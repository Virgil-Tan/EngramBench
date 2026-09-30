import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/commercecommand.mjs';
import { D_CASES } from '../evaluators/transfer/commercecommand/v2/cases/d.mjs';
import { A_CASES } from '../evaluators/transfer/commercecommand/v2/cases/a.mjs';
import { recoveryGateController, assertRecoveryGateObserved, assertVisibleMinor } from '../evaluators/transfer/commercecommand/v2/cases/verification.mjs';

const uuid = '10000000-0000-4000-8000-000000000001';
const messages = [
  { point: 'worker.claimed', role: 'worker', kind: 'FULFILLMENT', workId: uuid, aggregateId: uuid, attempt: 1, fencingToken: 1 },
  { point: 'dispatcher.response-received', role: 'dispatcher', notificationDeliveryId: uuid, eventId: uuid, aggregateId: uuid, attempt: 1, fencingToken: 1, responseStatus: 204 },
];
function context(t) {
  const cleanups = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
  return { key: value => `public-regression-${value}`, defer: cleanup => cleanups.push(cleanup), pass: value => ({ status: 'passed', ...value }) };
}
const post = (env, body, headers = {}) => fetch(env.TEST_BARRIER_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TEST_BARRIER_TOKEN}`, ...headers }, body: JSON.stringify(body) });

test('Commerce publishes marketplace browser mappings and recovery gate forwarding without changing economic policy', () => {
  assert.equal(contract.policyRevision, 'commercecommand-2026-09-08.1');
  const text = contract.notes.join('\n');
  for (const seam of ['allocation-add-row', 'seller-allocations-submit', 'settlement-seller', 'settlement-period-start', 'settlement-period-end', 'settlement-currency', 'settlement-create', 'settlement-close', 'settlement-id', 'settlement-net-minor', 'order-total-minor', 'order-captured-minor', 'order-refunded-minor', 'dispute-create', 'dispute-resolve', 'adjustment-create']) assert(text.includes(seam), seam);
  assert(text.includes('must forward those exact values'));
  assert(text.includes('command must exit nonzero'));
  assert(text.includes('200 basis points'));
});

test('recovery verification controller observes real authenticated closed messages and actually rejects failures', async t => {
  const ctx = context(t), success = await recoveryGateController(ctx);
  assert.throws(() => assertRecoveryGateObserved(success), /worker.claimed/);
  assert.equal((await post(success.env, messages[0], { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(success.env, { ...messages[0], secret: 'not-public' })).status, 400);
  for (const message of messages) assert.equal((await post(success.env, message)).status, 204);
  assertRecoveryGateObserved(success);
  const rejecting = await recoveryGateController(ctx, { reject: true });
  assert.equal((await post(rejecting.env, messages[0])).status, 503);
  assert.equal(rejecting.ledger.length, 1);
});

test('actual D07 requires observed recovery barriers and nonzero failure sensitivity, not success-shaped diagnostics', async t => {
  const ctx = context(t), calls = [];
  let bypass = false, ignoreRejection = false;
  ctx.npm = async (gate, _args, options) => {
    calls.push(gate);
    if (options.env?.DATABASE_URL) return { exitCode: 1, stdout: 'postgres failed', stderr: '', durationMs: 1 };
    if (gate === 'test:recovery' && options.env?.TEST_BARRIER_URL && !bypass) {
      const results = await Promise.all(messages.map(message => post(options.env, message)));
      return { exitCode: ignoreRejection || results.every(response => response.ok) ? 0 : 1, stdout: 'test recovery verification', stderr: '', durationMs: 1 };
    }
    return { exitCode: 0, stdout: 'test execution evidence', stderr: '', durationMs: 1 };
  };
  const entry = D_CASES.find(row => row.id === 'D-07');
  const result = await entry.run(ctx);
  assert.equal(result.status, 'passed');
  assert.equal(result.diagnostics, undefined);
  assert.equal(calls.length, 9);
  bypass = true;
  await assert.rejects(entry.run(ctx), /actually reaches the rejecting public controller/);
  bypass = false; ignoreRejection = true;
  await assert.rejects(entry.run(ctx), /detects a rejected barrier/);
});

test('visible cross-layer money checks reject hidden controls, formatted guesses and incorrect totals', async () => {
  let visible = true, value = '880';
  const page = { getByTestId: () => ({ count: async () => 1, isVisible: async () => visible, textContent: async () => value }) };
  await assertVisibleMinor(page, 'order-total-minor', 880);
  value = '881'; await assert.rejects(assertVisibleMinor(page, 'order-total-minor', 880), /committed API/);
  value = '8.80'; await assert.rejects(assertVisibleMinor(page, 'order-total-minor', 880), /integer minor units/);
  value = '880'; visible = false; await assert.rejects(assertVisibleMinor(page, 'order-total-minor', 880), /is visible/);
});

test('A10 and D04/D06 execute setup and cannot return placeholder passes', async () => {
  const failure = new Error('real public setup required');
  const fixtures = new Proxy({}, { get: () => () => { throw failure; } });
  for (const entry of [...A_CASES.filter(row => row.id === 'A-10'), ...D_CASES.filter(row => ['D-04', 'D-06'].includes(row.id))]) {
    await assert.rejects(entry.run({ fixtures, pass: () => ({ status: 'passed' }), mark() {} }), error => error === failure, entry.id);
  }
});

test('actual A10 refuses a false-success fulfillment response for an unowned fencing token', async () => {
  const plan = { fulfillmentPlanId: uuid, orderId: uuid, state: 'PENDING', lines: [], fencingToken: 1 };
  const work = { workId: uuid, aggregateId: uuid, kind: 'FULFILLMENT', state: 'LEASED', terminal: false, attempts: 1, fencingToken: 1, leaseOwner: 'observed-worker', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
  let held;
  const ctx = { fixtures: { fulfillment: () => ({}), quoteBody: () => ({}) }, key: value => value, mark() {}, async migrate() {}, async seed() {},
    async startApi() { return { baseUrl: 'http://fixture' }; },
    async mutate(_base, path) { return { status: path.endsWith('/quotes') ? 201 : 200, json: { orderId: uuid, state: 'COMPLETED' } }; },
    async snapshot() { return { resources: { orders: [{ orderId: uuid, orderTotalMinor: 100 }], fulfillmentPlans: [plan] }, events: [], work: [work] }; },
    async barrier({ hold }) { return { url: 'http://controller', token: 'private-test-token', waitFor: async predicate => { const entry = { json: messages[0] }; hold(entry.json, entry); assert(predicate(entry)); return entry; } }; },
    async startWorker(options) { assert.equal(options.env.WORK_LEASE_SECONDS, '60'); held = true; return {}; },
    pass() { throw new Error('false success cannot reach pass'); },
  };
  await assert.rejects(A_CASES.find(row => row.id === 'A-10').run(ctx), /STALE_FENCE status/);
  assert(held);
});
