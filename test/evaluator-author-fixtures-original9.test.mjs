import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { createCaseContext as launchContext } from '../evaluators/learning/launchpass/v2/lib/runtime.mjs';
import { seedFixture } from '../evaluators/learning/launchpass/v2/lib/fixtures.mjs';
import { E_CASES as launchCases } from '../evaluators/learning/launchpass/v2/cases/e.mjs';
import { A_CASES as launchACases } from '../evaluators/learning/launchpass/v2/cases/a.mjs';
import { createCaseContext as ledgerContext } from '../evaluators/learning/ledgerbridge/v2/lib/runtime.mjs';
import { createCaseContext as artifactContext } from '../evaluators/learning/artifactvault/v2/lib/runtime.mjs';
import { seedBundle } from '../evaluators/learning/artifactvault/v2/lib/fixtures.mjs';
import { createGroup } from '../evaluators/learning/reconcilehub/v2/cases/helpers.mjs';
import { completeDelivery } from '../evaluators/learning/dispatchboard/v2/cases/helpers.mjs';
import { createCaseContext as dispatchContext } from '../evaluators/learning/dispatchboard/v2/lib/runtime.mjs';
import { A_CASES as dispatchCases } from '../evaluators/learning/dispatchboard/v2/cases/a.mjs';

