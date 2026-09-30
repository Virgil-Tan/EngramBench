import { assertCompilationFindings, assertLegacyActivationPersistence, assertStandaloneRolloutEvents, expectedEvaluation, assertExpectedEvaluation, selectRolloutSnapshot, snapshotDigest, utf8Compare } from '../oracles/index.mjs';
import { activate, createReadyCandidate, createRevision, exactIdSets, expectError, progressiveActivate, requireStatus, snapshot, stableSemantic, submitOutcomes, waitSnapshot } from './helpers.mjs';

export async function checkUnmatchedEvaluation(ctx, baseUrl, family) {
  const body = family.evaluationBody('no-rule', { context: { subjectKey: 'no-rule', plan: 'free', country: 'MX', region: 'na' } });
  const expected = expectedEvaluation(family.snapshot(), body);
  ctx.equal(expected.reason, 'PERCENTAGE', 'no matching rule uses percentage, never DEFAULT fallback');
  const result = await ctx.evaluateFlag(baseUrl, body);
  requireStatus(ctx, result, 200, 'no-rule Evaluation');
  assertExpectedEvaluation(ctx, result.json, expected, 'no-rule percentage result');
  expectError(ctx, await ctx.evaluateFlag(baseUrl, { ...body, context: { ...body.context, unpublishedAttribute: 'x' } }), 400, 'INVALID_FLAG_RULE');
}

export async function checkCapturedSchemaRace(ctx, baseUrl, family, label) {
  const initial = await snapshot(ctx, baseUrl);
  const current = initial.resources.flagRevisions.find(row => row.flagId === family.stringFlag.flagId && row.environment === family.environment.name && row.state === 'ACTIVE');
  const oldEnvironment = initial.resources.environments.find(row => row.projectId === family.project.projectId && row.name === family.environment.name);
  const ready = await createReadyCandidate(ctx, baseUrl, family, { label: `${label}-ready`, overrides: { expectedActiveRevision: current.revision } });
  for (const worker of ready.workers) await ctx.stop(worker);
  const pending = await createRevision(ctx, baseUrl, family.stringFlag.flagId, family.revisionBody(family.stringFlag, `${label}-pending`, { expectedActiveRevision: current.revision }), { key: ctx.key(`${label}-pending`) });
  const attributes = [...new Set([...oldEnvironment.contextAttributes, 'schemaProbe'])].sort(utf8Compare);
  const path = `/api/v1/projects/${family.project.projectId}/environments/${encodeURIComponent(family.environment.name)}/context-schema`;
  const key = ctx.key(`${label}-schema`), body = { contextAttributes: attributes };
  const updated = await ctx.mutate(baseUrl, path, key, body, { admin: true });
  requireStatus(ctx, updated, 200, 'update captured Environment schema');
  ctx.equal(updated.json, { ...oldEnvironment, contextAttributes: attributes, schemaRevision: oldEnvironment.schemaRevision + 1 }, 'one schema revision increment');
  stableSemantic(ctx, [updated, await ctx.mutate(baseUrl, path, key, body, { admin: true })], 'schema mutation replay');
  expectError(ctx, await ctx.activateRevision(baseUrl, ready.revision.revisionId, current.revision, { key: ctx.key(`${label}-stale-ready`) }), 409, 'ACTIVE_REVISION_CHANGED');
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const state = await waitSnapshot(ctx, baseUrl, value => value.resources.flagRevisions.find(row => row.revisionId === pending.json.revisionId)?.state === 'REJECTED', { label: 'captured schema rejects unfinished Compilation', processes: workers });
  const rejected = state.resources.flagRevisions.find(row => row.revisionId === pending.json.revisionId);
  ctx.equal(state.resources.environments.find(row => row.projectId === family.project.projectId && row.name === family.environment.name), updated.json, 'updated schema is durably visible in the public snapshot');
  ctx.equal(rejected.snapshotDigest, null, 'stale Compilation has no digest');
  ctx.ok(!state.resources.flagSnapshots.some(row => row.revisionId === rejected.revisionId), 'stale Compilation has no Snapshot');
  ctx.equal(state.resources.flagSnapshots.find(row => row.revisionId === ready.revision.revisionId), ready.artifact, 'READY Snapshot stays immutable after schema change');
  ctx.equal(state.resources.flagRevisions.filter(row => row.flagId === family.stringFlag.flagId && row.environment === family.environment.name && row.state === 'ACTIVE').map(row => row.revisionId), [current.revisionId], 'schema race cannot change active pointer');
  const findingsPath = `/api/v1/flag-revisions/${pending.json.revisionId}/findings`;
  const findings = requireStatus(ctx, await ctx.request(baseUrl, findingsPath), 200, 'rejected Compilation findings');
  ctx.assert('nonempty sorted rejection findings', () => assertCompilationFindings(findings, { rejected: true }));
  const repeated = requireStatus(ctx, await ctx.request(baseUrl, findingsPath), 200, 'durable findings reread');
  ctx.assert('stable rejection findings', () => assertCompilationFindings(repeated, { rejected: true, previous: findings }));
  const readyFindings = requireStatus(ctx, await ctx.request(baseUrl, `/api/v1/flag-revisions/${ready.revision.revisionId}/findings`), 200, 'successful Compilation findings');
  ctx.equal(readyFindings, [], 'successful Compilation has no rejection findings');
  for (const worker of workers) await ctx.stop(worker);
  return { rejectedRevisionId: rejected.revisionId, schemaRevision: updated.json.schemaRevision };
}

