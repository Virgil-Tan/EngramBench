import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const helpers = new URL('../evaluators/transfer/creatorrightsexchange/v2/cases/helpers.mjs', import.meta.url).href;
const source = readFileSync(new URL('../evaluators/transfer/creatorrightsexchange/v2/cases/d.mjs', import.meta.url), 'utf8');
const upload = source.slice(source.indexOf('    const uploadPromise = '), source.indexOf('    const uploadNetwork = await uploadPromise;'));

// A child isolates unhandledRejection detection from the Node test runner.
for (const [name, action] of [
  ['single response', 'await captureJsonResponse(page, () => true, async () => { throw businessError; })'],
  ['file chooser', 'await keyboardChooseFile(page, {})'],
  ['actual D-02 multiple response waiters', upload],
]) test(`browser ${name}: failed UI action stays a business failure, not an unhandled waiter`, () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import * as helpers from ${JSON.stringify(helpers)};
    const { captureJsonResponse, keyboardChooseFile } = helpers;
    const observeBrowserWait = helpers.observeBrowserWait ?? (promise => promise);
    const businessError = new Error('SUBMISSION_UI_CONTROL_MISSING');
    const waitError = new Error('Target page, context or browser has been closed');
    const rejections = [], unhandled = [];
    process.on('unhandledRejection', error => unhandled.push(error));
    const waiter = () => new Promise((_, reject) => rejections.push(reject));
    const page = { waitForResponse: waiter, waitForEvent: waiter,
      locator: () => ({ first: () => ({ count: async () => 1, focus: async () => {} }) }),
      keyboard: { press: async () => { throw businessError; } } };
    const clickVisible = async () => { throw businessError; };
    await assert.rejects(async () => { ${action} }, error => error === businessError);
    assert(rejections.length > 0, 'actual waiter path must run');
    for (const reject of rejections) reject(waitError);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'browser cleanup must not orphan response waits');
    const rejected = observeBrowserWait(Promise.reject(waitError));
    await assert.rejects(rejected, error => error === waitError, 'awaited errors must not become success');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('browser wait observation preserves response identity and handles early timeout while action runs', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import * as helpers from ${JSON.stringify(helpers)};
    const { captureJsonResponse } = helpers;
    const observeBrowserWait = helpers.observeBrowserWait ?? (promise => promise);
    const unhandled = [];
    process.on('unhandledRejection', e => unhandled.push(e));
    const payload = { id: 'real-response' }, wire = Promise.resolve(payload);
    assert.equal(observeBrowserWait(wire), wire);
    assert.equal(await wire, payload);
    const timeout = new Error('response timeout');
    await assert.rejects(captureJsonResponse({ waitForResponse: () => Promise.reject(timeout) }, () => true,
      async () => new Promise(resolve => setImmediate(resolve))), e => e === timeout);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
