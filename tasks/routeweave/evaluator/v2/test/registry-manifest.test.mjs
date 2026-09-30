import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

const root = new URL("../",import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.v2.json",root),"utf8"));
const map = JSON.parse(await readFile(new URL("contract-map.v2.json",root),"utf8"));
const IDS = ["A-01","A-02","A-03","A-04","A-05","B-01","B-02","B-03","B-04","B-05","C-01","C-02","C-03","C-04","D-01","D-02","D-03","D-04","E-01","E-02","E-03","E-04"];

test("RouteWeave freezes the exact 22-Case order and weights",() => {
  assert.doesNotThrow(() => validateManifest(manifest,map));
  assert.doesNotThrow(() => validateCaseRegistry(manifest,CASES));
  assert.deepEqual(CASES.map(({ id }) => id),IDS);
  assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension) => [dimension,manifest.cases.filter((item) => item.dimension === dimension).reduce((sum,item) => sum+item.weight,0)])),{ A:30,B:25,C:20,D:15,E:10 });
});

test("every Case is RouteWeave-owned, executable and explicitly accepts ctx",() => {
  const allowed = new Set(["seed-command","public-http","shipment-scan","piece-scan","worker-process","dispatcher-process","verification-snapshot","openapi","chromium","v1-migration","performance-load"]);
  for (const item of CASES) {
    assert.equal(item.taskId,"routeweave"); assert.equal(typeof item.run,"function"); assert.equal(item.run.length,1,`${item.id} run must explicitly accept ctx`);
    for (const field of ["fixtureFamily","action","oracle"]) assert.ok(item[field].length>=12,`${item.id} lacks ${field}`);
    assert.ok(item.seams.length>0 && item.seams.every((seam) => allowed.has(seam)),`${item.id} lacks public executable seam`);
  }
  assert.deepEqual(map.cases.map(({ caseId }) => caseId),IDS);
});

test("both SPEC-GAPs are explanatory and no Case is blocked",() => {
  assert.deepEqual(manifest.specGaps.map(({ id }) => id),["SPEC-GAP-RW-01","SPEC-GAP-RW-02"]);
  assert.deepEqual(manifest.cases.flatMap(({ blockedAssertions=[] }) => blockedAssertions),[]);
});
