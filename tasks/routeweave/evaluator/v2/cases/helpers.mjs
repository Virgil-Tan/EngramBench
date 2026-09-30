import assert from "node:assert/strict";

import {
  assertConsignment,assertParcelPiece,assertPieceProjection,assertPublicError,
  canonical,replayPiece,replayShipment,
} from "../lib/oracle.mjs";

export function defineCase(id,fixtureFamily,action,oracle,seams,run){return Object.freeze({id,taskId:"routeweave",fixtureFamily,action,oracle,seams:Object.freeze([...seams]),run});}
export async function boot(ctx,options={}){const catalog=options.catalog??ctx.catalog(options.catalogOptions);if(options.seed!==false)await ctx.seed(options.seed??ctx.seedFor(options.seedVersion??`${ctx.caseId.toLowerCase()}-v1`,{catalog,...options.seedOptions}));const apis=[];for(let index=0;index<(options.apiCount??1);index+=1)apis.push(await ctx.startApi());return{catalog,apis,api:apis[0]};}
export function expectError(ctx,response,status,code,options){ctx.assert(`${code} exact error`,()=>assertPublicError(response,status,code),options);return response;}
export async function snapshot(ctx,url,options={}){const value=await ctx.snapshot(url,options);ctx.equal("snapshot top-level keys",Object.keys(value).sort(),["asOf","events","resources","schemaVersion","work"]);return value;}
export function resource(state,key,idKey,id){return state.resources[key].find((item)=>item[idKey]===id);}export function workFor(state,kind,aggregateId){return state.work.filter((item)=>item.kind===kind&&(aggregateId===undefined||item.aggregateId===aggregateId));}export function activeWork(state,kind){return workFor(state,kind).filter(({terminal})=>!terminal);}
export async function waitForState(ctx,url,select,predicate,options={}){return ctx.waitFor(async()=>{const state=await ctx.snapshot(url,{timeoutMs:options.requestTimeoutMs}),selected=select(state);return predicate(selected,state)?{selected,state}:undefined;},{label:options.label??"durable RouteWeave state",timeoutMs:options.timeoutMs??30_000,intervalMs:options.intervalMs??100,processes:options.processes??[]});}
export async function waitWorkDrain(ctx,url,kinds,options={}){const accepted=new Set(Array.isArray(kinds)?kinds:[kinds]);return waitForState(ctx,url,(state)=>state.work.filter((work)=>accepted.has(work.kind)&&!work.terminal),(items)=>items.length===0,{...options,label:options.label??`Work drain ${[...accepted].join(",")}`});}
export async function createConsignment(ctx,url,catalog,count=3,options={}){const response=await ctx.createConsignment(url,ctx.consignmentBody(catalog,count,options.bodyOverrides),{key:options.key});ctx.equal("Consignment create status",response.status,200);ctx.equal("Consignment create wrapper",Object.keys(response.json).sort(),["consignment","pieces"]);ctx.assert("Consignment exact shape",()=>assertConsignment(response.json.consignment));ctx.equal("piece count",response.json.pieces.length,count);response.json.pieces.forEach((piece)=>ctx.assert("ParcelPiece exact shape",()=>assertParcelPiece(piece)));return response.json;}
export function extractConsignmentView(json){const values=[];function visit(value){if(Array.isArray(value)){values.push(value);value.forEach(visit);}else if(value&&typeof value==="object"){values.push(value);Object.values(value).forEach(visit);}}visit(json);const consignment=values.find((value)=>!Array.isArray(value)&&Object.hasOwn(value,"consignmentId")&&Object.hasOwn(value,"externalRef")),pieces=values.find((value)=>Array.isArray(value)&&value.length>0&&value.every((item)=>item&&Object.hasOwn(item,"pieceId")&&Object.hasOwn(item,"pieceRef")))??[],projections=values.find((value)=>Array.isArray(value)&&value.length>0&&value.every((item)=>item&&Object.hasOwn(item,"pieceId")&&Object.hasOwn(item,"routePlanRevision")&&Object.hasOwn(item,"currentLegOrdinal")))??[];return{consignment,pieces,projections};}
export function assertConsignmentView(ctx,json,expectedCount){const view=extractConsignmentView(json);ctx.assert("GET contains exact Consignment member",()=>assertConsignment(view.consignment));ctx.equal("GET piece member count",view.pieces.length,expectedCount);ctx.equal("GET projection member count",view.projections.length,expectedCount);view.pieces.forEach((piece)=>ctx.assert("GET ParcelPiece member exact",()=>assertParcelPiece(piece)));view.projections.forEach((projection)=>ctx.assert("GET PieceProjection member exact",()=>assertPieceProjection(projection)));ctx.equal("GET pieces sorted by pieceRef",view.pieces.map(({pieceRef})=>pieceRef),[...view.pieces.map(({pieceRef})=>pieceRef)].sort());return view;}
export async function resetFixture(ctx,options={}){await ctx.resetDatabase();await ctx.migrate();return boot(ctx,options);}
export function stableResponses(ctx,responses,label,options){const first=responses[0];ctx.ok(`${label} has response`,Boolean(first));ctx.equal(`${label} statuses`,new Set(responses.map(({status})=>status)).size,1,options);ctx.equal(`${label} semantic bodies`,new Set(responses.map(({json})=>ctx.canonical(json))).size,1,options);return first;}
export function projectionFor(state,{shipmentId,pieceId}){return pieceId?resource(state,"pieceProjections","pieceId",pieceId):resource(state,"journeyProjections","shipmentId",shipmentId);}
export function pieceFor(state,pieceId){return resource(state,"parcelPieces","pieceId",pieceId);}export function consignmentFor(state,id){return resource(state,"consignments","consignmentId",id);}

