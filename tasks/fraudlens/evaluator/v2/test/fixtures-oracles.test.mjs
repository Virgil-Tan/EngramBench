import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { auditDigest, canonicalJson, correctionDigest, evaluateRules } from "../oracles/index.mjs";

const options = { evaluationSeed: "f".repeat(64), caseId: "A-01", baseTime: "2035-07-01T12:00:00.000Z" };

test("fixtures are deterministic task-local and seed contract complete", () => {
  const left = createFixtureFactory(options);
  const right = createFixtureFactory(options);
  assert.equal(left.uuid("x"), right.uuid("x"));
  assert.equal(left.key("x"), right.key("x"));
  assert.deepEqual(left.seed(), right.seed());
  assert.deepEqual(Object.keys(left.seed()).sort(), [
    "assessments", "auditEntries", "importedAt", "reviewCases", "reviewDecisions", "riskEvents",
    "ruleHits", "ruleRollbacks", "ruleSets", "ruleVersions", "schemaVersion", "seedVersion", "tenants",
  ]);
  assert.notEqual(left.ids.tenantId, left.ids.otherTenantId);
});

test("FL-W1 sums before final clamp and orders same-priority hits by ruleId", () => {
  const fixtures = createFixtureFactory(options);
  const version = { rules: fixtures.workedRules(), reviewThreshold: 700, blockThreshold: 900 };
  const event = fixtures.event(1, { attributes: { a: true, b: true, c: true } });
  const result = evaluateRules(event, version);
  assert.equal(result.score, 800);
  assert.equal(result.recommendation, "REVIEW");
  assert.deepEqual(result.ruleHits.map((item) => item.ruleId), ["a", "b", "c"]);
});

test("reference model handles final boundaries overflow and correction digest", () => {
  const fixtures = createFixtureFactory(options);
  const event = fixtures.event(2, { amountMinor: 50_000, attributes: { velocity: 9, tags: ["hot"] } });
  const version = { rules: [fixtures.rule({ score: 1_200 }), fixtures.rule({ ruleId: "negative", priority: 20, score: -300 })], reviewThreshold: 700, blockThreshold: 900 };
  assert.equal(evaluateRules(event, version).score, 900);
  assert.equal(evaluateRules(event, version).recommendation, "BLOCK");
  assert.match(correctionDigest(event, version), /^[a-f0-9]{64}$/u);
  const overflow = { ...version, rules: [fixtures.rule({ score: Number.MAX_SAFE_INTEGER }), fixtures.rule({ ruleId: "overflow", score: Number.MAX_SAFE_INTEGER })] };
  assert.throws(() => evaluateRules(event, overflow), /SCORE_OVERFLOW/u);
});

test("canonical and audit digest are stable", () => {
  assert.equal(canonicalJson({ b: 2, a: [3, 1] }), '{"a":[3,1],"b":2}');
  const entry = {
    tenantId: "11111111-1111-4111-8111-111111111111",
    sequence: 1,
    eventType: "risk.accepted",
    subjectRef: "risk:1",
    payloadDigest: "a".repeat(64),
    priorDigest: null,
    createdAt: "2035-07-01T12:00:00.000Z",
  };
  assert.equal(auditDigest(entry), auditDigest({ ...entry }));
});
