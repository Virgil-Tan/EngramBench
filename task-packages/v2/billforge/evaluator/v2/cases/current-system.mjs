import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { billingSeed, invoice as invoiceFixture, paymentIntent as paymentFixture } from "../lib/fixtures.mjs";
import { balancePostings, canonical } from "../lib/oracle.mjs";
import { assertSnapshot, createPayment, createRefund, createSettlement, prepare, result, waitForSettlement } from "./helpers.mjs";

// Fixtures supply public starting facts, never the result of the operation tested.
export function openBillingFixture(ctx, label, { unknown = false } = {}) {
  const fixture = billingSeed(ctx.fixtures, label);
  fixture.invoice = invoiceFixture(ctx.fixtures, label, fixture.tenant, fixture.customer, fixture.subscription, fixture.rate);
  fixture.seed.invoices = [fixture.invoice];
  if (unknown) {
    fixture.payment = paymentFixture(ctx.fixtures, label, fixture.invoice);
    fixture.seed.paymentIntents = [fixture.payment];
  }
  return fixture;
}

export async function successfulPayment(ctx, label, options = {}) {
  const fixture = openBillingFixture(ctx, label);
  if (options.secondInvoice) {
    fixture.secondInvoice = invoiceFixture(ctx.fixtures, `${label}-second`, fixture.tenant, fixture.customer, fixture.subscription, fixture.rate, { periodStart: ctx.at({ days: -120 }), periodEnd: ctx.at({ days: -90 }) });
    fixture.seed.invoices.push(fixture.secondInvoice);
  }
  const prepared = await prepare(ctx, fixture.seed, { apis: options.apis ?? 2 });
  const created = await createPayment(ctx, prepared.api, fixture.invoice, label);
  const fact = providerFact(ctx, created.paymentIntent, label);
  const response = await ctx.mutate(prepared.api.baseUrl, "/api/v1/provider/webhooks", ctx.key(`${label}-provider-fact`), fact);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.state, "SUCCEEDED", "public successful provider fact captures payment");
  assert.equal(response.json.paymentIntentId, created.paymentIntent.paymentIntentId);
  return { ...fixture, ...prepared, payment: response.json, fact };
}

function providerFact(ctx, payment, label, outcome = "SUCCEEDED") {
  return { providerEventId: ctx.key(`${label}-event`), providerRequestId: payment.providerRequestId,
    providerTransactionId: ctx.key(`${label}-transaction`), outcome, occurredAt: ctx.at() };
}

export function assertFinancialState(snapshot) {
  assertSnapshot(snapshot);
  balancePostings(snapshot.resources.ledgerEntries);
  for (const invoice of snapshot.resources.invoices) {
    const payments = snapshot.resources.paymentIntents.filter(item => item.invoiceId === invoice.invoiceId);
    const ids = new Set(payments.map(item => item.paymentIntentId));
    assert.equal(invoice.paidMinor, payments.filter(item => item.state === "SUCCEEDED").reduce((sum, item) => sum + item.amountMinor, 0), "paid balance follows successful payment facts");
    assert.equal(invoice.refundedMinor, snapshot.resources.refunds.filter(item => ids.has(item.paymentIntentId) && item.state === "SUCCEEDED").reduce((sum, item) => sum + item.amountMinor, 0), "refund balance follows only successful facts");
  }
  for (const payment of snapshot.resources.paymentIntents) {
    const refunds = snapshot.resources.refunds.filter(item => item.paymentIntentId === payment.paymentIntentId);
    const disputes = (snapshot.resources.disputes ?? []).filter(item => item.paymentIntentId === payment.paymentIntentId);
    const consumed = refunds.filter(item => ["REQUESTED", "PROCESSING", "SUCCEEDED"].includes(item.state)).reduce((sum, item) => sum + item.amountMinor, 0);
    const reserved = disputes.reduce((sum, item) => sum + item.reservedMinor, 0);
    assert.ok(consumed + reserved <= (payment.state === "SUCCEEDED" ? payment.amountMinor : 0), "refunds and disputes share captured reserve");
    for (const refund of refunds.filter(item => item.state !== "SUCCEEDED")) assert.equal(snapshot.resources.ledgerEntries.some(item => item.referenceType === "REFUND" && item.referenceId === refund.refundId), false, "unsuccessful refund has no successful posting");
  }
}

