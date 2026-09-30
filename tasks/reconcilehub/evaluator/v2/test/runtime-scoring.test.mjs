import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { createCaseContext, runCommand } from "../lib/runtime.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root = new URL("..", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("runtime creates deterministic ReconcileHub context without managing PostgreSQL", async () => {
  const context = await createCaseContext({ caseId: "A-01", workspace: process.cwd(), evaluationSeed: "runtime", baseTime: "2035-06-01T12:00:00.000Z", manageDatabase: false });
  try {
    await context.setup();
    assert.equal(context.caseId, "A-01");
    assert.equal(context.uuid("line"), context.fixtures.uuid("line"));
    assert.equal(typeof context.snapshot, "function");
  } finally {
    await context.teardown();
  }
});

test("shared command boundary captures a real process result", async () => {
  const result = await runCommand(process.execPath, ["-e", "process.stdout.write('reconcilehub')"], { timeoutMs: 5_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "reconcilehub");
});

test("all cases passing yields the frozen 100 points", () => {
  const result = scoreEvaluation(manifest, contractMap, { cases: CASES.map(({ id }) => ({ id, status: "passed", durationMs: 1 })) });
  assert.equal(result.score, 100);
  assert.equal(result.verdict, "accepted");
});

test("a second durable effect applies the 30-point cap", () => {
  const cases = CASES.map(({ id }) => ({ id, status: "passed", durationMs: 1 }));
  cases[5] = { id: "B-01", status: "failed", privateFailureCode: "RH_B01_ASSERTION_FAILED", hardCapIds: ["DURABLE_IDEMPOTENCY"] };
  const result = scoreEvaluation(manifest, contractMap, { cases });
  assert.equal(result.score, 30);
  assert.deepEqual(result.hardCapsApplied.map(({ id }) => id), ["DURABLE_IDEMPOTENCY"]);
});
