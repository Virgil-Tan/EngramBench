import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { scoreEvaluation, validateManifest } from "../lib/scoring.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("../contract-map.v2.json", import.meta.url), "utf8"));

test("registry is exact and every Case is task-owned async run(ctx)", () => {
  assert.equal(validateManifest(manifest, contractMap), true); assert.equal(validateCaseRegistry(manifest, CASES), true); assert.equal(CASES.length, 48); assert.ok(CASES.every((item) => item.taskId === "escrowguard" && item.run.constructor.name === "AsyncFunction" && item.run.length >= 1));
});

test("all-passed results score 100 and one failed atomicity Case triggers its cap", () => {
  const passed = manifest.cases.map(({ id, dimension, weight }) => ({ id, dimension, weight, status: "passed", evidenceDigest: "x" })); const accepted = scoreEvaluation(manifest, contractMap, { cases: passed }); assert.equal(accepted.verdict, "accepted"); assert.equal(accepted.score, 100);
  const failed = passed.map((item) => item.id === "B-09" ? { ...item, status: "failed", privateFailureCode: "EG_B09_ASSERTION_FAILED", hardCapIds: ["FUND_OR_PAYOUT_ATOMICITY"] } : item); const rejected = scoreEvaluation(manifest, contractMap, { cases: failed }); assert.equal(rejected.verdict, "rejected"); assert.equal(rejected.score, 35); assert.deepEqual(rejected.hardCapsApplied[0].triggeredBy, ["B-09"]);
});
