import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalJson, percentile, resource } from '../oracles/index.mjs';
import { assertSnapshotSchema } from '../oracles/openapi.mjs';
import { settlementFee } from '../oracles/economic-policy.mjs';
import { successful } from './helpers.mjs';

export const PERF_ENV = Object.freeze({ BENCH_PERF_SCALE: '1', WORK_LEASE_SECONDS: '2' });

// Drain already-issued public requests before a failed preparation is torn down.
export async function prepareConcurrently(ctx, values, clients, operation) {
  const errors = [];
  await ctx.concurrent(values, clients, async (...args) => {
    if (errors.length) return;
    try { return await operation(...args); } catch (error) { errors.push(error); }
  });
  if (errors.length) throw new AggregateError(errors, `Performance preparation failed: ${errors[0].message}`);
}

// Public preparation only: strict seed contains catalog/actors, never precomputed Work or effects.
export function performanceFixture(ctx, count, { sellersPerOrder = 0, physicalOnly = false, stages } = {}) {
  assert(Number.isSafeInteger(count) && count > 0 && count % 10 === 0);
  const seed = structuredClone(ctx.fixtures.marketplace().seed);
  for (const [key, value] of Object.entries(seed)) if (Array.isArray(value)) seed[key] = [];
  seed.seedVersion = ctx.key(`performance-catalog:${count}:${sellersPerOrder}`);
  const tenants = Array.from({ length: 10 }, (_, index) => {
    const tenantId = ctx.uuid(`performance:tenant:${index}`), buyerId = ctx.uuid(`performance:buyer:${index}`);
    seed.tenants.push({ tenantId, name: `Performance tenant ${index}` });
    seed.buyers.push({ buyerId, tenantId, displayName: `Performance buyer ${index}` });
    const products = {};
    for (const kind of ['PHYSICAL', 'DIGITAL']) {
      const productId = ctx.uuid(`performance:product:${index}:${kind}`);
      products[kind] = productId;
      seed.products.push({ productId, tenantId, sku: `PERF-${index}-${kind}`, name: `${kind} product`, kind });
      seed.offerVersions.push({ offerVersionId: ctx.uuid(`performance:offer:${index}:${kind}`), tenantId, productId,
        version: 1, currency: 'USD', unitPriceMinor: 1001, taxMinor: 0, fulfillmentKind: kind,
        effectiveFrom: ctx.at({ days: -30 }), effectiveUntil: ctx.at({ days: 365 }), state: 'ACTIVE' });
      if (kind === 'PHYSICAL') seed.inventoryPools.push({ inventoryPoolId: ctx.uuid(`performance:pool:${index}`),
        tenantId, productId, priority: 1, onHand: count * 4, reserved: 0 });
    }
    return { tenantId, buyerId, products };
  });
  const records = Array.from({ length: count }, (_, index) => {
    const tenant = tenants[index % 10], stage = stages?.(index) ?? 'captured';
    const kind = stage === 'physical' ? 'PHYSICAL' : stage === 'digital' ? 'DIGITAL'
      : physicalOnly || Math.floor(index / 10) % 2 === 0 ? 'PHYSICAL' : 'DIGITAL';
    const sellers = Array.from({ length: sellersPerOrder }, (_, ordinal) => {
      const seller = { sellerId: ctx.uuid(`performance:seller:${index}:${ordinal}`), tenantId: tenant.tenantId, name: `Seller ${index}-${ordinal}` };
      seed.sellers.push(seller); return seller;
    });
    return { index, stage, kind, tenantId: tenant.tenantId, sellers, quote: {
      tenantId: tenant.tenantId, buyerId: tenant.buyerId, channel: 'WEB',
      lines: [{ productId: tenant.products[kind], quantity: Math.max(1, sellersPerOrder) }], holdTtlSeconds: 3600,
    } };
  });
  return { seed, records, fixtureFamily: 'CC-F-PERF' };
}

