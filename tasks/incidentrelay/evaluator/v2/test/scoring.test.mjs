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
const passedCases = () => manifest.cases.map((item) => ({ id: item.id, status: "passed", durationMs: 1, evidenceDigest: "a".repeat(64) }));

test("all frozen cases sum to exact 100 and dimension weights", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: passedCases() });
  assert.equal(result.score, 100); assert.equal(result.rawScore, 100); assert.equal(result.verdict, "accepted");
  assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("a declared IncidentRelay gap is fail-closed diagnostic", () => {
  const cases = passedCases(), item = cases.find((value) => value.id === "A-10");
  item.status = "diagnostic"; item.diagnostics = [{ assertionId: "IR-A10-OUTSIDER-ERROR", status: "blocked", blockedBy: "SPEC-GAP-05", policy: "fail-closed-diagnostic" }];
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic"); assert.equal(result.formalEligible, false); assert.equal(result.blockedWeight, 2); assert.equal(result.maxAchievable, 98);
});

test("candidate authority failure applies exact declared cap", () => {
  const cases = passedCases(), failed = cases.find((item) => item.id === "B-10");
  Object.assign(failed, { status: "failed", privateFailureCode: "IR_B_10_ASSERTION_FAILED", hardCapIds: ["QUORUM_AUTHORITY"] });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.score, 35); assert.equal(result.verdict, "rejected"); assert.deepEqual(result.hardCapsApplied.map(({ id }) => id), ["QUORUM_AUTHORITY"]);
});

test("only migration cases can use the frozen missing checkpoint exclusion", () => {
  const cases = passedCases(); const excluded = cases.find((item) => item.id === "E-01"); Object.assign(excluded, createMissingV1CheckpointOutcome(manifest.cases.find(({ id }) => id === "E-01")));
  const result = scoreEvaluation(manifest, contractMap, { cases }); assert.equal(result.blockedWeight, 0); assert.equal(result.excludedWeight, 2); assert.equal(result.formalEligible, true); assert.equal(result.verdict, "accepted");
});
