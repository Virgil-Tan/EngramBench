import assert from "node:assert/strict";
import test from "node:test";

import { createCaseContext, runCommand } from "../lib/runtime.mjs";

test("ClinicGrid runtime creates deterministic task context without managing PostgreSQL", async () => {
  const context = await createCaseContext({
    caseId: "SLOT-01",
    workspace: process.cwd(),
    evaluationSeed: "runtime-seed",
    baseTime: "2035-06-01T12:00:00.000Z",
    manageDatabase: false,
  });
  try {
    await context.setup();
    assert.equal(context.caseId, "SLOT-01");
    assert.equal(context.uuid("patient"), context.fixtures.uuid("patient"));
    assert.equal(typeof context.mark, "function");
    assert.equal(typeof context.barrier, "function");
  } finally {
    await context.teardown();
  }
});

test("public command runner captures a real process result", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('clinicgrid')"], { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "clinicgrid");
  assert.equal(result.timedOut, false);
});