const root = resolve(import.meta.dirname, '..');
const tasks = ['launchpass', 'schemaharbor', 'queueforge', 'ledgerbridge', 'reconcilehub', 'evidencechain', 'artifactvault', 'firmwarefleet', 'dispatchboard'];
const boundaries = Object.fromEntries(await Promise.all(tasks.map(async task => [task, await evaluatorContract(resolve(root, `task-packages/v2/${task}/public-contract`))])));
const id = '11111111-1111-4111-8111-111111111111';
const contextOptions = { caseId: 'A-01', workspace: root, evaluationSeed: 'author-wire-regression', baseTime: '2031-04-05T06:07:08.000Z', manageDatabase: false };
const invalid = { contractExpectation: 'invalid' };
const mismatch = { code: 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH' };
const post = json => ({ method: 'POST', headers: { 'idempotency-key': 'author-wire-regression' }, json });

const regressions = [
  ['launchpass', '/api/holds', { eventId: id, customerId: id, quantity: 4 }, body => ({ ...body, quantity: 5 })],
  ['schemaharbor', `/api/v1/subjects/${id}/schema-drafts`, { schema: { name: 'Record', fields: { id: { type: 'STRING', required: true } } }, dependencies: [], expectedHeadVersion: null }, body => ({ ...body, schema: { ...body.schema, unknown: true } })],
  ['queueforge', '/api/v1/workers/perf-client-0/claim', { queueIds: [id], maxRuns: 20 }, body => ({ ...body, maxRuns: 25 })],
  ['ledgerbridge', '/api/v1/transfers', { sourceAccountId: id, destinationAccountId: id, currency: 'USD', amountMinor: 1 }, body => ({ ...body, amountMinor: 0 })],
  ['reconcilehub', '/api/v1/match-groups', { statementLineIds: [id], ledgerEntryIds: [id] }, body => ({ ...body, statementLineIds: [id, id] })],
  ['evidencechain', '/api/v1/intake-batches', { deviceId: id, batchSequence: 1, scans: [{ scanId: 'scan-1', label: 'label', sealCode: 'seal', scannedAt: contextOptions.baseTime, facilityId: id }] }, body => ({ ...body, scans: [] })],
  ['artifactvault', `/api/v1/upload-sessions/${id}/complete`, {}, () => ({ unexpected: true })],
  ['firmwarefleet', '/api/v1/firmware-images', { modelId: id, version: '1', sha256: '0'.repeat(64), size: 1, downloadPath: '/firmware/image.bin', compatibleFromVersions: ['0'] }, body => ({ ...body, version: '01' })],
  ['dispatchboard', '/api/v1/deliveries', { customerId: id, pickupZone: 'A', dropoffZone: 'B', readyAt: contextOptions.baseTime, deliverBy: '2031-04-05T07:07:08.000Z', loadUnits: 1 }, body => ({ ...body, loadUnits: 0 })],
];

for (const [task, path, validBody, malformed] of regressions) {
  test(`${task}: exact reported author mismatch is explicit only for intentional invalid input`, () => {
    const boundary = boundaries[task], body = malformed(validBody);
    assert.doesNotThrow(() => boundary.request(path, post(validBody)));
    assert.throws(() => boundary.request(path, post(body)), mismatch);
    assert.throws(() => boundary.request(path, { ...post(body), allowFailure: true }), mismatch);
    assert.doesNotThrow(() => boundary.request(path, { ...post(body), ...invalid }));
  });
}

test('all nine author registries retain the frozen manifest cases and published schemas', async () => {
  for (const task of tasks) {
    const { CASES } = await import(`../evaluators/learning/${task}/v2/cases/index.mjs`);
    const manifest = JSON.parse(await readFile(resolve(root, `evaluators/learning/${task}/v2/manifest.v2.json`)));
    assert.deepEqual(CASES.map(entry => entry.id), manifest.cases.map(entry => entry.id), task);
    const { default: authorContract } = await import(`../contracts/learning/${task}.mjs`);
    const publicContract = JSON.parse(await readFile(resolve(root, `task-packages/v2/${task}/public-contract/contract.json`)));
    assert.deepEqual(authorContract.schemas, publicContract.schemas, task);
    assert.deepEqual(authorContract.seed.schema, publicContract.seed.schema, task);
  }
});

test('LaunchPass helpers preserve explicit invalid input while keeping ordinary requests checked', async t => {
  const ctx = await launchContext(contextOptions);
  t.after(() => ctx.teardown());
  const boundary = boundaries.launchpass, calls = [];
  ctx.request = async (_base, path, options) => { boundary.request(path, options); calls.push(options); return { status: 422 }; };
  const body = { eventId: id, customerId: id, quantity: 5 };
  await assert.rejects(async () => ctx.createHold('http://localhost', body), mismatch);
  await ctx.createHold('http://localhost', body, undefined, invalid);
  await assert.rejects(async () => ctx.joinWaitlist('http://localhost', id, id, 5), mismatch);
  await ctx.joinWaitlist('http://localhost', id, id, 5, undefined, invalid);
  await ctx.createHold('http://localhost', { ...body, quantity: 1 });
  assert.deepEqual(calls.map(options => options.contractExpectation), ['invalid', 'invalid', undefined]);
  ctx.npm = async (_script, args, options) => { boundary.seed(JSON.parse(await readFile(args[1])), options); return { exitCode: 1 }; };
  const seed = { ...seedFixture(), unexpected: true };
  await assert.rejects(ctx.seed(seed, { expectFailure: true }), mismatch);
  await ctx.seed(seed, { expectFailure: true, ...invalid });
});

test('LaunchPass A-01 completes every author request with exact negative-header and body annotations', async t => {
  const ctx = await launchContext(contextOptions);
  t.after(() => ctx.teardown());
  const events = [], calls = [];
  ctx.startApi = async () => ({ baseUrl: 'http://localhost', logs: '' });
  // Run the actual case assertions; the small transport fixture only supplies responses.
  ctx.assert = (_label, operation) => operation();
  ctx.equal = (label, actual, expected) => assert.deepEqual(actual, expected, label);
  ctx.ok = (label, condition) => assert.ok(condition, label);
  const response = (status, json) => ({ status, json, text: JSON.stringify(json) });
  const error = (status, code) => response(status, { error: { code, message: code, details: [] } });
  ctx.request = async (_base, path, options = {}) => {
    boundaries.launchpass.request(path, options);
    calls.push({ path, options });
    if (options.method === 'POST') {
      assert.equal(path, '/api/admin/events');
      if (!options.headers.authorization) return error(401, 'UNAUTHORIZED');
      if (options.headers.authorization !== `Bearer ${ctx.adminToken}`) return error(403, 'FORBIDDEN');
      if (options.json.unexpected) return error(422, 'VALIDATION_ERROR');
      if (events.some(event => event.slug === options.json.slug)) return error(409, 'EVENT_EXISTS');
      const event = { ...options.json, id: ctx.uuid(`created-${events.length}`), availableCapacity: options.json.capacity, createdAt: contextOptions.baseTime };
      events.push(event);
      return response(201, { event });
    }
    const url = new URL(path, 'http://localhost');
    assert.equal(url.pathname, '/api/events');
    const cursor = url.searchParams.get('cursor');
    if (cursor === 'definitely-not-a-cursor') return error(400, 'INVALID_CURSOR');
    const query = url.searchParams.get('q')?.toLowerCase();
    const filtered = events.filter(event => !query || event.title.toLowerCase().includes(query) || event.slug.includes(query))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    const offset = cursor ? Number(cursor.slice('offset-'.length)) : 0;
    const limit = Number(url.searchParams.get('limit') ?? 50);
    return response(200, { items: filtered.slice(offset, offset + limit), nextCursor: offset + limit < filtered.length ? `offset-${offset + limit}` : null });
  };
  const result = await launchACases.find(entry => entry.id === 'A-01').run(ctx);
  assert.equal(events.length, 105);
  assert.deepEqual(result.evidence, ['105 created events were searched and cursor-paged through public HTTP']);
  const exempted = calls.filter(({ options }) => options.contractExpectation === 'invalid');
  assert.equal(exempted.length, 2, 'only missing Authorization and malformed event body bypass the wire check');
  assert.equal(exempted[0].options.headers.authorization, undefined);
  assert.equal(exempted[1].options.json.unexpected, true);
  const { contractExpectation: _invalid, ...missingHeader } = exempted[0].options;
  assert.throws(() => boundaries.launchpass.request('/api/admin/events', missingHeader), error => error.code === mismatch.code && error.details.violations.some(item => item.keyword === 'required'));
  assert.equal(calls[1].options.headers.authorization, 'Bearer incorrect');
  assert.equal(calls[1].options.contractExpectation, undefined, 'wrong credential is a semantic rejection, not a malformed header');
  assert.equal(calls.at(-1).path, '/api/events?cursor=definitely-not-a-cursor');
  assert.equal(calls.at(-1).options.contractExpectation, undefined);
});

test('LaunchPass E-01 executes all four negative seeds with only the unknown-field seed exempted', async t => {
  const ctx = await launchContext({ ...contextOptions, caseId: 'E-01' });
  t.after(() => ctx.teardown());
  const stop = new Error('reached positive bulk import'), seen = [];
  ctx.seed = async (seed, options = {}) => {
    boundaries.launchpass.seed(seed, options);
    if (!options.expectFailure) throw stop;
    seen.push(options.contractExpectation);
    return { exitCode: 1, stderr: 'invalid seed' };
  };
  await assert.rejects(launchCases.find(entry => entry.id === 'E-01').run(ctx), error => error === stop);
  assert.deepEqual(seen, [undefined, 'invalid', undefined, undefined]);
});

test('LedgerBridge, ReconcileHub and DispatchBoard request helpers do not drop invalid annotations', async t => {
  const ctx = await ledgerContext(contextOptions);
  t.after(() => ctx.teardown());
  ctx.mutate = async (_base, path, _key, body, options = {}) => { boundaries.ledgerbridge.request(path, { ...post(body), ...options }); return { status: 400 }; };
  const body = regressions.find(([task]) => task === 'ledgerbridge')[2];
  await assert.rejects(async () => ctx.createTransfer('http://localhost', { ...body, amountMinor: 0 }), mismatch);
  await ctx.createTransfer('http://localhost', { ...body, amountMinor: 0 }, invalid);
  await ctx.createTransfer('http://localhost', body);
  for (const [task, run] of [
    ['reconcilehub', fake => createGroup(fake, 'http://localhost', [id, id], [id], { allowFailure: true, ...invalid })],
    ['dispatchboard', fake => completeDelivery(fake, { baseUrl: 'http://localhost' }, id, id, 'short', { proofCode: '12345', ...invalid })],
  ]) {
    const calls = [];
    await run({ key: () => 'wire', mutate: async (_base, path, _key, json, options = {}) => { boundaries[task].request(path, { ...post(json), ...options }); calls.push(options); return { status: 400 }; } });
    assert.deepEqual(calls, [invalid]);
  }
});

test('ArtifactVault seed bundles exempt only explicit path attacks, not semantic rejection or positive seeds', async t => {
  const ctx = await artifactContext({ ...contextOptions, caseId: 'MIGRATE-03' });
  t.after(() => ctx.teardown());
  const bundle = seedBundle(ctx.fixtures, 'wire', [{ size: 1 }]), seen = [];
  ctx.seedFile = async (path, options) => { boundaries.artifactvault.seed(JSON.parse(await readFile(path)), options); seen.push(options.contractExpectation); return { exitCode: options.contractExpectation === 'invalid' ? 1 : 0 }; };
  await ctx.seedBundle(bundle);
  for (const assetPath of ['/tmp/escape.bin', '../escape.bin', 'x/../escape.bin']) {
    const bad = structuredClone(bundle); bad.seed.artifactVersions[0].assetPath = assetPath;
    await assert.rejects(ctx.seedBundle(bad, { expectFailure: true }), mismatch);
    await ctx.seedBundle(bad, { expectFailure: true, ...invalid });
  }
  assert.deepEqual(seen, [undefined, 'invalid', 'invalid', 'invalid']);
});

test('DispatchBoard A-01 reaches all eight original negative requests without disabling valid semantic checks', async t => {
  const ctx = await dispatchContext(contextOptions);
  t.after(() => ctx.teardown());
  const stop = new Error('reached valid delivery'), calls = [];
  ctx.command = ctx.npm = ctx.migrate = async () => ({ exitCode: 0 });
  ctx.seed = async seed => { boundaries.dispatchboard.seed(seed); return { exitCode: 0 }; };
  ctx.startApi = async () => ({ baseUrl: 'http://localhost' });
  ctx.snapshot = async () => ({ resources: {}, work: [], events: [] });
  const errors = [[400, 'INVALID_REQUEST'], [400, 'INVALID_REQUEST'], [400, 'INVALID_REQUEST'], [400, 'INVALID_REQUEST'], [400, 'UNKNOWN_FIELD'], [415, 'UNSUPPORTED_MEDIA_TYPE'], [400, 'MALFORMED_JSON'], [409, 'NO_ELIGIBLE_COURIER']];
  ctx.request = async (_base, path, options) => {
    boundaries.dispatchboard.request(path, options);
    if (calls.length === errors.length) throw stop;
    const [status, code] = errors[calls.length]; calls.push(options.contractExpectation);
    return { status, json: { error: { code, details: {}, message: code } } };
  };
  await assert.rejects(dispatchCases.find(entry => entry.id === 'A-01').run(ctx), error => error === stop);
  assert.deepEqual(calls, [undefined, 'invalid', 'invalid', undefined, 'invalid', 'invalid', 'invalid', undefined]);
});
