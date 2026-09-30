// Public README and Manager only. Historical submissions and their adapters are not authority.
import { finish, record, obj, ref, list, nullable, text, name, uuid, int, pos, time, page, pagination, query, operation as op, domainEventsOperation, detailedTransportErrors, id, idem, admin, snapshotSmoke } from '../learning/helpers-b.mjs';
const uid = n => id(103, n), at = '2026-01-01T00:00:00.000Z', start = '2099-01-01T00:00:00.000Z', end = '2099-01-01T01:00:00.000Z';
const schemas = {
  CapacityOwner: record('ownerId:uuid name:string'),
  CapacityPool: record('poolId:uuid name:string capacityUnits:pos revision:pos'),
  LegacyCapacityLease: record('leaseId:uuid poolId:uuid ownerId:uuid startAt:timestamp endAt:timestamp units:pos priority:int state:HELD|CONFIRMED|ACTIVE|RELEASED|EXPIRED holdExpiresAt:timestamp|null revision:pos createdAt:timestamp terminalAt:timestamp|null sequence:nat'),
  AdmissionEntry: record('admissionEntryId:uuid poolId:uuid ownerId:uuid startAt:timestamp endAt:timestamp units:pos priority:int state:WAITING|PROMOTED|CANCELLED promotedLeaseId:uuid|null requestedAt:timestamp terminalAt:timestamp|null'),
  CapacitySlice: record('poolId:uuid startAt:timestamp endAt:timestamp capacityUnits:pos heldUnits:nat confirmedUnits:nat activeUnits:nat availableUnits:nat'),
  GangLeaseMember: record('memberId:uuid leaseId:uuid ordinal:pos poolId:uuid units:pos'),
};
const memberInput = obj({ poolId: uuid, units: int });
schemas.CapacityLease = obj({ ...schemas.LegacyCapacityLease.properties, poolId: nullable(uuid), units: nullable(pos), members: list(ref('GangLeaseMember'), { minItems: 1, maxItems: 10 }) });
schemas.LeaseResponse = { anyOf: [ref('LegacyCapacityLease'), ref('CapacityLease')] };
schemas.HeldLease = { anyOf: [obj({ ...schemas.LegacyCapacityLease.properties, holdToken: name }), obj({ ...schemas.CapacityLease.properties, holdToken: name })] };
schemas.GangAdmissionEntry = obj({ ...schemas.AdmissionEntry.properties, poolId: { type: 'null' }, units: { type: 'null' }, members: list(obj({ poolId: uuid, units: pos }), { minItems: 2, maxItems: 10 }) });
schemas.AdmissionResponse = { anyOf: [ref('AdmissionEntry'), ref('GangAdmissionEntry')] };
// Keep named INVALID_LEASE_INTERVAL / INVALID_GANG_MEMBERS business checks reachable.
schemas.CreateLease = obj({ poolId: uuid, units: int, members: list(memberInput), ownerId: uuid, startAt: time, endAt: time, priority: int, allowWait: { type: 'boolean' }, holdSeconds: int }, ['ownerId', 'startAt', 'endAt', 'priority', 'allowWait']);
const createBody = { members: [{ poolId: uid(2), units: 2 }, { poolId: uid(3), units: 2 }], ownerId: uid(1), startAt: start, endAt: end, priority: 0, allowWait: false, holdSeconds: 120 };
const seedTypes = { owners: 'CapacityOwner', capacityPools: 'CapacityPool', capacityLeases: 'LegacyCapacityLease', admissionEntries: 'AdmissionEntry', capacitySlices: 'CapacitySlice' };
const operations = [
  op('list-leases', 'GET', '/api/v1/capacityLeases', null, page(ref('LeaseResponse')), { parameters: pagination }),
  op('read-lease-legacy-path', 'GET', '/api/v1/capacityLeases/:capacityLeaseId', null, ref('LeaseResponse')),
  op('create-lease', 'POST', '/api/v1/capacity-leases', ref('CreateLease'), ref('HeldLease'), { status: 201, successStatuses: [201, 202], successResponses: { 202: { response: ref('AdmissionResponse') } }, example: { body: createBody } }),
  op('confirm-lease', 'POST', '/api/v1/capacity-leases/:leaseId/confirm', obj({ holdToken: name, expectedRevision: int }), ref('LeaseResponse'), { example: { body: { holdToken: 'public-example-hold-fence', expectedRevision: 1 } } }),
  op('renew-lease', 'POST', '/api/v1/capacity-leases/:leaseId/renew', obj({ expectedRevision: int, endAt: time }), ref('LeaseResponse'), { example: { body: { expectedRevision: 1, endAt: '2099-01-01T02:00:00.000Z' } } }),
  op('release-lease', 'POST', '/api/v1/capacity-leases/:leaseId/release', obj({ expectedRevision: int, reason: text }), ref('LeaseResponse'), { example: { body: { expectedRevision: 1, reason: 'Public early release' } } }),
  op('cancel-admission', 'DELETE', '/api/v1/admission-entries/:admissionEntryId', null, ref('AdmissionResponse'), { requestBody: 'none' }),
  op('pool-timeline', 'GET', '/api/v1/capacity-pools/:poolId/timeline', null, obj({ items: list(ref('CapacitySlice')) }), { parameters: [query('from', time, true), query('to', time, true)], example: { query: { from: start, to: end } } }),
  op('read-lease', 'GET', '/api/v1/capacity-leases/:leaseId', null, ref('LeaseResponse')),
  op('read-members', 'GET', '/api/v1/capacity-leases/:leaseId/members', null, obj({ items: list(ref('GangLeaseMember')) })),
  domainEventsOperation(),
];
const seedCheck = snapshotSmoke([['capacityPools', { poolId: uid(2), capacityUnits: 10 }], ['capacityLeases', { leaseId: uid(4), ownerId: uid(1), state: 'CONFIRMED', units: 2 }], ['capacitySlices', { poolId: uid(2), startAt: start, endAt: end, confirmedUnits: 2, availableUnits: 8 }]]);
seedCheck.capture = { publicClock: ['asOf'] };
const contract = finish({ taskId: 'capacitylease', title: 'CapacityLease', schemas, seedTypes, operations,
  resources: { ...seedTypes, capacityLeases: 'LeaseResponse', admissionEntries: 'AdmissionResponse', gangLeaseMembers: 'GangLeaseMember' },
  seedData: {
    owners: [{ ownerId: uid(1), name: 'Public capacity owner' }],
    capacityPools: [{ poolId: uid(2), name: 'Public pool A', capacityUnits: 10, revision: 1 }, { poolId: uid(3), name: 'Public pool B', capacityUnits: 10, revision: 1 }],
    capacityLeases: [{ leaseId: uid(4), poolId: uid(2), ownerId: uid(1), startAt: start, endAt: end, units: 2, priority: 0, state: 'CONFIRMED', holdExpiresAt: null, revision: 1, createdAt: at, terminalAt: null, sequence: 0 }],
    capacitySlices: [{ poolId: uid(2), startAt: start, endAt: end, capacityUnits: 10, heldUnits: 0, confirmedUnits: 2, activeUnits: 0, availableUnits: 8 }],
  },
  workKinds: ['LEASE_EXPIRY', 'ADMISSION_PROMOTION'], eventTypes: ['lease.held', 'lease.confirmed', 'lease.renewed', 'lease.released', 'lease.expired', 'admission.promoted'], emptyEventPayload: true,
  transportErrors: detailedTransportErrors, environmentVariables: ['CHROMIUM_PATH', 'MANAGED_DATA_ROOT'],
  smoke: [seedCheck,
    { operationId: 'create-lease', body: { ...createBody, startAt: '${publicClock+3600000ms}', endAt: '${publicClock+7200000ms}' }, headers: idem('gang-create'), expectStatus: 201, expectBody: { state: 'HELD', poolId: null, units: null }, capture: { createdLeaseId: ['leaseId'], createdHoldToken: ['holdToken'], createdRevision: ['revision'] } },
    { operationId: 'read-members', params: { leaseId: '${createdLeaseId}' }, expectStatus: 200, expectContains: [{ path: ['items'], match: { leaseId: '${createdLeaseId}', ordinal: 1, poolId: uid(2), units: 2 } }, { path: ['items'], match: { leaseId: '${createdLeaseId}', ordinal: 2, poolId: uid(3), units: 2 } }] },
    { operationId: 'confirm-lease', params: { leaseId: '${createdLeaseId}' }, body: { holdToken: '${createdHoldToken}', expectedRevision: '${createdRevision}' }, headers: idem('gang-confirm'), expectStatus: 200, expectBody: { leaseId: '${createdLeaseId}', state: 'CONFIRMED' } },
    { operationId: 'read-lease', params: { leaseId: '${createdLeaseId}' }, expectStatus: 200, expectBody: { leaseId: '${createdLeaseId}', state: 'CONFIRMED', poolId: null, units: null }, expectContains: [{ path: ['members'], match: { leaseId: '${createdLeaseId}', poolId: uid(2), units: 2 } }, { path: ['members'], match: { leaseId: '${createdLeaseId}', poolId: uid(3), units: 2 } }] },
    { operationId: 'verification-snapshot', headers: admin, expectStatus: 200, expectContains: [{ path: ['resources', 'capacityLeases'], match: { leaseId: '${createdLeaseId}', state: 'CONFIRMED' } }, { path: ['resources', 'gangLeaseMembers'], match: { leaseId: '${createdLeaseId}', poolId: uid(3), units: 2 } }] },
    { operationId: 'create-lease', body: { ...createBody, startAt: '${publicClock+3600000ms}', endAt: '${publicClock+7200000ms}', unknown: true }, headers: idem('gang-unknown'), expectStatus: 400, expectBody: { error: { code: 'UNKNOWN_FIELD' } } },
  ],
  notes: [
    'V2 wire clarification: the literally documented camelCase collection/detail read paths and kebab-case detail path remain available. The bounded Pool timeline returns {items:[CapacitySlice]} in startAt order and accepts exactly from/to; it does not invent cursor paging for a fixed interval.',
    'Successful Hold creation is a top-level Lease with holdToken, never a wrapper; confirm/renew/release and detail never expose holdToken. Closed legacy responses remain valid for one-Pool clients and saved replay. Manager Lease responses add immutable members; multi-Pool poolId and units are null.',
    'V2 wire clarification: a WAITING Gang Admission Entry is the AdmissionEntry with poolId:null,units:null,members:[{poolId,units}] in poolId order. It preserves owner, interval, priority, requestedAt, state, promotedLeaseId and terminalAt. This publishes captured admission wire only; atomic admission and promotion remain business work.',
    'Create must choose legacy poolId+units or 2..10 members, never both. INVALID_GANG_MEMBERS and INVALID_LEASE_INTERVAL govern member/count/sign/mixed-field and cross-time validity after wire type checks. holdSeconds defaults to 120 at the business boundary and must be 1..120; no default is silently added to the idempotency fingerprint by the scaffold.',
    'The exact V1 seed links an Owner, two Pools, one stable confirmed one-Pool Lease and its conserved CapacitySlice. Manager migration creates one matching member; Manager-only seed collections remain forbidden.',
    'Public smoke derives start/end from snapshot.asOf so start is after the Hold expiry and duration remains below thirty days. Gang locks, all-or-none transitions, overlap ordering, Work fences, migration, UI and unchanged performance thresholds remain implementation obligations.',
  ],
});
contract.httpHost = '127.0.0.1'; contract.seed.replay = true;
contract.schemas.Error.properties.error.properties.details = obj({});
for (const operation of contract.operations) {
  if (operation.id === 'domain-events') for (const parameter of operation.parameters ?? []) if (parameter.name === 'aggregateId') parameter.required = false;
  operation.source = 'docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification)';
  operation.errors = Object.fromEntries([400, 401, 404, 409, 415].map(status => [status, ref('Error')]));
}
contract.schemas.Error.properties.error.properties.code.examples = ['INVALID_LEASE_INTERVAL', 'CAPACITY_UNAVAILABLE', 'HOLD_EXPIRED', 'LEASE_REVISION_CHANGED', 'LEASE_NOT_RELEASABLE', 'INVALID_GANG_MEMBERS', 'GANG_CAPACITY_UNAVAILABLE', 'GANG_STATE_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_CURSOR'];
contract.operations.find(operation => operation.id === 'create-lease').bodyTransportErrors = [
  {
    "path": "/units",
    "when": "unsafe_integer",
    "status": 400,
    "code": "INVALID_LEASE_INTERVAL"
  },
  {
    "path": "/priority",
    "when": "unsafe_integer",
    "status": 400,
    "code": "INVALID_LEASE_INTERVAL"
  },
  {
    "path": "/members/*/units",
    "when": "unsafe_integer",
    "status": 400,
    "code": "INVALID_GANG_MEMBERS"
  }
];
export default contract;
