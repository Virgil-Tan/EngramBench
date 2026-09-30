import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("DispatchBoard freezes exactly 22 independently weighted cases", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
  assert.ok(CASES.every(({ taskId, run }) => taskId === "dispatchboard" && run.length >= 1));
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension,
    manifest.cases.filter((entry) => entry.dimension === dimension).reduce((sum, entry) => sum + entry.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("only the frozen migration lineage gap blocks a whole case", () => {
  const blocked = manifest.cases.filter(({ blockedAssertions }) => blockedAssertions?.length);
  assert.deepEqual(blocked.map(({ id }) => id), ["E-04"]);
  assert.deepEqual(blocked[0].blockedAssertions, [{
    id: "DB-E04-DRIVER-LINEAGE",
    blockedBy: "SPEC-GAP-DB-01",
    policy: "fail-closed-diagnostic",
    summary: "The required migrated DRIVER lineage has no published FINAL observation surface.",
  }]);
});
