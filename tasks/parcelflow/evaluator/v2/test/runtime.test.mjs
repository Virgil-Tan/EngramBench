import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCaseContext, runCommand } from "../lib/runtime.mjs";

test("runCommand captures a public command without a shell", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('ok')"], { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ok");
  assert.equal(result.timedOut, false);
});

test("unmanaged case context provides isolated receiver and HTTP evidence primitives", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "parcelflow-runtime-test-"));
  const context = await createCaseContext({
    caseId: "C-07",
    workspace,
    evaluationSeed: "runtime-seed",
    baseTime: "2035-06-01T12:00:00.000Z",
    manageDatabase: false,
  });
  try {
    await context.setup();
    const receiver = await context.receiver();
    const response = await context.request(receiver.baseUrl, receiver.path, { method: "POST", json: { eventId: "event" } });
    assert.equal(response.status, 204);
    assert.equal(receiver.ledger.length, 1);
    assert.deepEqual(receiver.ledger[0].json, { eventId: "event" });
    assert.equal(context.uuid("warehouse"), context.fixtures.uuid("warehouse"));
  } finally {
    await context.teardown();
    await rm(workspace, { recursive: true, force: true });
  }
});
