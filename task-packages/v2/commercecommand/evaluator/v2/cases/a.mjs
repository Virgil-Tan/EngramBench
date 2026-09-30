import assert from "node:assert/strict";
import { candidateAssert } from '../lib/execution.mjs';
import { assertCoreInvariants, assertQuoteEffects, allocateByPriority, assertAllocations, resource, stableSnapshot } from "../oracles/index.mjs";
import { assertPublishedOpenApi, assertSnapshotSchema, assertLiveSchema } from "../oracles/openapi.mjs";
import { assertSettlement, settlementProjection, withholdingAdjustment, nextAdjustmentPeriod } from '../oracles/economic-policy.mjs';
import { heldWorker, assertHeldClaim, assertCaptureNotRepeated, assertOrderEvidence } from './recovery.mjs';
import { blockedCase, capture, checkout, defineCase, expectedQuote, guardedCase, prepare, providerCallback, quote, semanticError, semanticReplay, successful, waitSnapshot } from "./helpers.mjs";

const A01 = guardedCase("A-01", ["PRODUCTION_BOOT"], async (ctx) => {
  await ctx.command("npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: 300_000 });
  await ctx.migrate();
  await ctx.migrate();
  await ctx.npm("build", [], { timeoutMs: 180_000 });
  const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
  const worker = await ctx.startWorker();
  const dispatcher = await ctx.startDispatcher();
  const health = await ctx.request(api.baseUrl, "/healthz");
  assert.equal(health.status, 200, "published health route");
  const openapi = successful(await ctx.openApi(api.baseUrl), "OpenAPI", [200]);
  assertPublishedOpenApi(openapi.json, { exactBodies: false });
  const ui = await ctx.request(api.baseUrl, "/");
  assert.equal(ui.status, 200, "production UI route");
  assert.match(ui.headers.get("content-type") ?? "", /text\/html/iu, "production UI HTML");
  await Promise.all([ctx.stop(dispatcher), ctx.stop(worker), ctx.stop(api)]);
  assert.ok([api, worker, dispatcher].every((record) => record.stopped), "all independent roles stopped");
  return ctx.pass({ evidence: [{ command: "install/migrate×2/build/start roles", openapiPaths: Object.keys(openapi.json.paths ?? {}).length }] });
});

const A02 = guardedCase("A-02", ["MIGRATION_COMPATIBILITY"], async (ctx) => {
  const fixture = ctx.fixtures.migration();
  const { api } = await prepare(ctx, fixture, { migrateTwice: true });
  const created = await capture(ctx, api.baseUrl, fixture, "migration-state", { mixed: true });
  const before = await ctx.snapshot(api.baseUrl);
  assertCoreInvariants(before);
  await ctx.stop(api);
  await ctx.migrate();
  await ctx.migrate();
  const restarted = await ctx.startApi();
  const after = await ctx.snapshot(restarted.baseUrl);
  assert.equal(stableSnapshot(after), stableSnapshot(before), "repeatable populated migration preserves public state");
  assert.ok(resource(after, "orders").some(({ orderId }) => orderId === created.orderId), "migrated Order identity");
  return ctx.pass({ evidence: [{ orderId: created.orderId, snapshotStable: true }] });
});

const A03 = defineCase("A-03", async ctx => {
  const fixture = ctx.fixtures.main(), { api } = await prepare(ctx, fixture);
  const before = await ctx.snapshot(api.baseUrl);
  assertSnapshotSchema(before);
  await ctx.seed(fixture.seed);
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before), 'identical seed replay is a no-op');
  for (const [label, seed, contractExpectation] of [
    ['unknown-field', { ...fixture.seed, unexpected: true }, 'invalid'],
    ['changed-version-body', { ...fixture.seed, tenants: fixture.seed.tenants.map(tenant => ({ ...tenant, name: 'changed' })) }, undefined],
    ['broken-reference', { ...fixture.seed, seedVersion: 'broken-reference', buyers: fixture.seed.buyers.map(buyer => ({ ...buyer, tenantId: ctx.uuid('missing-tenant') })) }, undefined],
    ['duplicate-identity', { ...fixture.seed, seedVersion: 'duplicate-identity', products: [...fixture.seed.products, fixture.seed.products[0]] }, undefined],
  ]) {
    const result = await ctx.seed(seed, { allowFailure: true, ...(contractExpectation ? { contractExpectation } : {}) });
    assert.notEqual(result.exitCode, 0, `${label} rejects entire import`);
    assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before), `${label} has no partial writes`);
  }
  return ctx.pass();
});

