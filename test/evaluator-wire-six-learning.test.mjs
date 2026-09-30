import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { makeCoreSeed } from '../evaluators/learning/rulebench/v2/fixtures/index.mjs';
import * as media from '../evaluators/learning/mediadock/v2/lib/fixtures.mjs';
import * as entitlement from '../evaluators/learning/entitlementhub/v2/fixtures/index.mjs';
import * as moderation from '../evaluators/learning/moderationflow/v2/fixtures/index.mjs';
import * as identity from '../evaluators/learning/identitymesh/v2/lib/fixtures.mjs';
import * as seat from '../evaluators/learning/seatreserve/v2/fixtures/index.mjs';
import { formalSeed } from '../evaluators/learning/seatreserve/v2/cases/helpers.mjs';
import { checkoutHold } from '../evaluators/learning/seatreserve/v2/cases/helpers.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeFormalSeed } from '../evaluators/learning/entitlementhub/v2/cases/helpers.mjs';
import { CASES as ruleCases } from '../evaluators/learning/rulebench/v2/cases/index.mjs';
import { createFixtureFactory as ruleFactory } from '../evaluators/learning/rulebench/v2/fixtures/index.mjs';
import { GRANT_KEYS } from '../evaluators/learning/mediadock/v2/cases/helpers.mjs';
import { claimStage, decideStage, createAppeal } from '../evaluators/learning/moderationflow/v2/cases/helpers.mjs';

const options = { evaluationSeed: 'author-wire-regression', caseId: 'A-01', baseTime: '2026-01-01T00:00:00.000Z' };
const boundary = async (id) => evaluatorContract(resolve('task-packages/v2', id, 'public-contract'));
const seeds = {
  rulebench: () => [makeCoreSeed(options).seed],
  mediadock: () => [media.seedFixture(media.createFixtureFactory(options), 'regression')],
  entitlementhub: () => {
    const f = entitlement.createFixtureFactory(options);
    return ['contract', 'data', 'recovery', 'layer', 'operate', 'v1Final'].map((name) => f[name]().seed);
  },
  moderationflow: () => [moderation.createFixtureFactory(options).baseSeed()],
  identitymesh: () => {
    const f = identity.createFixtureFactory(options);
    const catalog = identity.identityCatalog(f);
    const auditEntries = identity.auditSeed(f, catalog, 2);
    return [identity.v1Seed(f), identity.v1Seed(f, 'audit', { catalogs: [catalog], auditEntries, auditCheckpoints: [identity.auditCheckpoint(catalog, auditEntries)] })];
  },
  seatreserve: () => {
    const f = seat.createFixtureFactory(options);
    return [...['contract', 'payment', 'waitlist', 'recovery', 'browser', 'v1Final', 'performance'].map((name) => f[name]().seed), formalSeed({ version: 'regression', seatCount: 3 }).seed];
  },
};

for (const [id, fixtures] of Object.entries(seeds)) {
  test(`${id}: every positive seed family matches the fixed public contract`, async () => {
    const wire = await boundary(id);
    for (const [index, seed] of fixtures().entries()) {
      assert.doesNotThrow(() => wire.seed(seed), `${id} fixture ${index}`);
    }
  });
}

test('MediaDock grant oracle includes the published nullable publication identity', async () => {
  const contract = JSON.parse(await readFile(resolve('task-packages/v2/mediadock/public-contract/contract.json')));
  assert.deepEqual([...GRANT_KEYS].sort(), Object.keys(contract.schemas.AccessGrant.properties).sort());
});

test('SeatReserve checkout accepts the public Order and reads its named PaymentIntent separately', async () => {
  const wire = await boundary('seatreserve');
  const f = seat.createFixtureFactory(options);
  const order = { orderId: f.uuid('order'), holdId: f.uuid('hold'), tenantId: f.uuid('tenant'), eventId: f.uuid('event'), customerRef: 'wire', state: 'PENDING_PAYMENT', totalMinor: 5500, currency: 'USD', paymentIntentId: f.uuid('payment'), createdAt: options.baseTime, confirmedAt: null, sequence: 1 };
  const paymentIntent = { paymentIntentId: order.paymentIntentId, orderId: order.orderId, amountMinor: 5500, currency: 'USD', state: 'CREATED', providerRequestId: 'server-payment-request', providerTransactionId: null, createdAt: options.baseTime, resolvedAt: null, sequence: 1 };
  const ctx = { key: f.key, equal: assert.deepEqual, ok: assert.ok, mutate: async (_base, path, key, json, extra = {}) => {
    wire.request(path, { ...extra, method: 'POST', headers: { 'Idempotency-Key': key }, json });
    return { status: 200, json: order };
  }, snapshot: async () => ({ resources: { paymentIntents: [paymentIntent] } }) };
  assert.deepEqual(await checkoutHold(ctx, 'http://example.test', order.holdId, 'TIMEOUT'), { order, paymentIntent });
});

