import assert from "node:assert/strict";

import { replayShipment } from "../lib/oracle.mjs";
import {
  boot,caseResult,consignmentFor,createConsignment,defineCase,exactEventIdentity,pieceFor,
  projectionFor,requireStatus,routeFromSnapshot,snapshot,waitForState,waitWorkDrain,
} from "./helpers.mjs";

const RECOVERY_CAP={failureCodeSuffix:"WORK_RECOVERY",hardCapIds:["WORK_RECOVERY_CORRECTNESS"]};
const JOURNEY_CAP={failureCodeSuffix:"JOURNEY_RECOVERY",hardCapIds:["JOURNEY_CORRECTNESS"]};

async function waitUntil(ctx,timestamp){
  const delay=Date.parse(timestamp)-Date.now()+100;
  if(delay>0)await ctx.sleep(delay);
}

const C01=defineCase(
  "C-01",
  "one pending Journey projection claimed behind the published worker barrier",
  "kill the lease owner only after worker.claimed and start a replacement after the recorded expiry",
  "the retained Work must be reclaimed, stale ownership fenced and final projection equal full evidence replay",
  ["seed-command","shipment-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"lease-reclaim"}),{api}=await boot(ctx,{catalog});
    const body=ctx.scanBody(catalog,"PICKED_UP",0,{scannerEventId:"claimed-scan"});
    requireStatus(await ctx.scanShipment(api.baseUrl,body,{key:ctx.key("claimed-scan")}),200,"queued scan");
    const barrier=await ctx.workerBarrier(({aggregateId})=>aggregateId===catalog.shipment.shipmentId),doomed=await ctx.startWorkerAtBarrier(barrier);
    const held=await barrier.waitFor(({json,released})=>json?.aggregateId===catalog.shipment.shipmentId&&!released,{timeoutMs:30_000,processes:[doomed]});
    const leased=await snapshot(ctx,api.baseUrl),work=leased.work.find(({workId})=>workId===held.json.workId);
    ctx.equal("claimed Work is retained",work.state,"LEASED",RECOVERY_CAP);
    ctx.equal("claimed Work authority",work.aggregateId,catalog.shipment.shipmentId,RECOVERY_CAP);
    await ctx.kill(doomed);await waitUntil(ctx,work.leaseExpiresAt);
    const replacement=await ctx.startWorker();
    const{state}=await waitWorkDrain(ctx,api.baseUrl,"JOURNEY_PROJECT",{processes:[replacement],timeoutMs:60_000}),recovered=state.work.find(({workId})=>workId===work.workId),actual=projectionFor(state,{shipmentId:catalog.shipment.shipmentId}),expected=replayShipment(catalog,state.resources.scanEvents.filter(({shipmentId})=>shipmentId===catalog.shipment.shipmentId));
    ctx.equal("reclaimed Work is terminal",recovered.terminal,true,RECOVERY_CAP);
    ctx.ok("reclaimed Work records a later attempt",recovered.attempt>=2,undefined,RECOVERY_CAP);
    ctx.equal("recovered projection equals replay",actual,expected,JOURNEY_CAP);
    ctx.equal("stale attempt cannot duplicate projected event",state.events.filter(({aggregateId,type})=>aggregateId===catalog.shipment.shipmentId&&type==="shipment.projected").length,1,RECOVERY_CAP);
    return caseResult(ctx,{workId:work.workId,attempt:recovered.attempt,killedPid:doomed.pid,replacementPid:replacement.pid});
  },
);

function stormSeed(ctx,catalogs){
  return ctx.seedFor("c02-storm",{catalog:catalogs[0],tenants:catalogs.map(({tenant})=>tenant),hubs:catalogs.flatMap(({hubs})=>hubs),carriers:catalogs.flatMap(({carriers})=>carriers),shipments:catalogs.map(({shipment})=>shipment),routePlans:catalogs.map(({routePlan})=>routePlan),transportLegs:catalogs.flatMap(({legs})=>legs),journeyProjections:catalogs.map(({projection})=>projection)});
}

