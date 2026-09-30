import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureFactory } from '../evaluators/transfer/coldchaincontrol/v2/fixtures/index.mjs';
import { A_CASES } from '../evaluators/transfer/coldchaincontrol/v2/cases/a.mjs';
import * as helpers from '../evaluators/transfer/coldchaincontrol/v2/cases/helpers.mjs';
import * as oracle from '../evaluators/transfer/coldchaincontrol/v2/oracles/index.mjs';
import { executeCase } from '../src/task-evaluator-v2/execution.mjs';

const fixtures = createFixtureFactory({ evaluationSeed: 'regression', caseId: 'A-13', baseTime: '2030-01-01T00:00:00Z' });
const fixture = fixtures.shipment();
const response = (status, json) => ({ status, json, text: JSON.stringify(json) });
const ctx = { fixtures, uuid: fixtures.uuid, key: fixtures.key, at: fixtures.at,
  migrate: async () => {}, seed: async () => {}, mark() {}, startApi: async () => ({ baseUrl: 'http://stub.invalid' }) };

test('actual A-13 positive max route connects the declared endpoints and fits the shipment window', async () => {
  const stop = new Error('positive request checked');
  await assert.rejects(A_CASES.find(c => c.id === 'A-13').run({ ...ctx,
    mutate: async (_, path, key, body) => {
      if (path === '/api/v1/shipments' && body.legs.length === 32) {
        assert.equal(body.legs[0].fromSiteId, body.originSiteId);
        assert.equal(body.legs.at(-1).toSiteId, body.destinationSiteId);
        assert.ok(Date.parse(body.legs.at(-1).plannedArrivalAt) <= Date.parse(body.expectedEndAt));
        for (let i = 1; i < 32; i++) assert.equal(body.legs[i].fromSiteId, body.legs[i - 1].toSiteId);
        throw stop;
      }
      return response(200, { ...body, shipmentId: fixtures.uuid('created'), state: path.endsWith('/activate') ? 'ACTIVE' : 'DRAFT' });
    },
  }), error => error === stop);
});

test('expected negative creation responses are not parsed as successful resources', async () => {
  const negative = response(409, { error: { code: 'STATE_CONFLICT', message: 'Conflict', details: {} } });
  const c = { ...ctx, mutate: async () => negative };
  for (const result of [await helpers.createAssignment(c, '', fixture, fixture.config.configRevisionId, 'negative', { expectSuccess: false }),
    await helpers.createShipment(c, '', fixture, 'negative', {}, { expectSuccess: false }),
    await helpers.createConfig(c, '', fixture, 'negative', { expectSuccess: false })]) assert.equal(result.response, negative);
  await assert.rejects(helpers.createAssignment(c, '', fixture, fixture.config.configRevisionId), /returned 409/);
});

test('candidate assertions are classified but arbitrary author exceptions remain evaluator errors', async () => {
  const run = fn => executeCase({ definition: { id: 'A-01', dimension: 'A', weight: 2 },
    implementation: { run: fn }, withContext: async (_, op) => op({}), contextOptions: {} });
  assert.equal((await run(() => helpers.successful(response(500, {})))).status, 'failed');
  assert.equal((await run(() => { throw new TypeError('broken fixture'); })).status, 'evaluator_error');
  assert.equal((await run(() => oracle.validateCustodySteps([], {}, []))).status, 'evaluator_error');
});

test('non-offline fixtures start within their offline window', () => {
  assert.ok(Date.parse(fixtures.at()) - Date.parse(fixture.device.lastSeenAt) < fixture.config.offlineAfterSeconds * 1000);
  const fleet = fixtures.performanceSeed({ deviceCount: 2, shipmentCount: 2 });
  assert.ok(fleet.devices.every(d => Date.parse(fixtures.at()) - Date.parse(d.lastSeenAt) < 300000));
});

test('actual A-03 cross-tenant negative has a real foreign referenced carrier', async () => {
  const stop = new Error('invalid graph checked');
  await assert.rejects(A_CASES.find(c => c.id === 'A-03').run({ ...ctx, snapshot: async () => ({}),
    seed: async seed => {
      if (seed.seedVersion === 'cross-tenant') {
        assert.ok(seed.devices.some(d => seed.carriers.some(c => c.carrierId === d.carrierId && c.tenantId !== d.tenantId)));
        throw stop;
      }
      return { exitCode: 1, stdout: '', stderr: '' };
    },
  }), error => error === stop);
});

test('reproducibility compares business identities, not fresh UUIDs or scheduler timestamps', () => {
  const snapshot = suffix => ({ resources: { telemetryReadings: [{ telemetryReadingId: 'internal-' + suffix, deviceId: 'device', readingId: 'reading', sequence: 1, receivedAt: suffix }],
    excursions: [], auditEntries: [] }, managerResources: {}, work: [], events: [{ eventId: 'event-' + suffix,
    aggregateId: 'internal-' + suffix, aggregateType: 'TelemetryReading', sequence: 1, kind: 'ACCEPTED', occurredAt: suffix,
    payload: { readingId: 'reading', telemetryReadingId: 'internal-' + suffix } }] });
  assert.deepEqual(oracle.reproducibleEvidence(snapshot('one')), oracle.reproducibleEvidence(snapshot('two')));
  const wrong = snapshot('two'); wrong.events[0].payload.readingId = 'different-reading';
  assert.notDeepEqual(oracle.reproducibleEvidence(snapshot('one')), oracle.reproducibleEvidence(wrong));
  const duplicate = snapshot('two'); duplicate.events.push({ ...duplicate.events[0], eventId: 'duplicate', sequence: 2 });
  assert.notDeepEqual(oracle.reproducibleEvidence(snapshot('one')), oracle.reproducibleEvidence(duplicate));
});

test('queue age uses observed first claim, not completion timestamp', () => {
  const work = { workId: 'w', availableAt: '2030-01-01T00:00:00Z', updatedAt: '2030-01-01T00:00:10Z' };
  assert.equal(helpers.firstClaimQueueAge(work, new Map([['w', Date.parse('2030-01-01T00:00:00.100Z')]])), 100);
  assert.throws(() => helpers.firstClaimQueueAge(work, new Map()), /claim/);
});

test('UI filling uses native select and datetime-local controls without assuming text inputs', async () => {
  const calls = [];
  await helpers.fillControl({ evaluate: async () => true, selectOption: async value => calls.push(['select', value]),
    fill: async () => assert.fail('must not fill a select') }, 'device-id');
  await helpers.fillControl({ evaluate: async () => false, getAttribute: async () => 'datetime-local',
    fill: async value => calls.push(['datetime', value]) }, '2030-01-01T12:00:00.000Z');
  assert.deepEqual(calls, [['select', 'device-id'], ['datetime', '2030-01-01T12:00:00.000']]);
});

test('keyboard selection moves through options instead of typing an ID into select', async () => {
  const calls = [];
  const control = { evaluate: async () => true, focus: async () => {},
    locator: () => ({ evaluateAll: async () => 2 }) };
  await helpers.fillControl(control, 'device-id', { keyboard: { press: async key => calls.push(key), type: () => assert.fail('no select text typing') } });
  assert.deepEqual(calls, ['Home', 'ArrowDown', 'ArrowDown', 'Enter']);
});
