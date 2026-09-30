import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path) => JSON.parse(await read(path));
const allowedSpeakerRoles = new Set(["junior_engineer", "delivery_lead", "user", "manager"]);
const managerPaths = [
  "/api/v1/policy-recall-runs",
  "/api/v1/policy-recall-runs/:runId",
  "/api/v1/policy-recall-runs/:runId/cancel",
];

test("ModerationFlow is a self-contained benchmark package", async () => {
  const [task, checklist, dialogue, contract] = await Promise.all([json("task.json"),json("checklist.json"),json("dialogue-script.json"),json("evaluator/contract.json")]);
  assert.equal(task.id,"moderationflow");
  assert.equal(checklist.items.reduce((sum,item)=>sum+item.weight,0),100);
  assert.equal(dialogue.scenes.length,24);
  assert.equal(dialogue.minimumTurns,22);
  assert.equal(dialogue.hardMaxTurns,80);
  assert.equal(dialogue.scenes.filter(({speakerRole})=>speakerRole==="manager").length,1);
  assert.ok(dialogue.scenes.every(({speakerRole})=>allowedSpeakerRoles.has(speakerRole)));
  const managerScene=dialogue.scenes.find(({speakerRole})=>speakerRole==="manager");
  assert.deepEqual(managerScene.revealsRequirementIds,managerScene.requirementIds);
  assert.deepEqual(task.hiddenTests.map(({id})=>id),Array.from({length:13},(_,index)=>`H-${String(index+1).padStart(2,"0")}`));
  assert.deepEqual(contract.perfScenarios.map(({id})=>id),["moderation-ingest","evidence-appeal-contention","policy-boundary-recovery"]);
  assert.ok(task.hiddenTests.every(({assetsPath,frameworkAssetsPath})=>assetsPath==="evaluator"&&frameworkAssetsPath==="../../hidden/hard-fullstack"));
});

test("ModerationFlow public and hidden contracts share one bounded domain", async () => {
  const [readme,plan,manager,adapter,contract,dialogue]=await Promise.all([
    read("workspace/README.md"),read("evaluator/E2E_TEST_PLAN.zh-CN.md"),
    read("orchestration/manager-prompt.zh-CN.md"),read("evaluator/adapter.mjs"),
    json("evaluator/contract.json"),json("dialogue-script.json"),
  ]);
  assert.match(readme,/EvidenceVersion/); assert.match(readme,/Appeal/); assert.match(plan,/H-13/);
  assert.match(manager,/PolicyRecallRun/); assert.match(adapter,/policy-boundary-recovery/);
  const managerMessage=dialogue.scenes.find(({speakerRole})=>speakerRole==="manager")?.fixedMessage??"";
  for(const path of managerPaths){
    assert.ok(contract.publicPaths.includes(path),`contract is missing ${path}`);
    assert.ok(manager.includes(path),`Manager prompt is missing ${path}`);
    assert.ok(managerMessage.includes(path),`Manager dialogue is missing ${path}`);
  }
  for(const marker of ["PolicyRecallRun =","Reconsideration =","reconsiderations:[Reconsideration]","POLICY_RECALL_RUN_TERMINAL"]){
    assert.ok(manager.includes(marker),`Manager prompt is missing ${marker}`);
    assert.ok(managerMessage.includes(marker),`Manager dialogue is missing ${marker}`);
  }
  assert.match(manager,/-> 201 PolicyRecallRun/u);
  assert.ok(managerMessage.includes("返回 201 PolicyRecallRun"));
  const managerIndex=dialogue.scenes.findIndex(({speakerRole})=>speakerRole==="manager");
  const preManager=dialogue.scenes.slice(0,managerIndex).map(({safeMessage,fixedMessage})=>safeMessage??fixedMessage??"").join("\n");
  assert.doesNotMatch(`${readme}\n${preManager}`,/PolicyRecallRun|Reconsideration|POLICY_RECALL|\/api\/v1\/policy-recall-runs|policy-recall-audit-recovery/u);
  assert.match(adapter,/async afterPrepare/u);
  assert.match(adapter,/async migrationVerify/u);
  assert.match(adapter,/Array\.from\(\{ length: 4 \}, \(\) => ctx\.startApi\(\)\)/u);
  assert.doesNotMatch(adapter,/\b(?:caseIds)\.includes\(/u);
});

test("ModerationFlow evaluator loads from its isolated task bundle", async () => {
  const root=await mkdtemp(join(tmpdir(),"moderationflow-bundle-"));
  try {
    await cp(new URL("../evaluator/",import.meta.url),join(root,"task"),{recursive:true});
    await cp(new URL("../../../hidden/hard-fullstack/",import.meta.url),join(root,"framework"),{recursive:true});
    const adapter=(await import(pathToFileURL(join(root,"task","adapter.mjs")))).default;
    assert.deepEqual(adapter.performanceScenarioIds,["moderation-ingest","evidence-appeal-contention","policy-boundary-recovery"]);
  } finally { await rm(root,{recursive:true,force:true}); }
});
