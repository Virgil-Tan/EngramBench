import assert from "node:assert/strict";

import { assertAwardSet, assertContiguousBidHistory, canonical } from "../lib/oracle.mjs";

export const correctnessCap = { hardCapIds: ["AUCTION_INVARIANT"] };

export function result(evidence = []) {
  return { evidence };
}

export async function seedAndStart(ctx, seed, options = {}) {
  await ctx.seed(seed, { timeoutMs: options.seedTimeoutMs ?? 900_000 });
  return ctx.startApi(options.api);
}

export function assertError(response, status, code) {
  assert.equal(response.status, status);
  assert.deepEqual(Object.keys(response.json ?? {}), ["error"]);
  assert.deepEqual(Object.keys(response.json.error ?? {}).sort(), ["code", "details", "message"]);
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.equal(typeof response.json.error.details, "object");
  assert.doesNotMatch(response.text, /postgres(?:ql)?:\/\/|select\s|insert\s|\/Users\/|\/workspace\/|admin[_-]?token|idempotency/iu);
}

export function assertUuid(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
}

export function assertTimestamp(value) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.ok(Number.isFinite(Date.parse(value)));
}

export function assertBid(value, expected = {}, options = {}) {
  const fields = ["acceptedAt", "amountMinor", "auctionId", "bidId", "bidderId", "committedSequence", "effectiveEndAtAfter", "state"];
  if (options.multiUnit) fields.push("quantity");
  assert.deepEqual(Object.keys(value).sort(), fields.sort());
  assertUuid(value.bidId);
  assertUuid(value.auctionId);
  assertUuid(value.bidderId);
  assert.equal(Number.isSafeInteger(value.amountMinor) && value.amountMinor > 0, true);
  assert.equal(Number.isSafeInteger(value.committedSequence) && value.committedSequence > 0, true);
  assert.ok(["ACCEPTED", "OUTBID", "WINNING"].includes(value.state));
  assertTimestamp(value.acceptedAt);
  assertTimestamp(value.effectiveEndAtAfter);
  if (options.multiUnit) assert.equal(Number.isSafeInteger(value.quantity) && value.quantity >= 1 && value.quantity <= 20, true);
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue);
}

export function assertBidMutation(response, expected = {}, options = {}) {
  assert.equal(response.status, 201);
  const keys = ["acceptedAt", "amountMinor", "auctionId", "bidId", "bidderId", "committedSequence", "effectiveEndAt", "effectiveEndAtAfter", "state"];
  if (options.multiUnit) keys.push("quantity");
  assert.deepEqual(Object.keys(response.json).sort(), keys.sort());
  const { effectiveEndAt, ...bid } = response.json;
  assertTimestamp(effectiveEndAt);
  assertBid(bid, expected, options);
  assert.equal(effectiveEndAt, bid.effectiveEndAtAfter);
  return bid;
}

export function assertAuctionDetail(value, expected = {}) {
  const keys = ["auctionId", "lotId", "currency", "reservePriceMinor", "minimumIncrementMinor", "startAt", "effectiveEndAt", "state", "leadingBidId", "winnerId", "winningAmountMinor", "sequence", "unitCount", "awards", "outcome"];
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
  assertUuid(value.auctionId);
  assertUuid(value.lotId);
  assert.match(value.currency, /^[A-Z]{3}$/u);
  assert.equal(Number.isSafeInteger(value.reservePriceMinor), true);
  assert.equal(Number.isSafeInteger(value.minimumIncrementMinor), true);
  assertTimestamp(value.startAt);
  assertTimestamp(value.effectiveEndAt);
  assert.ok(["SCHEDULED", "OPEN", "CLOSING", "CLOSED", "CANCELLED"].includes(value.state));
  assert.equal(Number.isSafeInteger(value.sequence) && value.sequence > 0, true);
  assert.equal(Number.isSafeInteger(value.unitCount) && value.unitCount >= 1 && value.unitCount <= 100, true);
  assert.ok(Array.isArray(value.awards));
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue);
  return value;
}

export async function getAuction(ctx, baseUrl, auctionId, expected = {}) {
  const response = await ctx.getAuction(baseUrl, auctionId);
  ctx.equal("Auction detail status", response.status, 200);
  ctx.assert("Auction detail has the exact FINAL shape", () => assertAuctionDetail(response.json, expected));
  return response.json;
}

export async function getBidHistory(ctx, baseUrl, auctionId) {
  const response = await ctx.getBids(baseUrl, auctionId);
  ctx.equal("Bid history status", response.status, 200);
  ctx.assert("Bid history uses the exact paginated shape", () => {
    assert.deepEqual(Object.keys(response.json).sort(), ["items", "nextCursor"]);
    assert.equal(response.json.nextCursor, null);
    for (const bid of response.json.items) assertBid(bid, {}, { multiUnit: Object.hasOwn(bid, "quantity") });
    assertContiguousBidHistory(response.json.items);
  }, correctnessCap);
  return response.json.items;
}

export async function waitForClosed(ctx, baseUrl, auctionId, processes = [], timeoutMs = 180_000) {
  return ctx.waitFor(async () => {
    const response = await ctx.getAuction(baseUrl, auctionId);
    return response.status === 200 && response.json?.state === "CLOSED" ? response.json : false;
  }, { timeoutMs, intervalMs: 100, label: "Auction CLOSED", processes });
}

export function assertReplay(ctx, label, response, original) {
  ctx.equal(`${label} status`, response.status, original.status, correctnessCap);
  ctx.equal(`${label} semantic body`, canonical(response.json), canonical(original.json), correctnessCap);
}

export function stableSnapshot(snapshot) {
  return { resources: snapshot.resources, work: snapshot.work, events: snapshot.events };
}

export function assertCanonicalAwards(ctx, actual, unitCount, expected) {
  ctx.assert("Award set matches the independent uniform-price oracle", () => assertAwardSet(actual, expected), correctnessCap);
  ctx.equal("allocated and unallocated Units conserve unitCount", expected.allocatedUnitCount + expected.unallocatedUnitCount, unitCount, correctnessCap);
}
