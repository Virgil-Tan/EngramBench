import assert from "node:assert/strict";
import { mkdtemp,readFile,readdir,rm,stat,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import test from "node:test";

import manifest from "../manifest.v2.json" with { type:"json" };
import { isConfigOrbitBarrier } from "../lib/runtime.mjs";
import { digestTree,parseArgs,selectCases } from "../run.mjs";

test("barrier accepts only the published claimed worker point and opaque dispatcher identity",()=>{const base={workId:"00000000-0000-4000-a000-000000000001",aggregateId:"00000000-0000-4000-a000-000000000002",attempt:1};assert.equal(isConfigOrbitBarrier({...base,processRole:"worker",point:"worker.claimed"}),true);assert.equal(isConfigOrbitBarrier({...base,processRole:"worker",point:"worker.effect-complete"}),false);assert.equal(isConfigOrbitBarrier({...base,processRole:"worker",point:"worker.claimed",attempt:0}),false);assert.equal(isConfigOrbitBarrier({...base,processRole:"dispatcher"}),true);assert.equal(isConfigOrbitBarrier({...base,processRole:"unknown"}),false);});
test("runner parses formal inputs and preserves manifest order for subsets",()=>{const parsed=parseArgs(["--workspace","/candidate","--result","/result.json","--seed","opaque","--v1-workspace","/v1","--case","LOAD-04,REV-01"]);assert.equal(parsed.workspace,"/candidate");assert.deepEqual(parsed.caseIds,["LOAD-04","REV-01"]);assert.deepEqual(selectCases(manifest,parsed.caseIds).map(({id})=>id),["REV-01","LOAD-04"]);assert.throws(()=>selectCases(manifest,["H-01"]),/unknown case/u);});
test("tree digest is deterministic and content-sensitive",async()=>{const root=await mkdtemp(join(tmpdir(),"configorbit-v2-test-"));try{await writeFile(join(root,"a.txt"),"one");const first=await digestTree(root),second=await digestTree(root);assert.equal(first,second);await writeFile(join(root,"a.txt"),"two");assert.notEqual(await digestTree(root),first);}finally{await rm(root,{recursive:true,force:true});}});
test("runner source has no placeholder legacy or cross-task evaluator imports",async()=>{const root=resolve(new URL("..",import.meta.url).pathname),files=[];async function visit(path){for(const name of await readdir(path)){if(name==="test")continue;const target=join(path,name),info=await stat(target);if(info.isDirectory())await visit(target);else if(name.endsWith(".mjs"))files.push(target);}}await visit(root);const source=(await Promise.all(files.map((path)=>readFile(path,"utf8")))).join("\n");assert.doesNotMatch(source,/TODO|FIXME|notImplemented|case is not implemented|hidden\/hard-fullstack|legacy-process-evaluator|\.\.\/\.\.\/[^/]+\/evaluator\/v2/iu);});
