import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));

test("EntitlementHub is a self-contained executable benchmark package", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([json("task.json"),json("checklist.json"),json("dialogue-script.json"),json("evaluator/contract.json")]);
  assert.equal(task.id,"entitlementhub");
  assert.equal(checklist.items.reduce((sum,item) => sum+item.weight,0),100);
  assert.equal(dialogue.scenes.length,24); assert.equal(dialogue.minimumTurns,22); assert.equal(dialogue.hardMaxTurns,60);
  const legacyVisitLimit = ["max", "Visits"].join("");
  assert.ok(dialogue.scenes.every((scene) => !(legacyVisitLimit in scene)));
  assert.equal(dialogue.scenes.filter(({ speakerRole }) => speakerRole === "manager").length,1);
  const managerScene=dialogue.scenes.find(({ speakerRole }) => speakerRole === "manager");
  assert.deepEqual(managerScene.revealsRequirementIds,managerScene.requirementIds);
  assert.deepEqual(task.hiddenTests.map(({ id }) => id),Array.from({ length:13 },(_,index) => `H-${String(index+1).padStart(2,"0")}`));
  assert.deepEqual(contract.perfScenarios.map(({ id }) => id),["entitlement-decision-read","upgrade-refund-race","expiry-revocation-recovery"]);
  for (const path of ["/api/v1/entitlement-pools","/api/v1/entitlement-pools/:poolId/assignments","/api/v1/entitlement-pools/:poolId/assignments/:subjectId/revoke"]) assert.ok(contract.publicPaths.includes(path));
  assert.ok(task.hiddenTests.every(({ assetsPath,frameworkAssetsPath }) => assetsPath === "evaluator" && frameworkAssetsPath === "../../hidden/hard-fullstack"));
});

test("EntitlementHub publishes every scored behavior and threshold", async () => {
  const [readme,plan,manager,adapter,dialogue] = await Promise.all([read("workspace/README.md"),read("evaluator/E2E_TEST_PLAN.zh-CN.md"),read("orchestration/manager-prompt.zh-CN.md"),read("evaluator/adapter.mjs"),json("dialogue-script.json")]);
  for (const value of ["entitlement-decision-read","upgrade-refund-race","expiry-revocation-recovery","TRIAL_ALREADY_CONSUMED"]) assert.match(readme,new RegExp(value));
  assert.match(plan,/H-13/); assert.match(manager,/EntitlementPool/); assert.match(manager,/subscriptionKind/); assert.match(adapter,/standardAdapter/);
  assert.match(adapter,/prepareWork/); assert.match(adapter,/migrationVerify/);
  const managerScene=dialogue.scenes.find(({ speakerRole }) => speakerRole === "manager");
  for (const value of ["/api/v1/entitlement-pools/:poolId/assignments/:subjectId/revoke","EntitlementPool =","SeatAssignment =","ORGANIZATION_SUBSCRIPTION_REQUIRED","POOL_CAPACITY_EXCEEDED","POOL_RECONCILE","POOL_REVOKE","aggregateId = poolId"]) {
    assert.ok(manager.includes(value)); assert.ok(managerScene.fixedMessage.includes(value));
  }
  const beforeManager=JSON.stringify(dialogue.scenes.slice(0,dialogue.scenes.indexOf(managerScene)));
  assert.doesNotMatch(`${readme}\n${beforeManager}`,/EntitlementPool|SeatAssignment|entitlement-pools|POOL_RECONCILE|POOL_REVOKE|entitlementPools|seatAssignments|subscriptionKind/u);
});

test("EntitlementHub evaluator loads from the isolated task bundle", async () => {
  const root = await mkdtemp(join(tmpdir(),"entitlementhub-bundle-"));
  try {
    await cp(new URL("../evaluator/",import.meta.url),join(root,"task"),{ recursive:true });
    await cp(new URL("../../../hidden/hard-fullstack/",import.meta.url),join(root,"framework"),{ recursive:true });
    const adapter = (await import(pathToFileURL(join(root,"task","adapter.mjs")))).default;
    assert.deepEqual(adapter.performanceScenarioIds,["entitlement-decision-read","upgrade-refund-race","expiry-revocation-recovery"]);
  } finally { await rm(root,{ recursive:true,force:true }); }
});
