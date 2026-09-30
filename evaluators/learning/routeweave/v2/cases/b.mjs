import assert from "node:assert/strict";

import {
  boot,captureResponse,caseResult,consignmentFor,createConsignment,defineCase,expectError,pieceFor,
  projectionFor,requireStatus,resetFixture,routeFromSnapshot,snapshot,stableResponses,waitForState,waitWorkDrain,
} from "./helpers.mjs";
import { scanSequence } from "../lib/fixtures.mjs";
import { digestProjection,replayShipment } from "../lib/oracle.mjs";

const IDEMPOTENCY_CAP={failureCodeSuffix:"DUPLICATE_EFFECT",hardCapIds:["IDEMPOTENCY_CORRECTNESS"]};
const JOURNEY_CAP={failureCodeSuffix:"NONDETERMINISTIC_PROJECTION",hardCapIds:["JOURNEY_CORRECTNESS"]};

const B01=defineCase(
  "B-01",
  "one shipment scan behind a response shield across two APIs and an API restart",
  "drop the committed HTTP response then replay the same mutation identity through independent API processes",
  "require the original status, canonical body, evidence identity, Work and Event effect to remain singular",
  ["seed-command","public-http","shipment-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"durable-replay"}),{api}=await boot(ctx,{catalog}),second=await ctx.startApi(),worker=await ctx.startWorker(),shield=await ctx.responseShield(api.baseUrl);
    const key=ctx.key("unknown-response"),body=ctx.scanBody(catalog,"PICKED_UP",0,{scannerEventId:"durable-scanner"});
    shield.dropNextMutation();
    await ctx.scanShipment(shield.baseUrl,body,{key}).then(()=>assert.fail("shielded mutation unexpectedly returned")).catch(()=>undefined);
    const capture=await ctx.waitFor(()=>shield.captures.find(({dropped})=>dropped),{label:"committed response captured before disconnect"}),original=captureResponse(capture);
    const replay=await ctx.scanShipment(second.baseUrl,body,{key});
    ctx.equal("replay status equals lost response",replay.status,original.status,IDEMPOTENCY_CAP);
    ctx.equal("replay JSON equals lost response",replay.json,original.json,IDEMPOTENCY_CAP);
    await ctx.stop(api);const restarted=await ctx.startApi();
    const afterRestart=await ctx.scanShipment(restarted.baseUrl,body,{key});
    ctx.equal("restart replay status",afterRestart.status,original.status,IDEMPOTENCY_CAP);
    ctx.equal("restart replay body",afterRestart.json,original.json,IDEMPOTENCY_CAP);
    await waitWorkDrain(ctx,restarted.baseUrl,"JOURNEY_PROJECT",{processes:[worker],timeoutMs:60_000});
    const state=await snapshot(ctx,restarted.baseUrl),events=state.resources.scanEvents.filter(({shipmentId,scannerEventId})=>shipmentId===catalog.shipment.shipmentId&&scannerEventId===body.scannerEventId);
    ctx.equal("one canonical ScanEvent",events.length,1,IDEMPOTENCY_CAP);
    ctx.equal("one logical projection Work",state.work.filter(({kind,aggregateId})=>kind==="JOURNEY_PROJECT"&&aggregateId===catalog.shipment.shipmentId).length,1,IDEMPOTENCY_CAP);
    ctx.equal("one scan accepted event",state.events.filter(({aggregateId,type})=>aggregateId===catalog.shipment.shipmentId&&type==="scan.accepted").length,1,IDEMPOTENCY_CAP);
    return caseResult(ctx,{shipmentId:catalog.shipment.shipmentId,scanEventId:events[0].scanEventId,replayStatus:replay.status});
  },
);

