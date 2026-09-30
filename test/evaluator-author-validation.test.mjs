import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authorValidationReport, runV2EvaluatorProcess, selectAuthorValidationCases } from '../src/task-package-v2-evaluator.mjs';
import { digestTaskPackagePath, loadTaskPackageV1 } from '../src/task-package-v1.mjs';

test('author validation cannot emit formal scores, even if every case passes', () => {
  const request = { task: { id: 'example', digest: 'a'.repeat(64) }, submission: { digest: 'b'.repeat(64) }, seed: 'c'.repeat(64) };
  const result = authorValidationReport({ taskId: 'example', request, cases: [{ id: 'A-01', status: 'passed' }], totalCases: 1, complete: true });
  assert.equal(result.kind, 'frontal-v2-author-validation');
  assert.equal(result.formalEligible, false);
  assert.equal(result.score, null);
  assert.equal(result.rawScore, null);
  assert.equal(result.verdict, 'diagnostic');
  assert.equal(result.counts.passed, 1);
  assert.equal(result.submission.digest, request.submission.digest);
});

test('evaluator author faults are not counted as submitted business failures', () => {
  const result = authorValidationReport({ taskId: 'example', request: {}, cases: [{ id: 'A-01', status: 'evaluator_error' }], totalCases: 2, complete: false });
  assert.equal(result.counts.failed, 0);
  assert.equal(result.counts.evaluator_error, 1);
  assert.equal(result.completedCases, 1);
  assert.equal(result.complete, false);
});

test('formal is the default and still requires evaluator release before any execution', async () => {
  await assert.rejects(runV2EvaluatorProcess({ argv: ['--request', '/unused-request', '--result', '/unused-result'], taskRoot: '/nonexistent-author-test', repositoryRoot: '/unused' }), error => error.code === 'v2_evaluator_not_released');
  await assert.rejects(runV2EvaluatorProcess({ mode: 'force' }), /Unknown evaluator mode/);
  await assert.rejects(runV2EvaluatorProcess({ caseIds: ['A-01'] }), /diagnostic-only/);
});

test('selective repair preserves order, rejects unknown IDs and cannot fake closure evidence', () => {
  const cases = [{ id: 'A-01' }, { id: 'A-02' }, { id: 'D-08' }];
  assert.deepEqual(selectAuthorValidationCases(cases, ['A-02', 'A-01']), cases.slice(0, 2));
  assert.equal(selectAuthorValidationCases(cases), cases);
  for (const ids of [[], ['X-01'], ['A-01', 'A-01'], ['D-08']]) assert.throws(() => selectAuthorValidationCases(cases, ids));
  assert.deepEqual(selectAuthorValidationCases(cases, cases.map(c => c.id)), cases);
});

