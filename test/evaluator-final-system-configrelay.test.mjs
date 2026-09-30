import test from 'node:test';
import assert from 'node:assert/strict';
import { B_CASES } from '../evaluators/learning/configrelay/v2/cases/b.mjs';
import { createFixtureFactory, agentCatalog, deploymentBody, stagedPlan, v1Seed } from '../evaluators/learning/configrelay/v2/lib/fixtures.mjs';
import contract from '../contracts/learning/configrelay.mjs';
import { matchOperation, validator } from '../templates/contract-first/runtime.mjs';

// Unit response doubles exercise the actual evaluator, not a candidate score.
function peer(fault) {
  const f=createFixtureFactory({caseId:'B-04',evaluationSeed:'cohort-isolation',baseTime:'2026-09-08T00:00:00Z'});
  const compile=validator(contract);let catalog,state,starts=0,kills=0,acks=0;
  const copy=value=>structuredClone(value);
  const ctx={caseId:'B-04',fixtures:f,stagedPlan,deploymentBody,
    catalog:options=>(catalog=agentCatalog(f,options)),seedFor:(version,options)=>v1Seed(f,version,options),
    seed:async value=>{const valid=compile(contract.seed.schema);assert.ok(valid(value),JSON.stringify(valid.errors));
      state={asOf:f.at(),resources:{agents:copy(value.agents),deployments:[],deploymentCohorts:[],rolloutCommands:[]},work:[],events:[]};},
    equal:(label,actual,expected)=>assert.deepEqual(actual,expected,label),ok:(label,value)=>assert.ok(value,label),
    startApi:async()=>{starts++;if(starts===2&&fault==='lost-state')state.resources.deploymentCohorts[0].state='DELIVERING';return {baseUrl:'http://response-double'};},
    kill:async()=>{kills++;},stop:async()=>{},startWorker:async()=>({}),snapshot:async()=>copy(state),
    waitFor:async read=>{const result=await read();assert.ok(result,'fixture must reach public observable state');return result;},
    createDeployment:async(_url,body)=>{
      const operation=matchOperation(contract.operations,'POST','/api/v1/deployments').operation;
      const valid=compile(operation.request);assert.ok(valid(body),JSON.stringify(valid.errors));
      const deploymentId=f.uuid('deployment');
      const cohorts=body.cohorts.map((cohort,ordinal)=>({...cohort,deploymentId,cohortId:f.uuid(`cohort-${ordinal}`),ordinal,
        state:ordinal?'WAITING':'DELIVERING',startedAt:ordinal?null:f.at(),successCount:0}));
      const deployment={deploymentId,cohorts};state.resources.deployments.push(deployment);state.resources.deploymentCohorts.push(...cohorts);
      for(const agent of catalog.agents.filter(a=>a.labels.cohort==='c0'))state.resources.rolloutCommands.push({commandId:f.uuid(agent.agentId),deploymentId,cohortId:cohorts[0].cohortId,agentId:agent.agentId,state:'SENT',kind:'APPLY'});
      return {status:202,json:copy(deployment)};
    },
    pollAgent:async(_url,agentId)=>{const command=state.resources.rolloutCommands.find(c=>c.agentId===agentId&&c.state==='SENT');return {status:200,json:command?{status:'COMMAND',command:copy(command)}:{status:'NO_CHANGE',command:null}};},
    acknowledge:async(_url,_agent,command,outcome)=>{
      assert.equal(outcome,'REJECTED');acks++;
      state.resources.rolloutCommands.find(c=>c.commandId===command.commandId).state='FAILED';
      if(state.resources.rolloutCommands.every(c=>c.state==='FAILED')) {
        state.resources.deploymentCohorts[0].state='FAILED';
        if(fault==='invented-success')state.resources.deploymentCohorts[0].successCount=1;
        if(fault==='later-started')state.resources.deploymentCohorts[1].startedAt=f.at();
        if(fault==='later-applied')state.resources.agents.find(a=>a.labels.cohort==='c1').appliedRevision++;
      }
      return {status:200,json:{}};
    },
  };
  return {ctx,counts:()=>({starts,kills,acks})};
}

test('ConfigRelay failed first cohort isolates the later cohort and survives API restart',async()=>{
  const p=peer();await B_CASES.find(c=>c.id==='B-04').run(p.ctx);
  assert.deepEqual(p.counts(),{starts:2,kills:1,acks:2});
});
for(const fault of ['invented-success','later-started','later-applied','lost-state'])test(`ConfigRelay B-04 rejects ${fault}`,async()=>{
  const p=peer(fault);await assert.rejects(B_CASES.find(c=>c.id==='B-04').run(p.ctx),error=>error.code==='ERR_ASSERTION');
  assert.equal(p.counts().acks,2,'negative must reach the target business rather than fail fixture setup');
});
