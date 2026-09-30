import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expand } from '../templates/contract-first/runtime.mjs';
import { probe } from '../templates/contract-first/check.mjs';
import { validateWireExamples } from '../src/public-contract.mjs';

test('a failed public create blocks dependent reads without masking independent checks', async t => {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    response.writeHead(request.url === '/create' ? 500 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url === '/create' ? { error: { code: 'BROKEN_CREATE' } } : { ok: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const contract = {
    schemas: { Error: { type: 'object' } },
    operations: [
      { id: 'create', method: 'POST', path: '/create', status: 201, response: { type: 'object' } },
      { id: 'read', method: 'GET', path: '/rows/:id', response: { type: 'object' } },
      { id: 'health', method: 'GET', path: '/health', response: { type: 'object' } },
    ],
    smoke: [
      { operationId: 'create', body: {}, capture: { rowId: ['id'] } },
      { operationId: 'read', params: { id: '${rowId}' } },
      { operationId: 'health' },
    ],
  };
  const result = await probe(contract, `http://127.0.0.1:${server.address().port}`);
  assert.equal(result.passed, false);
  assert.equal(result.findings[0].status, 'failed');
  assert.deepEqual(result.findings[1], { operationId: 'read', passed: false, status: 'blocked', blockedBy: ['create'] });
  assert.equal(result.findings[2].passed, true);
  assert.deepEqual(calls, ['/create', '/health']);
});

test('public timestamp offsets use captured time and reject invalid anchors', () => {
  const variables = { clock: '2030-01-01T00:00:00.000Z', integer: 7 };
  assert.equal(expand('${clock+60000ms}', variables), '2030-01-01T00:01:00.000Z');
  assert.equal(expand('before:${clock-1ms}', variables), 'before:2029-12-31T23:59:59.999Z');
  assert.equal(expand('${integer}', variables), 7);
  assert.throws(() => expand('${absent+1ms}', variables), /Missing public variable/);
  assert.throws(() => expand('${integer+1ms}', variables), /timestamp/);
  assert.throws(() => expand('${clock+1ms}', { clock: 'not-a-time' }), /timestamp/);
});

test('public HTTP probes capture server time then write with legal relative deadlines', async t => {
  const timestamp = { type: 'string', format: 'date-time' };
  const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const contract = {
    taskId: 'clockfixture', environmentVariables: [], schemas: { Error: object({ error: object({ code: { type: 'string' } }) }) },
    operations: [
      { id: 'clock', method: 'GET', path: '/clock', status: 200, response: object({ asOf: timestamp }) },
      { id: 'create', method: 'POST', path: '/windows', status: 201, request: object({ expiresAt: timestamp, startsAt: timestamp }), response: object({ expiresAt: timestamp, startsAt: timestamp }) },
    ],
    smoke: [
      { operationId: 'clock', capture: { clock: ['asOf'] }, expectStatus: 200 },
      { operationId: 'create', body: { expiresAt: '${clock+60000ms}', startsAt: '${clock+3600000ms}' }, expectStatus: 201, expectBody: { expiresAt: '${clock+60000ms}', startsAt: '${clock+3600000ms}' } },
    ],
  };
  validateWireExamples(contract);
  const now = new Date().toISOString();
  let observed;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/clock') return response.end(JSON.stringify({ asOf: now }));
    let raw = ''; for await (const chunk of request) raw += chunk;
    observed = JSON.parse(raw);
    const valid = Date.parse(observed.expiresAt) === Date.parse(now) + 60000 && Date.parse(observed.startsAt) === Date.parse(now) + 3600000;
    response.statusCode = valid ? 201 : 400;
    response.end(JSON.stringify(valid ? observed : { error: { code: 'INVALID_DEADLINE' } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await probe(contract, `http://127.0.0.1:${server.address().port}`, {});
  assert.equal(result.passed, true, JSON.stringify(result.findings));
  assert.equal(Date.parse(observed.expiresAt) - Date.parse(now), 60000);
});
