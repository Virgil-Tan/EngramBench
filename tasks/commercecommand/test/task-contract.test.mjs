import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertPortableSourceFixture } from "../../../test/support/source-fixture-validation.mjs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));

test("CommerceCommand is the 30-case, ten-scenario maximum transfer package", async () => {
  const [taskDefinition, checklist, dialogue, contract] = await Promise.all([
    json("task.json"),
    json("checklist.json"),
    json("dialogue-script.json"),
    json("evaluator/contract.json"),
  ]);
  assert.equal(taskDefinition.id, "commercecommand");
  assert.equal(taskDefinition.phase, "transfer");
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 32);
  assert.equal(dialogue.minimumTurns, 40);
  assert.equal(dialogue.hardMaxTurns, 120);
  assert.ok(dialogue.scenes.every((scene) => !("maxVisits" in scene)));
  assert.equal(dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager").length, 1);
  const manager = dialogue.scenes.find(({ speakerRole }) => speakerRole === "manager");
  assert.deepEqual(manager.revealsRequirementIds, manager.requirementIds);
  assert.equal(taskDefinition.hiddenTests.length, 30);
  assert.deepEqual(taskDefinition.hiddenTests.map(({ id }) => id),
    Array.from({ length: 30 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`));
  assert.equal(taskDefinition.hiddenTests.find(({ id }) => id === "H-12").timeoutMs, 3_600_000);
  assert.ok(taskDefinition.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) =>
    assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), [
    "quote-read-mix", "checkout-contention", "inventory-hotspot", "payment-unknown-reconcile",
    "fulfillment-drain", "notification-unknown-ack", "entitlement-revocation-storm",
    "seller-settlement-close", "refund-dispute-race", "full-catastrophe-recovery",
  ]);
  for (const id of taskDefinition.hiddenTests.map(({ id }) => id)) {
    assert.ok(checklist.items.some(({ testGates = [] }) => testGates.includes(id)), `${id} is not scored`);
  }
});

test("CommerceCommand publishes every scored behavior without leaking the Manager change early", async () => {
  const [readme, persona, managerDocument, plan, adapter, dialogue, contract] = await Promise.all([
    read("workspace/README.md"),
    read("persona.json"),
    read("orchestration/manager-prompt.zh-CN.md"),
    read("evaluator/E2E_TEST_PLAN.zh-CN.md"),
    read("evaluator/adapter.mjs"),
    json("dialogue-script.json"),
    json("evaluator/contract.json"),
  ]);
  for (const value of [
    "OfferVersion", "UNKNOWN", "InventoryHold", "LedgerEntry", "QUOTE_EXPIRY",
    "payment-unknown-reconcile", "entitlement-revocation-storm", "BENCH_PERF_SCALE=1",
  ]) assert.match(readme, new RegExp(value, "u"));
  for (const value of [
    "SellerAllocation", "SellerSettlement", "CommerceDispute", "SettlementAdjustment",
    "seller-settlement-close", "refund-dispute-race", "full-catastrophe-recovery",
    "50,000", "20,000", "300 秒",
  ]) assert.match(managerDocument, new RegExp(value, "u"));
  for (const id of Array.from({ length: 30 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`)) {
    assert.match(plan, new RegExp(id, "u"));
  }
  for (const route of contract.publicPaths) assert.ok(route.startsWith("/api/v1/"));
  assert.match(adapter, /standardAdapter/u);
  assert.match(adapter, /SIGKILL/u);
  assert.match(adapter, /measuredLoad/u);
  assert.doesNotMatch(adapter, /from\s+["'][^"']*(?:src|server|prisma|drizzle)/iu);

  const managerSceneIndex = dialogue.scenes.findIndex(({ speakerRole }) => speakerRole === "manager");
  const beforeManager = JSON.stringify(dialogue.scenes.slice(0, managerSceneIndex));
  assert.doesNotMatch(`${readme}\n${persona}\n${beforeManager}`, /marketplace|ten (?:performance|sustained)|十条|SellerAllocation|SellerSettlement|CommerceDispute|SettlementAdjustment|seller-settlement-close|refund-dispute-race/iu);
  const fixedMessage = dialogue.scenes[managerSceneIndex].fixedMessage;
  for (const value of ["ALLOCATION_NOT_CONSERVED", "RESERVE_EXCEEDS_CAPTURE", "SETTLEMENT_CLOSED", "p95<=750ms"]) {
    assert.ok(fixedMessage.includes(value));
  }
});

test("CommerceCommand fixture commit is exact and contains plaintext public sources", async () => {
  const taskDefinition = await json("task.json");
  await assertPortableSourceFixture({
    task: taskDefinition,
    workspace: new URL("../workspace/", import.meta.url),
    heading: "CommerceCommand",
  });
});

test("CommerceCommand evaluator loads from only its task bundle and shared framework", async () => {
  const root = await mkdtemp(join(tmpdir(), "commercecommand-bundle-"));
  try {
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const adapter = (await import(pathToFileURL(join(root, "task", "adapter.mjs")))).default;
    assert.equal(adapter.performanceScenarioIds.length, 10);
    assert.deepEqual(adapter.taskSpecificCaseIds, [
      "H-03", "H-04", "H-06", "H-07", "H-09", "H-10", "H-11", "H-12",
      "H-14", "H-15", "H-16", "H-17", "H-18", "H-19", "H-20", "H-21",
      "H-22", "H-23", "H-24", "H-25", "H-26", "H-27", "H-28", "H-29", "H-30",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
