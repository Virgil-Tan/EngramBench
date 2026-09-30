import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { candidateAssert, executeCase } from '../evaluators/transfer/commercecommand/v2/lib/execution.mjs';
import { A_CASES } from '../evaluators/transfer/commercecommand/v2/cases/a.mjs';
import { B_CASES } from '../evaluators/transfer/commercecommand/v2/cases/b.mjs';
import { D_CASES } from '../evaluators/transfer/commercecommand/v2/cases/d.mjs';
import { createFixtureFactory } from '../evaluators/transfer/commercecommand/v2/fixtures/index.mjs';
import contract from '../contracts/transfer/commercecommand.mjs';
import { requestValidator, matchOperation } from '../templates/contract-first/runtime.mjs';
import { successful, semanticError, semanticReplay, assertLoad, quote, capture, guardedCase } from '../evaluators/transfer/commercecommand/v2/cases/helpers.mjs';
import { assertSettlement, waterfall } from '../evaluators/transfer/commercecommand/v2/oracles/economic-policy.mjs';
import { quoteOracle } from '../evaluators/transfer/commercecommand/v2/oracles/index.mjs';
import { heldWorker } from '../evaluators/transfer/commercecommand/v2/cases/recovery.mjs';

const response = (status = 200, json = {}) => ({ status, json, text: JSON.stringify(json) });
const run = (operation, ctx = {}, id = 'A-04') => executeCase({
  definition: { id, dimension: id[0], weight: 1 }, implementation: { run: operation },
  withContext: async (_, fn) => fn(ctx), contextOptions: {}, failureCodePrefix: 'CC_',
});
const errorBody = { error: { code: 'STALE_FENCE', message: 'stale', details: {} } };
const limits = { minimumThroughput: 250, maximumP95: 500, acceptedStatuses: [200] };
const measured = { statuses: { 200: 623 }, completed: 623, throughput: 62.3, p95: 10 };
const settlement = { state: 'CLOSED', allocationIds: [], grossMinor: 0, feeMinor: 0,
  refundReserveMinor: 0, disputeReserveMinor: 0, netMinor: 0 };

test('real Commerce response, settlement and load assertions attribute candidate mismatches', async t => {
  const checks = [
    ['HTTP status', () => successful(response(500)), /returned 500/],
    ['HTTP body', () => successful({ status: 200 }), /returns JSON/],
    ['semantic status', () => semanticError(response(200, errorBody), 409, 'STALE_FENCE'), /STALE_FENCE status/],
    ['semantic envelope', () => semanticError(response(409, { ...errorBody, extra: true }), 409, 'STALE_FENCE'), /envelope/],
    ['semantic code', () => semanticError(response(409, errorBody), 409, 'INVALID_ORDER_STATE'), /STALE_FENCE/],
    ['replay status', () => semanticReplay(response(201), response(200)), /replayed status/],
    ['replay body', () => semanticReplay(response(200, { count: 1 }), response(200, { count: 2 })), /replayed semantic response/],
    ['settlement', () => assertSettlement({ ...settlement, refundReserveMinor: 101 }, settlement), /closed settlement refundReserveMinor/],
    ['throughput', () => assertLoad(measured, limits), /throughput 62.3 >= 250/],
    ['latency', () => assertLoad({ ...measured, throughput: 250, p95: 501 }, limits), /p95 501 <= 500/],
    ['load status', () => assertLoad({ ...measured, statuses: { 500: 623 } }, limits), /contract-valid statuses/],
    ['empty load', () => assertLoad({ ...measured, statuses: {}, completed: 0 }, limits), /load completed operations/],
  ];
  for (const [label, check, message] of checks) await t.test(label, async () => {
    const result = await run(check);
    assert.equal(result.status, 'failed');
    assert.equal(result.privateFailureCode, 'CC_ASSERTION_FAILED');
    assert.match(result.privateMessage, message);
    assert.equal(result.privateErrorDetails[0].code, 'ERR_ASSERTION');
    assert.equal(result.privateErrorDetails[0].origin, 'candidate');
  });
});

