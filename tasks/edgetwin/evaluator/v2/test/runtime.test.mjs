import assert from "node:assert/strict";
import test from "node:test";

import { createCaseContext, runCommand } from "../lib/runtime.mjs";

test("EdgeTwin runtime creates deterministic context without managing PostgreSQL", async () => {
  const ctx = await createCaseContext({ caseId: "CONTRACT-01", workspace: process.cwd(), evaluationSeed: "runtime", baseTime: "2035-06-01T12:00:00.000Z", manageDatabase: false });
  try {
    await ctx.setup();
    assert.equal(ctx.caseId, "CONTRACT-01");
    assert.equal(ctx.uuid("device"), ctx.fixtures.uuid("device"));
    assert.equal(typeof ctx.barrier, "function");
    assert.equal(typeof ctx.loadChromium, "function");
  } finally { await ctx.teardown(); }
});

test("public process runner captures an executed child", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('edgetwin')"], { timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "edgetwin");
});
