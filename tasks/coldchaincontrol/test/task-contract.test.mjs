import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { assertPortableSourceFixture } from "../../../test/support/source-fixture-validation.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const caseIds = Array.from({ length: 20 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`);
const performanceIds = [
  "signed-telemetry-ingest",
  "hot-device-ordering",
  "configuration-rollout-recovery",
  "excursion-notification-recovery",
  "recall-quarantine-convergence",
];
const managerPaths = [
  "/api/v1/custody-chains",
  "/api/v1/custody-chains/:chainId/handoffs",
  "/api/v1/custody-handoffs/:handoffId/accept",
  "/api/v1/recalls",
  "/api/v1/recalls/:recallId/quarantine",
];

test("ColdChainControl is a large transfer benchmark with twenty executable gates", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([
    json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json"),
  ]);
  assert.equal(task.id, "coldchaincontrol");
  assert.equal(task.phase, "transfer");
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), caseIds);
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath, command }) =>
    assetsPath === "evaluator"
    && frameworkAssetsPath === "../../hidden/hard-fullstack"
    && command.some((part) => part.startsWith("/hidden/"))), "every hidden gate must execute from its isolated bundle");
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), performanceIds);
  assert.equal(dialogue.scenes.length, 28);
  assert.equal(dialogue.minimumTurns, 28);
  assert.equal(dialogue.hardMaxTurns, 100);
  assert.ok(dialogue.scenes.every((scene) => !("maxVisits" in scene)));
  assert.equal(dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager").length, 1);
  const manager = dialogue.scenes.find(({ speakerRole }) => speakerRole === "manager");
  assert.deepEqual(manager.revealsRequirementIds, manager.requirementIds);
});

test("ColdChainControl keeps its sole Manager change hidden until publication", async () => {
  const [readme, context, managerPrompt, dialogue, contract] = await Promise.all([
    read("workspace/README.md"), read("CONTEXT.md"), read("orchestration/manager-prompt.zh-CN.md"),
    json("dialogue-script.json"), json("evaluator/contract.json"),
  ]);
  const managerIndex = dialogue.scenes.findIndex(({ speakerRole }) => speakerRole === "manager");
  const priorMessages = dialogue.scenes.slice(0, managerIndex)
    .map(({ safeMessage, fixedMessage }) => safeMessage ?? fixedMessage ?? "").join("\n");
  const unpublished = `${readme}\n${priorMessages}`;
  assert.doesNotMatch(unpublished, /custody|handoff|recall|quarantine|RECALL_PROPAGATE|QUARANTINE_ENFORCE|\/api\/v1\/custody-chains|\/api\/v1\/recalls/iu);
  for (const marker of ["CustodyChain", "CustodyHandoff", "RecallOrder", "RECALL_PROPAGATE", "QUARANTINE_ENFORCE"]) {
    assert.match(managerPrompt, new RegExp(marker));
    assert.ok(dialogue.scenes[managerIndex].fixedMessage.includes(marker));
    assert.match(context, new RegExp(marker));
  }
  for (const path of managerPaths) {
    assert.ok(contract.publicPaths.includes(path), `evaluator contract is missing ${path}`);
    assert.ok(managerPrompt.includes(path), `Manager prompt is missing ${path}`);
    assert.ok(dialogue.scenes[managerIndex].fixedMessage.includes(path), `Manager dialogue is missing ${path}`);
  }
  for (const fragment of [
    "body {tenantId,shipmentId,expectedShipmentState,steps:[{fromCarrierId,toCarrierId,siteId,windowStart,windowEnd}]}",
    "返回 201 CustodyChain",
    "body {carrierId,deviceId,keyVersion,attestation,acceptedAt,expectedChainRevision}",
    "返回 200 {chain:CustodyChain,handoff:CustodyHandoff,shipment:ColdShipment}",
    "body {tenantId,productLotCode,reason,issuedAt}",
    "返回 202 RecallOrder",
    "NotificationDelivery",
    "取消只允许 ISSUED 且尚无 APPLIED Action",
    "500 位于非终态 Chain",
    "500 位于 OFFERED Handoff",
  ]) {
    assert.ok(dialogue.scenes[managerIndex].fixedMessage.includes(fragment), `Manager dialogue is missing ${fragment}`);
  }
});

test("ColdChainControl evaluator exposes five performance scenarios and H-14 through H-20", async () => {
  const root = await mkdtemp(join(tmpdir(), "coldchaincontrol-bundle-"));
  try {
    const [source, runSource] = await Promise.all([read("evaluator/adapter.mjs"), read("evaluator/run.mjs")]);
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const loaded = await import(pathToFileURL(join(root, "task", "adapter.mjs")));
    assert.match(source, /standardAdapter/u);
    assert.deepEqual(loaded.default.performanceScenarioIds, performanceIds);
    assert.deepEqual(Object.keys(loaded.default.cases).filter((id) => /^H-(?:1[4-9]|20)$/u.test(id)).sort(), caseIds.slice(13));
    assert.equal(loaded.default.cases["H-08"].name, "notificationUnknownAck");
    assert.equal(loaded.default.cases["coldchain-contract-security"].name, "contractSecurity");
    assert.match(runSource, /H-\(\?:0\[1-9\]\|1\[0-9\]\|20\)/u);
    assert.match(runSource, /five-scenario-performance/u);
    assert.match(runSource, /runContractSecurity/u);
    assert.match(runSource, /assertThresholds/u);
    for (const threshold of ["minimumThroughput", "maximumP95Ms", "maximumRecoveryMs", "maximumQueueP95Ms"]) {
      assert.match(runSource, new RegExp(threshold));
    }
    for (const id of performanceIds) assert.match(source, new RegExp(id));
    for (const marker of [
      "rotation races old-key ingest across two APIs",
      "20k assignments converge through four workers",
      "genuinely late lower sequences",
      "two-policy open and resolved delivery",
      "16 distinct-key accepts",
      "16 competing Recall creations",
      "unknown-ACK dispatcher",
    ]) assert.match(source, new RegExp(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ColdChainControl publishes Site radius and seeds it for projection oracles", async () => {
  const [readme, adapter] = await Promise.all([read("workspace/README.md"), read("evaluator/adapter.mjs")]);
  assert.match(readme, /Site = \{siteId,tenantId,code,name,latitudeE6,longitudeE6,radiusMeters:int,timeZone\}/u);
  assert.match(adapter, /radiusMeters: 1_000/u);
});

test("ColdChainControl workspace is an independent Git fixture at the contracted commit", async () => {
  const task = await json("task.json");
  const workspace = new URL("../workspace/", import.meta.url);
  await assertPortableSourceFixture({ task, workspace, heading: "ColdChainControl" });
  assert.match(await read("workspace/README.md"), /ColdChainControl/);
  assert.match(await read("workspace/AGENTS.md"), /public contract/u);
});
