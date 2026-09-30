import test from 'node:test';
import assert from 'node:assert/strict';
import { E_CASES } from '../evaluators/transfer/commercecommand/v2/cases/e.mjs';
import { createFixtureFactory } from '../evaluators/transfer/commercecommand/v2/fixtures/index.mjs';
import contract from '../contracts/transfer/commercecommand.mjs';
import { matchOperation, requestValidator } from '../templates/contract-first/runtime.mjs';

const checkRequest = requestValidator(contract);
const actual = E_CASES.find(row => row.id === 'E-10');

async function preparation({ count, missing = false, duplicate = false, rejectCallback = false }) {
  const factory = createFixtureFactory({ evaluationSeed: 'e10-preparation', caseId: 'E-10', baseTime: '2030-01-01T00:00:00Z' });
  const fixture = factory.entitlement(), orders = [], byOrder = new Map(), byProvider = new Map(), callbacks = [], limits = [];
  const reachedWorkers = new Error('original Worker-start boundary reached');
  let quotes = 0, checkouts = 0, snapshots = 0, workers = 0, apis = 0;
  const ctx = {
    fixtures: { ...factory, performance: () => ({ scenarios: { entitlementStorm: { ...factory.performance().scenarios.entitlementStorm, lines: count } } }) },
    key: factory.key, mark: () => {}, migrate: async () => {}, seed: async seed => {
      for (const key of ['orders', 'orderLines', 'paymentAttempts', 'entitlementGrants', 'ledgerEntries']) assert.equal(seed[key].length, 0, 'preparation cannot seed business effects');
    },
    startApi: async () => ({ baseUrl: `http://api-${apis++}` }),
    startWorker: async () => { workers++; throw reachedWorkers; },
    concurrent: async (values, limit, operation) => {
      limits.push(limit); const results = new Array(values.length); let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
        while (cursor < values.length) { const index = cursor++; results[index] = await operation(values[index], index); }
      }));
      return results;
    },
    mutate: async (base, path, key, body) => {
      const route = matchOperation(contract.operations, 'POST', path);
      assert(route, 'use a real public mutation');
      const checked = checkRequest(route.operation, { params: route.params, body, hasBody: true,
        headers: { 'content-type': 'application/json', 'idempotency-key': key } });
      assert(checked.valid, JSON.stringify(checked));
      if (path === '/api/v1/orders/quotes') {
        const index = quotes++;
        assert.equal(base, `http://api-${index % 2}`);
        assert.deepEqual(body.lines, [{ productId: fixture.digital.productId, quantity: 1 }]);
        const order = { orderId: factory.uuid(`order:${index}`), orderTotalMinor: 1000 + index, index };
        orders.push(order); byOrder.set(order.orderId, order);
        return { status: 201, json: { orderId: order.orderId } };
      }
      if (path.endsWith('/checkout')) {
        checkouts++;
        const order = byOrder.get(route.params.orderId);
        assert(order); assert.equal(base, `http://api-${order.index % 2}`);
        byProvider.set(body.providerRequestId, order);
        return { status: 200, json: {} };
      }
      assert.equal(path, '/api/v1/payment-provider/callbacks');
      const order = byProvider.get(body.providerRequestId);
      assert(order, 'callback must retain its actual checkout provider identity');
      assert.equal(base, `http://api-${order.index % 2}`);
      assert.equal(body.outcome, 'CAPTURED');
      assert.equal(body.capturedMinor, order.orderTotalMinor, 'callback uses this exact Order snapshot amount, never a fixture constant or another Order');
      callbacks.push({ ...body });
      return { status: rejectCallback ? 409 : 200, json: {} };
    },
    snapshot: async base => {
      snapshots++;
      assert.equal(base, 'http://api-0');
      assert.equal(quotes, count, 'take the full snapshot only after all quotes');
      assert.equal(checkouts, count, 'take the full snapshot only after all checkouts');
      assert.equal(callbacks.length, 0, 'snapshot amounts precede provider callbacks');
      let rows = orders.map(({ index, ...order }) => order).reverse();
      if (missing) rows = rows.slice(1);
      if (duplicate) rows.push({ ...rows[0] });
      return { resources: { orders: rows } };
    },
  };
  let failure;
  try { await actual.run(ctx); } catch (error) { failure = error; }
  if (missing) assert.match(failure?.message ?? '', /captured Order precondition/);
  else if (duplicate) assert.match(failure?.message ?? '', /duplicate|unique/i);
  else if (rejectCallback) assert.match(failure?.message ?? '', /callback .* returned 409/);
  else {
    assert.equal(failure, reachedWorkers);
    assert.equal(callbacks.length, count); assert.equal(workers, 4);
    assert.equal(new Set(callbacks.map(row => row.providerRequestId)).size, count);
  }
  assert.equal(snapshots, 1, 'N Orders require one preparation snapshot, not N growing snapshots');
  assert.equal(quotes, count); assert.equal(checkouts, count); assert.equal(apis, 2);
  assert(limits.every(limit => limit === 64), 'both mutation phases retain concurrency 64');
  if (missing || duplicate) { assert.equal(callbacks.length, 0); assert.equal(workers, 0); }
}

