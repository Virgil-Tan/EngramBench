import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const TYPE_PRECEDENCE = Object.freeze({ LOSS_REPORTED:0,FOUND:1,PICKED_UP:2,DEPARTED:3,ARRIVED:4,DELIVERED:5 });

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value==="object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  if (typeof value==="number" && !Number.isFinite(value)) throw new TypeError("non-finite JSON number");
  const encoded=JSON.stringify(value); if (encoded===undefined) throw new TypeError("unsupported JSON value"); return encoded;
}
export function digestProjection(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function compareUtf8(left,right) { return Buffer.compare(Buffer.from(String(left)),Buffer.from(String(right))); }

export function sortEvidence(events) {
  return [...events].sort((left,right) => left.observedAt.localeCompare(right.observedAt) || (TYPE_PRECEDENCE[left.type]??99)-(TYPE_PRECEDENCE[right.type]??99) || compareUtf8(left.scannerEventId,right.scannerEventId));
}

export function validateRoute(legs) {
  assert.ok(Array.isArray(legs) && legs.length>=1,"route requires at least one leg");
  for (let index=0;index<legs.length;index+=1) {
    assert.equal(legs[index].ordinal,index+1,"leg ordinal must be contiguous");
    if (index>0) assert.equal(legs[index-1].toHubId,legs[index].fromHubId,"adjacent legs must be connected");
    assert.notEqual(legs[index].fromHubId,legs[index].toHubId,"leg endpoints must differ");
  }
  return true;
}

function semanticIdentity(event) { const { scanEventId:_scanEventId,receivedAt:_receivedAt,payloadDigest:_payloadDigest,...body }=event; return canonical(body); }
export function uniqueEvidence(events) {
  const identities=new Map();
  for (const event of events) {
    const scope=`${event.pieceId??event.shipmentId}\0${event.scannerEventId}`, prior=identities.get(scope), body=semanticIdentity(event);
    if (prior && prior.body!==body) throw new Error(`scannerEventId conflict: ${event.scannerEventId}`);
    if (!prior) identities.set(scope,{ body,event });
  }
  return [...identities.values()].map(({ event }) => event);
}

function replay(catalog,events,{ pieceId }={}) {
  validateRoute(catalog.legs);
  const evidence=sortEvidence(uniqueEvidence(events)), currentRevision=catalog.currentRoutePlanRevision??catalog.routePlan.revision, legs=catalog.legs.filter((leg) => (leg.routePlanRevision??currentRevision)===currentRevision), departed=new Set(),arrived=new Set();
  let state="PLANNED", currentHubId=catalog.hubs[0].hubId,currentLegOrdinal=legs[0]?.ordinal??null,currentLegId=legs[0]?.legId??null,lastObservedAt=null,lost=false;
  const pending=[];
  function apply(event) {
    if (lost || state==="DELIVERED") return false;
    const legIndex=legs.findIndex(({ legId }) => legId===event.legId), leg=legs[legIndex];
    if (!leg) return false;
    let applies=false;
    if (event.type==="PICKED_UP" && legIndex===0 && event.hubId===leg.fromHubId && departed.size===0 && arrived.size===0) { state="IN_TRANSIT";currentHubId=leg.fromHubId;currentLegOrdinal=leg.ordinal;currentLegId=leg.legId;applies=true; }
    else if (event.type==="DEPARTED" && event.hubId===leg.fromHubId && (legIndex===0 || arrived.has(legs[legIndex-1].legId))) { departed.add(leg.legId);state="IN_TRANSIT";currentLegOrdinal=leg.ordinal;currentLegId=leg.legId;applies=true; }
    else if (event.type==="ARRIVED" && event.hubId===leg.toHubId && departed.has(leg.legId) && (legIndex===0 || arrived.has(legs[legIndex-1].legId))) { arrived.add(leg.legId);currentHubId=leg.toHubId;currentLegOrdinal=legIndex+1<legs.length?legs[legIndex+1].ordinal:leg.ordinal;currentLegId=legIndex+1<legs.length?legs[legIndex+1].legId:leg.legId;state="IN_TRANSIT";applies=true; }
    else if (event.type==="DELIVERED" && legIndex===legs.length-1 && event.hubId===leg.toHubId && arrived.size===legs.length) { state="DELIVERED";currentHubId=leg.toHubId;currentLegOrdinal=leg.ordinal;currentLegId=leg.legId;applies=true; }
    if (applies) lastObservedAt=lastObservedAt===null||event.observedAt>lastObservedAt?event.observedAt:lastObservedAt;
    return applies;
  }
  function drainPending() {
    let progressed=true;
    while(progressed&&!lost&&state!=="DELIVERED"){
      progressed=false;
      for(let index=0;index<pending.length;index+=1){if(apply(pending[index])){pending.splice(index,1);index-=1;progressed=true;}}
    }
  }
  for (const event of evidence) {
    if ((event.routePlanRevision??currentRevision)!==currentRevision) continue;
    if (event.type==="LOSS_REPORTED") {
      if (!["DELIVERED","CANCELLED"].includes(state)) { lost=true;state="LOST";lastObservedAt=lastObservedAt===null||event.observedAt>lastObservedAt?event.observedAt:lastObservedAt; }
      continue;
    }
    if (event.type==="FOUND") {
      if (lost) { lost=false;state=arrived.size||departed.size?"IN_TRANSIT":"PLANNED";lastObservedAt=lastObservedAt===null||event.observedAt>lastObservedAt?event.observedAt:lastObservedAt;drainPending(); }
      continue;
    }
    if (!apply(event)) pending.push(event);
    else drainPending();
  }
  const sequence=evidence.length;
  return pieceId ? { pieceId,routePlanRevision:currentRevision,currentLegOrdinal,currentHubId,state,lastObservedAt,sequence } : { shipmentId:catalog.shipment.shipmentId,projectionVersion:sequence,currentHubId,currentLegId,state,lastObservedAt,routePlanRevision:currentRevision };
}
export function replayShipment(catalog,events) { return replay(catalog,events); }
export function replayPiece(catalog,events,pieceId="oracle-piece") { return replay(catalog,events,{ pieceId }); }

export function aggregateConsignment(states) {
  assert.ok(Array.isArray(states)&&states.length>0,"piece states required");
  if (states.some((state) => ["LOST","CANCELLED"].includes(state))) return "EXCEPTION";
  if (states.every((state) => state==="DELIVERED")) return "DELIVERED";
  if (states.some((state) => state==="DELIVERED")) return "PARTIALLY_DELIVERED";
  if (states.some((state) => state==="IN_TRANSIT")) return "IN_TRANSIT";
  return "PLANNED";
}

export function assertExactKeys(value,keys,label="object") { assert.ok(value&&typeof value==="object"&&!Array.isArray(value),`${label} object`); assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),`${label} keys`); }
function assertUuid(value) { assert.match(value,/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u); }
function assertTimestamp(value) { assert.match(value,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u); }

