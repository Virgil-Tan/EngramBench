import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import * as taskExecution from "../lib/execution.mjs";
import { createCaseContext } from "../lib/runtime.mjs";
import { validateManifest } from "../lib/scoring.mjs";
import * as sharedExecution from "../../../../../src/task-evaluator-v2/execution.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("SchemaHarbor freezes exactly the 22 designed domain cases", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.equal(manifest.cases.length, 22);
  assert.deepEqual(
    Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
      dimension,
      manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
    ])),
    { A: 30, B: 25, C: 20, D: 15, E: 10 },
  );
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
  assert.equal(CASES.some(({ id }) => /^H-/u.test(id)), false);
});

test("SchemaHarbor declares only the two published SPEC-GAP diagnostics", () => {
  const declarations = manifest.cases.flatMap(({ id, blockedAssertions = [] }) => (
    blockedAssertions.map((item) => ({ caseId: id, ...item }))
  ));
  assert.deepEqual(declarations, [
    { caseId: "A-04", id: "incompatible-http-trigger", blockedBy: "SPEC-GAP-SH-02", policy: "fail-closed-diagnostic" },
    { caseId: "A-05", id: "cross-aggregate-event-order", blockedBy: "SPEC-GAP-SH-01", policy: "fail-closed-diagnostic" },
    { caseId: "C-04", id: "cross-aggregate-event-order", blockedBy: "SPEC-GAP-SH-01", policy: "fail-closed-diagnostic" },
  ]);
});

test("task execution delegates to shared infrastructure and runtime stays SchemaHarbor-scoped", async () => {
  assert.equal(taskExecution.executeCase, sharedExecution.executeCase);
  assert.equal(taskExecution.validateCaseRegistry, sharedExecution.validateCaseRegistry);
  const context = await createCaseContext({
    caseId: "A-01",
    workspace: new URL("../../../workspace/", import.meta.url).pathname,
    evaluationSeed: "design-test",
    baseTime: "2035-06-01T12:00:00.000Z",
    manageDatabase: false,
  });
  try {
    await context.setup();
    assert.match(context.databaseName, /^sh_a_01_/u);
    assert.match(context.uuid("subject"), /^[0-9a-f-]{36}$/u);
    assert.equal(context.fixtures.caseId, "A-01");
  } finally {
    await context.teardown();
  }
});
