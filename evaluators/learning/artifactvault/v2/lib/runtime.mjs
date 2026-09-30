import assert from "node:assert/strict";
import { access,mkdir,writeFile } from "node:fs/promises";
import { dirname,resolve } from "node:path";

import { createFixtureFactory,performanceContract } from "./fixtures.mjs";

const sharedUrl=process.env.FRONTAL_V2_SHARED_RUNTIME_URL??new URL("../../../../../src/task-evaluator-v2/runtime.mjs",import.meta.url).href;
const shared=await import(sharedUrl);
const BARRIER_KEYS=["schemaVersion","processRole","point","workId","aggregateId","attempt","leaseTokenHash"];

function identity(_adapter,{json}){return json;}
function noAdapter(value){if(value!=null)throw new Error("ArtifactVault publishes no evaluator compatibility adapter");}
export function isArtifactVaultBarrier(value){
  if(!value||typeof value!=="object"||Array.isArray(value)||JSON.stringify(Object.keys(value).sort())!==JSON.stringify([...BARRIER_KEYS].sort()))return false;
  const seam=value.processRole==="worker"&&["worker.claimed","worker.effect-complete","worker.before-commit"].includes(value.point)||value.processRole==="dispatcher"&&value.point==="dispatcher.response-received";
  return value.schemaVersion===1&&seam&&typeof value.workId==="string"&&typeof value.aggregateId==="string"&&Number.isSafeInteger(value.attempt)&&value.attempt>=1&&/^[0-9a-f]{64}$/u.test(value.leaseTokenHash);
}

const runtime=shared.createCaseRuntime({taskSlug:"artifactvault",databasePrefix:"av",snapshotPath:"/api/v1/verification-snapshot",createFixtureFactory,adaptCompatibilityResponse:identity,assertCompatibilityAdapter:noAdapter,validateBarrierPayload:isArtifactVaultBarrier});

class ScenarioFailure extends Error{constructor(message,options={}){super(message,{cause:options.cause});this.origin = "candidate"; this.failureCodeSuffix=options.failureCodeSuffix??"ASSERTION_FAILED";this.hardCapIds=options.hardCapIds??[];}}
class Evidence{
  constructor(){this.assertions=[];this.statuses=new Map();this.metrics={};}
  check(label,operation,options={}){try{operation();this.assertions.push({label,status:"passed"});}catch (cause) {shared.assertCandidateError(cause);this.assertions.push({label,status:"failed"});throw new ScenarioFailure(`${label}: ${cause?.message??cause}`,{...options,cause});}}
  finish(){return{assertions:this.assertions,statuses:Object.fromEntries([...this.statuses.entries()].sort()),metrics:this.metrics};}
}

