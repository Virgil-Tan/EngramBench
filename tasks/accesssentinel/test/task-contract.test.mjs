import test from "node:test";
import assert from "node:assert/strict";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertPortableSourceFixture } from "../../../test/support/source-fixture-validation.mjs";

const base = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, base), "utf8");
const json = async (path) => JSON.parse(await read(path));
const ids = (count) => Array.from({ length: count }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`);

test("AccessSentinel is a complete independent transfer task", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([
    json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json"),
  ]);
  assert.equal(task.id, "accesssentinel");
  assert.equal(task.phase, "transfer");
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 30);
  assert.equal(dialogue.minimumTurns, 36);
  assert.equal(dialogue.hardMaxTurns, 100);
  assert.ok(dialogue.scenes.every((scene) => !Object.hasOwn(scene, "maxVisits")));
  const managerScenes = dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager");
  assert.equal(managerScenes.length, 1);
  assert.equal(managerScenes[0].id, "T22");
  assert.deepEqual(managerScenes[0].revealsRequirementIds, ["manager-break-glass"]);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), ids(26));
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) => (
    assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"
  )));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), [
    "session-refresh-storm", "access-decision-ingest", "policy-evaluation-hotset",
    "location-replay-convergence", "grant-revocation-fanout", "audit-chain-append",
    "outbox-ack-recovery", "revocation-fence-recovery",
  ]);
  assert.equal(contract.snapshot.managerResources.length, 4);
  assert.deepEqual(contract.workKinds.manager, ["BREAK_GLASS_EXPIRE", "REGION_QUARANTINE", "RETROSPECTIVE_DUE"]);

  await assertPortableSourceFixture({
    task,
    workspace: new URL("../workspace/", import.meta.url),
    heading: "AccessSentinel",
  });
});

test("AccessSentinel publishes every scored V1 behavior but not the Manager change", async () => {
  const [readme, agents, plan, manager, dialogue, checklist, contract] = await Promise.all([
    read("workspace/README.md"), read("workspace/AGENTS.md"), read("evaluator/E2E_TEST_PLAN.zh-CN.md"),
    read("orchestration/manager-prompt.zh-CN.md"), json("dialogue-script.json"), json("checklist.json"),
    json("evaluator/contract.json"),
  ]);
  for (const value of [
    "PolicyBundle", "RiskDecision", "AccessGrant", "LocationObservation", "AuditEntry",
    "/api/v1/access-requests", "/api/v1/access-requests:batch", "/api/v1/grants/:grantId/revoke",
    "session-refresh-storm", "revocation-fence-recovery", "test:perf",
  ]) assert.ok(readme.includes(value), `README omits ${value}`);
  assert.match(plan, /H-26/u);
  assert.match(plan, /8 条专属压力场景/u);
  assert.match(agents, /PostgreSQL/u);
  for (const value of ["BreakGlassSession", "RegionalQuarantine", "RetrospectiveReview", "/api/v1/break-glass-sessions"]) {
    assert.ok(manager.includes(value));
    assert.ok(dialogue.scenes[21].fixedMessage.includes(value));
    assert.doesNotMatch(`${readme}\n${agents}\n${JSON.stringify(dialogue.scenes.slice(0, 21))}`, new RegExp(value, "u"));
  }
  const fixedManagerMessage = manager.match(/<!-- FIXED_MANAGER_MESSAGE_START -->\r?\n([\s\S]*?)\r?\n<!-- FIXED_MANAGER_MESSAGE_END -->/u)?.[1];
  assert.equal(fixedManagerMessage, dialogue.scenes[21].fixedMessage);
  assert.ok(contract.publicPaths.includes("/api/v1/break-glass-sessions/:breakGlassSessionId/check"));
  const requirementIds = new Set(checklist.items.map(({ id }) => id));
  for (const scene of dialogue.scenes) {
    for (const id of [...(scene.requirementIds ?? []), ...(scene.revealsRequirementIds ?? [])]) {
      assert.ok(requirementIds.has(id), `${scene.id} references unknown requirement ${id}`);
    }
  }
});

test("AccessSentinel evaluator is self-contained beside the shared framework", async () => {
  const root = await mkdtemp(join(tmpdir(), "accesssentinel-bundle-"));
  try {
    await cp(new URL("evaluator/", base), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const adapter = (await import(pathToFileURL(join(root, "task", "adapter.mjs")))).default;
    assert.equal(adapter.performanceScenarioIds.length, 8);
    for (const id of [...ids(12).slice(2), ...ids(26).slice(13)]) {
      assert.equal(typeof adapter.cases[id], "function", `${id} is not executable`);
    }
    assert.ok(adapter.taskSpecificCaseIds.includes("H-26"));
    const source = await read("evaluator/adapter.mjs");
    for (const scenarioId of adapter.performanceScenarioIds) {
      assert.ok(source.includes(`scenarioId: "${scenarioId}"`), `${scenarioId} has no exact metric result`);
    }
    assert.match(source, /ctx\.resetDatabase\(\)/u);
    assert.match(source, /function stableSnapshot\(/u);
    assert.match(source, /async function finishPerformanceScenario\(/u);
    assert.equal(source.match(/return finishPerformanceScenario\(/gu)?.length, 8);
    assert.match(source, /postLoadInvariants/u);
    assert.match(source, /ctx\.processes\.filter\(\(\{ child \}\) => child\.exitCode === null\)/u);
    assert.match(source, /barrier\.ledger\.length >= 4/u);
    assert.match(source, /no Event was actually retried/u);
    assert.match(source, /continuous post-commit grant monitor/u);
    assert.doesNotMatch(source, /topology:\s*\{\s*apiProcesses:\s*2,\s*workers:\s*8,\s*dispatchers:\s*4\s*\}/u);
    assert.doesNotMatch(source, /ctx\.snapshot\(\(await ctx\.startApi\(\)\)\.baseUrl\)/u);
    for (const path of ["run.mjs", "contract.json", "fixtures/seed.json"]) await access(new URL(`evaluator/${path}`, base));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