const A04 = defineCase("A-04", async (ctx) => {
  const fixture = ctx.fixtures.main();
  const { api } = await prepare(ctx, fixture);
  const openapi = successful(await ctx.openApi(api.baseUrl), "OpenAPI", [200]);
  assertPublishedOpenApi(openapi.json, { exactBodies: true });
  const body = ctx.fixtures.quoteBody(fixture);
  const beforeMissing = await ctx.snapshot(api.baseUrl);
  const missingKey = await ctx.request(api.baseUrl, "/api/v1/orders/quotes", { method: "POST", json: body, contractExpectation: 'invalid' });
  assert.ok(missingKey.status >= 400 && missingKey.status < 500, "missing idempotency key rejected");
  assert.deepEqual(Object.keys(missingKey.json ?? {}).sort(), ["error"], "missing key error envelope");
  semanticError(missingKey, 400, 'VALIDATION_ERROR');
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(beforeMissing), 'missing key has no public side effects');
  const beforeMalformed = await ctx.snapshot(api.baseUrl);
  const malformed = await ctx.request(api.baseUrl, "/api/v1/orders/quotes", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ctx.key("malformed") },
    raw: "{",
    contractExpectation: 'invalid',
  });
  semanticError(malformed, 400, "MALFORMED_JSON");
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(beforeMalformed), "malformed JSON has no public side effect");
  const unknown = await ctx.mutate(api.baseUrl, "/api/v1/orders/quotes", ctx.key("unknown-field"), { ...body, unexpected: true }, { contractExpectation: 'invalid' });
  assert.equal(unknown.status, 400, "closed request rejects unknown member");
  assert.deepEqual(Object.keys(unknown.json ?? {}).sort(), ["error"], "unknown field error envelope");
  semanticError(unknown, 400, 'VALIDATION_ERROR');
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(beforeMalformed), 'unknown fields have no public side effects');
  return ctx.pass({ evidence: [{ paths: Object.keys(openapi.json.paths ?? {}).length, malformedStatus: malformed.status }] });
});

const A05 = defineCase("A-05", async ctx => {
  const fixture = ctx.fixtures.main(), { api } = await prepare(ctx, fixture);
  const products = successful(await ctx.request(api.baseUrl, `/api/v1/products?tenantId=${fixture.tenant.tenantId}`)).json;
  assertLiveSchema(null, '/api/v1/products', 'GET', 200, products);
  candidateAssert.equal(products.length, 2);
  assert(products.every(item => item.tenantId === fixture.tenant.tenantId));
  assert.deepEqual(products.map(item => item.productId), products.map(item => item.productId).sort());
  const before = await ctx.snapshot(api.baseUrl);
  assertSnapshotSchema(before);
  const scoped = await ctx.mutate(api.baseUrl, '/api/v1/orders/quotes', ctx.key('foreign-buyer'), ctx.fixtures.quoteBody(fixture, 'foreign-buyer', { buyerId: fixture.foreignBuyer.buyerId }));
  semanticError(scoped, 404, 'RESOURCE_NOT_FOUND');
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before), 'foreign Buyer rejected without writes');
  return ctx.pass();
});
const A06 = defineCase("A-06", async ctx => {
  const fixture = ctx.fixtures.quote(), { api } = await prepare(ctx, fixture);
  const quoted = await quote(ctx, api.baseUrl, fixture, 'before-new-offer');
  const before = await ctx.snapshot(api.baseUrl);
  const { offerVersionId: _id, version: _version, ...offerBody } = fixture.physicalOffer;
  const created = successful(await ctx.mutate(api.baseUrl, '/api/v1/offer-versions', ctx.key('new-offer'), { ...offerBody, unitPriceMinor: offerBody.unitPriceMinor + 100 }));
  assertLiveSchema(null, '/api/v1/offer-versions', 'POST', created.status, created.json);
  assert.equal(created.json.version, fixture.physicalOffer.version + 1);
  const path = `/api/v1/inventory-pools/${fixture.pools[0].inventoryPoolId}/adjustments`;
  const adjustment = successful(await ctx.mutate(api.baseUrl, path, ctx.key('stock-add'), { delta: 2, reason: 'Received units' }));
  assert.equal(adjustment.json.onHand, fixture.pools[0].onHand + 2);
  const after = await ctx.snapshot(api.baseUrl);
  assert.deepEqual(resource(after, 'orderLines').filter(item => item.orderId === quoted.orderId), resource(before, 'orderLines').filter(item => item.orderId === quoted.orderId), 'later offer cannot rewrite frozen lines');
  assertCoreInvariants(after);
  return ctx.pass();
});

