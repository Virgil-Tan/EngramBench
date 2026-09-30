import {T,S,U,N,P,B,D,E,R,A,O,Q,M,J,uid,time,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const headers=M(T);
const methods=A(E('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'),{minItems:1,uniqueItems:true});
const schemas={
  Backend:O({backendId:U,tenantId:U,name:S,originRedacted:{const:true},state:E('ACTIVE','DISABLED')}),
  SeedBackend:O({backendId:U,tenantId:U,name:S,origin:{...S,pattern:'^https?://[^/@?#]+(?::[0-9]+)?(?:/[^?#]*)?$'},state:E('ACTIVE','DISABLED')}),
  RouteDefinition:O({routeId:U,tenantId:U,name:S,priority:N}),
  RouteRevision:O({routeRevisionId:U,routeId:U,revision:P,pathPattern:S,methods,headerMatches:headers,backends:A(O({backendId:U,version:S,weight:{...P,maximum:10000}}),{minItems:1}),rateLimitPolicyId:Q(U),circuitPolicyId:Q(U),createdAt:D}),
  RateLimitPolicy:O({rateLimitPolicyId:U,tenantId:U,revision:P,windowSeconds:P,limit:P}),
  CircuitPolicy:O({circuitPolicyId:U,tenantId:U,revision:P,sampleSize:P,failureThresholdPercent:{...N,maximum:100},openSeconds:P,halfOpenMax:P}),
  ConfigRelease:O({configReleaseId:U,tenantId:U,version:P,state:E('PENDING','ACTIVE','SUPERSEDED','ROLLED_BACK'),routeRevisionIds:A(U,{uniqueItems:true}),priorReleaseId:Q(U),createdAt:D,activatedAt:Q(D)}),
  GatewayRequest:O({gatewayRequestId:U,tenantId:U,requestKey:S,configReleaseId:U,routeRevisionId:Q(U),backendId:Q(U),backendVersion:Q(S),bucket:Q({...N,maximum:9999}),status:E('SUCCEEDED','REJECTED','FAILED'),responseStatus:{...P,minimum:100,maximum:599},createdAt:D}),
  UpstreamAttempt:O({gatewayRequestId:U,attempt:P,backendId:U,requestIdentity:S,outcome:E('SUCCEEDED','FAILED','TIMEOUT'),startedAt:D,finishedAt:D}),
  RateWindow:O({tenantId:U,rateLimitPolicyId:U,windowStart:D,consumed:N}),
  CircuitWindow:O({tenantId:U,backendId:U,epoch:N,state:E('CLOSED','OPEN','HALF_OPEN'),sampleCount:N,failureCount:N,openUntil:Q(D)}),
  DispatchResult:O({gatewayRequestId:U,routeRevisionId:Q(U),backendVersion:Q(S),status:E('SUCCEEDED','REJECTED','FAILED'),responseStatus:{...P,minimum:100,maximum:599},responseHeaders:headers,body:J}),
  RegionalRollout:O({regionalRolloutId:U,tenantId:U,targetConfigReleaseId:U,requestRef:S,state:E('QUEUED','RUNNING','PAUSED','COMPLETED','CANCELLED','ROLLED_BACK'),currentStageOrdinal:Q(N),createdAt:D,updatedAt:D,sequence:N}),
  RegionalStage:O({regionalStageId:U,regionalRolloutId:U,ordinal:N,region:S,minimumObservationSeconds:{...P,maximum:86400},failureThresholdPercent:{...N,maximum:100},priorConfigReleaseId:Q(U),targetConfigReleaseId:U,state:E('PENDING','ACTIVE','SUCCEEDED','FAILED','ROLLED_BACK'),activatedAt:Q(D),completedAt:Q(D)})
};
const base={tenants:'Tenant',backends:'Backend',routeDefinitions:'RouteDefinition',routeRevisions:'RouteRevision',rateLimitPolicies:'RateLimitPolicy',circuitPolicies:'CircuitPolicy',configReleases:'ConfigRelease',gatewayRequests:'GatewayRequest',upstreamAttempts:'UpstreamAttempt',rateWindows:'RateWindow',circuitWindows:'CircuitWindow'};
const tenant={tenantId:uid(1),name:'Public Gateway Tenant'};
const backend={backendId:uid(2),tenantId:uid(1),name:'Public Local Backend',origin:'http://127.0.0.1:4012',state:'ACTIVE'};
const route={routeId:uid(3),tenantId:uid(1),name:'Public Health Route',priority:10};
const ratePolicy={rateLimitPolicyId:uid(4),tenantId:uid(1),revision:1,windowSeconds:60,limit:1000};
const circuit={circuitPolicyId:uid(5),tenantId:uid(1),revision:1,sampleSize:10,failureThresholdPercent:50,openSeconds:5,halfOpenMax:1};
const revision={routeRevisionId:uid(6),routeId:uid(3),revision:1,pathPattern:'/public/*',methods:['GET'],headerMatches:{},backends:[{backendId:uid(2),version:'1',weight:10000}],rateLimitPolicyId:uid(4),circuitPolicyId:uid(5),createdAt:time};
const release={configReleaseId:uid(7),tenantId:uid(1),version:1,state:'ACTIVE',routeRevisionIds:[uid(6)],priorReleaseId:null,createdAt:time,activatedAt:time};
const setup=[
  ['tenant','tenants','Tenant',O({name:S}),{name:'Another Public Gateway Tenant'}],
  ['backend','backends','Backend',O({tenantId:U,name:S,origin:schemas.SeedBackend.properties.origin}),{tenantId:uid(1),name:'Second Local Backend',origin:'http://127.0.0.1:4013'}],
  ['route-definition','route-definitions','RouteDefinition',O({tenantId:U,name:S,priority:N}),{tenantId:uid(1),name:'Created Through Public HTTP',priority:20}],
  ['route-revision','route-revisions','RouteRevision',O({routeId:U,revision:P,pathPattern:S,methods,headerMatches:headers,backends:schemas.RouteRevision.properties.backends,rateLimitPolicyId:Q(U),circuitPolicyId:Q(U)}),{routeId:uid(3),revision:2,pathPattern:'/public/new/*',methods:['GET'],headerMatches:{},backends:[{backendId:uid(2),version:'1',weight:10000}],rateLimitPolicyId:uid(4),circuitPolicyId:uid(5)}],
  ['rate-limit-policy','rate-limit-policies','RateLimitPolicy',O({tenantId:U,revision:P,windowSeconds:P,limit:P}),{tenantId:uid(1),revision:1,windowSeconds:60,limit:100}],
  ['circuit-policy','circuit-policies','CircuitPolicy',O({tenantId:U,revision:P,sampleSize:P,failureThresholdPercent:{...N,maximum:100},openSeconds:P,halfOpenMax:P}),{tenantId:uid(1),revision:1,sampleSize:10,failureThresholdPercent:50,openSeconds:10,halfOpenMax:1}]
];
const contract=define({taskId:'routepilot',title:'RoutePilot',schemas,resources:{...base,regionalRollouts:'RegionalRollout',regionalStages:'RegionalStage'},seedResources:{...base,backends:'SeedBackend'},seedValues:{tenants:[tenant],backends:[backend],routeDefinitions:[route],routeRevisions:[revision],rateLimitPolicies:[ratePolicy],circuitPolicies:[circuit],configReleases:[release]},snapshotVersion:true,environmentVariables:['UPSTREAM_TIMEOUT_MS'],workKinds:['CONFIG_ACTIVATE','CIRCUIT_RECONCILE','REGIONAL_ROLLOUT_ADVANCE'],eventTypes:['config.release.created','config.release.activated','config.release.rolled_back','gateway.request.completed','gateway.request.rejected','circuit.changed'],
  operations:[
    ...setup.flatMap(([id,path,type,request,body])=>[get(`list-${path}`,`/api/v1/${path}`,page(type),{query:{...(id!=='tenant'&&{tenantId:uid(1)}),limit:50}},{parameters:[...(id!=='tenant'?query({tenantId:U},['tenantId']):[]),...pagination]}),post(`create-${id}`,`/api/v1/${path}`,type,request,{body})]),
    get('list-config-releases','/api/v1/config-releases',page('ConfigRelease'),{query:{tenantId:uid(1),limit:50}},{parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-config-release','/api/v1/config-releases','ConfigRelease',O({tenantId:U,version:P,routeRevisionIds:A(U,{uniqueItems:true}),expectedActiveVersion:N}),{body:{tenantId:uid(1),version:2,routeRevisionIds:[uid(6)],expectedActiveVersion:1}}),
    get('read-config-release','/api/v1/config-releases/:configReleaseId','ConfigRelease',{params:{configReleaseId:uid(7)}}),
    post('rollback-config-release','/api/v1/config-releases/:configReleaseId/rollback','ConfigRelease',O({expectedActiveVersion:N}),{params:{configReleaseId:uid(7)},body:{expectedActiveVersion:2}}),
    post('dispatch-gateway','/api/v1/gateway/dispatch','DispatchResult',O({tenantId:U,method:E('GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'),path:S,headers,body:J,requestKey:S}),{body:{tenantId:uid(1),method:'GET',path:'/public/ping',headers:{'x-route-affinity':'public-customer'},body:null,requestKey:'public-request-1'}}),
    get('read-gateway-request','/api/v1/gateway-requests/:gatewayRequestId','GatewayRequest',{params:{gatewayRequestId:uid(8)}}),
    get('list-regional-rollouts','/api/v1/regional-rollouts',page('RegionalRollout'),{query:{tenantId:uid(1),limit:50}},{source:manager,parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-regional-rollout','/api/v1/regional-rollouts',O({regionalRollout:R('RegionalRollout'),stages:A(R('RegionalStage'))}),O({tenantId:U,targetConfigReleaseId:U,stages:A(O({region:S,minimumObservationSeconds:{...P,maximum:86400},failureThresholdPercent:{...N,maximum:100}}),{minItems:1}),requestRef:S}),{body:{tenantId:uid(1),targetConfigReleaseId:uid(7),stages:[{region:'EU',minimumObservationSeconds:30,failureThresholdPercent:10}],requestRef:'public-regional-1'}},{source:manager}),
    get('read-regional-rollout','/api/v1/regional-rollouts/:regionalRolloutId',O({regionalRollout:R('RegionalRollout'),stages:A(R('RegionalStage'))}),{params:{regionalRolloutId:uid(9)}},{source:manager}),
    ...['pause','resume','cancel','rollback'].map(action=>post(`${action}-regional-rollout`,`/api/v1/regional-rollouts/:regionalRolloutId/${action}`,'RegionalRollout',O({}),{params:{regionalRolloutId:uid(9)},body:{}},{source:manager}))
  ],smoke:[
    {operationId:'read-config-release',params:{configReleaseId:uid(7)},expectStatus:200,expectBody:release},
    {operationId:'create-route-definition',body:{tenantId:uid(1),name:'Created Through Public HTTP',priority:20},headers:{'Idempotency-Key':'smoke-create-route'},expectStatus:200,expectBody:{tenantId:uid(1),name:'Created Through Public HTTP',priority:20},capture:{newRouteId:['routeId']}},
    {operationId:'list-route-definitions',query:{tenantId:uid(1)},expectStatus:200,expectContains:[{path:['items'],match:{routeId:'${newRouteId}',name:'Created Through Public HTTP',priority:20}}]},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','routeDefinitions'],match:{routeId:'${newRouteId}',tenantId:uid(1),name:'Created Through Public HTTP'}}]}
  ],notes:[
    'V2 wire clarification: Backend.origin is accepted only by create and seed; every response uses originRedacted:true and omits origin. Methods are uppercase; headerMatches is an exact-match string map, backend version is a nonempty opaque string, and absent rate/circuit policy is represented by a required null ID.',
    'V2 wire clarification: administrative create bodies are exactly the schemas here; lists except tenants require tenantId. Dispatch body is JSON or a JSON string for textual bytes; null means no upstream body. Response body preserves the upstream decoded JSON, textual string or null. Rejected requests may have null route/backend/bucket fields. No private or hop-by-hop header is returned.',
    'V2 wire clarification: RegionalRollout list returns paged RegionalRollout summaries; detail and create return {regionalRollout,stages}. Stage priorConfigReleaseId is nullable only for a region with no prior active release, where rollback is unavailable. Region selection for dispatch uses x-route-region, default GLOBAL; without this clarified input regional behavior would be unobservable. No region may see a partially activated release.',
    'V2 compatibility clarification: legacy-global migration creates one deterministic completed Rollout/Stage only for each existing Tenant that has an ACTIVE ConfigRelease; a Tenant without a release cannot supply the required release identity and receives no synthetic record until it has an active release. The nonempty seed includes an active release so the published migration case is always testable.'
  ]});
// Seed origins are deliberately private and cannot be compared verbatim with the public snapshot.
contract.smoke[2].expectContains=contract.smoke[2].expectContains.map(check=>check.path[1]==='backends'?{...check,match:{backendId:uid(2),tenantId:uid(1),name:backend.name,state:'ACTIVE',originRedacted:true}}:check);
export default contract;
