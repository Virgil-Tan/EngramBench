import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));

test("BillForge is a self-contained benchmark package", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([
    json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json"),
  ]);
  assert.equal(task.id, "billforge");
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 22);
  assert.equal(task.hiddenTests.length, 13);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), Array.from({ length: 13 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), ["invoice-generation", "payment-reconcile", "settlement-recovery"]);
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) => assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
});

test("BillForge public and hidden contracts share the same bounded domain", async () => {
  const [readme, plan, manager, adapter] = await Promise.all([
    read("workspace/README.md"), read("evaluator/E2E_TEST_PLAN.zh-CN.md"), read("orchestration/manager-prompt.zh-CN.md"), read("evaluator/adapter.mjs"),
  ]);
  assert.match(readme, /PaymentIntent/);
  assert.match(readme, /double-entry/);
  assert.match(plan, /H-13/);
  assert.match(manager, /Chargeback/);
  assert.match(adapter, /settlement-recovery/);
});

test("BillForge evaluator loads from its isolated task bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "billforge-bundle-"));
  try {
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const adapter = (await import(pathToFileURL(join(root, "task", "adapter.mjs")))).default;
    assert.deepEqual(adapter.performanceScenarioIds, ["invoice-generation", "payment-reconcile", "settlement-recovery"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
