import assert from "node:assert/strict";
import { candidateAssert } from '../lib/execution.mjs';
import { assertCoreInvariants, allocateByPriority, assertAllocations, canonicalJson, resource, stableSnapshot } from "../oracles/index.mjs";
import { assertSettlement, projectOrder, settlementProjection, withholdingAdjustment } from '../oracles/economic-policy.mjs';
import { capture, checkout, guardedCase, prepare, providerCallback, quote, semanticError, semanticReplay, successful, waitSnapshot } from "./helpers.mjs";

const B01 = guardedCase("B-01", ["COMMERCE_CONSERVATION"], async (ctx) => {
  const fixture = ctx.fixtures.quote();
  const { api } = await prepare(ctx, fixture);
  const worked = await quote(ctx, api.baseUrl, fixture, "allocation", { quantity: 6 });
  const quoted = await ctx.snapshot(api.baseUrl);
  const line = resource(quoted, "orderLines").find(({ orderId }) => orderId === worked.orderId);
  const actual = resource(quoted, "inventoryHolds").filter(({ orderLineId }) => orderLineId === line.orderLineId).map(({ inventoryPoolId, quantity }) => ({ inventoryPoolId, quantity }));
  assertAllocations(actual, allocateByPriority(6, fixture.pools.filter(({ productId }) => productId === fixture.physical.productId)));
  const checked = await checkout(ctx, api.baseUrl, worked.orderId, "allocation");
  const order = resource(await ctx.snapshot(api.baseUrl), "orders").find(({ orderId }) => orderId === worked.orderId);
  await providerCallback(ctx, api.baseUrl, checked.providerRequestId, "allocation", "CAPTURED", order.orderTotalMinor);
  const captured = await ctx.snapshot(api.baseUrl);
  assert.ok(resource(captured, "inventoryHolds").filter(({ orderLineId }) => orderLineId === line.orderLineId).every(({ state }) => state === "CONSUMED"), "capture consumes each hold exactly once");
  assertCoreInvariants(captured);
  return ctx.pass({ evidence: [{ orderId: worked.orderId, allocations: actual }] });
});

const B02 = guardedCase("B-02", ["COMMERCE_CONSERVATION", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.quote();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const responses = await ctx.concurrent(Array.from({ length: 160 }), 64, (_, index) => ctx.mutate(
    apis[index % 2].baseUrl,
    "/api/v1/orders/quotes",
    ctx.key(`hot:${index}`),
    ctx.fixtures.quoteBody(fixture, `hot:${index}`, { quantity: 1 }),
  ));
  assert.ok(responses.every(({ status }) => [201, 409].includes(status)), "hot stock returns success or INSUFFICIENT_INVENTORY");
  assert.equal(responses.filter(({ status }) => status === 201).length, 8, "exact aggregate capacity succeeds");
  for (const response of responses.filter(({ status }) => status === 409)) semanticError(response, 409, "INSUFFICIENT_INVENTORY");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  assert.equal(resource(snapshot, "orders").length, 8, "no partial rejected Orders");
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ successes: 8, rejected: 152 }] });
});

