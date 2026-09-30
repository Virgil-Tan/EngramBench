import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { allocateByPriority, assertCoreInvariants, assertPaymentPrecedence, canonicalJson, quoteOracle } from "../oracles/index.mjs";

const options = { evaluationSeed: "f".repeat(64), caseId: "B-01", baseTime: "2035-06-01T12:00:00.000Z" };

test("fixtures are deterministic task-local and retain the exact V1 seed surface", () => {
  const left = createFixtureFactory(options);
  const right = createFixtureFactory(options);
  const fixture = left.main();
  assert.equal(left.uuid("x"), right.uuid("x"));
  assert.equal(left.key("x"), right.key("x"));
  assert.equal(canonicalJson(fixture.seed), canonicalJson(right.main().seed));
  assert.deepEqual(Object.keys(fixture.seed).sort(), ["schemaVersion", "seedVersion", "tenants", "buyers", "products", "offerVersions", "inventoryPools", "orders", "orderLines", "inventoryHolds", "paymentAttempts", "fulfillmentPlans", "entitlementGrants", "ledgerEntries", "notificationDeliveries"].sort());
  assert.equal(fixture.fixtureFamily, "CC-F-MAIN");
});

test("worked inventory and frozen-money oracles distinguish partial and wrong-priority allocation", () => {
  const factory = createFixtureFactory(options);
  const fixture = factory.quote();
  assert.deepEqual(allocateByPriority(6, fixture.pools.filter(({ productId }) => productId === fixture.physical.productId)), [
    { inventoryPoolId: fixture.pools[0].inventoryPoolId, quantity: 3 },
    { inventoryPoolId: fixture.pools[1].inventoryPoolId, quantity: 3 },
  ]);
  assert.equal(allocateByPriority(9, fixture.pools.filter(({ productId }) => productId === fixture.physical.productId)), null);
  const expected = quoteOracle(factory.mixedQuoteBody(fixture).lines, new Map(fixture.seed.offerVersions.map((offer) => [offer.productId, offer])));
  assert.deepEqual(expected.map(({ lineTotalMinor }) => lineTotalMinor), [1_320, 770]);
  assert.equal(assertPaymentPrecedence(["CAPTURED", "DECLINED", "UNKNOWN"]), "CAPTURED");
});

test("core oracle rejects inventory drift and accepts an empty valid public snapshot", () => {
  const fixture = createFixtureFactory(options).main();
  const resources = Object.fromEntries(["tenants", "buyers", "products", "offerVersions", "inventoryPools", "orders", "orderLines", "inventoryHolds", "paymentAttempts", "fulfillmentPlans", "entitlementGrants", "ledgerEntries", "notificationDeliveries"].map((key) => [key, structuredClone(fixture.seed[key])]));
  const snapshot = { asOf: options.baseTime, resources, events: [], work: [] };
  assert.equal(assertCoreInvariants(snapshot), true);
  snapshot.resources.inventoryPools[0].reserved = 1;
  assert.throws(() => assertCoreInvariants(snapshot), /reserved equation/u);
});

test("performance fixture freezes all ten published scenario cardinalities and thresholds", () => {
  const factory = createFixtureFactory(options);
  const scenarios = factory.performance().scenarios;
  assert.deepEqual(Object.keys(scenarios), ["quoteReadMix", "checkoutContention", "inventoryHotspot", "paymentUnknown", "fulfillmentDrain", "notificationUnknownAck", "entitlementStorm", "settlementClose", "refundDisputeRace", "catastrophe"]);
  assert.deepEqual([scenarios.quoteReadMix.products, scenarios.checkoutContention.quotes, scenarios.inventoryHotspot.attempts, scenarios.paymentUnknown.attempts, scenarios.fulfillmentDrain.orders, scenarios.notificationUnknownAck.notifications, scenarios.entitlementStorm.lines, scenarios.settlementClose.allocations, scenarios.refundDisputeRace.orders, scenarios.catastrophe.entities], [20_000, 2_000, 50_000, 5_000, 10_000, 10_000, 20_000, 50_000, 20_000, 10_000]);
  const catalog = factory.largeCatalog(100);
  assert.deepEqual([catalog.products.length, catalog.seed.offerVersions.length, catalog.seed.inventoryPools.length], [100, 100, 100]);
});
