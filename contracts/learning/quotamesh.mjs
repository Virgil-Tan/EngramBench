import { ref, obj, arr, one, nil, str, text, int, count, positive, range, uuid, time, en, without, page, op, paging, manager, T, id, key, environmentVariables, commands, commonSchemas, snapshot, seedSchema, infra, observe, basicSmoke, seedSmoke, commonNotes } from './helpers-a2.mjs';

const dimensionName = { type: 'string', pattern: '^[a-z][a-zA-Z0-9]{0,31}$' };
const vector = (minimum) => ({ type: 'object', minProperties: 1, ...(minimum > 0 && { maxProperties: 20 }), propertyNames: dimensionName, additionalProperties: { ...count, minimum } });
const capacity = vector(0), quantities = vector(1);
const schemas = {
  ...commonSchemas(['RESERVATION_EXPIRY', 'ADMISSION_PROMOTION'], ['reservation.held', 'reservation.committed', 'reservation.released', 'reservation.expired', 'admission.promoted']),
  Dimension: obj({ name: dimensionName, unit: text }),
  QuotaPool: obj({ poolId: uuid, tenantId: uuid, name: text, capacity, held: capacity, committed: capacity, revision: count }),
  LegacyReservation: obj({ reservationId: uuid, poolId: uuid, ownerId: uuid, quantities, state: en('HELD', 'COMMITTED', 'RELEASED', 'EXPIRED'), expiresAt: time, createdAt: time, terminalAt: nil(time), sequence: count }),
  LegacyCommitment: obj({ commitmentId: uuid, reservationId: uuid, poolId: uuid, ownerId: uuid, quantities, committedAt: time, releasedAt: nil(time) }),
  LegacyAdmissionEntry: obj({ admissionEntryId: uuid, poolId: uuid, ownerId: uuid, quantities, priority: int, state: en('WAITING', 'PROMOTED', 'WITHDRAWN'), requestedAt: time, reservationId: nil(uuid), position: nil(positive) }),
  QuotaOrganization: obj({ organizationId: uuid, tenantId: uuid, name: text, capacity, allocated: capacity, held: capacity, committed: capacity, revision: count }),
  QuotaProject: obj({ projectId: uuid, organizationId: uuid, name: text, allocation: capacity, held: capacity, committed: capacity, revision: count }),
};
for (const name of ['Reservation', 'Commitment', 'AdmissionEntry']) schemas[name] = obj({ ...schemas[`Legacy${name}`].properties, poolId: nil(uuid), organizationId: uuid, projectId: uuid });
schemas.SeedPool = obj({ poolId: uuid, tenantId: uuid, name: text, capacity });
schemas.SeedAdmissionEntry = without(schemas.LegacyAdmissionEntry, ['position']);
schemas.Seed = seedSchema({ dimensions: 'Dimension', quotaPools: 'SeedPool', commitments: 'LegacyCommitment', reservations: 'LegacyReservation', admissionQueue: 'SeedAdmissionEntry' });
schemas.VerificationSnapshot = snapshot({ dimensions: 'Dimension', quotaPools: 'QuotaPool', reservations: 'Reservation', commitments: 'Commitment', admissionEntries: 'AdmissionEntry', quotaOrganizations: 'QuotaOrganization', quotaProjects: 'QuotaProject' });
const poolId = id(51), tenantId = id(52), ownerId = id(53), reservationId = id(54), commitmentId = id(55), organizationId = id(56), projectId = id(57);
const amounts = { cpuMillis: 2, memoryMiB: 4 }, capacities = { cpuMillis: 100, memoryMiB: 200 };
const reservation = { reservationId, poolId, ownerId, quantities: amounts, state: 'COMMITTED', expiresAt: '2026-09-07T00:05:00.000Z', createdAt: T, terminalAt: T, sequence: 2 };
const holdRequest = obj({ ownerId: uuid, quantities, ttlSeconds: range(1, 3600) });
const holdBody = { ownerId, quantities: amounts, ttlSeconds: 300 };
const poolBody = { tenantId, name: 'Independent Public Organization', capacity: capacities };
const hierarchyParams = { organizationId, projectId };
export default {
  taskId: 'quotamesh', title: 'QuotaMesh', environmentVariables, commands,
  seed: { schema: schemas.Seed, example: { schemaVersion: 1, seedVersion: 'v2-public-quotamesh-1', dimensions: [{ name: 'cpuMillis', unit: 'millisecond' }, { name: 'memoryMiB', unit: 'MiB' }], quotaPools: [{ poolId, tenantId, name: 'Public Seed Pool', capacity: capacities }], reservations: [reservation], commitments: [{ commitmentId, reservationId, poolId, ownerId, quantities: amounts, committedAt: T, releasedAt: null }], admissionQueue: [] } }, schemas,
  operations: [
    ...infra(),
    op('list-reservations', 'GET', '/api/v1/reservations', 200, page(ref('Reservation')), undefined, { query: { limit: 20 } }, { parameters: paging }),
    op('read-reservation', 'GET', '/api/v1/reservations/:reservationId', 200, ref('Reservation'), undefined, { params: { reservationId } }),
    op('create-pool-reservation', 'POST', '/api/v1/quota-pools/:poolId/reservations', 201, ref('LegacyReservation'), holdRequest, { params: { poolId }, body: holdBody }),
    op('create-quota-pool', 'POST', '/api/v1/quota-pools', 201, ref('QuotaPool'), obj({ tenantId: uuid, name: text, capacity }), { body: { ...poolBody, name: 'Independent Public Pool' } }),
    op('commit-reservation', 'POST', '/api/v1/reservations/:reservationId/commit', 200, ref('Commitment'), obj({}), { params: { reservationId }, body: {} }),
    op('release-reservation', 'POST', '/api/v1/reservations/:reservationId/release', 200, ref('Reservation'), obj({ reason: text }), { params: { reservationId }, body: { reason: 'Release unused capacity' } }),
    op('join-admission-queue', 'POST', '/api/v1/admission-queue', 200, ref('AdmissionEntry'), one(obj({ poolId: uuid, ownerId: uuid, quantities, priority: int }), obj({ organizationId: uuid, projectId: uuid, ownerId: uuid, quantities, priority: int })), { body: { organizationId, projectId, ownerId, quantities: amounts, priority: 5 } }, { source: manager }),
    op('read-quota-pool', 'GET', '/api/v1/quota-pools/:poolId', 200, ref('QuotaPool'), undefined, { params: { poolId } }),
    op('pool-admission-queue', 'GET', '/api/v1/quota-pools/:poolId/admission-queue', 200, obj({ items: arr(ref('LegacyAdmissionEntry')) }), undefined, { params: { poolId } }),
    op('create-quota-organization', 'POST', '/api/v1/quota-organizations', 201, ref('QuotaOrganization'), obj({ tenantId: uuid, name: text, capacity }), { body: poolBody }, { source: manager }),
    op('create-quota-project', 'POST', '/api/v1/quota-organizations/:organizationId/projects', 201, ref('QuotaProject'), obj({ name: text, allocation: capacity }), { params: { organizationId }, body: { name: 'Public Project', allocation: { cpuMillis: 50, memoryMiB: 100 } } }, { source: manager }),
    op('create-project-reservation', 'POST', '/api/v1/quota-organizations/:organizationId/projects/:projectId/reservations', 200, ref('Reservation'), holdRequest, { params: hierarchyParams, body: holdBody }, { source: manager }),
    op('change-organization-capacity', 'PUT', '/api/v1/quota-organizations/:organizationId/capacity', 200, ref('QuotaOrganization'), obj({ capacity, expectedRevision: count }), { params: { organizationId }, body: { capacity: { cpuMillis: 200, memoryMiB: 400 }, expectedRevision: 1 } }, { source: manager }),
    op('change-project-allocation', 'PUT', '/api/v1/quota-organizations/:organizationId/projects/:projectId/allocation', 200, ref('QuotaProject'), obj({ allocation: capacity, expectedOrganizationRevision: count, expectedProjectRevision: count }), { params: hierarchyParams, body: { allocation: { cpuMillis: 60, memoryMiB: 120 }, expectedOrganizationRevision: 1, expectedProjectRevision: 1 } }, { source: manager }),
    op('read-quota-organization', 'GET', '/api/v1/quota-organizations/:organizationId', 200, ref('QuotaOrganization'), undefined, { params: { organizationId } }, { source: manager }),
    op('read-quota-project', 'GET', '/api/v1/quota-organizations/:organizationId/projects/:projectId', 200, ref('QuotaProject'), undefined, { params: hierarchyParams }, { source: manager }),
    ...observe(),
  ],
  smoke: [
    ...basicSmoke,
    seedSmoke({ dimensions: [{ name: 'cpuMillis' }, { name: 'memoryMiB' }], quotaPools: [{ poolId, capacity: capacities, held: { cpuMillis: 0, memoryMiB: 0 }, committed: amounts }], reservations: [{ reservationId, poolId, state: 'COMMITTED' }], commitments: [{ commitmentId, reservationId, poolId, quantities: amounts }] }),
    { operationId: 'create-quota-organization', body: poolBody, headers: key('create-quota-organization'), expectStatus: 201, expectBody: { ...poolBody, allocated: { cpuMillis: 0, memoryMiB: 0 }, held: { cpuMillis: 0, memoryMiB: 0 }, committed: { cpuMillis: 0, memoryMiB: 0 } }, capture: { createdOrganization: ['organizationId'] } },
    { operationId: 'read-quota-organization', params: { organizationId: '${createdOrganization}' }, expectStatus: 200, expectBody: { organizationId: '${createdOrganization}', ...poolBody, allocated: { cpuMillis: 0, memoryMiB: 0 } } },
  ],
  notes: [...commonNotes,
    'V2 wire clarification: direct Reservation detail/list, commit/release and admission creation expose the Manager fields. Routes under /quota-pools retain their explicitly promised V1 projection; their create returns LegacyReservation and admission list returns {items:[LegacyAdmissionEntry]}. Saved pre-upgrade replay bodies are unchanged.',
    'V2 wire clarification: unpaginated pool admission reads use {items:[AdmissionEntry]} without a cursor because the original publishes no query parameters. Every entry has its derived position; hierarchy identities are omitted from this legacy pool projection only.',
    'V2 wire clarification: new project-reservation creation uses 200 under the Manager default-status rule, while the original flat reservation route remains 201. Organization capacity changes return QuotaOrganization; Project allocation changes return QuotaProject; use separate GET Organization for its updated totals.',
    'The V1 seed imports two Dimensions, one flat Pool and a linked COMMITTED Reservation/Commitment. Manager migration adds a stable Organization/default Project without changing original IDs or balances. Their generated IDs are not prescribed by the original text and the smoke does not guess them.',
    'Capacity maps use declared dimension names and nonnegative safe integers; reservation quantities have 1..20 strictly positive entries. The contract does not silently clamp priority, which was only specified as a safe integer. Revision initial values and migration UUID algorithms must be documented; no hidden initialization is assumed.',
  ],
};