export async function preparePerformance(ctx, fixture, { env = {} } = {}) {
  await ctx.migrate(); await ctx.seed(fixture.seed);
  const apis = await Promise.all([ctx.startApi({ env: { ...PERF_ENV, ...env } }), ctx.startApi({ env: { ...PERF_ENV, ...env } })]);
  await prepareConcurrently(ctx, fixture.records, 64, async record => {
    const base = apis[record.index % 2].baseUrl, label = `performance:${record.index}`;
    const quoted = successful(await ctx.mutate(base, '/api/v1/orders/quotes', ctx.key(`${label}:quote`), record.quote), 'performance quote', [201]).json;
    assert.equal(quoted.lines.length, 1); assert.equal(quoted.orderTotalMinor, record.quote.lines[0].quantity * 1001);
    Object.assign(record, { orderId: quoted.orderId, orderTotalMinor: quoted.orderTotalMinor, line: quoted.lines[0] });
    if (record.sellers.length && !['quoted', 'unknown'].includes(record.stage)) {
      record.allocations = successful(await ctx.mutate(base, `/api/v1/orders/${record.orderId}/seller-allocations`, ctx.key(`${label}:allocate`), {
        allocations: record.sellers.map(seller => ({ sellerId: seller.sellerId, orderLineId: record.line.orderLineId, quantity: 1, amountMinor: 1001 })),
      }), 'performance immutable allocation').json;
      assert.equal(record.allocations.length, record.sellers.length);
    }
    if (record.stage === 'quoted') return;
    record.providerRequestId = ctx.key(`${label}:provider`);
    const attempt = successful(await ctx.mutate(base, `/api/v1/orders/${record.orderId}/checkout`, ctx.key(`${label}:checkout`), {
      provider: 'SANDBOX', providerRequestId: record.providerRequestId,
    }), 'performance checkout').json;
    record.paymentAttemptId = attempt.paymentAttemptId;
    assert.match(record.paymentAttemptId ?? '', /^[0-9a-f-]{36}$/);
    successful(await ctx.mutate(base, '/api/v1/payment-provider/callbacks', ctx.key(`${label}:callback`), {
      providerEventId: ctx.key(`${label}:event`), providerRequestId: record.providerRequestId,
      outcome: record.stage === 'unknown' ? 'UNKNOWN' : 'CAPTURED', capturedMinor: record.stage === 'unknown' ? 0 : record.orderTotalMinor,
    }), 'performance capture/unknown preparation');
  });
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  const orders = new Map(resource(snapshot, 'orders').map(row => [row.orderId, row]));
  assert.equal(orders.size, fixture.records.length, 'exact public starting Order count');
  for (const record of fixture.records) {
    const order = orders.get(record.orderId);
    assert.equal(order.tenantId, record.tenantId);
    assert.equal(order.capturedMinor, ['quoted', 'unknown'].includes(record.stage) ? 0 : record.orderTotalMinor);
    assert.equal(order.refundedMinor, 0);
    if (record.stage === 'quoted') assert.equal(order.state, 'QUOTED');
    if (record.stage === 'unknown') assert.equal(order.state, 'PAYMENT_PENDING');
  }
  ctx.mark('performance.prepared', { seed: ctx.evaluationSeed, referenceTime: ctx.at(), tenants: 10,
    counts: Object.fromEntries(Object.entries(snapshot.resources).map(([key, rows]) => [key, rows.length])),
    apiCount: 2, scale: 1, orderCount: orders.size });
  return { apis, snapshot };
}

export async function proposeSettlement(ctx, base, record, seller = record.sellers[0]) {
  return successful(await ctx.mutate(base, '/api/v1/seller-settlements', ctx.key(`performance:settlement:${record.index}:${seller.sellerId}`), {
    tenantId: record.tenantId, sellerId: seller.sellerId, currency: 'USD', periodStart: ctx.at({ days: -1 }), periodEnd: ctx.at({ days: 1 }),
  }), 'prepare OPEN settlement').json;
}

// The shared older load helper counts requests ending after the window. Here only
// responses fully received before the fixed deadline count toward the public rate.
export async function measuredWindow({ durationMs, clients, batches, operation }) {
  const startedAtMs = Date.now(), started = performance.now(), deadline = started + durationMs;
  let ordinal = 0, completed = 0, afterWindow = 0, transportFailures = 0;
  const latencies = [], roles = {}, statuses = {}, errors = [];
  const measure = async (role, request, validate = response => successful(response, role)) => {
    const begin = performance.now(); let response;
    try { response = await request(); } catch (error) { transportFailures++; throw error; }
    const end = performance.now(); validate(response);
    if (end <= deadline) {
      completed++; latencies.push(end - begin); roles[role] = (roles[role] ?? 0) + 1;
      statuses[response.status] = (statuses[response.status] ?? 0) + 1;
    } else afterWindow++;
    return response;
  };
  await Promise.all(Array.from({ length: clients }, async () => {
    try {
      while (performance.now() < deadline) {
        const index = ordinal++;
        if (index >= batches) { await sleep(Math.max(0, deadline - performance.now())); break; }
        await operation(index, measure, { deadline, startedAtMs });
      }
    } catch (error) { errors.push(error); }
  }));
  if (errors.length) throw new AggregateError(errors, `Performance request/contract failures: ${errors[0].message}`);
  return { startedAtMs, endedAtMs: startedAtMs + durationMs, durationMs, completed, afterWindow, transportFailures,
    throughput: completed / (durationMs / 1000), p50: percentile(latencies, .5), p95: percentile(latencies, .95), p99: percentile(latencies, .99), roles, statuses };
}

