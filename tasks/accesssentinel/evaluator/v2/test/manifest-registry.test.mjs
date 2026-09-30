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

test("manifest freezes all 53 AccessSentinel cases, weights and order", async () => {
  const manifest = await json(resolve(root, "manifest.v2.json"));
  const contractMap = await json(resolve(root, "contract-map.v2.json"));
  const design = await readFile(resolve(root, "../HIDDEN_TEST_V2_DESIGN.zh-CN.md"), "utf8");
  const frozen = [...design.matchAll(/^### ([A-E]-\d{2})\b[^\n]*?— ([0-9.]+)$/gmu)]
    .map((match) => ({ id: match[1], weight: Number(match[2]) }));
  assert.equal(frozen.length, 53);
  assert.deepEqual(manifest.cases.map(({ id, weight }) => ({ id, weight })), frozen);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension,
    manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
});

test("every implementation is AccessSentinel-owned async run(ctx)", () => {
  assert.equal(CASES.length, 53);
  for (const item of CASES) {
    assert.equal(item.taskId, "accesssentinel");
    assert.equal(item.run.constructor.name, "AsyncFunction");
    assert.equal(item.run.length, 1);
    assert.match(item.fixtureFamily, /^AS-F-/u);
    assert.ok(item.action.length >= 24);
    assert.ok(item.oracle.length >= 24);
  }
});

test("task modules contain no legacy, cross-task or placeholder checks", async () => {
  for (const directory of ["cases", "fixtures", "oracles", "lib"]) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const source = await readFile(resolve(root, directory, entry.name), "utf8");
      assert.doesNotMatch(source, /(?:hidden\/hard-fullstack|legacy-process-evaluator|\/evaluator\/run\.mjs|\.\.\/\.\.\/[^/]+\/evaluator\/v2)/u);
      assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder|not implemented)\b/iu);
      if (directory === "cases") {
        assert.doesNotMatch(source, /(?:existsSync|accessSync|statSync)\s*\(/u);
        assert.doesNotMatch(source, /readFile(?:Sync)?\s*\([^)]*workspace/iu);
      }
    }
  }
});

test("the five published contract gaps and affected assertions are frozen", async () => {
  const manifest = await json(resolve(root, "manifest.v2.json"));
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["AS-GAP-01", "AS-GAP-02", "AS-GAP-03", "AS-GAP-04", "AS-GAP-05"]);
  assert.deepEqual(Object.fromEntries(manifest.cases.filter(({ blockedAssertions }) => blockedAssertions).map(({ id, blockedAssertions }) => [id, blockedAssertions])), {
    "A-12": [{ id: "AS-A12-REVIEW-BODY", blockedBy: "AS-GAP-01", policy: "fail-closed-diagnostic" }],
    "A-14": [{ id: "AS-A14-EVENT-TYPE-PAYLOAD", blockedBy: "AS-GAP-03", policy: "fail-closed-diagnostic" }],
    "A-15": [{ id: "AS-A15-FINAL-SNAPSHOT-KEYS", blockedBy: "AS-GAP-04", policy: "fail-closed-diagnostic" }],
    "A-16": [{ id: "AS-A16-FINAL-SNAPSHOT-KEYS", blockedBy: "AS-GAP-04", policy: "fail-closed-diagnostic" }],
    "D-01": [{ id: "AS-D01-V1-REVIEW-SUCCESS", blockedBy: "AS-GAP-01", policy: "fail-closed-diagnostic" }],
    "D-03": [{ id: "AS-D03-REVIEW-MUTATION", blockedBy: "AS-GAP-01", policy: "fail-closed-diagnostic" }],
    "D-05": [{ id: "AS-D05-FINAL-SNAPSHOT-KEYS", blockedBy: "AS-GAP-04", policy: "fail-closed-diagnostic" }],
    "D-08": [{ id: "AS-D08-FINAL-SNAPSHOT-KEYS", blockedBy: "AS-GAP-04", policy: "fail-closed-diagnostic" }],
  });
});
