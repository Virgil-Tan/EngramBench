import assert from "node:assert/strict";

export const MAX_SAFE_MINOR = 9_007_199_254_740_991n;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertSafeProduct(amountMinor, quantity) {
  assert.equal(Number.isSafeInteger(amountMinor) && amountMinor > 0, true);
  assert.equal(Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= 20, true);
  const total = BigInt(amountMinor) * BigInt(quantity);
  assert.ok(total <= MAX_SAFE_MINOR);
  return Number(total);
}

export function allocateUniformPrice(unitCount, bids) {
  assert.equal(Number.isSafeInteger(unitCount) && unitCount >= 1 && unitCount <= 100, true);
  const ordered = [...bids].sort((left, right) => (
    right.amountMinor - left.amountMinor
    || left.committedSequence - right.committedSequence
    || Buffer.compare(Buffer.from(left.bidId), Buffer.from(right.bidId))
  ));
  let remaining = unitCount;
  const allocated = [];
  for (const bid of ordered) {
    if (remaining === 0) break;
    const quantity = Math.min(remaining, bid.quantity);
    if (quantity > 0) allocated.push({ ...bid, allocatedQuantity: quantity });
    remaining -= quantity;
  }
  const clearingUnitPriceMinor = allocated.length ? allocated.at(-1).amountMinor : null;
  return {
    allocatedUnitCount: unitCount - remaining,
    unallocatedUnitCount: remaining,
    clearingUnitPriceMinor,
    awards: allocated.map((bid, index) => ({
      bidId: bid.bidId,
      bidderId: bid.bidderId,
      allocatedQuantity: bid.allocatedQuantity,
      clearingUnitPriceMinor,
      totalAmountMinor: assertSafeProduct(clearingUnitPriceMinor, bid.allocatedQuantity),
      allocationRank: index + 1,
    })),
  };
}

export function assertContiguousBidHistory(bids) {
  for (const [index, bid] of bids.entries()) {
    assert.equal(bid.committedSequence, index + 1);
    if (index > 0) assert.ok(bid.amountMinor > bids[index - 1].amountMinor);
  }
  const leaders = bids.filter(({ state }) => state === "WINNING");
  assert.ok(leaders.length <= 1);
  if (bids.length) assert.equal(leaders[0]?.bidId, bids.at(-1).bidId);
}

export function assertAwardSet(actual, expected) {
  assert.equal(actual.length, expected.awards.length);
  const normalized = actual.map(({ bidId, bidderId, allocatedQuantity, clearingUnitPriceMinor, totalAmountMinor, allocationRank }) => ({
    bidId, bidderId, allocatedQuantity, clearingUnitPriceMinor, totalAmountMinor, allocationRank,
  }));
  assert.deepEqual(normalized, expected.awards);
  assert.equal(actual.reduce((sum, award) => sum + award.allocatedQuantity, 0), expected.allocatedUnitCount);
}
