import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("LaunchPass freezes exactly the 22 designed domain cases", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.equal(CASES.length, 22);
  assert.deepEqual(
    CASES.map(({ id }) => id),
    [
      "A-01", "A-02", "A-03", "A-04", "A-05",
      "B-01", "B-02", "B-03", "B-04", "B-05",
      "C-01", "C-02", "C-03", "C-04",
      "D-01", "D-02", "D-03", "D-04",
      "E-01", "E-02", "E-03", "E-04",
    ],
  );
  assert.deepEqual(
    Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
      dimension,
      manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
    ])),
    { A: 30, B: 25, C: 20, D: 15, E: 10 },
  );
});

test("every executable case has one task-local contract mapping", () => {
  assert.deepEqual(
    contractMap.cases.map(({ caseId }) => caseId),
    CASES.map(({ id }) => id),
  );
  for (const item of CASES) assert.equal(typeof item.run, "function", `${item.id} has no run function`);
  for (const mapping of contractMap.cases) {
    assert.match(mapping.privateFailureCodePrefix, /^LP_[A-E][0-9]{2}_$/u);
    assert.match(mapping.requirement.source, /^(workspace\/README\.md|orchestration\/user-and-manager-prompts\.zh-CN\.md)#/u);
  }
});

test("spec-gap assertions remain explicit subassertions with a fail-closed diagnostic policy", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["LP-GAP-01", "LP-GAP-02", "LP-GAP-03"]);
  assert.deepEqual(manifest.cases.find(({ id }) => id === "A-05").blockedAssertions, [
    { id: "waitlist-get-success-status", blockedBy: "LP-GAP-01", policy: "fail-closed-diagnostic" },
    { id: "waitlist-delete-success-status", blockedBy: "LP-GAP-01", policy: "fail-closed-diagnostic" },
  ]);
  assert.deepEqual(manifest.cases.find(({ id }) => id === "D-04").blockedAssertions, [
    { id: "openapi-waitlist-get-success-status", blockedBy: "LP-GAP-01", policy: "fail-closed-diagnostic" },
    { id: "openapi-waitlist-delete-success-status", blockedBy: "LP-GAP-01", policy: "fail-closed-diagnostic" },
  ]);
});
