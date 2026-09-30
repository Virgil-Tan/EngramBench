import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { CASES } from '../evaluators/learning/geopulse/v2/cases/index.mjs';
import { validateCaseRegistry } from '../evaluators/learning/geopulse/v2/lib/execution.mjs';
import { validateManifest } from '../evaluators/learning/geopulse/v2/lib/scoring.mjs';
import { createFixtureFactory, coreSeed, geometryFixture, identityFixture, timelineFixture, lateWorkedExample, performanceContract } from '../evaluators/learning/geopulse/v2/fixtures/index.mjs';
import { acceptEvent, acceptBatch, createBundle, publishBundle, rollbackBundle, readBundle, queryRegions, scaleRegionSeed } from '../evaluators/learning/geopulse/v2/cases/helpers.mjs';
import { jitterSeed, spatialSeed } from '../evaluators/learning/geopulse/v2/cases/e.mjs';
import { classifyPoint, isValidPolygon, assertContiguousTransitions } from '../evaluators/learning/geopulse/v2/oracles/index.mjs';

const root = resolve(import.meta.dirname, '..');
const contractRoot = resolve(root, 'task-packages/v2/geopulse/public-contract');
const contract = JSON.parse(await readFile(resolve(contractRoot, 'contract.json')));
const boundary = await evaluatorContract(contractRoot), compile = validator(contract);
const baseTime = '2031-04-05T06:07:08.000Z';
const fixture = caseId => createFixtureFactory({ evaluationSeed: 'wire-regression', caseId, baseTime });
const context = caseId => {
  const fixtures = fixture(caseId);
  return { fixtures, caseId, evaluationSeed: fixtures.evaluationSeed, uuid: fixtures.uuid, at: fixtures.at, key: fixtures.key,
    equal: (actual, expected) => assert.deepEqual(actual, expected), ok: value => assert.ok(value) };
};

test('GeoPulse retains the complete frozen 22-case registry and scoring weights', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'evaluators/learning/geopulse/v2/manifest.v2.json')));
  const map = JSON.parse(await readFile(resolve(root, 'evaluators/learning/geopulse/v2/contract-map.v2.json')));
  assert.equal(validateManifest(manifest, map), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
});

test('GeoPulse positive seeds, geometry and event fixtures conform for all cases', () => {
  const versionSchema = compile({ $ref: '#/$defs/RegionVersion' });
  for (const { id } of CASES) {
    const fixtures = fixture(id);
    for (const includeOtherTenant of [false, true]) boundary.seed(coreSeed(fixtures, { includeOtherTenant }));
    const geometry = geometryFixture(fixtures), timeline = timelineFixture(fixtures), late = lateWorkedExample(fixtures), identity = identityFixture(fixtures);
    for (const version of [...geometry.versions, timeline.regionVersion, late.regionVersion]) {
      assert.equal(versionSchema(version), true, JSON.stringify(versionSchema.errors));
      assert.equal(isValidPolygon(version.polygon).ok, true);
    }
    for (const event of [...timeline.events, ...late.canonical, late.tooOld, identity.event, identity.sameEventIdDifferentBody, identity.sameSequenceDifferentEventId, identity.otherTenant]) {
      boundary.request('/api/v1/location-events', { method: 'POST', headers: { 'Idempotency-Key': id }, json: event });
    }
    assert(late.tooOld.deviceSequence > 0);
    assert.equal(new Set([...late.canonical, late.tooOld].map(({ deviceSequence }) => deviceSequence)).size, 7);
  }
});

test('GeoPulse full spatial and overlapping-region fixtures use valid six-decimal coordinates', () => {
  const ctx = context('E-04');
  for (const seed of [scaleRegionSeed(ctx, 100), spatialSeed(ctx, performanceContract().query.regions)]) {
    boundary.seed(seed);
    for (const version of seed.regionVersions) assert.equal(isValidPolygon(version.polygon).ok, true, JSON.stringify(version.polygon));
  }
  const polygon = [[0.004001, 0], [0.014001, 0], [0.014001, 0.01], [0.004001, 0.01], [0.004001, 0]];
  assert.equal(classifyPoint(polygon, { longitude: 0.004001, latitude: 0.005 }).state, 'BOUNDARY');
  assert.throws(() => classifyPoint(polygon, { longitude: 0.0040011, latitude: 0.005 }), /six fractional/);
});

test('GeoPulse full jitter seed passes the published decimal multipleOf constraint', () => {
  const seed = jitterSeed(context('E-03'), performanceContract().jitter);
  for (const version of seed.regionVersions) assert.equal(isValidPolygon(version.polygon).ok, true);
  assert.equal(seed.regionVersions[1].polygon[1][0], -9.89);
  boundary.seed(seed);
});

