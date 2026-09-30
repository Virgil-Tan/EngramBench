import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { assertEvidenceHistory, canonical, exactKeys, percentile, sha256 } from "../oracles/index.mjs";

const options = { evaluationSeed: "moderationflow-test", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" };

test("fixtures are deterministic and ModerationFlow-owned", () => {
  const first = createFixtureFactory(options);
  const second = createFixtureFactory(options);
  assert.equal(first.uuid("tenant"), second.uuid("tenant"));
  assert.equal(first.key("mutation"), second.key("mutation"));
  assert.match(first.key("mutation"), /^mf-/u);
  const seed = first.baseSeed("fixture");
  assert.equal(seed.schemaVersion, 1);
  assert.equal(seed.policyVersions[0].state, "ACTIVE");
  assert.deepEqual(first.policyCategories().map(({ categoryCode }) => categoryCode), ["ABUSE", "SAFE"]);
  assert.deepEqual(first.performance, {
    ingest: { requests: 50_000, concurrency: 96, minimumPerSecond: 250, p95Ms: 350 },
    contention: { operations: 20_000, concurrency: 64, minimumPerSecond: 150, p95Ms: 800 },
    recall: { members: 10_000, killedWorkers: 2, replacementWorkers: 4, maximumSeconds: 90 },
  });
});

test("independent evidence, canonical, digest, shape, and percentile oracles close", () => {
  const fixtures = createFixtureFactory(options);
  const contentItemId = fixtures.uuid("content");
  const items = [1, 2, 3].map((version) => ({ evidenceVersionId: fixtures.uuid(`e-${version}`), contentItemId, version, digest: fixtures.digest(`e-${version}`) }));
  assert.equal(assertEvidenceHistory(items, contentItemId).length, 3);
  assert.throws(() => assertEvidenceHistory([items[0], items[2]], contentItemId), /contiguous/u);
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(sha256("x").length, 64);
  assert.equal(percentile([9, 1, 4, 2], 0.75), 4);
  assert.equal(exactKeys({ a: 1, b: 2 }, ["b", "a"]).a, 1);
});
