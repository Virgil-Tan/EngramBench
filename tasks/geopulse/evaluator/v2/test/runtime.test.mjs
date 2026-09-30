import assert from "node:assert/strict";
import test from "node:test";

import { createCaseContext, runCommand } from "../lib/runtime.mjs";

test("task runtime creates deterministic GeoPulse context without a managed database", async () => {
  const context = await createCaseContext({
    caseId: "A-01",
    workspace: process.cwd(),
    evaluationSeed: "runtime-seed",
    baseTime: "2035-06-01T12:00:00.000Z",
    manageDatabase: false,
  });
  try {
    await context.setup();
    assert.equal(context.caseId, "A-01");
    assert.equal(context.uuid("device"), context.fixtures.uuid("device"));
    assert.equal(typeof context.mark, "function");
    assert.equal(typeof context.snapshot, "function");
  } finally {
    await context.teardown();
  }
});

test("public command runner captures a real process outcome", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('geopulse')"], { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "geopulse");
  assert.equal(result.timedOut, false);
});
