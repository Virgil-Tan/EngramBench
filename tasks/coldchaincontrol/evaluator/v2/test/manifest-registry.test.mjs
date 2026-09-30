import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CASES } from "../cases/index.mjs";
import { validateCaseRegistry } from "../lib/execution.mjs";
import { IDS, validateManifest } from "../lib/scoring.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const json=async(path)=>JSON.parse(await readFile(path,"utf8"));

test("manifest exactly freezes all 51 ColdChainControl design cases",async()=>{
  const manifest=await json(resolve(root,"manifest.v2.json")),contractMap=await json(resolve(root,"contract-map.v2.json")),design=await readFile(resolve(root,"../HIDDEN_TEST_V2_DESIGN.zh-CN.md"),"utf8"),frozen=[...design.matchAll(/^### ([A-E]-\d{2}) (.+)（([0-9.]+) 分）$/gmu)].map((match)=>({id:match[1],title:match[2],weight:Number(match[3])}));
  assert.equal(frozen.length,51);assert.deepEqual(manifest.cases.map(({id,title,weight})=>({id,title,weight})),frozen);assert.deepEqual(manifest.cases.map(({id})=>id),IDS);assert.equal(manifest.cases.reduce((sum,item)=>sum+item.weight,0),100);assert.deepEqual(Object.fromEntries(Object.keys(manifest.dimensions).map((dimension)=>[dimension,manifest.cases.filter((item)=>item.dimension===dimension).reduce((sum,item)=>sum+item.weight,0)])),{A:30,B:25,C:20,D:15,E:10});assert.equal(validateManifest(manifest,contractMap),true);assert.equal(validateCaseRegistry(manifest,CASES),true);
});

test("every implementation is explicitly ColdChainControl-owned async run(ctx)",()=>{
  assert.equal(CASES.length,51);for(const item of CASES){assert.equal(item.taskId,"coldchaincontrol");assert.equal(item.run.constructor.name,"AsyncFunction");assert.equal(item.run.length,1);assert.match(item.fixtureFamily,/^CCC-F-/u);assert.ok(item.action.length>28);assert.ok(item.oracle.length>28);}
});

test("task modules have no legacy/cross-task evaluator imports, placeholders, fake file checks, or invented barrier calls",async()=>{
  for(const directory of ["cases","fixtures","oracles","lib"]){for(const entry of await readdir(resolve(root,directory),{withFileTypes:true})){if(!entry.isFile()||!entry.name.endsWith(".mjs"))continue;const source=await readFile(resolve(root,directory,entry.name),"utf8");assert.doesNotMatch(source,/tasks\/[a-z0-9-]+\/evaluator/iu);assert.doesNotMatch(source,/(?:evaluator\/v1|legacy-evaluator|cross-task)/iu);assert.doesNotMatch(source,/\b(?:TODO|FIXME|placeholder|not implemented)\b/iu);if(directory==="cases"){assert.doesNotMatch(source,/(?:existsSync|accessSync|statSync)\s*\(/u);assert.doesNotMatch(source,/readFile(?:Sync)?\s*\([^)]*workspace/iu);assert.doesNotMatch(source,/\bctx\.barrier\s*\(/u);}}
  }
});

test("all four published SPEC-GAPs remain fail-closed only at declared assertions",async()=>{
  const manifest=await json(resolve(root,"manifest.v2.json")),blocked=Object.fromEntries(manifest.cases.filter((item)=>item.blockedAssertions).map((item)=>[item.id,item.blockedAssertions.map(({id,blockedBy,policy})=>[id,blockedBy,policy])]));
  assert.deepEqual(blocked,{
    "A-04":[["CCC-A04-WIRE-CONTRACT","SPEC-GAP-01","fail-closed-diagnostic"]],"A-07":[["CCC-A07-CURSOR-WIRE","SPEC-GAP-01","fail-closed-diagnostic"]],"A-14":[["CCC-A14-SITE-RADIUS-BOUNDARY","SPEC-GAP-02","fail-closed-diagnostic"]],"A-15":[["CCC-A15-NOTIFICATION-PAYLOAD-WINDOW","SPEC-GAP-03","fail-closed-diagnostic"]],
    "C-02":[["CCC-C02-STALE-OWNER-BEFORE-COMMIT","SPEC-GAP-04","fail-closed-diagnostic"]],"C-03":[["CCC-C03-EFFECT-COMPLETE-BEFORE-COMMIT","SPEC-GAP-04","fail-closed-diagnostic"]],"C-04":[["CCC-C04-OLD-OWNER-BINDING","SPEC-GAP-04","fail-closed-diagnostic"]],"C-05":[["CCC-C05-STALE-EXPIRY-OWNER","SPEC-GAP-04","fail-closed-diagnostic"]],"C-06":[["CCC-C06-STALE-QUARANTINE-OWNER","SPEC-GAP-04","fail-closed-diagnostic"]],"C-07":[["CCC-C07-PRIVATE-PAYLOAD-FIELDS","SPEC-GAP-03","fail-closed-diagnostic"]],"C-08":[["CCC-C08-RATE-WINDOW-ALGORITHM","SPEC-GAP-03","fail-closed-diagnostic"]],"D-01":[["CCC-D01-WIRE-STATUS-WRAPPER","SPEC-GAP-01","fail-closed-diagnostic"]],
    "E-03":[["CCC-E03-STALE-TOKEN-COMPLETION","SPEC-GAP-04","fail-closed-diagnostic"]],"E-06":[["CCC-E06-STALE-COMMIT-BARRIER","SPEC-GAP-04","fail-closed-diagnostic"]],"E-08":[["CCC-E08-STALE-RELEASE-BARRIER","SPEC-GAP-04","fail-closed-diagnostic"]],
  });
});
