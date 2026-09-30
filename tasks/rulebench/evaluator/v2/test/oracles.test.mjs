import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJson,
  compareResult,
  detectConflicts,
  evaluateExpression,
  evaluateRuleSet,
  sha256Canonical,
  validateExpression,
} from "../oracles/index.mjs";

const id = (value) => `52000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

test("canonical JSON ignores object insertion order but preserves array order", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: true, x: null } }), '{"a":{"x":null,"y":true},"z":1}');
  assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
  assert.notEqual(sha256Canonical([1, 2]), sha256Canonical([2, 1]));
});

test("expression semantics keep missing distinct from null and never coerce", () => {
  assert.equal(evaluateExpression({ op: "exists", path: "$.missing", value: null }, {}).result, false);
  assert.equal(evaluateExpression({ op: "eq", path: "$.value", value: null }, {}).result, false);
  assert.equal(evaluateExpression({ op: "eq", path: "$.value", value: null }, { value: null }).result, true);
  assert.equal(evaluateExpression({ op: "eq", path: "$.value", value: 7 }, { value: "7" }).result, false);
  assert.equal(evaluateExpression({ op: "in", path: "$.value", value: [7, "7"] }, { value: 7 }).result, true);
  assert.equal(evaluateExpression({ op: "lt", path: "$.value", value: 8 }, { value: 7 }).result, true);
  assert.throws(() => evaluateExpression({ op: "lt", path: "$.value", value: 8 }, { value: "7" }), /safe integers/u);
});

test("expression validator enforces exact grammar, depth, and child cardinality", () => {
  assert.equal(validateExpression({ all: [{ op: "exists", path: "$.x", value: true }] }).ok, true);
  assert.equal(validateExpression({ any: [] }).code, "EXPRESSION_CARDINALITY");
  assert.equal(validateExpression({ op: "regex", path: "$.x", value: "x" }).code, "UNKNOWN_OPERATOR");
  assert.equal(validateExpression({ op: "eq", path: "$.__proto__", value: 1, extra: true }).code, "UNKNOWN_FIELD");
});

test("worked example stops at terminal rule and emits one skipped node per later rule", () => {
  const rules = [
    { ruleId: id(2), priority: 20, condition: { op: "eq", path: "$.risk", value: "high" }, effect: { decision: "DENY", tags: ["b"] }, terminal: true },
    { ruleId: id(1), priority: 10, condition: { op: "exists", path: "$.risk", value: null }, effect: { decision: "REVIEW", tags: ["a", "b"] }, terminal: false },
    { ruleId: id(3), priority: 30, condition: { op: "eq", path: "$.explode", value: true }, effect: { decision: "ALLOW", tags: ["never"] }, terminal: true },
  ];
  const outcome = evaluateRuleSet({ rules, defaultDecision: "ALLOW", facts: { risk: "high" } });
  assert.equal(outcome.decision, "DENY");
  assert.deepEqual(outcome.tags, ["a", "b"]);
  assert.deepEqual(outcome.matchedRuleIds, [id(1), id(2)]);
  assert.equal(outcome.nodes.filter(({ ruleId, result }) => ruleId === id(3) && result === "SKIPPED").length, 1);
  assert.match(outcome.explanationDigest, /^[0-9a-f]{64}$/u);
});

test("conflict report and comparison result digests are independently deterministic", () => {
  const duplicate = { ruleId: id(1), priority: 10, condition: { op: "exists", path: "$.risk", value: null }, effect: { decision: "ALLOW", tags: [] }, terminal: false };
  const reports = detectConflicts([
    duplicate,
    { ...duplicate, ruleId: id(2), effect: { decision: "DENY", tags: [] } },
  ]);
  assert.deepEqual(reports.map(({ code }) => code), ["AMBIGUOUS_CONDITION", "DUPLICATE_PRIORITY"]);
  const result = compareResult({
    comparisonRunId: id(90), evaluationId: id(91), ordinal: 1,
    baseline: { decision: "ALLOW", tags: [], explanationDigest: "a".repeat(64) },
    candidate: { decision: "DENY", tags: [], explanationDigest: "b".repeat(64) },
  });
  assert.equal(result.status, "DIFF");
  assert.equal(result.resultDigest, sha256Canonical(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "resultDigest"))));
});