export async function checkLegacyActivation(ctx, baseUrl, family) {
  const candidate = await createReadyCandidate(ctx, baseUrl, family, { label: 'legacy-row-observation' });
  for (const worker of candidate.workers) await ctx.stop(worker);
  const before = await snapshot(ctx, baseUrl), key = ctx.key('legacy-row-activate');
  const result = await activate(ctx, baseUrl, candidate.revision.revisionId, 1, { key });
  stableSemantic(ctx, [result, await ctx.activateRevision(baseUrl, candidate.revision.revisionId, 1, { key })], 'legacy reply is preserved on replay');
  const after = await snapshot(ctx, baseUrl);
  ctx.assert('legacy Manager row policy', () => assertLegacyActivationPersistence(before, after));
}

export async function checkWrongSnapshotOutcome(ctx, baseUrl, family, rollout, validOutcomes) {
  const before = await snapshot(ctx, baseUrl);
  const wrong = family.outcome(999, { snapshotDigest: 'f'.repeat(64) });
  const result = await ctx.outcomeBatch(baseUrl, rollout.rolloutId, { outcomes: [validOutcomes[0], wrong] }, { key: ctx.key('wrong-snapshot-atomic') });
  expectError(ctx, result, 409, 'SNAPSHOT_MISMATCH');
  const after = await snapshot(ctx, baseUrl);
  for (const field of ['resources', 'work', 'events']) ctx.equal(after[field], before[field], `wrong Snapshot batch leaves ${field} unchanged`);
}

export async function checkStandaloneStepEvents(ctx, baseUrl, family) {
  const current = (await snapshot(ctx, baseUrl)).resources.flagRevisions.find(row => row.flagId === family.stringFlag.flagId && row.environment === family.environment.name && row.state === 'ACTIVE');
  const candidate = await createReadyCandidate(ctx, baseUrl, family, { label: 'standalone-event', overrides: { expectedActiveRevision: current.revision } });
  for (const worker of candidate.workers) await ctx.stop(worker);
  const before = await snapshot(ctx, baseUrl);
  const rollout = await progressiveActivate(ctx, baseUrl, candidate.revision.revisionId, current.revision, [5000, 10000].map(exposure => ({ candidateExposureBasisPoints: exposure, minimumEvaluationCount: 1, maximumFailureBasisPoints: 0, observationSeconds: 60 })), { key: ctx.key('standalone-events') });
  const started = await snapshot(ctx, baseUrl);
  ctx.assert('starting an observation emits no activation event', () => assertStandaloneRolloutEvents(before, started));
  const outcome = { outcomeId: ctx.key('standalone-outcome'), stepIndex: 0, subjectKey: 'standalone-observation', outcome: 'SUCCESS' };
  const prior = before.resources.flagSnapshots.find(row => row.revisionId === current.revisionId);
  const selected = selectRolloutSnapshot({ flagKey: family.stringFlag.key, environment: family.environment.name, subjectKey: outcome.subjectKey, exposure: 5000, prior, candidate: candidate.artifact });
  outcome.snapshotDigest = snapshotDigest(selected.snapshot);
  const result = await submitOutcomes(ctx, baseUrl, rollout.json.rolloutId, [outcome], { key: ctx.key('standalone-step') });
  exactIdSets(ctx, result, [outcome.outcomeId], []);
  const advanced = await snapshot(ctx, baseUrl);
  const currentRollout = advanced.resources.progressiveRollouts.find(row => row.rolloutId === rollout.json.rolloutId);
  ctx.equal(currentRollout.currentStepIndex, 1, 'step really advanced');
  ctx.equal(currentRollout.state, 'RUNNING', 'step advance is not activation');
  ctx.assert('standalone Step advance emits no event', () => assertStandaloneRolloutEvents(started, advanced));
}
