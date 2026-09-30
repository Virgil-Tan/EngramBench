import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/creatorrightsexchange.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/creatorrightsexchange/v2/fixtures/index.mjs';
import { periodEntries } from '../evaluators/transfer/creatorrightsexchange/v2/oracles/index.mjs';
import { C_CASES } from '../evaluators/transfer/creatorrightsexchange/v2/cases/c.mjs';

test('period membership compares UTC instants, not the spelling of the timestamp', () => {
  const row = (id, createdAt) => ({ royaltyEntryId: id, createdAt });
  const rows = [row('before', '2032-04-05T06:07:07.999999Z'),
    row('start', '2032-04-05T06:07:08.000Z'), row('inside', '2032-04-05T06:07:08.000001Z'),
    row('near-end', '2032-04-05T06:07:08.999999Z'), row('end', '2032-04-05T06:07:09Z')];
  for (const [start, end] of [
    ['2032-04-05T06:07:08Z', '2032-04-05T06:07:09.000Z'],
    ['2032-04-05t06:07:08z', '2032-04-05T06:07:09+00:00'],
  ]) assert.deepEqual(periodEntries(rows, start, end).map(x => x.royaltyEntryId), ['start', 'inside', 'near-end']);
  assert.throws(() => periodEntries(rows, 'bad', '2032-04-05T06:07:09Z'));
});

test('chronological ordering preserves original JSON bytes and submillisecond differences', () => {
  const rows = [
    { royaltyEntryId: 'b', createdAt: '2032-04-05T06:07:08.000+00:00' },
    { royaltyEntryId: 'c', createdAt: '2032-04-05T06:07:08.000001Z' },
    { royaltyEntryId: 'a', createdAt: '2032-04-05t06:07:08z' },
  ];
  const original = structuredClone(rows), start = '2032-04-05T06:07:08Z', end = '2032-04-05T06:07:09Z';
  const ordered = periodEntries(rows, start, end);
  assert.deepEqual(ordered.map(row => row.royaltyEntryId), ['a', 'b', 'c']);
  assert.deepEqual(rows, original, 'oracle never rewrites the input');
  assert.deepEqual(ordered, [rows[2], rows[0], rows[1]]);
  // The newly published digest policy normalizes its own projection only;
  // general range/order helpers still never rewrite stored/public records.
});

async function runClaim(label, mutate = () => {}) {
  const fixtures = createFixtureFactory({ evaluationSeed: 'public-work-state', caseId: 'C-01', baseTime: '2032-04-05T06:07:08.000Z' });
  const family = fixtures.work();
    let released = false;
    const work = { workId: fixtures.uuid('durable-work'), kind: 'VIRUS_SCAN', aggregateId: fixtures.uuid('asset'),
      state: label, attempt: 1, leaseOwner: 'worker-a', leaseToken: null,
      leaseExpiresAt: fixtures.at({ seconds: 3 }), terminal: false };
    assert(validator(contract)(contract.schemas.DurableWork)(work), 'public contract permits this state spelling');
    const snapshot = () => ({ schemaVersion: 1, asOf: fixtures.at({ seconds: 5 }),
      resources: Object.fromEntries(Object.keys(contract.schemas.VerificationSnapshot.properties.resources.properties).map(k => [k, []])),
      work: [{ ...work, ...(released ? { terminal: true, state: 'DONE', leaseOwner: null, leaseExpiresAt: null } : {}) }], events: [] });
    const entry = { json: { point: 'worker.claimed', kind: work.kind, workId: work.workId,
      aggregateId: work.aggregateId, attempt: 1, leaseToken: 'private-worker-authority' } };
    const ctx = {
      fixtures, key: fixtures.key, caseId: 'C-01',
      migrate: async () => {}, seed: async () => {}, startApi: async () => ({ baseUrl: 'http://unused' }),
      startWorker: async () => ({}),
      mutate: async (_url, path) => ({ status: 200, json: path === '/api/v1/uploads' ? family.uploadSession : {} }),
      request: async () => ({ status: 200, json: {} }),
      barrier: async () => ({ url: 'http://barrier', token: 'secret', waitFor: async fn => {
        assert(fn(entry)); return entry;
      }, release: observed => { assert.equal(observed, entry); released = true; } }),
      snapshot: async () => { const value = snapshot(); mutate(value, released, entry); return value; },
      waitFor: async fn => { const value = await fn(); assert(value, 'terminal state must actually be observed'); return value; },
      equal: (a, b, message) => assert.deepEqual(a, b, message), ok: (condition, message) => assert.ok(condition, message),
      assert: (_label, fn) => fn(), pass: fields => ({ status: 'passed', ...fields }),
    };
    assert.equal((await C_CASES.find(c => c.id === 'C-01').run(ctx)).status, 'passed');
    assert(released);
}

test('the real C-01 checks lease authority rather than an unpublished Work state label', async () => {
  for (const label of ['LEASED', 'RUNNING', 'CLAIMED']) await runClaim(label);
  await runClaim('RUNNING', (value, released) => {
    if (released) value.work[0].state = 'LEASED'; // terminal, not this free-form label, is the public completion flag.
  });
});

test('the real C-01 still rejects absent lease evidence, wrong authority and token disclosure', async () => {
  for (const mutate of [
    value => { value.work = []; },
    value => { value.work[0].leaseOwner = null; },
    value => { value.work[0].leaseExpiresAt = null; },
    value => { value.work[0].leaseExpiresAt = 'not-a-time'; },
    value => { value.work[0].attempt += 1; },
    value => { value.work[0].kind = 'OTHER'; },
    value => { value.work[0].aggregateId = value.work[0].workId; },
    value => { value.work[0].terminal = true; },
    (value, _released, entry) => { value.work[0].leaseToken = entry.json.leaseToken; },
  ]) await assert.rejects(runClaim('RUNNING', mutate));
  await assert.rejects(runClaim('RUNNING', (value, released) => {
    if (released) value.work[0].terminal = false;
  }), /terminal state must actually be observed/);
});

test('positive Delivery seeds already contain referenced Events; foreign-key import order is submission-owned', () => {
  const factory = createFixtureFactory({ evaluationSeed: '41fc1ba05159cf805fffa7290fbd6abeb2c7b6af9ca59e23bc19f57d234e1d86', caseId: 'A-15', baseTime: '2026-09-08T00:00:00.000Z' });
  const validateSeed = validator(contract)(contract.seed.schema);
  for (const { seed } of [factory.notification(3), factory.notificationSeed(3)]) {
    assert(validateSeed(seed), JSON.stringify(validateSeed.errors));
    assert(seed.deliveries.length > 0);
    for (const delivery of seed.deliveries) {
      const notification = seed.notifications.find(row => row.notificationId === delivery.notificationId);
      const event = seed.events.find(row => row.eventId === delivery.eventId);
      assert(notification); assert(event);
      assert.equal(event.aggregateId, notification.aggregateId);
      assert.equal(event.sequence, notification.sequence);
      assert.deepEqual(event.payload, notification.payload);
    }
  }
});
