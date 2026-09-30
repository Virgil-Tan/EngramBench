import assert from "node:assert/strict";
import { CaseExcluded, candidateAssert } from "../lib/execution.mjs";
import { assertCoreInvariants, assertNoSecrets, canonicalJson, resource } from "../oracles/index.mjs";
import { assertLoad, checkout, defineCase, fixedDurationLoad, guardedCase, prepare, providerCallback, quote, semanticReplay, successful, waitSnapshot } from "./helpers.mjs";
import { heldWorker, assertHeldClaim, assertNotificationBytes } from './recovery.mjs';
import { assertSettlement, projectOrder, settlementFee, withholdingAdjustment } from '../oracles/economic-policy.mjs';
import { PERF_ENV, performanceFixture, prepareConcurrently, preparePerformance, proposeSettlement, measuredWindow, assertPerformanceRate, assertPerformanceInvariants, dueWorkDrained, assertImmutableRows } from './performance.mjs';
import { fullCatastrophe } from './performance-recovery.mjs';

const V1_RESOURCE_KEYS = Object.freeze(["tenants", "buyers", "products", "offerVersions", "inventoryPools", "orders", "orderLines", "inventoryHolds", "paymentAttempts", "fulfillmentPlans", "entitlementGrants", "ledgerEntries", "notificationDeliveries"]);

function requireV1(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  return ctx.forWorkspace(ctx.v1Workspace);
}

function v1Surface(snapshot) {
  return {
    resources: Object.fromEntries(V1_RESOURCE_KEYS.map((key) => [key, resource(snapshot, key)])),
    events: snapshot.events,
    work: snapshot.work,
  };
}

const E01 = guardedCase("E-01", ["MIGRATION_COMPATIBILITY"], async (ctx) => {
  const fixture = ctx.fixtures.migration();
  const v1 = requireV1(ctx);
  await v1.migrate();
  await v1.seed(fixture.seed);
  const oldApi = await v1.startApi();
  const quoted = await quote(ctx, oldApi.baseUrl, fixture, "v1-blue-green", {}, { mixed: true, key: fixture.savedReplayKey });
  const checked = await checkout(ctx, oldApi.baseUrl, quoted.orderId, "v1-blue-green");
  const before = await ctx.snapshot(oldApi.baseUrl);
  await ctx.migrate();
  await ctx.migrate();
  const finalApi = await ctx.startApi();
  const oldRead = successful(await ctx.request(oldApi.baseUrl, `/api/v1/orders/${quoted.orderId}`), "old API during blue-green", [200]);
  const finalRead = successful(await ctx.request(finalApi.baseUrl, `/api/v1/orders/${quoted.orderId}`), "FINAL API during blue-green", [200]);
  assert.equal(canonicalJson(oldRead.json), canonicalJson(finalRead.json), "old and FINAL APIs agree on V1 Order");
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/orders/quotes", fixture.savedReplayKey, quoted.body);
  semanticReplay(quoted.response, replay);
  const after = await ctx.snapshot(finalApi.baseUrl);
  assert.equal(canonicalJson(v1Surface(after)), canonicalJson(v1Surface(before)), "V1 public identities payloads Events and Work survive FINAL migration");
  const v1Client = await quote(ctx, oldApi.baseUrl, fixture, "v1-client-after-final", { productId: fixture.digital.productId }, { key: ctx.key("old-client-after-final") });
  assert.ok(v1Client.orderId, "old V1 client can create a documented request after FINAL migration");
  assert.ok(checked.response.status < 300, "V1 checkout retained");
  return ctx.pass({ evidence: [{ orderId: quoted.orderId, oldStatus: oldRead.status, finalStatus: finalRead.status, replay: true }] });
});

const E02 = guardedCase("E-02", ["MIGRATION_COMPATIBILITY", "IDEMPOTENCY_PROVIDER_IDENTITY", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.migration();
  const v1 = requireV1(ctx);
  await v1.migrate();
  await v1.seed(fixture.seed);
  const oldApi = await v1.startApi();
  const quoted = await quote(ctx, oldApi.baseUrl, fixture, "v1-replay", {}, { mixed: true });
  const checked = await checkout(ctx, oldApi.baseUrl, quoted.orderId, "v1-replay");
  const pending = await ctx.snapshot(oldApi.baseUrl);
  const order = resource(pending, "orders").find(({ orderId }) => orderId === quoted.orderId);
  const callbackKey = ctx.key("v1-lost-callback");
  const callbackBody = { providerEventId: `event-${ctx.key("v1-lost")}`, providerRequestId: checked.providerRequestId, outcome: "CAPTURED", capturedMinor: order.orderTotalMinor };
  const shield = await ctx.responseShield(oldApi.baseUrl);
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, "/api/v1/payment-provider/callbacks", callbackKey, callbackBody).catch(() => undefined);
  const capturedResponse = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "V1 saved callback response" });
  const before = await ctx.snapshot(oldApi.baseUrl);
  const events = before.events.filter(({ aggregateId }) => aggregateId === quoted.orderId);
  const ledger = resource(before, "ledgerEntries").filter(({ orderId }) => orderId === quoted.orderId);
  const notifications = resource(before, "notificationDeliveries").filter(({ orderId }) => orderId === quoted.orderId);
  await ctx.stop(oldApi);
  await ctx.migrate();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/payment-provider/callbacks", callbackKey, callbackBody);
  assert.equal(replay.status, capturedResponse.response.status, "saved V1 callback status");
  assert.equal(canonicalJson(replay.json), canonicalJson(JSON.parse(capturedResponse.response.body)), "saved V1 callback body");
  const after = await ctx.snapshot(finalApi.baseUrl);
  for (const event of events) assert.deepEqual(after.events.find(({ eventId }) => eventId === event.eventId), event, `Event ${event.eventId} immutable`);
  for (const entry of ledger) assert.deepEqual(resource(after, "ledgerEntries").find(({ entryId }) => entryId === entry.entryId), entry, `Ledger ${entry.entryId} immutable`);
  for (const delivery of notifications) assert.deepEqual(resource(after, "notificationDeliveries").find(({ notificationDeliveryId }) => notificationDeliveryId === delivery.notificationDeliveryId), delivery, `Notification ${delivery.notificationDeliveryId} immutable`);
  assertCoreInvariants(after);
  return ctx.pass({ evidence: [{ orderId: quoted.orderId, preservedEvents: events.length, preservedLedgerEntries: ledger.length, preservedNotifications: notifications.length }] });
});

