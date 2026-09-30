import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,copyFile,mkdir,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import contract from '../contracts/transfer/metersettle.mjs';
import {validatePublicContract} from '../src/public-contract.mjs';
import {evaluatorContract} from '../src/task-evaluator-v2/public-contract.mjs';
import {validator,openApi,requestValidator,matchOperation} from '../templates/contract-first/runtime.mjs';
import {assertLiveSchema} from '../evaluators/transfer/metersettle/v2/oracles/openapi.mjs';
import {CASES} from '../evaluators/transfer/metersettle/v2/cases/index.mjs';
import {validateManifest} from '../evaluators/transfer/metersettle/v2/lib/scoring.mjs';
import {validateCaseRegistry} from '../evaluators/transfer/metersettle/v2/lib/execution.mjs';
const options={evaluationSeed:'public-contract-regression',caseId:'A-05',baseTime:'2026-09-07T00:00:00.000Z'};
test('metersettle: frozen case manifest validates without claiming live readiness',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../evaluators/transfer/metersettle/v2/manifest.v2.json',import.meta.url),'utf8'));
 const map=JSON.parse(await readFile(new URL('../evaluators/transfer/metersettle/v2/contract-map.v2.json',import.meta.url),'utf8'));
 assert.equal(validateManifest(manifest,map),true);assert.equal(validateCaseRegistry(manifest,CASES),true);assert.equal(manifest.formalReady,false);
});
function checkRequest(path,body,key='private-regression-key',expect=true){
 const route=matchOperation(contract.operations,'POST',path);assert(route,path);
 const result=requestValidator(contract)(route.operation,{params:route.params,query:{},headers:{'content-type':'application/json','idempotency-key':key},body,hasBody:true});
 assert.equal(result.valid,expect,JSON.stringify(result));return result;
}
test('metersettle: public contract closes operations and uses a linked persistent smoke',()=>{
 const stats=validatePublicContract(contract);assert.equal(stats.operations,13);assert(stats.probes>=6);
 for(const op of contract.operations){assert(op.response);assert(op.source);if(op.method==='POST')assert(op.request&&op.example.body!==undefined);}
 assert(contract.smoke.some(x=>x.capture));assert(contract.smoke.some(x=>x.expectContains?.length));
 assert.equal(CASES.length,44);
});
test('metersettle: all real private seed families validate against author schema',()=>{
 const validate=validator(contract)(contract.seed.schema);
 assert(validate(contract.seed.example),JSON.stringify(validate.errors));
 for(const[name,seed]of privateSeeds())assert(validate(seed),name+': '+JSON.stringify(validate.errors));
 assert.equal(validate({...contract.seed.example,unpublished:[]}),false);
});
test('metersettle: hidden OpenAPI oracle accepts the author baseline and rejects weakened schema',()=>{
 const baseline=openApi(contract);assertOracle(baseline);
 const altered=structuredClone(baseline);altered.components.schemas.Work.required=altered.components.schemas.Work.required.filter(x=>x!=='terminal');
 assert.throws(()=>assertOracle(altered),/response schema/);
 const requestAltered=structuredClone(baseline),mutation=contract.operations.find(x=>x.method==='POST'),path=mutation.path.replace(/\/:([^/]+)/g,'/{$1}');
 requestAltered.paths[path].post.requestBody.content['application/json'].schema={type:'object'};
 assert.throws(()=>assertOracle(requestAltered),/request schema/);
});
test('metersettle: isolated author mount validates positive fixtures and rejects evaluator mistakes',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'metersettle-author-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const author=join(dir,'public-contract'),oracle=join(dir,'evaluator','v2','oracles');await mkdir(author,{recursive:true});await mkdir(oracle,{recursive:true});
 await writeFile(join(author,'contract.json'),JSON.stringify(contract));
 await copyFile(new URL('../templates/contract-first/runtime.mjs',import.meta.url),join(author,'runtime.mjs'));
 await copyFile(new URL('../evaluators/transfer/metersettle/v2/oracles/openapi.mjs',import.meta.url),join(oracle,'openapi.mjs'));await symlink(resolve('node_modules'),join(dir,'node_modules'),'dir');
 const boundary=await evaluatorContract(author);for(const[,seed]of privateSeeds())boundary.seed(seed);
 assert.throws(()=>boundary.seed({...contract.seed.example,unpublished:[]}),e=>e.origin==='evaluator'&&e.code==='EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
 const mutation=contract.operations.find(x=>x.method==='POST'),example=mutation.example;
 const url=mutation.path.replace(/\/:([^/]+)/g,(_,name)=>'/'+example.params[name]);
 boundary.request(url,{method:'POST',json:example.body,headers:{'Idempotency-Key':'private-test'}});
 assert.throws(()=>boundary.request(url,{method:'POST',json:{...example.body,unpublished:true},headers:{'Idempotency-Key':'private-test'}}),e=>e.origin==='evaluator');
 boundary.request(url,{method:'POST',raw:'{',headers:{'content-type':'application/json'},contractExpectation:'invalid'});
 const script='const o=await import('+JSON.stringify(pathToFileURL(join(oracle,'openapi.mjs')).href)+');const r=await import('+JSON.stringify(pathToFileURL(join(author,'runtime.mjs')).href)+');o.assertPublishedOpenApi(r.openApi(o.contract));';
 await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,FRONTAL_PUBLIC_CONTRACT_ROOT:author}});
 const release=JSON.parse(await readFile(new URL('../evaluators/transfer/metersettle/release.json',import.meta.url),'utf8'));assert.equal(release.status,'pending_live_validation');
});

