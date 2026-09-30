import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";
import { parseArgs, selectCases } from "../run.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("QueueForge freezes exactly the 22 designed executable cases", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension,
    manifest.cases.filter((entry) => entry.dimension === dimension).reduce((sum, entry) => sum + entry.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
  assert.equal(CASES.some(({ id }) => /^H-/u.test(id)), false);
});

test("runner selects only declared QueueForge cases and requires its reproducibility inputs", () => {
  assert.deepEqual(selectCases(manifest, ["A-02", "E-04"]).map(({ id }) => id), ["A-02", "E-04"]);
  assert.throws(() => selectCases(manifest, ["Z-99"]), /unknown case ids/iu);
  assert.deepEqual(parseArgs(["--submission", "/candidate", "--result", "/result.json", "--seed", "secret", "--case", "A-01,B-02"]), {
    caseIds: ["A-01", "B-02"], workspace: "/candidate", result: "/result.json", evaluationSeed: "secret",
  });
  assert.throws(() => parseArgs(["--workspace", "/candidate"]), /required/iu);
});

test("QueueForge has no score-blocking SPEC-GAP assertions", () => {
  assert.deepEqual(manifest.cases.flatMap(({ blockedAssertions = [] }) => blockedAssertions), []);
});
