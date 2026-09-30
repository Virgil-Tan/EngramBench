import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { D_CASES } from '../evaluators/transfer/creatorrightsexchange/v2/cases/d.mjs';
import { FINAL_RESOURCE_KEYS } from '../evaluators/transfer/creatorrightsexchange/v2/cases/helpers.mjs';

const family = { tenant: { tenantId: 'tenant-test' }, offer: { offerId: 'offer-test' }, edition: { editionId: 'edition-test' }, seed: {} };
const empty = () => ({ schemaVersion: 1, asOf: '2032-04-05T06:07:08Z', resources: Object.fromEntries(FINAL_RESOURCE_KEYS.map(name => [name, []])), work: [], events: [] });

async function browserContext(t, browser, serve) {
  const server = createServer(serve);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const pages = [];
  const ctx = {
    fixtures: { purchase: () => family, base: () => family },
    migrate: async () => {}, seed: async () => {}, startWorker: async () => ({}),
    startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
    at: () => '2032-04-05T06:07:08Z', key: label => label, sleep, adminToken: 'regression-only-admin-token',
    ok: (value, label) => assert.ok(value, label), equal: (actual, expected, label) => assert.deepEqual(actual, expected, label),
    assert: (_, operation) => operation(), defer: cleanup => t.after(cleanup), pass: value => ({ status: 'passed', ...value }),
    loadChromium: async () => ({ launch: async () => ({
      newPage: async options => {
        const page = await browser.newPage(options); pages.push(page); page.setDefaultTimeout(1000);
        const wait = page.waitForResponse.bind(page);
        page.waitForResponse = (predicate, options) => wait(predicate, { ...options, timeout: 1000 });
        if (ctx.onPage) ctx.onPage(page);
        return page;
      }, close: () => Promise.all(pages.map(page => page.context().close())),
    }) }),
  };
  return { ctx, pages, server };
}

function purchasePage({ jsonEditor, consoleOnly, manualReads, snapshotOnly, hideUnknown, hideFence }, identities) {
  if (consoleOnly) return '<label>Endpoint<select><option>Create purchase</option></select></label><label>JSON body<textarea>{}</textarea></label><button>Send</button>';
  const input = (name, label, type = 'text') => `<label>${label}<input name="${name}" type="${type}" required></label>`;
  const risk = jsonEditor ? '<label>Risk context JSON<textarea name="riskContext">{"velocity":1,"country":"US","deviceTrust":"KNOWN"}</textarea></label>'
    : input('velocity', 'Velocity', 'number') + input('country', 'Country') + input('deviceTrust', 'Device trust');
  return `<form id="decoy">${input('tenantId', 'Tenant ID')}${input('offerId', 'Offer ID')}${input('providerRequestId', 'Provider request ID')}${input('licenseId', 'License ID')}${input('amountMinor', 'Amount minor', 'number')}${input('reason', 'Reason')}${input('purchaseOrderId', 'Purchase order ID')}<button type="button">${manualReads && !snapshotOnly ? 'Load purchase' : 'Load unrelated purchase'}</button></form>
    ${manualReads ? '<label>Admin token<input id="token" type="password"></label><button id="snapshot">Load snapshot</button>' : ''}
    ${manualReads && !snapshotOnly ? '<form id="license-view"><label>License ID<input name="licenseId"></label><button>Load license</button></form>' : ''}
    <form id="purchase">${input('tenantId', 'Tenant ID')}${input('offerId', 'Offer ID')}${input('buyerRef', 'Buyer reference')}${input('providerRequestId', 'Provider request ID')}${risk}${input('idempotencyKey', 'Idempotency Key')}<button>Create purchase</button></form>
    <form id="refund">${input('licenseId', 'License ID')}${input('amountMinor', 'Amount minor', 'number')}${input('reason', 'Reason')}${input('providerRequestId', 'Provider request ID')}${input('idempotencyKey', 'Idempotency Key')}<button>Create refund</button></form>
    <output>${manualReads ? '' : 'UNKNOWN REVOKED ' + identities.join(' ')}</output><script>
    const display = async response => {
      let text = await response.text();
      if (${Boolean(hideUnknown)}) text = text.replaceAll('UNKNOWN', 'settled');
      if (${Boolean(hideFence)}) text = text.replaceAll('REVOKED', 'ACTIVE');
      document.querySelector('output').textContent = text;
    };
    document.querySelector('#decoy button').onclick = async () => display(await fetch('/api/v1/purchases/' + document.querySelector('[name=purchaseOrderId]').value));
    if (document.querySelector('#license-view')) document.querySelector('#license-view').onsubmit = async event => { event.preventDefault(); await display(await fetch('/api/v1/licenses/' + new FormData(event.currentTarget).get('licenseId'))); };
    if (document.querySelector('#snapshot')) document.querySelector('#snapshot').onclick = async () => display(await fetch('/api/v1/verification-snapshot', { headers: { Authorization: 'Bearer ' + document.querySelector('#token').value } }));
    for (const form of document.querySelectorAll('#purchase, #refund')) form.onsubmit = async event => {
      event.preventDefault(); const data = Object.fromEntries(new FormData(form));
      const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': data.idempotencyKey }; delete data.idempotencyKey;
      let path = '/api/v1/purchases';
      if (form.id === 'purchase') {
        if (${jsonEditor}) data.riskContext = JSON.parse(data.riskContext);
        else { data.riskContext = { velocity: Number(data.velocity), country: data.country, deviceTrust: data.deviceTrust }; delete data.velocity; delete data.country; delete data.deviceTrust; }
      } else { path = '/api/v1/licenses/' + data.licenseId + '/refunds'; delete data.licenseId; data.amountMinor = Number(data.amountMinor); }
      const result = await fetch(path, { method: 'POST', headers, body: JSON.stringify(data) }).then(response => response.text());
      document.querySelector('output').textContent += ' ' + result;
    };</script>`;
}

