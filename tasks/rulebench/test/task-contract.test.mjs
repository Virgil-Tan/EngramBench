import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { computeSourceFixtureCommit } from "../../../scripts/materialize-source-fixture.mjs";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const pattern = (value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u");

test("RuleBench is a self-contained benchmark package", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([
    json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json"),
  ]);
  assert.equal(task.id, "rulebench");
  assert.match(task.fixture.commit, /^[0-9a-f]{40}$/u);
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 24);
  assert.equal(dialogue.minimumTurns, 22);
  assert.equal(dialogue.hardMaxTurns, 80);
  assert.ok(dialogue.scenes.every((scene) => !("maxVisits" in scene)));
  assert.equal(dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager").length, 1);
  assert.equal(task.hiddenTests.length, 13);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), Array.from({ length: 13 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), ["evaluation-throughput", "deep-short-circuit", "comparison-recovery"]);
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) => assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
  assert.equal(task.fixture.commit, await computeSourceFixtureCommit(new URL("../workspace", import.meta.url).pathname, task.id));
});

test("RuleBench V1 and Manager contracts are bounded without pre-disclosure", async () => {
  const [readme, plan, manager, adapter, contract, dialogue] = await Promise.all([
    read("workspace/README.md"), read("evaluator/E2E_TEST_PLAN.zh-CN.md"),
    read("orchestration/manager-prompt.zh-CN.md"), read("evaluator/adapter.mjs"),
    json("evaluator/contract.json"), json("dialogue-script.json"),
  ]);
  assert.match(readme, /deep-short-circuit/u);
  assert.doesNotMatch(readme, /ComparisonRun|ComparisonResult|comparison-runs|COMPARISON_EXECUTE/u);
  assert.deepEqual(contract.publicPaths, [...contract.v1PublicPaths, ...contract.managerPublicPaths]);
  assert.equal(new Set(contract.publicPaths).size, contract.publicPaths.length);
  for (const path of contract.v1PublicPaths) assert.match(readme, pattern(path));
  for (const path of contract.managerPublicPaths) {
    assert.doesNotMatch(readme, pattern(path));
    assert.match(manager, pattern(path));
  }
  assert.match(plan, /H-13/u);
  assert.match(manager, /ComparisonResult.*MATCH\|DIFF\|ERROR/su);
  assert.match(manager, /COMPARISON_HAS_ERRORS/u);
  const scene = dialogue.scenes.find(({ speakerRole }) => speakerRole === "manager");
  assert.deepEqual(scene.revealsRequirementIds, scene.requirementIds);
  for (const value of [
    "response {run:ComparisonRun}",
    "response {run:ComparisonRun,ruleSet:RuleSet}",
    "response {run:ComparisonRun,results:[ComparisonResult,...]}",
    "errorCode:string|null",
    "409 COMPARISON_REVISION_CONFLICT",
    "409 COMPARISON_HAS_ERRORS",
    "comparison.started",
    "comparison.completed",
    "comparison.cancelled",
    "comparison.promoted",
  ]) {
    assert.match(manager, pattern(value));
    assert.match(scene.fixedMessage, pattern(value));
  }
  const managerIndex = dialogue.scenes.indexOf(scene);
  assert.doesNotMatch(JSON.stringify(dialogue.scenes.slice(0, managerIndex)), /ComparisonRun|ComparisonResult|comparison-runs|COMPARISON_EXECUTE|comparison-recovery/u);
  assert.match(adapter, /comparison-recovery/u);
});

test("RuleBench evaluator loads with canonical seed digests from its isolated bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "rulebench-bundle-"));
  try {
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const module = await import(pathToFileURL(join(root, "task", "adapter.mjs")));
    assert.deepEqual(module.default.performanceScenarioIds, ["evaluation-throughput", "deep-short-circuit", "comparison-recovery"]);
    const canonical = '{"a":3,"\ud83d\ude00":2,"\ufffd":1}';
    const unordered = { "\ud83d\ude00": 2, "\ufffd": 1, a: 3 };
    assert.equal(module.canonicalJson(unordered), canonical);
    assert.equal(module.sha256Canonical(unordered), createHash("sha256").update(canonical).digest("hex"));
    const seed = module.ruleBenchSeed();
    for (const version of seed.ruleSetVersions) {
      const versionRules = seed.rules.filter(({ ruleSetVersionId }) => ruleSetVersionId === version.ruleSetVersionId);
      assert.equal(version.rulesDigest, module.sha256Canonical(versionRules));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
