import test from 'node:test';
import assert from 'node:assert/strict';
import { validator } from '../templates/contract-first/runtime.mjs';

test('decimal multipleOf accepts exact microdegrees across the geographic range', () => {
  const valid = validator({ schemas: {} })({ type: 'number', minimum: -180, maximum: 180, multipleOf: 0.000001 });
  for (const value of [-180, -179.999999, -9.89, -9.8, -0.000001, 0, 0.000001, 9.89, 179.999999, 180])
    assert.equal(valid(value), true, String(value));
  for (const value of [-180.000001, -9.8900001, 0.0000001, 1.0000001, 180.000001])
    assert.equal(valid(value), false, String(value));
});

test('decimal multipleOf does not replace the constraint with a floating-point tolerance', () => {
  const compile = validator({ schemas: {} });
  for (const [divisor, yes, no] of [[0.1, 0.3, 0.30000000000000004], [0.25, -0.75, -0.76], [1e-8, 2e-8, 1e-9], [1e20, 2e20, 2.1e20]]) {
    const valid = compile({ type: 'number', multipleOf: divisor });
    assert.equal(valid(yes), true);
    assert.equal(valid(no), false);
  }
});
