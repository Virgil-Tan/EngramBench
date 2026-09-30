import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { D_CASES } from '../evaluators/transfer/accesssentinel/v2/cases/d.mjs';
import { loadProtectedSnapshot } from '../evaluators/transfer/accesssentinel/v2/cases/helpers.mjs';

const bodies = {
  'D-02': { tenantId: 'tenant-test', principalId: 'principal-test', deviceId: 'device-test', deviceTrustRevisionId: 'trust-test', requestedTtlSeconds: 600 },
  'D-03': { tenantId: 'tenant-test', sessionId: 'session-test', action: 'deploy', requestedTtlSeconds: 5 },
  'D-05': { tenantId: 'tenant-test', requesterId: 'principal-test', sessionId: 'session-test', actions: ['deploy'], resourcePatterns: ['production/*'], requestedTtlSeconds: 300 },
};
const routes = { 'D-02': '/api/v1/sessions', 'D-03': '/api/v1/access-requests', 'D-05': '/api/v1/break-glass-sessions' };
const labels = { tenantId: 'Tenant', principalId: 'Principal', deviceId: 'Device', deviceTrustRevisionId: 'Trust revision', sessionId: 'Session', requesterId: 'Requester', requestedTtlSeconds: 'TTL seconds', action: 'Action', actions: 'Actions JSON', resourcePatterns: 'Resource patterns JSON' };
const titles = { 'D-02': 'Create session', 'D-03': 'Request access', 'D-05': 'Create break glass' };

