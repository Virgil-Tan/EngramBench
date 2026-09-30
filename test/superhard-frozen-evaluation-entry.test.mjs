import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseOptions, validateFrozenBinding, verifyReuse, inspectEvaluation } from '../work/superhard-v2-alignment-20260908/evaluate.mjs';
import { authorValidationReport } from '../src/task-package-v2-evaluator.mjs';
import { loadTaskPackageV1, digestTaskPackagePath } from '../src/task-package-v1.mjs';
import { validateConversationTask } from '../src/conversation-harness.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const taskDigest = task => sha(JSON.stringify(validateConversationTask(task)));

test('per-run evaluator requires explicit absolute paths, accepts dry-run and stable seed/clock', () => {
  const args = ['--run-root', '/runtime/runs/r1', '--task-root', '/runtime/task-packages/v2/commercecommand', '--output-root', '/private/eval-r1'];
  const options = parseOptions([...args, '--dry-run']);
  assert.equal(options.dryRun, true);
  assert.equal(options.baseTime, undefined);
  for (const extra of [['--wat'], ['--run-root', '/other'], ['--seed', '123'], ['--base-time', 'bad']]) assert.throws(() => parseOptions([...args, ...extra]));
  assert.throws(() => parseOptions(['--run-root', 'relative']));
});

test('binding requires V2, frozen public-checked source, unchanged task/plan/package', () => {
  const executionPlan = 'Implement the frozen public plan.\n', planDigest = sha(executionPlan);
  const taskPackage = { task: { schemaVersion: 1, id: 'commercecommand', readme: 'Public requirements.\n', executionPlan, planDigest } };
  const experiment = { benchmarkVersion: 2, runId: 'r1', ownerId: 'owner', taskIds: ['commercecommand'], packages: [{ id: 'commercecommand', packageDigest: 'package', planDigest }] };
  const state = { schemaVersion: 1, kind: 'conversation-harness-run', runId: 'r1-commercecommand', ownerId: 'owner', agentDriverId: 'codex', taskId: 'commercecommand', status: 'awaiting_evaluation', phase: 'testing',
    taskDigest: taskDigest(taskPackage.task), planDigest,
    submission: { path: '/frozen/submission', digest: 'a'.repeat(64) }, publicContractChecks: [{ passed: true, workspaceDigest: 'a'.repeat(64) }] };
  const input = { experiment, state, taskPackage, sourceTaskPackage: taskPackage, sourcePackageDigest: 'package', runRoot: '/runtime/runs/r1' };
  validateFrozenBinding(input);
  for (const change of [{ schemaVersion: 2 }, { kind: 'other' }, { runId: 'other-commercecommand' }, { ownerId: 'other' }, { agentDriverId: 'other' }, { status: 'running' }, { phase: 'implementing' }, { taskDigest: 'other' }, { planDigest: 'other' }, { publicContractChecks: [{ passed: false }] }, { submission: { path: '/frozen/other', digest: 'b'.repeat(64) } }])
    assert.throws(() => validateFrozenBinding({ ...input, state: { ...state, ...change } }));
  assert.throws(() => validateFrozenBinding({ ...input, experiment: { ...experiment, benchmarkVersion: 1 } }));
  assert.throws(() => validateFrozenBinding({ ...input, sourcePackageDigest: 'changed' }));
  assert.throws(() => validateFrozenBinding({ ...input, experiment: { ...experiment, packages: [{ ...experiment.packages[0], planDigest: 'changed' }] } }));
});

test('cross-runtime binding permits evaluator-only hashes but rejects public task or frozen-source drift', () => {
  const executionPlan = 'Frozen plan\n', planDigest = sha(executionPlan);
  const sourceTaskPackage = { task: { schemaVersion: 1, id: 'commercecommand', readme: 'Public requirements\n', executionPlan, planDigest, metadata: { taskVersion: 'v2', environment: 'native', contractDigest: 'contract', scenarioDigest: 'scenario', packageDigest: 'old-package', evaluatorDigest: 'old-evaluator' } } };
  const taskPackage = structuredClone(sourceTaskPackage);
  Object.assign(taskPackage.task.metadata, { packageDigest: 'fixed-package', evaluatorDigest: 'fixed-evaluator' });
  const experiment = { benchmarkVersion: 2, runId: 'r1', ownerId: 'owner', taskIds: ['commercecommand'], packages: [{ id: 'commercecommand', packageDigest: 'old-package', planDigest }] };
  const state = { schemaVersion: 1, kind: 'conversation-harness-run', runId: 'r1-commercecommand', ownerId: 'owner', agentDriverId: 'codex', taskId: 'commercecommand', status: 'awaiting_evaluation', phase: 'testing', taskDigest: taskDigest(sourceTaskPackage.task), planDigest, submission: { path: '/frozen', digest: 'a'.repeat(64) }, publicContractChecks: [{ passed: true, workspaceDigest: 'a'.repeat(64) }] };
  const input = { experiment, state, taskPackage, sourceTaskPackage, sourcePackageDigest: 'old-package', runRoot: '/source/runs/r1' };
  validateFrozenBinding(input);
  for (const field of ['id', 'readme', 'executionPlan', 'planDigest']) {
    const changed = structuredClone(taskPackage); changed.task[field] += '-changed';
    assert.throws(() => validateFrozenBinding({ ...input, taskPackage: changed }));
  }
  for (const field of ['taskVersion', 'environment', 'contractDigest', 'scenarioDigest']) {
    const changed = structuredClone(taskPackage); changed.task.metadata[field] += '-changed';
    assert.throws(() => validateFrozenBinding({ ...input, taskPackage: changed }), /changed since coding/);
  }
  assert.throws(() => validateFrozenBinding({ ...input, state: { ...state, taskDigest: taskDigest(taskPackage.task) } }), /Development task changed/);
});