export function assertPerformanceRate(result, rate, p95) {
  assert(result.completed > 0 && result.throughput >= rate, `measured ${result.throughput}/s, required ${rate}/s`);
  assert(result.p95 <= p95, `measured p95 ${result.p95}ms, required <= ${p95}ms`);
  assert.equal(result.transportFailures, 0, 'unexpected performance transport failures');
}

// Linear indexing keeps author verification of the fixed 50,000-record workload
// from becoming quadratic; the business equations and schema remain unchanged.
export function assertPerformanceInvariants(snapshot) {
  assertSnapshotSchema(snapshot);
  const rows = snapshot.resources;
  const index = (key, field) => {
    const result = new Map(rows[key].map(row => [row[field], row]));
    assert.equal(result.size, rows[key].length, `${key} identities unique`); return result;
  };
  const orders = index('orders', 'orderId'), lines = index('orderLines', 'orderLineId'), attempts = index('paymentAttempts', 'paymentAttemptId');
  const products = index('products', 'productId'), buyers = index('buyers', 'buyerId'), pools = index('inventoryPools', 'inventoryPoolId');
  const sellers = index('sellers', 'sellerId'), allocations = index('sellerAllocations', 'sellerAllocationId');
  const totals = new Map(), reserved = new Map(), captured = new Map(), refunds = new Map(), disputeReserves = new Map(), journals = new Map();
  for (const line of lines.values()) {
    assert(Number.isSafeInteger(line.quantity * (line.unitPriceMinor + line.taxMinor)));
    assert.equal(line.lineTotalMinor, line.quantity * (line.unitPriceMinor + line.taxMinor));
    assert.equal(orders.get(line.orderId)?.tenantId, line.tenantId); assert.equal(products.get(line.productId)?.tenantId, line.tenantId);
    totals.set(line.orderId, (totals.get(line.orderId) ?? 0) + line.lineTotalMinor);
  }
  for (const hold of rows.inventoryHolds) {
    assert(['HELD', 'CONSUMED', 'RELEASED', 'EXPIRED'].includes(hold.state));
    assert(Number.isSafeInteger(hold.quantity) && hold.quantity > 0);
    assert.equal(lines.get(hold.orderLineId)?.tenantId, hold.tenantId); assert.equal(pools.get(hold.inventoryPoolId)?.tenantId, hold.tenantId);
    if (hold.state === 'HELD') reserved.set(hold.inventoryPoolId, (reserved.get(hold.inventoryPoolId) ?? 0) + hold.quantity);
  }
  for (const pool of pools.values()) { assert(pool.reserved >= 0 && pool.reserved <= pool.onHand); assert.equal(pool.reserved, reserved.get(pool.inventoryPoolId) ?? 0); }
  for (const attempt of attempts.values()) {
    assert.equal(orders.get(attempt.orderId)?.tenantId, attempt.tenantId);
    if (attempt.state === 'CAPTURED') captured.set(attempt.orderId, (captured.get(attempt.orderId) ?? 0) + 1);
  }
  for (const refund of rows.refunds) { assert.equal(orders.get(refund.orderId)?.tenantId, refund.tenantId); refunds.set(refund.orderId, (refunds.get(refund.orderId) ?? 0) + refund.amountMinor); }
  for (const dispute of rows.commerceDisputes) {
    const attempt = attempts.get(dispute.paymentAttemptId); assert.equal(attempt?.tenantId, dispute.tenantId);
    if (['OPEN', 'LOST'].includes(dispute.state)) disputeReserves.set(attempt.orderId, (disputeReserves.get(attempt.orderId) ?? 0) + dispute.amountMinor);
  }
  for (const order of orders.values()) {
    assert.equal(buyers.get(order.buyerId)?.tenantId, order.tenantId); assert.equal(order.orderTotalMinor, totals.get(order.orderId));
    assert(order.refundedMinor >= 0 && order.refundedMinor <= order.capturedMinor && order.capturedMinor <= order.orderTotalMinor);
    assert((captured.get(order.orderId) ?? 0) <= 1); assert.equal(order.refundedMinor, refunds.get(order.orderId) ?? 0);
    assert(order.refundedMinor + (disputeReserves.get(order.orderId) ?? 0) <= order.capturedMinor, 'refund+retained dispute bound');
  }
  for (const entry of rows.ledgerEntries) {
    assert.equal(orders.get(entry.orderId)?.tenantId, entry.tenantId); assert(entry.amountMinor > 0 && Number.isSafeInteger(entry.amountMinor));
    const key = `${entry.tenantId}:${entry.currency}:${entry.journalId}`;
    journals.set(key, (journals.get(key) ?? 0n) + (entry.direction === 'DEBIT' ? 1n : -1n) * BigInt(entry.amountMinor));
  }
  assert([...journals.values()].every(value => value === 0n), 'all journals balanced');
  const allocationTotals = new Map();
  for (const allocation of allocations.values()) {
    const line = lines.get(allocation.orderLineId); assert.equal(line?.orderId, allocation.orderId);
    assert.equal(line.tenantId, allocation.tenantId); assert.equal(sellers.get(allocation.sellerId)?.tenantId, allocation.tenantId);
    const value = allocationTotals.get(line.orderLineId) ?? { quantity: 0, amount: 0 };
    value.quantity += allocation.quantity; value.amount += allocation.amountMinor; allocationTotals.set(line.orderLineId, value);
  }
  for (const [lineId, total] of allocationTotals) { assert.equal(total.quantity, lines.get(lineId).quantity); assert.equal(total.amount, lines.get(lineId).lineTotalMinor); }
  const grantKeys = new Set();
  for (const grant of rows.entitlementGrants) {
    const order = orders.get(grant.orderId); assert.equal(order?.tenantId, grant.tenantId); assert.equal(lines.get(grant.orderLineId)?.orderId, order.orderId);
    const key = `${grant.tenantId}:${grant.orderLineId}:${grant.grantRevision}`;
    assert(!grantKeys.has(key), 'one entitlement grant per line/revision'); grantKeys.add(key);
    if (order.capturedMinor > 0 && order.refundedMinor === order.capturedMinor) assert.notEqual(grant.state, 'ACTIVE');
  }
  const included = new Set();
  for (const settlement of rows.sellerSettlements.filter(row => row.state === 'CLOSED')) {
    assert.equal(sellers.get(settlement.sellerId)?.tenantId, settlement.tenantId);
    for (const id of settlement.allocationIds) {
      const allocation = allocations.get(id); assert.equal(allocation?.sellerId, settlement.sellerId); assert.equal(allocation.tenantId, settlement.tenantId);
      assert(!included.has(id), 'allocation enters CLOSED settlement once'); included.add(id);
    }
    assert.equal(settlement.feeMinor, settlementFee(settlement.grossMinor));
  }
  const eventIds = new Map(), sequences = new Map();
  for (const event of snapshot.events) {
    assert(!eventIds.has(event.eventId)); eventIds.set(event.eventId, event);
    const key = `${event.tenantId}:${event.aggregateId}`, list = sequences.get(key) ?? []; list.push(event.aggregateSequence); sequences.set(key, list);
  }
  for (const list of sequences.values()) { list.sort((a, b) => a - b); list.slice(1).forEach((value, i) => assert.equal(value, list[i] + 1)); }
  const notifications = new Set(), notificationEvents = new Set();
  for (const notification of rows.notificationDeliveries) {
    assert(!notifications.has(notification.notificationDeliveryId)); notifications.add(notification.notificationDeliveryId);
    assert(!notificationEvents.has(notification.eventId)); notificationEvents.add(notification.eventId);
    const event = eventIds.get(notification.eventId); assert(event, 'notification has committed Event');
    assert.equal(event.aggregateId, notification.orderId); assert.equal(event.tenantId, notification.tenantId); assert.equal(event.aggregateSequence, notification.aggregateSequence);
  }
  for (const event of eventIds.values()) if (orders.has(event.aggregateId)) assert(notificationEvents.has(event.eventId), 'Order Event has durable notification');
  assert.equal(new Set(snapshot.work.map(row => row.workId)).size, snapshot.work.length);
  for (const work of snapshot.work) {
    assert(work.attempts >= 0);
    if (work.terminal) assert(['SUCCEEDED', 'DEAD'].includes(work.state));
  }
  return true;
}

export function dueWorkDrained(snapshot, now = Date.now()) {
  return snapshot.work.every(row => row.terminal || (row.kind === 'QUOTE_EXPIRY' && Date.parse(row.availableAt) > now));
}

export function assertImmutableRows(before, after, key, idField) {
  assert.equal(resource(after, key).length, resource(before, key).length, `${key} row set changed`);
  const actual = new Map(resource(after, key).map(row => [row[idField], row]));
  for (const row of resource(before, key)) assert.equal(canonicalJson(actual.get(row[idField])), canonicalJson(row), `${key} existing row changed`);
}
