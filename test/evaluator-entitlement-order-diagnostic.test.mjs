import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSorted, compareBy } from '../evaluators/learning/entitlementhub/v2/oracles/index.mjs';

test('EntitlementHub ordering failure does not retain full snapshot arrays in its diagnostic', () => {
  const rows = Array.from({ length: 10 }, (_, id) => ({ id, payload: 'sensitive-row' })).reverse();
  assert.throws(() => assertSorted(rows, ['id']), error => {
    assert.equal(Array.isArray(error.actual), false);
    assert.equal(Array.isArray(error.expected), false);
    assert.ok(error.message.length < 200);
    assert.ok(!error.message.includes('sensitive-row'));
    return true;
  });
});

test('EntitlementHub ordering retains exact multi-field and canonical tie-breaking semantics', () => {
  const rows = [{ id: 1, sub: 'a', value: 2 }, { id: 1, sub: 'a', value: 1 }, { id: 1, sub: 'b' }, { id: 0, sub: 'z' }];
  const sorted = [...rows].sort(compareBy(['id', 'sub']));
  assert.equal(assertSorted(sorted, ['id', 'sub']), true);
  for (let index = 1; index < sorted.length; index++) {
    const changed = [...sorted];
    [changed[index - 1], changed[index]] = [changed[index], changed[index - 1]];
    assert.throws(() => assertSorted(changed, ['id', 'sub']));
  }
  assert.equal(assertSorted([sorted[0], sorted[0]], ['id', 'sub']), true);
});

test('EntitlementHub full 100000-row sort checks every row without a full-array failure diff', () => {
  const rows = Array.from({ length: 100000 }, (_, id) => ({ id }));
  assert.equal(assertSorted(rows, ['id']), true);
  [rows[99998], rows[99999]] = [rows[99999], rows[99998]];
  assert.throws(() => assertSorted(rows, ['id']), /inversion at index 99999/);
});
