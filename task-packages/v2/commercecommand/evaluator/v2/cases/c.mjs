import assert from "node:assert/strict";
import { assertCoreInvariants, canonicalJson, exactKeys, resource, stableSnapshot } from "../oracles/index.mjs";
import { assertSettlement, settlementProjection } from '../oracles/economic-policy.mjs';
import { capture, checkout, guardedCase, prepare, providerCallback, quote, semanticError, semanticReplay, successful, waitSnapshot } from "./helpers.mjs";
import { assertCaptureNotRepeated, assertHeldClaim, assertNotificationBytes, assertOrderEvidence, heldWorker, recoverWorker, sandboxProvider } from './recovery.mjs';

const C01 = guardedCase("C-01", ["WORK_FENCING", "TRANSACTIONAL_EVIDENCE"], async (ctx) => {
  const fixture = ctx.fixtures.work();
  const { api } = await prepare(ctx, fixture);
  const captured = await capture(ctx, api.baseUrl, fixture, "work-lifecycle");
  const pending = await ctx.snapshot(api.baseUrl);
  const selected = pending.work.filter((work) => work.kind === "FULFILLMENT" && (work.aggregateId === captured.orderId || resource(pending, "fulfillmentPlans").some((plan) => plan.orderId === captured.orderId && plan.fulfillmentPlanId === work.aggregateId)));
  assert.ok(selected.length > 0, "capture publishes Fulfillment Work");
  for (const work of selected) {
    exactKeys(work, ["workId", "tenantId", "kind", "aggregateId", "payloadVersion", "state", "attempts", "availableAt", "leaseOwner", "leaseExpiresAt", "fencingToken", "terminal"], `Work ${work.workId}`);
    assert.equal(work.state, "PENDING", "new Work pending");
    assert.equal(work.terminal, false, "new Work nonterminal");
    assert.equal(work.attempts, 0, "new Work attempts zero");
  }
  const workers = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
  const terminal = await waitSnapshot(ctx, api.baseUrl, (snapshot) => {
    const ids = new Set(selected.map(({ workId }) => workId));
    const current = snapshot.work.filter(({ workId }) => ids.has(workId));
    return current.length === selected.length && current.every(({ terminal: value }) => value);
  }, { timeoutMs: 120_000, processes: workers, label: "Fulfillment Work terminal retention" });
  for (const initial of selected) {
    const final = terminal.work.find(({ workId }) => workId === initial.workId);
    assert.ok(final.attempts >= 1 && final.fencingToken >= initial.fencingToken, "attempt and fencing monotonic");
    assert.ok(["SUCCEEDED", "DEAD"].includes(final.state), "terminal Work state");
    assert.equal(final.terminal, true, "terminal retained");
  }
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  await ctx.stop(api);
  const restarted = await ctx.startApi();
  const afterRestart = await ctx.snapshot(restarted.baseUrl);
  assert.ok(selected.every((initial) => afterRestart.work.some(({ workId, terminal: value }) => workId === initial.workId && value)), "terminal Work survives process restart");
  assertCoreInvariants(afterRestart);
  return ctx.pass({ evidence: [{ terminalWorkIds: selected.map(({ workId }) => workId) }] });
});

const C02 = guardedCase('C-02', ['WORK_FENCING', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const fixture = ctx.fixtures.work(), { api } = await prepare(ctx, fixture);
  const captured = await capture(ctx, api.baseUrl, fixture, 'claimed-kill');
  const before = await ctx.snapshot(api.baseUrl);
  const held = await heldWorker(ctx, 'FULFILLMENT');
  const { claim, snapshot } = await recoverWorker(ctx, api.baseUrl, held);
  const plans = resource(snapshot, 'fulfillmentPlans').filter(row => row.orderId === captured.orderId);
  const selected = plans.find(row => row.fulfillmentPlanId === claim.aggregateId) ?? (plans.length === 1 ? plans[0] : undefined);
  assert.ok(selected?.state === 'COMPLETED' && selected.completedAt, 'reclaimed Work really completes its physical plan');
  assertCaptureNotRepeated(before, snapshot);
  assertOrderEvidence(snapshot, [captured.orderId]);
  assertCoreInvariants(snapshot);
  return ctx.pass();
});

