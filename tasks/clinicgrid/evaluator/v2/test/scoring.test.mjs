import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("all 22 passing cases accept at 100", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "x" })) });
  assert.equal(result.verdict, "accepted");
  assert.equal(result.score, 100);
  assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("ClinicGrid correctness failure applies the frozen 30-point cap", () => {
  const cases = manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "x" }));
  cases[0] = { id: "SLOT-01", status: "failed", privateFailureCode: "CG_SLOT01_INTERVAL", hardCapIds: ["CORRECTNESS_INVARIANT"] };
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "rejected");
  assert.equal(result.rawScore, 94);
  assert.equal(result.score, 30);
});

test("missing V1 checkpoint excludes only frozen migration cases from the applicable score", () => {
  const cases = manifest.cases.map((definition) => definition.id === "MIGRATE-01" ? createMissingV1CheckpointOutcome(definition) : { id: definition.id, status: "passed", evidenceDigest: "x" });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "accepted");
  assert.equal(result.formalEligible, true);
  assert.equal(result.excludedWeight, 2.5);
  assert.equal(result.maxAchievable, 97.5);
});
