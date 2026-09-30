import assert from "node:assert/strict";
import test from "node:test";

import { createCaseContext } from "../lib/runtime.mjs";

test("runtime creates an isolated task-owned context without compatibility adapters", async () => {
  const context = await createCaseContext({ caseId: "CONTRACT-01", workspace: process.cwd(), evaluationSeed: "seed", baseTime: "2035-06-01T12:00:00.000Z", manageDatabase: false });
  try { assert.equal(context.caseId, "CONTRACT-01"); assert.match(context.databaseName, /^ec_contract_01_/u); assert.equal(typeof context.request, "function"); assert.equal(typeof context.barrier, "function"); assert.equal(typeof context.loadChromium, "function"); assert.deepEqual(context.evidence, []); }
  finally { await context.teardown(); }
  await assert.rejects(() => createCaseContext({ caseId: "CONTRACT-01", workspace: process.cwd(), evaluationSeed: "seed", compatibilityAdapter: "legacy", manageDatabase: false }), /forbids compatibility/u);
});
