import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { probe, prepareProbe } from '../templates/contract-first/check.mjs';
import coldchain from '../contracts/transfer/coldchaincontrol.mjs';
import { validateWireExamples } from '../src/public-contract.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const secret = 'PUBLIC-test-secret-only';
const error = object({ error: object({ code: { type: 'string' } }) });
const contract = {
  taskId: 'signedprobe', environmentVariables: [], schemas: { Error: error },
  operations: [
    { id: 'clock', method: 'GET', path: '/clock', response: object({ asOf: { type: 'string', format: 'date-time' } }) },
    { id: 'write', method: 'POST', path: '/readings', request: object({ value: { type: 'integer' }, signature: { type: 'string' } }), response: object({ id: { type: 'string' } }) },
    { id: 'read', method: 'GET', path: '/readings/:id', response: object({ value: { type: 'integer' } }) },
  ],
  smoke: [
    { operationId: 'clock', capture: { clock: ['asOf'] } },
    { operationId: 'write', headers: { 'X-Signature': '', 'X-Time': '${clock}' }, body: { value: 7, signature: '' },
      signatures: [
        { target: ['headers', 'X-Signature'], key: secret, message: 'POST|/readings|${clock}' },
        { target: ['body', 'signature'], key: secret, message: '7' },
      ], capture: { readingId: ['id'] } },
    { operationId: 'read', params: { id: '${readingId}' }, expectBody: { value: 7 } },
  ],
};

test('public signed probes exercise credential acceptance and persisted readback, not just shapes', async t => {
  let brokenLookup = false, persist = true, clockFails = false;
  const records = new Map(), requests = [];
  const hmac = message => createHmac('sha256', secret).update(message).digest('hex');
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    let status = 200, body;
    if (req.url === '/clock') {
      status = clockFails ? 500 : 200;
      body = clockFails ? { error: { code: 'CLOCK_FAILED' } } : { asOf: new Date().toISOString() };
    } else if (req.method === 'POST') {
      let bytes = ''; for await (const chunk of req) bytes += chunk;
      const input = JSON.parse(bytes);
      if (brokenLookup || req.headers['x-signature'] !== hmac('POST|/readings|' + req.headers['x-time']) || input.signature !== hmac('7')) {
        status = 401; body = { error: { code: 'INVALID_DEVICE_SIGNATURE' } };
      } else { if (persist) records.set('one', input.value); body = { id: 'one' }; }
    } else { body = { value: records.get('one') ?? -1 }; }
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await probe(contract, url)).passed, true, 'valid signatures must reach actual writes and readback');
  brokenLookup = true;
  const failed = await probe(contract, url);
  assert.equal(failed.passed, false);
  assert.equal(failed.findings[1].actualStatus, 401);
  assert.equal(failed.findings[1].expectedStatus, 200);
  assert.equal(failed.findings[1].errorCode, 'INVALID_DEVICE_SIGNATURE');
  assert.equal(failed.findings[1].method, 'POST');
  assert.equal(failed.findings[1].path, '/readings');
  assert.deepEqual(failed.findings[2].blockedBy, ['write']);
  assert(!JSON.stringify(failed).includes(secret));
  brokenLookup = false; persist = false; records.clear();
  assert.equal((await probe(contract, url)).passed, false, 'success response without stored data is not green');
  clockFails = true; const count = requests.length;
  const blocked = await probe(contract, url);
  assert.deepEqual(blocked.findings[1].blockedBy, ['clock']);
  assert.deepEqual(requests.slice(count), ['/clock']);
});

test('ColdChain public smoke includes seeded device config, signed ingest, and durable identity verification', () => {
  const ids = coldchain.smoke.map(item => item.operationId);
  const read = ids.indexOf('read-device-config'), ingest = ids.indexOf('ingest-telemetry');
  assert(read >= 0 && ingest > read);
  assert.equal(coldchain.smoke[ingest].signatures.length, 2);
  assert(coldchain.smoke.slice(ingest + 1).some(item => item.expectContains?.some(row => row.path.join('.') === 'resources.telemetryReadings')));
  validateWireExamples(coldchain);
  const variables = { publicDeviceTime: '2026-09-07T12:00:00.123Z', publicReadingTime: '2026-09-07T12:00:01.456Z' };
  const credential = coldchain.seed.example.deviceCredentials[0];
  assert.notEqual(credential.deviceCredentialId, `${credential.deviceId}:${credential.keyVersion}`, 'public seed must exercise independent public credential identity');
  for (const index of [read, ingest]) {
    const request = prepareProbe(coldchain.smoke[index], variables);
    const method = index === read ? 'GET' : 'POST';
    const path = index === read ? `/api/v1/devices/${credential.deviceId}/config` : '/api/v1/telemetry-readings';
    const message = [method, path, request.headers['X-Device-Timestamp'], credential.keyVersion].join('|');
    assert.equal(request.headers['X-Device-Signature'], createHmac('sha256', credential.secret).update(message).digest('hex'));
    if (request.body) {
      const line = ['deviceId', 'readingId', 'sequence', 'observedAt', 'latitudeE6', 'longitudeE6', 'temperatureMilliC', 'configVersion', 'keyVersion'].map(key => request.body[key]).join('|');
      assert.equal(request.body.signature, createHmac('sha256', credential.secret).update(line).digest('hex'), 'body and header signatures independently follow the original public signing protocol');
    }
  }
});

test('malformed signing metadata is rejected during author validation', () => {
  for (const target of [['__proto__', 'polluted'], ['body', '__proto__'], ['headers'], ['query', 'sig']]) {
    const bad = structuredClone(contract); bad.smoke[1].signatures[0].target = target;
    assert.throws(() => validateWireExamples(bad), /signature target/);
  }
});
