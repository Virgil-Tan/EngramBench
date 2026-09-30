import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {authorValidationReport,validateAuthorResume,runV2EvaluatorProcess,orderV2CasesForExecution} from '../src/task-package-v2-evaluator.mjs';
import {createPriorCaseState} from '../src/task-evaluator-v2/execution.mjs';
import {digestTaskPackagePath,loadTaskPackageV1} from '../src/task-package-v1.mjs';

const definitions=[{id:'A-01',dimension:'A',weight:1},{id:'A-02',dimension:'A',weight:1},{id:'D-08',dimension:'D',weight:1}];
const request={task:{id:'test',version:4,contractDigest:'c'.repeat(64),digest:'b'.repeat(64)},submission:{path:'/frozen',digest:'d'.repeat(64)},seed:'e'.repeat(64)};
const outcome={...definitions[0],status:'failed',durationMs:42,evidenceDigest:'f'.repeat(64),privateMessage:'real prior failure'};
const source=()=>structuredClone({result:authorValidationReport({taskId:'test',request:{...request,task:{...request.task,digest:'a'.repeat(64)}},cases:[outcome],totalCases:3,complete:false}),priorState:createPriorCaseState('test',[{outcome,evidence:{verified:'kept'}}])});

test('resume preserves full failed outcome and private evidence across an evaluator-only revision',()=>{
  const input=source(),before=structuredClone(input),v=validateAuthorResume(input,request,definitions);
  assert.deepEqual(v.cases,[outcome]);assert.deepEqual(v.privateCaseRecords[0].evidence,{verified:'kept'});
  assert.equal(v.provenance.task.digest,'a'.repeat(64));assert.deepEqual(v.provenance.reusedCaseIds,['A-01']);
  assert.deepEqual(input,before);
});
test('resume rejects wrong identity, missing/private evidence drift, reordered and already complete results',()=>{
  for(const mutate of [v=>v.result.seed='different',v=>v.result.submission.digest='different',v=>v.result.task.contractDigest='different',v=>v.result.complete=true,v=>v.result.score=100,v=>v.result.counts.failed=0,v=>v.result.cases[0].id='A-02',v=>v.priorState.cases=[],v=>v.priorState.cases[0].outcome.evidenceDigest='0'.repeat(64)]){
    const v=source();mutate(v);assert.throws(()=>validateAuthorResume(v,request,definitions));
  }
});
test('resume remains author-only and cannot combine with arbitrary case selection',async()=>{
  await assert.rejects(runV2EvaluatorProcess({resume:source()}),/author-validation/);
  await assert.rejects(runV2EvaluatorProcess({mode:'author-validation',caseIds:['A-01'],resume:source()}),/case selection/);
});
test('real evaluator reuses prefix without executing it and carries prior evidence into remaining cases',async t=>{
  const repositoryRoot=resolve(import.meta.dirname,'..'),taskRoot=join(repositoryRoot,'task-packages/v2/configorbit');
  const dir=await mkdtemp(join(tmpdir(),'author-resume-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const frozen=join(dir,'frozen');await mkdir(frozen);await writeFile(join(frozen,'untouched'),'untouched');
  const pkg=await loadTaskPackageV1(taskRoot),manifest=JSON.parse(await readFile(join(taskRoot,'evaluator/v2/manifest.v2.json')));
  const ordered=orderV2CasesForExecution(manifest.cases),first={id:ordered[0].id,dimension:ordered[0].dimension,weight:ordered[0].weight,status:'failed',durationMs:5,evidenceDigest:'f'.repeat(64)};
  const req={kind:'frontal-evaluation-request',schemaVersion:1,operationId:'author-resume-test',task:pkg.evaluator.task,submission:{path:frozen,digest:await digestTaskPackagePath(frozen)},seed:'a'.repeat(64)};
  const priorState=createPriorCaseState('configorbit',[{outcome:first,evidence:{actual:'original evidence'}}]);
  const resume={result:authorValidationReport({taskId:'configorbit',request:req,cases:[first],totalCases:ordered.length,complete:false}),priorState};
  await writeFile(join(dir,'request.json'),JSON.stringify(req));let created=0;
  const result=await runV2EvaluatorProcess({mode:'author-validation',repositoryRoot,taskRoot,resume,argv:['--request',join(dir,'request.json'),'--result',join(dir,'result.json')],runtimeFactory:()=>({async createSession(options){
    const caseRoot=options.mounts.find(m=>m.target==='/results').source;
    const prior=JSON.parse(await readFile(join(caseRoot,'prior-case-state.json')));
    assert.deepEqual(prior.cases[0],priorState.cases[0]);created++;
    return {async exec(command,args){if(command!=='node')return;const id=args[args.indexOf('--case')+1];assert.notEqual(id,first.id);await writeFile(join(caseRoot,'result.json'),JSON.stringify({schemaVersion:2,taskId:'configorbit',cases:[{id,status:'passed',evidenceDigest:'b'.repeat(64)}]}));},async close(){}};
  }})});
  assert.equal(result.complete,true);assert.equal(result.completedCases,ordered.length);
  assert.deepEqual(result.cases[0],first);assert(created>0);assert(created<ordered.length);
  assert.equal(result.formalEligible,false);assert.equal(result.score,null);
  assert.deepEqual(result.resumeSource.reusedCaseIds,[first.id]);
  assert.equal(await digestTaskPackagePath(frozen),req.submission.digest);
});