const C03 = guardedCase('C-03', ['WORK_FENCING', 'COMMERCE_CONSERVATION'], async ctx => {
  const fixture = ctx.fixtures.fulfillment(), { api } = await prepare(ctx, fixture);
  const captured = await capture(ctx, api.baseUrl, fixture, 'expired-fence');
  const held = await heldWorker(ctx, 'FULFILLMENT', { point: 'worker.before-effect' });
  const entry = await held.wait();
  const before = await ctx.snapshot(api.baseUrl), claim = assertHeldClaim(before, entry);
  const plans = resource(before, 'fulfillmentPlans').filter(row => row.orderId === captured.orderId);
  const plan = plans.find(row => row.fulfillmentPlanId === claim.aggregateId) ?? (plans.length === 1 ? plans[0] : undefined);
  assert.ok(plan, 'held Work identifies its fulfillment plan');
  // Wait for the observed lease, never invent a token or write candidate storage.
  await ctx.waitFor(() => Date.now() > Date.parse(claim.leaseExpiresAt), { timeoutMs: 10_000, label: 'held lease expires' });
  const expired = await ctx.snapshot(api.baseUrl);
  semanticError(await ctx.mutate(api.baseUrl, `/api/v1/fulfillment-plans/${plan.fulfillmentPlanId}/complete`, ctx.key('expired-completion'), { fencingToken: claim.fencingToken }), 409, 'STALE_FENCE');
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(expired), 'expired completion changes no business state');
  const { snapshot } = await recoverWorker(ctx, api.baseUrl, held);
  const completed = resource(snapshot, 'fulfillmentPlans').find(row => row.fulfillmentPlanId === plan.fulfillmentPlanId);
  assert.equal(completed.state, 'COMPLETED');
  semanticError(await ctx.mutate(api.baseUrl, `/api/v1/fulfillment-plans/${plan.fulfillmentPlanId}/complete`, ctx.key('reclaimed-old-completion'), { fencingToken: claim.fencingToken }), 409, 'STALE_FENCE');
  assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(snapshot), 'old fencing token cannot repeat a completed effect');
  assertCaptureNotRepeated(before, snapshot);
  assertCoreInvariants(snapshot);
  return ctx.pass();
});

const C04 = guardedCase('C-04', ['WORK_FENCING', 'COMMERCE_CONSERVATION', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const fixture = ctx.fixtures.fulfillment(), { api } = await prepare(ctx, fixture);
  const orders = await Promise.all([0, 1, 2].map(index => capture(ctx, api.baseUrl, fixture, `fulfillment-recovery:${index}`, { quote: { quantity: 2 } })));
  const before = await ctx.snapshot(api.baseUrl), orderIds = orders.map(row => row.orderId);
  const held = await heldWorker(ctx, 'FULFILLMENT', { point: 'worker.before-effect' });
  const { replacement } = await recoverWorker(ctx, api.baseUrl, held, { keepAlive: true });
  const completed = await waitSnapshot(ctx, api.baseUrl, snapshot => {
    const plans = resource(snapshot, 'fulfillmentPlans').filter(row => orderIds.includes(row.orderId));
    return plans.length >= orders.length && plans.every(row => row.state === 'COMPLETED' && row.completedAt);
  }, { timeoutMs: 120_000, processes: [replacement], label: 'all physical plans complete after replacement' });
  await ctx.stop(replacement);
  assertCaptureNotRepeated(before, completed);
  assertOrderEvidence(completed, orderIds);
  await ctx.stop(api);
  const restarted = await ctx.startApi(), durable = await ctx.snapshot(restarted.baseUrl);
  assert.deepEqual(resource(durable, 'fulfillmentPlans'), resource(completed, 'fulfillmentPlans'), 'completed shipment identities survive restart');
  assertCaptureNotRepeated(completed, durable);
  assertCoreInvariants(durable);
  return ctx.pass();
});

