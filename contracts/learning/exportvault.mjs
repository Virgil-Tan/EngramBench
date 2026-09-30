import {createHash} from 'node:crypto';
import {T,S,U,N,P,D,H,E,R,A,O,Q,uid,time,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const scopeName=E('profile','activity','orders','files');
const scope=A(scopeName,{minItems:1,maxItems:20,uniqueItems:true});
const content=O({sha256:H,size:N,mediaType:S});
const raw={type:'string',contentMediaType:'application/octet-stream'};
const range=O({afterRecordId:Q(U),throughRecordId:Q(U)});
const schemas={
  ExportSubject:O({subjectId:U,name:S,currentDatasetRevision:P}),
  DatasetRecord:O({recordId:U,scope:scopeName,data:R('JsonValue')}),
  DatasetRevision:O({subjectId:U,revision:P,committedAt:D,records:A(R('DatasetRecord'))}),
  DatasetRevisionSummary:O({subjectId:U,revision:P,committedAt:D,recordCount:N,recordsDigest:H}),
  LegacyExport:O({exportId:U,subjectId:U,scope,format:E('JSONL','CSV'),datasetRevision:P,state:E('REQUESTED','GENERATING','READY','EXPIRED','CANCELLED','FAILED'),object:Q(content),retentionUntil:D,createdAt:D,readyAt:Q(D),sequence:N}),
  ExportSection:O({exportId:U,name:scopeName,recordCount:N,firstRecordId:Q(U),lastRecordId:Q(U),digest:H,state:E('PENDING','WRITTEN','VERIFIED')}),
  DownloadGrant:O({grantId:U,exportId:U,expiresAt:D,revokedAt:Q(D),createdAt:D}),
  DeletionProof:O({exportId:U,objectSha256:H,reason:E('EXPIRED','CANCELLED'),deletedAt:D,proofDigest:H}),
  ExportShard:O({shardId:U,exportId:U,ordinal:N,section:scopeName,range,recordCount:N,state:E('PENDING','GENERATING','VERIFIED','FAILED','CANCELLED'),object:Q(content)}),
  ExportManifest:O({manifestId:U,exportId:U,canonicalDigest:H,object:O({sha256:H,size:N,mediaType:{const:'application/json'}}),shards:A(O({shardId:U,ordinal:N,section:scopeName,range:O({afterRecordId:Q(U),throughRecordId:U}),recordCount:P,sha256:H,size:N,mediaType:S}),{minItems:2,maxItems:100}),createdAt:D}),
  ShardedDownloadGrant:O({grantId:U,exportId:U,target:E('MANIFEST','SHARD'),shardId:Q(U),expiresAt:D,revokedAt:Q(D),createdAt:D})
};
schemas.ShardedExport=O({...schemas.LegacyExport.properties,object:{type:'null'},manifest:Q(R('ExportManifest')),shards:A(R('ExportShard'),{minItems:2,maxItems:100})});
schemas.Export={oneOf:[R('LegacyExport'),R('ShardedExport')]};
schemas.Grant={oneOf:[R('DownloadGrant'),R('ShardedDownloadGrant')]};
const assetPath={...S,pattern:'^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\]+$'};
schemas.SeedExport=O({...schemas.LegacyExport.properties,assetPath},Object.keys(schemas.LegacyExport.properties));
schemas.SeedExport.allOf=[{if:{properties:{state:{const:'READY'}}},then:{required:['assetPath'],properties:{object:content}}}];
const resources={subjects:'ExportSubject',datasetRevisionSummaries:'DatasetRevisionSummary',exports:'Export',exportSections:'ExportSection',downloadGrants:'DownloadGrant',deletionProofs:'DeletionProof',exportShards:'ExportShard',exportManifests:'ExportManifest',shardedDownloadGrants:'ShardedDownloadGrant'};
const subject={subjectId:uid(1),name:'Public Export Subject',currentDatasetRevision:1};
const record={recordId:uid(2),scope:'profile',data:{message:'Public example'}};
const revision={subjectId:uid(1),revision:1,committedAt:time,records:[record]};
const request={subjectId:uid(1),scope:['profile'],format:'JSONL'};
const expiresInSeconds={...P,minimum:60,maximum:900};
const grantRequest={oneOf:[O({expiresInSeconds}),O({target:{const:'MANIFEST'},expiresInSeconds}),O({target:{const:'SHARD'},shardId:U,expiresInSeconds})]};
const contract=define({taskId:'exportvault',title:'ExportVault',schemas,resources,seedResources:{subjects:'ExportSubject',datasetRevisions:'DatasetRevision',exports:'SeedExport'},seedValues:{subjects:[subject],datasetRevisions:[revision]},importedAt:false,environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],workKinds:['EXPORT_GENERATION','EXPORT_CLEANUP'],eventTypes:['export.requested','export.ready','export.failed','export.cancelled','export.expired','export.deleted','download-grant.revoked'],eventPayload:O({}),
  operations:[
    get('list-exports','/api/v1/exports',page('Export'),{query:{limit:50}},{parameters:pagination}),
    get('read-export','/api/v1/exports/:exportId','Export',{params:{exportId:uid(3)}}),
    post('create-export','/api/v1/exports','Export',O({subjectId:U,scope,format:E('JSONL','CSV')}),{body:request},{status:202}),
    post('cancel-export','/api/v1/exports/:exportId/cancel','Export',O({reason:S}),{params:{exportId:uid(3)},body:{reason:'Public cancellation'}}),
    post('create-download-grant','/api/v1/exports/:exportId/download-grants','Grant',grantRequest,{params:{exportId:uid(3)},body:{expiresInSeconds:300}},{source:`${manager}; docs/frontal-legacy/README.md`}),
    post('revoke-download-grant','/api/v1/download-grants/:grantId/revoke','Grant',O({reason:S}),{params:{grantId:uid(4)},body:{reason:'Public revoke'}}),
    get('download-grant-content','/api/v1/download-grants/:grantId/content',raw,{params:{grantId:uid(4)}},{successStatuses:[200,206,304],successResponses:{206:{response:raw,description:'Exact range bytes with Content-Range, Content-Length and digest ETag.'},304:{description:'Empty body for unchanged object ETag.'}},parameters:[{name:'Range',in:'header',required:false,schema:{...S,pattern:'^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$'}},{name:'If-None-Match',in:'header',required:false,schema:S}]}),
    get('read-export-sections','/api/v1/exports/:exportId/sections',O({items:A(R('ExportSection'))}),{params:{exportId:uid(3)}}),
    get('list-domain-events','/api/v1/domain-events',O({items:A(R('DomainEvent'))}),{query:{aggregateId:uid(3),afterSequence:0,limit:50}},{parameters:query({aggregateId:U,afterSequence:N,limit:{...P,maximum:100,default:50}},['aggregateId'])})
  ],smoke:[
    {operationId:'create-export',body:request,headers:{'Idempotency-Key':'smoke-create-export'},expectStatus:202,expectBody:{subjectId:uid(1),scope:['profile'],format:'JSONL',datasetRevision:1,state:'REQUESTED'},capture:{newExportId:['exportId']}},
    {operationId:'read-export',params:{exportId:'${newExportId}'},expectStatus:200,expectBody:{exportId:'${newExportId}',subjectId:uid(1),scope:['profile'],format:'JSONL',datasetRevision:1}},
    {operationId:'list-exports',expectStatus:200,expectContains:[{path:['items'],match:{exportId:'${newExportId}',subjectId:uid(1),datasetRevision:1}}]},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','exports'],match:{exportId:'${newExportId}',subjectId:uid(1),datasetRevision:1}}]}
  ],notes:[
    'V2 wire clarification: grant creation returns the complete exact DownloadGrant for a legacy object or ShardedDownloadGrant for a Manager target. MANIFEST omits shardId in the request and returns shardId:null; SHARD requires shardId. Revocation returns the matching grant shape. Legacy and Manager grant arrays are separate in snapshot and must never duplicate the same grant.',
    'V2 wire clarification: READY seed Export supplies assetPath as an extra top-level field, relative to assets; it is import-only and stripped from all responses and snapshot. Non-READY seeded Export does not need an asset. DatasetRevisionSummary.recordCount counts its records, and recordsDigest hashes their RFC 8785 array sorted by recordId.',
    'V2 wire clarification: the preserved V1 legacy/small Export shape has no manifest or shards keys; sharded exports require both keys, object:null and a stable shard plan from creation. Empty selected sections do not create empty Shards in a manifest; shard ranges and recordCount must agree. The fixed seed contains one Subject, one DatasetRevision and one public record, without managed byte fixtures.',
    'Raw downloads stream immutable target bytes with the target media type and digest ETag, exact Content-Length, and single-range 206 Content-Range; matching conditionals use empty 304, unsatisfiable ranges use 416 INVALID_RANGE. Revocation and expiry are checked before bytes become visible. Domain-event reads return {items:[DomainEvent]} in sequence, with required aggregateId and default afterSequence=0.'
  ]});
contract.smoke[2].expectContains.push({path:['resources','datasetRevisionSummaries'],match:{subjectId:uid(1),revision:1,recordCount:1,recordsDigest:createHash('sha256').update(JSON.stringify([{data:record.data,recordId:record.recordId,scope:record.scope}])).digest('hex')}});
export default contract;
