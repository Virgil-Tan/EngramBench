import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixtureFactory,
  makeComparisonCorpus,
  makeCoreSeed,
  makeDepthExpression,
  makeWorkedExample,
  performanceContract,
} from "../fixtures/index.mjs";
import { evaluateRuleSet, sha256Canonical, validateExpression } from "../oracles/index.mjs";

const options = { evaluationSeed: "rulebench-private-seed", caseId: "A-03", baseTime: "2035-06-01T12:00:00.000Z" };

test("fixture identity is deterministic and case scoped", () => {
  const first = createFixtureFactory(options);
  const second = createFixtureFactory(options);
  const other = createFixtureFactory({ ...options, caseId: "A-04" });
  assert.equal(first.uuid("tenant"), second.uuid("tenant"));
  assert.notEqual(first.uuid("tenant"), other.uuid("tenant"));
  assert.equal(first.at({ minutes: 2 }), "2035-06-01T12:02:00.000Z");
});

test("core seed has exact public keys and self-consistent published rule digests", () => {
  const fixture = makeCoreSeed(options);
  assert.deepEqual(Object.keys(fixture.seed).sort(), [
    "conflictReports", "evaluations", "explanationNodes", "importedAt", "replayRuns", "ruleSetVersions", "ruleSets", "rules", "schemaVersion", "seedVersion", "tenants",
  ].sort());
  for (const version of fixture.seed.ruleSetVersions) {
    const rules = fixture.seed.rules.filter(({ ruleSetVersionId }) => ruleSetVersionId === version.ruleSetVersionId);
    assert.equal(version.rulesDigest, sha256Canonical(rules));
  }
});

test("depth fixtures straddle the exact public boundary", () => {
  assert.equal(validateExpression(makeDepthExpression(20)).ok, true);
  assert.equal(validateExpression(makeDepthExpression(21)).code, "EXPRESSION_TOO_DEEP");
});

test("worked example independently resolves REVIEW then terminal DENY", () => {
  const fixture = makeWorkedExample(options);
  const outcome = evaluateRuleSet({ rules: fixture.rules, defaultDecision: "ALLOW", facts: fixture.facts });
  assert.equal(outcome.decision, "DENY");
  assert.deepEqual(outcome.tags, ["a", "b"]);
  assert.deepEqual(outcome.matchedRuleIds, [fixture.ids.rule1Id, fixture.ids.rule2Id]);
  assert.equal(outcome.nodes.filter(({ ruleId, result }) => ruleId === fixture.ids.rule3Id && result === "SKIPPED").length, 1);
});

test("comparison corpus freezes unique UUID order and canonical digest", () => {
  const fixture = makeCoreSeed(options);
  const values = [fixture.fixtures.uuid("evaluation-2"), fixture.fixtures.uuid("evaluation-1")];
  const corpus = makeComparisonCorpus([...values, values[0]]);
  assert.deepEqual(corpus.evaluationIds, [...new Set(values)].sort());
  assert.equal(corpus.corpusDigest, sha256Canonical(corpus.evaluationIds));
});

test("performance contract preserves all formal public scales", () => {
  assert.deepEqual(performanceContract(), {
    evaluation: { rules: 200, evaluations: 200_000, clients: 64, seconds: 60, throughput: 600, p95Ms: 250, drainSeconds: 60 },
    shortCircuit: { rules: 5_000, evaluations: 100_000, terminalMaximum: 10, clients: 64, seconds: 60, throughput: 400, p95Ms: 350 },
    comparison: { evaluations: 50_000, killedWorkers: 2, replacements: 4, seconds: 60 },
  });
});
