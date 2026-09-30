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
  "SLOT-01", "SLOT-02", "SLOT-03", "SLOT-04", "SLOT-05",
  "PLAN-01", "PLAN-02", "PLAN-03", "PLAN-04", "PLAN-05",
  "RACE-01", "RACE-02", "RACE-03", "RACE-04",
  "MIGRATE-01", "MIGRATE-02", "MIGRATE-03", "MIGRATE-04",
  "LOAD-01", "LOAD-02", "LOAD-03", "LOAD-04",
];

test("ClinicGrid freezes exactly the designed 22 executable cases and 100 points", () => {
  assert.doesNotThrow(() => validateManifest(manifest, contractMap));
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), ids);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [
    dimension,
    manifest.cases.filter((item) => item.dimension === dimension).reduce((sum, item) => sum + item.weight, 0),
  ])), { A: 30, B: 25, C: 20, D: 15, E: 10 });
});

test("every case is ClinicGrid-owned with a public action and independent oracle", () => {
  assert.deepEqual(contractMap.cases.map(({ caseId }) => caseId), ids);
  for (const item of CASES) {
    assert.equal(item.taskId, "clinicgrid");
    assert.equal(typeof item.run, "function");
    assert.match(item.fixtureFamily, /^CG-F-/u);
    assert.ok(item.action.length >= 24);
    assert.ok(item.oracle.length >= 24);
  }
  for (const mapping of contractMap.cases) {
    assert.equal(mapping.privateFailureCodePrefix, `CG_${mapping.caseId.replace("-", "")}_`);
    assert.match(mapping.requirement.source, /^(workspace\/README\.md|orchestration\/user-and-manager-prompts\.zh-CN\.md|CONTEXT\.md)#/u);
  }
});

test("only public-seam gaps block the two frozen subassertions", () => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id), ["SPEC-GAP-CG-01", "SPEC-GAP-CG-02", "SPEC-GAP-CG-03"]);
  const blocked = manifest.cases.flatMap((item) => item.blockedAssertions ?? []);
  assert.deepEqual(blocked.map(({ id, blockedBy }) => [id, blockedBy]), [
    ["confirm-exactly-at-expires-at", "SPEC-GAP-CG-03"],
    ["per-statement-access-exclusive-lock", "SPEC-GAP-CG-02"],
  ]);
});

test("case modules contain no old evaluator mapping, cross-task import, or non-executable marker", async () => {
  const files = ["cases/slot.mjs", "cases/plan.mjs", "cases/race.mjs", "cases/migrate.mjs", "cases/load.mjs", "cases/helpers.mjs", "cases/index.mjs"];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, root), "utf8")))).join("\n");
  assert.doesNotMatch(source, /(?:H-\d\d|evaluator\/adapter|tasks\/(?!clinicgrid)|auctionguard|rulebench|importworks|schemaharbor|geopulse)/u);
  assert.doesNotMatch(source, /\b(?:TODO|FIXME|placeholder|not implemented)\b/iu);
  for (const seam of ["/api/v1/appointments", "/api/v1/care-plans", "startWorker", "SIGKILL", "/openapi.json", "loadChromium", "migrate", "performanceSeed"]) assert.match(source, new RegExp(seam.replaceAll("/", "\\/"), "u"));
});
