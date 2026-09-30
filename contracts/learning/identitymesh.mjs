import { readFileSync } from 'node:fs';
import {T,S,U,N,P,B,D,H,E,R,A,O,Q,M,J,uid,time,digest,admin,page,query,pagination,post,get,define,manager,wire} from './helpers-c.mjs';
const publicJwk={oneOf:[O({kty:{const:'OKP'},crv:{const:'Ed25519'},x:S,kid:S,alg:{const:'EdDSA'},use:{const:'sig'}}),O({kty:{const:'RSA'},n:S,e:S,kid:S,alg:{const:'RS256'},use:{const:'sig'}})]};
const schemas={
  User:O({userId:U,tenantId:U,username:S,displayName:S,state:E('ACTIVE','REVOKED'),createdAt:D}),
  LoginAttempt:O({loginAttemptId:U,tenantId:U,deviceId:U,providerRequestId:S,state:E('STARTED','SUCCEEDED','FAILED','UNKNOWN'),userId:Q(U),sessionId:Q(U),createdAt:D,resolvedAt:Q(D),sequence:N}),
  Session:O({sessionId:U,tenantId:U,userId:U,deviceId:U,tokenFamilyId:U,state:E('ACTIVE','ROTATING','REVOKED','EXPIRED'),refreshGeneration:N,requiredRevocationVersion:N,createdAt:D,expiresAt:D,revokedAt:Q(D),sequence:N}),
  Device:O({deviceId:U,tenantId:U,userId:U,publicKeyFingerprint:H,state:E('PENDING','TRUSTED','SUSPENDED','REVOKED'),trustRevision:N,createdAt:D,terminalAt:Q(D)}),
  DeviceChallenge:O({challengeId:U,deviceId:U,userId:U,nonceDigest:H,state:E('PENDING','USED','EXPIRED'),expiresAt:D,usedAt:Q(D)}),
  SigningKey:O({keyId:U,tenantId:U,publicJwk,publicKeyFingerprint:H,state:E('GENERATED','ACTIVE','RETIRING','RETIRED'),activatedAt:Q(D),retireAt:Q(D),retiredAt:Q(D),sequence:N}),
  Revocation:O({revocationId:U,tenantId:U,subjectType:E('SESSION','DEVICE','USER','TENANT'),subjectId:U,version:P,state:E('REQUESTED','PROPAGATING','PROPAGATED'),createdAt:D,propagatedAt:Q(D)}),
  AuditEntry:O({entryId:U,tenantId:U,sequence:P,eventType:S,actorRef:S,subjectRef:S,occurredAt:D,payloadDigest:H,priorDigest:Q(H),digest:H}),
  ProviderCallback:O({providerCallbackId:S,providerRequestId:S,outcome:E('SUCCEEDED','FAILED','UNKNOWN'),userId:Q(U),occurredAt:D}),
  ProviderLoginRequest:O({providerRequestId:{...S,maxLength:128,pattern:'^[!-~]+$'},tenantId:U,deviceId:U,username:S,password:S}),
  ProviderLoginOutcome:{oneOf:[O({providerRequestId:S,outcome:{const:'SUCCEEDED'},userId:U}),O({providerRequestId:S,outcome:E('FAILED','UNKNOWN'),userId:{type:'null'}})]},
  AuthTokens:O({accessToken:S,refreshToken:S,expiresAt:D}),
  LoginResult:O({loginAttempt:R('LoginAttempt'),session:Q(R('Session')),tokens:Q(R('AuthTokens'))}),
  RefreshResult:O({session:R('Session'),tokens:R('AuthTokens')}),
  ChallengeResult:O({challenge:R('DeviceChallenge'),nonce:S}),
  AuditVerification:O({valid:B,checkedEntries:N,checkpoints:A(R('AuditCheckpoint')),failures:A(O({tenantId:U,sequence:N,code:S}))}),
  CompromiseIncident:O({incidentId:U,tenantId:U,compromiseEpoch:P,approverIds:A(S,{minItems:2,maxItems:10,uniqueItems:true}),requiredApprovals:{...P,maximum:10},state:E('QUARANTINED','RECOVERY_READY','RECOVERING','RECOVERED'),newKeyId:Q(U),createdAt:D,recoveryReadyAt:Q(D),recoveredAt:Q(D),sequence:N}),
  RecoveryApproval:O({incidentId:U,approverId:S,compromiseEpoch:P,approvedAt:D})
};
const base={tenants:'Tenant',users:'User',devices:'Device',sessions:'Session',signingKeys:'SigningKey',revocations:'Revocation',auditEntries:'AuditEntry',auditCheckpoints:'AuditCheckpoint'};
const tenant={tenantId:uid(1),name:'Public Identity Tenant'};
const user={userId:uid(2),tenantId:uid(1),username:'public-user',displayName:'Public User',state:'ACTIVE',createdAt:time};
const device={deviceId:uid(3),tenantId:uid(1),userId:uid(2),publicKeyFingerprint:digest,state:'PENDING',trustRevision:0,createdAt:time,terminalAt:null};
const newUser={tenantId:uid(1),username:'created-public-user',displayName:'Created Through Public HTTP'};
const contract = define({taskId:'identitymesh',title:'IdentityMesh',schemas,resources:{...base,loginAttempts:'LoginAttempt',deviceChallenges:'DeviceChallenge',compromiseIncidents:'CompromiseIncident',recoveryApprovals:'RecoveryApproval'},seedResources:base,seedValues:{tenants:[tenant],users:[user],devices:[device]},environmentVariables:['PROVIDER_BASE_URL'],workKinds:['LOGIN_RECONCILIATION','REVOCATION_PROPAGATION','KEY_RETIREMENT','AUDIT_DELIVERY','TENANT_QUARANTINE','TENANT_RECOVERY'],eventTypes:['login.succeeded','login.failed','session.refreshed','session.revoked','device.trusted','device.revoked','key.rotated','revocation.propagated','tenant.quarantined','tenant.recovery_ready','tenant.recovered'],
  operations:[
    post('create-tenant','/api/v1/tenants','Tenant',O({name:S}),{body:{name:'Another Identity Tenant'}}),
    post('create-user','/api/v1/users','User',O({tenantId:U,username:S,displayName:S}),{body:newUser}),
    post('create-login-attempt','/api/v1/login-attempts','LoginResult',O({tenantId:U,deviceId:U,username:S,password:S}),{body:{tenantId:uid(1),deviceId:uid(3),username:'public-user',password:'public-local-provider-password'}}),
    post('provider-callback','/api/v1/provider/callbacks','LoginAttempt',R('ProviderCallback'),{body:{providerCallbackId:'public-callback',providerRequestId:'public-provider-request',outcome:'SUCCEEDED',userId:uid(2),occurredAt:time}}),
    post('reconcile-login-attempt','/api/v1/login-attempts/:attemptId/reconcile','LoginResult',O({}),{params:{attemptId:uid(4)},body:{}}),
    post('refresh-session','/api/v1/sessions/:sessionId/refresh','RefreshResult',O({refreshToken:S,expectedGeneration:N}),{params:{sessionId:uid(5)},body:{refreshToken:'public-example-issued-token',expectedGeneration:0}}),
    post('revoke-session','/api/v1/sessions/:sessionId/revoke','Session',O({reason:S}),{params:{sessionId:uid(5)},body:{reason:'Public sign out'}}),
    get('list-sessions','/api/v1/sessions',page('Session'),{query:{tenantId:uid(1),userId:uid(2),limit:50}},{parameters:[...query({tenantId:U,userId:U,state:schemas.Session.properties.state},['tenantId']),...pagination]}),
    post('register-device','/api/v1/devices/register','Device',O({tenantId:U,userId:U,publicKeyFingerprint:H}),{body:{tenantId:uid(1),userId:uid(2),publicKeyFingerprint:'b'.repeat(64)}}),
    post('create-device-challenge','/api/v1/devices/:deviceId/challenges','ChallengeResult',O({userId:U,expiresInSeconds:P}),{params:{deviceId:uid(3)},body:{userId:uid(2),expiresInSeconds:300}}),
    post('approve-device-challenge','/api/v1/device-challenges/:challengeId/approve','Device',O({tenantId:U,userId:U,publicKeyFingerprint:H,nonce:S,expectedTrustRevision:N}),{params:{challengeId:uid(6)},body:{tenantId:uid(1),userId:uid(2),publicKeyFingerprint:digest,nonce:'public-example-issued-nonce',expectedTrustRevision:0}}),
    post('revoke-device','/api/v1/devices/:deviceId/revoke','Device',O({reason:S}),{params:{deviceId:uid(3)},body:{reason:'Public device retired'}}),
    post('rotate-signing-key','/api/v1/signing-keys/rotate','SigningKey',O({tenantId:U,expectedActiveKeyId:Q(U),retiringForSeconds:N}),{body:{tenantId:uid(1),expectedActiveKeyId:null,retiringForSeconds:3600}}),
    get('read-jwks','/api/v1/signing-keys/jwks',O({keys:A(publicJwk)}),{query:{tenantId:uid(1)}},{parameters:query({tenantId:U},['tenantId'])}),
    post('create-revocation','/api/v1/revocations','Revocation',O({tenantId:U,subjectType:E('SESSION','DEVICE','USER','TENANT'),subjectId:U,reason:S}),{body:{tenantId:uid(1),subjectType:'DEVICE',subjectId:uid(3),reason:'Public revocation'}}),
    get('verify-audit','/api/v1/audit/verify','AuditVerification',{query:{tenantId:uid(1)}},{parameters:query({tenantId:U})}),
    get('list-audit','/api/v1/audit',page('AuditEntry'),{query:{limit:50}},{parameters:pagination}),
    post('create-compromise-incident','/api/v1/compromise-incidents','CompromiseIncident',O({tenantId:U,approverIds:A(S,{minItems:2,maxItems:10,uniqueItems:true}),requiredApprovals:{...P,maximum:10}}),{body:{tenantId:uid(1),approverIds:['public-approver-a','public-approver-b'],requiredApprovals:2}},{source:wire,status:201}),
    get('read-compromise-incident','/api/v1/compromise-incidents/:incidentId',O({incident:R('CompromiseIncident'),approvals:A(R('RecoveryApproval'))}),{params:{incidentId:uid(7)}},{source:wire}),
    post('approve-recovery','/api/v1/compromise-incidents/:incidentId/approvals',O({incident:R('CompromiseIncident'),approval:R('RecoveryApproval')}),O({approverId:S,expectedCompromiseEpoch:P}),{params:{incidentId:uid(7)},body:{approverId:'public-approver-a',expectedCompromiseEpoch:1}},{source:wire}),
    post('recover-tenant','/api/v1/compromise-incidents/:incidentId/recover','CompromiseIncident',O({expectedCompromiseEpoch:P,newKeyId:U}),{params:{incidentId:uid(7)},body:{expectedCompromiseEpoch:1,newKeyId:uid(8)}},{source:wire})
  ],smoke:[
    {operationId:'create-user',body:newUser,headers:{'Idempotency-Key':'smoke-create-user'},expectStatus:200,expectBody:newUser,capture:{newUserId:['userId']}},
    {operationId:'verification-snapshot',headers:admin,expectStatus:200,expectContains:[{path:['resources','users'],match:{userId:'${newUserId}',...newUser,state:'ACTIVE'}}]},
    {operationId:'list-sessions',query:{tenantId:uid(1),userId:'${newUserId}'},expectStatus:200,expectBody:{items:[],nextCursor:null}}
  ],notes:[
    'V2 wire clarification: User and all formerly unspecified authentication request/response shapes are explicit here. AuthTokens and challenge nonce appear only in successful direct authentication/challenge responses and durable protected replay storage; public Session, snapshot, audit and events never expose them. LoginResult has null session/tokens until SUCCEEDED. Reconcile returns the same session/token issuance identity. Credentials are never persisted or returned.',
    'V2 wire clarification: public JWK supports Ed25519/EdDSA or RSA/RS256 and contains only public fields. Challenge lifetime is a caller-specified positive expiresInSeconds; access-token expiresAt is server-issued and never exceeds Session.expiresAt. Signing-key retiringForSeconds is the verification grace and cannot permit a token beyond its own expiry. Refresh expectedGeneration fences the stored token generation.',
    'The Manager publishes quarantine behavior but no routes or resource fields. V2 explicitly introduces /compromise-incidents create/read, /approvals and /recover with the closed shapes here. Incidents freeze approver identities and quorum; requiredApprovals must not exceed approver count. Each tenant compromiseEpoch increments atomically; approvals are unique by incident and approver and must match the frozen epoch. TENANT_QUARANTINE/TENANT_RECOVERY aggregateId is incidentId.',
    'V2 wire clarification: Manager states are QUARANTINED, RECOVERY_READY, RECOVERING and RECOVERED; the sole threshold transition emits tenant.recovery_ready, creation emits tenant.quarantined and completed recovery emits tenant.recovered. This names the Manager transition events explicitly. Recovery requires completed revocation propagation and an ACTIVE key generated after quarantine; it never restores old sessions, families, challenges or keys.',
    'V2 wire clarification: quarantine errors are 409 COMPROMISE_EPOCH_CHANGED, RECOVERY_NOT_READY, INCIDENT_TERMINAL, APPROVER_NOT_ALLOWED, RECOVERY_ALREADY_APPROVED; invalid quorum is 400 INVALID_AUTH_REQUEST. Public IDs missing from any route return 404 NOT_FOUND. Identity-provider integration is restricted to the local double and must reconcile one stable providerRequestId.'
  ]});
