import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaseContext as createAccessContext } from '../evaluators/transfer/accesssentinel/v2/lib/runtime.mjs';
import { createCaseContext as createCreatorContext } from '../evaluators/transfer/creatorrightsexchange/v2/lib/runtime.mjs';

const workId = '10000000-0000-4000-8000-000000000001';
const options = { caseId: 'C-01', workspace: process.cwd(), evaluationSeed: 'barrier-auth-regression', manageDatabase: false };
const tasks = [
  ['AccessSentinel', createAccessContext, { schemaVersion: 1, processRole: 'worker', point: 'worker.claimed', workId, aggregateId: workId, attempt: 1, leaseTokenHash: 'a'.repeat(64) }],
  ['CreatorRightsExchange', createCreatorContext, { point: 'worker.claimed', kind: 'VIRUS_SCAN', workId, aggregateId: workId, attempt: 1, leaseToken: 'lease-token-regression' }],
];

for (const [name, createContext, payload] of tasks) {
  test(`${name} barrier accepts authenticated Bearer and existing token headers, rejecting conflicts`, async t => {
    const ctx = await createContext(options);
    t.after(() => ctx.teardown());
    const barrier = await ctx.barrier();
    const post = (headers, body = payload) => fetch(barrier.url, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    const bearer = { authorization: `Bearer ${barrier.token}` };
    const legacy = { 'x-test-barrier-token': barrier.token };
    assert.equal((await post(bearer)).status, 204);
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { 'x-test-barrier-token': 'wrong' }, { ...bearer, 'x-test-barrier-token': 'wrong' }, { ...legacy, authorization: 'Bearer wrong' }]) {
      assert.equal((await post(headers)).status, 401);
    }
    assert.equal(barrier.ledger.length, 1, 'unauthorized requests are not checkpoint evidence');
    for (const headers of [legacy, { ...bearer, ...legacy }]) assert.equal((await post(headers)).status, 204);
    const malformed = [{ event: 'worker.claimed' }, { ...payload, attempt: 0 }, { ...payload, point: '' }, { ...payload, point: 42 }, { ...payload, unexpected: true }];
    // Access publishes enumerated points; Creator publishes any non-empty point.
    if (name === 'AccessSentinel') malformed.push({ ...payload, point: 'dispatcher.external-response' });
    for (const body of malformed) {
      assert.equal((await post(bearer, body)).status, 400, 'authentication does not relax checkpoint payload validation');
    }
    assert.equal(barrier.ledger.length, 3, 'invalid frames cannot become checkpoint evidence');
  });

  test(`${name} valid Bearer checkpoint remains held until explicit release`, async t => {
    const ctx = await createContext(options);
    t.after(() => ctx.teardown());
    const barrier = await ctx.barrier({ hold: body => body.point === payload.point && body.workId === workId });
    t.after(() => barrier.releaseAll());
    let responded = false;
    const response = fetch(barrier.url, {
      method: 'POST', headers: { authorization: `Bearer ${barrier.token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
    }).then(value => { responded = true; return value; });
    const entry = await barrier.waitFor(row => row.json?.workId === workId);
    assert.deepEqual(entry.json, payload, 'checkpoint and lease identity remain unchanged');
    assert.equal(entry.released, false);
    assert.equal(entry.disconnected, false);
    assert.equal(responded, false);
    barrier.release(entry);
    assert.equal((await response).status, 204);
    assert.equal(entry.released, true);
  });
}
