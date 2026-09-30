import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureFactory } from '../evaluators/transfer/coldchaincontrol/v2/fixtures/index.mjs';
import { createCustody } from '../evaluators/transfer/coldchaincontrol/v2/cases/helpers.mjs';
import { E_CASES } from '../evaluators/transfer/coldchaincontrol/v2/cases/e.mjs';
import contract from '../contracts/transfer/coldchaincontrol.mjs';
import { matchOperation, requestValidator } from '../templates/contract-first/runtime.mjs';

const asOf = '2026-09-07T18:55:56.000Z';
const factory = caseId => createFixtureFactory({ evaluationSeed: 'cold-clock-regression', caseId, baseTime: '2026-09-08T00:00:00.000Z' });
const expectedWindow = { windowStart: '2026-09-07T18:50:56.000Z', windowEnd: '2026-09-07T19:05:56.000Z' };

test('default custody creation uses database snapshot time, preserving the 15-minute window and explicit expiry input', async () => {
  const f = factory('A-16'), fixture = f.recall(), original = structuredClone(fixture.custodyBody), bodies = [];
  const ctx = { key: f.key, snapshot: async () => ({ asOf }), mutate: async (_base, _path, _key, body) => {
    bodies.push(body);
    return { status: 201, json: { custodyChainId: f.uuid('chain'), revision: 1 } };
  } };
  await createCustody(ctx, 'http://test', fixture);
  assert.deepEqual(Object.fromEntries(['windowStart', 'windowEnd'].map(key => [key, bodies[0].steps[0][key]])), expectedWindow);
  assert.deepEqual(fixture.custodyBody, original, 'anchoring a live request must not rewrite the deterministic fixture');
  const expiry = { ...original, steps: [{ ...original.steps[0], windowStart: '2026-09-07T18:55:55.000Z', windowEnd: '2026-09-07T18:55:59.000Z' }] };
  await createCustody(ctx, 'http://test', fixture, 'expiry', { body: expiry });
  assert.deepEqual(bodies[1], expiry, 'explicit expiry and negative-case input is never rebased');
});

test('E-08 prepares all 500 live offered handoffs with a current window after the full 10,000-shipment seed', async () => {
  const f = factory('E-08'), validate = requestValidator(contract), chains = new Map(), stop = new Error('public preparation observed');
  let seeded, offered = 0, revisionReads = 0;
  const ctx = { fixtures: f, at: f.at, key: f.key, receiver: async () => ({ url: 'http://receiver/events' }), migrate: async () => {},
    seed: async seed => { seeded = seed; }, startApi: async () => ({ baseUrl: 'http://test' }), snapshot: async () => ({ asOf }),
    concurrent: async (items, clients, operation) => { assert.equal(clients, 64); return Promise.all(items.map(operation)); },
    request: async (_base, path) => {
      const chain = chains.get(path.split('/').at(-1)); assert(chain); revisionReads++;
      return { status: 200, json: { chain: { ...chain, revision: 2 }, handoffs: [] } };
    },
    mutate: async (_base, path, key, body) => {
      const route = matchOperation(contract.operations, 'POST', path);
      const result = validate(route.operation, { params: route.params, headers: { 'content-type': 'application/json', 'idempotency-key': key }, body, hasBody: true });
      assert(result.valid, JSON.stringify(result));
      if (path === '/api/v1/custody-chains') {
        const step = body.steps[0];
        assert.deepEqual({ windowStart: step.windowStart, windowEnd: step.windowEnd }, expectedWindow);
        const custodyChainId = f.uuid(`created:${chains.size}`), chain = { custodyChainId, revision: 1, step };
        chains.set(custodyChainId, chain);
        return { status: 201, json: chain };
      }
      if (route.operation.id === 'offer-custody-handoff') {
        const chain = chains.get(route.params.chainId); assert(chain);
        assert(Date.parse(asOf) <= Date.parse(chain.step.windowEnd), 'database time permits offer');
        offered++;
        return { status: 200, json: { custodyHandoffId: f.uuid(`offered:${offered}`), ...chain.step } };
      }
      assert.equal(path, '/api/v1/recalls');
      throw stop;
    } };
  await assert.rejects(E_CASES.find(item => item.id === 'E-08').run(ctx), error => error === stop);
  assert.equal(seeded.shipments.length, 10_000);
  assert.equal(seeded.shipments.filter(row => row.productLotCode === 'PERF-TARGET-LOT').length, 2_500);
  assert.equal(chains.size, 500); assert.equal(offered, 500);
  assert.equal(revisionReads, 500, 'every offered chain is reread before subsequent accept races');
});
