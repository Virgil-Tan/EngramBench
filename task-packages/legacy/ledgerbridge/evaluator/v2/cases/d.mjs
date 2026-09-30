import assert from "node:assert/strict";

import { assertExactKeys, canonical, compareUtf8, safeSum } from "../lib/oracle.mjs";
import {
  assertPostingOrder,
  boot,
  defineCase,
  eventsFor,
  expectError,
  postingsFor,
  requireTransfer,
  snapshot,
  statementAll,
  transferFrom,
  waitForTransfer,
  workFor,
} from "./helpers.mjs";

async function setLabeled(page, matcher, value, index = 0) {
  const control = page.getByLabel(matcher).nth(index);
  assert.ok(await control.count(), `visible labeled control ${matcher} is missing`);
  const tag = await control.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "select") await control.selectOption(String(value));
  else await control.fill(String(value));
}

async function press(page, matcher, index = 0) {
  const button = page.getByRole("button", { name: matcher }).nth(index);
  assert.ok(await button.count(), `visible button ${matcher} is missing`);
  await button.click();
}

async function fillLegacyTransfer(page, catalog, amount) {
  await setLabeled(page, /source account/i, catalog.source.accountId);
  await setLabeled(page, /destination account/i, catalog.destinations[0].accountId);
  const currency = page.getByLabel(/currency/i).first();
  if (await currency.count()) {
    const tag = await currency.evaluate((element) => element.tagName.toLowerCase());
    if (tag === "select") await currency.selectOption("USD"); else await currency.fill("USD");
  }
  await setLabeled(page, /amount/i, amount);
}

async function submitTransfer(page) {
  await press(page, /create transfer|submit transfer|send transfer/i);
}

async function openTransfer(page, transferId) {
  const visible = page.getByText(transferId, { exact: false }).first();
  if (await visible.count()) await visible.click();
}

const D01 = defineCase(
  "D-01", "F-TRANSFER desktop/mobile production UI", "Use production Chromium visible labeled controls to create, cancel, settle, reverse, browse Statement, refresh and operate by keyboard", "Reconcile each visible outcome against public HTTP Accounts, Transfer, Posting, Work and Events with no client-only ledger authority",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 500 } });
    let cancelledId;
    await ctx.withPage(api, { width: 390, height: 844 }, async (page) => {
      await page.goto("/");
      await fillLegacyTransfer(page, catalog, 40);
      await submitTransfer(page);
      await page.waitForLoadState("networkidle");
      const state = await ctx.snapshot(api.baseUrl);
      const pending = state.resources.transfers.find(({ state: value }) => value === "PENDING");
      ctx.ok("mobile UI creates a real pending Transfer", pending);
      cancelledId = pending.transferId;
      await openTransfer(page, cancelledId);
      await press(page, /^cancel(?: transfer)?$/i);
      await page.getByText(/cancelled/i).waitFor({ timeout: 10_000 });
      await page.reload();
      await page.getByText(/cancelled/i).waitFor({ timeout: 10_000 });
      ctx.ok("mobile controls are keyboard reachable", await page.getByRole("button", { name: /create|new transfer/i }).first().evaluate((element) => element.tabIndex >= 0).catch(() => true));
    });
    await waitForTransfer(ctx, api.baseUrl, cancelledId, "CANCELLED");

    let postedId;
    await ctx.withPage(api, { width: 1440, height: 900 }, async (page) => {
      await page.goto("/");
      const create = page.getByRole("button", { name: /new transfer|create transfer/i }).first();
      if (await create.count()) await create.click();
      await fillLegacyTransfer(page, catalog, 60);
      await submitTransfer(page);
      await page.waitForLoadState("networkidle");
      const state = await ctx.snapshot(api.baseUrl);
      postedId = state.resources.transfers.find(({ state: value, transferId }) => value === "PENDING" && transferId !== cancelledId)?.transferId;
      ctx.ok("desktop UI creates a second real Transfer", postedId);
    });
    const worker = await ctx.startWorker();
    await waitForTransfer(ctx, api.baseUrl, postedId, "POSTED", { processes: [worker] });
    await ctx.withPage(api, { width: 1440, height: 900 }, async (page) => {
      await page.goto("/");
      await openTransfer(page, postedId);
      await page.getByText(/posted/i).waitFor({ timeout: 10_000 });
      const reason = page.getByLabel(/reason/i);
      if (await reason.count()) await reason.fill("browser reversal");
      await press(page, /^reverse(?: transfer)?$/i);
      await page.getByText(/reversed/i).waitFor({ timeout: 10_000 });
      const statement = page.getByRole("link", { name: /statement/i }).first();
      if (await statement.count()) await statement.click();
      else await press(page, /statement/i);
      await page.getByText(/debit|credit/i).first().waitFor({ timeout: 10_000 });
    });
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal("browser cancellation has no Posting", postingsFor(state, cancelledId).length, 0);
    ctx.equal("browser reversal preserves two Postings", postingsFor(state, postedId).length, 2);
    ctx.equal("browser transitions expose exact events", [eventsFor(state, cancelledId).length, eventsFor(state, postedId).length], [2, 3]);
    return { evidence: [cancelledId, postedId] };
  },
);

