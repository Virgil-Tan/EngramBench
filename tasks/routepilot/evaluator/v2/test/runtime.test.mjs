import assert from "node:assert/strict";
import test from "node:test";
import { createCaseContext } from "../lib/runtime.mjs";

test("runtime exposes task-local deterministic context without compatibility adapters", async () => {
  const ctx = await createCaseContext({ caseId: "A-01", workspace: process.cwd(), evaluationSeed: "b".repeat(64), baseTime: "2035-07-01T12:00:00.000Z", manageDatabase: false });
  try {
    assert.equal(ctx.caseId, "A-01");
    assert.match(ctx.databaseName, /^rp_a_01_/u);
    assert.equal(ctx.fixtures.uuid("x"), ctx.uuid("x"));
    assert.equal(typeof ctx.mark, "function");
    assert.equal(typeof ctx.pass, "function");
    assert.equal(typeof ctx.loadChromium, "function");
  } finally { await ctx.teardown(); }
  await assert.rejects(createCaseContext({ caseId: "A-01", workspace: process.cwd(), evaluationSeed: "b".repeat(64), manageDatabase: false, compatibilityAdapter: {} }), /forbids compatibility adapters/u);
});
