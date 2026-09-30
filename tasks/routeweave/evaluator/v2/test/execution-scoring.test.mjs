import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { executeCase } from "../lib/execution.mjs";
import { isRouteWeaveBarrier } from "../lib/runtime.mjs";
import { classifyFailure, scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../",import.meta.url), manifest = JSON.parse(await readFile(new URL("manifest.v2.json",root),"utf8")), map = JSON.parse(await readFile(new URL("contract-map.v2.json",root),"utf8"));

test("barrier validator accepts only claimed worker and response-received dispatcher seams",() => {
  const common = { schemaVersion:1,workId:"w",aggregateId:"a",attempt:1,leaseTokenHash:"a".repeat(64) };
  assert.equal(isRouteWeaveBarrier({ ...common,processRole:"worker",point:"worker.claimed" }),true);
  assert.equal(isRouteWeaveBarrier({ ...common,processRole:"dispatcher",point:"dispatcher.response-received" }),true);
  assert.equal(isRouteWeaveBarrier({ ...common,processRole:"worker",point:"worker.before-commit" }),false);
  assert.equal(isRouteWeaveBarrier({ ...common,processRole:"worker",point:"worker.claimed",token:"secret" }),false);
});

test("candidate and evaluator failure classes remain distinct",async () => {
  assert.equal(classifyFailure({ origin:"candidate" }),"failed"); assert.equal(classifyFailure({ origin:"infrastructure" }),"evaluator_error");
  const result = await executeCase({ definition:manifest.cases[0],implementation:{ run:async (ctx) => { void ctx; throw new Error("mismatch"); } },withContext:async (_options,operation) => operation({}),contextOptions:{},failureCodePrefix:"RW_A01_" });
  assert.equal(result.privateFailureCode,"RW_A01_ASSERTION_FAILED");
});

test("all green scores 100 and each frozen correctness cap applies",() => {
  const passed = manifest.cases.map(({ id }) => ({ id,status:"passed",evidenceDigest:"0".repeat(64) })); assert.equal(scoreEvaluation(manifest,map,{ cases:passed }).score,100);
  for (const [id,cap] of [["JOURNEY_CORRECTNESS",35],["IDEMPOTENCY_CORRECTNESS",30],["WORK_RECOVERY_CORRECTNESS",40],["MIGRATION_CORRECTNESS",35]]) {
    const failed = passed.map((item) => item.id==="A-01" ? { ...item,status:"failed",privateFailureCode:"RW_A01_BROKEN",hardCapIds:[id] } : item);
    assert.equal(scoreEvaluation(manifest,map,{ cases:failed }).score,cap);
  }
});