const A07 = guardedCase("A-07", ["COMMERCE_CONSERVATION", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.quote();
  const { api } = await prepare(ctx, fixture);
  const before = await ctx.snapshot(api.baseUrl);
  const worked = await quote(ctx, api.baseUrl, fixture, "worked", { quantity: 6, holdTtlSeconds: 30 });
  const after = await ctx.snapshot(api.baseUrl);
  const expectedLines = expectedQuote(fixture, worked.body);
  assertQuoteEffects(before, after, worked.orderId, expectedLines);
  const line = resource(after, "orderLines").find(({ orderId }) => orderId === worked.orderId);
  const actualAllocations = resource(after, "inventoryHolds").filter(({ orderLineId }) => orderLineId === line.orderLineId).map(({ inventoryPoolId, quantity }) => ({ inventoryPoolId, quantity }));
  assertAllocations(actualAllocations, allocateByPriority(6, fixture.pools.filter(({ productId }) => productId === fixture.physical.productId)));
  const beforeInsufficient = await ctx.snapshot(api.baseUrl);
  const insufficient = await quote(ctx, api.baseUrl, fixture, "insufficient", { quantity: 3 }, { expectSuccess: false });
  semanticError(insufficient.response, 409, "INSUFFICIENT_INVENTORY");
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(beforeInsufficient), "insufficient quote is atomically rejected");
  assertCoreInvariants(after);

  await ctx.resetDatabase();
  const catalog = ctx.fixtures.largeCatalog(100);
  const { api: catalogApi } = await prepare(ctx, catalog);
  const hundred = { tenantId: catalog.tenant.tenantId, buyerId: catalog.buyer.buyerId, channel: "PARTNER", lines: catalog.products.map(({ productId }) => ({ productId, quantity: 1 })), holdTtlSeconds: 3_600 };
  const boundary = successful(await ctx.mutate(catalogApi.baseUrl, "/api/v1/orders/quotes", ctx.key("hundred-lines"), hundred), "100-line quote", [201]);
  assert.ok(boundary.json?.orderId, "100-line quote identity");
  const boundarySnapshot = await ctx.snapshot(catalogApi.baseUrl);
  assert.equal(resource(boundarySnapshot, "orderLines").filter(({ orderId }) => orderId === boundary.json.orderId).length, 100, "100 unique quote lines");
  assertCoreInvariants(boundarySnapshot);
  return ctx.pass({ evidence: [{ workedAllocation: actualAllocations, boundaryLines: 100 }] });
});

