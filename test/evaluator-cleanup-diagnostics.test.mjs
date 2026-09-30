import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createCaseRuntime, EvaluationInfrastructureError } from '../src/task-evaluator-v2/runtime.mjs';
import { executeCase } from '../src/task-evaluator-v2/execution.mjs';
import { createScoringPolicy } from '../src/task-evaluator-v2/scoring.mjs';

const runtime = createCaseRuntime({
  taskSlug: 'cleanupfixture', databasePrefix: 'cleanupfixture', snapshotPath: '/snapshot',
  createFixtureFactory: () => ({}), adaptCompatibilityResponse: (_, response) => response.json,
  assertCompatibilityAdapter() {}, validateBarrierPayload() {},
});
const options = { caseId: 'A-01', workspace: process.cwd(), evaluationSeed: 'cleanup-regression', manageDatabase: false };
const runCase = run => executeCase({ definition: { id: 'A-01', dimension: 'A', weight: 2 },
  contextOptions: options, failureCodePrefix: 'REGRESSION_', withContext: runtime.withCaseContext, implementation: { run },
});

test('failed cleanup retains only failed resources, can retry, and does not claim completion', async t => {
  const ctx = await runtime.createCaseContext(options);
  t.after(() => ctx.teardown());
  let successfulCalls = 0, failingCalls = 0;
  ctx.defer(() => { successfulCalls++; });
  ctx.defer(() => { if (++failingCalls === 1) throw new Error('fixture cleanup interrupted'); });
  await assert.rejects(ctx.teardown(), error => error.code === 'EVALUATOR_TEARDOWN_FAILED');
  assert.equal(ctx.teardownComplete, false);
  assert.equal(ctx.disposers.length, 1);
  await access(ctx.temporary);
  await ctx.teardown();
  assert.equal(ctx.teardownComplete, true);
  assert.equal(successfulCalls, 1);
  assert.equal(failingCalls, 2);
  await assert.rejects(access(ctx.temporary), { code: 'ENOENT' });
  await ctx.teardown();
  assert.equal(failingCalls, 2);
});

for (const businessFails of [false, true]) test(`cleanup failure preserves the ${businessFails ? 'failed' : 'passed'} operation without producing a formal business score`, async t => {
  let ctx;
  t.after(() => ctx.teardown());
  const result = await runCase(context => {
    ctx = context;
    let attempts = 0;
    ctx.defer(() => { if (++attempts === 1) throw new EvaluationInfrastructureError('EVALUATOR_DATABASE_DROP_FAILED', 'database cleanup failed'); });
    if (businessFails) throw new Error('real missing business behavior');
    return { status: 'passed', evidence: ['real verification completed'] };
  });
  assert.equal(result.status, 'evaluator_error');
  assert.equal(result.evaluatorErrorCode, 'EVALUATOR_TEARDOWN_FAILED');
  assert(result.privateErrorDetails.some(item => item.message === 'database cleanup failed'));
  if (businessFails) assert(result.privateErrorDetails.some(item => item.message === 'real missing business behavior'));
  else assert.equal(result.privateOperationResult.status, 'passed');
  assert.equal(ctx.teardownComplete, false);
});

test('a submission command failure retains stage, exit code and stderr and remains a failure', async () => {
  const result = await runCase(ctx => ctx.command(process.execPath, ['-e', 'process.stderr.write("seed foreign key violation"); process.exit(1)'], { stage: 'seed' }));
  assert.equal(result.status, 'failed');
  const command = result.privateErrorDetails.find(item => item.commandResult);
  assert.equal(command.stage, 'seed');
  assert.equal(command.commandResult.exitCode, 1);
  assert.match(command.commandResult.stderr, /foreign key violation/);
});

test('missing evaluator executable is infrastructure failure, not a submission zero', async () => {
  const result = await runCase(ctx => ctx.command('/nonexistent/frontal-evaluator-command', []));
  assert.equal(result.status, 'evaluator_error');
  assert.equal(result.evaluatorErrorCode, 'EVALUATOR_COMMAND_UNAVAILABLE');
  assert(result.privateErrorDetails.some(item => item.commandResult?.spawnError));
  const report = createScoringPolicy({ validateManifest() {} }).scoreEvaluation(
    { taskId: 'cleanupfixture', maxScore: 2, dimensions: { A: {} }, hardCaps: [], cases: [{ id: 'A-01', dimension: 'A', weight: 2 }] },
    { cases: [{ caseId: 'A-01', privateFailureCodePrefix: 'REGRESSION_', publicFeedbackCategory: 'wiring' }] },
    { cases: [result] },
  );
  assert.equal(report.verdict, 'evaluator_error');
  assert.equal(report.score, null);
  assert.equal(report.formalEligible, false);
});
