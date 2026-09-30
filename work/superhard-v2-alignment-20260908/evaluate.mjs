// Per-run author validation: reuse a checked frozen submission, never call a model.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTaskPackageV1, digestTaskPackagePath } from '../../src/task-package-v1.mjs';
import { validateConversationTask } from '../../src/conversation-harness.mjs';
import { runV2EvaluatorProcess, validateV2EvaluatorLock } from '../../src/task-package-v2-evaluator.mjs';
import { verifyCompleted } from '../../scripts/evaluate-frozen-batch.mjs';
import { writeJsonAtomic } from '../../src/files.mjs';
import { capturedRuntimeFactory, evaluatorEnvironment } from './capture-evaluator-environment.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
const optionalJson = async path => {
  try { return await json(path); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
};
const within = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export function parseOptions(argv) {
  const names = { '--run-root': 'runRoot', '--task-root': 'taskRoot', '--output-root': 'outputRoot', '--seed': 'seed' };
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index], key = names[flag];
    if (flag === '--dry-run' && !options.dryRun) { options.dryRun = true; continue; }
    assert(key && options[key] === undefined && argv[index + 1] && !argv[index + 1].startsWith('--'), `Invalid argument: ${flag}`);
    options[key] = argv[++index];
  }
  for (const key of ['runRoot', 'taskRoot', 'outputRoot']) assert(isAbsolute(options[key] ?? ''), `${key} must be an explicit absolute path`);
  if (options.seed !== undefined) assert(/^[a-f0-9]{64}$/.test(options.seed), 'seed must be a lowercase SHA-256');
  return options;
}

export function validateFrozenBinding({ experiment, state, taskPackage, sourceTaskPackage, sourcePackageDigest, runRoot }) {
  const id = taskPackage.task.id;
  assert.equal(experiment.benchmarkVersion, 2, 'Not a V2 experiment');
  assert.equal(experiment.runId, basename(runRoot), 'Run directory differs from experiment identity');
  assert(experiment.taskIds?.includes(id), 'Task is not part of this experiment');
  const sourceIdentity = experiment.packages?.find(item => item.id === id);
  assert.equal(sourceIdentity?.packageDigest, sourcePackageDigest, 'Development package changed after launch');
  assert.equal(sourceIdentity?.planDigest, sourceTaskPackage.task.planDigest, 'Experiment Frozen Plan changed');
  assert.equal(state.schemaVersion, 1, 'Unsupported conversation state');
  assert.equal(state.kind, 'conversation-harness-run', 'Not a conversation state');
  assert.equal(state.runId, `${experiment.runId}-${id}`, 'State belongs to a different run');
  assert.equal(state.ownerId, experiment.ownerId, 'State owner differs from experiment');
  assert.equal(state.agentDriverId, 'codex', 'Not a Codex continuation');
  assert.equal(state.taskId, id, 'State task identity differs');
  assert.equal(state.status, 'awaiting_evaluation', 'Run has no frozen V2 delivery awaiting evaluation');
  assert.equal(state.phase, 'testing', 'Run is not at the evaluation boundary');
  assert.equal(state.taskDigest, sha(JSON.stringify(validateConversationTask(sourceTaskPackage.task))), 'Development task changed since coding');
  assert.equal(state.planDigest, sourceTaskPackage.task.planDigest, 'Development Frozen Plan changed');
  // The task metadata also embeds the entire package/evaluator hash. Evaluator-only
  // fixes legitimately change those hashes, not the public task that the agent saw.
  for (const field of ['schemaVersion', 'id', 'readme', 'executionPlan', 'planDigest']) {
    assert.deepEqual(taskPackage.task[field], sourceTaskPackage.task[field], `Public task ${field} changed since coding`);
  }
  for (const field of ['taskVersion', 'environment', 'contractDigest', 'scenarioDigest']) {
    assert.deepEqual(taskPackage.task.metadata?.[field], sourceTaskPackage.task.metadata?.[field], `Public task ${field} changed since coding`);
  }
  assert.equal(state.publicContractChecks?.at(-1)?.passed, true, 'Latest public integration check did not pass');
  assert(isAbsolute(state.submission?.path ?? ''), 'Frozen submission path must be absolute');
  assert(/^[a-f0-9]{64}$/.test(state.submission?.digest ?? ''), 'Missing frozen submission digest');
  assert.equal(state.publicContractChecks.at(-1).workspaceDigest, state.submission.digest, 'Public gate did not check this frozen submission');
}

