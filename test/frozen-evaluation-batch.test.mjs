import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBatch, verifyCompleted } from '../scripts/evaluate-frozen-batch.mjs';

test('batch requires explicit diagnostic mode, unique known tasks and fixed source paths', () => {
  const config = { kind: 'frontal-frozen-evaluation-batch', schemaVersion: 1, id: 'demo',
    mode: 'author-validation',
    tasks: [{ id: 'a', statePath: '/run/state.json', sourceRuntime: '/runtime' }] };
  assert.equal(validateBatch(config, ['a']), config);
  for (const invalid of [{ ...config, tasks: [...config.tasks, ...config.tasks] },
    { ...config, baseTime: '2026-09-08T00:00:00.000Z' },
    { ...config, mode: 'formal' }, { ...config, id: '../escape' },
    { ...config, tasks: [{ ...config.tasks[0], id: 'unknown' }] },
    { ...config, tasks: [{ ...config.tasks[0], statePath: 'relative.json' }] }]) {
    assert.throws(() => validateBatch(invalid, ['a']));
  }
});

test('reuse requires exact frozen identity, diagnostic-only output and full unique case coverage', () => {
  const metadata = { taskId: 'a', submission: { digest: 'source' }, task: { digest: 'package' } };
  const result = { kind: 'frontal-v2-author-validation', ...metadata, complete: true,
    formalEligible: false, score: null, rawScore: null, completedCases: 2, totalCases: 2,
    cases: [{ id: 'A-01' }, { id: 'A-02' }] };
  assert.equal(verifyCompleted(result, metadata, ['A-01', 'A-02']), result);
  for (const invalid of [{ ...result, complete: false }, { ...result, score: 100 },
    { ...result, submission: { digest: 'other' } }, { ...result, task: { digest: 'other' } },
    { ...result, cases: [{ id: 'A-01' }, { id: 'A-01' }] },
    { ...result, cases: [{ id: 'A-01' }, { id: 'A-03' }] }]) {
    assert.throws(() => verifyCompleted(invalid, metadata, ['A-01', 'A-02']));
  }
});

test('repair completion is explicitly partial and requires exact selected coverage', () => {
  const metadata = { taskId: 'a', submission: { digest: 'source' }, task: { digest: 'new-package' },
    repairOf: { directory: '/old/result', resultDigest: 'old-result' } };
  const result = { kind: 'frontal-v2-author-validation', taskId: 'a', task: metadata.task, submission: metadata.submission,
    complete: false, selectionComplete: true, selectedCaseIds: ['A-02'], totalCases: 22, completedCases: 1,
    formalEligible: false, score: null, rawScore: null, cases: [{ id: 'A-02' }] };
  assert.equal(verifyCompleted(result, metadata, ['A-02']), result);
  for (const change of [{ selectionComplete: false }, { selectedCaseIds: ['A-01'] }, { score: 100 }])
    assert.throws(() => verifyCompleted({ ...result, ...change }, metadata, ['A-02']));
});