const E03 = guardedCase("E-03", ["MIGRATION_COMPATIBILITY", "WORK_FENCING", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const receiverState = { accepting: false };
  const receiver = await ctx.receiver({ path: "/commerce-migration", behavior: () => receiverState.accepting ? { status: 204 } : { status: 500 } });
  const fixture = ctx.fixtures.migration();
  const v1 = requireV1(ctx);
  await v1.migrate();
  await v1.seed(fixture.seed);
  const oldApi = await v1.startApi();
  const quoted = await quote(ctx, oldApi.baseUrl, fixture, "pending-migration");
  const checked = await checkout(ctx, oldApi.baseUrl, quoted.orderId, "pending-migration");
  await providerCallback(ctx, oldApi.baseUrl, checked.providerRequestId, "pending-unknown", "UNKNOWN", 0);
  const oldDispatcher = await v1.startDispatcher({ webhookUrl: receiver.url });
  await ctx.waitFor(() => receiver.ledger.length > 0 ? receiver.ledger : undefined, { label: "V1 unacknowledged notification", processes: [oldDispatcher] });
  const before = await ctx.snapshot(oldApi.baseUrl);
  const pendingIds = new Set(before.work.filter(({ terminal }) => !terminal).map(({ workId }) => workId));
  const notificationIds = new Set(resource(before, "notificationDeliveries").filter(({ orderId }) => orderId === quoted.orderId).map(({ notificationDeliveryId }) => notificationDeliveryId));
  assert.ok(pendingIds.size > 0 && notificationIds.size > 0, "V1 pending Work and notification preconditions");
  await ctx.stop(oldDispatcher);
  await ctx.stop(oldApi);
  await ctx.migrate();
  const finalApi = await ctx.startApi();
  const afterMigration = await ctx.snapshot(finalApi.baseUrl);
  assert.ok([...pendingIds].every((workId) => afterMigration.work.some((work) => work.workId === workId)), "pending V1 Work identities preserved");
  assert.ok([...notificationIds].every((id) => resource(afterMigration, "notificationDeliveries").some(({ notificationDeliveryId }) => notificationDeliveryId === id)), "unacked notification identities preserved");
  const order = resource(afterMigration, "orders").find(({ orderId }) => orderId === quoted.orderId);
  await providerCallback(ctx, finalApi.baseUrl, checked.providerRequestId, "final-capture", "CAPTURED", order.orderTotalMinor);
  receiverState.accepting = true;
  const workers = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
  const finalDispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
  const drained = await waitSnapshot(ctx, finalApi.baseUrl, (snapshot) => {
    const selected = snapshot.work.filter(({ workId }) => pendingIds.has(workId));
    return selected.length === pendingIds.size && selected.every(({ terminal }) => terminal);
  }, { timeoutMs: 180_000, processes: [...workers, finalDispatcher], label: "FINAL drains V1 Work" });
  await ctx.waitFor(() => receiver.ledger.some(({ acknowledged }) => acknowledged), { timeoutMs: 90_000, processes: [finalDispatcher], label: "FINAL acknowledges V1 notification" });
  assert.ok([...pendingIds].every((workId) => drained.work.find((work) => work.workId === workId).attempts >= before.work.find((work) => work.workId === workId).attempts), "Work attempts do not reset");
  assertCoreInvariants(drained);
  return ctx.pass({ evidence: [{ pendingWork: pendingIds.size, notifications: notificationIds.size, deliveryAttempts: receiver.ledger.length }] });
});

const E04 = guardedCase("E-04", ["COMMERCE_CONSERVATION"], async (ctx) => {
  const spec = ctx.fixtures.performance().scenarios.quoteReadMix;
  const fixture = ctx.fixtures.largeCatalog(spec.products);
  const { api } = await prepare(ctx, fixture);
  const result = await fixedDurationLoad(ctx, {
    warmupMs: spec.warmupMs,
    measureMs: spec.measureMs,
    concurrency: spec.clients,
    request: (index) => {
      if (index % 5 !== 0) {
        const path = index % 2 === 0 ? `/api/v1/products?tenantId=${fixture.tenant.tenantId}` : `/api/v1/orders?tenantId=${fixture.tenant.tenantId}`;
        return ctx.request(api.baseUrl, path);
      }
      const product = fixture.products[index % fixture.products.length];
      return ctx.mutate(api.baseUrl, "/api/v1/orders/quotes", ctx.key(`perf:quote:${index}`), ctx.fixtures.quoteBody(fixture, `perf:${index}`, { productId: product.productId, quantity: 1 }));
    },
    validate: (response, index) => assert.equal(response.status, index % 5 === 0 ? 201 : 200, "quote-read-mix response"),
  });
  assertLoad(result, { minimumThroughput: spec.minimumThroughput, maximumP95: spec.maximumP95, acceptedStatuses: [200, 201] });
  const snapshot = await ctx.snapshot(api.baseUrl);
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ scenario: "quote-read-mix", ...result }] });
});

