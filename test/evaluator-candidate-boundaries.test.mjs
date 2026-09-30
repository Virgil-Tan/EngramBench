import test from 'node:test';
import assert from 'node:assert/strict';
import * as execution from '../src/task-evaluator-v2/execution.mjs';
import { assertCapacitySlices } from '../evaluators/transfer/capacitylease/v2/lib/oracle.mjs';
import { assertEvents } from '../evaluators/transfer/escrowguard/v2/oracles/index.mjs';
import { localDateTimeValue } from '../src/task-evaluator-v2/browser.mjs';
import { A_CASES } from '../evaluators/transfer/capacitylease/v2/cases/a.mjs';
import { createCaseContext } from '../evaluators/transfer/capacitylease/v2/lib/runtime.mjs';
import { E_CASES } from '../evaluators/transfer/capacitylease/v2/cases/e.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { visibleControl, visibleField } from '../evaluators/transfer/escrowguard/v2/cases/helpers.mjs';

const run = operation => execution.executeCase({ definition: { id: 'A-03', dimension: 'A', weight: 1 },
  implementation: { run: operation }, withContext: async (_, fn) => fn({}), contextOptions: {}, failureCodePrefix: 'CHECK_' });

test('explicit candidate assertions classify sync and async assertion failures only', async () => {
  assert.equal(typeof execution.candidateAssert, 'function');
  for (const operation of [() => execution.candidateAssert.equal(0, 1),
    () => execution.candidateAssert.rejects(Promise.resolve()),
    () => execution.candidateAssert(false)]) {
    assert.equal((await run(operation)).status, 'failed');
  }
  for (const error of [new TypeError('oracle programming error'), new Error('unknown'),
    Object.assign(new assert.AssertionError({ message: 'author precondition' }), { origin: 'evaluator' })]) {
    const result = await run(() => execution.candidateAssert.throws(() => { throw error; }, /different expectation/));
    // The original author exception must remain visible through assertion wrapping.
    assert.equal(result.status, 'evaluator_error');
  }
});

test('raw assertions outside an explicit candidate seam still fail closed', async () => {
  assert.equal((await run(() => assert.equal(0, 1, 'author fixture invariant'))).status, 'evaluator_error');
});

test('real Escrow oracle rejects malformed submitted event fields as candidate failure', async () => {
  assert.equal((await run(() => assertEvents([{ eventId: 'not-a-uuid' }]))).status, 'failed');
});

test('real Capacity oracle marks published slice mismatch, not invalid oracle input', async () => {
  const pool = { poolId: 'p', capacityUnits: 10 };
  const lease = { leaseId: 'l', poolId: 'p', units: 2, state: 'HELD', startAt: '2030-01-01T00:00:00Z', endAt: '2030-01-01T01:00:00Z' };
  assert.equal((await run(() => assertCapacitySlices({ pools: [pool], leases: [lease], slices: [] }))).status, 'failed');
  assert.equal((await run(() => assertCapacitySlices({ pools: [pool, pool], leases: [lease], slices: [] }))).status, 'evaluator_error');
});

test('datetime-local normalization preserves nonzero seconds and fractional precision', () => {
  assert.equal(localDateTimeValue('2035-04-03T00:00:00.000Z'), '2035-04-03T00:00');
  assert.equal(localDateTimeValue('2035-04-03T00:00:12.120Z'), '2035-04-03T00:00:12.12');
  assert.equal(localDateTimeValue('2035-04-03T00:00:00.001Z'), '2035-04-03T00:00:00.001');
});

test('real Escrow UI helpers wait for delayed semantic controls instead of snapshot-counting', async () => {
  let waits = 0;
  const locator = { or() { return this; }, and() { return this; }, first() { return this; },
    count() { assert(waits > 0, 'count must follow a visibility wait'); return 1; },
    async waitFor(options) { assert.equal(options.state, 'visible'); await Promise.resolve(); waits++; } };
  const page = { getByRole: () => locator, getByLabel: () => locator, locator: () => locator };
  assert.equal(await visibleControl(page, ['button', 'link'], [/submit/i]), locator);
  assert.equal(await visibleField(page, [/evidence/i]), locator);
  assert.equal(waits, 3);
});

test('real A-16 accepts published legacy HeldLease without inline members and still checks member endpoint', async t => {
  const ctx = await createCaseContext({ caseId: 'A-16', workspace: process.cwd(), evaluationSeed: 'boundary', manageDatabase: false });
  t.after(() => ctx.teardown());
  const stop = new Error('reached-invalid-cases');
  const members = new Map(); let creates = 0, memberReads = 0;
  Object.assign(ctx, { migrate: async () => {}, seed: async () => ({ exitCode: 0 }), startApi: async () => ({ baseUrl: 'http://test' }),
    request: async (_, path) => {
      if (path === '/openapi.json') return { status: 200, json: { GANG_STATE_CONFLICT: true } };
      memberReads++; return { status: 200, json: { items: members.get(path.split('/')[4]) } };
    },
    mutate: async (_, path, key, body) => {
      if (creates === 4) throw stop;
      creates++; const leaseId = ctx.uuid('lease-'+creates), items = (body.members ?? [{ poolId: body.poolId, units: body.units }])
        .toSorted((a,b) => Buffer.from(a.poolId).compare(Buffer.from(b.poolId)))
        .map((m,i) => ({ ...m, leaseId, memberId: ctx.uuid('member-'+creates+'-'+i), ordinal: i+1 }));
      members.set(leaseId, items);
      return { status: 201, json: { leaseId, poolId: body.members ? null : body.poolId, units: body.members ? null : body.units,
        ...(body.members ? { members: items } : {}) } };
    } });
  await assert.rejects(A_CASES.find(c => c.id === 'A-16').run(ctx), error => error === stop);
  assert.equal(creates, 4); assert.equal(memberReads, 4);
});

test('real E-07 labels only intentional malformed seed invalid at the real public boundary', async t => {
  const workspace = new URL('../task-packages/v2/capacitylease/workspace/', import.meta.url).pathname;
  const boundary = await evaluatorContract(new URL('../task-packages/v2/capacitylease/public-contract/', import.meta.url).pathname);
  const ctx = await createCaseContext({ caseId: 'E-07', workspace, evaluationSeed: 'boundary', manageDatabase: false });
  t.after(() => ctx.teardown());
  let invalidSeeds = 0;
  const role = () => ({ baseUrl: 'http://test', child: { exitCode: null }, logs: '' });
  Object.assign(ctx, {
    command: async () => ({ exitCode: 0, stdout: '' }), migrate: async () => {}, resetDatabase: async () => {}, stop: async () => {},
    startApi: async () => role(), startWorker: async () => role(), startDispatcher: async () => role(),
    receiver: async () => ({ url: 'http://receiver' }), snapshot: async () => ({ asOf: '2030-01-01T00:00:00Z', resources: {} }),
    mutate: async () => ({ status: 201, json: {} }), request: async () => { throw new Error('expected stopped service'); },
    seed: async (value, options) => {
      boundary.seed(value, options);
      if ('hiddenUnknownMember' in value) { invalidSeeds++; assert.equal(options.contractExpectation, 'invalid'); return { exitCode: 1 }; }
      assert.notEqual(options?.contractExpectation, 'invalid'); return { exitCode: 0 };
    },
  });
  await E_CASES.find(c => c.id === 'E-07').run(ctx);
  assert.equal(invalidSeeds, 1);
  assert.throws(() => boundary.seed({ hiddenUnknownMember: [] }, { allowFailure: true }), /Hidden positive seed/);
});
