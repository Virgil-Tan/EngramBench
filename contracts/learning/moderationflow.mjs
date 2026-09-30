import {T,S,U,N,P,D,H,E,R,A,O,Q,uid,time,digest,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const outcome=E('ALLOW','RESTRICT','REMOVE','ESCALATE');
const finalOutcome=E('ALLOW','RESTRICT','REMOVE');
const category=O({categoryCode:S,severity:{...N,maximum:100},level1Action:outcome});
const evidenceInput={kind:E('SUBMISSION','CONTEXT','REPORT','EXPERT_NOTE'),digest:H,summary:{...T,maxLength:4096},createdBy:S};
const schemas={
  Policy:O({policyId:U,tenantId:U,name:S}),
  ContentItem:O({contentItemId:U,tenantId:U,externalContentId:S,contentType:E('POST','COMMENT','IMAGE','VIDEO'),bodyDigest:H,text:Q(T),createdAt:D,sequence:N}),
  EvidenceVersion:O({evidenceVersionId:U,contentItemId:U,version:P,...evidenceInput,createdAt:D}),
  PolicyVersion:O({policyVersionId:U,policyId:U,version:P,state:E('DRAFT','ACTIVE','SUPERSEDED','REVOKED'),categories:A(category),createdAt:D,activatedAt:Q(D)}),
  ModerationCase:O({caseId:U,contentItemId:U,policyVersionId:U,evidenceHeadVersion:P,state:E('QUEUED','IN_REVIEW','DECIDED','CANCELLED','FAILED'),finalDecisionId:Q(U),createdAt:D,decidedAt:Q(D),sequence:N}),
  ReviewStage:O({stageId:U,caseId:U,level:E('LEVEL_1','LEVEL_2','APPEAL','RECONSIDERATION'),state:E('OPEN','CLAIMED','DECIDED','EXPIRED'),assigneeId:Q(S),leaseExpiresAt:Q(D),openedAt:D,closedAt:Q(D),revision:N}),
  ModerationDecision:O({decisionId:U,stageId:U,outcome,categoryCode:S,reason:S,reviewerId:S,evidenceHeadVersion:P,policyVersionId:U,createdAt:D}),
  Appeal:O({appealId:U,caseId:U,challengedDecisionId:U,reason:S,evidenceHeadVersion:P,state:E('FILED','IN_REVIEW','UPHELD','OVERTURNED','REJECTED'),appealDecisionId:Q(U),createdAt:D,resolvedAt:Q(D)}),
  AuditVerification:O({valid:{type:'boolean'},checkedEntries:N,checkpoints:A(R('AuditCheckpoint')),failures:A(O({tenantId:U,sequence:N,code:S}))}),
  PolicyRecallRun:O({policyRecallRunId:U,tenantId:U,recalledPolicyVersionId:U,replacementPolicyVersionId:U,decidedFrom:D,decidedTo:D,state:E('PENDING','RUNNING','COMPLETED','CANCELLED'),totalCount:N,completedCount:N,changedCount:N,noChangeCount:N,createdAt:D,completedAt:Q(D),cancelledAt:Q(D)}),
  Reconsideration:O({reconsiderationId:U,policyRecallRunId:U,caseId:U,evidenceHeadVersion:P,oldDecisionId:U,oldOutcome:finalOutcome,suggestedOutcome:outcome,replacementPolicyVersionId:U,outcome:E('CHANGED','NO_CHANGE'),reason:S,reconsiderationStageId:Q(U),createdAt:D})
};
const base={tenants:'Tenant',policies:'Policy',policyVersions:'PolicyVersion',contentItems:'ContentItem',evidenceVersions:'EvidenceVersion',moderationCases:'ModerationCase',reviewStages:'ReviewStage',moderationDecisions:'ModerationDecision',appeals:'Appeal',auditEntries:'AuditEntry',auditCheckpoints:'AuditCheckpoint'};
const tenant={tenantId:uid(1),name:'Public Moderation Tenant'};
const policy={policyId:uid(2),tenantId:uid(1),name:'Public Content Policy'};
const categories=[{categoryCode:'GENERAL',severity:10,level1Action:'ALLOW'}];
const policyVersion={policyVersionId:uid(3),policyId:uid(2),version:1,state:'ACTIVE',categories,createdAt:time,activatedAt:time};
const submission={tenantId:uid(1),externalContentId:'public-content-1',contentType:'POST',bodyDigest:digest,text:'A public example post',evidence:{kind:'SUBMISSION',digest,summary:'Public submission context',createdBy:'public-author'}};
export default define({taskId:'moderationflow',title:'ModerationFlow',schemas,resources:{...base,policyRecallRuns:'PolicyRecallRun',reconsiderations:'Reconsideration'},seedResources:base,seedValues:{tenants:[tenant],policies:[policy],policyVersions:[policyVersion]},workKinds:['CASE_OPEN','STAGE_EXPIRY','APPEAL_OPEN','AUDIT_DELIVERY','POLICY_RECALL'],eventTypes:['content.accepted','evidence.appended','review.opened','review.decided','appeal.filed','appeal.resolved','policy.activated'],
  operations:[
    post('create-tenant','/api/v1/tenants','Tenant',O({name:S}),{body:{name:'Another Moderation Tenant'}}),
    post('create-policy','/api/v1/policies','Policy',O({tenantId:U,name:S}),{body:{tenantId:uid(1),name:'Second Policy'}}),
    post('create-policy-version','/api/v1/policies/:policyId/versions','PolicyVersion',O({categories:A(category)}),{params:{policyId:uid(2)},body:{categories}}),
    post('activate-policy-version','/api/v1/policy-versions/:policyVersionId/activate','PolicyVersion',O({expectedActivePolicyVersionId:Q(U)}),{params:{policyVersionId:uid(4)},body:{expectedActivePolicyVersionId:uid(3)}}),
    post('create-content-item','/api/v1/content-items',O({contentItem:R('ContentItem'),evidenceVersion:R('EvidenceVersion'),moderationCase:R('ModerationCase')}),O({tenantId:U,externalContentId:S,contentType:E('POST','COMMENT','IMAGE','VIDEO'),bodyDigest:H,text:Q(T),evidence:O({...evidenceInput,kind:{const:'SUBMISSION'}})}),{body:submission}),
    post('append-evidence','/api/v1/content-items/:contentItemId/evidence-versions','EvidenceVersion',O({expectedHeadVersion:P,...evidenceInput}),{params:{contentItemId:uid(5)},body:{expectedHeadVersion:1,kind:'CONTEXT',digest,summary:'Further public context',createdBy:'public-author'}}),
    get('read-moderation-case','/api/v1/moderation-cases/:caseId','ModerationCase',{params:{caseId:uid(6)}}),
    get('list-review-stages','/api/v1/review-stages',page('ReviewStage'),{query:{state:'OPEN',level:'LEVEL_1',limit:50}},{parameters:[...query({state:schemas.ReviewStage.properties.state,level:schemas.ReviewStage.properties.level}),...pagination]}),
    post('claim-review-stage','/api/v1/review-stages/:stageId/claim','ReviewStage',O({reviewerId:S,expectedRevision:N,leaseSeconds:{...P,maximum:30}}),{params:{stageId:uid(7)},body:{reviewerId:'public-reviewer',expectedRevision:0,leaseSeconds:30}}),
    post('decide-review-stage','/api/v1/review-stages/:stageId/decisions','ModerationDecision',O({reviewerId:S,expectedRevision:N,outcome,categoryCode:S,reason:S,evidenceHeadVersion:P,policyVersionId:U}),{params:{stageId:uid(7)},body:{reviewerId:'public-reviewer',expectedRevision:1,outcome:'ALLOW',categoryCode:'GENERAL',reason:'Allowed by published policy',evidenceHeadVersion:1,policyVersionId:uid(3)}}),
    post('file-appeal','/api/v1/moderation-cases/:caseId/appeals','Appeal',O({challengedDecisionId:U,reason:S,evidenceHeadVersion:P}),{params:{caseId:uid(6)},body:{challengedDecisionId:uid(8),reason:'Please reconsider',evidenceHeadVersion:1}}),
    post('decide-appeal','/api/v1/appeals/:appealId/decision','Appeal',O({reviewerId:S,expectedRevision:N,resolution:E('UPHOLD','OVERTURN'),outcome:finalOutcome,categoryCode:S,reason:S}),{params:{appealId:uid(9)},body:{reviewerId:'public-reviewer',expectedRevision:1,resolution:'UPHOLD',outcome:'ALLOW',categoryCode:'GENERAL',reason:'Original decision confirmed'}}),
    get('verify-audit','/api/v1/audit/verify','AuditVerification',{}),
    get('list-audit','/api/v1/audit',page('AuditEntry'),{query:{limit:50}},{parameters:pagination}),
    post('create-policy-recall-run','/api/v1/policy-recall-runs','PolicyRecallRun',O({tenantId:U,recalledPolicyVersionId:U,replacementPolicyVersionId:U,decidedFrom:D,decidedTo:D}),{body:{tenantId:uid(1),recalledPolicyVersionId:uid(3),replacementPolicyVersionId:uid(4),decidedFrom:time,decidedTo:'2026-01-02T00:00:00.000Z'}},{source:manager,status:201}),
    get('read-policy-recall-run','/api/v1/policy-recall-runs/:runId',O({run:R('PolicyRecallRun'),reconsiderations:A(R('Reconsideration'))}),{params:{runId:uid(10)}},{source:manager}),
    post('cancel-policy-recall-run','/api/v1/policy-recall-runs/:runId/cancel','PolicyRecallRun',O({}),{params:{runId:uid(10)},body:{}},{source:manager})
  ],smoke:[
    {operationId:'create-content-item',body:submission,headers:{'Idempotency-Key':'smoke-create-content'},expectStatus:200,expectBody:{contentItem:{externalContentId:'public-content-1'},moderationCase:{policyVersionId:uid(3),evidenceHeadVersion:1}},capture:{newContentId:['contentItem','contentItemId'],newCaseId:['moderationCase','caseId']}},
    {operationId:'read-moderation-case',params:{caseId:'${newCaseId}'},expectStatus:200,expectBody:{caseId:'${newCaseId}',contentItemId:'${newContentId}',policyVersionId:uid(3)}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','contentItems'],match:{contentItemId:'${newContentId}',tenantId:uid(1),externalContentId:'public-content-1'}}]}
  ],notes:[
    'V2 wire clarification: Policy is {policyId,tenantId,name}. Activation takes expectedActivePolicyVersionId, nullable only before a first activation. Content submission embeds initial SUBMISSION evidence and returns {contentItem,evidenceVersion,moderationCase}; public summaries and digest are the only evidence inputs. UTF-8 summary length is additionally limited to 4096 bytes by the implementation.',
    'V2 wire clarification: stage claims and decisions fence through reviewerId plus expectedRevision; claim also takes leaseSeconds 1..30. Claim increments revision and returns ReviewStage. Appeal decisions take UPHOLD/OVERTURN resolution with the resulting ALLOW/RESTRICT/REMOVE outcome; decision must use the current claimed APPEAL stage and frozen policy/evidence.',
    'V2 wire clarification: audit verification returns {valid,checkedEntries,checkpoints,failures:[{tenantId,sequence,code}]}. Valid chains return failures:[], and verification is read-only. Recall stages use the existing stage claim/decision endpoints and only final outcomes. A NO_CHANGE Reconsideration has no stage.'
  ]});
