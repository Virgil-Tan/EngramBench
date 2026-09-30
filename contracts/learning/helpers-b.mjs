// Author-side schema construction only; no business handlers, scoring or hidden fixtures.
import { createHash } from 'node:crypto';
export const T = '2026-09-07T00:00:00.000Z';
export const FUTURE = '2035-04-03T12:00:00.000Z';
export const ref = name => ({ $ref: `#/$defs/${name}` });
export const text = { type: 'string' };
export const name = { type: 'string', minLength: 1 };
export const uuid = { type: 'string', format: 'uuid', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
export const time = { type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' };
export const int = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
export const nat = { ...int, minimum: 0 };
export const pos = { ...int, minimum: 1 };
export const bool = { type: 'boolean' };
export const sha = { type: 'string', pattern: '^[0-9a-f]{64}$' };
export const currency = { type: 'string', pattern: '^[A-Z]{3}$' };
export const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
export const url = { type: 'string', pattern: '^https?://[^\\s@#]+$' };
export const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
export const list = (items, extra = {}) => ({ type: 'array', items, ...extra });
export const en = (...values) => ({ type: 'string', enum: values });
export const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export const map = (schema, keyPattern) => ({ type: 'object', ...(keyPattern && { propertyNames: { pattern: keyPattern } }), additionalProperties: schema });
export const union = (...schemas) => ({ anyOf: schemas });
export const empty = obj({});
export const interval = obj({ startAt: time, endAt: time });
export const page = schema => obj({ items: list(schema), nextCursor: nullable(text) });
export const pick = (schema, fields, optional = []) => obj(Object.fromEntries(fields.map(field => [field, schema.properties[field]])), fields.filter(field => !optional.includes(field)));
export const omit = (schema, fields) => obj(Object.fromEntries(Object.entries(schema.properties).filter(([field]) => !fields.includes(field))), schema.required.filter(field => !fields.includes(field)));
export const id = (task, index) => `b2${String(task).padStart(6, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function canonical(value) { return value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`; }
export const readme = 'docs/frontal-legacy/README.md';
export const manager = 'docs/frontal-legacy/manager-requirements.md';
export const wire = 'V2 wire clarification (contracts/learning contract and generated contract/README.md)';
// Exact common HTTP codes in the detailed public README family (not inferred business errors).
export const detailedTransportErrors = {
  auth:{status:401,code:'ADMIN_AUTH_REQUIRED'},
  unknownField:{status:400,code:'UNKNOWN_FIELD'},
  invalidRequest:{status:400,code:'INVALID_REQUEST'},
  invalidJson:{status:400,code:'MALFORMED_JSON'},
  unsupportedMediaType:{status:415,code:'UNSUPPORTED_MEDIA_TYPE'},
};

// Concise notation for flat, closed records. Nested records remain explicit schemas.
export function record(spec, extra = {}) {
  const atoms = { uuid, string: text, name, timestamp: time, int, nat, pos, boolean: bool, sha256: sha, currency, date, url, json: ref('Json'), object: ref('JsonObject') };
  const parse = token => token.endsWith('|null') ? nullable(parse(token.slice(0, -5))) : token.startsWith('[') ? list(parse(token.slice(1, -1))) : atoms[token] ?? (token.includes('|') ? en(...token.split('|')) : ref(token));
  return obj({ ...Object.fromEntries(spec.trim().split(/\s+/).filter(Boolean).map(field => { const p = field.indexOf(':'); return [field.slice(0, p), parse(field.slice(p + 1))]; })), ...extra });
}

export const common = {
  Json: { anyOf: [{ type: 'null' }, bool, { type: 'number' }, text, list(ref('Json')), map(ref('Json'))] },
  JsonObject: map(ref('Json')),
  Error: obj({ error: obj({ code: name, message: text, details: ref('JsonObject') }) }),
  Health: obj({ status: { const: 'ok' } }),
  OpenAPI: { type: 'object', required: ['openapi', 'info', 'paths'], properties: { openapi: { type: 'string', pattern: '^3\\.1\\.' }, info: obj({ title: text, version: text }), paths: { type: 'object' }, components: { type: 'object' } }, additionalProperties: true },
};

export const pagination = [{ name: 'limit', in: 'query', required: false, schema: { ...pos, maximum: 100, default: 50 } }, { name: 'cursor', in: 'query', required: false, schema: name }];
export const query = (name, schema, required = false) => ({ name, in: 'query', required, schema });
export const admin = { Authorization: 'Bearer ${ADMIN_TOKEN}' };
export const idem = key => ({ 'Idempotency-Key': `public-v2-${key}` });
export const snapshotSmoke = matches => ({ operationId: 'verification-snapshot', headers: admin, expectStatus: 200, expectContains: matches.map(([collection, match]) => ({ path: ['resources', collection], match })) });

function work(kinds) {
  return { ...record('workId:uuid aggregateId:uuid state:PENDING|LEASED|SUCCEEDED|FAILED|CANCELLED terminal:boolean attempt:nat leaseOwner:string|null leaseExpiresAt:timestamp|null', { kind: en(...kinds) }), allOf: [
    { if: { properties: { state: { const: 'LEASED' } } }, then: { properties: { leaseOwner: name, leaseExpiresAt: time } }, else: { properties: { leaseOwner: { type: 'null' }, leaseExpiresAt: { type: 'null' } } } },
    { if: { properties: { state: { enum: ['SUCCEEDED', 'FAILED', 'CANCELLED'] } } }, then: { properties: { terminal: { const: true } } }, else: { properties: { terminal: { const: false } } } },
  ] };
}

export function sample(schema, schemas, key = '', index = 1) {
  if (schema.$ref) return sample(schemas[schema.$ref.split('/').at(-1)], schemas, key, index);
  if (Object.hasOwn(schema, 'const')) return schema.const;
  if (schema.enum) return schema.enum[(index - 1) % schema.enum.length];
  if (schema.anyOf || schema.oneOf) return sample((schema.anyOf ?? schema.oneOf)[0], schemas, key, index);
  if (schema.type === 'null') return null;
  if (schema.type === 'boolean') return false;
  if (schema.type === 'integer' || schema.type === 'number') return schema.default ?? Math.max(schema.minimum ?? 0, Math.min(schema.maximum ?? 1, 1));
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, (_, i) => sample(schema.items, schemas, key, i + 1));
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map(field => [field, sample(schema.properties[field], schemas, field, index)]));
  if (schema.format === 'uuid' || schema.pattern?.includes('[0-9a-f]{8}')) return id(999, index);
  if (schema.format === 'date-time') return T;
  if (schema.pattern === sha.pattern) return digest(`public-v2-example-${index}`);
  if (schema.pattern === currency.pattern) return 'USD';
  if (schema.pattern === date.pattern) return '2035-04-03';
  if (schema.pattern === url.pattern) return 'http://127.0.0.1:4010/public-example';
  return (schema.example ?? `public${index}`).padEnd(schema.minLength ?? 0, 'x').slice(0, schema.maxLength ?? Infinity);
}