function stormEvents(ctx,catalog){
  const unique=[
    ctx.scanBody(catalog,"PICKED_UP",0,{scannerEventId:`${catalog.shipment.trackingCode}-pickup`,observedAt:ctx.fixtures.at({seconds:1})}),
    ctx.scanBody(catalog,"DEPARTED",0,{scannerEventId:`${catalog.shipment.trackingCode}-depart-1`,observedAt:ctx.fixtures.at({seconds:2})}),
    ctx.scanBody(catalog,"ARRIVED",0,{scannerEventId:`${catalog.shipment.trackingCode}-arrive-1`,observedAt:ctx.fixtures.at({seconds:3})}),
    ctx.scanBody(catalog,"DEPARTED",1,{scannerEventId:`${catalog.shipment.trackingCode}-depart-2`,observedAt:ctx.fixtures.at({seconds:4})}),
    ctx.scanBody(catalog,"ARRIVED",1,{scannerEventId:`${catalog.shipment.trackingCode}-arrive-2`,observedAt:ctx.fixtures.at({seconds:5})}),
    ctx.scanBody(catalog,"DELIVERED",1,{scannerEventId:`${catalog.shipment.trackingCode}-deliver`,observedAt:ctx.fixtures.at({seconds:6})}),
  ];
  return[unique[4],unique[1],unique[4],unique[5],unique[0],unique[3],unique[2]];
}

const C02=defineCase(
  "C-02",
  "one hundred shipments with shuffled full journeys and exact duplicates",
  "ingest through two APIs, kill two claimed workers, then drain with four replacement processes",
  "all evidence remains unique and every terminal projection equals an independent replay after recovery",
  ["seed-command","shipment-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalogs=Array.from({length:100},(_item,index)=>ctx.catalog({legCount:2,label:`storm-${index}`})),{api}=await boot(ctx,{catalog:catalogs[0],seed:stormSeed(ctx,catalogs)}),second=await ctx.startApi(),requests=catalogs.flatMap((catalog)=>stormEvents(ctx,catalog).map((body)=>({catalog,body})));
    await ctx.concurrent(requests,64,({body},index)=>ctx.scanShipment(index%2?api.baseUrl:second.baseUrl,body,{key:ctx.key(`storm-${index}`)}).then((response)=>requireStatus(response,200,"storm scan")));
    const heldWork=new Set(),barrier=await ctx.workerBarrier(({workId})=>{if(heldWork.size>=2||heldWork.has(workId))return false;heldWork.add(workId);return true;}),doomed=await Promise.all([ctx.startWorkerAtBarrier(barrier),ctx.startWorkerAtBarrier(barrier)]);
    await ctx.waitFor(()=>barrier.ledger.filter(({released})=>!released).length>=2?true:undefined,{label:"two independently claimed RouteWeave Work items",processes:doomed,timeoutMs:30_000});
    await Promise.all(doomed.map((worker)=>ctx.kill(worker)));
    const killed=await snapshot(ctx,api.baseUrl),expiry=killed.work.filter(({workId})=>heldWork.has(workId)).map(({leaseExpiresAt})=>leaseExpiresAt).sort().at(-1);await waitUntil(ctx,expiry);
    const replacements=await Promise.all(Array.from({length:4},()=>ctx.startWorker()));
    const{state}=await waitWorkDrain(ctx,api.baseUrl,"JOURNEY_PROJECT",{processes:replacements,timeoutMs:120_000});
    for(const catalog of catalogs){
      const evidence=state.resources.scanEvents.filter(({shipmentId})=>shipmentId===catalog.shipment.shipmentId),actual=projectionFor(state,{shipmentId:catalog.shipment.shipmentId}),expected=replayShipment(catalog,evidence);
      ctx.equal(`replay ${catalog.shipment.trackingCode}`,actual,expected,JOURNEY_CAP);
      ctx.equal(`unique scanner identities ${catalog.shipment.trackingCode}`,new Set(evidence.map(({scannerEventId})=>scannerEventId)).size,evidence.length,JOURNEY_CAP);
    }
    for(const workId of heldWork){const item=state.work.find((work)=>work.workId===workId);ctx.ok(`reclaimed ${workId}`,item?.terminal&&item.attempt>=2,undefined,RECOVERY_CAP);}
    return caseResult(ctx,{shipmentCount:catalogs.length,requestCount:requests.length,killedWorkIds:[...heldWork],replacementWorkers:replacements.length});
  },
);

