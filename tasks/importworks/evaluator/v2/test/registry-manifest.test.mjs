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

test("ImportWorks freezes exactly the 22 designed domain cases", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), IDS);
  assert.deepEqual(
    Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
      dimension,
      manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
    ])),
    { A: 30, B: 25, C: 20, D: 15, E: 10 },
  );
});

test("every executable case has one task-local public-contract mapping", () => {
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), IDS);
  for (const item of CASES) {
    assert.equal(item.taskId, "importworks", `${item.id} is not task-owned`);
    assert.equal(typeof item.run, "function", `${item.id} has no run function`);
    for (const field of ["fixtureFamily", "action", "oracle"]) assert.ok(item[field].length >= 8, `${item.id} has no executable ${field} declaration`);
  }
  for (const mapping of contractMap.cases) {
    assert.equal(mapping.privateFailureCodePrefix, `IW_${mapping.caseId.replace("-", "")}_`);
    assert.match(mapping.requirement.source, /^(workspace\/README\.md|orchestration\/manager-prompt\.zh-CN\.md|CONTEXT\.md)#/u);
  }
});

test("published SPEC-GAPs stay explicit fail-closed subassertions", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["IW-GAP-01", "IW-GAP-02", "IW-GAP-03"]);
  const blocked = Object.fromEntries(manifest.cases.flatMap((item) => (
    item.blockedAssertions?.length ? [[item.id, item.blockedAssertions]] : []
  )));
  assert.deepEqual(blocked, {
    "A-03": [
      { id: "error-report-download-bytes", blockedBy: "IW-GAP-01", policy: "fail-closed-diagnostic" },
    ],
    "C-01": [
      { id: "validate-effect-commit-window", blockedBy: "IW-GAP-03", policy: "fail-closed-diagnostic" },
    ],
    "C-02": [
      { id: "commit-report-effect-commit-window", blockedBy: "IW-GAP-03", policy: "fail-closed-diagnostic" },
    ],
    "C-03": [
      { id: "bundle-effect-commit-window", blockedBy: "IW-GAP-03", policy: "fail-closed-diagnostic" },
    ],
    "D-02": [
      { id: "ui-error-report-download-bytes", blockedBy: "IW-GAP-01", policy: "fail-closed-diagnostic" },
      { id: "ui-bundle-refresh-history", blockedBy: "IW-GAP-02", policy: "fail-closed-diagnostic" },
    ],
  });
});
