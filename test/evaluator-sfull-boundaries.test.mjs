import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as helpers from '../src/task-evaluator-v2/browser.mjs';
import { candidateAssert } from '../src/task-evaluator-v2/execution.mjs';
import { CommandError, observeExpectedCommandFailure } from '../src/task-evaluator-v2/runtime.mjs';

function functions(path, names, bindings = {}) {
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const code = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(source).replace(/^export /, '')).join('\n');
  return runInNewContext(code + `;({${names.join(',')}})`, { ...helpers, ...bindings });
}

test('positive UI flow attributes a rejected candidate prerequisite, not arbitrary requests or negative probes', async () => {
  const { EventEmitter } = await import('node:events');
  for (const [optIn, origin, candidateFailure] of [[true, 'http://candidate', true], [false, 'http://candidate', false], [true, 'http://external', false]]) {
    const page = new EventEmitter(); page.url = () => 'http://candidate/';
    const request = { method: () => 'POST', url: () => origin + '/api/v1/flags' };
    const response = { request: () => request, status: () => 400 };
    await assert.rejects(helpers.captureBrowserResponse(page, () => false, async () => {
      page.emit('request', request); page.emit('response', response);
    }, { timeoutMs: 20, expectSuccessfulMutations: optIn }), error => candidateFailure
      ? error.origin === 'candidate' && /rejected prerequisite/.test(error.message)
      : error.code === 'EVALUATOR_UI_NO_MATCHING_REQUEST');
    assert.equal(page.listenerCount('response'), 0);
  }
});

test('FlagFoundry rollout lookup matches the requested candidate, not an unrelated seeded rollout', () => {
  const path = '../evaluators/transfer/flagfoundry/v2/cases/d.mjs';
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const predicates = [];
  function visit(n) {
    if (ts.isCallExpression(n) && n.expression.getText(source).endsWith('progressiveRollouts.find') && n.arguments[0]?.getText(source).includes('candidate.revision.revisionId')) predicates.push(n.arguments[0].getText(source));
    ts.forEachChild(n, visit);
  }
  visit(source); assert.equal(predicates.length, 2);
  for (const code of predicates) {
    const predicate = runInNewContext('(' + code + ')', { candidate: { revision: { revisionId: 'chosen' } } });
    assert.equal(predicate({ candidateRevisionId: 'other' }), false);
    assert.equal(predicate({ candidateRevisionId: 'chosen' }), true);
  }
});

