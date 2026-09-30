import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { mock } from 'node:test';

// Execute the production orchestration module. Only its fixture, IO and clock
// boundaries are stand-ins: this checks error retention, not business success.
if (!process.argv[2]) {
  for (const scenario of ['main-and-load', 'main-only', 'load-only', 'success', 'slow-first']) {
    test(`Commerce catastrophe retains errors: ${scenario}`, () => {
      execFileSync(process.execPath, ['--experimental-test-module-mocks', fileURLToPath(import.meta.url), scenario], { stdio: 'pipe', timeout: 10_000 });
    });
  }
} else {
  const scenario = process.argv[2];
  const base = new URL('../evaluators/transfer/commercecommand/v2/', import.meta.url);
  const mainError = Object.assign(new Error('primary recovery failure'), { origin: 'candidate' });
  const loadError = new TypeError('concurrent load author failure');
  const records = Array.from({ length: 8000 }, (_, index) => ({
    index, stage: ['quoted', 'unknown', 'physical', 'digital'][Math.floor(index / 2000)],
    orderId: `o${index}`, paymentAttemptId: String(index), orderTotalMinor: 1000,
    kind: index < 6000 ? 'PHYSICAL' : 'DIGITAL',
    allocations: [{ sellerId: `seller${index}`, sellerAllocationId: `allocation${index}` }],
  }));
  const settlements = Array.from({ length: 1000 }, (_, index) => ({ sellerSettlementId: `s${4000 + index}`, sellerId: `seller${4000 + index}`, state: 'OPEN' }));
  const disputes = Array.from({ length: 1000 }, (_, index) => ({ commerceDisputeId: `d${5000 + index}`, state: 'OPEN' }));
  const plans = records.filter(row => row.kind === 'PHYSICAL').map(row => ({ orderId: row.orderId, fulfillmentPlanId: `p${row.index}`, state: 'COMPLETED' }));
  const before = { resources: { orders: records, sellerSettlements: settlements, commerceDisputes: disputes, fulfillmentPlans: plans } };
  const claim = { workId: 'work', aggregateId: 'p4000', attempts: 1, fencingToken: 1 };
  const final = { resources: {
    ...before.resources,
    orders: records.map(row => ({ ...row, capturedMinor: 1000 })),
    sellerSettlements: settlements.map(row => ({ ...row, state: 'CLOSED' })),
    commerceDisputes: disputes.map((row, i) => ({ ...row, state: i % 2 ? 'LOST' : 'WON' })),
    entitlementGrants: records.filter(row => row.kind === 'DIGITAL').map(row => ({ orderId: row.orderId, state: 'ACTIVE' })),
    notificationDeliveries: [{ notificationDeliveryId: 'delivery', state: 'DELIVERED', deliveredAt: 'done' }],
    ledgerEntries: disputes.flatMap((_, i) => i % 2 ? [{ orderId: `o${5000 + i}`, account: 'CASH', direction: 'CREDIT', amountMinor: 100 }] : []),
  }, work: [{ ...claim, state: 'SUCCEEDED', attempts: 2, fencingToken: 2 }] };
  let now = 0, killed = false, injected = false, snapshotCalls = 0;
  const sleepers = [];
  const pendingClaims = [];
  const immediate = () => new Promise(resolve => setImmediate(resolve));
  const releaseClients = () => sleepers.splice(0).forEach(resolve => resolve());
  mock.method(Date, 'now', () => now);
  mock.module('node:timers/promises', { namedExports: { setTimeout: async ms => {
    if (ms <= 1000) return new Promise(resolve => sleepers.push(resolve));
    await immediate();
    if (!killed) {
      now = 10_000;
      if (scenario === 'main-only') { setImmediate(releaseClients); throw mainError; }
      if (scenario === 'main-and-load') setImmediate(releaseClients);
    } else {
      releaseClients();
      await immediate();
      now = 20_000;
      setImmediate(releaseClients);
    }
  } } });
  mock.module(new URL('cases/performance.mjs', base), { namedExports: {
    PERF_ENV: {}, performanceFixture: () => ({ records }),
    preparePerformance: async () => ({ apis: [{ baseUrl: 'a' }, { baseUrl: 'b' }], snapshot: before }),
    prepareConcurrently: async (_, rows, concurrency, fn) => Promise.all(rows.map(fn)),
    proposeSettlement: async (_, url, record) => settlements[record.index - 4000],
    assertPerformanceInvariants() {}, dueWorkDrained: () => true,
  } });
  mock.module(new URL('cases/recovery.mjs', base), { namedExports: {
    sandboxProvider: async () => ({ url: 'provider', saved: new Map(), ledger: [], revealCaptures() {} }),
    assertHeldClaim: () => claim, assertNotificationBytes() {},
  } });
  mock.module(new URL('oracles/index.mjs', base), { namedExports: {
    resource: (snapshot, name) => snapshot.resources[name] ?? [], stableSnapshot: JSON.stringify,
  } });
  mock.module(new URL('oracles/economic-policy.mjs', base), { namedExports: { assertSettlement() {}, settlementFee: () => 0 } });
  mock.module(new URL('cases/helpers.mjs', base), { namedExports: {
    successful: response => response, semanticError() {},
    waitSnapshot: async (_, url, predicate) => { assert(predicate(final)); return final; },
  } });
  const barriers = [];
  function emit(barrier, json) {
    const entry = { json, released: false };
    entry.released = !barrier.hold(json, entry);
    barrier.ledger.push(entry);
    return entry;
  }
  const ctx = {
    fixtures: { performance: () => ({ scenarios: { catastrophe: { entities: 10_000, drainMs: 300_000 } } }) },
    key: value => value, uuid: value => value,
    mutate: async (_, path, key, body) => {
      if (!injected && path.endsWith('/checkout') && (scenario === 'main-and-load' || scenario === 'load-only' && killed)) {
        injected = true; throw loadError;
      }
      return { status: 201, json: { commerceDisputeId: `d${body.paymentAttemptId}` }, text: '{}' };
    },
    snapshot: async () => ++snapshotCalls <= 2 ? before : final,
    barrier: async ({ hold }) => {
      const barrier = { hold, ledger: [], waitFor: async predicate => barrier.ledger.find(predicate) };
      barriers.push(barrier); return barrier;
    },
    receiver: async () => ({ ledger: [{ json: { eventId: 'event' }, acknowledged: true }, { json: { eventId: 'event' }, acknowledged: true }] }),
    startWorker: async () => {
      if (killed) emit(barriers[3], { point: 'worker.claimed', workId: 'work', kind: 'FULFILLMENT', aggregateId: 'p4000', fencingToken: 2 });
      return {};
    },
    startDispatcher: async () => {
      if (killed) emit(barriers[4], { notificationDeliveryId: 'delivery' });
      return {};
    },
    startApi: async () => ({ baseUrl: 'replacement' }),
    kill: async process => { process.stopped = true; killed = true; },
    waitFor: async (predicate, options) => {
      if (options.label === 'catastrophe Worker claimed barrier') {
        pendingClaims.splice(0).forEach(resolve => resolve(1));
        emit(barriers[2], { point: 'dispatcher.response-received', responseStatus: 204, eventId: 'event' });
        emit(barriers[0], { point: 'worker.claimed', kind: 'FULFILLMENT', aggregateId: 'p4000' });
        return predicate();
      }
      if (scenario === 'slow-first' && !killed && options.label === 'public fulfillment claim authority for catastrophe client')
        return new Promise(resolve => pendingClaims.push(resolve));
      return 1;
    },
    mark() {}, pass: () => ({ status: 'passed' }),
  };
  const { fullCatastrophe } = await import(new URL('cases/performance-recovery.mjs', base));
  let thrown, result;
  try { result = await fullCatastrophe(ctx); } catch (error) { thrown = error; }
  if (scenario === 'main-only') assert.equal(thrown, mainError, 'a lone primary error retains identity');
  else if (scenario === 'success' || scenario === 'slow-first') { assert.equal(thrown, undefined); assert.equal(result.status, 'passed'); }
  else {
    assert(thrown instanceof AggregateError, 'load errors cannot disappear behind a derived primary assertion');
    assert(thrown.errors.includes(loadError), 'retain the original TypeError object');
    assert.equal(thrown.errors.length, scenario === 'main-and-load' ? 2 : 1);
    if (scenario === 'main-and-load') assert(thrown.errors.some(error => /all six public shares active/.test(error.message)));
    const { executeCase } = await import('../src/task-evaluator-v2/execution.mjs');
    const outcome = await executeCase({ definition: { id: 'E-13', dimension: 'E', weight: 1 },
      implementation: { run: async () => { throw thrown; } }, withContext: async (_, fn) => fn({}), contextOptions: {}, failureCodePrefix: 'CC_' });
    assert.equal(outcome.status, 'evaluator_error', 'a load TypeError must not be attributed to the candidate');
    assert(outcome.privateErrorDetails.some(error => error.message === loadError.message));
  }
}
