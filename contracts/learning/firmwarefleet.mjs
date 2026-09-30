import {T,S,U,N,P,D,H,E,R,A,O,Q,M,pick,uid,time,digest,admin,page,query,pagination,post,get,define,manager} from './helpers-c.mjs';
const version={...S,maxLength:64,pattern:'^(?:0|[1-9][0-9]*)(?:\\.(?:0|[1-9][0-9]*)){0,7}$'};
const imageSize={...P,maximum:2147483648};
const path={...S,pattern:'^/firmware/[a-z0-9][a-z0-9._/-]{0,255}$'};
const labels=M(T);
const schemas={
  DeviceModel:O({modelId:U,name:S}),
  Device:O({deviceId:U,modelId:U,labels,installedVersion:version,installedDigest:H,lastReportSequence:N}),
  FirmwareImage:O({firmwareImageId:U,modelId:U,version,sha256:H,size:imageSize,downloadPath:path,compatibleFromVersions:A(version,{minItems:1,maxItems:100,uniqueItems:true}),createdAt:D}),
  FirmwareCampaign:O({campaignId:U,firmwareImageId:U,targetCount:N,targetDigest:H,maxParallel:{...P,maximum:1000},reportTimeoutSeconds:P,state:E('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED'),createdAt:D,completedAt:Q(D),sequence:N}),
  LegacyDeviceUpdate:O({deviceUpdateId:U,campaignId:U,deviceId:U,priorVersion:version,targetVersion:version,state:E('WAITING','DOWNLOADING','INSTALLING','VERIFYING','SUCCEEDED','FAILED','ROLLED_BACK','CANCELLED'),currentCommandSequence:N,installedDigest:Q(H)}),
  DeviceCommand:O({commandId:U,deviceUpdateId:U,sequence:P,type:E('DOWNLOAD','INSTALL','VERIFY','ROLLBACK'),imageDigest:H,commandToken:S,createdAt:D,expiresAt:D}),
  DeviceReport:O({deviceId:U,deviceUpdateId:U,sequence:P,commandId:U,commandToken:S,outcome:E('SUCCEEDED','FAILED'),installedDigest:Q(H),reportedAt:D}),
  UpgradeHopAttempt:O({attempt:P,state:E('DOWNLOADING','INSTALLING','VERIFYING','SUCCEEDED','FAILED','ROLLED_BACK'),firstCommandSequence:P,lastCommandSequence:Q(P),startedAt:D,completedAt:Q(D)}),
  UpgradeHop:O({hopIndex:{...N,maximum:4},firmwareImageId:U,fromVersion:version,toVersion:version,imageDigest:H,state:E('WAITING','RUNNING','SUCCEEDED','FAILED'),attempts:A(R('UpgradeHopAttempt'))}),
  UpgradePlan:O({deviceUpdateId:U,sourceVersion:version,targetVersion:version,pathDigest:H,currentHopIndex:{...N,maximum:4},hops:A(R('UpgradeHop'),{minItems:1,maxItems:5}),createdAt:D})
};
schemas.MultiHopDeviceUpdate=O({...schemas.LegacyDeviceUpdate.properties,upgradePlan:A(R('UpgradeHop'),{minItems:2,maxItems:5}),currentHopIndex:{...N,maximum:4}});
schemas.DeviceUpdate={oneOf:[R('LegacyDeviceUpdate'),R('MultiHopDeviceUpdate')]};
schemas.DeviceCommandPollResponse={oneOf:[O({status:{const:'COMMAND'},command:R('DeviceCommand')}),O({status:{const:'NO_CHANGE'},command:{type:'null'}})]};
schemas.SnapshotDeviceCommand=pick(schemas.DeviceCommand,'commandId deviceUpdateId sequence type imageDigest createdAt expiresAt');
schemas.SnapshotDeviceReport=pick(schemas.DeviceReport,'deviceId deviceUpdateId sequence commandId outcome installedDigest reportedAt');
schemas.SeedFirmwareImage=O({...schemas.FirmwareImage.properties,assetPath:{...S,pattern:'^(?!/)(?!.*(?:^|/)\\.\\.?(?:/|$))[^\\\\]+$'}});
const resources={deviceModels:'DeviceModel',devices:'Device',firmwareImages:'FirmwareImage',firmwareCampaigns:'FirmwareCampaign',deviceUpdates:'DeviceUpdate',deviceCommands:'SnapshotDeviceCommand',deviceReports:'SnapshotDeviceReport',upgradePlans:'UpgradePlan'};
const model={modelId:uid(1),name:'Public Device Model'};
const device={deviceId:uid(2),modelId:uid(1),labels:{fleet:'public'},installedVersion:'1.0.0',installedDigest:digest,lastReportSequence:0};
const imageInput={modelId:uid(1),version:'2.0.0',sha256:'b'.repeat(64),size:5,downloadPath:'/firmware/public-v2.bin',compatibleFromVersions:['1.0.0']};
export default define({taskId:'firmwarefleet',title:'FirmwareFleet',schemas,resources,seedResources:{deviceModels:'DeviceModel',devices:'Device',firmwareImages:'SeedFirmwareImage',campaigns:'FirmwareCampaign',deviceUpdates:'LegacyDeviceUpdate',commands:'DeviceCommand',reports:'DeviceReport'},seedValues:{deviceModels:[model],devices:[device]},importedAt:false,environmentVariables:['CHROMIUM_PATH','MANAGED_DATA_ROOT'],workKinds:['COMMAND_DELIVERY','REPORT_TIMEOUT','ROLLBACK'],eventTypes:['campaign.created','device-update.started','firmware.installed','device-update.failed','device-update.rolled-back','campaign.completed'],eventPayload:O({}),
  operations:[
    get('list-firmware-campaigns','/api/v1/firmware-campaigns',page('FirmwareCampaign'),{query:{limit:50}},{parameters:pagination}),
    get('read-firmware-campaign','/api/v1/firmware-campaigns/:campaignId','FirmwareCampaign',{params:{campaignId:uid(4)}}),
    post('create-firmware-campaign','/api/v1/firmware-campaigns','FirmwareCampaign',O({firmwareImageId:U,selector:O({modelId:U,labels}),maxParallel:{...P,maximum:1000},reportTimeoutSeconds:P}),{body:{firmwareImageId:uid(3),selector:{modelId:uid(1),labels:{fleet:'public'}},maxParallel:1,reportTimeoutSeconds:30}},{status:202}),
    post('create-firmware-image','/api/v1/firmware-images','FirmwareImage',pick(schemas.FirmwareImage,'modelId version sha256 size downloadPath compatibleFromVersions'),{body:imageInput},{status:201}),
    post('poll-device-command','/api/v1/devices/:deviceId/commands/poll','DeviceCommandPollResponse',O({lastCommandSequence:N}),{params:{deviceId:uid(2)},body:{lastCommandSequence:0}}),
    post('report-device-batch','/api/v1/devices/:deviceId/report-batches',A(R('DeviceReport')),O({firstSequence:P,reports:A(O({sequence:P,commandId:U,commandToken:S,outcome:E('SUCCEEDED','FAILED'),installedDigest:Q(H)}),{minItems:1})}),{params:{deviceId:uid(2)},body:{firstSequence:1,reports:[{sequence:1,commandId:uid(6),commandToken:'public-example-command-token',outcome:'SUCCEEDED',installedDigest:null}]}}),
    post('cancel-firmware-campaign','/api/v1/firmware-campaigns/:campaignId/cancel','FirmwareCampaign',O({reason:S}),{params:{campaignId:uid(4)},body:{reason:'Public cancellation'}}),
    get('read-device-updates','/api/v1/devices/:deviceId/updates',O({items:A(R('DeviceUpdate'))}),{params:{deviceId:uid(2)}}),
    get('read-campaign-updates','/api/v1/firmware-campaigns/:campaignId/updates',O({items:A(R('DeviceUpdate'))}),{params:{campaignId:uid(4)}}),
    get('list-domain-events','/api/v1/domain-events',O({items:A(R('DomainEvent'))}),{query:{aggregateId:uid(4),afterSequence:0,limit:50}},{parameters:query({aggregateId:U,afterSequence:N,limit:{...P,maximum:100,default:50}},['aggregateId'])}),
    get('read-upgrade-plan','/api/v1/device-updates/:deviceUpdateId/upgrade-plan','UpgradePlan',{params:{deviceUpdateId:uid(5)}},{source:manager}),
    post('retry-device-update','/api/v1/device-updates/:deviceUpdateId/retry','DeviceUpdate',O({expectedCurrentHopIndex:{...N,maximum:4},expectedAttempt:P}),{params:{deviceUpdateId:uid(5)},body:{expectedCurrentHopIndex:0,expectedAttempt:1}},{source:manager})
  ],smoke:[
    {operationId:'poll-device-command',params:{deviceId:uid(2)},body:{lastCommandSequence:0},headers:{'Idempotency-Key':'smoke-initial-poll'},expectStatus:200,expectBody:{status:'NO_CHANGE',command:null}},
    {operationId:'create-firmware-image',body:imageInput,headers:{'Idempotency-Key':'smoke-create-firmware'},expectStatus:201,expectBody:imageInput,capture:{newFirmwareId:['firmwareImageId']}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','firmwareImages'],match:{firmwareImageId:'${newFirmwareId}',...imageInput}}]},
    {operationId:'create-firmware-campaign',body:{firmwareImageId:'${newFirmwareId}',selector:{modelId:uid(1),labels:{fleet:'public'}},maxParallel:1,reportTimeoutSeconds:30},headers:{'Idempotency-Key':'smoke-create-campaign'},expectStatus:202,expectBody:{firmwareImageId:'${newFirmwareId}',targetCount:1,maxParallel:1},capture:{newCampaignId:['campaignId']}},
    {operationId:'read-firmware-campaign',params:{campaignId:'${newCampaignId}'},expectStatus:200,expectBody:{campaignId:'${newCampaignId}',firmwareImageId:'${newFirmwareId}',targetCount:1}},
    {operationId:'read-campaign-updates',params:{campaignId:'${newCampaignId}'},expectStatus:200,expectContains:[{path:['items'],match:{campaignId:'${newCampaignId}',deviceId:uid(2),priorVersion:'1.0.0',targetVersion:'2.0.0'}}]}
  ],notes:[
    'V2 wire clarification: selector is {modelId,labels}, with labels a string equality map. Campaign creation returns the exact FirmwareCampaign at 202; targetCount, digest and progress are its published fields. Both device and campaign update reads return {items:[DeviceUpdate]}; report batches return a JSON array of DeviceReport. Reports and command polls expose only the command token needed by that Device.',
    'V2 wire clarification: snapshot DeviceCommand and DeviceReport remove commandToken entirely, as the literal recursive Token omission requires; operational poll/report schemas retain it. Multi-hop DeviceUpdate adds upgradePlan:[UpgradeHop] and currentHopIndex, while one-hop compatibility responses retain the exact legacy shape. Full UpgradePlan is always available through its dedicated read and FINAL snapshot.',
    'The minimal seed is one DeviceModel with one idle Device and no FirmwareImages, Campaigns or byte assets. Registering FirmwareImage publishes immutable metadata and a device downloadPath, and requires no upload of bytes to the API. Seeded FirmwareImages, when present, must include fully verified fixture bytes. Every numeric version component must also be a JSON-safe integer; path segments must reject empty, dot and dot-dot independently of the pattern.',
    'Upgrade-plan retry returns the changed DeviceUpdate; successful earlier hops are immutable. Hops and attempts retain global increasing command/report sequences. Domain-event reads return {items:[DomainEvent]} with aggregateId required and default afterSequence=0. Legacy public performance and recovery requirements are unchanged.'
  ]});
