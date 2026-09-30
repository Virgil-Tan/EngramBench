import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import contract from '../contracts/transfer/creatorrightsexchange.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { validator, openApi, requestPath, expand, matchOperation, requestValidator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/creatorrightsexchange/v2/fixtures/index.mjs';
import { assertOpenApiDocument, assertUtcTimestamp, assertLedgerTotals } from '../evaluators/transfer/creatorrightsexchange/v2/oracles/index.mjs';
import { assertSnapshot, assetIdFromCompletion, createProfile, createUpload, putChunk, completeUpload, FINAL_RESOURCE_KEYS } from '../evaluators/transfer/creatorrightsexchange/v2/cases/helpers.mjs';
import { CASES } from '../evaluators/transfer/creatorrightsexchange/v2/cases/index.mjs';

const compile = validator(contract);
const fixtures = id => createFixtureFactory({ evaluationSeed: 'v2-author-wire-regression', caseId: id, baseTime: '2032-04-05T06:07:08.000Z' });
const response = (status, json) => ({ status, json, text: JSON.stringify(json) });
const emptySnapshot = () => ({ schemaVersion: 1, asOf: '2032-04-05T06:07:08Z', resources: Object.fromEntries(FINAL_RESOURCE_KEYS.map(key => [key, []])), work: [], events: [] });

test('Creator public operations, examples, linked seed and the real hidden OpenAPI oracle agree', () => {
  assert.deepEqual(validatePublicContract(contract), { operations: 44, probes: 14, schemas: 40 });
  assert.doesNotThrow(() => assertOpenApiDocument(openApi(contract)));
  const seed = contract.seed.example;
  assert.equal(seed.creators[0].tenantId, seed.tenants[0].tenantId);
  assert.equal(seed.works[0].tenantId, seed.tenants[0].tenantId);
  assert.equal(seed.rightsSplits[0].workId, seed.works[0].workId);
  assert.equal(seed.rightsSplits[0].creatorId, seed.creators[0].creatorId);
  assert.equal(seed.rightsSplits[0].revision, seed.works[0].currentRightsRevision);
  assert.equal(seed.rightsSplits.reduce((sum, split) => sum + split.basisPoints, 0), 10000);
  for (const operation of contract.operations) {
    assert(operation.example, operation.id);
    for (const [, name] of operation.path.matchAll(/\/:([A-Za-z][A-Za-z0-9_]*)/g)) {
      assert(operation.parameters.some(p => p.name === name && p.in === 'path' && p.required), name);
    }
    if (operation.method === 'POST' || operation.method === 'PUT') {
      assert(operation.parameters.some(p => p.name === 'Idempotency-Key' && p.required), operation.id);
    }
  }
  const incomplete = structuredClone(openApi(contract));
  delete incomplete.paths['/api/v1/provider/receipts'].post.responses['200'].content;
  assert.throws(() => assertOpenApiDocument(incomplete), /published success body/);
});

test('Creator positive private seed families include valid delivery Event references', () => {
  const validate = compile(contract.seed.schema), factory = fixtures('A-01');
  const families = ['base', 'empty', 'upload', 'pipeline', 'edition', 'purchase', 'review', 'refund', 'royalty', 'notification', 'dispute', 'idempotency', 'work', 'migration', 'browser'];
  for (const [name, family] of [...families.map(name => [name, factory[name]()]), ['commercial', factory.commercialSeed(3)], ['notifications', factory.notificationSeed(3)]]) {
    assert(validate(family.seed), `${name}: ${JSON.stringify(validate.errors)}`);
    for (const delivery of family.seed.deliveries) {
      assert.equal(family.seed.notifications.filter(n => n.notificationId === delivery.notificationId).length, 1, name);
      assert.equal(family.seed.events.filter(e => e.eventId === delivery.eventId).length, 1, name);
    }
  }
});

