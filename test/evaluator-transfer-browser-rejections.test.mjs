import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';

for (const task of ['carbonledger', 'escrowguard']) {
  const casesRoot = new URL(`../evaluators/transfer/${task}/v2/cases/`, import.meta.url);
  const helpers = new URL('helpers.mjs', casesRoot).href;
  const dSource = ts.createSourceFile('d.mjs', readFileSync(new URL('d.mjs', casesRoot), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const privateFunctions = task === 'carbonledger'
    ? dSource.statements.filter(node => ts.isFunctionDeclaration(node) && ['keyboardMutation', 'openCertificate'].includes(node.name?.text)).map(node => node.getText(dSource)).join('\n')
    : '';
  const actions = [['mutation helper', task === 'escrowguard' ? 'helpers.browserMutation(page, [/submit/i], /api/, { timeoutMs: 10 })' : 'helpers.browserMutation(page, [/submit/i], /api/)']];
  if (task === 'carbonledger') actions.push(['keyboard mutation', 'keyboardMutation(page, [/submit/i], /api/)'], ['certificate download', 'openCertificate(page, "retirement-id")']);

  for (const [label, action] of actions) for (const scenario of ['action failure', 'early timeout', 'success']) {
    test(`${task} ${label} preserves ${scenario} without orphaned waits`, () => {
      // The child observes unhandled rejections without involving node:test's handlers.
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { EventEmitter } from 'node:events';
        import * as helpers from ${JSON.stringify(helpers)};
        const { visibleControl, tabTo } = helpers;
        const observeBrowserWait = helpers.observeBrowserWait ?? (promise => promise);
        ${privateFunctions}
        const actionError = new Error('SUBMISSION_UI_ACTION_FAILED');
        const waitError = new Error('page.waitForResponse: timeout or browser closed');
        const request = { method: () => 'POST', url: () => 'http://fixture/api' };
        const response = { status: () => 202, request: () => request };
        const unhandled = []; let rejectPending, waits = 0;
        process.on('unhandledRejection', error => unhandled.push(error));
        const scenario = ${JSON.stringify(scenario)};
        const act = async () => {
          if (scenario === 'action failure') throw actionError;
          if (${JSON.stringify(task)} === 'escrowguard' && scenario === 'success') { page.emit('request', request); page.emit('response', response); }
          await new Promise(resolve => setImmediate(resolve));
        };
        const control = { isVisible: async () => true, evaluate: async () => true, click: act };
        const locator = { count: async () => 1, nth: () => control, click: act, or() { return this; }, and() { return this; }, first() { return control; } };
        control.waitFor = async () => {};
        const page = {
          getByRole: () => locator, locator: () => locator,
          keyboard: { press: act },
          waitForResponse: () => {
            waits++;
            if (scenario === 'success') return Promise.resolve(response);
            if (scenario === 'early timeout') return Promise.reject(waitError);
            return new Promise((_, reject) => { rejectPending = reject; });
          },
        };
        if (${JSON.stringify(task)} === 'escrowguard') {
          const emitter = new EventEmitter();
          page.emit = emitter.emit.bind(emitter); page.off = emitter.off.bind(emitter);
          page.on = (name, listener) => { if (name === 'response') waits++; return emitter.on(name, listener); };
        }
        if (scenario === 'success') assert.equal(await ${action}, response);
        else await assert.rejects(async () => ${action}, error => scenario === 'action failure' ? error === actionError
          : ${JSON.stringify(task)} === 'escrowguard' ? error.code === 'EVALUATOR_UI_NO_MATCHING_REQUEST' : error === waitError);
        assert.equal(waits, 1, 'actual evaluator must register its response wait');
        rejectPending?.(waitError);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(unhandled, [], 'UI failure/cleanup must not orphan the response wait');
      `], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    });
  }

  test(`${task} covers every speculative browser wait in its cases`, () => {
    let waits = 0;
    for (const name of readdirSync(casesRoot).filter(name => name.endsWith('.mjs'))) {
      const source = ts.createSourceFile(name, readFileSync(new URL(name, casesRoot), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      function inspect(node) {
        const browserCall = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression);
        const navigation = browserCall && ['goto', 'reload'].includes(node.expression.name.text)
          && (ts.isVariableDeclaration(node.parent) || (ts.isCallExpression(node.parent) && ts.isVariableDeclaration(node.parent.parent)));
        if (browserCall && (node.expression.name.text === 'waitForResponse' || navigation)) {
          waits++;
          assert(ts.isCallExpression(node.parent) && node.parent.expression.getText(source) === 'observeBrowserWait',
            `${task}/${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} must observe its wait before a UI action can fail`);
        }
        ts.forEachChild(node, inspect);
      }
      inspect(source);
    }
    assert(waits > 0, 'must inspect actual browser response waits');
  });

  test(`${task} observes navigation rejection while its loading assertion is pending`, () => {
    const navigationCode = task === 'carbonledger'
      ? dSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'assertControlledLoading').getText(dSource) + '\nawait assertControlledLoading(page);'
      : dSource.text.slice(dSource.text.indexOf('const loadingNavigation = '), dSource.text.indexOf(' ctx.ok(delayed,', dSource.text.indexOf('const loadingNavigation = ')));
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import * as helpers from ${JSON.stringify(helpers)};
      const observeBrowserWait = helpers.observeBrowserWait ?? (promise => promise);
      const failure = new Error('original navigation failure'), unhandled = [];
      process.on('unhandledRejection', error => unhandled.push(error));
      const page = {
        route: async () => {}, unroute: async () => {},
        goto: () => Promise.reject(failure), reload: () => Promise.reject(failure),
        getByText: () => ({ first: () => ({ waitFor: () => new Promise(resolve => setImmediate(resolve)) }) }),
      };
      const desktop = page, shield = { baseUrl: 'http://fixture' };
      await assert.rejects(async () => { ${navigationCode} }, error => error === failure);
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(unhandled, [], 'loading checks must observe their concurrent navigation');
    `], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