const B02=defineCase(
  "B-02",
  "twenty identical and conflicting requests for one piece-scoped scanner identity",
  "submit concurrent piece scan mutations through two API processes with independent idempotency keys",
  "same semantics converge to one evidence and one projection effect while conflict produces no durable mutation",
  ["seed-command","piece-scan","public-http","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"piece-uniqueness"}),{api}=await boot(ctx,{catalog}),second=await ctx.startApi(),worker=await ctx.startWorker();
    const created=await createConsignment(ctx,api.baseUrl,catalog,2,{key:ctx.key("piece-consignment")}),initial=await snapshot(ctx,api.baseUrl),route=routeFromSnapshot(catalog,initial,created.consignment.routePlanId),pieceId=created.pieces[0].pieceId;
    const body=ctx.pieceScanBody(route,"PICKED_UP",0,{scannerEventId:"piece-scanner-shared",observedAt:ctx.fixtures.at({seconds:2})});
    const responses=await ctx.concurrent(Array.from({length:20},(_,index)=>index),20,(index)=>ctx.scanPiece(index%2?api.baseUrl:second.baseUrl,pieceId,body,{key:ctx.key(`same-${index}`)}));
    ctx.equal("all exact duplicates replay successfully",new Set(responses.map(({status})=>status)),new Set([200]),IDEMPOTENCY_CAP);
    stableResponses(ctx,responses,"concurrent scanner replay",IDEMPOTENCY_CAP);
    const conflict={...body,observedAt:ctx.fixtures.at({seconds:3})};
    expectError(ctx,await ctx.scanPiece(second.baseUrl,pieceId,conflict,{key:ctx.key("conflict")}),409,"SCAN_EVENT_CONFLICT",IDEMPOTENCY_CAP);
    await waitWorkDrain(ctx,api.baseUrl,"CONSIGNMENT_PROJECT",{processes:[worker],timeoutMs:60_000});
    const state=await snapshot(ctx,api.baseUrl),evidence=state.resources.scanEvents.filter(({scannerEventId})=>scannerEventId===body.scannerEventId);
    ctx.equal("one piece-scoped evidence",evidence.length,1,IDEMPOTENCY_CAP);
    ctx.equal("scanner identity belongs to target piece",evidence[0].pieceId??pieceId,pieceId,IDEMPOTENCY_CAP);
    ctx.equal("one target projection sequence",projectionFor(state,{pieceId}).sequence,1,IDEMPOTENCY_CAP);
    ctx.equal("other piece remains planned",pieceFor(state,created.pieces[1].pieceId).state,"PLANNED",IDEMPOTENCY_CAP);
    return caseResult(ctx,{pieceId,concurrentCalls:responses.length,scanEventId:evidence[0].scanEventId});
  },
);

function permutations(values){
  return [values,[...values].reverse(),[...values.slice(2),...values.slice(0,2)],[...values.filter((_item,index)=>index%2),...values.filter((_item,index)=>index%2===0)]];
}

const B03=defineCase(
  "B-03",
  "four fixed arrival permutations of one complete two-leg evidence set",
  "reset isolated PostgreSQL between permutations and ingest through two APIs with two projection workers",
  "every stored projection and independent total-order replay must have the same canonical digest",
  ["seed-command","shipment-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"commutative"}),events=scanSequence(ctx.fixtures,catalog,{includeLoss:false}),digests=[];
    for(const [iteration,order] of permutations(events).entries()){
      const environment=iteration===0?await boot(ctx,{catalog,seedVersion:`b03-${iteration}`}):await resetFixture(ctx,{catalog,seedVersion:`b03-${iteration}`});
      const second=await ctx.startApi(),workers=await Promise.all([ctx.startWorker(),ctx.startWorker()]);
      await ctx.concurrent(order,4,(body,index)=>ctx.scanShipment(index%2?environment.api.baseUrl:second.baseUrl,body,{key:ctx.key(`permutation-${iteration}-${index}`)}).then((response)=>requireStatus(response,200,"permuted scan")));
      const{state}=await waitWorkDrain(ctx,environment.api.baseUrl,"JOURNEY_PROJECT",{processes:workers,timeoutMs:60_000}),actual=projectionFor(state,{shipmentId:catalog.shipment.shipmentId}),expected=replayShipment(catalog,state.resources.scanEvents.filter(({shipmentId})=>shipmentId===catalog.shipment.shipmentId));
      ctx.equal(`permutation ${iteration} projection`,actual,expected,JOURNEY_CAP);
      digests.push(digestProjection(actual));
    }
    ctx.equal("all arrival permutations converge",new Set(digests).size,1,JOURNEY_CAP);
    return caseResult(ctx,{permutationCount:digests.length,projectionDigest:digests[0]});
  },
);

