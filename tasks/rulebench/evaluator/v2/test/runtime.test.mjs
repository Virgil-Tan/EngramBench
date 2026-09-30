import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createCaseContext, runCommand } from "../lib/runtime.mjs";

test("shared command runner captures a public command without a shell", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('rulebench')"], { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "rulebench");
});

test("RuleBench context adds deterministic evidence and diagnostic assertions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "rulebench-runtime-test-"));
  const context = await createCaseContext({
    caseId: "C-04", workspace, evaluationSeed: "runtime-seed",
    baseTime: "2035-06-01T12:00:00.000Z", manageDatabase: false,
  });
  try {
    await context.setup();
    context.mark("snapshot-read", { events: 2 });
    context.equal({ state: "PUBLISHED" }, { state: "PUBLISHED" }, "version state");
    const result = context.pass({ evidence: [{ kind: "case-summary" }], diagnostics: [context.diagnostic("external-delivery-unknown-ack", "SPEC-GAP-RB-03")] });
    assert.equal(result.status, "passed");
    assert.equal(result.evidence.length, 2);
    assert.deepEqual(result.diagnostics, [{ assertionId: "external-delivery-unknown-ack", blockedBy: "SPEC-GAP-RB-03" }]);
    const receiver = await context.receiver();
    assert.equal((await context.request(receiver.baseUrl, receiver.path, { method: "POST", json: { event: "stable" } })).status, 204);
  } finally {
    await context.teardown();
    await rm(workspace, { recursive: true, force: true });
  }
});
