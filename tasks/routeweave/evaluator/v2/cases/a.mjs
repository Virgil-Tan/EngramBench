import assert from "node:assert/strict";

import { aggregateConsignment } from "../lib/oracle.mjs";
import {
  assertNoSecondEffects,assertProjectionMatches,boot,caseResult,consignmentFor,createConsignment,
  defineCase,expectError,pieceFor,projectionFor,requireStatus,resource,routeFromSnapshot,
  shipmentReplayFromSnapshot,snapshot,stableSnapshot,waitForState,waitWorkDrain,
} from "./helpers.mjs";

const JOURNEY_CAP={failureCodeSuffix:"JOURNEY_CORRECTNESS",hardCapIds:["JOURNEY_CORRECTNESS"]};

async function submitShipmentScan(ctx,url,body,key){
  return requireStatus(await ctx.scanShipment(url,body,{key:key??ctx.key(body.scannerEventId)}),200,body.type);
}

async function submitPieceSequence(ctx,url,pieceId,catalog,label,types){
  const responses=[];
  for(const [index,type] of types.entries()){
    const legIndex=Math.min(Math.floor(Math.max(0,index-1)/2),catalog.legs.length-1);
    const body=ctx.pieceScanBody(catalog,type,legIndex,{scannerEventId:`${pieceId}:${label}:${index}`,observedAt:ctx.fixtures.at({seconds:index+1})});
    responses.push(await ctx.scanPiece(url,pieceId,body,{key:ctx.key(`${label}-${index}`)}));
    requireStatus(responses.at(-1),200,`${label} ${type}`);
  }
  return responses;
}

const A01=defineCase(
  "A-01",
  "same-time shuffled shipment evidence with loss and found boundaries",
  "submit immutable scan, loss and found mutations through the public API then drain projection Work",
  "independently sort the committed scan ledger and compare every published JourneyProjection member",
  ["seed-command","public-http","shipment-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"total-order"}),{api}=await boot(ctx,{catalog});
    const workers=await Promise.all([ctx.startWorker(),ctx.startWorker()]);
    const at=ctx.fixtures.at({seconds:10}),leg=catalog.legs[0];
    const bodies=[
      ctx.scanBody(catalog,"ARRIVED",0,{observedAt:at,scannerEventId:"same-arrived"}),
      ctx.scanBody(catalog,"DEPARTED",0,{observedAt:at,scannerEventId:"same-departed"}),
      ctx.scanBody(catalog,"PICKED_UP",0,{observedAt:at,scannerEventId:"same-picked-up"}),
    ];
    for(const body of bodies)await submitShipmentScan(ctx,api.baseUrl,body);
    requireStatus(await ctx.lossShipment(api.baseUrl,catalog.shipment.shipmentId,{reason:"sorting-boundary",observedAt:at},{key:ctx.key("loss")}),200,"loss");
    requireStatus(await ctx.foundShipment(api.baseUrl,catalog.shipment.shipmentId,{observedAt:at},{key:ctx.key("found")}),200,"found");
    await submitShipmentScan(ctx,api.baseUrl,ctx.scanBody(catalog,"DEPARTED",1,{observedAt:ctx.fixtures.at({seconds:11}),scannerEventId:"leg-2-departed"}));
    await submitShipmentScan(ctx,api.baseUrl,ctx.scanBody(catalog,"ARRIVED",1,{observedAt:ctx.fixtures.at({seconds:12}),scannerEventId:"leg-2-arrived"}));
    await submitShipmentScan(ctx,api.baseUrl,ctx.scanBody(catalog,"DELIVERED",1,{observedAt:ctx.fixtures.at({seconds:13}),scannerEventId:"delivered"}));
    const{state}=await waitWorkDrain(ctx,api.baseUrl,["JOURNEY_PROJECT","LOSS_RECONCILE"],{processes:workers,timeoutMs:60_000});
    const actual=projectionFor(state,{shipmentId:catalog.shipment.shipmentId}),expected=shipmentReplayFromSnapshot(state,catalog);
    assertProjectionMatches(ctx,actual,expected,JOURNEY_CAP);
    ctx.equal("all eight immutable evidence records retained",state.resources.scanEvents.filter(({shipmentId})=>shipmentId===catalog.shipment.shipmentId).length,8,JOURNEY_CAP);
    ctx.equal("final route destination",actual.currentHubId,catalog.hubs.at(-1).hubId,JOURNEY_CAP);
    ctx.equal("terminal state",actual.state,"DELIVERED",JOURNEY_CAP);
    return caseResult(ctx,{shipmentId:catalog.shipment.shipmentId,projection:actual,workerCount:workers.length,firstLegId:leg.legId});
  },
);

