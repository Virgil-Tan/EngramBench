import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { computeSourceFixtureCommit } from "../../../scripts/materialize-source-fixture.mjs";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const pattern = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");

test("GeoPulse is a self-contained benchmark package", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([
    json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json"),
  ]);
  assert.equal(task.id, "geopulse");
  assert.match(task.fixture.commit, /^[0-9a-f]{40}$/u);
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 21);
  assert.equal(dialogue.minimumTurns, 22);
  assert.equal(dialogue.hardMaxTurns, 60);
  assert.ok(dialogue.scenes.every((scene) => !("maxVisits" in scene)));
  assert.equal(dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager").length, 1);
  assert.equal(task.hiddenTests.length, 13);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), Array.from({ length: 13 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), ["ordered-location-ingest", "boundary-jitter-convergence", "bulk-spatial-query"]);
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) => assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
  assert.equal(task.fixture.commit, await computeSourceFixtureCommit(new URL("../workspace", import.meta.url).pathname, task.id));
});

test("GeoPulse V1 and Manager contracts are bounded without pre-disclosure", async () => {
  const [readme, plan, manager, adapter, contract, dialogue] = await Promise.all([
    read("workspace/README.md"), read("evaluator/E2E_TEST_PLAN.zh-CN.md"),
    read("orchestration/manager-prompt.zh-CN.md"), read("evaluator/adapter.mjs"),
    json("evaluator/contract.json"), json("dialogue-script.json"),
  ]);
  assert.match(readme, /boundary-jitter-convergence/u);
  assert.doesNotMatch(readme, /RegionBundle|region-bundles|BUNDLE_REEVALUATION|bundle publication/u);
  assert.deepEqual(contract.publicPaths, [...contract.v1PublicPaths, ...contract.managerPublicPaths]);
  assert.equal(new Set(contract.publicPaths).size, contract.publicPaths.length);
  for (const path of contract.v1PublicPaths) assert.match(readme, pattern(path));
  for (const path of contract.managerPublicPaths) {
    assert.doesNotMatch(readme, pattern(path));
    assert.match(manager, pattern(path));
  }
  assert.match(plan, /H-13/u);
  assert.match(manager, /RegionBundleRevision.*bundleRevisionId/su);
  assert.match(manager, /BUNDLE_REVISION_CONFLICT/u);
  const scene = dialogue.scenes.find(({ speakerRole }) => speakerRole === "manager");
  assert.deepEqual(scene.revealsRequirementIds, scene.requirementIds);
  for (const value of [
    "response {bundle:RegionBundle}",
    "response {bundle:RegionBundle,revision:RegionBundleRevision}",
    "response {bundle:RegionBundle,revisions:[RegionBundleRevision,...]}",
    "409 BUNDLE_REVISION_CONFLICT",
    "跨租户、空成员、未知 RegionVersion 或重叠有效时间",
    "region_bundle.published",
    "region_bundle.rolled_back",
  ]) {
    assert.match(manager, pattern(value));
    assert.match(scene.fixedMessage, pattern(value));
  }
  const managerIndex = dialogue.scenes.indexOf(scene);
  assert.doesNotMatch(JSON.stringify(dialogue.scenes.slice(0, managerIndex)), /RegionBundle|region-bundles|bundleRevisionId|BUNDLE_REEVALUATION|region_bundle/u);
  assert.match(adapter, /bulk-spatial-query/u);
});

test("GeoPulse evaluator loads from its isolated task bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "geopulse-bundle-"));
  try {
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const adapter = (await import(pathToFileURL(join(root, "task", "adapter.mjs")))).default;
    assert.deepEqual(adapter.performanceScenarioIds, ["ordered-location-ingest", "boundary-jitter-convergence", "bulk-spatial-query"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
