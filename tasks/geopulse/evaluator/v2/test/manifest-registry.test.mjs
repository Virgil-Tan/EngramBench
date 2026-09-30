import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));
const ids = [
  "A-01", "A-02", "A-03", "A-04", "A-05",
  "B-01", "B-02", "B-03", "B-04", "B-05",
  "C-01", "C-02", "C-03", "C-04",
  "D-01", "D-02", "D-03", "D-04",
  "E-01", "E-02", "E-03", "E-04",
];

test("GeoPulse freezes exactly the designed 22 domain cases and 100 points", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), ids);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension,
    manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("every case is task-owned and declares an executable public action and independent oracle", () => {
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), ids);
  for (const item of CASES) {
    assert.equal(item.taskId, "geopulse");
    assert.equal(typeof item.run, "function");
    assert.match(item.fixtureFamily, /^GP-F-/u);
    assert.ok(item.action.length >= 24);
    assert.ok(item.oracle.length >= 24);
  }
  for (const mapping of contractMap.cases) {
    assert.equal(mapping.privateFailureCodePrefix, `GP_${mapping.caseId.replace("-", "")}_`);
    assert.match(mapping.requirement.source, /^(workspace\/README\.md|orchestration\/manager-prompt\.zh-CN\.md|CONTEXT\.md)#/u);
  }
});

test("only the three frozen GeoPulse SPEC-GAPs block explicit subassertions", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["GP-GAP-01", "GP-GAP-02", "GP-GAP-03"]);
  const referenced = new Set(manifest.cases.flatMap((item) => (item.blockedAssertions ?? []).map(({ blockedBy }) => blockedBy)));
  assert.deepEqual([...referenced].sort(), ["GP-GAP-01", "GP-GAP-02", "GP-GAP-03"]);
});

test("case modules never import legacy evaluators or another task", async () => {
  const files = ["cases/a.mjs", "cases/b.mjs", "cases/c.mjs", "cases/d.mjs", "cases/e.mjs", "cases/helpers.mjs", "cases/index.mjs"];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(source, /(?:H-\d\d|evaluator\/adapter|evaluator\/run\.mjs|tasks\/(?!geopulse)|auctionguard|rulebench|importworks|schemaharbor)/u);
  assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder|not implemented)\b/iu);
});
