import assert from "node:assert/strict";

import {
  assertAccount,
  assertEvent,
  assertPosting,
  assertPublicError,
  assertStatementPage,
  assertTransfer,
  canonical,
  compareUtf8,
  reconcileSnapshot,
  safeSum,
} from "../lib/oracle.mjs";

export function defineCase(id, fixtureFamily, action, oracle, run) {
  return Object.freeze({ id, taskId: "ledgerbridge", fixtureFamily, action, oracle, run });
}

export async function boot(ctx, options = {}) {
  const catalog = options.catalog ?? ctx.catalog(options.catalogOptions);
  await ctx.seed(options.seed ?? ctx.seedFor(options.seedVersion ?? `${ctx.caseId.toLowerCase()}-v1`, { catalog, accounts: options.accounts, transfers: options.transfers }));
  const apis = [];
  for (let index = 0; index < (options.apiCount ?? 1); index += 1) apis.push(await ctx.startApi());
  const workers = [];
  for (let index = 0; index < (options.workerCount ?? 0); index += 1) workers.push(await ctx.startWorker());
  return { catalog, api: apis[0], apis, workers };
}

export function requireTransfer(ctx, response, options = {}) {
  ctx.equal("Transfer mutation status", response.status, options.status ?? 202, { failureCodeSuffix: options.failureCodeSuffix ?? "TRANSFER_STATUS" });
  ctx.assert("Transfer response has exact FINAL shape", () => assertTransfer(response.json, { expected: options.expected }), { failureCodeSuffix: options.failureCodeSuffix ?? "TRANSFER_SHAPE" });
  return response.json;
}

export async function waitForTransfer(ctx, baseUrl, transferId, state, options = {}) {
  return ctx.waitFor(async () => {
    const response = await ctx.getTransfer(baseUrl, transferId);
    if (response.status !== 200 || response.json?.state !== state) return undefined;
    assertTransfer(response.json);
    return response.json;
  }, { timeoutMs: options.timeoutMs ?? 60_000, intervalMs: options.intervalMs ?? 40, label: `Transfer ${transferId} ${state}`, processes: options.processes });
}

export async function waitForAnyTerminal(ctx, baseUrl, transferId, options = {}) {
  return ctx.waitFor(async () => {
    const response = await ctx.getTransfer(baseUrl, transferId);
    if (response.status !== 200 || !["POSTED", "CANCELLED", "REVERSED"].includes(response.json?.state)) return undefined;
    assertTransfer(response.json);
    return response.json;
  }, { timeoutMs: options.timeoutMs ?? 60_000, intervalMs: 40, label: `Transfer ${transferId} terminal`, processes: options.processes });
}

export async function snapshot(ctx, baseUrl, options = {}) {
  const value = await ctx.snapshot(baseUrl, { timeoutMs: options.timeoutMs });
  ctx.assert("verification snapshot reconciles independently", () => reconcileSnapshot(value), {
    failureCodeSuffix: "LEDGER_INVARIANT",
    hardCapIds: ["CORRECTNESS_INVARIANT"],
  });
  return value;
}

export function resources(value) { return value.resources; }
export function transferFrom(value, transferId) {
  const transfer = value.resources.transfers.find((item) => item.transferId === transferId);
  assert.ok(transfer, `Transfer ${transferId} absent from snapshot`);
  return transfer;
}
export function postingsFor(value, transferId) { return value.resources.postings.filter((item) => item.transferId === transferId); }
export function workFor(value, transferId) { return value.work.filter((item) => item.aggregateId === transferId); }
export function eventsFor(value, transferId) { return value.events.filter((item) => item.aggregateId === transferId); }

