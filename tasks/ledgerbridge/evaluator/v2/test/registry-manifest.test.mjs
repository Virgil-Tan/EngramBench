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

test("LedgerBridge freezes exactly the 22 designed executable cases", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), IDS);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension, manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("every case is task-owned and mapped to one public LedgerBridge contract", () => {
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), IDS);
  for (const item of CASES) {
    assert.equal(item.taskId, "ledgerbridge");
    assert.equal(typeof item.run, "function");
    for (const field of ["fixtureFamily", "action", "oracle"]) assert.ok(item[field].length >= 8, `${item.id} lacks ${field}`);
  }
  for (const mapping of contractMap.cases) {
    assert.equal(mapping.privateFailureCodePrefix, `LB_${mapping.caseId.replace("-", "")}_`);
    assert.match(mapping.requirement.source, /^(workspace\/README\.md|orchestration\/user-and-manager-prompts\.zh-CN\.md|CONTEXT\.md)#/u);
  }
});

test("LB-GAP-01 remains a narrow fail-closed subassertion", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["LB-GAP-01"]);
  assert.deepEqual(Object.fromEntries(manifest.cases.flatMap((item) => item.blockedAssertions ? [[item.id, item.blockedAssertions]] : [])), {
    "A-05": [{ id: "legacy-one-leg-statement-leg-shape", blockedBy: "LB-GAP-01", policy: "fail-closed-diagnostic" }],
    "D-03": [{ id: "legacy-one-leg-statement-leg-shape", blockedBy: "LB-GAP-01", policy: "fail-closed-diagnostic" }],
  });
});
