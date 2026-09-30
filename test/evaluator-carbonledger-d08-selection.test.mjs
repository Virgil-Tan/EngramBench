import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAuthorValidationCases } from '../src/task-package-v2-evaluator.mjs';

const cases = [{id:'A-01'}, {id:'D-08'}, {id:'E-01'}];
test('CarbonLedger standalone D-08 does not inherit another task’s prior-evidence dependency', () => {
  assert.deepEqual(selectAuthorValidationCases(cases, ['D-08'], {taskId:'carbonledger'}), [cases[1]]);
  for (const taskId of ['escrowguard', 'unknown', undefined]) {
    assert.throws(() => selectAuthorValidationCases(cases, ['D-08'], {taskId}), /complete private evidence/);
  }
  assert.throws(() => selectAuthorValidationCases(cases, ['not-a-case'], {taskId:'carbonledger'}), /unique known/);
});
