import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseSelectedOptions, validateSelectedSource, inspectSelectedEvaluation } from '../work/superhard-v2-alignment-20260908/evaluate-selected.mjs';
import { authorValidationReport } from '../src/task-package-v2-evaluator.mjs';
import { loadTaskPackageV1, digestTaskPackagePath } from '../src/task-package-v1.mjs';
import { validateConversationTask } from '../src/conversation-harness.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const args = ['--run-root', '/old/runs/r1', '--task-root', '/new/task-packages/v2/accesssentinel', '--output-root', '/results/repair', '--source-evaluation', '/results/original'];

test('selected arguments require explicit original output and cases; fixed seed/clock cannot be overridden', () => {
  const options = parseSelectedOptions([...args, '--case', 'E-05', '--case', 'E-05', '--case', 'D-07', '--dry-run']);
  assert.deepEqual(options.caseIds, ['E-05', 'D-07']);
  assert.equal(options.dryRun, true);
  for (const extra of [[], ['--case', 'invalid'], ['--case', 'E-05', '--seed', 'a'.repeat(64)], ['--case', 'E-05', '--base-time', '2026-09-08T00:00:00.000Z'], ['--case', 'E-05', '--source-evaluation', '/other']]) assert.throws(() => parseSelectedOptions([...args, ...extra]));
});

function sourceFixture() {
  const request = { kind: 'frontal-evaluation-request', schemaVersion: 1, task: { id: 'accesssentinel', version: 'v2', digest: 'old-private-evaluator', contractDigest: 'public-contract' }, submission: { path: '/frozen', digest: 'frozen-digest' }, seed: 'a'.repeat(64) };
  const binding = { runRoot: '/old/runs/r1', statePath: '/old/runs/r1/private/state.json', sourceRuntime: '/old', taskRoot: '/old/task-packages/v2/accesssentinel', publicContractDigest: 'public-tree', publicRequirementsDigest: 'public-readme-tree', baseTime: '2026-09-08T00:00:00.000Z' };
  const cases = [{ id: 'A-01', status: 'failed' }, { id: 'E-05', status: 'evaluator_error' }];
  const result = authorValidationReport({ taskId: request.task.id, request, cases, totalCases: cases.length, complete: true });
  const source = { request, result, launch: { binding, caseIds: cases.map(item => item.id), mode: 'author-validation', formalEligible: false }, status: { status: 'completed' } };
  const expected = { request: { ...request, task: { ...request.task, digest: 'corrected-private-evaluator' } }, binding: { ...binding, taskRoot: '/new/task-packages/v2/accesssentinel' }, caseIds: source.launch.caseIds };
  return { source, expected };
}

test('complete source may contain author errors and use an older private evaluator, without merging or scoring', () => {
  const { source, expected } = sourceFixture(), before = structuredClone(source);
  validateSelectedSource(source, expected);
  assert.deepEqual(source, before);
  assert.equal(source.result.formalEligible, false);
  assert.equal(source.result.score, null);
});

test('source must be complete and match run, frozen code, public contract, requirements and seed', () => {
  const { source, expected } = sourceFixture();
  for (const mutate of [
    x => { x.status.status = 'running'; }, x => { x.result.complete = false; },
    x => { x.result.cases.pop(); }, x => { x.result.cases[1].id = 'A-01'; },
    x => { x.launch.caseIds = ['E-05']; }, x => { x.launch.sourceEvaluation = '/older-repair'; },
    x => { x.request.task.id = 'other'; }, x => { x.request.submission.digest = 'other'; },
    x => { x.result.task = { ...x.result.task, digest: 'other' }; }, x => { x.result.seed = 'b'.repeat(64); },
    x => { x.launch.binding.runRoot = '/other'; }, x => { x.launch.binding.publicContractDigest = 'other'; },
    x => { x.launch.binding.publicRequirementsDigest = 'other'; },
  ]) {
    const changed = structuredClone(source); mutate(changed);
    assert.throws(() => validateSelectedSource(changed, expected));
  }
});