const E05 = guardedCase("E-05", ["IDEMPOTENCY_PROVIDER_IDENTITY"], async (ctx) => {
  const spec = ctx.fixtures.performance().scenarios.checkoutContention;
  const fixture = ctx.fixtures.payment();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const bodies = Array.from({ length: spec.quotes }, (_, index) => ctx.fixtures.quoteBody(fixture, `checkout:${index}`, { productId: fixture.digital.productId }));
  const created = await ctx.concurrent(bodies, 64, (body, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/orders/quotes", ctx.key(`checkout:quote:${index}`), body));
  assert.ok(created.every(({ status }) => status === 201), "2,000 checkout quotes prepared");
  const orders = created.map(({ json }) => json.orderId);
  const result = await fixedDurationLoad(ctx, {
    measureMs: spec.measureMs,
    concurrency: spec.clients,
    request: (index) => {
      const ordinal = index % orders.length;
      const duplicateArm = index % 4 < 2;
      return ctx.mutate(apis[index % 2].baseUrl, `/api/v1/orders/${orders[ordinal]}/checkout`, ctx.key(duplicateArm ? `perf:checkout:${ordinal}:same` : `perf:checkout:${ordinal}:${index}`), { provider: "SANDBOX", providerRequestId: `perf-provider-${ordinal}` });
    },
    validate: (response) => assert.ok((response.status >= 200 && response.status < 300) || response.status === 409, "checkout-contention business response"),
  });
  assertLoad(result, { minimumThroughput: spec.minimumThroughput, maximumP95: spec.maximumP95, acceptedStatuses: [200, 201, 202, 409] });
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  for (const orderId of orders) assert.ok(resource(snapshot, "paymentAttempts").filter((attempt) => attempt.orderId === orderId).length <= 1, `Order ${orderId} one provider operation`);
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ scenario: "checkout-contention", preparedQuotes: orders.length, ...result }] });
});

const E06 = guardedCase("E-06", ["COMMERCE_CONSERVATION"], async (ctx) => {
  const spec = ctx.fixtures.performance().scenarios.inventoryHotspot;
  const fixture = ctx.fixtures.payment();
  fixture.seed.inventoryPools = Array.from({ length: spec.pools }, (_, index) => ({
    inventoryPoolId: ctx.uuid(`hot-pool:${index}`),
    tenantId: fixture.tenant.tenantId,
    productId: fixture.physical.productId,
    priority: index + 1,
    onHand: 5_000,
    reserved: 0,
  }));
  const { apis } = await prepare(ctx, fixture, { apiCount: spec.apiCount });
  const result = await fixedDurationLoad(ctx, {
    measureMs: spec.measureMs,
    concurrency: spec.clients,
    maximumOperations: spec.attempts,
    request: (index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/orders/quotes", ctx.key(`hotspot:${index}`), ctx.fixtures.quoteBody(fixture, `hotspot:${index}`, { quantity: 2 })),
    validate: (response) => assert.ok([201, 409].includes(response.status), "inventory-hotspot success or inventory rejection"),
  });
  assertLoad(result, { minimumThroughput: spec.minimumThroughput, maximumP95: spec.maximumP95, acceptedStatuses: [201, 409] });
  assert.equal(Object.hasOwn(result.statuses, "500"), false, "inventory-hotspot has no 5xx");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ scenario: "inventory-hotspot", pools: spec.pools, attempted: result.completed, ...result }] });
});

