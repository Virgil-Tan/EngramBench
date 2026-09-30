import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { requestValidator, openApi } from '../templates/contract-first/runtime.mjs';
import { probe } from '../templates/contract-first/check.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import billforge from '../contracts/learning/billforge.mjs';
import clinicgrid from '../contracts/learning/clinicgrid.mjs';
import configrelay from '../contracts/learning/configrelay.mjs';
import dispatchboard from '../contracts/learning/dispatchboard.mjs';
import notifyroute from '../contracts/learning/notifyroute.mjs';

const contracts = [billforge, clinicgrid, configrelay, dispatchboard, notifyroute];
const named = (contract, id) => contract.operations.find(operation => operation.id === id);
const asRequest = example => ({ ...structuredClone(example), headers: { ...example.headers, 'content-type': 'application/json' }, hasBody: example.body !== undefined });

test('B contracts: schema, nonempty seed, wire inputs and public captures are executable', () => {
  for (const contract of contracts) assert(validatePublicContract(contract).operations > 0);
});

test('published transportErrors govern missing auth and unknown JSON fields', () => {
  for (const [contract, creation] of [[clinicgrid, 'appointment-create'], [configrelay, 'configuration-create'], [dispatchboard, 'delivery-create']]) {
    const validate = requestValidator(contract);
    const auth = validate(named(contract, 'verification-snapshot'), {});
    assert.equal(auth.valid, false);
    assert.deepEqual({ status: auth.status, code: auth.code }, contract.transportErrors.auth, contract.taskId);
    const operation = named(contract, creation), request = asRequest(operation.example);
    request.body.unpublished = true;
    const unknown = validate(operation, request);
    assert.equal(unknown.valid, false);
    assert.deepEqual({ status: unknown.status, code: unknown.code }, contract.transportErrors.unknownField, contract.taskId);
  }
});

test('parameter coercion/defaults do not coerce JSON body values or lose normalized headers', () => {
  const validate = requestValidator(clinicgrid), read = named(clinicgrid, 'appointments-list');
  const input = { query: { limit: '7' } };
  const checked = validate(read, input);
  assert(checked.valid); assert.equal(checked.query.limit, 7);
  assert.equal(validate(read, {}).query.limit, 50);
  assert.equal(validate(read, { query: { limit: ['7', '8'] } }).valid, false);
  assert.equal(validate(read, { query: { unexpected: '1' } }).valid, false);
  const confirm = named(clinicgrid, 'care-plan-visit-confirm');
  const visit = asRequest(confirm.example); visit.params.visitIndex = '2';
  assert.equal(validate(confirm, visit).params.visitIndex, 2);
  const configuration = named(configrelay, 'configuration-create'), checkConfig = requestValidator(configrelay);
  const request = asRequest(configuration.example); request.body.expectedFleetRevision = '1';
  assert.equal(checkConfig(configuration, request).valid, false, 'body numeric string must remain invalid');
  const snapshot = validate(named(clinicgrid, 'verification-snapshot'), { headers: { Authorization: 'Bearer public-admin' } });
  assert(snapshot.valid); assert.equal(snapshot.headers.authorization, 'Bearer public-admin');
});

test('a malformed known union variant is not mislabeled as containing unknown fields', () => {
  const operation = named(clinicgrid, 'waitlist-create');
  const result = requestValidator(clinicgrid)(operation, {
    headers: { 'content-type': 'application/json', 'idempotency-key': 'public-invalid-visits' },
    hasBody: true,
    body: { patientId: clinicgrid.seed.example.patients[0].patientId, priority: 1, visits: [] },
  });
  assert.equal(result.valid, false);
  assert.equal(result.code, 'INVALID_REQUEST', 'visits is a published Manager field; its empty array is the error');
});

async function serve(t, respond) {
  const server = createServer((request, response) => {
    const { status = 200, body, headers = {} } = respond(request);
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('public probes fail on 501 implementations and schema-valid empty snapshots', async t => {
  for (const contract of contracts) await t.test(contract.taskId, async t => {
    const notImplemented = await serve(t, request => request.url === '/openapi.json'
      ? { body: openApi(contract) }
      : { status: 501, body: { error: { code: 'NOT_IMPLEMENTED', message: 'Independent negative fixture', details: {} } } });
    const stubResult = await probe(contract, notImplemented, { ADMIN_TOKEN: 'public-admin' });
    assert.equal(stubResult.passed, false);
    assert(stubResult.findings.some(finding => !finding.passed && /HTTP status/.test(finding.message)));
    const emptySnapshot = { asOf: '2026-09-07T00:00:00.000Z', resources: Object.fromEntries(Object.keys(contract.schemas.SnapshotResources.properties).map(key => [key, []])), work: [], events: [] };
    const emptyServer = await serve(t, () => ({ body: emptySnapshot }));
    const snapshotOnly = { ...contract, smoke: [contract.smoke.find(probe => probe.operationId === 'verification-snapshot')] };
    const emptyResult = await probe(snapshotOnly, emptyServer, { ADMIN_TOKEN: 'public-admin' });
    assert.equal(emptyResult.passed, false);
    assert.match(emptyResult.findings[0].message, /nonempty record identity mismatch/);
  });
});

test('OpenAPI keeps the different legal success codes for B business routes', () => {
  for (const [contract, path, status] of [[clinicgrid, '/api/v1/appointments', '201'], [configrelay, '/api/v1/fleets/{fleetId}/configurations', '201'], [dispatchboard, '/api/v1/deliveries', '202'], [notifyroute, '/api/v1/notifications', '200'], [billforge, '/api/v1/invoices', '200']]) {
    assert(openApi(contract).paths[path].post.responses[status].content['application/json']);
  }
});

test('public probes reject JSON successes with the wrong response media type', async t => {
  const base = await serve(t, () => ({ body: { status: 'ok' }, headers: { 'content-type': 'text/plain' } }));
  const result = await probe({ ...clinicgrid, smoke: [{ operationId: 'health', expectStatus: 200 }] }, base, {});
  assert.equal(result.passed, false, 'valid JSON bytes are not an application/json response');
});
