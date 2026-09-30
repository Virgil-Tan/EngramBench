import assert from "node:assert/strict";

import { EvaluationInfrastructureError } from "../lib/runtime.mjs";
import { percentile,replayShipment,validateRoute } from "../lib/oracle.mjs";
import {
  boot,caseResult,defineCase,projectionFor,requireStatus,snapshot,stableSnapshot,waitWorkDrain,
} from "./helpers.mjs";

const MIGRATION_CAP={failureCodeSuffix:"MIGRATION_COMPATIBILITY",hardCapIds:["MIGRATION_CORRECTNESS"]};
const JOURNEY_CAP={failureCodeSuffix:"PERFORMANCE_CORRECTNESS",hardCapIds:["JOURNEY_CORRECTNESS"]};

const E01=defineCase(
  "E-01",
  "populated V1 shipment with stable scan replay, projection, Event and retained Work identities",
  "run V1 migrations and public mutations, upgrade the same PostgreSQL database twice, then replay through FINAL",
  "migration adds exactly one deterministic legacy Consignment and Piece without changing any V1 identity or response",
  ["seed-command","public-http","shipment-scan","worker-process","v1-migration","verification-snapshot"],
  async function run(ctx){
    if(!ctx.v1Workspace)throw new EvaluationInfrastructureError("EVALUATOR_V1_WORKSPACE_REQUIRED","E-01 requires --v1-workspace");
    const catalog=ctx.catalog({legCount:2,label:"migration"}),v1=ctx.forWorkspace(ctx.v1Workspace);
    await v1.migrate();await v1.seed(ctx.seedFor("routeweave-v1-migration",{catalog}));
    const v1Api=await v1.startApi(),v1Worker=await v1.startWorker(),key=ctx.key("saved-v1-replay"),body=ctx.scanBody(catalog,"PICKED_UP",0,{scannerEventId:"migration-scan"}),first=await ctx.scanShipment(v1Api.baseUrl,body,{key});
    requireStatus(first,200,"V1 saved scan");await waitWorkDrain(ctx,v1Api.baseUrl,"JOURNEY_PROJECT",{processes:[v1Worker],timeoutMs:60_000});
    const before=await snapshot(ctx,v1Api.baseUrl),stableBefore=stableSnapshot(before),v1Shipment=before.resources.shipments.find(({shipmentId})=>shipmentId===catalog.shipment.shipmentId),v1RoutePlans=before.resources.routePlans.filter(({shipmentId})=>shipmentId===catalog.shipment.shipmentId),v1Scans=before.resources.scanEvents.filter(({shipmentId})=>shipmentId===catalog.shipment.shipmentId),v1Projection=projectionFor(before,{shipmentId:catalog.shipment.shipmentId}),v1Events=before.events.filter(({aggregateId})=>aggregateId===catalog.shipment.shipmentId),v1Work=before.work.filter(({aggregateId})=>aggregateId===catalog.shipment.shipmentId);
    await ctx.stop(v1Worker);await ctx.stop(v1Api);await ctx.migrate();await ctx.migrate();
    let finalApi=await ctx.startApi(),after=await snapshot(ctx,finalApi.baseUrl);
    ctx.equal("V1 Shipment identity preserved",after.resources.shipments.find(({shipmentId})=>shipmentId===v1Shipment.shipmentId),v1Shipment,MIGRATION_CAP);
    ctx.equal("V1 RoutePlan identities preserved",after.resources.routePlans.filter(({shipmentId})=>shipmentId===v1Shipment.shipmentId),v1RoutePlans,MIGRATION_CAP);
    ctx.equal("V1 ScanEvent identities preserved",after.resources.scanEvents.filter(({shipmentId})=>shipmentId===v1Shipment.shipmentId),v1Scans,MIGRATION_CAP);
    ctx.equal("V1 JourneyProjection preserved",projectionFor(after,{shipmentId:v1Shipment.shipmentId}),v1Projection,MIGRATION_CAP);
    ctx.equal("migration emits no replacement business Events",after.events.filter(({aggregateId})=>aggregateId===v1Shipment.shipmentId),v1Events,MIGRATION_CAP);
    ctx.equal("migration retains V1 Work",after.work.filter(({aggregateId})=>aggregateId===v1Shipment.shipmentId),v1Work,MIGRATION_CAP);
    const legacyPieces=after.resources.parcelPieces.filter(({legacyShipmentId})=>legacyShipmentId===v1Shipment.shipmentId),legacyConsignmentIds=new Set(legacyPieces.map(({consignmentId})=>consignmentId)),legacyConsignments=after.resources.consignments.filter(({consignmentId})=>legacyConsignmentIds.has(consignmentId));
    ctx.equal("exactly one legacy ParcelPiece",legacyPieces.length,1,MIGRATION_CAP);
    ctx.equal("exactly one legacy Consignment",legacyConsignments.length,1,MIGRATION_CAP);
    ctx.equal("legacy pieceRef equals tracking code",legacyPieces[0].pieceRef,v1Shipment.trackingCode,MIGRATION_CAP);
    ctx.equal("legacy route identity is unchanged",legacyConsignments[0].routePlanId,v1Shipment.currentRoutePlanId,MIGRATION_CAP);
    ctx.equal("legacy route revision is unchanged",legacyConsignments[0].routePlanRevision,v1Projection.routePlanRevision,MIGRATION_CAP);
    ctx.equal("legacy Consignment exists",after.resources.consignments.filter(({consignmentId})=>consignmentId===legacyPieces[0].consignmentId).length,1,MIGRATION_CAP);
    const replay=await ctx.scanShipment(finalApi.baseUrl,body,{key});ctx.equal("saved V1 replay status",replay.status,first.status,MIGRATION_CAP);ctx.equal("saved V1 replay body",replay.json,first.json,MIGRATION_CAP);
    const identities={pieceId:legacyPieces[0].pieceId,consignmentId:legacyPieces[0].consignmentId};await ctx.stop(finalApi);await ctx.migrate();finalApi=await ctx.startApi();after=await snapshot(ctx,finalApi.baseUrl);
    const repeated=after.resources.parcelPieces.filter(({legacyShipmentId})=>legacyShipmentId===v1Shipment.shipmentId);
    ctx.equal("repeated migration keeps legacy identities",{pieceId:repeated[0].pieceId,consignmentId:repeated[0].consignmentId},identities,MIGRATION_CAP);
    ctx.equal("repeated migration does not duplicate evidence",after.resources.scanEvents.filter(({shipmentId})=>shipmentId===v1Shipment.shipmentId).length,v1Scans.length,MIGRATION_CAP);
    return caseResult(ctx,{shipmentId:v1Shipment.shipmentId,...identities,v1EventCount:v1Events.length,v1WorkCount:v1Work.length,legacyConsignmentCount:legacyConsignments.length,preMigrationDigest:ctx.digestProjection(stableBefore)});
  },
);