test('real superhard package README trailing newlines use the exact Harness-normalized digest without changing stored state', async () => {
  for (const id of ['commercecommand', 'coldchaincontrol', 'creatorrightsexchange', 'accesssentinel']) {
    const taskPackage = await loadTaskPackageV1(resolve(import.meta.dirname, '../task-packages/v2', id));
    assert.match(taskPackage.task.readme, /\s$/);
    const normalized = validateConversationTask(taskPackage.task);
    assert.equal(normalized.readme, taskPackage.task.readme.trim());
    assert.equal(normalized.executionPlan, taskPackage.task.executionPlan, 'Frozen Plan bytes must not be trimmed');
    const state = { schemaVersion: 1, kind: 'conversation-harness-run', runId: `r1-${id}`, ownerId: 'owner', agentDriverId: 'codex', taskId: id, status: 'awaiting_evaluation', phase: 'testing', taskDigest: sha(JSON.stringify(normalized)), planDigest: taskPackage.task.planDigest, submission: { path: '/frozen', digest: 'a'.repeat(64) }, publicContractChecks: [{ passed: true, workspaceDigest: 'a'.repeat(64) }] };
    const before = structuredClone(state);
    const input = { experiment: { benchmarkVersion: 2, runId: 'r1', ownerId: 'owner', taskIds: [id], packages: [{ id, packageDigest: taskPackage.digests.package, planDigest: taskPackage.task.planDigest }] }, state, taskPackage, sourceTaskPackage: taskPackage, sourcePackageDigest: taskPackage.digests.package, runRoot: '/runtime/runs/r1' };
    assert.notEqual(state.taskDigest, sha(JSON.stringify(taskPackage.task)), 'raw package hash reproduces the previous integration failure');
    validateFrozenBinding(input);
    assert.deepEqual(state, before, 'do not rewrite actual historical state to match the evaluator');
    assert.throws(() => validateFrozenBinding({ ...input, state: { ...state, taskDigest: sha(JSON.stringify(taskPackage.task)) } }), /Development task changed/);
  }
});

test('reuse rejects partial evidence and drift in seed, source, package or clock', () => {
  const request = { task: { id: 'commercecommand', digest: 'p' }, submission: { path: '/frozen', digest: 's' }, seed: 'a'.repeat(64) };
  const binding = { baseTime: '2026-09-08T00:00:00.000Z', runRoot: '/runtime/runs/r1' };
  const result = authorValidationReport({ taskId: 'commercecommand', request, cases: [{ id: 'A-01', status: 'failed' }], totalCases: 1, complete: true });
  const previous = { request, result, launch: { binding }, status: { status: 'completed' } };
  const expected = { request, binding, caseIds: ['A-01'] };
  assert.equal(verifyReuse(previous, expected), result);
  assert.throws(() => verifyReuse({ ...previous, status: { status: 'running' } }, expected), /Partial evaluation/);
  assert.throws(() => verifyReuse({ ...previous, result: { ...result, complete: false } }, expected));
  assert.throws(() => verifyReuse(previous, { ...expected, request: { ...request, seed: 'b'.repeat(64) } }));
  assert.throws(() => verifyReuse(previous, { ...expected, binding: { ...binding, baseTime: '2026-09-09T00:00:00.000Z' } }));
  assert.throws(() => verifyReuse({ ...previous, result: { ...result, score: 100 } }, expected));
});

test('full author validation retains explicitly excluded checkpoints without inventing formal scores', () => {
  const request = { task: { id: 'commercecommand', digest: 'p' }, submission: { path: '/frozen', digest: 's' }, seed: 'a'.repeat(64) };
  const binding = { baseTime: '2026-09-08T00:00:00.000Z', runRoot: '/runtime/runs/r1' };
  const cases = [{ id: 'A-01', status: 'failed' }, ...['E-01', 'E-02', 'E-03'].map(id => ({ id, status: 'excluded', reason: 'No real pre-Manager V1 checkpoint supplied' }))];
  const result = authorValidationReport({ taskId: 'commercecommand', request, cases, totalCases: cases.length, complete: true });
  const previous = { request, result, launch: { binding }, status: { status: 'completed' } };
  assert.equal(verifyReuse(previous, { request, binding, caseIds: cases.map(item => item.id) }), result);
  assert.equal(result.counts.excluded, 3);
  assert.equal(result.formalEligible, false);
  assert.equal(result.score, null);
  assert.equal(result.rawScore, null);
  assert.throws(() => verifyReuse({ ...previous, result: { ...result, cases: cases.slice(0, 1) } }, { request, binding, caseIds: cases.map(item => item.id) }));
});