test('registered Creator D03 scopes mutation controls, preserves risk values and rejects real business errors', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const options of [{ jsonEditor: true }, { jsonEditor: false }, { jsonEditor: true, manualReads: true }, { jsonEditor: true, manualReads: true, snapshotOnly: true }, { jsonEditor: true, manualReads: true, hideUnknown: true }, { jsonEditor: true, manualReads: true, hideFence: true }, { jsonEditor: true, rejected: true }, { consoleOnly: true }]) await t.test(JSON.stringify(options), async t => {
    const identities = [], traffic = [], reads = [], problems = [], state = empty();
    const { ctx, pages } = await browserContext(t, browser, async (request, reply) => {
      if (request.method === 'GET' && request.url.startsWith('/api/v1/')) {
        reads.push(request.url);
        let result;
        if (request.url === '/api/v1/verification-snapshot') {
          assert.equal(request.headers.authorization, 'Bearer regression-only-admin-token'); result = state;
        } else if (request.url.startsWith('/api/v1/purchases/')) {
          assert.equal(request.url, '/api/v1/purchases/purchase-test');
          result = { purchaseOrder: state.resources.purchaseOrders[0], paymentIntent: state.resources.paymentIntents[0] };
        } else {
          assert.equal(request.url, '/api/v1/licenses/license-test'); result = { license: state.resources.licenses[0] };
        }
        reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(result)); return;
      }
      if (request.method === 'GET') { reply.setHeader('Content-Type', 'text/html'); reply.end(purchasePage(options, identities)); return; }
      let text = ''; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text); traffic.push({ path: request.url, body });
      let result;
      try {
        assert(request.headers['idempotency-key']);
        if (request.url === '/api/v1/purchases') {
          assert.deepEqual(body, { tenantId: family.tenant.tenantId, offerId: family.offer.offerId, buyerRef: 'd03-buyer', providerRequestId: 'd03-provider', riskContext: { velocity: 1, country: 'US', deviceTrust: 'KNOWN' } });
          result = { purchaseOrderId: 'purchase-test' }; identities.push('purchase-test');
          state.resources.purchaseOrders.push(result);
        } else {
          const index = state.resources.refunds.length, amountMinor = index ? 6001 : 4000, label = index ? 'd03-full' : 'd03-partial';
          assert.equal(request.url, '/api/v1/licenses/license-test/refunds');
          assert.deepEqual(body, { amountMinor, reason: label.toUpperCase(), providerRequestId: `${label}-provider` });
          result = { refundId: `refund-${index + 1}`, state: 'PENDING' };
          state.resources.refunds.push(result); identities.push(result.refundId);
        }
      } catch (error) { problems.push(error); reply.statusCode = 400; result = { error: { code: 'INVALID_REQUEST' } }; }
      if (options.rejected) { reply.statusCode = 409; result = { error: { code: 'PURCHASE_CONFLICT' } }; }
      else if (!reply.statusCode || reply.statusCode === 200) reply.statusCode = 200;
      reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(result));
    });
    ctx.snapshot = async () => structuredClone(state);
    ctx.waitFor = async predicate => { const value = await predicate(); assert(value); return value; };
    ctx.request = async () => ({ status: 200, json: { allowed: true } });
    ctx.mutate = async (_, path, key, body) => {
      assert.equal(path, '/api/v1/provider/events');
      if (body.kind === 'PAYMENT' && body.outcome === 'UNKNOWN') state.resources.paymentIntents.push({ state: 'UNKNOWN' });
      if (body.kind === 'PAYMENT' && body.outcome === 'SUCCEEDED') {
        state.resources.licenses.push({ licenseId: 'license-test', purchaseOrderId: 'purchase-test' }); identities.push('license-test');
      }
      if (body.kind === 'REFUND') {
        state.resources.refunds.at(-1).state = 'SUCCEEDED';
        if (state.resources.refunds.length === 2) state.resources.entitlementGrants.push({ licenseId: 'license-test', state: 'REVOKED' });
      }
      return { status: 200, json: {} };
    };
    const run = () => D_CASES.find(row => row.id === 'D-03').run(ctx);
    if (options.consoleOnly) { await assert.rejects(run(), /visible action not found/); assert.equal(traffic.length, 0); }
    else if (options.rejected) await assert.rejects(run(), /browser checkout accepted/);
    else if (options.hideUnknown || options.hideFence) await assert.rejects(run(), options.hideUnknown ? /unknown\|pending/ : /revoked\|denied\|false/);
    else {
      assert.equal((await run()).status, 'passed'); assert.equal(traffic.length, 3);
      if (options.manualReads) {
        assert.equal(pages.length, 2);
        assert.deepEqual(reads, options.snapshotOnly ? Array(4).fill('/api/v1/verification-snapshot') : ['/api/v1/purchases/purchase-test', '/api/v1/licenses/license-test', '/api/v1/verification-snapshot', '/api/v1/verification-snapshot']);
      }
    }
    assert.deepEqual(problems, [], 'public mutation values must be valid before response assertions');
    if (!options.consoleOnly) for (const page of pages) assert.equal(await page.locator('#decoy input').first().inputValue(), '', 'unrelated fields untouched');
  });
});