test('actual Commerce quote and capture helpers classify missing candidate identities', async () => {
  const fixture = { seed: {} };
  const ctx = { fixtures: { quoteBody: () => ({}) }, key: label => label,
    mutate: async () => response(201, {}), snapshot: async () => ({ resources: { orders: [] } }) };
  assert.equal((await run(() => quote(ctx, 'http://test', fixture))).status, 'failed');
  ctx.mutate = async (_, path) => response(path.endsWith('/quotes') ? 201 : 200,
    path.endsWith('/quotes') ? { orderId: '00000000-0000-4000-8000-000000000001' } : {});
  assert.equal((await run(() => capture(ctx, 'http://test', fixture))).status, 'failed');
});

function checkoutContext(snapshot) {
  const orderId = '00000000-0000-4000-8000-000000000001';
  return {
    fixtures: { payment: () => ({ seed: {} }), quoteBody: () => ({}) },
    migrate: async () => {}, seed: async () => {}, mark: () => {},
    startApi: async () => ({ baseUrl: 'http://test' }), key: label => label,
    mutate: async (_, path) => response(path.endsWith('/quotes') ? 201 : 200,
      path.endsWith('/quotes') ? { orderId } : {}),
    snapshot: async () => snapshot ?? ({ resources: { paymentAttempts:
      Array.from({ length: 9 }, (_, i) => ({ orderId, paymentAttemptId: `attempt-${i}` })) } }),
  };
}

test('real registered A-08 rejects duplicate PaymentAttempts as failed with original hard cap', async () => {
  const actual = A_CASES.find(item => item.id === 'A-08');
  const result = await run(actual.run, checkoutContext(), actual.id);
  assert.equal(result.status, 'failed');
  assert.match(result.privateMessage, /one PaymentAttempt\/provider operation/);
  assert.deepEqual(result.hardCapIds, ['IDEMPOTENCY_PROVIDER_IDENTITY']);
});