function emptyPerformanceSeed(ctx,catalog,seedVersion){
  return ctx.seedFor(seedVersion,{catalog,shipments:[],routePlans:[],transportLegs:[],journeyProjections:[]});
}

function fourLegBody(catalog,index){
  const start=index%(catalog.hubs.length-4);
  return{tenantId:catalog.tenantId,trackingCode:`PERF-PLAN-${String(index).padStart(8,"0")}`,legs:Array.from({length:4},(_item,offset)=>({fromHubId:catalog.hubs[start+offset].hubId,toHubId:catalog.hubs[start+offset+1].hubId,carrierId:catalog.carriers[(index+offset)%catalog.carriers.length].carrierId}))};
}

const E02=defineCase(
  "E-02",
  "exactly one hundred hubs, twenty carriers and fifty thousand four-leg shipment requests",
  "drive the full published shipment-plan-ingest operation count through two production APIs at concurrency 64",
  "meet throughput and p95 thresholds with zero unexpected 5xx and independently validate every connected atomic route",
  ["seed-command","public-http","performance-load","verification-snapshot"],
  async function run(ctx){
    const contract=ctx.performanceContract().plan,catalog=ctx.catalog({label:"perf-plan",legCount:99,carrierCount:20}),{api}=await boot(ctx,{catalog,seed:emptyPerformanceSeed(ctx,catalog,"e02-plan")}),second=await ctx.startApi(),latencies=[],shipmentIds=[],unexpected5xx=[];
    ctx.equal("published plan operation count",contract.operationCount,50_000);ctx.equal("published plan concurrency",contract.concurrency,64);
    const startedAt=performance.now(),responses=await ctx.concurrent(Array.from({length:contract.operationCount},(_item,index)=>index),contract.concurrency,async(index)=>{
      const response=await ctx.createShipment(index%2?api.baseUrl:second.baseUrl,fourLegBody(catalog,index),{key:ctx.key(`plan-${index}`),timeoutMs:10_000});
      latencies.push(response.durationMs);if(response.status>=500)unexpected5xx.push(response.status);if(response.status===200)shipmentIds.push(response.json.shipment?.shipmentId??response.json.shipmentId);return response;
    }),elapsedMs=performance.now()-startedAt,throughput=responses.filter(({status})=>status===200).length/(elapsedMs/1000),p95=percentile(latencies,0.95);
    ctx.equal("all plan creations succeed",new Set(responses.map(({status})=>status)),new Set([200]),JOURNEY_CAP);ctx.equal("unexpected 5xx",unexpected5xx.length,0,JOURNEY_CAP);ctx.ok("shipment throughput threshold",throughput>=contract.targetPerSecond,`${throughput.toFixed(2)} < ${contract.targetPerSecond}`);ctx.ok("shipment p95 threshold",p95<=contract.p95Ms,`${p95.toFixed(2)} > ${contract.p95Ms}`);
    const state=await snapshot(ctx,api.baseUrl,{timeoutMs:300_000}),created=new Set(shipmentIds),plans=state.resources.routePlans.filter(({shipmentId})=>created.has(shipmentId)),legsByPlan=Map.groupBy(state.resources.transportLegs,({routePlanId})=>routePlanId);
    ctx.equal("all shipment identities unique",created.size,contract.operationCount,JOURNEY_CAP);ctx.equal("one route per created shipment",plans.length,contract.operationCount,JOURNEY_CAP);
    for(const plan of plans){const legs=legsByPlan.get(plan.routePlanId)?.sort((left,right)=>left.ordinal-right.ordinal)??[];ctx.assert(`connected route ${plan.shipmentId}`,()=>validateRoute(legs),JOURNEY_CAP);ctx.equal(`four legs ${plan.shipmentId}`,legs.length,4,JOURNEY_CAP);}
    return caseResult(ctx,{operationCount:contract.operationCount,concurrency:contract.concurrency,throughput,p50:percentile(latencies,0.5),p95,p99:percentile(latencies,0.99),unexpected5xx:unexpected5xx.length});
  },
);

