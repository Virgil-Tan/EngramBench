import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { resource, stableSnapshot } from '../oracles/index.mjs';
import { assertSettlement, settlementFee } from '../oracles/economic-policy.mjs';
import { successful, semanticError, waitSnapshot } from './helpers.mjs';
import { assertHeldClaim, assertNotificationBytes, sandboxProvider } from './recovery.mjs';
import { PERF_ENV, performanceFixture, prepareConcurrently, preparePerformance, proposeSettlement, assertPerformanceInvariants, dueWorkDrained } from './performance.mjs';

export function catastropheStages(index) {
  return index < 2000 ? 'quoted' : index < 4000 ? 'unknown' : index < 6000 ? 'physical' : 'digital';
}

export async function fullCatastrophe(ctx) {
  const spec = ctx.fixtures.performance().scenarios.catastrophe;
  assert.equal(spec.entities, 10_000); assert.equal(spec.drainMs, 300_000);
  const provider = await sandboxProvider(ctx, { disconnectFirstAcceptance: true }), env = { ...PERF_ENV, WORK_LEASE_SECONDS: '30', SANDBOX_PROVIDER_URL: provider.url };
  const fixture = performanceFixture(ctx, 8000, { sellersPerOrder: 2, stages: catastropheStages });
  const { apis, snapshot: prepared } = await preparePerformance(ctx, fixture, { env });
  const byStage = Map.groupBy(fixture.records, record => record.stage);
  for (const stage of ['quoted', 'unknown', 'physical', 'digital']) assert.equal(byStage.get(stage).length, 2000);
  const settlements = [], disputes = [];
  await prepareConcurrently(ctx, byStage.get('physical').slice(0, 1000), 64, async record => {
    settlements.push({ record, settlement: await proposeSettlement(ctx, apis[record.index % 2].baseUrl, record) });
  });
  await prepareConcurrently(ctx, byStage.get('physical').slice(1000), 64, async record => {
    const dispute = successful(await ctx.mutate(apis[record.index % 2].baseUrl, '/api/v1/commerce-disputes', ctx.key(`catastrophe:open:${record.index}`), {
      tenantId: record.tenantId, paymentAttemptId: record.paymentAttemptId, providerDisputeId: ctx.uuid(`catastrophe:dispute:${record.index}`), amountMinor: 100,
    }), 'prepare actual OPEN dispute').json;
    disputes.push({ record, dispute });
  });
  settlements.sort((a, b) => a.record.index - b.record.index); disputes.sort((a, b) => a.record.index - b.record.index);
  const before = await ctx.snapshot(apis[0].baseUrl);
  assert.equal(resource(before, 'orders').length, 8000);
  assert.equal(resource(before, 'sellerSettlements').length, 1000);
  assert.equal(resource(before, 'commerceDisputes').length, 1000);
  assert(resource(before, 'sellerSettlements').every(row => row.state === 'OPEN'));
  assert(resource(before, 'commerceDisputes').every(row => row.state === 'OPEN'));
  assertPerformanceInvariants(before);
  const plansByOrder = new Map(resource(before, 'fulfillmentPlans').map(row => [row.orderId, row]));
  const fences = new Map();
  const observeClaim = body => {
    if (body.point === 'worker.claimed' && body.kind === 'FULFILLMENT') fences.set(body.aggregateId, body.fencingToken);
    return false;
  };
  let armed = false, workerEntry, workerTarget, dispatcherEntry;
  const workerBarrier = await ctx.barrier({ hold: (body, entry) => {
    observeClaim(body);
    if (armed && dispatcherEntry && !workerEntry && body.point === 'worker.claimed' && body.kind === 'FULFILLMENT') { workerEntry = entry; workerTarget = 0; return true; }
    return false;
  } });
  const otherWorkerBarrier = await ctx.barrier({ hold: (body, entry) => {
    observeClaim(body);
    if (armed && dispatcherEntry && !workerEntry && body.point === 'worker.claimed' && body.kind === 'FULFILLMENT') { workerEntry = entry; workerTarget = 1; return true; }
    return false;
  } });
  const dispatcherBarrier = await ctx.barrier({ hold: (body, entry) => {
    if (armed && !dispatcherEntry && body.point === 'dispatcher.response-received' && body.responseStatus === 204) { dispatcherEntry = entry; return true; }
    return false;
  } });
  const receiver = await ctx.receiver({ path: '/catastrophe-notifications' });
  const workers = await Promise.all([
    ctx.startWorker({ env: { ...env, TEST_BARRIER_URL: workerBarrier.url, TEST_BARRIER_TOKEN: workerBarrier.token } }),
    ctx.startWorker({ env: { ...env, TEST_BARRIER_URL: otherWorkerBarrier.url, TEST_BARRIER_TOKEN: otherWorkerBarrier.token } }),
  ]);
  const dispatchers = await Promise.all([
    ctx.startDispatcher({ webhookUrl: receiver.url, env: { ...env, TEST_BARRIER_URL: dispatcherBarrier.url, TEST_BARRIER_TOKEN: dispatcherBarrier.token } }),
    ctx.startDispatcher({ webhookUrl: receiver.url, env }),
  ]);
  const shares = ['checkout', 'provider', 'fulfillment', 'notification', 'settlement', 'dispute'];
  const admitted = Object.fromEntries(shares.map(name => [name, []]));
  const startedShares = Object.fromEntries(shares.map(name => [name, 0]));
  const errors = [], transport = [];
  let active = true, ordinal = 0, duringKill = false;
  const mutate = async (preferred, path, key, body) => {
    const target = apis[preferred].stopped ? apis[1 - preferred] : apis[preferred];
    try { return await ctx.mutate(target.baseUrl, path, key, body); }
    catch (error) {
      transport.push({ time: Date.now(), message: error.message });
      if (!duringKill && !target.stopped) throw error;
      const replacement = apis.find(api => !api.stopped && api !== target);
      assert(replacement, 'live API for exact-key transport retry');
      return ctx.mutate(replacement.baseUrl, path, key, body);
    }
  };
  const loadStartedAt = Date.now();
  const load = Promise.all(Array.from({ length: 64 }, async () => {
    try {
      while (active) {
        const index = ordinal++, share = shares[index % 6], itemIndex = Math.floor(index / 6);
        // Each finite public category has >=1,000 legal operations. A 1s
        // client cadence keeps all six shares active throughout the crash window;
        // this recovery scenario publishes no request-rate target.
        assert(itemIndex < 1000, 'public catastrophe workload exhausted before crash window completed');
        const started = performance.now(), startedAtMs = Date.now(), key = ctx.key(`catastrophe:load:${share}:${itemIndex}`);
        startedShares[share] += 1;
        let response, record;
        if (share === 'checkout') {
          record = byStage.get('quoted')[itemIndex];
          response = await mutate(index % 2, `/api/v1/orders/${record.orderId}/checkout`, key, { provider: 'SANDBOX', providerRequestId: ctx.key(`catastrophe:provider:${record.index}`) });
        } else if (share === 'provider') {
          record = byStage.get('unknown')[itemIndex];
          response = await mutate(index % 2, '/api/v1/payment-provider/callbacks', key, { providerEventId: ctx.key(`catastrophe:capture-event:${record.index}`), providerRequestId: record.providerRequestId, outcome: 'CAPTURED', capturedMinor: record.orderTotalMinor });
        } else if (share === 'fulfillment') {
          record = byStage.get('physical')[itemIndex];
          const plan = plansByOrder.get(record.orderId); assert(plan, 'real physical plan in prepared manifest');
          // A client cannot mint a lease. Observe the real public claim token;
          // a competing Worker may legitimately make it stale before commit.
          const fencingToken = await ctx.waitFor(() => fences.get(plan.fulfillmentPlanId) ?? fences.get(record.orderId), {
            timeoutMs: 60_000, processes: workers, label: 'public fulfillment claim authority for catastrophe client',
          });
          response = await mutate(index % 2, `/api/v1/fulfillment-plans/${plan.fulfillmentPlanId}/complete`, key, { fencingToken });
          if (response.status === 409) assert(['STALE_FENCE', 'INVALID_ORDER_STATE'].includes(response.json?.error?.code), 'only legitimate fulfillment contention');
        } else if (share === 'notification') {
          record = byStage.get('digital')[itemIndex];
          response = await mutate(index % 2, `/api/v1/orders/${record.orderId}/refunds`, key, { amountMinor: 1, reason: 'Public catastrophe notification-producing mutation', restockLines: [] });
        } else if (share === 'settlement') {
          const item = settlements[itemIndex]; record = item.record;
          response = await mutate(index % 2, `/api/v1/seller-settlements/${item.settlement.sellerSettlementId}/close`, key, {});
        } else {
          const item = disputes[itemIndex]; record = item.record;
          response = await mutate(index % 2, `/api/v1/commerce-disputes/${item.dispute.commerceDisputeId}/resolve`, key, { providerEventId: ctx.key(`catastrophe:resolve:${itemIndex}`), outcome: itemIndex % 2 ? 'LOST' : 'WON' });
        }
        if (!(share === 'fulfillment' && response.status === 409)) successful(response, `catastrophe ${share}`);
        admitted[share].push({ index: itemIndex, orderId: record.orderId, status: response.status, startedAtMs, completedAtMs: Date.now() });
        await sleep(Math.max(0, 1000 - (performance.now() - started)));
      }
    } catch (error) { errors.push(error); active = false; }
  }));
  let killAt, replacementAt, loadStoppedAt, claimed, killedPlan, workerProbe, dispatcherProbe, mainError;
  try {
    await sleep(10_000); armed = true;
    // Active load means scheduled real clients, not a hidden ten-second
    // completion target. Claims may still be in flight; recovery checks below remain.
    ctx.mark('catastrophe-load-start', { startedShares: {...startedShares}, completedShares: Object.fromEntries(shares.map(s=>[s,admitted[s].length])) });
    assert(active && shares.every(share => startedShares[share] > 0), 'all six public shares active before requested crash');
    await Promise.all([
      ctx.waitFor(() => workerEntry, { timeoutMs: 60_000, processes: workers, label: 'catastrophe Worker claimed barrier' }),
      dispatcherBarrier.waitFor(entry => entry === dispatcherEntry, { timeoutMs: 60_000, processes: [dispatchers[0]], label: 'catastrophe dispatcher response barrier' }),
    ]);
    const atKill = await ctx.snapshot(apis[1].baseUrl); claimed = assertHeldClaim(atKill, workerEntry);
    killedPlan = resource(atKill, 'fulfillmentPlans').find(row => row.fulfillmentPlanId === claimed.aggregateId || row.orderId === claimed.aggregateId);
    assert(killedPlan, 'held fulfillment claim maps to real public plan');
    assert(receiver.ledger.some(entry => entry.json?.eventId === dispatcherEntry.json.eventId && entry.acknowledged), 'held dispatcher actually received ACK');
    duringKill = true; killAt = Date.now();
    await Promise.all([ctx.kill(apis[0]), ctx.kill(workers[workerTarget]), ctx.kill(dispatchers[0])]);
    assert(apis[0].stopped && workers[workerTarget].stopped && dispatchers[0].stopped, 'all three exact target processes killed');
    workerProbe = await ctx.barrier({ hold: observeClaim }); dispatcherProbe = await ctx.barrier({ hold: () => false });
    [apis[0], workers[workerTarget], dispatchers[0]] = await Promise.all([
      ctx.startApi({ env }),
      ctx.startWorker({ env: { ...env, TEST_BARRIER_URL: workerProbe.url, TEST_BARRIER_TOKEN: workerProbe.token } }),
      ctx.startDispatcher({ webhookUrl: receiver.url, env: { ...env, TEST_BARRIER_URL: dispatcherProbe.url, TEST_BARRIER_TOKEN: dispatcherProbe.token } }),
    ]);
    replacementAt = Date.now(); duringKill = false;
    await sleep(Math.max(0, killAt + 10_000 - Date.now()));
  } catch (error) {
    mainError = error;
    throw error;
  } finally {
    active = false; loadStoppedAt = Date.now(); await load;
    // A load failure can cause the main precondition to fail too. Retain both
    // after every client settles; without load errors the original throw wins.
    if (errors.length) throw new AggregateError(mainError === undefined ? errors : [mainError, ...errors], `Catastrophe workload failed: ${errors[0].message}`);
  }
  assert(shares.every(share => admitted[share].some(row => row.startedAtMs >= killAt && row.startedAtMs < loadStoppedAt)), 'all six shares admit new real operations after the crash');
  const checkoutOrders = new Set(admitted.checkout.map(row => row.orderId));
  const mustCapture = fixture.records.filter(row => row.stage !== 'quoted' || checkoutOrders.has(row.orderId));
  provider.revealCaptures();
  const final = await waitSnapshot(ctx, apis[0].baseUrl, snapshot => {
    // Workers may submit already-admitted UNKNOWN operations only after recovery.
    // Those real accepted operations become definitive too, not permanently UNKNOWN.
    provider.revealCaptures();
    const orders = new Map(resource(snapshot, 'orders').map(row => [row.orderId, row]));
    const fulfilled = new Set(resource(snapshot, 'fulfillmentPlans').filter(row => row.state === 'COMPLETED').map(row => row.orderId));
    const licensed = new Set(resource(snapshot, 'entitlementGrants').filter(row => row.state === 'ACTIVE').map(row => row.orderId));
    return dueWorkDrained(snapshot)
      && mustCapture.every(record => orders.get(record.orderId)?.capturedMinor === record.orderTotalMinor
        && (record.kind === 'PHYSICAL' ? fulfilled : licensed).has(record.orderId))
      && resource(snapshot, 'notificationDeliveries').every(row => row.state === 'DELIVERED' && row.deliveredAt);
  },
  { timeoutMs: Math.max(1, killAt + spec.drainMs - Date.now()), intervalMs: 1000, processes: [...workers, ...dispatchers], label: 'catastrophe resolvable Work/outbox drain from actual kill time' });
  const drainMs = Date.now() - killAt; assert(drainMs <= spec.drainMs);
  assert(workerProbe.ledger.some(({ json, released }) => released === true && json.point === 'worker.claimed' && final.work.some(row => row.workId === json.workId && row.state === 'SUCCEEDED' && row.fencingToken >= json.fencingToken)), 'replacement Worker claimed and completed real Work');
  assert(dispatcherProbe.ledger.some(({ json, released }) => released === true && resource(final, 'notificationDeliveries').some(row => row.notificationDeliveryId === json.notificationDeliveryId && row.state === 'DELIVERED')), 'replacement dispatcher delivered real notification');
  const recovered = final.work.find(row => row.workId === claimed.workId);
  assert(recovered?.state === 'SUCCEEDED' && recovered.fencingToken > claimed.fencingToken && recovered.attempts > claimed.attempts);
  for (const item of admitted.settlement) {
    const { record, settlement } = settlements[item.index];
    const actual = resource(final, 'sellerSettlements').find(row => row.sellerSettlementId === settlement.sellerSettlementId);
    assertSettlement(actual, { allocationIds: [record.allocations.find(row => row.sellerId === settlement.sellerId).sellerAllocationId], grossMinor: 1001, feeMinor: settlementFee(1001), refundReserveMinor: 0, disputeReserveMinor: 0, netMinor: 1001 - settlementFee(1001) });
  }
  for (const item of admitted.dispute) {
    const actual = resource(final, 'commerceDisputes').find(row => row.commerceDisputeId === disputes[item.index].dispute.commerceDisputeId);
    assert.equal(actual.state, item.index % 2 ? 'LOST' : 'WON');
    const entries = resource(final, 'ledgerEntries').filter(row => row.orderId === item.orderId);
    assert.equal(entries.filter(row => row.account === 'CASH' && row.direction === 'CREDIT').reduce((sum, row) => sum + row.amountMinor, 0), item.index % 2 ? 100 : 0, 'one chargeback for LOST, none for WON');
  }
  for (const operation of provider.saved.values()) assert(operation.chargeCount <= 1, 'no duplicate provider charge during recovery');
  assert(!provider.ledger.some(row => row.protocolError), 'actual provider traffic obeys public dependency protocol');
  assert(receiver.ledger.filter(entry => entry.json?.eventId === dispatcherEntry.json.eventId).length >= 2, 'killed ACK was replayed');
  assertNotificationBytes(final, receiver.ledger); assertPerformanceInvariants(final);
  // Use the exact pre-kill token through the public operation, never database writes.
  semanticError(await ctx.mutate(apis[0].baseUrl, `/api/v1/fulfillment-plans/${killedPlan.fulfillmentPlanId}/complete`, ctx.key('catastrophe:stale-fence'), { fencingToken: claimed.fencingToken }), 409, 'STALE_FENCE');
  const afterStale = await ctx.snapshot(apis[0].baseUrl);
  assert.equal(stableSnapshot(afterStale), stableSnapshot(final), 'stale pre-kill token cannot add any business effect');
  ctx.mark('performance.catastrophe', { primaryEntities: 10_000, categories: { quoted: 2000, unknown: 2000, physical: 2000, digital: 2000, settlements: 1000, disputes: 1000 },
    supportCounts: Object.fromEntries(Object.entries(prepared.resources).map(([key, rows]) => [key, rows.length])),
    topology: { apis: 2, workers: 2, dispatchers: 2, clients: 64 }, admissionCadenceMs: 1000, workLeaseSeconds: 30,
    loadStartedAt, killAt, replacementAt, loadStoppedAt, drainMs,
    responses: Object.fromEntries(shares.map(share => [share, admitted[share].length])), transportFailuresDuringKill: transport.length });
  return ctx.pass();
}
