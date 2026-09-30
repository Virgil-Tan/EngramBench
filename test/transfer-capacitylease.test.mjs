import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import contract from '../contracts/transfer/capacitylease.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import * as runtime from '../templates/contract-first/runtime.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { createFixtureFactory, makeCapacityBoundaryFixture, makePerformanceFixture } from '../evaluators/transfer/capacitylease/v2/lib/fixtures.mjs';
import { assertCapacitySlices } from '../evaluators/transfer/capacitylease/v2/lib/oracle.mjs';
import { assertPublishedOpenApi } from '../evaluators/transfer/capacitylease/v2/lib/public-wire.mjs';
import { assertCompatibilityAdapter, adaptCompatibilityResponse } from '../evaluators/transfer/capacitylease/v2/lib/compatibility.mjs';
import { emptySeed, leaseRequest, gangRequest, createLease, cancelAdmission, collection } from '../evaluators/transfer/capacitylease/v2/cases/helpers.mjs';
import { CASES } from '../evaluators/transfer/capacitylease/v2/cases/index.mjs';
const options = { evaluationSeed: 'author-wire-regression', caseId: 'A-03', baseTime: '2026-09-07T00:00:00.000Z' };
const f = createFixtureFactory(options), compile = runtime.validator(contract);

test('Capacity public operations, linked lease/slice seed and captured-clock Gang smoke compile', () => {
  assert.deepEqual(validatePublicContract(contract), { operations: 15, probes: 9, schemas: 22 });
  assert.equal(CASES.length, 49);
  const seed = contract.seed.example;
  assert.equal(seed.capacityLeases[0].ownerId, seed.owners[0].ownerId);
  assert.equal(seed.capacitySlices[0].poolId, seed.capacityLeases[0].poolId);
  assertCapacitySlices({ pools: seed.capacityPools, leases: seed.capacityLeases, slices: seed.capacitySlices });
  assert(contract.smoke.some(step => step.capture?.createdHoldToken));
  assert(contract.smoke.some(step => step.body?.startAt === '${publicClock+3600000ms}'));
});

test('Capacity uses the author OpenAPI baseline and refuses all historical submission adapters', () => {
  const document = runtime.openApi(contract), author = { contract, runtime };
  assertPublishedOpenApi(document, author);
  document.components.schemas.GangLeaseMember.properties.units = { type: 'string' };
  assert.throws(() => assertPublishedOpenApi(document, author));
  assert.throws(() => assertCompatibilityAdapter('capacitylease-legacy'), /forbids/);
  const json = { leaseId: 'unchanged', nested: { value: 1 } };
  assert.equal(adaptCompatibilityResponse(undefined, { json }), json);
  assert.throws(() => collection([{ leaseId: 'unpublished-array-envelope' }]), /items array/);
});

test('Capacity real private boundary/performance seeds conform and retain independent conservation checks', () => {
  const check = compile(contract.seed.schema);
  for (const fixture of [makeCapacityBoundaryFixture(options), makePerformanceFixture(options)]) {
    assert(check(fixture.seed), JSON.stringify(check.errors));
    const model = { pools: fixture.seed.capacityPools, leases: fixture.seed.capacityLeases, slices: fixture.seed.capacitySlices };
    assertCapacitySlices(model);
  }
  const fixture = makeCapacityBoundaryFixture(options), slices = structuredClone(fixture.seed.capacitySlices); slices[0].availableUnits++;
  assert.throws(() => assertCapacitySlices({ pools: fixture.seed.capacityPools, leases: fixture.seed.capacityLeases, slices }), /independent interval model/);
});