contract.policyRevision = 'identitymesh-provider-2026-09-08.1';
contract.providerProtocol = {
  policyRevision: contract.policyRevision,
  baseUrlEnvironment: 'PROVIDER_BASE_URL',
  helper: 'identitymesh-provider.mjs',
  login: { method: 'POST', path: '/v1/login', request: R('ProviderLoginRequest'), response: R('ProviderLoginOutcome'), idempotencyHeader: 'Idempotency-Key' },
  query: { method: 'GET', path: '/v1/login-requests/:providerRequestId', response: R('ProviderLoginOutcome') },
  accounts: [{ tenantId: tenant.tenantId, userId: user.userId, username: user.username, password: 'public-local-provider-password' }],
};
contract.notes.push(readFileSync(new URL('./identitymesh-provider-protocol.md', import.meta.url), 'utf8'));
contract.smoke.push(
  { operationId: 'create-device-challenge', params: { deviceId: device.deviceId }, body: { userId: user.userId, expiresInSeconds: 300 },
    headers: { 'Idempotency-Key': 'public-provider-device-challenge' }, expectStatus: 200,
    capture: { providerChallengeId: ['challenge', 'challengeId'], providerChallengeNonce: ['nonce'] } },
  { operationId: 'approve-device-challenge', params: { challengeId: '${providerChallengeId}' },
    body: { tenantId: tenant.tenantId, userId: user.userId, publicKeyFingerprint: device.publicKeyFingerprint, nonce: '${providerChallengeNonce}', expectedTrustRevision: 0 },
    headers: { 'Idempotency-Key': 'public-provider-device-approve' }, expectStatus: 200,
    expectBody: { deviceId: device.deviceId, userId: user.userId, state: 'TRUSTED' } },
  { operationId: 'rotate-signing-key', body: { tenantId: tenant.tenantId, expectedActiveKeyId: null, retiringForSeconds: 3600 },
    headers: { 'Idempotency-Key': 'public-provider-signing-key' }, expectStatus: 200, expectBody: { tenantId: tenant.tenantId, state: 'ACTIVE' } },
  { operationId: 'create-login-attempt', body: { tenantId: tenant.tenantId, deviceId: device.deviceId, username: user.username, password: contract.providerProtocol.accounts[0].password },
    headers: { 'Idempotency-Key': 'public-provider-login' }, expectStatus: 200,
    expectBody: { loginAttempt: { tenantId: tenant.tenantId, deviceId: device.deviceId, userId: user.userId, state: 'SUCCEEDED' }, session: { tenantId: tenant.tenantId, userId: user.userId, deviceId: device.deviceId, state: 'ACTIVE' } },
    capture: { providerLoginAttempt: ['loginAttempt'], providerLoginAttemptId: ['loginAttempt', 'loginAttemptId'], providerSession: ['session'], providerSessionId: ['session', 'sessionId'], providerTokens: ['tokens'] } },
  { operationId: 'verification-snapshot', headers: admin, expectStatus: 200,
    expectContains: [
      { path: ['resources', 'loginAttempts'], match: { loginAttemptId: '${providerLoginAttemptId}', sessionId: '${providerSessionId}', state: 'SUCCEEDED', userId: user.userId } },
      { path: ['resources', 'sessions'], match: { sessionId: '${providerSessionId}', userId: user.userId, deviceId: device.deviceId, state: 'ACTIVE' } },
    ] },
  { operationId: 'create-login-attempt', body: { tenantId: tenant.tenantId, deviceId: device.deviceId, username: user.username, password: contract.providerProtocol.accounts[0].password },
    headers: { 'Idempotency-Key': 'public-provider-login' }, expectStatus: 200,
    expectBody: { loginAttempt: '${providerLoginAttempt}', session: '${providerSession}', tokens: '${providerTokens}' } },
  { operationId: 'reconcile-login-attempt', params: { attemptId: '${providerLoginAttemptId}' }, body: {},
    headers: { 'Idempotency-Key': 'public-provider-reconcile' }, expectStatus: 200,
    expectBody: { loginAttempt: '${providerLoginAttempt}', session: '${providerSession}', tokens: '${providerTokens}' } },
);
export default contract;
