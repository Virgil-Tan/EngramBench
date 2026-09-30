import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { D_CASES } from '../evaluators/transfer/creatorrightsexchange/v2/cases/d.mjs';
import { FINAL_RESOURCE_KEYS } from '../evaluators/transfer/creatorrightsexchange/v2/cases/helpers.mjs';

function ui(mode) {
  const display = mode === 'text' ? '<section><h3>Editions</h3><div role="status">No records.</div></section>'
    : mode === 'counts' ? '<section><h2>Committed state</h2><pre>{"counts":{"editions":0,"tenants":1}}</pre></section>'
    : mode === 'resource' ? '<label>Resource view<select><option value="tenants">tenants (1)</option><option value="editions">editions (0)</option></select></label><pre id="resource">{"resource":"tenants","total":1,"shown":1,"items":[{"tenantId":"tenant-test"}]}</pre>'
    : mode === 'unrelated' ? '<section><h3>Uploads</h3><div>No records.</div><pre>{"counts":{"uploads":0,"editions":1}}</pre></section>'
    : mode === 'hidden' ? '<pre hidden>{"counts":{"editions":0}}</pre>' : '<output>0</output>';
  return `<label>Admin token<input type="password" id="token"></label><button>Load snapshot</button><output id="pending">Ready</output><div id="view"></div><script>
    document.querySelector('button').onclick = async () => {
      document.querySelector('#pending').textContent = 'Loading committed state';
      const response = await fetch('/api/v1/verification-snapshot', { headers: { Authorization: 'Bearer ' + document.querySelector('#token').value } });
      await response.json();
      document.querySelector('#view').innerHTML = ${JSON.stringify(display)};
      document.querySelector('#pending').textContent = 'Loaded';
      const select = document.querySelector('select');
      if (select) select.onchange = () => document.querySelector('#resource').textContent = JSON.stringify({resource:select.value,total:select.value === 'editions' ? 0 : 1,shown:select.value === 'editions' ? 0 : 1,items:select.value === 'editions' ? [] : [{tenantId:'tenant-test'}]});
    };</script>`;
}

test('registered Creator D05 accepts resource-bound empty UI and rejects unrelated, arbitrary or hidden zeroes', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const mode of ['text', 'counts', 'resource', 'unrelated', 'arbitrary', 'hidden']) await t.test(mode, async t => {
    const state = { schemaVersion: 1, asOf: '2032-04-05T06:07:08Z', resources: Object.fromEntries(FINAL_RESOURCE_KEYS.map(name => [name, []])), work: [], events: [] };
    state.resources.tenants.push({ tenantId: 'tenant-test', name: 'Visible tenant' });
    const requests = [], pages = [], boundary = new Error('real D05 empty backend/UI observation reached');
    let backendChecked = false;
    const server = createServer((request, reply) => {
      if (request.url.startsWith('/api/v1/')) {
        requests.push(request.url);
        assert.equal(request.headers.authorization, 'Bearer regression-only-admin-token');
        reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(state));
      } else { reply.setHeader('Content-Type', 'text/html'); reply.end(ui(mode)); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const ctx = {
      fixtures: { base: () => ({ seed: {} }) }, migrate: async () => {}, seed: async () => {},
      startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
      at: () => state.asOf, key: label => label, sleep, adminToken: 'regression-only-admin-token',
      snapshot: async () => structuredClone(state),
      ok: (value, label) => {
        if (!value && label === 'visible action not found: /create.*tenant/i') {
          assert(backendChecked, 'both backend and visible empty state must precede the next business action');
          throw boundary;
        }
        assert.ok(value, label);
      },
      equal: (actual, expected, label) => { assert.deepEqual(actual, expected, label); if (label === 'empty backend matches UI') backendChecked = true; },
      assert: (_, operation) => operation(), defer: cleanup => t.after(cleanup),
      loadChromium: async () => ({ launch: async () => ({
        newPage: async options => { const page = await browser.newPage(options); pages.push(page); page.setDefaultTimeout(1000); return page; },
        close: () => Promise.all(pages.map(page => page.context().close())),
      }) }),
    };
    const expectedEmpty = ['text', 'counts', 'resource'].includes(mode);
    await assert.rejects(() => D_CASES.find(row => row.id === 'D-05').run(ctx), error => expectedEmpty ? error === boundary : error !== boundary && /empty|visible|timeout/i.test(error.message));
    assert.deepEqual(requests, ['/api/v1/verification-snapshot'], 'observe the actual delayed authenticated browser read');
    if (mode === 'resource') assert.equal(await pages[0].getByLabel('Resource view').inputValue(), 'editions', 'select the resource whose emptiness is asserted');
  });
});
