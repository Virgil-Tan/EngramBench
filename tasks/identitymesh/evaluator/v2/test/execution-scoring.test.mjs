import assert from "node:assert/strict";
import test from "node:test";

import contractMap from "../contract-map.v2.json" with { type: "json" };
import manifest from "../manifest.v2.json" with { type: "json" };
import { executeCase } from "../lib/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const passed = ({ id, dimension, weight }) => ({ id, dimension, weight, status: "passed", durationMs: 1, evidenceDigest: "a".repeat(64) });

test("all exact cases score 100 and every dimension closes", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: manifest.cases.map(passed) });
  assert.equal(result.score, 100);
  assert.equal(result.verdict, "accepted");
  assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("declared contract gaps remain fail-closed diagnostics without score renormalization", () => {
  const cases = manifest.cases.map((item) => item.blockedAssertions?.length
    ? { id: item.id, status: "diagnostic", diagnostics: item.blockedAssertions.map(({ id, blockedBy }) => ({ assertionId: id, blockedBy, status: "blocked", policy: "fail-closed-diagnostic" })) }
    : passed(item));
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic");
  assert.equal(result.formalEligible, false);
  assert.equal(result.blockedWeight, 40.5);
  assert.equal(result.maxAchievable, 59.5);
  assert.equal(result.rawScore, 59.5);
});

test("candidate security failures use task-owned prefix and declared hard cap", async () => {
  const definition = manifest.cases[0]; const mapping = contractMap.cases[0];
  const implementation = { run: async () => { const error = new Error("secret exposure"); error.failureCodeSuffix = "SECRET"; error.hardCapIds = ["SECRET_EXPOSURE"]; throw error; } };
  const outcome = await executeCase({ definition, implementation, withContext: async (_options, operation) => operation({}), contextOptions: {}, failureCodePrefix: mapping.privateFailureCodePrefix });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.privateFailureCode, "IM_A01_SECRET");
  assert.deepEqual(outcome.hardCapIds, ["SECRET_EXPOSURE"]);
  const cases = manifest.cases.map((item) => item.id === definition.id ? outcome : passed(item));
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.rawScore, 94);
  assert.equal(result.score, 25);
});
