import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertLocationProjection } from '../evaluators/transfer/accesssentinel/v2/cases/b.mjs';

const ctx = { equal: (a, b, label) => assert.deepEqual(a, b, label), assert: (_label, fn) => fn() };
const projection = watermarkObservedAt => ({ lastSequence: 180, watermarkObservedAt,
  longitude: -73, latitude: 40, region: 'us-east', riskFlags: [] });

test('E-07 performance projection uses the same strict semantic-time assertion as B-04', async () => {
  const source = await readFile(new URL('../evaluators/transfer/accesssentinel/v2/cases/e.mjs', import.meta.url), 'utf8');
  assert.match(source, /assertLocationProjection\(ctx, actual, expected\.projection, id\)/);
});

test('B-04 compares published UTC instants, not optional fractional formatting', () => {
  for (const value of ['2032-02-29T06:07:08Z', '2032-02-29T06:07:08.000Z',
    '2032-02-29t06:07:08z', '2032-02-29T06:07:08+00:00']) {
    assertLocationProjection(ctx, projection(value), projection('2032-02-29T06:07:08.000Z'), 'projection');
  }
  assertLocationProjection(ctx, projection('2032-02-29T06:07:08.123400Z'),
    projection('2032-02-29T06:07:08.1234+00:00'), 'projection');
});

test('B-04 still rejects wrong instants, submillisecond differences and invalid UTC', () => {
  for (const value of ['2032-02-29T06:07:09Z', '2032-02-29T06:07:08.000001Z',
    '2032-02-29T06:07:08+08:00', '2032-02-30T06:07:08Z', 'bad', null]) {
    assert.throws(() => assertLocationProjection(ctx, projection(value),
      projection('2032-02-29T06:07:08.000Z'), 'projection'));
  }
  assert.throws(() => assertLocationProjection(ctx, projection('bad'), projection('bad'), 'projection'));
});

test('B-04 retains every non-time projection assertion', () => {
  const expected = projection('2032-02-29T06:07:08Z');
  for (const changed of [{ lastSequence: 179 }, { longitude: -72 }, { latitude: 41 },
    { region: 'us-west' }, { riskFlags: ['impossibleTravel'] }]) {
    assert.throws(() => assertLocationProjection(ctx, { ...expected, ...changed }, expected, 'projection'));
  }
});