const B03 = guardedCase("B-03", ["IDEMPOTENCY_PROVIDER_IDENTITY", "COMMERCE_CONSERVATION"], async (ctx) => {
  const fixture = ctx.fixtures.payment();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const quoted = await quote(ctx, apis[0].baseUrl, fixture, "provider-race");
  const checked = await checkout(ctx, apis[0].baseUrl, quoted.orderId, "provider-race");
  const pending = await ctx.snapshot(apis[0].baseUrl);
  const total = resource(pending, "orders").find(({ orderId }) => orderId === quoted.orderId).orderTotalMinor;
  const payloads = [
    { label: "unknown", event: "provider-unknown", outcome: "UNKNOWN", amount: 0 },
    { label: "decline", event: "provider-decline", outcome: "DECLINED", amount: 0 },
    { label: "capture", event: "provider-capture", outcome: "CAPTURED", amount: total },
    { label: "capture-duplicate", event: "provider-capture", outcome: "CAPTURED", amount: total },
  ];
  const responses = await ctx.concurrent(payloads, 4, (item, index) => providerCallback(ctx, apis[index % 2].baseUrl, checked.providerRequestId, item.label, item.outcome, item.amount, { providerEventId: item.event, key: ctx.key(`provider:${item.label}`), expectSuccess: false }));
  assert.ok(responses.every(({ response }) => response.status < 500), "provider precedence race has business outcomes");
  const conflict = await providerCallback(ctx, apis[1].baseUrl, checked.providerRequestId, "conflict", "DECLINED", 0, { providerEventId: "provider-capture", expectSuccess: false });
  semanticError(conflict.response, 409, "PROVIDER_EVENT_CONFLICT");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  const order = resource(snapshot, "orders").find(({ orderId }) => orderId === quoted.orderId);
  assert.ok(["PAID", "FULFILLING", "FULFILLED"].includes(order.state), "CAPTURED wins precedence");
  assert.equal(resource(snapshot, "paymentAttempts").filter((attempt) => attempt.orderId === quoted.orderId && (attempt.state === "CAPTURED" || attempt.outcome === "CAPTURED")).length, 1, "one capture");
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ orderId: quoted.orderId, winner: "CAPTURED" }] });
});

const B04 = guardedCase("B-04", ["IDEMPOTENCY_PROVIDER_IDENTITY", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.idempotency();
  const { api } = await prepare(ctx, fixture);
  const shield = await ctx.responseShield(api.baseUrl);
  const quoteKey = ctx.key("lost:quote");
  const quoteBody = ctx.fixtures.quoteBody(fixture, "lost", { quantity: 2 });
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, "/api/v1/orders/quotes", quoteKey, quoteBody).catch(() => undefined);
  const quoteCapture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "committed quote response loss" });
  const quotedResponse = JSON.parse(quoteCapture.response.body);
  await ctx.stop(api);
  let restarted = await ctx.startApi();
  const quoteReplay = await ctx.mutate(restarted.baseUrl, "/api/v1/orders/quotes", quoteKey, quoteBody);
  assert.equal(quoteReplay.status, quoteCapture.response.status, "lost quote status replay");
  assert.equal(canonicalJson(quoteReplay.json), canonicalJson(quotedResponse), "lost quote body replay");
  const orderId = quotedResponse.orderId;
  assert.ok(orderId, "lost quote returned top-level orderId");

  const checkoutKey = ctx.key("lost:checkout");
  const checkoutBody = { provider: "SANDBOX", providerRequestId: `provider-${ctx.key("lost")}` };
  const secondShield = await ctx.responseShield(restarted.baseUrl);
  secondShield.dropNextMutation();
  await ctx.mutate(secondShield.baseUrl, `/api/v1/orders/${orderId}/checkout`, checkoutKey, checkoutBody).catch(() => undefined);
  const checkoutCapture = await ctx.waitFor(() => secondShield.captures.find(({ dropped }) => dropped), { label: "committed checkout response loss" });
  await ctx.stop(restarted);
  restarted = await ctx.startApi();
  const checkoutReplay = await ctx.mutate(restarted.baseUrl, `/api/v1/orders/${orderId}/checkout`, checkoutKey, checkoutBody);
  assert.equal(checkoutReplay.status, checkoutCapture.response.status, "lost checkout status replay");
  assert.equal(canonicalJson(checkoutReplay.json), canonicalJson(JSON.parse(checkoutCapture.response.body)), "lost checkout body replay");

  const before = await ctx.snapshot(restarted.baseUrl);
  const order = resource(before, "orders").find((item) => item.orderId === orderId);
  const callbackKey = ctx.key("lost:callback");
  const callbackBody = { providerEventId: `event-${ctx.key("lost")}`, providerRequestId: checkoutBody.providerRequestId, outcome: "CAPTURED", capturedMinor: order.orderTotalMinor };
  const thirdShield = await ctx.responseShield(restarted.baseUrl);
  thirdShield.dropNextMutation();
  await ctx.mutate(thirdShield.baseUrl, "/api/v1/payment-provider/callbacks", callbackKey, callbackBody).catch(() => undefined);
  const callbackCapture = await ctx.waitFor(() => thirdShield.captures.find(({ dropped }) => dropped), { label: "committed callback response loss" });
  const callbackReplay = await ctx.mutate(restarted.baseUrl, "/api/v1/payment-provider/callbacks", callbackKey, callbackBody);
  assert.equal(callbackReplay.status, callbackCapture.response.status, "lost callback status replay");
  assert.equal(canonicalJson(callbackReplay.json), canonicalJson(JSON.parse(callbackCapture.response.body)), "lost callback body replay");
  const snapshot = await ctx.snapshot(restarted.baseUrl);
  assert.equal(resource(snapshot, "orders").filter((item) => item.orderId === orderId).length, 1, "one Order after unknown responses");
  assert.equal(resource(snapshot, "paymentAttempts").filter((item) => item.orderId === orderId).length, 1, "one PaymentAttempt after unknown responses");
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ orderId, droppedMutations: 3 }] });
});