test('Capacity actual one-Pool/Gang request helpers use the fixed public route and scalar types', async () => {
  const fixture = emptySeed(f, 'helpers'), check = runtime.requestValidator(contract), calls = [];
  const ctx = { ...f, mutate: async (_base, path, key, body) => {
    const route = runtime.matchOperation(contract.operations, 'POST', path);
    const result = check(route.operation, { params: route.params, body, hasBody: true, headers: { 'content-type': 'application/json', 'idempotency-key': key } });
    assert(result.valid, JSON.stringify(result)); calls.push({ path, body });
    return { status: 201, json: { leaseId: f.uuid('created') } };
  } };
  await createLease(ctx, { baseUrl: 'http://localhost' }, 'legacy', leaseRequest(f, fixture.ids, 'legacy'), 201);
  await createLease(ctx, { baseUrl: 'http://localhost' }, 'gang', gangRequest(f, fixture.ids, 'gang'), 201);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.members.map(member => member.poolId), [...calls[1].body.members.map(member => member.poolId)].sort());
  for (const call of calls) assert.equal(call.path, '/api/v1/capacity-leases');
});

test('Capacity actual seed negative case marks only malformed schema families', async () => {
  const check = compile(contract.seed.schema), calls = [], state = { asOf: f.at(), resources: {}, work: [], events: [] };
  const ctx = { ...f, migrate: async () => {}, startApi: async () => ({ baseUrl: 'http://localhost' }), snapshot: async () => state,
    seed: async (value, options = {}) => { const valid = check(value); if (options.contractExpectation !== 'invalid') assert(valid, JSON.stringify(check.errors)); calls.push({ version: value.seedVersion, marker: options.contractExpectation, valid }); return { exitCode: calls.length <= 2 ? 0 : 1, stdout: '', stderr: 'SEED_VERSION_CONFLICT' }; } };
  await CASES.find(item => item.id === 'A-03').run(ctx);
  assert.deepEqual(calls.filter(c => c.marker).map(c => Number(c.version.split('-').at(-1))), [0, 3, 4, 5, 6]);
  assert(calls.filter(c => !c.marker).every(c => c.valid));
});

test('Capacity cancellation helper sends no body instead of mutate default empty JSON', async () => {
  let sent;
  await cancelAdmission({ request: async (_base, path, options) => { sent = { path, options }; } }, 'http://localhost', f.uuid('admission'), f.key('cancel'));
  assert.equal(sent.options.method, 'DELETE');
  assert(!Object.hasOwn(sent.options, 'json'));
  assert(!Object.hasOwn(sent.options, 'raw'));
  const route = runtime.matchOperation(contract.operations, 'DELETE', sent.path);
  assert(runtime.requestValidator(contract)(route.operation, { params: route.params, headers: sent.options.headers, hasBody: false }).valid);
});

test('Capacity author mismatch attribution and original numeric domain error codes remain distinct', async () => {
  const root = await mkdtemp(join(tmpdir(), 'capacity-author-contract-'));
  try {
    await writeFile(join(root, 'contract.json'), JSON.stringify(contract));
    await symlink(new URL('../templates/contract-first/runtime.mjs', import.meta.url).pathname, join(root, 'runtime.mjs'));
    const boundary = await evaluatorContract(root), fixture = emptySeed(f, 'error');
    boundary.seed(fixture.seed);
    assert.throws(() => boundary.seed({ ...fixture.seed, unknown: [] }), error => error.origin === 'evaluator');
    const operation = contract.operations.find(op => op.id === 'create-lease'), check = runtime.requestValidator(contract);
    const input = { body: leaseRequest(f, fixture.ids, 'error'), hasBody: true, headers: { 'content-type': 'application/json', 'idempotency-key': f.key('error') } };
    input.body.priority = 0.5; assert.equal(check(operation, input).code, 'INVALID_LEASE_INTERVAL');
    input.body = gangRequest(f, fixture.ids, 'error'); input.body.members[0].units = 0.5;
    assert.equal(check(operation, input).code, 'INVALID_GANG_MEMBERS');
    input.body.members[0].units = '1'; assert.equal(check(operation, input).code, 'INVALID_REQUEST');
    assert.throws(() => boundary.request('/api/v1/capacity-leases', { method: 'POST', headers: input.headers, json: input.body }), error => error.origin === 'evaluator');
  } finally { await rm(root, { recursive: true, force: true }); }
});
