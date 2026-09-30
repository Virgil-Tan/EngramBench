import {T,S,U,I,N,P,D,H,C,E,R,A,O,Q,M,uid,time,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const outcome=E('APPROVE','BLOCK');
const scalar={anyOf:[{type:'boolean'},I,{...T,maxLength:256}]};
const attributes=M({anyOf:[scalar,A(scalar,{maxItems:32})]});
const rule=O({ruleId:S,priority:I,field:S,operator:E('EQ','IN','GTE','LTE'),value:{anyOf:[T,I]},score:I,reasonCode:S});
const threshold={...N,maximum:1000};
const schemas={
  RuleSet:O({ruleSetId:U,tenantId:U,name:S}),
  RiskEvent:O({riskEventId:U,tenantId:U,externalEventId:S,subjectId:S,amountMinor:{...N,maximum:9000000000000},currency:C,occurredAt:D,attributes,createdAt:D,sequence:N}),
  RuleVersion:O({ruleVersionId:U,ruleSetId:U,version:P,state:E('DRAFT','ACTIVE','SUPERSEDED','ROLLED_BACK'),rules:A(rule),reviewThreshold:threshold,blockThreshold:threshold,createdAt:D,activatedAt:Q(D)}),
  Assessment:O({assessmentId:U,riskEventId:U,ruleVersionId:U,state:E('PENDING','SCORED','REVIEW_REQUIRED','DECIDED','FAILED'),score:Q(threshold),recommendation:Q(E('APPROVE','REVIEW','BLOCK')),decision:Q(outcome),createdAt:D,decidedAt:Q(D),sequence:N}),
  RuleHit:O({assessmentId:U,ruleId:S,priority:I,score:I,reasonCode:S}),
  ReviewCase:O({reviewCaseId:U,assessmentId:U,state:E('OPEN','CLAIMED','APPROVED','BLOCKED','EXPIRED'),assigneeId:Q(S),leaseExpiresAt:Q(D),openedAt:D,closedAt:Q(D),revision:N}),
  ReviewDecision:O({reviewDecisionId:U,reviewCaseId:U,outcome,reasonCode:S,reviewerId:S,createdAt:D}),
  RuleRollback:O({rollbackId:U,ruleSetId:U,fromRuleVersionId:U,toRuleVersionId:U,reason:S,createdAt:D}),
  RemediationRun:O({remediationRunId:U,tenantId:U,fromRuleVersionId:U,toRuleVersionId:U,occurredFrom:D,occurredTo:D,state:E('PENDING','RUNNING','COMPLETED','CANCELLED'),totalCount:N,completedCount:N,correctionCount:N,noChangeCount:N,createdAt:D,completedAt:Q(D),cancelledAt:Q(D)}),
  AssessmentCorrection:O({assessmentCorrectionId:U,remediationRunId:U,assessmentId:U,outcome:E('CORRECTED','NO_CHANGE'),oldDecision:outcome,newDecision:E('APPROVE','REVIEW','BLOCK'),reason:S,newRuleHitsDigest:H,createdAt:D})
};
const base={tenants:'Tenant',ruleSets:'RuleSet',ruleVersions:'RuleVersion',riskEvents:'RiskEvent',assessments:'Assessment',ruleHits:'RuleHit',reviewCases:'ReviewCase',reviewDecisions:'ReviewDecision',ruleRollbacks:'RuleRollback',auditEntries:'AuditEntry'};
const tenant={tenantId:uid(1),name:'Public Risk Tenant'};
const ruleSet={ruleSetId:uid(2),tenantId:uid(1),name:'Public Risk Rules'};
const rules=[{ruleId:'large-amount',priority:1,field:'amountMinor',operator:'GTE',value:10000,score:500,reasonCode:'LARGE_AMOUNT'}];
const ruleVersion={ruleVersionId:uid(3),ruleSetId:uid(2),version:1,state:'ACTIVE',rules,reviewThreshold:400,blockThreshold:800,createdAt:time,activatedAt:time};
const eventInput={tenantId:uid(1),externalEventId:'public-event-1',subjectId:'public-customer',amountMinor:500,currency:'USD',occurredAt:time,attributes:{channel:'web'}};
export default define({taskId:'fraudlens',title:'FraudLens',schemas,resources:{...base,remediationRuns:'RemediationRun',assessmentCorrections:'AssessmentCorrection'},seedResources:base,seedValues:{tenants:[tenant],ruleSets:[ruleSet],ruleVersions:[ruleVersion]},workKinds:['RISK_ASSESSMENT','REVIEW_EXPIRY','AUDIT_DELIVERY','REMEDIATION_RECHECK'],eventTypes:['risk.accepted','assessment.scored','decision.recorded','review.opened','review.decided','rule.activated','rule.rolled_back'],
  operations:[
    post('create-tenant','/api/v1/tenants','Tenant',O({name:S}),{body:{name:'Another Risk Tenant'}}),
    post('create-rule-set','/api/v1/rule-sets','RuleSet',O({tenantId:U,name:S}),{body:{tenantId:uid(1),name:'Additional Public Rules'}}),
    post('create-rule-version','/api/v1/rule-sets/:ruleSetId/versions','RuleVersion',O({rules:A(rule),reviewThreshold:threshold,blockThreshold:threshold}),{params:{ruleSetId:uid(2)},body:{rules,reviewThreshold:450,blockThreshold:900}}),
    post('activate-rule-version','/api/v1/rule-versions/:ruleVersionId/activate','RuleVersion',O({expectedActiveRuleVersionId:Q(U)}),{params:{ruleVersionId:uid(4)},body:{expectedActiveRuleVersionId:uid(3)}}),
    post('rollback-rule-set','/api/v1/rule-sets/:ruleSetId/rollback','RuleRollback',O({fromRuleVersionId:U,toRuleVersionId:U,reason:S}),{params:{ruleSetId:uid(2)},body:{fromRuleVersionId:uid(4),toRuleVersionId:uid(3),reason:'Public rollback'}}),
    post('create-risk-event','/api/v1/risk-events',O({riskEvent:R('RiskEvent'),assessment:R('Assessment')}),O({tenantId:U,externalEventId:S,subjectId:S,amountMinor:{...N,maximum:9000000000000},currency:C,occurredAt:D,attributes}),{body:eventInput}),
    get('read-assessment','/api/v1/assessments/:assessmentId','Assessment',{params:{assessmentId:uid(5)}}),
    get('list-review-cases','/api/v1/review-cases',page('ReviewCase'),{query:{state:'OPEN',limit:50}},{parameters:[...query({state:schemas.ReviewCase.properties.state}),...pagination]}),
    post('claim-review','/api/v1/review-cases/:reviewCaseId/claim','ReviewCase',O({reviewerId:S,expectedRevision:N,leaseSeconds:{...P,maximum:30}}),{params:{reviewCaseId:uid(6)},body:{reviewerId:'public-reviewer',expectedRevision:0,leaseSeconds:30}}),
    post('decide-review','/api/v1/review-cases/:reviewCaseId/decisions','ReviewDecision',O({reviewerId:S,expectedRevision:N,outcome,reasonCode:S}),{params:{reviewCaseId:uid(6)},body:{reviewerId:'public-reviewer',expectedRevision:1,outcome:'APPROVE',reasonCode:'VERIFIED'}}),
    get('list-audit','/api/v1/audit',page('AuditEntry'),{query:{limit:50}},{parameters:pagination}),
    post('create-remediation-run','/api/v1/remediation-runs','RemediationRun',O({tenantId:U,fromRuleVersionId:U,toRuleVersionId:U,occurredFrom:D,occurredTo:D}),{body:{tenantId:uid(1),fromRuleVersionId:uid(4),toRuleVersionId:uid(3),occurredFrom:time,occurredTo:'2026-01-02T00:00:00.000Z'}},{source:manager,status:201}),
    get('read-remediation-run','/api/v1/remediation-runs/:runId',O({run:R('RemediationRun'),corrections:A(R('AssessmentCorrection'))}),{params:{runId:uid(7)}},{source:manager}),
    post('cancel-remediation-run','/api/v1/remediation-runs/:runId/cancel','RemediationRun',O({}),{params:{runId:uid(7)},body:{}},{source:manager})
  ],smoke:[
    {operationId:'create-risk-event',body:eventInput,headers:{'Idempotency-Key':'smoke-risk-event'},expectStatus:200,expectBody:{riskEvent:{tenantId:uid(1),externalEventId:'public-event-1'},assessment:{ruleVersionId:uid(3)}},capture:{newRiskEventId:['riskEvent','riskEventId'],newAssessmentId:['assessment','assessmentId']}},
    {operationId:'read-assessment',params:{assessmentId:'${newAssessmentId}'},expectStatus:200,expectBody:{assessmentId:'${newAssessmentId}',riskEventId:'${newRiskEventId}',ruleVersionId:uid(3)}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','riskEvents'],match:{riskEventId:'${newRiskEventId}',externalEventId:'public-event-1',amountMinor:500}}]}
  ],notes:[
    'V2 wire clarification: RuleSet is {ruleSetId,tenantId,name}; create-version carries rules and thresholds. Activation takes expectedActiveRuleVersionId (null means no active version). Rollback takes the current fromRuleVersionId, earlier toRuleVersionId and reason.',
    'V2 wire clarification: risk-event submission returns {riskEvent,assessment}; the assessment read returns Assessment, and RuleHits remain visible in snapshot. Claims take reviewerId, expectedRevision and leaseSeconds (1..30); decisions take reviewerId and expectedRevision as the public lease fence, outcome and reasonCode. No private lease token enters a response.',
    'The legacy rule value type remains string|integer, including IN. V2 wire clarification: IN compares a scalar rule value with membership in an event array; EQ compares scalars, GTE/LTE compare integers. UTF-8 byte limits on attribute strings are additionally checked by the implementation, as JSON Schema maxLength counts characters.',
    'Remediation is append-only, freezes only eligible terminal decisions in the closed occurrence interval, and never mutates original evidence or audit records; all Manager run/correction resources are typed and appear in FINAL snapshot.'
  ]});