const E07 = guardedCase("E-07", ["IDEMPOTENCY_PROVIDER_IDENTITY", "COMMERCE_CONSERVATION"], async (ctx) => {
  const spec = ctx.fixtures.performance().scenarios.paymentUnknown;
  const fixture = ctx.fixtures.payment();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const prepared = await ctx.concurrent(Array.from({ length: spec.attempts }), 64, async (_, index) => {
    const quoted = await quote(ctx, apis[index % 2].baseUrl, fixture, `unknown:${index}`, { productId: fixture.digital.productId });
    const checked = await checkout(ctx, apis[index % 2].baseUrl, quoted.orderId, `unknown:${index}`);
    await providerCallback(ctx, apis[index % 2].baseUrl, checked.providerRequestId, `unknown:${index}`, "UNKNOWN", 0);
    return { orderId: quoted.orderId, providerRequestId: checked.providerRequestId };
  });
  const pending = await ctx.snapshot(apis[0].baseUrl);
  for (const value of prepared) {
    const order = resource(pending, "orders").find(({ orderId }) => orderId === value.orderId);
    const attempt = resource(pending, "paymentAttempts").find(({ orderId }) => orderId === value.orderId);
    Object.assign(value, { amountMinor: order.orderTotalMinor, paymentAttemptId: attempt.paymentAttemptId });
  }
  const result = await fixedDurationLoad(ctx, {
    measureMs: spec.measureMs,
    concurrency: spec.clients,
    request: (index) => {
      const value = prepared[index % prepared.length];
      if (index % 2 === 0) return ctx.mutate(apis[index % 2].baseUrl, "/api/v1/payment-provider/callbacks", ctx.key(`perf:payment:callback:${index % prepared.length}`), { providerEventId: `perf-event-${index % prepared.length}`, providerRequestId: value.providerRequestId, outcome: "CAPTURED", capturedMinor: value.amountMinor });
      return ctx.mutate(apis[index % 2].baseUrl, `/api/v1/payment-attempts/${value.paymentAttemptId}/reconcile`, ctx.key(`perf:payment:reconcile:${index % prepared.length}`), { providerQueryId: `perf-query-${index % prepared.length}`, outcome: "DECLINED", capturedMinor: 0 });
    },
    validate: (response) => assert.ok((response.status >= 200 && response.status < 300) || response.status === 409, "payment reconciliation business response"),
  });
  assertLoad(result, { minimumThroughput: spec.minimumThroughput, maximumP95: spec.maximumP95, acceptedStatuses: [200, 201, 202, 409] });
  const converged = await waitSnapshot(ctx, apis[0].baseUrl, (snapshot) => prepared.every(({ paymentAttemptId }) => {
    const attempt = resource(snapshot, "paymentAttempts").find((item) => item.paymentAttemptId === paymentAttemptId);
    return attempt && ["CAPTURED", "DECLINED"].includes(attempt.state ?? attempt.outcome);
  }), { timeoutMs: spec.convergenceMs, label: "all determinable payments terminal" });
  assertCoreInvariants(converged);
  return ctx.pass({ evidence: [{ scenario: "payment-unknown-reconcile", prepared: prepared.length, ...result }] });
});

const E08 = guardedCase('E-08', ['WORK_FENCING', 'COMMERCE_CONSERVATION', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const spec = ctx.fixtures.performance().scenarios.fulfillmentDrain;
  const fixture = performanceFixture(ctx, spec.orders, { physicalOnly: true });
  const { apis, snapshot: before } = await preparePerformance(ctx, fixture);
  assert.equal(resource(before, 'fulfillmentPlans').length, 10_000, '10,000 actual physical plans prepared');
  assert(resource(before, 'fulfillmentPlans').every(row => row.state === 'PENDING'), 'drain does not count precompleted plans');
  const started = performance.now();
  const held = await heldWorker(ctx, 'FULFILLMENT', { env: PERF_ENV });
  const entry = await held.wait(), claim = assertHeldClaim(await ctx.snapshot(apis[0].baseUrl), entry);
  const killedAt = Date.now(); await ctx.kill(held.worker); assert(held.worker.stopped, 'claimed Worker SIGKILL happened');
  const workers = await Promise.all(Array.from({ length: spec.workers - 1 }, () => ctx.startWorker({ env: PERF_ENV })));
  const replacementBarrier = await ctx.barrier({ hold: () => false });
  const replacement = await ctx.startWorker({ env: { ...PERF_ENV, TEST_BARRIER_URL: replacementBarrier.url, TEST_BARRIER_TOKEN: replacementBarrier.token } });
  workers.push(replacement);
  const drained = await waitSnapshot(ctx, apis[0].baseUrl, snapshot => resource(snapshot, 'fulfillmentPlans').length === spec.orders
    && resource(snapshot, 'fulfillmentPlans').every(row => row.state === 'COMPLETED' && row.completedAt) && dueWorkDrained(snapshot),
  { timeoutMs: Math.max(1, spec.drainMs - (performance.now() - started)), intervalMs: 1000, processes: workers, label: 'full 10,000-plan drain after Worker kill' });
  const durationMs = performance.now() - started, throughput = spec.orders / (durationMs / 1000);
  assert(durationMs <= spec.drainMs && throughput >= spec.minimumThroughput, '50 terminal plans/s and 300-second complete drain');
  const recovered = drained.work.find(row => row.workId === claim.workId);
  assert(recovered?.state === 'SUCCEEDED' && recovered.attempts > claim.attempts && recovered.fencingToken > claim.fencingToken, 'killed claim reclaimed with a new authority');
  assert(replacementBarrier.ledger.some(({ json, released }) => released === true && json.point === 'worker.claimed' && drained.work.some(row => row.workId === json.workId && row.state === 'SUCCEEDED' && row.fencingToken >= json.fencingToken)), 'replacement actually claimed completed work');
  for (const key of ['inventoryPools', 'inventoryHolds', 'orderLines', 'paymentAttempts', 'ledgerEntries']) assertImmutableRows(before, drained, key, ({ inventoryPools: 'inventoryPoolId', inventoryHolds: 'inventoryHoldId', orderLines: 'orderLineId', paymentAttempts: 'paymentAttemptId', ledgerEntries: 'ledgerEntryId' })[key]);
  assert.equal(new Set(resource(drained, 'fulfillmentPlans').map(row => row.orderId)).size, spec.orders, 'no duplicate shipment plan');
  assertPerformanceInvariants(drained);
  return ctx.pass({ evidence: [{ scenario: 'fulfillment-drain', preparedOrders: spec.orders, workers: 4, killedAt, durationMs, throughput, terminalPlans: spec.orders }] });
});

