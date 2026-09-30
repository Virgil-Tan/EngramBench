import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { IDS, validateManifest } from "../lib/scoring.mjs";

const CASE_HEADING = /^### ([A-Z][A-Z0-9_-]*-\d+)\s+(.+?)[（(]([0-9]+(?:\.[0-9]+)?) 分[）)]$/gmu;

test("manifest and contract-map exactly freeze all CreatorRightsExchange cases", async () => {
  const [design, manifestSource, contractSource] = await Promise.all([
    readFile(new URL("../../HIDDEN_TEST_V2_DESIGN.zh-CN.md", import.meta.url), "utf8"),
    readFile(new URL("../manifest.v2.json", import.meta.url), "utf8"),
    readFile(new URL("../contract-map.v2.json", import.meta.url), "utf8"),
  ]);
  const expected = [...design.matchAll(CASE_HEADING)].map((match) => ({ id: match[1], title: match[2], weight: Number(match[3]) }));
  const manifest = JSON.parse(manifestSource);
  const contractMap = JSON.parse(contractSource);
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.deepEqual(manifest.cases.map(({ id, title, weight }) => ({ id, title, weight })), expected);
  assert.deepEqual(manifest.cases.map(({ id }) => id), IDS);
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), IDS);
  assert.equal(manifest.cases.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.equal(CASES.length, 54);
  for (const item of CASES) {
    assert.equal(item.taskId, "creatorrightsexchange");
    assert.equal(item.run.constructor.name, "AsyncFunction");
    assert.equal(item.run.length, 1);
  }
});
