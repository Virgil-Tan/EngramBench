import {createHash} from 'node:crypto';
import {T,S,U,N,P,D,H,E,R,A,O,Q,uid,time,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const text={...T,maxLength:10000};
const title={...S,maxLength:120};
const conflictFields={operationIndex:N,code:E('TARGET_MISSING','TARGET_CHANGED','ANCHOR_MISSING','BLOCK_ID_EXISTS','MOVE_BASE_CHANGED'),path:T,baseValue:Q(T),headValue:Q(T)};
const reviewPolicy=O({reviewerIds:A(U,{minItems:1,maxItems:20,uniqueItems:true}),requiredApprovals:{...P,maximum:5}});
const schemas={
  Block:O({blockId:U,text}),
  Operation:{oneOf:[O({op:{const:'INSERT_AFTER'},afterBlockId:Q(U),block:R('Block')}),O({op:{const:'REPLACE'},blockId:U,expectedText:text,newText:text}),O({op:{const:'MOVE_AFTER'},blockId:U,afterBlockId:Q(U),expectedAfterBlockId:Q(U)}),O({op:{const:'DELETE'},blockId:U,expectedText:text})]},
  Document:O({documentId:U,title,headRevision:N,blocks:A(R('Block')),canonicalDigest:H,createdAt:D,sequence:N}),
  Change:O({changeId:U,documentId:U,clientId:U,clientSequence:P,baseRevision:N,operations:A(R('Operation'),{minItems:1,maxItems:100}),state:E('APPLIED','CONFLICTED','REJECTED'),revision:Q(N),conflicts:A(R('Conflict')),createdAt:D}),
  Conflict:O({conflictId:U,changeId:U,...conflictFields}),
  DocumentRevision:O({documentId:U,revision:N,blocks:A(R('Block')),changeId:Q(U),canonicalDigest:H,createdAt:D}),
  DocumentDiff:O({documentId:U,fromRevision:N,toRevision:N,items:A(O({blockId:U,kind:E('DELETE','INSERT','REPLACE','MOVE'),fromIndex:Q(N),toIndex:Q(N),fromText:Q(text),toText:Q(text)}))}),
  DocumentSnapshot:O({documentId:U,revision:N,canonicalDigest:H,createdAt:D}),
  Branch:O({branchId:U,documentId:U,name:{...S,pattern:'^[a-z][a-z0-9-]{0,31}$'},sourceBranchId:Q(U),sourceRevision:N,headRevision:N,state:{const:'ACTIVE'},createdAt:D}),
  MergeApproval:O({approvalId:U,mergeRequestId:U,reviewerId:U,resultDigest:H,approvedAt:D}),
  MergeOperation:O({sourceRevision:P,sourceOperationIndex:N,operation:R('Operation')}),
  MergeConflict:O({sourceRevision:P,sourceOperationIndex:N,code:conflictFields.code,path:T,baseValue:Q(T),headValue:Q(T)}),
  MergeRequest:O({mergeRequestId:U,documentId:U,sourceBranchId:U,targetBranchId:U,sourceHeadRevision:N,targetHeadRevision:N,state:E('CONFLICTED','IN_REVIEW','APPROVED','MERGED','STALE'),reviewPolicy,approvals:A(R('MergeApproval')),mergeOperations:A(R('MergeOperation')),conflicts:A(R('MergeConflict')),resultDigest:Q(H),mergedTargetRevision:Q(N),createdAt:D,terminalAt:Q(D)}),
  BranchDocumentSnapshot:O({documentId:U,branchId:U,revision:N,canonicalDigest:H,createdAt:D}),
  SeedDocument:O({documentId:U,title,initialBlocks:A(R('Block'),{maxItems:1000}),createdAt:D}),
  SeedSnapshot:O({documentId:U,revision:N,canonicalDigest:H,assetPath:{...S,pattern:'^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\]+$'}})
};
schemas.BranchChange=O({...schemas.Change.properties,branchId:U});
schemas.BranchDocumentRevision=O({...schemas.DocumentRevision.properties,branchId:U,mergeRequestId:Q(U)});
schemas.ChangeApplied=O({...schemas.Change.properties,canonicalDigest:H});
schemas.BranchChangeApplied=O({...schemas.BranchChange.properties,canonicalDigest:H});
const provenance=O({snapshotRevision:Q(N),changeIds:A(U)});
schemas.RevisionRead=O({...schemas.DocumentRevision.properties,provenance});
schemas.BranchRevisionRead=O({...schemas.BranchDocumentRevision.properties,provenance});
const changeRequest=O({clientId:U,clientSequence:P,baseRevision:N,operations:A(R('Operation'),{minItems:1,maxItems:100})});
const document={documentId:uid(1),title:'Public Document',initialBlocks:[{blockId:uid(2),text:'Initial public text'}],createdAt:time};
const input={title:'Created Through Public HTTP',blocks:[{blockId:uid(3),text:'First block'}]};
const base={documents:'Document',documentRevisions:'DocumentRevision',changes:'Change',conflicts:'Conflict',documentSnapshots:'DocumentSnapshot'};
const contract=define({taskId:'mergeboard',title:'MergeBoard',schemas,resources:{...base,documentRevisions:'BranchDocumentRevision',changes:'BranchChange',branches:'Branch',mergeRequests:'MergeRequest',branchDocumentSnapshots:'BranchDocumentSnapshot'},seedResources:{documents:'SeedDocument',changes:'Change',snapshots:'SeedSnapshot'},seedValues:{documents:[document]},importedAt:false,environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],workKinds:['SNAPSHOT_COMPACTION'],eventTypes:['document.created','document.changed','change.conflicted','conflict.resolved','snapshot.created','merge-request.approved','merge-request.merged'],eventPayload:O({}),
  operations:[
    get('list-documents','/api/v1/documents',page('Document'),{query:{limit:50}},{parameters:pagination}),
    get('read-document','/api/v1/documents/:documentId','Document',{params:{documentId:uid(1)}}),
    post('create-document','/api/v1/documents','Document',O({title,blocks:A(R('Block'),{maxItems:1000})}),{body:input},{status:201}),
    post('apply-change','/api/v1/documents/:documentId/changes','ChangeApplied',changeRequest,{params:{documentId:uid(1)},body:{clientId:uid(4),clientSequence:1,baseRevision:0,operations:[{op:'REPLACE',blockId:uid(2),expectedText:'Initial public text',newText:'Updated public text'}]}},{status:201}),
    post('resolve-conflict','/api/v1/documents/:documentId/conflicts/:conflictId/resolve','ChangeApplied',O({expectedHeadRevision:N,resolutionOperations:A(R('Operation'),{minItems:1,maxItems:100})}),{params:{documentId:uid(1),conflictId:uid(5)},body:{expectedHeadRevision:1,resolutionOperations:[{op:'REPLACE',blockId:uid(2),expectedText:'Updated public text',newText:'Resolved text'}]}}),
    get('read-revision','/api/v1/documents/:documentId/revisions/:revision','RevisionRead',{params:{documentId:uid(1),revision:0}}),
    get('read-document-diff','/api/v1/documents/:documentId/diff','DocumentDiff',{params:{documentId:uid(1)},query:{fromRevision:0,toRevision:1}},{parameters:query({fromRevision:N,toRevision:N},['fromRevision','toRevision'])}),
    get('list-changes','/api/v1/documents/:documentId/changes',page('Change'),{params:{documentId:uid(1)},query:{limit:50}},{parameters:pagination}),
    get('list-domain-events','/api/v1/domain-events',O({items:A(R('DomainEvent'))}),{query:{aggregateId:uid(1),afterSequence:0,limit:50}},{parameters:query({aggregateId:U,afterSequence:N,limit:{...P,maximum:100,default:50}},['aggregateId'])}),
    post('create-branch','/api/v1/documents/:documentId/branches','Branch',O({name:schemas.Branch.properties.name,sourceBranchId:U,sourceRevision:N}),{params:{documentId:uid(1)},body:{name:'review',sourceBranchId:uid(6),sourceRevision:0}},{source:manager,status:201}),
    get('list-branches','/api/v1/documents/:documentId/branches',O({items:A(R('Branch'))}),{params:{documentId:uid(1)}},{source:manager}),
    post('apply-branch-change','/api/v1/documents/:documentId/branches/:branchId/changes','BranchChangeApplied',changeRequest,{params:{documentId:uid(1),branchId:uid(7)},body:{clientId:uid(4),clientSequence:1,baseRevision:0,operations:[{op:'REPLACE',blockId:uid(2),expectedText:'Initial public text',newText:'Branch text'}]}},{source:manager,status:201}),
    post('create-merge-request','/api/v1/documents/:documentId/merge-requests','MergeRequest',O({sourceBranchId:U,targetBranchId:U,expectedSourceHeadRevision:N,expectedTargetHeadRevision:N,reviewPolicy}),{params:{documentId:uid(1)},body:{sourceBranchId:uid(7),targetBranchId:uid(6),expectedSourceHeadRevision:1,expectedTargetHeadRevision:0,reviewPolicy:{reviewerIds:[uid(8)],requiredApprovals:1}}},{source:manager}),
    post('approve-merge-request','/api/v1/merge-requests/:mergeRequestId/approvals','MergeRequest',O({reviewerId:U}),{params:{mergeRequestId:uid(9)},body:{reviewerId:uid(8)}},{source:manager}),
    post('merge-request','/api/v1/merge-requests/:mergeRequestId/merge','MergeRequest',O({}),{params:{mergeRequestId:uid(9)},body:{}},{source:manager}),
    get('read-merge-request','/api/v1/merge-requests/:mergeRequestId','MergeRequest',{params:{mergeRequestId:uid(9)}},{source:manager}),
    get('read-branch-revision','/api/v1/documents/:documentId/branches/:branchId/revisions/:revision','BranchRevisionRead',{params:{documentId:uid(1),branchId:uid(7),revision:1}},{source:manager})
  ],smoke:[
    {operationId:'read-document',params:{documentId:uid(1)},expectStatus:200,expectBody:{documentId:uid(1),headRevision:0,blocks:document.initialBlocks}},
    {operationId:'create-document',body:input,headers:{'Idempotency-Key':'smoke-create-document'},expectStatus:201,expectBody:{title:input.title,headRevision:0,blocks:input.blocks},capture:{newDocumentId:['documentId']}},
    {operationId:'read-document',params:{documentId:'${newDocumentId}'},expectStatus:200,expectBody:{documentId:'${newDocumentId}',title:input.title,headRevision:0,blocks:input.blocks}},
    {operationId:'apply-change',params:{documentId:'${newDocumentId}'},body:{clientId:uid(4),clientSequence:1,baseRevision:0,operations:[{op:'REPLACE',blockId:uid(3),expectedText:'First block',newText:'Changed through public HTTP'}]},headers:{'Idempotency-Key':'smoke-apply-change'},expectStatus:201,expectBody:{documentId:'${newDocumentId}',state:'APPLIED',revision:1}},
    {operationId:'read-document',params:{documentId:'${newDocumentId}'},expectStatus:200,expectBody:{documentId:'${newDocumentId}',headRevision:1,blocks:[{blockId:uid(3),text:'Changed through public HTTP'}]}}
  ],notes:[
    'V2 wire clarification: successful Change submission/resolution returns the exact Change plus canonicalDigest of its resulting revision, satisfying the published performance digest assertion. Stored Change and collection shapes omit this response-only digest. Branch change success adds branchId and canonicalDigest; FINAL stored revisions/changes have their required branch fields, while V1 endpoints omit Manager fields.',
    'V2 wire clarification: revision reads return the exact legacy or Branch-local DocumentRevision plus provenance:{snapshotRevision,changeIds}. snapshotRevision is the verified compaction prefix used (null if none); changeIds are the ordered applied Changes replayed after that prefix. Reads cannot fabricate provenance or trigger compaction. Revision path parameters are nonnegative integers.',
    'V2 wire clarification: Branch list returns {items:[Branch]}, main first then name/branchId. MergeRequest creation uses default 200, branch change inherits 201 from V1, and approval/merge return MergeRequest. CHANGE_CONFLICT uses error.details:{changeId,conflicts:[Conflict]}; every Conflict is also retained in snapshot. Review quorum and branch head checks are business validation.',
    'Seed Document initialBlocks creates exact immutable revision 0 and derived main Branch without asset files; a supplied Snapshot asset must independently verify. Initial seeded snapshot identity is checked against derived Document fields, not import-only initialBlocks. Unicode scalar limits and forbidden unpaired surrogates require validation beyond ordinary string type checks.'
  ]});
contract.smoke[2].expectContains=[{path:['resources','documents'],match:{documentId:uid(1),title:document.title,headRevision:0,blocks:document.initialBlocks,canonicalDigest:createHash('sha256').update(JSON.stringify({blocks:document.initialBlocks,documentId:uid(1),revision:0})).digest('hex')}}];
for(const operation of contract.operations)for(const parameter of operation.parameters??[])if(parameter.in==='path'&&parameter.name==='revision')parameter.schema=N;
export default contract;