const B05 = guardedCase("B-05", ["IDEMPOTENCY_PROVIDER_IDENTITY"], async (ctx) => {
  const fixture = ctx.fixtures.idempotency();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const key = ctx.key("same-key");
  const body = ctx.fixtures.quoteBody(fixture, "same-key", { quantity: 1 });
  const responses = await ctx.concurrent(Array.from({ length: 64 }), 64, (_, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/orders/quotes", key, body));
  candidateAssert.ok(responses.every(({ status }) => status === responses[0].status), "same key one status authority");
  assert.ok(responses.every(({ json }) => canonicalJson(json) === canonicalJson(responses[0].json)), "same key one body authority");
  const conflict = await ctx.mutate(apis[1].baseUrl, "/api/v1/orders/quotes", key, ctx.fixtures.quoteBody(fixture, "same-key-conflict", { quantity: 2 }));
  semanticError(conflict, 409, "IDEMPOTENCY_CONFLICT");
  await ctx.stop(apis[0]);
  const third = await ctx.startApi();
  semanticReplay(responses[0], await ctx.mutate(third.baseUrl, "/api/v1/orders/quotes", key, body));
  const snapshot = await ctx.snapshot(third.baseUrl);
  assert.equal(resource(snapshot, "orders").filter(({ orderId }) => orderId === responses[0].json.orderId).length, 1, "one same-key business effect");
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ contenders: 64, orderId: responses[0].json.orderId }] });
});

const B06 = guardedCase("B-06", ["COMMERCE_CONSERVATION", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.payment();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const quoted = await quote(ctx, apis[0].baseUrl, fixture, "terminal-race", { holdTtlSeconds: 30 });
  const providerRequestId = `provider-${ctx.key("terminal-race")}`;
  const order = resource(await ctx.snapshot(apis[0].baseUrl), "orders").find(({ orderId }) => orderId === quoted.orderId);
  const worker = await ctx.startWorker();
  const outcomes = await Promise.all([
    ctx.mutate(apis[0].baseUrl, `/api/v1/orders/${quoted.orderId}/checkout`, ctx.key("terminal:checkout"), { provider: "SANDBOX", providerRequestId }),
    ctx.mutate(apis[1].baseUrl, "/api/v1/payment-provider/callbacks", ctx.key("terminal:capture"), { providerEventId: `event-${ctx.key("terminal")}`, providerRequestId, outcome: "CAPTURED", capturedMinor: order.orderTotalMinor }),
    ctx.mutate(apis[0].baseUrl, "/api/v1/payment-provider/callbacks", ctx.key("terminal:decline"), { providerEventId: `decline-${ctx.key("terminal")}`, providerRequestId, outcome: "DECLINED", capturedMinor: 0 }),
  ]);
  assert.ok(outcomes.every(({ status }) => status < 500), "terminal race has only business outcomes");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  const holds = resource(snapshot, "inventoryHolds").filter((hold) => resource(snapshot, "orderLines").some((line) => line.orderId === quoted.orderId && line.orderLineId === hold.orderLineId));
  assert.equal(holds.some(({ state }) => state === "CONSUMED") && holds.some(({ state }) => ["RELEASED", "EXPIRED"].includes(state)), false, "one serialized inventory terminal winner");
  assertCoreInvariants(snapshot);
  await ctx.stop(worker);
  return ctx.pass({ evidence: [{ orderId: quoted.orderId, statuses: outcomes.map(({ status }) => status) }] });
});

