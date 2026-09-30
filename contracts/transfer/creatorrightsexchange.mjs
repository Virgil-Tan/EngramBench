// Public contract only: the original README and Manager requirements are the authority.
import { utcTimestampSchema } from '../../templates/contract-first/runtime.mjs';
import { ROYALTY_DIGEST_REVISION, royaltyDigestPolicy, royaltyDigestNotes } from './creator-royalty-digest-policy.mjs';
const readme = 'docs/frontal-legacy/README.md';
const manager = 'docs/frontal-legacy/manager-requirements.md';
const clarification = 'contract/README.md (V2 public wire clarification)';
const string = { type: 'string' };
const integer = { type: 'integer' };
const boolean = { type: 'boolean' };
const uuid = { type: 'string', format: 'uuid', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const timestamp = utcTimestampSchema;
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const currency = { type: 'string', pattern: '^[A-Z]{3}$' };
const opaqueObject = { type: 'object', additionalProperties: true, description: 'Explicit free JSON business payload; original redaction and canonicalization rules remain mandatory.' };
const ref = name => ({ $ref: `#/$defs/${name}` });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const enumeration = (...values) => ({ type: 'string', enum: values });
const array = (items, limits = {}) => ({ type: 'array', items, ...limits });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const list = name => object({ items: array(ref(name)), nextCursor: nullable(string) });
const positiveMoney = { type: 'integer', minimum: 1 };
const nonzeroMoney = { type: 'integer', not: { const: 0 } };
const totalBytes = { type: 'integer', minimum: 1, maximum: 2 * 1024 ** 3 };
const chunkSize = { type: 'integer', minimum: 64 * 1024, maximum: 8 * 1024 ** 2 };
const territories = array({ type: 'string', pattern: '^[A-Z]{2}$' }, { uniqueItems: true });
const evidenceRefs = array(string, { minItems: 1, maxItems: 20, uniqueItems: true });
const leaseFields = { leaseOwner: nullable(string), leaseToken: nullable(string), leaseExpiresAt: nullable(timestamp) };

const schemas = {
  Tenant: object({ tenantId: uuid, name: string }),
  Creator: object({ creatorId: uuid, tenantId: uuid, displayName: string, payoutCurrency: currency }),
  Work: object({ workId: uuid, tenantId: uuid, externalRef: string, title: string, currentRightsRevision: integer }),
  RightsSplit: object({ workId: uuid, revision: integer, creatorId: uuid, basisPoints: integer, effectiveFrom: timestamp }),
  UploadSession: object({
    uploadId: uuid, tenantId: uuid, workId: uuid, fileName: string, mediaType: string, totalBytes, chunkSize,
    contentSha256: digest, requiredProfileIds: array(uuid, { uniqueItems: true }),
    state: enumeration('OPEN', 'COMPLETED', 'ABORTED', 'EXPIRED'), createdAt: timestamp, expiresAt: timestamp,
    completedAt: nullable(timestamp),
  }),
  UploadChunk: object({ uploadId: uuid, chunkNumber: { type: 'integer', minimum: 1 }, startByte: integer, endByte: integer, sizeBytes: integer, sha256: digest, createdAt: timestamp }),
  BlobObject: object({ blobId: uuid, tenantId: uuid, sha256: digest, sizeBytes: integer, state: enumeration('QUARANTINED', 'PROCESSING', 'READY', 'REJECTED'), createdAt: timestamp }),
  ScanJob: object({ scanJobId: uuid, assetId: uuid, state: enumeration('PENDING', 'RUNNING', 'CLEAN', 'INFECTED', 'FAILED'), attempt: integer, ...leaseFields }),
  ScanResult: object({ scanResultId: uuid, scanJobId: uuid, assetId: uuid, verdict: enumeration('CLEAN', 'INFECTED'), engineVersion: string, contentSha256: digest, createdAt: timestamp }),
  TranscodeProfile: object({ profileId: uuid, tenantId: uuid, revision: integer, name: string, operation: enumeration('COPY', 'PREFIX_BASE64'), prefixBase64: nullable(string), active: boolean }),
  TranscodeJob: object({ transcodeJobId: uuid, assetId: uuid, profileId: uuid, profileRevision: integer, state: enumeration('PENDING', 'RUNNING', 'READY', 'FAILED'), attempt: integer, ...leaseFields }),
  Rendition: object({ renditionId: uuid, assetId: uuid, profileId: uuid, profileRevision: integer, sha256: digest, sizeBytes: integer, state: enumeration('READY'), createdAt: timestamp }),
  Edition: object({ editionId: uuid, tenantId: uuid, workId: uuid, title: string, revision: integer, state: enumeration('DRAFT', 'PUBLISHED'), rightsRevision: nullable(integer), manifestDigest: nullable(digest), publishedAt: nullable(timestamp), createdAt: timestamp }),
  EditionAsset: object({ editionId: uuid, ordinal: integer, assetId: uuid, renditionId: uuid, assetSha256: digest, renditionSha256: digest }),
  LicenseOffer: object({ offerId: uuid, tenantId: uuid, editionId: uuid, state: enumeration('ACTIVE', 'RETIRED'), licenseType: enumeration('STREAM', 'DOWNLOAD'), territories, priceMinor: positiveMoney, currency, termsVersion: integer, createdAt: timestamp }),
  PurchaseOrder: object({
    purchaseOrderId: uuid, tenantId: uuid, buyerRef: string, offerId: uuid, editionId: uuid,
    priceMinor: positiveMoney, currency, termsVersion: integer, rightsRevision: integer,
    state: enumeration('RISK_PENDING', 'REVIEW', 'PAYMENT_PENDING', 'LICENSED', 'BLOCKED', 'FAILED', 'LICENSE_HELD'),
    providerRequestId: string, sequence: integer, createdAt: timestamp, terminalAt: nullable(timestamp),
  }),
  FraudAssessment: object({ assessmentId: uuid, purchaseOrderId: uuid, rulesVersion: integer, score: nullable(integer), recommendation: nullable(enumeration('APPROVE', 'REVIEW', 'BLOCK')), state: enumeration('PENDING', 'COMPLETED'), createdAt: timestamp, completedAt: nullable(timestamp) }),
  ReviewCase: object({ reviewCaseId: uuid, purchaseOrderId: uuid, state: enumeration('OPEN', 'CLAIMED', 'DECIDED'), reviewerId: nullable(string), leaseToken: nullable(string), leaseExpiresAt: nullable(timestamp), outcome: nullable(enumeration('APPROVE', 'BLOCK')), reasonCode: nullable(string), revision: integer }),
  PaymentIntent: object({ paymentIntentId: uuid, purchaseOrderId: uuid, providerRequestId: string, amountMinor: integer, currency, state: enumeration('PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED'), sequence: integer, createdAt: timestamp, resolvedAt: nullable(timestamp) }),
  License: object({ licenseId: uuid, tenantId: uuid, purchaseOrderId: uuid, editionId: uuid, buyerRef: string, licenseType: enumeration('STREAM', 'DOWNLOAD'), territories, rightsRevision: integer, state: enumeration('ACTIVE', 'REVOKED', 'HELD'), grantedAt: timestamp, revokedAt: nullable(timestamp) }),
  EntitlementGrant: object({ grantId: uuid, tenantId: uuid, licenseId: uuid, buyerRef: string, editionId: uuid, state: enumeration('ACTIVE', 'REVOKED'), revision: integer, grantedAt: timestamp, revokedAt: nullable(timestamp) }),
  Refund: object({ refundId: uuid, licenseId: uuid, providerRequestId: string, amountMinor: positiveMoney, currency, state: enumeration('PENDING', 'UNKNOWN', 'SUCCEEDED', 'FAILED'), createdAt: timestamp, resolvedAt: nullable(timestamp) }),
  RoyaltyAccount: object({ royaltyAccountId: uuid, tenantId: uuid, ownerType: enumeration('PLATFORM', 'CREATOR'), ownerId: string, currency }),
  RoyaltyEntry: object({
    royaltyEntryId: uuid, postingId: uuid, tenantId: uuid, royaltyPeriodId: uuid, royaltyAccountId: uuid,
    ownerId: string, accountRole: enumeration('PLATFORM_CLEARING', 'CREATOR_PAYABLE', 'REFUND_CLEARING'),
    direction: enumeration('DEBIT', 'CREDIT'), amountMinor: integer, currency,
    sourceType: enumeration('LICENSE', 'REFUND', 'ADJUSTMENT'), sourceId: uuid, createdAt: timestamp,
  }),
  RoyaltyPeriod: object({ royaltyPeriodId: uuid, tenantId: uuid, currency, periodStart: timestamp, periodEnd: timestamp, state: enumeration('OPEN', 'CLOSING', 'CLOSED'), closedAt: nullable(timestamp), snapshotDigest: nullable(digest) }),
  Notification: object({ notificationId: uuid, tenantId: uuid, aggregateType: string, aggregateId: uuid, sequence: integer, templateKey: string, payload: opaqueObject, state: enumeration('PENDING', 'DELIVERED'), createdAt: timestamp }),
  Delivery: object({ deliveryId: uuid, notificationId: uuid, eventId: uuid, attempt: integer, state: enumeration('PENDING', 'UNKNOWN', 'DELIVERED'), nextAttemptAt: nullable(timestamp), providerReceiptId: nullable(string) }),
  RightsDispute: object({ rightsDisputeId: uuid, tenantId: uuid, editionId: uuid, claimantCreatorId: uuid, licenseId: nullable(uuid), reason: string, evidenceRefs, state: enumeration('OPEN', 'UPHELD', 'REJECTED'), revision: integer, createdAt: timestamp, resolvedAt: nullable(timestamp), resolutionReason: nullable(string) }),
  LicenseHold: object({ licenseHoldId: uuid, tenantId: uuid, rightsDisputeId: uuid, scope: enumeration('EDITION', 'LICENSE'), editionId: uuid, licenseId: nullable(uuid), state: enumeration('ACTIVE', 'RELEASED'), revision: integer, reason: string, createdAt: timestamp, releasedAt: nullable(timestamp) }),
  RoyaltyAdjustment: object({ royaltyAdjustmentId: uuid, tenantId: uuid, rightsDisputeId: nullable(uuid), originalPostingId: uuid, targetRoyaltyPeriodId: uuid, amountMinor: nonzeroMoney, currency, reason: string, adjustmentPostingId: uuid, createdAt: timestamp }),
  DurableWork: object({ workId: uuid, kind: string, aggregateId: uuid, state: string, attempt: integer, ...leaseFields, terminal: boolean }),
  Event: object({ eventId: uuid, aggregateType: string, aggregateId: uuid, sequence: integer, type: string, payload: opaqueObject, createdAt: timestamp }),
  Error: { oneOf: [ref('DomainError'), ref('MalformedJsonError')] },
  DomainError: object({ error: object({ code: string, message: string, details: opaqueObject }, ['code', 'message']) }),
  MalformedJsonError: object({ error: object({ code: { const: 'MALFORMED_JSON' } }) }),
  LedgerTotals: object({ currency, debitMinor: { type: 'integer', minimum: 0 }, creditMinor: { type: 'integer', minimum: 0 }, balanceMinor: integer }),
  AccountTotals: object({ royaltyAccountId: uuid, ownerId: string, currency, debitMinor: { type: 'integer', minimum: 0 }, creditMinor: { type: 'integer', minimum: 0 }, balanceMinor: integer }),
};

const resourceTypes = {
  tenants: 'Tenant', creators: 'Creator', works: 'Work', rightsSplits: 'RightsSplit',
  uploadSessions: 'UploadSession', uploadChunks: 'UploadChunk', blobObjects: 'BlobObject',
  scanJobs: 'ScanJob', scanResults: 'ScanResult', transcodeProfiles: 'TranscodeProfile',
  transcodeJobs: 'TranscodeJob', renditions: 'Rendition', editions: 'Edition', editionAssets: 'EditionAsset',
  licenseOffers: 'LicenseOffer', purchaseOrders: 'PurchaseOrder', paymentIntents: 'PaymentIntent',
  fraudAssessments: 'FraudAssessment', reviewCases: 'ReviewCase', licenses: 'License',
  entitlementGrants: 'EntitlementGrant', refunds: 'Refund', royaltyAccounts: 'RoyaltyAccount',
  royaltyEntries: 'RoyaltyEntry', royaltyPeriods: 'RoyaltyPeriod', notifications: 'Notification', deliveries: 'Delivery',
};
const resourceArrays = Object.fromEntries(Object.entries(resourceTypes).map(([key, name]) => [key, array(ref(name))]));
const snapshotResourceArrays = {
  ...resourceArrays,
  rightsDisputes: array(ref('RightsDispute')),
  licenseHolds: array(ref('LicenseHold')),
  royaltyAdjustments: array(ref('RoyaltyAdjustment')),
};
schemas.VerificationSnapshot = object({
  schemaVersion: { const: 1 }, asOf: timestamp,
  resources: { ...object(snapshotResourceArrays), additionalProperties: array(opaqueObject) },
  work: array(ref('DurableWork')), events: array(ref('Event')),
});
schemas.SeedBlobObject = object({ ...schemas.BlobObject.properties, contentBase64: { type: 'string', contentEncoding: 'base64' } });
schemas.SeedRendition = object({ ...schemas.Rendition.properties, contentBase64: { type: 'string', contentEncoding: 'base64' } });
const seedSchema = object({
  schemaVersion: integer, seedVersion: string, importedAt: timestamp,
  ...resourceArrays, blobObjects: array(ref('SeedBlobObject')), renditions: array(ref('SeedRendition')),
  work: array(ref('DurableWork')), events: array(ref('Event')),
}, ['schemaVersion', 'seedVersion', ...Object.keys(resourceTypes)]);
const emptyResources = Object.fromEntries(Object.keys(resourceTypes).map(key => [key, []]));
const source = section => `${readme} §${section}`;
const operation = (id, method, path, section, options = {}) => ({ id, method, path, status: 200, source: source(section), ...options });
const managerOperation = (id, method, path, options) => operation(id, method, path, '', { ...options, source: manager });

// Author examples come from the published domain, independently of private fixtures.
const T = '2026-01-01T00:00:00Z';
const publicId = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = publicId(1), creatorId = publicId(2), workId = publicId(3), profileId = publicId(4);
const publicTenant = { tenantId, name: 'Public Media Cooperative' };
const publicCreator = { creatorId, tenantId, displayName: 'Public Author', payoutCurrency: 'USD' };
const publicWork = { workId, tenantId, externalRef: 'public-catalog-work', title: 'Public Catalog Work', currentRightsRevision: 1 };
const publicSplit = { workId, revision: 1, creatorId, basisPoints: 10000, effectiveFrom: T };
const publicProfile = { profileId, tenantId, revision: 1, name: 'Original Copy', operation: 'COPY', prefixBase64: null, active: true };
const publicPreviewProfile = { profileId: publicId(30), tenantId, revision: 2, name: 'Public Preview', operation: 'PREFIX_BASE64', prefixBase64: 'UFJFVklFVwo=', active: true };
const keyed = name => ({ 'Idempotency-Key': `public-${name}` });
const admin = { Authorization: 'Bearer ${ADMIN_TOKEN}' };
const exampleBodies = {
  createTenant: { name: 'New Public Tenant' },
  createCreator: { tenantId, displayName: 'New Public Creator', payoutCurrency: 'USD' },
  createWork: { tenantId, externalRef: 'new-public-work', title: 'New Public Work' },
  setRightsSplits: { expectedRevision: 1, effectiveFrom: T, splits: [{ creatorId, basisPoints: 10000 }] },
  createTranscodeProfile: { tenantId, name: 'Original Copy', operation: 'COPY', prefixBase64: null },
  createUpload: { tenantId, workId, fileName: 'public.txt', mediaType: 'text/plain', totalBytes: 1, chunkSize: 65536, contentSha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', requiredProfileIds: [profileId] },
  putUploadChunk: 'a',
  completeUpload: { contentSha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', chunks: [{ chunkNumber: 1, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' }] },
  recordScanResult: { scanResultId: publicId(12), scanJobId: publicId(11), verdict: 'CLEAN', engineVersion: 'creator-rights-scanner-v1', contentSha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb' },
  createEdition: { tenantId, workId, title: 'Public Edition', assets: [{ assetId: publicId(10), renditionId: publicId(13), ordinal: 1 }] },
  publishEdition: { expectedRevision: 0 },
  createLicenseOffer: { tenantId, editionId: publicId(14), licenseType: 'DOWNLOAD', territories: ['US'], priceMinor: 250, currency: 'USD', termsVersion: 1 },
  createPurchase: { tenantId, buyerRef: 'public-buyer', offerId: publicId(15), providerRequestId: 'public-payment-request', riskContext: { velocity: 1, country: 'US', deviceTrust: 'KNOWN' } },
  claimReviewCase: { reviewerId: 'public-reviewer', leaseSeconds: 30 },
  decideReviewCase: { reviewerId: 'public-reviewer', leaseToken: 'public-example-lease', outcome: 'APPROVE', reasonCode: 'REVIEW_COMPLETE' },
  recordProviderEvent: { providerEventId: 'public-payment-event', providerRequestId: 'public-payment-request', kind: 'PAYMENT', outcome: 'SUCCEEDED', occurredAt: T },
  createRefund: { amountMinor: 100, reason: 'Customer request', providerRequestId: 'public-refund-request' },
  closeRoyaltyPeriod: { tenantId, currency: 'USD', periodStart: T, periodEnd: '2026-02-01T00:00:00Z' },
  recordProviderReceipt: { deliveryId: publicId(20), providerReceiptId: 'public-receipt' },
  createRightsDispute: { tenantId, editionId: publicId(14), claimantCreatorId: creatorId, reason: 'Attribution review', evidenceRefs: ['public:attribution'], expectedEditionRevision: 1 },
  resolveRightsDispute: { expectedRevision: 1, outcome: 'REJECTED', reason: 'Attribution verified' },
  createLicenseHold: { rightsDisputeId: publicId(21), scope: 'EDITION', reason: 'Attribution review' },
  releaseLicenseHold: { expectedRevision: 1, reason: 'Review complete' },
  createRoyaltyAdjustment: { tenantId, originalPostingId: publicId(22), amountMinor: 100, currency: 'USD', reason: 'Settlement correction', targetPeriodStart: '2026-02-01T00:00:00Z' },
};
const parameter = (name, schema, where = 'query', required = true) => ({ name, in: where, required, schema });
const queryParameters = {
  checkEntitlement: [parameter('tenantId', uuid), parameter('buyerRef', string), parameter('editionId', uuid)],
  getRoyaltyLedger: [parameter('tenantId', uuid), parameter('ownerId', string), parameter('cursor', string, 'query', false)],
  listAssetRenditions: [parameter('cursor', string, 'query', false)],
};
const queryExamples = {
  checkEntitlement: { tenantId, buyerRef: 'public-buyer', editionId: publicId(14) },
  getRoyaltyLedger: { tenantId, ownerId: creatorId },
};
function publishOperation(op) {
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(op.method);
  const pathParameters = [...op.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, name]) => parameter(name, name === 'chunkNumber' ? { type: 'integer', minimum: 1 } : uuid, 'path'));
  const params = Object.fromEntries(pathParameters.map(p => [p.name, p.name === 'chunkNumber' ? 1 : ({ workId, profileId }[p.name] ?? publicId(10))]));
  const headers = { ...(mutation ? keyed(op.id) : {}), ...(op.id === 'verificationSnapshot' ? admin : {}) };
  const parameters = [...pathParameters, ...(queryParameters[op.id] ?? []), ...(mutation ? [parameter('Idempotency-Key', { type: 'string', minLength: 1 }, 'header')] : []), ...(op.id === 'verificationSnapshot' ? [parameter('Authorization', { type: 'string', pattern: '^Bearer .+$' }, 'header')] : [])];
  if (op.id === 'putUploadChunk') {
    parameters.push(parameter('Content-Range', { type: 'string', pattern: '^bytes [0-9]+-[0-9]+/[0-9]+$' }, 'header'), parameter('X-Chunk-Sha256', digest, 'header'));
    Object.assign(headers, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-0/1', 'X-Chunk-Sha256': exampleBodies.createUpload.contentSha256 });
  }
  return { ...op, parameters, ...(!mutation ? { requestBody: 'none' } : {}), example: { ...(pathParameters.length ? { params } : {}), ...(queryExamples[op.id] ? { query: queryExamples[op.id] } : {}), headers, ...(op.request ? { body: exampleBodies[op.id] ?? {} } : {}) } };
}