const C05 = guardedCase('C-05', ['WORK_FENCING', 'IDEMPOTENCY_PROVIDER_IDENTITY', 'COMMERCE_CONSERVATION'], async ctx => {
  const fixture = ctx.fixtures.payment(), provider = await sandboxProvider(ctx, { disconnectFirstAcceptance: true });
  await ctx.migrate(); await ctx.seed(fixture.seed);
  const env = { SANDBOX_PROVIDER_URL: provider.url };
  const api = await ctx.startApi({ env });
  const quoted = await quote(ctx, api.baseUrl, fixture, 'provider-accepted-unknown');
  const checked = await checkout(ctx, api.baseUrl, quoted.orderId, 'provider-accepted-unknown');
  const pending = await ctx.snapshot(api.baseUrl);
  const order = resource(pending, 'orders').find(row => row.orderId === quoted.orderId);
  const attempt = resource(pending, 'paymentAttempts').find(row => row.orderId === quoted.orderId);
  assert.equal(attempt.state, 'UNKNOWN', 'a lost provider response is not a decline');
  assert.equal(order.capturedMinor, 0, 'unknown external outcome is not fabricated as capture');
  assert.ok(provider.ledger.some(row => row.accepted && !row.responseDelivered), 'dependency really accepted and lost its response');
  const held = await heldWorker(ctx, 'PAYMENT_RECONCILIATION', { env });
  await held.wait();
  provider.revealCaptures();
  const { replacement } = await recoverWorker(ctx, api.baseUrl, held, { env, keepAlive: true });
  const captured = await waitSnapshot(ctx, api.baseUrl, snapshot => resource(snapshot, 'paymentAttempts').some(row => row.paymentAttemptId === attempt.paymentAttemptId && row.state === 'CAPTURED'), { processes: [replacement], label: 'replacement reconciles same provider operation' });
  await ctx.stop(replacement);
  assert.equal(provider.saved.size, 1, 'no replacement provider identity');
  assert.equal([...provider.saved.values()][0].chargeCount, 1, 'one provider charge despite transport failure and Worker death');
  assert.ok(provider.ledger.some(row => row.method === 'GET'), 'actual provider query used');
  assert.ok(!provider.ledger.some(row => row.protocolError), 'provider requests match the public wire protocol');
  assert.equal(resource(captured, 'orders').find(row => row.orderId === quoted.orderId).capturedMinor, order.orderTotalMinor);
  const ledger = resource(captured, 'ledgerEntries').filter(row => row.orderId === quoted.orderId);
  assert.equal(new Set(ledger.map(row => row.journalId)).size, 1, 'exactly one capture journal');
  assert.equal(ledger.filter(row => row.account === 'CASH' && row.direction === 'DEBIT').reduce((sum, row) => sum + row.amountMinor, 0), order.orderTotalMinor);
  await providerCallback(ctx, api.baseUrl, checked.providerRequestId, 'late-provider-replay', 'CAPTURED', order.orderTotalMinor);
  const replayed = await ctx.snapshot(api.baseUrl);
  assert.deepEqual(resource(replayed, 'ledgerEntries'), resource(captured, 'ledgerEntries'), 'late observation never duplicates capture journal');
  assert.deepEqual(resource(replayed, 'inventoryPools'), resource(captured, 'inventoryPools'), 'late observation never consumes inventory twice');
  assertOrderEvidence(replayed, [quoted.orderId]);
  assertCoreInvariants(replayed);
  return ctx.pass();
});

