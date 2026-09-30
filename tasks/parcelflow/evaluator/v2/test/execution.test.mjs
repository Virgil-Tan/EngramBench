import assert from "node:assert/strict";
import test from "node:test";

import { CaseExcluded, CaseFailure, executeCase } from "../lib/execution.mjs";

const definition = { id: "B-02", dimension: "B", weight: 2 };
const base = {
  definition,
  contextOptions: {},
  failureCodePrefix: "PF_B02_",
  withContext: async (_options, operation) => operation({}),
};

test("executeCase records deterministic evidence for a passing domain case", async () => {
  const result = await executeCase({ ...base, implementation: { async run() { return { status: "passed", evidence: [{ stock: "balanced" }] }; } } });
  assert.equal(result.status, "passed");
  assert.match(result.evidenceDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.privateFailureCode, undefined);
});

test("executeCase distinguishes candidate failure, contract exclusion, and evaluator error", async () => {
  const failed = await executeCase({
    ...base,
    implementation: { async run() { throw new CaseFailure("oversell", { failureCodeSuffix: "OVERSELL", hardCapIds: ["CORE_INVENTORY_ATOMICITY"] }); } },
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.privateFailureCode, "PF_B02_OVERSELL");
  assert.deepEqual(failed.hardCapIds, ["CORE_INVENTORY_ATOMICITY"]);

  const excluded = await executeCase({ ...base, implementation: { async run() { throw new CaseExcluded("missing_v1_checkpoint"); } } });
  assert.equal(excluded.status, "excluded");
  assert.equal(excluded.reason, "missing_v1_checkpoint");

  const evaluator = await executeCase({
    ...base,
    implementation: { async run() { throw Object.assign(new Error("database unavailable"), { origin: "infrastructure", code: "EVALUATOR_DATABASE_CREATE_FAILED" }); } },
  });
  assert.equal(evaluator.status, "evaluator_error");
  assert.equal(evaluator.evaluatorErrorCode, "EVALUATOR_DATABASE_CREATE_FAILED");
});
