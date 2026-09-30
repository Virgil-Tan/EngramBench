import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.v2.json"), "utf8"));
const contractMap = JSON.parse(await readFile(resolve(root, "contract-map.v2.json"), "utf8"));
const passed = () => manifest.cases.map(({ id }) => ({ id, status: "passed", durationMs: 1, evidenceDigest: "a".repeat(64) }));

test("all 53 frozen cases score exactly 100", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: passed() });
  assert.equal(result.score, 100);
  assert.equal(result.verdict, "accepted");
  assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("candidate authority failure applies the exact hard cap", () => {
  const cases = passed();
  Object.assign(cases.find(({ id }) => id === "B-09"), { status: "failed", privateFailureCode: "AS_B_09_ASSERTION_FAILED", hardCapIds: ["REVOCATION_FAIL_CLOSED"] });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.score, 35);
  assert.deepEqual(result.hardCapsApplied.map(({ id }) => id), ["REVOCATION_FAIL_CLOSED"]);
});

test("declared AccessSentinel contract gaps fail closed as diagnostic", () => {
  const cases = passed();
  Object.assign(cases.find(({ id }) => id === "A-12"), {
    status: "diagnostic",
    diagnostics: [{ assertionId: "AS-A12-REVIEW-BODY", status: "blocked", blockedBy: "AS-GAP-01", policy: "fail-closed-diagnostic" }],
  });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic");
  assert.equal(result.formalEligible, false);
  assert.equal(result.blockedWeight, 2);
  assert.equal(result.maxAchievable, 98);
});

test("only the three migration cases may be excluded for a missing V1 checkpoint", () => {
  const cases = passed();
  const definition = manifest.cases.find(({ id }) => id === "E-01");
  Object.assign(cases.find(({ id }) => id === "E-01"), createMissingV1CheckpointOutcome(definition));
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.formalEligible, true);
  assert.equal(result.blockedWeight, 0);
  assert.equal(result.excludedWeight, 1.5);
  assert.equal(result.verdict, "accepted");
  assert.throws(() => {
    const invalid = passed();
    Object.assign(invalid.find(({ id }) => id === "A-01"), { status: "excluded", reason: "missing_v1_checkpoint" });
    scoreEvaluation(manifest, contractMap, { cases: invalid });
  }, /A-01 missing_v1_checkpoint exclusion/u);
});
