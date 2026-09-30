import assert from "node:assert/strict";
import test from "node:test";

import { baseSeed, createFixtureFactory, invalidSeedFixtures, performanceContract, performanceSeed, splitRequest } from "../fixtures/index.mjs";
import { assertQuantityConserved, assertTimeline, canonicalDigest, canonicalJson, percentile, rankMatches } from "../oracles/index.mjs";

const options = { evaluationSeed: "private-seed", caseId: "CONTRACT-01", baseTime: "2035-06-01T12:00:00.000Z" };

test("fixture factory is deterministic and isolated by label", () => {
  const one = createFixtureFactory(options); const two = createFixtureFactory(options);
  assert.equal(one.uuid("item"), two.uuid("item")); assert.equal(one.key("request"), two.key("request")); assert.notEqual(one.uuid("item"), one.uuid("scan")); assert.match(one.uuid("item"), /^[0-9a-f-]{36}$/u);
});

test("base and formal fixtures freeze the V1 seed contract", () => {
  const fixtures = createFixtureFactory(options); const seed = baseSeed(fixtures, { caseCount: 2, itemsPerCase: 3 });
  assert.deepEqual(Object.keys(seed).sort(), ["caseManifests", "cases", "custodians", "custodyMatches", "deviceRegistrations", "facilities", "intakeScans", "schemaVersion", "seedVersion", "transfers"]);
  const formal = performanceSeed(fixtures); assert.equal(formal.cases.length, 100); assert.equal(formal.caseManifests.reduce((sum, manifest) => sum + manifest.items.length, 0), 10_000); assert.equal(formal.intakeScans.length, 10_000); assert.equal(formal.custodyMatches.length, 10_000); assert.equal(formal.transfers.length, 50_000); assert.equal(formal.facilities.length, 10); assert.equal(formal.custodians.length, 10); assert.equal(formal.deviceRegistrations.length, 100);
  assert.deepEqual(performanceContract(), { batch: { clients: 64, warmupSeconds: 10, measureSeconds: 60, scansPerBatch: 20, minimumThroughput: 100, maximumP95Ms: 350 }, timeline: { clients: 64, warmupSeconds: 10, measureSeconds: 60, minimumThroughput: 200, maximumP95Ms: 180 }, verification: { items: 10_000, killedWorkers: 2, replacementWorkers: 2, maximumSeconds: 60 } });
  assert.equal(invalidSeedFixtures(fixtures).length, 3);
});

test("quantity, ranking, timeline and canonical oracles are independent", () => {
  const fixtures = createFixtureFactory(options); const parent = { revision: 3 }; const request = splitRequest(fixtures, parent, [2, 3, 5]); assert.equal(assertQuantityConserved(10, request.aliquots), true); assert.throws(() => assertQuantityConserved(9, request.aliquots), /MISMATCH/u);
  const items = [{ caseId: "c", expectedLabel: "A", expectedSealCode: "S", collectedItemId: "i" }]; const scans = [{ label: "A", sealCode: "X", scannedAt: "2", deviceId: "d", intakeScanId: "b" }, { label: "A", sealCode: "S", scannedAt: "3", deviceId: "d", intakeScanId: "a" }]; assert.equal(rankMatches(items, scans)[0].scan.intakeScanId, "a");
  assert.equal(assertTimeline([{ sequence: 1, type: "MATCH_CONFIRMED", matchId: "m", transferId: null, fromCustodianId: null, toCustodianId: null }, { sequence: 2, type: "CUSTODY_TRANSFERRED", matchId: null, transferId: "t", fromCustodianId: "a", toCustodianId: "b" }]), true);
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}'); assert.equal(canonicalDigest({ a: 1 }).length, 64); assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
});
