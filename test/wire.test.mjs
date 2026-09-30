import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { probe } from '../templates/contract-first/check.mjs';
import { expand, requestPath, openApi, validator, errorBody } from '../templates/contract-first/runtime.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
const root = resolve(import.meta.dirname, '..');
const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const text = { type: 'string' }, integer = { type: 'integer' };
const row = obj({ id: text, name: text });
const errorSchema = obj({ error: obj({ code: text, message: text, details: { type: 'object' } }) });
const op = (id, method, path, response, extra = {}) => ({ id, method, path, status: 200, response, source: 'test fixture', ...extra });
const contract = {
  title: 'Wire fixture', schemas: { Error: errorSchema }, seed: { schema: obj({ rows: { type: 'array', items: row } }), example: { rows: [{ id: 'seed-1', name: 'Seed' }] } },
  operations: [
    op('health', 'GET', '/healthz', obj({ status: text })),
    op('openapi', 'GET', '/openapi.json', { type: 'object' }),
    op('ui', 'GET', '/', { type: 'string', contentMediaType: 'text/html' }),
    op('create', 'POST', '/api/rows', row, { status: 201, request: obj({ name: text }) }),
    op('read', 'GET', '/api/rows/:id', row),
    op('snapshot', 'GET', '/api/snapshot', obj({ rows: { type: 'array', items: row } })),
    op('query', 'GET', '/api/query', obj({ limit: integer }), { parameters: [{ name: 'limit', in: 'query', required: true, schema: { ...integer, minimum: 1 } }] }),
    op('wrong-response', 'GET', '/api/wrong-response', row),
    op('wrong-status', 'GET', '/api/wrong-status', row),
    op('upload', 'PUT', '/api/upload', obj({ length: integer }), { request: { type: 'string', contentMediaType: 'application/octet-stream' } }),
    op('download', 'GET', '/api/download', { type: 'string', contentMediaType: 'application/octet-stream' }, { successStatuses: [200, 206] }),
    op('cached', 'GET', '/api/cached', row, { successStatuses: [200, 304] }),
    op('batch', 'GET', '/api/actions:batch', obj({ literal: { type: 'boolean' } })),
    op('none', 'POST', '/api/none', obj({ accepted: { type: 'boolean' } }), { requestBody: 'none' }),
    op('unimplemented', 'GET', '/api/unimplemented', row),
  ],
  smoke: [
    { operationId: 'create', body: { name: 'Independent' }, expectStatus: 201, capture: { created: ['id'] } },
    { operationId: 'read', params: { id: '${created}' }, expectStatus: 200, expectBody: { name: 'Independent' } },
    { operationId: 'snapshot', expectStatus: 200, expectContains: [{ path: ['rows'], match: { id: '${created}', name: 'Independent' } }] },
    { operationId: 'openapi', expectStatus: 200 },
  ],
};
async function fixture(t, authorContract = contract) {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const path = await mkdtemp(join(root, '.tmp/wire-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await mkdir(join(path, 'contract')); await mkdir(join(path, 'dist'));
  await cp(join(root, 'test/fixtures/implementation.mjs'), join(path, 'dist/implementation.js'));
  for (const file of ['runtime.mjs', 'server.mjs']) await cp(join(root, 'templates/contract-first', file), join(path, 'contract', file));
  await writeFile(join(path, 'package.json'), '{"type":"module"}');
  await writeFile(join(path, 'contract/contract.json'), JSON.stringify(authorContract));
  const child = fork(join(path, 'contract/server.mjs'), [], { cwd: path, env: { ...process.env, PORT: '0' }, silent: true });
  const done = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await done; });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const listening = await new Promise((yes, no) => { child.once('error', no); child.once('exit', () => no(new Error(stderr))); child.on('message', message => yes(message)); });
  return { path, base: `http://127.0.0.1:${listening.port}`, address: listening.address };
}
test('fixed transport obeys the published loopback-only listening requirement', async t => {
  const author = structuredClone(contract);
  author.httpHost = '127.0.0.1';
  const { base, address } = await fixture(t, author);
  assert.equal(address, '127.0.0.1');
  assert.equal((await fetch(base + '/healthz')).status, 200);
});
test('real HTTP transport: validation, dynamic write/read identity and honest stubs', async t => {
  const { base } = await fixture(t);
  const response = await probe(contract, base, {});
  assert.equal(response.passed, true, JSON.stringify(response));
  for (const [path, options, expected] of [
    ['/api/rows', { method: 'POST', body: '{', headers: { 'content-type': 'application/json' } }, 400],
    ['/api/rows', { method: 'POST', body: JSON.stringify({ name: 'X', extra: true }), headers: { 'content-type': 'application/json; charset=utf-8' } }, 400],
    ['/api/rows', { method: 'POST', body: JSON.stringify({ name: 'X' }), headers: { 'content-type': 'text/plain' } }, 415],
    ['/api/query?limit=2', {}, 200], ['/api/query?limit=bad', {}, 400],
    ['/api/query?limit=2&extra=1', {}, 400], ['/api/query?limit=2&limit=3', {}, 400],
    ['/api/wrong-response', {}, 500], ['/api/wrong-status', {}, 500],
    ['/api/unimplemented', {}, 501], ['/api/unknown', {}, 404], ['/api/rows/%E0%A4%A', {}, 400],
    ['/api/none', { method: 'POST' }, 200], ['/api/none', { method: 'POST', body: '{}' }, 400],
    ['/api/actions:batch', {}, 200],
  ]) {
    const result = await fetch(base + path, options);
    assert.equal(result.status, expected, path);
    if (expected >= 400) assert.equal(typeof (await result.json()).error.code, 'string');
  }
  const negative = structuredClone(contract);
  negative.smoke[2].expectContains[0].match.name = 'Never created';
  assert.equal((await probe(negative, base, {})).passed, false, 'empty/fake identity must not pass');
});
test('raw upload is streamed; byte-range and conditional download are not JSON-wrapped', async t => {
  const { base } = await fixture(t);
  const upload = await fetch(base + '/api/upload', { method: 'PUT', body: Buffer.from([0, 255, 1]), headers: { 'content-type': 'application/octet-stream' } });
  assert.deepEqual(await upload.json(), { length: 3 });
  const result = await fetch(base + '/api/download');
  assert.equal(result.status, 206); assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from([0, 255, 1]));
  assert.equal((await fetch(base + '/api/cached')).status, 304);
  assert.match(await (await fetch(base + '/')).text(), /doctype html/);
});
test('author-side hidden fixture errors are not submission failures', async t => {
  const { path } = await fixture(t), boundary = await evaluatorContract(join(path, 'contract'));
  assert.doesNotThrow(() => boundary.seed(contract.seed.example));
  assert.throws(() => boundary.seed({ rows: [{ unexpected: true }] }), error => error.origin === 'evaluator' && error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.throws(() => boundary.request('/api/rows', { method: 'POST', json: {} }), /violates/);
  assert.throws(() => boundary.request('/api/query?unknown=1'), /Unknown query/);
  assert.throws(() => boundary.request('/api/none', { method: 'POST', json: {} }), /no request body/);
  assert.throws(() => boundary.request('/api/rows', { method: 'POST', json: { name: 'X' }, headers: { 'content-type': 'text/plain' } }), /Content-Type/);
  assert.doesNotThrow(() => boundary.request('/api/rows', { method: 'POST', json: {}, contractExpectation: 'invalid' }));
  assert.doesNotThrow(() => boundary.request('/api/rows', { method: 'POST', raw: Buffer.from('{\n  "name": "Raw JSON"\n}'), headers: { 'content-type': 'application/json' } }));
  assert.doesNotThrow(() => boundary.request('/api/rows', { method: 'POST', json: { name: 'JSON wins' }, raw: '{' }));
  assert.throws(() => boundary.request('/api/rows', { method: 'POST', raw: '{', headers: { 'content-type': 'application/json' } }), error => error.origin === 'evaluator' && /malformed JSON/.test(error.message));
  assert.throws(() => boundary.request('/api/rows', { method: 'POST', raw: '{}', headers: { 'content-type': 'application/json' } }), /violates/);
});
test('OpenAPI and examples share the runtime schema; path metadata has no duplicates', () => {
  assert.equal(openApi(contract).paths['/api/download'].get.responses['206'].content['application/octet-stream'].schema.type, 'string');
  assert.equal(openApi(contract).paths['/api/cached'].get.responses['304'].content, undefined);
  assert.equal(requestPath(contract.operations[4], { params: { id: 'a/b' }, query: { limit: 3 } }), '/api/rows/a%2Fb?limit=3');
  assert.deepEqual(expand({ id: '${id}', text: 'row-${id}' }, { id: 5 }), { id: 5, text: 'row-5' });
  assert.throws(() => expand('${absent}', {}), /Missing/);
  assert(validator(contract)({ type: 'number', multipleOf: 0.000001 })(0.01 + 0.000001));
  const arrayErrors = { schemas: { Error: obj({ error: obj({ code: text, message: text, details: { type: 'array', items: text } }) }) } };
  assert.deepEqual(errorBody(arrayErrors, 'INVALID_REQUEST', 'bad').error.details, []);
  const references = structuredClone(contract);
  references.schemas.Identifier = { type: 'string', format: 'uuid' };
  references.operations[4].parameters = [{ name: 'id', in: 'path', required: true, schema: { $ref: '#/$defs/Identifier' } }];
  const document = openApi(references);
  assert.equal(document.paths['/api/rows/{id}'].get.parameters.length, 1);
  assert.equal(document.paths['/api/rows/{id}'].get.parameters[0].schema.$ref, '#/components/schemas/Identifier');
  references.operations[3].errors = { 415: errorSchema, 422: errorSchema, 503: errorSchema };
  const responseCodes = openApi(references).paths['/api/rows'].post.responses;
  for (const status of [415, 422, 503]) assert.deepEqual(responseCodes[status].content['application/json'].schema, errorSchema);
  references.webhooks = { delivery: { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/$defs/Identifier' } } } }, responses: { 204: { description: 'Acknowledged' } } } } };
  assert.equal(openApi(references).webhooks.delivery.post.requestBody.content['application/json'].schema.$ref, '#/components/schemas/Identifier');
});

test('published code-only malformed-JSON envelopes survive the fixed transport', async t => {
  const codeOnly = obj({ error: obj({ code: { const: 'MALFORMED_JSON' } }) });
  const author = structuredClone(contract);
  author.schemas.Error = { anyOf: [errorSchema, codeOnly] };
  author.transportErrors = { invalidJson: { status: 400, code: 'MALFORMED_JSON', body: { error: { code: 'MALFORMED_JSON' } } } };
  const { base } = await fixture(t, author);
  const response = await fetch(base + '/api/rows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'MALFORMED_JSON' } });
  const ordinary = await fetch(base + '/api/rows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(typeof (await ordinary.json()).error.message, 'string', 'ordinary errors retain their full envelope');
});

test('device-header authentication errors do not reclassify business request validation', async t => {
  const author = structuredClone(contract);
  author.operations.find(op => op.id === 'create').parameters = [{ name: 'X-Device-Signature', in: 'header', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' }, transportError: { status: 401, code: 'INVALID_DEVICE_SIGNATURE' } }];
  const { base } = await fixture(t, author);
  for (const [headers, body, status, code] of [
    [{}, { name: 'A' }, 401, 'INVALID_DEVICE_SIGNATURE'],
    [{ 'x-device-signature': 'bad' }, { name: 'A' }, 401, 'INVALID_DEVICE_SIGNATURE'],
    [{ 'x-device-signature': 'a'.repeat(64) }, {}, 400, 'INVALID_REQUEST'],
  ]) {
    const result = await fetch(base + '/api/rows', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal(result.status, status);
    assert.equal((await result.json()).error.code, code);
  }
  const parameter = openApi(author).paths['/api/rows'].post.parameters[0];
  assert.deepEqual(parameter['x-transport-error'], { status: 401, code: 'INVALID_DEVICE_SIGNATURE' });
  assert.equal(parameter.transportError, undefined);
});

test('public headers distinguish absence from malformed values over real HTTP', async t => {
  const author = structuredClone(contract);
  author.operations.find(op => op.id === 'create').parameters = [
    { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[ -~]+$' }, missingTransportError: { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' }, transportError: { status: 400, code: 'INVALID_IDEMPOTENCY_KEY' } },
    { name: 'Authorization', in: 'header', required: true, schema: { type: 'string', pattern: '^Bearer .+$' }, missingTransportError: { status: 401, code: 'ADMIN_AUTH_REQUIRED' }, transportError: { status: 401, code: 'ADMIN_AUTH_INVALID' } },
  ];
  const { base } = await fixture(t, author);
  for (const [headers, status, code] of [
    [{}, 400, 'IDEMPOTENCY_KEY_REQUIRED'],
    [{ 'idempotency-key': 'bad' }, 400, 'INVALID_IDEMPOTENCY_KEY'],
    [{ 'idempotency-key': 'public-key' }, 401, 'ADMIN_AUTH_REQUIRED'],
    [{ 'idempotency-key': 'public-key', authorization: 'invalid' }, 401, 'ADMIN_AUTH_INVALID'],
  ]) {
    const result = await fetch(base + '/api/rows', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ name: 'Row' }) });
    assert.equal(result.status, status);
    assert.equal((await result.json()).error.code, code);
  }
  const published = openApi(author).paths['/api/rows'].post.parameters[0];
  assert.deepEqual(published['x-missing-transport-error'], { status: 400, code: 'IDEMPOTENCY_KEY_REQUIRED' });
  assert.equal(published.missingTransportError, undefined);
});

test('published body error rules retain domain codes without accepting unsafe numbers', async t => {
  const author = structuredClone(contract), operation = author.operations.find(op => op.id === 'create');
  author.transportErrors = { unknownField: { status: 400, code: 'UNKNOWN_FIELD' } };
  const safe = { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
  operation.request = obj({ name: text, amount: { ...safe, minimum: 1 }, children: { type: 'array', items: obj({ amount: safe }) } });
  operation.request.properties.filter = obj({ project: text });
  operation.bodyTransportErrors = [
    { path: '/amount', when: 'number', status: 400, code: 'INVALID_TOTAL' },
    { path: '/children/*/amount', when: 'unsafe_integer', status: 400, code: 'INVALID_ALLOCATION' },
    { path: '/filter', status: 400, code: 'INVALID_FILTER' },
  ];
  const { base } = await fixture(t, author);
  for (const [body, code] of [
    [{ name: 'A', amount: 0, children: [] }, 'INVALID_TOTAL'],
    [{ name: 'A', amount: 1.5, children: [] }, 'INVALID_TOTAL'],
    [{ name: 'A', amount: '1', children: [] }, 'INVALID_REQUEST'],
    [{ name: 'A', amount: 1, children: [{ amount: 1.5 }] }, 'INVALID_ALLOCATION'],
    [{ name: 'A', amount: 1, children: [{ amount: Number.MAX_SAFE_INTEGER + 1 }] }, 'INVALID_ALLOCATION'],
    [{ name: 'A', amount: 1, children: [{ amount: '1' }] }, 'INVALID_REQUEST'],
    [{ amount: 1, children: [] }, 'INVALID_REQUEST'],
    [{ name: 'A', amount: 1, children: [], filter: { project: 'P', unknown: 1 } }, 'UNKNOWN_FIELD'],
    [{ name: 'A', amount: 1, children: [], filter: { project: 1 } }, 'INVALID_FILTER'],
  ]) {
    const result = await fetch(base + '/api/rows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(result.status, 400);
    assert.equal((await result.json()).error.code, code);
  }
  assert.deepEqual(openApi(author).paths['/api/rows'].post['x-body-transport-errors'], operation.bodyTransportErrors);
});
