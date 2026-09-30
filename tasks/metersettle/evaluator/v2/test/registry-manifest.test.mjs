import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));

test("frozen design IDs, weights and order equal manifest exactly", async () => {
  const design = await readFile(new URL("../../HIDDEN_TEST_V2_DESIGN.zh-CN.md", import.meta.url), "utf8");
  const frozen = [...design.matchAll(/^### ([A-E]-\d{2}) .+ — (\d+)$/gmu)].map(([, id, weight]) => ({ id, weight: Number(weight) }));
  assert.equal(frozen.length, 44);
  assert.deepEqual(manifest.cases.map(({ id, weight }) => ({ id, weight })), frozen);
  assert.equal(frozen.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.dimensions).map(([id, value]) => [id, value.weight])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("manifest, contract map and task-owned async registry are complete", () => {
  assert.equal(validateManifest(manifest, contractMap), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.equal(CASES.length, 44);
  for (const item of CASES) { assert.equal(item.taskId, "metersettle"); assert.equal(item.run.constructor.name, "AsyncFunction"); assert.equal(item.run.length, 1); assert.ok(item.seams.length > 0); }
});

test("every fail-closed declaration maps to a registered SPEC-GAP and implementation", async () => {
  const sources = await Promise.all(["a.mjs", "b.mjs", "c.mjs", "d.mjs", "e.mjs"].map((name) => readFile(new URL(`cases/${name}`, root), "utf8")));
  const source = sources.join("\n"); const gaps = new Set(manifest.specGaps.map(({ id }) => id));
  for (const definition of manifest.cases) for (const blocked of definition.blockedAssertions ?? []) { assert.ok(gaps.has(blocked.blockedBy)); assert.equal(blocked.policy, "fail-closed-diagnostic"); assert.ok(source.includes(`blocked("${blocked.id}", "${blocked.blockedBy}")`)); }
});

test("hard caps equal the seven frozen design failures", () => {
  assert.deepEqual(Object.fromEntries(manifest.hardCaps.map(({ id, cap }) => [id, cap])), { CLEAN_BUILD_MIGRATION_BOOT: 25, RATING_CONSERVATION: 35, CORRECTION_REVISION_CORRECTNESS: 35, IDEMPOTENCY_CORRECTNESS: 30, EVENT_TRANSACTIONALITY: 40, STALE_WORK_OR_LOST_WORK: 40, MIGRATION_COMPATIBILITY: 35 });
});
