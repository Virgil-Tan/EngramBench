import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CommandError, runCommand } from '../src/task-evaluator-v2/runtime.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'linux') return true;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
  } catch { return false; }
}

function fixture({ exitCode = 23, wait = false, detached = true, scrubEnvironment = false, startupDelayMs = 0 } = {}) {
  return `
    // Reproduce slow process scheduling without changing the cleanup behavior.
    const readyAt = Date.now() + ${startupDelayMs};
    while (Date.now() < readyAt) {}
    const { spawn } = require('node:child_process');
    const children = ['inherit', 'ignore'].map(stderr => spawn(process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 4000)'], {
        detached: ${detached}, stdio: ['ignore', 'ignore', stderr],
        ${scrubEnvironment ? 'env: {},' : ''}
      }));
    children.forEach(child => child.unref());
    console.log(JSON.stringify(children.map(child => child.pid)));
    process.stderr.write('original command failure evidence\\n');
    ${wait ? 'setTimeout(() => process.exit(0), 4000);' : `process.exit(${exitCode});`}
  `;
}

for (const exitCode of [0, 23]) test(`detached descendants cannot hang or pass a command that exited ${exitCode}`, async t => {
  const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 6000)'], { stdio: 'ignore' });
  t.after(() => unrelated.kill('SIGKILL'));
  let error;
  // This test measures post-exit cleanup, not startup speed. A 200 ms command
  // timeout could kill a scheduled child before it emitted its PID evidence.
  await assert.rejects(runCommand(process.execPath, ['-e', fixture({ exitCode, startupDelayMs: 300 })]), value => {
    error = value;
    return value instanceof CommandError;
  });
  const pids = JSON.parse(error.result.stdout.trim());
  t.after(() => { for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert(error.result.durationMs < 2500, 'an exited command must not wait for a detached descendant to close stderr');
  assert.equal(error.result.exitCode, exitCode);
  assert.match(error.result.stderr, /original command failure evidence/);
  assert.equal(error.result.timedOut, false);
  assert.equal(error.result.leakedProcessGroup, true);
  assert(alive(unrelated.pid), 'cleanup must not signal an unrelated process');
  if (process.platform === 'linux') assert(pids.every(pid => !alive(pid)), 'both the pipe holder and silent owned descendant must be reaped');
});

test('running-command timeout also cleans detached descendants without replacing timeout evidence', async t => {
  let error;
  await assert.rejects(runCommand(process.execPath, ['-e', fixture({ wait: true })], { timeoutMs: 300 }), value => {
    error = value;
    return value instanceof CommandError;
  });
  const pids = JSON.parse(error.result.stdout.trim());
  t.after(() => { for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert(error.result.durationMs < 2500);
  assert.equal(error.result.timedOut, true);
  assert.equal(error.result.signal, 'SIGKILL');
  if (process.platform === 'linux') assert(pids.every(pid => !alive(pid)));
});

test('pipe draining stays bounded when a detached child clears its inherited environment', async t => {
  let error;
  await assert.rejects(runCommand(process.execPath, ['-e', fixture({ scrubEnvironment: true })]), value => {
    error = value;
    return value instanceof CommandError;
  });
  const pids = JSON.parse(error.result.stdout.trim());
  t.after(() => { for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert(error.result.durationMs < 2500);
  assert.equal(error.result.exitCode, 23);
  assert.equal(error.result.leakedProcessGroup, true);
  assert.match(error.result.stderr, /output streams remained open/);
});

test('healthy commands, allowed nonzero exits and same-group leak detection retain their behavior', async () => {
  const success = await runCommand(process.execPath, ['-e', 'console.log("healthy")']);
  assert.equal(success.exitCode, 0);
  assert.equal(success.stdout.trim(), 'healthy');
  assert.equal(success.leakedProcessGroup, false);
  const allowed = await runCommand(process.execPath, ['-e', 'process.exit(7)'], { allowFailure: true });
  assert.equal(allowed.exitCode, 7);
  await assert.rejects(runCommand(process.execPath, ['-e', fixture({ detached: false })]), error =>
    error.result.exitCode === 23 && error.result.leakedProcessGroup === true);
  const lateOutput = await runCommand(process.execPath, ['-e', `
    const child = require('node:child_process').spawn(process.execPath,
      ['-e', 'setTimeout(() => console.log("late-output"), 75)'],
      { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    child.unref();
  `]);
  assert.equal(lateOutput.stdout.trim(), 'late-output');
  assert.equal(lateOutput.leakedProcessGroup, false);
});

test('concurrent commands have independent descendant ownership', async () => {
  const results = await Promise.all([
    runCommand(process.execPath, ['-e', 'setTimeout(() => console.log("other command survived"), 1800)']),
    runCommand(process.execPath, ['-e', `
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setTimeout(() => {}, 2000)'],
        { detached: true, stdio: ['ignore', 'ignore', 'inherit'] });
      child.unref();
      process.exit(23);
    `]).catch(error => error),
  ]);
  assert.equal(results[0].exitCode, 0);
  assert.match(results[0].stdout, /other command survived/);
  assert(results[1] instanceof CommandError);
  assert.equal(results[1].result.exitCode, 23);
});
