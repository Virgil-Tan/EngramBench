import assert from "node:assert/strict";

import { aggregateConsignment,reconcileFinalSnapshot,replayShipment } from "../lib/oracle.mjs";
import {
  assertConsignmentView,boot,caseResult,consignmentFor,createConsignment,defineCase,expectError,
  pieceFor,pieceReplayFromSnapshot,projectionFor,requireStatus,routeFromSnapshot,snapshot,
  stableSnapshot,waitForState,waitWorkDrain,
} from "./helpers.mjs";

const JOURNEY_CAP={failureCodeSuffix:"PUBLIC_CONTRACT",hardCapIds:["JOURNEY_CORRECTNESS"]};

function contractSeed(ctx,primary,foreign){
  return ctx.seedFor("d01-contract",{catalog:primary,tenants:[primary.tenant,foreign.tenant],hubs:[...primary.hubs,...foreign.hubs],carriers:[...primary.carriers,...foreign.carriers],shipments:[primary.shipment],routePlans:[primary.routePlan],transportLegs:primary.legs,journeyProjections:[primary.projection]});
}

const REQUIRED_PATHS=[
  "/api/v1/tenants","/api/v1/hubs","/api/v1/carriers","/api/v1/shipments","/api/v1/shipments/{shipmentId}","/api/v1/shipments/{shipmentId}/timeline","/api/v1/scan-events","/api/v1/shipments/{shipmentId}/loss","/api/v1/shipments/{shipmentId}/found","/api/v1/shipments/{shipmentId}/reassign","/api/v1/shipments/{shipmentId}/cancel","/api/v1/verification-snapshot",
  "/api/v1/consignments","/api/v1/consignments/{consignmentId}","/api/v1/consignments/{consignmentId}/reassign","/api/v1/consignments/{consignmentId}/cancel","/api/v1/parcel-pieces/{pieceId}/scan-events","/api/v1/parcel-pieces/{pieceId}/loss","/api/v1/parcel-pieces/{pieceId}/found",
];

const D01=defineCase(
  "D-01",
  "two-tenant wire fixtures with piece count boundaries, malformed bodies and stable pagination",
  "inspect OpenAPI and execute only public V1 and Consignment HTTP routes against real PostgreSQL",
  "runtime and OpenAPI must agree on closed members, published errors, pieceRef order and tenant fences",
  ["seed-command","public-http","openapi","verification-snapshot"],
  async function run(ctx){
    const primary=ctx.catalog({legCount:2,label:"wire-primary"}),foreign=ctx.catalog({legCount:2,label:"wire-foreign"}),{api}=await boot(ctx,{catalog:primary,seed:contractSeed(ctx,primary,foreign)}),document=await ctx.readOpenApi(api.baseUrl);
    ctx.equal("OpenAPI version",document.openapi,"3.1.0");
    for(const path of REQUIRED_PATHS)ctx.ok(`OpenAPI path ${path}`,Boolean(document.paths?.[path]),`missing ${path}`);
    const invalidBefore=stableSnapshot(await snapshot(ctx,api.baseUrl)),valid=ctx.consignmentBody(primary,2);
    expectError(ctx,await ctx.request(api.baseUrl,"/api/v1/consignments",{method:"POST",headers:{"content-type":"application/json","idempotency-key":ctx.key("unknown")},json:{...valid,unknown:true}}),400,"INVALID_REQUEST",JOURNEY_CAP);
    expectError(ctx,await ctx.request(api.baseUrl,"/api/v1/consignments",{method:"POST",headers:{"content-type":"application/json","idempotency-key":ctx.key("malformed")},raw:"{"}),400,"MALFORMED_JSON",JOURNEY_CAP);
    ctx.equal("unsupported media type is rejected",(await ctx.request(api.baseUrl,"/api/v1/consignments",{method:"POST",headers:{"content-type":"text/plain","idempotency-key":ctx.key("media")},raw:JSON.stringify(valid)})).status,415,JOURNEY_CAP);
    expectError(ctx,await ctx.createConsignment(api.baseUrl,{...valid,pieceRefs:["dup","dup"]},{key:ctx.key("dup")}),409,"PIECE_REF_CONFLICT",JOURNEY_CAP);
    expectError(ctx,await ctx.createConsignment(api.baseUrl,ctx.consignmentBody(primary,101),{key:ctx.key("too-many")}),400,"INVALID_REQUEST",JOURNEY_CAP);
    expectError(ctx,await ctx.createConsignment(api.baseUrl,ctx.consignmentBody(primary,2,{legs:[{fromHubId:primary.hubs[0].hubId,toHubId:foreign.hubs[1].hubId,carrierId:primary.carriers[0].carrierId}]}),{key:ctx.key("cross-tenant")}),400,"INVALID_ROUTE_PLAN",JOURNEY_CAP);
    ctx.equal("all rejected requests are side-effect free",stableSnapshot(await snapshot(ctx,api.baseUrl)),invalidBefore,JOURNEY_CAP);
    const one=await createConsignment(ctx,api.baseUrl,primary,1,{key:ctx.key("one"),bodyOverrides:{externalRef:"D01-ONE"}}),hundred=await createConsignment(ctx,api.baseUrl,primary,100,{key:ctx.key("hundred"),bodyOverrides:{externalRef:"D01-HUNDRED"}});
    for(const created of[one,hundred]){
      const detail=requireStatus(await ctx.getConsignment(api.baseUrl,created.consignment.consignmentId),200,"Consignment GET");
      const view=assertConsignmentView(ctx,detail,created.pieces.length);
      ctx.equal("GET Consignment semantic identity",view.consignment,created.consignment,JOURNEY_CAP);
    }
    const page=requireStatus(await ctx.request(api.baseUrl,`/api/v1/consignments?tenantId=${primary.tenantId}&limit=1`),200,"Consignment list");
    ctx.equal("collection wrapper",Object.keys(page).sort(),["items","nextCursor"]);
    ctx.equal("page size",page.items.length,1);
    const foreignPage=requireStatus(await ctx.request(api.baseUrl,`/api/v1/consignments?tenantId=${foreign.tenantId}`),200,"foreign tenant list");
    ctx.equal("foreign tenant sees no primary Consignment",foreignPage.items.some(({consignmentId})=>[one,hundred].some(({consignment})=>consignment.consignmentId===consignmentId)),false,JOURNEY_CAP);
    return caseResult(ctx,{openApiPaths:REQUIRED_PATHS.length,consignmentIds:[one.consignment.consignmentId,hundred.consignment.consignmentId],pieceCounts:[1,100]});
  },
);