async function decorate(ctx){
  const evidence=new Evidence(),originalRequest=ctx.request,fixtureKey=ctx.key;let keys=0,bundles=0;
  ctx.evidence=evidence;ctx.performanceContract=performanceContract();ctx.key=(label)=>fixtureKey(`${label}-${keys++}`);
  ctx.assert=(label,operation,options)=>evidence.check(label,operation,options);ctx.equal=(label,actual,expected,options)=>evidence.check(label,()=>assert.deepEqual(actual,expected),options);ctx.ok=(label,value,message,options)=>evidence.check(label,()=>assert.ok(value,message),options);ctx.metric=(name,value)=>{evidence.metrics[name]=value;};ctx.sleep=(ms)=>new Promise((done)=>setTimeout(done,ms));
  ctx.request=async(baseUrl,path,options={})=>{const response=await originalRequest(baseUrl,path,options);if(options.record!==false)evidence.statuses.set(String(response.status),(evidence.statuses.get(String(response.status))??0)+1);return response;};
  ctx.seedBundle=async(bundle,options={})=>{
    const root=ctx.tempPath(`seed-bundle-${String(++bundles).padStart(3,"0")}`),assets=resolve(root,"assets"),path=resolve(root,"seed.json");await mkdir(assets,{recursive:true});
    for(const[name,body]of Object.entries(bundle.assets??{})){const target=resolve(assets,name);if(!target.startsWith(`${assets}/`))throw new Error("fixture asset escapes assets directory");await mkdir(dirname(target),{recursive:true});await writeFile(target,body);}
    await writeFile(path,JSON.stringify(bundle.seed));const result=await ctx.seedFile(path,{workspace:options.workspace,timeoutMs:options.timeoutMs??1_800_000,allowFailure:true,contractExpectation:options.contractExpectation});
    if(options.expectFailure)ctx.ok("invalid seed exits nonzero",result.exitCode!==0,undefined,{failureCodeSuffix:"SEED_ACCEPTED_INVALID",hardCapIds:["MIGRATION_CORRECTNESS"]});else ctx.equal("valid seed exits zero",result.exitCode,0,{failureCodeSuffix:"SEED_FAILED",hardCapIds:["MIGRATION_CORRECTNESS"]});return{root,assets,path,result};
  };
  ctx.createUpload=(url,body,options={})=>ctx.mutate(url,"/api/v1/upload-sessions",options.key??ctx.key("upload-create"),body,{timeoutMs:options.timeoutMs});
  ctx.putChunk=(url,uploadId,bytes,start,total,options={})=>ctx.request(url,`/api/v1/upload-sessions/${uploadId}/chunks`,{method:"PUT",raw:bytes,timeoutMs:options.timeoutMs??120_000,headers:{"idempotency-key":options.key??ctx.key(`chunk-${start}`),"content-type":"application/octet-stream","content-range":`bytes ${start}-${start+bytes.length-1}/${total}`,...options.headers}});
  ctx.completeUpload=(url,uploadId,options={})=>ctx.mutate(url,`/api/v1/upload-sessions/${uploadId}/complete`,options.key??ctx.key("complete"),{}, {timeoutMs:options.timeoutMs});
  ctx.getUpload=(url,uploadId,options={})=>ctx.request(url,`/api/v1/upload-sessions/${uploadId}`,options);
  ctx.getVersion=(url,packageName,version,options={})=>ctx.request(url,`/api/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}`,options);
  ctx.getContent=(url,packageName,version,options={})=>ctx.request(url,`/api/v1/packages/${encodeURIComponent(packageName)}/versions/${encodeURIComponent(version)}/content`,{...options,binary:true});
  ctx.createRelease=(url,body,options={})=>ctx.mutate(url,"/api/v1/releases",options.key??ctx.key("release-create"),body,{timeoutMs:options.timeoutMs});
  ctx.getRelease=(url,packageName,version,options={})=>ctx.request(url,`/api/v1/packages/${encodeURIComponent(packageName)}/releases/${encodeURIComponent(version)}`,options);
  ctx.publishRelease=(url,releaseId,options={})=>ctx.mutate(url,`/api/v1/releases/${releaseId}/publish`,options.key??ctx.key("release-publish"),{}, {timeoutMs:options.timeoutMs});
  ctx.retryRelease=(url,releaseId,platform,options={})=>ctx.mutate(url,`/api/v1/releases/${releaseId}/artifacts/${encodeURIComponent(platform)}/retry`,options.key??ctx.key("release-retry"),{}, {timeoutMs:options.timeoutMs});
  ctx.getReleaseContent=(url,packageName,version,platform,options={})=>ctx.request(url,`/api/v1/packages/${encodeURIComponent(packageName)}/releases/${encodeURIComponent(version)}/artifacts/${encodeURIComponent(platform)}/content`,{...options,binary:true});
  ctx.readOpenApi=async(url)=>{const response=await ctx.request(url,"/openapi.json");ctx.equal("OpenAPI status",response.status,200);return response.json;};
  ctx.workerBarrier=(point,predicate=()=>true)=>ctx.barrier({hold:(payload)=>payload.processRole==="worker"&&payload.point===point&&predicate(payload)});ctx.dispatcherBarrier=(predicate=()=>true)=>ctx.barrier({hold:(payload)=>payload.processRole==="dispatcher"&&payload.point==="dispatcher.response-received"&&predicate(payload)});
  ctx.startWorkerAtBarrier=(barrier,options={})=>ctx.startWorker({...options,env:{TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:barrier.token,...options.env}});ctx.startDispatcherAtBarrier=(receiver,barrier,options={})=>ctx.startDispatcher({...options,webhookUrl:receiver.url,env:{TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:barrier.token,...options.env}});
  ctx.withPage=(api,viewport,operation)=>withPage(ctx,api,viewport,operation);return ctx;
}

export async function createCaseContext(options){return decorate(await runtime.createCaseContext(options));}
export async function withCaseContext(options,operation){return runtime.withCaseContext(options,async(raw)=>{const ctx=await decorate(raw);if(!["MIGRATE-01","MIGRATE-02","MIGRATE-04"].includes(ctx.caseId))await ctx.migrate();const outcome=await operation(ctx),unexpected=[...ctx.evidence.statuses].filter(([status])=>Number(status)>=500).reduce((sum,[,count])=>sum+count,0);ctx.equal("no unexpected HTTP 5xx",unexpected,0);return{...outcome,evidence:{...ctx.evidence.finish(),caseEvidence:outcome?.evidence??[]}};});}

async function chromiumExecutable(){for(const candidate of[process.env.CHROMIUM_PATH,"/usr/bin/chromium","/usr/bin/chromium-browser","/Applications/Google Chrome.app/Contents/MacOS/Google Chrome","/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)){try{await access(candidate);return candidate;}catch{}}throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE","EVALUATOR_CHROMIUM_UNAVAILABLE");}
async function withPage(ctx,api,viewport,operation){let chromium;try{({chromium}=await import("playwright-core"));}catch(cause){throw new shared.EvaluationInfrastructureError("EVALUATOR_PLAYWRIGHT_UNAVAILABLE","EVALUATOR_PLAYWRIGHT_UNAVAILABLE",{cause});}const browser=await chromium.launch({executablePath:await chromiumExecutable(),headless:true,args:["--no-sandbox","--disable-dev-shm-usage"]}),browserContext=await browser.newContext({viewport,baseURL:api.baseUrl}),page=await browserContext.newPage(),errors=[];page.on("pageerror",(error)=>errors.push(error.message));page.on("console",(message)=>{if(message.type()==="error"&&!/Failed to load resource.*4\d\d/iu.test(message.text()))errors.push(message.text());});try{await operation(page);ctx.equal("browser console clean",errors,[]);ctx.equal("browser no horizontal overflow",await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);}finally{await browserContext.close();await browser.close();}}

export const{CandidateResponseError,CommandError,EvaluationInfrastructureError,freePort,runCommand}=shared;