test('registered Creator D05 observes a real delayed read, not a reload with no request', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const [pending, action] of [[true, 'Refresh snapshot'], [true, 'Load operational snapshot'], [false, 'Load snapshot']]) await t.test(`${action}: ${pending ? 'real pending UI' : 'missing pending still fails'}`, async t => {
    const requests = [], state = empty(), boundary = new Error('real loading reached the independent backend check');
    const { ctx } = await browserContext(t, browser, (request, reply) => {
      if (request.url.startsWith('/api/v1/')) {
        requests.push(request.url); assert.equal(request.headers.authorization, 'Bearer regression-only-admin-token');
        reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(state)); return;
      }
      reply.setHeader('Content-Type', 'text/html');
      reply.end(`<label>Admin token<input type="password" id="token"></label><button>${action}</button><output>Ready</output><script>
        document.querySelector('button').onclick = async () => {
          if (!document.querySelector('#token').value) return;
          ${pending ? "document.querySelector('output').textContent = 'Loading committed state';" : ''}
          await fetch('/api/v1/verification-snapshot', { headers: { Authorization: 'Bearer ' + document.querySelector('#token').value } });
          document.querySelector('output').textContent = '{"editions":[]}';
        };</script>`);
    });
    ctx.snapshot = async () => state;
    ctx.equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); assert.equal(label, 'empty backend matches UI'); throw boundary; };
    await assert.rejects(() => D_CASES.find(row => row.id === 'D-05').run(ctx), error => pending ? error === boundary : /loading\|pending/.test(error.message));
    assert.deepEqual(requests, ['/api/v1/verification-snapshot'], 'the browser must actually make the delayed read');
  });
});

