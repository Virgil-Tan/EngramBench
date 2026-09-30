import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseContext } from '../evaluators/learning/configorbit/v2/lib/runtime.mjs';

test('a completed HTTP 500 response is not a successful webhook acknowledgement', async t => {
  const ctx = await createCaseContext({ caseId: 'RACE-04', workspace: process.cwd(), evaluationSeed: 'receiver-regression', baseTime: '2026-09-07T00:00:00.000Z', manageDatabase: false });
  t.after(() => ctx.teardown());
  const receiver = await ctx.receiver({ behavior: entry => ({ status: entry.attempt === 1 ? 500 : 204 }) });
  for (const status of [500, 204]) assert.equal((await fetch(receiver.url, { method: 'POST', body: '{}' })).status, status);
  assert.deepEqual(receiver.ledger.map(item => item.responseStatus), [500, 204]);
  assert.deepEqual(receiver.ledger.map(item => item.acknowledged), [false, true]);
});