const E09 = guardedCase('E-09', ['WORK_FENCING', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const spec = ctx.fixtures.performance().scenarios.notificationUnknownAck;
  const fixture = performanceFixture(ctx, spec.notifications, { stages: () => 'quoted' });
  const { apis, snapshot: before } = await preparePerformance(ctx, fixture);
  const deliveries = resource(before, 'notificationDeliveries');
  assert.equal(deliveries.length, spec.notifications, 'exactly 10,000 real quote notifications');
  const droppedIds = new Set([...deliveries].sort((a, b) => a.notificationDeliveryId.localeCompare(b.notificationDeliveryId))
    .filter((_, index) => index % 10 === 0).map(row => row.notificationDeliveryId));
  const lost = new Set();
  const receiver = await ctx.receiver({ path: '/performance-notifications', behavior: entry => {
    entry.observedAtMs = Date.now();
    if (droppedIds.has(entry.json?.notificationDeliveryId) && !lost.has(entry.json.notificationDeliveryId)) {
      lost.add(entry.json.notificationDeliveryId); return { disconnect: true };
    }
    return { status: 204 };
  } });
  let held;
  const barrier = await ctx.barrier({ hold: (body, entry) => {
    if (!held && body.point === 'dispatcher.response-received' && body.responseStatus === 204) { held = entry; return true; }
    return false;
  } });
  const started = performance.now();
  const first = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { ...PERF_ENV, TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  await barrier.waitFor(entry => entry === held, { processes: [first], label: 'real notification ACK barrier' });
  assert(receiver.ledger.some(entry => entry.json?.eventId === held.json.eventId && entry.acknowledged), 'held ACK was actually received');
  const second = await ctx.startDispatcher({ webhookUrl: receiver.url, env: PERF_ENV });
  const killedAt = Date.now(); await ctx.kill(first); assert(first.stopped, 'response-barrier dispatcher actually SIGKILLed');
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url, env: PERF_ENV });
  const final = await waitSnapshot(ctx, apis[0].baseUrl, snapshot => resource(snapshot, 'notificationDeliveries').length === spec.notifications
    && resource(snapshot, 'notificationDeliveries').every(row => row.state === 'DELIVERED' && row.deliveredAt),
  { timeoutMs: Math.max(1, spec.drainMs - (performance.now() - started)), intervalMs: 500, processes: [second, replacement], label: '10,000 notifications drain with 10% lost ACKs' });
  const durationMs = performance.now() - started, throughput = spec.notifications / (durationMs / 1000);
  assert(durationMs <= spec.drainMs && throughput >= spec.minimumThroughput, '100 distinct deliveries/s and 180-second drain');
  assert.equal(lost.size, spec.notifications * spec.lostAckRatio, 'exactly 10% first ACKs lost after record');
  assert(receiver.ledger.filter(entry => entry.json?.eventId === held.json.eventId).length >= 2, 'killed dispatcher ACK is redelivered');
  assert.equal(new Set(receiver.ledger.filter(entry => entry.acknowledged).map(entry => entry.json.notificationDeliveryId)).size, spec.notifications);
  assertNotificationBytes(final, receiver.ledger); assertPerformanceInvariants(final);
  return ctx.pass({ evidence: [{ scenario: 'notification-unknown-ack', notifications: spec.notifications, lostACKs: lost.size, killedAt, durationMs, throughput, attempts: receiver.ledger.length }] });
});

