import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";
import { parseArgs, selectCases } from "../run.mjs";

const manifest = JSON.parse(await readFile(new URL("../manifest.v2.json", import.meta.url)));
const contractMap = JSON.parse(await readFile(new URL("../contract-map.v2.json", import.meta.url)));

test("MediaDock owns the frozen 22-case 100-point design", () => {
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.equal(CASES.length, 22);
  assert.equal(manifest.cases.reduce((sum, entry) => sum + entry.weight, 0), 100);
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
});

test("every MediaDock case is independently executable and task-owned", () => {
  for (const entry of CASES) {
    assert.equal(entry.taskId, "mediadock");
    assert.equal(typeof entry.run, "function");
    assert.ok(entry.run.length >= 1);
  }
});

test("runner parsing preserves manifest order and rejects unknown cases", () => {
  const options = parseArgs(["--submission", "/candidate", "--result", "/private/result.json", "--seed", "secret", "--case", "E-03,A-01"]);
  assert.deepEqual(options.caseIds, ["E-03", "A-01"]);
  assert.deepEqual(selectCases(manifest, options.caseIds).map(({ id }) => id), ["A-01", "E-03"]);
  assert.throws(() => selectCases(manifest, ["H-01"]), /unknown case ids/iu);
});

test("only published MediaDock gaps can exclude assertions", () => {
  const blocked = manifest.cases.flatMap(({ id, blockedAssertions = [] }) => blockedAssertions.map((entry) => [id, entry.blockedBy]));
  assert.deepEqual(blocked, [
    ["C-02", "MD-GAP-05"], ["C-03", "MD-GAP-05"],
    ["D-02", "MD-GAP-01"], ["D-02", "MD-GAP-02"], ["D-03", "MD-GAP-01"],
    ["D-04", "MD-GAP-01"], ["D-04", "MD-GAP-02"], ["D-04", "MD-GAP-03"],
    ["E-04", "MD-GAP-01"], ["E-04", "MD-GAP-05"],
  ]);
});