test('S-Full UI regressions use actual evaluator drivers', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(1500);
  const ff = functions('../evaluators/transfer/flagfoundry/v2/cases/d.mjs', ['uiCreateFlag', 'uiProgressive', 'fill', 'enter', 'click', 'visible']);
  await t.test('forms can be named by their action without an internal heading', async () => {
    await page.setContent(`<section><h2>Operations</h2>
      <form onsubmit="event.preventDefault();this.dataset.sent='yes'"><label>Project ID<input></label><label>Flag key<input></label><label>Flag type<select><option>STRING</option></select></label><button>Create Flag</button></form>
      <form><label>Revision value<input></label><button>Create Revision</button></form>
      <form><button>Submit Outcome</button></form></section>`);
    await ff.uiCreateFlag(page, 'project', 'key', 'STRING');
    assert.equal(await page.locator('form').first().getAttribute('data-sent'), 'yes');
  });
  await t.test('steps JSON is an array, not the entire rollout request; Load Rollout is not Start Rollout', async () => {
    await page.setContent(`<label>Revision flag ID<input value=unrelated></label><section><h2>Progressive Rollout</h2>
      <label>Candidate revision ID<input></label><label>Expected active revision<input></label><label>Steps JSON<textarea></textarea></label>
      <button onclick="this.dataset.sent='yes'">Start Rollout</button><label>Rollout ID<input></label><button>Load Rollout</button><button>Submit Outcome</button></section>`);
    const steps = [{ candidateExposureBasisPoints: 10000 }];
    await ff.uiProgressive(page, 'revision', 1, steps, { flagId: 'chosen-flag' });
    assert.equal(await page.getByLabel('Revision flag ID', { exact: true }).inputValue(), 'chosen-flag');
    assert.deepEqual(JSON.parse(await page.getByLabel('Steps JSON').inputValue()), steps);
    assert.equal(await page.getByLabel('Candidate revision ID').inputValue(), 'revision');
    assert.equal(await page.getByRole('button', { name: 'Start Rollout' }).getAttribute('data-sent'), 'yes');
  });
  await t.test('Escrow ordered action synonyms do not collide with Resolve Release', async () => {
    const eg = functions('../evaluators/transfer/escrowguard/v2/cases/helpers.mjs', ['visibleControl', 'firstVisible']);
    await page.setContent('<button>Accept</button><button>Resolve Release</button>');
    assert.equal(await (await eg.visibleControl(page, ['button'], [/accept/i, /release/i])).innerText(), 'Accept');
  });
  await t.test('MeterSettle shared Scope fields stay separate from unrelated mutation forms', async () => {
    const { performUsageUi } = await import('../evaluators/transfer/metersettle/v2/cases/ui.mjs');
    await page.route('http://fixture/**', r => r.fulfill({ status: 202, contentType: 'application/json', body: '{}' }));
    await page.goto('http://fixture/');
    await page.setContent(`<section><h2>Scope</h2><label>Tenant ID<input id=t></label><label>Meter ID<input id=m></label></section>
      <section><h2>Usage</h2><label>Event ID<input id=e></label><label>Occurred at<input id=o></label><label>Quantity<input id=q></label>
      <button onclick="fetch('/api/v1/usage-batches',{method:'POST',body:JSON.stringify({tenantId:t.value,events:[{eventId:e.value,meterId:m.value,occurredAt:o.value,quantity:Number(q.value)}]})})">Ingest usage</button></section>
      <section><h2>Correction</h2><label>Tenant ID<input value=unrelated></label><button>Create correction</button></section>`);
    const actual = await performUsageUi(page, { tenant: { tenantId: 'chosen' }, meters: [{ meterId: 'unrelated-first-meter' }, { meterId: 'event-meter' }], events: [{ eventId: 'event', meterId: 'event-meter', occurredAt: '2035-01-01T00:00:00.000Z', quantity: 2 }] });
    assert.equal(actual.tenantId, 'chosen');
    assert.equal(actual.events[0].meterId, 'event-meter');
    assert.equal(await page.getByLabel('Tenant ID').nth(1).inputValue(), 'unrelated');
  });
  await t.test('inline Escrow create is exercised; hard-coded partial payload fails as a submission assertion', async () => {
    await page.goto('http://fixture/');
    await page.setContent(`<form><h2>Create Escrow</h2><label>Buyer<input></label><label>Seller<input></label><label>Seller share<input value=88></label><label>Total<input></label>
      <button type=button onclick="fetch('/api/v1/escrows',{method:'POST',body:JSON.stringify({buyerId:'chosen',milestones:[]})})">Create</button></form>`);
    const eg = functions('../evaluators/transfer/escrowguard/v2/cases/d.mjs', ['createViaBrowser', 'openCreateForm', 'optionalFill', 'addMilestone'], {
      URL, assert: candidateAssert, launchBrowser: async () => ({ page }), fillControl: (field, value) => field.fill(String(value)),
    });
    await assert.rejects(eg.createViaBrowser({}, 'http://fixture/', { buyerId: 'chosen', sellerId: 'seller', currency: 'USD', totalMinor: 5, expiresAt: '2035-01-01T00:00:00.000Z', milestones: [{ title: 'one', amountMinor: 5 }] }),
      e => e.origin === 'candidate' && /chosen Escrow/.test(e.message));
    assert.equal(await page.getByLabel('Seller', { exact: true }).inputValue(), 'seller');
    assert.equal(await page.getByLabel('Seller share').inputValue(), '88');
  });
  await t.test('keyboard create supports an already-open form without clicking an imaginary navigation button', async () => {
    await page.setContent('<form><h2>Create Escrow</h2><label>Buyer ID<input></label><button>Create</button></form>');
    const eg = functions('../evaluators/transfer/escrowguard/v2/cases/d.mjs', ['openCreateForm']);
    const root = await eg.openCreateForm(page, { keyboard: true });
    assert.equal(await root.getByRole('button', { name: 'Create', exact: true }).count(), 1);
  });
  await t.test('single-Milestone keyboard form need not duplicate total or expose a fixed currency input', async () => {
    const { keyboardFill } = await import('../evaluators/transfer/escrowguard/v2/cases/helpers.mjs');
    const eg = functions('../evaluators/transfer/escrowguard/v2/cases/d.mjs', ['fillKeyboardEscrowForm'], { keyboardFill });
    await page.setContent('<form><label>Buyer ID<input></label><label>Seller ID<input></label><label>Beneficiary ID<input></label><label>Total minor<input type=number></label><label>Milestone title<input></label><label>Expires at<input></label><button>Create</button></form>');
    await eg.fillKeyboardEscrowForm(page, page.locator('form'), { buyerId: 'buyer', sellerId: 'seller', parties: [{}, {}, { partyId: 'known-party' }], fixtures: { at: () => '2035-01-01T00:00:00.000Z' } });
    assert.equal(await page.getByLabel('Buyer ID').inputValue(), 'buyer');
    assert.equal(await page.getByLabel('Beneficiary ID').inputValue(), 'known-party');
    assert.equal(await page.getByLabel('Total minor').inputValue(), '100');
    assert.equal(await page.getByLabel('Milestone title').inputValue(), 'Keyboard Milestone');
  });
  await t.test('loading observation holds an actual request, avoiding a short wall-clock race', async () => {
    await page.setContent(`<button onclick="document.querySelector('p').hidden=false;fetch('/api/v1/items').then(()=>document.querySelector('p').hidden=true)">Load items</button><p hidden>Loading</p>`);
    await helpers.assertUiLoading(page, () => page.getByRole('button').click());
    await page.setContent('<p>No data available</p>');
    await helpers.assertUiEvidence(page.getByText(/no.*available/i), 'empty state');
    const original = new TypeError('bad locator implementation');
    await assert.rejects(helpers.assertUiEvidence({ first: () => ({ waitFor: async () => { throw original; } }) }, 'state'), e => e === original);
  });
  await t.test('native HTML validation is accessible feedback without a custom aria-invalid attribute', async () => {
    await page.setContent('<form><label>Quantity<input type=number min=0 value=-1 required></label><button>Submit</button></form>');
    await page.getByRole('button').click();
    const source = readFileSync(new URL('../evaluators/transfer/metersettle/v2/cases/d.mjs', import.meta.url), 'utf8');
    const selector = source.match(/const error = page\.locator\("([^"]+)"\)/)[1];
    await helpers.assertUiEvidence(page.locator(selector), 'invalid quantity');
    assert.equal(await page.getByLabel('Quantity').getAttribute('aria-invalid'), null);
    assert.equal(await page.getByLabel('Quantity').evaluate(node => node === document.activeElement), true);
  });
  await t.test('a non-JSON revision form is exercised and an incomplete emitted configuration is a candidate failure', async () => {
    await page.setContent(`<form onsubmit="event.preventDefault();fetch('/api/v1/flags/chosen/revisions',{method:'POST',body:JSON.stringify({variants:[{key:'fixed',value:'fixed',allocationBasisPoints:10000}],rules:[]})})">
      <h2>Create Revision</h2><label>Flag ID<input></label><label>Variant value<input></label><button>Create Revision</button></form>`);
    const driver = functions('../evaluators/transfer/flagfoundry/v2/cases/d.mjs', ['uiCreateRevision', 'fill', 'enter', 'click', 'visible'], { URL, assert: candidateAssert });
    await assert.rejects(driver.uiCreateRevision(page, 'chosen', { stringFlag: {}, revisionBody: () => ({ variants: [{ key: 'control', value: 'requested', allocationBasisPoints: 10000 }], rules: [], expectedActiveRevision: 0 }) }),
      e => e.origin === 'candidate' && /chosen Revision configuration/.test(e.message));
  });
  await t.test('combined Revision flow is judged by actual requests, not by absence of a dedicated editor', async () => {
    const driver = functions('../evaluators/transfer/flagfoundry/v2/cases/d.mjs', ['uiCreateRevision', 'fill', 'enter', 'click', 'visible'], { URL, assert: candidateAssert });
    const body = { environment: 'test', variants: [{ key: 'control', value: 'chosen' }], rules: [] };
    const family = { project: { projectId: 'project' }, stringFlag: {}, revisionBody: () => body };
    for (const outcome of ['rejected-prerequisite', 'wrong-flag', 'hardcoded-revision', 'correct-revision']) {
      await page.unroute('http://fixture/**');
      await page.route('http://fixture/**', route => route.fulfill({
        status: route.request().method() === 'POST' && outcome === 'rejected-prerequisite' ? 404 : 200,
        contentType: 'application/json', body: '{}',
      }));
      await page.goto('http://fixture/');
      await page.setContent(`<label>Project ID<input value=unrelated></label><section><h2>Progressive Rollout</h2><label>Project ID<input></label>
        <button onclick='fetch(${JSON.stringify(outcome === 'rejected-prerequisite' ? '/api/v1/flags' : '/api/v1/flags/' + (outcome === 'wrong-flag' ? 'other' : 'chosen') + '/revisions')},
          {method:"POST",body:JSON.stringify(${JSON.stringify(outcome === 'hardcoded-revision' ? { ...body, variants: [] } : body)})})'>Run Rollout</button></section>`);
      if (outcome === 'correct-revision') await driver.uiCreateRevision(page, 'chosen', family);
      else await assert.rejects(driver.uiCreateRevision(page, 'chosen', family), error => error.origin === 'candidate'
        && (outcome === 'rejected-prerequisite' ? /rejected prerequisite/.test(error.message)
          : outcome === 'wrong-flag' ? /requested Flag/.test(error.message) : /chosen Revision configuration/.test(error.message)));
      assert.equal(await page.locator('section').getByLabel('Project ID').inputValue(), 'project');
      assert.equal(await page.getByLabel('Project ID').first().inputValue(), 'unrelated');
    }
  });
  await t.test('only a fresh explicit Revision rejection is attributable; an old alert is not', async () => {
    const noRequest = helpers.uiAutomationError('NO_MATCHING_REQUEST', 'no matching request');
    const driver = functions('../evaluators/transfer/flagfoundry/v2/cases/d.mjs', ['uiCreateRevision', 'fill', 'enter', 'click', 'visible'], {
      URL, assert: candidateAssert,
      captureBrowserResponse: async (_page, _matches, action) => { await action(); throw noRequest; },
    });
    const family = { stringFlag: {}, revisionBody: () => ({ variants: [{ key: 'control', value: 'value' }], rules: [] }) };
    await page.setContent(`<form><button type=button onclick="document.querySelector('p').textContent='Revision error: NOT_FOUND'">Create Revision</button></form><p role=status></p>`);
    await assert.rejects(driver.uiCreateRevision(page, 'chosen', family), error => error.origin === 'candidate' && /explicitly rejected/.test(error.message));
    await page.setContent(`<form><button type=button>Create Revision</button></form><p role=alert>Revision error: NOT_FOUND</p>`);
    await assert.rejects(driver.uiCreateRevision(page, 'chosen', family), error => error === noRequest);
    await page.setContent(`<form><h2>Create Flag</h2><button type=button onclick="this.dataset.clicked='yes'">Create Flag</button></form>`);
    await assert.rejects(driver.uiCreateRevision(page, 'chosen', family), error => error.code === 'EVALUATOR_UI_TARGET_UNRESOLVED');
    assert.equal(await page.getByRole('button').getAttribute('data-clicked'), null);
  });
});