export function requireStatus(response,status,label="request"){
  const expected=Array.isArray(status)?status:[status];
  assert.ok(expected.includes(response.status),`${label}: expected ${expected.join("/")}, received ${response.status}: ${response.text}`);
  assert.notEqual(response.json,undefined,`${label}: response is not JSON`);
  return response.json;
}

export function stableSnapshot(value){const{asOf:_asOf,...stable}=value;return stable;}

export function caseResult(ctx,details={}){
  return{evidence:[{caseId:ctx.caseId,taskId:"routeweave",...details}]};
}

export function captureResponse(capture){
  const response=capture?.response??capture;
  let json;
  try{json=JSON.parse(response.body??response.text??"");}catch{}
  return{status:response.status,json,text:response.body??response.text};
}

export function routeFromSnapshot(catalog,state,routePlanId,revision=1){
  const routePlan=state.resources.routePlans.find((item)=>item.routePlanId===routePlanId);
  assert.ok(routePlan,`missing RoutePlan ${routePlanId}`);
  const legs=state.resources.transportLegs.filter((item)=>item.routePlanId===routePlanId).sort((left,right)=>left.ordinal-right.ordinal);
  assert.ok(legs.length>0,`missing TransportLegs for ${routePlanId}`);
  return{...catalog,routePlan:{...routePlan,revision},currentRoutePlanRevision:revision,legs};
}

export function shipmentReplayFromSnapshot(state,catalog,shipmentId=catalog.shipment.shipmentId){
  const events=state.resources.scanEvents.filter((item)=>item.shipmentId===shipmentId);
  return replayShipment({...catalog,shipment:{...catalog.shipment,shipmentId}},events);
}

export function pieceReplayFromSnapshot(state,catalog,pieceId){
  const events=state.resources.scanEvents.filter((item)=>item.pieceId===pieceId||String(item.scannerEventId).startsWith(`${pieceId}:`));
  return replayPiece(catalog,events,pieceId);
}

export function assertProjectionMatches(ctx,actual,expected,options={}){
  for(const key of Object.keys(expected))ctx.equal(`projection ${key}`,actual?.[key],expected[key],options);
}

export function assertNoSecondEffects(ctx,before,after,selectors,options={}){
  for(const [label,select] of Object.entries(selectors))ctx.equal(`${label} unchanged`,select(after),select(before),options);
}

export function exactEventIdentity(event){
  return canonical({eventId:event.eventId,aggregateId:event.aggregateId,sequence:event.sequence,type:event.type,payload:event.payload});
}
