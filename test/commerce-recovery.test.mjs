import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseRuntime } from '../src/task-evaluator-v2/runtime.mjs';
import { createCaseContext, validateBarrierPayload } from '../evaluators/transfer/commercecommand/v2/lib/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/commercecommand/v2/fixtures/index.mjs';
import { assertHeldClaim, assertNotificationBytes, recoverWorker, sandboxProvider } from '../evaluators/transfer/commercecommand/v2/cases/recovery.mjs';
import { C_CASES } from '../evaluators/transfer/commercecommand/v2/cases/c.mjs';
import { canonicalJson, sha256 } from '../evaluators/transfer/commercecommand/v2/oracles/index.mjs';

const uuid = '10000000-0000-4000-8000-000000000001';
const workerMessage = { point: 'worker.claimed', role: 'worker', kind: 'FULFILLMENT', workId: uuid, aggregateId: uuid, attempt: 1, fencingToken: 1 };
const options = { caseId: 'C-02', workspace: process.cwd(), evaluationSeed: 'public-recovery-contract', manageDatabase: false };

test('Commerce barriers accept every published Work kind and only closed role-specific bodies', () => {
  for (const kind of ['QUOTE_EXPIRY', 'PAYMENT_RECONCILIATION', 'FULFILLMENT', 'ENTITLEMENT_GRANT', 'ENTITLEMENT_REVOCATION', 'SELLER_SETTLEMENT_CLOSE', 'DISPUTE_RECONCILIATION', 'SETTLEMENT_ADJUSTMENT']) {
    for (const point of ['worker.claimed', 'worker.before-effect']) assert(validateBarrierPayload({ ...workerMessage, kind, point }));
  }
  const dispatcher = { point: 'dispatcher.response-received', role: 'dispatcher', notificationDeliveryId: uuid, eventId: uuid, aggregateId: uuid, attempt: 1, fencingToken: 1, responseStatus: 204 };
  assert(validateBarrierPayload(dispatcher));
  for (const invalid of [{ ...workerMessage, fencingToken: 0 }, { ...workerMessage, attempt: 0 }, { ...workerMessage, secret: 'not-allowed' }, { ...workerMessage, workId: 'made-up' }, { ...workerMessage, point: 'worker.after-attempt' }, { ...dispatcher, workId: uuid }, { ...dispatcher, responseStatus: 600 }]) assert.equal(validateBarrierPayload(invalid), false);
});

test('real HTTP Commerce barrier accepts Bearer, rejects legacy token header, and actually holds until release', async t => {
  const ctx = await createCaseContext(options); t.after(() => ctx.teardown());
  const barrier = await ctx.barrier({ hold: () => true });
  const post = headers => fetch(barrier.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(workerMessage) });
  assert.equal((await post({ 'x-test-barrier-token': barrier.token })).status, 401);
  let resolved = false;
  const response = post({ authorization: `Bearer ${barrier.token}` }).then(value => { resolved = true; return value; });
  const entry = await barrier.waitFor(row => row.json?.workId === uuid);
  assert.equal(resolved, false); assert.equal(entry.released, false);
  barrier.release(entry);
  assert.equal((await response).status, 204);
});

test('the shared runtime default still accepts X-Test-Barrier-Token, not Bearer', async t => {
  const runtime = createCaseRuntime({ taskSlug: 'regression', databasePrefix: 'regression', snapshotPath: '/snapshot', createFixtureFactory, adaptCompatibilityResponse: (_adapter, response) => response.json, assertCompatibilityAdapter() {}, validateBarrierPayload: () => true });
  const ctx = await runtime.createCaseContext(options); t.after(() => ctx.teardown());
  const barrier = await ctx.barrier();
  const post = headers => fetch(barrier.url, { method: 'POST', headers, body: '{}' });
  assert.equal((await post({ authorization: `Bearer ${barrier.token}` })).status, 401);
  assert.equal((await post({ 'x-test-barrier-token': barrier.token })).status, 204);
});

