import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { probe } from '../templates/contract-first/check.mjs';
import creator from '../contracts/transfer/creatorrightsexchange.mjs';
import { validateWireExamples } from '../src/public-contract.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const contract = {
  schemas: { Error: object({ error: object({ code: { type: 'string' } }) }) },
  operations: [{ id: 'echo', method: 'POST', path: '/echo', status: 200, request: { type: 'string' }, response: object({ value: { type: 'string' } }) }],
  smoke: [{ operationId: 'echo', rawBody: '{', expectStatus: 400, expectBody: { error: { code: 'MALFORMED_JSON' } } }],
};

test('public rawBody probe sends malformed JSON bytes and receives MALFORMED_JSON over HTTP', async t => {
  const received = [];
  let behavior = 'parse';
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    received.push({ raw, contentType: request.headers['content-type'] });
    let status = 200, body;
    if (!raw) { status = 400; body = { error: { code: 'INVALID_REQUEST' } }; }
    else {
      try { body = { value: JSON.parse(raw) }; }
      catch { status = 400; body = { error: { code: 'MALFORMED_JSON' } }; }
    }
    if (behavior === 'accept-malformed') { status = 200; body = { value: 'accepted' }; }
    if (behavior === 'wrong-error') { status = 400; body = { error: { code: 'INVALID_REQUEST' } }; }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const result = await probe(contract, baseUrl);
  assert.deepEqual(received, [{ raw: '{', contentType: 'application/json' }]);
  assert.equal(result.passed, true, JSON.stringify(result.findings));
  const stringResult = await probe({ ...contract, smoke: [{ operationId: 'echo', body: '{', expectStatus: 200, expectBody: { value: '{' } }] }, baseUrl);
  assert.equal(stringResult.passed, true, 'ordinary JSON string bodies remain valid JSON');
  assert.equal(received.at(-1).raw, '"{"');
  behavior = 'accept-malformed';
  assert.equal((await probe(contract, baseUrl)).passed, false, 'unexpected success cannot make a negative probe green');
  behavior = 'wrong-error';
  assert.equal((await probe(contract, baseUrl)).passed, false, 'wrong error code cannot make a negative probe green');
  behavior = 'parse';
  const malformed = creator.smoke.find(item => item.expectBody?.error?.code === 'MALFORMED_JSON');
  assert(malformed, 'Creator must publish the malformed JSON probe');
  const creatorResult = await probe({ ...creator, smoke: [malformed] }, baseUrl);
  assert.equal(creatorResult.passed, true, JSON.stringify(creatorResult.findings));
  assert.equal(received.at(-1).raw, '{');
  const before = received.length;
  for (const override of [{ rawBody: 42 }, { rawBody: '{', body: 'ambiguous' }]) {
    const invalid = await probe({ ...contract, smoke: [{ ...contract.smoke[0], ...override }] }, baseUrl);
    assert.equal(invalid.passed, false, 'invalid rawBody metadata must fail locally');
    assert.match(invalid.findings[0].message, /rawBody/);
  }
  assert.equal(received.length, before, 'invalid rawBody metadata must never reach HTTP');
});

test('public example validation checks rawBody type, exclusivity and positive JSON wire shape', () => {
  const validate = smoke => validateWireExamples({ ...contract, taskId: 'rawprobe', environmentVariables: [], smoke });
  validate(contract.smoke);
  for (const override of [{ rawBody: 42 }, { rawBody: '{', body: 'ambiguous' }]) assert.throws(() => validate([{ ...contract.smoke[0], ...override }]), /rawBody/);
  validate([{ operationId: 'echo', rawBody: '"valid JSON string"', expectStatus: 200 }]);
  assert.throws(() => validate([{ operationId: 'echo', rawBody: '{', expectStatus: 200 }]), /rawBody/);
  assert.throws(() => validate([{ operationId: 'echo', rawBody: '{}', expectStatus: 200 }]), /example/);
});
