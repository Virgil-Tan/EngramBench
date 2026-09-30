// Public schema construction only: no domain implementation or evaluator fixtures.
export const T = {type:'string'};
export const S = {...T,minLength:1};
export const U = {...T,format:'uuid',pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'};
export const I = {type:'integer',minimum:Number.MIN_SAFE_INTEGER,maximum:Number.MAX_SAFE_INTEGER};
export const N = {...I,minimum:0};
export const P = {...I,minimum:1};
export const B = {type:'boolean'};
export const D = {...T,format:'date-time',pattern:'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'};
export const H = {...T,pattern:'^[0-9a-f]{64}$'};
export const C = {...T,pattern:'^[A-Z]{3}$'};
export const E = (...values) => ({enum:values});
export const R = name => ({$ref:`#/$defs/${name}`});
export const A = (items,extra={}) => ({type:'array',items,...extra});
export const O = (properties,required=Object.keys(properties)) => ({type:'object',properties,required,additionalProperties:false});
export const Q = schema => ({anyOf:[schema,{type:'null'}]});
export const M = schema => ({type:'object',additionalProperties:schema});
export const J = R('JsonValue');
export const pick = (schema,keys,optional=[]) => O(Object.fromEntries(keys.split(' ').map(key=>[key,schema.properties[key]])),keys.split(' ').filter(k=>!optional.includes(k)));
export const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const time = '2026-01-01T00:00:00.000Z';
export const digest = 'a'.repeat(64);
export const admin = {Authorization:'Bearer ${ADMIN_TOKEN}'};
export const page = schema => O({items:A(typeof schema==='string'?R(schema):schema),nextCursor:Q(T)});
export const query = (properties,required=[]) => Object.entries(properties).map(([name,schema])=>({name,in:'query',required:required.includes(name),schema}));
export const pagination = query({limit:{...P,maximum:100,default:50},cursor:S});
export const source = 'docs/frontal-legacy/README.md';
export const manager = 'docs/frontal-legacy/manager-requirements.md';
export const wire = 'contract/README.md (V2 wire clarification)';
export function op(id,method,path,response,request,example={},extra={}) {
  const mutation=!['GET','HEAD','OPTIONS'].includes(method);
  return {id,method,path,status:200,source,...(request!==undefined&&{request}),response:typeof response==='string'?R(response):response,
    example:{...example,...(mutation&&{headers:{'Idempotency-Key':`public-example-${id}`,...example.headers}})},
    parameters:[...(mutation?[{name:'Idempotency-Key',in:'header',required:true,schema:{...S,maxLength:128,pattern:'^[!-~]+$'}}]:[])],...extra};
}
export const post = (id,path,response,request,example={},extra={}) => op(id,'POST',path,response,request,example,extra);
export const get = (id,path,response,example={},extra={}) => op(id,'GET',path,response,undefined,example,extra);
export function define({taskId,title,schemas,resources,seedResources=resources,seedValues,operations,workKinds,eventTypes,smoke=[],notes=[],importedAt=true,snapshotVersion=false,environmentVariables=[],eventPayload}) {
  const arrays = mapping => Object.fromEntries(Object.entries(mapping).map(([key,name])=>[key,A(R(name))]));
  const definitions={
    JsonValue:{anyOf:[{type:'null'},B,T,{type:'number'},A(R('JsonValue')),M(R('JsonValue'))]},
    Error:O({error:O({code:S,message:T,details:M(J)})}),
    Tenant:O({tenantId:U,name:S}),
    AuditCheckpoint:O({tenantId:U,sequence:N,digest:H,createdAt:D}),
    AuditEntry:O({auditEntryId:U,tenantId:U,sequence:P,eventType:S,subjectRef:S,payloadDigest:H,priorDigest:Q(H),digest:H,createdAt:D}),
    Work:{...O({workId:U,kind:E(...workKinds),aggregateId:U,state:E('PENDING','LEASED','SUCCEEDED','FAILED','CANCELLED'),terminal:B,attempt:N,leaseOwner:Q(S),leaseExpiresAt:Q(D)}),allOf:[
      {if:{properties:{state:{const:'LEASED'}}},then:{properties:{leaseOwner:S,leaseExpiresAt:D}},else:{properties:{leaseOwner:{type:'null'},leaseExpiresAt:{type:'null'}}}},
      {if:{properties:{state:E('SUCCEEDED','FAILED','CANCELLED')}},then:{properties:{terminal:{const:true}}},else:{properties:{terminal:{const:false}}}}
    ]},
    DomainEvent:O({eventId:U,aggregateId:U,sequence:P,type:eventTypes?.length?E(...eventTypes):S,occurredAt:D,schemaVersion:{const:1},payload:eventPayload??M(J)}),
    ...schemas
  };
  definitions.Seed=O({schemaVersion:{const:1},seedVersion:{...S,maxLength:64},...(importedAt&&{importedAt:D}),...arrays(seedResources)});
  definitions.SnapshotResources=O(arrays(resources));
  definitions.VerificationSnapshot=O({...(snapshotVersion&&{schemaVersion:{const:1}}),asOf:D,resources:R('SnapshotResources'),work:A(R('Work')),events:A(R('DomainEvent'))});
  const example={schemaVersion:1,seedVersion:`public-${taskId}-v2`,...(importedAt&&{importedAt:time}),...Object.fromEntries(Object.keys(seedResources).map(key=>[key,seedValues[key]??[]]))};
  const initialChecks=Object.entries(seedValues).filter(([key,value])=>resources[key]&&value.length).map(([key,value])=>({path:['resources',key],match:value[0]}));
  for(const operation of operations) {
    const paths=[...operation.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([,name])=>({name,in:'path',required:true,schema:name==='subjectId'?S:name==='packageName'?{...S,pattern:'^[a-z0-9][a-z0-9._-]{0,127}$'}:name==='platform'?{...S,pattern:'^[a-z0-9][a-z0-9._-]{0,63}$'}:name==='version'?{...S,maxLength:64,pattern:'^[!-~]+$'}:U}));
    operation.parameters=[...paths,...(operation.parameters??[]).filter(p=>p.in!=='path')];
  }
  return {taskId,title,environmentVariables:['PORT','DATABASE_URL','TEST_DATABASE_URL','ADMIN_TOKEN','WEBHOOK_URL','WORK_LEASE_SECONDS','TEST_BARRIER_URL','TEST_BARRIER_TOKEN',...environmentVariables],commands:['npm run build','npm run db:migrate','npm run db:seed -- --file <seed.json>','npm run dev','npm run start:api','npm run start:worker','npm run start:dispatcher',...['unit','integration','e2e','concurrency','recovery','all','perf'].map(n=>`npm run test:${n}`)],seed:{schema:definitions.Seed,example},schemas:definitions,
    operations:[get('health','/healthz',O({status:{const:'ok'}})),get('openapi','/openapi.json',{type:'object',required:['openapi','info','paths','components'],properties:{openapi:{...T,pattern:'^3\\.1\\.'},info:{type:'object'},paths:{type:'object'},components:{type:'object'}}}),get('production-ui','/',{...T,contentMediaType:'text/html'}),...operations,get('verification-snapshot','/api/v1/verification-snapshot','VerificationSnapshot',{headers:admin},{parameters:[{name:'Authorization',in:'header',required:true,schema:S}]})],
    smoke:[{operationId:'health',expectStatus:200},{operationId:'openapi',expectStatus:200},{operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:initialChecks},...smoke],
    notes:[
      'The complete public README and Manager requirements remain business authority. These V2 schemas freeze previously unspecified transport fields; they are authored from public documents only. The public smoke checks interface and persistence identity, not complete business correctness.',
      'V2 wire clarification: health returns {status:"ok"}; the production root returns HTML. Mutation bodies are closed, server-generated identity/state/timestamps are outputs, all mutation examples require durable Idempotency-Key, and unspecified success status is 200. Path parameters use their corresponding resource field types. Collection limits are 1..100 (default 50) with stable opaque cursors.',
      'V2 wire clarification: Tenant is {tenantId,name}; the default AuditEntry/AuditCheckpoint, DomainEvent envelope and fenced Work fields are the published schema definitions. Unless legacy prose literally fixes payload to {}, DomainEvent.payload is a public JSON object. This does not authorize exposing secrets or inventing event types.',
      'V2 wire clarification: snapshot is one PostgreSQL point-in-time with exact resources, work and events keys (and schemaVersion only where declared). Resource arrays are complete, sorted by public identity tuple; audit by tenantId then sequence, events by aggregateId then sequence then eventId, Work by workId. Foreign keys, state invariants and digest validity remain implementation validation. Token/credential/private-path fields never appear in snapshot.',
      'Seed preserves exactly the V1 top-level members; Manager-only resources are created by public operations or the explicitly required compatibility migration. The nonempty example is a minimal legal starting graph, with no evaluator fixtures.',...notes]
  };
}
