import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import contract from '../contracts/transfer/flagfoundry.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { validator, openApi, requestPath, expand } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/flagfoundry/v2/fixtures/index.mjs';
import { createCaseContext } from '../evaluators/transfer/flagfoundry/v2/lib/runtime.mjs';
import { assertOpenApiDocument, snapshotDigest, snapshotFromRevision, assertEvaluation, expectedEvaluation, assertExpectedEvaluation, resolveObservation, assertRolloutAuthority, assertSnapshot, findSubjectForBucket, rolloutBucket } from '../evaluators/transfer/flagfoundry/v2/oracles/index.mjs';
import { submitOutcomes, exactIdSets, checkRolloutAuthority } from '../evaluators/transfer/flagfoundry/v2/cases/helpers.mjs';
import { validateManifest } from '../evaluators/transfer/flagfoundry/v2/lib/scoring.mjs';
import { CASES } from '../evaluators/transfer/flagfoundry/v2/cases/index.mjs';

const factory = createFixtureFactory({ evaluationSeed: 'public-wire-regression', caseId: 'A-05', baseTime: '2032-04-05T06:07:08.000Z' });
const compile = validator(contract);
const response = (status, json) => ({ status, json, text: JSON.stringify(json) });

test('FlagFoundry every published operation and real private OpenAPI oracle agree', () => {
  assert.deepEqual(validatePublicContract(contract), { operations: 18, probes: 8, schemas: 18 });
  assert.equal(CASES.length, 44); assert.doesNotThrow(() => assertOpenApiDocument(openApi(contract)));
  const seed = contract.seed.example, snapshot = snapshotFromRevision(seed.activeRevisions[0], seed.flags[0], seed.projects[0].projectId, seed.environments[0]);
  assert.equal(snapshotDigest(snapshot), seed.activeRevisions[0].snapshotDigest);
});

test('FlagFoundry real private seed families and snapshot digests remain legal', () => {
  const valid = compile(contract.seed.schema);
  for (const name of ['empty', 'flag', 'revision', 'evaluation', 'idempotency', 'contention', 'work', 'event', 'rollout', 'migration', 'browser', 'performance']) {
    const family = factory[name](); assert(valid(family.seed), `${name}: ${JSON.stringify(valid.errors)}`);
    for (const revision of family.seed.activeRevisions) {
      const flag = family.seed.flags.find(flag => flag.flagId === revision.flagId);
      const env = family.seed.environments.find(env => env.projectId === flag.projectId && env.name === revision.environment);
      assert.equal(snapshotDigest(snapshotFromRevision(revision, flag, flag.projectId, env)), revision.snapshotDigest);
    }
  }
});

