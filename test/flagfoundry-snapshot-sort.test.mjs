import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureFactory } from '../evaluators/transfer/flagfoundry/v2/fixtures/index.mjs';
import { assertSnapshot } from '../evaluators/transfer/flagfoundry/v2/oracles/index.mjs';

const fixtures = createFixtureFactory({ evaluationSeed: 'bounded-sort-diagnostic', caseId: 'E-05', baseTime: '2026-09-08T00:00:00.000Z' });
function snapshot(resources) {
  return { asOf: fixtures.at(), resources: { projects: [], environments: [], flags: [], flagRevisions: [], flagSnapshots: [], progressiveRollouts: [], evaluationOutcomes: [], ...resources }, work: [], events: [] };
}
function rejectSort(value, label) {
  assert.throws(() => assertSnapshot(value), error => {
    assert.match(error.message, label);
    assert(error.message.length < 256, 'sort failure is a short diagnostic');
    assert(!Array.isArray(error.actual) && !Array.isArray(error.expected), 'assertion retains no resource arrays');
    return true;
  });
}

test('snapshot sort accepts empty, singleton and identical duplicate records without mutation', () => {
  for (const projects of [[], [{ ...fixtures.project }], [{ ...fixtures.project }, { ...fixtures.project }]]) {
    const value = snapshot({ projects }), before = structuredClone(value);
    assertSnapshot(value); assert.deepEqual(value, before);
  }
});
test('snapshot sort retains the canonical JSON tie-break for duplicate primary keys', () => {
  const alpha = { ...fixtures.project, name: 'Alpha' }, beta = { ...fixtures.project, name: 'Beta' };
  assertSnapshot(snapshot({ projects: [alpha, beta] }));
  rejectSort(snapshot({ projects: [beta, alpha] }), /projectId sort at index 1/);
});
test('snapshot sort preserves UTF-8 byte ordering and numeric composite-key ordering', () => {
  const environments = ['z', 'é', '😀'].map(name => ({ ...fixtures.environment, name }));
  assertSnapshot(snapshot({ environments }));
  rejectSort(snapshot({ environments: [...environments].reverse() }), /projectId,name sort at index 1/);
  const flagRevisions = [1, 2, 10].map(revision => fixtures.activeRevision(fixtures.stringFlag, { revision, revisionId: fixtures.uuid(`revision-${revision}`) }));
  assertSnapshot(snapshot({ flagRevisions }));
  rejectSort(snapshot({ flagRevisions: [flagRevisions[0], flagRevisions[2], flagRevisions[1]] }), /flagId,environment,revision sort at index 2/);
  assert.throws(() => assertSnapshot(snapshot({ flagRevisions: [{ ...flagRevisions[0], revision: NaN }] })), 'non-finite keys remain invalid before sorting');
});
test('snapshot sort inspects the complete collection and bounds a late large-row failure', () => {
  const projects = Array.from({ length: 1000 }, (_, index) => ({ projectId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, name: 'x'.repeat(4096) }));
  assertSnapshot(snapshot({ projects }));
  [projects[998], projects[999]] = [projects[999], projects[998]];
  rejectSort(snapshot({ projects }), /projectId sort at index 999/);
});
