import {T,S,U,N,P,B,D,H,E,R,A,O,Q,pick,uid,time,admin,page,query,pagination,post,get,op,define,manager} from './helpers-c.mjs';
const packageName={...S,pattern:'^[a-z0-9][a-z0-9._-]{0,127}$'};
const version={...S,maxLength:64,pattern:'^[!-~]+$'};
const platform={...S,pattern:'^[a-z0-9][a-z0-9._-]{0,63}$'};
const size={...P,maximum:2147483648};
const mediaType={...S,pattern:'^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$'};
const blob=O({sha256:H,size,mediaType});
const raw={type:'string',contentMediaType:'application/octet-stream'};
const schemas={
  Package:O({packageName,displayName:S}),
  LegacyUploadSession:O({uploadId:U,packageName,version,mediaType,expectedSize:size,expectedSha256:H,nextOffset:N,state:E('STAGING','VERIFYING','COMMITTED','REJECTED','ABANDONED'),expiresAt:D,artifactVersionId:Q(U),createdAt:D}),
  ArtifactVersion:O({artifactVersionId:U,packageName,version,blob,committedAt:D,sequence:P}),
  ChunkReceipt:O({uploadId:U,start:N,endExclusive:P,nextOffset:P,replayed:B}),
  VerificationResult:O({uploadId:U,actualSize:N,actualSha256:H,outcome:E('COMMITTED','SIZE_MISMATCH','DIGEST_MISMATCH','VERIFIED'),completedAt:D}),
  Blob:O({sha256:H,size,mediaType,state:E('STAGED','VERIFIED','COMMITTED','ORPHANED'),referenceCount:N}),
  BlobReference:O({artifactVersionId:U,blobSha256:H,createdAt:D}),
  ReleaseArtifact:O({platform,uploadId:U,artifactVersionId:Q(U),state:E('STAGING','VERIFYING','VERIFIED','REJECTED','ABANDONED','COMMITTED'),blob:Q(blob)}),
  ReleaseManifest:O({packageName,version,artifacts:A(O({platform,sha256:H,size,mediaType}),{minItems:1,maxItems:20}),manifestSha256:H}),
  Release:O({releaseId:U,packageName,version,state:E('DRAFT','PUBLISHED'),manifestSha256:Q(H),artifacts:A(R('ReleaseArtifact'),{minItems:1,maxItems:20}),createdAt:D,publishedAt:Q(D),sequence:N}),
  ReleaseDetail:O({release:R('Release'),manifest:Q(R('ReleaseManifest'))}),
  SeedArtifactVersion:O({artifactVersionId:U,packageName,version,mediaType,assetPath:{...S,pattern:'^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\]+$'},expectedSize:size,expectedSha256:H,committedAt:D})
};
schemas.MemberUploadSession=O({...schemas.LegacyUploadSession.properties,state:E('STAGING','VERIFYING','VERIFIED','COMMITTED','REJECTED','ABANDONED'),releaseId:U,platform});
schemas.UploadSession={oneOf:[R('LegacyUploadSession'),R('MemberUploadSession')]};
schemas.SnapshotArtifactVersion=O({...schemas.ArtifactVersion.properties,platform});
const resources={packages:'Package',uploadSessions:'UploadSession',artifactVersions:'SnapshotArtifactVersion',verificationResults:'VerificationResult',blobs:'Blob',blobReferences:'BlobReference',releases:'Release'};
const input={packageName:'public-package',version:'1.0.0',mediaType:'text/plain',expectedSize:5,expectedSha256:'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'};
const rawOptions={successStatuses:[200,206,304],successResponses:{206:{response:raw,description:'Exact requested range with Content-Range, Content-Length and digest ETag.'},304:{description:'Empty body when the conditional digest ETag matches.'}},parameters:[{name:'Range',in:'header',required:false,schema:{...S,pattern:'^bytes=(?:[0-9]+-[0-9]*|-[0-9]+)$'}},{name:'If-None-Match',in:'header',required:false,schema:S}]};
export default define({taskId:'artifactvault',title:'ArtifactVault',schemas,resources,seedResources:{packages:'Package',artifactVersions:'SeedArtifactVersion'},seedValues:{packages:[{packageName:'public-package',displayName:'Public Package'}]},importedAt:false,environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],workKinds:['ARTIFACT_VERIFICATION','UPLOAD_EXPIRY','BLOB_GC'],eventTypes:['upload.completed','artifact.committed','artifact.rejected','upload.abandoned','blob.collected'],eventPayload:O({}),
  operations:[
    get('list-artifact-versions','/api/v1/artifact-versions',page('ArtifactVersion'),{query:{limit:50}},{parameters:pagination}),
    get('read-artifact-version','/api/v1/artifact-versions/:artifactVersionId','ArtifactVersion',{params:{artifactVersionId:uid(1)}}),
    post('create-upload-session','/api/v1/upload-sessions','LegacyUploadSession',O({packageName,version,mediaType,expectedSize:size,expectedSha256:H}),{body:input},{status:201}),
    op('upload-chunk','PUT','/api/v1/upload-sessions/:uploadId/chunks','ChunkReceipt',{...raw,minLength:1,maxLength:8388608},{params:{uploadId:uid(2)},headers:{'Content-Range':'bytes 0-4/5','Content-Type':'application/octet-stream'},body:'hello'},{parameters:[{name:'Content-Range',in:'header',required:true,schema:{...S,pattern:'^bytes [0-9]+-[0-9]+/[0-9]+$'}},{name:'Idempotency-Key',in:'header',required:true,schema:S}]}),
    post('complete-upload','/api/v1/upload-sessions/:uploadId/complete','UploadSession',O({}),{params:{uploadId:uid(2)},body:{}},{status:202}),
    get('read-package-version','/api/v1/packages/:packageName/versions/:version','ArtifactVersion',{params:{packageName:'public-package',version:'1.0.0'}}),
    get('download-package-version','/api/v1/packages/:packageName/versions/:version/content',raw,{params:{packageName:'public-package',version:'1.0.0'}},rawOptions),
    get('read-upload-session','/api/v1/upload-sessions/:uploadId',O({uploadSession:R('UploadSession'),verificationResult:Q(R('VerificationResult'))}),{params:{uploadId:uid(2)}}),
    get('list-domain-events','/api/v1/domain-events',O({items:A(R('DomainEvent'))}),{query:{aggregateId:uid(2),afterSequence:0,limit:50}},{parameters:query({aggregateId:U,afterSequence:N,limit:{...P,maximum:100,default:50}},['aggregateId'])}),
    post('create-release','/api/v1/releases','Release',O({packageName,version,artifacts:A(O({platform,expectedSize:size,expectedSha256:H,mediaType}),{minItems:1,maxItems:20})}),{body:{packageName:'public-package',version:'2.0.0',artifacts:[{platform:'linux-arm64',expectedSize:5,expectedSha256:input.expectedSha256,mediaType:'text/plain'}]}},{source:manager}),
    post('retry-release-artifact','/api/v1/releases/:releaseId/artifacts/:platform/retry','MemberUploadSession',O({}),{params:{releaseId:uid(3),platform:'linux-arm64'},body:{}},{source:manager}),
    post('publish-release','/api/v1/releases/:releaseId/publish','Release',O({}),{params:{releaseId:uid(3)},body:{}},{source:manager}),
    get('read-release','/api/v1/packages/:packageName/releases/:version','ReleaseDetail',{params:{packageName:'public-package',version:'2.0.0'}},{source:manager}),
    get('download-release-artifact','/api/v1/packages/:packageName/releases/:version/artifacts/:platform/content',raw,{params:{packageName:'public-package',version:'2.0.0',platform:'linux-arm64'}},{...rawOptions,source:manager})
  ],smoke:[
    {operationId:'create-upload-session',body:input,headers:{'Idempotency-Key':'smoke-create-upload'},expectStatus:201,expectBody:{packageName:'public-package',version:'1.0.0',state:'STAGING',nextOffset:0,expectedSize:5},capture:{newUploadId:['uploadId']}},
    {operationId:'read-upload-session',params:{uploadId:'${newUploadId}'},expectStatus:200,expectBody:{uploadSession:{uploadId:'${newUploadId}',packageName:'public-package',state:'STAGING',nextOffset:0},verificationResult:null}},
    {operationId:'upload-chunk',params:{uploadId:'${newUploadId}'},headers:{'Idempotency-Key':'smoke-upload-chunk','Content-Type':'application/octet-stream','Content-Range':'bytes 0-4/5'},body:'hello',expectStatus:200,expectBody:{uploadId:'${newUploadId}',start:0,endExclusive:5,nextOffset:5,replayed:false}},
    {operationId:'read-upload-session',params:{uploadId:'${newUploadId}'},expectStatus:200,expectBody:{uploadSession:{uploadId:'${newUploadId}',nextOffset:5,state:'STAGING'},verificationResult:null}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','uploadSessions'],match:{uploadId:'${newUploadId}',packageName:'public-package',nextOffset:5}}]}
  ],notes:[
    'V2 wire clarification: upload-session detail is exactly {uploadSession,verificationResult}. Domain-event reads use {items:[DomainEvent]} with aggregateId required and default afterSequence=0; this sequence-based interface has no cursor. Chunk PUT consumes raw octets and reports endExclusive despite inclusive Content-Range end.',
    'V2 wire clarification: legacy ArtifactVersion responses omit platform; FINAL snapshot artifactVersions always includes platform (default for legacy/standalone versions). Release-member sessions require releaseId/platform and may be VERIFIED. Release create/publish return Release; member retry returns the replacement MemberUploadSession.',
    'Raw download success uses the exact Blob media type, Content-Length, quoted SHA-256 ETag, Accept-Ranges:bytes, and 206 Content-Range for one valid range; no JSON/base64 envelope or private path. Conditional match uses empty 304, unsatisfiable range uses 416 INVALID_RANGE. Stream bytes without whole-object buffering.',
    'The package-only nonempty seed intentionally needs no asset files; artifactVersions may be empty. It is a complete legal namespace graph for the independent create/upload/read smoke. Nonempty seeded ArtifactVersions still require full relative-asset verification as published.'
  ]});
