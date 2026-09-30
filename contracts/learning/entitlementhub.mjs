import {T,S,U,N,P,B,D,C,E,R,A,O,Q,M,J,pick,uid,time,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const schemas={
  Plan:O({planId:U,tenantId:U,name:S}),
  PlanRevision:O({planRevisionId:U,planId:U,revision:P,state:E('DRAFT','PUBLISHED','RETIRED'),priceMinor:N,currency:C,interval:E('MONTH','YEAR'),features:M(O({limit:Q(N)})),trialDays:N,graceDays:N,refundDays:N,createdAt:D,publishedAt:Q(D)}),
  Subscription:O({subscriptionId:U,tenantId:U,subjectId:S,planRevisionId:U,state:E('PENDING','TRIALING','ACTIVE','FAILED','PAST_DUE','CANCELLED','EXPIRED','REFUNDED'),periodStart:D,periodEnd:D,trialEndsAt:Q(D),cancelAtPeriodEnd:B,pendingPlanRevisionId:Q(U),revocationVersion:N,createdAt:D,terminalAt:Q(D),sequence:N}),
  TrialConsumption:O({tenantId:U,subjectId:S,planId:U,subscriptionId:U,consumedAt:D}),
  PlanChange:O({changeId:U,subscriptionId:U,fromPlanRevisionId:U,toPlanRevisionId:U,kind:E('UPGRADE','DOWNGRADE'),state:E('REQUESTED','APPLIED','SCHEDULED','REJECTED','CANCELLED'),effectiveAt:D,amountMinor:N,createdAt:D}),
  Refund:O({refundId:U,subscriptionId:U,providerRequestId:S,amountMinor:N,currency:C,state:E('REQUESTED','SUCCEEDED','FAILED','UNKNOWN'),createdAt:D,resolvedAt:Q(D)}),
  ProviderEvent:O({providerEventId:S,providerRequestId:S,kind:E('SUBSCRIPTION','REFUND'),outcome:E('SUCCEEDED','FAILED','UNKNOWN'),occurredAt:D}),
  EntitlementGrant:O({grantId:U,subscriptionId:U,feature:S,limit:Q(N),validFrom:D,validUntil:Q(D),grantRevision:P}),
  RevocationFence:O({tenantId:U,subjectId:S,revocationVersion:N,updatedAt:D}),
  EntitlementView:O({tenantId:U,subjectId:S,feature:S,state:E('ENABLED','DISABLED'),limit:Q(N),subscriptionId:Q(U),revocationVersion:N,evaluatedAt:D}),
  EntitlementPool:O({poolId:U,tenantId:U,subscriptionId:U,feature:S,seatLimit:N,state:E('ACTIVE','OVER_LIMIT','REVOKED','EXPIRED'),version:N,periodStart:D,periodEnd:D,createdAt:D}),
  SeatAssignment:O({poolId:U,subjectId:S,state:E('ACTIVE','REVOKED','EXPIRED'),assignedAt:D,terminalAt:Q(D)})
};
const base={tenants:'Tenant',plans:'Plan',planRevisions:'PlanRevision',subscriptions:'Subscription',trialConsumptions:'TrialConsumption',planChanges:'PlanChange',refunds:'Refund',providerEvents:'ProviderEvent',entitlementGrants:'EntitlementGrant',revocationFences:'RevocationFence',auditEntries:'AuditEntry'};
const tenant={tenantId:uid(1),name:'Public Entitlement Tenant'};
const plan={planId:uid(2),tenantId:uid(1),name:'Public Basic Plan'};
const terms={priceMinor:1200,currency:'USD',interval:'MONTH',features:{projects:{limit:5}},trialDays:7,graceDays:3,refundDays:14};
const revision={planRevisionId:uid(3),planId:uid(2),revision:1,state:'PUBLISHED',...terms,createdAt:time,publishedAt:time};
export default define({taskId:'entitlementhub',title:'EntitlementHub',schemas,resources:{...base,entitlementPools:'EntitlementPool',seatAssignments:'SeatAssignment'},seedResources:base,importedAt:false,seedValues:{tenants:[tenant],plans:[plan],planRevisions:[revision]},environmentVariables:['PROVIDER_BASE_URL'],
  workKinds:['SUBSCRIPTION_ACTIVATE','PLAN_CHANGE_APPLY','SUBSCRIPTION_EXPIRE','REFUND_RECONCILE','ENTITLEMENT_REVOKE','EVENT_DELIVERY','POOL_RECONCILE','POOL_REVOKE'],eventTypes:['subscription.started','subscription.changed','subscription.cancelled','subscription.expired','refund.succeeded','entitlement.revoked'],
  operations:[
    post('create-tenant','/api/v1/tenants','Tenant',O({name:S}),{body:{name:'Another Entitlement Tenant'}}),
    post('create-plan','/api/v1/plans','Plan',pick(schemas.Plan,'tenantId name'),{body:{tenantId:uid(1),name:'Public Team Plan'}}),
    post('create-plan-revision','/api/v1/plans/:planId/revisions','PlanRevision',pick(schemas.PlanRevision,'priceMinor currency interval features trialDays graceDays refundDays'),{params:{planId:uid(2)},body:terms}),
    post('publish-plan-revision','/api/v1/plan-revisions/:planRevisionId/publish','PlanRevision',O({}),{params:{planRevisionId:uid(3)},body:{}}),
    post('create-subscription','/api/v1/subscriptions','Subscription',O({tenantId:U,subjectId:S,planRevisionId:U,startTrial:B,subscriptionKind:E('INDIVIDUAL','ORGANIZATION')},['tenantId','subjectId','planRevisionId','startTrial']),{body:{tenantId:uid(1),subjectId:'public-subject',planRevisionId:uid(3),startTrial:true}}),
    get('read-subscription','/api/v1/subscriptions/:subscriptionId','Subscription',{params:{subscriptionId:uid(4)}}),
    post('change-plan','/api/v1/subscriptions/:subscriptionId/change-plan','PlanChange',O({toPlanRevisionId:U,expectedPlanRevisionId:U,kind:E('UPGRADE','DOWNGRADE')}),{params:{subscriptionId:uid(4)},body:{toPlanRevisionId:uid(5),expectedPlanRevisionId:uid(3),kind:'UPGRADE'}}),
    post('cancel-subscription','/api/v1/subscriptions/:subscriptionId/cancel','Subscription',O({cancelAtPeriodEnd:B}),{params:{subscriptionId:uid(4)},body:{cancelAtPeriodEnd:false}}),
    post('create-refund','/api/v1/subscriptions/:subscriptionId/refunds','Refund',O({amountMinor:P}),{params:{subscriptionId:uid(4)},body:{amountMinor:600}}),
    post('provider-event','/api/v1/provider/events','ProviderEvent',R('ProviderEvent'),{body:{providerEventId:'public-provider-event',providerRequestId:'public-provider-request',kind:'REFUND',outcome:'SUCCEEDED',occurredAt:time}}),
    post('reconcile-refund','/api/v1/refunds/:refundId/reconcile','Refund',O({}),{params:{refundId:uid(6)},body:{}}),
    get('check-entitlement','/api/v1/entitlements/check','EntitlementView',{query:{tenantId:uid(1),subjectId:'public-subject',feature:'projects',knownRevocationVersion:0}},{parameters:query({tenantId:U,subjectId:S,feature:S,knownRevocationVersion:N},['tenantId','subjectId','feature'])}),
    get('list-entitlements','/api/v1/entitlements',page('EntitlementView'),{query:{tenantId:uid(1),subjectId:'public-subject',limit:50}},{parameters:[...query({tenantId:U,subjectId:S},['tenantId','subjectId']),...pagination]}),
    post('expire-due','/api/v1/admin/expire-due',O({expiredSubscriptionIds:A(U)}),O({}),{headers:admin,body:{}},{parameters:[{name:'Authorization',in:'header',required:true,schema:S},{name:'Idempotency-Key',in:'header',required:true,schema:S}]}),
    get('list-audit','/api/v1/audit',page('AuditEntry'),{query:{tenantId:uid(1),limit:50}},{parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-entitlement-pool','/api/v1/entitlement-pools','EntitlementPool',pick(schemas.EntitlementPool,'tenantId subscriptionId feature seatLimit'),{body:{tenantId:uid(1),subscriptionId:uid(4),feature:'projects',seatLimit:5}},{source:manager}),
    post('assign-seat','/api/v1/entitlement-pools/:poolId/assignments',O({pool:R('EntitlementPool'),assignment:R('SeatAssignment')}),O({subjectId:S,expectedPoolVersion:N}),{params:{poolId:uid(7)},body:{subjectId:'public-member',expectedPoolVersion:0}},{source:manager}),
    post('revoke-seat','/api/v1/entitlement-pools/:poolId/assignments/:subjectId/revoke',O({pool:R('EntitlementPool'),assignment:R('SeatAssignment')}),O({expectedPoolVersion:N}),{params:{poolId:uid(7),subjectId:'public-member'},body:{expectedPoolVersion:1}},{source:manager}),
    get('list-pool-assignments','/api/v1/entitlement-pools/:poolId/assignments',page('SeatAssignment'),{params:{poolId:uid(7)},query:{limit:50}},{source:manager,parameters:pagination})
  ],smoke:[
    {operationId:'create-plan',body:{tenantId:uid(1),name:'Created Through Public HTTP'},headers:{'Idempotency-Key':'smoke-create-plan'},expectStatus:200,expectBody:{tenantId:uid(1),name:'Created Through Public HTTP'},capture:{newPlanId:['planId']}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','plans'],match:{planId:'${newPlanId}',tenantId:uid(1),name:'Created Through Public HTTP'}}]},
    {operationId:'check-entitlement',query:{tenantId:uid(1),subjectId:'unsubscribed-public-subject',feature:'projects'},expectStatus:200,expectBody:{tenantId:uid(1),subjectId:'unsubscribed-public-subject',feature:'projects',state:'DISABLED',subscriptionId:null}}
  ],notes:[
    'V2 wire clarification: Plan is {planId,tenantId,name}; PlanRevision.features is a map from enabled feature name to {limit:nonnegative integer|null}, where null means unbounded and absent means unavailable. TrialConsumption and RevocationFence shapes are published explicitly. This freezes the formerly unspecified feature-limit representation.',
    'V2 wire clarification: subscription create takes startTrial explicitly; subscriptionKind is optional and defaults to INDIVIDUAL. The public Subscription shape remains the exact legacy fields; the server persists kind for Pool eligibility. Change-plan takes kind plus expectedPlanRevisionId and toPlanRevisionId; cancellation takes cancelAtPeriodEnd. Refund currency and provider request identity derive from the frozen period, never from caller input.',
    'V2 wire clarification: expire-due has {} body, requires ADMIN_TOKEN, expires all currently due eligible subscriptions and returns sorted expiredSubscriptionIds. No provider credentials or raw provider bodies are published. Manager Pool state is snapshot-only beyond its documented operations.'
  ]});
