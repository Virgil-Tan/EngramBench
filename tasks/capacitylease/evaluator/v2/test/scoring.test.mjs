import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import {
  classifyFailure,
  scoreEvaluation,
  validateManifest,
} from "../lib/scoring.mjs";

const here = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", here), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", here), "utf8"));

const clone = (value) => structuredClone(value);
const passingResults = () => manifest.cases.map(({ id }) => ({ id, status: "passed" }));

test("CapacityLease manifest freezes 49 unique cases and exact dimension weights", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.equal(manifest.cases.length, 49);
  assert.equal(new Set(manifest.cases.map(({ id }) => id)).size, 49);

  const totals = Object.fromEntries(Object.keys(manifest.dimensions).map((id) => [id, 0]));
  for (const item of manifest.cases) totals[item.dimension] += item.weight;

  assert.deepEqual(totals, { A: 30, B: 25, C: 20, D: 15, E: 10 });
  assert.equal(Object.values(totals).reduce((sum, value) => sum + value, 0), 100);
});

test("every case maps to exactly one public requirement and safe feedback metadata", () => {
  assert.equal(contractMap.cases.length, 49);
  assert.deepEqual(
    contractMap.cases.map(({ caseId }) => caseId).sort(),
    manifest.cases.map(({ id }) => id).sort(),
  );

  for (const mapping of contractMap.cases) {
    assert.deepEqual(Object.keys(mapping.requirement).sort(), ["id", "source", "summary"]);
    assert.match(mapping.requirement.source, /^(workspace\/README\.md|orchestration\/user-and-manager-prompts\.zh-CN\.md|workspace\/AGENTS\.md)#/);
    assert.match(mapping.privateFailureCodePrefix, /^CL_[A-E][0-9]{2}_$/);
    assert.match(mapping.publicFeedbackCategory, /^[a-z][a-z0-9-]*$/);
  }
});

test("manifest validation rejects duplicate cases and score drift", () => {
  const duplicate = clone(manifest);
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateManifest(duplicate, contractMap), /duplicate case id/i);

  const drifted = clone(manifest);
  drifted.cases[0].weight += 0.5;
  assert.throws(() => validateManifest(drifted, contractMap), /dimension A weight|total weight/i);
});

test("all passed cases produce the strict accepted verdict", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: passingResults() });

  assert.equal(result.rawScore, 100);
  assert.equal(result.score, 100);
  assert.equal(result.verdict, "accepted");
  assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });
  assert.deepEqual(result.hardCapsApplied, []);
});

test("a candidate failure scores zero for its case and rejects the run", () => {
  const cases = passingResults();
  cases[0] = { id: "A-01", status: "failed", privateFailureCode: "CL_A01_BOOT_FAILED" };
  const result = scoreEvaluation(manifest, contractMap, { cases });

  assert.equal(result.rawScore, 98);
  assert.equal(result.score, 98);
  assert.equal(result.verdict, "rejected");
  assert.equal(result.cases[0].publicFeedbackCategory, "build-and-process-lifecycle");
});

test("the lowest triggered hard cap limits final score without rewriting raw case score", () => {
  const cases = passingResults();
  cases[0] = {
    id: "A-01",
    status: "failed",
    privateFailureCode: "CL_A01_PRODUCTION_BOOT_FAILED",
    hardCapIds: ["BUILD_MIGRATION_OR_BOOT"],
  };
  cases[26] = {
    id: "C-01",
    status: "failed",
    privateFailureCode: "CL_C01_WORK_LOST",
    hardCapIds: ["RECOVERY_OR_FENCING"],
  };

  const result = scoreEvaluation(manifest, contractMap, { cases });

  assert.equal(result.rawScore, 96);
  assert.equal(result.score, 25);
  assert.deepEqual(
    result.hardCapsApplied.map(({ id, cap }) => ({ id, cap })),
    [
      { id: "BUILD_MIGRATION_OR_BOOT", cap: 25 },
      { id: "RECOVERY_OR_FENCING", cap: 40 },
    ],
  );
});

test("invalid evidence takes precedence over scoring", () => {
  const cases = passingResults();
  const result = scoreEvaluation(manifest, contractMap, {
    cases,
    invalidReason: "hidden_asset_access",
  });

  assert.equal(result.verdict, "invalid");
  assert.equal(result.score, null);
  assert.equal(result.rawScore, 100);
});

test("evaluator infrastructure errors never become candidate failures", () => {
  const cases = passingResults();
  cases[0] = {
    id: "A-01",
    status: "evaluator_error",
    evaluatorErrorCode: "EVALUATOR_POSTGRES_UNAVAILABLE",
  };
  const result = scoreEvaluation(manifest, contractMap, { cases });

  assert.equal(result.verdict, "evaluator_error");
  assert.equal(result.candidateFailureCount, 0);
  assert.equal(result.evaluatorErrorCount, 1);
  assert.equal(result.score, null);
  assert.equal(result.rawScore, 98);
});

test("missing frozen V1 checkpoint is a formal exclusion without renormalization", () => {
  const cases = passingResults();
  for (const id of ["E-01", "E-02", "E-03"]) {
    const index = cases.findIndex((item) => item.id === id);
    cases[index] = createMissingV1CheckpointOutcome(manifest.cases.find((item) => item.id === id));
  }

  const result = scoreEvaluation(manifest, contractMap, { cases });

  assert.equal(result.verdict, "accepted");
  assert.equal(result.evaluationMode, "formal");
  assert.equal(result.formalEligible, true);
  assert.equal(result.blockedWeight, 0);
  assert.equal(result.excludedWeight, 5.5);
  assert.equal(result.maxAchievable, 94.5);
  assert.equal(result.rawScore, 94.5);
  assert.equal(result.maxScore, 100);
});

test("excluded is limited to checkpoint-dependent cases and the published reason", () => {
  const wrongCase = passingResults();
  wrongCase[0] = { id: "A-01", status: "excluded", reason: "missing_v1_checkpoint" };
  assert.throws(
    () => scoreEvaluation(manifest, contractMap, { cases: wrongCase }),
    /A-01 missing_v1_checkpoint exclusion/i,
  );

  const wrongReason = passingResults();
  const index = wrongReason.findIndex(({ id }) => id === "E-01");
  wrongReason[index] = { id: "E-01", status: "excluded", reason: "not_implemented" };
  assert.throws(
    () => scoreEvaluation(manifest, contractMap, { cases: wrongReason }),
    /missing_v1_checkpoint/i,
  );
});

test("failure classification keeps candidate, invalid-sample, and evaluator failures separate", () => {
  assert.equal(classifyFailure({ origin: "candidate" }), "failed");
  assert.equal(classifyFailure({ origin: "submission-integrity" }), "invalid");
  assert.equal(classifyFailure({ origin: "evaluator" }), "evaluator_error");
  assert.equal(classifyFailure({ origin: "infrastructure" }), "evaluator_error");
  assert.throws(() => classifyFailure({ origin: "unknown" }), /unknown failure origin/i);
});

test("results must be complete, unique, and use their case-owned failure prefix", () => {
  const missing = passingResults().slice(1);
  assert.throws(
    () => scoreEvaluation(manifest, contractMap, { cases: missing }),
    /results must cover every manifest case/i,
  );

  const wrongPrefix = passingResults();
  wrongPrefix[0] = { id: "A-01", status: "failed", privateFailureCode: "OTHER_BOOT_FAILED" };
  assert.throws(
    () => scoreEvaluation(manifest, contractMap, { cases: wrongPrefix }),
    /private failure code.*CL_A01_/i,
  );
});
