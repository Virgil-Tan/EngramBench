import { ref, obj, arr, nil, str, text, count, positive, range, uuid, time, en, pick, without, page, op, q, paging, manager, wire, T, FUTURE, id, auth, key, admin, infra, basicSmoke, seedSmoke } from './helpers-a2.mjs';

const inputTime = { type: 'string', format: 'date-time' };
const outputTime = { type: 'string', format: 'date-time', pattern: 'Z$' };
const schemas = {
  Error: obj({ error: obj({ code: text, message: str, details: arr(obj({ field: str, message: str }, ['message'])) }) }),
  Health: obj({ status: { const: 'ok' } }),
  Event: obj({ id: uuid, slug: { type: 'string', minLength: 3, maxLength: 64, pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }, title: { ...text, maxLength: 120 }, startsAt: outputTime, capacity: range(1, 1000000), availableCapacity: range(0, 1000000), createdAt: outputTime }),
  Customer: obj({ id: uuid, displayName: text }),
  Hold: obj({ id: uuid, eventId: uuid, customerId: uuid, quantity: range(1, 4), status: en('PENDING', 'CONFIRMED', 'RELEASED', 'EXPIRED'), expiresAt: outputTime, createdAt: outputTime }),
  Order: obj({ id: uuid, eventId: uuid, customerId: uuid, holdId: nil(uuid), quantity: positive, confirmedAt: outputTime }),
  WaitlistEntry: obj({ id: uuid, eventId: uuid, customerId: uuid, quantity: range(1, 4), status: en('WAITING', 'PROMOTED', 'WITHDRAWN'), position: nil(positive), joinedAt: outputTime, holdId: nil(uuid) }),
};
schemas.WaitlistEntry.allOf = [
  { if: { properties: { status: { const: 'WAITING' } } }, then: { properties: { position: positive, holdId: { type: 'null' } } } },
  { if: { properties: { status: { const: 'PROMOTED' } } }, then: { properties: { position: { type: 'null' }, holdId: uuid } } },
  { if: { properties: { status: { const: 'WITHDRAWN' } } }, then: { properties: { position: { type: 'null' }, holdId: { type: 'null' } } } },
];
schemas.SeedEvent = obj({ ...pick(schemas.Event, ['id', 'slug', 'title', 'startsAt', 'capacity']).properties, startsAt: inputTime });
schemas.SeedOrder = obj({ ...without(schemas.Order, ['holdId']).properties, confirmedAt: inputTime });
schemas.Seed = obj({ schemaVersion: { const: 1 }, events: arr(ref('SeedEvent')), customers: arr(ref('Customer')), orders: arr(ref('SeedOrder')) });
schemas.VerificationSnapshot = obj({ asOf: outputTime, resources: obj({ events: arr(ref('Event')), customers: arr(ref('Customer')), holds: arr(ref('Hold')), orders: arr(ref('Order')), waitlistEntries: arr(ref('WaitlistEntry')) }) });
const eventId = id(11), customerId = id(12), historicalOrder = id(13), holdId = id(14);
const eventRequest = obj({ slug: schemas.Event.properties.slug, title: schemas.Event.properties.title, startsAt: inputTime, capacity: range(1, 1000000) });
const eventBody = { slug: 'independent-v2-event', title: 'Independent V2 Event', startsAt: FUTURE, capacity: 24 };
const pages = paging.map((p) => p.name === 'limit' ? { ...p, schema: { ...p.schema, default: 20 } } : p);
const operations = [
  ...infra().filter((o) => o.id !== 'health'),
  op('health', 'GET', '/api/health', 200, ref('Health')),
  op('create-event', 'POST', '/api/admin/events', 201, obj({ event: ref('Event') }), eventRequest, { body: eventBody, headers: auth }, { parameters: admin }),
  op('list-events', 'GET', '/api/events', 200, page(ref('Event')), undefined, { query: { limit: 20, q: 'public' } }, { parameters: [...pages, q('q', str)] }),
  op('read-event', 'GET', '/api/events/:eventId', 200, obj({ event: ref('Event') }), undefined, { params: { eventId } }, { source: wire }),
  op('create-hold', 'POST', '/api/holds', 201, obj({ hold: ref('Hold') }), obj({ eventId: uuid, customerId: uuid, quantity: range(1, 4) }), { body: { eventId, customerId, quantity: 1 } }),
  op('read-hold', 'GET', '/api/holds/:holdId', 200, obj({ hold: ref('Hold') }), undefined, { params: { holdId } }, { source: wire }),
  op('confirm-hold', 'POST', '/api/holds/:holdId/confirm', 200, obj({ hold: ref('Hold'), order: ref('Order') }), undefined, { params: { holdId } }),
  op('release-hold', 'DELETE', '/api/holds/:holdId', 200, obj({ hold: ref('Hold') }), undefined, { params: { holdId } }),
  op('customer-holds', 'GET', '/api/customers/:customerId/holds', 200, page(ref('Hold')), undefined, { params: { customerId }, query: { limit: 20 } }, { parameters: pages }),
  op('customer-orders', 'GET', '/api/customers/:customerId/orders', 200, page(ref('Order')), undefined, { params: { customerId }, query: { limit: 20 } }, { parameters: pages }),
  op('join-waitlist', 'POST', '/api/events/:eventId/waitlist', 201, obj({ waitlistEntry: ref('WaitlistEntry') }), obj({ customerId: uuid, quantity: range(1, 4) }), { params: { eventId }, body: { customerId, quantity: 2 } }, { source: manager }),
  op('read-waitlist', 'GET', '/api/events/:eventId/waitlist/:customerId', 200, obj({ waitlistEntry: ref('WaitlistEntry') }), undefined, { params: { eventId, customerId } }, { source: manager }),
  op('withdraw-waitlist', 'DELETE', '/api/events/:eventId/waitlist/:customerId', 200, obj({ waitlistEntry: ref('WaitlistEntry') }), undefined, { params: { eventId, customerId } }, { source: manager }),
  op('verification-snapshot', 'GET', '/api/verification-snapshot', 200, ref('VerificationSnapshot'), undefined, { headers: auth }, { source: wire, parameters: admin }),
];
for (const operation of operations) for (const parameter of operation.parameters) if (parameter.name === 'Idempotency-Key') parameter.schema = { type: 'string', minLength: 8, maxLength: 128, pattern: '^[\\x20-\\x7e]+$' };
export default {
  taskId: 'launchpass', title: 'LaunchPass', environmentVariables: ['DATABASE_URL', 'TEST_DATABASE_URL', 'PORT', 'ADMIN_TOKEN', 'HOLD_TTL_SECONDS', 'WAITLIST_HOLD_TTL_SECONDS'],
  commands: ['npm run db:migrate', 'npm run seed -- --file <path>', 'npm run dev', 'npm run build', 'npm start', 'npm test', ...['unit', 'integration', 'e2e', 'concurrency', 'all', 'perf'].map((s) => `npm run test:${s}`)],
  seed: { schema: schemas.Seed, replay: false, command: ['npm', 'run', 'seed', '--', '--file', '${SEED_PATH}'], example: { schemaVersion: 1, events: [{ id: eventId, slug: 'public-seed-event', title: 'Public Seed Event', startsAt: FUTURE, capacity: 20 }], customers: [{ id: customerId, displayName: 'Public Customer' }], orders: [{ id: historicalOrder, eventId, customerId, quantity: 2, confirmedAt: T }] } },
  schemas, operations,
  smoke: [
    ...basicSmoke,
    seedSmoke({ events: [{ id: eventId, capacity: 20, availableCapacity: 18 }], customers: [{ id: customerId }], orders: [{ id: historicalOrder, holdId: null, eventId, customerId, quantity: 2 }] }),
    { operationId: 'customer-orders', params: { customerId }, expectStatus: 200, expectContains: [{ path: ['items'], match: { id: historicalOrder, holdId: null } }] },
    { operationId: 'create-event', body: eventBody, headers: { ...auth, ...key('create-event') }, expectStatus: 201, expectBody: { event: { ...eventBody, availableCapacity: 24 } }, capture: { createdEvent: ['event', 'id'] } },
    { operationId: 'read-event', params: { eventId: '${createdEvent}' }, expectStatus: 200, expectBody: { event: { id: '${createdEvent}', ...eventBody, availableCapacity: 24 } } },
  ],
  notes: [
    'Authority is the complete original LaunchPass README plus the published waitlist Manager change; no private tests or submissions were read. Every original route and all three waitlist routes are fixed here.',
    'V2 wire clarification: GET event and hold detail use the same {event} and {hold} envelopes as their creation routes. Successful confirmation remains {hold,order}; release remains {hold}. Confirm, release and waitlist withdrawal have no request body.',
    'V2 adds GET /api/verification-snapshot, ADMIN_TOKEN protected, with exactly {asOf,resources:{events,customers,holds,orders,waitlistEntries}} and the typed resource shapes here. This is a new verification surface, not a claim that the original README published a snapshot.',
    'V2 clarification: Error.details contains {message,field?} objects, empty array allowed. Unknown resource errors are EVENT_NOT_FOUND, HOLD_NOT_FOUND, CUSTOMER_NOT_FOUND, ORDER_NOT_FOUND and WAITLIST_ENTRY_NOT_FOUND respectively; the original demanded specific stable names without spelling them out.',
    'The V1 seed remains exactly {schemaVersion,events,customers,orders}. It imports once into empty application tables; a second import must be rejected, not required as idempotent replay. Preserve the original npm run seed command. Seeded Event.createdAt uses the first import transaction time; historical Order.holdId is null and availableCapacity subtracts all imported quantities.',
    'No new customer-registration API is invented: the seed creates the customer. Waitlist joining requires insufficient available capacity and a quantity no greater than total capacity; its transport example does not bypass those state prerequisites.',
    'V2 exposes /openapi.json for the fixed scaffold in addition to the required workspace openapi.yaml. The expiration and promotion lifecycle runs durably under the original npm start application; worker and dispatcher commands were not part of this task.',
  ],
};