test('six real registered Commerce cases attribute verified public business outputs, not fixtures', async t => {
  const checkRequest = requestValidator(contract);
  for (const [id, message] of [
    ['A-05', /3 !== 2/], ['A-10', /plan exposes the actual current claim fence/],
    ['A-13', /quote and capture Events retained/], ['A-14', /first allocation set is immutable/],
    ['B-05', /same key one status authority/], ['B-09', /one distinct allocation set wins/],
  ]) await t.test(id, async () => {
    const fixtures = createFixtureFactory({ evaluationSeed: 'candidate-classification', caseId: id, baseTime: '2030-01-01T00:00:00Z' });
    const fixture = fixtures.marketplace(), orderId = fixtures.uuid('order'), planId = fixtures.uuid('plan');
    const line = { orderId, orderLineId: fixtures.uuid('line'), quantity: 2, lineTotalMinor: 2640 };
    const order = { orderId, orderTotalMinor: 2640 };
    const plan = { fulfillmentPlanId: planId, orderId, state: 'PENDING', lines: [], fencingToken: 0 };
    const work = { workId: fixtures.uuid('work'), kind: 'FULFILLMENT', aggregateId: planId, state: 'LEASED', terminal: false,
      attempts: 1, fencingToken: 1, leaseOwner: 'worker', leaseExpiresAt: '2030-01-01T01:00:00Z' };
    let calls = 0, snapshots = 0, allocations;
    const ctx = {
      fixtures, key: fixtures.key, migrate: async () => {}, seed: async () => {}, mark: () => {},
      startApi: async () => ({ baseUrl: 'http://test' }), startWorker: async () => ({}),
      concurrent: async (items, _limit, operation) => Promise.all(items.map(operation)),
      request: async (_base, path) => {
        assert.equal(id, 'A-05');
        assert.equal(path, `/api/v1/products?tenantId=${fixture.tenant.tenantId}`);
        assert.equal(fixture.seed.products.filter(row => row.tenantId === fixture.tenant.tenantId).length, 2);
        return response(200, fixture.seed.products);
      },
      mutate: async (_base, path, key, body) => {
        const route = matchOperation(contract.operations, 'POST', path);
        assert(route, 'case requests an actual published operation');
        const checked = checkRequest(route.operation, { params: route.params, body, hasBody: true,
          headers: { 'content-type': 'application/json', 'idempotency-key': key } });
        assert(checked.valid, JSON.stringify(checked));
        if (id === 'B-05') return response(calls++ === 0 ? 201 : 409);
        if (path.endsWith('/quotes')) return response(201, { orderId });
        if (id === 'A-14' && path.endsWith('/seller-allocations')) {
          assert.equal(body.allocations.reduce((sum, row) => sum + row.quantity, 0), line.quantity);
          assert.equal(body.allocations.reduce((sum, row) => sum + row.amountMinor, 0), line.lineTotalMinor);
          allocations ??= body.allocations.map((row, index) => ({ ...row, tenantId: fixture.tenant.tenantId, orderId,
            sellerAllocationId: fixtures.uuid(`allocation-${index}`) }));
          return response(200, allocations);
        }
        if (id === 'B-09') {
          assert.equal(body.allocations.reduce((sum, row) => sum + row.quantity, 0), line.quantity);
          assert.equal(body.allocations.reduce((sum, row) => sum + row.amountMinor, 0), line.lineTotalMinor);
        }
        return response();
      },
      snapshot: async () => {
        snapshots++;
        if (id === 'A-14') return { resources: { orderLines: [line], sellerAllocations: allocations } };
        if (id === 'B-09') return { resources: { orderLines: [line] } };
        if (snapshots === 1) return { resources: { orders: [order] } };
        if (id === 'A-10') return { resources: { fulfillmentPlans: [plan] }, work: [work] };
        assert.equal(id, 'A-13');
        return { asOf: '2030-01-01T00:00:00Z', events: [], work: [],
          resources: Object.fromEntries(Object.keys(contract.schemas.VerificationSnapshot.properties.resources.properties).map(key => [key, []])) };
      },
      barrier: async options => {
        const json = { role: 'worker', point: 'worker.claimed', workId: work.workId, kind: work.kind,
          aggregateId: work.aggregateId, attempt: work.attempts, fencingToken: work.fencingToken };
        const entry = { json };
        assert.equal(options.hold(json, entry), true);
        return { waitFor: async predicate => { assert(predicate(entry)); return entry; } };
      },
    };
    const actual = [...A_CASES, ...B_CASES].find(item => item.id === id);
    const result = await run(actual.run, ctx, id);
    assert.match(result.privateMessage, message, 'must reach the intended actual case assertion');
    assert.equal(result.status, 'failed');
    assert.equal(result.privateErrorDetails[0].origin, 'candidate');
  });
});

test('valid candidate checks keep their existing return values and do not rewrite data', async () => {
  const ok = response(201, { id: 1 }), actual = structuredClone(settlement);
  assert.equal(successful(ok, 'create', [201]), ok);
  assert.equal(semanticError(response(409, errorBody), 409, 'STALE_FENCE'), undefined);
  assert.equal(semanticReplay(ok, structuredClone(ok)), undefined);
  assert.equal(assertSettlement(actual, settlement), undefined);
  assert.deepEqual(actual, settlement);
  assert.equal(assertLoad({ ...measured, throughput: 250 }, limits), undefined);
});

test('author oracle/setup invariants, dependency failures and unexpected exceptions stay evaluator errors', async t => {
  const authorFailure = Object.assign(new assert.AssertionError({ message: 'dependency ledger precondition' }), { origin: 'evaluator' });
  const checks = [
    ['oracle fixture', () => quoteOracle([{ productId: 'missing', quantity: 1 }], new Map())],
    ['oracle arithmetic', () => waterfall(-1, [])],
    ['worker setup', () => heldWorker({}, 'FULFILLMENT', { leaseSeconds: 0 })],
    ['guarded author assertion', guardedCase('A-08', [], async () => assert.fail('fixture invariant')).run],
    ['dependency origin', guardedCase('A-08', [], async () => { throw authorFailure; }).run],
    ['helper argument error', () => successful(response(), 'invalid author argument', {})],
    ['undefined settlement', () => assertSettlement(undefined, settlement)],
  ];
  for (const [label, check] of checks) await t.test(label, async () => {
    assert.equal((await run(check)).status, 'evaluator_error');
  });
  const ctx = checkoutContext();
  ctx.snapshot = async () => { throw new TypeError('broken snapshot helper'); };
  const result = await run(A_CASES.find(item => item.id === 'A-08').run, ctx, 'A-08');
  assert.equal(result.status, 'evaluator_error');
  assert.match(result.privateMessage, /broken snapshot helper/);
});

