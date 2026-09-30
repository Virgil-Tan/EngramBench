import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CaseFailure, executeCase } from "../lib/execution.mjs";
import { validateBarrierPayload } from "../lib/runtime.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url); const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root))); const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root)));
const barrier = { schemaVersion: 1, processRole: "worker", point: "worker.claimed", workId: "work", aggregateId: "aggregate", attempt: 1, leaseTokenHash: "a".repeat(64) };

test("barrier validator enforces exact fields and role-specific four published points", () => {
  for (const point of ["worker.claimed", "worker.effect-complete", "worker.before-commit"]) assert.equal(validateBarrierPayload({ ...barrier, point }), true);
  assert.equal(validateBarrierPayload({ ...barrier, processRole: "dispatcher", point: "dispatcher.response-received" }), true);
  assert.equal(validateBarrierPayload({ ...barrier, processRole: "dispatcher", point: "worker.claimed" }), false); assert.equal(validateBarrierPayload({ ...barrier, point: "dispatcher.response-received" }), false); assert.equal(validateBarrierPayload({ ...barrier, token: "secret" }), false); assert.equal(validateBarrierPayload({ ...barrier, leaseTokenHash: "A".repeat(64) }), false);
});

test("candidate assertion failure carries private suffix and hard caps", async () => {
  const definition = manifest.cases.find(({ id }) => id === "B-04"); const implementation = { id: "B-04", async run(_ctx) { throw new CaseFailure("second effect", { failureCodeSuffix: "SECOND_EFFECT", hardCapIds: ["IDEMPOTENCY_CORRECTNESS"] }); } }; const result = await executeCase({ definition, implementation, withContext: (_options, operation) => operation({}), contextOptions: {}, failureCodePrefix: "MS_B_04_" }); assert.equal(result.status, "failed"); assert.equal(result.privateFailureCode, "MS_B_04_SECOND_EFFECT"); assert.deepEqual(result.hardCapIds, ["IDEMPOTENCY_CORRECTNESS"]);
});

test("all-pass scores 100 and hard cap lowers a failed synthetic result", () => {
  const passed = manifest.cases.map(({ id }) => ({ id, status: "passed", durationMs: 1, evidenceDigest: "e" })); const all = scoreEvaluation(manifest, contractMap, { cases: passed }); assert.equal(all.score, 100); assert.equal(all.verdict, "accepted");
  const failed = passed.map((item) => item.id === "B-04" ? { ...item, status: "failed", privateFailureCode: "MS_B_04_SECOND_EFFECT", hardCapIds: ["IDEMPOTENCY_CORRECTNESS"] } : item); const scored = scoreEvaluation(manifest, contractMap, { cases: failed }); assert.equal(scored.score, 30); assert.equal(scored.verdict, "rejected");
});

test("declared blocked assertion is diagnostic and fail-closed", () => {
  const cases = manifest.cases.map(({ id }) => id === "A-11" ? { id, status: "diagnostic", durationMs: 1, evidenceDigest: "e", diagnostics: [{ assertionId: "MS-A11-RANGE-BOUNDARIES", status: "blocked", blockedBy: "SPEC-GAP-05", policy: "fail-closed-diagnostic" }] } : { id, status: "passed", durationMs: 1, evidenceDigest: "e" }); const result = scoreEvaluation(manifest, contractMap, { cases }); assert.equal(result.verdict, "diagnostic"); assert.equal(result.formalEligible, false); assert.equal(result.blockedWeight, 2);
});
