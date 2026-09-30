import assert from "node:assert/strict";
import { assertCoreInvariants, assertQuoteEffects, allocateByPriority, resource, stableSnapshot } from "../oracles/index.mjs";
import { assertPublishedOpenApi } from "../oracles/openapi.mjs";
import { blockedCase, capture, checkout, defineCase, diagnostic, expectedQuote, guardedCase, prepare, providerCallback, quote, semanticError, semanticReplay, successful } from "./helpers.mjs";

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

const A03 = blockedCase("A-03", [["CC-A03-SEED-WIRE", "CC-GAP-07"]]);

const A04 = defineCase("A-04", async (ctx) => {
  const fixture = ctx.fixtures.main();
  const { api } = await prepare(ctx, fixture);
  const openapi = successful(await ctx.openApi(api.baseUrl), "OpenAPI", [200]);
  assertPublishedOpenApi(openapi.json, { exactBodies: true });
  const body = ctx.fixtures.quoteBody(fixture);
  const missingKey = await ctx.request(api.baseUrl, "/api/v1/orders/quotes", { method: "POST", json: body });
  assert.ok(missingKey.status >= 400 && missingKey.status < 500, "missing idempotency key rejected");
  assert.deepEqual(Object.keys(missingKey.json ?? {}).sort(), ["error"], "missing key error envelope");
  const beforeMalformed = await ctx.snapshot(api.baseUrl);
  const malformed = await ctx.request(api.baseUrl, "/api/v1/orders/quotes", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ctx.key("malformed") },
    raw: "{",
  });
  semanticError(malformed, 400, "MALFORMED_JSON");
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(beforeMalformed), "malformed JSON has no public side effect");
  const unknown = await ctx.mutate(api.baseUrl, "/api/v1/orders/quotes", ctx.key("unknown-field"), { ...body, unexpected: true });
  assert.equal(unknown.status, 400, "closed request rejects unknown member");
  assert.deepEqual(Object.keys(unknown.json ?? {}).sort(), ["error"], "unknown field error envelope");
  return ctx.pass({ diagnostics: [diagnostic("CC-A04-ERROR-MAPPING", "CC-GAP-09")], evidence: [{ paths: Object.keys(openapi.json.paths ?? {}).length, malformedStatus: malformed.status }] });
});

const A05 = blockedCase("A-05", [["CC-A05-WIRE-SORT", "CC-GAP-07"]]);
const A06 = blockedCase("A-06", [["CC-A06-MUTATION-WIRE", "CC-GAP-08"]]);

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
  assert.deepEqual(actualAllocations, allocateByPriority(6, fixture.pools.filter(({ productId }) => productId === fixture.physical.productId)), "worked split A=3/B=3 by priority and ID");
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
  assert.equal(attempts.length, 1, "one PaymentAttempt/provider operation");
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

const A10 = blockedCase("A-10", [["CC-A10-COMPLETE-WIRE", "CC-GAP-08"]]);
const A11 = blockedCase("A-11", [["CC-A11-REVOKE-WIRE", "CC-GAP-08"]]);
const A12 = blockedCase("A-12", [["CC-A12-MUTATION-WIRE", "CC-GAP-08"], ["CC-A12-ERROR-MAPPING", "CC-GAP-09"]]);

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
  assert.ok(orderEvents.length >= 2, "quote and capture Events retained");
  assert.ok(resource(snapshot, "ledgerEntries").some(({ orderId }) => orderId === captured.orderId), "capture journal retained");
  const eventIds = new Set(orderEvents.map(({ eventId }) => eventId));
  assert.ok(resource(snapshot, "notificationDeliveries").filter(({ orderId }) => orderId === captured.orderId).every(({ eventId }) => eventIds.has(eventId)), "notifications reference immutable Events");
  return ctx.pass({ evidence: [{ orderId: captured.orderId, eventCount: orderEvents.length, journalEntries: resource(snapshot, "ledgerEntries").filter(({ orderId }) => orderId === captured.orderId).length }] });
});

const A14 = blockedCase("A-14", [["CC-A14-MANAGER-WIRE", "CC-GAP-02"], ["CC-A14-FINAL-SEED", "CC-GAP-05"], ["CC-A14-SETTLEMENT-FORMULA", "CC-GAP-10"]]);
const A15 = blockedCase("A-15", [["CC-A15-MANAGER-WIRE", "CC-GAP-02"], ["CC-A15-FINAL-SEED", "CC-GAP-05"], ["CC-A15-SETTLEMENT-FORMULA", "CC-GAP-10"]]);

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14, A15]);