test('FlagFoundry mounted author boundary and real evaluation helper preserve required headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'flag-public-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'contract.json'), JSON.stringify(contract));
  await writeFile(join(directory, 'runtime.mjs'), `export * from ${JSON.stringify(pathToFileURL(resolve('templates/contract-first/runtime.mjs')).href)};`);
  const boundary = await evaluatorContract(directory);
  for (const operation of contract.operations) {
    const example = expand(operation.example, { ADMIN_TOKEN: 'public-author' });
    assert.doesNotThrow(() => boundary.request(requestPath(operation, example), { method: operation.method, headers: example.headers, ...(example.body !== undefined ? { json: example.body } : {}) }), operation.id);
  }
  const ctx = await createCaseContext({ workspace: process.cwd(), evaluationSeed: 'public-wire', caseId: 'A-05', manageDatabase: false });
  t.after(() => ctx.teardown()); const calls = [];
  ctx.request = async (_base, path, options) => { boundary.request(path, options); calls.push(options); return response(200, {}); };
  await ctx.evaluateFlag('http://author', factory.evaluationBody('same'));
  await ctx.evaluateFlag('http://author', factory.evaluationBody('same'));
  await ctx.evaluateFlag('http://author', factory.evaluationBody('other'));
  assert(calls.every(call => call.headers['idempotency-key']));
  assert.notEqual(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
  assert.equal(new Set(calls.map(call => call.headers['idempotency-key'])).size, 3, 'repeated input reads the current snapshot instead of replaying a previous evaluation');
  assert.throws(() => boundary.request('/api/v1/evaluations', { method: 'POST', json: factory.evaluationBody('bad') }), e => e.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.throws(() => boundary.seed({ ...factory.flag().seed, extra: true }), e => e.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
});

test('FlagFoundry real outcome extraction uses public acceptedIds and duplicateIds', async () => {
  const family = factory.rollout(), value = family.outcome(1);
  const ctx = { key: factory.key, outcomeBatch: async () => response(200, { acceptedIds: [value.outcomeId], duplicateIds: [] }), ok: assert.ok, equal: assert.deepEqual };
  const result = await submitOutcomes(ctx, 'http://author', factory.uuid('rollout'), [value]);
  exactIdSets(ctx, result, [value.outcomeId], []);
  ctx.outcomeBatch = async () => response(200, { acceptedOutcomeIds: [value.outcomeId], duplicateOutcomeIds: [] });
  await assert.rejects(() => submitOutcomes(ctx, 'http://author', factory.uuid('rollout'), [value]));
});

test('FlagFoundry independent evaluation oracle accepts both published legacy and null extension shapes without losing business checks', () => {
  const body = factory.evaluationBody('oracle'), expected = expectedEvaluation(factory.snapshot(), body);
  const ctx = { equal: assert.deepEqual };
  const legacy = { ...expected }; delete legacy.rolloutId; delete legacy.stepIndex;
  assertEvaluation(legacy); assertEvaluation(expected);
  assertExpectedEvaluation(ctx, legacy, expected, 'legacy representation');
  assertExpectedEvaluation(ctx, expected, expected, 'explicit null representation');
  assert.throws(() => assertExpectedEvaluation(ctx, { ...legacy, value: 'wrong' }, expected));
  assert.equal(resolveObservation({ successCount: 3, failureCount: 1, minimumEvaluationCount: 4, maximumFailureBasisPoints: 2500 }).passed, true);
});

// Private observation fixtures use the real task fixture factory; no Manager state
// is added to either the public or private V1 seed format.
function rolloutObservation(state = 'RUNNING') {
  const family = factory.rollout();
  const prior = structuredClone(family.stringActive);
  const candidateOptions = { revisionId: factory.uuid('authority-candidate'), revision: 2 };
  const candidate = { ...family.activeRevision(family.stringFlag, candidateOptions), state: 'READY', activatedAt: null };
  const priorSnapshot = family.snapshot(), candidateSnapshot = family.snapshot(family.stringFlag, candidateOptions);
  const steps = [5000, 10000].map((exposure, index) => ({ stepIndex: index, candidateExposureBasisPoints: exposure, minimumEvaluationCount: 2, maximumFailureBasisPoints: 0, observationSeconds: 60, successCount: 0, failureCount: 0, state: index === 0 ? 'OBSERVING' : 'PENDING', startedAt: index === 0 ? factory.at() : null, observationDeadlineAt: index === 0 ? factory.at({ seconds: 60 }) : null, completedAt: null }));
  const rollout = { rolloutId: factory.uuid('authority-rollout'), flagId: family.stringFlag.flagId, environment: family.environment.name, priorRevisionId: prior.revisionId, candidateRevisionId: candidate.revisionId, state, currentStepIndex: 0, steps, createdAt: factory.at(), terminalAt: null };
  if (state === 'COMPLETED') {
    rollout.currentStepIndex = 1; rollout.terminalAt = factory.at({ seconds: 2 });
    steps.forEach((step, index) => Object.assign(step, { state: 'PASSED', successCount: 2, startedAt: factory.at({ seconds: index }), observationDeadlineAt: factory.at({ seconds: index + 60 }), completedAt: factory.at({ seconds: index + 1 }) }));
    prior.state = 'SUPERSEDED'; candidate.state = 'ACTIVE'; candidate.activatedAt = rollout.terminalAt;
  } else if (state === 'ROLLED_BACK') {
    rollout.terminalAt = factory.at({ seconds: 1 });
    Object.assign(steps[0], { state: 'FAILED', successCount: 1, failureCount: 1, completedAt: rollout.terminalAt });
  }
  const snapshot = { asOf: factory.at({ seconds: 3 }), resources: { projects: [family.project], environments: [family.environment], flags: [{ ...family.stringFlag, createdAt: prior.createdAt }], flagRevisions: [prior, candidate], flagSnapshots: [priorSnapshot, candidateSnapshot], progressiveRollouts: [rollout], evaluationOutcomes: [] }, work: [], events: [] };
  return { family, snapshot, rollout, prior, candidate, priorSnapshot, candidateSnapshot };
}

test('confirmed rollout authority oracle accepts all three transitions and rejects shape-valid early promotion and bad rollback', () => {
  assert.equal(contract.policyRevision, 'flagfoundry-public-observation-v2');
  const valid = compile(contract.schemas.VerificationSnapshot);
  for (const phase of ['RUNNING', 'COMPLETED', 'ROLLED_BACK']) {
    const fixture = rolloutObservation(phase);
    assert(valid(fixture.snapshot), JSON.stringify(valid.errors));
    assertSnapshot(fixture.snapshot);
    const result = assertRolloutAuthority(fixture.snapshot, fixture.rollout.rolloutId, { expectedState: phase });
    assert.equal(result.active.revisionId, phase === 'COMPLETED' ? fixture.candidate.revisionId : fixture.prior.revisionId);
  }
  const negatives = [
    ['RUNNING', f => { f.prior.state = 'SUPERSEDED'; f.candidate.state = 'ACTIVE'; f.candidate.activatedAt = factory.at(); }],
    ['RUNNING', f => { f.candidate.state = 'ACTIVE'; }],
    ['RUNNING', f => { f.candidate.activatedAt = factory.at(); }],
    ['COMPLETED', f => { f.prior.state = 'ACTIVE'; f.candidate.state = 'READY'; f.candidate.activatedAt = null; }],
    ['COMPLETED', f => { f.rollout.steps[0].state = 'OBSERVING'; }],
    ['COMPLETED', f => { f.candidate.activatedAt = factory.at(); }],
    ['ROLLED_BACK', f => { f.prior.state = 'SUPERSEDED'; f.candidate.state = 'ACTIVE'; f.candidate.activatedAt = factory.at(); }],
    ['ROLLED_BACK', f => { f.candidate.state = 'REJECTED'; }],
  ];
  for (const [phase, mutate] of negatives) {
    const fixture = rolloutObservation(phase); mutate(fixture);
    assert(valid(fixture.snapshot), 'negative is legal wire, not a schema failure');
    assert.throws(() => assertRolloutAuthority(fixture.snapshot, fixture.rollout.rolloutId), `${phase} authority violation must fail`);
    if (phase === 'RUNNING') assert.throws(() => assertSnapshot(fixture.snapshot));
  }
  const fullExposure = rolloutObservation();
  Object.assign(fullExposure.rollout.steps[0], { state: 'PASSED', successCount: 2, completedAt: factory.at({ seconds: 1 }) });
  fullExposure.rollout.currentStepIndex = 1;
  Object.assign(fullExposure.rollout.steps[1], { state: 'OBSERVING', startedAt: factory.at({ seconds: 1 }), observationDeadlineAt: factory.at({ seconds: 61 }) });
  assert.equal(assertRolloutAuthority(fullExposure.snapshot, fullExposure.rollout.rolloutId).active.revisionId, fullExposure.prior.revisionId, '10000 exposure alone does not promote the candidate');
});

test('real rollout helper verifies both cohort routes and terminal fresh evaluations against observed authority', async () => {
  for (const phase of ['RUNNING', 'COMPLETED', 'ROLLED_BACK']) {
    const fixture = rolloutObservation(phase);
    const subjects = [true, false].map(candidate => findSubjectForBucket(subject => rolloutBucket(fixture.family.stringFlag.key, fixture.family.environment.name, subject), bucket => (bucket < 5000) === candidate, `authority-${candidate}`).subjectKey);
    const bodies = subjects.map(subjectKey => fixture.family.evaluationBody(subjectKey, { context: { subjectKey, plan: 'free', country: 'MX', region: 'na' } }));
    const expected = bodies.map((body, index) => expectedEvaluation(phase === 'COMPLETED' || (phase === 'RUNNING' && index === 0) ? fixture.candidateSnapshot : fixture.priorSnapshot, body, phase === 'RUNNING' ? { rolloutId: fixture.rollout.rolloutId, stepIndex: 0 } : {}));
    let calls = 0;
    const ctx = { snapshot: async () => structuredClone(fixture.snapshot), assert: (_label, run) => run(), ok: assert.ok, equal: assert.deepEqual, evaluateFlag: async (_base, body) => { assert.deepEqual(body, bodies[calls]); return response(200, expected[calls++]); } };
    await checkRolloutAuthority(ctx, 'http://author', fixture.rollout.rolloutId, { expectedState: phase, bodies });
    assert.equal(calls, 2, `${phase} uses real fresh evaluation helper calls`);
    const wrongArtifact = phase === 'ROLLED_BACK' ? fixture.candidateSnapshot : fixture.priorSnapshot;
    ctx.evaluateFlag = async (_base, body) => response(200, expectedEvaluation(wrongArtifact, body, phase === 'RUNNING' ? { rolloutId: fixture.rollout.rolloutId, stepIndex: 0 } : {}));
    await assert.rejects(() => checkRolloutAuthority(ctx, 'http://author', fixture.rollout.rolloutId, { expectedState: phase, bodies: [bodies[0]] }), 'wrong routing must fail even when snapshot states are correct');
    ctx.snapshot = async () => { const wrong = structuredClone(fixture.snapshot); wrong.resources.flagRevisions[0].state = 'REJECTED'; return wrong; };
    await assert.rejects(() => checkRolloutAuthority(ctx, 'http://author', fixture.rollout.rolloutId), 'real helper rejects wrong current pointer');
  }
});

test('snapshot oracle does not freeze historical terminal rollouts or steal authority from a STALE winner', () => {
  for (const phase of ['COMPLETED', 'ROLLED_BACK', 'STALE']) {
    const fixture = rolloutObservation(phase === 'STALE' ? 'RUNNING' : phase);
    if (phase === 'STALE') { fixture.rollout.state = 'STALE'; fixture.rollout.terminalAt = factory.at({ seconds: 2 }); }
    fixture.prior.state = 'SUPERSEDED';
    if (fixture.candidate.state === 'ACTIVE') fixture.candidate.state = 'SUPERSEDED';
    const options = { revisionId: factory.uuid(`later-${phase}`), revision: 3 };
    fixture.snapshot.resources.flagRevisions.push(fixture.family.activeRevision(fixture.family.stringFlag, options));
    fixture.snapshot.resources.flagSnapshots.push(fixture.family.snapshot(fixture.family.stringFlag, options));
    assert.doesNotThrow(() => assertSnapshot(fixture.snapshot), `${phase} historical row does not override a later activation`);
  }
});

test('publicly resolved observation gaps have real case assertions but remain pending live validation', async () => {
  const root = new URL('../evaluators/transfer/flagfoundry/v2/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.v2.json', root), 'utf8'));
  const map = JSON.parse(await readFile(new URL('contract-map.v2.json', root), 'utf8'));
  assert(validateManifest(manifest, map));
  assert.deepEqual(manifest.specGaps, []);
  assert(manifest.cases.every(row => !(row.blockedAssertions?.length)));
  assert.deepEqual(manifest.resolvedSpecGaps.map(row => row.id), Array.from({ length: 7 }, (_, index) => `SPEC-GAP-${String(index + 2).padStart(2, '0')}`));
  const release = JSON.parse(await readFile(new URL('../evaluators/transfer/flagfoundry/release.json', import.meta.url), 'utf8'));
  assert.equal(release.status, 'pending_live_validation');
});
