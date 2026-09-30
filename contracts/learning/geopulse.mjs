import { ref, str, name, uuid, time, int, nat, pos, bool, nullable, list, obj, enumeration as en, page, pick, T, uid, basic, work, event, seedShape, snapshotShape, operation as op, standardOps, commands, environmentVariables, keyed, admin, source, manager, wire, pagination, sharedNotes } from './helpers-a.mjs';

const tenantId = uid(3, 1), deviceId = uid(3, 2), regionId = uid(3, 3), regionVersionId = uid(3, 4), bundleId = uid(3, 5), bundleRevisionId = uid(3, 6);
const longitude = { type: 'number', minimum: -180, maximum: 180, multipleOf: 0.000001 };
const latitude = { type: 'number', minimum: -90, maximum: 90, multipleOf: 0.000001 };
const pair = { type: 'array', prefixItems: [longitude, latitude], items: false, minItems: 2, maxItems: 2 };
const polygon = list(pair, { minItems: 4, maxItems: 10001 });
const schemas = {
  ...basic,
  Device: obj({ deviceId: uuid, tenantId: uuid, externalRef: name, createdAt: time }),
  Region: obj({ regionId: uuid, tenantId: uuid, name, createdAt: time }),
  RegionVersion: obj({ regionVersionId: uuid, regionId: uuid, tenantId: uuid, revision: pos, effectiveFrom: time, effectiveTo: nullable(time), polygon, boundaryToleranceMeters: nat, dwellSeconds: nat, createdAt: time }),
  LocationEvent: obj({ eventId: uuid, tenantId: uuid, deviceId: uuid, deviceSequence: pos, observedAt: time, receivedAt: time, longitude, latitude, accuracyMeters: nat, bundleRevisionId: nullable(uuid) }),
  Membership: obj({ tenantId: uuid, deviceId: uuid, regionId: uuid, regionVersionId: uuid, state: en('OUTSIDE', 'INSIDE', 'BOUNDARY'), enteredAt: nullable(time), lastObservedAt: time, lastDeviceSequence: pos, watermark: time, revision: pos, bundleRevisionId: nullable(uuid) }),
  Transition: obj({ transitionId: uuid, tenantId: uuid, deviceId: uuid, regionId: uuid, regionVersionId: uuid, type: en('ENTER', 'EXIT', 'DWELL'), observedAt: time, sourceEventId: uuid, sequence: pos, bundleRevisionId: nullable(uuid) }),
  RegionBundle: obj({ bundleId: uuid, tenantId: uuid, name, currentRevision: nat, currentBundleRevisionId: nullable(uuid), createdAt: time }),
  RegionBundleRevision: obj({ bundleRevisionId: uuid, bundleId: uuid, tenantId: uuid, revision: pos, regionVersionIds: list(uuid, { minItems: 1, maxItems: 10000, uniqueItems: true }), effectiveFrom: time, createdAt: time }),
  PointQuery: obj({ queryId: str, longitude, latitude, at: time }),
  QueryResult: obj({ bundleRevisionId: nullable(uuid), items: list(obj({ queryId: str, matches: list(obj({ regionId: uuid, regionVersionId: uuid })) })) }),
  Work: work(['LOCATION_EVALUATION', 'LATE_REPLAY', 'BUNDLE_REEVALUATION']),
  DomainEvent: event(['location.accepted', 'membership.entered', 'membership.exited', 'membership.dwelled', 'location.late_ignored', 'region_bundle.published', 'region_bundle.rolled_back'], obj({ eventId: uuid, deviceId: uuid, regionId: uuid, regionVersionId: uuid, bundleId: uuid, bundleRevisionId: nullable(uuid), transitionId: uuid, revision: pos }, [])),
};
schemas.CreateRegionVersion = pick(schemas.RegionVersion, ['effectiveFrom', 'effectiveTo', 'polygon', 'boundaryToleranceMeters', 'dwellSeconds']);
schemas.IngestEvent = obj({ ...pick(schemas.LocationEvent, ['eventId', 'tenantId', 'deviceId', 'deviceSequence', 'observedAt', 'longitude', 'latitude', 'accuracyMeters']).properties, bundleId: uuid }, ['eventId', 'tenantId', 'deviceId', 'deviceSequence', 'observedAt', 'longitude', 'latitude', 'accuracyMeters']);
schemas.RegionRead = obj({ ...schemas.Region.properties, versions: list(ref('RegionVersion')) });
const collections = Object.fromEntries(Object.entries({ tenants: 'Tenant', devices: 'Device', regions: 'Region', regionVersions: 'RegionVersion', locationEvents: 'LocationEvent', memberships: 'Membership', transitions: 'Transition', regionBundles: 'RegionBundle', regionBundleRevisions: 'RegionBundleRevision' }).map(([key, type]) => [key, list(ref(type))]));
schemas.Snapshot = snapshotShape(collections);
const square = [[10, 20], [11, 20], [11, 21], [10, 21], [10, 20]];
const seed = {
  schema: seedShape(collections),
  example: { schemaVersion: 1, seedVersion: 'geopulse-public-v2-1', importedAt: T, tenants: [{ tenantId, name: 'Public Cartography' }], devices: [{ deviceId, tenantId, externalRef: 'public-device', createdAt: T }], regions: [{ regionId, tenantId, name: 'Public Square', createdAt: T }], regionVersions: [{ regionVersionId, regionId, tenantId, revision: 1, effectiveFrom: T, effectiveTo: null, polygon: square, boundaryToleranceMeters: 0, dwellSeconds: 30, createdAt: T }], locationEvents: [], memberships: [], transitions: [], regionBundles: [{ bundleId, tenantId, name: 'Public Atlas', currentRevision: 1, currentBundleRevisionId: bundleRevisionId, createdAt: T }], regionBundleRevisions: [{ bundleRevisionId, bundleId, tenantId, revision: 1, regionVersionIds: [regionVersionId], effectiveFrom: T, createdAt: T }] },
};
const ingest = { eventId: uid(3, 10), tenantId, deviceId, deviceSequence: 1, observedAt: T, longitude: 10.5, latitude: 20.5, accuracyMeters: 0, bundleId };
const operations = [
  op('createTenant', 'POST', '/api/v1/tenants', obj({ name }), ref('Tenant'), { body: { name: 'Public Tenant' }, headers: keyed('geo-example-tenant') }),
  op('createDevice', 'POST', '/api/v1/devices', obj({ tenantId: uuid, externalRef: name }), ref('Device'), { body: { tenantId, externalRef: 'new-device' }, headers: keyed('geo-example-device') }),
  op('createRegion', 'POST', '/api/v1/regions', obj({ tenantId: uuid, name }), ref('Region'), { body: { tenantId, name: 'Second Public Region' }, headers: keyed('geo-example-region') }),
  op('createRegionVersion', 'POST', '/api/v1/regions/:regionId/versions', ref('CreateRegionVersion'), ref('RegionVersion'), { params: { regionId }, body: { effectiveFrom: '2032-01-01T00:00:00.000Z', effectiveTo: null, polygon: square, boundaryToleranceMeters: 1, dwellSeconds: 60 }, headers: keyed('geo-example-version') }, source('Domain and invariants')),
  op('getRegion', 'GET', '/api/v1/regions/:regionId', null, ref('RegionRead'), { params: { regionId } }),
  op('ingestEvent', 'POST', '/api/v1/location-events', ref('IngestEvent'), ref('LocationEvent'), { body: ingest, headers: keyed('geo-example-event') }, source('Required behavior and HTTP surface')),
  op('ingestBatch', 'POST', '/api/v1/location-events/batch', obj({ events: list(ref('IngestEvent'), { minItems: 1, maxItems: 10000 }) }), page(ref('LocationEvent')), { body: { events: [ingest] }, headers: keyed('geo-example-batch') }),
  op('getMemberships', 'GET', '/api/v1/devices/:deviceId/memberships', null, page(ref('Membership')), { params: { deviceId }, query: { limit: 20 } }, source('Required behavior and HTTP surface'), pagination),
  op('getTransitions', 'GET', '/api/v1/devices/:deviceId/transitions', null, page(ref('Transition')), { params: { deviceId }, query: { limit: 20 } }, source('Required behavior and HTTP surface'), pagination),
  op('queryRegions', 'POST', '/api/v1/regions/query', obj({ tenantId: uuid, points: list(ref('PointQuery'), { minItems: 1, maxItems: 10000 }), bundleId: uuid }, ['tenantId', 'points']), ref('QueryResult'), { body: { tenantId, bundleId, points: [{ queryId: 'public-interior', longitude: 10.5, latitude: 20.5, at: T }] }, headers: keyed('geo-example-query') }, manager),
  op('createBundle', 'POST', '/api/v1/region-bundles', obj({ tenantId: uuid, name }), obj({ bundle: ref('RegionBundle') }), { body: { tenantId, name: 'Public Composition' }, headers: keyed('geo-example-bundle') }, manager),
  op('publishBundle', 'POST', '/api/v1/region-bundles/:bundleId/publish', obj({ expectedRevision: nat, effectiveFrom: time, regionVersionIds: list(uuid, { minItems: 1, maxItems: 10000 }) }), obj({ bundle: ref('RegionBundle'), revision: ref('RegionBundleRevision') }), { params: { bundleId }, body: { expectedRevision: 1, effectiveFrom: '2032-01-01T00:00:00.000Z', regionVersionIds: [regionVersionId] }, headers: keyed('geo-example-publish') }, manager),
  op('rollbackBundle', 'POST', '/api/v1/region-bundles/:bundleId/rollback', obj({ expectedRevision: nat, targetRevision: pos, effectiveFrom: time }), obj({ bundle: ref('RegionBundle'), revision: ref('RegionBundleRevision') }), { params: { bundleId }, body: { expectedRevision: 1, targetRevision: 1, effectiveFrom: '2032-02-01T00:00:00.000Z' }, headers: keyed('geo-example-rollback') }, manager),
  op('getBundle', 'GET', '/api/v1/region-bundles/:bundleId', null, obj({ bundle: ref('RegionBundle'), revisions: list(ref('RegionBundleRevision')) }), { params: { bundleId } }, manager),
  ...standardOps(),
];
export default {
  taskId: 'geopulse', title: 'GeoPulse', environmentVariables, commands, seed, schemas, operations,
  smoke: [
    { operationId: 'snapshot', headers: admin, expectContains: [{ path: ['resources', 'devices'], match: { deviceId, tenantId } }, { path: ['resources', 'regionVersions'], match: { regionVersionId, polygon: square } }, { path: ['resources', 'regionBundleRevisions'], match: { bundleRevisionId, regionVersionIds: [regionVersionId] } }] },
    { operationId: 'getRegion', params: { regionId }, expectBody: { regionId, tenantId, name: 'Public Square' }, expectContains: [{ path: ['versions'], match: { regionVersionId, revision: 1 } }] },
    { operationId: 'queryRegions', body: { tenantId, bundleId, points: [{ queryId: 'public-interior', longitude: 10.5, latitude: 20.5, at: T }] }, headers: keyed('geo-smoke-query'), expectBody: { bundleRevisionId, items: [{ queryId: 'public-interior', matches: [{ regionId, regionVersionId }] }] } },
    { operationId: 'createRegion', body: { tenantId, name: 'Smoke Created Region' }, headers: keyed('geo-smoke-create'), capture: { newRegionId: ['regionId'] }, expectBody: { tenantId, name: 'Smoke Created Region' } },
    { operationId: 'getRegion', params: { regionId: '${newRegionId}' }, expectBody: { regionId: '${newRegionId}', tenantId, name: 'Smoke Created Region', versions: [] } },
    { operationId: 'createTenant', body: { name: 'Smoke Legacy Spatial Tenant' }, headers: keyed('geo-smoke-legacy-tenant'), capture: { legacyTenantId: ['tenantId'] } },
    { operationId: 'createRegion', body: { tenantId: '${legacyTenantId}', name: 'Smoke Legacy Square' }, headers: keyed('geo-smoke-legacy-region'), capture: { legacyRegionId: ['regionId'] } },
    { operationId: 'createRegionVersion', params: { regionId: '${legacyRegionId}' }, body: { effectiveFrom: T, effectiveTo: null, polygon: square, boundaryToleranceMeters: 0, dwellSeconds: 30 }, headers: keyed('geo-smoke-legacy-version'), capture: { legacyVersionId: ['regionVersionId'] }, expectBody: { revision: 1 } },
    { operationId: 'queryRegions', body: { tenantId: '${legacyTenantId}', points: [{ queryId: 'public-v1-interior', longitude: 10.5, latitude: 20.5, at: T }] }, headers: keyed('geo-smoke-legacy-query'), expectBody: { bundleRevisionId: null, items: [{ queryId: 'public-v1-interior', matches: [{ regionId: '${legacyRegionId}', regionVersionId: '${legacyVersionId}' }] }] } },
  ],
  notes: [...sharedNotes,
    'Final-system evaluation policy learning-final-system-2026-09-08.1: when TEST_BARRIER_URL and TEST_BARRIER_TOKEN are set for tests, a Worker POSTs to that URL after its Work claim is durably LEASED and before performing the claimed business effect. The request has Content-Type:application/json and X-Test-Barrier-Token equal to TEST_BARRIER_TOKEN. Its closed JSON is {point:"worker.claimed",workId:uuid,kind:LOCATION_EVALUATION|LATE_REPLAY|BUNDLE_REEVALUATION,aggregateId:uuid}; IDs and kind match the public Work row. The Worker waits for HTTP 204 before continuing; a held response permits SIGKILL/replacement observation. This optional test control is disabled when those variables are absent and does not prescribe tables, locks or implementation architecture. It adds observability only and is not retroactive authority to penalize submissions frozen before this revision.',
    'V2 wire clarification: Device adds externalRef and createdAt; Region adds createdAt. Region GET is the Region fields plus versions sorted by revision. Version creation assigns revision monotonically; effectiveTo is explicit null for an open interval. Batch input is {events:[...]}; response is {items,nextCursor:null} in input order.',
    'V2 wire clarification: seed adds regionBundles and regionBundleRevisions, and event/membership/transition expose nullable bundleRevisionId. The example includes an independent tenant/device/region/version/bundle graph, not a private test fixture.',
    'V2 selection clarification: query and event input may specify bundleId. Without it, no published bundle uses the original V1 active RegionVersions at observedAt/point.at and returns bundleRevisionId:null; exactly one published tenant bundle selects it; multiple published bundles require explicit bundleId and otherwise return INVALID_REQUEST. Explicit bundle selection must belong to tenant and have an active published revision. Frozen bundle membership does not waive RegionVersion effective-time validity. A point-query request may not span bundle publication boundaries: return INVALID_REQUEST rather than mix bundle revisions.',
    'Coordinates retain the original six-decimal constraint; schema multipleOf is a wire constraint, not permission to use floating-point boundary heuristics. Exact-edge BOUNDARY emits no transition. Point query matches inside and exact-boundary points; match arrays are sorted by (regionId,regionVersionId). This inclusion/sort convention is an explicit V2 wire clarification.',
    'No business or concurrency test is replaced: observedAt selection, late replay, hysteresis, DWELL, CAS, atomic batches and lease fencing remain original requirements. All 13 README routes and 4 Manager routes are declared.',
  ],
};
