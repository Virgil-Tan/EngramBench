import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, copyFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import contract from '../contracts/transfer/commercecommand.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { openApi, validator, requestValidator, matchOperation } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/commercecommand/v2/fixtures/index.mjs';
import { assertPublishedOpenApi, assertLiveSchema } from '../evaluators/transfer/commercecommand/v2/oracles/openapi.mjs';
import { assertAllocations } from '../evaluators/transfer/commercecommand/v2/oracles/index.mjs';
import { quote, checkout, providerCallback, reconcile } from '../evaluators/transfer/commercecommand/v2/cases/helpers.mjs';
import { CASES } from '../evaluators/transfer/commercecommand/v2/cases/index.mjs';
import { validateManifest } from '../evaluators/transfer/commercecommand/v2/lib/scoring.mjs';
import { validateCaseRegistry } from '../evaluators/transfer/commercecommand/v2/lib/execution.mjs';

const compile = validator(contract), check = requestValidator(contract);
const fixture = () => createFixtureFactory({ evaluationSeed: 'v2-author-regression', caseId: 'A-01', baseTime: '2026-09-07T00:00:00Z' });

test('CommerceCommand publishes complete closed wire and a nonempty persistent smoke graph', () => {
  assert.equal(validatePublicContract(contract).operations, 28);
  for (const op of contract.operations) {
    assert(Number.isInteger(op.status));
    assert(op.response);
    for (const [, name] of op.path.matchAll(/\/:([^/]+)/g)) assert(op.parameters.some(p => p.name === name && p.in === 'path' && p.required));
    if (op.method === 'POST') assert(op.request && op.example.body !== undefined);
  }
  assert(contract.seed.example.sellers.length && contract.seed.example.offerVersions.length && contract.seed.example.inventoryPools.length);
  const seed = compile(contract.seed.schema);
  assert(seed(contract.seed.example));
  assert.equal(seed({ ...contract.seed.example, accidentalCollection: [] }), false);
  const snapshot = compile(contract.schemas.VerificationSnapshot);
  const { schemaVersion: _version, seedVersion: _seedVersion, ...resources } = contract.seed.example;
  assert(snapshot({ asOf: '2026-09-07T00:00:00Z', resources, work: [], events: [] }));
  assert.equal(snapshot({ asOf: '2026-09-07T00:00:00Z', resources: { ...resources, paymentAttempts: [{}] }, work: [], events: [] }), false);
});

test('CommerceCommand publishes author policies and a real marketplace public acceptance chain', () => {
  assert.equal(contract.policyRevision, 'commercecommand-2026-09-08.1');
  assert(contract.environmentVariables.includes('SANDBOX_PROVIDER_URL'));
  const notes = contract.notes.join('\n');
  for (const phrase of ['200 basis points', 'cumulative waterfall', 'worker.claimed', 'dispatcher.response-received', 'X-Event-Id', 'bodyDigest']) assert(notes.includes(phrase), phrase);
  assert(!notes.includes('Economic policy remains unresolved'));
  const chain = contract.smoke.slice(8);
  assert.deepEqual(chain.map(step => step.operationId), ['createQuote', 'setSellerAllocations', 'checkoutOrder', 'recordPaymentCallback', 'createSellerSettlement', 'closeSellerSettlement', 'getVerificationSnapshot']);
  assert.deepEqual(chain[1].capture, { marketplaceAllocationId: [0, 'sellerAllocationId'] });
  assert.equal(chain[5].expectBody.feeMinor, 18);
  assert.equal(chain[5].expectBody.netMinor, 862);
  assert(chain[6].expectContains.some(item => item.path.join('.') === 'resources.sellerSettlements'));
});

test('CommerceCommand hidden OpenAPI oracle accepts the author baseline and rejects a weakened required shape', () => {
  const document = openApi(contract);
  assertPublishedOpenApi(document);
  const changed = structuredClone(document);
  changed.components.schemas.Refund.required = changed.components.schemas.Refund.required.filter(key => key !== 'journalId');
  assert.throws(() => assertPublishedOpenApi(changed), /response schema/);
  assert.throws(() => assertLiveSchema(document, '/api/v1/orders/{orderId}', 'GET', 200, { orderId: fixture().uuid('order') }), /author schema/);
});