test('ModerationFlow sends frozen review CAS and explicit appeal lineage', async () => {
  const wire = await boundary('moderationflow');
  const f = moderation.createFixtureFactory(options);
  const seed = f.baseSeed();
  const stage = { stageId: f.uuid('stage'), caseId: f.uuid('case'), revision: 7 };
  const moderationCase = { caseId: stage.caseId, policyVersionId: seed.policyVersions[0].policyVersionId, evidenceHeadVersion: 2, finalDecisionId: f.uuid('decision') };
  const calls = [];
  const ctx = { key: f.key, snapshot: async () => ({ resources: { reviewStages: [stage], moderationCases: [moderationCase], reconsiderations: [] } }),
    request: async (_base, path, extra) => { wire.request(path, extra); return { status: 200, json: moderationCase }; },
    mutate: async (_base, path, key, json, extra = {}) => {
      wire.request(path, { ...extra, method: 'POST', headers: { 'Idempotency-Key': key }, json });
      calls.push({ path, json });
      return { status: 200, json: path.endsWith('/claim') ? { ...stage, revision: 8 } : {} };
    } };
  await claimStage(ctx, 'http://example.test', stage.stageId, 'reviewer');
  moderationCase.evidenceHeadVersion = 3;
  stage.revision = 9;
  await decideStage(ctx, 'http://example.test', stage.stageId, { reviewerId: 'reviewer', outcome: 'ALLOW', categoryCode: 'SAFE', reason: 'wire' });
  await createAppeal(ctx, 'http://example.test', stage.caseId, 'review again');
  assert.equal(calls[0].json.expectedRevision, 7);
  assert.equal(calls[1].json.expectedRevision, 8);
  assert.equal(calls[1].json.evidenceHeadVersion, 2);
  assert.equal(calls[2].json.challengedDecisionId, moderationCase.finalDecisionId);
  assert.equal(calls[2].json.evidenceHeadVersion, 3);
});

test('EntitlementHub keeps all three formal populations and emits contract-valid streamed seeds', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'entitlementhub-author-wire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wire = await boundary('entitlementhub');
  for (const [scenario, count] of [['entitlement-decision-read', 100000], ['upgrade-refund-race', 20000], ['expiry-revocation-recovery', 50000]]) {
    const generated = await writeFormalSeed({ tempPath: (name) => resolve(root, name) }, scenario);
    const seed = JSON.parse(await readFile(generated.path));
    assert.equal(seed.subscriptions.length, count);
    assert.equal(seed.entitlementGrants.length, count);
    assert.equal(seed.revocationFences.length, count);
    assert.doesNotThrow(() => wire.seed(seed));
  }
});

test('RuleBench A-01 explicitly marks invalid DSL but keeps the following positive seed strict', async () => {
  const wire = await boundary('rulebench');
  const fixtures = ruleFactory(options);
  const captured = [];
  const stop = new Error('positive seed captured');
  const ctx = { ...options, fixtures, uuid: fixtures.uuid, key: fixtures.key, workspace: 'wire-fixture',
    npm: async () => ({}), migrate: async () => ({}), mark: () => {}, ok: assert.ok, equal: assert.deepEqual,
    seed: async (value, extra = {}) => {
      wire.seed(value, extra);
      captured.push(extra);
      if (extra.contractExpectation !== 'invalid') throw stop;
      return { exitCode: 1 };
    } };
  ctx.forWorkspace = () => ctx;
  await assert.rejects(ruleCases.find(({ id }) => id === 'A-01').run(ctx), (error) => error === stop);
  assert.equal(captured[0].contractExpectation, 'invalid');
  assert.equal(captured[1].contractExpectation, undefined);
});
