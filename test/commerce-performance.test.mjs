import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import contract from '../contracts/transfer/commercecommand.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/commercecommand/v2/fixtures/index.mjs';
import { E_CASES } from '../evaluators/transfer/commercecommand/v2/cases/e.mjs';
import { catastropheStages } from '../evaluators/transfer/commercecommand/v2/cases/performance-recovery.mjs';
import { performanceFixture, prepareConcurrently, measuredWindow, assertPerformanceRate, assertPerformanceInvariants, dueWorkDrained, assertImmutableRows } from '../evaluators/transfer/commercecommand/v2/cases/performance.mjs';

const factory = createFixtureFactory({ evaluationSeed: 'performance-regression', caseId: 'E-13', baseTime: '2026-09-08T00:00:00Z' });
const ctx = { ...factory, fixtures: factory };
const validSeed = validator(contract)(contract.schemas.Seed);

test('full-size public performance manifests are strict, tenant-local and balanced, without seeded business effects', () => {
  for (const [count, sellersPerOrder] of [[50_000, 1], [20_000, 2]]) {
    const fixture = performanceFixture(ctx, count, { sellersPerOrder });
    assert(validSeed(fixture.seed), JSON.stringify(validSeed.errors));
    assert.equal(fixture.records.length, count);
    assert.equal(fixture.seed.sellers.length, count * sellersPerOrder);
    assert.equal(new Set(fixture.seed.sellers.map(row => row.sellerId)).size, count * sellersPerOrder);
    assert.equal(fixture.seed.tenants.length, 10);
    for (const records of Map.groupBy(fixture.records, row => row.tenantId).values()) {
      assert.equal(records.length, count / 10);
      assert.equal(records.filter(row => row.kind === 'PHYSICAL').length, count / 20);
      for (const row of records) {
        assert(row.sellers.every(seller => seller.tenantId === row.tenantId));
        assert.equal(row.quote.lines[0].quantity, sellersPerOrder);
      }
    }
    for (const key of ['orders', 'orderLines', 'paymentAttempts', 'sellerAllocations', 'sellerSettlements', 'ledgerEntries', 'notificationDeliveries']) assert.equal(fixture.seed[key].length, 0, `${key} must be produced by real public mutations`);
    assert(!('work' in fixture.seed) && !('events' in fixture.seed));
  }
});

test('catastrophe has exactly 8,000 Orders plus 1,000 settlements and 1,000 disputes, with new physical Work in UNKNOWN share', () => {
  const fixture = performanceFixture(ctx, 8000, { sellersPerOrder: 2, stages: catastropheStages });
  assert(validSeed(fixture.seed), JSON.stringify(validSeed.errors));
  const groups = Map.groupBy(fixture.records, row => row.stage);
  for (const stage of ['quoted', 'unknown', 'physical', 'digital']) assert.equal(groups.get(stage).length, 2000);
  assert.equal(groups.get('unknown').slice(0, 1000).filter(row => row.kind === 'PHYSICAL').length, 500);
  assert.equal(fixture.records.length + 1000 + 1000, factory.performance().scenarios.catastrophe.entities);
});

test('preparation failure drains in-flight public requests and admits no later work', async () => {
  const finished = [];
  const concurrent = async (values, limit, fn) => {
    let cursor = 0;
    await Promise.all(Array.from({ length: limit }, async () => {
      while (cursor < values.length) { const index = cursor++; await fn(values[index], index); }
    }));
  };
  await assert.rejects(prepareConcurrently({ concurrent }, [0, 1, 2, 3], 2, async index => {
    if (index === 0) { await sleep(1); throw new Error('invalid public preparation'); }
    await sleep(15); finished.push(index);
  }), /invalid public preparation/);
  assert.deepEqual(finished, [1]);
});

test('fixed-window measurement excludes late completions and never promotes HTTP failures to performance passes', async () => {
  const late = await measuredWindow({ durationMs: 15, clients: 1, batches: 1,
    operation: (_index, measure) => measure('mutation', async () => { await sleep(30); return { status: 200, json: {} }; }) });
  assert.equal(late.completed, 0); assert.equal(late.afterWindow, 1);
  assert.throws(() => assertPerformanceRate(late, 1, 750));
  const measured = await measuredWindow({ durationMs: 50, clients: 1, batches: 3,
    operation: (index, measure) => measure(index === 2 ? 'resolution' : 'refund', async () => ({ status: index === 2 ? 409 : 201 }), response => assert([201, 409].includes(response.status))) });
  assert.equal(measured.completed, 3); assert.equal(measured.throughput, 60);
  assert.deepEqual(measured.roles, { refund: 2, resolution: 1 });
  assert.deepEqual(measured.statuses, { 201: 2, 409: 1 });
  assert.equal(measured.afterWindow, 0);
  await assert.rejects(measuredWindow({ durationMs: 10, clients: 1, batches: 1,
    operation: (_index, measure) => measure('mutation', async () => ({ status: 500 })) }), /Performance request\/contract failures/);
});

