import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertPortableSourceFixture } from "../../../test/support/source-fixture-validation.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const hiddenIds = Array.from({ length: 23 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`);
const customIds = hiddenIds.slice(13);
const performanceIds = [
  "multipart-edition-pipeline",
  "license-checkout-uncertainty",
  "fraud-review-release",
  "entitlement-read-storm",
  "royalty-ledger-close",
  "notification-recovery",
];
const managerOnly = [
  "RightsDispute",
  "LicenseHold",
  "RoyaltyAdjustment",
  "/api/v1/rights-disputes",
  "/api/v1/license-holds",
  "/api/v1/royalty-adjustments",
];

test("CreatorRightsExchange is an independent large transfer benchmark", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([
    json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json"),
  ]);
  assert.equal(task.id, "creatorrightsexchange");
  assert.equal(task.phase, "transfer");
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 28);
  assert.equal(dialogue.minimumTurns, 32);
  assert.equal(dialogue.hardMaxTurns, 100);
  assert.ok(dialogue.scenes.every((scene) => !("maxVisits" in scene)));
  assert.equal(dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager").length, 1);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), hiddenIds);
  for (const hidden of task.hiddenTests) {
    assert.deepEqual(hidden.command.slice(0, 4), ["node", `/hidden/${hidden.id}/task/run.mjs`, "--case", hidden.id]);
    assert.equal(hidden.command[4], "--snapshot");
    assert.equal(hidden.command[5], hidden.id === "H-09" ? "V1_TO_FINAL" : "FINAL");
  }
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), performanceIds);
  assert.equal(new Set(contract.publicPaths).size, contract.publicPaths.length);
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) =>
    assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
  const knownGates = new Set(hiddenIds);
  assert.ok(checklist.items.filter(({ category }) => category === "correctness")
    .every(({ testGates }) => testGates.length > 0 && testGates.every((gate) => knownGates.has(gate))));
  await assertPortableSourceFixture({
    task,
    workspace: new URL("../workspace/", import.meta.url),
    heading: "CreatorRightsExchange",
  });
});

test("CreatorRightsExchange keeps the one Manager change secret until its scene", async () => {
  const [readme, dialogue, manager, contract] = await Promise.all([
    read("workspace/README.md"), json("dialogue-script.json"),
    read("orchestration/manager-prompt.zh-CN.md"), json("evaluator/contract.json"),
  ]);
  const managerIndex = dialogue.scenes.findIndex(({ speakerRole }) => speakerRole === "manager");
  assert.ok(managerIndex > 0);
  const prior = JSON.stringify(dialogue.scenes.slice(0, managerIndex));
  for (const token of managerOnly) {
    assert.ok(!readme.includes(token), `${token} leaked into README.md`);
    assert.ok(!prior.includes(token), `${token} leaked before the Manager scene`);
    assert.ok(manager.includes(token), `${token} is absent from the fixed Manager contract`);
    assert.ok(dialogue.scenes[managerIndex].fixedMessage.includes(token), `${token} is absent from the Manager scene`);
  }
  for (const token of [
    "evidenceRefs", "expectedEditionRevision", "EDITION_REVISION_CONFLICT", "LICENSE_HELD",
    "originalPostingId", "targetRoyaltyPeriodId", "targetPeriodStart", "1..20", "512",
  ]) assert.ok(dialogue.scenes[managerIndex].fixedMessage.includes(token), `${token} is absent from the Manager scene`);
  assert.deepEqual(contract.publicPaths, [...contract.v1PublicPaths, ...contract.managerPublicPaths]);
  assert.deepEqual(dialogue.scenes[managerIndex].revealsRequirementIds, dialogue.scenes[managerIndex].requirementIds);
});

test("CreatorRightsExchange evaluator exposes ten deep cases and six exact pressure metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "creator-rights-exchange-bundle-"));
  try {
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const adapter = (await import(pathToFileURL(join(root, "task", "adapter.mjs")))).default;
    assert.deepEqual(adapter.performanceScenarioIds, performanceIds);
    assert.ok(customIds.every((id) => typeof adapter.cases[id] === "function"));
    assert.ok(customIds.every((id) => adapter.taskSpecificCaseIds.includes(id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
