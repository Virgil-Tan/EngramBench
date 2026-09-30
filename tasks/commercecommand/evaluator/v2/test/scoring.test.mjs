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

test("all 55 frozen cases score exact 100 and dimension totals", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: passedCases() });
  assert.equal(result.score, 100);
  assert.equal(result.rawScore, 100);
  assert.equal(result.verdict, "accepted");
  assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("all currently unpublished assertions produce the designed diagnostic ceiling", () => {
  const cases = passedCases();
  for (const definition of manifest.cases.filter(({ blockedAssertions }) => blockedAssertions)) {
    const item = cases.find(({ id }) => id === definition.id);
    item.status = "diagnostic";
    item.diagnostics = definition.blockedAssertions.map(({ id, blockedBy, policy }) => ({ assertionId: id, status: "blocked", blockedBy, policy }));
  }
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic");
  assert.equal(result.formalEligible, false);
  assert.equal(result.blockedWeight, 52.25);
  assert.equal(result.maxAchievable, 47.75);
});

test("inventory authority failure applies the Commerce conservation cap", () => {
  const cases = passedCases();
  Object.assign(cases.find(({ id }) => id === "B-02"), { status: "failed", privateFailureCode: "CC_B_02_ASSERTION_FAILED", hardCapIds: ["COMMERCE_CONSERVATION"] });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.score, 35);
  assert.equal(result.verdict, "rejected");
  assert.deepEqual(result.hardCapsApplied.map(({ id }) => id), ["COMMERCE_CONSERVATION"]);
});

test("only V1 migration cases may use the checkpoint exclusion", () => {
  const cases = passedCases();
  Object.assign(cases.find(({ id }) => id === "E-01"), createMissingV1CheckpointOutcome(manifest.cases.find(({ id }) => id === "E-01")));
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.blockedWeight, 0);
  assert.equal(result.excludedWeight, 1.5);
  assert.equal(result.formalEligible, true);
  assert.equal(result.verdict, "accepted");
  const invalid = passedCases();
  Object.assign(invalid.find(({ id }) => id === "A-01"), { status: "excluded", reason: "missing_v1_checkpoint" });
  assert.throws(() => scoreEvaluation(manifest, contractMap, { cases: invalid }), /A-01 missing_v1_checkpoint exclusion/u);
});
