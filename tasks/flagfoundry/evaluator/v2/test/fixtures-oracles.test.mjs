import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { canonicalJson, evaluateSnapshot, failureBasisPoints, findSubjectForBucket, percentageBucket, revisionDiff, rolloutBucket, selectRolloutSnapshot, snapshotDigest } from "../oracles/index.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "fixture-test", caseId: "B-01", baseTime: "2035-01-01T00:00:00.000Z" });

test("task-local fixtures are deterministic and internally linked", () => {
  const first = fixtures.flag(), second = fixtures.flag();
  assert.deepEqual(first.seed, second.seed);
  assert.equal(first.stringActive.snapshotDigest, snapshotDigest(first.snapshot()));
  assert.equal(first.seed.activeRevisions.every(({ flagId }) => first.seed.flags.some((flag) => flag.flagId === flagId)), true);
  assert.equal(first.fixtureFamily, "FF-F-FLAG");
});

test("RFC 8785 object ordering is canonical while arrays remain ordered", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), canonicalJson({ a: { x: 3, y: 2 }, z: 1 }));
  const snapshot = fixtures.snapshot();
  assert.notEqual(snapshotDigest(snapshot), snapshotDigest({ ...snapshot, variants: [...snapshot.variants].reverse() }));
});

test("rule, percentage and rollout buckets use separate frozen inputs", () => {
  const snapshot = fixtures.snapshot();
  const rule = evaluateSnapshot(snapshot, { subjectKey: "subject-rule", context: { plan: "enterprise", country: "US", region: "na" } });
  assert.equal(rule.reason, "RULE"); assert.equal(rule.variant.key, "candidate");
  const subject = findSubjectForBucket((value) => percentageBucket(snapshotDigest(snapshot), snapshot.flagKey, value), (bucket) => bucket === 4_999, "percentage");
  assert.equal(evaluateSnapshot(snapshot, { subjectKey: subject.subjectKey, context: {} }).variant.key, "control");
  const rolloutSubject = findSubjectForBucket((value) => rolloutBucket(snapshot.flagKey, snapshot.environment, value), (bucket) => bucket === 2_499, "rollout");
  assert.equal(selectRolloutSnapshot({ flagKey: snapshot.flagKey, environment: snapshot.environment, subjectKey: rolloutSubject.subjectKey, exposure: 2_500, prior: "prior", candidate: "candidate" }).selected, "candidate");
});

test("failure basis points floors and revision diff separates order from membership", () => {
  assert.equal(failureBasisPoints(9, 1), 1_000);
  const from = fixtures.snapshot(), to = structuredClone(from);
  to.variants.reverse(); to.rules[0].clauses[0].value = "pro";
  const diff = revisionDiff(from, to);
  assert.equal(diff.variantOrderChanged, true);
  assert.deepEqual(diff.changedRuleIds, [from.rules[0].ruleId]);
});
