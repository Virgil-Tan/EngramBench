import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.v2.json"), "utf8"));
const contractMap = JSON.parse(await readFile(resolve(root, "contract-map.v2.json"), "utf8"));

function passedCases() {
  return manifest.cases.map((item) => ({ id: item.id, status: "passed", durationMs: 1, evidenceDigest: "a".repeat(64) }));
}

test("all passed cases score the exact frozen 100 points", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: passedCases() });
  assert.equal(result.score, 100);
  assert.equal(result.rawScore, 100);
  assert.equal(result.verdict, "accepted");
  assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("declared SPEC-GAP assertion is fail-closed diagnostic", () => {
  const cases = passedCases();
  cases.find((item) => item.id === "A-05").status = "diagnostic";
  cases.find((item) => item.id === "A-05").diagnostics = [{
    assertionId: "unresolved-review-remediation",
    status: "blocked",
    blockedBy: "FL-GAP-01",
    policy: "fail-closed-diagnostic",
  }];
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic");
  assert.equal(result.formalEligible, false);
  assert.equal(result.blockedWeight, 6);
  assert.equal(result.maxAchievable, 94);
});

test("candidate invariant failure applies the declared cap", () => {
  const cases = passedCases();
  const failed = cases.find((item) => item.id === "A-03");
  Object.assign(failed, { status: "failed", privateFailureCode: "FL_A03_ASSERTION_FAILED", hardCapIds: ["REVIEW_TERMINAL"] });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.score, 30);
  assert.equal(result.verdict, "rejected");
  assert.deepEqual(result.hardCapsApplied.map((item) => item.id), ["REVIEW_TERMINAL"]);
});
