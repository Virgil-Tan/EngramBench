import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("RuleBench owns the frozen 22 task-specific cases totaling 100 points", () => {
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.equal(CASES.length, 22);
  assert.equal(CASES.reduce((sum, item) => sum + manifest.cases.find(({ id }) => id === item.id).weight, 0), 100);
  assert.deepEqual(
    Object.fromEntries(["A", "B", "C", "D", "E"].map((dimension) => [
      dimension,
      manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
    ])),
    { A: 30, B: 25, C: 20, D: 15, E: 10 },
  );
});

test("every case declares a distinct RuleBench fixture, public action, and independent oracle", () => {
  for (const item of CASES) {
    assert.match(item.fixtureFamily, /^RB-F-/u, `${item.id} fixture`);
    assert.ok(item.action.length > 20, `${item.id} action`);
    assert.ok(item.oracle.length > 20, `${item.id} oracle`);
    assert.equal(typeof item.run, "function", `${item.id} runner`);
  }
  assert.equal(new Set(CASES.map(({ id, action }) => `${id}:${action}`)).size, 22);
});

test("C-04 declares only the published unknown-ACK diagnostic gap", () => {
  const c04 = manifest.cases.find(({ id }) => id === "C-04");
  assert.deepEqual(c04.blockedAssertions, [{
    id: "external-delivery-unknown-ack",
    blockedBy: "SPEC-GAP-RB-03",
    policy: "fail-closed-diagnostic",
  }]);
  assert.ok(manifest.cases.filter(({ id }) => id !== "C-04").every((item) => item.blockedAssertions === undefined));
});

test("task-local case modules never import the legacy H runner or another task", async () => {
  const sources = await Promise.all(["a", "b", "c", "d", "e"].map((name) => readFile(new URL(`../cases/${name}.mjs`, import.meta.url), "utf8")));
  assert.ok(sources.every((source) => !source.includes("evaluator/adapter.mjs")));
  assert.ok(sources.every((source) => !/\bH-(?:0[1-9]|1[0-3])\b/u.test(source)));
  assert.ok(sources.every((source) => !/tasks\/(?!rulebench)/u.test(source)));
});