test('registered Access browser cases never fill a Policy editor or click an unrelated Create action', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true });
  t.after(() => browser.close());
  for (const options of [
    { caseId: 'D-02' }, { caseId: 'D-02', wholeBody: true }, { caseId: 'D-02', genericButton: true, derivedTrust: true }, { caseId: 'D-02', container: 'div role="form"' }, { caseId: 'D-02', container: 'fieldset' }, { caseId: 'D-02', container: 'section role="region"' }, { caseId: 'D-03' }, { caseId: 'D-05' }, { caseId: 'D-05', rawArray: true },
    { caseId: 'D-05', missing: true }, { caseId: 'D-02', duplicate: true }, { caseId: 'D-02', reject: true },
    { caseId: 'D-02', globalTenant: true }, { caseId: 'D-03', globalTenant: true }, { caseId: 'D-05', globalTenant: true },
    { caseId: 'D-02', globalTenant: true, ambiguousTenant: true }, { caseId: 'D-02', globalTenant: true, missingTenantOption: true }, { caseId: 'D-05', globalTenant: true, emptyRequester: true },
  ]) await t.test(JSON.stringify(options), async t => {
    const { caseId } = options, body = bodies[caseId], traffic = [], stop = new Error('first observed UI request verified');
    const fields = Object.entries(body).map(([key, value]) => `<label>${labels[key]}${key.endsWith('Id')
      ? options.derivedTrust && key === 'deviceTrustRevisionId' ? `<input name="${key}" readonly value="${value}">` : `<select name="${key}"><option value="wrong">Unrelated</option>${options.globalTenant && key !== 'tenantId' ? '' : `<option value="${value}">${value}</option>`}</select>`
      : Array.isArray(value) ? `<textarea name="${key}">${options.rawArray ? 'example' : '[]'}</textarea>` : `<input name="${key}" type="${typeof value === 'number' ? 'number' : 'text'}">`}</label>`).join('');
    const container = options.container ?? 'form';
    const target = `<${container} data-target><h2>${titles[caseId]}</h2>${options.wholeBody ? '<label>Request body<textarea>{}</textarea></label>' : fields}<button>${options.genericButton ? 'Create' : titles[caseId]}</button></${container.split(' ')[0]}>`;
    const related = caseId === 'D-02' ? '<form class="related-decoy"><button>Create break-glass session</button></form>' : caseId === 'D-03' ? '<form class="related-decoy"><h2>Review Access Request</h2><button>Submit Review</button></form><form class="related-decoy"><button>Grant request</button></form>' : '';
    const globalTenant = options.globalTenant ? `<label>Selected Tenant<select id="context"><option value="foreign">Foreign tenant</option>${options.missingTenantOption ? '' : '<option value="tenant-test">Test tenant</option>'}</select></label>` : '';
    const html = `${globalTenant}${options.ambiguousTenant ? globalTenant.replace('id="context"', 'id="other-context"') : ''}<form id="decoy"><h2>Policy</h2><label>Selected Tenant<select id="decoy-tenant"><option value="foreign">Foreign tenant</option><option value="tenant-test">Test tenant</option></select></label><label>Rules JSON<textarea>[]</textarea></label><button>Create policy bundle</button></form>${related}${options.missing ? '' : target}${options.duplicate ? target : ''}<script>
      const context = document.getElementById('context');
      if (context) context.onchange = () => { for (const [key, value] of Object.entries(${JSON.stringify(body)})) if (key.endsWith('Id') && key !== 'tenantId' && !(${Boolean(options.emptyRequester)} && key === 'requesterId')) document.querySelector('[data-target] [name="' + key + '"]').innerHTML = context.value === 'tenant-test' ? '<option value="' + value + '">' + value + '</option>' : '<option value="wrong">Unrelated</option>'; };
      for (const form of document.querySelectorAll('#decoy,.related-decoy,[data-target]')) { const send = async event => {
        event.preventDefault(); const isTarget = form.hasAttribute('data-target'); let body;
        if (${Boolean(options.wholeBody)} && isTarget) body = JSON.parse(form.querySelector('textarea').value);
        else { body = {}; for (const field of form.querySelectorAll('[name]')) body[field.name] = field.type === 'number' ? Number(field.value) : field.tagName === 'TEXTAREA' ? ${Boolean(options.rawArray)} ? [field.value] : JSON.parse(field.value) : field.value; }
        await fetch(isTarget ? '${routes[caseId]}' : '/api/v1/policy-bundles', { method: 'POST', body: JSON.stringify(body) });
      }; if (form.tagName === 'FORM') form.onsubmit = send; else form.querySelector('button').onclick = send; }</script>`;
    const server = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
      let text = ''; for await (const chunk of req) text += chunk;
      traffic.push({ path: req.url, body: JSON.parse(text) }); res.statusCode = options.reject ? 409 : 200;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: { code: 'STATE_CONFLICT', message: 'test rejection' } }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    let page;
    const family = { seed: {}, tenant: { tenantId: body.tenantId }, sessionBody: () => body, requestBody: () => body, breakGlassBody: () => body };
    const ctx = {
      fixtures: { browser: () => family, breakglass: () => family }, migrate: async () => {}, npm: async () => {}, seed: async () => ({ exitCode: 0 }),
      startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }), startWorker: async () => ({}), defer: cleanup => t.after(cleanup),
      ok: (value, label) => assert.ok(value, label), equal: (actual, expected, label) => { assert.deepEqual(actual, expected, label); if (/UI.*(?:HTTP|create)/.test(label)) throw stop; },
      loadChromium: async () => ({ launch: async () => ({
        newPage: async settings => { page = await browser.newPage(settings); page.setDefaultTimeout(1000); page.setDefaultNavigationTimeout(5000); const wait = page.waitForResponse.bind(page); page.waitForResponse = (predicate, settings) => wait(predicate, { ...settings, timeout: 500 }); return page; },
        close: () => page?.context().close(),
      }) }),
    };
    const tenantFailure = options.ambiguousTenant || options.missingTenantOption || options.emptyRequester;
    if (tenantFailure) {
      await assert.rejects(D_CASES.find(row => row.id === caseId).run(ctx), error => options.ambiguousTenant ? error.code === 'EVALUATOR_UI_TARGET_AMBIGUOUS' : error.name === 'TimeoutError' && /did not find some options/.test(error.message));
      assert.deepEqual(traffic, []);
      if (!options.emptyRequester) assert.equal(await page.locator('[data-target] [name=tenantId]').inputValue(), 'wrong', 'unresolved global context does not edit the action form');
    }
    else if (options.missing || options.duplicate) { await assert.rejects(D_CASES.find(row => row.id === caseId).run(ctx), /visible action form|ambiguous action form/); assert.deepEqual(traffic, []); }
    else if (options.reject) await assert.rejects(D_CASES.find(row => row.id === caseId).run(ctx), /UI Session HTTP/);
    else await assert.rejects(D_CASES.find(row => row.id === caseId).run(ctx), error => error === stop);
    if (!options.missing && !options.duplicate && !tenantFailure) assert.deepEqual(traffic, [{ path: routes[caseId], body }]);
    assert.equal(await page.locator('#decoy textarea').inputValue(), '[]', 'unrelated JSON remains untouched');
    assert.equal(await page.locator('#decoy-tenant').inputValue(), 'foreign', 'an action-form Tenant is never treated as global context');
    if (options.globalTenant && !tenantFailure) {
      await page.reload({ waitUntil: 'networkidle' });
      await loadProtectedSnapshot(ctx, page, { tenantId: body.tenantId });
      assert.equal(await page.locator('#context').inputValue(), 'tenant-test', 'reload restores the visible global context');
      assert.equal(await page.locator('[data-target] [name=tenantId]').inputValue(), 'wrong', 'global selection never substitutes for filling the local form');
    }
  });
});