export function assertConsignment(value) { assertExactKeys(value,["consignmentId","tenantId","externalRef","routePlanId","routePlanRevision","state","createdAt","updatedAt","sequence"],"Consignment"); for(const key of ["consignmentId","tenantId","routePlanId"]) assertUuid(value[key]); assert.ok(Number.isSafeInteger(value.routePlanRevision)&&value.routePlanRevision>0); assert.ok(["PLANNED","IN_TRANSIT","PARTIALLY_DELIVERED","DELIVERED","EXCEPTION"].includes(value.state)); assertTimestamp(value.createdAt);assertTimestamp(value.updatedAt);assert.ok(Number.isSafeInteger(value.sequence)&&value.sequence>=0); }
export function assertParcelPiece(value) { assertExactKeys(value,["pieceId","consignmentId","pieceRef","legacyShipmentId","state","createdAt","terminalAt"],"ParcelPiece"); assertUuid(value.pieceId);assertUuid(value.consignmentId);if(value.legacyShipmentId!==null)assertUuid(value.legacyShipmentId);assert.ok(["PLANNED","IN_TRANSIT","DELIVERED","LOST","CANCELLED"].includes(value.state));assertTimestamp(value.createdAt);if(value.terminalAt!==null)assertTimestamp(value.terminalAt); }
export function assertPieceProjection(value) { assertExactKeys(value,["pieceId","routePlanRevision","currentLegOrdinal","currentHubId","state","lastObservedAt","sequence"],"PieceProjection");assertUuid(value.pieceId);assert.ok(Number.isSafeInteger(value.routePlanRevision)&&value.routePlanRevision>0);assert.ok(value.currentLegOrdinal===null||(Number.isSafeInteger(value.currentLegOrdinal)&&value.currentLegOrdinal>0));if(value.currentHubId!==null)assertUuid(value.currentHubId);assert.ok(["PLANNED","IN_TRANSIT","DELIVERED","LOST","CANCELLED"].includes(value.state));if(value.lastObservedAt!==null)assertTimestamp(value.lastObservedAt);assert.ok(Number.isSafeInteger(value.sequence)&&value.sequence>=0); }
export function assertPublicError(response,status,code) { assert.equal(response.status,status);assertExactKeys(response.json,["error"],"error response");assertExactKeys(response.json.error,["code","message","details"],"error");assert.equal(response.json.error.code,code); }
export function percentile(values,fraction) { assert.ok(values.length);const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]; }