const A08 = guardedCase("A-08", ["IDEMPOTENCY_PROVIDER_IDENTITY"], async (ctx) => {
  const fixture = ctx.fixtures.payment();
  const { api, apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const quoted = await quote(ctx, api.baseUrl, fixture, "unknown");
  const key = ctx.key("checkout:unknown");
  const first = await checkout(ctx, api.baseUrl, quoted.orderId, "unknown", { key });
  const replay = await ctx.mutate(apis[1].baseUrl, `/api/v1/orders/${quoted.orderId}/checkout`, key, first.body);
  semanticReplay(first.response, replay);
  const raced = await Promise.all(Array.from({ length: 8 }, (_, index) => checkout(ctx, apis[index % 2].baseUrl, quoted.orderId, `distinct-${index}`, { expectSuccess: false })));
  assert.ok(raced.every(({ response }) => response.status < 500), "distinct checkout race has business outcomes");
  const pending = await ctx.snapshot(api.baseUrl);
  const attempts = resource(pending, "paymentAttempts").filter(({ orderId }) => orderId === quoted.orderId);
  candidateAssert.equal(attempts.length, 1, "one PaymentAttempt/provider operation");
  await providerCallback(ctx, api.baseUrl, first.providerRequestId, "unknown", "UNKNOWN", 0);
  const after = await ctx.snapshot(api.baseUrl);
  const order = resource(after, "orders").find(({ orderId }) => orderId === quoted.orderId);
  assert.equal(order.state, "PAYMENT_PENDING", "UNKNOWN remains pending");
  assert.ok(resource(after, "inventoryHolds").filter((hold) => attempts.some((attempt) => attempt.orderId === order.orderId) && hold.state === "HELD").length > 0, "UNKNOWN retains physical holds");
  assert.ok(after.work.some((work) => work.aggregateId === attempts[0].paymentAttemptId && work.kind === "PAYMENT_RECONCILIATION"), "UNKNOWN schedules reconciliation");
  assertCoreInvariants(after);
  return ctx.pass({ evidence: [{ orderId: quoted.orderId, paymentAttemptId: attempts[0].paymentAttemptId }] });
});

const A09 = guardedCase("A-09", ["COMMERCE_CONSERVATION", "IDEMPOTENCY_PROVIDER_IDENTITY", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.payment();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const quoted = await quote(ctx, apis[0].baseUrl, fixture, "precedence", {}, { mixed: true });
  const checked = await checkout(ctx, apis[0].baseUrl, quoted.orderId, "precedence");
  const pending = await ctx.snapshot(apis[0].baseUrl);
  const order = resource(pending, "orders").find(({ orderId }) => orderId === quoted.orderId);
  const results = await Promise.all([
    providerCallback(ctx, apis[0].baseUrl, checked.providerRequestId, "unknown", "UNKNOWN", 0),
    providerCallback(ctx, apis[1].baseUrl, checked.providerRequestId, "declined", "DECLINED", 0),
    providerCallback(ctx, apis[0].baseUrl, checked.providerRequestId, "captured", "CAPTURED", order.orderTotalMinor),
  ]);
  assert.ok(results.every(({ response }) => response.status < 500), "provider race has no server error");
  const captureBody = results[2].body;
  const conflict = await ctx.mutate(apis[1].baseUrl, "/api/v1/payment-provider/callbacks", ctx.key("provider-event-conflict"), { ...captureBody, outcome: "DECLINED", capturedMinor: 0 });
  semanticError(conflict, 409, "PROVIDER_EVENT_CONFLICT");
  const after = await ctx.snapshot(apis[0].baseUrl);
  const finalOrder = resource(after, "orders").find(({ orderId }) => orderId === quoted.orderId);
  assert.ok(["PAID", "FULFILLING", "FULFILLED"].includes(finalOrder.state), "CAPTURED precedence wins");
  assert.equal(resource(after, "paymentAttempts").filter((attempt) => attempt.orderId === quoted.orderId && (attempt.state === "CAPTURED" || attempt.outcome === "CAPTURED")).length, 1, "one captured attempt");
  assert.ok(resource(after, "fulfillmentPlans").some(({ orderId }) => orderId === quoted.orderId), "capture creates physical fulfillment");
  assert.ok(after.work.some((work) => work.aggregateId === quoted.orderId || resource(after, "orderLines").some((line) => line.orderId === quoted.orderId && line.orderLineId === work.aggregateId)), "capture creates fulfillment or entitlement Work");
  assertCoreInvariants(after);
  return ctx.pass({ evidence: [{ orderId: quoted.orderId, finalState: finalOrder.state }] });
});

const A10 = guardedCase('A-10', ['WORK_FENCING', 'COMMERCE_CONSERVATION', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const fixture = ctx.fixtures.fulfillment(), { api } = await prepare(ctx, fixture);
  const captured = await capture(ctx, api.baseUrl, fixture, 'physical-completion');
  const beforeClaim = await ctx.snapshot(api.baseUrl);
  const plans = resource(beforeClaim, 'fulfillmentPlans').filter(row => row.orderId === captured.orderId);
  assert.equal(plans.length, 1, 'single physical unit has one frozen fulfillment plan');
  const plan = plans[0], path = `/api/v1/fulfillment-plans/${plan.fulfillmentPlanId}/complete`;
  assert.equal(plan.state, 'PENDING');
  const held = await heldWorker(ctx, 'FULFILLMENT', { leaseSeconds: 60 });
  const entry = await held.wait(), claimed = await ctx.snapshot(api.baseUrl);
  const work = assertHeldClaim(claimed, entry);
  const leasedPlan = resource(claimed, 'fulfillmentPlans').find(row => row.fulfillmentPlanId === plan.fulfillmentPlanId);
  candidateAssert.equal(leasedPlan.fencingToken, work.fencingToken, 'plan exposes the actual current claim fence');
  assert.deepEqual(leasedPlan.lines, plan.lines, 'claim preserves frozen lines and pool quantities');
  semanticError(await ctx.mutate(api.baseUrl, path, ctx.key('wrong-fence'), { fencingToken: work.fencingToken + 1 }), 409, 'STALE_FENCE');
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(claimed), 'unowned token cannot commit any business effect');
  const key = ctx.key('physical-current-fence'), body = { fencingToken: work.fencingToken };
  const completed = successful(await ctx.mutate(api.baseUrl, path, key, body));
  assertLiveSchema(null, '/api/v1/fulfillment-plans/{fulfillmentPlanId}/complete', 'POST', completed.status, completed.json);
  assert.equal(completed.json.state, 'COMPLETED');
  assert.equal(completed.json.fulfillmentPlanId, plan.fulfillmentPlanId);
  assert.deepEqual(completed.json.lines, plan.lines);
  assert.ok(Number.isFinite(Date.parse(completed.json.completedAt)), 'completion is durably timestamped');
  const once = await ctx.snapshot(api.baseUrl);
  assertCaptureNotRepeated(beforeClaim, once);
  assertOrderEvidence(once, [captured.orderId]);
  assertCoreInvariants(once);
  semanticReplay(completed, await ctx.mutate(api.baseUrl, path, key, body));
  const repeated = await ctx.mutate(api.baseUrl, path, ctx.key('physical-repeat'), body);
  assert.ok((repeated.status >= 200 && repeated.status < 300) || repeated.status === 409, 'repeated completion has a valid no-op or conflict outcome');
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(once), 'duplicate completion cannot repeat stock, ledger, Event or notification effects');
  held.barrier.release(entry);
  const drained = await waitSnapshot(ctx, api.baseUrl, snapshot => snapshot.work.find(row => row.workId === work.workId)?.terminal, { processes: [held.worker] });
  assert.equal(drained.work.find(row => row.workId === work.workId).state, 'SUCCEEDED');
  for (const collection of ['fulfillmentPlans', 'inventoryPools', 'inventoryHolds', 'ledgerEntries', 'notificationDeliveries']) assert.deepEqual(resource(drained, collection), resource(once, collection), `${collection}: original Worker cannot duplicate an already completed effect`);
  assert.deepEqual(drained.events, once.events);
  await ctx.stop(held.worker);
  return ctx.pass({ evidence: [{ orderId: captured.orderId, fulfillmentPlanId: plan.fulfillmentPlanId, workId: work.workId, fencingToken: work.fencingToken, completedAt: completed.json.completedAt }] });
});
const A11 = defineCase("A-11", async ctx => {
  const fixture = ctx.fixtures.entitlement(), { api } = await prepare(ctx, fixture);
  const captured = await capture(ctx, api.baseUrl, fixture, 'grant-revoke', { quote: { productId: fixture.digital.productId } });
  const worker = await ctx.startWorker();
  const ready = await waitSnapshot(ctx, api.baseUrl, snapshot => resource(snapshot, 'entitlementGrants').some(item => item.orderId === captured.orderId && item.state === 'ACTIVE'), { processes: [worker] });
  const grant = resource(ready, 'entitlementGrants').find(item => item.orderId === captured.orderId);
  const path = `/api/v1/entitlement-grants/${grant.entitlementGrantId}/revoke`, key = ctx.key('revoke');
  const first = successful(await ctx.mutate(api.baseUrl, path, key, {}));
  assertLiveSchema(null, '/api/v1/entitlement-grants/{entitlementGrantId}/revoke', 'POST', first.status, first.json);
  assert.equal(first.json.state, 'REVOKED');
  semanticReplay(first, await ctx.mutate(api.baseUrl, path, key, {}));
  assert.equal(resource(await ctx.snapshot(api.baseUrl), 'entitlementGrants').filter(item => item.orderLineId === grant.orderLineId && item.grantRevision === grant.grantRevision).length, 1);
  return ctx.pass();
});
const A12 = defineCase("A-12", async ctx => {
  const fixture = ctx.fixtures.payment(), { api } = await prepare(ctx, fixture);
  const quoted = await quote(ctx, api.baseUrl, fixture, 'cancel');
  const cancelled = successful(await ctx.mutate(api.baseUrl, `/api/v1/orders/${quoted.orderId}/cancel`, ctx.key('cancel'), {}));
  assert.equal(cancelled.json.state, 'CANCELLED');
  const captured = await capture(ctx, api.baseUrl, fixture, 'refund');
  const before = await ctx.snapshot(api.baseUrl), line = resource(before, 'orderLines').find(item => item.orderId === captured.orderId);
  const body = { amountMinor: captured.orderTotalMinor, reason: 'Returned physical item', restockLines: [{ orderLineId: line.orderLineId, quantity: line.quantity }] };
  const path = `/api/v1/orders/${captured.orderId}/refunds`, key = ctx.key('refund');
  const refunded = successful(await ctx.mutate(api.baseUrl, path, key, body));
  assertLiveSchema(null, '/api/v1/orders/{orderId}/refunds', 'POST', refunded.status, refunded.json);
  semanticReplay(refunded, await ctx.mutate(api.baseUrl, path, key, body));
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(after, 'orders').find(item => item.orderId === captured.orderId).state, 'REFUNDED');
  assert.equal(resource(after, 'refunds').filter(item => item.orderId === captured.orderId).length, 1);
  const stock = snapshot => resource(snapshot, 'inventoryPools').filter(item => item.productId === fixture.physical.productId).reduce((sum, item) => sum + item.onHand, 0);
  assert.equal(stock(after) - stock(before), line.quantity);
  assertCoreInvariants(after);
  return ctx.pass();
});