function massShipmentGraph(ctx,label,count,legCount=4){
  const base=ctx.catalog({label,legCount,carrierCount:4}),shipments=[],routePlans=[],transportLegs=[],journeyProjections=[];
  for(let index=0;index<count;index+=1){
    const shipmentId=ctx.uuid(`${label}:shipment:${index}`),routePlanId=ctx.uuid(`${label}:route:${index}`),createdAt=ctx.fixtures.at();
    shipments.push({shipmentId,tenantId:base.tenantId,trackingCode:`${label.toUpperCase()}-${String(index).padStart(8,"0")}`,state:"PLANNED",currentRoutePlanId:routePlanId,createdAt});
    routePlans.push({routePlanId,shipmentId,revision:1,reason:"INITIAL",priorRoutePlanId:null,createdAt});
    const legs=Array.from({length:legCount},(_item,ordinal)=>({legId:ctx.uuid(`${label}:leg:${index}:${ordinal+1}`),routePlanId,ordinal:ordinal+1,fromHubId:base.hubs[ordinal].hubId,toHubId:base.hubs[ordinal+1].hubId,carrierId:base.carriers[ordinal%base.carriers.length].carrierId,state:"PLANNED"}));
    transportLegs.push(...legs);journeyProjections.push({shipmentId,projectionVersion:0,currentHubId:base.hubs[0].hubId,currentLegId:legs[0].legId,state:"PLANNED",lastObservedAt:null,routePlanRevision:1});
  }
  return{base,shipments,routePlans,transportLegs,journeyProjections,seed:ctx.seedFor(`${label}-seed`,{catalog:base,shipments,routePlans,transportLegs,journeyProjections})};
}

