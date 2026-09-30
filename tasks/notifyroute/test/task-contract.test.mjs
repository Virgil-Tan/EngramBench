import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));

test("NotifyRoute is a self-contained benchmark package", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([
    json("task.json"), json("checklist.json"), json("dialogue-script.json"), json("evaluator/contract.json"),
  ]);
  assert.equal(task.id, "notifyroute");
  assert.equal(checklist.items.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.equal(dialogue.scenes.length, 22);
  assert.equal(task.hiddenTests.length, 13);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id), Array.from({ length: 13 }, (_, index) => `H-${String(index + 1).padStart(2, "0")}`));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id), ["notification-ingest", "hot-recipient-quota", "delivery-recovery"]);
  assert.ok(task.hiddenTests.every(({ assetsPath, frameworkAssetsPath }) => assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
});

test("NotifyRoute public and hidden contracts share the same bounded domain", async () => {
  const [readme, plan, manager, adapter] = await Promise.all([
    read("workspace/README.md"), read("evaluator/E2E_TEST_PLAN.zh-CN.md"), read("orchestration/manager-prompt.zh-CN.md"), read("evaluator/adapter.mjs"),
  ]);
  assert.match(readme, /DeliveryAttempt/);
  assert.match(readme, /unsubscribe/iu);
  assert.match(plan, /H-13/);
  assert.match(manager, /Campaign/);
  assert.match(adapter, /delivery-recovery/);
});

test("NotifyRoute evaluator loads from its isolated task bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "notifyroute-bundle-"));
  try {
    await cp(new URL("../evaluator/", import.meta.url), join(root, "task"), { recursive: true });
    await cp(new URL("../../../hidden/hard-fullstack/", import.meta.url), join(root, "framework"), { recursive: true });
    const adapter = (await import(pathToFileURL(join(root, "task", "adapter.mjs")))).default;
    assert.deepEqual(adapter.performanceScenarioIds, ["notification-ingest", "hot-recipient-quota", "delivery-recovery"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
