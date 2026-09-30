import assert from "node:assert/strict";
import test from "node:test";
import { createCaseContext } from "../lib/runtime.mjs";

test("runtime creates isolated FirmwareFleet context and forbids adapters", async () => {
  const context = await createCaseContext({
    caseId: "A-01",
    workspace: process.cwd(),
    evaluationSeed: "seed",
    baseTime: "2035-07-01T12:00:00.000Z",
    manageDatabase: false,
  });
  try {
    assert.equal(context.caseId, "A-01");
    assert.match(context.databaseName, /^ff_a_01_/u);
    assert.equal(typeof context.request, "function");
    assert.equal(typeof context.barrier, "function");
    assert.equal(typeof context.loadChromium, "function");
    assert.deepEqual(context.evidence, []);
  } finally {
    await context.teardown();
  }
  await assert.rejects(
    () =>
      createCaseContext({
        caseId: "A-01",
        workspace: process.cwd(),
        evaluationSeed: "seed",
        compatibilityAdapter: "old",
        manageDatabase: false,
      }),
    /forbids compatibility/u,
  );
});