test('Creator snapshot oracle accepts public UTC representations and extension arrays while retaining checks', () => {
  const validate = compile(contract.schemas.VerificationSnapshot);
  for (const asOf of ['2032-04-05T06:07:08Z', '2032-04-05T06:07:08.123456Z', '2032-04-05T06:07:08+00:00']) {
    const snapshot = { ...emptySnapshot(), asOf };
    snapshot.resources.extensionResources = [];
    assert(validate(snapshot), JSON.stringify(validate.errors));
    assert.doesNotThrow(() => assertSnapshot({}, snapshot));
  }
  for (const value of ['2032-02-30T06:07:08Z', '2032-04-05T06:07:08+08:00', '2032-04-05T25:07:08Z']) assert.throws(() => assertUtcTimestamp(value));
  const missing = emptySnapshot(); delete missing.resources.works;
  assert.throws(() => assertSnapshot({}, missing), /works array/);
  const leaked = emptySnapshot(); leaked.resources.extensions = [{ storageKey: 'private-media' }];
  assert.throws(() => assertSnapshot({}, leaked));
});

test('Creator completion extraction binds the published blob identity to the committed snapshot', () => {
  const id = fixtures('A-02').uuid('blob'), before = emptySnapshot(), after = emptySnapshot();
  after.resources.scanJobs = [{ assetId: id }];
  const completed = response(200, { uploadSession: {}, blobObject: { blobId: id } });
  assert.equal(assetIdFromCompletion(completed, before, after), id);
  assert.throws(() => assetIdFromCompletion(response(200, { ...completed.json, assetId: id }), before, after));
  assert.throws(() => assetIdFromCompletion(response(200, { uploadSession: {}, blobObject: { blobId: fixtures('A-02').uuid('other') } }), before, after));
});

test('Creator ledger oracle verifies published totals across the full owner ledger', () => {
  const entries = [{ currency: 'USD', direction: 'CREDIT', amountMinor: 300 }, { currency: 'USD', direction: 'DEBIT', amountMinor: 80 }];
  const page = { items: [entries[1]], nextCursor: 'next-page', totals: [{ currency: 'USD', debitMinor: 80, creditMinor: 300, balanceMinor: 220 }] };
  assert.doesNotThrow(() => assertLedgerTotals(page, entries));
  assert.throws(() => assertLedgerTotals({ ...page, totals: [{ currency: 'USD', debitMinor: 80, creditMinor: 0, balanceMinor: -80 }] }, entries));
  assert.throws(() => assertLedgerTotals({ items: [], nextCursor: null, runningTotals: [] }, []));
});

test('Creator actual evaluator boundary accepts every public example and rejects positive fixture mistakes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'creator-contract-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'contract.json'), JSON.stringify(contract));
  await writeFile(join(directory, 'runtime.mjs'), `export { validator, requestValidator, matchOperation } from ${JSON.stringify(pathToFileURL(resolve('templates/contract-first/runtime.mjs')).href)};\n`);
  const boundary = await evaluatorContract(directory);
  for (const operation of contract.operations) {
    const example = expand(operation.example, { ADMIN_TOKEN: 'author-example-token' });
    const options = { method: operation.method, headers: example.headers };
    if (operation.request?.contentMediaType === 'application/octet-stream') options.raw = Buffer.from(example.body);
    else if (example.body !== undefined) options.json = example.body;
    assert.doesNotThrow(() => boundary.request(requestPath(operation, example), options), operation.id);
  }
  const payload = contract.operations.find(o => o.id === 'createTenant').example.body;
  assert.throws(() => boundary.request('/api/v1/tenants', { method: 'POST', json: payload }), e => e.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.throws(() => boundary.request('/api/v1/tenants', { method: 'POST', json: { ...payload, unknown: true }, headers: { 'Idempotency-Key': 'author-negative' } }), e => e.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.doesNotThrow(() => boundary.request('/api/v1/tenants', { method: 'POST', json: { ...payload, unknown: true }, contractExpectation: 'invalid' }));
});

