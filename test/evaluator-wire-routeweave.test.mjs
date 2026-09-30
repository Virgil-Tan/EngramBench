import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { CASES } from '../evaluators/learning/routeweave/v2/cases/index.mjs';
import { createCaseContext } from '../evaluators/learning/routeweave/v2/lib/runtime.mjs';
import { validateCaseRegistry } from '../evaluators/learning/routeweave/v2/lib/execution.mjs';
import { validateManifest } from '../evaluators/learning/routeweave/v2/lib/scoring.mjs';
import { extractConsignmentView } from '../evaluators/learning/routeweave/v2/cases/helpers.mjs';
import { reconcileFinalSnapshot, sortEvidence } from '../evaluators/learning/routeweave/v2/lib/oracle.mjs';

const root = resolve(import.meta.dirname, '..');
const contractRoot = resolve(root, 'task-packages/v2/routeweave/public-contract');
const contract = JSON.parse(await readFile(resolve(contractRoot, 'contract.json')));
const boundary = await evaluatorContract(contractRoot), compile = validator(contract);
const manifest = JSON.parse(await readFile(resolve(root, 'evaluators/learning/routeweave/v2/manifest.v2.json')));
const map = JSON.parse(await readFile(resolve(root, 'evaluators/learning/routeweave/v2/contract-map.v2.json')));

async function context(t, caseId = 'A-01') {
  const ctx = await createCaseContext({ caseId, workspace: root, v1Workspace: root, evaluationSeed: 'wire-review', baseTime: '2026-01-01T00:00:00.000Z', manageDatabase: false });
  t.after(() => ctx.teardown());
  return ctx;
}

test('routeweave retains the complete 22-case registry and original scoring contract', () => {
  assert.equal(CASES.length, 22);
  assert.equal(validateManifest(manifest, map), true);
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
});

test('every routeweave case starts with a positive seed accepted by the public validator', async t => {
  const stop = new Error('author fixture captured');
  for (const item of CASES) {
    const ctx = await context(t, item.id);
    let checked = false;
    ctx.migrate = async () => {};
    ctx.seed = async value => { boundary.seed(value); checked = true; throw stop; };
    await assert.rejects(item.run(ctx), error => error === stop, item.id);
    assert.equal(checked, true, `${item.id} seed was validated before any candidate execution`);
  }
});

