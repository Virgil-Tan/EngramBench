import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createCaseContext } from '../evaluators/learning/exportvault/v2/lib/runtime.mjs';
import { CaseFailure } from '../evaluators/learning/exportvault/v2/lib/execution.mjs';
import { B_CASES } from '../evaluators/learning/exportvault/v2/cases/b.mjs';

const ctx = await createCaseContext({
  evaluationSeed: 'buffer-assertion-regression', caseId: 'B-01',
  baseTime: '2026-09-07T00:00:00.000Z', workspace: resolve(import.meta.dirname, '..'), manageDatabase: false,
});

test('ExportVault unequal byte buffers fail with bounded diagnostics and unchanged failure metadata', () => {
  assert.throws(() => ctx.equal(Buffer.alloc(4096, 0x41), Buffer.alloc(4096, 0x42), 'exact bytes', {
    failureCodeSuffix: 'EXACT_BYTES', hardCapIds: ['PUBLICATION_ATOMICITY'],
  }), error => {
    assert(error instanceof CaseFailure);
    assert.equal(error.origin, 'candidate');
    assert.equal(error.failureCodeSuffix, 'EXACT_BYTES');
    assert.deepEqual(error.hardCapIds, ['PUBLICATION_ATOMICITY']);
    assert.match(error.message, /^exact bytes: /);
    assert(Buffer.byteLength(error.message) < 256, 'binary mismatch must not dump the byte payload');
    return true;
  });
});

test('ExportVault exact-byte comparison accepts copies and rejects a change at every byte position', () => {
  const expected = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  assert.doesNotThrow(() => ctx.equal(Buffer.from(expected), expected, 'exact bytes'));
  assert.doesNotThrow(() => ctx.equal(Buffer.alloc(0), Buffer.alloc(0), 'empty bytes'));
  for (let index = 0; index < expected.length; index++) {
    const actual = Buffer.from(expected);
    actual[index] ^= 1;
    assert.throws(() => ctx.equal(actual, expected, 'exact bytes'), CaseFailure);
  }
  assert.throws(() => ctx.equal(expected.subarray(0, -1), expected, 'length differs'), CaseFailure);
});

test('ExportVault multi-megabyte byte mismatches never include their payload in the diagnostic', () => {
  const expected = Buffer.alloc(4 * 1024 * 1024, 0x41);
  assert.doesNotThrow(() => ctx.equal(Buffer.from(expected), expected, 'large exact bytes'));
  for (const index of [0, expected.length / 2, expected.length - 1]) {
    const actual = Buffer.from(expected);
    actual[index] ^= 1;
    assert.throws(() => ctx.equal(actual, expected, 'large exact bytes'), error => {
      assert(error instanceof CaseFailure);
      assert(Buffer.byteLength(error.message) < 256);
      return true;
    });
  }
  assert.throws(() => ctx.equal(Buffer.alloc(expected.length, 0x42), expected, 'all bytes differ'), error => {
    assert(error instanceof CaseFailure);
    assert(Buffer.byteLength(error.message) < 256);
    return true;
  });
});

test('ExportVault non-buffer equality keeps strict structural semantics', () => {
  assert.doesNotThrow(() => ctx.equal({ values: [1, '1'] }, { values: [1, '1'] }, 'structure'));
  assert.throws(() => ctx.equal({ value: 1 }, { value: '1' }, 'structure'), CaseFailure);
  assert.throws(() => ctx.equal(Buffer.from([1]), new Uint8Array([1]), 'type differs'), CaseFailure);
});

test('ExportVault B-05 reaches the seed boundary with all 200002 original records and identities in order', async () => {
  const caseContext = await createCaseContext({
    evaluationSeed: 'shard-append-regression', caseId: 'B-05',
    baseTime: '2026-09-07T00:00:00.000Z', workspace: resolve(import.meta.dirname, '..'), manageDatabase: false,
  });
  const reached = new Error('stop at candidate seed boundary');
  let captured;
  const target = {
    workspace: 'author-b05-seed-boundary', npm: async () => {}, migrate: async () => {},
    seed: async value => { captured = value; throw reached; },
  };
  caseContext.forWorkspace = () => target;
  await assert.rejects(B_CASES.find(c => c.id === 'B-05').run(caseContext), error => error === reached);
  const records = captured.datasetRevisions[0].records;
  assert.equal(records.length, 200002);
  assert.equal(new Set(records.map(record => record.recordId)).size, 200002);
  for (const [scope, offset, count] of [['profile', 0, 200000], ['activity', 200000, 2]]) {
    const seen = new Set();
    for (let position = offset; position < offset + count; position++) {
      const record = records[position], index = record.data.index;
      assert.equal(record.scope, scope);
      assert.equal(record.data.scope, scope);
      assert(Number.isInteger(index) && index >= 0 && index < count);
      seen.add(index);
      assert.equal(record.recordId, caseContext.uuid(`b05-success:${scope}:${String(index).padStart(7, '0')}`));
      if (position > offset) assert(Buffer.compare(Buffer.from(records[position - 1].recordId), Buffer.from(record.recordId)) < 0);
    }
    assert.equal(seen.size, count);
  }
});
