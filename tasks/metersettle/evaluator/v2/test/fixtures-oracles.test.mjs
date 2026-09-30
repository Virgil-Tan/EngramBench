import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import {
  assertRevisionChain, canonicalJson, expectedRevision, monthInterval, ratePeriod, safeAdd, safeMultiply,
} from "../oracles/index.mjs";
import { performanceBatch } from "../cases/perf.mjs";

const options = { evaluationSeed: "fixed-seed", caseId: "B-01", baseTime: "2035-06-01T12:00:00.000Z" };

test("fixtures are deterministic, isolated by case and expose every frozen family", () => {
  const first = createFixtureFactory(options); const second = createFixtureFactory(options); const other = createFixtureFactory({ ...options, caseId: "B-02" });
  assert.equal(canonicalJson(first.rating()), canonicalJson(second.rating())); assert.notEqual(first.uuid("tenant"), other.uuid("tenant"));
  assert.deepEqual([first.empty().fixtureFamily, first.rating().fixtureFamily, first.dedupe().fixtureFamily, first.watermark().fixtureFamily, first.recovery().fixtureFamily, first.eventFamily().fixtureFamily, first.correctionFamily().fixtureFamily, first.migration().fixtureFamily, first.browser().fixtureFamily, first.performance().fixtureFamily], ["F-EMPTY", "F-V1-RATING", "F-DEDUPE", "F-WATERMARK", "F-WORK", "F-EVENT", "F-CORRECTION", "F-MIGRATION", "F-BROWSER", "F-PERF-V1"]);
});

test("UTC month and occurredAt plan oracle covers the worked example", () => {
  const fixture = createFixtureFactory(options); const family = fixture.correctionFamily();
  assert.deepEqual(monthInterval("2034-12-31T23:59:59.999Z"), { periodStart: "2034-12-01T00:00:00.000Z", periodEnd: "2035-01-01T00:00:00.000Z" });
  assert.deepEqual(monthInterval("2035-01-01T00:00:00.000Z"), { periodStart: "2035-01-01T00:00:00.000Z", periodEnd: "2035-02-01T00:00:00.000Z" });
  const rated = ratePeriod([family.events[0]], family.plans, family.corrections.slice(0, 2)); assert.equal(rated.lines[0].quantity, 11); assert.equal(rated.lines[0].unitPriceMinor, 7); assert.equal(rated.totalMinor, 77);
});

test("Revision oracle uses byte ordering and a continuous finalized chain", () => {
  const fixture = createFixtureFactory(options); const family = fixture.correctionFamily(); const base = { totalMinor: 70 }; const revision = { ...expectedRevision({ statementId: fixture.uuid("statement"), revision: 2, priorTotalMinor: 70, corrections: family.corrections.slice(0, 2), events: family.events, ratePlans: family.plans }), statementRevisionId: fixture.uuid("revision"), state: "FINALIZED", finalizedAt: fixture.at() };
  assert.equal(revision.deltaMinor, 7); assert.deepEqual(revision.correctionIds, ["correction-a", "correction-z"]); assert.equal(assertRevisionChain(base, [revision]), 77);
});

test("safe integer helpers reject overflow", () => {
  assert.equal(safeAdd(1, 2), 3); assert.equal(safeMultiply(7, 11), 77); assert.throws(() => safeAdd(Number.MAX_SAFE_INTEGER, 1)); assert.throws(() => safeMultiply(Number.MAX_SAFE_INTEGER, 2));
});

test("fixed performance fixture cannot drift", () => {
  const fixtures = createFixtureFactory(options); const spec = fixtures.performance(); assert.deepEqual(spec, { fixtureFamily: "F-PERF-V1", seedVersion: "perf-v1", importedAt: "2026-01-01T00:00:00.000Z", tenantCount: 100, meterCount: 10000, ratePlanCount: 100, eventCount: 1000000, closedEventCount: 10000, warmupBatchCount: 100, measuredBatchCount: 600, batchSize: 100, httpConcurrency: 64, warmupSeconds: 10, measureSeconds: 60, scenarios: ["usage-batch-ingest", "statement-read", "rating-recovery"] }); const tenants = [fixtures.tenant]; const meters = fixtures.meters.map((meter) => ({ ...meter, tenantId: fixtures.tenant.tenantId })); const first = performanceBatch({ tenants, meters }, "perf-measured", 0); const second = performanceBatch({ tenants, meters }, "perf-measured", 1); assert.equal(first.events.length, 100); assert.equal(new Set([...first.events, ...second.events].map(({ eventId }) => eventId)).size, 200);
});