test('routeweave helper requests use published routes and positive bodies; only explicit negatives bypass validation', async t => {
  const ctx = await context(t), catalog = ctx.catalog(), url = 'http://127.0.0.1:1', calls = [];
  ctx.request = async (_url, path, options = {}) => { boundary.request(path, options); calls.push({ path, options }); return { status: 200, json: {} }; };
  ctx.mutate = (base, path, key, json, options = {}) => ctx.request(base, path, { ...options, method: 'POST', headers: { 'Idempotency-Key': key }, json });
  const shipmentId = catalog.shipment.shipmentId, pieceId = ctx.uuid('piece'), consignmentId = ctx.uuid('consignment');
  await ctx.createTenant(url, { name: 'Wire tenant' });
  const { hubId: _hubId, ...hub } = catalog.hubs[0];
  await ctx.createHub(url, hub);
  const { carrierId: _carrierId, state: _state, ...carrier } = catalog.carriers[0];
  await ctx.createCarrier(url, carrier);
  await ctx.createShipment(url, ctx.shipmentBody(catalog));
  await ctx.getShipment(url, shipmentId); await ctx.timeline(url, shipmentId);
  for (const type of ['PICKED_UP', 'DEPARTED', 'ARRIVED', 'DELIVERED', 'LOSS_REPORTED', 'FOUND']) await ctx.scanShipment(url, ctx.scanBody(catalog, type));
  const loss = { reason: 'Missing', observedAt: ctx.at() }, found = { observedAt: ctx.at() };
  await ctx.lossShipment(url, shipmentId, loss); await ctx.foundShipment(url, shipmentId, found);
  const reassign = { expectedRoutePlanRevision: 1, reason: 'Reroute', legs: ctx.shipmentBody(catalog).legs };
  await ctx.reassignShipment(url, shipmentId, { ...reassign, lossCaseId: ctx.uuid('loss') }); await ctx.cancelShipment(url, shipmentId);
  for (const count of [1, 100]) await ctx.createConsignment(url, ctx.consignmentBody(catalog, count));
  await ctx.getConsignment(url, consignmentId); await ctx.reassignConsignment(url, consignmentId, reassign); await ctx.cancelConsignment(url, consignmentId);
  for (const type of ['PICKED_UP', 'DEPARTED', 'ARRIVED', 'DELIVERED']) await ctx.scanPiece(url, pieceId, ctx.pieceScanBody(catalog, type));
  await ctx.lossPiece(url, pieceId, loss); await ctx.foundPiece(url, pieceId, found);
  const before = calls.length;
  await assert.rejects(ctx.createConsignment(url, ctx.consignmentBody(catalog, 101)), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.equal(calls.length, before, 'invalid positive author body is never sent');
  await ctx.createConsignment(url, ctx.consignmentBody(catalog, 101), { contractExpectation: 'invalid' });
  assert.equal(calls.at(-1).options.contractExpectation, 'invalid');
});

test('routeweave native piece and consignment snapshot records match the fixed disjoint public shapes', async t => {
  const ctx = await context(t), catalog = ctx.catalog(), seed = ctx.seedFor('snapshot', { catalog });
  const { schemaVersion, seedVersion: _version, importedAt, ...resources } = seed;
  const consignmentId = ctx.uuid('native-consignment'), pieceId = ctx.uuid('native-piece'), routePlanId = ctx.uuid('native-plan');
  resources.routePlans = [{ routePlanId, consignmentId, revision: 1, reason: 'INITIAL', priorRoutePlanId: null, createdAt: importedAt }];
  resources.transportLegs = [];
  resources.shipments = []; resources.journeyProjections = [];
  resources.consignments = [{ consignmentId, tenantId: catalog.tenantId, externalRef: 'Native', routePlanId, routePlanRevision: 1, state: 'PLANNED', createdAt: importedAt, updatedAt: importedAt, sequence: 0 }];
  resources.parcelPieces = [{ pieceId, consignmentId, pieceRef: 'piece', legacyShipmentId: null, state: 'PLANNED', createdAt: importedAt, terminalAt: null }];
  resources.pieceProjections = [{ pieceId, routePlanRevision: 1, currentLegOrdinal: null, currentHubId: null, state: 'PLANNED', lastObservedAt: null, sequence: 0 }];
  resources.scanEvents = [{ scanEventId: ctx.uuid('native-scan'), tenantId: catalog.tenantId, pieceId, scannerEventId: 'loss', type: 'LOSS_REPORTED', routePlanRevision: 1, hubId: null, legId: null, observedAt: importedAt, receivedAt: importedAt, payloadDigest: '0'.repeat(64) }];
  resources.hubs.sort((a, b) => a.hubId.localeCompare(b.hubId));
  resources.carriers.sort((a, b) => a.carrierId.localeCompare(b.carrierId));
  const snapshot = { schemaVersion, asOf: importedAt, resources, work: [], events: [] };
  const valid = compile(contract.schemas.VerificationSnapshot);
  assert.equal(valid(snapshot), true, JSON.stringify(valid.errors));
  assert.equal(reconcileFinalSnapshot(snapshot), true);
  const detail = { consignment: resources.consignments[0], pieces: resources.parcelPieces, projections: resources.pieceProjections };
  assert.deepEqual(extractConsignmentView(detail), detail);
  assert.throws(() => extractConsignmentView({ data: detail }), /wrapper/);
  snapshot.resources.scanEvents[0].shipmentId = null;
  assert.equal(valid(snapshot), false, 'legacy nullable shipmentId is not part of native PieceScanEvent');
  assert.throws(() => reconcileFinalSnapshot(snapshot), /ScanEvent keys/);
});

test('routeweave evidence ties follow public scanEventId rather than caller scannerEventId', async t => {
  const ctx = await context(t), catalog = ctx.catalog();
  const { routePlanRevision: _revision, ...body } = ctx.scanBody(catalog, 'ARRIVED');
  const scan = { ...body, receivedAt: ctx.at(), payloadDigest: '0'.repeat(64) };
  const events = [
    { ...scan, scanEventId: '00000000-0000-4000-8000-000000000002', scannerEventId: 'a' },
    { ...scan, scanEventId: '00000000-0000-4000-8000-000000000001', scannerEventId: 'z' },
  ];
  const valid = compile(contract.schemas.ScanEvent);
  for (const event of events) assert.equal(valid(event), true, JSON.stringify(valid.errors));
  const expected = [events[1], events[0]];
  assert.deepEqual(sortEvidence(events), expected);
  assert.deepEqual(sortEvidence([...events].reverse()), expected);
});