test('Commerce assertions also work with a real shared-module copy lacking candidateAssert', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'commerce-legacy-assertions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await readFile(new URL('../src/task-evaluator-v2/execution.mjs', import.meta.url), 'utf8');
  const legacy = source.replace('export const candidateAssert =', 'const candidateAssert =');
  assert.notEqual(legacy, source, 'remove only the modern named export, keeping the real classifier');
  await writeFile(join(directory, 'execution.mjs'), legacy);
  assert.equal(Object.hasOwn(await import(pathToFileURL(join(directory, 'execution.mjs'))), 'candidateAssert'), false);
  const env = { ...process.env,
    FRONTAL_V2_SHARED_ROOT_URL: pathToFileURL(directory + '/').href,
    FRONTAL_V2_SHARED_RUNTIME_URL: new URL('../src/task-evaluator-v2/runtime.mjs', import.meta.url).href,
  };
  delete env.NODE_TEST_CONTEXT; // The child is a separate test runner, not this runner's IPC worker.
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-reporter=tap',
    '--test-name-pattern=^(real Commerce response|actual Commerce quote|real registered A-08|six real registered|valid candidate checks|author oracle/setup)',
    fileURLToPath(import.meta.url)], { env });
  assert.match(stdout, /(?:#|ℹ) fail 0/);
});

test('author oracle/setup errors remain protected through the candidate assertion wrapper', async () => {
  for (const origin of ['evaluator', 'infrastructure']) {
    const cause = Object.assign(new Error('author-owned failure'), { origin });
    const wrapped = new assert.AssertionError({ message: 'wrapped author precondition' });
    wrapped.cause = cause;
    for (const actual of [cause, wrapped]) {
      const result = await run(() => candidateAssert.equal(actual, 0));
      assert.equal(result.status, 'evaluator_error');
      assert.notEqual(result.privateErrorDetails[0].origin, 'candidate');
    }
  }
});

