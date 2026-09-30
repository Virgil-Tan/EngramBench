import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("ParcelFlow owns exactly 49 weighted task-specific cases", () => {
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.equal(CASES.length, 49);
  assert.equal(new Set(CASES.map(({ id }) => id)).size, 49);
  assert.ok(CASES.every(({ id }) => /^[A-E]-\d{2}$/u.test(id)));
  assert.ok(CASES.every(({ id }) => !id.startsWith("PF-")));
});

test("every case declares its own ParcelFlow action and independent oracle", () => {
  for (const item of CASES) {
    assert.match(item.fixtureFamily, /^F-/u, `${item.id} fixture family`);
    assert.ok(item.action.length > 12, `${item.id} action`);
    assert.ok(item.oracle.length > 12, `${item.id} oracle`);
    assert.equal(typeof item.run, "function", `${item.id} run`);
    assert.match(String(item.run), /ctx\.|context\./u, `${item.id} executes through a public evaluator context`);
  }
  assert.equal(new Set(CASES.map(({ id, action }) => `${id}:${action}`)).size, 49);
});

test("case modules never import the legacy hidden runner as an implementation", async () => {
  const sources = await Promise.all(["a", "b", "c", "d", "e"].map((name) => readFile(new URL(`../cases/${name}.mjs`, import.meta.url), "utf8")));
  assert.ok(sources.every((source) => !source.includes("hidden/parcelflow")));
  assert.ok(sources.every((source) => !/PF-(?:E2E|CON|REC|PERF|AUD)-/u.test(source)));
});

test("contract map has one authoritative mapping and ParcelFlow failure prefix per case", () => {
  assert.deepEqual(
    contractMap.cases.map(({ caseId }) => caseId).sort(),
    manifest.cases.map(({ id }) => id).sort(),
  );
  for (const mapping of contractMap.cases) {
    assert.equal(mapping.privateFailureCodePrefix, `PF_${mapping.caseId.replace("-", "")}_`);
    assert.match(mapping.requirement.source, /workspace\/README\.md|user-and-manager-prompts\.zh-CN\.md|workspace\/AGENTS\.md/u);
  }
});