const E10 = guardedCase("E-10", ["COMMERCE_CONSERVATION", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const spec = ctx.fixtures.performance().scenarios.entitlementStorm;
  const fixture = ctx.fixtures.entitlement();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const checked = await ctx.concurrent(Array.from({ length: spec.lines }), 64, async (_, index) => {
    const baseUrl = apis[index % 2].baseUrl, label = `entitlement:${index}`;
    const quoted = await quote(ctx, baseUrl, fixture, label, { productId: fixture.digital.productId });
    return { ...quoted, ...await checkout(ctx, baseUrl, quoted.orderId, label) };
  });
  candidateAssert.equal(new Set(checked.map(row => row.orderId)).size, checked.length, "prepared Orders have unique identities");
  const orders = resource(await ctx.snapshot(apis[0].baseUrl), "orders");
  const ordersById = new Map(orders.map(order => [order.orderId, order]));
  candidateAssert.equal(ordersById.size, orders.length, "preparation snapshot has no duplicate Order identities");
  const captured = checked.map(record => {
    const order = ordersById.get(record.orderId);
    candidateAssert.ok(order, "captured Order precondition");
    return { ...record, orderTotalMinor: order.orderTotalMinor };
  });
  await ctx.concurrent(captured, 64, async (record, index) => {
    record.callback = await providerCallback(ctx, apis[index % 2].baseUrl, record.providerRequestId, `entitlement:${index}`, "CAPTURED", record.orderTotalMinor);
  });
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const withGrants = await waitSnapshot(ctx, apis[0].baseUrl, (snapshot) => resource(snapshot, "entitlementGrants").filter(({ state }) => state === "ACTIVE").length >= captured.length, { timeoutMs: 300_000, processes: workers, label: "digital grants active" });
  const firstLineById = new Map();
  for (const line of resource(withGrants, "orderLines")) if (!firstLineById.has(line.orderLineId)) firstLineById.set(line.orderLineId, line);
  const grantsByOrder = new Map(resource(withGrants, "entitlementGrants").map((grant) => [firstLineById.get(grant.orderLineId)?.orderId, grant]));
  const result = await fixedDurationLoad(ctx, {
    measureMs: spec.measureMs,
    concurrency: spec.clients,
    request: (index) => {
      const item = captured[index % captured.length];
      if (index % 2 === 0) return ctx.mutate(apis[index % 2].baseUrl, `/api/v1/orders/${item.orderId}/refunds`, ctx.key(`entitlement:refund:${index % captured.length}`), { amountMinor: item.orderTotalMinor, reason: "entitlement storm full refund", restockLines: [] });
      const grant = grantsByOrder.get(item.orderId);
      return ctx.mutate(apis[index % 2].baseUrl, `/api/v1/entitlement-grants/${grant.entitlementGrantId}/revoke`, ctx.key(`entitlement:revoke:${index % captured.length}`), {});
    },
    validate: (response) => assert.ok((response.status >= 200 && response.status < 300) || response.status === 409, "entitlement storm business response"),
  });
  assertLoad(result, { minimumThroughput: spec.minimumThroughput, maximumP95: spec.maximumP95, acceptedStatuses: [200, 201, 202, 409] });
  const final = await ctx.snapshot(apis[0].baseUrl);
  const digitalLinesByOrder = Map.groupBy(resource(final, "orderLines").filter(line => line.fulfillmentKind === "DIGITAL"), line => line.orderId);
  const activeGrantLines = new Set(resource(final, "entitlementGrants").filter(grant => grant.state === "ACTIVE").map(grant => grant.orderLineId));
  for (const order of resource(final, "orders").filter(({ refundedMinor, capturedMinor }) => capturedMinor > 0 && refundedMinor === capturedMinor)) {
    const lines = digitalLinesByOrder.get(order.orderId) ?? [];
    assert.ok(lines.every((line) => !activeGrantLines.has(line.orderLineId)), "fully refunded line has no ACTIVE grant");
  }
  assertCoreInvariants(final);
  return ctx.pass({ evidence: [{ scenario: "entitlement-revocation-storm", lines: captured.length, ...result }] });
});

const E11 = guardedCase('E-11', ['COMMERCE_CONSERVATION', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const spec = ctx.fixtures.performance().scenarios.settlementClose;
  const fixture = performanceFixture(ctx, spec.allocations, { sellersPerOrder: 1 });
  const { apis, snapshot: prepared } = await preparePerformance(ctx, fixture);
  assert.equal(resource(prepared, 'sellerAllocations').length, 50_000); assert.equal(resource(prepared, 'sellers').length, 50_000);
  await prepareConcurrently(ctx, fixture.records, 64, async record => { record.settlement = await proposeSettlement(ctx, apis[record.index % 2].baseUrl, record); });
  const workers = await Promise.all([ctx.startWorker({ env: PERF_ENV }), ctx.startWorker({ env: PERF_ENV })]);
  await waitSnapshot(ctx, apis[0].baseUrl, dueWorkDrained, { timeoutMs: 300_000, intervalMs: 1000, processes: workers, label: 'preparation Work drains outside settlement measurement' });
  const before = await ctx.snapshot(apis[0].baseUrl);
  assert.equal(resource(before, 'sellerSettlements').length, spec.allocations);
  assert(resource(before, 'sellerSettlements').every(row => row.state === 'OPEN'), 'all 50,000 distinct proposals unclosed before measurement');
  const admitted = new Map(), acknowledgedClosed = new Set();
  const result = await measuredWindow({ durationMs: spec.measureMs, clients: spec.clients, batches: fixture.records.length,
    operation: async (index, measure, window) => {
      const record = fixture.records[index], id = record.settlement.sellerSettlementId;
      admitted.set(id, record);
      const response = await measure('close', () => ctx.mutate(apis[index % 2].baseUrl, `/api/v1/seller-settlements/${id}/close`, ctx.key(`performance:close:${index}`), {}));
      if (response.json.state === 'CLOSED' && performance.now() <= window.deadline) acknowledgedClosed.add(id);
    } });
  const final = await waitSnapshot(ctx, apis[0].baseUrl, snapshot => {
    const byId = new Map(resource(snapshot, 'sellerSettlements').map(row => [row.sellerSettlementId, row]));
    return [...admitted.keys()].every(id => byId.get(id)?.state === 'CLOSED') && dueWorkDrained(snapshot);
  }, { timeoutMs: 300_000, intervalMs: 1000, processes: workers, label: 'acknowledged close operations become durable' });
  let committedInWindow = 0;
  for (const actual of resource(final, 'sellerSettlements')) {
    const record = admitted.get(actual.sellerSettlementId); if (!record) { assert.equal(actual.state, 'OPEN'); continue; }
    assertSettlement(actual, { allocationIds: [record.allocations[0].sellerAllocationId], grossMinor: 1001, feeMinor: settlementFee(1001), refundReserveMinor: 0, disputeReserveMinor: 0, netMinor: 1001 - settlementFee(1001) });
    const closedAt = Date.parse(actual.closedAt);
    if (acknowledgedClosed.has(actual.sellerSettlementId) || (closedAt >= result.startedAtMs && closedAt <= result.endedAtMs)) committedInWindow++;
  }
  const settlementThroughput = committedInWindow / (spec.measureMs / 1000);
  assert(settlementThroughput >= spec.minimumThroughput, '80 distinct committed CLOSED settlements/s; HTTP acceptance is not a close');
  assertPerformanceRate(result, spec.minimumThroughput, spec.maximumP95); assertPerformanceInvariants(final);
  const stable = await ctx.snapshot(apis[1].baseUrl);
  assertImmutableRows(final, stable, 'sellerSettlements', 'sellerSettlementId');
  return ctx.pass({ evidence: [{ scenario: 'seller-settlement-close', preparedAllocations: 50_000, preparedSellers: 50_000, admitted: admitted.size, committedInWindow, settlementThroughput, ...result }] });
});