function perfScan(ctx,graph,shipmentIndex,position){
  const uniqueIndex=[6,0,1,1,5,2,3,7,4,4][position],shipment=graph.shipments[shipmentIndex],plan=graph.routePlans[shipmentIndex],legs=graph.transportLegs.slice(shipmentIndex*4,shipmentIndex*4+4),legIndex=Math.floor(uniqueIndex/2),type=uniqueIndex%2===0?"DEPARTED":"ARRIVED",leg=legs[legIndex];
  return{tenantId:graph.base.tenantId,shipmentId:shipment.shipmentId,scannerEventId:`perf-scan-${shipmentIndex}-${uniqueIndex}`,type,routePlanRevision:plan.revision,hubId:type==="DEPARTED"?leg.fromHubId:leg.toHubId,legId:leg.legId,observedAt:ctx.fixtures.at({seconds:uniqueIndex+1})};
}

const E03=defineCase(
  "E-03",
  "twenty thousand four-leg shipments and exactly two hundred thousand shuffled scans with twenty percent duplicates",
  "send the entire scan storm through two APIs at concurrency 64 while four production workers project all evidence",
  "meet mutation thresholds and compare every stored projection against a complete independent ledger replay",
  ["seed-command","shipment-scan","worker-process","performance-load","verification-snapshot"],
  async function run(ctx){
    const contract=ctx.performanceContract().scans,graph=massShipmentGraph(ctx,"perf-storm",contract.shipmentCount),{api}=await boot(ctx,{catalog:graph.base,seed:graph.seed}),second=await ctx.startApi(),workers=await Promise.all(Array.from({length:4},()=>ctx.startWorker())),latencies=[],unexpected5xx=[];
    ctx.equal("published scan operation count",contract.operationCount,200_000);ctx.equal("published duplicate percentage",contract.duplicatePercent,20);
    const startedAt=performance.now(),responses=await ctx.concurrent(Array.from({length:contract.operationCount},(_item,index)=>index),64,async(index)=>{
      const shipmentIndex=Math.floor(index/10),position=index%10,body=perfScan(ctx,graph,shipmentIndex,position),response=await ctx.scanShipment(index%2?api.baseUrl:second.baseUrl,body,{key:ctx.key(`storm-${index}`),timeoutMs:10_000});latencies.push(response.durationMs);if(response.status>=500)unexpected5xx.push(response.status);return response;
    }),elapsedMs=performance.now()-startedAt,throughput=responses.filter(({status})=>status===200).length/(elapsedMs/1000),p95=percentile(latencies,0.95);
    ctx.equal("all exact duplicate scans replay",new Set(responses.map(({status})=>status)),new Set([200]),JOURNEY_CAP);ctx.equal("scan storm unexpected 5xx",unexpected5xx.length,0,JOURNEY_CAP);ctx.ok("scan throughput threshold",throughput>=contract.targetPerSecond,`${throughput.toFixed(2)} < ${contract.targetPerSecond}`);ctx.ok("scan p95 threshold",p95<=contract.p95Ms,`${p95.toFixed(2)} > ${contract.p95Ms}`);
    const{state}=await waitWorkDrain(ctx,api.baseUrl,"JOURNEY_PROJECT",{processes:workers,timeoutMs:300_000}),evidenceByShipment=Map.groupBy(state.resources.scanEvents,({shipmentId})=>shipmentId);
    for(let index=0;index<contract.shipmentCount;index+=1){const shipment=graph.shipments[index],catalog={...graph.base,shipment,routePlan:graph.routePlans[index],legs:graph.transportLegs.slice(index*4,index*4+4)},evidence=evidenceByShipment.get(shipment.shipmentId)??[],expected=replayShipment(catalog,evidence),actual=projectionFor(state,{shipmentId:shipment.shipmentId});ctx.equal(`full replay ${index}`,actual,expected,JOURNEY_CAP);ctx.equal(`duplicate zero-advance ${index}`,evidence.length,8,JOURNEY_CAP);}
    return caseResult(ctx,{shipmentCount:contract.shipmentCount,operationCount:contract.operationCount,duplicatePercent:contract.duplicatePercent,throughput,p50:percentile(latencies,0.5),p95,p99:percentile(latencies,0.99),unexpected5xx:unexpected5xx.length});
  },
);

