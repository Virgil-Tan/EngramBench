// Author-owned wire contract. Only public README/Manager requirements are used.
import { utcTimestampSchema } from '../../templates/contract-first/runtime.mjs';
import { readFileSync } from 'node:fs';
import { digest as canonicalDigest } from '../learning/helpers-b.mjs';
const text = { type: "string" };
const integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const uuid = { type: "string", format: "uuid", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const timestamp = utcTimestampSchema;
const enumeration = (...values) => ({ type: 'string', enum: values });
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const array = (items) => ({ type: "array", items });
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const metadata = { type: 'object', additionalProperties: true, description: 'Explicit free JSON business metadata; all recursive secret exclusions still apply.' };
const numericFields = new Set('revocationEpoch,currentTrustRevision,revision,assurance,generation,currentRevision,lowMax,reviewMax,maxLocationAgeSeconds,maxTravelKph,deviceSequence,lastSequence,requestedTtlSeconds,sessionGeneration,tenantRevocationEpoch,principalRevocationEpoch,score,epoch,sequence,attempt,sessionRevocationEpoch,deviceRevocationEpoch,regionQuarantineRevision'.split(','));
const nullableFields = new Set('currentPolicyRevisionId,locationWatermark,activatedAt,closedAt,releasedAt,leaseOwner,leaseToken,leaseExpiresAt,lastError,actorId'.split(','));
const fieldSchema = key => {
  const schema = numericFields.has(key) ? integer : key === 'terminal' ? { type: 'boolean' }
    : ['actions', 'resourcePatterns', 'riskFlags', 'reasons'].includes(key) ? { ...array(text), uniqueItems: true }
    : key === 'longitude' ? { type: 'number', minimum: -180, maximum: 180 }
    : key === 'latitude' ? { type: 'number', minimum: -90, maximum: 90 }
    : ['data', 'payload'].includes(key) ? metadata
    : key.endsWith('Digest') || key === 'digest' ? digest
    : key.endsWith('At') || ['validFrom', 'validUntil', 'notBefore', 'effectiveFrom', 'locationWatermark'].includes(key) ? timestamp
    : key.endsWith('Id') && !['actorId', 'subjectId', 'aggregateId'].includes(key) ? uuid : text;
  return nullableFields.has(key) ? nullable(schema) : schema;
};
const resource = (fields, overrides = {}) => object(Object.fromEntries(fields.split(",").map(key => [key, overrides[key] ?? fieldSchema(key)])));
const source = "docs/frontal-legacy/README.md";
const manager = "docs/frontal-legacy/manager-requirements.md";
const publicTenant = { tenantId: "10000000-0000-4000-8000-000000000041", name: "Public policy tenant", revocationEpoch: 0, createdAt: "2026-01-01T00:00:00Z" };
const publicPolicyRules = [{ ruleId: "public-basic-read", effect: "ALLOW", actions: ["read"], resourcePattern: "public/*", minAssurance: 1, regions: ["public"] }];
const schemas = {
  Error: object({ error: object({ code: text, message: text, details: metadata }) }),
  Tenant: resource("tenantId,name,revocationEpoch,createdAt", { tenantId: uuid, name: text, revocationEpoch: integer, createdAt: timestamp }),
  Principal: resource("principalId,tenantId,displayName,state,revocationEpoch,createdAt", { state: enumeration("ACTIVE", "SUSPENDED", "REVOKED") }),
  Device: resource("deviceId,tenantId,principalId,publicKeyFingerprint,state,currentTrustRevision,revocationEpoch,createdAt", { state: enumeration("ACTIVE", "REVOKED") }),
  DeviceTrustRevision: resource("deviceTrustRevisionId,deviceId,tenantId,revision,state,assurance,validFrom,validUntil,evidenceDigest,createdAt"),
  Session: resource("sessionId,tenantId,principalId,deviceId,deviceTrustRevisionId,familyId,generation,refreshTokenDigest,state,expiresAt,revocationEpoch,createdAt,updatedAt", { state: enumeration("ACTIVE", "REVOKED", "EXPIRED") }),
  PolicyBundle: resource("policyBundleId,tenantId,name,currentRevision,currentPolicyRevisionId,createdAt"),
  PolicyRule: object({ ruleId: text, effect: enumeration("ALLOW", "DENY"), actions: { ...array(text), uniqueItems: true }, resourcePattern: text, minAssurance: integer, regions: { ...array(text), uniqueItems: true } }),
  PolicyRevision: resource("policyRevisionId,policyBundleId,tenantId,revision,effectiveFrom,rules,digest,createdAt", { rules: { ...array(ref("PolicyRule")), minItems: 1, maxItems: 500 } }),
  RiskModelRevision: resource("riskModelRevisionId,tenantId,revision,effectiveFrom,lowMax,reviewMax,maxLocationAgeSeconds,maxTravelKph,digest,createdAt,weights", { weights: object({ oldSession: integer, staleLocation: integer, regionMismatch: integer, impossibleTravel: integer }) }),
  LocationObservation: resource("observationId,tenantId,deviceId,deviceSequence,observedAt,longitude,latitude,region,acceptedAt"),
  DeviceLocation: resource("deviceId,tenantId,lastSequence,watermarkObservedAt,longitude,latitude,region,riskFlags,revision,updatedAt"),
  AccessRequest: resource("accessRequestId,tenantId,principalId,deviceId,sessionId,action,resource,region,requestedTtlSeconds,justification,state,policyRevisionId,riskModelRevisionId,deviceTrustRevisionId,sessionGeneration,tenantRevocationEpoch,principalRevocationEpoch,locationWatermark,createdAt,updatedAt", { state: enumeration("PENDING_RISK", "DENIED", "PENDING_REVIEW", "APPROVED", "GRANTED", "REVOKED", "EXPIRED") }),
  RiskDecision: resource("riskDecisionId,accessRequestId,tenantId,score,level,reasons,policyEffect,inputDigest,decidedAt", { level: enumeration("LOW", "REVIEW", "HIGH") }),
  AccessReview: resource("accessReviewId,accessRequestId,tenantId,reviewerId,decision,comment,createdAt", { decision: enumeration("APPROVE", "REJECT") }),
  AccessGrant: resource("grantId,accessRequestId,tenantId,principalId,deviceId,sessionId,action,resource,region,policyRevisionId,riskDecisionId,state,notBefore,expiresAt,revocationEpoch,createdAt,updatedAt", { state: enumeration("ACTIVE", "REVOKED", "EXPIRED") }),
  Revocation: resource("revocationId,tenantId,subjectType,subjectId,epoch,reason,effectiveAt,createdAt", { subjectType: enumeration("TENANT", "PRINCIPAL", "DEVICE", "SESSION", "GRANT", "REGION") }),
  AuditEntry: resource("auditEntryId,tenantId,sequence,occurredAt,actorType,actorId,action,subjectType,subjectId,data,previousDigest,digest"),
  Work: resource("workId,tenantId,kind,aggregateId,state,attempt,availableAt,leaseOwner,leaseToken,leaseExpiresAt,lastError,terminal,createdAt,updatedAt", { state: enumeration("PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED") }),
  Event: resource("eventId,tenantId,aggregateType,aggregateId,sequence,type,occurredAt,payload"),
  BreakGlassSession: resource("breakGlassSessionId,tenantId,requesterId,sessionId,deviceId,deviceTrustRevisionId,sessionGeneration,sessionRevocationEpoch,principalRevocationEpoch,deviceRevocationEpoch,region,actions,resourcePatterns,reason,state,requiredApprovals,policyRevisionId,riskModelRevisionId,tenantRevocationEpoch,regionQuarantineRevision,notBefore,expiresAt,activatedAt,closedAt,createdAt,updatedAt", { state: enumeration("PENDING_APPROVAL", "READY", "ACTIVE", "CLOSED", "EXPIRED", "REJECTED"), requiredApprovals: { const: 2 } }),
  BreakGlassApproval: resource("breakGlassApprovalId,breakGlassSessionId,tenantId,approverId,decision,comment,createdAt", { decision: enumeration("APPROVE", "REJECT") }),
  RegionalQuarantine: resource("regionalQuarantineId,tenantId,region,revision,state,reason,createdBy,effectiveAt,releasedAt,createdAt,updatedAt", { state: enumeration("ACTIVE", "RELEASED") }),
  RetrospectiveReview: resource("retrospectiveReviewId,breakGlassSessionId,tenantId,reviewerId,outcome,findings,createdAt", { outcome: enumeration("JUSTIFIED", "POLICY_GAP", "MISUSE") }),
};
const resources = Object.fromEntries([
  ["tenants", "Tenant"], ["principals", "Principal"], ["devices", "Device"], ["deviceTrustRevisions", "DeviceTrustRevision"],
  ["sessions", "Session"], ["policyBundles", "PolicyBundle"], ["policyRevisions", "PolicyRevision"], ["riskModelRevisions", "RiskModelRevision"],
  ["locationObservations", "LocationObservation"], ["deviceLocations", "DeviceLocation"], ["accessRequests", "AccessRequest"],
  ["riskDecisions", "RiskDecision"], ["accessReviews", "AccessReview"], ["accessGrants", "AccessGrant"], ["revocations", "Revocation"], ["auditEntries", "AuditEntry"],
].map(([name, schema]) => [name, array(ref(schema))]));
const finalResources = { ...resources, breakGlassSessions: array(ref("BreakGlassSession")), breakGlassApprovals: array(ref("BreakGlassApproval")), regionalQuarantines: array(ref("RegionalQuarantine")), retrospectiveReviews: array(ref("RetrospectiveReview")) };
schemas.Snapshot = object({ schemaVersion: { const: 1 }, asOf: timestamp, resources: object(finalResources), work: array(ref("Work")), events: array(ref("Event")), metrics: object({ databaseBytes: { type: "integer", minimum: 0 } }) });
const operations = [];
const add = (id, method, path, request, response, origin = source) => operations.push({ id, method, path, ...(request && { request }), ...(response && { response }), status: 200, source: origin });
add("health", "GET", "/healthz", null, object({ status: { const: 'ok' } }));
add("openapi", "GET", "/openapi.json", null, { type: 'object', required: ['openapi', 'info', 'paths'], properties: { openapi: { type: 'string', pattern: '^3\\.1\\.' }, info: { type: 'object', additionalProperties: true }, paths: { type: 'object', additionalProperties: true } }, additionalProperties: true });
add("ui", "GET", "/", null, { type: 'string', minLength: 1, contentMediaType: 'text/html' });
add("listTenants", "GET", "/api/v1/tenants", null, object({ tenants: array(ref("Tenant")) }));
add("listPrincipals", "GET", "/api/v1/principals", null, object({ principals: array(ref("Principal")) }));
add("listDevices", "GET", "/api/v1/devices", null, object({ devices: array(ref("Device")) }));
add("getAccessRequest", "GET", "/api/v1/access-requests/:accessRequestId", null, object({ accessRequest: ref("AccessRequest") }));
const ttl = (min, max) => ({ type: "integer", minimum: min, maximum: max });
const sessionResponse = object({ session: ref("Session"), refreshToken: text });
add("createSession", "POST", "/api/v1/sessions", object({ tenantId: uuid, principalId: uuid, deviceId: uuid, deviceTrustRevisionId: uuid, requestedTtlSeconds: ttl(60, 3600) }), sessionResponse);
add("refreshSession", "POST", "/api/v1/sessions/:sessionId/refresh", object({ refreshToken: text, requestedTtlSeconds: ttl(60, 3600) }), sessionResponse);
add("revokeSession", "POST", "/api/v1/sessions/:sessionId/revoke", object({ expectedGeneration: integer, reason: text }), ref("Session"));
add("publishTrust", "POST", "/api/v1/devices/:deviceId/trust-revisions", object({ expectedRevision: integer, assurance: integer, validFrom: timestamp, validUntil: timestamp, evidenceDigest: digest }), ref("DeviceTrustRevision"));
for (const [type, id, schema] of [["devices", "deviceId", "Device"], ["principals", "principalId", "Principal"], ["tenants", "tenantId", "Tenant"]]) add(`revoke-${type}`, "POST", `/api/v1/${type}/:${id}/revoke`, object({ expectedEpoch: integer, reason: text }), ref(schema));
add("createPolicyBundle", "POST", "/api/v1/policy-bundles", object({ tenantId: uuid, name: text }), ref("PolicyBundle"));
add("publishPolicy", "POST", "/api/v1/policy-bundles/:policyBundleId/publish", object({ expectedRevision: integer, effectiveFrom: timestamp, rules: { ...array(ref("PolicyRule")), minItems: 1, maxItems: 500 } }), ref("PolicyRevision"));
add("rollbackPolicy", "POST", "/api/v1/policy-bundles/:policyBundleId/rollback", object({ expectedRevision: integer, targetRevision: integer, effectiveFrom: timestamp }), ref("PolicyRevision"));
add("observeLocation", "POST", "/api/v1/location-observations", object({ tenantId: uuid, deviceId: uuid, deviceSequence: integer, observedAt: timestamp, longitude: { type: "number", minimum: -180, maximum: 180 }, latitude: { type: "number", minimum: -90, maximum: 90 }, region: text }), ref("LocationObservation"));
const access = object({ tenantId: uuid, principalId: uuid, deviceId: uuid, sessionId: uuid, action: text, resource: text, region: text, requestedTtlSeconds: ttl(5, 900), justification: text });
add("createAccessRequest", "POST", "/api/v1/access-requests", access, ref("AccessRequest"));
add("batchAccessRequests", "POST", "/api/v1/access-requests:batch", object({ requests: { ...array(access), minItems: 1, maxItems: 100 } }), object({ accessRequests: array(ref('AccessRequest')) }));
add("reviewAccessRequest", "POST", "/api/v1/access-requests/:accessRequestId/reviews", object({ reviewerId: uuid, decision: enumeration("APPROVE", "REJECT"), comment: text }), ref("AccessReview"));
add("grantAccessRequest", "POST", "/api/v1/access-requests/:accessRequestId/grant", object({ expectedState: schemas.AccessRequest.properties.state }), ref("AccessGrant"));
add("checkGrant", "GET", "/api/v1/grants/:grantId/check", null, object({ grantId: uuid, active: { type: "boolean" }, reason: text, policyRevisionId: uuid, checkedAt: timestamp }));
add("revokeGrant", "POST", "/api/v1/grants/:grantId/revoke", object({ reason: text }), ref("AccessGrant"));
const scope = { ...array(text), minItems: 1, maxItems: 20, uniqueItems: true };
add("createBreakGlass", "POST", "/api/v1/break-glass-sessions", object({ tenantId: uuid, requesterId: uuid, sessionId: uuid, region: text, actions: scope, resourcePatterns: scope, reason: text, requestedTtlSeconds: ttl(60, 900) }), ref("BreakGlassSession"), manager);
add("approveBreakGlass", "POST", "/api/v1/break-glass-sessions/:breakGlassSessionId/approvals", object({ approverId: uuid, decision: enumeration("APPROVE", "REJECT"), comment: text }), ref("BreakGlassApproval"), manager);
add("activateBreakGlass", "POST", "/api/v1/break-glass-sessions/:breakGlassSessionId/activate", object({ expectedState: schemas.BreakGlassSession.properties.state }), ref("BreakGlassSession"), manager);
add("closeBreakGlass", "POST", "/api/v1/break-glass-sessions/:breakGlassSessionId/close", object({ reason: text }), ref("BreakGlassSession"), manager);
add("checkBreakGlass", "POST", "/api/v1/break-glass-sessions/:breakGlassSessionId/check", object({ action: text, resource: text, region: text }), object({ breakGlassSessionId: uuid, authorized: { type: "boolean" }, reason: text, policyRevisionId: uuid, riskModelRevisionId: uuid, checkedAt: timestamp }), manager);
add("quarantineRegion", "POST", "/api/v1/regions/:region/quarantine", object({ tenantId: uuid, expectedRevision: integer, reason: text, createdBy: uuid }), ref("RegionalQuarantine"), manager);
add("releaseRegion", "POST", "/api/v1/regions/:region/release", object({ tenantId: uuid, expectedRevision: integer, releasedBy: uuid }), ref("RegionalQuarantine"), manager);
add("reviewRetrospective", "POST", "/api/v1/break-glass-sessions/:breakGlassSessionId/retrospective-reviews", object({ reviewerId: uuid, outcome: enumeration("JUSTIFIED", "POLICY_GAP", "MISUSE"), findings: text }), ref("RetrospectiveReview"), manager);
add("snapshot", "GET", "/api/v1/verification-snapshot", null, ref("Snapshot"));
const id = n => `32000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-01-01T00:00:00Z', later = '2099-01-01T00:00:00Z';
const principal = { principalId: id(2), tenantId: publicTenant.tenantId, displayName: 'Public operator', state: 'ACTIVE', revocationEpoch: 0, createdAt: at };
const device = { deviceId: id(3), tenantId: publicTenant.tenantId, principalId: id(2), publicKeyFingerprint: 'a'.repeat(64), state: 'ACTIVE', currentTrustRevision: 1, revocationEpoch: 0, createdAt: at };
const trust = { deviceTrustRevisionId: id(4), tenantId: publicTenant.tenantId, deviceId: id(3), revision: 1, state: 'TRUSTED', assurance: 2, validFrom: at, validUntil: later, evidenceDigest: 'b'.repeat(64), createdAt: at };
// Public example configuration, not an additional scoring policy.
const riskFields = { riskModelRevisionId: id(8), tenantId: publicTenant.tenantId, revision: 1, effectiveFrom: at, lowMax: 20, reviewMax: 50, maxLocationAgeSeconds: 3600, maxTravelKph: 900, createdAt: at, weights: { oldSession: 10, staleLocation: 20, regionMismatch: 30, impossibleTravel: 40 } };
const publicRisk = { ...riskFields, digest: canonicalDigest(riskFields) };
const requestExample = { tenantId: publicTenant.tenantId, principalId: id(2), deviceId: id(3), sessionId: id(5), action: 'read', resource: 'public/report', region: 'public', requestedTtlSeconds: 300, justification: 'Public example request' };
const bodies = {
  createSession: { tenantId: publicTenant.tenantId, principalId: id(2), deviceId: id(3), deviceTrustRevisionId: id(4), requestedTtlSeconds: 600 },
  refreshSession: { refreshToken: 'public-example-response-token', requestedTtlSeconds: 600 },
  revokeSession: { expectedGeneration: 1, reason: 'Public session closed' },
  publishTrust: { expectedRevision: 1, assurance: 2, validFrom: at, validUntil: later, evidenceDigest: 'c'.repeat(64) },
  'revoke-devices': { expectedEpoch: 0, reason: 'Public revocation example' },
  'revoke-principals': { expectedEpoch: 0, reason: 'Public revocation example' },
  'revoke-tenants': { expectedEpoch: 0, reason: 'Public revocation example' },
  createPolicyBundle: { tenantId: publicTenant.tenantId, name: 'Public read policy' },
  publishPolicy: { expectedRevision: 0, effectiveFrom: at, rules: publicPolicyRules },
  rollbackPolicy: { expectedRevision: 2, targetRevision: 1, effectiveFrom: at },
  observeLocation: { tenantId: publicTenant.tenantId, deviceId: id(3), deviceSequence: 1, observedAt: at, longitude: 0, latitude: 0, region: 'public' },
  createAccessRequest: requestExample, batchAccessRequests: { requests: [requestExample] },
  reviewAccessRequest: { reviewerId: id(6), decision: 'APPROVE', comment: 'Public independent review' },
  grantAccessRequest: { expectedState: 'APPROVED' },
  revokeGrant: { reason: 'Public completed access' },
  createBreakGlass: { tenantId: publicTenant.tenantId, requesterId: id(2), sessionId: id(5), region: 'public', actions: ['read'], resourcePatterns: ['public/*'], reason: 'Public emergency example', requestedTtlSeconds: 300 },
  approveBreakGlass: { approverId: id(6), decision: 'APPROVE', comment: 'Public independent approval' },
  activateBreakGlass: { expectedState: 'READY' },
  closeBreakGlass: { reason: 'Public emergency closed' },
  checkBreakGlass: { action: 'read', resource: 'public/report', region: 'public' },
  quarantineRegion: { tenantId: publicTenant.tenantId, expectedRevision: 0, reason: 'Public quarantine', createdBy: id(6) },
  releaseRegion: { tenantId: publicTenant.tenantId, expectedRevision: 1, releasedBy: id(6) },
  reviewRetrospective: { reviewerId: id(7), outcome: 'JUSTIFIED', findings: 'Public retrospective review' },
};
for (const op of operations) {
  op.parameters = [...op.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: name === 'region' ? { type: 'string', minLength: 1 } : uuid }));
  if (op.method === 'POST' && op.id !== 'checkBreakGlass') op.parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1 } });
  if (op.id === 'snapshot') op.parameters.push({ name: 'Authorization', in: 'header', required: true, schema: { type: 'string', pattern: '^Bearer .+$' } });
  if (['listPrincipals', 'listDevices'].includes(op.id)) op.parameters.push({ name: 'tenantId', in: 'query', required: false, schema: uuid });
  const params = Object.fromEntries(op.parameters.filter(p => p.in === 'path').map(p => [p.name, p.name === 'region' ? 'public' : id(3)]));
  const headers = Object.fromEntries(op.parameters.filter(p => p.in === 'header').map(p => [p.name, p.name === 'Authorization' ? 'Bearer ${ADMIN_TOKEN}' : 'public-example-' + op.id]));
  op.example = { params, headers, ...(op.request ? { body: bodies[op.id] } : {}) };
}
export default {
  taskId: "accesssentinel", title: "AccessSentinel",
  policyRevision: 'accesssentinel-2026-09-08.1',
  environmentVariables: ["DATABASE_URL", "TEST_DATABASE_URL", "PORT", "ADMIN_TOKEN", "WEBHOOK_URL", "WORK_LEASE_SECONDS", "CHROMIUM_PATH", "MANAGED_DATA_ROOT", "TEST_BARRIER_URL", "TEST_BARRIER_TOKEN"],
  commands: ["build", "db:migrate", "db:seed", "start:api", "start:worker", "start:dispatcher", "test:unit", "test:integration", "test:e2e", "test:concurrency", "test:recovery", "test:perf", "test:all"].map(name => `npm run ${name}`),
  seed: {
    replay: true,
    schema: object({ schemaVersion: { const: 1 }, seedVersion: text, importedAt: timestamp, ...resources }),
    example: { schemaVersion: 1, seedVersion: "public-linked-trust-risk-v2", importedAt: at, ...Object.fromEntries(Object.keys(resources).map(key => [key, []])), tenants: [publicTenant], principals: [principal], devices: [device], deviceTrustRevisions: [trust], riskModelRevisions: [publicRisk] },
  },
  schemas, operations,
  smoke: [
    { operationId: "health", expectStatus: 200 },
    { operationId: "openapi", expectStatus: 200 },
    { operationId: "listTenants", expectStatus: 200, expectContains: [{ path: ['tenants'], match: publicTenant }], capture: { publicTenantId: ['tenants', '0', 'tenantId'] } },
    { operationId: "snapshot", headers: { Authorization: "Bearer ${ADMIN_TOKEN}" }, expectStatus: 200, expectContains: [
      { path: ['resources', 'devices'], match: device }, { path: ['resources', 'deviceTrustRevisions'], match: trust },
    ] },
    { operationId: "createPolicyBundle", body: { tenantId: "${publicTenantId}", name: "Public read policy" }, headers: { "Idempotency-Key": "public-policy-create-v2" }, expectStatus: 200, expectBody: { currentRevision: 0, currentPolicyRevisionId: null }, capture: { publicPolicyBundleId: ['policyBundleId'], publicExpectedRevision: ['currentRevision'] } },
    { operationId: "snapshot", headers: { Authorization: "Bearer ${ADMIN_TOKEN}" }, expectStatus: 200, expectContains: [{ path: ['resources', 'policyBundles'], match: { policyBundleId: "${publicPolicyBundleId}", currentRevision: "${publicExpectedRevision}" } }] },
    { operationId: "publishPolicy", params: { policyBundleId: "${publicPolicyBundleId}" }, body: { expectedRevision: "${publicExpectedRevision}", effectiveFrom: at, rules: publicPolicyRules }, headers: { "Idempotency-Key": "public-policy-publish-v2" }, expectStatus: 200, expectBody: { policyBundleId: "${publicPolicyBundleId}", revision: 1, rules: publicPolicyRules }, capture: { publicPolicyRevisionId: ['policyRevisionId'], publicPublishedRevision: ['revision'] } },
    { operationId: "snapshot", headers: { Authorization: "Bearer ${ADMIN_TOKEN}" }, expectStatus: 200, expectContains: [
      { path: ['resources', 'policyBundles'], match: { policyBundleId: "${publicPolicyBundleId}", currentRevision: "${publicPublishedRevision}", currentPolicyRevisionId: "${publicPolicyRevisionId}" } },
      { path: ['resources', 'policyRevisions'], match: { policyRevisionId: "${publicPolicyRevisionId}", policyBundleId: "${publicPolicyBundleId}", revision: "${publicPublishedRevision}", rules: publicPolicyRules } },
    ] },
    { operationId: "createSession", body: {}, headers: { "Idempotency-Key": "public-invalid-request" }, expectStatus: 400, expectBody: { error: { code: "INVALID_REQUEST" } } },
    { operationId: "createSession", body: bodies.createSession, headers: { "Idempotency-Key": "public-session-create-v2" }, expectStatus: 200,
      expectBody: { session: { tenantId: publicTenant.tenantId, principalId: principal.principalId, deviceId: device.deviceId, state: "ACTIVE" } },
      capture: { publicSessionId: ['session', 'sessionId'], publicSessionGeneration: ['session', 'generation'] } },
    { operationId: "createAccessRequest", body: { ...requestExample, sessionId: "${publicSessionId}" }, headers: { "Idempotency-Key": "public-access-request-v2" }, expectStatus: 200,
      expectBody: { sessionId: "${publicSessionId}", sessionGeneration: "${publicSessionGeneration}", policyRevisionId: "${publicPolicyRevisionId}", riskModelRevisionId: publicRisk.riskModelRevisionId, deviceTrustRevisionId: trust.deviceTrustRevisionId },
      capture: { publicAccessRequestId: ['accessRequestId'] } },
    { operationId: "snapshot", headers: { Authorization: "Bearer ${ADMIN_TOKEN}" }, expectStatus: 200, expectContains: [
      { path: ['resources', 'sessions'], match: { sessionId: "${publicSessionId}", generation: "${publicSessionGeneration}" } },
      { path: ['resources', 'accessRequests'], match: { accessRequestId: "${publicAccessRequestId}", sessionId: "${publicSessionId}", policyRevisionId: "${publicPolicyRevisionId}", riskModelRevisionId: publicRisk.riskModelRevisionId } },
    ] },
  ],
  notes: [
    readFileSync(new URL('./accesssentinel-events.md', import.meta.url), 'utf8'),
    'The original README and Manager message remain complete authority. V2 clarifies only missing wire representations; all business, security, concurrency, recovery, migration, UI and performance requirements remain mandatory.',
    'Seed uses schemaVersion:1, string seedVersion and UTC importedAt, keeps the original closed V1 collection whitelist, and provides a linked Tenant/Principal/Device/TRUSTED revision. Identical seed replay is allowed; conflicting content under the same version rejects atomically. No raw secret is in the public seed.',
    'Every resource is closed and every field has a declared type. Resource IDs are lowercase UUIDs; generic actorId/subjectId/aggregateId are strings because actors and region subjects need not be resource UUIDs. actorId may be null for a system actor. Integer epochs, revisions, generation, assurance, risk scores/weights and sequence counters are nonnegative safe integers. Coordinates are finite numbers in their original ranges.',
    'Digest fields are lowercase SHA-256 hex; fingerprints remain opaque public strings. Work terminal is boolean; leaseOwner/leaseToken/leaseExpiresAt and lastError are nullable. PolicyBundle currentPolicyRevisionId is null before publication. locationWatermark and not-yet-occurred lifecycle timestamps are null. reasons/riskFlags/actions/resourcePatterns are string arrays. Audit data and Event payload are explicit free JSON metadata with the original recursive secret exclusion.',
    'Health GET /healthz returns {status:"ok"}; / returns nonempty text/html; /openapi.json publishes OpenAPI 3.1 from this same contract. Snapshot requires Authorization: Bearer ADMIN_TOKEN. All mutation routes require Idempotency-Key except POST BreakGlass check, which is explicitly a side-effect-free authorization check.',
    'Batch acceptance returns 200 {accessRequests:AccessRequest[]} in input order; cardinality is exactly the number accepted and the entire input is committed or rejected atomically. It performs the same acceptance semantics and frozen authority capture as single creation.',
    'List tenant/principal/device returns the named collection envelope; principal/device lists optionally filter tenantId. Unpublished query keys reject. Path IDs are UUIDs, region is a nonempty string, and query/path values use the common validator. JSON values never undergo numeric coercion.',
    'Malformed JSON returns 400 MALFORMED_JSON; unknown fields/queries and invalid wire shapes return 400 INVALID_REQUEST; unsupported media returns 415 UNSUPPORTED_MEDIA_TYPE; missing snapshot authentication returns 401 UNAUTHORIZED. Original named business errors retain their original status and exact closed envelope.',
    'Final snapshot adds exactly the four lower-camel plural Manager collections. Policy publication and rollback return the new PolicyRevision, revocation returns the subject resource. New PolicyBundle starts currentRevision:0/currentPolicyRevisionId:null; first publication creates revision:1 and moves the pointer.',
    'The smoke reads linked identities and an immutable public example RiskModelRevision, creates/publishes a PolicyBundle, then creates a real Session and AccessRequest and verifies captured authority identities in persisted snapshot records. Risk thresholds/weights in this seed are example configuration, not new mandatory business policy. It does not certify risk worker completion, grants, full business behavior, browser, recovery or performance.',
  ],
};
