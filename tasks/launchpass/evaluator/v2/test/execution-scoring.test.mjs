import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { EvaluationInfrastructureError, executeCase } from "../lib/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));
const passing = () => manifest.cases.map(({ id, dimension, weight }) => ({ id, dimension, weight, status: "passed" }));

test("blocked subassertions fail closed as a diagnostic exclusion, not a synthetic pass", async () => {
  const definition = manifest.cases.find(({ id }) => id === "A-05");
  const outcome = await executeCase({
    definition,
    implementation: {
      id: "A-05",
      async run() {
        return {
          evidence: ["all published assertions passed"],
          status: "excluded",
          reason: "blocked_public_contract",
        };
      },
    },
    withContext: async (_options, operation) => operation({}),
    contextOptions: {},
    failureCodePrefix: "LP_A05_",
  });
  assert.equal(outcome.status, "excluded");
  assert.equal(outcome.reason, "blocked_public_contract");
});

test("candidate failures and evaluator failures remain separate", async () => {
  const definition = manifest.cases[0];
  const run = (error) => executeCase({
    definition,
    implementation: { id: definition.id, run: async () => { throw error; } },
    withContext: async (_options, operation) => operation({}),
    contextOptions: {},
    failureCodePrefix: "LP_A01_",
  });
  const failed = await run(new Error("candidate response differed"));
  assert.equal(failed.status, "failed");
  assert.match(failed.privateFailureCode, /^LP_A01_/u);
  const infrastructure = await run(new EvaluationInfrastructureError("postgres_unavailable"));
  assert.equal(infrastructure.status, "evaluator_error");
  assert.equal(infrastructure.evaluatorErrorCode, "EVALUATOR_POSTGRES_UNAVAILABLE");
});

test("all-green scoring accepts, while declared gaps produce a diagnostic ceiling", () => {
  const accepted = scoreEvaluation(manifest, contractMap, { cases: passing() });
  assert.equal(accepted.verdict, "accepted");
  assert.equal(accepted.score, 100);
  assert.deepEqual(accepted.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });

  const diagnostic = passing();
  for (const id of ["A-05", "D-04"]) {
    const index = diagnostic.findIndex((item) => item.id === id);
    diagnostic[index] = {
      ...diagnostic[index],
      status: "excluded",
      reason: "blocked_public_contract",
    };
  }
  const scored = scoreEvaluation(manifest, contractMap, { cases: diagnostic });
  assert.equal(scored.verdict, "rejected");
  assert.equal(scored.evaluationMode, "diagnostic");
  assert.equal(scored.formalEligible, false);
  assert.equal(scored.blockedWeight, 9);
  assert.equal(scored.maxAchievable, 91);
  assert.equal(scored.score, 91);
});

test("correctness failures apply the published score cap", () => {
  const cases = passing();
  const index = cases.findIndex(({ id }) => id === "B-01");
  cases[index] = {
    ...cases[index],
    status: "failed",
    privateFailureCode: "LP_B01_OVERSOLD",
    hardCapIds: ["CORRECTNESS_INVARIANT"],
  };
  const scored = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(scored.score, 30);
  assert.deepEqual(scored.hardCapsApplied.map(({ id }) => id), ["CORRECTNESS_INVARIANT"]);
});