const A02=defineCase(
  "A-02",
  "four-leg shipment with premature, wrong-hub and post-terminal evidence",
  "ingest dependency-breaking evidence and a valid completion only through the shipment scan endpoint",
  "verify contiguous leg authority, immutable evidence and an irreversible terminal projection",
  ["seed-command","shipment-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:4,label:"dependency"}),{api}=await boot(ctx,{catalog}),worker=await ctx.startWorker();
    await submitShipmentScan(ctx,api.baseUrl,ctx.scanBody(catalog,"ARRIVED",2,{scannerEventId:"premature-leg-three",observedAt:ctx.fixtures.at({seconds:1})}));
    const wrong=ctx.scanBody(catalog,"DEPARTED",0,{scannerEventId:"wrong-hub",hubId:catalog.hubs.at(-1).hubId,observedAt:ctx.fixtures.at({seconds:2})});
    expectError(ctx,await ctx.scanShipment(api.baseUrl,wrong,{key:ctx.key("wrong-hub")}),400,"INVALID_SCAN",JOURNEY_CAP);
    const before=await waitForState(ctx,api.baseUrl,(state)=>projectionFor(state,{shipmentId:catalog.shipment.shipmentId}),(value)=>value?.projectionVersion>=1,{processes:[worker]});
    ctx.equal("premature evidence cannot skip legs",before.selected.currentLegId,catalog.legs[0].legId,JOURNEY_CAP);
    const sequence=[];
    sequence.push(ctx.scanBody(catalog,"PICKED_UP",0,{scannerEventId:"ordered-pickup",observedAt:ctx.fixtures.at({seconds:3})}));
    for(let index=0;index<catalog.legs.length;index+=1){
      sequence.push(ctx.scanBody(catalog,"DEPARTED",index,{scannerEventId:`ordered-depart-${index}`,observedAt:ctx.fixtures.at({seconds:4+index*2})}));
      sequence.push(ctx.scanBody(catalog,"ARRIVED",index,{scannerEventId:`ordered-arrive-${index}`,observedAt:ctx.fixtures.at({seconds:5+index*2})}));
    }
    sequence.push(ctx.scanBody(catalog,"DELIVERED",3,{scannerEventId:"ordered-deliver",observedAt:ctx.fixtures.at({seconds:20})}));
    for(const body of sequence)await submitShipmentScan(ctx,api.baseUrl,body);
    const terminal=(await waitForState(ctx,api.baseUrl,(state)=>projectionFor(state,{shipmentId:catalog.shipment.shipmentId}),(value)=>value?.state==="DELIVERED",{processes:[worker],timeoutMs:60_000})).state;
    const projectionBefore=projectionFor(terminal,{shipmentId:catalog.shipment.shipmentId});
    await submitShipmentScan(ctx,api.baseUrl,ctx.scanBody(catalog,"ARRIVED",0,{scannerEventId:"late-old-arrival",observedAt:ctx.fixtures.at({seconds:6})}));
    await waitWorkDrain(ctx,api.baseUrl,"JOURNEY_PROJECT",{processes:[worker]});
    const after=await snapshot(ctx,api.baseUrl),projectionAfter=projectionFor(after,{shipmentId:catalog.shipment.shipmentId});
    ctx.equal("terminal projection cannot regress",projectionAfter,projectionBefore,JOURNEY_CAP);
    ctx.equal("wrong-hub rejection has no evidence",after.resources.scanEvents.some(({scannerEventId})=>scannerEventId==="wrong-hub"),false,JOURNEY_CAP);
    return caseResult(ctx,{shipmentId:catalog.shipment.shipmentId,state:projectionAfter.state,evidenceCount:after.resources.scanEvents.length});
  },
);