async function visibleField(page,names,value){
  for(const name of names){
    const labelled=page.getByLabel(name,{exact:false}).first();
    if(await labelled.count()){
      const tag=await labelled.evaluate((node)=>node.tagName);
      if(tag==="SELECT")await labelled.selectOption({label:String(value)}).catch(()=>labelled.selectOption(String(value)));
      else await labelled.fill(String(value));
      return;
    }
  }
  throw new Error(`missing visible field ${names.map(String).join("/")}`);
}

async function visibleButton(page,names){
  for(const name of names){
    const button=page.getByRole("button",{name}).first();
    if(await button.count()){await button.click();return;}
  }
  throw new Error(`missing visible button ${names.map(String).join("/")}`);
}

async function selectTenant(page,tenant){
  const selector=page.getByLabel(/tenant/i).first();
  if(await selector.count()){
    const tag=await selector.evaluate((node)=>node.tagName);
    if(tag==="SELECT")await selector.selectOption({value:tenant.tenantId}).catch(()=>selector.selectOption({label:tenant.name}));
  }
}

async function submitUiShipmentScan(page,catalog,type,index,label){
  const leg=catalog.legs[index];
  await visibleField(page,[/scanner.*event/i,/scanner.*id/i],label);
  await visibleField(page,[/^type$/i,/scan.*type/i],type);
  await visibleField(page,[/route.*revision/i],"1");
  await visibleField(page,[/leg.*id/i],leg.legId);
  await visibleField(page,[/hub.*id/i],type==="ARRIVED"||type==="DELIVERED"?leg.toHubId:leg.fromHubId);
  await visibleField(page,[/observed/i],new Date(Date.now()+index*1_000).toISOString());
  await visibleButton(page,[/submit.*scan/i,/record.*scan/i,/add.*scan/i]);
}

async function submitUiReassign(page,catalog,reason){
  await visibleField(page,[/reassign.*reason/i,/reroute.*reason/i,/reason/i],reason);
  await visibleField(page,[/expected.*revision/i,/route.*revision/i],"1");
  await visibleField(page,[/from.*hub/i],catalog.hubs[0].hubId);
  await visibleField(page,[/to.*hub/i],catalog.hubs.at(-1).hubId);
  await visibleField(page,[/carrier/i],catalog.carriers[0].carrierId);
  await visibleButton(page,[/reassign/i,/reroute/i]);
}