test('replacement recovery must kill the observed owner and prove a larger claim on the same Work', async () => {
  const claim = { workId: uuid, kind: 'FULFILLMENT', aggregateId: uuid, state: 'LEASED', terminal: false, attempts: 1, fencingToken: 1, leaseOwner: 'old', leaseExpiresAt: new Date(Date.now() + 2000).toISOString() };
  const entry = { json: workerMessage }, old = {}, replacement = { child: { exitCode: null } };
  let current = claim, killed = false, stopped = false;
  const ctx = { snapshot: async () => ({ work: [current] }), async kill(value) { assert.equal(value, old); killed = true; value.stopped = true; }, async startWorker() { assert(killed, 'replacement must not start before killing original'); return replacement; }, async waitFor(predicate) { current = { ...claim, state: 'SUCCEEDED', terminal: true, attempts: 2, fencingToken: 2 }; return predicate(); }, async stop(value) { assert.equal(value, replacement); stopped = true; }, mark() {} };
  await recoverWorker(ctx, 'http://unused', { worker: old, wait: async () => entry });
  assert(stopped);
  assert.throws(() => assertHeldClaim({ work: [{ ...claim, fencingToken: 2 }] }, entry), /2 !== 1/);
  current = claim; killed = false;
  ctx.waitFor = async predicate => { current = { ...claim, state: 'SUCCEEDED', terminal: true }; return predicate(); };
  await assert.rejects(recoverWorker(ctx, 'http://unused', { worker: old, wait: async () => entry }), /higher attempt and fence/);
});

test('notification oracle checks exact frozen bytes, digest, persisted identity and retry stability', () => {
  const delivery = { notificationDeliveryId: uuid, tenantId: uuid, orderId: uuid, eventId: uuid, aggregateSequence: 1, state: 'DELIVERED', attempts: 3, createdAt: '2026-09-07T00:00:00.000Z', deliveredAt: '2026-09-07T00:00:05.000Z', bodyDigest: 'placeholder' };
  const frozen = { ...delivery, state: 'PENDING', attempts: 0, deliveredAt: null }; delete frozen.bodyDigest;
  const json = { ...frozen, bodyDigest: sha256(canonicalJson(frozen)) };
  delivery.bodyDigest = json.bodyDigest;
  const entry = { method: 'POST', headers: { 'content-type': 'application/json', 'x-event-id': uuid, 'x-aggregate-sequence': '1' }, json, raw: canonicalJson(json) };
  const snapshot = { resources: { notificationDeliveries: [delivery] }, events: [{ eventId: uuid, aggregateId: uuid, aggregateSequence: 1 }] };
  assertNotificationBytes(snapshot, [entry, entry]);
  assert.throws(() => assertNotificationBytes(snapshot, [entry, { ...entry, raw: JSON.stringify({ ...json, attempts: 3 }) }]), /canonical frozen/);
  assert.throws(() => assertNotificationBytes(snapshot, [{ ...entry, headers: { ...entry.headers, 'x-event-id': 'wrong' } }]));
});

test('test-owned provider really accepts once, loses response, and later reveals the same capture', async t => {
  const ctx = await createCaseContext(options); t.after(() => ctx.teardown());
  const provider = await sandboxProvider(ctx, { disconnectFirstAcceptance: true });
  const body = { tenantId: uuid, providerRequestId: 'merchant-stable', amountMinor: 123, currency: 'USD' };
  const post = () => fetch(`${provider.url}/payments`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': body.providerRequestId }, body: JSON.stringify(body) });
  await assert.rejects(post(), /fetch failed/);
  assert.equal((await (await post()).json()).outcome, 'UNKNOWN');
  provider.revealCaptures();
  const response = await fetch(`${provider.url}/payments/merchant-stable?tenantId=${uuid}`);
  assert.deepEqual(await response.json(), { providerRequestId: 'merchant-stable', outcome: 'CAPTURED', capturedMinor: 123 });
  assert.equal(provider.saved.size, 1); assert.equal([...provider.saved.values()][0].chargeCount, 1);
  assert(provider.ledger.some(row => row.accepted && !row.responseDelivered));
  assert.equal((await (await post()).json()).capturedMinor, 123);
});

test('C02-C08 cannot pass by returning a blocked placeholder before attempting setup', async () => {
  for (const entry of C_CASES.filter(row => row.id !== 'C-01')) {
    const failure = new Error('real case requires setup');
    const fixtureFactory = new Proxy({}, { get: () => () => { throw failure; } });
    await assert.rejects(entry.run({ fixtures: fixtureFactory, pass: () => ({ status: 'passed' }), mark() {} }), error => error === failure, entry.id);
  }
});