const C03=defineCase(
  "C-03",
  "two Consignments with one old CONSIGNMENT_PROJECT lease held during route and terminal changes",
  "reassign the held Consignment, cancel a second Consignment, kill the old worker and start replacements",
  "old Work cannot cross either revision or terminal fence and all aggregate state remains member-derived",
  ["seed-command","piece-scan","worker-process","public-http","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"aggregate-fence"}),{api}=await boot(ctx,{catalog}),reassigned=await createConsignment(ctx,api.baseUrl,catalog,3,{key:ctx.key("reassigned"),bodyOverrides:{externalRef:"C03-REASSIGN"}}),cancelled=await createConsignment(ctx,api.baseUrl,catalog,2,{key:ctx.key("cancelled"),bodyOverrides:{externalRef:"C03-CANCEL"}}),initial=await snapshot(ctx,api.baseUrl),route=routeFromSnapshot(catalog,initial,reassigned.consignment.routePlanId);
    const piece=reassigned.pieces[0],scan=ctx.pieceScanBody(route,"PICKED_UP",0,{scannerEventId:`${piece.pieceId}:held`,observedAt:ctx.fixtures.at({seconds:1})});
    requireStatus(await ctx.scanPiece(api.baseUrl,piece.pieceId,scan,{key:ctx.key("held-scan")}),200,"held piece scan");
    const barrier=await ctx.workerBarrier(({aggregateId})=>aggregateId===reassigned.consignment.consignmentId),doomed=await ctx.startWorkerAtBarrier(barrier),held=await barrier.waitFor(({json,released})=>json?.aggregateId===reassigned.consignment.consignmentId&&!released,{processes:[doomed],timeoutMs:30_000});
    requireStatus(await ctx.reassignConsignment(api.baseUrl,reassigned.consignment.consignmentId,{reason:"worker-fence",expectedRoutePlanRevision:1,legs:[{fromHubId:catalog.hubs[0].hubId,toHubId:catalog.hubs.at(-1).hubId,carrierId:catalog.carriers[0].carrierId}]},{key:ctx.key("reassign")}),200,"shared reassignment");
    requireStatus(await ctx.cancelConsignment(api.baseUrl,cancelled.consignment.consignmentId,{key:ctx.key("cancel")}),200,"Consignment cancel");
    const leased=await snapshot(ctx,api.baseUrl),heldWork=leased.work.find(({workId})=>workId===held.json.workId);await ctx.kill(doomed);await waitUntil(ctx,heldWork.leaseExpiresAt);
    const replacements=await Promise.all([ctx.startWorker(),ctx.startWorker()]),{state}=await waitWorkDrain(ctx,api.baseUrl,"CONSIGNMENT_PROJECT",{processes:replacements,timeoutMs:60_000}),current=consignmentFor(state,reassigned.consignment.consignmentId),cancelledCurrent=consignmentFor(state,cancelled.consignment.consignmentId);
    ctx.equal("reassigned authority stays at revision two",current.routePlanRevision,2,RECOVERY_CAP);
    ctx.equal("old piece evidence cannot cross revision",projectionFor(state,{pieceId:piece.pieceId}).routePlanRevision,2,RECOVERY_CAP);
    ctx.equal("cancelled aggregate remains terminal exception",cancelledCurrent.state,"EXCEPTION",RECOVERY_CAP);
    ctx.equal("all cancelled pieces stay cancelled",new Set(cancelled.pieces.map(({pieceId})=>pieceFor(state,pieceId).state)),new Set(["CANCELLED"]),RECOVERY_CAP);
    const recovered=state.work.find(({workId})=>workId===heldWork.workId);ctx.ok("held Work is terminal after takeover",recovered?.terminal&&recovered.attempt>=2,undefined,RECOVERY_CAP);
    return caseResult(ctx,{reassignedConsignmentId:current.consignmentId,cancelledConsignmentId:cancelledCurrent.consignmentId,heldWorkId:heldWork.workId});
  },
);

