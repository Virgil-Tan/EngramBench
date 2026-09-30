import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { assertNoSecrets } from '../evaluators/transfer/commercecommand/v2/oracles/index.mjs';
import { D_CASES } from '../evaluators/transfer/commercecommand/v2/cases/d.mjs';

const admin = 'synthetic-admin-value-37c94e';
const barrier = 'synthetic-barrier-value-65ad23';

test('Commerce secret checks permit public names but still reject actual protected values', async t => {
  for (const value of [
    '<label>ADMIN_TOKEN<input value=""></label>',
    'const headers = { Authorization: "Bearer " + adminToken };',
    { authorization: 'Bearer <redacted>', adminToken: '', providerSecret: null, 'provider-credential': '[redacted]' },
  ]) await t.test('legal protocol names are not secret material', () => {
    assert.equal(assertNoSecrets(value, [admin, barrier]), true);
  });
  for (const [label, value] of [
    ['admin in HTML', `<p>${admin}</p>`],
    ['admin in source', `const value = "${admin}";`],
    ['barrier in logs', `request failed: ${barrier}`],
    ['secret under an unrelated JSON field', { nested: { value: admin } }],
  ]) await t.test(label, () => {
    assert.throws(() => assertNoSecrets(value, [admin, barrier]), error => {
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.match(error.message, /public evidence does not expose secret material/);
      assert.equal(error.message.includes(admin) || error.message.includes(barrier), false, 'diagnostic does not repeat the leaked value');
      return true;
    });
  });
  assert.equal(assertNoSecrets('ordinary output', ['', undefined, null]), true);
});

test('registered Commerce D-05 checks actual HTML and bundle values, not their public identifiers', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const leak of [null, 'html', 'bundle']) await t.test(leak ?? 'legal names only', async () => {
    const reachedOffline = new Error('actual D-05 HTML and asset checks completed');
    const html = '<label>Tenant<select data-testid="tenant-select"><option value="primary">Primary</option></select></label>'
      + '<label>Buyer<select data-testid="buyer-select"><option>Buyer</option></select></label>'
      + '<button data-testid="product-physical-add">Add product</button><button data-testid="create-quote">Create quote</button>'
      + '<label>ADMIN_TOKEN<input type="password" value=""></label>'
      + `<p>${leak === 'html' ? admin : 'Ready'}</p><script src="/app.js"></script>`;
    const bundle = 'window.publicHeaderNames = ["Authorization", "adminToken", "provider-secret", "providerCredential"];'
      + (leak === 'bundle' ? `window.value = "${admin}";` : '');
    let inspectedAssets = 0, page;
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/app.js' ? 'text/javascript' : 'text/html');
      response.end(request.url === '/app.js' ? bundle : html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const ctx = {
      adminToken: admin,
      fixtures: { browser: () => ({ seed: {}, tenant: { tenantId: 'primary' }, physical: { productId: 'physical' } }) },
      migrate: async () => {}, seed: async () => {}, npm: async () => {}, defer: () => {},
      startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
      request: async (base, path) => {
        assert.equal(path, '/app.js'); inspectedAssets++;
        const response = await fetch(base + path);
        return { status: response.status, text: await response.text() };
      },
      loadChromium: async () => ({ launch: async () => ({ newPage: async options => {
        page = await browser.newPage(options);
        page.context().setOffline = async () => { throw reachedOffline; };
        return page;
      }, close: () => page?.context().close() }) }),
    };
    try {
      await assert.rejects(() => D_CASES.find(row => row.id === 'D-05').run(ctx), error => leak
        ? error.code === 'ERR_ASSERTION' && /public evidence does not expose secret material/.test(error.message)
        : error === reachedOffline);
      assert.equal(inspectedAssets, leak === 'html' ? 0 : 1, 'the registered case inspects the expected real surfaces');
    } finally {
      await page?.context().close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  });
});
