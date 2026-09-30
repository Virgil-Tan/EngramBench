import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeCase } from "../lib/execution.mjs";
import { isConfigRelayBarrier, withCaseContext } from "../lib/runtime.mjs";
import { classifyFailure, scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const map = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("worker and dispatcher accept only exact public recovery barrier payloads", () => {
  const common = { schemaVersion:1,workId:"w",aggregateId:"a",attempt:1,leaseTokenHash:"a".repeat(64) };
  for (const point of ["worker.claimed","worker.effect-complete","worker.before-commit"]) assert.equal(isConfigRelayBarrier({ ...common,processRole:"worker",point }), true);
  assert.equal(isConfigRelayBarrier({ ...common,processRole:"dispatcher",point:"dispatcher.response-received" }), true);
  assert.equal(isConfigRelayBarrier({ ...common,processRole:"worker",point:"worker.claimed",assignmentToken:"secret" }), false);
});

test("B-04 execution produces only the declared fail-closed diagnostic", async () => {
  const definition = manifest.cases.find(({ id }) => id === "B-04");
  const result = await executeCase({ definition, implementation:{ run:async () => ({ diagnostics:[{ assertionId:"successful-cohort-ordered-successor",blockedBy:"SPEC-GAP-CR-02" }] }) }, withContext:async (_options, operation) => operation({}), contextOptions:{}, failureCodePrefix:"CR_B04_" });
  assert.equal(result.status, "diagnostic");
  assert.deepEqual(result.diagnostics, [{ assertionId:"successful-cohort-ordered-successor",status:"blocked",blockedBy:"SPEC-GAP-CR-02",policy:"fail-closed-diagnostic" }]);
});

test("B-04 context bypasses candidate process and database setup", async () => {
  const outcome = await withCaseContext({ caseId:"B-04" },async (ctx) => ({ diagnostics:[{ assertionId:"successful-cohort-ordered-successor",blockedBy:"SPEC-GAP-CR-02" }],evidence:[ctx.caseId] }));
  assert.deepEqual(outcome.diagnostics,[{ assertionId:"successful-cohort-ordered-successor",blockedBy:"SPEC-GAP-CR-02" }]);
  assert.deepEqual(outcome.evidence.caseEvidence,["B-04"]);
});

test("candidate and evaluator failures remain distinct", async () => {
  assert.equal(classifyFailure({ origin:"candidate" }), "failed");
  assert.equal(classifyFailure({ origin:"infrastructure" }), "evaluator_error");
  const result = await executeCase({ definition:manifest.cases[0],implementation:{ run:async () => { throw new Error("mismatch"); } },withContext:async (_options,operation) => operation({}),contextOptions:{},failureCodePrefix:"CR_A01_" });
  assert.equal(result.privateFailureCode, "CR_A01_ASSERTION_FAILED");
});

test("scoring reports the contract diagnostic and applies frozen hard caps", () => {
  const results = manifest.cases.map(({ id }) => id === "B-04" ? { id,status:"diagnostic",diagnostics:[{ assertionId:"successful-cohort-ordered-successor",status:"blocked",blockedBy:"SPEC-GAP-CR-02",policy:"fail-closed-diagnostic" }],evidenceDigest:"0".repeat(64) } : { id,status:"passed",evidenceDigest:"0".repeat(64) });
  const scored = scoreEvaluation(manifest, map, { cases:results });
  assert.equal(scored.verdict, "diagnostic");
  assert.equal(scored.score, 95);
  assert.equal(scored.maxAchievable, 95);
  for (const [id,cap] of [["ORDERED_DELIVERY_CORRECTNESS",35],["IDEMPOTENCY_CORRECTNESS",30],["ROLLBACK_RECOVERY_CORRECTNESS",40],["MIGRATION_CORRECTNESS",35]]) {
    const failed = results.map((item) => item.id === "A-01" ? { ...item,status:"failed",privateFailureCode:"CR_A01_BROKEN",hardCapIds:[id] } : item);
    assert.equal(scoreEvaluation(manifest, map, { cases:failed }).score, cap);
  }
});
