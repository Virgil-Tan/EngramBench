import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/coldchaincontrol.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { matchOperation, openApi, requestValidator, validator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/coldchaincontrol/v2/fixtures/index.mjs';
import { assertOpenApiContract, assertPublishedResponse } from '../evaluators/transfer/coldchaincontrol/v2/oracles/openapi.mjs';
import { readFile } from 'node:fs/promises';
import { validateManifest } from '../evaluators/transfer/coldchaincontrol/v2/lib/scoring.mjs';
import * as helpers from '../evaluators/transfer/coldchaincontrol/v2/cases/helpers.mjs';
import { A_CASES } from '../evaluators/transfer/coldchaincontrol/v2/cases/a.mjs';

const factory = caseId => createFixtureFactory({ evaluationSeed: 'author-alignment-regression', caseId, baseTime: '2026-09-07T00:00:00Z' });
const compile = validator(contract);

test('ColdChain public route examples, closed resources and linked seed compile', () => {
  assert.equal(validatePublicContract(contract).operations, 32);
  const seed = contract.seed.example;
  assert.equal(seed.devices[0].carrierId, seed.carriers[0].carrierId);
  assert.equal(seed.deviceCredentials[0].deviceId, seed.devices[0].deviceId);
  assert.equal(seed.configAssignments[0].configRevisionId, seed.configRevisions[0].configRevisionId);
  assert.equal(seed.configAssignments[0].deviceId, seed.devices[0].deviceId);
  for (const name of ['Work', 'Event', 'ShipmentTimeline']) assert.equal(contract.schemas[name].additionalProperties, false);
  assert(contract.smoke.some(step => step.expectContains?.some(check => check.path.includes('devices'))));
});

test('ColdChain hidden OpenAPI oracle accepts the author baseline and rejects string temperature', () => {
  const document = openApi(contract);
  assertOpenApiContract(document);
  document.components.schemas.TelemetryReading.properties.temperatureMilliC = { type: 'string' };
  assert.throws(() => assertOpenApiContract(document), /temperatureMilliC integer/);
});

test('ColdChain private seed families and a bounded performance graph obey the public schema', () => {
  const f = factory('A-03'), check = compile(contract.seed.schema);
  for (const name of ['base', 'empty', 'config', 'credential', 'shipment', 'telemetry', 'excursion', 'notification', 'custody', 'recall', 'idempotency', 'work', 'migration', 'browser']) {
    assert(check(f[name]().seed), `${name}: ${JSON.stringify(check.errors)}`);
  }
  assert(check(f.performanceSeed({ tenantCount: 2, deviceCount: 6, shipmentCount: 4 }).seed), JSON.stringify(check.errors));
});

test('ColdChain actual private request helpers use the public wire, including signed headers', async () => {
  const f = factory('A-09'), fixture = f.recall(), validate = requestValidator(contract), calls = [];
  const request = async (_base, path, options = {}) => {
    const route = matchOperation(contract.operations, options.method ?? 'GET', new URL(path, 'http://localhost').pathname);
    assert(route, path);
    const result = validate(route.operation, { params: route.params, headers: options.headers, body: options.json, hasBody: options.json !== undefined });
    if (options.contractExpectation !== 'invalid') assert(result.valid, `${route.operation.id}: ${JSON.stringify(result)}`);
    calls.push({ id: route.operation.id, options, valid: result.valid });
    return { status: route.operation.status, json: { configRevisionId: f.uuid('config'), configAssignmentId: f.uuid('assignment'), deviceCredentialId: f.uuid('credential'), shipmentId: f.uuid('shipment'), custodyChainId: f.uuid('chain'), recallId: f.uuid('recall') } };
  };
  const ctx = { fixtures: f, key: f.key, at: f.at, snapshot: async () => ({ asOf: f.at() }), request,
    mutate: (base, path, key, json, options = {}) => request(base, path, { ...options, method: options.method ?? 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key, ...options.headers }, json }) };
  await helpers.createConfig(ctx, 'http://localhost', fixture, 'example');
  await helpers.publishConfig(ctx, 'http://localhost', f.uuid('config'), 1);
  await helpers.createAssignment(ctx, 'http://localhost', fixture, f.uuid('config'));
  await helpers.rotateCredential(ctx, 'http://localhost', fixture);
  await helpers.revokeCredential(ctx, 'http://localhost', fixture, 1);
  await helpers.createShipment(ctx, 'http://localhost', fixture);
  await helpers.createCustody(ctx, 'http://localhost', fixture);
  await helpers.createRecall(ctx, 'http://localhost', fixture);
  await helpers.ingest(ctx, 'http://localhost', fixture, f.reading(fixture, 'signed'));
  await helpers.ingest(ctx, 'http://localhost', fixture, f.reading(fixture, 'fractional', { sequence: 1.5 }), 'fractional', { expectSuccess: false, contractExpectation: 'invalid' });
  assert(calls.slice(0, -1).every(call => call.valid));
  assert.equal(calls.at(-1).valid, false);
  assert.equal(calls.at(-1).options.contractExpectation, 'invalid');
});

