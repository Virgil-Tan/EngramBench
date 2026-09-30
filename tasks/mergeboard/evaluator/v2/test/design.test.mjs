import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));
const IDS = [
  "A-01", "A-02", "A-03", "A-04", "A-05",
  "B-01", "B-02", "B-03", "B-04", "B-05",
  "C-01", "C-02", "C-03", "C-04",
  "D-01", "D-02", "D-03", "D-04",
  "E-01", "E-02", "E-03", "E-04",
];

test("MergeBoard freezes exactly the designed 22 cases and 100 points", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(manifest.cases.map(({ id }) => id), IDS);
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), IDS);
  assert.deepEqual(CASES.map(({ id }) => id), IDS);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension,
    manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("every case is task-owned and carries executable fixture/action/oracle metadata", () => {
  for (const entry of CASES) {
    assert.equal(entry.taskId, "mergeboard");
    assert.match(entry.fixtureFamily, /^MB-F-/u);
    assert.ok(entry.action.length >= 24);
    assert.ok(entry.oracle.length >= 24);
    assert.equal(typeof entry.run, "function");
    assert.ok(entry.run.length >= 1);
  }
});

test("the two frozen SPEC-GAPs remain sub-assertions on their designed cases", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["MB-GAP-01", "MB-GAP-02"]);
  assert.deepEqual(manifest.cases.filter(({ blockedAssertions }) => blockedAssertions?.length).map(({ id }) => id), ["A-05", "D-03", "E-01"]);
});
