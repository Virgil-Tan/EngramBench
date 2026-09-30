import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";

const root = new URL("..", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("ReconcileHub freezes exactly its designed 22 cases and 100 points", () => {
  const ids = [
    "A-01", "A-02", "A-03", "A-04", "A-05",
    "B-01", "B-02", "B-03", "B-04", "B-05",
    "C-01", "C-02", "C-03", "C-04",
    "D-01", "D-02", "D-03", "D-04",
    "E-01", "E-02", "E-03", "E-04",
  ];
  assert.equal(manifest.taskId, "reconcilehub");
  assert.deepEqual(manifest.cases.map(({ id }) => id), ids);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), ids);
  assert.deepEqual(CASES.map(({ id }) => id), ids);
});

test("every case is ReconcileHub-owned and executable", () => {
  for (const entry of CASES) {
    assert.equal(entry.taskId, "reconcilehub");
    assert.equal(typeof entry.run, "function");
    assert.ok(entry.run.length >= 1);
    assert.match(entry.fixtureFamily, /^RH-F-/u);
    assert.ok(entry.action.length > 24);
    assert.ok(entry.oracle.length > 24);
  }
});

test("the two published SPEC-GAPs block no scoring case", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["SPEC-GAP-RH-01", "SPEC-GAP-RH-02"]);
  assert.ok(manifest.cases.every(({ blockedAssertions = [] }) => blockedAssertions.length === 0));
});
