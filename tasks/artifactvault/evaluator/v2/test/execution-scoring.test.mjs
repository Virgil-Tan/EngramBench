import assert from "node:assert/strict";
import test from "node:test";

import manifest from "../manifest.v2.json" with { type:"json" };
import contractMap from "../contract-map.v2.json" with { type:"json" };
import { executeCase } from "../lib/execution.mjs";
import { scoreEvaluation } from "../lib/scoring.mjs";

test("all exact cases score 100 and every dimension closes",()=>{const cases=manifest.cases.map(({id,dimension,weight})=>({id,dimension,weight,status:"passed",durationMs:1,evidenceDigest:"a".repeat(64)})),result=scoreEvaluation(manifest,contractMap,{cases});assert.equal(result.score,100);assert.equal(result.verdict,"accepted");assert.deepEqual(result.dimensions,{A:30,B:25,C:20,D:15,E:10});});
test("candidate failures use task-owned prefix and hard cap",async()=>{const definition=manifest.cases[0],mapping=contractMap.cases[0],implementation={run:async()=>{const error=new Error("atomic stream failure");error.failureCodeSuffix="RANGE";error.hardCapIds=["DOMAIN_ATOMICITY"];throw error;}},outcome=await executeCase({definition,implementation,withContext:async(_options,operation)=>operation({}),contextOptions:{},failureCodePrefix:mapping.privateFailureCodePrefix});assert.equal(outcome.status,"failed");assert.equal(outcome.privateFailureCode,"AV_STREAM01_RANGE");assert.deepEqual(outcome.hardCapIds,["DOMAIN_ATOMICITY"]);const cases=manifest.cases.map(({id,dimension,weight})=>id===definition.id?{...outcome,id,dimension,weight}:{id,dimension,weight,status:"passed",durationMs:1,evidenceDigest:"b".repeat(64)}),scored=scoreEvaluation(manifest,contractMap,{cases});assert.equal(scored.rawScore,94);assert.equal(scored.score,35);});
