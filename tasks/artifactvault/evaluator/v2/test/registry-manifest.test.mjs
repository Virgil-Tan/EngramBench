import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CASES } from "../cases/index.mjs";
import manifest from "../manifest.v2.json" with { type:"json" };
import contractMap from "../contract-map.v2.json" with { type:"json" };
import { validateCaseRegistry } from "../lib/execution.mjs";
import { validateManifest } from "../lib/scoring.mjs";

test("frozen design headings exactly match manifest ids, weights, and order",async()=>{const design=await readFile(new URL("../../HIDDEN_TEST_V2_DESIGN.zh-CN.md",import.meta.url),"utf8"),pattern=/^### ([A-Z][A-Z0-9_-]*-\d+)\b[^\n]*?— ([0-9]+(?:\.[0-9]+)?) 分\s*$/gmu,found=[...design.matchAll(pattern)].map((match)=>[match[1],Number(match[2])]);assert.deepEqual(manifest.cases.map(({id,weight})=>[id,weight]),found);assert.equal(found.reduce((sum,[,weight])=>sum+weight,0),100);});
test("registry owns exactly the ArtifactVault cases",()=>{assert.equal(validateManifest(manifest,contractMap),true);validateCaseRegistry(manifest,CASES);assert.deepEqual(CASES.map(({id})=>id),manifest.cases.map(({id})=>id));for(const item of CASES){assert.equal(item.taskId,"artifactvault");assert.equal(item.run.constructor.name,"AsyncFunction");assert.ok(item.run.length>=1);assert.ok(item.fixtureFamily&&item.action&&item.oracle);assert.ok(Array.isArray(item.seams));}});
test("contract map is exact and task local",()=>{assert.equal(contractMap.taskId,"artifactvault");assert.deepEqual(contractMap.cases.map(({caseId})=>caseId),manifest.cases.map(({id})=>id));for(const item of contractMap.cases){assert.match(item.privateFailureCodePrefix,/^AV_[A-Z0-9]+_$/u);assert.ok(item.requirement.source.startsWith("workspace/")||item.requirement.source.startsWith("orchestration/"));}});
