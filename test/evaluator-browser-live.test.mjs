import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('real Chromium closes abandoned waits without hiding the original UI failure', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { chromium } from 'playwright-core';
    import { observeBrowserWait } from './src/task-evaluator-v2/browser.mjs';
    const unhandled = []; process.on('unhandledRejection', e => unhandled.push(e));
    const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage(); await page.setContent('<button>Present</button>');
    const waiting = observeBrowserWait(page.waitForResponse(() => true));
    let original;
    try { await page.getByRole('button', { name: 'Missing UI control' }).click({ timeout: 100 }); } catch (e) { original = e; }
    assert.match(original.message, /Missing UI control/);
    await browser.close(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    await assert.rejects(waiting, /closed/);
    console.log('real Chromium: missing UI remains failure, abandoned waiter handled');
  `], { encoding: 'utf8', cwd: new URL('..', import.meta.url) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
