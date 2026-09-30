import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCaseContext, validateBarrierPayload } from "../lib/runtime.mjs";
import { digestTree, parseArgs, selectCases } from "../run.mjs";

test("CLI accepts FINAL and V1 inputs while preserving manifest order", () => {
  assert.deepEqual(parseArgs(["--submission", "/submission", "--result", "/result.json", "--seed", "seed", "--v1-workspace", "/v1", "--case", "E-03,A-01"]), { caseIds: ["E-03", "A-01"], workspace: "/submission", result: "/result.json", evaluationSeed: "seed", v1Workspace: "/v1" });
  assert.deepEqual(selectCases({ cases: [{ id: "A-01" }, { id: "E-03" }] }, ["E-03", "A-01"]).map(({ id }) => id), ["A-01", "E-03"]);
  assert.throws(() => parseArgs(["--submission", "/x"]), /required/u);
});

test("submission digest is stable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "commercecommand-run-test-"));
  try {
    await writeFile(join(directory, "a.txt"), "a");
    const first = await digestTree(directory);
    const second = await digestTree(directory);
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime is task-local deterministic and rejects compatibility adapters", async () => {
  const context = await createCaseContext({ caseId: "A-01", workspace: process.cwd(), evaluationSeed: "b".repeat(64), baseTime: "2035-06-01T12:00:00.000Z", manageDatabase: false });
  try {
    assert.equal(context.caseId, "A-01");
    assert.match(context.databaseName, /^cc_a_01_/u);
    assert.equal(context.fixtures.uuid("x"), context.uuid("x"));
    assert.equal(typeof context.mark, "function");
    assert.equal(typeof context.loadChromium, "function");
  } finally {
    await context.teardown();
  }
  await assert.rejects(createCaseContext({ caseId: "A-01", workspace: process.cwd(), evaluationSeed: "b".repeat(64), manageDatabase: false, compatibilityAdapter: {} }), /forbids compatibility adapters/u);
});

test("unpublished recovery barrier protocol is rejected fail-closed", () => {
  assert.equal(validateBarrierPayload({ schemaVersion: 1, point: "worker.claimed" }), false);
  assert.equal(validateBarrierPayload({ processRole: "dispatcher", point: "dispatcher.response-received", token: "invented" }), false);
});
