// Public-contract construction only; no application behavior or private fixtures.
import { createHash } from 'node:crypto';
export const ref = (name) => ({ $ref: `#/$defs/${name}` });
export const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const arr = (items, extra = {}) => ({ type: 'array', items, ...extra });
export const one = (...schemas) => ({ oneOf: schemas });
export const nil = (schema) => ({ anyOf: [schema, { type: 'null' }] });
export const str = { type: 'string' };
export const text = { type: 'string', minLength: 1, pattern: '\\S' };
export const bool = { type: 'boolean' };
export const int = { type: 'integer', minimum: -9007199254740991, maximum: 9007199254740991 };
export const count = { ...int, minimum: 0 };
export const positive = { ...int, minimum: 1 };
export const range = (minimum, maximum) => ({ ...int, minimum, maximum });
export const uuid = { type: 'string', format: 'uuid', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
export const time = { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
export const currency = { type: 'string', pattern: '^[A-Z]{3}$' };
export const sha = { type: 'string', pattern: '^[0-9a-f]{64}$' };
export const en = (...values) => ({ type: 'string', enum: values });
export const pick = (schema, keys, required = keys) => obj(Object.fromEntries(keys.map((k) => [k, schema.properties[k]])), required);
export const without = (schema, keys) => pick(schema, Object.keys(schema.properties).filter((k) => !keys.includes(k)));
export const page = (schema) => obj({ items: arr(schema), nextCursor: nil(str) });
export const source = (section) => `docs/frontal-legacy/README.md#${section}`;
export const manager = 'docs/frontal-legacy/manager-requirements.md';
export const wire = 'V2 public wire clarification (contract notes)';
export const T = '2026-09-07T00:00:00.000Z';
export const FUTURE = '2099-01-01T00:00:00.000Z';
export const id = (n) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const auth = { Authorization: 'Bearer ${ADMIN_TOKEN}' };
export const key = (name) => ({ 'Idempotency-Key': `v2-public-${name}` });
export const q = (name, schema, required = false) => ({ name, in: 'query', required, schema });
export const paging = [q('limit', { ...range(1, 100), default: 50 }), q('cursor', text)];
export const canonical = (v) => JSON.stringify(v, function (_key, value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]])) : value;
});
export const digest = (v) => createHash('sha256').update(canonical(v)).digest('hex');
export const environmentVariables = ['DATABASE_URL', 'TEST_DATABASE_URL', 'PORT', 'ADMIN_TOKEN', 'WEBHOOK_URL', 'WORK_LEASE_SECONDS', 'CHROMIUM_PATH', 'MANAGED_DATA_ROOT', 'TEST_BARRIER_URL', 'TEST_BARRIER_TOKEN'];
export const commands = ['npm run db:migrate', 'npm run db:seed -- --file <path>', 'npm run dev', 'npm run build', 'npm run start:api', 'npm run start:worker', 'npm run start:dispatcher', ...['unit', 'integration', 'e2e', 'concurrency', 'recovery', 'all', 'perf'].map((s) => `npm run test:${s}`)];
export function op(id, method, path, status, response, request, example = {}, extra = {}) {
  const mutates = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const pathParameters = [...path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, name]) => ({ name, in: 'path', required: true, schema: name === 'version' ? positive : ['workerId', 'nodeKey'].includes(name) ? text : uuid }));
  const headers = mutates ? [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7e]+$' } }] : [];
  return { id, method, path, status, source: source('http-and-openapi-31'), response, ...(request ? { request } : { requestBody: 'none' }), ...extra,
    parameters: [...pathParameters, ...headers, ...(extra.parameters ?? [])],
    example: { ...example, ...(mutates && { headers: { ...key(id), ...example.headers } }) } };
}
export const admin = [{ name: 'Authorization', in: 'header', required: true, schema: { type: 'string', pattern: '^Bearer .+$' } }];
export function commonSchemas(workKinds, eventTypes) {
  const Work = obj({ workId: uuid, kind: en(...workKinds), aggregateId: uuid, state: en('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED'), terminal: bool, attempt: count, leaseOwner: nil(text), leaseExpiresAt: nil(time) });
  Work.allOf = [
    { if: { properties: { state: { const: 'LEASED' } } }, then: { properties: { leaseOwner: text, leaseExpiresAt: time } }, else: { properties: { leaseOwner: { type: 'null' }, leaseExpiresAt: { type: 'null' } } } },
    { if: { properties: { state: en('SUCCEEDED', 'FAILED', 'CANCELLED') } }, then: { properties: { terminal: { const: true } } }, else: { properties: { terminal: { const: false } } } },
  ];
  return {
    Error: obj({ error: obj({ code: text, message: str, details: obj({}) }) }),
    Health: obj({ status: { const: 'ok' } }),
    JsonValue: { anyOf: [{ type: 'null' }, bool, { type: 'number', minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE }, str, arr(ref('JsonValue')), { type: 'object', additionalProperties: ref('JsonValue') }] },
    Work,
    DomainEvent: obj({ eventId: uuid, aggregateId: uuid, sequence: positive, type: en(...eventTypes), occurredAt: time, schemaVersion: { const: 1 }, payload: obj({}) }),
  };
}
export const resourceArrays = (resources) => Object.fromEntries(Object.entries(resources).map(([key, schema]) => [key, arr(typeof schema === 'string' ? ref(schema) : schema)]));
export const snapshot = (resources) => obj({ asOf: time, resources: obj(resourceArrays(resources)), work: arr(ref('Work')), events: arr(ref('DomainEvent')) });
export const seedSchema = (resources) => obj({ schemaVersion: { const: 1 }, seedVersion: { ...text, maxLength: 64 }, ...resourceArrays(resources) });
export function infra() {
  return [op('health', 'GET', '/healthz', 200, ref('Health'), undefined, {}, { source: wire }),
    op('openapi', 'GET', '/openapi.json', 200, { type: 'object', required: ['openapi', 'info', 'paths'], properties: { openapi: { type: 'string', pattern: '^3\\.1\\.' }, info: { type: 'object' }, paths: { type: 'object' }, components: { type: 'object' } } }),
    op('production-ui', 'GET', '/', 200, { type: 'string', minLength: 1 }, undefined, {}, { source: source('real-ui') })];
}
export function observe() {
  return [op('domain-events', 'GET', '/api/v1/domain-events', 200, obj({ items: arr(ref('DomainEvent')) }), undefined, { query: { aggregateId: id(1), afterSequence: 0, limit: 50 } }, { source: wire, parameters: [q('aggregateId', uuid, true), q('afterSequence', count), q('limit', range(1, 100))] }),
    op('verification-snapshot', 'GET', '/api/v1/verification-snapshot', 200, ref('VerificationSnapshot'), undefined, { headers: auth }, { parameters: admin })];
}
export const basicSmoke = [{ operationId: 'health', expectStatus: 200, expectBody: { status: 'ok' } }, { operationId: 'openapi', expectStatus: 200 }];
export const seedSmoke = (matches, operationId = 'verification-snapshot') => ({ operationId, headers: auth, expectStatus: 200, expectContains: Object.entries(matches).flatMap(([name, rows]) => rows.map((match) => ({ path: ['resources', name], match }))) });
export const commonNotes = [
  'Authority: the complete original public README and Manager requirements. This contract uses no private evaluator cases or submitted implementation. Wire validation does not establish workflow, recovery or performance correctness.',
  'V2 wire clarification: unspecified health body is exactly {status:"ok"}; production UI is HTML at /. GET domain-events returns {items:[DomainEvent]} with aggregateId required and optional afterSequence (default 0), limit (default 50, range 1..100), ordered by sequence. No other query keys are accepted.',
  'Original error details is an exact empty object. Every mutation requires its published Idempotency-Key. Only documented admin routes require ADMIN_TOKEN. Output timestamps retain the original UTC millisecond precision.',
  'The FINAL snapshot has exactly its published resource keys and explicitly typed Work/DomainEvent records. It is one database snapshot; recursive *Token omission, stable ordering, retained terminal Work and event identity remain business requirements. Manager-only data is created by public APIs, never inserted through the V1 seed.',
  'Examples are independent public transport examples, not a required stateful sequence. A success requires the state/time/lease/revision prerequisites in the original public documents. Smoke checks identity and a separate write/read path, not every operation or concurrency invariant.',
];