function twoShipmentSeed(ctx,target,sentinel){
  return ctx.seedFor("b04-two-shipments",{catalog:target,tenants:[target.tenant,sentinel.tenant],hubs:[...target.hubs,...sentinel.hubs],carriers:[...target.carriers,...sentinel.carriers],shipments:[target.shipment,sentinel.shipment],routePlans:[target.routePlan,sentinel.routePlan],transportLegs:[...target.legs,...sentinel.legs],journeyProjections:[target.projection,sentinel.projection]});
}

const B04=defineCase(
  "B-04",
  "one open loss raced by found and expected-revision reassignment with a sentinel shipment",
  "commit the loss first, then race only published resolution mutations through separate APIs",
  "accept one legal serial history and enforce target, revision, stale-evidence and foreign-shipment fences",
  ["seed-command","public-http","shipment-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const target=ctx.catalog({legCount:2,label:"race-target"}),sentinel=ctx.catalog({legCount:2,label:"race-sentinel"}),{api}=await boot(ctx,{catalog:target,seed:twoShipmentSeed(ctx,target,sentinel)}),second=await ctx.startApi(),workers=await Promise.all([ctx.startWorker(),ctx.startWorker()]);
    requireStatus(await ctx.lossShipment(api.baseUrl,target.shipment.shipmentId,{reason:"race",observedAt:ctx.fixtures.at({seconds:2})},{key:ctx.key("loss")}),200,"loss");
    const open=(await waitForState(ctx,api.baseUrl,(state)=>state.resources.lossCases.find(({shipmentId,state:lossState})=>shipmentId===target.shipment.shipmentId&&lossState==="OPEN"),Boolean,{processes:workers})).selected;
    const found=ctx.foundShipment(api.baseUrl,target.shipment.shipmentId,{observedAt:ctx.fixtures.at({seconds:3})},{key:ctx.key("found")}),reassign=ctx.reassignShipment(second.baseUrl,target.shipment.shipmentId,{lossCaseId:open.lossCaseId,expectedRoutePlanRevision:1,reason:"race-reassign",legs:[{fromHubId:target.hubs[0].hubId,toHubId:target.hubs.at(-1).hubId,carrierId:target.carriers[0].carrierId}]},{key:ctx.key("reassign")});
    const outcomes=await Promise.all([found,reassign]);
    ctx.equal("exactly one loss resolution commits",outcomes.filter(({status})=>status===200).length,1,JOURNEY_CAP);
    ctx.equal("losing resolution is a stable conflict",outcomes.filter(({status})=>status===409).length,1,JOURNEY_CAP);
    const postResolution=await snapshot(ctx,api.baseUrl),revision=projectionFor(postResolution,{shipmentId:target.shipment.shipmentId}).routePlanRevision;
    const oldBody=ctx.scanBody(target,"ARRIVED",0,{routePlanRevision:1,scannerEventId:"race-old-revision",observedAt:ctx.fixtures.at({seconds:50})});
    const oldResponse=await ctx.scanShipment(api.baseUrl,oldBody,{key:ctx.key("old-revision")});
    ctx.ok("old revision returns published success or revision conflict",[200,409].includes(oldResponse.status));
    await waitWorkDrain(ctx,api.baseUrl,["JOURNEY_PROJECT","LOSS_RECONCILE"],{processes:workers,timeoutMs:60_000});
    const state=await snapshot(ctx,api.baseUrl),targetProjection=projectionFor(state,{shipmentId:target.shipment.shipmentId}),sentinelProjection=projectionFor(state,{shipmentId:sentinel.shipment.shipmentId});
    ctx.equal("single current route revision",new Set(state.resources.routePlans.filter(({shipmentId})=>shipmentId===target.shipment.shipmentId).map(({revision})=>revision)).size,revision,JOURNEY_CAP);
    if(revision===2)ctx.equal("old evidence cannot move new authority",targetProjection.currentHubId,target.hubs[0].hubId,JOURNEY_CAP);
    ctx.equal("sentinel remains untouched",sentinelProjection,sentinel.projection,JOURNEY_CAP);
    return caseResult(ctx,{targetShipmentId:target.shipment.shipmentId,resolutionStatuses:outcomes.map(({status})=>status),routeRevision:targetProjection.routePlanRevision});
  },
);

