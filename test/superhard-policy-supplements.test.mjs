import test from 'node:test';
import assert from 'node:assert/strict';
import cold from '../contracts/transfer/coldchaincontrol.mjs';
import access from '../contracts/transfer/accesssentinel.mjs';
import { distanceMillimetres, selectSite, projectReadings, assertSlidingQuota, assertNotificationWire, canonicalJson } from '../evaluators/transfer/coldchaincontrol/v2/oracles/index.mjs';
import { validateBarrierPayload } from '../evaluators/transfer/coldchaincontrol/v2/lib/runtime.mjs';
import { releaseStaleWorker } from '../evaluators/transfer/coldchaincontrol/v2/cases/helpers.mjs';
import { assertAccessEvents } from '../evaluators/transfer/accesssentinel/v2/oracles/index.mjs';

test('approved policies and public examples name one immutable revision', () => {
  for (const contract of [cold, access]) assert(contract.notes.some(note => note.includes(contract.policyRevision)));
  assert.equal(cold.policyRevision, 'coldchaincontrol-2026-09-08.1');
  assert.equal(access.policyRevision, 'accesssentinel-2026-09-08.1');
  assert(cold.publicPolicy.barrierPoints.includes('worker.after-attempt'));
  assert.deepEqual(cold.operations.find(o => o.id === 'create-notification-policy').example.body.eventKinds, ['EXCURSION_OPENED']);
});

test('site oracle uses radius, quantization and deterministic tie-break, not centre equality', () => {
  const point = { latitudeE6: 0, longitudeE6: 0 }, inside = { siteId: 'b', latitudeE6: 100, longitudeE6: 0, radiusMeters: 12 };
  assert.equal(distanceMillimetres(point, inside), 11120);
  assert.equal(selectSite(point, [inside]), inside);
  assert.equal(selectSite(point, [{ ...inside, radiusMeters: 11 }]), undefined);
  assert.equal(selectSite(point, [inside, { ...inside, siteId: 'a' }]).siteId, 'a');
  assert.equal(selectSite(point, [{ ...point, siteId: 'centre', radiusMeters: 0 }]).siteId, 'centre');
});

test('resolved temperature excursions do not swallow a later independent excursion', () => {
  const readings = Array.from({ length: 12 }, (_, i) => ({ sequence: i + 1, readingId: String(i), temperatureMilliC: i % 6 < 3 ? 9000 : 5000 }));
  const result = projectReadings(readings);
  assert.deepEqual(result.excursions.map(x => [x.firstSequence, x.state]), [[1, 'RESOLVED'], [7, 'RESOLVED']]);
});

test('shared rolling quota rejects a burst across a fixed-window boundary', () => {
  assert.doesNotThrow(() => assertSlidingQuota([0, 1000, 60000], 2));
  assert.throws(() => assertSlidingQuota([59990, 59995, 60001], 2));
});

test('barrier accepts only closed published messages, including obsolete-attempt receipts', () => {
  const value = { role: 'worker', point: 'worker.before-commit', kind: 'CONFIG_DELIVER', workId: '10000000-0000-4000-8000-000000000001', aggregateId: '10000000-0000-4000-8000-000000000002', attempt: 1, leaseToken: 'opaque' };
  assert.equal(validateBarrierPayload(value), true);
  assert.equal(validateBarrierPayload({ ...value, point: 'worker.after-attempt', outcome: 'stale' }), true);
  for (const bad of [{ ...value, extra: true }, { ...value, attempt: 0 }, { ...value, point: 'private-point' }, { ...value, point: 'worker.after-attempt' }]) assert.equal(validateBarrierPayload(bad), false);
});

