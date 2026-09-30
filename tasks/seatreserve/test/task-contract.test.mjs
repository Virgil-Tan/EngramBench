import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),"utf8");
const json=async(path)=>JSON.parse(await read(path));
const allowedSpeakerRoles=new Set(["junior_engineer","delivery_lead","user","manager"]);
const managerPaths=[
  "/api/v1/waitlist-entries",
  "/api/v1/waitlist-entries/:entryId/cancel",
  "/api/v1/seat-offers/:offerId",
  "/api/v1/seat-offers/:offerId/accept",
  "/api/v1/seat-offers/:offerId/decline",
];

test("SeatReserve is a self-contained benchmark package",async()=>{
  const [task,checklist,dialogue,contract]=await Promise.all([json("task.json"),json("checklist.json"),json("dialogue-script.json"),json("evaluator/contract.json")]);
  assert.equal(task.id,"seatreserve"); assert.equal(checklist.items.reduce((sum,item)=>sum+item.weight,0),100);
  assert.equal(dialogue.scenes.length,25); assert.equal(dialogue.minimumTurns,22); assert.equal(dialogue.hardMaxTurns,80);
  assert.equal(dialogue.scenes.filter(({speakerRole})=>speakerRole==="manager").length,1);
  assert.ok(dialogue.scenes.every(({speakerRole})=>allowedSpeakerRoles.has(speakerRole)));
  const managerScene=dialogue.scenes.find(({speakerRole})=>speakerRole==="manager");
  assert.deepEqual(managerScene.revealsRequirementIds,managerScene.requirementIds);
  assert.deepEqual(task.hiddenTests.map(({id})=>id),Array.from({length:13},(_,index)=>`H-${String(index+1).padStart(2,"0")}`));
  assert.deepEqual(contract.perfScenarios.map(({id})=>id),["seat-hold-ingest","hot-seat-contention","payment-expiry-recovery"]);
  assert.ok(task.hiddenTests.every(({assetsPath,frameworkAssetsPath})=>assetsPath==="evaluator"&&frameworkAssetsPath==="../../hidden/hard-fullstack"));
});

test("SeatReserve public and hidden contracts share one bounded domain",async()=>{
  const [readme,plan,manager,adapter,contract,dialogue]=await Promise.all([
    read("workspace/README.md"),read("evaluator/E2E_TEST_PLAN.zh-CN.md"),
    read("orchestration/manager-prompt.zh-CN.md"),read("evaluator/adapter.mjs"),
    json("evaluator/contract.json"),json("dialogue-script.json"),
  ]);
  assert.match(readme,/PaymentIntent/); assert.match(readme,/SEAT_UNAVAILABLE/); assert.match(plan,/H-13/);
  assert.match(manager,/SeatOffer/); assert.match(adapter,/payment-expiry-recovery/);
  const managerMessage=dialogue.scenes.find(({speakerRole})=>speakerRole==="manager")?.fixedMessage??"";
  for(const path of managerPaths){
    assert.ok(contract.publicPaths.includes(path),`contract is missing ${path}`);
    assert.ok(manager.includes(path),`Manager prompt is missing ${path}`);
    assert.ok(managerMessage.includes(path),`Manager dialogue is missing ${path}`);
  }
  for(const marker of ["WaitlistEntry =","SeatOffer =","offer:SeatOffer,hold:SeatHold","SEAT_OFFER_TERMINAL"]){
    assert.ok(manager.includes(marker),`Manager prompt is missing ${marker}`);
    assert.ok(managerMessage.includes(marker),`Manager dialogue is missing ${marker}`);
  }
  assert.match(manager,/-> 201 WaitlistEntry/u);
  assert.ok(managerMessage.includes("返回 201 WaitlistEntry"));
  const managerIndex=dialogue.scenes.findIndex(({speakerRole})=>speakerRole==="manager");
  const preManager=dialogue.scenes.slice(0,managerIndex).map(({safeMessage,fixedMessage})=>safeMessage??fixedMessage??"").join("\n");
  assert.doesNotMatch(`${readme}\n${preManager}`,/WaitlistEntry|SeatOffer|WAITLIST_MATCH|OFFER_EXPIRY|\/api\/v1\/waitlist-entries|\/api\/v1\/seat-offers/u);
  assert.match(adapter,/async afterPrepare/u);
  assert.match(adapter,/async migrationVerify/u);
  assert.match(adapter,/createServer/u);
  assert.match(adapter,/PROVIDER_BASE_URL/u);
  assert.match(adapter,/Array\.from\(\{ length: 4 \}, \(\) => ctx\.startApi\(\)\)/u);
  assert.doesNotMatch(adapter,/\.find\(\(\{ holdId \}\)/u);
});

test("SeatReserve evaluator loads from its isolated task bundle",async()=>{
  const root=await mkdtemp(join(tmpdir(),"seatreserve-bundle-"));
  try{
    await cp(new URL("../evaluator/",import.meta.url),join(root,"task"),{recursive:true});
    await cp(new URL("../../../hidden/hard-fullstack/",import.meta.url),join(root,"framework"),{recursive:true});
    const loaded=await import(pathToFileURL(join(root,"task","adapter.mjs")));
    const adapter=loaded.default;
    assert.deepEqual(adapter.performanceScenarioIds,["seat-hold-ingest","hot-seat-contention","payment-expiry-recovery"]);
    let workerEnvironment;
    const context={
      servers:[],
      startWorker:async(environment)=>{workerEnvironment=environment; return environment;},
    };
    const provider=await loaded.startProviderDouble(context);
    await context.startWorker({TEST_BARRIER_TOKEN:"test"});
    assert.equal(workerEnvironment.PROVIDER_BASE_URL,provider.baseUrl);
    const request={providerRequestId:"provider-test",amountMinor:5000,currency:"USD",scenario:"TIMEOUT"};
    assert.equal((await fetch(`${provider.baseUrl}/charges`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(request)})).status,504);
    const resolved=await fetch(`${provider.baseUrl}/charges/provider-test`);
    assert.equal(resolved.status,200);
    assert.ok(["SUCCEEDED","FAILED"].includes((await resolved.json()).outcome));
    const conflict=await fetch(`${provider.baseUrl}/charges`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...request,amountMinor:5001})});
    assert.equal(conflict.status,409);
    for(const socket of provider.sockets)socket.destroy();
    await new Promise((resolve)=>provider.server.close(resolve));
  }finally{await rm(root,{recursive:true,force:true});}
});