const A13 = guardedCase("A-13", ["COMMERCE_CONSERVATION", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.ledger();
  const { api } = await prepare(ctx, fixture);
  const captured = await capture(ctx, api.baseUrl, fixture, "ledger", { mixed: true });
  const first = captured.callback.response;
  const replay = await ctx.mutate(api.baseUrl, "/api/v1/payment-provider/callbacks", ctx.key("callback:ledger"), captured.callback.body);
  semanticReplay(first, replay);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assertCoreInvariants(snapshot);
  const orderEvents = snapshot.events.filter(({ aggregateId }) => aggregateId === captured.orderId);
  candidateAssert.ok(orderEvents.length >= 2, "quote and capture Events retained");
  assert.ok(resource(snapshot, "ledgerEntries").some(({ orderId }) => orderId === captured.orderId), "capture journal retained");
  const eventIds = new Set(orderEvents.map(({ eventId }) => eventId));
  assert.ok(resource(snapshot, "notificationDeliveries").filter(({ orderId }) => orderId === captured.orderId).every(({ eventId }) => eventIds.has(eventId)), "notifications reference immutable Events");
  return ctx.pass({ evidence: [{ orderId: captured.orderId, eventCount: orderEvents.length, journalEntries: resource(snapshot, "ledgerEntries").filter(({ orderId }) => orderId === captured.orderId).length }] });
});

