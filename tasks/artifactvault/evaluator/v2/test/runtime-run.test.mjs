import assert from "node:assert/strict";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import manifest from "../manifest.v2.json" with { type:"json" };
import { isArtifactVaultBarrier } from "../lib/runtime.mjs";
import { digestTree,parseArgs,selectCases } from "../run.mjs";

test("barrier accepts only exact published worker and dispatcher payloads",()=>{const base={schemaVersion:1,workId:"00000000-0000-4000-a000-000000000001",aggregateId:"00000000-0000-4000-a000-000000000002",attempt:1,leaseTokenHash:"a".repeat(64)};for(const[processRole,point]of[["worker","worker.claimed"],["worker","worker.effect-complete"],["worker","worker.before-commit"],["dispatcher","dispatcher.response-received"]])assert.equal(isArtifactVaultBarrier({...base,processRole,point}),true);assert.equal(isArtifactVaultBarrier({...base,processRole:"worker",point:"worker.unpublished"}),false);assert.equal(isArtifactVaultBarrier({...base,processRole:"worker",point:"worker.claimed",token:"secret"}),false);});
test("runner parses formal inputs and preserves manifest order for subsets",()=>{const parsed=parseArgs(["--workspace","/candidate","--result","/result.json","--seed","opaque","--v1-workspace","/v1","--case","LOAD-04,STREAM-01"]);assert.equal(parsed.workspace,"/candidate");assert.deepEqual(parsed.caseIds,["LOAD-04","STREAM-01"]);assert.deepEqual(selectCases(manifest,parsed.caseIds).map(({id})=>id),["STREAM-01","LOAD-04"]);assert.throws(()=>selectCases(manifest,["H-01"]),/unknown case/u);});
test("tree digest is deterministic and content-sensitive",async()=>{const root=await mkdtemp(join(tmpdir(),"artifactvault-v2-test-"));try{await writeFile(join(root,"a.txt"),"one");const first=await digestTree(root),second=await digestTree(root);assert.equal(first,second);await writeFile(join(root,"a.txt"),"two");assert.notEqual(await digestTree(root),first);}finally{await rm(root,{recursive:true,force:true});}});