test('registered E-10 preparation preserves all 20,000 real operation paths with one full snapshot', async () => {
  const spec = createFixtureFactory({ evaluationSeed: 'fixed', caseId: 'E-10', baseTime: '2030-01-01T00:00:00Z' }).performance().scenarios.entitlementStorm;
  assert.deepEqual(spec, { lines: 20_000, clients: 64, measureMs: 60_000, minimumThroughput: 150, maximumP95: 500 });
  await preparation({ count: 20_000 });
});

test('registered E-10 cannot hide missing Orders, duplicate identities or rejected captures', async t => {
  for (const options of [{ missing: true }, { duplicate: true }, { rejectCallback: true }]) {
    await t.test(JSON.stringify(options), () => preparation({ count: 65, ...options }));
  }
});

test('registered E-10 indexes grant observations with first-match semantics and still rejects an active refunded grant', async t => {
  for (const activeRefunded of [false, true]) await t.test(String(activeRefunded), async t => {
    const count = 65;
    const factory = createFixtureFactory({ evaluationSeed: 'e10-observation', caseId: 'E-10', baseTime: '2030-01-01T00:00:00Z' });
    const fixture = factory.entitlement();
    const orders = Array.from({ length: count }, (_, index) => ({ orderId: factory.uuid(`order:${index}`), tenantId: fixture.tenant.tenantId,
      buyerId: fixture.buyer.buyerId, channel: 'WEB', currency: 'USD', state: 'REFUNDED', orderTotalMinor: 770, capturedMinor: 770,
      refundedMinor: 770, quoteExpiresAt: factory.at({ hours: 1 }) }));
    const lines = orders.map((order, index) => ({ orderLineId: factory.uuid(`line:${index}`), orderId: order.orderId,
      tenantId: fixture.tenant.tenantId, productId: fixture.digital.productId, offerVersionId: fixture.digitalOffer.offerVersionId,
      quantity: 1, currency: 'USD', unitPriceMinor: 700, taxMinor: 70, lineTotalMinor: 770, fulfillmentKind: 'DIGITAL' }));
    const grants = lines.map((line, index) => ({ entitlementGrantId: factory.uuid(`grant:${index}`), tenantId: fixture.tenant.tenantId,
      orderId: line.orderId, orderLineId: line.orderLineId, grantRevision: 1, state: activeRefunded && index === 0 ? 'ACTIVE' : 'REVOKED' }));
    let matchingReads = 0, finalReads = 0, countFinalReads = true;
    const observedLines = [...lines, { ...lines[1], orderId: orders[0].orderId }].map(line => ({ ...line,
      get orderLineId() { matchingReads++; return line.orderLineId; } }));
    const final = { asOf: factory.at(), work: [], events: [], resources: {
      ...Object.fromEntries(Object.keys(contract.schemas.VerificationSnapshot.properties.resources.properties).map(key => [key, []])),
      orders,
      orderLines: lines.map(line => ({ ...line, get orderId() { if (countFinalReads) finalReads++; return line.orderId; } })),
      entitlementGrants: grants.map(grant => ({ ...grant, get orderLineId() { if (countFinalReads) finalReads++; return grant.orderLineId; } })),
    } };
    // Stop counting when the independent core/schema oracle begins; it is not
    // part of this case-local indexing repair and remains completely unchanged.
    Object.defineProperty(final.resources, 'inventoryPools', { enumerable: true, get() { countFinalReads = false; return []; } });
    let snapshots = 0, quoted = 0, clock = 0, revocations = 0;
    t.mock.method(performance, 'now', () => ++clock);
    const ctx = {
      fixtures: { ...factory, performance: () => ({ scenarios: { entitlementStorm: { lines: count, clients: 1, measureMs: 20, minimumThroughput: 150, maximumP95: 500 } } }) },
      key: factory.key, mark: () => {}, migrate: async () => {}, seed: async () => {},
      startApi: async () => ({ baseUrl: 'http://api' }), startWorker: async () => ({}),
      concurrent: async (values, _limit, operation) => Promise.all(values.map(operation)),
      mutate: async (_base, path) => {
        if (path === '/api/v1/orders/quotes') return { status: 201, json: { orderId: orders[quoted++].orderId } };
        if (path.endsWith('/revoke')) {
          const grant = grants.find(row => path === `/api/v1/entitlement-grants/${row.entitlementGrantId}/revoke`);
          assert(grant, 'the first matching OrderLine, not its later duplicate, binds each grant'); revocations++;
        }
        return { status: 200, json: {} };
      },
      snapshot: async () => {
        if (++snapshots === 1) return { resources: { orders } };
        if (snapshots === 2) return { resources: { orderLines: observedLines, entitlementGrants: grants.map(row => ({ ...row, state: 'ACTIVE' })) } };
        return final;
      },
      waitFor: async operation => { const value = await operation(); assert(value); return value; },
      pass: value => ({ status: 'passed', ...value }),
    };
    if (activeRefunded) await assert.rejects(() => actual.run(ctx), /fully refunded line has no ACTIVE grant/);
    else {
      assert.equal((await actual.run(ctx)).status, 'passed');
      assert.deepEqual({ grantAssociation: matchingReads < count * 3, refundedLines: finalReads < count * 4 },
        { grantAssociation: true, refundedLines: true }, `linear observations: ${matchingReads} association / ${finalReads} refund field reads`);
    }
    assert(revocations > 0, 'real measured branch exercised the observed grant association');
  });
});