test('CommerceCommand isolated oracle reads author mount without repository sources', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commerce-author-oracle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const author = join(directory, 'public-contract'), oracle = join(directory, 'evaluator', 'v2', 'oracles');
  await mkdir(author, { recursive: true });
  await mkdir(oracle, { recursive: true });
  await writeFile(join(author, 'contract.json'), JSON.stringify(contract));
  await copyFile(new URL('../templates/contract-first/runtime.mjs', import.meta.url), join(author, 'runtime.mjs'));
  await copyFile(new URL('../evaluators/transfer/commercecommand/v2/oracles/openapi.mjs', import.meta.url), join(oracle, 'openapi.mjs'));
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  const script = `const o=await import(${JSON.stringify(pathToFileURL(join(oracle, 'openapi.mjs')).href)});const r=await import(${JSON.stringify(pathToFileURL(join(author, 'runtime.mjs')).href)});o.assertPublishedOpenApi(r.openApi(o.contract));`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, FRONTAL_PUBLIC_CONTRACT_ROOT: author } });
});

test('CommerceCommand base and marketplace private seed families obey the public schema', () => {
  const f = fixture(), valid = compile(contract.seed.schema);
  for (const name of ['base', 'empty', 'main', 'quote', 'payment', 'fulfillment', 'entitlement', 'ledger', 'idempotency', 'work', 'migration', 'browser', 'marketplace']) {
    assert(valid(f[name]().seed), `${name}: ${JSON.stringify(valid.errors)}`);
  }
  assert(valid(f.largeCatalog(3).seed), JSON.stringify(valid.errors));
});

test('CommerceCommand actual quote, checkout, callback and reconcile helpers issue valid public requests', async () => {
  const f = fixture(), calls = [];
  const ctx = { fixtures: f, key: f.key, async mutate(_base, path, key, body, options = {}) {
    const route = matchOperation(contract.operations, 'POST', path);
    assert(route, path);
    const checked = check(route.operation, { params: route.params, body, hasBody: true, headers: { 'content-type': 'application/json', 'idempotency-key': key } });
    assert(checked.valid, `${path}: ${JSON.stringify(checked)}`);
    assert.notEqual(options.contractExpectation, 'invalid', 'positive helpers cannot bypass contract validation');
    calls.push(path);
    return { status: route.operation.status, json: { orderId: f.uuid('order') } };
  } };
  await quote(ctx, 'http://author.test', f.main());
  await checkout(ctx, 'http://author.test', f.uuid('order'));
  await providerCallback(ctx, 'http://author.test', 'public-provider-request', 'capture', 'CAPTURED', 1320);
  await reconcile(ctx, 'http://author.test', f.uuid('attempt'), 'query', 'UNKNOWN', 0);
  assert.equal(calls.length, 4);
});

test('CommerceCommand malformed transport tests are explicit and preserve error/no-effect checks', async () => {
  const f = fixture(), before = { asOf: '2026-09-07T00:00:00Z', resources: {}, events: [], work: [] }, invalid = [];
  const ctx = { fixtures: f, key: f.key, async migrate() {}, async seed() {}, async startApi() { return { baseUrl: 'http://author.test' }; }, mark() {}, async openApi() { return { status: 200, json: openApi(contract) }; }, async snapshot() { return structuredClone(before); }, pass(value) { return value; },
    async request(_base, path, options) {
      assert.equal(options.contractExpectation, 'invalid');
      invalid.push(path);
      return { status: 400, json: { error: { code: options.raw ? 'MALFORMED_JSON' : 'VALIDATION_ERROR', message: 'Invalid request', details: {} } } };
    },
    async mutate(base, path, key, body, options) { return this.request(base, path, { ...options, json: body, headers: { 'idempotency-key': key } }); },
  };
  await CASES.find(item => item.id === 'A-04').run(ctx);
  assert.equal(invalid.length, 3);
});

test('CommerceCommand observes allocation identity independently of snapshot sorting', () => {
  const rows = [{ inventoryPoolId: 'b', quantity: 2 }, { inventoryPoolId: 'a', quantity: 1 }];
  assert.doesNotThrow(() => assertAllocations([...rows].reverse(), rows));
  assert.throws(() => assertAllocations([{ inventoryPoolId: 'a', quantity: 2 }, { inventoryPoolId: 'b', quantity: 1 }], rows));
});

test('CommerceCommand retains the frozen case registry and explicit incomplete certification', async () => {
  const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const manifest = await read('../evaluators/transfer/commercecommand/v2/manifest.v2.json');
  const map = await read('../evaluators/transfer/commercecommand/v2/contract-map.v2.json');
  assert.equal(validateManifest(manifest, map), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  assert.equal(CASES.length, 55);
  const release = await read('../evaluators/transfer/commercecommand/release.json');
  assert.equal(release.status, 'pending_live_validation');
  assert.equal(manifest.formalReady, false);
  assert.deepEqual(manifest.specGaps, []);
  for (const item of manifest.cases) assert.equal(item.blockedAssertions, undefined, `${item.id} has executable author assertions, not placeholder diagnostics`);
});
