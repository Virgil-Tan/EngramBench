import assert from "node:assert/strict";
import test from "node:test";

import { createCaseContext, runCommand } from "../lib/runtime.mjs";

test("NotifyRoute runtime creates deterministic task context without managing PostgreSQL", async () => {
  const context = await createCaseContext({ caseId: "A-01", workspace: process.cwd(), evaluationSeed: "runtime", baseTime: "2035-06-01T12:00:00.000Z", manageDatabase: false });
  try {
    await context.setup();
    assert.equal(context.caseId, "A-01");
    assert.equal(context.uuid("tenant"), context.fixtures.uuid("tenant"));
    assert.equal(typeof context.receiver, "function");
    assert.equal(typeof context.loadChromium, "function");
  } finally { await context.teardown(); }
});

test("shared command boundary captures a real process result", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('notifyroute')"], { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "notifyroute");
});