export function assertRefundRaceResponses(responses) {
  const conflicts = new Set(['REFUND_EXCEEDS_CAPTURE', 'INVALID_ORDER_STATE', 'INSUFFICIENT_INVENTORY', 'RESERVE_EXCEEDS_CAPTURE']);
  candidateAssert.ok(responses.every(({status,json}) => status >= 200 && status < 300
    || (status === 400 && json?.error?.code === 'VALIDATION_ERROR')
    || (status === 409 && conflicts.has(json?.error?.code))), 'refund race success or public remaining-quantity rejection only');
  candidateAssert.equal(responses.filter(({status}) => status >= 200 && status < 300).length, 1, 'only one half refund with full restock commits');
}

const B07 = guardedCase("B-07", ["COMMERCE_CONSERVATION", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.ledger();
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const captured = await capture(ctx, apis[0].baseUrl, fixture, "refund-race", { quote: { quantity: 4 } });
  const before = await ctx.snapshot(apis[0].baseUrl);
  const line = resource(before, "orderLines").find(({ orderId }) => orderId === captured.orderId);
  const amountMinor = Math.floor(captured.orderTotalMinor / 2);
  const responses = await ctx.concurrent(Array.from({ length: 12 }), 12, (_, index) => ctx.mutate(
    apis[index % 2].baseUrl,
    `/api/v1/orders/${captured.orderId}/refunds`,
    ctx.key(`refund:${index}`),
    { amountMinor, reason: "concurrent returned units", restockLines: [{ orderLineId: line.orderLineId, quantity: 4 }] },
  ));
  assertRefundRaceResponses(responses);
  const after = await ctx.snapshot(apis[0].baseUrl);
  const order = resource(after, "orders").find(({ orderId }) => orderId === captured.orderId);
  assert.ok(order.refundedMinor <= order.capturedMinor, "refund bound");
  const beforeStock = resource(before, "inventoryPools").filter(({ productId }) => productId === fixture.physical.productId).reduce((sum, pool) => sum + pool.onHand, 0);
  const afterStock = resource(after, "inventoryPools").filter(({ productId }) => productId === fixture.physical.productId).reduce((sum, pool) => sum + pool.onHand, 0);
  assert.equal(afterStock - beforeStock, 4, "declared physical units restocked once");
  assertCoreInvariants(after);
  return ctx.pass({ evidence: [{ successes: 1, rejections: 11, responses: responses.map(({status,json})=>({status,code:json?.error?.code})), refundedMinor: order.refundedMinor }] });
});

const B08 = guardedCase("B-08", ["COMMERCE_CONSERVATION", "WORK_FENCING"], async (ctx) => {
  const fixture = ctx.fixtures.fulfillment();
  const { api } = await prepare(ctx, fixture);
  const captured = [];
  for (let index = 0; index < 8; index += 1) captured.push(await capture(ctx, api.baseUrl, fixture, `mixed-${index}`, { mixed: true }));
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const refunded = captured.slice(0, 4);
  await Promise.all(refunded.map((item, index) => ctx.mutate(api.baseUrl, `/api/v1/orders/${item.orderId}/refunds`, ctx.key(`full-refund:${index}`), { amountMinor: item.orderTotalMinor, reason: "full digital and physical convergence", restockLines: [] })));
  const orderIds = new Set(captured.map(({ orderId }) => orderId));
  const snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => {
    const selected = value.work.filter((work) => orderIds.has(work.aggregateId) || resource(value, "orderLines").some((line) => orderIds.has(line.orderId) && line.orderLineId === work.aggregateId));
    return selected.length > 0 && selected.every(({ terminal }) => terminal);
  }, { timeoutMs: 180_000, processes: workers, label: "fulfillment and entitlement Work drain" });
  for (const item of refunded) {
    const lines = resource(snapshot, "orderLines").filter(line => line.orderId === item.orderId && line.fulfillmentKind === "DIGITAL");
    assert.ok(lines.every((line) => !resource(snapshot, "entitlementGrants").some((grant) => grant.orderLineId === line.orderLineId && grant.state === "ACTIVE")), "fully refunded digital rights inactive");
  }
  assert.equal(new Set(resource(snapshot, "fulfillmentPlans").map(({ fulfillmentPlanId }) => fulfillmentPlanId)).size, resource(snapshot, "fulfillmentPlans").length, "one physical plan identity");
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ orders: captured.length, refunded: refunded.length }] });
});