export function operation(id, method, path, request, response, extra = {}) {
  return { id, method, path, status: 200, source: `${readme}; ${wire}`, ...(request && { request }), response, ...extra };
}

export function finish({ taskId, title, schemas, seedTypes, resources = seedTypes, seedData, importedAt = false, snapshotVersion = false, workKinds, eventTypes, emptyEventPayload = false, operations, smoke = [], notes = [], environmentVariables = [], transportErrors }) {
  schemas = { ...common, ...schemas, Work: work(workKinds) };
  schemas.DomainEvent = obj({ eventId: uuid, aggregateId: uuid, sequence: pos, type: en(...eventTypes), occurredAt: time, schemaVersion: { const: 1 }, payload: emptyEventPayload ? empty : ref('JsonObject') });
  schemas.Seed = obj({ schemaVersion: { const: 1 }, seedVersion: { ...name, maxLength: 64 }, ...(importedAt && { importedAt: time }), ...Object.fromEntries(Object.entries(seedTypes).map(([key, type]) => [key, list(ref(type))])) });
  schemas.SnapshotResources = obj(Object.fromEntries(Object.entries(resources).map(([key, type]) => [key, list(ref(type))])));
  schemas.VerificationSnapshot = obj({ ...(snapshotVersion && { schemaVersion: { const: 1 } }), asOf: time, resources: ref('SnapshotResources'), work: list(ref('Work')), events: list(ref('DomainEvent')) });
  const allOperations = [operation('health', 'GET', '/healthz', null, ref('Health')), operation('openapi', 'GET', '/openapi.json', null, ref('OpenAPI')), operation('production-ui', 'GET', '/', null, {...text,contentMediaType:'text/html'}), ...operations, operation('verification-snapshot', 'GET', '/api/v1/verification-snapshot', null, ref('VerificationSnapshot'), { parameters: [{ name: 'Authorization', in: 'header', required: true, schema: { type: 'string', pattern: '^Bearer .+$' } }] })];
  for (const op of allOperations) {
    const pathParameters = [...op.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)].map(([, key]) => ({ name: key, in: 'path', required: true, schema: key === 'visitIndex' ? pos : /^(revision|keyVersion|ordinal)$/.test(key) ? nat : key === 'resourceType' ? en('clinician', 'room', 'equipmentUnit') : uuid }));
    const supplied = op.parameters ?? [];
    op.parameters = [...pathParameters.filter(p => !supplied.some(s => s.in === p.in && s.name === p.name)), ...supplied];
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(op.method)) op.parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7e]+$' } });
    const generated = {};
    for (const p of op.parameters.filter(p => p.required)) { const group = p.in === 'path' ? 'params' : p.in === 'header' ? 'headers' : 'query'; (generated[group] ??= {})[p.name] = p.name === 'Idempotency-Key' ? `public-v2-${op.id}` : p.name === 'Authorization' ? 'Bearer public-example-admin' : sample(p.schema, schemas, p.name); }
    if (op.request) generated.body = sample(op.request, schemas);
    op.example = { ...generated, ...op.example, ...(generated.headers && { headers: { ...generated.headers, ...op.example?.headers } }), ...(generated.params && { params: { ...generated.params, ...op.example?.params } }) };
  }
  const example = { schemaVersion: 1, seedVersion: `public-v2-${taskId}-1`, ...(importedAt && { importedAt: T }), ...Object.fromEntries(Object.keys(seedTypes).map(key => [key, seedData[key] ?? []])) };
  return { taskId, title, ...(transportErrors && {transportErrors}), environmentVariables: [...new Set(['PORT', 'DATABASE_URL', 'TEST_DATABASE_URL', 'ADMIN_TOKEN', 'WEBHOOK_URL', 'WORK_LEASE_SECONDS', 'TEST_BARRIER_URL', 'TEST_BARRIER_TOKEN', ...environmentVariables])], commands: ['npm run db:migrate', 'npm run db:seed -- --file <seed.json>', 'npm run dev', 'npm run build', 'npm run start:api', 'npm run start:worker', 'npm run start:dispatcher', ...['unit', 'integration', 'e2e', 'concurrency', 'recovery', 'all', 'perf'].map(s => `npm run test:${s}`)], seed: { schema: schemas.Seed, example }, schemas, operations: allOperations, smoke: [{ operationId: 'health', expectStatus: 200 }, { operationId: 'openapi', expectStatus: 200 }, ...smoke], notes: [
    'Source authority is the full public README, Manager requirements and AGENTS. No hidden evaluator data or solution code is imported. This V2 contract fixes wire boundaries; state machines, algorithms, isolation, migrations and performance remain implementation work.',
    'V2 wire clarification: every route has the closed request/success schema published here; only business inputs occur in creation requests. Omitted success status is 200. Health returns {status:"ok"}; UI returns HTML. Collection nextCursor is string or null, with null denoting completion. Path/query/header parameters and independent request examples are explicit. Examples validate transport only, not eligibility of referenced resources.',
    'V2 wire clarification: the authenticated verification snapshot is one point-in-time envelope with complete named resource arrays, typed retained Work and ordered DomainEvents. When the legacy source did not specify event fields, V2 uses eventId,aggregateId,sequence,type,occurredAt,schemaVersion,payload; payload remains a JSON object. No hidden event payload is prescribed.',
    'The seed uses the exact V1 array names and graph references. Repeated identical seed import is a no-op; another digest under the same seedVersion conflicts. Manager resources are derived by migration or created by public operations, never invented V1 seed members.',
    ...notes,
  ] };
}

export const domainEventsOperation = () => operation('domain-events', 'GET', '/api/v1/domain-events', null, obj({ items: list(ref('DomainEvent')), nextCursor: nullable(text) }), { parameters: [query('aggregateId', uuid, true), query('afterSequence', nat), ...pagination], source: `${readme}; ${wire} (event collection envelope)` });
