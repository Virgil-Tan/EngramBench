import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/task-evaluator-v2/runtime.mjs';

test('completed npm-style parent allows its owned child to drain before declaring a leak', async () => {
  const result = await runCommand(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    spawn(process.execPath, ['-e', 'setTimeout(() => console.log("owned child drained"), 700)'], { stdio: 'inherit' }).unref();
    process.exit(0);
  `]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.leakedProcessGroup, false);
  assert.match(result.stdout, /owned child drained/);
});
