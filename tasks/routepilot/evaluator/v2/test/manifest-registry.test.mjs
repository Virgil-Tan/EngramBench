import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { IDS, validateManifest } from "../lib/scoring.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));

test("manifest freezes the RoutePilot design IDs weights order and total", async () => {
  const manifest = await json(resolve(root, "manifest.v2.json"));
  const contractMap = await json(resolve(root, "contract-map.v2.json"));
  const design = await readFile(resolve(root, "../HIDDEN_TEST_V2_DESIGN.zh-CN.md"), "utf8");
  const frozen = [...design.matchAll(/^### ([A-E]-\d{2}) .+ — ([0-9.]+) 分$/gmu)].map((match) => ({ id: match[1], weight: Number(match[2]) }));
  assert.equal(frozen.length, 22);
  assert.deepEqual(manifest.cases.map(({ id, weight }) => ({ id, weight })), frozen);
  assert.deepEqual(manifest.cases.map(({ id }) => id), IDS);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
});

test("every implementation is explicitly RoutePilot-owned async run(ctx)", () => {
  assert.equal(CASES.length, 22);
  for (const item of CASES) {
    assert.equal(item.taskId, "routepilot");
    assert.equal(item.run.constructor.name, "AsyncFunction");
    assert.equal(item.run.length, 1);
    assert.match(item.fixtureFamily, /^RP-F-/u);
    assert.ok(item.action.length > 24);
    assert.ok(item.oracle.length > 24);
  }
});

test("case modules contain no old or cross-task evaluator imports and no fake checks", async () => {
  for (const directory of ["cases", "fixtures", "oracles", "lib"]) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const source = await readFile(resolve(root, directory, entry.name), "utf8");
      assert.doesNotMatch(source, /tasks\/[a-z0-9-]+\/evaluator/iu);
      assert.doesNotMatch(source, /\.\.\/\.\.\/(?:adapter|run|framework)/iu);
      assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder|not implemented)\b/iu);
      if (directory === "cases") {
        assert.doesNotMatch(source, /(?:existsSync|accessSync|statSync)\s*\(/u);
        assert.doesNotMatch(source, /readFile(?:Sync)?\s*\([^)]*workspace/iu);
      }
    }
  }
});

test("SPEC-GAP-RP-01 is fail-closed only at the three frozen branches", async () => {
  const manifest = await json(resolve(root, "manifest.v2.json"));
  const blocked = manifest.cases.filter((item) => item.blockedAssertions).map((item) => [item.id, item.blockedAssertions[0].id, item.blockedAssertions[0].blockedBy]);
  assert.deepEqual(blocked, [["A-05", "RP-A05-AUTO-ADVANCE", "SPEC-GAP-RP-01"], ["C-03", "RP-C03-READINESS", "SPEC-GAP-RP-01"], ["D-03", "RP-D03-AUTO-ADVANCE", "SPEC-GAP-RP-01"]]);
});