export async function unknownPaymentScenario(ctx, { restart = false, resolve = false } = {}) {
  const fixture = openBillingFixture(ctx, "unknown-state", { unknown: true });
  let { api } = await prepare(ctx, fixture.seed);
  const before = await ctx.snapshot(api.baseUrl);
  assertFinancialState(before);
  if (restart) { await ctx.stop(api); api = await ctx.startApi(); }
  const after = await ctx.snapshot(api.baseUrl);
  const unknown = after.resources.paymentIntents.find(item => item.paymentIntentId === fixture.payment.paymentIntentId);
  assert.deepEqual(unknown, fixture.payment, "UNKNOWN and provider identity persist without a fabricated success");
  assert.equal(after.resources.ledgerEntries.some(item => item.referenceId === unknown.paymentIntentId), false);
  const rejected = await ctx.mutate(api.baseUrl, `/api/v1/payment-intents/${unknown.paymentIntentId}/refunds`, ctx.key("unknown-refund"), { amountMinor: 1 });
  assert.ok(rejected.status >= 400 && rejected.status < 500, "uncaptured payment cannot be refunded");
  if (resolve) {
    const response = await ctx.mutate(api.baseUrl, "/api/v1/provider/webhooks", ctx.key("unknown-resolve"), providerFact(ctx, unknown, "unknown-resolve"));
    assert.equal(response.status, 200);
    assert.equal(response.json.state, "SUCCEEDED");
    assert.equal(response.json.providerRequestId, unknown.providerRequestId);
  }
  assertFinancialState(await ctx.snapshot(api.baseUrl));
  return result({ paymentIntentId: unknown.paymentIntentId, restart, resolvedByPublicFact: resolve });
}

export async function providerIdentityScenario(ctx, { reconcile = false } = {}) {
  const setup = await successfulPayment(ctx, "provider-identity", { secondInvoice: true });
  const before = await ctx.snapshot(setup.api.baseUrl);
  const calls = Array.from({ length: 12 }, (_, index) => ctx.mutate(setup.apis[index % 2].baseUrl,
    reconcile && index % 2 ? `/api/v1/payment-intents/${setup.payment.paymentIntentId}/reconcile` : "/api/v1/provider/webhooks",
    ctx.key(`provider-repeat-${index}`), reconcile && index % 2 ? {} : setup.fact));
  for (const response of await Promise.all(calls)) assert.equal(response.status, 200, response.text);
  const after = await ctx.snapshot(setup.api.baseUrl);
  assert.deepEqual(after.resources.paymentIntents, before.resources.paymentIntents, "duplicates never rewrite provider reality");
  assert.deepEqual(after.resources.ledgerEntries, before.resources.ledgerEntries, "duplicates never append payment postings");
  assert.deepEqual(after.events, before.events, "duplicates never append semantic events");
  const other = await createPayment(ctx, setup.api, setup.secondInvoice, "other-intent");
  const collision = await ctx.mutate(setup.api.baseUrl, "/api/v1/provider/webhooks", ctx.key("provider-collision"), { ...setup.fact, providerEventId: ctx.key("collision-event"), providerRequestId: other.paymentIntent.providerRequestId });
  assert.ok(collision.status >= 400 && collision.status < 500, "provider transaction cannot bind to another intent");
  const final = await ctx.snapshot(setup.api.baseUrl);
  assert.equal(final.resources.paymentIntents.filter(item => item.providerTransactionId === setup.fact.providerTransactionId).length, 1);
  assertFinancialState(final);
  return result({ duplicateFacts: calls.length, reconcile, transactionId: setup.fact.providerTransactionId });
}

export async function pendingRefundScenario(ctx) {
  const setup = await successfulPayment(ctx, "pending-refunds");
  const before = await ctx.snapshot(setup.api.baseUrl);
  const amount = Math.floor(setup.payment.amountMinor / 3);
  const first = await createRefund(ctx, setup.api, setup.payment, amount, "pending-first");
  const second = await createRefund(ctx, setup.api, setup.payment, amount, "pending-second");
  for (const refund of [first.refund, second.refund]) assert.ok(["REQUESTED", "PROCESSING"].includes(refund.state), "unprocessed refund is reserved, not successful");
  const rejected = await ctx.mutate(setup.api.baseUrl, `/api/v1/payment-intents/${setup.payment.paymentIntentId}/refunds`, ctx.key("refund-over-reserve"), { amountMinor: setup.payment.amountMinor - amount });
  assert.ok(rejected.status >= 400 && rejected.status < 500, "reserved refunds prevent overdraw");
  const after = await ctx.snapshot(setup.api.baseUrl);
  assert.equal(after.resources.invoices.find(item => item.invoiceId === setup.invoice.invoiceId).refundedMinor, 0);
  assert.deepEqual(after.resources.ledgerEntries, before.resources.ledgerEntries, "reservation has no successful refund posting");
  assertFinancialState(after);
  return result({ reservedRefundIds: [first.refund.refundId, second.refund.refundId] });
}