import {createFixtureFactory} from '../evaluators/transfer/metersettle/v2/fixtures/index.mjs';
import {usageBody,correctionBody,ingest} from '../evaluators/transfer/metersettle/v2/cases/helpers.mjs';
import {assertOpenApiDocument,semanticRevisionDetail} from '../evaluators/transfer/metersettle/v2/oracles/index.mjs';
import {writePerformanceSeed,performanceBatch} from '../evaluators/transfer/metersettle/v2/cases/perf.mjs';
function privateSeeds(){const f=createFixtureFactory(options);return ['empty','rating','contract','dedupe','watermark','correctionFamily','recovery','eventFamily','migration','browser'].map(name=>[name,f[name]().seed]);}
const assertOracle=assertOpenApiDocument;

test('metersettle: actual negative seed case marks only malformed wire, never semantic conflicts',async()=>{
 const f=createFixtureFactory(options),valid=validator(contract)(contract.seed.schema),issues=[],seen=new Map(),calls=[];
 const empty={asOf:'2026-09-07T00:00:00.000Z',resources:Object.fromEntries(Object.keys(contract.schemas.SnapshotResources.properties).map(name=>[name,[]])),work:[],events:[]};
 const ctx={...options,fixtures:f,uuid:f.uuid,key:f.key,workspace:'private-boundary-metersettle',canonical:JSON.stringify,evidence:[],
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
test('MeterSettle actual streaming performance seed and request builder preserve public wire',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'meter-perf-author-'));t.after(()=>rm(dir,{recursive:true,force:true}));const f=createFixtureFactory(options);
 const catalog=await writePerformanceSeed({fixtures:{performance:()=>({...f.performance(),tenantCount:2,meterCount:4,eventCount:20,closedEventCount:5})},uuid:f.uuid,tempPath:name=>join(dir,name)});
 const seed=JSON.parse(await readFile(catalog.path,'utf8')),valid=validator(contract)(contract.seed.schema);assert(valid(seed),JSON.stringify(valid.errors));
 checkRequest('/api/v1/usage-batches',performanceBatch(catalog,'regression',0));assert.equal(seed.usageEvents.length,20);
});
test('MeterSettle real helper bodies keep only published fields and preserve signed corrections',async()=>{
 const f=createFixtureFactory(options),family=f.rating(),calls=[];
 const ctx={async usageBatch(_base,body){checkRequest('/api/v1/usage-batches',body);calls.push(body);return {status:202,json:{batchId:f.uuid('batch'),tenantId:family.tenant.tenantId,acceptedEventIds:body.events.map(x=>x.eventId),duplicateEventIds:[],createdAt:f.at()}};},ok:assert.ok,assert(_label,fn){fn();}};
 await ingest(ctx,'http://author.test',family);
 const correction=correctionBody(family.tenant.tenantId,[f.correction(1,family.events[1],{quantityDelta:-1,reason:''})]);
 checkRequest('/api/v1/correction-batches',correction);
 assert.equal(correction.corrections[0].reason,'');assert.equal(calls.length,1);
 assert(!Object.hasOwn(usageBody(family.tenant.tenantId,family.events).events[0],'ingestedAt'));
 const good={statementRevision:{statementRevisionId:f.uuid('revision'),statementId:f.uuid('statement'),revision:2,priorTotalMinor:70,deltaMinor:-7,effectiveTotalMinor:63,correctionIds:['public'],state:'FINALIZED',finalizedAt:f.at()},correctionEvents:[{...f.correction(1,family.events[1],{correctionId:'public',quantityDelta:-1}),ingestedAt:f.at()}]};
 assert.doesNotThrow(()=>semanticRevisionDetail(good));
 assert.throws(()=>semanticRevisionDetail({data:good}),/fields/);
});