const D02=defineCase(
  "D-02",
  "seeded V1 shipment rendered in production Chromium at desktop and mobile widths",
  "use visible controls for scans, loss, found and reassignment, refresh, then compare UI to HTTP state",
  "evidence timeline and derived projection remain distinct, ordered and truthful across errors and refresh",
  ["seed-command","shipment-scan","worker-process","chromium","public-http","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"browser-v1"}),{api}=await boot(ctx,{catalog}),worker=await ctx.startWorker();
    await ctx.withPage(api,{width:1280,height:900},async(page)=>{
      await page.goto("/",{waitUntil:"networkidle"});await selectTenant(page,catalog.tenant);
      await page.getByText(catalog.shipment.trackingCode,{exact:false}).first().click();
      await submitUiShipmentScan(page,catalog,"PICKED_UP",0,"ui-picked-up");
      await page.getByText("ui-picked-up",{exact:false}).waitFor();
      await visibleField(page,[/loss.*reason/i,/reason/i],"browser-loss");await visibleButton(page,[/report.*loss/i,/mark.*lost/i]);
      await page.getByText(/lost|exception/i).first().waitFor();
      await visibleButton(page,[/found/i]);
      await visibleField(page,[/loss.*reason/i,/reason/i],"browser-reroute-loss");await visibleButton(page,[/report.*loss/i,/mark.*lost/i]);
      await page.getByText(/lost|exception/i).first().waitFor();await submitUiReassign(page,catalog,"browser-reroute");
      await page.reload({waitUntil:"networkidle"});await selectTenant(page,catalog.tenant);
      await page.getByText(catalog.shipment.trackingCode,{exact:false}).first().click();
      const body=(await page.locator("body").innerText()).toLowerCase();
      assert.match(body,/evidence|scan timeline/u);assert.match(body,/projection|journey/u);assert.match(body,/ui-picked-up/u);
    });
    await waitWorkDrain(ctx,api.baseUrl,["JOURNEY_PROJECT","LOSS_RECONCILE"],{processes:[worker],timeoutMs:60_000});
    const state=await snapshot(ctx,api.baseUrl),projection=projectionFor(state,{shipmentId:catalog.shipment.shipmentId});
    ctx.equal("browser mutation persisted one evidence",state.resources.scanEvents.filter(({scannerEventId})=>scannerEventId==="ui-picked-up").length,1,JOURNEY_CAP);
    ctx.ok("browser found resolved loss",state.resources.lossCases.filter(({shipmentId})=>shipmentId===catalog.shipment.shipmentId).every(({state:lossState})=>lossState!=="OPEN"));
    ctx.equal("browser reassignment advanced route revision",projection.routePlanRevision,2,JOURNEY_CAP);
    return caseResult(ctx,{shipmentId:catalog.shipment.shipmentId,state:projection.state,chromiumViewport:"1280x900"});
  },
);

const D03=defineCase(
  "D-03",
  "three-piece Consignment with delivered, lost and in-transit members rendered after refresh",
  "drive piece scans and shared route controls through the production React UI at a mobile viewport",
  "each piece journey remains independent and the visible aggregate equals a full member-state recomputation",
  ["seed-command","piece-scan","worker-process","chromium","public-http","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"browser-manager"}),{api}=await boot(ctx,{catalog}),workers=await Promise.all([ctx.startWorker(),ctx.startWorker()]),created=await createConsignment(ctx,api.baseUrl,catalog,3,{key:ctx.key("browser-consignment"),bodyOverrides:{externalRef:"UI-MULTI-PIECE"}}),cancelled=await createConsignment(ctx,api.baseUrl,catalog,2,{key:ctx.key("browser-cancel"),bodyOverrides:{externalRef:"UI-CANCEL-PIECES"}}),initial=await snapshot(ctx,api.baseUrl),route=routeFromSnapshot(catalog,initial,created.consignment.routePlanId);
    const moving=created.pieces[0],lost=created.pieces[1];
    requireStatus(await ctx.scanPiece(api.baseUrl,moving.pieceId,ctx.pieceScanBody(route,"PICKED_UP",0,{scannerEventId:`${moving.pieceId}:browser-moving`}),{key:ctx.key("moving")}),200,"moving piece");
    requireStatus(await ctx.lossPiece(api.baseUrl,lost.pieceId,{reason:"browser-exception",observedAt:ctx.fixtures.at({seconds:10})},{key:ctx.key("lost")}),200,"lost piece");
    await waitWorkDrain(ctx,api.baseUrl,"CONSIGNMENT_PROJECT",{processes:workers,timeoutMs:60_000});
    await ctx.withPage(api,{width:390,height:844},async(page)=>{
      await page.goto("/",{waitUntil:"networkidle"});await selectTenant(page,catalog.tenant);
      await page.getByText(created.consignment.externalRef,{exact:false}).first().click();
      for(const piece of created.pieces)await page.getByText(piece.pieceRef,{exact:false}).first().waitFor();
      await page.getByText(/exception/i).first().waitFor();
      await submitUiReassign(page,catalog,"browser-shared-reroute");
      await page.goto("/",{waitUntil:"networkidle"});await selectTenant(page,catalog.tenant);await page.getByText(cancelled.consignment.externalRef,{exact:false}).first().click();await visibleButton(page,[/cancel.*consignment/i,/cancel/i]);
      await page.reload({waitUntil:"networkidle"});await selectTenant(page,catalog.tenant);
      const text=(await page.locator("body").innerText()).toLowerCase();
      assert.match(text,/exception/u);assert.match(text,/piece-000/u);assert.match(text,/piece-001/u);assert.match(text,/piece-002/u);
    });
    await waitWorkDrain(ctx,api.baseUrl,"CONSIGNMENT_PROJECT",{processes:workers,timeoutMs:60_000});
    const state=await snapshot(ctx,api.baseUrl),pieces=created.pieces.map(({pieceId})=>pieceFor(state,pieceId)),aggregate=consignmentFor(state,created.consignment.consignmentId);
    ctx.equal("UI-backed aggregate closure",aggregate.state,aggregateConsignment(pieces.map(({state:pieceState})=>pieceState)),JOURNEY_CAP);
    ctx.equal("piece states remain independent",new Set(pieces.map(({state:pieceState})=>pieceState)).size>=2,true,JOURNEY_CAP);
    ctx.equal("shared UI reroute advances one revision",aggregate.routePlanRevision,2,JOURNEY_CAP);
    ctx.equal("UI cancel is durable for every member",new Set(cancelled.pieces.map(({pieceId})=>pieceFor(state,pieceId).state)),new Set(["CANCELLED"]),JOURNEY_CAP);
    return caseResult(ctx,{consignmentId:aggregate.consignmentId,state:aggregate.state,pieceStates:pieces.map(({state:pieceState})=>pieceState),chromiumViewport:"390x844"});
  },
);

