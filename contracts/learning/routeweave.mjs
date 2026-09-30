import {T,S,U,N,P,D,H,E,R,A,O,Q,uid,time,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const state=E('PLANNED','IN_TRANSIT','DELIVERED','LOST','CANCELLED');
const scanType=E('PICKED_UP','DEPARTED','ARRIVED','DELIVERED','LOSS_REPORTED','FOUND');
const legInput=O({fromHubId:U,toHubId:U,carrierId:U});
const legs=A(legInput,{minItems:1});
const schemas={
  Hub:O({hubId:U,tenantId:U,code:S,name:S,timeZone:S}),
  Carrier:O({carrierId:U,tenantId:U,code:S,name:S,state:E('ACTIVE','SUSPENDED')}),
  Shipment:O({shipmentId:U,tenantId:U,trackingCode:S,state,currentRoutePlanId:U,createdAt:D}),
  RoutePlan:O({routePlanId:U,shipmentId:U,revision:P,reason:E('INITIAL','REASSIGNED'),priorRoutePlanId:Q(U),createdAt:D}),
  ConsignmentRoutePlan:O({routePlanId:U,consignmentId:U,revision:P,reason:E('INITIAL','REASSIGNED'),priorRoutePlanId:Q(U),createdAt:D}),
  TransportLeg:O({legId:U,routePlanId:U,ordinal:P,fromHubId:U,toHubId:U,carrierId:U,state:E('PLANNED','DEPARTED','ARRIVED','SKIPPED')}),
  ScanEvent:O({scanEventId:U,tenantId:U,shipmentId:U,scannerEventId:S,type:scanType,hubId:Q(U),legId:Q(U),observedAt:D,receivedAt:D,payloadDigest:H}),
  PieceScanEvent:O({scanEventId:U,tenantId:U,pieceId:U,scannerEventId:S,type:scanType,routePlanRevision:P,hubId:Q(U),legId:Q(U),observedAt:D,receivedAt:D,payloadDigest:H}),
  JourneyProjection:O({shipmentId:U,projectionVersion:N,currentHubId:Q(U),currentLegId:Q(U),state,lastObservedAt:Q(D),routePlanRevision:P}),
  LossCase:O({lossCaseId:U,shipmentId:U,state:E('OPEN','RESOLVED_FOUND','RESOLVED_REASSIGNED'),openedAt:D,resolvedAt:Q(D)}),
  Reassignment:O({reassignmentId:U,shipmentId:U,lossCaseId:U,fromRoutePlanId:U,toRoutePlanId:U,reason:S,createdAt:D}),
  Consignment:O({consignmentId:U,tenantId:U,externalRef:S,routePlanId:U,routePlanRevision:P,state:E('PLANNED','IN_TRANSIT','PARTIALLY_DELIVERED','DELIVERED','EXCEPTION'),createdAt:D,updatedAt:D,sequence:N}),
  ParcelPiece:O({pieceId:U,consignmentId:U,pieceRef:S,legacyShipmentId:Q(U),state,createdAt:D,terminalAt:Q(D)}),
  PieceProjection:O({pieceId:U,routePlanRevision:P,currentLegOrdinal:Q(P),currentHubId:Q(U),state,lastObservedAt:Q(D),sequence:N}),
  FinalRoutePlan:{oneOf:[R('RoutePlan'),R('ConsignmentRoutePlan')]},
  FinalScanEvent:{oneOf:[R('ScanEvent'),R('PieceScanEvent')]},
  ShipmentCreated:O({shipment:R('Shipment'),routePlan:R('RoutePlan'),transportLegs:A(R('TransportLeg'),{minItems:1})}),
  ShipmentTimeline:O({shipment:R('Shipment'),routePlans:A(R('RoutePlan')),transportLegs:A(R('TransportLeg')),scanEvents:A(R('ScanEvent')),projection:Q(R('JourneyProjection')),lossCases:A(R('LossCase')),reassignments:A(R('Reassignment'))})
};
const base={tenants:'Tenant',hubs:'Hub',carriers:'Carrier',shipments:'Shipment',routePlans:'RoutePlan',transportLegs:'TransportLeg',scanEvents:'ScanEvent',journeyProjections:'JourneyProjection',lossCases:'LossCase',reassignments:'Reassignment'};
const tenant={tenantId:uid(1),name:'Public Journey Tenant'};
const hubs=[{hubId:uid(2),tenantId:uid(1),code:'ORIGIN',name:'Public Origin',timeZone:'UTC'},{hubId:uid(3),tenantId:uid(1),code:'DEST',name:'Public Destination',timeZone:'UTC'}];
const carrier={carrierId:uid(4),tenantId:uid(1),code:'PUBLIC',name:'Public Carrier',state:'ACTIVE'};
const shipmentInput={tenantId:uid(1),trackingCode:'PUBLIC-TRACK-1',legs:[{fromHubId:uid(2),toHubId:uid(3),carrierId:uid(4)}]};
export default define({taskId:'routeweave',title:'RouteWeave',schemas,resources:{...base,routePlans:'FinalRoutePlan',scanEvents:'FinalScanEvent',consignments:'Consignment',parcelPieces:'ParcelPiece',pieceProjections:'PieceProjection'},seedResources:base,seedValues:{tenants:[tenant],hubs,carriers:[carrier]},snapshotVersion:true,workKinds:['JOURNEY_PROJECT','LOSS_RECONCILE','CONSIGNMENT_PROJECT'],eventTypes:['shipment.created','scan.accepted','shipment.projected','shipment.lost','shipment.found','shipment.reassigned','shipment.delivered','shipment.cancelled'],
  operations:[
    ...[['tenants','Tenant',O({name:S}),{name:'Another Journey Tenant'}],['hubs','Hub',O({tenantId:U,code:S,name:S,timeZone:S}),{tenantId:uid(1),code:'THIRD',name:'Third Hub',timeZone:'UTC'}],['carriers','Carrier',O({tenantId:U,code:S,name:S}),{tenantId:uid(1),code:'SECOND',name:'Second Carrier'}]].flatMap(([path,type,bodySchema,body])=>[get(`list-${path}`,`/api/v1/${path}`,page(type),{query:{...(path==='tenants'?{}:{tenantId:uid(1)}),limit:50}},{parameters:[...(path==='tenants'?[]:query({tenantId:U},['tenantId'])),...pagination]}),post(`create-${path}`,`/api/v1/${path}`,type,bodySchema,{body})]),
    get('list-shipments','/api/v1/shipments',page('Shipment'),{query:{tenantId:uid(1),limit:50}},{parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-shipment','/api/v1/shipments','ShipmentCreated',O({tenantId:U,trackingCode:S,legs}),{body:shipmentInput}),
    get('read-shipment','/api/v1/shipments/:shipmentId','Shipment',{params:{shipmentId:uid(5)}}),
    get('read-shipment-timeline','/api/v1/shipments/:shipmentId/timeline','ShipmentTimeline',{params:{shipmentId:uid(5)}}),
    post('create-scan-event','/api/v1/scan-events','ScanEvent',O({tenantId:U,shipmentId:U,scannerEventId:S,type:scanType,routePlanRevision:P,hubId:Q(U),legId:Q(U),observedAt:D}),{body:{tenantId:uid(1),shipmentId:uid(5),scannerEventId:'public-scan',type:'PICKED_UP',routePlanRevision:1,hubId:uid(2),legId:uid(7),observedAt:time}}),
    post('report-shipment-loss','/api/v1/shipments/:shipmentId/loss','LossCase',O({reason:S,observedAt:D}),{params:{shipmentId:uid(5)},body:{reason:'Public loss report',observedAt:time}}),
    post('report-shipment-found','/api/v1/shipments/:shipmentId/found','LossCase',O({observedAt:D}),{params:{shipmentId:uid(5)},body:{observedAt:time}}),
    post('reassign-shipment','/api/v1/shipments/:shipmentId/reassign','Reassignment',O({lossCaseId:U,expectedRoutePlanRevision:P,reason:S,legs}),{params:{shipmentId:uid(5)},body:{lossCaseId:uid(8),expectedRoutePlanRevision:1,reason:'Public reassignment',legs:shipmentInput.legs}}),
    post('cancel-shipment','/api/v1/shipments/:shipmentId/cancel','Shipment',O({}),{params:{shipmentId:uid(5)},body:{}}),
    get('list-consignments','/api/v1/consignments',page('Consignment'),{query:{tenantId:uid(1),limit:50}},{source:manager,parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-consignment','/api/v1/consignments',O({consignment:R('Consignment'),pieces:A(R('ParcelPiece'),{minItems:1,maxItems:100})}),O({tenantId:U,externalRef:S,pieceRefs:A(S,{minItems:1,maxItems:100,uniqueItems:true}),legs}),{body:{tenantId:uid(1),externalRef:'PUBLIC-CONSIGNMENT',pieceRefs:['piece-a','piece-b'],legs:shipmentInput.legs}},{source:manager}),
    get('read-consignment','/api/v1/consignments/:consignmentId',O({consignment:R('Consignment'),pieces:A(R('ParcelPiece')),projections:A(R('PieceProjection'))}),{params:{consignmentId:uid(9)}},{source:manager}),
    post('reassign-consignment','/api/v1/consignments/:consignmentId/reassign','Consignment',O({reason:S,expectedRoutePlanRevision:P,legs}),{params:{consignmentId:uid(9)},body:{reason:'Shared public reassignment',expectedRoutePlanRevision:1,legs:shipmentInput.legs}},{source:manager}),
    post('cancel-consignment','/api/v1/consignments/:consignmentId/cancel','Consignment',O({}),{params:{consignmentId:uid(9)},body:{}},{source:manager}),
    post('create-piece-scan','/api/v1/parcel-pieces/:pieceId/scan-events','PieceScanEvent',O({tenantId:U,scannerEventId:S,type:E('PICKED_UP','DEPARTED','ARRIVED','DELIVERED'),routePlanRevision:P,legId:U,hubId:U,observedAt:D}),{params:{pieceId:uid(10)},body:{tenantId:uid(1),scannerEventId:'public-piece-scan',type:'PICKED_UP',routePlanRevision:1,legId:uid(7),hubId:uid(2),observedAt:time}},{source:manager}),
    post('report-piece-loss','/api/v1/parcel-pieces/:pieceId/loss','ParcelPiece',O({reason:S,observedAt:D}),{params:{pieceId:uid(10)},body:{reason:'Public piece loss',observedAt:time}},{source:manager}),
    post('report-piece-found','/api/v1/parcel-pieces/:pieceId/found','ParcelPiece',O({observedAt:D}),{params:{pieceId:uid(10)},body:{observedAt:time}},{source:manager})
  ],smoke:[
    {operationId:'create-shipment',body:shipmentInput,headers:{'Idempotency-Key':'smoke-create-shipment'},expectStatus:200,expectBody:{shipment:{tenantId:uid(1),trackingCode:'PUBLIC-TRACK-1',state:'PLANNED'},routePlan:{revision:1}},capture:{newShipmentId:['shipment','shipmentId'],newRoutePlanId:['routePlan','routePlanId']}},
    {operationId:'read-shipment',params:{shipmentId:'${newShipmentId}'},expectStatus:200,expectBody:{shipmentId:'${newShipmentId}',trackingCode:'PUBLIC-TRACK-1',currentRoutePlanId:'${newRoutePlanId}'}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','shipments'],match:{shipmentId:'${newShipmentId}',tenantId:uid(1),trackingCode:'PUBLIC-TRACK-1'}},{path:['resources','transportLegs'],match:{routePlanId:'${newRoutePlanId}',ordinal:1,fromHubId:uid(2),toHubId:uid(3),carrierId:uid(4)}}]}
  ],notes:[
    'V2 wire clarification: create Shipment returns {shipment,routePlan,transportLegs}; detail returns Shipment and timeline returns the exact ShipmentTimeline schema. Loss takes {reason,observedAt}, found takes {observedAt}, cancellation takes {}; reassign returns Reassignment. IDs are UUIDs, revisions/ordinals positive integers and not-yet-observed projection fields are nullable.',
    'V2 wire clarification: native Consignment RoutePlans use consignmentId instead of shipmentId; migrated single-piece Consignments reference the unchanged legacy RoutePlan. Native PieceScanEvent records carry pieceId and routePlanRevision, while unchanged legacy ScanEvents map to a piece via ParcelPiece.legacyShipmentId without duplicate scan identities. FINAL snapshot routePlans and scanEvents expose these closed disjoint shapes.',
    'V2 wire clarification: Consignment reassign/cancel return Consignment, Piece loss/found return ParcelPiece; cancellation of every unfinished piece yields aggregate EXCEPTION because the published Consignment state enum has no CANCELLED. All-delivered is DELIVERED, any lost/cancelled is EXCEPTION, otherwise any delivered is PARTIALLY_DELIVERED, then any in-transit is IN_TRANSIT, otherwise PLANNED. This makes the described recomputable aggregate state deterministic.',
    'Route connectivity, time-zone validity, immutable route membership, source evidence ordering, stale revision fencing and terminal conflicts remain business validation. Manager resources are excluded from V1 seed; no new Manager event names are inferred.'
  ]});