function combinedSeed(ctx,catalogs,seedVersion){
  return ctx.seedFor(seedVersion,{
    catalog:catalogs[0],tenants:catalogs.map(({tenant})=>tenant),hubs:catalogs.flatMap(({hubs})=>hubs),carriers:catalogs.flatMap(({carriers})=>carriers),
    shipments:catalogs.map(({shipment})=>shipment),routePlans:catalogs.map(({routePlan})=>routePlan),transportLegs:catalogs.flatMap(({legs})=>legs),journeyProjections:catalogs.map(({projection})=>projection),
  });
}

const A03=defineCase(
  "A-03",
  "target and sentinel shipments across loss, found, reassignment and old-revision evidence",
  "mutate one shipment through published loss, found and reassignment APIs while scanning both authorities",
  "prove target-only loss closure and a revision fence that preserves but cannot apply stale evidence",
  ["seed-command","public-http","shipment-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const target=ctx.catalog({legCount:2,label:"loss-target"}),sentinel=ctx.catalog({legCount:2,label:"loss-sentinel"});
    const{api}=await boot(ctx,{catalog:target,seed:combinedSeed(ctx,[target,sentinel],"a03-target-sentinel")}),workers=await Promise.all([ctx.startWorker(),ctx.startWorker()]);
    await submitShipmentScan(ctx,api.baseUrl,ctx.scanBody(target,"PICKED_UP",0,{scannerEventId:"target-picked"}));
    await submitShipmentScan(ctx,api.baseUrl,ctx.scanBody(sentinel,"PICKED_UP",0,{scannerEventId:"sentinel-picked"}));
    requireStatus(await ctx.lossShipment(api.baseUrl,target.shipment.shipmentId,{reason:"missing",observedAt:ctx.fixtures.at({seconds:3})},{key:ctx.key("target-loss")}),200,"target loss");
    let state=(await waitForState(ctx,api.baseUrl,(value)=>value,(value)=>projectionFor(value,{shipmentId:target.shipment.shipmentId})?.state==="LOST",{processes:workers})).state;
    ctx.equal("sentinel remains in transit",projectionFor(state,{shipmentId:sentinel.shipment.shipmentId}).state,"IN_TRANSIT",JOURNEY_CAP);
    requireStatus(await ctx.foundShipment(api.baseUrl,target.shipment.shipmentId,{observedAt:ctx.fixtures.at({seconds:4})},{key:ctx.key("target-found")}),200,"target found");
    const reassignBody={lossCaseId:resource(state,"lossCases","shipmentId",target.shipment.shipmentId).lossCaseId,expectedRoutePlanRevision:1,reason:"network-change",legs:[{fromHubId:target.hubs[0].hubId,toHubId:target.hubs.at(-1).hubId,carrierId:target.carriers[0].carrierId}]};
    requireStatus(await ctx.lossShipment(api.baseUrl,target.shipment.shipmentId,{reason:"missing-again",observedAt:ctx.fixtures.at({seconds:5})},{key:ctx.key("target-loss-two")}),200,"second target loss");
    state=(await waitForState(ctx,api.baseUrl,(value)=>value,(value)=>value.resources.lossCases.some(({shipmentId,state:lossState})=>shipmentId===target.shipment.shipmentId&&lossState==="OPEN"),{processes:workers})).state;
    reassignBody.lossCaseId=state.resources.lossCases.find(({shipmentId,state:lossState})=>shipmentId===target.shipment.shipmentId&&lossState==="OPEN").lossCaseId;
    requireStatus(await ctx.reassignShipment(api.baseUrl,target.shipment.shipmentId,reassignBody,{key:ctx.key("target-reassign")}),200,"target reassignment");
    await submitShipmentScan(ctx,api.baseUrl,ctx.scanBody(target,"ARRIVED",0,{scannerEventId:"stale-old-revision",routePlanRevision:1,observedAt:ctx.fixtures.at({seconds:99})}));
    await waitWorkDrain(ctx,api.baseUrl,["JOURNEY_PROJECT","LOSS_RECONCILE"],{processes:workers,timeoutMs:60_000});
    const after=await snapshot(ctx,api.baseUrl),targetProjection=projectionFor(after,{shipmentId:target.shipment.shipmentId}),sentinelProjection=projectionFor(after,{shipmentId:sentinel.shipment.shipmentId});
    ctx.equal("reassignment advances route revision",targetProjection.routePlanRevision,2,JOURNEY_CAP);
    ctx.equal("stale scan remains immutable evidence",after.resources.scanEvents.filter(({scannerEventId})=>scannerEventId==="stale-old-revision").length,1,JOURNEY_CAP);
    ctx.equal("stale scan cannot cross revision fence",targetProjection.currentHubId,target.hubs[0].hubId,JOURNEY_CAP);
    ctx.equal("sentinel route revision unchanged",sentinelProjection.routePlanRevision,1,JOURNEY_CAP);
    return caseResult(ctx,{targetShipmentId:target.shipment.shipmentId,sentinelShipmentId:sentinel.shipment.shipmentId,targetRevision:targetProjection.routePlanRevision});
  },
);