const C06 = guardedCase('C-06', ['WORK_FENCING', 'COMMERCE_CONSERVATION', 'TRANSACTIONAL_EVIDENCE'], async ctx => {
  const fixture = ctx.fixtures.marketplace(), { api } = await prepare(ctx, fixture);
  const quoted = await quote(ctx, api.baseUrl, fixture, 'manager-recovery');
  const line = resource(await ctx.snapshot(api.baseUrl), 'orderLines').find(row => row.orderId === quoted.orderId);
  const allocations = successful(await ctx.mutate(api.baseUrl, `/api/v1/orders/${quoted.orderId}/seller-allocations`, ctx.key('manager-allocations'), { allocations: [{ orderLineId: line.orderLineId, sellerId: fixture.sellers[0].sellerId, quantity: line.quantity, amountMinor: line.lineTotalMinor }] })).json;
  const checked = await checkout(ctx, api.baseUrl, quoted.orderId, 'manager-recovery');
  await providerCallback(ctx, api.baseUrl, checked.providerRequestId, 'manager-recovery', 'CAPTURED', line.lineTotalMinor);
  const proposed = successful(await ctx.mutate(api.baseUrl, '/api/v1/seller-settlements', ctx.key('manager-period'), { tenantId: fixture.tenant.tenantId, sellerId: fixture.sellers[0].sellerId, periodStart: ctx.at({ days: -1 }), periodEnd: ctx.at({ days: 1 }), currency: 'USD' })).json;
  const expected = settlementProjection(await ctx.snapshot(api.baseUrl), proposed);
  const heldClose = await heldWorker(ctx, 'SELLER_SETTLEMENT_CLOSE');
  successful(await ctx.mutate(api.baseUrl, `/api/v1/seller-settlements/${proposed.sellerSettlementId}/close`, ctx.key('manager-close'), {}));
  await recoverWorker(ctx, api.baseUrl, heldClose);
  const closed = resource(await ctx.snapshot(api.baseUrl), 'sellerSettlements').find(row => row.sellerSettlementId === proposed.sellerSettlementId);
  assertSettlement(closed, expected);
  const attempt = resource(await ctx.snapshot(api.baseUrl), 'paymentAttempts').find(row => row.orderId === quoted.orderId);
  const heldDispute = await heldWorker(ctx, 'DISPUTE_RECONCILIATION');
  const dispute = successful(await ctx.mutate(api.baseUrl, '/api/v1/commerce-disputes', ctx.key('manager-dispute'), { tenantId: fixture.tenant.tenantId, paymentAttemptId: attempt.paymentAttemptId, providerDisputeId: ctx.uuid('manager-provider-dispute'), amountMinor: 100 })).json;
  successful(await ctx.mutate(api.baseUrl, `/api/v1/commerce-disputes/${dispute.commerceDisputeId}/resolve`, ctx.key('manager-lost'), { providerEventId: 'manager-lost-result', outcome: 'LOST' }));
  const { replacement } = await recoverWorker(ctx, api.baseUrl, heldDispute, { keepAlive: true });
  const adjusted = await waitSnapshot(ctx, api.baseUrl, snapshot => resource(snapshot, 'settlementAdjustments').some(row => row.sourceSettlementId === closed.sellerSettlementId), { processes: [replacement], label: 'recovered LOST adjustment durable' });
  await ctx.stop(replacement);
  const losses = resource(adjusted, 'settlementAdjustments').filter(row => row.sourceSettlementId === closed.sellerSettlementId);
  assert.equal(losses.length, 1); assert.equal(losses[0].amountMinor, -100, 'late unreserved LOST charged to seller once');
  const beforeCorrection = await ctx.snapshot(api.baseUrl);
  const correctionKey = ctx.key('manager-correction'), correctionBody = { tenantId: fixture.tenant.tenantId, sellerId: closed.sellerId, sourceSettlementId: closed.sellerSettlementId, sourceAllocationId: allocations[0].sellerAllocationId, amountMinor: 7, reason: 'Published explicit correction' };
  const correction = successful(await ctx.mutate(api.baseUrl, '/api/v1/settlement-adjustments', correctionKey, correctionBody));
  const previousWork = new Set(beforeCorrection.work.map(row => row.workId));
  const correctionWork = (await ctx.snapshot(api.baseUrl)).work.find(row => row.kind === 'SETTLEMENT_ADJUSTMENT' && !previousWork.has(row.workId));
  assert.ok(correctionWork, 'explicit correction publishes its own durable Work');
  const heldAdjustment = await heldWorker(ctx, 'SETTLEMENT_ADJUSTMENT', { workId: correctionWork.workId });
  await recoverWorker(ctx, api.baseUrl, heldAdjustment);
  semanticReplay(correction, await ctx.mutate(api.baseUrl, '/api/v1/settlement-adjustments', correctionKey, correctionBody));
  const final = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(final, 'settlementAdjustments').length, resource(beforeCorrection, 'settlementAdjustments').length + 1, 'correction recovery never duplicates adjustment');
  assert.deepEqual(resource(final, 'sellerSettlements').find(row => row.sellerSettlementId === closed.sellerSettlementId), closed, 'crash/retry never rewrites closed settlement');
  assert.deepEqual(resource(final, 'ledgerEntries'), resource(beforeCorrection, 'ledgerEntries'), 'entitlement correction never posts a second cash loss');
  const debit = resource(final, 'ledgerEntries').filter(row => row.orderId === quoted.orderId && row.account === 'ORDER_LIABILITY' && row.direction === 'DEBIT');
  assert.equal(debit.reduce((sum, row) => sum + row.amountMinor, 0), 100, 'one LOST chargeback effect');
  assertCoreInvariants(final);
  return ctx.pass();
});