const E12 = guardedCase('E-12', ['COMMERCE_CONSERVATION', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const spec = ctx.fixtures.performance().scenarios.refundDisputeRace;
  const fixture = performanceFixture(ctx, spec.orders, { sellersPerOrder: 2 });
  const { apis } = await preparePerformance(ctx, fixture);
  const workers = await Promise.all([ctx.startWorker({ env: PERF_ENV }), ctx.startWorker({ env: PERF_ENV })]);
  // Both fulfillment kinds in each Tenant have a frozen period, so late-adjustment
  // and immutable-period checks are exercised rather than passing on empty sets.
  const closed = new Map();
  await prepareConcurrently(ctx, fixture.records.slice(0, 20), 20, async record => {
    for (const seller of record.sellers) {
      const proposal = await proposeSettlement(ctx, apis[record.index % 2].baseUrl, record, seller);
      successful(await ctx.mutate(apis[record.index % 2].baseUrl, `/api/v1/seller-settlements/${proposal.sellerSettlementId}/close`, ctx.key(`performance:before-race-close:${seller.sellerId}`), {}));
      closed.set(proposal.sellerSettlementId, { record, seller });
    }
  });
  const before = await waitSnapshot(ctx, apis[0].baseUrl, snapshot => resource(snapshot, 'sellerSettlements').filter(row => row.state === 'CLOSED').length === 40 && dueWorkDrained(snapshot),
    { timeoutMs: 300_000, intervalMs: 1000, processes: workers, label: 'public closed-period race preconditions' });
  const batches = [];
  const result = await measuredWindow({ durationMs: spec.measureMs, clients: spec.clients, batches: fixture.records.length,
    operation: async (index, measure) => {
      const record = fixture.records[index], base = apis[index % 2].baseUrl;
      const refundAmount = Number(BigInt(record.orderTotalMinor) * (index % 2 ? 3n : 1n) / 4n);
      const disputeAmount = refundAmount;
      const validate = response => {
        if (response.status === 409) assert(['REFUND_EXCEEDS_CAPTURE', 'RESERVE_EXCEEDS_CAPTURE'].includes(response.json?.error?.code), 'only published contention codes count');
        else successful(response, 'refund-dispute mutation');
      };
      const [refund, dispute] = await Promise.all([
        measure('refund', () => ctx.mutate(base, `/api/v1/orders/${record.orderId}/refunds`, ctx.key(`performance:refund:${index}`), { amountMinor: refundAmount, reason: 'Public refund/dispute race', restockLines: [] }), validate),
        measure('dispute-open', () => ctx.mutate(apis[(index + 1) % 2].baseUrl, '/api/v1/commerce-disputes', ctx.key(`performance:dispute:${index}`), { tenantId: record.tenantId, paymentAttemptId: record.paymentAttemptId, providerDisputeId: ctx.uuid(`performance:provider-dispute:${index}`), amountMinor: disputeAmount }), validate),
      ]);
      if (index % 2 === 0) assert(refund.status < 300 && dispute.status < 300, 'within-bound batch admits both legal mutations');
      else assert.equal(Number(refund.status < 300) + Number(dispute.status < 300), 1, 'over-bound race commits one individually legal mutation and rejects the other');
      if (refund.status < 300) assert.equal(refund.json.amountMinor, refundAmount);
      if (dispute.status < 300) assert.equal(dispute.json.amountMinor, disputeAmount);
      let resolved;
      if (dispute.status < 300) {
        resolved = (await measure('resolution', () => ctx.mutate(base, `/api/v1/commerce-disputes/${dispute.json.commerceDisputeId}/resolve`, ctx.key(`performance:resolution:${index}`), { providerEventId: ctx.key(`performance:resolution-event:${index}`), outcome: index % 2 ? 'LOST' : 'WON' }))).json;
        assert.equal(resolved.state, index % 2 ? 'LOST' : 'WON');
      }
      const order = successful(await ctx.request(base, `/api/v1/orders/${record.orderId}`), 'post-batch committed Order', [200]).json;
      assert.equal(order.refundedMinor, refund.status < 300 ? refundAmount : 0, 'post-batch actual refund projection');
      assert(order.refundedMinor + (resolved?.state === 'LOST' ? disputeAmount : 0) <= order.capturedMinor, 'post-batch committed reserve bound');
      batches.push({ record, refund: refund.status < 300 ? refund.json : null, dispute: resolved ?? null });
    } });
  assertPerformanceRate(result, spec.minimumThroughput, spec.maximumP95);
  const final = await waitSnapshot(ctx, apis[0].baseUrl, dueWorkDrained, { timeoutMs: 300_000, intervalMs: 1000, processes: workers, label: 'refund/dispute Work and liability drain' });
  const disputesById = new Map(resource(final, 'commerceDisputes').map(row => [row.commerceDisputeId, row]));
  const ledgersByOrder = Map.groupBy(resource(final, 'ledgerEntries'), row => row.orderId);
  for (const batch of batches) {
    const dispute = batch.dispute && disputesById.get(batch.dispute.commerceDisputeId);
    if (batch.dispute) assert.equal(dispute?.state, batch.dispute.state);
    const ledger = ledgersByOrder.get(batch.record.orderId) ?? [];
    const expectedReversals = (batch.refund?.amountMinor ?? 0) + (dispute?.state === 'LOST' ? dispute.amountMinor : 0);
    assert.equal(ledger.filter(row => row.account === 'CASH' && row.direction === 'CREDIT').reduce((sum, row) => sum + row.amountMinor, 0), expectedReversals, 'refund and LOST reverse cash exactly once; WON does not');
    assert.equal(new Set(ledger.map(row => row.journalId)).size, 1 + Number(Boolean(batch.refund)) + Number(dispute?.state === 'LOST'), 'distinct capture/refund/LOST journals without replay duplicates');
  }
  for (const [id, { record }] of closed) {
    const previous = resource(before, 'sellerSettlements').find(row => row.sellerSettlementId === id);
    assert.deepEqual(resource(final, 'sellerSettlements').find(row => row.sellerSettlementId === id), previous, 'late race cannot edit CLOSED period');
    const projected = projectOrder(final, record.orderId).allocations;
    for (const allocationId of previous.allocationIds) {
      const allocation = projected.find(row => row.sellerAllocationId === allocationId);
      const adjustments = resource(final, 'settlementAdjustments').filter(row => row.sourceSettlementId === id && row.sourceAllocationId === allocationId);
      assert.equal(adjustments.reduce((sum, row) => sum + row.amountMinor, 0), withholdingAdjustment({ refundReserveMinor: 0, disputeReserveMinor: 0 }, allocation), 'late withholding attributed to exact frozen allocation');
      assert(adjustments.every(row => row.targetPeriodStart === previous.periodEnd), 'late adjustments persist next eligible period');
    }
  }
  assertPerformanceInvariants(final);
  return ctx.pass({ evidence: [{ scenario: 'refund-dispute-race', preparedOrders: 20_000, sellersPerOrder: 2, checkedBatches: batches.length, frozenPeriods: 40,
    resolutions: { WON: batches.filter(row => row.dispute?.state === 'WON').length, LOST: batches.filter(row => row.dispute?.state === 'LOST').length }, ...result }] });
});
const E13 = guardedCase('E-13', ['WORK_FENCING', 'COMMERCE_CONSERVATION', 'TRANSACTIONAL_EVIDENCE'], fullCatastrophe);

