import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import contractMap from "../contract-map.v2.json" with { type: "json" };
import manifest from "../manifest.v2.json" with { type: "json" };
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

test("frozen design headings exactly match ids, weights, order, and total", async () => {
  const design = await readFile(new URL("../../HIDDEN_TEST_V2_DESIGN.zh-CN.md", import.meta.url), "utf8");
  const pattern = /^### ([A-E]-\d+)\b[^\n]*?— ([0-9]+(?:\.[0-9]+)?) 分\s*$/gmu;
  const found = [...design.matchAll(pattern)].map((match) => [match[1], Number(match[2])]);
  assert.deepEqual(manifest.cases.map(({ id, weight }) => [id, weight]), found);
  assert.equal(found.length, 22);
  assert.equal(found.reduce((sum, [, weight]) => sum + weight, 0), 100);
});

test("registry owns exactly the IdentityMesh async run(ctx) cases", () => {
  assert.equal(validateManifest(manifest, contractMap), true);
  validateCaseRegistry(manifest, CASES);
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
  for (const item of CASES) {
    assert.equal(item.taskId, "identitymesh");
    assert.equal(item.run.constructor.name, "AsyncFunction");
    assert.ok(item.run.length >= 1);
    assert.ok(item.fixtureFamily && item.action && item.oracle);
    assert.ok(Array.isArray(item.seams) && item.seams.length > 0);
  }
});

test("contract map and all blocked assertions are task-local and fail closed", () => {
  assert.equal(contractMap.taskId, "identitymesh");
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), manifest.cases.map(({ id }) => id));
  for (const item of contractMap.cases) {
    assert.match(item.privateFailureCodePrefix, /^IM_[A-E]\d{2}_$/u);
    assert.ok(item.requirement.source.startsWith("workspace/") || item.requirement.source.startsWith("orchestration/"));
  }
  const blocked = manifest.cases.flatMap(({ blockedAssertions = [] }) => blockedAssertions);
  assert.equal(blocked.length, 13);
  for (const item of blocked) {
    assert.equal(item.policy, "fail-closed-diagnostic");
    assert.ok(manifest.specGaps.some(({ id }) => id === item.blockedBy));
  }
  assert.ok(!blocked.some(({ blockedBy }) => blockedBy === "IM-GAP-03"), "IM-GAP-03 forbids inventing an Event rather than declaring an executable assertion");
});
