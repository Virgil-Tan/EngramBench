import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMissingV1CheckpointOutcome } from "../../../../../src/task-evaluator-v2/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),manifest=JSON.parse(await readFile(resolve(root,"manifest.v2.json"),"utf8")),contractMap=JSON.parse(await readFile(resolve(root,"contract-map.v2.json"),"utf8")),passedCases=()=>manifest.cases.map((item)=>({id:item.id,status:"passed",durationMs:1,evidenceDigest:"a".repeat(64)}));

test("all 51 frozen cases score exact 100 and dimension totals",()=>{const result=scoreEvaluation(manifest,contractMap,{cases:passedCases()});assert.equal(result.score,100);assert.equal(result.rawScore,100);assert.equal(result.verdict,"accepted");assert.deepEqual(result.dimensions,{A:30,B:25,C:20,D:15,E:10});});

test("unpublished barrier assertion is fail-closed diagnostic",()=>{const cases=passedCases(),item=cases.find((value)=>value.id==="E-03");item.status="diagnostic";item.diagnostics=[{assertionId:"CCC-E03-STALE-TOKEN-COMPLETION",status:"blocked",blockedBy:"SPEC-GAP-04",policy:"fail-closed-diagnostic"}];const result=scoreEvaluation(manifest,contractMap,{cases});assert.equal(result.verdict,"diagnostic");assert.equal(result.formalEligible,false);assert.equal(result.blockedWeight,1);assert.equal(result.maxAchievable,99);});

test("candidate projection failure applies the frozen hard cap",()=>{const cases=passedCases(),failed=cases.find((item)=>item.id==="B-05");Object.assign(failed,{status:"failed",privateFailureCode:"CCC_B_05_ASSERTION_FAILED",hardCapIds:["PROJECTION_AUTHORITY"]});const result=scoreEvaluation(manifest,contractMap,{cases});assert.equal(result.score,35);assert.equal(result.verdict,"rejected");assert.deepEqual(result.hardCapsApplied.map(({id})=>id),["PROJECTION_AUTHORITY"]);});

test("only V1 migration cases use the checkpoint exclusion",()=>{const cases=passedCases(),definition=manifest.cases.find((item)=>item.id==="E-01"),excluded=cases.find((item)=>item.id==="E-01");Object.assign(excluded,createMissingV1CheckpointOutcome(definition));const result=scoreEvaluation(manifest,contractMap,{cases});assert.equal(result.blockedWeight,0);assert.equal(result.excludedWeight,2);assert.equal(result.formalEligible,true);assert.equal(result.verdict,"accepted");});
