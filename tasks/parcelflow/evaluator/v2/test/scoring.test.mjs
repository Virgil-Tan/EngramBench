import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { scoreEvaluation, validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("manifest dimension weights are exactly 30/25/20/15/10", () => {
  assert.equal(validateManifest(manifest, contractMap), true);
  const totals = Object.fromEntries(Object.keys(manifest.dimensions).map((id) => [id, 0]));
  for (const item of manifest.cases) totals[item.dimension] += item.weight;
  assert.deepEqual(totals, { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("all passing cases score 100 and a failed hard invariant applies its cap", () => {
  const passed = manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "a".repeat(64) }));
  assert.equal(scoreEvaluation(manifest, contractMap, { cases: passed }).score, 100);

  const failed = passed.map((item) => item.id === "B-02"
    ? { ...item, status: "failed", privateFailureCode: "PF_B02_ATOMICITY", hardCapIds: ["CORE_INVENTORY_ATOMICITY"] }
    : item);
  const scored = scoreEvaluation(manifest, contractMap, { cases: failed });
  assert.equal(scored.verdict, "rejected");
  assert.ok(scored.score <= 35);
});

test("missing V1 checkpoint is explicit and never renormalized", () => {
  const cases = manifest.cases.map(({ id }) => ["E-01", "E-02", "E-03"].includes(id)
    ? createMissingV1CheckpointOutcome(manifest.cases.find((item) => item.id === id))
    : { id, status: "passed", evidenceDigest: "a".repeat(64) });
  const scored = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(scored.verdict, "accepted");
  assert.equal(scored.maxScore, 100);
  assert.equal(scored.blockedWeight, 0);
  assert.equal(scored.excludedWeight, 5.5);
  assert.equal(scored.maxAchievable, 94.5);
  assert.equal(scored.score, 94.5);
  assert.equal(scored.evaluationMode, "formal");
  assert.equal(scored.formalEligible, true);
});

test("the V1-only capacity rejection is explicitly excluded without a frozen checkpoint", () => {
  const cases = manifest.cases.map(({ id }) => id === "A-10"
    ? createMissingV1CheckpointOutcome(manifest.cases.find((item) => item.id === id))
    : { id, status: "passed", evidenceDigest: "a".repeat(64) });
  const scored = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(scored.verdict, "accepted");
  assert.equal(scored.blockedWeight, 0);
  assert.equal(scored.excludedWeight, 2);
  assert.equal(scored.maxAchievable, 98);
  assert.equal(scored.score, 98);
  assert.equal(scored.evaluationMode, "formal");
  assert.equal(scored.formalEligible, true);
});