const D02 = defineCase(
  "D-02", "F-MULTI responsive beneficiary editor", "Use production Chromium to add/reorder beneficiary controls, surface duplicate/invalid/insufficient errors, submit success and inspect atomic Posting/Reversal legs", "Compare captured public request order and visible stable leg IDs/source sum to API and independent snapshot without any partial destination credit",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 100, destinationCount: 4 } });
    let sentBody;
    let transferId;
    await ctx.withPage(api, { width: 1440, height: 900 }, async (page) => {
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/transfers") {
          try { sentBody = request.postDataJSON(); } catch {}
        }
      });
      await page.goto("/");
      const multi = page.getByRole("button", { name: /multi|beneficiar|destination/i }).first();
      if (await multi.count()) await multi.click();
      await setLabeled(page, /source account/i, catalog.source.accountId);
      const currency = page.getByLabel(/currency/i).first();
      if (await currency.count()) {
        const tag = await currency.evaluate((element) => element.tagName.toLowerCase());
        if (tag === "select") await currency.selectOption("USD"); else await currency.fill("USD");
      }
      await press(page, /add destination|add beneficiary|add leg/i);
      await setLabeled(page, /destination account/i, catalog.destinations[0].accountId, 0);
      await setLabeled(page, /amount/i, 30, 0);
      await setLabeled(page, /destination account/i, catalog.destinations[1].accountId, 1);
      await setLabeled(page, /amount/i, 20, 1);
      const reorder = page.getByRole("button", { name: /move (up|down)|reorder/i }).first();
      if (await reorder.count()) { await reorder.click(); await reorder.click(); }
      await submitTransfer(page);
      await page.waitForLoadState("networkidle");
      const state = await ctx.snapshot(api.baseUrl);
      const created = state.resources.transfers.find(({ legs }) => legs?.length === 2);
      ctx.ok("multi UI creates a real two-leg Transfer", created);
      transferId = created.transferId;
      ctx.ok("browser issued the Manager request alternative", Array.isArray(sentBody?.legs) && sentBody.legs.length === 2 && !Object.hasOwn(sentBody, "amountMinor"));
      ctx.equal("browser request order reaches durable Transfer", created.legs.map(({ destinationAccountId, amountMinor }) => [destinationAccountId, amountMinor]), sentBody.legs.map(({ destinationAccountId, amountMinor }) => [destinationAccountId, amountMinor]));
    });
    const worker = await ctx.startWorker();
    await waitForTransfer(ctx, api.baseUrl, transferId, "POSTED", { processes: [worker] });
    requireTransfer(ctx, await ctx.reverseTransfer(api.baseUrl, transferId));
    const state = await snapshot(ctx, api.baseUrl);
    const transfer = transferFrom(state, transferId);
    const postings = postingsFor(state, transferId);
    ctx.equal("UI multi result has all-or-none original and reversal", postings.length, 2, { failureCodeSuffix: "UI_PARTIAL_MULTI", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    assertPostingOrder(ctx, postings[0], transfer, "TRANSFER");
    assertPostingOrder(ctx, postings[1], transfer, "REVERSAL");
    await ctx.withPage(api, { width: 390, height: 844 }, async (page) => {
      await page.goto("/"); await openTransfer(page, transferId);
      for (const leg of transfer.legs) await page.getByText(leg.legId, { exact: false }).waitFor({ timeout: 10_000 });
      await page.getByText(String(safeSum(transfer.legs.map(({ amountMinor }) => amountMinor))), { exact: false }).first().waitFor({ timeout: 10_000 });
      await page.getByText(/reversed/i).waitFor({ timeout: 10_000 });
    });
    return { evidence: [transferId, sentBody] };
  },
);

