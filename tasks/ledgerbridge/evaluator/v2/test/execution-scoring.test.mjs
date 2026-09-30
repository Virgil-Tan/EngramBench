import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { executeCase } from "../lib/execution.mjs";
import { createCaseContext, isLedgerBarrier } from "../lib/runtime.mjs";
import { classifyFailure, scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("the exact worker and dispatcher barrier payloads are accepted", () => {
  const common = { schemaVersion: 1, workId: "w", aggregateId: "a", attempt: 1, leaseTokenHash: "a".repeat(64) };
  for (const point of ["worker.claimed", "worker.effect-complete", "worker.before-commit"]) assert.equal(isLedgerBarrier({ ...common, processRole: "worker", point }), true);
  assert.equal(isLedgerBarrier({ ...common, processRole: "dispatcher", point: "dispatcher.response-received" }), true);
  assert.equal(isLedgerBarrier({ ...common, processRole: "worker", point: "dispatcher.response-received" }), false);
  assert.equal(isLedgerBarrier({ ...common, processRole: "worker", point: "worker.claimed", token: "secret" }), false);
});

test("blocked legacy statement shape fails closed", async () => {
  const context = await createCaseContext({ caseId: "A-05", workspace: process.cwd(), evaluationSeed: "blocked", baseTime: "2035-06-01T12:00:00.000Z", manageDatabase: false });
  try {
    assert.throws(() => context.blocked("invented", "LB-GAP-01"), /UNDECLARED/u);
    context.blocked("legacy-one-leg-statement-leg-shape", "LB-GAP-01");
    assert.equal(context.evidence.finish().blockedAssertions.length, 1);
  } finally { await context.teardown(); }
});

test("candidate and evaluator failures remain distinct", async () => {
  assert.equal(classifyFailure({ origin: "candidate" }), "failed");
  assert.equal(classifyFailure({ origin: "infrastructure" }), "evaluator_error");
  const definition = manifest.cases[0];
  const failed = await executeCase({ definition, implementation: { run: async () => { throw new Error("mismatch"); } }, withContext: async (_options, operation) => operation({}), contextOptions: {}, failureCodePrefix: "LB_A01_" });
  assert.equal(failed.privateFailureCode, "LB_A01_ASSERTION_FAILED");
});

test("weighted scoring accepts green, diagnoses the gap and caps broken ledgers", () => {
  const passed = manifest.cases.map(({ id }) => ({ id, status: "passed", evidenceDigest: "0".repeat(64) }));
  assert.deepEqual((({ score, rawScore, verdict }) => ({ score, rawScore, verdict }))(scoreEvaluation(manifest, contractMap, { cases: passed })), { score: 100, rawScore: 100, verdict: "accepted" });
  const diagnostic = passed.map((item) => item.id === "A-05" ? { ...item, status: "diagnostic", diagnostics: [{ assertionId: "legacy-one-leg-statement-leg-shape", status: "blocked", blockedBy: "LB-GAP-01", policy: "fail-closed-diagnostic" }] } : item);
  assert.equal(scoreEvaluation(manifest, contractMap, { cases: diagnostic }).blockedWeight, 6);
  const failed = passed.map((item) => item.id === "A-05" ? { ...item, status: "failed", privateFailureCode: "LB_A05_PARTIAL_POSTING", hardCapIds: ["CORRECTNESS_INVARIANT"] } : item);
  const capped = scoreEvaluation(manifest, contractMap, { cases: failed });
  assert.equal(capped.rawScore, 94);
  assert.equal(capped.score, 30);
});
