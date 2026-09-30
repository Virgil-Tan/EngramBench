import {T,S,U,I,N,P,D,E,R,A,O,Q,pick,uid,time,admin,page,query,pagination,post,get,define,manager} from '../learning/helpers-c.mjs';

// Authored from the preserved README and Manager contract, not evaluator fixtures.
const quantity={...N,maximum:1000000000};
const usageInput=O({eventId:T,meterId:U,occurredAt:D,quantity});
const correctionInput=O({correctionId:T,sourceEventId:T,quantityDelta:{...I,not:{const:0}},reason:T,occurredAt:D});
const usage=O({eventId:T,meterId:U,tenantId:U,occurredAt:D,quantity,ingestedAt:D});
const watermark=O({tenantId:U,watermarkThrough:Q(D),openPeriodStarts:A(D),finalizedThrough:Q(D)});
const resources={tenantStates:'TenantState',meterDefinitions:'MeterDefinition',ratePlans:'RatePlan',usageEvents:'UsageEvent',usageBatches:'UsageBatch',statements:'Statement',correctionEvents:'CorrectionEvent',statementRevisions:'StatementRevision'};
const tenant={tenantId:uid(1),name:'Public tenant',watermarkThrough:null};
const meter={meterId:uid(2),tenantId:uid(1),name:'Public meter'};
const ratePlan={tenantId:uid(1),version:1,effectiveFrom:'2020-01-01T00:00:00.000Z',effectiveTo:null,unitPriceMinor:2};
const seededUsage={eventId:'public-seeded-usage',tenantId:uid(1),meterId:uid(2),occurredAt:'2025-12-15T12:00:00.000Z',quantity:1};
const write={tenantId:uid(1),events:[{eventId:'public-new-usage',meterId:uid(2),occurredAt:'2026-01-15T12:00:00.000Z',quantity:2}]};
const contract=define({taskId:'metersettle',title:'MeterSettle',resources,seedResources:{tenants:'SeedTenant',meterDefinitions:'MeterDefinition',ratePlans:'RatePlan',usageEvents:'SeedUsageEvent'},seedValues:{tenants:[tenant],meterDefinitions:[meter],ratePlans:[ratePlan],usageEvents:[seededUsage]},workKinds:['RATING'],eventTypes:['usage.batch-accepted','watermark.advanced','statement.finalized','statement.revision-finalized'],eventPayload:O({}),environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],schemas:{
  Error:O({error:O({code:S,message:T,details:O({})})}),
  SeedTenant:O({tenantId:U,name:{...S,maxLength:120},watermarkThrough:Q(D)}),
  TenantState:O({...watermark.properties,name:T}),Watermark:watermark,
  MeterDefinition:O({meterId:U,tenantId:U,name:T}),
  RatePlan:O({tenantId:U,version:P,effectiveFrom:D,effectiveTo:Q(D),unitPriceMinor:N}),
  UsageEvent:usage,SeedUsageEvent:pick(usage,'eventId meterId tenantId occurredAt quantity'),
  UsageBatch:O({batchId:U,tenantId:U,acceptedEventIds:A(T),duplicateEventIds:A(T),createdAt:D}),
  RatedLine:O({eventId:T,meterId:U,quantity:N,ratePlanVersion:P,unitPriceMinor:N,chargeMinor:N}),
  Statement:O({statementId:U,tenantId:U,periodStart:D,periodEnd:D,state:E('OPEN','FINALIZING','FINALIZED'),revision:{const:1},totalQuantity:N,totalMinor:N,watermarkThrough:Q(D),ratePlanVersions:A(P),lines:A(R('RatedLine')),finalizedAt:Q(D),sequence:N}),
  CorrectionEvent:O({...correctionInput.properties,tenantId:U,ingestedAt:D}),
  CorrectionBatch:O({batchId:U,acceptedCorrectionIds:A(T),duplicateCorrectionIds:A(T)}),
  StatementRevision:O({statementRevisionId:U,statementId:U,revision:{...P,minimum:2},priorTotalMinor:N,deltaMinor:I,effectiveTotalMinor:N,correctionIds:A(T),state:E('FINALIZING','FINALIZED'),finalizedAt:Q(D)}),
  StatementDetail:O({statement:R('Statement'),revisions:A(R('StatementRevision')),effectiveTotalMinor:N,pendingRevision:Q({...P,minimum:2})}),
  RevisionDetail:O({statementRevision:R('StatementRevision'),correctionEvents:A(R('CorrectionEvent'))}),
},operations:[
  get('list-statements','/api/v1/statements',page('Statement'),{query:{limit:50}},{parameters:pagination}),
  get('get-statement','/api/v1/statements/:statementId','StatementDetail',{params:{statementId:uid(10)}},{source:manager}),
  post('create-usage-batch','/api/v1/usage-batches','UsageBatch',O({tenantId:U,events:A(usageInput,{minItems:1,maxItems:1000})}),{body:write},{status:202}),
  post('advance-watermark','/api/v1/tenants/:tenantId/watermark','Watermark',O({through:D}),{params:{tenantId:uid(1)},body:{through:'2026-02-01T00:00:00.000Z'}}),
  get('get-watermark','/api/v1/tenants/:tenantId/watermark','Watermark',{params:{tenantId:uid(1)}}),
  get('meter-usage','/api/v1/meters/:meterId/usage',page('UsageEvent'),{params:{meterId:uid(2)},query:{limit:50}},{parameters:[...query({from:D,to:D}),...pagination]}),
  get('domain-events','/api/v1/domain-events',page('DomainEvent'),{query:{aggregateId:uid(1),afterSequence:0,limit:50}},{parameters:query({aggregateId:U,afterSequence:N,limit:{...P,maximum:100,default:50}})}),
  post('create-correction-batch','/api/v1/correction-batches','CorrectionBatch',O({tenantId:U,corrections:A(correctionInput,{minItems:1,maxItems:1000})}),{body:{tenantId:uid(1),corrections:[{correctionId:'public-correction',sourceEventId:'public-new-usage',quantityDelta:1,reason:'Public correction',occurredAt:'2026-01-16T12:00:00.000Z'}]}},{source:manager}),
  get('get-statement-revision','/api/v1/statements/:statementId/revisions/:revision','RevisionDetail',{params:{statementId:uid(10),revision:2}},{source:manager}),
],smoke:[
  {operationId:'create-usage-batch',body:write,headers:{'Idempotency-Key':'public-meter-ingest'},expectStatus:202,capture:{batchId:['batchId']}},
  {operationId:'meter-usage',params:{meterId:uid(2)},query:{from:'2026-01-01T00:00:00.000Z',to:'2026-02-01T00:00:00.000Z'},expectStatus:200,expectContains:[{path:['items'],match:{eventId:'public-new-usage',tenantId:uid(1),meterId:uid(2),quantity:2}}]},
  {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','usageBatches'],match:{batchId:'${batchId}',tenantId:uid(1),acceptedEventIds:['public-new-usage'],duplicateEventIds:[]}}]},
],notes:[
  'V2 representation clarification: a watermark mutation returns the same closed Watermark view as its GET (without tenant name). A revision detail returns {statementRevision,correctionEvents}; the Manager StatementDetail is used for current statement detail reads. Revision is an integer >=2, not a UUID. Base Statement revision remains exactly 1.',
  'Usage filters from/to are optional UTC bounds on occurredAt and use [from,to); omitted bounds are unbounded. Usage collection order is occurredAt then eventId; statement list order is statementId. Domain-event afterSequence defaults to zero and its nextCursor is null: continuation uses the last returned sequence together with aggregateId. Without aggregateId, order is aggregateId then sequence then eventId.',
  'The SeedUsageEvent deliberately omits ingestedAt; the importer derives it from importedAt. Seed is exactly the four published V1 arrays. Snapshot adds the Manager arrays, and tenantStates differs from the seed tenants view. Resource ordering remains the precise README/Manager tuple, including ratePlans tenantId/version, usageEvents tenantId/eventId, correctionEvents tenantId/correctionId and statementRevisions statementId/revision.',
  'The minimally sufficient rate-plan wire encoding is the published immutable flat unitPriceMinor. No tiers, private billing policy or new financial rounding rule is introduced. All integer arithmetic, corrections, month assignment, finalized-watermark rules and overflow detection remain implementation responsibilities.',
  'V2 representation clarification: acceptedEventIds/duplicateEventIds and acceptedCorrectionIds/duplicateCorrectionIds each preserve relative request-member order. Correction reason is the published unrestricted string, including empty text; no private reason-length limit is added. Correction ingestion itself emits no DomainEvent: the sole additional Manager type is statement.revision-finalized after finalization.',
  'Stable business errors remain INVALID_USAGE_BATCH (400), RATE_PLAN_UNAVAILABLE, EVENT_ID_CONFLICT, LATE_USAGE_EVENT, WATERMARK_NOT_ADVANCING (409), INVALID_CORRECTION_BATCH and CORRECTION_TOTAL_OVERFLOW (400), CORRECTION_ID_CONFLICT, NEGATIVE_EFFECTIVE_USAGE and STATEMENT_REVISION_PENDING (409). Shape errors on batch requests use the corresponding published INVALID_*_BATCH, unknown keys still UNKNOWN_FIELD.',
]});
contract.httpHost='127.0.0.1';
contract.transportErrors={auth:{status:401,code:'ADMIN_AUTH_REQUIRED'},unknownField:{status:400,code:'UNKNOWN_FIELD'}};
contract.seed.command=['npm','run','db:seed','--','--file','${SEED_PATH}'];contract.seed.replay=true;
for(const operation of contract.operations){operation.errors=Object.fromEntries([400,401,404,409,415].map(code=>[code,R('Error')]));if(operation.id==='get-statement-revision')operation.parameters.find(p=>p.name==='revision').schema={...P,minimum:2};if(operation.id==='create-usage-batch'||operation.id==='create-correction-batch')operation.transportErrors={invalidRequest:{status:400,code:operation.id==='create-usage-batch'?'INVALID_USAGE_BATCH':'INVALID_CORRECTION_BATCH'}};}
export default contract;
