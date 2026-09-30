import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeCase } from '../src/task-evaluator-v2/execution.mjs';

const root = resolve(import.meta.dirname, '..');
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const seed = object({ rows: { type: 'array', items: object({ id: { type: 'string' } }) } });
const contract = {
  schemas: {},
  seed: { schema: seed, command: ['npm', 'run', 'seed', '--', '--file', '${SEED_PATH}'], example: { rows: [{ id: 'public-seed' }] } },
  operations: [{ id: 'create', method: 'POST', path: '/api/rows', status: 201, request: object({ id: { type: 'string' } }), response: object({ id: { type: 'string' } }) }],
};

async function contextFixture(t) {
  const spawnCalls = [];
  t.mock.method(childProcess, 'spawn', (...args) => {
    spawnCalls.push(args);
    throw new Error('Regression test does not execute subprocesses');
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await mkdir(join(root, '.tmp'), { recursive: true });
  const path = await mkdtemp(join(root, '.tmp/evaluator-boundary-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  await cp(join(root, 'templates/contract-first/runtime.mjs'), join(path, 'runtime.mjs'));
  await writeFile(join(path, 'contract.json'), JSON.stringify(contract));
  const previous = process.env.FRONTAL_PUBLIC_CONTRACT_ROOT;
  process.env.FRONTAL_PUBLIC_CONTRACT_ROOT = path;
  let runtime;
  try {
    runtime = await import(`${pathToFileURL(join(root, 'src/task-evaluator-v2/runtime.mjs')).href}?fixture=${encodeURIComponent(path)}`);
  } finally {
    if (previous === undefined) delete process.env.FRONTAL_PUBLIC_CONTRACT_ROOT;
    else process.env.FRONTAL_PUBLIC_CONTRACT_ROOT = previous;
  }
  const { createCaseContext } = runtime.createCaseRuntime({
    taskSlug: 'boundary', databasePrefix: 'boundary', snapshotPath: '/api/snapshot',
    createFixtureFactory: () => ({}), adaptCompatibilityResponse: (_, response) => response.json,
    assertCompatibilityAdapter() {}, validateBarrierPayload() {},
  });
  const ctx = await createCaseContext({ caseId: 'A-01', workspace: root, evaluationSeed: 'local-regression', manageDatabase: false });
  ctx.testSpawnCalls = spawnCalls;
  t.after(() => ctx.teardown());
  return ctx;
}

function runCase(ctx, run) {
  return executeCase({
    definition: { id: 'A-01', dimension: 'A', weight: 1 }, contextOptions: {}, failureCodePrefix: 'BOUNDARY_',
    withContext: async (_, operation) => operation(ctx), implementation: { run },
  });
}

test('allowFailure changes command-exit handling, never positive author-seed validation', async t => {
  const ctx = await contextFixture(t);
  const outcome = await runCase(ctx, async context => {
    const result = await context.seed({ rows: [{ legacyOnly: true }] }, { allowFailure: true });
    if (result.exitCode !== 0) throw new Error(`seed failed: ${result.stderr}`);
  });
  assert.equal(outcome.status, 'evaluator_error', JSON.stringify(outcome));
  assert.equal(outcome.evaluatorErrorCode, 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert(outcome.privateErrorDetails.some(item => item.details?.violations?.length), 'retain exact schema violations for author repair');
  assert.equal(ctx.testSpawnCalls.length, 0, 'invalid positive author fixture must not reach the candidate');
});

test('explicit invalid-seed cases may reach the candidate to check rejection', async t => {
  const ctx = await contextFixture(t);
  const calls = [], options = { allowFailure: true, contractExpectation: 'invalid' };
  ctx.command = async (...args) => { calls.push(args); return { exitCode: 1 }; };
  const result = await ctx.seed({ legacyOnly: true }, options);
  assert.equal(result.exitCode, 1);
  assert.equal(calls.length, 1);
  const path = ctx.tempPath('seed-001.json');
  assert.deepEqual(calls[0], ['npm', ['run', 'seed', '--', '--file', path], { ...options, stage: 'seed' }]);
  assert.deepEqual(JSON.parse(await readFile(path)), { legacyOnly: true });
  assert.equal(ctx.testSpawnCalls.length, 0);
});

test('direct npm seed validates positive fixtures at the command boundary before spawn', async t => {
  const ctx = await contextFixture(t), path = ctx.tempPath('direct-seed.json');
  await writeFile(path, JSON.stringify(contract.seed.example));
  await assert.rejects(ctx.npm('seed', ['--file', path], { allowFailure: true }), { name: 'CommandError' });
  assert.equal(ctx.testSpawnCalls.length, 1, 'legal seed reaches only the mocked spawn');
  assert.deepEqual(ctx.testSpawnCalls[0].slice(0, 2), ['npm', ['run', 'seed', '--', '--file', path]]);
  await writeFile(path, JSON.stringify({ rows: [{ legacyOnly: true }] }));
  await assert.rejects(ctx.npm('seed', ['--file', path], { allowFailure: true }),
    error => error.origin === 'evaluator' && error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.equal(ctx.testSpawnCalls.length, 1, 'invalid seed must not reach spawn');
});

test('waitFor preserves positive request contract errors instead of reporting a candidate timeout', async t => {
  const ctx = await contextFixture(t);
  let attempts = 0;
  const outcome = await runCase(ctx, context => context.waitFor(
    () => { attempts += 1; return context.request('http://127.0.0.1:1', '/api/rows', { method: 'POST', json: { legacyOnly: true } }); },
    // Test error propagation, not whether two wall-clock reads share a millisecond.
    { timeoutMs: 1000, intervalMs: 0, label: 'positive fixture request' },
  ));
  assert.equal(outcome.status, 'evaluator_error', JSON.stringify(outcome));
  assert.equal(outcome.evaluatorErrorCode, 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.equal(attempts, 1, 'invalid author input fails immediately, without candidate retries');
});

test('waitFor still retries a transient business 404', async t => {
  const ctx = await contextFixture(t);
  let attempts = 0;
  const result = await ctx.waitFor(() => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('resource not found'), { response: { status: 404 } });
    return { status: 200 };
  }, { timeoutMs: 100, intervalMs: 0, label: 'resource becomes visible' });
  assert.equal(result.status, 200);
  assert.equal(attempts, 2);
});

test('waitFor preserves wrapped infrastructure causes', async t => {
  const ctx = await contextFixture(t);
  let attempts = 0;
  const cause = Object.assign(new Error('author database unavailable'), { origin: 'infrastructure', code: 'EVALUATOR_DATABASE_CREATE_FAILED' });
  const error = new Error('task helper failed', { cause });
  const outcome = await runCase(ctx, context => context.waitFor(() => {
    attempts += 1;
    throw error;
  }, { timeoutMs: 100, intervalMs: 0, label: 'author infrastructure' }));
  assert.equal(outcome.status, 'evaluator_error');
  assert.equal(outcome.evaluatorErrorCode, cause.code);
  assert.equal(attempts, 1, 'author failures cannot become recoverable business retries');
});

test('a seed scalar beyond the engine string limit is an author reader fault, not invalid JSON', async t => {
  const ctx = await contextFixture(t);
  const path = ctx.tempPath('large-seed.json');
  const read = fs.createReadStream;
  t.mock.method(fs, 'createReadStream', (file, ...args) => {
    if (file === path) throw Object.assign(new Error('Cannot create a string longer than engine maximum'), { code: 'ERR_STRING_TOO_LONG' });
    return read(file, ...args);
  });
  syncBuiltinESMExports();
  const outcome = await runCase(ctx, context => context.seedFile(path));
  assert.equal(outcome.status, 'evaluator_error');
  assert.equal(outcome.evaluatorErrorCode, 'EVALUATOR_SEED_READER_LIMIT');
  assert.equal(ctx.testSpawnCalls.length, 0);
});

test('incremental scalar concatenation marks its engine string limit before evaluator classification', async t => {
  const ctx = await contextFixture(t), path = ctx.tempPath('large-scalar.json');
  await writeFile(path, JSON.stringify(contract.seed.example));
  const joinParts = Array.prototype.join;
  let outcome;
  try {
    Array.prototype.join = function (separator) {
      // Simulate V8 refusing a scalar at the native concatenation boundary.
      if (this.length === 1 && this[0] === '"' && separator === '') throw new RangeError('Invalid string length');
      return joinParts.call(this, separator);
    };
    outcome = await runCase(ctx, context => context.seedFile(path));
  } finally { Array.prototype.join = joinParts; }
  assert.equal(outcome.status, 'evaluator_error');
  assert.equal(outcome.evaluatorErrorCode, 'EVALUATOR_SEED_READER_LIMIT');
  assert.equal(outcome.privateErrorDetails[0].details.code, 'ERR_STRING_TOO_LONG');
  assert.equal(ctx.testSpawnCalls.length, 0);
});