test('CapacityLease unauthorized snapshot traffic is explicitly negative', async () => {
  const path = '../evaluators/transfer/capacitylease/v2/cases/d.mjs';
  const source = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = [];
  function visit(n) { if (ts.isCallExpression(n) && n.expression.getText(source) === 'ctx.request' && n.arguments[1]?.text === '/api/v1/verification-snapshot') calls.push(n); ts.forEachChild(n, visit); }
  visit(source);
  const anonymous = calls.filter(n => !n.arguments[2]?.getText(source).includes('authorization'));
  assert.equal(anonymous.length, 1);
  assert.match(anonymous[0].arguments[2]?.getText(source) ?? '', /contractExpectation:\s*["']invalid/);
});

test('Escrow re-enters its visible detail after reload before another mutation', async () => {
  const calls = [];
  const { reloadEscrow } = functions('../evaluators/transfer/escrowguard/v2/cases/d.mjs', ['reloadEscrow', 'openEscrow'], { assert: candidateAssert });
  const page = {
    reload: async () => calls.push('reload'),
    getByText: id => { assert.equal(id, 'chosen'); return { first: () => ({ count: async () => 1, click: async () => calls.push('select') }) }; },
    waitForLoadState: async () => calls.push('detail settled'),
  };
  await reloadEscrow({ mark: () => calls.push('observed') }, page, 'chosen');
  assert.deepEqual(calls, ['reload', 'select', 'detail settled', 'observed']);
  const source = readFileSync(new URL('../evaluators/transfer/escrowguard/v2/cases/d.mjs', import.meta.url), 'utf8');
  assert.equal(source.split('await reloadEscrow(ctx, page, escrow.escrowId); const secondSubmit').length - 1, 2);
});

test('CapacityLease actual gate driver observes cleaned negative crashes, not just allowFailure', async () => {
  const end = new Error('reached topology'), calls = [];
  const { runD07 } = functions('../evaluators/transfer/capacitylease/v2/cases/d.mjs', ['runD07', 'guarded'], {
    assert: candidateAssert, observeExpectedCommandFailure,
    processTable: async () => { throw end; },
  });
  await assert.rejects(runD07({ tempPath: () => '/missing', npm: async (name, _, options) => {
    calls.push(name);
    if (options.allowFailure) throw new CommandError(name, { exitCode: 1, signal: null, timedOut: false, leakedProcessGroup: true, cleanupComplete: true });
    return { exitCode: 0 };
  } }), e => e === end);
  assert.deepEqual(calls, ['test:integration', 'test:integration', 'test:e2e', 'test:e2e']);
});

test('HTTP timeout attribution is limited to a recorded candidate API, never arbitrary evaluator traffic', async t => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const { createCaseContext } = await import('../evaluators/transfer/capacitylease/v2/lib/runtime.mjs');
  const server = createServer(() => {}); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const ctx = await createCaseContext({ caseId: 'C-05', workspace: process.cwd(), evaluationSeed: 'timeout-attribution', manageDatabase: false });
  t.after(async () => { ctx.processes.length = 0; server.closeAllConnections(); server.close(); await ctx.teardown(); });
  await assert.rejects(ctx.request(baseUrl, '/healthz', { timeoutMs: 20 }), e => e.name === 'TimeoutError' && e.origin !== 'candidate');
  ctx.processes.push({ role: 'api', baseUrl, stopped: false, child: { exitCode: null } });
  await assert.rejects(ctx.request(baseUrl, '/healthz', { timeoutMs: 20 }), e => e.origin === 'candidate' && e.response?.timeoutMs === 20);
});