async function waitLeaseExpiry(ctx,state,workIds){
  const expiry=state.work.filter(({workId})=>workIds.has(workId)).map(({leaseExpiresAt})=>leaseExpiresAt).filter(Boolean).sort().at(-1),delay=Date.parse(expiry)-Date.now()+100;
  if(delay>0)await ctx.sleep(delay);
}

const E04=defineCase(
  "E-04",
  "exactly ten thousand in-flight shipments with loss, found and expected-revision reroute outcomes",
  "kill two workers only after public claimed barriers, start four replacements and drain the entire recovery load",
  "close within sixty seconds with one loss outcome and route authority per shipment and no stale old-plan movement",
  ["seed-command","shipment-scan","worker-process","public-http","performance-load","verification-snapshot"],
  async function run(ctx){
    const contract=ctx.performanceContract().recovery,graph=massShipmentGraph(ctx,"perf-recovery",contract.shipmentCount,2),{api}=await boot(ctx,{catalog:graph.base,seed:graph.seed}),second=await ctx.startApi(),setupWorkers=await Promise.all(Array.from({length:4},()=>ctx.startWorker()));
    await ctx.concurrent(graph.shipments,64,async(shipment,index)=>{const leg=graph.transportLegs[index*2],body={tenantId:graph.base.tenantId,shipmentId:shipment.shipmentId,scannerEventId:`recovery-pickup-${index}`,type:"PICKED_UP",routePlanRevision:1,hubId:leg.fromHubId,legId:leg.legId,observedAt:ctx.fixtures.at({seconds:1})};return requireStatus(await ctx.scanShipment(index%2?api.baseUrl:second.baseUrl,body,{key:ctx.key(`pickup-${index}`)}),200,"setup pickup");});
    await waitWorkDrain(ctx,api.baseUrl,"JOURNEY_PROJECT",{processes:setupWorkers,timeoutMs:180_000});await Promise.all(setupWorkers.map((worker)=>ctx.stop(worker)));
    await ctx.concurrent(graph.shipments,64,(shipment,index)=>ctx.lossShipment(index%2?api.baseUrl:second.baseUrl,shipment.shipmentId,{reason:"recovery-load",observedAt:ctx.fixtures.at({seconds:2})},{key:ctx.key(`loss-${index}`)}).then((response)=>requireStatus(response,200,"recovery loss")));
    const claimedIds=new Set(),barrier=await ctx.workerBarrier(({workId})=>{if(claimedIds.size>=contract.killedWorkers||claimedIds.has(workId))return false;claimedIds.add(workId);return true;}),doomed=await Promise.all(Array.from({length:contract.killedWorkers},()=>ctx.startWorkerAtBarrier(barrier)));
    await ctx.waitFor(()=>barrier.ledger.filter(({released})=>!released).length===contract.killedWorkers?true:undefined,{label:"two claimed recovery workers",processes:doomed,timeoutMs:30_000});await Promise.all(doomed.map((worker)=>ctx.kill(worker)));
    const lost=await snapshot(ctx,api.baseUrl),lossByShipment=new Map(lost.resources.lossCases.filter(({state})=>state==="OPEN").map((item)=>[item.shipmentId,item]));ctx.equal("one open LossCase per shipment",lossByShipment.size,contract.shipmentCount,JOURNEY_CAP);
    const resolutions=await ctx.concurrent(graph.shipments,64,async(shipment,index)=>index%2===0?ctx.foundShipment(index%2?api.baseUrl:second.baseUrl,shipment.shipmentId,{observedAt:ctx.fixtures.at({seconds:3})},{key:ctx.key(`found-${index}`)}):ctx.reassignShipment(index%2?api.baseUrl:second.baseUrl,shipment.shipmentId,{lossCaseId:lossByShipment.get(shipment.shipmentId).lossCaseId,expectedRoutePlanRevision:1,reason:"recovery-reroute",legs:[{fromHubId:graph.base.hubs[0].hubId,toHubId:graph.base.hubs.at(-1).hubId,carrierId:graph.base.carriers[0].carrierId}]},{key:ctx.key(`reassign-${index}`)}));
    ctx.equal("all recovery resolutions commit",new Set(resolutions.map(({status})=>status)),new Set([200]),JOURNEY_CAP);
    const stale=await ctx.concurrent(graph.shipments.filter((_item,index)=>index%2===1),64,async(shipment,index)=>{const originalIndex=index*2+1,leg=graph.transportLegs[originalIndex*2],body={tenantId:graph.base.tenantId,shipmentId:shipment.shipmentId,scannerEventId:`stale-old-plan-${originalIndex}`,type:"ARRIVED",routePlanRevision:1,hubId:leg.toHubId,legId:leg.legId,observedAt:ctx.fixtures.at({seconds:4})};return ctx.scanShipment(index%2?api.baseUrl:second.baseUrl,body,{key:ctx.key(`stale-${originalIndex}`)});});
    ctx.ok("old-plan evidence is accepted or rejected only by the published revision fence",stale.every(({status})=>[200,409].includes(status)));
    await waitLeaseExpiry(ctx,lost,claimedIds);const startedAt=performance.now(),replacements=await Promise.all(Array.from({length:contract.replacementWorkers},()=>ctx.startWorker())),{state}=await waitWorkDrain(ctx,api.baseUrl,["JOURNEY_PROJECT","LOSS_RECONCILE"],{processes:replacements,timeoutMs:contract.maximumSeconds*1000}),recoverySeconds=(performance.now()-startedAt)/1000;
    ctx.ok("published recovery deadline",recoverySeconds<=contract.maximumSeconds,`${recoverySeconds.toFixed(2)} > ${contract.maximumSeconds}`,{failureCodeSuffix:"RECOVERY_DEADLINE",hardCapIds:["WORK_RECOVERY_CORRECTNESS"]});
    const routesByShipment=Map.groupBy(state.resources.routePlans,({shipmentId})=>shipmentId),lossesByShipment=Map.groupBy(state.resources.lossCases,({shipmentId})=>shipmentId);
    for(let index=0;index<graph.shipments.length;index+=1){const shipment=graph.shipments[index],projection=projectionFor(state,{shipmentId:shipment.shipmentId}),routes=routesByShipment.get(shipment.shipmentId)??[],losses=lossesByShipment.get(shipment.shipmentId)??[];ctx.equal(`one LossCase ${index}`,losses.length,1,JOURNEY_CAP);ctx.equal(`closed LossCase ${index}`,losses[0].state,index%2===0?"RESOLVED_FOUND":"RESOLVED_REASSIGNED",JOURNEY_CAP);ctx.equal(`route authority ${index}`,projection.routePlanRevision,index%2===0?1:2,JOURNEY_CAP);ctx.equal(`route count ${index}`,routes.length,index%2===0?1:2,JOURNEY_CAP);if(index%2===1)ctx.equal(`old plan cannot move rerouted projection ${index}`,projection.currentHubId,graph.base.hubs[0].hubId,JOURNEY_CAP);}
    for(const workId of claimedIds){const item=state.work.find((work)=>work.workId===workId);ctx.ok(`claimed Work ${workId} recovered`,item?.terminal&&item.attempt>=2,undefined,{failureCodeSuffix:"STALE_WORK",hardCapIds:["WORK_RECOVERY_CORRECTNESS"]});}
    return caseResult(ctx,{shipmentCount:contract.shipmentCount,killedWorkers:doomed.length,replacementWorkers:replacements.length,recoverySeconds,claimedWorkIds:[...claimedIds]});
  },
);

export const E_CASES=Object.freeze([E01,E02,E03,E04]);