const A04=defineCase(
  "A-04",
  "one, one-hundred and invalid Consignment piece sets on one frozen route",
  "create Consignments through the Manager API and compare replay identities and durable snapshots",
  "verify transaction-wide piece uniqueness, one shared revision and zero partial state for every rejected graph",
  ["seed-command","public-http","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:3,label:"consignment-create"}),{api}=await boot(ctx,{catalog}),before=stableSnapshot(await snapshot(ctx,api.baseUrl));
    const invalid=[
      ctx.consignmentBody(catalog,2,{pieceRefs:["duplicate","duplicate"]}),
      ctx.consignmentBody(catalog,101),
      ctx.consignmentBody(catalog,2,{legs:[{fromHubId:catalog.hubs[0].hubId,toHubId:catalog.hubs[1].hubId,carrierId:catalog.carriers[0].carrierId},{fromHubId:catalog.hubs[2].hubId,toHubId:catalog.hubs[3].hubId,carrierId:catalog.carriers[0].carrierId}]})
    ];
    const invalidOutcomes=[[409,"PIECE_REF_CONFLICT"],[400,"INVALID_REQUEST"],[400,"INVALID_ROUTE_PLAN"]];
    for(const [index,body] of invalid.entries()){const[status,code]=invalidOutcomes[index];expectError(ctx,await ctx.createConsignment(api.baseUrl,body,{key:ctx.key(`invalid-${index}`)}),status,code,JOURNEY_CAP);}
    ctx.equal("invalid Consignments leave no durable effects",stableSnapshot(await snapshot(ctx,api.baseUrl)),before,JOURNEY_CAP);
    const one=await createConsignment(ctx,api.baseUrl,catalog,1,{key:ctx.key("one"),bodyOverrides:{externalRef:"A04-ONE"}}),hundredKey=ctx.key("hundred"),hundred=await createConsignment(ctx,api.baseUrl,catalog,100,{key:hundredKey,bodyOverrides:{externalRef:"A04-HUNDRED"}});
    const replay=await ctx.createConsignment(api.baseUrl,ctx.consignmentBody(catalog,100,{externalRef:"A04-HUNDRED"}),{key:hundredKey});
    requireStatus(replay,200,"Consignment replay");
    ctx.equal("replay body preserves all identities",replay.json,hundred,JOURNEY_CAP);
    const after=await snapshot(ctx,api.baseUrl);
    for(const created of[one,hundred]){
      ctx.equal("all pieces share Consignment",new Set(created.pieces.map(({consignmentId})=>consignmentId)),new Set([created.consignment.consignmentId]),JOURNEY_CAP);
      ctx.equal("piece IDs are unique",new Set(created.pieces.map(({pieceId})=>pieceId)).size,created.pieces.length,JOURNEY_CAP);
      ctx.equal("one shared route revision",created.consignment.routePlanRevision,1,JOURNEY_CAP);
      ctx.equal("one Consignment project Work",after.work.filter(({kind,aggregateId})=>kind==="CONSIGNMENT_PROJECT"&&aggregateId===created.consignment.consignmentId).length,1,JOURNEY_CAP);
    }
    return caseResult(ctx,{consignmentIds:[one.consignment.consignmentId,hundred.consignment.consignmentId],pieceCounts:[one.pieces.length,hundred.pieces.length]});
  },
);