const C07 = guardedCase('C-07', ['TRANSACTIONAL_EVIDENCE', 'WORK_FENCING'], async ctx => {
  const fixture = ctx.fixtures.ledger(), receiver = await ctx.receiver();
  const { api } = await prepare(ctx, fixture);
  const quoted = await quote(ctx, api.baseUrl, fixture, 'unknown-ack');
  let held;
  const barrier = await ctx.barrier({ hold: (body, entry) => {
    if (!held && body.role === 'dispatcher' && body.responseStatus >= 200 && body.responseStatus < 300) { held = entry; return true; }
    return false;
  } });
  const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { WORK_LEASE_SECONDS: '2', TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const entry = await barrier.waitFor(item => item === held, { timeoutMs: 60_000, processes: [dispatcher], label: 'receiver ACK before durable dispatcher ACK' });
  const before = await ctx.snapshot(api.baseUrl), delivery = resource(before, 'notificationDeliveries').find(row => row.notificationDeliveryId === entry.json.notificationDeliveryId);
  assert.ok(delivery && delivery.eventId === entry.json.eventId && delivery.orderId === entry.json.aggregateId, 'held dispatcher reports actual notification identity');
  assert.equal(delivery.deliveredAt, null, 'barrier is before durable ACK');
  assert.ok(receiver.ledger.some(row => row.json.eventId === delivery.eventId && row.acknowledged), 'receiver accepted before dispatcher was killed');
  await ctx.kill(dispatcher);
  assert.equal(dispatcher.stopped, true);
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { WORK_LEASE_SECONDS: '2' } });
  const final = await waitSnapshot(ctx, api.baseUrl, snapshot => resource(snapshot, 'notificationDeliveries').some(row => row.notificationDeliveryId === delivery.notificationDeliveryId && row.deliveredAt), { timeoutMs: 120_000, processes: [replacement], label: 'replacement retries unknown ACK and commits it' });
  await ctx.stop(replacement);
  const repeated = receiver.ledger.filter(row => row.json?.eventId === delivery.eventId);
  assert.ok(repeated.length >= 2, 'receiver really observed retry of the same notification');
  assertNotificationBytes(final, receiver.ledger);
  assertOrderEvidence(final, [quoted.orderId]);
  assertCoreInvariants(final);
  return ctx.pass({ evidence: [{ eventId: delivery.eventId, attemptsObserved: repeated.length }] });
});