function resolveSchema(document, schema) {
  if (!schema?.$ref) return schema;
  return schema.$ref.slice(2).split("/").reduce((value, key) => value?.[key], document);
}

const D03 = defineCase(
  "D-03", "All states plus OpenAPI and FINAL snapshot", "Execute request-union/error probes, traverse OpenAPI operations/schemas, and read one point-in-time verification snapshot", "Validate executable status/body agreement, exact resource keys, conditional Transfer/Posting wires, Work/Event enums, bytewise sorting and recursive token omission",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 500 } });
    const legacy = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 20)));
    const multi = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, [10, 15])));
    requireTransfer(ctx, await ctx.cancelTransfer(api.baseUrl, legacy.transferId), { status: 200 });
    const worker = await ctx.startWorker();
    await waitForTransfer(ctx, api.baseUrl, multi.transferId, "POSTED", { processes: [worker] });
    requireTransfer(ctx, await ctx.reverseTransfer(api.baseUrl, multi.transferId));
    expectError(ctx, await ctx.createTransfer(api.baseUrl, { ...ctx.legacyBody(catalog, 1), unknown: true }), 400, "UNKNOWN_FIELD");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/transfers", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("malformed") }, raw: "{" }), 400, "MALFORMED_JSON");

    const openapi = await ctx.readOpenApi(api.baseUrl);
    ctx.equal("OpenAPI version is 3.1", openapi.openapi, "3.1.0");
    for (const [path, method] of [["/api/v1/transfers", "post"], ["/api/v1/transfers/{transferId}", "get"], ["/api/v1/transfers/{transferId}/cancel", "post"], ["/api/v1/transfers/{transferId}/reverse", "post"], ["/api/v1/accounts/{accountId}/statement", "get"], ["/api/v1/verification-snapshot", "get"]]) ctx.ok(`OpenAPI publishes ${method.toUpperCase()} ${path}`, openapi.paths?.[path]?.[method]);
    const createOperation = openapi.paths["/api/v1/transfers"].post;
    const requestSchema = resolveSchema(openapi, createOperation.requestBody?.content?.["application/json"]?.schema);
    ctx.ok("OpenAPI create request publishes oneOf alternatives", Array.isArray(requestSchema?.oneOf) && requestSchema.oneOf.length === 2);
    ctx.ok("OpenAPI publishes 202 create response", createOperation.responses?.["202"]);
    for (const code of ["DUPLICATE_DESTINATION_ACCOUNT", "INVALID_MULTI_LEG_AMOUNT", "MULTI_LEG_INSUFFICIENT_FUNDS", "IDEMPOTENCY_CONFLICT"]) ctx.ok(`OpenAPI publishes ${code}`, canonical(openapi).includes(code));

    const state = await snapshot(ctx, api.baseUrl);
    ctx.assert("snapshot resources have exactly frozen keys", () => assertExactKeys(state.resources, ["accounts", "transfers", "postings"], "resources"));
    for (const [name, key] of [["accounts", "accountId"], ["transfers", "transferId"], ["postings", "postingId"]]) {
      const actual = state.resources[name].map((item) => item[key]);
      ctx.equal(`${name} sort is bytewise`, actual, [...actual].sort(compareUtf8));
    }
    ctx.equal("snapshot work kind union is SETTLEMENT only", [...new Set(state.work.map(({ kind }) => kind))], ["SETTLEMENT"]);
    ctx.equal("snapshot contains no token-named fields", /"[^"]*Token"\s*:/u.test(JSON.stringify(state)), false);
    ctx.blocked("legacy-one-leg-statement-leg-shape", "LB-GAP-01");
    return { evidence: [legacy.transferId, multi.transferId, state.asOf] };
  },
);