const A05=defineCase(
  "A-05",
  "three independently projected pieces with delivered, in-transit and loss outcomes",
  "drive per-piece scans and one shared reassignment through production workers and public APIs",
  "recompute aggregate state from every piece and require one atomic revision for the nonterminal cohort",
  ["seed-command","piece-scan","public-http","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"aggregate"}),{api}=await boot(ctx,{catalog}),workers=await Promise.all([ctx.startWorker(),ctx.startWorker()]);
    const created=await createConsignment(ctx,api.baseUrl,catalog,3,{key:ctx.key("aggregate-consignment")}),initial=await snapshot(ctx,api.baseUrl),route=routeFromSnapshot(catalog,initial,created.consignment.routePlanId,created.consignment.routePlanRevision);
    await submitPieceSequence(ctx,api.baseUrl,created.pieces[0].pieceId,route,"delivered",["PICKED_UP","DEPARTED","ARRIVED","DEPARTED","ARRIVED","DELIVERED"]);
    await submitPieceSequence(ctx,api.baseUrl,created.pieces[1].pieceId,route,"moving",["PICKED_UP","DEPARTED"]);
    requireStatus(await ctx.lossPiece(api.baseUrl,created.pieces[2].pieceId,{reason:"piece-missing",observedAt:ctx.fixtures.at({seconds:20})},{key:ctx.key("piece-loss")}),200,"piece loss");
    let state=(await waitForState(ctx,api.baseUrl,(value)=>value,(value)=>created.pieces.every(({pieceId})=>pieceFor(value,pieceId)?.state!=="PLANNED"),{processes:workers,timeoutMs:60_000})).state;
    const pieceStates=created.pieces.map(({pieceId})=>pieceFor(state,pieceId).state),aggregate=consignmentFor(state,created.consignment.consignmentId);
    ctx.equal("aggregate is independently recomputed",aggregate.state,aggregateConsignment(pieceStates),JOURNEY_CAP);
    ctx.equal("mixed delivered and lost is exception",aggregate.state,"EXCEPTION",JOURNEY_CAP);
    const terminalBefore=pieceFor(state,created.pieces[0].pieceId),newLegs=[{fromHubId:catalog.hubs[0].hubId,toHubId:catalog.hubs.at(-1).hubId,carrierId:catalog.carriers[0].carrierId}];
    requireStatus(await ctx.reassignConsignment(api.baseUrl,created.consignment.consignmentId,{reason:"shared-recovery",expectedRoutePlanRevision:1,legs:newLegs},{key:ctx.key("shared-reassign")}),200,"shared reassignment");
    await waitWorkDrain(ctx,api.baseUrl,"CONSIGNMENT_PROJECT",{processes:workers,timeoutMs:60_000});
    state=await snapshot(ctx,api.baseUrl);const current=consignmentFor(state,created.consignment.consignmentId),nonterminal=created.pieces.slice(1).map(({pieceId})=>projectionFor(state,{pieceId}));
    ctx.equal("shared reassignment advances exactly one revision",current.routePlanRevision,2,JOURNEY_CAP);
    ctx.equal("all eligible pieces share the new revision",new Set(nonterminal.map(({routePlanRevision})=>routePlanRevision)),new Set([2]),JOURNEY_CAP);
    ctx.equal("terminal piece state remains immutable",pieceFor(state,created.pieces[0].pieceId),terminalBefore,JOURNEY_CAP);
    ctx.equal("aggregate remains member-derived",current.state,aggregateConsignment(created.pieces.map(({pieceId})=>pieceFor(state,pieceId).state)),JOURNEY_CAP);
    assertNoSecondEffects(ctx,initial,state,{otherShipments:(value)=>value.resources.shipments.length},{failureCodeSuffix:"FOREIGN_SIDE_EFFECT",hardCapIds:["JOURNEY_CORRECTNESS"]});
    return caseResult(ctx,{consignmentId:created.consignment.consignmentId,states:created.pieces.map(({pieceId})=>pieceFor(state,pieceId).state),revision:current.routePlanRevision});
  },
);

export const A_CASES=Object.freeze([A01,A02,A03,A04,A05]);
