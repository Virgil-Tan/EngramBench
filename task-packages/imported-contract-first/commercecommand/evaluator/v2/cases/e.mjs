import assert from "node:assert/strict";
import { CaseExcluded } from "../lib/execution.mjs";
import { assertCoreInvariants, assertNoSecrets, canonicalJson, resource } from "../oracles/index.mjs";
import { assertLoad, blockedCase, capture, checkout, defineCase, fixedDurationLoad, guardedCase, prepare, providerCallback, quote, semanticReplay, successful, waitSnapshot } from "./helpers.mjs";

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

const E08 = blockedCase("E-08", [["CC-E08-BARRIER", "CC-GAP-04"]]);
const E09 = blockedCase("E-09", [["CC-E09-BARRIER", "CC-GAP-04"]]);

const E10 = guardedCase("E-10", ["COMMERCE_CONSERVATION", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const spec = ctx.fixtures.performance().scenarios.entitlementStorm;
  const fixture = ctx.fixtures.entitlement();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const captured = await ctx.concurrent(Array.from({ length: spec.lines }), 64, (_, index) => capture(ctx, apis[index % 2].baseUrl, fixture, `entitlement:${index}`, { quote: { productId: fixture.digital.productId } }));
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const withGrants = await waitSnapshot(ctx, apis[0].baseUrl, (snapshot) => resource(snapshot, "entitlementGrants").filter(({ state }) => state === "ACTIVE").length >= captured.length, { timeoutMs: 300_000, processes: workers, label: "digital grants active" });
  const grantsByOrder = new Map(resource(withGrants, "entitlementGrants").map((grant) => [resource(withGrants, "orderLines").find((line) => line.orderLineId === grant.orderLineId)?.orderId, grant]));
  const result = await fixedDurationLoad(ctx, {
    measureMs: spec.measureMs,
    concurrency: spec.clients,
    request: (index) => {
      const item = captured[index % captured.length];
      if (index % 2 === 0) return ctx.mutate(apis[index % 2].baseUrl, `/api/v1/orders/${item.orderId}/refunds`, ctx.key(`entitlement:refund:${index % captured.length}`), { amountMinor: item.orderTotalMinor, reason: "entitlement storm full refund", restockLines: [] });
      const grant = grantsByOrder.get(item.orderId);
      return ctx.request(apis[index % 2].baseUrl, `/api/v1/entitlement-grants/${grant.entitlementGrantId}/revoke`, { method: "POST", headers: { "idempotency-key": ctx.key(`entitlement:revoke:${index % captured.length}`) } });
    },
    validate: (response) => assert.ok((response.status >= 200 && response.status < 300) || response.status === 409, "entitlement storm business response"),
  });
  assertLoad(result, { minimumThroughput: spec.minimumThroughput, maximumP95: spec.maximumP95, acceptedStatuses: [200, 201, 202, 409] });
  const final = await ctx.snapshot(apis[0].baseUrl);
  for (const order of resource(final, "orders").filter(({ refundedMinor, capturedMinor }) => capturedMinor > 0 && refundedMinor === capturedMinor)) {
    const lines = resource(final, "orderLines").filter(({ orderId, fulfillmentKind }) => orderId === order.orderId && fulfillmentKind === "DIGITAL");
    assert.ok(lines.every((line) => !resource(final, "entitlementGrants").some((grant) => grant.orderLineId === line.orderLineId && grant.state === "ACTIVE")), "fully refunded line has no ACTIVE grant");
  }
  assertCoreInvariants(final);
  return ctx.pass({ evidence: [{ scenario: "entitlement-revocation-storm", lines: captured.length, ...result }] });
});

const E11 = blockedCase("E-11", [["CC-E11-MANAGER-WIRE", "CC-GAP-02"], ["CC-E11-SETTLEMENT-FORMULA", "CC-GAP-10"], ["CC-E11-WORKLOAD", "CC-GAP-11"]]);
const E12 = blockedCase("E-12", [["CC-E12-MANAGER-WIRE", "CC-GAP-02"], ["CC-E12-SETTLEMENT-FORMULA", "CC-GAP-10"], ["CC-E12-WORKLOAD", "CC-GAP-11"]]);
const E13 = blockedCase("E-13", [["CC-E13-MANAGER-WIRE", "CC-GAP-02"], ["CC-E13-BARRIER", "CC-GAP-04"], ["CC-E13-SETTLEMENT-FORMULA", "CC-GAP-10"], ["CC-E13-WORKLOAD", "CC-GAP-11"]]);

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
