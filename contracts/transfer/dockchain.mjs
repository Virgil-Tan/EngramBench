import {T,S,U,I,N,P,D,E,R,A,O,Q,uid,time,admin,page,query,pagination,post,get,define,manager} from '../learning/helpers-c.mjs';

// All wire decisions below originate in the original public README + Manager.
const interval=O({startAt:D,endAt:D});
const movementInput=O({...interval.properties,requiredTugs:P,containerUnits:P});
const legacyFields={portCallId:U,vesselId:U,arrivalAt:D,departureAt:D,requiredTugs:P,containerUnits:P,berthId:U,tugPoolId:U,yardWindowId:U,state:E('HELD','CLEARED','IN_SERVICE','COMPLETED','CANCELLED','EXPIRED'),expiresAt:D,startedAt:Q(D),completedAt:Q(D),sequence:N};
const nullable=['arrivalAt','departureAt','requiredTugs','containerUnits','berthId','tugPoolId','yardWindowId','expiresAt','startedAt','completedAt'];
const finalFields={...legacyFields,...Object.fromEntries(nullable.map(k=>[k,Q(legacyFields[k])])),state:E('HELD','CLEARED','IN_SERVICE','ARRIVED','COMPLETED','CANCELLED','EXPIRED'),movements:A(R('PortMovement'),{minItems:1,maxItems:2})};
const resourceType=E('BERTH','TUG_POOL','YARD_WINDOW');
const seedResources={berths:'Berth',tugPools:'TugPool',yardWindows:'YardWindow',vessels:'Vessel',portCalls:'LegacyPortCall',standbyEntries:'StandbyEntry'};
const resources={...seedResources,portCalls:'PortCall',resourceAllocations:'ResourceAllocation',clearances:'Clearance',portMovements:'PortMovement'};
const availability=[{startAt:'2020-01-01T00:00:00.000Z',endAt:'2040-01-01T00:00:00.000Z'}];
const berth={berthId:uid(1),name:'Public berth',priority:1,maxLengthMeters:300,availability};
const tug={tugPoolId:uid(2),name:'Public tugs',priority:1,capacity:4,availability};
const yard={yardWindowId:uid(3),priority:1,capacityUnits:100,...availability[0]};
const vessel={vesselId:uid(4),name:'Public vessel',lengthMeters:100};
const legacyCreate=O({vesselId:U,arrivalAt:D,departureAt:D,requiredTugs:P,containerUnits:P});
const linkedCreate=O({vesselId:U,arrival:movementInput,departure:movementInput});
const creation={vesselId:uid(4),arrival:{startAt:'2030-01-01T00:00:00.000Z',endAt:'2030-01-01T01:00:00.000Z',requiredTugs:1,containerUnits:1},departure:{startAt:'2030-01-01T03:00:00.000Z',endAt:'2030-01-01T04:00:00.000Z',requiredTugs:1,containerUnits:1}};
const standby=O({vesselId:U,arrivalFrom:D,arrivalTo:D,durationMinutes:{...P,minimum:60,maximum:1440,multipleOf:15},requiredTugs:P,containerUnits:P,priority:I});
const operations=[
  get('list-port-calls','/api/v1/port-calls',page('PortCall'),{query:{limit:50}},{parameters:pagination}),
  get('get-port-call','/api/v1/port-calls/:portCallId','PortCall',{params:{portCallId:uid(10)}},{source:manager}),
  post('create-port-call','/api/v1/port-calls','PortCallReply',{oneOf:[legacyCreate,linkedCreate]},{body:creation},{status:201,source:manager}),
  ...['confirm','start-service','cancel','complete'].map(action=>post(`${action}-port-call`,`/api/v1/port-calls/:portCallId/${action}`,'PortCallReply',action==='cancel'?O({reason:T}):O({}),{params:{portCallId:uid(10)},body:action==='cancel'?{reason:'Public cancellation'}:{}})),
  post('create-standby-entry','/api/v1/standby-entries','StandbyEntry',standby,{body:{vesselId:uid(4),arrivalFrom:'2030-01-02T00:00:00.000Z',arrivalTo:'2030-01-03T00:00:00.000Z',durationMinutes:60,requiredTugs:1,containerUnits:1,priority:1}},{status:201}),
  get('feasible-windows','/api/v1/port-resources/feasible-windows','FeasibleWindowPage',{query:{vesselId:uid(4),arrivalFrom:'2030-01-01T00:00:00.000Z',arrivalTo:'2030-01-02T00:00:00.000Z',durationMinutes:60,requiredTugs:1,containerUnits:1,limit:50}},{parameters:[...query(Object.fromEntries(Object.entries(standby.properties).filter(([k])=>k!=='priority')),['vesselId','arrivalFrom','arrivalTo','durationMinutes','requiredTugs','containerUnits']),...pagination]}),
  get('resource-schedule','/api/v1/port-resources/schedule','ResourceSchedule',{query:{from:'2030-01-01T00:00:00.000Z',to:'2030-01-01T01:00:00.000Z'}},{parameters:query({from:D,to:D},['from','to'])}),
  get('domain-events','/api/v1/domain-events',page('DomainEvent'),{query:{aggregateId:uid(10),afterSequence:0,limit:50}},{parameters:query({aggregateId:U,afterSequence:N,limit:{...P,maximum:100,default:50}})}),
  ...['confirm','start-service','cancel','complete'].map(action=>post(`${action}-movement`,`/api/v1/port-calls/:portCallId/movements/:movementId/${action}`,'PortMovement',action==='cancel'?O({reason:T}):O({}),{params:{portCallId:uid(10),movementId:uid(11)},body:action==='cancel'?{reason:'Public cancellation'}:{}},{source:manager})),
];
const contract=define({taskId:'dockchain',title:'DockChain',resources,seedResources,importedAt:false,seedValues:{berths:[berth],tugPools:[tug],yardWindows:[yard],vessels:[vessel]},workKinds:['PORT_CALL_EXPIRY','CLEARANCE','STANDBY_PROMOTION'],eventTypes:['port-call.held','port-call.cleared','port-call.started','port-call.completed','port-call.cancelled','port-call.expired','standby.created','standby.promoted'],eventPayload:O({}),environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],schemas:{
  Error:O({error:O({code:S,message:T,details:O({})})}),Interval:interval,
  Berth:O({berthId:U,name:T,priority:I,maxLengthMeters:P,availability:A(interval)}),
  TugPool:O({tugPoolId:U,name:T,priority:I,capacity:N,availability:A(interval)}),
  YardWindow:O({yardWindowId:U,priority:I,capacityUnits:N,startAt:D,endAt:D}),Vessel:O({vesselId:U,name:T,lengthMeters:P}),
  LegacyPortCall:O(legacyFields),PortCall:O(finalFields),PortCallReply:{oneOf:[R('LegacyPortCall'),R('PortCall')]},
  PortMovement:O({movementId:U,portCallId:U,type:E('ARRIVAL','DEPARTURE'),berthId:U,tugPoolId:U,yardWindowId:U,startAt:D,endAt:D,requiredTugs:P,containerUnits:P,state:legacyFields.state,expiresAt:D,startedAt:Q(D),completedAt:Q(D),clearanceTaskId:Q(U),sequence:N}),
  ResourceAllocation:O({resourceType,resourceId:U,startAt:D,endAt:D,quantity:N}),
  StandbyEntry:O({standbyEntryId:U,...standby.properties,state:E('WAITING','PROMOTED','WITHDRAWN'),requestedAt:D,portCallId:Q(U)}),
  Clearance:O({portCallId:U,taskId:U,attempt:N,state:E('PENDING','LEASED','PASSED','FAILED'),checkedRules:A(T),completedAt:Q(D)}),
  FeasibleWindowPage:page(O({arrivalAt:D,departureAt:D,berthId:U,tugPoolId:U,yardWindowId:U})),
  ScheduleBucket:O({resourceType,resourceId:U,startAt:D,endAt:D,capacity:N,allocatedQuantity:N}),ResourceSchedule:O({items:A(R('ScheduleBucket'))}),
},operations,smoke:[
  {operationId:'create-port-call',body:creation,headers:{'Idempotency-Key':'public-dock-create'},expectStatus:201,capture:{portCallId:['portCallId']}},
  {operationId:'get-port-call',params:{portCallId:'${portCallId}'},expectStatus:200,capture:{arrivalId:['movements',0,'movementId'],departureId:['movements',1,'movementId']},expectBody:{portCallId:'${portCallId}',vesselId:uid(4),state:'HELD',arrivalAt:null},expectContains:[{path:['movements'],match:{type:'ARRIVAL',...creation.arrival}},{path:['movements'],match:{type:'DEPARTURE',...creation.departure}}]},
  {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','portCalls'],match:{portCallId:'${portCallId}',vesselId:uid(4),state:'HELD'}},{path:['resources','portMovements'],match:{movementId:'${arrivalId}',portCallId:'${portCallId}'}}]},
],notes:[
  'V2 compatibility clarification: create accepts either the exact V1 flat body or the exact Manager linked body, never a mixture. V1 flat requests remain necessary for the unchanged published performance workload. Both create forms retain status 201. Current resources include movements; saved V1 mutation replay responses remain exact legacy PortCall JSON, hence the narrowly scoped mutation response union. The seed remains exactly V1 (no importedAt, work or movements).',
  'V2 representation clarification: schedule returns {items:[ScheduleBucket]}. Each bucket names resourceType, resourceId, startAt, endAt, capacity and allocatedQuantity; BERTH capacity is one and its allocatedQuantity is occupancy (zero or one). Tug and yard buckets report integer capacity and reserved quantity. Buckets are 15 minutes, cover [from,to), and are ordered by startAt, resourceType, resourceId. The complete public resource allocation and point-in-time conservation rules still apply.',
  'Port-call collection order is portCallId. Feasible-window filter parameters and schedule from/to are required; feasible-window cursor encodes exactly the full published tuple. Domain-event afterSequence defaults to zero; nextCursor is null and continuation uses last sequence with aggregateId. Without aggregateId, events use snapshot event order.',
  'All linked movement business conditions, 120-minute turnaround, 180-second database-clock expiry, aggregate state precedence, immutable completed arrival, deterministic standby head blocking and atomic capacity ownership remain implementation responsibilities. These schemas do not supply their algorithms.',
  'Stable errors: WINDOW_UNAVAILABLE, PORT_CALL_EXPIRED, CLEARANCE_REQUIRED, PORT_CALL_NOT_CANCELLABLE, PORT_CALL_STATE_CONFLICT, TURNAROUND_GAP_TOO_SHORT, MOVEMENT_STATE_CONFLICT (409), INVALID_PORT_CALL_INTERVAL (400). New Manager transitions introduce no extra event type or payload field. Snapshot arrays use the exact README/Manager tuples, including resourceAllocations resourceType/resourceId/startAt/endAt and portMovements portCallId/movementId.',
]});
contract.httpHost='127.0.0.1';contract.transportErrors={auth:{status:401,code:'ADMIN_AUTH_REQUIRED'},unknownField:{status:400,code:'UNKNOWN_FIELD'}};
contract.seed.command=['npm','run','db:seed','--','--file','${SEED_PATH}'];contract.seed.replay=true;
for(const operation of contract.operations){
  operation.errors=Object.fromEntries([400,401,404,409,415].map(code=>[code,R('Error')]));
  if(operation.id==='create-port-call')operation.bodyTransportErrors=['/requiredTugs','/containerUnits','/arrival/requiredTugs','/arrival/containerUnits','/departure/requiredTugs','/departure/containerUnits'].map(path=>({path,when:'number',status:400,code:'INVALID_PORT_CALL_INTERVAL'}));
  if(operation.id==='create-standby-entry')operation.bodyTransportErrors=['/requiredTugs','/containerUnits','/durationMinutes'].map(path=>({path,when:'number',status:400,code:'INVALID_PORT_CALL_INTERVAL'}));
}
export default contract;
