import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.v2.json"), "utf8"));
const contractMap = JSON.parse(await readFile(resolve(root, "contract-map.v2.json"), "utf8"));
const passedCases = () => manifest.cases.map((item) => ({ id: item.id, status: "passed", durationMs: 1, evidenceDigest: "a".repeat(64) }));

test("all passed cases score the exact frozen 100 points", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: passedCases() });
  assert.equal(result.score, 100); assert.equal(result.rawScore, 100); assert.equal(result.verdict, "accepted");
  assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("declared readiness gap is fail-closed diagnostic", () => {
  const cases = passedCases(), item = cases.find((value) => value.id === "C-03");
  item.status = "diagnostic";
  item.diagnostics = [{ assertionId: "RP-C03-READINESS", status: "blocked", blockedBy: "SPEC-GAP-RP-01", policy: "fail-closed-diagnostic" }];
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.verdict, "diagnostic"); assert.equal(result.formalEligible, false); assert.equal(result.blockedWeight, 5); assert.equal(result.maxAchievable, 95);
});

test("candidate invariant failure applies the declared cap", () => {
  const cases = passedCases(), failed = cases.find((item) => item.id === "B-02");
  Object.assign(failed, { status: "failed", privateFailureCode: "RP_B02_ASSERTION_FAILED", hardCapIds: ["IDEMPOTENCY_CORRECTNESS"] });
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.score, 30); assert.equal(result.verdict, "rejected");
  assert.deepEqual(result.hardCapsApplied.map((item) => item.id), ["IDEMPOTENCY_CORRECTNESS"]);
});