export function verifyReuse({ result, request, launch, status }, expected) {
  assert.equal(status?.status, 'completed', 'Partial evaluation directory retained; automatic partial resume is not supported');
  assert.deepEqual(request, expected.request, 'Existing evaluation request differs (package, submission, seed or operation)');
  assert.deepEqual(launch?.binding, expected.binding, 'Existing evaluation source or fixed clock differs');
  assert.equal(result?.seed, expected.request.seed, 'Existing result seed differs');
  assert.deepEqual(result?.task, expected.request.task, 'Existing result package identity differs');
  assert.deepEqual(result?.submission, expected.request.submission, 'Existing result submission differs');
  return verifyCompleted(result, { taskId: expected.request.task.id, task: expected.request.task, submission: expected.request.submission }, expected.caseIds);
}

export async function inspectEvaluation(options) {
  const runRoot = await realpath(options.runRoot), taskRoot = await realpath(options.taskRoot);
  // V2 deployments retain run and package provenance in the existing runtime layout.
  assert.equal(basename(dirname(runRoot)), 'runs', 'Expected a deployed runtime/runs/run-id');
  assert.equal(basename(dirname(taskRoot)), 'v2', 'Expected a deployed task-packages/v2/task-id');
  const repositoryRoot = resolve(taskRoot, '../../..');
  assert.equal(dirname(taskRoot), join(repositoryRoot, 'task-packages/v2'), 'Invalid deployed task package root');
  assert.equal(repositoryRoot, await realpath(resolve(import.meta.dirname, '../..')), 'Use the evaluator entry from the same deployed runtime as taskRoot');
  const sourceRuntime = resolve(runRoot, '../..'), id = basename(taskRoot);
  const experiment = await json(join(runRoot, 'experiment.json'));
  const index = experiment.taskIds?.indexOf(id);
  assert(index >= 0, 'Task is not present in run');
  const statePath = join(runRoot, 'projects', `${String(index + 1).padStart(2, '0')}-${id}`, 'private/harness-state.json');
  const state = await json(statePath), taskPackage = await loadTaskPackageV1(taskRoot);
  const sourceTaskRoot = join(sourceRuntime, 'task-packages/v2', id);
  const sourceTaskPackage = await loadTaskPackageV1(sourceTaskRoot);
  validateFrozenBinding({ experiment, state, taskPackage, sourceTaskPackage, sourcePackageDigest: sourceTaskPackage.digests.package, runRoot });
  const publicContractDigest = await digestTaskPackagePath(join(taskRoot, 'public-contract'));
  assert.equal(publicContractDigest, await digestTaskPackagePath(join(sourceTaskRoot, 'public-contract')), 'Public contract/checker changed since coding');
  const publicRequirementsDigest = await digestTaskPackagePath(join(taskPackage.paths.workspace, 'docs/frontal-legacy'));
  assert.equal(publicRequirementsDigest, await digestTaskPackagePath(join(sourceTaskPackage.paths.workspace, 'docs/frontal-legacy')), 'Public legacy requirement documents changed since coding');
  const marker = await json(join(taskRoot, 'contract-first.json'));
  assert.equal(marker.kind, 'frontal-contract-first-package');
  assert.equal(marker.benchmarkVersion, 2);
  assert.equal(marker.taskId, id);
  assert.equal(marker.publicContractDigest, sha(await readFile(join(taskRoot, 'public-contract/contract.json'))));
  await validateV2EvaluatorLock(join(taskRoot, 'evaluator/runtime-lock.json'), { repositoryRoot });
  const submissionPath = await realpath(state.submission.path);
  assert.equal(submissionPath, state.submission.path, 'Submission must be a resolved frozen directory');
  assert((await lstat(submissionPath)).isDirectory(), 'Frozen submission is not a directory');
  assert.equal(await digestTaskPackagePath(submissionPath), state.submission.digest, 'Frozen submission changed after public gate');
  const outputRoot = resolve(options.outputRoot);
  assert(!within(runRoot, outputRoot) && !within(taskRoot, outputRoot) && !within(submissionPath, outputRoot), 'Evaluation output must be outside the run, submission and task package');
  // Resolve the nearest existing ancestor so a symlink cannot redirect writes into a submission.
  let ancestor = outputRoot;
  while (true) {
    try {
      const actual = await realpath(ancestor);
      assert.equal(actual, ancestor, 'Output path must not traverse symlinks');
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = dirname(ancestor); }
  }
  const manifest = await json(join(taskRoot, 'evaluator/v2/manifest.v2.json'));
  const caseIds = manifest.cases.map(item => item.id);
  assert.equal(new Set(caseIds).size, caseIds.length, 'Duplicate evaluator cases');
  const request = { kind: 'frontal-evaluation-request', schemaVersion: 1,
    operationId: `v2-${id}-${sha(outputRoot).slice(0, 16)}`,
    seed: options.seed ?? sha(`superhard-v2-author-validation:${id}:${publicContractDigest}`),
    task: taskPackage.evaluator.task, submission: { path: submissionPath, digest: state.submission.digest } };
  const binding = { runRoot, statePath, sourceRuntime, taskRoot, publicContractDigest, publicRequirementsDigest, clockPolicy: 'case-start-wall-clock-v1' };
  let previous = null;
  try {
    await lstat(outputRoot);
    previous = verifyReuse({ result: await optionalJson(join(outputRoot, 'result.json')),
      request: await optionalJson(join(outputRoot, 'request.json')), launch: await optionalJson(join(outputRoot, 'launch.json')),
      status: await optionalJson(join(outputRoot, 'status.json')) }, { request, binding, caseIds });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { repositoryRoot, outputRoot, taskRoot, request, binding, caseIds, previous };
}

export async function main(argv) {
  const options = parseOptions(argv), checked = await inspectEvaluation(options);
  const { repositoryRoot, outputRoot, taskRoot, request, binding, caseIds, previous } = checked;
  if (options.dryRun || previous) {
    console.log(JSON.stringify({ action: previous ? 'reuse_completed' : 'dry_run_validated', runRoot: binding.runRoot,
      outputRoot, taskId: request.task.id, cases: caseIds.length, formalEligible: false, counts: previous?.counts, environment: evaluatorEnvironment }));
    return;
  }
  assert(process.platform === 'linux' && process.arch === 'x64', 'Execute hidden evaluation only on native Linux AMD64');
  await mkdir(dirname(outputRoot), { recursive: true, mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 }); // Exclusive claim: no overwrite or duplicate concurrent evaluator.
  await writeJsonAtomic(join(outputRoot, 'request.json'), request);
  await writeJsonAtomic(join(outputRoot, 'launch.json'), { binding, caseIds, environment: evaluatorEnvironment, mode: 'author-validation', formalEligible: false, startedAt: new Date().toISOString() });
  await writeJsonAtomic(join(outputRoot, 'status.json'), { status: 'running', pid: process.pid, startedAt: new Date().toISOString() });
  process.env.FRONTAL_OCI_COMMAND = join(repositoryRoot, 'scripts/docker-native-amd64-evaluator.mjs');
  try {
    const result = await runV2EvaluatorProcess({ mode: 'author-validation', repositoryRoot, taskRoot, runtimeFactory: capturedRuntimeFactory,
      argv: ['--request', join(outputRoot, 'request.json'), '--result', join(outputRoot, 'result.json')] });
    verifyCompleted(result, { taskId: request.task.id, task: request.task, submission: request.submission }, caseIds);
    await writeJsonAtomic(join(outputRoot, 'status.json'), { status: 'completed', counts: result.counts, completedAt: new Date().toISOString(), formalEligible: false });
    console.log(JSON.stringify({ action: 'completed', taskId: request.task.id, outputRoot, counts: result.counts, formalEligible: false }));
  } catch (error) {
    await writeJsonAtomic(join(outputRoot, 'status.json'), { status: 'evaluator_error', code: error.code, message: error.message, stoppedAt: new Date().toISOString() });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
