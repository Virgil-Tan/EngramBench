import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { D_CASES } from '../evaluators/transfer/commercecommand/v2/cases/d.mjs';
import contract from '../contracts/transfer/commercecommand.mjs';

test('registered Commerce D-02 compares the reload response, not a later Worker snapshot', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  for (const [source, wrongDisplay] of [['detail', false], ['list', false], ['snapshot', false], ['detail', true]]) await t.test(`${source}: ${wrongDisplay ? 'wrong displayed state is rejected' : 'normal PAID to FULFILLED progression is accepted'}`, async () => {
    const orderId = '00000000-0000-4000-8000-000000000001';
    const tenantId = '00000000-0000-4000-8000-000000000002';
    const buyerId = '00000000-0000-4000-8000-000000000003';
    const order = { orderId, tenantId, buyerId, channel: 'WEB', currency: 'USD', state: 'PAYMENT_PENDING',
      orderTotalMinor: 0, capturedMinor: 0, refundedMinor: 0, quoteExpiresAt: '2030-01-01T01:00:00Z' };
    const snapshotFor = state => ({ asOf: '2030-01-01T00:00:00Z', work: [], events: [], resources: {
      ...Object.fromEntries(Object.keys(contract.schemas.VerificationSnapshot.properties.resources.properties).map(key => [key, []])),
      orders: [{ ...order, state }],
    } });
    const readPath = source === 'detail' ? `/api/v1/orders/${orderId}` : source === 'list' ? '/api/v1/orders' : '/api/v1/verification-snapshot';
    let captured = false, snapshots = 0, orderReads = 0, laterState = 'PAYMENT_PENDING';
    const html = `<select data-testid="tenant-select"><option value="${tenantId}">Tenant</option></select>
      <select data-testid="buyer-select"><option value="${buyerId}">Buyer</option></select>
      <button data-testid="product-physical-add">Physical</button><button data-testid="product-digital-add">Digital</button>
      <button data-testid="create-quote">Create quote</button><button data-testid="checkout">Checkout</button>
      <p data-testid="order-id">No order</p><p data-testid="order-state">No order</p><p data-testid="payment-state">UNKNOWN</p>
      <script>const show = order => {
        document.querySelector('[data-testid="order-id"]').textContent = order.orderId;
        document.querySelector('[data-testid="order-state"]').textContent = ${wrongDisplay} ? 'FULFILLING' : order.state;
      };
      document.querySelector('[data-testid="create-quote"]').onclick = async () => {
        const order = await fetch('/api/v1/orders/quotes', { method: 'POST' }).then(r => r.json());
        localStorage.setItem('orderId', order.orderId); show(order);
      };
      if (localStorage.getItem('orderId')) fetch('${readPath}').then(r => r.json()).then(body => {
        const order = ${source === 'detail' ? 'body' : source === 'list' ? 'body[0]' : 'body.resources.orders[0]'};
        setTimeout(() => show(order), 100);
      });</script>`;
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', request.url === '/' ? 'text/html' : 'application/json');
      if (request.url === '/') { response.end(html); return; }
      if (request.url === '/api/v1/orders/quotes') { response.end(JSON.stringify(order)); return; }
      if (request.url === '/api/v1/payment-provider/callbacks') { captured = true; response.end('{}'); return; }
      if (request.url === readPath) {
        assert(captured, 'GET only follows the actual capture callback'); orderReads++;
        const observed = { ...order, state: 'PAID' };
        response.end(JSON.stringify(source === 'detail' ? observed : source === 'list' ? [observed] : snapshotFor('PAID')));
        laterState = 'FULFILLED'; // Worker commits after the response observation.
        return;
      }
      response.statusCode = 404; response.end('{}');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let page;
    const ctx = {
      fixtures: { browser: () => ({ seed: {}, tenant: { tenantId }, buyer: { buyerId }, physical: { productId: 'physical' }, digital: { productId: 'digital' } }) },
      migrate: async () => {}, seed: async () => {}, npm: async () => {}, startWorker: async () => ({}), key: value => value,
      startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }), defer: () => {},
      mutate: async (base, path, _key, body) => {
        const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: response.status, json: await response.json() };
      },
      snapshot: async () => {
        snapshots++;
        if (snapshots === 1) return { resources: { orders: [order], paymentAttempts: [{ orderId, providerRequestId: 'provider-test' }] } };
        assert.equal(laterState, 'FULFILLED');
        return snapshotFor(laterState);
      },
      pass: value => ({ status: 'passed', ...value }),
      loadChromium: async () => ({ launch: async () => ({ newPage: async options => {
        page = await browser.newPage(options);
        const wait = page.waitForResponse.bind(page);
        page.waitForResponse = (predicate, options) => wait(predicate, { ...options, timeout: 1500 });
        return page;
      }, close: () => page?.context().close() }) }),
    };
    try {
      const run = () => D_CASES.find(row => row.id === 'D-02').run(ctx);
      if (wrongDisplay) await assert.rejects(run(), /browser state matches|visible text did not match/);
      else { assert.equal((await run()).status, 'passed'); assert.equal(snapshots, 2, 'later snapshot invariants still run'); }
      assert.equal(orderReads, 1, 'observe the real browser GET without inserting extra refreshes');
    } finally {
      await page?.context().close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  });
});
