import {T,S,U,N,P,D,H,E,R,A,O,Q,M,J,uid,time,admin,page,query,pagination,post,get,op,define,manager} from './helpers-c.mjs';
const jsonObject=M(J);
const schemas={
  Device:O({deviceId:U,tenantId:U,externalRef:S,state:E('ONLINE','OFFLINE','RETIRED'),lastSeenAt:Q(D),createdAt:D}),
  DeviceShadow:O({deviceId:U,desiredVersion:N,desired:jsonObject,reportedVersion:N,reported:jsonObject,updatedAt:D}),
  DeviceCommand:O({commandId:U,tenantId:U,deviceId:U,kind:S,payload:jsonObject,desiredVersion:N,deliveryIdentity:S,state:E('QUEUED','DELIVERED','ACKNOWLEDGED','FAILED','EXPIRED','CANCELLED'),expiresAt:D,createdAt:D}),
  CommandReceipt:O({receiptId:U,tenantId:U,deviceId:U,commandId:U,deviceSequence:P,outcome:E('ACKNOWLEDGED','FAILED'),reportedPatch:jsonObject,observedAt:D,receivedAt:D}),
  FirmwareRelease:O({firmwareReleaseId:U,tenantId:U,version:S,digest:H,sizeBytes:P,state:E('READY','REVOKED'),createdAt:D}),
  UpgradeCampaign:O({upgradeCampaignId:U,tenantId:U,firmwareReleaseId:U,state:E('QUEUED','RUNNING','PAUSED','COMPLETED','CANCELLED'),createdAt:D}),
  UpgradeTarget:O({upgradeCampaignId:U,deviceId:U,priorFirmwareDigest:H,state:E('PENDING','COMMAND_CREATED','SUCCEEDED','FAILED','EXPIRED','CANCELLED'),commandId:Q(U)}),
  DeploymentWave:O({deploymentWaveId:U,tenantId:U,upgradeCampaignId:U,requestRef:S,state:E('QUEUED','RUNNING','PAUSED','COMPLETED','CANCELLED','ROLLED_BACK'),currentWaveOrdinal:Q(N),waves:A(O({ordinal:N,name:S,state:E('PENDING','RUNNING','PAUSED','SUCCEEDED','FAILED','ROLLED_BACK'),minimumObservationSeconds:{...P,maximum:86400},maximumFailurePercent:{...N,maximum:100}}),{minItems:1}),createdAt:D,updatedAt:D,sequence:N}),
  WaveDevice:O({deploymentWaveId:U,waveOrdinal:N,deviceId:U,priorFirmwareReleaseId:Q(U),targetFirmwareReleaseId:U,state:E('PENDING','COMMAND_CREATED','SUCCEEDED','FAILED','ROLLBACK_PENDING','ROLLED_BACK'),commandId:Q(U),rollbackTargetId:Q(U),confirmedAt:Q(D)})
};
schemas.ReceiptResult=O({...schemas.CommandReceipt.properties,projectionStatus:E('APPLIED','STALE','TERMINAL')});
schemas.CompensationUpgradeTarget=O({...schemas.UpgradeTarget.properties,upgradeTargetId:U});
schemas.FinalUpgradeTarget={oneOf:[R('UpgradeTarget'),R('CompensationUpgradeTarget')]};
const base={tenants:'Tenant',devices:'Device',deviceShadows:'DeviceShadow',deviceCommands:'DeviceCommand',commandReceipts:'CommandReceipt',firmwareReleases:'FirmwareRelease',upgradeCampaigns:'UpgradeCampaign',upgradeTargets:'UpgradeTarget'};
const tenant={tenantId:uid(1),name:'Public Edge Tenant'};
const device={deviceId:uid(2),tenantId:uid(1),externalRef:'public-device',state:'OFFLINE',lastSeenAt:null,createdAt:time};
const shadow={deviceId:uid(2),desiredVersion:0,desired:{mode:'idle'},reportedVersion:0,reported:{mode:'idle'},updatedAt:time};
export default define({taskId:'edgetwin',title:'EdgeTwin',schemas,resources:{...base,upgradeTargets:'FinalUpgradeTarget',deploymentWaves:'DeploymentWave',waveDevices:'WaveDevice'},seedResources:base,seedValues:{tenants:[tenant],devices:[device],deviceShadows:[shadow]},snapshotVersion:true,environmentVariables:['DEVICE_POLL_LIMIT'],workKinds:['COMMAND_DISPATCH','COMMAND_EXPIRE','UPGRADE_FANOUT','RECEIPT_PROJECT','DEPLOYMENT_WAVE_ADVANCE'],eventTypes:['shadow.desired_updated','shadow.reported_updated','command.created','command.delivered','command.acknowledged','command.failed','command.expired','upgrade.created','upgrade.target_terminal','upgrade.terminal'],
  operations:[
    get('list-tenants','/api/v1/tenants',page('Tenant'),{query:{limit:50}},{parameters:pagination}),
    post('create-tenant','/api/v1/tenants','Tenant',O({name:S}),{body:{name:'Another Edge Tenant'}}),
    get('list-devices','/api/v1/devices',page('Device'),{query:{tenantId:uid(1),limit:50}},{parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-device','/api/v1/devices','Device',O({tenantId:U,externalRef:S}),{body:{tenantId:uid(1),externalRef:'second-public-device'}}),
    get('read-device-shadow','/api/v1/devices/:deviceId/shadow','DeviceShadow',{params:{deviceId:uid(2)}}),
    op('patch-desired-shadow','PATCH','/api/v1/devices/:deviceId/shadow/desired','DeviceShadow',O({expectedVersion:N,patch:jsonObject}),{params:{deviceId:uid(2)},body:{expectedVersion:0,patch:{mode:'active'}}}),
    post('create-device-command','/api/v1/device-commands','DeviceCommand',O({tenantId:U,deviceId:U,kind:S,payload:jsonObject,desiredVersion:N,expiresAt:D}),{body:{tenantId:uid(1),deviceId:uid(2),kind:'SET_MODE',payload:{mode:'active'},desiredVersion:1,expiresAt:'2030-01-01T00:00:00.000Z'}}),
    get('read-device-command','/api/v1/device-commands/:commandId','DeviceCommand',{params:{commandId:uid(3)}}),
    post('cancel-device-command','/api/v1/device-commands/:commandId/cancel','DeviceCommand',O({}),{params:{commandId:uid(3)},body:{}}),
    post('connect-device','/api/v1/devices/:deviceId/connect',O({device:R('Device'),connectionId:U}),O({tenantId:U}),{params:{deviceId:uid(2)},body:{tenantId:uid(1)}}),
    post('disconnect-device','/api/v1/devices/:deviceId/disconnect','Device',O({tenantId:U,connectionId:U}),{params:{deviceId:uid(2)},body:{tenantId:uid(1),connectionId:uid(4)}}),
    post('poll-device','/api/v1/devices/:deviceId/poll',O({items:A(R('DeviceCommand'))}),O({tenantId:U,connectionId:U,limit:{...P,maximum:1000}}),{params:{deviceId:uid(2)},body:{tenantId:uid(1),connectionId:uid(4),limit:100}}),
    post('create-command-receipt','/api/v1/command-receipts','ReceiptResult',O({tenantId:U,deviceId:U,commandId:U,deliveryIdentity:S,receiptId:U,deviceSequence:P,outcome:E('ACKNOWLEDGED','FAILED'),reportedBaseVersion:N,reportedPatch:jsonObject,observedAt:D}),{body:{tenantId:uid(1),deviceId:uid(2),commandId:uid(3),deliveryIdentity:'public-command-delivery',receiptId:uid(5),deviceSequence:1,outcome:'ACKNOWLEDGED',reportedBaseVersion:0,reportedPatch:{mode:'active'},observedAt:time}}),
    get('list-firmware-releases','/api/v1/firmware-releases',page('FirmwareRelease'),{query:{tenantId:uid(1),limit:50}},{parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-firmware-release','/api/v1/firmware-releases','FirmwareRelease',O({tenantId:U,version:S,digest:H,sizeBytes:P}),{body:{tenantId:uid(1),version:'2.0.0',digest:'b'.repeat(64),sizeBytes:1024}}),
    get('list-upgrade-campaigns','/api/v1/upgrade-campaigns',page('UpgradeCampaign'),{query:{tenantId:uid(1),limit:50}},{parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-upgrade-campaign','/api/v1/upgrade-campaigns','UpgradeCampaign',O({tenantId:U,firmwareReleaseId:U,deviceIds:A(U,{minItems:1,uniqueItems:true})}),{body:{tenantId:uid(1),firmwareReleaseId:uid(6),deviceIds:[uid(2)]}}),
    ...['pause','resume','cancel'].map(action=>post(`${action}-upgrade-campaign`,`/api/v1/upgrade-campaigns/:upgradeCampaignId/${action}`,'UpgradeCampaign',O({}),{params:{upgradeCampaignId:uid(7)},body:{}})),
    get('list-deployment-waves','/api/v1/deployment-waves',page('DeploymentWave'),{query:{tenantId:uid(1),limit:50}},{source:manager,parameters:[...query({tenantId:U},['tenantId']),...pagination]}),
    post('create-deployment-wave','/api/v1/deployment-waves',O({deploymentWave:R('DeploymentWave'),waveDevices:A(R('WaveDevice'))}),O({tenantId:U,upgradeCampaignId:U,requestRef:S,waves:A(O({name:S,deviceIds:A(U,{minItems:1,uniqueItems:true}),minimumObservationSeconds:{...P,maximum:86400},maximumFailurePercent:{...N,maximum:100}}),{minItems:1})}),{body:{tenantId:uid(1),upgradeCampaignId:uid(7),requestRef:'public-waves',waves:[{name:'canary',deviceIds:[uid(2)],minimumObservationSeconds:30,maximumFailurePercent:10}]}},{source:manager}),
    get('read-deployment-wave','/api/v1/deployment-waves/:deploymentWaveId',O({deploymentWave:R('DeploymentWave'),waveDevices:A(R('WaveDevice'))}),{params:{deploymentWaveId:uid(8)}},{source:manager}),
    ...['pause','resume','cancel','rollback'].map(action=>post(`${action}-deployment-wave`,`/api/v1/deployment-waves/:deploymentWaveId/${action}`,'DeploymentWave',O({}),{params:{deploymentWaveId:uid(8)},body:{}},{source:manager}))
  ],smoke:[
    {operationId:'read-device-shadow',params:{deviceId:uid(2)},expectStatus:200,expectBody:shadow},
    {operationId:'patch-desired-shadow',params:{deviceId:uid(2)},body:{expectedVersion:0,patch:{mode:'active'}},headers:{'Idempotency-Key':'smoke-patch-shadow'},expectStatus:200,expectBody:{deviceId:uid(2),desiredVersion:1,desired:{mode:'active'},reportedVersion:0}},
    {operationId:'read-device-shadow',params:{deviceId:uid(2)},expectStatus:200,expectBody:{deviceId:uid(2),desiredVersion:1,desired:{mode:'active'},reportedVersion:0,reported:{mode:'idle'}}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','deviceShadows'],match:{deviceId:uid(2),desiredVersion:1,desired:{mode:'active'},reportedVersion:0}}]}
  ],notes:[
    'V2 wire clarification: new Devices start OFFLINE with null lastSeenAt and a persisted empty version-0 desired/reported Shadow. Desired PATCH takes {expectedVersion,patch}; both patches and stored documents are JSON objects. Enforce the published 64KiB UTF-8 result, depth, prototype-key and array limits in business validation.',
    'V2 wire clarification: connect takes tenantId and returns {device,connectionId}; disconnect takes tenantId/connectionId and returns Device. Poll returns {items:[DeviceCommand]} ordered by createdAt/commandId, capped by the smaller of request limit and DEVICE_POLL_LIMIT. A newer connection fences the prior connectionId. Invalid connections use DELIVERY_IDENTITY_CONFLICT.',
    'V2 wire clarification: receipt success is the exact CommandReceipt plus projectionStatus:APPLIED|STALE|TERMINAL; immutable snapshot receipt evidence retains the original public fields. Delivery identity and reported base version are accepted in the request and retained privately for canonical replay/fencing. Terminal receipts remain visible but do not alter shadow or command state.',
    'V2 wire clarification: DeploymentWave list returns paginated DeploymentWave summaries; creation/detail return {deploymentWave,waveDevices}. priorFirmwareReleaseId is null only when no registered release matches the captured prior digest, making rollback unavailable. Compensating UpgradeTargets add upgradeTargetId, referenced by rollbackTargetId; original compound-identity UpgradeTargets remain exact.',
    'Frozen Wave membership, target release and health gates govern future work for the existing Campaign from DeploymentWave creation; already issued V1 commands keep identity. Only matching firmware receipt confirms success. Native Manager resources remain outside the unchanged V1 seed; deterministic legacy migration preserves all identities and pending work.'
  ]});