test('dry-run inspects a deployed Transfer package without writing evidence or changing frozen code', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'frontal-superhard-entry-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const taskId = 'commercecommand', taskRoot = resolve(import.meta.dirname, '../task-packages/v2', taskId);
  const taskPackage = await loadTaskPackageV1(taskRoot);
  const runRoot = join(directory, 'runtime/runs/r1'), stateRoot = join(runRoot, 'projects', `01-${taskId}`, 'private');
  const sourceTaskRoot = join(directory, 'runtime/task-packages/v2', taskId);
  await cp(taskRoot, sourceTaskRoot, { recursive: true });
  // Simulate an older evaluator-only deployment with identical public assets.
  const entry = join(sourceTaskRoot, 'evaluator/run.mjs');
  await writeFile(entry, `${await readFile(entry, 'utf8')}\n// Previous evaluator deployment.\n`);
  const sourceTaskPackage = await loadTaskPackageV1(sourceTaskRoot);
  assert.notEqual(sourceTaskPackage.digests.package, taskPackage.digests.package);
  await mkdir(stateRoot, { recursive: true });
  const submissionPath = join(runRoot, 'frozen');
  await mkdir(submissionPath); await writeFile(join(submissionPath, 'unchanged.txt'), 'Frozen test-only source');
  const digest = await digestTaskPackagePath(submissionPath);
  await writeFile(join(runRoot, 'experiment.json'), JSON.stringify({ benchmarkVersion: 2, runId: 'r1', ownerId: 'owner', taskIds: [taskId], packages: [{ id: taskId, packageDigest: sourceTaskPackage.digests.package, planDigest: sourceTaskPackage.task.planDigest }] }));
  await writeFile(join(stateRoot, 'harness-state.json'), JSON.stringify({ schemaVersion: 1, kind: 'conversation-harness-run', runId: `r1-${taskId}`, ownerId: 'owner', agentDriverId: 'codex', taskId, status: 'awaiting_evaluation', phase: 'testing',
    taskDigest: taskDigest(sourceTaskPackage.task), planDigest: sourceTaskPackage.task.planDigest,
    submission: { path: submissionPath, digest }, publicContractChecks: [{ passed: true, workspaceDigest: digest }] }));
  const outputRoot = join(directory, 'results');
  const options = parseOptions(['--run-root', runRoot, '--task-root', taskRoot, '--output-root', outputRoot, '--dry-run']);
  const inspected = await inspectEvaluation(options);
  assert.equal(inspected.request.task.id, taskId);
  assert.equal(inspected.request.task.digest, taskPackage.digests.package, 'new hidden request uses the corrected evaluator package');
  assert.equal(inspected.binding.publicRequirementsDigest, await digestTaskPackagePath(join(sourceTaskPackage.paths.workspace, 'docs/frontal-legacy')));
  assert.equal(inspected.caseIds.length, 55);
  assert.equal(inspected.previous, null);
  await assert.rejects(readFile(join(outputRoot, 'request.json')), { code: 'ENOENT' });
  assert.equal(await digestTaskPackagePath(submissionPath), digest);
  await assert.rejects(inspectEvaluation({ ...options, outputRoot: join(submissionPath, 'results') }), /outside the run/);
  await mkdir(outputRoot);
  await writeFile(join(outputRoot, 'keep.txt'), 'partial evidence');
  await assert.rejects(inspectEvaluation(options), /Partial evaluation directory retained/);
  assert.equal(await readFile(join(outputRoot, 'keep.txt'), 'utf8'), 'partial evidence');
  // A package whose original business documents changed must not be admitted just
  // because its wrapper README, Frozen Plan and structural contract still match.
  const legacyReadme = join(sourceTaskPackage.paths.workspace, 'docs/frontal-legacy/README.md');
  await writeFile(legacyReadme, `${await readFile(legacyReadme, 'utf8')}\nChanged original public requirement.\n`);
  const changedSource = await loadTaskPackageV1(sourceTaskRoot);
  const experiment = JSON.parse(await readFile(join(runRoot, 'experiment.json'), 'utf8'));
  experiment.packages[0].packageDigest = changedSource.digests.package;
  await writeFile(join(runRoot, 'experiment.json'), JSON.stringify(experiment));
  const statePath = join(stateRoot, 'harness-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.taskDigest = taskDigest(changedSource.task);
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(inspectEvaluation(options), /Public legacy requirement documents changed/);
  assert.equal(await digestTaskPackagePath(submissionPath), digest);
});