test('ColdChain seed corruption case marks only intentional malformed wire inputs', async () => {
  const f = factory('A-03'), fixture = f.config(), check = compile(contract.seed.schema), calls = [];
  const state = { schemaVersion: 1, asOf: f.at(), resources: Object.fromEntries(Object.entries(fixture.seed).filter(([, value]) => Array.isArray(value))), work: [], events: [], managerResources: { custodyChains: [], custodyHandoffs: [], recallOrders: [], quarantineActions: [] } };
  state.resources.deviceCredentials = state.resources.deviceCredentials.map(({ secret, ...record }) => record);
  for (const records of Object.values(state.resources)) records.sort((a, b) => String(Object.values(a)[0]).localeCompare(String(Object.values(b)[0])));
  const ctx = { fixtures: f, uuid: f.uuid, migrate: async () => {}, startApi: async () => ({ baseUrl: 'http://localhost' }), snapshot: async () => structuredClone(state), pass: () => ({ status: 'passed' }),
    seed: async (value, options = {}) => { const valid = check(value); if (options.contractExpectation !== 'invalid') assert(valid, JSON.stringify(check.errors)); calls.push({ version: value.seedVersion, invalid: options.contractExpectation === 'invalid', valid }); return { exitCode: calls.length === 1 ? 0 : 1, stdout: '', stderr: '' }; } };
  await A_CASES.find(item => item.id === 'A-03').run(ctx);
  assert.deepEqual(calls.filter(call => call.invalid).map(call => call.version), ['unknown-member', 'bad-state']);
  assert(calls.filter(call => !call.invalid).every(call => call.valid));
});

test('ColdChain device header failures differ from body shape failures', () => {
  const operation = contract.operations.find(op => op.id === 'ingest-telemetry'), check = requestValidator(contract);
  const input = { ...structuredClone(operation.example), hasBody: true };
  input.headers['content-type'] = 'application/json';
  delete input.headers['X-Device-Signature'];
  assert.equal(check(operation, input).code, 'INVALID_DEVICE_SIGNATURE');
  input.headers['X-Device-Signature'] = '0'.repeat(64);
  input.body.sequence = 1.5;
  const result = check(operation, input);
  assert.equal(result.status, 400); assert.equal(result.code, 'INVALID_REQUEST');
});

test('ColdChain V2 exact response contract rejects guessed wrappers/statuses and malformed cursors', () => {
  const response = (status, json) => ({ status, json });
  assertPublishedResponse('GET', '/api/v1/excursions', response(200, { items: [], nextCursor: null }));
  for (const json of [[], { items: [] }, { items: [], cursor: null }, { items: [], nextCursor: 7 }, { items: [], nextCursor: null, extra: true }]) {
    assert.throws(() => assertPublishedResponse('GET', '/api/v1/excursions', response(200, json)), /published response/);
  }
  assert.throws(() => assertPublishedResponse('GET', '/api/v1/excursions', response(201, { items: [], nextCursor: null })), /published status/);
  assertPublishedResponse('GET', '/api/v1/devices/{deviceId}/config', response(200, contract.seed.example.configRevisions[0]));
  assert.throws(() => assertPublishedResponse('GET', '/api/v1/devices/{deviceId}/config', response(200, { configRevision: contract.seed.example.configRevisions[0] })), /published response/);
});

test('ColdChain author-approved policies close gaps without implying live certification', async () => {
  const root = new URL('../evaluators/transfer/coldchaincontrol/v2/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.v2.json', root)));
  const map = JSON.parse(await readFile(new URL('contract-map.v2.json', root)));
  assert.equal(validateManifest(manifest, map), true);
  assert.deepEqual(manifest.specGaps.map(g => g.id), []);
  assert.equal(manifest.formalReady, false);
  for (const id of ['A-04', 'A-07', 'D-01']) assert.deepEqual(manifest.cases.find(c => c.id === id).blockedAssertions ?? [], []);
});

test('ColdChain A-07 runs exact cursor contract with restart continuity and catches wrong envelopes', async () => {
  const f = factory('A-07'); let seed, wrongEnvelope = false;
  const ctx = { fixtures: f, uuid: f.uuid, at: f.at, mark: () => {}, migrate: async () => {}, seed: async value => { seed = value; },
    startApi: async () => ({ baseUrl: 'http://public-test' }), stop: async () => {}, snapshot: async () => ({ asOf: f.at() }), pass: details => details ?? { status: 'passed' },
    request: async (_base, path) => {
      const q = new URL(path, 'http://public-test').searchParams;
      let status = 200, json;
      if (q.get('cursor') === 'not-opaque') { status = 400; json = { error: { code: 'INVALID_REQUEST', message: 'bad cursor', details: {} } }; }
      else {
        const all = seed.excursions.filter(row => row.tenantId === q.get('tenantId') && (!q.get('shipmentId') || row.shipmentId === q.get('shipmentId')) && (!q.get('kind') || row.kind === q.get('kind')) && (!q.get('state') || row.state === q.get('state')));
        const offset = Number(q.get('cursor')?.slice(5) ?? 0), limit = Number(q.get('limit'));
        const items = all.slice(offset, offset + limit), nextCursor = offset + limit < all.length ? `page-${offset + limit}` : null;
        json = wrongEnvelope ? { items, cursor: nextCursor } : { items, nextCursor };
      }
      return { status, json, text: JSON.stringify(json) };
    } };
  const run = () => A_CASES.find(c => c.id === 'A-07').run(ctx);
  assert.deepEqual(await run(), { status: 'passed' });
  wrongEnvelope = true;
  await assert.rejects(run(), /published response/);
});
