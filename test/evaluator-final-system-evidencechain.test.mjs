import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CASES } from '../evaluators/learning/evidencechain/v2/cases/data.mjs';
import { createFixtureFactory } from '../evaluators/learning/evidencechain/v2/fixtures/index.mjs';
import contract from '../contracts/learning/evidencechain.mjs';
import { matchOperation, validator } from '../templates/contract-first/runtime.mjs';

// A response double validates evaluator sensitivity, not candidate correctness.
// No fake implementation is exported into task packages or used by live tests.
function peer(fault) {
  const f=createFixtureFactory({caseId:'DATA-05',evaluationSeed:'final-child-custody',baseTime:'2026-09-08T00:00:00Z'});
  const compile=validator(contract), saved=new Map(), calls=[];
  let state, starts=0, kills=0;
  const copy=v=>structuredClone(v), response=(status,json)=>({status,json:copy(json),text:JSON.stringify(json)});
  const ctx={fixtures:f,key:f.key,at:f.at,uuid:f.uuid,migrate:async()=>{},
    seed:async seed=>{
      const {schemaVersion,seedVersion,...resources}=copy(seed);
      delete resources.transfers; delete resources.importedAt;
      resources.collectedItems=seed.caseManifests.flatMap(m=>m.items.map(item=>({...item,caseId:m.caseId,
        state:'EXPECTED',currentCustodianId:null,intakeScanId:null,revision:0,sequence:0})));
      Object.assign(resources,{intakeScans:[],custodyMatches:[],custodyTransfers:[],itemSplits:[],aliquots:[],custodyMatchGroups:[]});
      state={asOf:f.at(),resources,work:[],events:[]};
      return {exitCode:0};
    },
    startApi:async()=>{starts++; if(fault==='lost-on-restart' && kills===2)state.resources.custodyTransfers=[];return {baseUrl:`http://peer-${starts}`};},
    kill:async()=>{kills++;},stop:async()=>{},
    startWorker:async()=>{for(const item of [...state.resources.collectedItems,...state.resources.aliquots])if(item.state==='RECEIVED')item.state='VERIFIED';return {};},
    snapshot:async()=>copy(state),waitFor:async read=>{const result=await read();assert.ok(result,'fixture must reach observable state');return result;},
    mutate:async(_base,path,key,body)=>{
      const operation=matchOperation(contract.operations,'POST',path)?.operation;
      assert.ok(operation,`unpublished request ${path}`);
      if(operation.request){const valid=compile(operation.request);assert.ok(valid(body),JSON.stringify(valid.errors));}
      calls.push(path);
      if(saved.has(key)) {
        if(fault==='duplicate-replay' && path.includes('/aliquots/'))state.resources.custodyTransfers.push(copy(state.resources.custodyTransfers[0]));
        return copy(saved.get(key));
      }
      const r=state.resources;let value,status=200;
      if(path==='/api/v1/intake-batches') {
        const scans=body.scans.map(scan=>({...scan,intakeScanId:f.uuid(scan.scanId),deviceId:body.deviceId,batchSequence:body.batchSequence,state:'UNMATCHED',revision:0}));
        r.intakeScans.push(...scans);value={deviceId:body.deviceId,batchSequence:body.batchSequence,scans};status=202;
      } else if(path==='/api/v1/custody-matches') {
        value={...body,matchId:f.uuid(key),state:'PROPOSED',createdAt:f.at(),confirmedAt:null,reversedAt:null};r.custodyMatches.push(value);
      } else if(path.includes('/custody-matches/') && path.endsWith('/confirm')) {
        value=r.custodyMatches.find(m=>path.includes(m.matchId));value.state='CONFIRMED';value.confirmedAt=f.at();
        Object.assign(r.collectedItems[0],{state:'RECEIVED',currentCustodianId:r.custodians[0].custodianId,intakeScanId:value.intakeScanId});
      } else if(path.endsWith('/splits')) {
        const parent=r.collectedItems[0];parent.state='CONSUMED_BY_SPLIT';parent.currentCustodianId=null;parent.intakeScanId=null;
        const aliquots=body.aliquots.map(a=>({...a,parentItemId:parent.collectedItemId,state:'EXPECTED',currentCustodianId:null,intakeScanId:null,revision:0}));
        r.aliquots.push(...aliquots);value={splitId:f.uuid(key),parentItemId:parent.collectedItemId,totalQuantity:parent.quantity,aliquots,state:'ACTIVE',createdAt:f.at(),reversedAt:null};r.itemSplits.push(value);
      } else if(path==='/api/v1/custody-match-groups') {
        value={custodyMatchGroupId:f.uuid(key),...body,members:body.members.map(m=>({...m,collectedItemId:null})),state:'CONFIRMED',createdAt:f.at(),confirmedAt:f.at(),reversedAt:null,sequence:0};r.custodyMatchGroups.push(value);status=201;
        for(const member of body.members)Object.assign(r.aliquots.find(a=>a.aliquotId===member.aliquotId),{state:'RECEIVED',intakeScanId:member.intakeScanId,currentCustodianId:r.custodians[0].custodianId});
      } else if(path.startsWith('/api/v1/aliquots/')) {
        const child=r.aliquots.find(a=>path.includes(a.aliquotId));child.currentCustodianId=body.toCustodianId;
        if(fault==='sibling-mutation')r.aliquots[1].currentCustodianId=body.toCustodianId;
        value={transferId:f.uuid(key),aliquotId:child.aliquotId,...body,acceptedAt:f.at(),priorTransferId:null};r.custodyTransfers.push(value);
      } else if(path.endsWith('/reverse')) {
        if(fault==='illegal-reversal')r.collectedItems[0].state='VERIFIED';
        return response(409,{error:{code:'SPLIT_NOT_REVERSIBLE',message:'Transferred',details:{}}});
      } else throw new Error(`unexpected mutation ${path}`);
      const result=response(status,value);saved.set(key,copy(result));return result;
    },
  };
  return {ctx,calls,counts:()=>({starts,kills})};
}

test('EvidenceChain DATA-05 executes public custody/reversal/replay and real restart boundaries',async()=>{
  const p=peer();const result=await DATA_CASES.find(c=>c.id==='DATA-05').run(p.ctx);
  assert.ok(result.evidence.length>0);
  assert.ok(p.calls.some(path=>path.startsWith('/api/v1/aliquots/')));
  assert.deepEqual(p.counts(),{starts:3,kills:2});
});
for(const fault of ['sibling-mutation','duplicate-replay','illegal-reversal','lost-on-restart']) {
  test(`EvidenceChain DATA-05 rejects ${fault}`,async()=>{
    const p=peer(fault);
    await assert.rejects(DATA_CASES.find(c=>c.id==='DATA-05').run(p.ctx),error=>error.code==='ERR_ASSERTION');
    assert.ok(p.calls.some(path=>path.startsWith('/api/v1/aliquots/')),'failure must exercise the target business, not an invalid initial fixture');
  });
}