test('selected dry-run binds a real frozen V2 run to its complete prior report and creates no output', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'frontal-selected-evaluation-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const id = 'accesssentinel', taskRoot = resolve(import.meta.dirname, '../task-packages/v2', id);
  const task = await loadTaskPackageV1(taskRoot), sourceRuntime = join(directory, 'old-runtime');
  const sourceTaskRoot = join(sourceRuntime, 'task-packages/v2', id);
  await cp(taskRoot, sourceTaskRoot, { recursive: true });
  const evaluatorEntry = join(sourceTaskRoot, 'evaluator/run.mjs');
  await writeFile(evaluatorEntry, `${await readFile(evaluatorEntry, 'utf8')}\n// Older private evaluator only.\n`);
  const sourceTask = await loadTaskPackageV1(sourceTaskRoot);
  const runRoot = join(sourceRuntime, 'runs/r1'), statePath = join(runRoot, 'projects', `01-${id}`, 'private/harness-state.json');
  await mkdir(join(runRoot, 'projects', `01-${id}`, 'private'), { recursive: true });
  const frozen = join(runRoot, 'frozen'); await mkdir(frozen); await writeFile(join(frozen, 'business.ts'), 'existing implementation');
  const submission = { path: frozen, digest: await digestTaskPackagePath(frozen) };
  const state = { schemaVersion: 1, kind: 'conversation-harness-run', runId: `r1-${id}`, ownerId: 'owner', agentDriverId: 'codex', taskId: id, status: 'awaiting_evaluation', phase: 'testing', taskDigest: sha(JSON.stringify(validateConversationTask(sourceTask.task))), planDigest: sourceTask.task.planDigest, submission, publicContractChecks: [{ passed: true, workspaceDigest: submission.digest }] };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(join(runRoot, 'experiment.json'), JSON.stringify({ benchmarkVersion: 2, runId: 'r1', ownerId: 'owner', taskIds: [id], packages: [{ id, packageDigest: sourceTask.digests.package, planDigest: sourceTask.task.planDigest }] }));
  const sourceEvaluation = join(directory, 'original'), outputRoot = join(directory, 'selected'); await mkdir(sourceEvaluation);
  const seed = 'c'.repeat(64), baseTime = '2026-09-03T01:02:03.000Z';
  const request = { kind: 'frontal-evaluation-request', schemaVersion: 1, operationId: 'original-evaluation', task: sourceTask.evaluator.task, submission, seed };
  const binding = { runRoot, statePath, sourceRuntime, taskRoot: sourceTaskRoot, publicContractDigest: await digestTaskPackagePath(join(sourceTaskRoot, 'public-contract')), publicRequirementsDigest: await digestTaskPackagePath(join(sourceTask.paths.workspace, 'docs/frontal-legacy')), baseTime };
  const manifest = JSON.parse(await readFile(join(taskRoot, 'evaluator/v2/manifest.v2.json'), 'utf8'));
  const caseIds = manifest.cases.map(item => item.id), cases = caseIds.map(id => ({ id, status: id === 'E-05' ? 'evaluator_error' : 'failed' }));
  const result = authorValidationReport({ taskId: id, request, cases, totalCases: cases.length, complete: true });
  for (const [name, data] of Object.entries({ request, result, launch: { binding, caseIds, mode: 'author-validation', formalEligible: false }, status: { status: 'completed' } })) await writeFile(join(sourceEvaluation, `${name}.json`), JSON.stringify(data));
  const sourceDigest = await digestTaskPackagePath(sourceEvaluation);
  const options = parseSelectedOptions(['--run-root', runRoot, '--task-root', taskRoot, '--output-root', outputRoot, '--source-evaluation', sourceEvaluation, '--case', 'E-05', '--dry-run']);
  const checked = await inspectSelectedEvaluation(options);
  assert.deepEqual(checked.caseIds, ['E-05']);
  assert.equal(checked.request.seed, seed); assert.equal(checked.binding.baseTime, undefined);
  assert.equal(checked.binding.clockPolicy, 'case-start-wall-clock-v1');
  assert.equal(checked.sourceClock, baseTime);
  assert.equal(checked.request.task.digest, task.digests.package);
  assert.notEqual(checked.request.task.digest, request.task.digest);
  assert.equal(checked.sourceResultSha256, sha(await readFile(join(sourceEvaluation, 'result.json'))));
  await assert.rejects(readFile(join(outputRoot, 'request.json')), { code: 'ENOENT' });
  assert.equal(await digestTaskPackagePath(sourceEvaluation), sourceDigest);
  assert.equal(await digestTaskPackagePath(frozen), submission.digest);
  await assert.rejects(inspectSelectedEvaluation({ ...options, outputRoot: join(sourceEvaluation, 'new') }), /overlap/);
  await assert.rejects(inspectSelectedEvaluation({ ...options, caseIds: ['UNKNOWN-01'] }), /known diagnostic case IDs/);
  await assert.rejects(inspectSelectedEvaluation({ ...options, caseIds: ['D-08'] }), /complete private evidence sequence/);
  await mkdir(outputRoot); await writeFile(join(outputRoot, 'keep.txt'), 'prior evidence');
  await assert.rejects(inspectSelectedEvaluation(options), /Partial evaluation directory retained/);
  assert.equal(await readFile(join(outputRoot, 'keep.txt'), 'utf8'), 'prior evidence');
});
