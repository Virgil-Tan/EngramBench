import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,copyFile,mkdir,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import contract from '../contracts/transfer/dockchain.mjs';
import {validatePublicContract} from '../src/public-contract.mjs';
import {evaluatorContract} from '../src/task-evaluator-v2/public-contract.mjs';
import {validator,openApi,requestValidator,matchOperation} from '../templates/contract-first/runtime.mjs';
import {assertLiveSchema} from '../evaluators/transfer/dockchain/v2/oracles/openapi.mjs';
import {CASES} from '../evaluators/transfer/dockchain/v2/cases/index.mjs';
import {validateManifest} from '../evaluators/transfer/dockchain/v2/lib/scoring.mjs';
import {validateCaseRegistry} from '../evaluators/transfer/dockchain/v2/lib/execution.mjs';
const options={evaluationSeed:'public-contract-regression',caseId:'A-05',baseTime:'2026-09-07T00:00:00.000Z'};
test('dockchain: frozen case manifest validates without claiming live readiness',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../evaluators/transfer/dockchain/v2/manifest.v2.json',import.meta.url),'utf8'));
 const map=JSON.parse(await readFile(new URL('../evaluators/transfer/dockchain/v2/contract-map.v2.json',import.meta.url),'utf8'));
 assert.equal(validateManifest(manifest,map),true);assert.equal(validateCaseRegistry(manifest,CASES),true);assert.equal(manifest.formalReady,false);
});
function checkRequest(path,body,key='private-regression-key',expect=true){
 const route=matchOperation(contract.operations,'POST',path);assert(route,path);
 const result=requestValidator(contract)(route.operation,{params:route.params,query:{},headers:{'content-type':'application/json','idempotency-key':key},body,hasBody:true});
 assert.equal(result.valid,expect,JSON.stringify(result));return result;
}
test('dockchain: public contract closes operations and uses a linked persistent smoke',()=>{
 const stats=validatePublicContract(contract);assert.equal(stats.operations,19);assert(stats.probes>=6);
 for(const op of contract.operations){assert(op.response);assert(op.source);if(op.method==='POST')assert(op.request&&op.example.body!==undefined);}
 assert(contract.smoke.some(x=>x.capture));assert(contract.smoke.some(x=>x.expectContains?.length));
 assert.equal(CASES.length,44);
});
test('dockchain: all real private seed families validate against author schema',()=>{
 const validate=validator(contract)(contract.seed.schema);
 assert(validate(contract.seed.example),JSON.stringify(validate.errors));
 for(const[name,seed]of privateSeeds())assert(validate(seed),name+': '+JSON.stringify(validate.errors));
 assert.equal(validate({...contract.seed.example,unpublished:[]}),false);
});
test('dockchain: hidden OpenAPI oracle accepts the author baseline and rejects weakened schema',()=>{
 const baseline=openApi(contract);assertOracle(baseline);
 const altered=structuredClone(baseline);altered.components.schemas.Work.required=altered.components.schemas.Work.required.filter(x=>x!=='terminal');
 assert.throws(()=>assertOracle(altered),/response schema/);
 const requestAltered=structuredClone(baseline),mutation=contract.operations.find(x=>x.method==='POST'),path=mutation.path.replace(/\/:([^/]+)/g,'/{$1}');
 requestAltered.paths[path].post.requestBody.content['application/json'].schema={type:'object'};
 assert.throws(()=>assertOracle(requestAltered),/request schema/);
});
test('dockchain: isolated author mount validates positive fixtures and rejects evaluator mistakes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'dockchain-author-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const author=join(dir,'public-contract'),oracle=join(dir,'evaluator','v2','oracles');await mkdir(author,{recursive:true});await mkdir(oracle,{recursive:true});
 await writeFile(join(author,'contract.json'),JSON.stringify(contract));
 await copyFile(new URL('../templates/contract-first/runtime.mjs',import.meta.url),join(author,'runtime.mjs'));
 await copyFile(new URL('../evaluators/transfer/dockchain/v2/oracles/openapi.mjs',import.meta.url),join(oracle,'openapi.mjs'));await symlink(resolve('node_modules'),join(dir,'node_modules'),'dir');
 const boundary=await evaluatorContract(author);for(const[,seed]of privateSeeds())boundary.seed(seed);
 assert.throws(()=>boundary.seed({...contract.seed.example,unpublished:[]}),e=>e.origin==='evaluator'&&e.code==='EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
 const mutation=contract.operations.find(x=>x.method==='POST'),example=mutation.example;
 const url=mutation.path.replace(/\/:([^/]+)/g,(_,name)=>'/'+example.params[name]);
 boundary.request(url,{method:'POST',json:example.body,headers:{'Idempotency-Key':'private-test'}});
 assert.throws(()=>boundary.request(url,{method:'POST',json:{...example.body,unpublished:true},headers:{'Idempotency-Key':'private-test'}}),e=>e.origin==='evaluator');
 boundary.request(url,{method:'POST',raw:'{',headers:{'content-type':'application/json'},contractExpectation:'invalid'});
 const script='const o=await import('+JSON.stringify(pathToFileURL(join(oracle,'openapi.mjs')).href)+');const r=await import('+JSON.stringify(pathToFileURL(join(author,'runtime.mjs')).href)+');o.assertPublishedOpenApi(r.openApi(o.contract));';
 await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,FRONTAL_PUBLIC_CONTRACT_ROOT:author}});
 const release=JSON.parse(await readFile(new URL('../evaluators/transfer/dockchain/release.json',import.meta.url),'utf8'));assert.equal(release.status,'pending_live_validation');
});

