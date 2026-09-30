import { T,id,digest,ref,record as r,obj,pick,omit,list,union,nullable,name,text,uuid,time,nat,pos,int,empty,page,operation as op,finish,pagination,snapshotSmoke,idem,manager,wire } from './helpers-b.mjs';
const I=n=>id(5,n);
const s={
 Tenant:r('tenantId:uuid name:name createdAt:timestamp'),
 Recipient:r('recipientId:uuid tenantId:uuid externalRef:string locale:string timeZone:string preferenceRevision:nat createdAt:timestamp'),
 ChannelEndpoint:r('endpointId:uuid tenantId:uuid recipientId:uuid channel:EMAIL|SMS|WEBHOOK address:string state:ACTIVE|UNSUBSCRIBED|DISABLED|BOUNCED revision:nat createdAt:timestamp terminalAt:timestamp|null'),
 Template:r('templateId:uuid tenantId:uuid name:name createdAt:timestamp'),
 TemplateVersion:r('templateVersionId:uuid templateId:uuid version:pos channel:EMAIL|SMS|WEBHOOK subject:string|null body:string contentDigest:sha256 createdAt:timestamp'),
 RouteStep:r('ordinal:nat channel:EMAIL|SMS|WEBHOOK delaySeconds:nat maxAttempts:pos baseRetrySeconds:nat'),
 RoutePolicy:r('routePolicyId:uuid tenantId:uuid name:string revision:pos steps:[RouteStep] createdAt:timestamp'),
 RateLimitPolicy:r('rateLimitPolicyId:uuid tenantId:uuid channel:EMAIL|SMS|WEBHOOK revision:pos windowSeconds:pos tenantLimit:pos recipientLimit:pos|null effectiveFrom:timestamp'),
 Notification:r('notificationId:uuid tenantId:uuid recipientId:uuid category:string dedupeKey:string templateVersionId:uuid routePolicyId:uuid routePolicyRevision:pos state:ACCEPTED|ROUTING|DELIVERING|DELIVERED|PARTIALLY_DELIVERED|SUPPRESSED|FAILED|CANCELLED data:object acceptedAt:timestamp terminalAt:timestamp|null sequence:pos'),
 Delivery:r('deliveryId:uuid notificationId:uuid endpointId:uuid channel:EMAIL|SMS|WEBHOOK routeOrdinal:nat state:PENDING|RATE_LIMITED|SENDING|ACCEPTED|DELIVERED|FAILED|UNKNOWN|SUPPRESSED|CANCELLED attemptCount:nat providerMessageId:string|null suppressionRevision:nat nextAttemptAt:timestamp|null createdAt:timestamp terminalAt:timestamp|null sequence:pos'),
 DeliveryAttempt:r('attemptId:uuid deliveryId:uuid attemptNumber:pos providerRequestId:string outcome:ACCEPTED|REJECTED|TIMEOUT|CONNECTION_RESET|HTTP_ERROR startedAt:timestamp finishedAt:timestamp|null'),
 Suppression:r('suppressionId:uuid tenantId:uuid recipientId:uuid channel:EMAIL|SMS|WEBHOOK|ALL category:string|null state:ACTIVE|RELEASED revision:pos reason:string createdAt:timestamp releasedAt:timestamp|null'),
 ProviderReceipt:r('providerReceiptId:uuid channel:EMAIL|SMS|WEBHOOK providerEventId:string providerMessageId:string deliveryId:uuid outcome:DELIVERED|BOUNCED|COMPLAINED|FAILED occurredAt:timestamp receivedAt:timestamp'),
 Campaign:r('campaignId:uuid tenantId:uuid name:name templateVersionId:uuid routePolicyId:uuid routePolicyRevision:pos category:string data:object state:QUEUED|RUNNING|PAUSED|COMPLETED|CANCELLED recipientCount:nat createdAt:timestamp completedAt:timestamp|null cancelledAt:timestamp|null'),
 CampaignRecipient:r('campaignId:uuid recipientId:uuid suppressionRevision:nat notificationId:uuid|null'),
};
s.CampaignDetail=obj({campaign:ref('Campaign'),campaignRecipients:list(ref('CampaignRecipient'))});
const base={tenants:'Tenant',recipients:'Recipient',channelEndpoints:'ChannelEndpoint',templates:'Template',templateVersions:'TemplateVersion',routePolicies:'RoutePolicy',rateLimitPolicies:'RateLimitPolicy',notifications:'Notification',deliveries:'Delivery',deliveryAttempts:'DeliveryAttempt',suppressions:'Suppression',providerReceipts:'ProviderReceipt'};
const scope=pick(s.Suppression,['channel','category']);
const unsubscribe=obj({...scope.properties,reason:name,expectedPreferenceRevision:nat});
const resubscribe=obj({...scope.properties,consentReference:name,expectedPreferenceRevision:nat});
const content={channel:'EMAIL',subject:'Public notice',body:'This is a public example.'};
export default finish({taskId:'notifyroute',title:'NotifyRoute',schemas:s,seedTypes:base,resources:{...base,campaigns:'Campaign',campaignRecipients:'CampaignRecipient'},importedAt:true,transportErrors:{invalidRequest:{status:400,code:'INVALID_REQUEST'}},environmentVariables:['NOTIFYROUTE_WEBHOOK_SIGNING_SECRET'],
 seedData:{tenants:[{tenantId:I(1),name:'Public notifications',createdAt:T}],recipients:[{recipientId:I(2),tenantId:I(1),externalRef:'public-recipient',locale:'en-US',timeZone:'UTC',preferenceRevision:0,createdAt:T}],channelEndpoints:[{endpointId:I(3),tenantId:I(1),recipientId:I(2),channel:'EMAIL',address:'public@example.com',state:'ACTIVE',revision:1,createdAt:T,terminalAt:null}],templates:[{templateId:I(4),tenantId:I(1),name:'Public notice',createdAt:T}],templateVersions:[{templateVersionId:I(5),templateId:I(4),version:1,...content,contentDigest:digest(content),createdAt:T}],routePolicies:[{routePolicyId:I(6),tenantId:I(1),name:'Public email route',revision:1,steps:[{ordinal:0,channel:'EMAIL',delaySeconds:0,maxAttempts:1,baseRetrySeconds:1}],createdAt:T}],rateLimitPolicies:[{rateLimitPolicyId:I(7),tenantId:I(1),channel:'EMAIL',revision:1,windowSeconds:60,tenantLimit:10,recipientLimit:2,effectiveFrom:T}]},
 workKinds:['NOTIFICATION_ROUTE','DELIVERY_SEND','DELIVERY_RECONCILE','CAMPAIGN_FANOUT'],eventTypes:['notification.accepted','notification.terminal','delivery.suppressed','delivery.accepted','delivery.delivered','delivery.failed','delivery.unknown','recipient.unsubscribed'],
 operations:[
 op('tenant-create','POST','/api/v1/tenants',r('name:name'),ref('Tenant')),
 op('recipient-create','POST','/api/v1/recipients',pick(s.Recipient,['tenantId','externalRef','locale','timeZone']),ref('Recipient')),
 op('endpoint-create','POST','/api/v1/channel-endpoints',pick(s.ChannelEndpoint,['tenantId','recipientId','channel','address']),ref('ChannelEndpoint')),
 op('template-create','POST','/api/v1/templates',pick(s.Template,['tenantId','name']),ref('Template')),
 op('template-version-create','POST','/api/v1/template-versions',pick(s.TemplateVersion,['templateId','version','channel','subject','body']),ref('TemplateVersion')),
 op('route-policy-create','POST','/api/v1/route-policies',pick(s.RoutePolicy,['tenantId','name','revision','steps']),ref('RoutePolicy')),
 op('rate-limit-policy-create','POST','/api/v1/rate-limit-policies',pick(s.RateLimitPolicy,['tenantId','channel','revision','windowSeconds','tenantLimit','recipientLimit','effectiveFrom']),ref('RateLimitPolicy')),
 op('notification-create','POST','/api/v1/notifications',pick(s.Notification,['tenantId','recipientId','category','dedupeKey','templateVersionId','routePolicyId','data']),ref('Notification')),
 op('notification-get','GET','/api/v1/notifications/:notificationId',null,ref('Notification')),
 op('notification-cancel','POST','/api/v1/notifications/:notificationId/cancel',empty,ref('Notification')),
 op('recipient-unsubscribe','POST','/api/v1/recipients/:recipientId/unsubscribe',unsubscribe,ref('Suppression'),{example:{params:{recipientId:I(2)},body:{channel:'EMAIL',category:null,reason:'Public opt-out',expectedPreferenceRevision:0}}}),
 op('recipient-resubscribe','POST','/api/v1/recipients/:recipientId/resubscribe',resubscribe,ref('Suppression')),
 op('provider-receipt','POST','/api/v1/provider/receipts',pick(s.ProviderReceipt,['channel','providerEventId','providerMessageId','deliveryId','outcome','occurredAt']),ref('ProviderReceipt')),
 op('delivery-reconcile','POST','/api/v1/deliveries/:deliveryId/reconcile',empty,ref('Delivery')),
 op('campaign-create','POST','/api/v1/campaigns',obj({...pick(s.Campaign,['tenantId','name','templateVersionId','routePolicyId','category','data']).properties,recipientIds:list(uuid,{minItems:1})}),ref('CampaignDetail'),{source:`${manager}; ${wire} (new route and resource)`}),
 op('campaigns-list','GET','/api/v1/campaigns',null,page(ref('Campaign')),{parameters:pagination,source:`${manager}; ${wire} (new route)`}),
 op('campaign-get','GET','/api/v1/campaigns/:campaignId',null,ref('CampaignDetail'),{source:`${manager}; ${wire} (new route and resource)`}),
 ...['pause','resume','cancel'].map(action=>op(`campaign-${action}`,'POST',`/api/v1/campaigns/:campaignId/${action}`,empty,ref('Campaign'),{source:`${manager}; ${wire} (new route)`})),
 ],
 smoke:[snapshotSmoke([['tenants',{tenantId:I(1)}],['recipients',{recipientId:I(2),preferenceRevision:0}],['channelEndpoints',{endpointId:I(3),recipientId:I(2)}],['templateVersions',{templateVersionId:I(5),contentDigest:digest(content)}],['routePolicies',{routePolicyId:I(6),revision:1}],['rateLimitPolicies',{rateLimitPolicyId:I(7)}]]),{operationId:'recipient-unsubscribe',params:{recipientId:I(2)},headers:idem('public-unsubscribe'),body:{channel:'EMAIL',category:null,reason:'Public opt-out',expectedPreferenceRevision:0},expectStatus:200,capture:{suppressionId:['suppressionId']},expectBody:{recipientId:I(2),channel:'EMAIL',category:null,state:'ACTIVE'}},snapshotSmoke([['suppressions',{suppressionId:'${suppressionId}',recipientId:I(2),state:'ACTIVE'}]])],
 notes:[
 'V2 wire clarification: Tenant and Template fields, creation bodies, and consent optimistic-concurrency input expectedPreferenceRevision are newly fixed public transport. Generated identity, state and timestamps are omitted from creation bodies. Unsubscribe/resubscribe return the named Suppression; category:null is the all-category scope and channel:ALL is all channels.',
 'V2 wire clarification: TemplateVersion.contentDigest is SHA-256 of UTF-8 canonical JSON {channel,subject,body}. This makes the previously unspecified digest reproducible without defining new template syntax. The public seed has no template variables and causes no external send.',
 'V2 wire clarification: Manager Campaign routes, Campaign/CampaignRecipient fields and snapshot collections are explicitly new, not original V1 definitions. Campaign creation/get return {campaign,campaignRecipients}; pause/resume/cancel return Campaign. Recipient IDs may repeat in the input because the published Manager rule requires deduplicating them. campaignRecipients holds the frozen audience preference revision and eventual Notification link.',
 'Public signing wire clarification: WEBHOOK deliveries use NOTIFYROUTE_WEBHOOK_SIGNING_SECRET as a nonempty UTF-8 HMAC key. Send X-NotifyRoute-Signature as lowercase hexadecimal HMAC-SHA256 over the exact UTF-8 HTTP request-body bytes. The stable Idempotency-Key and X-NotifyRoute-Delivery-Id still follow the complete product requirements. API and Worker roles receive the same configured secret; it must never enter public resources, snapshots or events. This specifies the missing transport/configuration of the original HMAC requirement, not a provider implementation. Template-variable grammar remains outside hidden assertions unless explicitly specified by the product requirements.',
 ],
});