test('author run records setup failure, stops on unconfirmed cleanup and preserves the frozen input', async t => {
  const repositoryRoot = resolve(import.meta.dirname, '..'), taskRoot = join(repositoryRoot, 'task-packages/v2/configorbit');
  const directory = await mkdtemp(join(tmpdir(), 'frontal-author-execution-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const submissionPath = join(directory, 'frozen');
  await mkdir(submissionPath);
  await writeFile(join(submissionPath, 'untouched.txt'), 'frozen input\n');
  const submission = { path: submissionPath, digest: await digestTaskPackagePath(submissionPath) };
  const taskPackage = await loadTaskPackageV1(taskRoot);
  const requestPath = join(directory, 'request.json'), resultPath = join(directory, 'result.json');
  await writeFile(requestPath, JSON.stringify({ kind: 'frontal-evaluation-request', schemaVersion: 1, operationId: 'author-lifecycle-test', seed: 'a'.repeat(64), task: taskPackage.evaluator.task, submission }));
  let created = 0;
  const result = await runV2EvaluatorProcess({ mode: 'author-validation', repositoryRoot, taskRoot,
    argv: ['--request', requestPath, '--result', resultPath],
    runtimeFactory: () => ({ async createSession(options) {
      const sequence = ++created;
      assert.equal(options.mounts.find(item => item.target === '/submission').readonly, true);
      if (sequence === 1) throw new Error('test-only create failure');
      const caseRoot = options.mounts.find(item => item.target === '/results').source;
      return { async exec(command, args) {
        if (command === 'node') {
          const id = args[args.indexOf('--case') + 1];
          await writeFile(join(caseRoot, 'result.json'), JSON.stringify({ schemaVersion: 2, taskId: 'configorbit', cases: [{ id, status: 'passed', evidenceDigest: 'b'.repeat(64) }] }));
        }
      }, async close() { if (sequence === 2) throw new Error('test-only cleanup failure'); } };
    } }),
  });
  assert.equal(result.complete, false, 'do not run another case with unconfirmed container cleanup');
  assert.equal(result.completedCases, 2);
  assert.equal(created, 2);
  assert.equal(result.cases[1].privatePriorOutcome.status, 'passed');
  assert.equal(result.counts.evaluator_error, 2);
  assert.equal(result.counts.failed, 0);
  assert.equal(result.score, null);
  assert.equal(await digestTaskPackagePath(submissionPath), submission.digest);
  assert.deepEqual(JSON.parse(await readFile(resultPath)), result);
});

test('selective author repair executes only requested cases and never claims full-suite completion', async t => {
  const repositoryRoot = resolve(import.meta.dirname, '..'), taskRoot = join(repositoryRoot, 'task-packages/v2/configorbit');
  const directory = await mkdtemp(join(tmpdir(), 'frontal-author-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'frozen');
  await mkdir(source); await writeFile(join(source, 'unchanged.txt'), 'unchanged');
  const submission = { path: source, digest: await digestTaskPackagePath(source) };
  const taskPackage = await loadTaskPackageV1(taskRoot), seed = 'a'.repeat(64);
  const requestPath = join(directory, 'request.json'), resultPath = join(directory, 'result.json');
  await writeFile(requestPath, JSON.stringify({ kind: 'frontal-evaluation-request', schemaVersion: 1, operationId: 'selection-test', seed, task: taskPackage.evaluator.task, submission }));
  const executed = [];
  const commands = [];
  const result = await runV2EvaluatorProcess({ mode: 'author-validation', repositoryRoot, taskRoot, caseIds: ['RACE-02'],
    argv: ['--request', requestPath, '--result', resultPath],
    runtimeFactory: () => ({ async createSession(options) {
      assert.equal(options.mounts.find(item => item.target === '/submission').readonly, true);
      const caseRoot = options.mounts.find(item => item.target === '/results').source;
      return { async exec(command, args, options) {
        commands.push([command, args]);
        if (command === 'git') assert.equal(options.timeoutMs, null);
        if (command !== 'node') return;
        const id = args[args.indexOf('--case') + 1]; executed.push(id);
        assert.equal(args[args.indexOf('--seed') + 1], seed);
        assert.equal(args.includes('--base-time'), false);
        await writeFile(join(caseRoot, 'result.json'), JSON.stringify({ schemaVersion: 2, taskId: 'configorbit', cases: [{ id, status: 'passed' }] }));
      }, async close() {} };
    } }),
  });
  assert.deepEqual(executed, ['RACE-02']);
  assert.deepEqual(commands.slice(0, 3), [
    ['cp', ['-a', '/submission/.', '/workspace/']],
    ['chmod', ['-R', 'u+rwX', '/workspace']],
    ['git', ['init', '/workspace']],
  ], 'initialize only the isolated writable copy, before dependency/build/test execution');
  assert.equal(commands[3][0], 'node');
  assert.equal(commands[3][1][0], '/evaluator/run.mjs');
  assert.equal(result.complete, false); assert.equal(result.selectionComplete, true);
  assert.equal(result.totalCases, 22); assert.equal(result.completedCases, 1);
  assert.equal(result.formalEligible, false); assert.equal(result.score, null);
  assert.equal(await digestTaskPackagePath(source), submission.digest);
  assert.deepEqual(await readdir(source), ['unchanged.txt'], 'frozen source receives no .git or other environment files');
});
