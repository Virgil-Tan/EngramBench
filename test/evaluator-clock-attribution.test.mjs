import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCase } from '../src/task-evaluator-v2/execution.mjs';
import { createCaseRuntime, CandidateResponseError } from '../src/task-evaluator-v2/runtime.mjs';
import { attach, createCaseContext } from '../evaluators/transfer/accesssentinel/v2/lib/runtime.mjs';
import { CaseFailure } from '../evaluators/transfer/accesssentinel/v2/lib/execution.mjs';
import { parseOptions } from '../work/superhard-v2-alignment-20260908/evaluate.mjs';

const run = operation => executeCase({ definition: { id: 'A-01', dimension: 'A', weight: 2 },
  implementation: { run: operation }, withContext: async (_, fn) => fn(attach({})),
  contextOptions: {}, failureCodePrefix: 'CHECK_' });

test('frozen reevaluation does not retain an absolute calendar date', () => {
  const args = ['--run-root', '/r/runs/a', '--task-root', '/r/task-packages/v2/accesssentinel', '--output-root', '/evaluations/a'];
  assert.equal(parseOptions(args).baseTime, undefined);
  assert.throws(() => parseOptions([...args, '--base-time', '2026-09-08T00:00:00.000Z']), /Invalid argument/);
});

test('Access fixtures remain live on different execution dates with the same seed and keep relative expiry semantics', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-01T00:00:00Z') });
  let firstId;
  for (const calendar of ['2030-01-01T00:00:00Z', '2040-06-05T17:30:00Z']) {
    t.mock.timers.setTime(Date.parse(calendar));
    const ctx = await createCaseContext({ caseId: 'A-09', workspace: process.cwd(), evaluationSeed: 'same-fixed-seed', manageDatabase: false });
    try {
      const session = ctx.fixtures.session;
      assert.equal(Date.parse(session.expiresAt) - Date.now(), 3_600_000);
      assert.equal(Date.parse(ctx.at({ hours: -1 })) - Date.now(), -3_600_000);
      firstId ??= session.sessionId;
      assert.equal(session.sessionId, firstId, 'random identities still use the identical seed');
    } finally { await ctx.teardown(); }
  }
});

test('unknown exceptions, author bugs and transport failures cannot become candidate deductions', async () => {
  for (const error of [new TypeError('bad author fixture'), new ReferenceError('undefined oracle'),
    new Error('unattributed failure'), new TypeError('fetch failed', { cause: Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }) })]) {
    const result = await run(() => { throw error; });
    assert.equal(result.status, 'evaluator_error');
    assert.equal(result.evaluatorErrorCode, 'EVALUATOR_UNATTRIBUTED_FAILURE');
    assert.equal(result.privateFailureCode, undefined);
    assert.match(result.privateMessage, new RegExp(error.message));
  }
});

test('assertion wrappers do not relabel broken author code or author preconditions as candidate failures', async () => {
  for (const cause of [new TypeError('broken oracle'), Object.assign(new Error('invalid positive fixture'),
    { origin: 'evaluator', code: 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH' })]) {
    const result = await run(ctx => ctx.assert('check', () => { throw cause; }));
    assert.equal(result.status, 'evaluator_error');
    assert.match(result.privateMessage, new RegExp(cause.message));
  }
});

test('explicit candidate assertions and actual rejected responses remain failures', async () => {
  for (const operation of [ctx => ctx.equal(403, 200, 'valid request rejected'),
    () => { throw new CaseFailure('missing business operation'); },
    () => { throw new CandidateResponseError('snapshot returned 500', { status: 500 }); }]) {
    const result = await run(operation);
    assert.equal(result.status, 'failed');
    assert.match(result.privateFailureCode, /^CHECK_/);
  }
});

test('polling does not swallow an author bug and relabel it as a candidate timeout', async t => {
  const runtime = createCaseRuntime({ taskSlug: 'attribution', databasePrefix: 'attribution', snapshotPath: '/snapshot',
    createFixtureFactory: () => ({}), adaptCompatibilityResponse: (_, r) => r.json,
    assertCompatibilityAdapter() {}, validateBarrierPayload() {} });
  const ctx = await runtime.createCaseContext({ caseId: 'A-01', workspace: process.cwd(), evaluationSeed: 'attribution', manageDatabase: false });
  t.after(() => ctx.teardown());
  let attempts = 0;
  const result = await run(() => ctx.waitFor(() => { attempts++; throw new TypeError('bad predicate'); }, { timeoutMs: 20, intervalMs: 0 }));
  assert.equal(result.status, 'evaluator_error');
  assert.equal(attempts, 1);
});