test('registered Access D-04 uses visible authentication and checks identities in the relevant panel', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true }); t.after(() => browser.close());
  const deviceId = '43f06eb4-device-test', requests = [], pages = [], controls = ['Location', 'Revocations', 'Audit', 'Work', 'Events'];
  const html = `<label>
          Admin Token
          <input type=password>
        </label><button id=load>Load Snapshot</button><div id=views></div><script>
    document.getElementById('load').onclick = async () => {
      const r = await fetch('/api/v1/verification-snapshot', { headers: { authorization: 'Bearer ' + document.querySelector('input').value } });
      if (!r.ok) return;
      document.getElementById('views').innerHTML = '<div hidden>${deviceId}</div>' + ${JSON.stringify(controls)}.map(name => '<button type=button data-panel="' + name + '">' + name + '</button><section hidden data-name="' + name + '">' + (name === 'Work' ? 'SUCCEEDED terminal Work' : name === 'Events' ? 'Event delivered' : '${deviceId} lost device') + '</section>').join('');
      for (const b of document.querySelectorAll('[data-panel]')) b.onclick = () => { for (const p of document.querySelectorAll('[data-name]')) p.hidden = p.dataset.name !== b.dataset.panel; };
    };</script>`;
  const server = createServer((req, res) => { if (req.url.startsWith('/api/')) { requests.push(req.headers.authorization); res.setHeader('content-type', 'application/json'); res.end('{}'); } else { res.setHeader('content-type', 'text/html'); res.end(html); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const state = { resources: { auditEntries: [] }, work: [], events: [] }, family = { seed: {}, device: { deviceId }, locationBody: () => ({}), at: () => '2032-04-05T06:07:08Z' };
  const ctx = {
    adminToken: 'test-only-credential', fixtures: { browser: () => family }, migrate: async () => {}, npm: async () => {}, seed: async () => ({ exitCode: 0 }),
    startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }), startWorker: async () => ({}), startDispatcher: async () => ({}), receiver: async () => ({ url: 'http://unused' }),
    observeLocation: async () => ({ status: 200 }), revokeDevice: async () => ({ status: 200 }), key: x => x, snapshot: async () => state, waitFor: async fn => fn(), defer: cleanup => t.after(cleanup),
    ok: (v, l) => assert.ok(v, l), equal: (a, b, l) => assert.deepEqual(a, b, l), assert: (_label, check) => check(), pass: () => ({ status: 'passed' }),
    loadChromium: async () => ({ launch: async () => ({ newPage: async settings => { const page = await browser.newPage(settings); pages.push(page); page.setDefaultTimeout(1000); page.setDefaultNavigationTimeout(5000); return page; }, close: () => Promise.all(pages.filter(page => !page.isClosed()).map(page => page.context().close())) }) }),
  };
  assert.equal((await D_CASES.find(row => row.id === 'D-04').run(ctx)).status, 'passed');
  assert.deepEqual(requests, ['Bearer test-only-credential', 'Bearer test-only-credential'], 'reload uses normal visible authentication again');
  await assert.rejects(loadProtectedSnapshot({}, pages[0]), error => error.origin === 'evaluator' && error.code === 'EVALUATOR_UI_CONFIGURATION');
  assert.equal(requests.length, 2, 'missing test credential makes no additional authenticated request');
});

test('registered Access D-06 requires real accessible names, not HTML form keys', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true });
  t.after(() => browser.close());
  for (const fixture of [
    { label: 'visible button text', html: '<button>Create session</button>', named: true },
    { label: 'ARIA name', html: '<button aria-label="Create session"></button>', named: true },
    { label: 'referenced name', html: '<span id="label">Create session</span><button aria-labelledby="label"></button>', named: true },
    { label: 'native label', html: '<label>Session name<input></label>', named: true },
    { label: 'password label', html: '<label>Credential<input type="password"></label>', named: true },
    { label: 'unnamed button', html: '<button></button>', named: false },
    { label: 'button HTML name is not a label', html: '<button name="createSession"></button>', named: false },
    { label: 'input HTML name is not a label', html: '<input name="sessionName">', named: false },
  ]) await t.test(fixture.label, async t => {
    const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(fixture.html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    let page; const stop = new Error('registered name validation completed');
    const ctx = {
      fixtures: { browser: () => ({ seed: {}, tenant: { tenantId: 'tenant-test' } }) }, migrate: async () => {}, npm: async () => {}, seed: async () => ({ exitCode: 0 }),
      startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }), defer: cleanup => t.after(cleanup),
      equal: (a, b, label) => assert.deepEqual(a, b, label),
      ok: (value, label) => { assert.ok(value, label); if (label === 'keyboard focus enters controls') throw stop; },
      loadChromium: async () => ({ launch: async () => ({ newPage: async options => { page = await browser.newPage(options); return page; }, close: () => page.context().close() }) }),
    };
    await assert.rejects(D_CASES.find(row => row.id === 'D-06').run(ctx), error => fixture.named ? error === stop : error.code === 'ERR_ASSERTION' && /control 0 named/.test(error.message));
  });
});
