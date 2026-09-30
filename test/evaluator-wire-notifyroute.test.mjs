import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validator, requestValidator, matchOperation } from '../task-packages/v2/notifyroute/public-contract/runtime.mjs';
import { createFixtureFactory, baseSeed } from '../evaluators/learning/notifyroute/v2/fixtures/index.mjs';
import { CASES } from '../evaluators/learning/notifyroute/v2/cases/index.mjs';
import { assertFallbackOrder } from '../evaluators/learning/notifyroute/v2/cases/a.mjs';
import { validateCaseRegistry } from '../evaluators/learning/notifyroute/v2/lib/execution.mjs';
import { validateManifest } from '../evaluators/learning/notifyroute/v2/lib/scoring.mjs';
import { coreNotification, scriptedSeed, createNotification, cancelNotification, unsubscribe, receipt, reconcile } from '../evaluators/learning/notifyroute/v2/cases/helpers.mjs';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const contract = await json('../task-packages/v2/notifyroute/public-contract/contract.json');
const compile = validator(contract), validateRequest = requestValidator(contract);
const fixture = caseId => createFixtureFactory({ evaluationSeed: 'author-wire', caseId, baseTime: '2026-09-07T00:00:00.000Z' });

function request(path, key, body) {
  const matched = matchOperation(contract.operations, 'POST', path);
  assert.ok(matched, path);
  return validateRequest(matched.operation, { params: matched.params, body, hasBody: true,
    headers: { 'content-type': 'application/json', 'idempotency-key': key, authorization: 'Bearer author-test' } });
}

test('NotifyRoute preserves all 22 cases and validates every author seed with canonical channel-aware digests', async () => {
  const manifest = await json('../evaluators/learning/notifyroute/v2/manifest.v2.json');
  const map = await json('../evaluators/learning/notifyroute/v2/contract-map.v2.json');
  assert.equal(validateManifest(manifest, map), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  const valid = compile(contract.seed.schema);
  for (const { id } of CASES) {
    const fixtures = fixture(id);
    for (const seed of [baseSeed(fixtures), scriptedSeed({ fixtures }, { url: 'http://127.0.0.1:9000/events' }).seed]) {
      assert.ok(valid(seed), `${id}: ${JSON.stringify(valid.errors)}`);
      for (const { channel, subject, body, contentDigest } of seed.templateVersions) {
        assert.equal(contentDigest, createHash('sha256').update(JSON.stringify({ body, channel, subject })).digest('hex'));
        assert.equal(subject.includes('{{') || body.includes('{{'), false, 'positive setup must not choose unpublished template grammar');
      }
    }
  }
});

test('NotifyRoute actual helpers send fixed positive requests and explicit invalid unknown-field requests', async () => {
  const fixtures = fixture('A-02'), calls = [];
  const ctx = { fixtures, key: fixtures.key, async mutate(_base, path, key, body, options = {}) {
    const result = request(path, key, body);
    assert.equal(result.valid, options.contractExpectation !== 'invalid', JSON.stringify({ path, result }));
    calls.push({ path, body, options });
    return { status: result.valid ? 200 : 400, json: {} };
  } };
  const { seed } = scriptedSeed(ctx, { url: 'http://127.0.0.1:9000/events' });
  const notification = coreNotification(ctx, seed), deliveryId = fixtures.uuid('delivery');
  await createNotification(ctx, 'http://author.test', notification, { allowFailure: true });
  await cancelNotification(ctx, 'http://author.test', fixtures.uuid('notification'), { allowFailure: true });
  await unsubscribe(ctx, 'http://author.test', notification.recipientId, {
    channel: 'WEBHOOK', category: notification.category, reason: 'recipient request', expectedPreferenceRevision: seed.recipients[0].preferenceRevision,
  }, { allowFailure: true });
  await receipt(ctx, 'http://author.test', {
    channel: 'WEBHOOK', providerEventId: 'event', providerMessageId: 'message', deliveryId, outcome: 'DELIVERED', occurredAt: fixtures.at(),
  }, { allowFailure: true });
  await reconcile(ctx, 'http://author.test', deliveryId, {}, { allowFailure: true });
  await createNotification(ctx, 'http://author.test', { ...notification, unexpected: true }, { allowFailure: true, contractExpectation: 'invalid' });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls[1].body, {});
  assert.deepEqual(calls[4].body, {});
  assert.equal(calls.filter(c => c.options.contractExpectation === 'invalid').length, 1);
});

test('NotifyRoute later versions and policy revisions are legal; malformed cancel/reconcile bodies are not positive fixtures', () => {
  const f = fixture('A-01');
  for (const [path, body] of [
    ['/api/v1/template-versions', { templateId: f.uuid('template'), version: 3, channel: 'WEBHOOK', subject: 'Later Ada', body: 'Later 042' }],
    ['/api/v1/route-policies', { tenantId: f.uuid('tenant'), name: 'Later policy', revision: 2, steps: [{ ordinal: 1, channel: 'WEBHOOK', delaySeconds: 5, maxAttempts: 1, baseRetrySeconds: 2 }] }],
  ]) assert.equal(request(path, f.key(path), body).valid, true);
  assert.equal(request(`/api/v1/notifications/${f.uuid('notification')}/cancel`, f.key('cancel'), { reason: 'different' }).valid, false);
  assert.equal(request(`/api/v1/deliveries/${f.uuid('delivery')}/reconcile`, f.key('reconcile'), { outcome: 'DELIVERED' }).valid, false);
  const seed = baseSeed(f);
  seed.channelEndpoints[0].signingSecret = 'not-a-public-seed-field';
  assert.equal(compile(contract.seed.schema)(seed), false);
});

test('NotifyRoute fallback validates UUID snapshot order separately from actual Provider route order', () => {
  const ctx = { equal: assert.deepEqual, ok: assert.ok };
  const notificationId = '00000000-0000-4000-8000-000000000001';
  const first = { deliveryId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', notificationId, routeOrdinal: 1, state: 'FAILED' };
  const second = { deliveryId: '00000000-0000-4000-8000-000000000002', notificationId, routeOrdinal: 2, state: 'ACCEPTED' };
  const deliveries = [second, first], route = [{ ordinal: 1 }, { ordinal: 2 }];
  const calls = [first, second].map(({ deliveryId }) => ({ headers: { 'x-notifyroute-delivery-id': deliveryId } }));
  assert.doesNotThrow(() => assertFallbackOrder(ctx, route, deliveries, notificationId, calls));
  assert.deepEqual(deliveries, [second, first], 'assertion does not reorder the source snapshot');
  assert.throws(() => assertFallbackOrder(ctx, route, [...deliveries].reverse(), notificationId, calls), /sorted by public identity/);
  assert.throws(() => assertFallbackOrder(ctx, route, deliveries, notificationId, [...calls].reverse()), /Provider calls follow frozen ordinal order/);
  assert.throws(() => assertFallbackOrder(ctx, route, deliveries, notificationId, [calls[0], ...calls]), /one attempt per configured step/);
  assert.throws(() => assertFallbackOrder(ctx, route, [second], notificationId, calls), /exactly the frozen route steps/);
  assert.throws(() => assertFallbackOrder(ctx, route, [{ ...second, state: 'SENDING' }, first], notificationId, calls), /terminal configured step succeeds/);
  assert.throws(() => assertFallbackOrder(ctx, route, [second, { ...first, state: 'ACCEPTED' }], notificationId, calls), /first configured step fails/);
});
