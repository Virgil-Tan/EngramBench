import assert from "node:assert/strict";
import test from "node:test";

import { PERF_COUNTS, createFixtureFactory, dispatchSeed, performanceSeed } from "../lib/fixtures.mjs";

test("DispatchBoard fixtures are deterministic and use the exact V1 seed envelope", () => {
  const options = { evaluationSeed: "unit-seed", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" };
  const firstFixtures = createFixtureFactory(options);
  const secondFixtures = createFixtureFactory(options);
  const first = dispatchSeed(firstFixtures, "basic");
  const second = dispatchSeed(secondFixtures, "basic");
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first.seed).sort(), [
    "assignments", "couriers", "customers", "deliveries", "offerNotifications", "offers",
    "schemaVersion", "seedVersion", "zoneDistances", "zones",
  ]);
  assert.equal(first.seed.schemaVersion, 1);
  assert.equal(first.seed.zoneDistances.length, first.seed.zones.length ** 2);
});

test("the formal performance fixture cardinalities are immutable", () => {
  assert.deepEqual(PERF_COUNTS, {
    zones: 100, zoneDistances: 10_000, couriers: 10_000, customers: 100_000,
    deliveries: 5_200, offers: 30_000, assignments: 0, hotOffers: 1_000, dueOffers: 5_000,
  });
  const fixtures = createFixtureFactory({ evaluationSeed: "perf-audit", caseId: "E-03", baseTime: "2035-06-01T12:00:00.000Z" });
  const now = Date.parse("2035-06-01T12:00:00.000Z");
  const seed = performanceSeed(fixtures, { now });
  assert.deepEqual({
    zones: seed.zones.length,
    zoneDistances: seed.zoneDistances.length,
    couriers: seed.couriers.length,
    customers: seed.customers.length,
    deliveries: seed.deliveries.length,
    offers: seed.offers.length,
    assignments: seed.assignments.length,
    hotOffers: seed.offers.filter(({ state, expiresAt }) => state === "OPEN" && Date.parse(expiresAt) > now).length,
    dueOffers: seed.offers.filter(({ state, expiresAt }) => state === "OPEN" && Date.parse(expiresAt) <= now).length,
  }, PERF_COUNTS);
  assert.equal(seed.seedVersion, "perf-v1");
  assert.equal(seed.offerNotifications.length, PERF_COUNTS.offers);
});
