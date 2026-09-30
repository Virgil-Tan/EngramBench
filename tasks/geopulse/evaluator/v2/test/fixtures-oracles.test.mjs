import assert from "node:assert/strict";
import test from "node:test";

import {
  bundleFixture,
  coreSeed,
  createFixtureFactory,
  geometryFixture,
  lateWorkedExample,
  performanceContract,
  timelineFixture,
} from "../fixtures/index.mjs";
import {
  assertContiguousTransitions,
  canonicalJson,
  classifyPoint,
  effectiveVersion,
  isValidPolygon,
  percentile,
  projectTimeline,
  replayArrivals,
} from "../oracles/index.mjs";

const fixtures = createFixtureFactory({
  evaluationSeed: "geopulse-fixtures",
  caseId: "A-01",
  baseTime: "2035-06-01T12:00:00.000Z",
});

test("fixtures deterministically freeze UUIDs, time, keys and exact V1 seed resources", () => {
  assert.equal(fixtures.uuid("tenant"), fixtures.uuid("tenant"));
  assert.notEqual(fixtures.uuid("tenant"), fixtures.uuid("device"));
  assert.equal(fixtures.at({ seconds: 3 }), "2035-06-01T12:00:03.000Z");
  assert.match(fixtures.key("ingest"), /^gp-a-01-ingest-[a-f0-9]{18}$/u);
  assert.deepEqual(Object.keys(coreSeed(fixtures)), [
    "schemaVersion", "seedVersion", "importedAt", "tenants", "devices", "regions",
    "regionVersions", "locationEvents", "memberships", "transitions",
  ]);
});

test("independent polygon oracle distinguishes inside, outside, exact edge and vertex", () => {
  const geometry = geometryFixture(fixtures);
  assert.equal(isValidPolygon(geometry.polygon).ok, true);
  assert.equal(classifyPoint(geometry.polygon, geometry.inside).state, "INSIDE");
  assert.equal(classifyPoint(geometry.polygon, geometry.outside).state, "OUTSIDE");
  assert.equal(classifyPoint(geometry.polygon, geometry.edge).state, "BOUNDARY");
  assert.equal(classifyPoint(geometry.polygon, geometry.vertex).state, "BOUNDARY");
  assert.equal(isValidPolygon(geometry.selfIntersecting).code, "SELF_INTERSECTION");
  assert.equal(isValidPolygon(geometry.openRing).code, "RING_NOT_CLOSED");
});

test("effective intervals are half-open and selected by observedAt", () => {
  const geometry = geometryFixture(fixtures);
  assert.equal(effectiveVersion(geometry.versions, fixtures.at({ hours: -1 })).revision, 1);
  assert.equal(effectiveVersion(geometry.versions, fixtures.at()).revision, 2);
  assert.equal(effectiveVersion(geometry.versions, fixtures.at({ hours: 1 })).revision, 2);
});

test("hysteresis suppresses edge jitter and DWELL occurs once per continuous inside interval", () => {
  const timeline = timelineFixture(fixtures);
  const result = projectTimeline(timeline.events, timeline.regionVersion);
  assert.deepEqual(result.transitions.map(({ type }) => type), ["ENTER", "DWELL", "EXIT", "ENTER"]);
  assert.deepEqual(result.transitions.map(({ sequence }) => sequence), [1, 2, 3, 4]);
  assert.equal(result.transitions.filter(({ type }) => type === "DWELL").length, 1);
  assert.equal(result.membership.revision, timeline.events.length);
  assert.doesNotThrow(() => assertContiguousTransitions(result.transitions));
});

test("GP-W1 reverse arrivals converge and the old frontier is LATE_IGNORED", () => {
  const worked = lateWorkedExample(fixtures);
  const canonical = replayArrivals(worked.canonical, worked.regionVersion);
  const reversed = replayArrivals(worked.arrivalOrder, worked.regionVersion);
  assert.deepEqual(reversed.projection.transitions, canonical.projection.transitions);
  assert.deepEqual(reversed.projection.membership, canonical.projection.membership);
  const withOld = replayArrivals([...worked.arrivalOrder, worked.tooOld], worked.regionVersion);
  assert.deepEqual(withOld.projection, reversed.projection);
  assert.deepEqual(withOld.lateIgnored.map(({ eventId }) => eventId), [worked.tooOld.eventId]);
  assert.equal(withOld.watermark, worked.canonical.at(-1).observedAt);
});

test("bundle and formal workloads freeze the published cardinalities", () => {
  const bundle = bundleFixture(fixtures, 100);
  assert.equal(bundle.regionVersionIds.length, 100);
  assert.deepEqual(bundle.regionVersionIds, [...bundle.regionVersionIds].sort());
  assert.deepEqual(performanceContract(), {
    ordered: { events: 500_000, devices: 100_000, clients: 64, seconds: 60, throughput: 500, p95Ms: 250 },
    jitter: { events: 100_000, devices: 2_000, regions: 100, clients: 64, seconds: 60, throughput: 300, p95Ms: 350 },
    query: { regions: 10_000, points: 1_000_000, batchSize: 1_000, seconds: 60, throughput: 20_000, p95Ms: 700 },
  });
});

test("canonical evidence and percentile are deterministic", () => {
  assert.equal(canonicalJson({ z: 1, a: [0, -0, 1.25] }), '{"a":[0,0,1.25],"z":1}');
  assert.equal(percentile([10, 2, 7, 4], 0.95), 10);
});
