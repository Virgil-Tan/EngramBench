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

test("manifest exactly freezes all 55 CommerceCommand design cases", async () => {
  const manifest = await json(resolve(root, "manifest.v2.json"));
  const contractMap = await json(resolve(root, "contract-map.v2.json"));
  const design = await readFile(resolve(root, "../HIDDEN_TEST_V2_DESIGN.zh-CN.md"), "utf8");
  const frozen = [...design.matchAll(/^### ([A-E]-\d{2}) (.+?)(?: \[BLOCKED:[^\]]+\])? — ([0-9.]+)$/gmu)].map((match) => ({ id: match[1], title: match[2], weight: Number(match[3]) }));
  assert.equal(frozen.length, 55);
  assert.deepEqual(manifest.cases.map(({ id, title, weight }) => ({ id, title, weight })), frozen);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [dimension, manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0)])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
});

test("every implementation is explicitly CommerceCommand-owned async run(ctx)", () => {
  assert.equal(CASES.length, 55);
  for (const item of CASES) {
    assert.equal(item.taskId, "commercecommand");
    assert.equal(item.run.constructor.name, "AsyncFunction");
    assert.equal(item.run.length, 1);
    assert.match(item.fixtureFamily, /^CC-F-/u);
    assert.ok(item.action.length > 28);
    assert.ok(item.oracle.length > 28);
  }
});

test("all blocked assertions name one of the eleven frozen gaps and remain fail-closed", async () => {
  const manifest = await json(resolve(root, "manifest.v2.json"));
  const gaps = new Set(manifest.specGaps.map(({ id }) => id));
  const blockedCases = manifest.cases.filter((item) => item.blockedAssertions);
  assert.deepEqual(blockedCases.map(({ id }) => id), ["A-03", "A-04", "A-05", "A-06", "A-10", "A-11", "A-12", "A-14", "A-15", "B-09", "B-10", "C-02", "C-03", "C-04", "C-05", "C-06", "C-07", "C-08", "D-01", "D-04", "D-06", "D-07", "E-08", "E-09", "E-11", "E-12", "E-13"]);
  for (const item of blockedCases) for (const blocked of item.blockedAssertions) {
    assert.ok(gaps.has(blocked.blockedBy));
    assert.equal(blocked.policy, "fail-closed-diagnostic");
  }
});

test("task modules contain no legacy/cross-task import, placeholder, fake workspace inspection, or invented barrier use", async () => {
  for (const directory of ["cases", "fixtures", "oracles", "lib"]) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const source = await readFile(resolve(root, directory, entry.name), "utf8");
      assert.doesNotMatch(source, /tasks\/[a-z0-9-]+\/evaluator/iu);
      assert.doesNotMatch(source, /(?:evaluator\/v1|legacy-evaluator|cross-task)/iu);
      assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder|not implemented)\b/iu);
      if (directory === "cases") {
        assert.doesNotMatch(source, /(?:existsSync|accessSync|statSync)\s*\(/u);
        assert.doesNotMatch(source, /readFile(?:Sync)?\s*\([^)]*workspace/iu);
        assert.doesNotMatch(source, /\bctx\.barrier\s*\(/u);
      }
    }
  }
});
