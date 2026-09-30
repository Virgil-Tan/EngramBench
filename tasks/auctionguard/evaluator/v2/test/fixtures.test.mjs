import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory, performanceContract, performanceSeed, uniformPriceWorkedExample, v1Seed } from "../lib/fixtures.mjs";
import { allocateUniformPrice } from "../lib/oracle.mjs";

function factory() {
  return createFixtureFactory({ evaluationSeed: "fixture-seed", caseId: "CLEAR-03", baseTime: "2035-06-01T12:00:00.000Z" });
}

test("AuctionGuard fixtures are deterministic and case-scoped", () => {
  assert.equal(factory().uuid("auction"), factory().uuid("auction"));
  assert.notEqual(factory().uuid("auction"), createFixtureFactory({ evaluationSeed: "fixture-seed", caseId: "BID-01", baseTime: "2035-06-01T12:00:00.000Z" }).uuid("auction"));
});

test("V1 seed keeps the exact published schema and references", () => {
  const seed = v1Seed(factory(), { label: "contract" });
  assert.deepEqual(Object.keys(seed), ["schemaVersion", "seedVersion", "bidders", "lots", "auctions", "bids"]);
  assert.equal(seed.auctions[0].lotId, seed.lots[0].lotId);
  assert.equal(seed.auctions[0].antiSnipingWindowSeconds, 120);
});

test("worked example is independent and yields 3, 3, 1 at clearing price 80", () => {
  const fixture = uniformPriceWorkedExample(factory());
  const result = allocateUniformPrice(fixture.unitCount, fixture.bids);
  assert.deepEqual(result.awards.map(({ allocatedQuantity }) => allocatedQuantity), [3, 3, 1]);
  assert.deepEqual(result.awards.map(({ clearingUnitPriceMinor }) => clearingUnitPriceMinor), [80, 80, 80]);
});

test("performance fixture freezes every published scale and threshold", () => {
  assert.deepEqual(performanceContract(), {
    seed: { bidders: 100_000, lots: 2_020, auctions: 2_020, bids: 50_000 },
    hotBids: { auctions: 20, concurrency: 20, warmupSeconds: 10, measureSeconds: 60, minimumRate: 250, maximumP95Ms: 300 },
    liveReads: { auctions: 20, concurrency: 64, warmupSeconds: 10, measureSeconds: 60, minimumRate: 400, maximumP95Ms: 100 },
    closeRecovery: { dueAuctions: 2_000, workers: 2, maximumSeconds: 45 },
  });
});

test("performance seed has the exact public scale and hot/due partition", () => {
  const seed = performanceSeed();
  assert.equal(seed.bidders.length, 100_000);
  assert.equal(seed.lots.length, 2_020);
  assert.equal(seed.auctions.length, 2_020);
  assert.equal(seed.bids.length, 50_000);
  assert.equal(seed.auctions.filter(({ state }) => state === "OPEN").length, 20);
  assert.equal(seed.auctions.filter(({ state }) => state === "CLOSING").length, 2_000);
});