const C08 = guardedCase('C-08', ['TRANSACTIONAL_EVIDENCE', 'IDEMPOTENCY_PROVIDER_IDENTITY', 'COMMERCE_CONSERVATION'], async ctx => {
  const fixture = ctx.fixtures.ledger(), { api } = await prepare(ctx, fixture);
  const quoted = await quote(ctx, api.baseUrl, fixture, 'transaction-recovery');
  const checked = await checkout(ctx, api.baseUrl, quoted.orderId, 'transaction-recovery');
  const pending = await ctx.snapshot(api.baseUrl), total = resource(pending, 'orders').find(row => row.orderId === quoted.orderId).orderTotalMinor;
  const shield = await ctx.responseShield(api.baseUrl), key = ctx.key('transaction-capture');
  const body = { providerEventId: 'transaction-capture-result', providerRequestId: checked.providerRequestId, outcome: 'CAPTURED', capturedMinor: total };
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, '/api/v1/payment-provider/callbacks', key, body).catch(() => undefined);
  const saved = await ctx.waitFor(() => shield.captures.find(row => row.dropped), { label: 'capture committed but HTTP response lost' });
  assert.ok(saved.response.status >= 200 && saved.response.status < 300, 'dropped response was a successful capture');
  await ctx.kill(api);
  const restarted = await ctx.startApi(), committed = await ctx.snapshot(restarted.baseUrl);
  const order = resource(committed, 'orders').find(row => row.orderId === quoted.orderId);
  assert.equal(order.capturedMinor, total);
  assert.equal(resource(committed, 'paymentAttempts').find(row => row.orderId === order.orderId).state, 'CAPTURED');
  const journal = resource(committed, 'ledgerEntries').filter(row => row.orderId === order.orderId);
  assert.equal(new Set(journal.map(row => row.journalId)).size, 1, 'capture journal committed with captured Order');
  assert.equal(journal.filter(row => row.account === 'CASH' && row.direction === 'DEBIT').reduce((sum, row) => sum + row.amountMinor, 0), total);
  assert.ok(resource(committed, 'fulfillmentPlans').some(row => row.orderId === order.orderId), 'capture included frozen physical plan');
  assert.ok(committed.work.some(row => row.kind === 'FULFILLMENT'), 'capture included durable fulfillment Work');
  assertOrderEvidence(committed, [order.orderId]);
  const replay = successful(await ctx.mutate(restarted.baseUrl, '/api/v1/payment-provider/callbacks', key, body));
  assert.equal(replay.status, saved.response.status);
  assert.equal(canonicalJson(replay.json), canonicalJson(JSON.parse(saved.response.body)), 'saved response survives API crash');
  assert.equal(stableSnapshot(await ctx.snapshot(restarted.baseUrl)), stableSnapshot(committed), 'response replay creates no partial or duplicate side effects');
  const held = await heldWorker(ctx, 'FULFILLMENT', { point: 'worker.before-effect' });
  const { snapshot } = await recoverWorker(ctx, restarted.baseUrl, held);
  assert.ok(resource(snapshot, 'fulfillmentPlans').some(row => row.orderId === order.orderId && row.state === 'COMPLETED' && row.completedAt), 'recovered Work commits physical fulfillment, not just a terminal flag');
  assertCaptureNotRepeated(committed, snapshot);
  assertOrderEvidence(snapshot, [order.orderId]);
  assertCoreInvariants(snapshot);
  return ctx.pass();
});

export const C_CASES = Object.freeze([C01, C02, C03, C04, C05, C06, C07, C08]);