test('Creator request helpers preserve positive raw headers and explicitly marked negatives', async () => {
  const validate = requestValidator(contract), calls = [];
  const ctx = {
    key: label => `test-${label}`, ok: (value, message) => assert.ok(value, message),
    request: async (_base, path, options) => {
      const route = matchOperation(contract.operations, options.method, new URL(path, 'http://author').pathname);
      const checked = validate(route.operation, { params: route.params, headers: { 'content-type': 'application/json', ...options.headers }, body: options.json, hasBody: options.json !== undefined || options.raw !== undefined });
      assert.equal(checked.valid, options.contractExpectation !== 'invalid', `${path}: ${checked.message}`);
      calls.push({ path, options }); return response(200, {});
    },
  };
  ctx.mutate = (base, path, key, json, options = {}) => ctx.request(base, path, { ...options, method: options.method ?? 'POST', json, headers: { 'Idempotency-Key': key, ...options.headers } });
  const get = name => contract.operations.find(o => o.id === name).example;
  await createProfile(ctx, 'http://author', get('createTranscodeProfile').body);
  await createUpload(ctx, 'http://author', get('createUpload').body);
  const raw = get('putUploadChunk');
  await putChunk(ctx, 'http://author', raw.params.uploadId, { chunkNumber: 1, bytes: Buffer.from(raw.body), contentRange: raw.headers['Content-Range'], sha256: raw.headers['X-Chunk-Sha256'] });
  await completeUpload(ctx, 'http://author', raw.params.uploadId, { sha256: get('completeUpload').body.contentSha256, chunks: get('completeUpload').body.chunks });
  await putChunk(ctx, 'http://author', raw.params.uploadId, { chunkNumber: 1, bytes: Buffer.from('a'), contentRange: 'not-a-range', sha256: raw.headers['X-Chunk-Sha256'] }, 'bad-header', { contractExpectation: 'invalid' });
  assert.equal(calls.length, 5);
  assert.equal(calls.filter(c => c.options.contractExpectation === 'invalid').length, 1);
});

test('Creator real A-06 case labels only malformed wire inputs, keeping semantic negatives validated', async () => {
  const validate = requestValidator(contract), checked = [], factory = fixtures('A-06');
  const semanticFailures = new Set(['territory', 'a06-prefix-overflow', 'rights-bad']);
  const ctx = { caseId: 'A-06', fixtures: factory, key: label => label, at: factory.at, migrate: async () => {}, seed: async value => assert(compile(contract.seed.schema)(value)), startApi: async () => ({ baseUrl: 'http://author' }), ok: (v, m) => assert.ok(v, m), equal: (a, b, m) => assert.deepEqual(a, b, m), assert: (_label, fn) => fn(), pass: value => value };
  ctx.mutate = async (_base, path, key, body, options = {}) => {
    const route = matchOperation(contract.operations, 'POST', path);
    const result = validate(route.operation, { params: route.params, headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body, hasBody: true });
    assert.equal(result.valid, options.contractExpectation !== 'invalid', `${key}: ${result.message}`);
    checked.push({ key, marked: options.contractExpectation === 'invalid' });
    return !result.valid || semanticFailures.has(key) ? response(400, { error: { code: 'INVALID_REQUEST', message: 'rejected' } }) : response(200, {});
  };
  ctx.request = async () => {
    const family = factory.royalty({ label: 'a06', closed: true });
    const entries = family.seed.royaltyEntries.filter(entry => entry.ownerId === family.creators[0].creatorId);
    const creditMinor = entries.filter(e => e.direction === 'CREDIT').reduce((sum, e) => sum + e.amountMinor, 0);
    const debitMinor = entries.filter(e => e.direction === 'DEBIT').reduce((sum, e) => sum + e.amountMinor, 0);
    return response(200, { items: entries, nextCursor: null, totals: [{ currency: 'USD', debitMinor, creditMinor, balanceMinor: creditMinor - debitMinor }] });
  };
  await CASES.find(c => c.id === 'A-06').run(ctx);
  assert.equal(checked.filter(c => c.marked).length, 7);
  for (const key of semanticFailures) assert.equal(checked.find(c => c.key === key).marked, false);
});