test('GeoPulse helper requests use fixed envelopes and required idempotency headers', async () => {
  const ctx = context('A-05'), seed = coreSeed(ctx.fixtures), event = identityFixture(ctx.fixtures).event;
  const bundle = { ...contract.seed.example.regionBundles[0], currentRevision: 0, currentBundleRevisionId: null };
  const revision = contract.seed.example.regionBundleRevisions[0];
  const requests = [];
  ctx.request = async (_base, path, options = {}) => {
    assert.notEqual(options.contractExpectation, 'invalid');
    boundary.request(path, options);
    requests.push({ path, options });
    let json;
    if (path.endsWith('/location-events')) json = { ...event, receivedAt: baseTime, bundleRevisionId: null };
    else if (path.endsWith('/location-events/batch')) json = { items: [{ ...event, receivedAt: baseTime, bundleRevisionId: null }], nextCursor: null };
    else if (path.endsWith('/regions/query')) json = { bundleRevisionId: null, items: options.json.points.map(({ queryId }) => ({ queryId, matches: [] })) };
    else if (path.endsWith('/publish') || path.endsWith('/rollback')) json = { bundle, revision };
    else if ((options.method ?? 'GET') === 'GET') json = { bundle, revisions: [revision] };
    else json = { bundle };
    return { status: 200, json };
  };
  ctx.mutate = (base, path, key, json, options = {}) => ctx.request(base, path, { ...options, method: 'POST', headers: { 'Idempotency-Key': key }, json });
  const base = 'http://127.0.0.1:1';
  await acceptEvent(ctx, base, event);
  await acceptBatch(ctx, base, [event]);
  await createBundle(ctx, base, seed.tenants[0].tenantId);
  await publishBundle(ctx, base, bundle.bundleId, { expectedRevision: 0, effectiveFrom: ctx.at(), regionVersionIds: [seed.regionVersions[0].regionVersionId] });
  await rollbackBundle(ctx, base, bundle.bundleId, { expectedRevision: 1, targetRevision: 1, effectiveFrom: ctx.at({ hours: 1 }) });
  await readBundle(ctx, base, bundle.bundleId);
  await queryRegions(ctx, base, seed.tenants[0].tenantId, [{ queryId: 'positive', longitude: 0.005, latitude: 0.005, at: ctx.at() }]);
  assert.equal(requests.length, 7);
});

test('GeoPulse marks only malformed wire negatives; allowFailure cannot bypass a positive publication', async () => {
  const ctx = context('A-02'), event = identityFixture(ctx.fixtures).event, calls = [];
  ctx.mutate = async (_base, path, key, json, options = {}) => {
    const request = { ...options, method: 'POST', headers: { 'Idempotency-Key': key }, json };
    boundary.request(path, request);
    calls.push(request);
    return { status: 400, json: { error: { code: 'INVALID_REQUEST', message: 'Invalid', details: {} } } };
  };
  const invalidEvent = { ...event, latitude: 90.000001 };
  await assert.rejects(acceptBatch(ctx, '', [invalidEvent], { expectedStatus: 400 }), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  await acceptBatch(ctx, '', [invalidEvent], { expectedStatus: 400, contractExpectation: 'invalid' });
  const body = { expectedRevision: 0, effectiveFrom: ctx.at(), regionVersionIds: [] };
  await assert.rejects(publishBundle(ctx, '', ctx.uuid('bundle'), body, { allowFailure: true }), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  await publishBundle(ctx, '', ctx.uuid('bundle'), body, { allowFailure: true, contractExpectation: 'invalid' });
  assert.equal(calls.length, 2);
  assert(calls.every(({ contractExpectation }) => contractExpectation === 'invalid'));
});

test('GeoPulse transition source/type identity is scoped to device and region', () => {
  const transition = { deviceId: 'device', regionId: 'region-a', sourceEventId: 'event', type: 'ENTER', sequence: 1 };
  assert.doesNotThrow(() => assertContiguousTransitions([transition, { ...transition, regionId: 'region-b' }]));
  assert.throws(() => assertContiguousTransitions([transition, { ...transition, sequence: 2 }]), /duplicated/);
});

test('GeoPulse E-04 captures a concurrent publication rejection instead of crashing the evaluator', async () => {
  const ctx = context('E-04'), rejected = new Error('injected publication request timeout');
  const bundle = { ...contract.seed.example.regionBundles[0], currentRevision: 0, currentBundleRevisionId: null };
  const revision = contract.seed.example.regionBundleRevisions[0];
  Object.assign(ctx, { workspace: 'geopulse-author-rejection', forWorkspace: () => ctx,
    npm: async () => ({}), migrate: async () => {}, seed: async value => boundary.seed(value), mark() {},
    startApi: async () => ({ baseUrl: 'http://author.invalid' }), startWorker: async () => ({}),
    receiver: async () => ({ url: 'http://receiver.invalid' }), startDispatcher: async () => ({}),
    mutate: async (_url, path, _key, body) => {
      if (!path.endsWith('/publish')) return { status: 200, json: { bundle } };
      if (body.expectedRevision === 1) throw rejected;
      return { status: 200, json: { bundle, revision } };
    },
    request: async () => { await tick(); return { status: 503 }; },
  });
  await assert.rejects(CASES.find(({ id }) => id === 'E-04').run(ctx), error => error === rejected);
});
