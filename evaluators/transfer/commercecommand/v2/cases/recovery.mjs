import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { canonicalJson, resource, sha256 } from '../oracles/index.mjs';
import { waitSnapshot } from './helpers.mjs';

export async function heldWorker(ctx, kind, { point = 'worker.claimed', env = {}, aggregateId, workId, leaseSeconds = 2 } = {}) {
  assert(Number.isInteger(leaseSeconds) && leaseSeconds >= 1 && leaseSeconds <= 300, 'WORK_LEASE_SECONDS must be an integer in 1..300');
  let held;
  const barrier = await ctx.barrier({ hold: (body, entry) => {
    if (!held && body.role === 'worker' && body.point === point && body.kind === kind
      && (!aggregateId || body.aggregateId === aggregateId) && (!workId || body.workId === workId)) {
      held = entry;
      return true;
    }
    return false;
  } });
  const worker = await ctx.startWorker({ env: { ...env, WORK_LEASE_SECONDS: String(leaseSeconds), TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  return { worker, barrier, wait: () => barrier.waitFor(entry => entry === held, { timeoutMs: 60_000, processes: [worker], label: `${kind} ${point}` }) };
}

export function assertHeldClaim(snapshot, entry) {
  const body = entry.json;
  const work = snapshot.work.find(row => row.workId === body.workId);
  assert.ok(work, 'barrier refers to real persisted Work');
  assert.equal(work.kind, body.kind);
  assert.equal(work.aggregateId, body.aggregateId);
  assert.equal(work.state, 'LEASED');
  assert.equal(work.terminal, false);
  assert.equal(work.attempts, body.attempt);
  assert.equal(work.fencingToken, body.fencingToken);
  assert.ok(work.leaseOwner && Number.isFinite(Date.parse(work.leaseExpiresAt)), 'claim owner and expiry persisted');
  return work;
}

export async function recoverWorker(ctx, baseUrl, held, { env = {}, keepAlive = false } = {}) {
  const entry = await held.wait();
  const claim = assertHeldClaim(await ctx.snapshot(baseUrl), entry);
  await ctx.kill(held.worker);
  assert.equal(held.worker.stopped, true, 'original Worker was actually killed');
  const replacement = await ctx.startWorker({ env: { ...env, WORK_LEASE_SECONDS: '2' } });
  const snapshot = await waitSnapshot(ctx, baseUrl, value => {
    const work = value.work.find(row => row.workId === claim.workId);
    return work?.state === 'SUCCEEDED' && work.terminal;
  }, { timeoutMs: 120_000, processes: [replacement], label: `${claim.kind} replacement completes same Work` });
  const current = snapshot.work.find(row => row.workId === claim.workId);
  assert.ok(current.attempts > claim.attempts && current.fencingToken > claim.fencingToken, 'replacement reclaimed with a higher attempt and fence');
  if (!keepAlive) await ctx.stop(replacement);
  ctx.mark('recovery.reclaimed', { kind: claim.kind, workId: claim.workId, originalAttempt: claim.attempts, replacementAttempt: current.attempts, originalFence: claim.fencingToken, replacementFence: current.fencingToken });
  return { entry, claim, replacement, snapshot };
}

export function assertCaptureNotRepeated(before, after) {
  for (const key of ['inventoryPools', 'inventoryHolds', 'orderLines', 'paymentAttempts', 'ledgerEntries']) {
    assert.deepEqual(resource(after, key), resource(before, key), `${key}: recovering fulfillment cannot repeat capture or stock consumption`);
  }
  for (const event of before.events) assert.deepEqual(after.events.find(row => row.eventId === event.eventId), event, 'existing Event remains immutable');
}

export function assertOrderEvidence(snapshot, orderIds) {
  for (const orderId of orderIds) {
    const events = snapshot.events.filter(row => row.aggregateId === orderId);
    const notifications = resource(snapshot, 'notificationDeliveries').filter(row => row.orderId === orderId);
    assert.ok(events.length > 0, 'business Order has committed Events');
    for (const event of events) {
      const rows = notifications.filter(row => row.eventId === event.eventId);
      assert.equal(rows.length, 1, 'each Order Event has exactly one logical notification');
      assert.equal(rows[0].tenantId, event.tenantId);
      assert.equal(rows[0].aggregateSequence, event.aggregateSequence);
    }
    assert.equal(notifications.length, events.length, 'no orphan or duplicate notification');
  }
}

export function assertNotificationBytes(snapshot, entries) {
  const first = new Map(), highest = new Map();
  const deliveries = new Map(), events = new Map();
  for (const row of resource(snapshot, 'notificationDeliveries')) if (!deliveries.has(row.notificationDeliveryId)) deliveries.set(row.notificationDeliveryId, row);
  for (const row of snapshot.events) if (!events.has(row.eventId)) events.set(row.eventId, row);
  for (const entry of entries) {
    assert.equal(entry.method, 'POST');
    assert.match(entry.headers['content-type'] ?? '', /^application\/json(?:;|$)/i);
    const delivery = deliveries.get(entry.json?.notificationDeliveryId);
    assert.ok(delivery, 'wire notification identity exists in durable snapshot');
    const frozen = { ...delivery, state: 'PENDING', attempts: 0, deliveredAt: null };
    delete frozen.bodyDigest;
    const expected = { ...frozen, bodyDigest: sha256(canonicalJson(frozen)) };
    assert.equal(delivery.bodyDigest, expected.bodyDigest, 'persisted digest matches frozen wire digest');
    assert.equal(entry.raw.toString(), canonicalJson(expected), 'wire body is canonical frozen notification including non-self-referential digest');
    assert.equal(entry.headers['x-event-id'], delivery.eventId);
    assert.equal(entry.headers['x-aggregate-sequence'], String(delivery.aggregateSequence));
    const event = events.get(delivery.eventId);
    assert.ok(event && event.aggregateId === delivery.orderId && event.aggregateSequence === delivery.aggregateSequence, 'wire links to the committed Order Event');
    if (first.has(delivery.eventId)) assert.equal(entry.raw.toString(), first.get(delivery.eventId), 'retry bytes never change');
    else {
      assert.ok(delivery.aggregateSequence > (highest.get(delivery.orderId) ?? -1), 'first delivery attempts preserve per-Order order');
      first.set(delivery.eventId, entry.raw.toString());
      highest.set(delivery.orderId, delivery.aggregateSequence);
    }
  }
}

// A test-owned dependency implementing only the published HTTP provider protocol.
export async function sandboxProvider(ctx, { disconnectFirstAcceptance = false } = {}) {
  const saved = new Map(), ledger = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://provider');
      assert.equal(request.headers.authorization, undefined, 'no application credential sent to sandbox provider');
      assert.equal(request.headers['x-test-barrier-token'], undefined, 'no barrier credential sent to sandbox provider');
      let operation;
      if (request.method === 'POST' && url.pathname === '/payments') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.deepEqual(Object.keys(body).sort(), ['amountMinor', 'currency', 'providerRequestId', 'tenantId']);
        assert.equal(request.headers['idempotency-key'], body.providerRequestId);
        assert.ok(Number.isSafeInteger(body.amountMinor) && body.amountMinor > 0);
        const key = `${body.tenantId}\0${body.providerRequestId}`;
        operation = saved.get(key);
        if (operation && canonicalJson(operation.request) !== canonicalJson(body)) {
          response.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'PROVIDER_REQUEST_CONFLICT', message: 'operation identity reused', details: {} } }));
          return;
        }
        if (!operation) {
          operation = { request: body, outcome: 'UNKNOWN', capturedMinor: 0, chargeCount: 0 };
          saved.set(key, operation);
          if (disconnectFirstAcceptance) {
            operation.chargeCount = 1;
            ledger.push({ method: 'POST', key, accepted: true, responseDelivered: false });
            response.destroy();
            return;
          }
        }
        ledger.push({ method: 'POST', key, accepted: true, responseDelivered: true });
      } else if (request.method === 'GET' && url.pathname.startsWith('/payments/')) {
        const key = `${url.searchParams.get('tenantId')}\0${decodeURIComponent(url.pathname.slice('/payments/'.length))}`;
        operation = saved.get(key);
        ledger.push({ method: 'GET', key, responseDelivered: true });
      } else { response.writeHead(404).end(); return; }
      if (!operation) { response.writeHead(404).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ providerRequestId: operation.request.providerRequestId, outcome: operation.outcome, capturedMinor: operation.capturedMinor }));
    } catch (error) {
      ledger.push({ protocolError: error.message });
      response.writeHead(400).end();
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  ctx.defer(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, ledger, saved, revealCaptures() {
    for (const operation of saved.values()) if (operation.chargeCount === 1) {
      operation.outcome = 'CAPTURED'; operation.capturedMinor = operation.request.amountMinor;
    }
  } };
}