export async function createDispute(ctx, setup, label, amountMinor) {
  const body = { tenantId: setup.tenant.tenantId, paymentIntentId: setup.payment.paymentIntentId, externalRef: ctx.key(label), amountMinor };
  const response = await ctx.mutate(setup.api.baseUrl, "/api/v1/disputes", ctx.key(label), body);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.state, "OPEN");
  assert.equal(response.json.reservedMinor, amountMinor);
  assert.equal(response.json.paymentIntentId, setup.payment.paymentIntentId);
  return { dispute: response.json, body, key: ctx.key(label) };
}

export async function disputeScenario(ctx, { resolution = false, browser = false } = {}) {
  const setup = await successfulPayment(ctx, "disputes");
  const openapi = await ctx.request(setup.api.baseUrl, "/openapi.json");
  assert.equal(openapi.status, 200);
  for (const path of ["/api/v1/disputes", "/api/v1/disputes/{disputeId}/resolve", "/api/v1/adjustments"]) assert.ok(openapi.json.paths?.[path], `published path ${path}`);
  const first = await createDispute(ctx, setup, "dispute-first", 2_000);
  const replay = await ctx.mutate(setup.apis[1].baseUrl, "/api/v1/disputes", first.key, first.body);
  assert.deepEqual(replay.json, first.dispute);
  let snapshot = await ctx.snapshot(setup.api.baseUrl);
  assert.deepEqual(snapshot.resources.disputes.find(item => item.disputeId === first.dispute.disputeId), first.dispute, "public response agrees with durable dispute");
  if (resolution) {
    const second = await createDispute(ctx, setup, "dispute-second", 3_000);
    for (const [created, outcome] of [[first, "WON"], [second, "LOST"]]) {
      const path = `/api/v1/disputes/${created.dispute.disputeId}/resolve`;
      const key = ctx.key(`resolve-${outcome}`);
      const response = await ctx.mutate(setup.api.baseUrl, path, key, { outcome });
      assert.equal(response.status, 200);
      assert.equal(response.json.state, outcome);
      assert.equal(response.json.reservedMinor, 0, "resolution releases dispute reservation");
      assert.deepEqual((await ctx.mutate(setup.apis[1].baseUrl, path, key, { outcome })).json, response.json);
      snapshot = await ctx.snapshot(setup.api.baseUrl);
      const entries = snapshot.resources.ledgerEntries.filter(item => item.referenceType === "CHARGEBACK" && item.referenceId === created.dispute.disputeId);
      if (outcome === "WON") assert.equal(entries.length, 0);
      else {
        const postings = balancePostings(entries);
        assert.equal(postings.length, 1, "LOST creates exactly one balanced chargeback");
        assert.equal(postings[0].debitMinor, created.dispute.amountMinor);
        assert.equal(response.json.chargebackPostingId, postings[0].postingId);
      }
    }
  }
  assertFinancialState(snapshot);
  if (browser) await assertBrowserFacts(ctx, setup.api.baseUrl, [first.dispute.disputeId]);
  return result({ disputeId: first.dispute.disputeId, resolution, browser });
}

export async function reserveRaceScenario(ctx, { browser = false } = {}) {
  const setup = await successfulPayment(ctx, "shared-reserve");
  const amountMinor = Math.floor(setup.payment.amountMinor * 3 / 4);
  const responses = await Promise.all([
    ctx.mutate(setup.apis[0].baseUrl, `/api/v1/payment-intents/${setup.payment.paymentIntentId}/refunds`, ctx.key("race-refund"), { amountMinor }),
    ctx.mutate(setup.apis[1].baseUrl, "/api/v1/disputes", ctx.key("race-dispute"), { tenantId: setup.tenant.tenantId, paymentIntentId: setup.payment.paymentIntentId, externalRef: ctx.key("race-dispute"), amountMinor }),
  ]);
  assert.equal(responses.filter(item => item.status === 200).length, 1, "only one contender can reserve the last capacity");
  assert.ok(responses.every(item => item.status === 200 || (item.status >= 400 && item.status < 500)));
  const snapshot = await ctx.snapshot(setup.api.baseUrl);
  assertFinancialState(snapshot);
  assert.equal(snapshot.resources.refunds.length + snapshot.resources.disputes.length, 1, "rejected reservation has no durable effect");
  if (browser) await assertBrowserFacts(ctx, setup.api.baseUrl, [setup.invoice.invoiceId]);
  return result({ accepted: responses.map(item => item.status), browser });
}

