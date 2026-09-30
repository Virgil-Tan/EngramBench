import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import contract from '../contracts/transfer/parcelflow.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { validator, openApi, requestPath, expand, requestValidator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory, makeAllocationFixture, makeSplitFixture, makeSeedFixture, makeHotStockFixture, makeBacklogFixture } from '../evaluators/transfer/parcelflow/v2/fixtures/index.mjs';
import { createCaseContext } from '../evaluators/transfer/parcelflow/v2/lib/runtime.mjs';
import { allocationPlan, inventoryProjection, assertEventLedger } from '../evaluators/transfer/parcelflow/v2/oracles/index.mjs';
import { loadPublicWire, assertOpenApiSource } from '../evaluators/transfer/parcelflow/v2/oracles/public-wire.mjs';
import { CASES } from '../evaluators/transfer/parcelflow/v2/cases/index.mjs';

const settings = { evaluationSeed: 'public-wire-regression', caseId: 'A-05', baseTime: '2032-04-05T06:07:08.000Z' };
const factory = createFixtureFactory(settings);
const compile = validator(contract);
const response = (status, json) => ({ status, json, text: JSON.stringify(json) });

test('ParcelFlow complete published operations, dynamic smoke and real OpenAPI oracle agree', () => {
  assert.deepEqual(validatePublicContract(contract), { operations: 13, probes: 8, schemas: 15 });
  assert.equal(CASES.length, 49);
  const document = openApi(contract);
  assert.doesNotThrow(() => assertOpenApiSource(JSON.stringify(document)));
  const noSchema = structuredClone(document); delete noSchema.components.schemas.Order;
  assert.throws(() => assertOpenApiSource(JSON.stringify(noSchema)), /schemas/);
  const noAuth = structuredClone(document); noAuth.paths['/api/admin/warehouses'].post.parameters = [];
  assert.throws(() => assertOpenApiSource(JSON.stringify(noAuth)), /parameters/);
  const noWebhook = structuredClone(document); delete noWebhook.webhooks;
  assert.throws(() => assertOpenApiSource(JSON.stringify(noWebhook)), /webhook/);
  assert.throws(() => assertOpenApiSource('openapi: 3.1.0\npaths: {}'), SyntaxError, 'V2 explicitly publishes canonical JSON-compatible YAML, not file-presence validation');
});

test('ParcelFlow actual private seed families have valid linked references', () => {
  const valid = compile(contract.seed.schema);
  for (const make of [makeAllocationFixture, makeSplitFixture, makeSeedFixture, makeHotStockFixture, makeBacklogFixture]) {
    const { seed } = make(settings); assert(valid(seed), `${make.name}: ${JSON.stringify(valid.errors)}`);
    const warehouses = new Set(seed.warehouses.map(row => row.id)), skus = new Set(seed.skus.map(row => row.id));
    for (const row of seed.stockPositions) assert(warehouses.has(row.warehouseId) && skus.has(row.skuId));
    for (const row of seed.orders) { assert(warehouses.has(row.warehouseId)); for (const line of row.lines) assert(skus.has(line.skuId)); }
  }
  const seed = contract.seed.example; assert(seed.orders.length && seed.stockPositions.length);
  assert.equal(seed.orders[0].warehouseId, seed.warehouses[0].id);
  assert.equal(seed.orders[0].lines[0].skuId, seed.skus[0].id);
});

