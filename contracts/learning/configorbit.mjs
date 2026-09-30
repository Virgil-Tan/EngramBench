import {T,S,U,N,P,B,D,H,E,R,A,O,Q,M,J,pick,uid,time,digest,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const bp={...N,maximum:10000};
const environmentKey=E('development','staging','production');
const schemas={
  Application:O({applicationId:U,tenantId:U,key:S,name:S}),
  Environment:O({environmentId:U,applicationId:U,key:environmentKey,generation:N,activeReleaseId:Q(U),createdAt:D}),
  ConfigRevision:O({revisionId:U,environmentId:U,revision:P,parentRevisionId:Q(U),state:E('DRAFT','PUBLISHED','ABANDONED'),document:M(J),documentDigest:H,schemaRevision:P,createdAt:D,publishedAt:Q(D)}),
  Release:O({releaseId:U,environmentId:U,revisionId:U,previousReleaseId:Q(U),state:E('SCHEDULED','ACTIVE','SUPERSEDED','ROLLED_BACK','CANCELLED'),rolloutBasisPoints:bp,audienceSalt:S,generation:P,createdAt:D,activatedAt:Q(D),terminalAt:Q(D)}),
  ClientObservation:O({clientId:S,environmentId:U,lastGeneration:N,lastReleaseId:Q(U),lastSeenAt:D}),
  Invalidation:O({invalidationId:U,environmentId:U,generation:P,releaseId:U,eventId:U,state:E('PENDING','DELIVERING','DELIVERED'),createdAt:D,deliveredAt:Q(D)}),
  ClientConfig:O({releaseId:U,revisionId:U,generation:N,document:M(J),documentDigest:H,etag:S}),
  PromotionTrain:O({trainId:U,tenantId:U,applicationId:U,name:S,revisionId:U,revisionDigest:H,state:E('DRAFT','RUNNING','COMPLETED','ROLLED_BACK','CANCELLED'),audienceSalt:S,createdAt:D,startedAt:Q(D),terminalAt:Q(D)}),
  PromotionStage:O({trainId:U,position:N,environmentId:U,rolloutBasisPoints:bp,state:E('PENDING','ACTIVE','PROMOTED','ROLLED_BACK')})
};
const base={tenants:'Tenant',applications:'Application',environments:'Environment',configRevisions:'ConfigRevision',releases:'Release',clientObservations:'ClientObservation',invalidations:'Invalidation',auditEntries:'AuditEntry'};
const tenant={tenantId:uid(1),name:'Public Config Tenant'};
const application={applicationId:uid(2),tenantId:uid(1),key:'catalog',name:'Public Catalog'};
const environment={environmentId:uid(3),applicationId:uid(2),key:'development',generation:0,activeReleaseId:null,createdAt:time};
const revisionInput={environmentId:uid(3),parentRevisionId:null,document:{theme:'light'},schemaRevision:1};
const options={expectedGeneration:N,rolloutBasisPoints:bp,audienceSalt:S,startAt:D};
export default define({taskId:'configorbit',title:'ConfigOrbit',schemas,resources:{...base,promotionTrains:'PromotionTrain',promotionStages:'PromotionStage'},seedResources:base,importedAt:false,seedValues:{tenants:[tenant],applications:[application],environments:[environment]},
  workKinds:['DRAFT_EXPIRY','RELEASE_ACTIVATE','CACHE_INVALIDATE','EVENT_DELIVERY','PROMOTION_ADVANCE','PROMOTION_ROLLBACK'],
  eventTypes:['revision.created','revision.published','release.activated','release.rollout_changed','release.rolled_back'],
  operations:[
    post('create-tenant','/api/v1/tenants','Tenant',O({name:S}),{body:{name:'Another Config Tenant'}}),
    post('create-application','/api/v1/applications','Application',pick(schemas.Application,'tenantId key name'),{body:{tenantId:uid(1),key:'billing',name:'Billing'}}),
    post('create-environment','/api/v1/environments','Environment',O({applicationId:U,key:environmentKey}),{body:{applicationId:uid(2),key:'staging'}}),
    post('create-config-revision','/api/v1/config-revisions','ConfigRevision',O({environmentId:U,parentRevisionId:Q(U),document:M(J),schemaRevision:P}),{body:revisionInput}),
    get('read-config-revision','/api/v1/config-revisions/:revisionId','ConfigRevision',{params:{revisionId:uid(4)}}),
    post('publish-config-revision','/api/v1/config-revisions/:revisionId/publish','Release',O(options),{params:{revisionId:uid(4)},body:{expectedGeneration:0,rolloutBasisPoints:10000,audienceSalt:'public-rollout',startAt:time}}),
    post('change-rollout','/api/v1/environments/:environmentId/rollout','Release',O(options,['expectedGeneration','rolloutBasisPoints','audienceSalt']),{params:{environmentId:uid(3)},body:{expectedGeneration:1,rolloutBasisPoints:5000,audienceSalt:'public-rollout-next'}}),
    post('rollback-environment','/api/v1/environments/:environmentId/rollback','Release',O({expectedGeneration:N,revisionId:U,audienceSalt:S}),{params:{environmentId:uid(3)},body:{expectedGeneration:2,revisionId:uid(4),audienceSalt:'public-rollback'}}),
    get('list-releases','/api/v1/environments/:environmentId/releases',page('Release'),{params:{environmentId:uid(3)},query:{limit:50}},{parameters:pagination}),
    get('client-config','/api/v1/client-config','ClientConfig',{query:{tenantId:uid(1),applicationKey:'catalog',environmentKey:'development',clientId:'public-client',knownGeneration:0}},{parameters:[...query({tenantId:U,applicationKey:S,environmentKey,clientId:S,knownGeneration:N},['tenantId','applicationKey','environmentKey','clientId']),{name:'If-None-Match',in:'header',required:false,schema:S}],successStatuses:[200,304],successResponses:{304:{description:'No body; resolved release and known generation are both current.'}}}),
    post('observe-client','/api/v1/client-observations','ClientObservation',pick(schemas.ClientObservation,'clientId environmentId lastGeneration lastReleaseId'),{body:{clientId:'public-client',environmentId:uid(3),lastGeneration:0,lastReleaseId:null}}),
    get('list-audit','/api/v1/audit',page('AuditEntry'),{query:{tenantId:uid(1),limit:50}},{parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-promotion-train','/api/v1/promotion-trains','PromotionTrain',O({tenantId:U,applicationId:U,name:S,revisionId:U,stages:A(O({environmentId:U,rolloutBasisPoints:bp}),{minItems:1,maxItems:3})}),{body:{tenantId:uid(1),applicationId:uid(2),name:'Public Promotion',revisionId:uid(4),stages:[{environmentId:uid(3),rolloutBasisPoints:10000}]}},{source:manager}),
    post('start-promotion-train','/api/v1/promotion-trains/:trainId/start','PromotionTrain',O({}),{params:{trainId:uid(5)},body:{}},{source:manager}),
    ...['advance','rollback'].map(action=>post(`${action}-promotion-train`,`/api/v1/promotion-trains/:trainId/${action}`,'PromotionTrain',O({expectedStage:N,expectedEnvironmentGeneration:N}),{params:{trainId:uid(5)},body:{expectedStage:0,expectedEnvironmentGeneration:1}},{source:manager}))
  ],
  smoke:[
    {operationId:'create-config-revision',body:revisionInput,headers:{'Idempotency-Key':'smoke-config-revision'},expectStatus:200,expectBody:{environmentId:uid(3),state:'DRAFT',document:{theme:'light'},parentRevisionId:null},capture:{newRevisionId:['revisionId']}},
    {operationId:'read-config-revision',params:{revisionId:'${newRevisionId}'},expectStatus:200,expectBody:{revisionId:'${newRevisionId}',environmentId:uid(3),state:'DRAFT',document:{theme:'light'}}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','configRevisions'],match:{revisionId:'${newRevisionId}',environmentId:uid(3),document:{theme:'light'}}}]}
  ],notes:[
    'V2 wire clarification: revision creation takes environmentId, parentRevisionId, document and schemaRevision. Document is an object; reject credential-like keys recursively. Publication takes expectedGeneration, rolloutBasisPoints, audienceSalt and startAt and returns the created Release. Rollout uses the same options with optional startAt (omission means database now); rollback takes expectedGeneration, revisionId and audienceSalt, creating a full-rollout Release.',
    'V2 wire clarification: ClientObservation input excludes server lastSeenAt. Audit reads require tenantId. 304 has an empty response body and is permitted only by the published ETag/generation rule. Every other successful client fetch returns ClientConfig.',
    'V2 wire clarification: PromotionTrain audienceSalt is generated and frozen by the server on creation, and all accepted mutations return the complete Train; its ordered stages remain observable in the exact FINAL snapshot. No extra cancel endpoint is invented.'
  ]});
