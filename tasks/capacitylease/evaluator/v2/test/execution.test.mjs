import assert from "node:assert/strict";
import test from "node:test";

import {
  CaseExcluded,
  EvaluationInfrastructureError,
  executeCase,
  validateCaseRegistry,
} from "../lib/execution.mjs";

const manifest = {
  cases: [
    { id: "A-01", dimension: "A", weight: 2 },
    { id: "B-01", dimension: "B", weight: 2.5 },
  ],
};

test("case registry must implement exactly the frozen manifest", () => {
  assert.doesNotThrow(() => validateCaseRegistry(manifest, [
    { id: "A-01", run() {} },
    { id: "B-01", run() {} },
  ]));
  assert.throws(() => validateCaseRegistry(manifest, [{ id: "A-01", run() {} }]), /exactly/u);
  assert.throws(() => validateCaseRegistry(manifest, [
    { id: "A-01", run() {} },
    { id: "A-01", run() {} },
  ]), /duplicate/u);
});

test("executeCase records passing public evidence without experiment-arm input", async () => {
  const received = [];
  const result = await executeCase({
    definition: manifest.cases[0],
    implementation: {
      id: "A-01",
      async run(ctx) {
        received.push(Object.keys(ctx));
        return { evidence: [{ kind: "http", status: 200 }] };
      },
    },
    withContext: async (_options, operation) => operation({ workspace: "/submission" }),
    contextOptions: { workspace: "/submission", evaluationSeed: "seed" },
    failureCodePrefix: "CL_A01_",
  });

  assert.equal(result.status, "passed");
  assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(received, [["workspace"]]);
  assert.equal("experimentArm" in result, false);
});

test("a passing case cannot accidentally trigger a hard cap", async () => {
  const result = await executeCase({
    definition: manifest.cases[0],
    implementation: {
      id: "A-01",
      async run() {
        return { evidence: ["booted"], hardCapIds: ["BUILD_MIGRATION_OR_BOOT"] };
      },
    },
    withContext: async (_options, operation) => operation({}),
    contextOptions: {},
    failureCodePrefix: "CL_A01_",
  });

  assert.equal(result.status, "passed");
  assert.equal("hardCapIds" in result, false);
});

test("candidate assertion, exclusion, and infrastructure errors stay distinct", async () => {
  const base = {
    definition: manifest.cases[0],
    contextOptions: {},
    failureCodePrefix: "CL_A01_",
  };
  const run = async (error) => executeCase({
    ...base,
    implementation: { id: "A-01", run: async () => { throw error; } },
    withContext: async (_options, operation) => operation({}),
  });

  const failed = await run(new assert.AssertionError({ message: "boot did not become healthy" }));
  assert.equal(failed.status, "failed");
  assert.match(failed.privateFailureCode, /^CL_A01_/u);

  const excluded = await run(new CaseExcluded("missing_v1_checkpoint"));
  assert.equal(excluded.status, "excluded");
  assert.equal(excluded.reason, "missing_v1_checkpoint");

  const infrastructure = await run(new EvaluationInfrastructureError("postgres_unavailable"));
  assert.equal(infrastructure.status, "evaluator_error");
  assert.equal(infrastructure.evaluatorErrorCode, "EVALUATOR_POSTGRES_UNAVAILABLE");
});