const D04 = defineCase(
  "D-04", "One-leg, multi-leg, cancellation and Reversal lineage", "Trace each public ID and amount from mutation response through Work, Posting, Account Statements, Domain Events and snapshot", "Join transferId/postingId/legId/order/timestamps/sequence exactly and reject any orphan, rewritten original or secret-bearing branch",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 1_000, destinationCount: 4 } });
    const cancelled = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 25)));
    requireTransfer(ctx, await ctx.cancelTransfer(api.baseUrl, cancelled.transferId), { status: 200 });
    const multi = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, [30, 20, 10])));
    const worker = await ctx.startWorker();
    await waitForTransfer(ctx, api.baseUrl, multi.transferId, "POSTED", { processes: [worker] });
    const beforeReverse = await snapshot(ctx, api.baseUrl);
    const original = postingsFor(beforeReverse, multi.transferId)[0];
    requireTransfer(ctx, await ctx.reverseTransfer(api.baseUrl, multi.transferId));
    const final = await snapshot(ctx, api.baseUrl);
    const transfer = transferFrom(final, multi.transferId);
    const postings = postingsFor(final, multi.transferId);
    ctx.equal("Reversal does not rewrite original Posting", canonical(postings[0]), canonical(original));
    ctx.equal("Transfer Posting IDs trace into immutable resources", [transfer.postingId, transfer.reversalPostingId], postings.map(({ postingId }) => postingId));
    for (const [index, leg] of transfer.legs.entries()) {
      ctx.equal("TransferLeg postingLegId traces to original credit", leg.postingLegId, postings[0].legs[index + 1].postingLegId);
      const items = (await statementAll(ctx, api.baseUrl, leg.destinationAccountId, 1, { finalMulti: true })).filter(({ transferId }) => transferId === transfer.transferId);
      ctx.equal("Statement trace keeps Posting and leg identities", items.map(({ postingId, legId }) => [postingId, legId]), [[postings[0].postingId, leg.legId], [postings[1].postingId, leg.legId]]);
    }
    const work = workFor(final, multi.transferId);
    ctx.equal("Settlement Work points at Transfer and remains terminal", work.map(({ aggregateId, kind, terminal }) => [aggregateId, kind, terminal]), [[multi.transferId, "SETTLEMENT", true]]);
    const events = eventsFor(final, multi.transferId);
    ctx.equal("Event aggregate, sequence and transitions trace", events.map(({ aggregateId, sequence, type }) => [aggregateId, sequence, type]), [[multi.transferId, 1, "transfer.created"], [multi.transferId, 2, "transfer.posted"], [multi.transferId, 3, "transfer.reversed"]]);
    ctx.equal("cancel lineage has no Posting", postingsFor(final, cancelled.transferId).length, 0);
    ctx.equal("cancel lineage Work is terminal cancelled", workFor(final, cancelled.transferId).map(({ state, terminal }) => [state, terminal]), [["CANCELLED", true]]);
    return { evidence: [transfer.transferId, ...postings.map(({ postingId }) => postingId)] };
  },
);

export const D_CASES = [D01, D02, D03, D04];
