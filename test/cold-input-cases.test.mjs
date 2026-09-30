import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/coldchaincontrol.mjs';
import { matchOperation, requestValidator, validator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/coldchaincontrol/v2/fixtures/index.mjs';
import { A_CASES } from '../evaluators/transfer/coldchaincontrol/v2/cases/a.mjs';

const factory = caseId => createFixtureFactory({ evaluationSeed: 'cold-input-regression', caseId, baseTime: '2026-09-08T00:00:00Z' });
const errorResponse = (status, code) => ({ status, json: { error: { code, message: code, details: {} } } });

test('A-06 sends both invalid sequence scalars with otherwise valid signed telemetry input', async () => {
  const fixtures = factory('A-06'), fixture = fixtures.credential(), validate = requestValidator(contract), checkSeed = validator(contract)(contract.seed.schema), readings = [];
  const ctx = {
    fixtures, uuid: fixtures.uuid, key: fixtures.key, at: fixtures.at, mark: () => {},
    migrate: async () => {}, seed: async seed => assert(checkSeed(seed), JSON.stringify(checkSeed.errors)),
    startApi: async () => ({ baseUrl: 'http://public-test' }), snapshot: async () => ({ asOf: fixtures.at() }),
    pass: () => ({ status: 'passed' }),
    request: async (_base, path, options) => {
      const route = matchOperation(contract.operations, options.method, path);
      assert(route, path);
      const input = { params: route.params, headers: options.headers, body: options.json, hasBody: options.json !== undefined };
      const result = validate(route.operation, input);
      if (options.json !== undefined) {
        assert.equal(options.contractExpectation, 'invalid');
        assert.equal(result.valid, false);
        assert.equal(result.code, 'INVALID_REQUEST');
        assert(validate(route.operation, { ...input, body: { ...input.body, sequence: 1 } }).valid,
          'the only malformed body scalar is sequence; observedAt remains a valid timestamp');
        readings.push(options.json);
        return errorResponse(400, 'INVALID_REQUEST');
      }
      assert.equal(result.valid, options.contractExpectation !== 'invalid');
      const headers = options.headers;
      const validAuth = result.valid && headers['x-device-id'] === fixture.device.deviceId
        && headers['x-device-key-version'] === '1'
        && Math.abs(Date.parse(headers['x-device-timestamp']) - Date.parse(fixtures.at())) <= 60_000;
      return validAuth ? { status: 200, json: fixture.config } : errorResponse(401, 'INVALID_DEVICE_SIGNATURE');
    },
  };
  assert.deepEqual(await A_CASES.find(item => item.id === 'A-06').run(ctx), { status: 'passed' });
  assert.deepEqual(readings.map(reading => reading.sequence), [1.5, Number.MAX_SAFE_INTEGER + 1]);
  assert(readings.every(reading => Number.isFinite(Date.parse(reading.observedAt))));
});

test('A-07 paginates 140 resolved histories from a valid non-overlapping 170-row seed', async () => {
  const fixtures = factory('A-07'), checkSeed = validator(contract)(contract.seed.schema);
  let seed, starts = 0, stops = 0;
  const pages = [];
  const ctx = {
    fixtures, uuid: fixtures.uuid, at: fixtures.at, mark: () => {}, migrate: async () => {},
    seed: async value => {
      assert(checkSeed(value), JSON.stringify(checkSeed.errors));
      assert.equal(value.excursions.length, 170);
      const unresolved = new Set();
      for (const row of value.excursions) {
        if (row.state !== 'RESOLVED') {
          const identity = `${row.shipmentId}:${row.kind}`;
          assert(!unresolved.has(identity), 'the seed cannot contain multiple unresolved excursions for one shipment and kind');
          unresolved.add(identity);
        } else {
          assert(row.resolvedAt && Date.parse(row.resolvedAt) > Date.parse(row.openedAt), 'resolved history has a later resolution timestamp');
        }
      }
      const ordered = [...value.excursions].sort((a, b) => a.firstSequence - b.firstSequence);
      for (let index = 1; index < ordered.length; index += 1) {
        assert(ordered[index].firstSequence > ordered[index - 1].lastSequence, 'historical sequence ranges do not overlap');
        assert(Date.parse(ordered[index].openedAt) > Date.parse(ordered[index - 1].resolvedAt), 'historical time ranges do not overlap');
      }
      const matching = value.excursions.filter(row => row.kind === 'TEMPERATURE' && row.state === 'RESOLVED');
      assert.equal(matching.length, 140);
      assert.equal(value.excursions.filter(row => row.kind === 'OFFLINE' && row.state === 'RESOLVED').length, 29);
      assert.equal(value.excursions.filter(row => row.kind === 'TEMPERATURE' && row.state === 'OPEN').length, 1);
      assert.equal(ordered.at(-1).state, 'OPEN', 'the sole open excursion follows all resolved histories');
      seed = value;
    },
    startApi: async () => ({ baseUrl: `http://public-test-${++starts}` }), stop: async () => { stops += 1; },
    snapshot: async () => ({ asOf: fixtures.at() }), pass: () => ({ status: 'passed' }),
    request: async (base, path) => {
      const query = new URL(path, base).searchParams;
      if (query.get('cursor') === 'not-opaque') return errorResponse(400, 'INVALID_REQUEST');
      const all = seed.excursions.filter(row => row.tenantId === query.get('tenantId')
        && (!query.has('shipmentId') || row.shipmentId === query.get('shipmentId'))
        && (!query.has('kind') || row.kind === query.get('kind'))
        && (!query.has('state') || row.state === query.get('state')));
      const offset = Number(query.get('cursor')?.slice(5) ?? 0), limit = Number(query.get('limit'));
      assert.equal(limit, 25);
      const items = all.slice(offset, offset + limit), nextCursor = offset + limit < all.length ? `page-${offset + limit}` : null;
      pages.push({ base, offset, count: items.length });
      return { status: 200, json: { items, nextCursor } };
    },
  };
  assert.deepEqual(await A_CASES.find(item => item.id === 'A-07').run(ctx), { status: 'passed' });
  assert.deepEqual(pages.slice(0, 6).map(page => page.count), [25, 25, 25, 25, 25, 15]);
  assert.equal(starts, 2); assert.equal(stops, 1);
  assert.deepEqual(pages.at(-1), { base: 'http://public-test-2', offset: 25, count: 25 });
});