test('stale release requires the exact newer completed claim and unchanged effects', async () => {
  const held = { entry: { json: { workId: 'w', aggregateId: 'g', attempt: 1 } }, worker: {}, barrier: { release() {}, waitFor: async () => ({ json: { outcome: 'stale' } }) } };
  const before = { work: [{ workId: 'w', attempt: 2, terminal: true }], resources: { records: [{ id: 'g', state: 'DONE' }] }, managerResources: {}, events: [] };
  let i = 0; const ctx = { snapshot: async () => structuredClone(before), kill: async () => {} };
  await releaseStaleWorker(ctx, '', held);
  await assert.rejects(() => releaseStaleWorker({ ...ctx, snapshot: async () => ({ ...before, work: [{ workId: 'other', attempt: 2, terminal: true }] }) }, '', held));
  await assert.rejects(() => releaseStaleWorker({ ...ctx, snapshot: async () => i++ === 0 ? before : { ...before, resources: { records: [{ id: 'g', state: 'CORRUPTED' }] } } }, '', held));
});

test('notification Event uses historical transition state, canonical bytes and committed identity', () => {
  const event = { eventId: 'e', aggregateId: 's', aggregateType: 'ColdShipment', kind: 'EXCURSION_OPENED', payload: { resourceType: 'Excursion', resourceId: 'x', shipmentId: 's', state: 'OPEN' }, outboxState: 'DELIVERED' };
  const { outboxState, ...wire } = event, snapshot = { events: [event], resources: { excursions: [{ excursionId: 'x', shipmentId: 's', state: 'RESOLVED' }] } };
  const entry = { headers: { 'x-coldchain-event-id': 'e', 'content-type': 'application/json' }, raw: canonicalJson(wire) };
  assert.doesNotThrow(() => assertNotificationWire(snapshot, [entry]));
  assert.throws(() => assertNotificationWire(snapshot, [{ ...entry, raw: JSON.stringify(wire) }]));
  assert.throws(() => assertNotificationWire(snapshot, [{ ...entry, headers: { ...entry.headers, 'x-coldchain-event-id': 'missing' } }]));
});

test('Access Event policy rejects missing, duplicate and payload-drifted transitions', () => {
  const request = { accessRequestId: 'q', tenantId: 't', sessionId: 's', policyRevisionId: 'p', riskModelRevisionId: 'r', deviceTrustRevisionId: 'd' };
  const risk = { accessRequestId: 'q', tenantId: 't', riskDecisionId: 'risk', score: 0, level: 'LOW', reasons: [], policyEffect: 'ALLOW', inputDigest: 'digest' };
  const grant = { accessRequestId: 'q', tenantId: 't', grantId: 'grant', policyRevisionId: 'p', riskDecisionId: 'risk', expiresAt: 'later', state: 'REVOKED', revocationEpoch: 1 };
  const specs = [['ACCESS_REQUESTED', request, 'accessRequestId,sessionId,policyRevisionId,riskModelRevisionId,deviceTrustRevisionId'], ['RISK_DECIDED', risk, 'accessRequestId,riskDecisionId,score,level,reasons,policyEffect,inputDigest'], ['ACCESS_GRANTED', grant, 'accessRequestId,grantId,policyRevisionId,riskDecisionId,expiresAt'], ['ACCESS_REVOKED', grant, 'accessRequestId,grantId,state,revocationEpoch']];
  const events = specs.map(([type, row, keys], i) => ({ eventId: String(i), tenantId: 't', aggregateId: 'q', aggregateType: 'AccessRequest', type, payload: Object.fromEntries(keys.split(',').map(key => [key, row[key]])) }));
  const snapshot = { resources: { accessRequests: [request], riskDecisions: [risk], accessGrants: [grant] }, events };
  assert.doesNotThrow(() => assertAccessEvents(snapshot, 'q', events.map(e => ({ raw: canonicalJson(e) }))));
  assert.throws(() => assertAccessEvents({ ...snapshot, events: events.slice(1) }, 'q'));
  assert.throws(() => assertAccessEvents({ ...snapshot, events: [...events, events[0]] }, 'q'));
  const broken = structuredClone(snapshot); broken.events[1].payload.score = 9;
  assert.throws(() => assertAccessEvents(broken, 'q'));
});
