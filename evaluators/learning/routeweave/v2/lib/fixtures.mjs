import { createHash } from "node:crypto";

function digest(seed,label) { return createHash("sha256").update(`${seed}\0${label}`).digest("hex"); }
function uuidFrom(hex) { return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`; }

export function createFixtureFactory({ evaluationSeed,caseId,baseTime }) {
  const seed = `${evaluationSeed}\0${caseId}`, epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  return Object.freeze({
    uuid:(label) => uuidFrom(digest(seed,`uuid:${label}`)),
    key:(label) => `rw-${String(label).replace(/[^a-z0-9-]/giu,"-").slice(0,72)}-${digest(seed,`key:${label}`).slice(0,24)}`,
    at:({ milliseconds=0,seconds=0 }={}) => new Date(epoch+milliseconds+seconds*1000).toISOString(),
    seed,
  });
}

export function routeCatalog(fixtures,options={}) {
  const label = options.label ?? "primary", legCount = options.legCount ?? 2, tenantId = options.tenantId ?? fixtures.uuid(`tenant:${label}`), shipmentId = fixtures.uuid(`shipment:${label}`), routePlanId = fixtures.uuid(`route-plan:${label}:1`);
  const tenant = { tenantId,name:options.tenantName ?? `Tenant ${label}` };
  const hubs = Array.from({ length:legCount+1 },(_item,index) => ({ hubId:fixtures.uuid(`hub:${label}:${index}`),tenantId,code:`${label.slice(0,3).toUpperCase()}${String(index).padStart(2,"0")}`,name:`Hub ${label} ${index}`,timeZone:"UTC" }));
  const carriers = Array.from({ length:Math.max(1,options.carrierCount ?? 1) },(_item,index) => ({ carrierId:fixtures.uuid(`carrier:${label}:${index}`),tenantId,code:`C${String(index).padStart(2,"0")}`,name:`Carrier ${index}`,state:"ACTIVE" }));
  const shipment = { shipmentId,tenantId,trackingCode:options.trackingCode ?? `TRACK-${label.toUpperCase()}-001`,state:"PLANNED",currentRoutePlanId:routePlanId,createdAt:fixtures.at() };
  const routePlan = { routePlanId,shipmentId,revision:1,reason:"INITIAL",priorRoutePlanId:null,createdAt:fixtures.at() };
  const legs = Array.from({ length:legCount },(_item,index) => ({ legId:fixtures.uuid(`leg:${label}:1:${index+1}`),routePlanId,ordinal:index+1,fromHubId:hubs[index].hubId,toHubId:hubs[index+1].hubId,carrierId:carriers[index%carriers.length].carrierId,state:"PLANNED" }));
  const projection = { shipmentId,projectionVersion:0,currentHubId:hubs[0].hubId,currentLegId:legs[0].legId,state:"PLANNED",lastObservedAt:null,routePlanRevision:1 };
  return { tenant,tenantId,hubs,carriers,shipment,routePlan,legs,projection };
}

export function shipmentBody(catalog,overrides={}) {
  return { tenantId:catalog.tenantId,trackingCode:overrides.trackingCode ?? catalog.shipment.trackingCode,legs:(overrides.legs ?? catalog.legs).map(({ fromHubId,toHubId,carrierId }) => ({ fromHubId,toHubId,carrierId })) };
}

export function consignmentBody(catalog,pieceCount=3,overrides={}) {
  return { tenantId:catalog.tenantId,externalRef:overrides.externalRef ?? `CONSIGN-${catalog.shipment.trackingCode}`,pieceRefs:overrides.pieceRefs ?? Array.from({ length:pieceCount },(_item,index) => `piece-${String(index).padStart(3,"0")}`),legs:(overrides.legs ?? catalog.legs).map(({ fromHubId,toHubId,carrierId }) => ({ fromHubId,toHubId,carrierId })) };
}

export function scanBody(fixtures,catalog,type,index=0,overrides={}) {
  const leg = overrides.leg ?? catalog.legs[Math.min(index,catalog.legs.length-1)], hubId = overrides.hubId ?? (["PICKED_UP","DEPARTED","LOSS_REPORTED"].includes(type) ? leg.fromHubId : leg.toHubId);
  return { tenantId:catalog.tenantId,shipmentId:catalog.shipment.shipmentId,scannerEventId:overrides.scannerEventId ?? `scanner-${type.toLowerCase()}-${index}`,type,routePlanRevision:overrides.routePlanRevision ?? catalog.routePlan.revision,hubId,legId:overrides.legId ?? leg.legId,observedAt:overrides.observedAt ?? fixtures.at({ seconds:index+1 }) };
}

export function pieceScanBody(fixtures,catalog,type,index=0,overrides={}) {
  const { shipmentId:_shipmentId,...body } = scanBody(fixtures,catalog,type,index,overrides);
  return body;
}

export function scanSequence(fixtures,catalog,options={}) {
  const events = [scanBody(fixtures,catalog,"PICKED_UP",0,{ observedAt:fixtures.at({ seconds:1 }) })];
  for (let index=0;index<catalog.legs.length;index+=1) {
    events.push(scanBody(fixtures,catalog,"DEPARTED",index,{ observedAt:fixtures.at({ seconds:2+index*2 }) }));
    events.push(scanBody(fixtures,catalog,"ARRIVED",index,{ observedAt:fixtures.at({ seconds:3+index*2 }) }));
  }
  if (options.includeLoss) {
    const finalLeg = catalog.legs.at(-1), base = 2+catalog.legs.length*2;
    events.push(scanBody(fixtures,catalog,"LOSS_REPORTED",catalog.legs.length-1,{ leg:finalLeg,observedAt:fixtures.at({ seconds:base }),scannerEventId:"scanner-loss" }));
    events.push(scanBody(fixtures,catalog,"FOUND",catalog.legs.length-1,{ leg:finalLeg,observedAt:fixtures.at({ seconds:base+1 }),scannerEventId:"scanner-found" }));
  }
  events.push(scanBody(fixtures,catalog,"DELIVERED",catalog.legs.length-1,{ leg:catalog.legs.at(-1),observedAt:fixtures.at({ seconds:options.includeLoss ? 2+catalog.legs.length*2+2 : 2+catalog.legs.length*2 }),scannerEventId:"scanner-delivered" }));
  return events;
}

export function v1Seed(fixtures,seedVersion="routeweave-v1",options={}) {
  const catalog = options.catalog ?? routeCatalog(fixtures,options);
  return {
    schemaVersion:1,seedVersion,importedAt:options.importedAt ?? fixtures.at(),
    tenants:options.tenants ?? [catalog.tenant],hubs:options.hubs ?? catalog.hubs,carriers:options.carriers ?? catalog.carriers,
    shipments:options.shipments ?? [catalog.shipment],routePlans:options.routePlans ?? [catalog.routePlan],transportLegs:options.transportLegs ?? catalog.legs,
    scanEvents:options.scanEvents ?? [],journeyProjections:options.journeyProjections ?? [catalog.projection],lossCases:options.lossCases ?? [],reassignments:options.reassignments ?? [],
  };
}

function scaled(value,factor,minimum=1) { return factor===1 ? value : Math.max(minimum,Math.round(value*factor)); }
export function performanceContract(factor=1) {
  if (!(factor>0 && factor<=1)) throw new RangeError("performance scale must be in (0,1]");
  return Object.freeze({
    factor,
    plan:{ operationCount:scaled(50_000,factor),hubCount:scaled(100,factor,5),carrierCount:scaled(20,factor),legCount:4,concurrency:64,targetPerSecond:factor===1?300:1,p95Ms:400 },
    scans:{ shipmentCount:scaled(20_000,factor),operationCount:scaled(200_000,factor,5),duplicatePercent:20,targetPerSecond:factor===1?600:1,p95Ms:500 },
    recovery:{ shipmentCount:scaled(10_000,factor),killedWorkers:2,replacementWorkers:4,maximumSeconds:factor===1?60:10 },
  });
}
