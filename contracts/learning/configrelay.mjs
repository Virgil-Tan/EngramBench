import { T,id,digest,ref,record as r,obj,pick,omit,list,map,union,nullable,name,text,uuid,nat,int,empty,page,operation as op,finish,pagination,domainEventsOperation,snapshotSmoke,idem,manager,wire,detailedTransportErrors } from './helpers-b.mjs';
const I=n=>id(3,n);
const initialContent={theme:'public-neutral'};
const selector=obj({labels:r('key:name value:string')});
const s={
 Fleet:r('fleetId:uuid name:name currentRevision:nat'),
 Agent:r('agentId:uuid fleetId:uuid appliedRevision:nat appliedDigest:sha256|null desiredRevision:nat|null desiredDigest:sha256|null drift:boolean lastCommandSequence:nat lastSeenAt:timestamp',{labels:map(text)}),
 Configuration:r('fleetId:uuid revision:pos content:json canonicalDigest:sha256 createdAt:timestamp'),
 Deployment:r('deploymentId:uuid fleetId:uuid configurationRevision:pos targetCount:nat targetDigest:sha256 state:PENDING|DELIVERING|APPLIED|FAILED|CANCELLED createdAt:timestamp completedAt:timestamp|null sequence:pos',{selector}),
 Assignment:r('assignmentId:uuid deploymentId:uuid agentId:uuid commandSequence:pos revision:pos digest:sha256 state:WAITING|SENT|ACKED|FAILED|SUPERSEDED deliveryId:uuid assignmentToken:name sentAt:timestamp|null ackedAt:timestamp|null'),
 Acknowledgement:r('agentId:uuid deploymentId:uuid commandSequence:pos revision:pos digest:sha256 assignmentToken:name outcome:APPLIED|REJECTED reportedAt:timestamp'),
 DeploymentCohort:r('cohortId:uuid deploymentId:uuid ordinal:nat name:name targetCount:nat targetDigest:sha256 successCount:nat failureCount:nat pendingCount:nat state:WAITING|DELIVERING|OBSERVING|SUCCEEDED|FAILED|ROLLED_BACK startedAt:timestamp|null observationDeadlineAt:timestamp|null completedAt:timestamp|null',{selector,minimumSuccessBasisPoints:{...nat,maximum:10000},maximumFailureBasisPoints:{...nat,maximum:10000},observationSeconds:{...int,minimum:1,maximum:86400}}),
 RolloutCommand:r('commandId:uuid deploymentId:uuid cohortId:uuid agentId:uuid commandSequence:pos kind:APPLY|ROLLBACK fromRevision:nat toRevision:nat toDigest:sha256 deliveryId:uuid assignmentToken:name state:WAITING|SENT|ACKED|FAILED|SUPERSEDED createdAt:timestamp ackedAt:timestamp|null'),
 DeploymentRollback:r('rollbackId:uuid deploymentId:uuid failedCohortId:uuid state:PENDING|DELIVERING|COMPLETED|FAILED commandCount:nat completedCount:nat startedAt:timestamp completedAt:timestamp|null'),
};
s.SeedAgent=omit(s.Agent,['desiredRevision','desiredDigest','drift']);
s.StagedDeployment=obj({...s.Deployment.properties,cohorts:list(ref('DeploymentCohort'),{minItems:1,maxItems:20}),rollback:nullable(ref('DeploymentRollback'))});
s.AnyDeployment=union(ref('Deployment'),ref('StagedDeployment'));
s.PollResult=union(obj({status:{const:'NO_CHANGE'},command:{type:'null'}}),obj({status:{const:'COMMAND'},command:union(ref('Assignment'),ref('RolloutCommand'))}));
s.SnapshotAssignment=omit(s.Assignment,['assignmentToken']);s.SnapshotAcknowledgement=omit(s.Acknowledgement,['assignmentToken']);s.SnapshotRolloutCommand=omit(s.RolloutCommand,['assignmentToken']);
const base={fleets:'Fleet',agents:'SeedAgent',configurations:'Configuration',deployments:'Deployment',assignments:'Assignment'};
const deploymentFields={fleetId:uuid,configurationRevision:{...int,minimum:1},selector,expectedFleetRevision:nat};
const createDeployment=union(obj(deploymentFields),obj({...deploymentFields,cohorts:list(pick(s.DeploymentCohort,['name','selector','minimumSuccessBasisPoints','maximumFailureBasisPoints','observationSeconds']),{minItems:1,maxItems:20})}));
export default finish({taskId:'configrelay',title:'ConfigRelay',schemas:s,seedTypes:base,resources:{agents:'Agent',configurations:'Configuration',deployments:'AnyDeployment',assignments:'SnapshotAssignment',acknowledgements:'SnapshotAcknowledgement',deploymentCohorts:'DeploymentCohort',rolloutCommands:'SnapshotRolloutCommand',deploymentRollbacks:'DeploymentRollback'},emptyEventPayload:true,environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],transportErrors:detailedTransportErrors,
 seedData:{fleets:[{fleetId:I(1),name:'Public fleet',currentRevision:1}],configurations:[{fleetId:I(1),revision:1,content:initialContent,canonicalDigest:digest(initialContent),createdAt:T}],agents:[{agentId:I(2),fleetId:I(1),labels:{region:'public'},appliedRevision:1,appliedDigest:digest(initialContent),lastCommandSequence:0,lastSeenAt:T}]},
 workKinds:['ASSIGNMENT_DELIVERY','COHORT_DEADLINE','ROLLBACK_DELIVERY'],eventTypes:['deployment.created','assignment.sent','assignment.acknowledged','assignment.failed','deployment.completed','deployment.cancelled'],
 operations:[op('deployments-list','GET','/api/v1/deployments',null,page(ref('AnyDeployment')),{parameters:pagination}),op('deployment-get','GET','/api/v1/deployments/:deploymentId',null,ref('AnyDeployment')),
 op('deployment-create','POST','/api/v1/deployments',createDeployment,ref('AnyDeployment'),{status:202,source:`${manager}; ${wire}`}),
 op('configuration-create','POST','/api/v1/fleets/:fleetId/configurations',r('content:json expectedFleetRevision:nat'),ref('Configuration'),{status:201,example:{params:{fleetId:I(1)},body:{content:{theme:'public-blue'},expectedFleetRevision:1}}}),
 op('agent-poll','POST','/api/v1/agents/:agentId/poll',obj({appliedRevision:nat,lastCommandSequence:nat},['appliedRevision']),ref('PollResult')),
 op('agent-acknowledge','POST','/api/v1/agents/:agentId/acknowledgements',pick(s.Acknowledgement,['deploymentId','commandSequence','revision','digest','assignmentToken','outcome']),ref('Acknowledgement')),
 op('deployment-cancel','POST','/api/v1/deployments/:deploymentId/cancel',r('reason:name'),ref('AnyDeployment')),
 op('agent-get','GET','/api/v1/agents/:agentId',null,ref('Agent')),
 op('agent-assignments','GET','/api/v1/agents/:agentId/assignments',null,obj({items:list(ref('Assignment'))})),domainEventsOperation()],
 smoke:[snapshotSmoke([['agents',{agentId:I(2),fleetId:I(1),appliedRevision:1}],['configurations',{fleetId:I(1),revision:1,canonicalDigest:digest(initialContent)}]]),{operationId:'agent-get',params:{agentId:I(2)},expectStatus:200,expectBody:{agentId:I(2),fleetId:I(1)}},{operationId:'configuration-create',params:{fleetId:I(1)},headers:idem('configuration'),body:{content:{theme:'public-blue'},expectedFleetRevision:1},expectStatus:201,capture:{revision:['revision']},expectBody:{fleetId:I(1),content:{theme:'public-blue'}}},snapshotSmoke([['configurations',{fleetId:I(1),revision:'${revision}',content:{theme:'public-blue'}}]])],
 notes:['V2 wire clarification: preserve the published selector shape {labels:{key,value}} (one label predicate). A multi-predicate selector encoding is not specified by V1 and is not silently introduced.','V2 wire clarification: configuration creation returns Configuration; acknowledgement returns Acknowledgement with server reportedAt; assignment history is {items:[Assignment]}. Poll command is Assignment or Manager RolloutCommand.','Snapshot intentionally has no fleets array, matching the original exact resource list. Every assignmentToken property is omitted in snapshots, not replaced with a marker; live command and acknowledgement responses retain it. Legacy deployment responses do not gain Manager fields unless a staged rollout was requested.'],
});
