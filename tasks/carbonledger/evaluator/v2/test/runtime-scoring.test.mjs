import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { createCaseContext, validateBarrierPayload } from "../lib/runtime.mjs";
import { scoreEvaluation, validateManifest } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("barrier contract is closed and context is CarbonLedger-isolated", async () => { const valid = { schemaVersion: 1, processRole: "worker", point: "worker.claimed", workId: "w", aggregateId: "a", attempt: 1, leaseTokenHash: "a".repeat(64) }; assert.equal(validateBarrierPayload(valid), true); assert.equal(validateBarrierPayload({ ...valid, token: "secret" }), false); const context = await createCaseContext({ caseId: "A-01", workspace: root, evaluationSeed: "seed", manageDatabase: false }); assert.match(context.databaseName, /^cl_/u); assert.equal(typeof context.pass, "function"); await context.teardown(); });

test("scoring accepts exact all-pass outcomes and only excludes absent V1 checkpoint cases", async () => { const manifest = await json("manifest.v2.json"); const contract = await json("contract-map.v2.json"); validateManifest(manifest, contract); const passed = manifest.cases.map(({ id }) => ({ id, status: "passed", hardCapIds: [] })); const scored = scoreEvaluation(manifest, contract, { cases: passed }); assert.equal(scored.score, 100); assert.equal(scored.verdict, "accepted"); const withoutV1 = passed.map((item) => ["E-01", "E-02", "E-03"].includes(item.id) ? createMissingV1CheckpointOutcome(manifest.cases.find(({ id }) => id === item.id)) : item); const excluded = scoreEvaluation(manifest, contract, { cases: withoutV1 }); assert.equal(excluded.formalEligible, true); assert.equal(excluded.excludedWeight, 5.5); assert.equal(excluded.verdict, "accepted"); });

async function json(name) { return JSON.parse(await readFile(resolve(root, name), "utf8")); }
