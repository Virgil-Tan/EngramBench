import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

test("manifest freezes the FlagFoundry 44 IDs, weights, order and total", async () => {
  const manifest = await json(resolve(root, "manifest.v2.json")); const contractMap = await json(resolve(root, "contract-map.v2.json")); const design = await readFile(resolve(root, "../HIDDEN_TEST_V2_DESIGN.zh-CN.md"), "utf8"); const frozen = [...design.matchAll(/^### ([A-E]-\d{2}) .+ — ([0-9.]+)$/gmu)].map((match) => ({ id: match[1], weight: Number(match[2]) })); assert.equal(frozen.length, 44); assert.deepEqual(manifest.cases.map(({ id, weight }) => ({ id, weight })), frozen); assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100); assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [dimension, manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0)])), { A: 30, B: 25, C: 20, D: 15, E: 10 }); assert.equal(validateManifest(manifest, contractMap), true); assert.equal(validateCaseRegistry(manifest, CASES), true);
});

test("all implementations are explicitly FlagFoundry-owned async run(ctx)", () => {
  assert.equal(CASES.length, 44); for (const item of CASES) { assert.equal(item.taskId, "flagfoundry"); assert.equal(item.run.constructor.name, "AsyncFunction"); assert.equal(item.run.length, 1); assert.match(item.fixtureFamily, /^FF-F-/u); assert.ok(item.action.length > 24); assert.ok(item.oracle.length > 24); }
});

test("task modules have no old/cross-task evaluator imports or placeholder fake checks", async () => {
  for (const directory of ["cases", "fixtures", "oracles", "lib"]) for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) { if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue; const source = await readFile(resolve(root, directory, entry.name), "utf8"); assert.doesNotMatch(source, /from\s+["'][^"']*tasks\/[a-z0-9-]+\/evaluator/iu); assert.doesNotMatch(source, /from\s+["'][^"']*(?:evaluator\/v1|legacy-evaluator|cross-task)/iu); assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder|not implemented)\b/iu); if (directory === "cases") { assert.doesNotMatch(source, /(?:existsSync|accessSync|statSync)\s*\(/u); assert.doesNotMatch(source, /readFile(?:Sync)?\s*\([^)]*workspace/iu); } }
});

test("all eight SPEC-GAP assertions are frozen fail-closed diagnostics", async () => {
  const manifest = await json(resolve(root, "manifest.v2.json")); const blocked = Object.fromEntries(manifest.cases.filter((item) => item.blockedAssertions).map((item) => [item.id, item.blockedAssertions.map(({ id, blockedBy, policy }) => [id, blockedBy, policy])])); assert.deepEqual(blocked, {
    "A-09": [["FF-A09-DEFAULT-UNKNOWN-ATTRIBUTE", "SPEC-GAP-08", "fail-closed-diagnostic"]],
    "A-11": [["FF-A11-SCHEMA-RACE", "SPEC-GAP-07", "fail-closed-diagnostic"], ["FF-A11-FINDINGS-SURFACE", "SPEC-GAP-05", "fail-closed-diagnostic"]],
    "A-13": [["FF-A13-RUNNING-REVISION-STATE", "SPEC-GAP-01", "fail-closed-diagnostic"], ["FF-A13-LEGACY-ROLLOUT-ROW", "SPEC-GAP-02", "fail-closed-diagnostic"]],
    "A-14": [["FF-A14-STALE-ERROR-CODE", "SPEC-GAP-03", "fail-closed-diagnostic"], ["FF-A14-OUTCOME-ID-BOUNDARY", "SPEC-GAP-04", "fail-closed-diagnostic"]],
    "C-08": [["FF-C08-ROLLOUT-EVENT-NAME", "SPEC-GAP-06", "fail-closed-diagnostic"]],
  });
});