export async function settlementScenario(ctx, { adjustment = false, browser = false } = {}) {
  const setup = await successfulPayment(ctx, "settlement-lifecycle");
  const created = await createSettlement(ctx, setup.api, setup.tenant, ctx.at({ days: -90 }), ctx.at({ days: 1 }), "current-settlement");
  const beforeRestart = await ctx.snapshot(setup.api.baseUrl);
  assert.ok(beforeRestart.work.some(item => item.kind === "SETTLEMENT_CLOSE" && item.aggregateId === created.settlement.settlementRunId), "settlement owns durable close work");
  await ctx.stop(setup.api);
  const api = await ctx.startApi();
  const resumed = await ctx.snapshot(api.baseUrl);
  assert.deepEqual(resumed.work, beforeRestart.work, "queued settlement work survives API restart");
  const worker = await ctx.startWorker();
  const closed = await waitForSettlement(ctx, api, created.settlement.settlementRunId, ["CLOSED"], { processes: [worker], timeoutMs: 60_000 });
  await ctx.stop(worker);
  const frozen = await ctx.snapshot(api.baseUrl);
  if (adjustment) {
    const original = frozen.resources.ledgerEntries.find(item => item.referenceType === "PAYMENT" && item.referenceId === setup.payment.paymentIntentId);
    assert.ok(original, "payment has an original posting to correct");
    const next = await createSettlement(ctx, api, setup.tenant, closed.periodEnd, ctx.at({ days: 31 }), "next-settlement");
    const body = { tenantId: setup.tenant.tenantId, settlementRunId: next.settlement.settlementRunId, originalPostingId: original.postingId,
      currency: original.currency, amountMinor: 100, direction: "DEBIT", accountCode: "RefundExpense", balancingAccountCode: "CashClearing", reason: "next-period correction" };
    const response = await ctx.mutate(api.baseUrl, "/api/v1/adjustments", ctx.key("next-adjustment"), body);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.originalPostingId, original.postingId);
    assert.equal(response.json.settlementRunId, next.settlement.settlementRunId);
    assert.deepEqual((await ctx.mutate(api.baseUrl, "/api/v1/adjustments", ctx.key("next-adjustment"), body)).json, response.json);
    const snapshot = await ctx.snapshot(api.baseUrl);
    assert.deepEqual(snapshot.resources.adjustments.find(item => item.adjustmentId === response.json.adjustmentId), response.json);
    const posting = balancePostings(snapshot.resources.ledgerEntries.filter(item => item.referenceType === "ADJUSTMENT" && item.referenceId === response.json.adjustmentId));
    assert.equal(posting.length, 1);
    assert.equal(posting[0].debitMinor, body.amountMinor);
    assert.equal(posting[0].postingId, response.json.postingId);
    const rejected = await ctx.mutate(api.baseUrl, "/api/v1/adjustments", ctx.key("closed-adjustment"), { ...body, settlementRunId: closed.settlementRunId });
    assert.ok(rejected.status >= 400 && rejected.status < 500, "CLOSED settlement cannot accept in-place correction");
  }
  const after = await ctx.snapshot(api.baseUrl);
  assert.deepEqual(after.resources.settlementRuns.find(item => item.settlementRunId === closed.settlementRunId), closed, "CLOSED settlement snapshot is immutable");
  for (const entry of frozen.resources.ledgerEntries) assert.equal(canonical(after.resources.ledgerEntries.find(item => item.ledgerEntryId === entry.ledgerEntryId)), canonical(entry), "correction never rewrites original posting");
  assertFinancialState(after);
  if (browser) await assertBrowserFacts(ctx, api.baseUrl, [setup.invoice.invoiceId]);
  return result({ settlementRunId: closed.settlementRunId, adjustment, browser });
}

async function assertBrowserFacts(ctx, baseUrl, identities) {
  const require = createRequire(import.meta.url);
  const chromium = require("playwright-core").chromium;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  ctx.defer(() => browser.close());
  const page = await browser.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  // Navigate through visible product links, never inject data or call a private UI adapter.
  for (const identity of identities) {
    let found = await page.getByText(identity, { exact: false }).first().isVisible().catch(() => false);
    if (!found) {
      const hrefs = await page.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href")));
      for (const href of hrefs) {
        if (!href || !/invoice|bill|dispute|settle/i.test(href)) continue;
        await page.goto(new URL(href, baseUrl).href, { waitUntil: "domcontentloaded" });
        found = await page.getByText(identity, { exact: false }).first().isVisible().catch(() => false);
        if (found) break;
      }
    }
    assert.ok(found, "production UI exposes the same public business identity");
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.ok(await page.getByText(identity, { exact: false }).first().isVisible(), "business identity survives UI refresh");
  }
}