const D04=defineCase(
  "D-04",
  "one FINAL snapshot containing V1 and multi-piece journeys, Work and domain Events",
  "authorize one verification snapshot after real APIs and workers have drained all committed evidence",
  "validate exact point-in-time resources, sorting, secret omission and independent V1 and piece replay closure",
  ["seed-command","shipment-scan","piece-scan","worker-process","verification-snapshot"],
  async function run(ctx){
    const catalog=ctx.catalog({legCount:2,label:"snapshot-closure"}),{api}=await boot(ctx,{catalog}),workers=await Promise.all([ctx.startWorker(),ctx.startWorker()]),created=await createConsignment(ctx,api.baseUrl,catalog,2,{key:ctx.key("snapshot-consignment")}),initial=await snapshot(ctx,api.baseUrl),route=routeFromSnapshot(catalog,initial,created.consignment.routePlanId);
    requireStatus(await ctx.scanShipment(api.baseUrl,ctx.scanBody(catalog,"PICKED_UP",0,{scannerEventId:"snapshot-shipment"}),{key:ctx.key("shipment-scan")}),200,"snapshot shipment scan");
    for(const [index,piece] of created.pieces.entries())requireStatus(await ctx.scanPiece(api.baseUrl,piece.pieceId,ctx.pieceScanBody(route,"PICKED_UP",0,{scannerEventId:`${piece.pieceId}:snapshot`,observedAt:ctx.fixtures.at({seconds:index+2})}),{key:ctx.key(`piece-${index}`)}),200,"snapshot piece scan");
    await waitWorkDrain(ctx,api.baseUrl,["JOURNEY_PROJECT","CONSIGNMENT_PROJECT"],{processes:workers,timeoutMs:60_000});
    const unauthorized=await ctx.request(api.baseUrl,"/api/v1/verification-snapshot");ctx.ok("snapshot requires bearer token",[401,403].includes(unauthorized.status));
    const state=await snapshot(ctx,api.baseUrl);ctx.assert("FINAL snapshot exact closure",()=>reconcileFinalSnapshot(state),JOURNEY_CAP);
    const shipmentEvidence=state.resources.scanEvents.filter(({shipmentId})=>shipmentId===catalog.shipment.shipmentId),expectedShipment=replayShipment(catalog,shipmentEvidence);
    ctx.equal("V1 projection replays",projectionFor(state,{shipmentId:catalog.shipment.shipmentId}),expectedShipment,JOURNEY_CAP);
    for(const piece of created.pieces){const expected=pieceReplayFromSnapshot(state,route,piece.pieceId),actual=projectionFor(state,{pieceId:piece.pieceId});ctx.equal(`piece replay ${piece.pieceRef}`,actual,expected,JOURNEY_CAP);}
    ctx.equal("snapshot omits admin token",JSON.stringify(state).includes(ctx.adminToken),false,JOURNEY_CAP);
    ctx.equal("snapshot is one timestamp",typeof state.asOf,"string");
    return caseResult(ctx,{asOf:state.asOf,resourceCounts:Object.fromEntries(Object.entries(state.resources).map(([key,items])=>[key,items.length])),workCount:state.work.length,eventCount:state.events.length});
  },
);

export const D_CASES=Object.freeze([D01,D02,D03,D04]);
