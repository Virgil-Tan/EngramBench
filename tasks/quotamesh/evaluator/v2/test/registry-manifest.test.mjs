import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));
const IDS = ["A-01","A-02","A-03","A-04","A-05","B-01","B-02","B-03","B-04","B-05","C-01","C-02","C-03","C-04","D-01","D-02","D-03","D-04","E-01","E-02","E-03","E-04"];
test("QuotaMesh freezes exactly 22 task-owned executable Cases", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), IDS);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [dimension, manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0)])), { A:30,B:25,C:20,D:15,E:10 });
});
test("every Case owns an executable QuotaMesh fixture, action, oracle and contract mapping", () => {
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), IDS);
  for (const item of CASES) {
    assert.equal(item.taskId, "quotamesh"); assert.equal(typeof item.run, "function");
    for (const field of ["fixtureFamily","action","oracle"]) assert.ok(item[field].length >= 8, `${item.id} lacks ${field}`);
  }
  for (const item of contractMap.cases) assert.equal(item.privateFailureCodePrefix, `QM_${item.caseId.replace("-", "")}_`);
});
test("frozen SPEC-GAPs are explanatory and no Case is blocked", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["SPEC-GAP-QM-01","SPEC-GAP-QM-02"]);
  assert.deepEqual(manifest.cases.flatMap(({ blockedAssertions = [] }) => blockedAssertions), []);
});