export async function statementAll(ctx, baseUrl, accountId, limit = 2, options = {}) {
  const items = [];
  let cursor;
  const cursors = new Set();
  do {
    const query = `limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response = await ctx.getStatement(baseUrl, accountId, query);
    ctx.equal("Statement page returns 200", response.status, 200);
    ctx.assert("Statement page has exact public shape", () => assertStatementPage(response.json, { finalMulti: options.finalMulti }));
    items.push(...response.json.items);
    cursor = response.json.nextCursor;
    if (cursor !== null) {
      ctx.ok("Statement cursor advances", !cursors.has(cursor));
      cursors.add(cursor);
    }
  } while (cursor !== null);
  return items;
}

export async function eventsAll(ctx, baseUrl, aggregateId) {
  const response = await ctx.getEvents(baseUrl, `aggregateId=${encodeURIComponent(aggregateId)}&afterSequence=0&limit=100`);
  ctx.equal("Domain Event query returns 200", response.status, 200);
  const items = response.json?.items ?? response.json;
  ctx.ok("Domain Event query returns an array or page", Array.isArray(items));
  for (const event of items) ctx.assert("Domain Event has exact public shape", () => assertEvent(event));
  return items;
}

export function assertAccountDelta(ctx, before, after, expected, label) {
  ctx.assert(`${label} account shape`, () => assertAccount(after));
  for (const [key, delta] of Object.entries(expected)) ctx.equal(`${label} ${key} delta`, after[key] - before[key], delta);
}

export function assertPostingOrder(ctx, posting, transfer, kind) {
  const multi = transfer.legs.length > 1;
  ctx.assert(`${kind} Posting exact shape and balance`, () => assertPosting(posting, { multi }), { failureCodeSuffix: "POSTING_SHAPE", hardCapIds: ["CORRECTNESS_INVARIANT"] });
  const total = safeSum(transfer.legs.map(({ amountMinor }) => amountMinor));
  const expectedDirections = kind === "TRANSFER"
    ? ["DEBIT", ...transfer.legs.map(() => "CREDIT")]
    : [...transfer.legs.map(() => "DEBIT"), "CREDIT"];
  ctx.equal(`${kind} Posting direction order`, posting.legs.map(({ direction }) => direction), expectedDirections);
  ctx.equal(`${kind} source total`, posting.legs[kind === "TRANSFER" ? 0 : posting.legs.length - 1].amountMinor, total);
  if (multi) {
    const destinationLegs = kind === "TRANSFER" ? posting.legs.slice(1) : posting.legs.slice(0, -1);
    ctx.equal(`${kind} stable TransferLeg linkage`, destinationLegs.map(({ legId }) => legId), transfer.legs.map(({ legId }) => legId));
    ctx.equal(`${kind} per-destination amounts`, destinationLegs.map(({ amountMinor }) => amountMinor), transfer.legs.map(({ amountMinor }) => amountMinor));
  }
}

export function assertStableReplay(ctx, responses, label) {
  ctx.ok(`${label} produced responses`, responses.length > 0);
  const first = responses[0];
  for (const response of responses.slice(1)) {
    ctx.equal(`${label} status replay`, response.status, first.status);
    ctx.equal(`${label} semantic body replay`, canonical(response.json), canonical(first.json));
  }
  return first;
}

export function assertSortedIds(ctx, values, key, label) {
  const actual = values.map((item) => item[key]);
  const expected = [...actual].sort(compareUtf8);
  ctx.equal(`${label} bytewise order`, actual, expected);
}

export function expectError(ctx, response, status, code, options = {}) {
  ctx.assert(`${code} exact public error`, () => assertPublicError(response, status, code), { failureCodeSuffix: options.failureCodeSuffix ?? code });
}

export function noEffect(ctx, before, after, label) {
  ctx.equal(`${label} account state unchanged`, canonical(after.resources.accounts), canonical(before.resources.accounts));
  ctx.equal(`${label} Transfer count unchanged`, after.resources.transfers.length, before.resources.transfers.length);
  ctx.equal(`${label} Posting count unchanged`, after.resources.postings.length, before.resources.postings.length);
  ctx.equal(`${label} Work count unchanged`, after.work.length, before.work.length);
  ctx.equal(`${label} Event count unchanged`, after.events.length, before.events.length);
}