test('real D-05 accepts standard accessible labels but not unnamed controls', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const reachedKeyboard = new Error('all actual D-05 control names checked');
  const variants = [
    ['nested label', '<label>Tenant<select data-testid="tenant-select"></select></label>'],
    ['label for', '<label for="tenant">Tenant</label><select id="tenant" data-testid="tenant-select"></select>'],
    ['aria labelledby', '<span id="tenant-name">Tenant</span><select aria-labelledby="tenant-name" data-testid="tenant-select"></select>'],
    ['aria label', '<select aria-label="Tenant" data-testid="tenant-select"></select>'],
    ['unnamed empty', '<select data-testid="tenant-select"></select>', true],
    ['option text is not a label', '<select data-testid="tenant-select"><option>Tenant</option></select>', true],
    ['missing label reference', '<select aria-labelledby="missing" data-testid="tenant-select"></select>', true],
    ['default foreign tenant', '<label>Tenant<select data-testid="tenant-select"><option value="foreign">Foreign</option><option value="primary">Primary</option></select></label>'],
  ];
  for (const [name, tenant, invalid] of variants) await t.test(name, async t => {
    const defaultForeign = name === 'default foreign tenant';
    const html = tenant.replaceAll('</select>', '<option value="primary"></option></select>')
      + '<label>Buyer<select data-testid="buyer-select"></select></label>'
      + `<button data-testid="product-${defaultForeign ? 'foreign' : 'physical'}-add">Add product</button><button data-testid="create-quote">Create quote</button>`
      + (defaultForeign ? `<script>document.querySelector('[data-testid="tenant-select"]').onchange = event => {
        if (event.target.value === 'primary') setTimeout(() => {
          document.querySelector('[data-testid="product-foreign-add"]').dataset.testid = 'product-physical-add';
        }, 100);
      };</script>` : '');
    const server = createServer((_, response) => { response.setHeader('Content-Type', 'text/html'); response.end(html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const ctx = {
      fixtures: { browser: () => ({ seed: {}, tenant: { tenantId: 'primary' }, physical: { productId: 'physical' } }) },
      migrate: async () => {}, seed: async () => {}, npm: async () => {},
      startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
      defer: cleanup => t.after(cleanup),
      loadChromium: async () => ({ launch: async options => {
        const browser = await chromium.launch({ ...options, executablePath: process.env.FRONTAL_TEST_CHROMIUM, args: ['--no-sandbox'] });
        const newPage = browser.newPage.bind(browser);
        browser.newPage = async settings => {
          const page = await newPage(settings);
          page.keyboard.press = async () => { throw reachedKeyboard; };
          return page;
        };
        return browser;
      } }),
    };
    await assert.rejects(D_CASES.find(item => item.id === 'D-05').run(ctx), error => invalid
      ? error.code === 'ERR_ASSERTION' && /tenant-select has an accessible name/.test(error.message)
      : error === reachedKeyboard);
  });
});

test('real D-02 waits for an asynchronously rendered Order ID and still rejects invalid IDs', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const reachedSnapshot = new Error('real browser quote and checkout reached snapshot');
  const orderId = '00000000-0000-4000-8000-000000000001';
  let returnedOrderId = orderId;
  const html = '<select data-testid="tenant-select"><option value="tenant">Tenant</option></select>'
    + '<select data-testid="buyer-select"><option value="buyer">Buyer</option></select>'
    + '<button data-testid="product-physical-add">Add physical</button><button data-testid="product-digital-add">Add digital</button>'
    + '<button data-testid="create-quote">Create quote</button><p data-testid="order-id">No order</p>'
    + '<button data-testid="checkout">Checkout</button><p data-testid="payment-state">Not checked out</p>'
    + `<script>document.querySelector('[data-testid="create-quote"]').onclick = async () => {
      const order = await fetch('/api/v1/orders/quotes', { method: 'POST' }).then(response => response.json());
      document.querySelector('[data-testid="order-id"]').textContent = ' ' + order.orderId + ' ';
    }; document.querySelector('[data-testid="checkout"]').onclick = () => {
      document.querySelector('[data-testid="payment-state"]').textContent = 'UNKNOWN';
    };</script>`;
  let quotes = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      quotes++;
      setTimeout(() => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ orderId: returnedOrderId })); }, 200);
    } else { response.setHeader('Content-Type', 'text/html'); response.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const browserCleanups = [];
  t.after(async () => { for (const cleanup of browserCleanups) await cleanup(); });
  const ctx = {
    fixtures: { browser: () => ({ seed: {}, tenant: { tenantId: 'tenant' }, buyer: { buyerId: 'buyer' },
      physical: { productId: 'physical' }, digital: { productId: 'digital' } }) },
    migrate: async () => {}, seed: async () => {}, npm: async () => {}, startWorker: async () => ({}),
    startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
    defer: cleanup => browserCleanups.push(cleanup), snapshot: async () => { throw reachedSnapshot; },
    loadChromium: async () => ({ launch: options => chromium.launch({ ...options,
      executablePath: process.env.FRONTAL_TEST_CHROMIUM, args: ['--no-sandbox'] }) }),
  };
  await assert.rejects(D_CASES.find(item => item.id === 'D-02').run(ctx), error => error === reachedSnapshot);
  assert.equal(quotes, 1, 'one actual browser quote request, with no evaluator-injected mutation');
  await browserCleanups.pop()();
  returnedOrderId = 'not-a-public-order-id';
  await assert.rejects(D_CASES.find(item => item.id === 'D-02').run(ctx), /visible text did not match/);
  assert.equal(quotes, 2, 'invalid rendered identity is still rejected after the real request');
});