const RESOURCE_KEYS=["tenants","hubs","carriers","shipments","routePlans","transportLegs","scanEvents","journeyProjections","lossCases","reassignments","consignments","parcelPieces","pieceProjections"];
function assertSorted(items,selector,label){const actual=items.map(selector),expected=[...actual].sort((left,right)=>{for(let index=0;index<left.length;index+=1){const a=left[index],b=right[index],order=typeof a==="number"&&typeof b==="number"?a-b:compareUtf8(a,b);if(order)return order;}return 0;});assert.deepEqual(actual,expected,`${label} order`);}
function assertWork(value){assertExactKeys(value,["workId","kind","aggregateId","state","terminal","attempt","leaseOwner","leaseExpiresAt"],"Work");assertUuid(value.workId);assertUuid(value.aggregateId);assert.ok(["JOURNEY_PROJECT","LOSS_RECONCILE","CONSIGNMENT_PROJECT"].includes(value.kind));assert.ok(["PENDING","LEASED","SUCCEEDED","FAILED","CANCELLED"].includes(value.state));assert.equal(value.terminal,["SUCCEEDED","FAILED","CANCELLED"].includes(value.state));assert.equal(value.state==="LEASED",value.leaseOwner!==null&&value.leaseExpiresAt!==null);}
function assertV1Shapes(resources){
  for(const item of resources.tenants){assertExactKeys(item,["tenantId","name"],"Tenant");assertUuid(item.tenantId);}for(const item of resources.hubs){assertExactKeys(item,["hubId","tenantId","code","name","timeZone"],"Hub");assertUuid(item.hubId);assertUuid(item.tenantId);}for(const item of resources.carriers){assertExactKeys(item,["carrierId","tenantId","code","name","state"],"Carrier");assertUuid(item.carrierId);assertUuid(item.tenantId);assert.ok(["ACTIVE","SUSPENDED"].includes(item.state));}
  for(const item of resources.shipments){assertExactKeys(item,["shipmentId","tenantId","trackingCode","state","currentRoutePlanId","createdAt"],"Shipment");assertUuid(item.shipmentId);assertUuid(item.tenantId);assertUuid(item.currentRoutePlanId);assert.ok(["PLANNED","IN_TRANSIT","DELIVERED","LOST","CANCELLED"].includes(item.state));assertTimestamp(item.createdAt);}for(const item of resources.routePlans){assertExactKeys(item,["routePlanId","shipmentId","revision","reason","priorRoutePlanId","createdAt"],"RoutePlan");assertUuid(item.routePlanId);assertUuid(item.shipmentId);if(item.priorRoutePlanId!==null)assertUuid(item.priorRoutePlanId);assert.ok(Number.isSafeInteger(item.revision)&&item.revision>0);assertTimestamp(item.createdAt);}for(const item of resources.transportLegs){assertExactKeys(item,["legId","routePlanId","ordinal","fromHubId","toHubId","carrierId","state"],"TransportLeg");for(const key of["legId","routePlanId","fromHubId","toHubId","carrierId"])assertUuid(item[key]);assert.ok(Number.isSafeInteger(item.ordinal)&&item.ordinal>0);}
  for(const item of resources.scanEvents){const pieceScoped=Object.hasOwn(item,"pieceId"),keys=["scanEventId","tenantId","shipmentId","scannerEventId","type","hubId","legId","observedAt","receivedAt","payloadDigest",...(pieceScoped?["pieceId"]:[])];assertExactKeys(item,keys,"ScanEvent");for(const key of["scanEventId","tenantId","hubId","legId"])assertUuid(item[key]);if(item.shipmentId!==null)assertUuid(item.shipmentId);if(pieceScoped)assertUuid(item.pieceId);assert.ok(Object.hasOwn(TYPE_PRECEDENCE,item.type));assertTimestamp(item.observedAt);assertTimestamp(item.receivedAt);assert.match(item.payloadDigest,/^[0-9a-f]{64}$/u);}for(const item of resources.journeyProjections){assertExactKeys(item,["shipmentId","projectionVersion","currentHubId","currentLegId","state","lastObservedAt","routePlanRevision"],"JourneyProjection");assertUuid(item.shipmentId);if(item.currentHubId!==null)assertUuid(item.currentHubId);if(item.currentLegId!==null)assertUuid(item.currentLegId);assert.ok(Number.isSafeInteger(item.projectionVersion)&&item.projectionVersion>=0);}
  for(const item of resources.lossCases){assertExactKeys(item,["lossCaseId","shipmentId","state","openedAt","resolvedAt"],"LossCase");assertUuid(item.lossCaseId);assertUuid(item.shipmentId);}for(const item of resources.reassignments){assertExactKeys(item,["reassignmentId","shipmentId","lossCaseId","fromRoutePlanId","toRoutePlanId","reason","createdAt"],"Reassignment");for(const key of["reassignmentId","shipmentId","lossCaseId","fromRoutePlanId","toRoutePlanId"])assertUuid(item[key]);}
}
export function reconcileFinalSnapshot(snapshot){
  assertExactKeys(snapshot,["schemaVersion","asOf","resources","work","events"],"verification snapshot");assert.equal(snapshot.schemaVersion,1);assertTimestamp(snapshot.asOf);assertExactKeys(snapshot.resources,RESOURCE_KEYS,"FINAL resources");assertV1Shapes(snapshot.resources);snapshot.resources.consignments.forEach(assertConsignment);snapshot.resources.parcelPieces.forEach(assertParcelPiece);snapshot.resources.pieceProjections.forEach(assertPieceProjection);snapshot.work.forEach(assertWork);
  assertSorted(snapshot.resources.tenants,(item)=>[item.tenantId],"tenants");assertSorted(snapshot.resources.hubs,(item)=>[item.hubId],"hubs");assertSorted(snapshot.resources.carriers,(item)=>[item.carrierId],"carriers");assertSorted(snapshot.resources.shipments,(item)=>[item.shipmentId],"shipments");assertSorted(snapshot.resources.routePlans,(item)=>[item.shipmentId,item.revision],"routePlans");assertSorted(snapshot.resources.transportLegs,(item)=>[item.routePlanId,item.ordinal],"transportLegs");assertSorted(snapshot.resources.scanEvents,(item)=>[item.scanEventId],"scanEvents");assertSorted(snapshot.resources.journeyProjections,(item)=>[item.shipmentId],"journeyProjections");assertSorted(snapshot.resources.lossCases,(item)=>[item.lossCaseId],"lossCases");assertSorted(snapshot.resources.reassignments,(item)=>[item.reassignmentId],"reassignments");assertSorted(snapshot.resources.consignments,(item)=>[item.consignmentId],"consignments");assertSorted(snapshot.resources.parcelPieces,(item)=>[item.consignmentId,item.pieceRef],"parcelPieces");assertSorted(snapshot.resources.pieceProjections,(item)=>[item.pieceId],"pieceProjections");assertSorted(snapshot.work,(item)=>[item.workId],"work");
  const pieces=new Map(snapshot.resources.parcelPieces.map((piece)=>[piece.pieceId,piece])),projections=new Map(snapshot.resources.pieceProjections.map((projection)=>[projection.pieceId,projection]));for(const pieceId of pieces.keys())assert.ok(projections.has(pieceId),`missing projection ${pieceId}`);for(const consignment of snapshot.resources.consignments){const states=snapshot.resources.parcelPieces.filter(({consignmentId})=>consignmentId===consignment.consignmentId).map(({state})=>state);assert.equal(consignment.state,aggregateConsignment(states));}
  return true;
}