const A14 = defineCase('A-14', async ctx => {
  const fixture = ctx.fixtures.marketplace(), { api } = await prepare(ctx, fixture);
  const quoted = await quote(ctx, api.baseUrl, fixture, 'seller-allocation', { quantity: 2 });
  const line = resource(await ctx.snapshot(api.baseUrl), 'orderLines').find(item => item.orderId === quoted.orderId);
  const body = { allocations: fixture.sellers.map(seller => ({ orderLineId: line.orderLineId, sellerId: seller.sellerId, quantity: 1, amountMinor: line.lineTotalMinor / 2 })) };
  const path = `/api/v1/orders/${quoted.orderId}/seller-allocations`, key = ctx.key('seller-allocations');
  const first = successful(await ctx.mutate(api.baseUrl, path, key, body));
  assertLiveSchema(null, '/api/v1/orders/{orderId}/seller-allocations', 'POST', first.status, first.json);
  assert.equal(first.json.length, 2);
  semanticReplay(first, await ctx.mutate(api.baseUrl, path, key, body));
  const saved = resource(await ctx.snapshot(api.baseUrl), 'sellerAllocations').filter(item => item.orderId === quoted.orderId);
  assert.equal(saved.reduce((sum, item) => sum + item.quantity, 0), line.quantity);
  assert.equal(saved.reduce((sum, item) => sum + item.amountMinor, 0), line.lineTotalMinor);
  const changed = await ctx.mutate(api.baseUrl, path, ctx.key('allocation-reassignment'), { allocations: [{ orderLineId: line.orderLineId, sellerId: fixture.sellers[0].sellerId, quantity: 2, amountMinor: line.lineTotalMinor }] });
  candidateAssert.equal(changed.status, 409, 'first allocation set is immutable');
  const settlement = successful(await ctx.mutate(api.baseUrl, '/api/v1/seller-settlements', ctx.key('settlement'), { tenantId: fixture.tenant.tenantId, sellerId: fixture.sellers[0].sellerId, periodStart: ctx.at({ days: -1 }), periodEnd: ctx.at({ days: 1 }), currency: 'USD' }));
  assertLiveSchema(null, '/api/v1/seller-settlements', 'POST', settlement.status, settlement.json);
  assert.equal(settlement.json.state, 'OPEN');
  // An allocation present when OPEN is created is not eligible until capture.
  const empty = successful(await ctx.mutate(api.baseUrl, `/api/v1/seller-settlements/${settlement.json.sellerSettlementId}/close`, ctx.key('empty-close'), {}));
  assertSettlement(empty.json, { allocationIds: [], grossMinor: 0, feeMinor: 0, refundReserveMinor: 0, disputeReserveMinor: 0, netMinor: 0 });
  const checked = await checkout(ctx, api.baseUrl, quoted.orderId, 'allocation-capture');
  await providerCallback(ctx, api.baseUrl, checked.providerRequestId, 'allocation-capture', 'CAPTURED', line.lineTotalMinor);
  successful(await ctx.mutate(api.baseUrl, `/api/v1/orders/${quoted.orderId}/refunds`, ctx.key('partial-refund'), { amountMinor: 101, reason: 'Partial refund before close', restockLines: [] }));
  const attempt = resource(await ctx.snapshot(api.baseUrl), 'paymentAttempts').find(item => item.orderId === quoted.orderId);
  successful(await ctx.mutate(api.baseUrl, '/api/v1/commerce-disputes', ctx.key('reserved-dispute'), { tenantId: fixture.tenant.tenantId, paymentAttemptId: attempt.paymentAttemptId, providerDisputeId: ctx.uuid('reserved-dispute'), amountMinor: 50 }));
  for (const [index, seller] of fixture.sellers.entries()) {
    const proposed = successful(await ctx.mutate(api.baseUrl, '/api/v1/seller-settlements', ctx.key(`captured-settlement:${index}`), { tenantId: fixture.tenant.tenantId, sellerId: seller.sellerId, periodStart: ctx.at({ days: 1 }), periodEnd: ctx.at({ days: 2 }), currency: 'USD' })).json;
    const expected = settlementProjection(await ctx.snapshot(api.baseUrl), proposed);
    assert.equal(expected.allocationIds.length, 1, 'captured allocation eligible despite future batch label');
    const closePath = `/api/v1/seller-settlements/${proposed.sellerSettlementId}/close`, closeKey = ctx.key(`close:${index}`);
    const closed = successful(await ctx.mutate(api.baseUrl, closePath, closeKey, {}));
    assertSettlement(closed.json, expected);
    semanticReplay(closed, await ctx.mutate(api.baseUrl, closePath, closeKey, {}));
    assert.deepEqual(successful(await ctx.mutate(api.baseUrl, closePath, ctx.key(`close-again:${index}`), {})).json, closed.json, 'distinct close never recomputes CLOSED projection');
  }
  assertCoreInvariants(await ctx.snapshot(api.baseUrl));
  return ctx.pass({ evidence: [{ policyRevision: '2026-09-07.1', uncapturedExcluded: true, closedSellers: 2 }] });
});
const A15 = defineCase('A-15', async ctx => {
  const fixture = ctx.fixtures.marketplace(), { api } = await prepare(ctx, fixture);
  const captured = await quote(ctx, api.baseUrl, fixture, 'dispute');
  const line = resource(await ctx.snapshot(api.baseUrl), 'orderLines').find(item => item.orderId === captured.orderId);
  captured.orderTotalMinor = line.lineTotalMinor;
  const allocated = successful(await ctx.mutate(api.baseUrl, `/api/v1/orders/${captured.orderId}/seller-allocations`, ctx.key('dispute-allocation'), { allocations: [{ orderLineId: line.orderLineId, sellerId: fixture.sellers[0].sellerId, quantity: line.quantity, amountMinor: line.lineTotalMinor }] })).json;
  const checked = await checkout(ctx, api.baseUrl, captured.orderId, 'dispute');
  await providerCallback(ctx, api.baseUrl, checked.providerRequestId, 'dispute', 'CAPTURED', captured.orderTotalMinor);
  const capturedState = await ctx.snapshot(api.baseUrl);
  const attempt = resource(capturedState, 'paymentAttempts').find(item => item.orderId === captured.orderId);
  const opened = successful(await ctx.mutate(api.baseUrl, '/api/v1/commerce-disputes', ctx.key('dispute'), { tenantId: fixture.tenant.tenantId, paymentAttemptId: attempt.paymentAttemptId, providerDisputeId: ctx.uuid('provider-dispute'), amountMinor: 100 }));
  assertLiveSchema(null, '/api/v1/commerce-disputes', 'POST', opened.status, opened.json);
  const before = await ctx.snapshot(api.baseUrl);
  const conflict = await ctx.mutate(api.baseUrl, `/api/v1/orders/${captured.orderId}/refunds`, ctx.key('refund-reserved'), { amountMinor: captured.orderTotalMinor, reason: 'Conflicts with dispute reserve', restockLines: [] });
  semanticError(conflict, 409, 'RESERVE_EXCEEDS_CAPTURE');
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before), 'reserve bound rejects atomically');
  const proposed = successful(await ctx.mutate(api.baseUrl, '/api/v1/seller-settlements', ctx.key('dispute-settlement'), { tenantId: fixture.tenant.tenantId, sellerId: fixture.sellers[0].sellerId, periodStart: ctx.at({ days: -1 }), periodEnd: ctx.at({ days: 1 }), currency: 'USD' })).json;
  const expected = settlementProjection(await ctx.snapshot(api.baseUrl), proposed);
  const closed = successful(await ctx.mutate(api.baseUrl, `/api/v1/seller-settlements/${proposed.sellerSettlementId}/close`, ctx.key('dispute-close'), {})).json;
  assertSettlement(closed, expected);
  assert.equal(closed.disputeReserveMinor, 100, 'OPEN amount withheld once at close');
  const next = successful(await ctx.mutate(api.baseUrl, '/api/v1/seller-settlements', ctx.key('next-period'), { tenantId: fixture.tenant.tenantId, sellerId: closed.sellerId, periodStart: ctx.at({ days: 2 }), periodEnd: ctx.at({ days: 3 }), currency: 'USD' })).json;
  const worker = await ctx.startWorker();
  const path = `/api/v1/commerce-disputes/${opened.json.commerceDisputeId}/resolve`, key = ctx.key('dispute-lost'), body = { providerEventId: 'lost-dispute-event', outcome: 'LOST' };
  const resolved = successful(await ctx.mutate(api.baseUrl, path, key, body));
  assertLiveSchema(null, '/api/v1/commerce-disputes/{commerceDisputeId}/resolve', 'POST', resolved.status, resolved.json);
  assert.equal(resolved.json.state, 'LOST');
  const once = await waitSnapshot(ctx, api.baseUrl, snapshot => resource(snapshot, 'settlementAdjustments').some(item => item.sourceSettlementId === closed.sellerSettlementId), { processes: [worker], label: 'LOST liability adjustment becomes durable' });
  assert(resource(once, 'ledgerEntries').length > resource(before, 'ledgerEntries').length, 'LOST records a chargeback journal');
  const beforeEntryIds = new Set(resource(before, 'ledgerEntries').map(item => item.ledgerEntryId));
  const chargeback = resource(once, 'ledgerEntries').filter(item => !beforeEntryIds.has(item.ledgerEntryId));
  assert.equal(new Set(chargeback.map(item => item.journalId)).size, 1, 'one new chargeback journal');
  assert.equal(chargeback.filter(item => item.account === 'ORDER_LIABILITY' && item.direction === 'DEBIT').reduce((total, item) => total + item.amountMinor, 0), 100);
  assert.equal(chargeback.filter(item => item.account === 'CASH' && item.direction === 'CREDIT').reduce((total, item) => total + item.amountMinor, 0), 100);
  semanticReplay(resolved, await ctx.mutate(api.baseUrl, path, key, body));
  assert.deepEqual(resource(await ctx.snapshot(api.baseUrl), 'ledgerEntries'), resource(once, 'ledgerEntries'), 'LOST replay cannot charge back twice');
  const liabilities = resource(once, 'settlementAdjustments').filter(item => item.sourceSettlementId === closed.sellerSettlementId);
  assert.equal(liabilities.length, 1, 'one durable seller-liability acknowledgement');
  assert.equal(liabilities[0].sourceAllocationId, allocated[0].sellerAllocationId);
  assert.equal(liabilities[0].amountMinor, withholdingAdjustment({ refundReserveMinor: 0, disputeReserveMinor: 100 }, { refundReserveMinor: 0, disputeReserveMinor: 100 }), 'reserved LOST cannot debit seller twice');
  assert.equal(liabilities[0].targetPeriodStart, nextAdjustmentPeriod(once, closed));
  assert.deepEqual(resource(once, 'sellerSettlements').find(item => item.sellerSettlementId === closed.sellerSettlementId), closed, 'late resolution cannot mutate frozen settlement');
  const correctionBody = { tenantId: closed.tenantId, sellerId: closed.sellerId, sourceSettlementId: closed.sellerSettlementId, sourceAllocationId: allocated[0].sellerAllocationId, amountMinor: -7, reason: 'Published signed correction' };
  const correctionKey = ctx.key('correction');
  const correction = successful(await ctx.mutate(api.baseUrl, '/api/v1/settlement-adjustments', correctionKey, correctionBody));
  assert.equal(correction.json.targetPeriodStart, next.periodStart);
  semanticReplay(correction, await ctx.mutate(api.baseUrl, '/api/v1/settlement-adjustments', correctionKey, correctionBody));
  const nextExpected = settlementProjection(await ctx.snapshot(api.baseUrl), next);
  assert.equal(nextExpected.netMinor, -7, 'negative settlement net remains observable');
  assertSettlement(successful(await ctx.mutate(api.baseUrl, `/api/v1/seller-settlements/${next.sellerSettlementId}/close`, ctx.key('next-close'), {})).json, nextExpected);
  assertCoreInvariants(once);
  return ctx.pass({ evidence: [{ policyRevision: '2026-09-07.1', chargebackJournals: 1, nextNetMinor: -7 }] });
});

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14, A15]);