test('registered Creator D05 validates the actual tenant form and preserves error, offline retry and restart assertions', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const options of [{ native: true }, { native: false }, { native: true, errorInButton: true }, { native: false, noFeedback: true }, { native: false, hiddenRequired: true }, { native: false, muteConflict: true }, { native: true, offlineNoPost: true }, { native: true, resourceView: true }, { native: true, resourceView: true, hideTenant: true }]) await t.test(JSON.stringify(options), async t => {
    const { native, noFeedback, hiddenRequired, muteConflict, errorInButton, offlineNoPost, resourceView, hideTenant } = options;
    const state = empty(), mutations = [];
    const { ctx, pages, server } = await browserContext(t, browser, async (request, reply) => {
      if (request.url === '/api/v1/verification-snapshot') {
        assert.equal(request.headers.authorization, 'Bearer regression-only-admin-token');
        reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(state)); return;
      }
      if (request.method === 'POST') {
        assert.equal(request.url, '/api/v1/tenants');
        let text = ''; for await (const chunk of request) text += chunk;
        const body = JSON.parse(text); mutations.push(body); assert.deepEqual(body, { name: 'D05 Tenant' });
        const tenant = { tenantId: 'created-tenant', name: body.name }; state.resources.tenants.push(tenant);
        reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(tenant)); return;
      }
      reply.setHeader('Content-Type', 'text/html');
      reply.end(`<form id="decoy"><label>Name<input value="Unrelated work"></label><button type="button">Retry upload</button></form>
        <label>Admin token<input type="password" id="token"></label><button id="snapshot">Load snapshot</button><pre></pre><output>Ready</output>
        ${resourceView ? '<label>Resource view<select><option value="blobObjects">blobObjects</option><option value="editions">editions</option><option value="tenants">tenants</option></select></label><pre id="resource"></pre>' : ''}
        <form id="tenant"><label>Name<input name="name" ${native ? 'required' : ''}></label>${hiddenRequired ? '<input style="display:none" required>' : ''}<button>Create tenant</button></form><script>
        const status = document.querySelector('output');
        let latestResources = {};
        const renderResource = () => {
          const key = document.querySelector('select').value, rows = latestResources[key] || [];
          document.querySelector('#resource').textContent = JSON.stringify({resource:key,total:rows.length,items:${Boolean(hideTenant)} && key === 'tenants' ? rows.map(row => ({name:row.name})) : rows});
        };
        if (document.querySelector('select')) document.querySelector('select').onchange = renderResource;
        document.querySelector('#snapshot').onclick = async () => {
          status.textContent = 'Loading snapshot';
          const response = await fetch('/api/v1/verification-snapshot', { headers: { Authorization: 'Bearer ' + document.querySelector('#token').value } });
          const value = await response.json(); latestResources = value.resources;
          document.querySelector('pre').textContent = JSON.stringify(${Boolean(resourceView)} ? {counts:Object.fromEntries(Object.entries(latestResources).map(([key,rows]) => [key,rows.length]))} : value);
          if (document.querySelector('select')) renderResource(); status.textContent = 'Loaded';
        };
        document.querySelector('#tenant').onsubmit = async event => {
          event.preventDefault(); const name = new FormData(event.currentTarget).get('name');
          if (!name) { if (!${Boolean(noFeedback)}) status.textContent = 'Name required'; return; }
          if (${Boolean(offlineNoPost)} && !navigator.onLine) { status.textContent = 'Network error'; return; }
          try {
            const response = await fetch('/api/v1/tenants', { method: 'POST', headers: {'Content-Type':'application/json'}, body:JSON.stringify({name}) });
            const value = await response.json(); status.textContent = response.ok ? JSON.stringify(value) : ${Boolean(muteConflict)} ? 'Saved' : value.error.message;
            document.querySelector('#tenant button').textContent = 'Create tenant';
          } catch { ${errorInButton ? "document.querySelector('#tenant button').textContent = 'Failed to fetch — Create tenant';" : "status.textContent = 'Network error';"} }
        };</script>`);
    });
    const port = server.address().port;
    ctx.onPage = page => {
      const getByText = page.getByText.bind(page);
      page.getByText = (...args) => {
        const locator = getByText(...args);
        if (args[0] === 'created-tenant') {
          const first = locator.first.bind(locator);
          locator.first = () => { const target = first(), wait = target.waitFor.bind(target); target.waitFor = options => wait({ ...options, timeout: 1000 }); return target; };
        }
        return locator;
      };
    };
    let stoppedNavigation;
    ctx.startApi = async () => {
      if (!server.listening) {
        await stoppedNavigation; await pages[0].waitForLoadState('load');
        await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
      }
      return { baseUrl: `http://127.0.0.1:${port}`, port, logs: '' };
    };
    ctx.stop = async () => { stoppedNavigation = pages[0].waitForEvent('framenavigated'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
    ctx.snapshot = async () => structuredClone(state);
    const run = () => D_CASES.find(row => row.id === 'D-05').run(ctx);
    if (hideTenant) {
      await assert.rejects(run(), /created-tenant/);
      assert.deepEqual(mutations, [{ name: 'D05 Tenant' }], 'missing rendered identity cannot pass on persistence alone');
      assert.equal(await pages[0].getByRole('combobox', {name:'Resource view'}).inputValue(), 'tenants');
    } else if (noFeedback || hiddenRequired || muteConflict || offlineNoPost) {
      await assert.rejects(run(), offlineNoPost ? /requestfailed/ : muteConflict ? /stale\|conflict\|revision/ : /required\|invalid\|error/);
      assert.deepEqual(mutations, []);
    } else {
      assert.equal((await run()).status, 'passed');
      assert.deepEqual(mutations, [{ name: 'D05 Tenant' }], 'invalid, conflict, permission and offline attempts have no persisted POST');
      if (resourceView) assert.equal(await pages[0].getByRole('combobox', {name:'Resource view'}).inputValue(), 'tenants');
    }
    assert.equal(await pages[0].locator('#decoy input').inputValue(), 'Unrelated work');
  });
});