const B09 = guardedCase('B-09', ['COMMERCE_CONSERVATION', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const fixture = ctx.fixtures.marketplace(), { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const quoted = await quote(ctx, apis[0].baseUrl, fixture, 'allocation-race', { quantity: 2 });
  const line = resource(await ctx.snapshot(apis[0].baseUrl), 'orderLines').find(item => item.orderId === quoted.orderId);
  const variants = [
    { allocations: fixture.sellers.map(seller => ({ sellerId: seller.sellerId, orderLineId: line.orderLineId, quantity: 1, amountMinor: line.lineTotalMinor / 2 })) },
    { allocations: [{ sellerId: fixture.sellers[0].sellerId, orderLineId: line.orderLineId, quantity: 2, amountMinor: line.lineTotalMinor }] },
  ];
  const path = `/api/v1/orders/${quoted.orderId}/seller-allocations`;
  const raced = await Promise.all(variants.map((body, index) => ctx.mutate(apis[index].baseUrl, path, ctx.key(`allocation-race:${index}`), body)));
  candidateAssert.equal(raced.filter(response => response.status >= 200 && response.status < 300).length, 1, 'one distinct allocation set wins');
  for (const response of raced.filter(item => item.status === 409)) semanticError(response, 409, 'INVALID_ORDER_STATE');
  assert(raced.every(response => response.status === 409 || (response.status >= 200 && response.status < 300)), 'allocation race has no infrastructure errors');
  const winner = raced.findIndex(response => response.status >= 200 && response.status < 300);
  semanticReplay(raced[winner], await ctx.mutate(apis[1].baseUrl, path, ctx.key(`allocation-race:${winner}`), variants[winner]));
  const checked = await checkout(ctx, apis[0].baseUrl, quoted.orderId, 'settlement-race');
  await providerCallback(ctx, apis[0].baseUrl, checked.providerRequestId, 'settlement-race', 'CAPTURED', line.lineTotalMinor);
  const captured = await ctx.snapshot(apis[0].baseUrl);
  const allocationIds = projectOrder(captured, quoted.orderId).allocations.map(item => item.sellerAllocationId).sort();
  const proposals = [];
  for (const [sellerIndex, seller] of fixture.sellers.entries()) {
    for (let index = 0; index < 3; index += 1) proposals.push(successful(await ctx.mutate(apis[index % 2].baseUrl, '/api/v1/seller-settlements', ctx.key(`proposal:${sellerIndex}:${index}`), {
      tenantId: fixture.tenant.tenantId, sellerId: seller.sellerId, periodStart: ctx.at({ days: 2 + index }), periodEnd: ctx.at({ days: 5 + index }), currency: 'USD',
    })).json);
  }
  const closed = await Promise.all(proposals.map((proposal, index) => ctx.mutate(apis[index % 2].baseUrl, `/api/v1/seller-settlements/${proposal.sellerSettlementId}/close`, ctx.key(`close-race:${index}`), {})));
  closed.forEach(response => successful(response, 'concurrent close; losing proposal closes an empty batch'));
  const after = await ctx.snapshot(apis[0].baseUrl);
  const claimed = closed.flatMap(response => response.json.allocationIds).sort();
  assert.deepEqual(claimed, allocationIds, 'each captured allocation enters exactly one CLOSED batch');
  for (const response of closed) assertSettlement(response.json, settlementProjection(after, response.json));
  assertCoreInvariants(after);
  await ctx.stop(apis[0]);
  const restarted = await ctx.startApi();
  for (const [index, proposal] of proposals.entries()) semanticReplay(closed[index], await ctx.mutate(restarted.baseUrl, `/api/v1/seller-settlements/${proposal.sellerSettlementId}/close`, ctx.key(`close-race:${index}`), {}));
  assert.deepEqual(resource(await ctx.snapshot(restarted.baseUrl), 'sellerAllocations'), resource(after, 'sellerAllocations'), 'restart/replay cannot duplicate allocations');
  return ctx.pass({ evidence: [{ policyRevision: '2026-09-07.1', contenders: proposals.length, allocationIds }] });
});

const B10 = guardedCase('B-10', ['COMMERCE_CONSERVATION', 'IDEMPOTENCY_PROVIDER_IDENTITY', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const fixture = ctx.fixtures.marketplace(), { api } = await prepare(ctx, fixture);
  const captured = await quote(ctx, api.baseUrl, fixture, 'late-effects');
  const initial = await ctx.snapshot(api.baseUrl), line = resource(initial, 'orderLines').find(item => item.orderId === captured.orderId);
  successful(await ctx.mutate(api.baseUrl, `/api/v1/orders/${captured.orderId}/seller-allocations`, ctx.key('late-allocation'), { allocations: [{ sellerId: fixture.sellers[0].sellerId, orderLineId: line.orderLineId, quantity: line.quantity, amountMinor: line.lineTotalMinor }] }));
  const checked = await checkout(ctx, api.baseUrl, captured.orderId, 'late-effects');
  await providerCallback(ctx, api.baseUrl, checked.providerRequestId, 'late-effects', 'CAPTURED', line.lineTotalMinor);
  const attempt = resource(await ctx.snapshot(api.baseUrl), 'paymentAttempts').find(item => item.orderId === captured.orderId);
  const proposal = successful(await ctx.mutate(api.baseUrl, '/api/v1/seller-settlements', ctx.key('source-period'), { tenantId: fixture.tenant.tenantId, sellerId: fixture.sellers[0].sellerId, periodStart: ctx.at({ days: -1 }), periodEnd: ctx.at({ days: 1 }), currency: 'USD' })).json;
  const expected = settlementProjection(await ctx.snapshot(api.baseUrl), proposal);
  const closed = successful(await ctx.mutate(api.baseUrl, `/api/v1/seller-settlements/${proposal.sellerSettlementId}/close`, ctx.key('source-close'), {})).json;
  assertSettlement(closed, expected);
  const next = successful(await ctx.mutate(api.baseUrl, '/api/v1/seller-settlements', ctx.key('future-period'), { tenantId: closed.tenantId, sellerId: closed.sellerId, periodStart: ctx.at({ days: 2 }), periodEnd: ctx.at({ days: 4 }), currency: 'USD' })).json;
  const disputeBody = { tenantId: fixture.tenant.tenantId, paymentAttemptId: attempt.paymentAttemptId, providerDisputeId: ctx.uuid('late-dispute'), amountMinor: 150 };
  const dispute = successful(await ctx.mutate(api.baseUrl, '/api/v1/commerce-disputes', ctx.key('late-dispute'), disputeBody)).json;
  const worker = await ctx.startWorker();
  const path = `/api/v1/commerce-disputes/${dispute.commerceDisputeId}/resolve`, key = ctx.key('lost-ack'), body = { providerEventId: ctx.key('provider-lost'), outcome: 'LOST' };
  const shield = await ctx.responseShield(api.baseUrl);
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, path, key, body).catch(() => undefined);
  const lost = await ctx.waitFor(() => shield.captures.find(item => item.dropped), { label: 'committed LOST response before API restart' });
  assert(lost.response.status >= 200 && lost.response.status < 300, 'lost response was a successful committed resolution');
  const afterLost = await waitSnapshot(ctx, api.baseUrl, snapshot => resource(snapshot, 'settlementAdjustments').filter(item => item.sourceSettlementId === closed.sellerSettlementId).reduce((total, item) => total + item.amountMinor, 0) === -150, { processes: [worker], label: 'late chargeback adjustment becomes durable' });
  await ctx.stop(api);
  const restarted = await ctx.startApi();
  const replay = successful(await ctx.mutate(restarted.baseUrl, path, key, body));
  assert.equal(replay.status, lost.response.status);
  assert.equal(canonicalJson(replay.json), canonicalJson(JSON.parse(lost.response.body)), 'post-crash provider event replay');
  const opposite = await ctx.mutate(restarted.baseUrl, path, ctx.key('opposite-outcome'), { providerEventId: ctx.key('provider-won'), outcome: 'WON' });
  semanticError(opposite, 409, 'PROVIDER_EVENT_CONFLICT');
  assert.deepEqual(resource(await ctx.snapshot(restarted.baseUrl), 'ledgerEntries'), resource(afterLost, 'ledgerEntries'), 'replay/opposite terminal event cannot charge back twice');
  successful(await ctx.mutate(restarted.baseUrl, `/api/v1/orders/${captured.orderId}/refunds`, ctx.key('late-refund'), { amountMinor: 200, reason: 'Refund after accounting close', restockLines: [] }));
  const final = await waitSnapshot(ctx, restarted.baseUrl, snapshot => resource(snapshot, 'settlementAdjustments').filter(item => item.sourceSettlementId === closed.sellerSettlementId).reduce((total, item) => total + item.amountMinor, 0) === -350, { processes: [worker], label: 'late refund adjustment becomes durable' });
  const adjustments = resource(final, 'settlementAdjustments').filter(item => item.sourceSettlementId === closed.sellerSettlementId);
  assert(adjustments.length > 0, 'late financial effects retain immutable adjustments');
  assert(adjustments.every(item => item.targetPeriodStart === next.periodStart), 'late adjustments target next open period');
  assert.equal(adjustments.reduce((total, item) => total + item.amountMinor, 0), withholdingAdjustment({ refundReserveMinor: 0, disputeReserveMinor: 0 }, { refundReserveMinor: 200, disputeReserveMinor: 150 }), 'only previously unwithheld liability debited');
  assert.deepEqual(resource(final, 'sellerSettlements').find(item => item.sellerSettlementId === closed.sellerSettlementId), closed, 'closed source remains immutable');
  const nextExpected = settlementProjection(final, next);
  assert.equal(nextExpected.netMinor, -350);
  assertSettlement(successful(await ctx.mutate(restarted.baseUrl, `/api/v1/seller-settlements/${next.sellerSettlementId}/close`, ctx.key('future-close'), {})).json, nextExpected);
  const overlapping = successful(await ctx.mutate(restarted.baseUrl, '/api/v1/seller-settlements', ctx.key('overlapping-period'), { tenantId: closed.tenantId, sellerId: closed.sellerId, periodStart: next.periodStart, periodEnd: next.periodEnd, currency: 'USD' })).json;
  const emptyExpected = settlementProjection(await ctx.snapshot(restarted.baseUrl), overlapping, { consumedAdjustmentIds: nextExpected.adjustmentIds });
  assert.equal(emptyExpected.netMinor, 0, 'consumed adjustments cannot fund another batch');
  assertSettlement(successful(await ctx.mutate(restarted.baseUrl, `/api/v1/seller-settlements/${overlapping.sellerSettlementId}/close`, ctx.key('overlapping-close'), {})).json, emptyExpected);
  assertCoreInvariants(await ctx.snapshot(restarted.baseUrl));
  return ctx.pass({ evidence: [{ policyRevision: '2026-09-07.1', postRestartReplay: true, lateNetMinor: -350, consumedExactlyOnce: true }] });
});

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05, B06, B07, B08, B09, B10]);
