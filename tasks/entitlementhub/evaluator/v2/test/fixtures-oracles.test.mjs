import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { assertGrantIntervals, assertPoolClosure, assertRefundConservation, canonicalJson, sha256 } from "../oracles/index.mjs";

const factory = createFixtureFactory({ evaluationSeed: "eh-tests", caseId: "DATA-04", baseTime: "2035-06-01T12:00:00.000Z" });

test("fixtures are deterministic and cover contract, data, recovery, layer, operate, and V1", () => {
  const again = createFixtureFactory({ evaluationSeed: "eh-tests", caseId: "DATA-04", baseTime: "2035-06-01T12:00:00.000Z" });
  assert.equal(factory.uuid("tenant"), again.uuid("tenant")); assert.match(factory.key("mutation"), /^eh-/u);
  for (const name of ["contract", "data", "recovery", "layer", "operate", "v1Final"]) assert.equal(factory[name]().seed.schemaVersion, 1);
  assert.deepEqual(factory.operate().scenarios, ["entitlement-decision-read", "upgrade-refund-race", "expiry-revocation-recovery"]);
});

test("independent invariant oracles reject Grant gaps or overlap, excess refund, and pool oversell", () => {
  const fixture = factory.data(); const grants = fixture.seed.entitlementGrants; assert.equal(assertGrantIntervals(grants), true); const first = { ...grants[0], validUntil: "2025-02-01T00:00:00.000Z" }; const adjoining = { ...grants[0], grantId: factory.uuid("next-grant"), grantRevision: 2, validFrom: first.validUntil }; assert.equal(assertGrantIntervals([first, adjoining]), true); assert.throws(() => assertGrantIntervals([first, { ...adjoining, validFrom: "2025-01-31T00:00:00.000Z" }])); assert.throws(() => assertGrantIntervals([first, { ...adjoining, validFrom: "2025-02-02T00:00:00.000Z" }]));
  assert.equal(assertRefundConservation(fixture.seed.subscriptions, fixture.seed.planRevisions, fixture.seed.refunds), true); assert.throws(() => assertRefundConservation(fixture.seed.subscriptions, fixture.seed.planRevisions, [{ subscriptionId: fixture.active.subscriptionId, amountMinor: 1001, state: "UNKNOWN" }]));
  assert.equal(assertPoolClosure({ seatLimit: 2, state: "ACTIVE", version: 2 }, [{ subjectId: "a", state: "ACTIVE" }, { subjectId: "b", state: "ACTIVE" }]), true);
  assert.throws(() => assertPoolClosure({ seatLimit: 1, state: "ACTIVE", version: 2 }, [{ subjectId: "a", state: "ACTIVE" }, { subjectId: "b", state: "ACTIVE" }]));
  assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256('{"a":1,"b":2}'));
});