function validSnapshot() {
  const { seed } = factory.marketplace();
  const { schemaVersion, seedVersion, ...resources } = structuredClone(seed);
  const tenantId = resources.tenants[0].tenantId, orderId = factory.uuid('oracle-order'), orderLineId = factory.uuid('oracle-line');
  const product = resources.products.find(row => row.tenantId === tenantId && row.kind === 'DIGITAL');
  const offer = resources.offerVersions.find(row => row.productId === product.productId);
  resources.orders.push({ orderId, tenantId, buyerId: resources.buyers[0].buyerId, channel: 'WEB', currency: 'USD', state: 'PAID', orderTotalMinor: 770, capturedMinor: 770, refundedMinor: 0, quoteExpiresAt: factory.at({ hours: 1 }) });
  resources.orderLines.push({ orderLineId, orderId, tenantId, productId: product.productId, offerVersionId: offer.offerVersionId,
    quantity: 1, currency: 'USD', unitPriceMinor: 700, taxMinor: 70, lineTotalMinor: 770, fulfillmentKind: 'DIGITAL' });
  resources.paymentAttempts.push({ paymentAttemptId: factory.uuid('oracle-payment'), orderId, tenantId, provider: 'SANDBOX', providerRequestId: 'original-request', state: 'CAPTURED', capturedMinor: 770 });
  for (const direction of ['DEBIT', 'CREDIT']) resources.ledgerEntries.push({ ledgerEntryId: factory.uuid(`ledger:${direction}`), tenantId, orderId, journalId: factory.uuid('journal'), currency: 'USD', account: direction === 'DEBIT' ? 'CASH' : 'REVENUE', direction, amountMinor: 770 });
  resources.entitlementGrants.push({ entitlementGrantId: factory.uuid('grant'), tenantId, orderId, orderLineId, grantRevision: 1, state: 'ACTIVE' });
  return { asOf: factory.at(), resources, events: [], work: [] };
}

test('linear performance oracle rejects bad reserve, ledger, isolation and duplicate grant identities', () => {
  assertPerformanceInvariants(validSnapshot());
  const over = validSnapshot();
  over.resources.commerceDisputes.push({ commerceDisputeId: factory.uuid('dispute'), tenantId: over.resources.orders[0].tenantId, paymentAttemptId: over.resources.paymentAttempts[0].paymentAttemptId, providerDisputeId: factory.uuid('provider-dispute'), amountMinor: 771, state: 'LOST' });
  assert.throws(() => assertPerformanceInvariants(over), /refund\+retained dispute/);
  const ledger = validSnapshot(); ledger.resources.ledgerEntries[0].amountMinor++;
  assert.throws(() => assertPerformanceInvariants(ledger), /journals balanced/);
  const foreign = validSnapshot(); foreign.resources.orderLines[0].tenantId = foreign.resources.tenants[1].tenantId;
  assert.throws(() => assertPerformanceInvariants(foreign));
  const grant = validSnapshot(); grant.resources.entitlementGrants.push({ ...grant.resources.entitlementGrants[0], entitlementGrantId: factory.uuid('second-grant') });
  assert.throws(() => assertPerformanceInvariants(grant), /one entitlement grant/);
});

test('immutable row checks ignore serialization order but reject new duplicate effects, and drain ignores only future expiry', () => {
  const before = { resources: { rows: [{ id: 1, amount: 5 }, { id: 2, amount: 10 }] } };
  assertImmutableRows(before, { resources: { rows: [...before.resources.rows].reverse() } }, 'rows', 'id');
  assert.throws(() => assertImmutableRows(before, { resources: { rows: [...before.resources.rows, { id: 3, amount: 5 }] } }, 'rows', 'id'), /row set changed/);
  assert(dueWorkDrained({ work: [{ kind: 'QUOTE_EXPIRY', terminal: false, availableAt: '2026-09-08T01:00:00Z' }] }, Date.parse('2026-09-08T00:00:00Z')));
  assert(!dueWorkDrained({ work: [{ kind: 'FULFILLMENT', terminal: false, availableAt: '2026-09-08T01:00:00Z' }] }, Date.parse('2026-09-08T00:00:00Z')));
});

test('five formerly missing performance cases attempt real preparation and cannot return a placeholder pass', async () => {
  const ids = ['E-08', 'E-09', 'E-11', 'E-12', 'E-13'];
  for (const id of ids) {
    const failure = new Error('real performance fixture setup');
    const selected = E_CASES.find(row => row.id === id); assert(selected);
    await assert.rejects(selected.run({ fixtures: { performance() { throw failure; } }, pass: () => ({ status: 'passed' }), mark() {} }), error => error === failure, id);
  }
});
