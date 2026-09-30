import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../src/task-evaluator-v2/runtime.mjs';

for (const task of ['metersettle', 'flagfoundry']) test(`${task} actual D-06 reaches business recovery after the explicit dependency negatives`, async () => {
  const { D_CASES } = await import(`../evaluators/transfer/${task}/v2/cases/d.mjs`);
  const reachedRecovery = new Error('all negatives checked; reached independent recovery test');
  let negatives = 0;
  const ctx = { key: x => x, migrate: async () => {}, equal: assert.deepEqual, ok: assert.ok,
    resetDatabase: async () => { throw reachedRecovery; },
    npm: async (_script, _args, options = {}) => {
      if (!options.allowFailure) return { exitCode: 0, durationMs: 1, stdout: 'real-gate-evidence', stderr: '' };
      negatives++;
      throw new runtime.CommandError('npm run dependency-negative', { exitCode: 1, signal: null,
        timedOut: false, leakedProcessGroup: true, cleanupComplete: true });
    },
  };
  await assert.rejects(D_CASES.find(c => c.id === 'D-06').run(ctx), e => e === reachedRecovery);
  assert.equal(negatives, task === 'metersettle' ? 2 : 4);
});

test('fault-injection observation accepts only nonzero exit with verified completed cleanup', async () => {
  assert.equal(typeof runtime.observeExpectedCommandFailure, 'function');
  const base = { exitCode: 1, signal: null, timedOut: false, leakedProcessGroup: true, cleanupComplete: true };
  const error = patch => new runtime.CommandError('npm run test:e2e', { ...base, ...patch });
  const observed = await runtime.observeExpectedCommandFailure(async () => { throw error({}); });
  assert.equal(observed.exitCode, 1); assert.equal(observed.leakedProcessGroup, true);
  for (const patch of [{ exitCode: 0 }, { exitCode: null }, { signal: 'SIGKILL' }, { timedOut: true },
    { cleanupComplete: false }, { cleanupComplete: undefined }, { spawnError: 'ENOENT' }]) {
    const original = error(patch);
    await assert.rejects(runtime.observeExpectedCommandFailure(async () => { throw original; }), e => e === original);
  }
  const bug = new TypeError('test author error');
  await assert.rejects(runtime.observeExpectedCommandFailure(async () => { throw bug; }), e => e === bug);
  const infrastructure = Object.assign(error({}), { origin: 'infrastructure' });
  await assert.rejects(runtime.observeExpectedCommandFailure(async () => { throw infrastructure; }), e => e === infrastructure);
  assert.equal((await runtime.observeExpectedCommandFailure(async () => ({ exitCode: 0 }))).exitCode, 0,
    'caller must still assert that the intended dependency failure produced a nonzero exit');
});

test('real public-command failure returns original exit only after its owned descendants are cleaned', { skip: process.platform !== 'linux' }, async () => {
  const result = await runtime.observeExpectedCommandFailure(() => runtime.runCommand(process.execPath, ['-e', `
    const c = require('node:child_process').spawn(process.execPath, ['-e','setTimeout(()=>{},5000)'],
      { detached: true, stdio: ['ignore','ignore','inherit'] });
    c.unref(); console.log('dependency intentionally unavailable'); process.exit(7);
  `], { allowFailure: true }));
  assert.equal(result.exitCode, 7); assert.equal(result.leakedProcessGroup, true);
  assert.equal(result.cleanupComplete, true); assert.match(result.stdout, /intentionally unavailable/);
});
