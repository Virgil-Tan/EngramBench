import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."); const manifest = JSON.parse(await readFile(resolve(root, "manifest.v2.json"), "utf8")); const contractMap = JSON.parse(await readFile(resolve(root, "contract-map.v2.json"), "utf8")); const passed = () => manifest.cases.map(({ id }) => ({ id, status: "passed", durationMs: 1, evidenceDigest: "a".repeat(64) }));
test("all frozen cases score exact 100", () => { const result = scoreEvaluation(manifest, contractMap, { cases: passed() }); assert.equal(result.score, 100); assert.equal(result.rawScore, 100); assert.equal(result.verdict, "accepted"); assert.deepEqual(result.dimensions, { A: 30, B: 25, C: 20, D: 15, E: 10 }); });
test("declared SPEC-GAP is diagnostic and fail-closed", () => { const cases = passed(); const item = cases.find(({ id }) => id === "A-09"); Object.assign(item, { status: "diagnostic", diagnostics: [{ assertionId: "FF-A09-DEFAULT-UNKNOWN-ATTRIBUTE", status: "blocked", blockedBy: "SPEC-GAP-08", policy: "fail-closed-diagnostic" }] }); const result = scoreEvaluation(manifest, contractMap, { cases }); assert.equal(result.verdict, "diagnostic"); assert.equal(result.formalEligible, false); assert.equal(result.blockedWeight, 2); });
test("Flag authority failure applies exact cap", () => { const cases = passed(); Object.assign(cases.find(({ id }) => id === "B-06"), { status: "failed", privateFailureCode: "FF_B_06_ASSERTION_FAILED", hardCapIds: ["FLAG_AUTHORITY"] }); const result = scoreEvaluation(manifest, contractMap, { cases }); assert.equal(result.score, 35); assert.deepEqual(result.hardCapsApplied.map(({ id }) => id), ["FLAG_AUTHORITY"]); });
test("only migration cases use the missing checkpoint exclusion", () => { const cases = passed(); Object.assign(cases.find(({ id }) => id === "E-01"), createMissingV1CheckpointOutcome(manifest.cases.find(({ id }) => id === "E-01"))); const result = scoreEvaluation(manifest, contractMap, { cases }); assert.equal(result.blockedWeight, 0); assert.equal(result.excludedWeight, 2); assert.equal(result.formalEligible, true); assert.equal(result.verdict, "accepted"); });
