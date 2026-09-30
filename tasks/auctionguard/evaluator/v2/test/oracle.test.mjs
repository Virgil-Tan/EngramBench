import assert from "node:assert/strict";
import test from "node:test";

import { allocateUniformPrice, assertContiguousBidHistory, assertSafeProduct, canonical } from "../lib/oracle.mjs";

const bids = [
  { bidId: "00000000-0000-4000-8000-000000000003", bidderId: "00000000-0000-4000-8000-000000000013", amountMinor: 80, quantity: 5, committedSequence: 1 },
  { bidId: "00000000-0000-4000-8000-000000000002", bidderId: "00000000-0000-4000-8000-000000000012", amountMinor: 90, quantity: 3, committedSequence: 2 },
  { bidId: "00000000-0000-4000-8000-000000000001", bidderId: "00000000-0000-4000-8000-000000000011", amountMinor: 100, quantity: 3, committedSequence: 3 },
];

test("worked allocation uses one clearing price and a final partial Award", () => {
  assert.deepEqual(allocateUniformPrice(7, bids), {
    allocatedUnitCount: 7,
    unallocatedUnitCount: 0,
    clearingUnitPriceMinor: 80,
    awards: [
      { bidId: bids[2].bidId, bidderId: bids[2].bidderId, allocatedQuantity: 3, clearingUnitPriceMinor: 80, totalAmountMinor: 240, allocationRank: 1 },
      { bidId: bids[1].bidId, bidderId: bids[1].bidderId, allocatedQuantity: 3, clearingUnitPriceMinor: 80, totalAmountMinor: 240, allocationRank: 2 },
      { bidId: bids[0].bidId, bidderId: bids[0].bidderId, allocatedQuantity: 1, clearingUnitPriceMinor: 80, totalAmountMinor: 80, allocationRank: 3 },
    ],
  });
});

test("safe product uses integer arithmetic at the published boundary", () => {
  assert.equal(assertSafeProduct(450_359_962_737_049, 20), 9_007_199_254_740_980);
  assert.throws(() => assertSafeProduct(450_359_962_737_050, 20));
});

test("canonical objects ignore insertion order", () => {
  assert.equal(canonical({ b: [2, 1], a: 1 }), canonical({ a: 1, b: [2, 1] }));
});

test("bid history oracle requires strict values, contiguous sequence and one leader", () => {
  const history = bids.map((bid, index) => ({ ...bid, state: index === bids.length - 1 ? "WINNING" : "OUTBID" }));
  assert.doesNotThrow(() => assertContiguousBidHistory(history));
  assert.throws(() => assertContiguousBidHistory([{ ...history[0], committedSequence: 2 }]));
});
