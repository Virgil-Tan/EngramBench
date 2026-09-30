import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { computeSourceFixtureCommit } from "../../../scripts/materialize-source-fixture.mjs";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const managerPaths = [
  "/api/v1/deployment-waves",
  "/api/v1/deployment-waves/:deploymentWaveId",
  "/api/v1/deployment-waves/:deploymentWaveId/pause",
  "/api/v1/deployment-waves/:deploymentWaveId/resume",
  "/api/v1/deployment-waves/:deploymentWaveId/cancel",
  "/api/v1/deployment-waves/:deploymentWaveId/rollback",
];
const managerOnlyTokens = [
  "DeploymentWave",
  "WaveDevice",
  "DEPLOYMENT_WAVE_ADVANCE",
  "DEPLOYMENT_WAVE_TERMINAL",
  "WAVE_DEVICE_CONFLICT",
  "WAVE_HEALTH_GATE_FAILED",
  "ROLLBACK_UNAVAILABLE",
  "EXPECTED_WAVE_STATE_MISMATCH",
  ...managerPaths,
];
const managerContractTokens = [
  "GET/POST /api/v1/deployment-waves",
  "GET /api/v1/deployment-waves/:deploymentWaveId",
  ...managerPaths.slice(2).map((path) => `POST ${path}`),
  "{tenantId,upgradeCampaignId,requestRef,waves:[{name,deviceIds,minimumObservationSeconds,maximumFailurePercent}]}",
  "DeploymentWave = {deploymentWaveId,tenantId,upgradeCampaignId,requestRef,state:QUEUED|RUNNING|PAUSED|COMPLETED|CANCELLED|ROLLED_BACK,currentWaveOrdinal:int|null,waves:[{ordinal:int,name,state:PENDING|RUNNING|PAUSED|SUCCEEDED|FAILED|ROLLED_BACK,minimumObservationSeconds:int,maximumFailurePercent:int}],createdAt,updatedAt,sequence:int}",
  "WaveDevice = {deploymentWaveId,waveOrdinal:int,deviceId,priorFirmwareReleaseId,targetFirmwareReleaseId,state:PENDING|COMMAND_CREATED|SUCCEEDED|FAILED|ROLLBACK_PENDING|ROLLED_BACK,commandId:null|uuid,rollbackTargetId:null|uuid,confirmedAt:null|timestamp}",
  "{deploymentWave:DeploymentWave,waveDevices:WaveDevice[]}",
  "1..86400",
  "0..100",
  "DEPLOYMENT_WAVE_ADVANCE",
  "aggregateId",
  "deploymentWaveId",
  "DEPLOYMENT_WAVE_TERMINAL",
  "WAVE_DEVICE_CONFLICT",
  "WAVE_HEALTH_GATE_FAILED",
  "ROLLBACK_UNAVAILABLE",
  "EXPECTED_WAVE_STATE_MISMATCH",
  "requestRef=\"legacy:\" + upgradeCampaignId",
  "ordinal=0",
  "name=\"legacy\"",
  "UpgradeTarget",
  "Device",
  "Shadow",
  "Command",
  "Receipt",
  "Event",
  "Work",
  "幂等 replay",
];
const normalized = (value) => value.replace(/\s+/g, " ");

test("EdgeTwin is an independent executable benchmark package", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json")]);
  assert.equal(task.id, "edgetwin");
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 25);
  assert.equal(dialogue.minimumTurns, 22);
  assert.equal(dialogue.hardMaxTurns, 60);
  assert.ok(dialogue.scenes.every((scene) => !("maxVisits" in scene)));
  assert.ok(dialogue.scenes.every(({ speakerRole }) => ["delivery_lead", "manager"].includes(speakerRole)));
  const managerScenes = dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager");
  assert.equal(managerScenes.length, 1);
  assert.deepEqual(managerScenes[0].revealsRequirementIds, managerScenes[0].requirementIds);
  assert.equal(task.hiddenTests.length, 13);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), Array.from({ length: 13 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), ["shadow-patch-ingest", "offline-command-expiry", "fleet-upgrade-recovery"]);
  assert.ok(managerPaths.every((path) => contract.publicPaths.includes(path)));
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) => assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
  assert.equal(task.fixture.commit, await computeSourceFixtureCommit(new URL("../workspace", import.meta.url).pathname, task.id));
});

test("EdgeTwin public, Manager, and hidden contracts share one bounded domain", async () => {
  const [readme, plan, manager, adapter, dialogue] = await Promise.all([read("workspace/README.md"), read("evaluator/E2E_TEST_PLAN.zh-CN.md"), read("orchestration/manager-prompt.zh-CN.md"), read("evaluator/adapter.mjs"), json("dialogue-script.json")]);
  const managerIndex = dialogue.scenes.findIndex(({ speakerRole }) => speakerRole === "manager");
  const fixedMessage = dialogue.scenes[managerIndex].fixedMessage;
  const preManagerScenes = JSON.stringify(dialogue.scenes.slice(0, managerIndex));
  assert.match(readme, /deliveryIdentity/);
  assert.match(readme, /fleet-upgrade-recovery/);
  for (const token of managerOnlyTokens) {
    assert.ok(!readme.includes(token), `${token} leaked into the initial README`);
    assert.ok(!preManagerScenes.includes(token), `${token} leaked before the Manager scene`);
  }
  assert.match(plan, /H-13/);
  for (const text of [manager, fixedMessage].map(normalized)) {
    assert.ok(managerContractTokens.every((token) => text.includes(normalized(token))));
  }
  assert.match(fixedMessage, /本轮只做.*影响分析.*不立即编码/);
  assert.match(adapter, /offline-command-expiry/);
});

test("EdgeTwin evaluator loads from its isolated bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "edgetwin-bundle-"));
  try {
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const adapter = (await import(pathToFileURL(join(root, "task", "adapter.mjs")))).default;
    assert.deepEqual(adapter.performanceScenarioIds, ["shadow-patch-ingest", "offline-command-expiry", "fleet-upgrade-recovery"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
