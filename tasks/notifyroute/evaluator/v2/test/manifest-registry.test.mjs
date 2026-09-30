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

test("NotifyRoute freezes the designed 22 cases, order, dimensions and 100 points", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), ids);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension,
    manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("all entries are task-owned executable definitions with independent fixture and oracle metadata", () => {
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), ids);
  for (const item of CASES) {
    assert.equal(item.taskId, "notifyroute");
    assert.equal(typeof item.run, "function");
    assert.equal(item.run.length, 1);
    assert.match(item.fixtureFamily, /^NR-F-/u);
    assert.ok(item.action.length >= 24);
    assert.ok(item.oracle.length >= 24);
  }
});

test("only eight whole cases are fail-closed at the two applicable frozen gaps", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["SPEC-GAP-NR-01", "SPEC-GAP-NR-02", "SPEC-GAP-NR-03"]);
  const blocked = manifest.cases.flatMap((item) => (item.blockedAssertions ?? []).map(({ blockedBy }) => [item.id, blockedBy]));
  assert.deepEqual(blocked, [
    ["A-05", "SPEC-GAP-NR-01"], ["B-05", "SPEC-GAP-NR-01"],
    ["C-03", "SPEC-GAP-NR-01"], ["C-04", "SPEC-GAP-NR-01"],
    ["D-04", "SPEC-GAP-NR-01"],
    ["E-02", "SPEC-GAP-NR-03"], ["E-03", "SPEC-GAP-NR-03"], ["E-04", "SPEC-GAP-NR-03"],
  ]);
});

test("case code contains no old evaluator gate, cross-task import, or non-executable marker", async () => {
  const files = ["cases/a.mjs", "cases/b.mjs", "cases/c.mjs", "cases/d.mjs", "cases/e.mjs", "cases/helpers.mjs", "cases/index.mjs"];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(source, /(?:H-\d\d|evaluator\/adapter|evaluator\/run\.mjs|tasks\/(?!notifyroute)|auctionguard|rulebench|importworks|schemaharbor|geopulse|clinicgrid)/u);
  assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder|not implemented)\b/iu);
});
