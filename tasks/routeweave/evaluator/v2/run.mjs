#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir,readFile,readdir,rename,stat,writeFile } from "node:fs/promises";
import { dirname,relative,resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CASES } from "./cases/index.mjs";
import { executeCase,validateCaseRegistry } from "./lib/execution.mjs";
import { withCaseContext } from "./lib/runtime.mjs";
import { scoreEvaluation,validateManifest } from "./lib/scoring.mjs";

const evaluatorRoot=dirname(fileURLToPath(import.meta.url));

export async function runEvaluation(options){
  const manifest=await readJson(resolve(evaluatorRoot,"manifest.v2.json")),contractMap=await readJson(resolve(evaluatorRoot,"contract-map.v2.json"));
  validateManifest(manifest,contractMap);validateCaseRegistry(manifest,CASES);
  const workspace=resolve(options.workspace),resultPath=resolve(options.result),selected=selectCases(manifest,options.caseIds),implementations=new Map(CASES.map((item)=>[item.id,item])),mappings=new Map(contractMap.cases.map((item)=>[item.caseId,item]));
  const submissionDigest=options.submissionDigest??await digestTree(workspace,{ignore:new Set([".git","dist","node_modules"])}),evaluatorDigest=await digestTree(evaluatorRoot,{ignore:new Set(["node_modules"])}),evaluationSeedDigest=sha256(options.evaluationSeed),cases=[];
  await mkdir(dirname(resultPath),{recursive:true});
  for(const definition of selected){
    const outcome=await executeCase({definition,implementation:implementations.get(definition.id),withContext:withCaseContext,contextOptions:{workspace,v1Workspace:options.v1Workspace?resolve(options.v1Workspace):undefined,evaluationSeed:options.evaluationSeed,...(options.baseTime === undefined ? {} : { baseTime: options.baseTime }),postgresAdminUrl:options.postgresAdminUrl},failureCodePrefix:mappings.get(definition.id).privateFailureCodePrefix});
    cases.push(outcome);process.stdout.write(`${JSON.stringify({event:"case.completed",id:outcome.id,status:outcome.status,durationMs:outcome.durationMs})}\n`);
    await writeJson(resultPath,{schemaVersion:2,taskId:manifest.taskId,complete:false,submissionDigest,evaluatorDigest,evaluationSeedDigest,completedCaseCount:cases.length,selectedCaseCount:selected.length,cases});
  }
  const complete=selected.length===manifest.cases.length,scored=complete?scoreEvaluation(manifest,contractMap,{cases}):{verdict:"partial",formalEligible:false,rawScore:null,score:null,dimensions:{},hardCapsApplied:[]},evaluation={schemaVersion:2,taskId:manifest.taskId,submissionDigest,evaluatorDigest,evaluationSeedDigest,completedAt:new Date().toISOString(),complete,...scored,cases:scored.cases??cases};
  await writeJson(resultPath,evaluation);return evaluation;
}

export function parseArgs(argv){
  const parsed={caseIds:[]},valued=new Set(["--workspace","--submission","--result","--seed","--base-time","--v1-workspace","--submission-digest","--case","--postgres-admin-url"]);
  for(let index=0;index<argv.length;index+=1){const flag=argv[index];if(!valued.has(flag)||argv[index+1]===undefined)throw new Error(`unknown or valueless argument: ${flag}`);const value=argv[index+=1];if(flag==="--case")parsed.caseIds.push(...value.split(",").filter(Boolean));else if(flag==="--workspace"||flag==="--submission")parsed.workspace=value;else if(flag==="--result")parsed.result=value;else if(flag==="--seed")parsed.evaluationSeed=value;else if(flag==="--base-time")parsed.baseTime=value;else if(flag==="--v1-workspace")parsed.v1Workspace=value;else if(flag==="--submission-digest")parsed.submissionDigest=value;else if(flag==="--postgres-admin-url")parsed.postgresAdminUrl=value;}
  if(!parsed.workspace||!parsed.result||!parsed.evaluationSeed)throw new Error("--submission/--workspace, --result, and --seed are required");return parsed;
}

export function selectCases(manifest,requested=[]){
  if(requested.length===0)return[...manifest.cases];const selected=new Set(requested),unknown=[...selected].filter((id)=>!manifest.cases.some((item)=>item.id===id));if(unknown.length)throw new Error(`unknown case ids: ${unknown.join(", ")}`);return manifest.cases.filter(({id})=>selected.has(id));
}

export async function digestTree(root,{ignore=new Set()}={}){
  const files=[];async function visit(path){const information=await stat(path);if(information.isDirectory()){for(const name of(await readdir(path)).sort())if(!ignore.has(name))await visit(resolve(path,name));}else if(information.isFile()&&information.size<=128*1024*1024)files.push([relative(root,path),await readFile(path)]);}await visit(root);const digest=createHash("sha256");for(const[path,body]of files)digest.update(path).update("\0").update(body).update("\0");return digest.digest("hex");
}

function sha256(value){return createHash("sha256").update(String(value)).digest("hex");}
async function readJson(path){return JSON.parse(await readFile(path,"utf8"));}
async function writeJson(path,value){const temporary=`${path}.${process.pid}.tmp`;await writeFile(temporary,`${JSON.stringify(value,null,2)}\n`,{mode:0o600});await rename(temporary,path);}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))runEvaluation(parseArgs(process.argv.slice(2))).then((evaluation)=>{process.stdout.write(`${JSON.stringify({event:"evaluation.completed",verdict:evaluation.verdict,score:evaluation.score})}\n`);if(!["accepted","diagnostic","partial"].includes(evaluation.verdict))process.exitCode=1;}).catch((error)=>{process.stderr.write(`${error instanceof Error?error.message:String(error)}\n`);process.exitCode=1;});
