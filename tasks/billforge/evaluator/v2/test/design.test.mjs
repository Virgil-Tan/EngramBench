import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("BillForge freezes exactly the 22 designed cases and their weights", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension, manifest.cases.filter((entry) => entry.dimension === dimension).reduce((sum, entry) => sum + entry.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("every frozen SPEC-GAP is fail-closed and no unpublished perf or barrier case is invented", () => {
  const blocked = manifest.cases.flatMap(({ blockedAssertions = [] }) => blockedAssertions);
  assert.ok(blocked.length > 0);
  assert.ok(blocked.every(({ policy }) => policy === "fail-closed-diagnostic"));
  assert.equal(manifest.cases.some(({ title }) => /performance|load|throughput/iu.test(title)), false);
});
