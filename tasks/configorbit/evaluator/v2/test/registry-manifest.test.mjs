import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import contractMap from "../contract-map.v2.json" with { type:"json" };
import manifest from "../manifest.v2.json" with { type:"json" };
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

test("frozen design headings exactly match manifest ids weights and order",async()=>{const design=await readFile(new URL("../../HIDDEN_TEST_V2_DESIGN.zh-CN.md",import.meta.url),"utf8"),pattern=/^### ([A-Z][A-Z0-9_-]*-\d+)\b[^\n]*?— ([0-9]+(?:\.[0-9]+)?) 分\s*$/gmu,found=[...design.matchAll(pattern)].map((match)=>[match[1],Number(match[2])]);assert.deepEqual(manifest.cases.map(({id,weight})=>[id,weight]),found);assert.equal(found.length,22);assert.equal(found.reduce((sum,[,weight])=>sum+weight,0),100);});
test("registry owns exactly the ConfigOrbit cases",()=>{assert.equal(validateManifest(manifest,contractMap),true);validateCaseRegistry(manifest,CASES);assert.deepEqual(CASES.map(({id})=>id),manifest.cases.map(({id})=>id));for(const item of CASES){assert.equal(item.taskId,"configorbit");assert.equal(item.run.constructor.name,"AsyncFunction");assert.ok(item.run.length>=1);assert.ok(item.fixtureFamily&&item.action&&item.oracle);assert.ok(Array.isArray(item.seams)&&item.seams.length>0);}});
test("contract map and blocked assertions remain task local",()=>{assert.equal(contractMap.taskId,"configorbit");assert.deepEqual(contractMap.cases.map(({caseId})=>caseId),manifest.cases.map(({id})=>id));for(const item of contractMap.cases){assert.match(item.privateFailureCodePrefix,/^CO_[A-Z0-9]+_$/u);assert.ok(item.requirement.source.startsWith("workspace/")||item.requirement.source.startsWith("orchestration/"));}const declared=new Map(manifest.cases.map(({id,blockedAssertions=[]})=>[id,blockedAssertions]));assert.equal([...declared.values()].flat().length,10);for(const assertions of declared.values())for(const item of assertions){assert.equal(item.policy,"fail-closed-diagnostic");assert.ok(manifest.specGaps.some(({id})=>id===item.blockedBy));}});