import {createFixtureFactory,createPerformanceSeed} from '../evaluators/transfer/dockchain/v2/fixtures/index.mjs';
import {createPortCall,createStandby,movementAction} from '../evaluators/transfer/dockchain/v2/cases/helpers.mjs';
import {assertDockChainOpenApi,selectBundle} from '../evaluators/transfer/dockchain/v2/oracles/index.mjs';
function privateSeeds(){const f=createFixtureFactory(options);return ['empty','resourceGrid','portCall','standby','idempotency','work','event','linked','migration','browser','performance'].map(name=>[name,f[name]().seed]);}
const assertOracle=assertDockChainOpenApi;

test('dockchain: actual negative seed case marks only malformed wire, never semantic conflicts',async()=>{
 const f=createFixtureFactory(options),valid=validator(contract)(contract.seed.schema),issues=[],seen=new Map(),calls=[];
 const empty={asOf:'2026-09-07T00:00:00.000Z',resources:Object.fromEntries(Object.keys(contract.schemas.SnapshotResources.properties).map(name=>[name,[]])),work:[],events:[]};
 const ctx={...options,fixtures:f,uuid:f.uuid,key:f.key,workspace:'private-boundary-dockchain',canonical:JSON.stringify,evidence:[],
  forWorkspace(){return this;},async migrate(){},async npm(){},async stop(){},mark(){},async resetDatabase(){seen.clear();},
  async startApi(){return {baseUrl:'http://author.test'};},async snapshot(){return structuredClone(empty);},
  equal(a,b,label){assert.deepEqual(a,b,label);},ok(a,label){assert.ok(a,label);},assert(_label,fn){fn();},pass(x){return x;},
  async seed(value,opts={}){
   const conforms=valid(value);calls.push({conforms,marker:opts.contractExpectation});
   if(!conforms&&opts.contractExpectation!=='invalid')issues.push('unmarked invalid wire '+value.seedVersion);
   if(conforms&&opts.contractExpectation==='invalid')issues.push('valid wire bypass '+value.seedVersion);
   const text=JSON.stringify(value),prior=seen.get(value.seedVersion);
   const semanticInvalid=/^invalid-|-(unknown|duplicate|reference|conservation|state|integer|timestamp|missing|priority|capacity|interval)$/.test(value.seedVersion);
   const conflict=prior!==undefined&&prior!==text;
   if(!conforms||semanticInvalid||conflict){if(opts.allowFailure)return{exitCode:1,stdout:conflict?'SEED_VERSION_CONFLICT':'invalid seed',stderr:''};throw Error(conflict?'SEED_VERSION_CONFLICT':'invalid seed');}
   seen.set(value.seedVersion,text);return{exitCode:0,stdout:'',stderr:''};
  },
 };
 await CASES.find(item=>item.id==='A-03').run(ctx);
 assert.deepEqual(issues,[]);assert(calls.some(x=>!x.conforms));assert(calls.some(x=>x.conforms&&!x.marker));
});
test('DockChain real legacy and linked helpers use published requests without adapters',async()=>{
 const f=createFixtureFactory(options),family=f.linked(),calls=[];
 const ctx={key:f.key,async mutate(_base,path,key,body,opts={}){checkRequest(path,body,key);assert.notEqual(opts.contractExpectation,'invalid');calls.push(path);return{status:201,json:{}};}};
 await createPortCall(ctx,'http://author.test',family.v1Payload('one'),{allowFailure:true});
 await createPortCall(ctx,'http://author.test',family.linkedPayload('two'),{allowFailure:true});
 await createStandby(ctx,'http://author.test',f.standby().standbyPayload('wait'),{allowFailure:true});
 await movementAction(ctx,'http://author.test',f.uuid('call'),f.uuid('movement'),'confirm',{allowFailure:true});
 assert.equal(calls.length,4);assert(selectBundle(family,family.v1Payload('one')));
 for(const body of [{...family.v1Payload('bad'),requiredTugs:0},{...family.linkedPayload('bad'),arrival:{...family.linkedPayload('bad').arrival,containerUnits:1.5}}])assert.equal(checkRequest('/api/v1/port-calls',body,undefined,false).code,'INVALID_PORT_CALL_INTERVAL');
 assert.equal(checkRequest('/api/v1/port-calls',{...family.v1Payload('bad'),vesselId:'bad'},undefined,false).code,'INVALID_REQUEST');
});
test('DockChain full fixed performance seed remains V1 wire-valid',()=>{
 const f=createPerformanceSeed(),valid=validator(contract)(contract.seed.schema);
 assert(valid(f.seed),JSON.stringify(valid.errors));assert.equal(f.seed.portCalls.length,51500);
});
