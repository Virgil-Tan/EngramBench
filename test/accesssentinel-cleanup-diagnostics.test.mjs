// Focused diagnostic of the real task-local boundary, not a mock of that boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withCaseContext, EvaluationInfrastructureError } from '../evaluators/transfer/accesssentinel/v2/lib/runtime.mjs';
import { executeCase } from '../src/task-evaluator-v2/execution.mjs';

for (const businessFails of [true, false]) test(`Access cleanup retains the prior ${businessFails ? 'failure' : 'success'} privately`, async t => {
  let context;
  t.after(() => context.teardown());
  const outcome = await executeCase({
    definition: { id: 'E-05', dimension: 'E', weight: 0.75 },
    contextOptions: { workspace: process.cwd(), evaluationSeed: 'access-cleanup-regression', manageDatabase: false },
    withContext: withCaseContext, failureCodePrefix: 'REPRO_',
    implementation: { run: ctx => {
      context = ctx;
      assert.equal(typeof ctx.createAccessRequest, 'function');
      let attempts = 0;
      ctx.defer(() => { if (++attempts === 1) throw new EvaluationInfrastructureError('EVALUATOR_DATABASE_DROP_FAILED', 'database is recovering'); });
      if (businessFails) throw new Error('original business assertion failed');
      return ctx.pass({ evidence: ['original verification completed'] });
    } },
  });
  assert.equal(outcome.status, 'evaluator_error');
  assert(outcome.privateErrorDetails.some(row => row.message === 'database is recovering'));
  if (businessFails) assert(outcome.privateErrorDetails.some(row => row.message === 'original business assertion failed'));
  else assert.equal(outcome.privateOperationResult?.status, 'passed');
});
