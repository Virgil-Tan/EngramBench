import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json", root), "utf8"));
const contractMap = JSON.parse(await readFile(new URL("contract-map.v2.json", root), "utf8"));
const ids = [
  "CONTRACT-01", "CONTRACT-02", "CONTRACT-03", "CONTRACT-04", "CONTRACT-05",
  "DATA-01", "DATA-02", "DATA-03", "DATA-04", "DATA-05",
  "RECOVERY-01", "RECOVERY-02", "RECOVERY-03", "RECOVERY-04",
  "LAYER-01", "LAYER-02", "LAYER-03", "LAYER-04",
  "OPERATE-01", "OPERATE-02", "OPERATE-03", "OPERATE-04",
];

test("EdgeTwin freezes exactly the designed 22 cases and 100 points", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), ids);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension,
    manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("every case is EdgeTwin-owned, contextual and describes a real public action and oracle", () => {
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), ids);
  for (const item of CASES) {
    assert.equal(item.taskId, "edgetwin");
    assert.equal(item.run.length, 1);
    assert.match(item.fixtureFamily, /^ET-F-/u);
    assert.ok(item.action.length >= 24);
    assert.ok(item.oracle.length >= 24);
  }
});

test("health adjudication stays fail-closed while every other published seam is executable", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["SPEC-GAP-ET-01", "SPEC-GAP-ET-02", "SPEC-GAP-ET-03", "SPEC-GAP-ET-04"]);
  assert.deepEqual(manifest.cases.flatMap((item) => (item.blockedAssertions ?? []).map((entry) => [item.id, entry.id, entry.blockedBy])), [
    ["DATA-03", "wave-health-adjudication", "SPEC-GAP-ET-01"],
    ["RECOVERY-03", "automatic-health-gated-wave-advance", "SPEC-GAP-ET-01"],
  ]);
});

test("case sources contain task seams and no legacy mapping, cross-task imports or inert markers", async () => {
  const files = ["cases/contract.mjs", "cases/data.mjs", "cases/recovery.mjs", "cases/layer.mjs", "cases/operate.mjs", "cases/helpers.mjs", "cases/index.mjs"];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(source, /(?:H-\d\d|evaluator\/adapter|tasks\/(?!edgetwin)|clinicgrid|notifyroute|rulebench|geopulse)/u);
  assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder|not implemented)\b/iu);
  for (const seam of ["/api/v1/devices", "/api/v1/command-receipts", "/api/v1/deployment-waves", "startWorker", "SIGKILL", "startDispatcher", "/openapi.json", "loadChromium", "migrate", "performanceSeed"]) assert.match(source, new RegExp(seam.replaceAll("/", "\\/"), "u"));
});