const E14 = defineCase("E-14", async (ctx) => {
  const fixture = ctx.fixtures.main();
  let { api } = await prepare(ctx, fixture);
  const first = await quote(ctx, api.baseUrl, fixture, "reproducible", { productId: fixture.digital.productId });
  const firstSnapshot = await ctx.snapshot(api.baseUrl);
  const firstProjection = reproducibleProjection(firstSnapshot, first.orderId);
  const firstPort = api.port;
  assertNoSecrets(ctx.processes.map(({ logs }) => logs).join("\n"), [ctx.adminToken, ctx.barrierToken]);
  await ctx.stop(api);
  await assert.rejects(ctx.request(`http://127.0.0.1:${firstPort}`, "/healthz", { timeoutMs: 250 }), "stopped API releases its port");
  await ctx.resetDatabase();
  ({ api } = await prepare(ctx, fixture));
  const second = await quote(ctx, api.baseUrl, fixture, "reproducible", { productId: fixture.digital.productId });
  const secondSnapshot = await ctx.snapshot(api.baseUrl);
  assert.deepEqual(reproducibleProjection(secondSnapshot, second.orderId), firstProjection, "same fixture reproduces the same observable semantic result");
  assertNoSecrets(ctx.processes.map(({ logs }) => logs).join("\n"), [ctx.adminToken, ctx.barrierToken]);
  assertCoreInvariants(secondSnapshot);
  return ctx.pass({ evidence: [{ rerun: true, semanticProjection: firstProjection }] });
});

function reproducibleProjection(snapshot, orderId) {
  const order = resource(snapshot, "orders").find((item) => item.orderId === orderId);
  const lines = resource(snapshot, "orderLines").filter((line) => line.orderId === orderId);
  return {
    state: order.state,
    orderTotalMinor: order.orderTotalMinor,
    capturedMinor: order.capturedMinor,
    refundedMinor: order.refundedMinor,
    lines: lines.map(({ productId, quantity, unitPriceMinor, taxMinor, lineTotalMinor, fulfillmentKind }) => ({ productId, quantity, unitPriceMinor, taxMinor, lineTotalMinor, fulfillmentKind })),
    workKinds: snapshot.work.filter((work) => work.aggregateId === orderId || lines.some((line) => line.orderLineId === work.aggregateId)).map(({ kind }) => kind).sort(),
    eventTypes: snapshot.events.filter((event) => event.aggregateId === orderId).map(({ type }) => type).sort(),
    notifications: resource(snapshot, "notificationDeliveries").filter((delivery) => delivery.orderId === orderId).length,
  };
}

export const E_CASES = Object.freeze([E01, E02, E03, E04, E05, E06, E07, E08, E09, E10, E11, E12, E13, E14]);
