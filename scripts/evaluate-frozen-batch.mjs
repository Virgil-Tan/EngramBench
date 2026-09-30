#!/usr/bin/env node
// One batch, existing frozen submissions only. No model calls or source edits.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTaskPackageV1, digestTaskPackagePath } from '../src/task-package-v1.mjs';
import { runV2EvaluatorProcess, validateV2EvaluatorLock } from '../src/task-package-v2-evaluator.mjs';
import { writeJsonAtomic } from '../src/files.mjs';

const root = resolve(import.meta.dirname, '..');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const optionalJson = async path => {
  try { return await json(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export function validateBatch(config, allowed) {
  if (config.kind !== 'frontal-frozen-evaluation-batch' || config.schemaVersion !== 1
    || !/^[a-z0-9][a-z0-9-]{0,100}$/.test(config.id) || config.mode !== 'author-validation'
    || Object.hasOwn(config, 'baseTime') || !Array.isArray(config.tasks) || !config.tasks.length) {
    throw new Error('Invalid explicit author-validation batch configuration');
  }
  const seen = new Set();
  for (const task of config.tasks) {
    if (!allowed.includes(task.id) || seen.has(task.id) || !isAbsolute(task.statePath)
      || !isAbsolute(task.sourceRuntime) || (task.reuseDirectory && !isAbsolute(task.reuseDirectory))
      || (task.repairDirectory && (!isAbsolute(task.repairDirectory) || task.reuseDirectory))
      || (task.caseIds && (!task.repairDirectory || !Array.isArray(task.caseIds) || !task.caseIds.length
        || new Set(task.caseIds).size !== task.caseIds.length))) {
      throw new Error(`Invalid or repeated task: ${task.id}`);
    }
    seen.add(task.id);
  }
  return config;
}

export function verifyCompleted(result, metadata, caseIds) {
  const selection = Boolean(metadata.repairOf);
  if (result?.kind !== 'frontal-v2-author-validation' || result.taskId !== metadata.taskId
    || (selection ? result.selectionComplete !== true : result.complete !== true)
    || result.formalEligible !== false || result.score !== null || result.rawScore !== null
    || result.submission?.digest !== metadata.submission.digest || result.task?.digest !== metadata.task.digest
    || result.completedCases !== caseIds.length || (!selection && result.totalCases !== caseIds.length)
    || (selection && JSON.stringify(result.selectedCaseIds) !== JSON.stringify(caseIds))
    || !Array.isArray(result.cases) || result.cases.length !== caseIds.length
    || new Set(result.cases.map(item => item.id)).size !== caseIds.length
    || result.cases.some(item => !caseIds.includes(item.id))) throw new Error('Completed result identity or case coverage mismatch');
  return result;
}

async function snapshot(config) {
  const rows = await Promise.all(config.tasks.map(async task => {
    const directory = task.reuseDirectory ?? join(root, 'hidden-results', config.id, task.id);
    const status = await optionalJson(join(directory, 'status.json'));
    const result = await optionalJson(join(directory, 'result.json'));
    let pidAlive = false;
    if (status?.pid) { try { process.kill(status.pid, 0); pidAlive = true; } catch {} }
    return { taskId: task.id, directory, reused: Boolean(task.reuseDirectory), status: status?.status ?? 'not_started',
      pid: status?.pid, pidAlive, complete: result?.complete === true || result?.selectionComplete === true,
      completedCases: result?.completedCases ?? 0, totalCases: result?.totalCases ?? null,
      counts: result?.counts, failure: status?.message };
  }));
  return { batchId: config.id, mode: config.mode, formalEligible: false, score: null, rawScore: null,
    updatedAt: new Date().toISOString(), totalTasks: rows.length,
    completedTasks: rows.filter(row => row.status === 'completed' && row.complete).length, tasks: rows };
}

async function worker(config, taskId) {
  const task = config.tasks.find(task => task.id === taskId);
  if (!task || task.reuseDirectory) throw new Error('Worker cannot execute a reused or unknown task');
  const directory = join(root, 'hidden-results', config.id, taskId);
  const metadata = await json(join(directory, 'launch.json'));
  await writeJsonAtomic(join(directory, 'status.json'), { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const result = await runV2EvaluatorProcess({ mode: config.mode, repositoryRoot: root,
      taskRoot: join(root, 'task-packages/v2', taskId),
      argv: ['--request', join(directory, 'request.json'), '--result', join(directory, 'result.json')],
      ...(metadata.repairOf && { caseIds: metadata.caseIds }) });
    verifyCompleted(result, metadata, metadata.caseIds);
    await writeJsonAtomic(join(directory, 'status.json'), {
      status: 'completed', completedAt: new Date().toISOString(), counts: result.counts, formalEligible: false,
    });
  } catch (error) {
    await writeJsonAtomic(join(directory, 'status.json'), {
      status: 'evaluator_error', stoppedAt: new Date().toISOString(), code: error.code, message: error.message,
    });
    throw error;
  }
}

async function startTask(config, configPath, task) {
  const state = await json(task.statePath), submission = state.submission;
  if (state.taskId !== task.id || state.status !== 'awaiting_evaluation'
    || !state.publicContractChecks?.at(-1)?.passed || !submission?.path
    || state.publicContractChecks.at(-1).workspaceDigest !== submission.digest) throw new Error('No public-checked frozen submission');
  if (await digestTaskPackagePath(submission.path) !== submission.digest) throw new Error('Frozen submission digest mismatch');
  const taskRoot = join(root, 'task-packages/v2', task.id);
  const publicContractDigest = await digestTaskPackagePath(join(taskRoot, 'public-contract'));
  if (publicContractDigest !== await digestTaskPackagePath(join(task.sourceRuntime, 'task-packages/v2', task.id, 'public-contract'))) {
    throw new Error('Public contract changed since coding');
  }
  await validateV2EvaluatorLock(join(taskRoot, 'evaluator/runtime-lock.json'), { repositoryRoot: root });
  const taskPackage = await loadTaskPackageV1(taskRoot);
  const manifest = await json(join(taskRoot, 'evaluator/v2/manifest.v2.json'));
  const metadata = { taskId: task.id, statePath: task.statePath, submission, publicContractDigest,
    task: taskPackage.evaluator.task, caseIds: manifest.cases.map(item => item.id),
    clockPolicy: 'case-start-wall-clock-v1', mode: config.mode, formalEligible: false };
  let seed = sha(`${config.id}:${task.id}`);
  if (task.repairDirectory) {
    const oldRequest = await json(join(task.repairDirectory, 'request.json'));
    const oldResultBytes = await readFile(join(task.repairDirectory, 'result.json'));
    const oldResult = JSON.parse(oldResultBytes), oldLaunch = await json(join(task.repairDirectory, 'launch.json'));
    if (!oldResult.complete || oldResult.taskId !== task.id || oldRequest.task.id !== task.id
      || oldResult.submission.digest !== submission.digest || oldRequest.submission.digest !== submission.digest
      || oldLaunch.publicContractDigest !== publicContractDigest
      || oldRequest.task.contractDigest !== metadata.task.contractDigest || oldResult.seed !== oldRequest.seed) {
      throw new Error('Repair must preserve original frozen submission, public contract and seed');
    }
    const selected = task.caseIds ?? oldResult.cases.filter(item => item.status === 'evaluator_error').map(item => item.id);
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !metadata.caseIds.includes(id))) throw new Error('No unique known repair cases');
    metadata.caseIds = metadata.caseIds.filter(id => selected.includes(id));
    metadata.repairOf = { directory: task.repairDirectory, resultDigest: sha(oldResultBytes),
      task: oldRequest.task, seed: oldRequest.seed, caseIds: metadata.caseIds,
      sourceClock: oldLaunch.clockPolicy ?? oldLaunch.baseTime };
    seed = oldRequest.seed;
  }
  const directory = task.reuseDirectory ?? join(root, 'hidden-results', config.id, task.id);
  const previous = await optionalJson(join(directory, 'result.json'));
  if (previous?.complete === true || previous?.selectionComplete === true) {
    verifyCompleted(previous, metadata, metadata.caseIds);
    const original = await json(join(directory, 'launch.json'));
    if (original.clockPolicy !== metadata.clockPolicy || original.publicContractDigest !== publicContractDigest) throw new Error('Existing evaluation environment differs');
    console.log(JSON.stringify({ taskId: task.id, action: 'reuse_completed', directory }));
    return { taskId: task.id, action: 'reuse_completed', directory };
  }
  if (task.reuseDirectory) throw new Error('Expected preserved completed result is missing');
  // Never overwrite partial cases or implicitly retry a live/aborted evaluation.
  await mkdir(directory, { mode: 0o700 });
  const request = { kind: 'frontal-evaluation-request', schemaVersion: 1,
    operationId: `${config.id}-${task.id}`, seed,
    task: metadata.task, submission: { path: submission.path, digest: submission.digest } };
  await writeJsonAtomic(join(directory, 'request.json'), request);
  await writeJsonAtomic(join(directory, 'launch.json'), { ...metadata, startedAt: new Date().toISOString() });
  const log = await open(join(directory, 'runner.log'), 'wx', 0o600);
  try {
    const child = spawn(process.execPath, [import.meta.filename, configPath, '--worker', task.id], {
      cwd: root, stdio: ['ignore', log.fd, log.fd],
      env: { ...process.env,
        FRONTAL_EVALUATION_BATCH_ID: config.id, FRONTAL_EVALUATION_TASK_ID: task.id,
        FRONTAL_RUN_ID: `${config.id}-${task.id}`,
        FRONTAL_OCI_COMMAND: join(root, 'scripts/docker-native-amd64-evaluator.mjs') },
    });
    const completion = new Promise(resolve => {
      child.once('error', error => resolve({ taskId: task.id, error: error.message }));
      child.once('exit', (code, signal) => resolve({ taskId: task.id, exitCode: code, signal }));
    });
    await new Promise((done, fail) => { child.once('spawn', done); child.once('error', fail); });
    await writeJsonAtomic(join(directory, 'runner.json'), { pid: child.pid, startedAt: new Date().toISOString() });
    console.log(JSON.stringify({ taskId: task.id, action: 'started', pid: child.pid, directory }));
    return { taskId: task.id, pid: child.pid, completion };
  } finally { await log.close(); }
}

async function main() {
  const [input, action = '--run', taskId] = process.argv.slice(2);
  if (!input || !['--run', '--status', '--worker'].includes(action)) throw new Error('Usage: evaluate-frozen-batch.mjs CONFIG [--run|--status|--worker TASK]');
  const configPath = resolve(input);
  const config = validateBatch(await json(configPath), (await json(join(root, 'learning-tasks.json'))).tasks);
  if (action === '--status') { console.log(JSON.stringify(await snapshot(config), null, 2)); return; }
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Use the native Linux AMD64 server');
  if (action === '--worker') { await worker(config, taskId); return; }
  const batchRoot = join(root, 'hidden-results', config.id);
  await mkdir(batchRoot, { recursive: true });
  const identityPath = join(batchRoot, 'batch.json');
  const previous = await optionalJson(identityPath);
  if (previous && JSON.stringify(previous) !== JSON.stringify(config)) throw new Error('Batch ID already binds different inputs');
  if (!previous) await writeJsonAtomic(identityPath, config);
  const launched = [], errors = [];
  // Sequential preparation, concurrent workers: one broken task does not cancel siblings.
  for (const task of config.tasks) {
    try { launched.push(await startTask(config, configPath, task)); }
    catch (error) { errors.push({ taskId: task.id, error: error.message }); console.error(JSON.stringify(errors.at(-1))); }
  }
  await writeJsonAtomic(join(batchRoot, 'launch-summary.json'), {
    startedAt: new Date().toISOString(), tasks: launched.map(({ completion, ...row }) => row), errors,
  });
  await Promise.all(launched.filter(row => row.completion).map(async row => {
    const exit = await row.completion;
    console.log(JSON.stringify(exit));
  }));
  const result = await snapshot(config);
  await writeJsonAtomic(join(batchRoot, 'summary.json'), { ...result, launchErrors: errors });
  console.log(JSON.stringify({ batchId: config.id, completed: result.completedTasks, total: result.totalTasks, errors }));
  if (errors.length || result.completedTasks !== result.totalTasks) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