test('ParcelFlow mounted author boundary and real private helpers preserve raw JSON, headers and bodyless cancellation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'parcel-public-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'contract.json'), JSON.stringify(contract));
  await writeFile(join(directory, 'runtime.mjs'), `export * from ${JSON.stringify(pathToFileURL(resolve('templates/contract-first/runtime.mjs')).href)};`);
  const boundary = await evaluatorContract(directory), mounted = await loadPublicWire(directory);
  assert.doesNotThrow(() => mounted.assertOpenApiSource(JSON.stringify(openApi(contract))));
  for (const operation of contract.operations) {
    const example = expand(operation.example, { ADMIN_TOKEN: 'public-author' });
    assert.doesNotThrow(() => boundary.request(requestPath(operation, example), { method: operation.method, headers: example.headers, ...(example.body !== undefined ? { json: example.body } : {}) }), operation.id);
  }
  const ctx = await createCaseContext({ workspace: process.cwd(), ...settings, manageDatabase: false });
  t.after(() => ctx.teardown()); const calls = [];
  ctx.request = async (_base, path, options) => { boundary.request(path, options); calls.push({ path, ...options }); return response(200, {}); };
  await ctx.adminRequest('http://author', '/api/admin/warehouses', factory.key('warehouse'), { code: 'WAREHOUSE', name: 'Created', priority: 1 });
  const orderBody = { customerReference: 'fresh', lines: [{ skuId: factory.uuid('sku'), quantity: 1 }] };
  await ctx.orderRequest('http://author', factory.key('order'), orderBody);
  await ctx.cancelRequest('http://author', factory.uuid('order'), factory.key('cancel'));
  assert.match(calls[0].headers.authorization, /^Bearer /);
  assert(calls.every(call => call.headers['idempotency-key'].length >= 8));
  assert(!Object.hasOwn(calls[2], 'json') && !Object.hasOwn(calls[2], 'raw'));
  assert.doesNotThrow(() => boundary.request('/api/orders', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': factory.key('raw') }, raw: JSON.stringify(orderBody, null, 2) }));
  assert.throws(() => boundary.request('/api/orders', { method: 'POST', json: orderBody }), e => e.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.throws(() => boundary.seed({ ...makeSeedFixture(settings).seed, unexpected: true }), e => e.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.doesNotThrow(() => boundary.request('/api/orders', { method: 'POST', raw: '{', contractExpectation: 'invalid' }));
});

test('ParcelFlow public transport distinguishes missing and malformed parameter errors', () => {
  const validate = requestValidator(contract), operation = contract.operations.find(op => op.id === 'create-warehouse');
  const value = { params: {}, query: {}, body: operation.example.body, hasBody: true, headers: { 'content-type': 'application/json' } };
  let result = validate(operation, value); assert.equal(result.code, 'IDEMPOTENCY_KEY_REQUIRED'); assert.equal(result.status, 400);
  value.headers['idempotency-key'] = 'short'; result = validate(operation, value); assert.equal(result.code, 'INVALID_IDEMPOTENCY_KEY');
  value.headers['idempotency-key'] = factory.key('valid'); result = validate(operation, value); assert.equal(result.code, 'ADMIN_AUTH_REQUIRED');
  value.headers.authorization = 'Basic wrong'; result = validate(operation, value); assert.equal(result.code, 'ADMIN_AUTH_INVALID'); assert.equal(result.status, 401);
});

test('ParcelFlow independent allocation, conservation and Event oracles retain business checks', () => {
  const full = makeAllocationFixture(settings), split = makeSplitFixture(settings);
  assert.equal(allocationPlan(full.warehouses, full.lines, full.stock, { allowSplit: true }).fulfillments[0].warehouseId, full.completeWarehouseId);
  const result = allocationPlan(split.warehouses, split.lines, split.stock, { allowSplit: true });
  assert.equal(result.kind, 'split');
  assert.equal(result.fulfillments.reduce((sum, group) => sum + group.allocations.reduce((sum, item) => sum + item.quantity, 0), 0), 10);
  assert.deepEqual(inventoryProjection({ onHand: 10, reserved: 2 }, 2, 'ship'), { onHand: 8, reserved: 0, available: 8 });
  const orderId = factory.uuid('event-order'), event = { eventId: factory.uuid('event'), aggregateId: orderId, aggregateType: 'order', sequence: 1, type: 'order.allocated', occurredAt: factory.at(), data: { orderId, fulfillmentId: factory.uuid('group'), warehouseId: factory.uuid('warehouse'), lines: [{ skuId: factory.uuid('sku'), quantity: 2 }] } };
  const entry = { json: event, headers: { 'content-type': 'application/json', 'x-parcelflow-event-id': event.eventId, 'x-parcelflow-event-type': event.type }, acknowledged: true, responseStatus: 204 };
  assert.deepEqual(assertEventLedger([entry, structuredClone(entry)], [orderId]), { uniqueEvents: 1, successfulOrders: 1 });
  assert.throws(() => assertEventLedger([{ ...entry, json: { ...event, data: { orderId } } }]), /wire schema/);
  const changed = structuredClone(entry); changed.json.data.lines[0].quantity = 3;
  assert.throws(() => assertEventLedger([entry, changed]), /changed across retry/);
  assert.throws(() => assertEventLedger([{ ...entry, headers: { ...entry.headers, 'x-parcelflow-event-id': factory.uuid('wrong') } }]));
});
