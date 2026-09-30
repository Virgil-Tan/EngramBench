import test from 'node:test';
import assert from 'node:assert/strict';
import { executeCase } from '../src/task-evaluator-v2/execution.mjs';
import { createDeferredEvolutionAdapter } from '../src/memorax-evolution-adapter.mjs';
test('a task wrapper cannot turn an author fixture error into model zero', async () => {
  const cause = Object.assign(new Error('Author field not in public contract'), { origin: 'evaluator', code: 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH' });
  const result = await executeCase({ definition: { id: 'A-01', dimension: 'A', weight: 1 }, contextOptions: {}, failureCodePrefix: 'FIXTURE_', withContext: async (_, run) => run({}), implementation: { run() { throw new Error('task-specific scenario failed', { cause }); } } });
  assert.equal(result.status, 'evaluator_error');
  assert.equal(result.evaluatorErrorCode, cause.code);
  assert.match(result.privateMessage, /Author field/);
});
test('explicit business failure remains a submission failure, not an evaluator exemption', async () => {
  const result = await executeCase({ definition: { id: 'A-01', dimension: 'A', weight: 1 }, contextOptions: {}, failureCodePrefix: 'BUSINESS_', withContext: async (_, run) => run({}), implementation: { run() { throw Object.assign(new Error('oversold capacity'), { origin: 'candidate' }); } } });
  assert.equal(result.status, 'failed');
  assert.match(result.privateFailureCode, /^BUSINESS_/);
});
test('explicitly deferred evolution is deferred, not failed or a new bank checkpoint', async () => {
  const outcome = await createDeferredEvolutionAdapter().run();
  assert.equal(outcome.status, 'deferred');
  assert.equal(outcome.turns, 0);
});
