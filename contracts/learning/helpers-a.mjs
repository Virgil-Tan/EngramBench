// Public V2 wire definitions. No evaluator fixtures or business implementation.
export const dialect = 'https://json-schema.org/draft/2020-12/schema';
export const ref = name => ({ $ref: `#/$defs/${name}` });
export const str = { type: 'string' };
export const name = { type: 'string', minLength: 1, maxLength: 200 };
export const uuid = { type: 'string', format: 'uuid', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
export const time = { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
export const sha = { type: 'string', pattern: '^[0-9a-f]{64}$' };
export const int = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
export const nat = { ...int, minimum: 0 };
export const pos = { ...int, minimum: 1 };
export const bool = { type: 'boolean' };
export const enumeration = (...values) => ({ enum: values });
export const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
export const list = (schema, extra = {}) => ({ type: 'array', items: schema, ...extra });
export const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const pick = (schema, keys, required = keys) => obj(Object.fromEntries(keys.map(key => [key, schema.properties[key]])), required);
export const page = schema => obj({ items: list(schema), nextCursor: nullable(str) });
export const empty = obj({});
export const T = '2031-04-05T06:07:08.000Z';
export const uid = (group, index) => `c42a${String(group).padStart(4, '0')}-1030-4030-8030-${String(index).padStart(12, '0')}`;
export const source = section => `docs/frontal-legacy/README.md — ${section}`;
export const manager = 'docs/frontal-legacy/manager-requirements.md';
export const wire = 'contract/README.md — explicit V2 public wire clarification';
export const environmentVariables = ['PORT', 'DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_TOKEN', 'WEBHOOK_URL', 'WORK_LEASE_SECONDS', 'TEST_BARRIER_URL', 'TEST_BARRIER_TOKEN'];
export const commands = ['npm run db:migrate', 'npm run db:seed -- --file <path>', 'npm run dev', 'npm run build', 'npm run start:api', 'npm run start:worker', 'npm run start:dispatcher', ...['unit', 'integration', 'e2e', 'concurrency', 'recovery', 'all', 'perf'].map(x => `npm run test:${x}`)];
export const parameter = (key, schema, where = 'query', required = false) => ({ name: key, in: where, required, schema });
export const pagination = [parameter('limit', { ...pos, maximum: 1000 }), parameter('cursor', str)];
export const idem = parameter('Idempotency-Key', { type: 'string', minLength: 1, maxLength: 200 }, 'header', true);
export const admin = { Authorization: 'Bearer ${ADMIN_TOKEN}' };
export const keyed = key => ({ 'Idempotency-Key': key });
export const basic = {
  JsonValue: { anyOf: [{ type: 'null' }, bool, str, { type: 'number' }, list(ref('JsonValue')), { type: 'object', additionalProperties: ref('JsonValue') }] },
  Tenant: obj({ tenantId: uuid, name }),
  Error: obj({ error: obj({ code: str, message: str, details: obj({}) }) }),
  Health: obj({ status: { const: 'ok' } }),
  // OpenAPI itself is a standards-defined document, not a domain record.
  OpenApi: { type: 'object', required: ['openapi', 'info', 'paths'], properties: { openapi: { const: '3.1.0' }, info: { type: 'object' }, paths: { type: 'object' } }, additionalProperties: true },
};
export function work(kinds) { return obj({ workId: uuid, kind: enumeration(...kinds), aggregateId: uuid, state: enumeration('PENDING', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED'), terminal: bool, attempt: nat, leaseOwner: nullable(str), leaseExpiresAt: nullable(time) }); }
export function event(types, payload) { return obj({ eventId: uuid, tenantId: uuid, aggregateId: uuid, aggregateType: str, type: enumeration(...types), sequence: pos, occurredAt: time, payload }); }
export function seedShape(collections, importedAt = true) { return { $schema: dialect, ...obj({ schemaVersion: { const: 1 }, seedVersion: name, ...(importedAt ? { importedAt: time } : {}), ...collections }) }; }
export function snapshotShape(collections) { return obj({ schemaVersion: { const: 1 }, resources: obj(collections), work: list(ref('Work')), events: list(ref('DomainEvent')) }); }
export function operation(id, method, path, request, response, example = {}, at = wire, parameters = []) {
  const pathParameters = [...path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, key]) => parameter(key, key === 'chunkNumber' ? nat : key === 'partNumber' ? pos : uuid, 'path', true));
  return { id, method, path, status: 200, source: at, ...(request ? { request } : { requestBody: 'none' }), response, parameters: [...pathParameters, ...(method === 'GET' || method === 'HEAD' ? [] : [idem]), ...parameters], example };
}
export function standardOps() { return [operation('snapshot', 'GET', '/api/v1/verification-snapshot', null, ref('Snapshot'), { headers: admin }, source('Seed and snapshot'), [parameter('Authorization', str, 'header', true)]), operation('health', 'GET', '/healthz', null, ref('Health'), {}, wire), operation('openapi', 'GET', '/openapi.json', null, ref('OpenApi'), {}, source('HTTP contract')), operation('productionUi', 'GET', '/', null, { type: 'string', minLength: 1, contentMediaType: 'text/html' }, {}, wire)]; }
export const sharedNotes = [
  'V2 public wire clarification (new protocol, not a claim about the original specification): object schemas are closed; server-generated identities, counters and timestamps are omitted from creation inputs. Empty command bodies are {}. Tenant is exactly {tenantId,name}; no createdAt is added to it.',
  'V2 public wire clarification: snapshot is exactly {schemaVersion:1,resources,work,events}; every listed collection is complete and sorted lexicographically by its public identity (composite identities by listed component order). Manager resource collections extend resources. Snapshot requires Authorization: Bearer ADMIN_TOKEN. Health is {status:"ok"}; production UI is HTML at /. Error.details is exactly {}. DomainEvent uses the fixed redacted envelope declared in schemas; payload contains only the published resource references/state/digests, never credentials or raw sensitive content.',
  'V2 public wire clarification: seed is metadata, validated atomically including references and invariants; missing required fields are errors, not adapter defaults. Seed replay follows the original version+canonical digest no-op rule. JSON schema validates wire shape; business checks such as uniqueness, reference ownership, ordering, digest correctness and CAS remain implementation responsibilities.',
  'Every listed operation has an independent public request example. Examples containing resource IDs from later lifecycle stages illustrate wire shape, not a promise that they can all be called in isolation. Only smoke is an executable ordered scenario; it verifies real seed/read and write/read behavior, not full business acceptance.',
];
