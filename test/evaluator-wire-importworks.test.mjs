import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { CASES } from '../evaluators/learning/importworks/v2/cases/index.mjs';
import { validateCaseRegistry } from '../evaluators/learning/importworks/v2/lib/execution.mjs';
import { validateManifest } from '../evaluators/learning/importworks/v2/lib/scoring.mjs';
import { createCaseContext } from '../evaluators/learning/importworks/v2/lib/runtime.mjs';
import { createFixtureFactory, emptySeed, importSeed, importPayload, schemaFixture, tenantSchemaFixture, ndjsonBytes, rowFixture, splitBytes, uploadWorkedExample } from '../evaluators/learning/importworks/v2/lib/fixtures.mjs';
import { publishRevision, verifyReportContent, assertEventSequences } from '../evaluators/learning/importworks/v2/cases/helpers.mjs';
import { canonical, sha256 } from '../evaluators/learning/importworks/v2/lib/oracle.mjs';

const root = resolve(import.meta.dirname, '..');
const contractRoot = resolve(root, 'task-packages/v2/importworks/public-contract');
const contract = JSON.parse(await readFile(resolve(contractRoot, 'contract.json')));
const boundary = await evaluatorContract(contractRoot), compile = validator(contract);
const baseTime = '2031-04-05T06:07:08.000Z';
const fixture = caseId => createFixtureFactory({ evaluationSeed: 'wire-regression', caseId, baseTime });

test('ImportWorks retains the complete frozen 22-case registry and scoring weights', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'evaluators/learning/importworks/v2/manifest.v2.json')));
  const map = JSON.parse(await readFile(resolve(root, 'evaluators/learning/importworks/v2/contract-map.v2.json')));
  assert.equal(validateManifest(manifest, map), true);
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
  assert.deepEqual(CASES.map(({ id }) => id), manifest.cases.map(({ id }) => id));
});

test('ImportWorks positive catalogs and import payloads satisfy the fixed public schemas for every case', () => {
  const revision = compile({ $ref: '#/$defs/SchemaRevision' });
  for (const { id } of CASES) {
    const fixtures = fixture(id), catalog = tenantSchemaFixture(fixtures);
    assert.doesNotThrow(() => boundary.seed(emptySeed(`empty-${id}`)));
    assert.doesNotThrow(() => boundary.seed(importSeed(fixtures, `catalog-${id}`, { catalog })));
    const bytes = ndjsonBytes([rowFixture(1)]), body = importPayload(catalog, bytes);
    assert.doesNotThrow(() => boundary.request('/api/v1/imports', { method: 'POST', headers: { 'Idempotency-Key': id }, json: body }));
    assert.equal(Object.hasOwn(body, 'schemaId'), false);
    assert.equal(Object.hasOwn(body, 'externalIdField'), false);
    assert.equal(revision(catalog.revision), true, JSON.stringify(revision.errors));
  }
  assert.deepEqual(uploadWorkedExample().pieces.map(({ chunkNumber }) => chunkNumber), [0, 1, 2]);
  assert.deepEqual(splitBytes(Buffer.from('abcdefghijkl'), 3).map(({ chunkNumber }) => chunkNumber), [0, 1, 2]);
});

test('ImportWorks runtime helper requests and seed command are positively validated, including raw chunk headers', async t => {
  const ctx = await createCaseContext({ caseId: 'A-01', workspace: root, evaluationSeed: 'wire-regression', baseTime, manageDatabase: false });
  t.after(() => ctx.teardown());
  const calls = [], commands = [];
  ctx.request = async (base, path, options = {}) => {
    assert.notEqual(options.contractExpectation, 'invalid', path);
    boundary.request(path, options);
    calls.push({ path, options });
    return { status: 200, json: { revision: 2 }, text: '{"revision":2}' };
  };
  ctx.npm = async (script, args, options) => {
    await boundary.command('npm', ['run', script, '--', ...args], options);
    commands.push({ script, args, options });
    return { exitCode: 0 };
  };
  const base = 'http://127.0.0.1:1', catalog = ctx.catalog(), bytes = ndjsonBytes([rowFixture(1)]);
  const importId = ctx.uuid('import'), bundleId = ctx.uuid('bundle');
  await ctx.seed(ctx.seedFor('helper-seed', { catalog }));
  await ctx.createImport(base, catalog, bytes);
  await ctx.putChunk(base, importId, bytes.length, splitBytes(bytes, 1)[0]);
  await ctx.getImport(base, importId);
  await ctx.completeImport(base, importId);
  await ctx.commitImport(base, importId);
  await ctx.cancelImport(base, importId);
  await ctx.getFindings(base, importId);
  await ctx.getErrorReport(base, importId);
  await ctx.getRecords(base, catalog.tenant.tenantId, catalog.schema.datasetKey);
  await ctx.createBundle(base, catalog.tenant.tenantId, 'Bundle');
  await ctx.addBundleMember(base, bundleId, importId);
  await ctx.stageBundle(base, bundleId);
  await ctx.publishBundle(base, bundleId);
  await publishRevision(ctx, base, catalog, schemaFixture(ctx.fixtures, { schemaId: catalog.schema.schemaId, revision: 2 }));
  assert.equal(calls.length, 14);
  assert.equal(commands[0].script, 'db:seed');
  assert.equal(commands[0].options.allowFailure, true);
  assert.equal(commands[0].options.contractExpectation, undefined);
  await assert.rejects(ctx.seed({ ...ctx.seedFor('bad-seed'), legacy: true }), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.equal(commands.length, 1, 'positive invalid seed never reaches a candidate command');
});

test('ImportWorks canonical report-content assertion verifies bytes, media type and digest', async () => {
  const fixtures = fixture('A-03');
  const findings = [{ findingId: fixtures.uuid('finding'), importId: fixtures.uuid('import'), rowNumber: 1, externalRowId: 'row-1', field: 'age', code: 'WRONG_TYPE', message: 'Invalid', valueDigest: sha256('"invalid"') }];
  assert.equal(compile({ $ref: '#/$defs/ValidationFinding' })(findings[0]), true);
  const bytes = Buffer.from(`${canonical(findings[0])}\n`);
  const ctx = {
    request: async (_base, path, options) => { boundary.request(path, options); return { status: 200, body: bytes, headers: new Headers({ 'content-type': 'application/x-ndjson' }) }; },
    equal: (_label, actual, expected) => assert.deepEqual(actual, expected),
    ok: (_label, value) => assert.ok(value), sha256,
  };
  await verifyReportContent(ctx, 'http://127.0.0.1:1', fixture('A-03').uuid('import'), findings, { sha256: sha256(bytes) });
  await assert.rejects(verifyReportContent(ctx, 'http://127.0.0.1:1', fixture('A-03').uuid('import'), findings, { sha256: '0'.repeat(64) }));
});

test('ImportWorks snapshot Event order is by event identity while aggregate sequences remain unique', () => {
  const events = [{ eventId: 'a', aggregateId: 'job', sequence: 2 }, { eventId: 'b', aggregateId: 'job', sequence: 1 }];
  assert.doesNotThrow(() => assertEventSequences(events));
  assert.throws(() => assertEventSequences([...events].reverse()));
  assert.throws(() => assertEventSequences([events[0], { ...events[1], sequence: 2 }]));
});