const C04=defineCase(
  "C-04",
  "committed shipment events whose first webhook response is received but not durably acknowledged",
  "hold dispatcher.response-received, kill that dispatcher and allow a replacement to redeliver to the real receiver",
  "the retry must preserve event ID, canonical body and aggregate sequence while rolled-back work emits nothing",
  ["seed-command","shipment-scan","worker-process","dispatcher-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"unknown-ack"}),{api}=await boot(ctx,{catalog}),worker=await ctx.startWorker(),receiver=await ctx.receiver(()=>({status:204})),barrier=await ctx.dispatcherBarrier(({aggregateId})=>aggregateId===catalog.shipment.shipmentId),doomed=await ctx.startDispatcherAtBarrier(receiver,barrier);
    const before=await snapshot(ctx,api.baseUrl),invalid=ctx.scanBody(catalog,"DEPARTED",0,{scannerEventId:"rolled-back-scan",hubId:catalog.hubs.at(-1).hubId});
    const rejected=await ctx.scanShipment(api.baseUrl,invalid,{key:ctx.key("rolled-back")});ctx.equal("invalid mutation rejected",rejected.status,400,RECOVERY_CAP);
    const rejectedState=await snapshot(ctx,api.baseUrl);ctx.equal("rollback emits no Event",rejectedState.events,before.events,RECOVERY_CAP);ctx.equal("rollback creates no Work",rejectedState.work,before.work,RECOVERY_CAP);ctx.equal("rollback stores no evidence",rejectedState.resources.scanEvents,before.resources.scanEvents,RECOVERY_CAP);
    const body=ctx.scanBody(catalog,"PICKED_UP",0,{scannerEventId:"unknown-ack-scan"});
    requireStatus(await ctx.scanShipment(api.baseUrl,body,{key:ctx.key("committed")}),200,"committed mutation");
    await waitWorkDrain(ctx,api.baseUrl,"JOURNEY_PROJECT",{processes:[worker],timeoutMs:60_000});
    const held=await barrier.waitFor(({json,released})=>json?.aggregateId===catalog.shipment.shipmentId&&!released,{processes:[doomed],timeoutMs:30_000});
    const first=receiver.ledger.find((entry)=>entry.json?.aggregateId===catalog.shipment.shipmentId);
    assert.ok(first,"receiver did not persist the first Event request");await ctx.kill(doomed);
    const replacement=await ctx.startDispatcher({webhookUrl:receiver.url});
    const attempts=await ctx.waitFor(()=>{const matches=receiver.ledger.filter((entry)=>entry.headers["x-routeweave-event-id"]===first.headers["x-routeweave-event-id"]);return matches.length>=2?matches:undefined;},{label:"same Event redelivery",processes:[replacement],timeoutMs:60_000});
    ctx.equal("unknown ACK retry preserves body",new Set(attempts.map(({raw})=>raw)).size,1,RECOVERY_CAP);
    ctx.equal("unknown ACK retry preserves Event header",new Set(attempts.map(({headers})=>headers["x-routeweave-event-id"])).size,1,RECOVERY_CAP);
    const state=await snapshot(ctx,api.baseUrl),events=state.events.filter(({aggregateId})=>aggregateId===catalog.shipment.shipmentId).sort((left,right)=>left.sequence-right.sequence);
    ctx.equal("aggregate Event sequences are contiguous",events.map(({sequence})=>sequence),Array.from({length:events.length},(_item,index)=>index+1),RECOVERY_CAP);
    ctx.equal("each committed Event identity is unique",new Set(events.map(exactEventIdentity)).size,events.length,RECOVERY_CAP);
    ctx.equal("rejected scanner identity never appears",state.resources.scanEvents.some(({scannerEventId})=>scannerEventId==="rolled-back-scan"),false,RECOVERY_CAP);
    return caseResult(ctx,{eventId:first.headers["x-routeweave-event-id"],attempts:attempts.length,aggregateEventCount:events.length});
  },
);

export const C_CASES=Object.freeze([C01,C02,C03,C04]);
