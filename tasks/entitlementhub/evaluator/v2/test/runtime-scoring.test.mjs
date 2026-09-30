import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { createCaseContext, validateBarrierPayload } from "../lib/runtime.mjs";
import { scoreEvaluation, validateManifest } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
test("barrier is closed and isolated context is EntitlementHub-owned", async () => { const valid = { schemaVersion: 1, processRole: "worker", point: "worker.claimed", workId: "w", aggregateId: "a", attempt: 1, leaseTokenHash: "a".repeat(64) }; assert.equal(validateBarrierPayload(valid), true); assert.equal(validateBarrierPayload({ ...valid, token: "x" }), false); const ctx = await createCaseContext({ caseId: "CONTRACT-01", workspace: root, evaluationSeed: "s", manageDatabase: false }); assert.match(ctx.databaseName, /^eh_/u); await ctx.teardown(); });
test("all passed scores exactly 100 and only migration may be excluded", async () => { const manifest = await json("manifest.v2.json"); const contract = await json("contract-map.v2.json"); validateManifest(manifest, contract); const passed = manifest.cases.map(({ id }) => ({ id, status: "passed", hardCapIds: [] })); assert.equal(scoreEvaluation(manifest, contract, { cases: passed }).score, 100); const excluded = passed.map((item) => item.id === "OPERATE-04" ? createMissingV1CheckpointOutcome(manifest.cases.find(({ id }) => id === item.id)) : item); const scored = scoreEvaluation(manifest, contract, { cases: excluded }); assert.equal(scored.formalEligible, true); assert.equal(scored.excludedWeight, 2.5); assert.equal(scored.verdict, "accepted"); });
async function json(name) { return JSON.parse(await readFile(resolve(root, name), "utf8")); }