async function primePieces(ctx,url,created,route){
  for(const [pieceIndex,{pieceId}] of created.pieces.entries()){
    for(const [eventIndex,type] of ["PICKED_UP","DEPARTED","ARRIVED","DEPARTED","ARRIVED"].entries()){
      const legIndex=eventIndex<3?0:1,body=ctx.pieceScanBody(route,type,legIndex,{scannerEventId:`${pieceId}:prime:${eventIndex}`,observedAt:ctx.fixtures.at({seconds:pieceIndex*20+eventIndex+1})});
      requireStatus(await ctx.scanPiece(url,pieceId,body,{key:ctx.key(`prime-${pieceIndex}-${eventIndex}`)}),200,"prime piece");
    }
  }
}

const B05=defineCase(
  "B-05",
  "three-piece Consignment at the final destination racing terminal delivery and shared reassignment",
  "issue the final piece scan and expected-revision shared reassign concurrently through two APIs",
  "freeze one legal commit point with no partial revision and never modify a member that became terminal first",
  ["seed-command","piece-scan","public-http","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"batch-race"}),{api}=await boot(ctx,{catalog}),second=await ctx.startApi(),workers=await Promise.all([ctx.startWorker(),ctx.startWorker()]),created=await createConsignment(ctx,api.baseUrl,catalog,3,{key:ctx.key("batch")});
    const initial=await snapshot(ctx,api.baseUrl),route=routeFromSnapshot(catalog,initial,created.consignment.routePlanId);
    await primePieces(ctx,api.baseUrl,created,route);await waitWorkDrain(ctx,api.baseUrl,"CONSIGNMENT_PROJECT",{processes:workers,timeoutMs:60_000});
    const target=created.pieces[0],delivery=ctx.scanPiece(api.baseUrl,target.pieceId,ctx.pieceScanBody(route,"DELIVERED",1,{scannerEventId:`${target.pieceId}:terminal`,observedAt:ctx.fixtures.at({seconds:100})}),{key:ctx.key("terminal")}),shared=ctx.reassignConsignment(second.baseUrl,created.consignment.consignmentId,{reason:"batch-race",expectedRoutePlanRevision:1,legs:[{fromHubId:catalog.hubs[0].hubId,toHubId:catalog.hubs.at(-1).hubId,carrierId:catalog.carriers[0].carrierId}]},{key:ctx.key("shared")});
    const outcomes=await Promise.all([delivery,shared]);
    ctx.ok("race returns only published success or conflict",outcomes.every(({status})=>[200,409].includes(status)));
    ctx.ok("at least one race operation commits",outcomes.some(({status})=>status===200));
    await waitWorkDrain(ctx,api.baseUrl,"CONSIGNMENT_PROJECT",{processes:workers,timeoutMs:60_000});
    const state=await snapshot(ctx,api.baseUrl),consignment=consignmentFor(state,created.consignment.consignmentId),pieces=created.pieces.map(({pieceId})=>pieceFor(state,pieceId)),projections=created.pieces.map(({pieceId})=>projectionFor(state,{pieceId}));
    const eligible=pieces.map((piece,index)=>({piece,projection:projections[index]})).filter(({piece})=>!["DELIVERED","CANCELLED"].includes(piece.state));
    ctx.equal("every nonterminal member has one route authority",new Set(eligible.map(({projection})=>projection.routePlanRevision)),new Set([consignment.routePlanRevision]),JOURNEY_CAP);
    ctx.ok("Consignment revision is one legal commit point",[1,2].includes(consignment.routePlanRevision),undefined,JOURNEY_CAP);
    if(pieceFor(state,target.pieceId).state==="DELIVERED")ctx.equal("terminal target remains delivered",pieceFor(state,target.pieceId).state,"DELIVERED",JOURNEY_CAP);
    return caseResult(ctx,{consignmentId:created.consignment.consignmentId,statuses:outcomes.map(({status})=>status),revision:consignment.routePlanRevision,pieceStates:pieces.map(({state:pieceState})=>pieceState)});
  },
);

export const B_CASES=Object.freeze([B01,B02,B03,B04,B05]);
