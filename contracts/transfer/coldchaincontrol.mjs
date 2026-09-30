// Public author contract only. Sources are the two public task documents, never evaluator cases.
import { readFileSync } from 'node:fs';
const dialect = 'https://json-schema.org/draft/2020-12/schema';
const source = (line) => `docs/frontal-legacy/README.md:${line}`;
const manager = (line) => `docs/frontal-legacy/manager-requirements.md:${line}`;
const wireSource = 'contract/README.md (v4 wire clarification)';
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const text = { type: 'string' };
const uuid = { type: 'string', format: 'uuid', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const instant = { type: 'string', format: 'date-time', pattern: '(?:[Zz]|\\+00:00)$' };
const integer = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });
const list = (schema, extra = {}) => ({ type: 'array', items: schema, ...extra });
const enumeration = (...values) => ({ type: 'string', enum: values });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const positive = { ...integer, minimum: 1 };
const nonnegative = { ...integer, minimum: 0 };
const maybeInstant = nullable(instant);
const pick = (schema, names) => object(Object.fromEntries(names.map((name) => [name, schema.properties[name]])));
const json = { type: 'object', additionalProperties: true, description: 'Explicit free JSON metadata; recursively secret-free.' };
const id = n => `31000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-01-01T00:00:00Z';
const later = '2099-01-01T00:00:00Z';
const publicDeviceSecret = 'public-example-device-secret-not-production';

const schemas = {
  Error: object({ error: object({ code: text, message: text, details: { type: 'object' } }) }),
  Tenant: object({ tenantId: uuid, name: text }),
  Site: object({ siteId: uuid, tenantId: uuid, code: text, name: text, latitudeE6: integer, longitudeE6: integer, radiusMeters: positive, timeZone: text }),
  Carrier: object({ carrierId: uuid, tenantId: uuid, code: text, name: text, state: enumeration('ACTIVE', 'SUSPENDED') }),
  DeviceCredential: object({ deviceCredentialId: uuid, tenantId: uuid, deviceId: uuid, keyVersion: integer, state: enumeration('ACTIVE', 'REVOKED'), validFrom: instant, revokedAt: maybeInstant }),
  SensorDevice: object({ deviceId: uuid, tenantId: uuid, carrierId: uuid, serialNumber: text, state: enumeration('ACTIVE', 'SUSPENDED', 'RETIRED'), currentKeyVersion: integer, currentConfigVersion: nullable(integer), lastSequence: integer, lastSeenAt: maybeInstant }),
  ConfigRevision: object({ configRevisionId: uuid, tenantId: uuid, version: integer, state: enumeration('DRAFT', 'PUBLISHED'), minTemperatureMilliC: integer, maxTemperatureMilliC: integer, sampleIntervalSeconds: integer, offlineAfterSeconds: integer, createdAt: instant, publishedAt: maybeInstant }),
  ConfigAssignment: object({ configAssignmentId: uuid, tenantId: uuid, deviceId: uuid, configRevisionId: uuid, state: enumeration('PENDING', 'DELIVERED', 'CONFIRMED', 'EXPIRED'), expiresAt: instant, confirmedAt: maybeInstant, createdAt: instant }),
  ColdShipment: object({ shipmentId: uuid, tenantId: uuid, externalRef: text, productLotCode: text, carrierId: uuid, originSiteId: uuid, destinationSiteId: uuid, deviceId: uuid, state: enumeration('DRAFT', 'ACTIVE', 'DELIVERED', 'CANCELLED'), minimumTemperatureMilliC: integer, maximumTemperatureMilliC: integer, expectedStartAt: instant, expectedEndAt: instant, activatedAt: maybeInstant, terminalAt: maybeInstant }),
  ShipmentLeg: object({ shipmentLegId: uuid, shipmentId: uuid, ordinal: nonnegative, fromSiteId: uuid, toSiteId: uuid, plannedDepartureAt: instant, plannedArrivalAt: instant }),
  TelemetryReading: object({ telemetryReadingId: uuid, tenantId: uuid, deviceId: uuid, readingId: uuid, sequence: integer, observedAt: instant, receivedAt: instant, latitudeE6: integer, longitudeE6: integer, temperatureMilliC: integer, configVersion: integer, keyVersion: integer, signature: { type: 'string', pattern: '^[0-9a-f]{64}$' } }),
  ShipmentProjection: object({ shipmentId: uuid, tenantId: uuid, lastSequence: integer, lastObservedAt: maybeInstant, lastLatitudeE6: nullable(integer), lastLongitudeE6: nullable(integer), lastTemperatureMilliC: nullable(integer), currentSiteId: nullable(uuid), currentLegOrdinal: integer, state: enumeration('IN_TRANSIT', 'AT_SITE', 'DELIVERED', 'CANCELLED'), updatedAt: instant }),
  Excursion: object({ excursionId: uuid, tenantId: uuid, shipmentId: uuid, kind: enumeration('TEMPERATURE', 'OFFLINE'), state: enumeration('OPEN', 'ACKNOWLEDGED', 'RESOLVED'), openedAt: instant, acknowledgedAt: maybeInstant, resolvedAt: maybeInstant, firstSequence: integer, lastSequence: integer, minimumObservedMilliC: nullable(integer), maximumObservedMilliC: nullable(integer) }),
  NotificationPolicy: object({ notificationPolicyId: uuid, tenantId: uuid, eventKinds: list(text), destination: text, rateLimitPerMinute: integer, state: enumeration('ACTIVE', 'DISABLED') }),
  NotificationDelivery: object({ notificationDeliveryId: uuid, tenantId: uuid, notificationPolicyId: uuid, eventId: uuid, state: enumeration('PENDING', 'DELIVERED', 'DEAD_LETTER'), attempts: integer, nextAttemptAt: maybeInstant, deliveredAt: maybeInstant }),
  AuditEntry: object({ auditEntryId: uuid, tenantId: uuid, actorType: enumeration('USER', 'DEVICE', 'SYSTEM'), actorRef: text, action: text, resourceType: text, resourceId: uuid, occurredAt: instant, details: { type: 'object' } }),
  CustodyChain: object({ custodyChainId: uuid, tenantId: uuid, shipmentId: uuid, revision: integer, state: enumeration('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'), currentOrdinal: integer, createdAt: instant, terminalAt: maybeInstant }),
  CustodyHandoff: object({ custodyHandoffId: uuid, custodyChainId: uuid, ordinal: integer, fromCarrierId: uuid, toCarrierId: uuid, siteId: uuid, windowStart: instant, windowEnd: instant, state: enumeration('PENDING', 'OFFERED', 'ACCEPTED', 'EXPIRED', 'CANCELLED'), offeredAt: maybeInstant, acceptedAt: maybeInstant, terminalAt: maybeInstant }),
  RecallOrder: object({ recallId: uuid, tenantId: uuid, productLotCode: text, reason: text, state: enumeration('ISSUED', 'QUARANTINING', 'CONTAINED', 'CANCELLED'), revision: integer, issuedAt: instant, terminalAt: maybeInstant }),
  QuarantineAction: object({ quarantineActionId: uuid, recallId: uuid, shipmentId: uuid, state: enumeration('PENDING', 'APPLIED', 'RELEASED'), expectedShipmentState: enumeration('DRAFT', 'ACTIVE', 'DELIVERED', 'CANCELLED'), createdAt: instant, appliedAt: maybeInstant, releasedAt: maybeInstant }),
};
schemas.Work = object({ workId: uuid, tenantId: uuid, kind: text, aggregateId: uuid, state: enumeration('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED'), attempt: nonnegative, availableAt: instant, leaseOwner: nullable(text), leaseToken: nullable(text), leaseExpiresAt: maybeInstant, lastError: nullable(text), terminal: { type: 'boolean' }, createdAt: instant, updatedAt: instant });
schemas.Event = object({ eventId: uuid, tenantId: uuid, aggregateType: text, aggregateId: uuid, sequence: positive, kind: text, occurredAt: instant, payload: json, outboxState: enumeration('PENDING', 'DELIVERED', 'DEAD_LETTER') });
schemas.ShipmentTimeline = object({ shipmentId: uuid, readings: list(ref('SnapshotTelemetryReading')), excursions: list(ref('Excursion')), events: list(ref('Event')) });
schemas.Error.properties.error.properties.details = json;
schemas.Error.properties.error.properties.code = { ...text, examples: ['INVALID_REQUEST', 'NOT_FOUND', 'TENANT_SCOPE_MISMATCH', 'STATE_CONFLICT', 'CONFIG_VERSION_CONFLICT', 'CONFIG_ASSIGNMENT_STALE', 'DEVICE_TERMINAL', 'DEVICE_CREDENTIAL_CONFLICT', 'INVALID_DEVICE_SIGNATURE', 'TELEMETRY_CONFLICT', 'SHIPMENT_ROUTE_INVALID', 'SHIPMENT_DEVICE_BUSY', 'SHIPMENT_TERMINAL', 'EXCURSION_TERMINAL', 'RATE_LIMITED', 'CUSTODY_CHAIN_INVALID', 'RECALL_INVALID', 'INVALID_HANDOFF_ATTESTATION', 'CUSTODY_CHAIN_CONFLICT', 'CUSTODY_HANDOFF_NOT_CURRENT', 'CUSTODY_HANDOFF_EXPIRED', 'CUSTODY_REVISION_CONFLICT', 'RECALL_ALREADY_ACTIVE', 'RECALL_REVISION_CONFLICT', 'SHIPMENT_QUARANTINED', 'RECALL_TERMINAL', 'IDEMPOTENCY_CONFLICT', 'MALFORMED_JSON'] };
schemas.Work.properties.kind = { type: 'string', minLength: 1, examples: ['CONFIG_DELIVER', 'TELEMETRY_PROJECT', 'DEVICE_OFFLINE_CHECK', 'CUSTODY_HANDOFF_EXPIRY', 'RECALL_PROPAGATE', 'QUARANTINE_ENFORCE'] };
schemas.AuditEntry.properties.details = json;

// Seed is a transport shape. Referential, temporal and transactional validity remains business work.
schemas.SeedDeviceCredential = object({ ...schemas.DeviceCredential.properties, secret: text });
schemas.SnapshotTelemetryReading = object({ ...schemas.TelemetryReading.properties, signature: { type: 'null' } });
schemas.CreateTenant = pick(schemas.Tenant, ['name']);
schemas.CreateSite = pick(schemas.Site, ['tenantId', 'code', 'name', 'latitudeE6', 'longitudeE6', 'radiusMeters', 'timeZone']);
schemas.CreateCarrier = pick(schemas.Carrier, ['tenantId', 'code', 'name', 'state']);
schemas.CreateDevice = pick(schemas.SensorDevice, ['tenantId', 'carrierId', 'serialNumber', 'state']);
schemas.CreateConfigRevision = pick(schemas.ConfigRevision, ['tenantId', 'minTemperatureMilliC', 'maxTemperatureMilliC', 'sampleIntervalSeconds', 'offlineAfterSeconds']);
schemas.IngestTelemetry = pick(schemas.TelemetryReading, ['deviceId', 'readingId', 'sequence', 'observedAt', 'latitudeE6', 'longitudeE6', 'temperatureMilliC', 'configVersion', 'keyVersion', 'signature']);
schemas.CreateShipmentLeg = pick(schemas.ShipmentLeg, ['ordinal', 'fromSiteId', 'toSiteId', 'plannedDepartureAt', 'plannedArrivalAt']);
schemas.CreateShipment = object({ ...pick(schemas.ColdShipment, ['tenantId', 'externalRef', 'productLotCode', 'carrierId', 'originSiteId', 'destinationSiteId', 'deviceId', 'minimumTemperatureMilliC', 'maximumTemperatureMilliC', 'expectedStartAt', 'expectedEndAt']).properties, legs: list(ref('CreateShipmentLeg'), { minItems: 1, maxItems: 32 }) });
schemas.CreateNotificationPolicy = pick(schemas.NotificationPolicy, ['tenantId', 'eventKinds', 'destination', 'rateLimitPerMinute', 'state']);
schemas.ExcursionPage = object({ items: list(ref('Excursion')), nextCursor: nullable(text) });
const resources = {
  tenants: 'Tenant', sites: 'Site', carriers: 'Carrier', deviceCredentials: 'DeviceCredential', devices: 'SensorDevice',
  configRevisions: 'ConfigRevision', configAssignments: 'ConfigAssignment', shipments: 'ColdShipment', shipmentLegs: 'ShipmentLeg',
  telemetryReadings: 'TelemetryReading', shipmentProjections: 'ShipmentProjection', excursions: 'Excursion',
  notificationPolicies: 'NotificationPolicy', notificationDeliveries: 'NotificationDelivery', auditEntries: 'AuditEntry',
};
const resourceArrays = (overrides = {}) => Object.fromEntries(Object.entries({ ...resources, ...overrides }).map(([name, schema]) => [name, list(ref(schema))]));
schemas.Seed = {
  $schema: dialect,
  ...object({ schemaVersion: { const: 1 }, seedVersion: text, importedAt: instant, ...resourceArrays({ deviceCredentials: 'SeedDeviceCredential' }) }),
};
schemas.SnapshotResources = object(resourceArrays({ telemetryReadings: 'SnapshotTelemetryReading' }));
schemas.ManagerResources = object({ custodyChains: list(ref('CustodyChain')), custodyHandoffs: list(ref('CustodyHandoff')), recallOrders: list(ref('RecallOrder')), quarantineActions: list(ref('QuarantineAction')) });
schemas.VerificationSnapshot = object({ schemaVersion: { const: 1 }, asOf: instant, resources: ref('SnapshotResources'), work: list(ref('Work')), events: list(ref('Event')), managerResources: ref('ManagerResources') });

const operation = (id, method, path, line, extra = {}) => ({ id, method, path, source: source(line), ...extra });
const mutation = (id, path, line, response, request) => operation(id, 'POST', path, line, { status: 200, ...(response ? { response: ref(response) } : {}), ...(request ? { request } : {}) });
const clarifiedMutation = (id, path, response, request) => ({ id, method: 'POST', path, status: 200, source: wireSource, response: ref(response), request });
const managerOperation = (id, method, path, status, response, request) => ({ id, method, path, status, source: manager(9), response, ...(request ? { request } : {}) });
const chainStep = object({ fromCarrierId: uuid, toCarrierId: uuid, siteId: uuid, windowStart: instant, windowEnd: instant });

const contract = {
  taskId: 'coldchaincontrol',
  title: 'ColdChainControl',
  environmentVariables: ['PORT', 'DATABASE_URL', 'ADMIN_TOKEN', 'WEBHOOK_URL', 'WORK_LEASE_SECONDS', 'TEST_BARRIER_URL', 'TEST_BARRIER_TOKEN'],
  commands: ['npm run build', 'npm run db:migrate', 'npm run db:seed -- --file <seed.json>', 'npm run start:api', 'npm run start:worker', 'npm run start:dispatcher', ...['unit', 'integration', 'e2e', 'concurrency', 'recovery', 'perf', 'all'].map((name) => `npm run test:${name}`)],
  seed: {
    schema: schemas.Seed,
    replay: true,
    example: { schemaVersion: 1, seedVersion: 'public-linked-device-v2', importedAt: at, ...Object.fromEntries(Object.keys(resources).map((key) => [key, []])),
      tenants: [{ tenantId: id(1), name: 'Public cold-chain tenant' }],
      carriers: [{ carrierId: id(2), tenantId: id(1), code: 'PUBLIC-CARRIER', name: 'Public carrier', state: 'ACTIVE' }],
      devices: [{ deviceId: id(3), tenantId: id(1), carrierId: id(2), serialNumber: 'PUBLIC-SENSOR-001', state: 'ACTIVE', currentKeyVersion: 1, currentConfigVersion: 1, lastSequence: 0, lastSeenAt: null }],
      deviceCredentials: [{ deviceCredentialId: id(4), tenantId: id(1), deviceId: id(3), keyVersion: 1, state: 'ACTIVE', validFrom: at, revokedAt: null, secret: publicDeviceSecret }],
      configRevisions: [{ configRevisionId: id(5), tenantId: id(1), version: 1, state: 'PUBLISHED', minTemperatureMilliC: 2000, maxTemperatureMilliC: 8000, sampleIntervalSeconds: 30, offlineAfterSeconds: 180, createdAt: at, publishedAt: at }],
      configAssignments: [{ configAssignmentId: id(6), tenantId: id(1), deviceId: id(3), configRevisionId: id(5), state: 'CONFIRMED', expiresAt: later, confirmedAt: at, createdAt: at }],
    },
  },
  schemas,
  operations: [
    operation('health', 'GET', '/healthz', 14, { status: 200, response: object({ status: { const: 'ok' } }) }),
    operation('openapi', 'GET', '/openapi.json', 14, { status: 200, response: { type: 'object', required: ['openapi', 'info', 'paths'], properties: { openapi: { type: 'string', pattern: '^3\\.1\\.' }, info: { type: 'object' }, paths: { type: 'object' } } } }),
    operation('production-ui', 'GET', '/', 14, { status: 200, response: { type: 'string', minLength: 1, contentMediaType: 'text/html' } }),
    clarifiedMutation('create-tenant', '/api/v1/tenants', 'Tenant', ref('CreateTenant')),
    clarifiedMutation('create-site', '/api/v1/sites', 'Site', ref('CreateSite')),
    clarifiedMutation('create-carrier', '/api/v1/carriers', 'Carrier', ref('CreateCarrier')),
    clarifiedMutation('create-device', '/api/v1/devices', 'SensorDevice', ref('CreateDevice')),
    clarifiedMutation('create-config-revision', '/api/v1/config-revisions', 'ConfigRevision', ref('CreateConfigRevision')),
    clarifiedMutation('publish-config-revision', '/api/v1/config-revisions/:configRevisionId/publish', 'ConfigRevision', object({ expectedVersion: integer })),
    mutation('create-config-assignment', '/api/v1/devices/:deviceId/config-assignments', 57, 'ConfigAssignment', object({ configRevisionId: uuid, expiresAt: instant })),
    operation('read-device-config', 'GET', '/api/v1/devices/:deviceId/config', 58, { source: wireSource, status: 200, response: ref('ConfigRevision') }),
    mutation('acknowledge-config', '/api/v1/devices/:deviceId/config-acknowledgements', 58, 'ConfigAssignment', object({ configAssignmentId: uuid, configVersion: integer, appliedAt: instant })),
    mutation('rotate-device-credential', '/api/v1/devices/:deviceId/credentials/rotate', 63, 'DeviceCredential', object({ expectedKeyVersion: integer, secret: text, validFrom: instant })),
    mutation('revoke-device-credential', '/api/v1/devices/:deviceId/credentials/:keyVersion/revoke', 63, 'DeviceCredential', object({ reason: text })),
    clarifiedMutation('ingest-telemetry', '/api/v1/telemetry-readings', 'TelemetryReading', ref('IngestTelemetry')),
    clarifiedMutation('create-shipment', '/api/v1/shipments', 'ColdShipment', ref('CreateShipment')),
    clarifiedMutation('activate-shipment', '/api/v1/shipments/:shipmentId/activate', 'ColdShipment', object({})),
    clarifiedMutation('cancel-shipment', '/api/v1/shipments/:shipmentId/cancel', 'ColdShipment', object({})),
    operation('read-shipment', 'GET', '/api/v1/shipments/:shipmentId', 73, { status: 200, response: ref('ColdShipment') }),
    operation('read-shipment-timeline', 'GET', '/api/v1/shipments/:shipmentId/timeline', 73, { status: 200, response: ref('ShipmentTimeline') }),
    clarifiedMutation('deliver-shipment', '/api/v1/shipments/:shipmentId/deliver', 'ColdShipment', object({})),
    clarifiedMutation('acknowledge-excursion', '/api/v1/excursions/:excursionId/acknowledge', 'Excursion', object({})),
    clarifiedMutation('create-notification-policy', '/api/v1/notification-policies', 'NotificationPolicy', ref('CreateNotificationPolicy')),
    operation('list-excursions', 'GET', '/api/v1/excursions', 81, { source: wireSource, status: 200, response: ref('ExcursionPage') }),
    operation('verification-snapshot', 'GET', '/api/v1/verification-snapshot', 84, { status: 200, response: ref('VerificationSnapshot') }),
    managerOperation('create-custody-chain', 'POST', '/api/v1/custody-chains', 201, ref('CustodyChain'), object({ tenantId: uuid, shipmentId: uuid, expectedShipmentState: enumeration('DRAFT', 'ACTIVE', 'DELIVERED', 'CANCELLED'), steps: list(chainStep, { minItems: 1 }) })),
    managerOperation('read-custody-chain', 'GET', '/api/v1/custody-chains/:chainId', 200, object({ chain: ref('CustodyChain'), handoffs: list(ref('CustodyHandoff')) })),
    managerOperation('offer-custody-handoff', 'POST', '/api/v1/custody-chains/:chainId/handoffs', 200, ref('CustodyHandoff'), object({ expectedChainRevision: integer })),
    managerOperation('accept-custody-handoff', 'POST', '/api/v1/custody-handoffs/:handoffId/accept', 200, object({ chain: ref('CustodyChain'), handoff: ref('CustodyHandoff'), shipment: ref('ColdShipment') }), object({ carrierId: uuid, deviceId: uuid, keyVersion: integer, attestation: text, acceptedAt: instant, expectedChainRevision: integer })),
    managerOperation('create-recall', 'POST', '/api/v1/recalls', 201, ref('RecallOrder'), object({ tenantId: uuid, productLotCode: text, reason: text, issuedAt: instant })),
    managerOperation('read-recall', 'GET', '/api/v1/recalls/:recallId', 200, object({ recall: ref('RecallOrder'), actions: list(ref('QuarantineAction')) })),
    managerOperation('quarantine-recall', 'POST', '/api/v1/recalls/:recallId/quarantine', 202, ref('RecallOrder'), object({ expectedRevision: integer })),
  ],
  smoke: [
    { operationId: 'health', expectStatus: 200 },
    { operationId: 'openapi', expectStatus: 200 },
    { operationId: 'verification-snapshot', headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, expectStatus: 200, expectContains: [
      { path: ['resources', 'devices'], match: { deviceId: id(3), carrierId: id(2), currentConfigVersion: 1 } },
      { path: ['resources', 'configAssignments'], match: { configAssignmentId: id(6), deviceId: id(3), configRevisionId: id(5), state: 'CONFIRMED' } },
    ], capture: { publicDeviceTime: ['asOf'] } },
    { operationId: 'read-device-config', params: { deviceId: id(3) },
      headers: { 'X-Device-Id': id(3), 'X-Device-Key-Version': '1', 'X-Device-Timestamp': '${publicDeviceTime}', 'X-Device-Signature': '' },
      signatures: [{ target: ['headers', 'X-Device-Signature'], key: publicDeviceSecret, message: `GET|/api/v1/devices/${id(3)}/config|\${publicDeviceTime}|1` }],
      expectBody: { configRevisionId: id(5), tenantId: id(1), version: 1, state: 'PUBLISHED' } },
    { operationId: 'verification-snapshot', headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, capture: { publicReadingTime: ['asOf'] } },
    { operationId: 'ingest-telemetry',
      headers: { 'Idempotency-Key': 'public-signed-reading-v2', 'X-Device-Id': id(3), 'X-Device-Key-Version': '1', 'X-Device-Timestamp': '${publicReadingTime}', 'X-Device-Signature': '' },
      body: { deviceId: id(3), readingId: id(7), sequence: 1, observedAt: '${publicReadingTime}', latitudeE6: 0, longitudeE6: 0, temperatureMilliC: 5000, configVersion: 1, keyVersion: 1, signature: '' },
      signatures: [
        { target: ['headers', 'X-Device-Signature'], key: publicDeviceSecret, message: 'POST|/api/v1/telemetry-readings|${publicReadingTime}|1' },
        { target: ['body', 'signature'], key: publicDeviceSecret, message: `${id(3)}|${id(7)}|1|\${publicReadingTime}|0|0|5000|1|1` },
      ],
      expectBody: { deviceId: id(3), readingId: id(7), sequence: 1, temperatureMilliC: 5000 },
      capture: { publicTelemetryId: ['telemetryReadingId'] } },
    { operationId: 'verification-snapshot', headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, expectContains: [
      { path: ['resources', 'telemetryReadings'], match: { telemetryReadingId: '${publicTelemetryId}', tenantId: id(1), deviceId: id(3), readingId: id(7), sequence: 1, temperatureMilliC: 5000, signature: null } },
    ] },
    { operationId: 'create-tenant', body: { name: 'Public Contract Tenant' }, headers: { 'Idempotency-Key': 'public-create-tenant-v2' }, expectStatus: 200, capture: { publicTenantId: ['tenantId'] } },
    { operationId: 'create-config-revision', body: { tenantId: '${publicTenantId}', minTemperatureMilliC: 1000, maxTemperatureMilliC: 7000, sampleIntervalSeconds: 15, offlineAfterSeconds: 300 }, headers: { 'Idempotency-Key': 'public-create-config-v2' }, expectStatus: 200, expectBody: { state: 'DRAFT' }, capture: { publicConfigId: ['configRevisionId'], publicConfigVersion: ['version'] } },
    { operationId: 'verification-snapshot', headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, expectStatus: 200, expectContains: [{ path: ['resources', 'configRevisions'], match: { configRevisionId: '${publicConfigId}', tenantId: '${publicTenantId}', version: '${publicConfigVersion}', state: 'DRAFT' } }] },
    { operationId: 'publish-config-revision', params: { configRevisionId: '${publicConfigId}' }, body: { expectedVersion: 0 }, headers: { 'Idempotency-Key': 'public-publish-config-v2' }, expectStatus: 200, expectBody: { configRevisionId: '${publicConfigId}', version: '${publicConfigVersion}', state: 'PUBLISHED' } },
    { operationId: 'verification-snapshot', headers: { Authorization: 'Bearer ${ADMIN_TOKEN}' }, expectStatus: 200, expectContains: [{ path: ['resources', 'configRevisions'], match: { configRevisionId: '${publicConfigId}', tenantId: '${publicTenantId}', state: 'PUBLISHED', minTemperatureMilliC: 1000, maxTemperatureMilliC: 7000 } }] },
    { operationId: 'create-recall', body: { tenantId: id(1), productLotCode: 'PUBLIC', reason: 'transport check', issuedAt: at, unknown: true }, headers: { 'Idempotency-Key': 'public-invalid-v2' }, expectStatus: 400, expectBody: { error: { code: 'INVALID_REQUEST' } } },
  ],
  notes: [
    'Public smoke imports the published credential, signs real config and telemetry requests using database snapshot time, and verifies the accepted reading in the persisted snapshot. Its HMAC helper is client-side request construction only: storage, lookup, verification and business effects remain implementation work.',
    'Authority is the complete original README and Manager requirements. The following V2 clarifications fix wire representation only; every original business, UI, recovery and performance obligation remains required.',
    'Health is GET /healthz with {status:"ok"}; production / returns nonempty text/html. OpenAPI is 3.1 and generated from this same contract.',
    'All mutations require a nonempty Idempotency-Key. Device config, acknowledgement and ingest require the four X-Device authentication headers. Signature and database-time authentication remain business validation. Wire-invalid device-authentication headers return 401 INVALID_DEVICE_SIGNATURE.',
    'Request schemas publish only input fields. New ConfigRevision is the next tenant version; publish expectedVersion is the previous published version (0 before first publication), and publication preserves the created identity/version.',
    'GET device config returns the referenced ConfigRevision at top level; its selected ConfigAssignment remains in the snapshot. Shipment transitions and excursion acknowledgement take an empty JSON object.',
    'GET excursions returns {items,nextCursor}; query tenantId/shipmentId/kind/state filter, limit is a positive safe integer (default 50), cursor is opaque. Stable ordering and continuity must survive restart.',
    'Shipment timeline returns {shipmentId,readings,excursions,events}; readings sort by sequence/readingId and redact signature to null; excursions sort by firstSequence/excursionId; events sort by aggregate sequence/eventId. All records come from the shipment tenant and point-in-time committed history.',
    'Work and Event use the explicitly closed schemas published here. Work leaseOwner/leaseToken/leaseExpiresAt are null unless leased; lastError is string|null. Event payload and Audit details are explicitly free JSON metadata, recursively secret-free. outboxState reports PENDING/DELIVERED/DEAD_LETTER.',
    'Unobserved projection timestamp/coordinates/temperature and nullable lifecycle timestamps are null. Excursion observed bounds are nullable for OFFLINE. Snapshot telemetry signature is always null, while ingest/seed carries the signed value.',
    'Seed header is schemaVersion:1, string seedVersion and UTC importedAt. The nonempty public graph links a tenant, carrier, active device, credential, published config and confirmed assignment. Identical seed replay is a no-op; changed bytes under one version reject atomically. Manager collections remain snapshot.managerResources, outside the V1 seed whitelist.',
    'UUID path parameters are lowercase canonical UUIDs, keyVersion is a positive safe integer. Query/path integers are normalized from HTTP strings; JSON numbers are never coerced. Unknown query/JSON keys and other malformed shapes use 400 INVALID_REQUEST; malformed JSON uses 400 MALFORMED_JSON; unsupported media uses 415 UNSUPPORTED_MEDIA_TYPE; missing snapshot auth uses 401 UNAUTHORIZED. Original named business errors retain their original status.',
    'Recall cancellation has no published endpoint; no new business route is invented. All canonical payloads, sortedness, foreign keys, state transitions and cross-field consistency remain implementation work.',
    'The smoke verifies the linked seed, independently creates a tenant/config, reads it, publishes it and reads the committed published identity. Public smoke does not certify hidden, concurrent, recovery, Chromium or performance behavior.',
  ],
};
const bodies = {
  'create-tenant': { name: 'Public tenant' },
  'create-site': { tenantId: id(1), code: 'PUBLIC-DEPOT', name: 'Public depot', latitudeE6: 0, longitudeE6: 0, radiusMeters: 100, timeZone: 'UTC' },
  'create-carrier': { tenantId: id(1), code: 'PUBLIC-SECOND', name: 'Public carrier', state: 'ACTIVE' },
  'create-device': { tenantId: id(1), carrierId: id(2), serialNumber: 'PUBLIC-SENSOR-002', state: 'ACTIVE' },
  'create-config-revision': { tenantId: id(1), minTemperatureMilliC: 2000, maxTemperatureMilliC: 8000, sampleIntervalSeconds: 30, offlineAfterSeconds: 180 },
  'publish-config-revision': { expectedVersion: 1 },
  'create-config-assignment': { configRevisionId: id(5), expiresAt: later },
  'acknowledge-config': { configAssignmentId: id(6), configVersion: 1, appliedAt: at },
  'rotate-device-credential': { expectedKeyVersion: 1, secret: 'public-rotation-secret-not-production', validFrom: at },
  'revoke-device-credential': { reason: 'Public rotation example' },
  'ingest-telemetry': { deviceId: id(3), readingId: id(7), sequence: 1, observedAt: at, latitudeE6: 0, longitudeE6: 0, temperatureMilliC: 5000, configVersion: 1, keyVersion: 1, signature: '0'.repeat(64) },
  'create-shipment': { tenantId: id(1), externalRef: 'PUBLIC-SHIPMENT', productLotCode: 'PUBLIC-LOT', carrierId: id(2), originSiteId: id(8), destinationSiteId: id(9), deviceId: id(3), minimumTemperatureMilliC: 2000, maximumTemperatureMilliC: 8000, expectedStartAt: at, expectedEndAt: later, legs: [{ ordinal: 0, fromSiteId: id(8), toSiteId: id(9), plannedDepartureAt: at, plannedArrivalAt: later }] },
  'activate-shipment': {}, 'cancel-shipment': {}, 'deliver-shipment': {}, 'acknowledge-excursion': {},
  'create-notification-policy': { tenantId: id(1), eventKinds: ['EXCURSION_OPENED'], destination: 'https://example.invalid/cold-chain', rateLimitPerMinute: 60, state: 'ACTIVE' },
  'create-custody-chain': { tenantId: id(1), shipmentId: id(10), expectedShipmentState: 'ACTIVE', steps: [{ fromCarrierId: id(2), toCarrierId: id(11), siteId: id(9), windowStart: at, windowEnd: later }] },
  'offer-custody-handoff': { expectedChainRevision: 1 },
  'accept-custody-handoff': { carrierId: id(11), deviceId: id(12), keyVersion: 1, attestation: '0'.repeat(64), acceptedAt: at, expectedChainRevision: 1 },
  'create-recall': { tenantId: id(1), productLotCode: 'PUBLIC-LOT', reason: 'Public recall example', issuedAt: at },
  'quarantine-recall': { expectedRevision: 1 },
};
const deviceAuth = new Set(['read-device-config', 'acknowledge-config', 'ingest-telemetry']);
for (const op of contract.operations) {
  op.parameters = [...op.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: name === 'keyVersion' ? positive : uuid }));
  if (op.method === 'POST') op.parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1 } });
  if (op.id === 'verification-snapshot') op.parameters.push({ name: 'Authorization', in: 'header', required: true, schema: { type: 'string', pattern: '^Bearer .+$' } });
  if (deviceAuth.has(op.id)) {
    op.parameters.push(...[
      ['X-Device-Id', uuid], ['X-Device-Key-Version', positive], ['X-Device-Timestamp', instant], ['X-Device-Signature', { type: 'string', pattern: '^[0-9a-f]{64}$' }],
    ].map(([name, schema]) => ({ name, in: 'header', required: true, schema, transportError: { status: 401, code: 'INVALID_DEVICE_SIGNATURE' } })));
  }
  if (op.id === 'list-excursions') op.parameters.push(...Object.entries({ tenantId: uuid, shipmentId: uuid, kind: schemas.Excursion.properties.kind, state: schemas.Excursion.properties.state, limit: { ...positive, default: 50 }, cursor: text }).map(([name, schema]) => ({ name, in: 'query', required: false, schema })));
  const params = Object.fromEntries(op.parameters.filter(p => p.in === 'path').map(p => [p.name, p.name === 'keyVersion' ? 1 : id(3)]));
  const headers = Object.fromEntries(op.parameters.filter(p => p.in === 'header').map(p => [p.name, p.name === 'Authorization' ? 'Bearer ${ADMIN_TOKEN}' : p.name === 'Idempotency-Key' ? 'public-example-' + op.id : p.name === 'X-Device-Id' ? id(3) : p.name === 'X-Device-Key-Version' ? '1' : p.name === 'X-Device-Timestamp' ? at : '0'.repeat(64)]));
  op.example = { params, headers, ...(op.request ? { body: bodies[op.id] } : {}) };
}
contract.policyRevision = 'coldchaincontrol-2026-09-08.1';
contract.publicPolicy = { siteRadius: { earthRadiusMeters: 6371008.8, quantization: 'nearest-millimetre-half-up', boundary: 'inclusive', tieBreak: 'distance-then-siteId' }, notification: { windowSeconds: 60, tenantBudget: 'minimum-active-policy', maxAttempts: 6, retryDelaysSeconds: [1, 2, 4, 8, 16] }, barrierPoints: ['worker.claimed', 'worker.before-commit', 'worker.after-attempt', 'dispatcher.response-received'] };
contract.notes.push(readFileSync(new URL('./coldchaincontrol-policy.md', import.meta.url), 'utf8'));
export default contract;
