import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url); const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root))); const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root)));
const passing = () => manifest.cases.map(({ id }) => id === "DATA-05" ? { id, status: "diagnostic", diagnostics: [{ assertionId: "aliquot-transfer-reversal-authority", status: "blocked", blockedBy: "SPEC-GAP-EC-01", policy: "fail-closed-diagnostic" }] } : { id, status: "passed" });

test("one frozen blocker yields honest 95 diagnostic without renormalization", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: passing() }); assert.equal(result.score, 95); assert.equal(result.rawScore, 95); assert.equal(result.blockedWeight, 5); assert.equal(result.maxAchievable, 95); assert.equal(result.verdict, "diagnostic"); assert.equal(result.formalEligible, false);
});

test("candidate hard caps limit score and OPERATE-04 is the only exclusion", () => {
  const cases = passing(); const index = cases.findIndex(({ id }) => id === "DATA-01"); cases[index] = { id: "DATA-01", status: "failed", privateFailureCode: "EC_DATA01_REPLAY", hardCapIds: ["DURABLE_IDEMPOTENCY"] };
  const result = scoreEvaluation(manifest, contractMap, { cases }); assert.equal(result.rawScore, 90); assert.equal(result.score, 30); assert.deepEqual(result.hardCapsApplied.map(({ id }) => id), ["DURABLE_IDEMPOTENCY"]);
  const excluded = passing(); excluded[excluded.findIndex(({ id }) => id === "OPERATE-04")] = createMissingV1CheckpointOutcome(manifest.cases.find(({ id }) => id === "OPERATE-04")); const excludedResult = scoreEvaluation(manifest, contractMap, { cases: excluded }); assert.equal(excludedResult.blockedWeight, 5); assert.equal(excludedResult.excludedWeight, 2.5);
  const illegal = passing(); illegal[0] = { id: "CONTRACT-01", status: "excluded", reason: "missing_v1_checkpoint" }; assert.throws(() => scoreEvaluation(manifest, contractMap, { cases: illegal }), /CONTRACT-01 missing_v1_checkpoint exclusion/u);
});