export default {
  taskId: 'creatorrightsexchange',
  policyRevision: ROYALTY_DIGEST_REVISION,
  royaltyDigest: royaltyDigestPolicy,
  httpHost: '127.0.0.1',
  transportErrors: { invalidJson: { status: 400, code: 'MALFORMED_JSON', body: { error: { code: 'MALFORMED_JSON' } } } },
  title: 'CreatorRightsExchange',
  environmentVariables: [
    'DATABASE_URL', 'TEST_DATABASE_URL', 'PORT', 'ADMIN_TOKEN', 'WEBHOOK_URL',
    'WORK_LEASE_SECONDS', 'CHROMIUM_PATH', 'MANAGED_DATA_ROOT', 'TEST_BARRIER_URL', 'TEST_BARRIER_TOKEN',
  ],
  commands: [
    'npm run build', 'npm run db:migrate', 'npm run db:seed -- --file <path>',
    'npm run start:api', 'npm run start:worker', 'npm run start:dispatcher',
    'npm run test:unit', 'npm run test:integration', 'npm run test:e2e',
    'npm run test:concurrency', 'npm run test:recovery', 'npm run test:perf', 'npm run test:all',
  ],
  seed: { command: ['npm', 'run', 'db:seed', '--', '--file', '${SEED_PATH}'], replay: true, schema: seedSchema, example: { schemaVersion: 1, seedVersion: 'creatorrights-public-v2-2', importedAt: T, ...emptyResources, tenants: [publicTenant], creators: [publicCreator], works: [publicWork], rightsSplits: [publicSplit], transcodeProfiles: [publicProfile, publicPreviewProfile], work: [], events: [] } },
  schemas,
  operations: [
    operation('ui', 'GET', '/', 'Required stack and processes', { response: { type: 'string', contentMediaType: 'text/html' } }),
    operation('health', 'GET', '/healthz', '', { source: clarification, response: object({ status: { const: 'ok' } }) }),
    operation('openapi', 'GET', '/openapi.json', 'Common HTTP rules', {
      response: { type: 'object', properties: { openapi: { type: 'string', pattern: '^3\\.1\\.' }, paths: { type: 'object' } }, required: ['openapi', 'paths'] },
    }),
    operation('createTenant', 'POST', '/api/v1/tenants', '1', { request: object({ name: string }), response: ref('Tenant'), source: clarification }),
    operation('createCreator', 'POST', '/api/v1/creators', '1', {
      request: object({ tenantId: uuid, displayName: string, payoutCurrency: currency }),
      response: ref('Creator'), source: clarification,
    }),
    operation('createWork', 'POST', '/api/v1/works', '1', {
      request: object({ tenantId: uuid, externalRef: string, title: string }),
      response: ref('Work'), source: clarification,
    }),
    operation('setRightsSplits', 'POST', '/api/v1/works/:workId/rights-splits', '1', {
      request: object({ expectedRevision: integer, effectiveFrom: timestamp, splits: array(object({ creatorId: uuid, basisPoints: integer })) }),
      response: ref('Work'), source: clarification,
    }),
    operation('createTranscodeProfile', 'POST', '/api/v1/transcode-profiles', '1', {
      request: object({ tenantId: uuid, name: string, operation: enumeration('COPY', 'PREFIX_BASE64'), prefixBase64: nullable(string) }),
      response: ref('TranscodeProfile'), source: clarification,
    }),
    operation('createUpload', 'POST', '/api/v1/uploads', '2', {
      request: object({ tenantId: uuid, workId: uuid, fileName: string, mediaType: string, totalBytes, chunkSize, contentSha256: digest, requiredProfileIds: array(uuid, { uniqueItems: true }) }),
      response: object({ uploadSession: ref('UploadSession') }),
    }),
    operation('putUploadChunk', 'PUT', '/api/v1/uploads/:uploadId/chunks/:chunkNumber', '2', {
      request: { type: 'string', contentMediaType: 'application/octet-stream' }, response: ref('UploadChunk'),
    }),
    operation('getUpload', 'GET', '/api/v1/uploads/:uploadId', '2', { response: object({ uploadSession: ref('UploadSession'), chunks: array(ref('UploadChunk')) }) }),
    operation('abortUpload', 'POST', '/api/v1/uploads/:uploadId/abort', '2', { request: object({}), response: ref('UploadSession') }),
    operation('completeUpload', 'POST', '/api/v1/uploads/:uploadId/complete', '2', {
      request: object({ contentSha256: digest, chunks: array(object({ chunkNumber: { type: 'integer', minimum: 1 }, sha256: digest })) }),
      response: object({ uploadSession: ref('UploadSession'), blobObject: ref('BlobObject') }),
    }),
    operation('recordScanResult', 'POST', '/api/v1/scanner/results', '3', {
      request: object({ scanResultId: uuid, scanJobId: uuid, verdict: enumeration('CLEAN', 'INFECTED'), engineVersion: string, contentSha256: digest }),
      response: ref('ScanResult'),
    }),
    operation('reconcileScanJob', 'POST', '/api/v1/scan-jobs/:scanJobId/reconcile', '3', { request: object({}), response: ref('ScanJob') }),
    operation('getAsset', 'GET', '/api/v1/assets/:assetId', '3', { response: ref('BlobObject'), source: clarification }),
    operation('listAssetRenditions', 'GET', '/api/v1/assets/:assetId/renditions', '3', { response: list('Rendition') }),
    operation('createEdition', 'POST', '/api/v1/editions', '4', {
      request: object({ tenantId: uuid, workId: uuid, title: string, assets: array(object({ assetId: uuid, renditionId: uuid, ordinal: integer })) }),
      response: ref('Edition'),
    }),
    operation('publishEdition', 'POST', '/api/v1/editions/:editionId/publish', '4', {
      request: object({ expectedRevision: integer }), response: ref('Edition'), example: { request: { expectedRevision: 0 } },
    }),
    operation('getEdition', 'GET', '/api/v1/editions/:editionId', '4', { response: object({ edition: ref('Edition'), assets: array(ref('EditionAsset')), rightsSplits: array(ref('RightsSplit')) }) }),
    operation('createLicenseOffer', 'POST', '/api/v1/license-offers', '5', {
      request: object({ tenantId: uuid, editionId: uuid, licenseType: enumeration('STREAM', 'DOWNLOAD'), territories, priceMinor: positiveMoney, currency, termsVersion: integer }),
      response: ref('LicenseOffer'), source: clarification,
    }),
    operation('getLicenseOffer', 'GET', '/api/v1/license-offers/:offerId', '5', { response: object({ offer: ref('LicenseOffer'), edition: ref('Edition') }) }),
    operation('createPurchase', 'POST', '/api/v1/purchases', '5', {
      request: object({ tenantId: uuid, buyerRef: string, offerId: uuid, providerRequestId: string, riskContext: object({ velocity: { type: 'number' }, country: string, deviceTrust: string }) }),
      response: object({ purchaseOrder: ref('PurchaseOrder'), paymentIntent: ref('PaymentIntent') }),
    }),
    operation('claimReviewCase', 'POST', '/api/v1/review-cases/:reviewCaseId/claim', '5', {
      request: object({ reviewerId: string, leaseSeconds: { type: 'number' } }), response: ref('ReviewCase'),
    }),
    operation('decideReviewCase', 'POST', '/api/v1/review-cases/:reviewCaseId/decisions', '5', {
      request: object({ reviewerId: string, leaseToken: string, outcome: enumeration('APPROVE', 'BLOCK'), reasonCode: string }), response: ref('ReviewCase'),
    }),
    operation('recordProviderEvent', 'POST', '/api/v1/provider/events', '5', {
      request: object({ providerEventId: string, providerRequestId: string, kind: enumeration('PAYMENT', 'REFUND'), outcome: enumeration('SUCCEEDED', 'FAILED', 'UNKNOWN'), occurredAt: timestamp }),
      response: { oneOf: [ref('PaymentIntent'), ref('Refund')] },
      source: clarification,
    }),
    operation('reconcilePaymentIntent', 'POST', '/api/v1/payment-intents/:paymentIntentId/reconcile', '5', { request: object({}), response: ref('PaymentIntent') }),
    operation('getPurchase', 'GET', '/api/v1/purchases/:purchaseOrderId', '5', { response: object({ purchaseOrder: ref('PurchaseOrder'), fraudAssessment: ref('FraudAssessment'), reviewCase: nullable(ref('ReviewCase')), paymentIntent: ref('PaymentIntent'), license: nullable(ref('License')) }) }),
    operation('getLicense', 'GET', '/api/v1/licenses/:licenseId', '5', { response: object({ license: ref('License'), grant: ref('EntitlementGrant'), offer: ref('LicenseOffer'), edition: ref('Edition') }) }),
    operation('checkEntitlement', 'GET', '/api/v1/entitlements/check', '5', { response: object({ allowed: boolean, licenseId: nullable(uuid), grantRevision: nullable(integer) }) }),
    operation('createRefund', 'POST', '/api/v1/licenses/:licenseId/refunds', '6', {
      request: object({ amountMinor: positiveMoney, reason: string, providerRequestId: string }), response: ref('Refund'),
    }),
    operation('reconcileRefund', 'POST', '/api/v1/refunds/:refundId/reconcile', '6', { request: object({}), response: ref('Refund') }),
    operation('getRoyaltyLedger', 'GET', '/api/v1/royalty-ledger', '7', { response: object({ items: array(ref('RoyaltyEntry')), nextCursor: nullable(string), totals: array(ref('LedgerTotals')) }) }),
    operation('closeRoyaltyPeriod', 'POST', '/api/v1/royalty-periods', '7', {
      request: object({ tenantId: uuid, currency, periodStart: timestamp, periodEnd: timestamp }), response: ref('RoyaltyPeriod'),
    }),
    operation('getRoyaltyPeriod', 'GET', '/api/v1/royalty-periods/:royaltyPeriodId', '7', { response: object({ period: ref('RoyaltyPeriod'), accountTotals: array(ref('AccountTotals')), entryCount: { type: 'integer', minimum: 0 } }) }),
    operation('recordProviderReceipt', 'POST', '/api/v1/provider/receipts', '8', { request: object({ deliveryId: uuid, providerReceiptId: string }), response: ref('Delivery') }),
    operation('reconcileDelivery', 'POST', '/api/v1/deliveries/:deliveryId/reconcile', '8', { request: object({}), response: ref('Delivery') }),
    operation('verificationSnapshot', 'GET', '/api/v1/verification-snapshot', '10', { response: ref('VerificationSnapshot'), source: clarification }),
    managerOperation('createRightsDispute', 'POST', '/api/v1/rights-disputes', {
      request: object({ tenantId: uuid, editionId: uuid, claimantCreatorId: uuid, reason: string, evidenceRefs, expectedEditionRevision: integer, licenseId: uuid }, ['tenantId', 'editionId', 'claimantCreatorId', 'reason', 'evidenceRefs', 'expectedEditionRevision']),
      response: object({ rightsDispute: ref('RightsDispute') }),
    }),
    managerOperation('getRightsDispute', 'GET', '/api/v1/rights-disputes/:rightsDisputeId', { response: object({ rightsDispute: ref('RightsDispute'), holds: array(ref('LicenseHold')) }) }),
    managerOperation('resolveRightsDispute', 'POST', '/api/v1/rights-disputes/:rightsDisputeId/resolve', {
      request: object({ expectedRevision: integer, outcome: enumeration('UPHELD', 'REJECTED'), reason: string }),
      response: object({ rightsDispute: ref('RightsDispute') }),
    }),
    managerOperation('createLicenseHold', 'POST', '/api/v1/license-holds', {
      request: {
        ...object({ rightsDisputeId: uuid, scope: enumeration('EDITION', 'LICENSE'), licenseId: uuid, reason: string }, ['rightsDisputeId', 'scope', 'reason']),
        if: { properties: { scope: { const: 'LICENSE' } } }, then: { required: ['licenseId'] }, else: { not: { required: ['licenseId'] } },
      },
      response: object({ licenseHold: ref('LicenseHold') }),
    }),
    managerOperation('releaseLicenseHold', 'POST', '/api/v1/license-holds/:licenseHoldId/release', {
      request: object({ expectedRevision: integer, reason: string }), response: object({ licenseHold: ref('LicenseHold') }),
    }),
    managerOperation('createRoyaltyAdjustment', 'POST', '/api/v1/royalty-adjustments', {
      request: object({ tenantId: uuid, rightsDisputeId: uuid, originalPostingId: uuid, amountMinor: nonzeroMoney, currency, reason: string, targetPeriodStart: timestamp }, ['tenantId', 'originalPostingId', 'amountMinor', 'currency', 'reason', 'targetPeriodStart']),
      response: object({ royaltyAdjustment: ref('RoyaltyAdjustment'), entries: array(ref('RoyaltyEntry')) }),
    }),
  ].map(publishOperation),
  smoke: [
    { operationId: 'health', expectStatus: 200 },
    { operationId: 'openapi', expectStatus: 200 },
    { operationId: 'verificationSnapshot', headers: admin, expectStatus: 200, expectContains: [
      { path: ['resources', 'tenants'], match: publicTenant },
      { path: ['resources', 'creators'], match: publicCreator },
      { path: ['resources', 'works'], match: publicWork },
      { path: ['resources', 'rightsSplits'], match: publicSplit },
      { path: ['resources', 'transcodeProfiles'], match: publicProfile },
      { path: ['resources', 'transcodeProfiles'], match: publicPreviewProfile },
    ] },
    { operationId: 'createUpload', body: exampleBodies.createUpload, headers: { 'Idempotency-Key': 'public-upload-create-v2' }, expectStatus: 200,
      expectBody: { uploadSession: { tenantId, workId, totalBytes: 1, state: 'OPEN' } }, capture: { publicUploadId: ['uploadSession', 'uploadId'] } },
    { operationId: 'putUploadChunk', params: { uploadId: '${publicUploadId}', chunkNumber: 1 }, rawBody: 'a',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-0/1', 'X-Chunk-Sha256': exampleBodies.createUpload.contentSha256, 'Idempotency-Key': 'public-upload-chunk-v2' }, expectStatus: 200,
      expectBody: { uploadId: '${publicUploadId}', chunkNumber: 1, startByte: 0, endByte: 0, sizeBytes: 1, sha256: exampleBodies.createUpload.contentSha256 } },
    { operationId: 'completeUpload', params: { uploadId: '${publicUploadId}' }, body: exampleBodies.completeUpload,
      headers: { 'Idempotency-Key': 'public-upload-complete-v2' }, expectStatus: 200,
      expectBody: { uploadSession: { uploadId: '${publicUploadId}', state: 'COMPLETED' }, blobObject: { tenantId, sizeBytes: 1, sha256: exampleBodies.createUpload.contentSha256 } }, capture: { publicBlobId: ['blobObject', 'blobId'] } },
    { operationId: 'getUpload', params: { uploadId: '${publicUploadId}' }, expectStatus: 200,
      expectBody: { uploadSession: { uploadId: '${publicUploadId}', state: 'COMPLETED' } }, expectContains: [{ path: ['chunks'], match: { uploadId: '${publicUploadId}', chunkNumber: 1, sha256: exampleBodies.createUpload.contentSha256 } }] },
    { operationId: 'verificationSnapshot', headers: admin, expectStatus: 200, expectContains: [
      { path: ['resources', 'uploadSessions'], match: { uploadId: '${publicUploadId}', state: 'COMPLETED' } },
      { path: ['resources', 'blobObjects'], match: { blobId: '${publicBlobId}', tenantId, sizeBytes: 1, sha256: exampleBodies.createUpload.contentSha256 } },
    ] },
    { operationId: 'createTenant', rawBody: '{', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'public-malformed-json-v4' }, expectStatus: 400, expectBody: { error: { code: 'MALFORMED_JSON' } } },
    {
      operationId: 'createTenant', body: { name: 'Public Rights Studio' },
      headers: { 'Idempotency-Key': 'public-rights-tenant-v4' }, expectStatus: 200,
      expectBody: { name: 'Public Rights Studio' }, capture: { publicTenantId: ['tenantId'] },
    },
    {
      operationId: 'createCreator',
      body: { tenantId: '${publicTenantId}', displayName: 'Public Creator', payoutCurrency: 'USD' },
      headers: { 'Idempotency-Key': 'public-rights-creator-v4' }, expectStatus: 200,
      expectBody: { tenantId: '${publicTenantId}', displayName: 'Public Creator', payoutCurrency: 'USD' },
      capture: { publicCreatorId: ['creatorId'] },
    },
    {
      operationId: 'createWork',
      body: { tenantId: '${publicTenantId}', externalRef: 'public-rights-master', title: 'Public Rights Master' },
      headers: { 'Idempotency-Key': 'public-rights-work-v4' }, expectStatus: 200,
      expectBody: { tenantId: '${publicTenantId}', externalRef: 'public-rights-master', title: 'Public Rights Master' },
      capture: { publicWorkId: ['workId'], publicInitialRightsRevision: ['currentRightsRevision'] },
    },
    {
      operationId: 'setRightsSplits', params: { workId: '${publicWorkId}' },
      body: {
        expectedRevision: '${publicInitialRightsRevision}', effectiveFrom: '2026-09-01T00:00:00.000Z',
        splits: [{ creatorId: '${publicCreatorId}', basisPoints: 10000 }],
      },
      headers: { 'Idempotency-Key': 'public-rights-split-v4' }, expectStatus: 200,
      expectBody: { workId: '${publicWorkId}', tenantId: '${publicTenantId}', externalRef: 'public-rights-master', title: 'Public Rights Master' },
      capture: { publicUpdatedRightsRevision: ['currentRightsRevision'] },
    },
    {
      operationId: 'verificationSnapshot', headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, expectStatus: 200,
      expectBody: { schemaVersion: 1 },
      expectContains: [
        { path: ['resources', 'tenants'], match: { tenantId: '${publicTenantId}', name: 'Public Rights Studio' } },
        { path: ['resources', 'creators'], match: { creatorId: '${publicCreatorId}', tenantId: '${publicTenantId}', displayName: 'Public Creator', payoutCurrency: 'USD' } },
        { path: ['resources', 'works'], match: { workId: '${publicWorkId}', tenantId: '${publicTenantId}', externalRef: 'public-rights-master', title: 'Public Rights Master', currentRightsRevision: '${publicUpdatedRightsRevision}' } },
        { path: ['resources', 'rightsSplits'], match: { workId: '${publicWorkId}', revision: '${publicUpdatedRightsRevision}', creatorId: '${publicCreatorId}', basisPoints: 10000, effectiveFrom: '2026-09-01T00:00:00.000Z' } },
      ],
    },
  ],
  notes: [
    ...royaltyDigestNotes,
    'HTTP binds only to 127.0.0.1, as required by the original README. The author-owned transport reads contract.httpHost; PORT selects only the port, not a wider network interface.',
    'Authority is workspace/README.md plus the original public README and Manager requirements. The Manager closing instruction about delaying code is legacy orchestration metadata, not product behavior.',
    'Every mutation requires a non-empty Idempotency-Key scoped by tenant, method and canonical route. Exact response/status replay is durable and transactional; changed canonical input returns 409 IDEMPOTENCY_CONFLICT. Unknown JSON members fail before effects. Malformed JSON has the literal code-only error body, unlike other domain errors requiring message.',
    'V2 public wire clarification: GET /healthz returns 200 {status:"ok"} for API startup readiness. GET/HEAD requests have no body. Entitlement-check requires tenantId, buyerRef and editionId; royalty-ledger requires tenantId and ownerId, with optional cursor; asset-renditions accepts optional cursor. Other query keys are invalid. All path identities are lowercase UUIDs except positive integer chunkNumber. List cursors are opaque stable (createdAt,id) cursors; invalid/cross-tenant cursors return 400.',
    'PUT chunk bodies are raw bytes and require Content-Range, X-Chunk-Sha256 and Idempotency-Key. The schema contentMediaType marks non-JSON media; range/digest agreement, final-chunk math and disk atomicity remain business obligations.',
    'V2 public wire clarification resolves the original seed whitelist versus atomic Work/Event import tension: retain all 27 required resource arrays and allow optional top-level work and events arrays using the exact snapshot shapes. Missing work/events means empty. schemaVersion is an integer, seedVersion is a string and optional importedAt is UTC RFC3339. Unknown other fields remain invalid. Import resource/file metadata, durable Work and Events atomically; exact canonical seed replay is a no-op and conflicting seedVersion fails without changes.',
    'The nonempty public seed contains one linked Tenant, Creator, Work, rights revision summing to 10000 and two immutable profiles with distinct revisions. SeedBlobObject and SeedRendition alone add contentBase64; public records never expose bytes or storage keys. Fixed seed identities are example data, not special-case runtime behavior.',
    'Profile revision clarification creator-profile-revision-v1: profileId identifies the immutable profile and the returned revision must be preserved in frozen TranscodeJob/Rendition references. Seed import preserves the supplied profileId and revision, including a revision greater than 1; it must not renumber them. The original requirements do not prescribe whether revision allocation is tenant-wide or per profile. Evaluation does not require equal revision numbers across different profiles and does not assert a particular next number; ordinary seed examples use distinct revisions within each tenant. Immutability, exact frozen references, tenant isolation and seed replay/conflict checks remain mandatory.',
    'contract/README.md (v4 wire clarification) publishes rightsDisputes, licenseHolds and royaltyAdjustments as the three Manager snapshot resource arrays, in addition to the original 27. The original snapshot extension allowance remains. Snapshot Work is DurableWork, distinct from creator catalog Work. Lease values in snapshots must never be usable credentials.',
    'contract/README.md (v4 wire clarification) defines Tenant creation as {name}; profile creation as {tenantId,name,operation,prefixBase64}, using null prefixBase64 for COPY; rights-split mutation returns Work at the top level; asset detail returns BlobObject, with assetId identifying blobId. termsVersion is an integer and providerEventId is an opaque string, not necessarily a UUID. These clarify transport fields without adding business rules.',
    'contract/README.md (v4 wire clarification) defines Creator creation as {tenantId,displayName,payoutCurrency} and Work creation as {tenantId,externalRef,title}, returning their named closed records at the top level. Resource IDs and Work.currentRightsRevision are server-owned response fields. The initial rights revision is not fixed; callers pass the returned revision to rights-splits CAS. These public creation payloads clarify the named-record creation routes without prescribing internal module layout or persistence representation.',
    'V2 public wire clarification: upload completion returns {uploadSession:UploadSession,blobObject:BlobObject}; blobObject.blobId is the public asset identity. Abort and all reconcile operations take the closed empty JSON object {}. Provider events return the exact PaymentIntent for kind PAYMENT or Refund for kind REFUND; no extra event envelope. POST provider/receipts accepts {deliveryId,providerReceiptId}, binding a stable provider receipt to that delivery, and returns Delivery. Receipt replay/unknown ACK/order and no-premature-success requirements remain unchanged.',
    'V2 public wire clarification: royalty-ledger returns {items:RoyaltyEntry[],nextCursor:string|null,totals:LedgerTotals[]}. Totals cover all committed entries for tenantId+ownerId, independent of page cursor, grouped and sorted by currency. Each total is {currency,debitMinor,creditMinor,balanceMinor}, with nonnegative debit/credit totals and signed balanceMinor=creditMinor-debitMinor. Royalty-period accountTotals is an array of {royaltyAccountId,ownerId,currency,debitMinor,creditMinor,balanceMinor}, sorted by royaltyAccountId, covering exactly the period entries; entryCount is their count. SnapshotDigest and accounting conservation remain original business requirements. Notification/Event payload and domain-error details are explicitly free JSON objects subject to original privacy rules.',
    'Lifecycle fields such as completedAt, revokedAt, lease fields and pending assessment values have no complete public nullability matrix; these schemas allow null for absent lifecycle values without prescribing defaults.',
    'V2 public wire clarification: Manager adds PurchaseOrder LICENSE_HELD and License HELD; EntitlementGrant keeps ACTIVE/REVOKED and its authorization read checks Hold authority. Adjustment RoyaltyEntries use sourceType ADJUSTMENT and sourceId=royaltyAdjustmentId; the adjustment links originalPostingId and adjustmentPostingId, while entries retain original accountRole meanings. Original entries/CLOSED periods are never edited. Missing lifecycle values use null exactly where the published schemas allow it.',
    'evidenceRefs must be sorted, unique, opaque, 1..20 elements and at most 512 UTF-8 bytes each; JSON Schema maxLength counts characters, so byte limits remain runtime validation. References must never be fetched. Territory ISO membership/order, rights sum 10000 and unique creators require semantic validation.',
    'All explicit mutation successes default to status 200. A named single-resource success uses the exact top-level record; literal multi-resource/enveloped responses are preserved. No {data} or {result} wrapper is authorized.',
    'The smoke verifies the linked nonempty seed through the admin snapshot, creates independent Tenant/Creator/Work records, submits a 10000-basis-point rights revision and checks the same committed identities. Capture paths are arrays and preserve integer revisions. Each expectContains requires exactly one matching record; an empty list or response-only echo cannot pass. This does not certify media, licensing, concurrency, recovery or performance.',
    'V2 wire defaults absent from the legacy text are public: invalid wire input uses 400 INVALID_REQUEST, missing Idempotency-Key is invalid input, missing/malformed admin authorization uses 401 UNAUTHORIZED, wrong media type uses 415 UNSUPPORTED_MEDIA_TYPE, and unknown routes use 404 NOT_FOUND. Malformed JSON alone uses the original code-only 400 MALFORMED_JSON body. UTC timestamps may use Z or +00:00 with optional fractional precision. Additional snapshot resource arrays remain allowed; known resources and privacy/invariant checks remain mandatory.',
    'PostgreSQL 16 owns resources, idempotency, leases/fences, ordering, money and events. Node.js 22/TypeScript/React and independent API/worker/dispatcher processes, production UI at /, loopback binding, supplied Chromium, managed files, and transactional authority are required.',
    'The six required measured pressure scenarios are multipart-edition-pipeline, license-checkout-uncertainty, fraud-review-release, entitlement-read-storm, royalty-ledger-close and notification-recovery; their exact metrics, durations, real-process/Chromium/SIGKILL conditions and post-load invariants remain in README sections 13–14. Schema smoke is not evidence that those scenarios pass.',
  ],
};
