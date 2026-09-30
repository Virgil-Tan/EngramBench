// Independent author-only repair. Never mutate or merge the original evaluation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOptions, inspectEvaluation } from './evaluate.mjs';
import { runV2EvaluatorProcess, selectAuthorValidationCases } from '../../src/task-package-v2-evaluator.mjs';
import { verifyCompleted } from '../../scripts/evaluate-frozen-batch.mjs';
import { writeJsonAtomic } from '../../src/files.mjs';
import { capturedRuntimeFactory, evaluatorEnvironment } from './capture-evaluator-environment.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const within = (parent, child) => {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};

export function parseSelectedOptions(argv) {
  const forwarded = [], cases = [];
  let sourceEvaluation;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    assert(!['--seed', '--base-time'].includes(flag), 'Selected evaluation inherits its seed; absolute clock overrides are forbidden');
    if (flag === '--source-evaluation' || flag === '--case') {
      const value = argv[++index];
      assert(value && !value.startsWith('--'), `Missing value for ${flag}`);
      if (flag === '--source-evaluation') {
        assert.equal(sourceEvaluation, undefined, 'Repeated source evaluation');
        sourceEvaluation = value;
      } else {
        assert(/^[A-Z][A-Z0-9]*-[0-9]{2}$/.test(value), 'Invalid selected case ID');
        cases.push(value);
      }
    } else forwarded.push(flag);
  }
  assert(isAbsolute(sourceEvaluation ?? ''), 'sourceEvaluation must be an explicit absolute path');
  assert(cases.length, 'At least one --case is required');
  return { ...parseOptions(forwarded), sourceEvaluation, caseIds: [...new Set(cases)] };
}

export function validateSelectedSource(source, expected) {
  const { request, result, launch, status } = source;
  assert.equal(status?.status, 'completed', 'Source evaluation must have completed');
  assert.equal(request?.kind, 'frontal-evaluation-request');
  assert.equal(request?.schemaVersion, 1);
  assert.equal(launch?.mode, 'author-validation');
  assert.equal(launch?.formalEligible, false);
  assert.equal(launch?.sourceEvaluation, undefined, 'Source must be a full original evaluation, not another selected repair');
  assert.deepEqual(launch?.caseIds, expected.caseIds, 'Source launch must contain the complete case inventory');
  assert.equal(request.task?.id, expected.request.task.id, 'Source task differs');
  for (const field of ['version', 'contractDigest']) assert.equal(request.task?.[field], expected.request.task[field], `Source task ${field} differs`);
  assert.deepEqual(request.submission, expected.request.submission, 'Source frozen submission differs');
  assert.equal(request.seed, expected.request.seed, 'Source seed differs');
  assert.equal(result?.seed, request.seed, 'Source result seed differs');
  assert.deepEqual(result?.task, request.task, 'Source result package identity differs');
  assert.deepEqual(result?.submission, request.submission, 'Source result submission identity differs');
  for (const field of ['runRoot', 'statePath', 'sourceRuntime', 'publicContractDigest', 'publicRequirementsDigest']) {
    assert.equal(launch?.binding?.[field], expected.binding[field], `Source binding ${field} differs`);
  }
  // The source's private evaluator may be the broken version. Its public task,
  // full inventory and frozen input must still match the corrected evaluator.
  verifyCompleted(result, { taskId: request.task.id, task: request.task, submission: request.submission }, expected.caseIds);
}

export async function inspectSelectedEvaluation(options) {
  const sourceEvaluation = await realpath(options.sourceEvaluation);
  const read = async name => JSON.parse(await readFile(join(sourceEvaluation, name), 'utf8'));
  const resultBytes = await readFile(join(sourceEvaluation, 'result.json'));
  const source = { result: JSON.parse(resultBytes), request: await read('request.json'), launch: await read('launch.json'), status: await read('status.json') };
  const seed = source.request?.seed;
  assert(/^[a-f0-9]{64}$/.test(seed ?? ''), 'Source requires a valid fixed seed');
  const outputRoot = resolve(options.outputRoot);
  assert(!within(sourceEvaluation, outputRoot) && !within(outputRoot, sourceEvaluation), 'New output must not overlap the original evaluation');
  const checked = await inspectEvaluation({ ...options, seed });
  assert.equal(checked.previous, null, 'Selected evaluation requires a new exclusive output directory');
  validateSelectedSource(source, checked);
  const caseIds = selectAuthorValidationCases(checked.caseIds.map(id => ({ id })), options.caseIds).map(item => item.id);
  return { ...checked, caseIds, sourceEvaluation, sourceResultSha256: sha(resultBytes), sourceClock: source.launch.binding.clockPolicy ?? source.launch.binding.baseTime };
}

export async function main(argv) {
  const options = parseSelectedOptions(argv), checked = await inspectSelectedEvaluation(options);
  const { repositoryRoot, taskRoot, outputRoot, request, binding, caseIds, sourceEvaluation, sourceResultSha256, sourceClock } = checked;
  if (options.dryRun) {
    console.log(JSON.stringify({ action: 'selected_dry_run_validated', taskId: request.task.id, outputRoot, sourceEvaluation, caseIds, seed: request.seed, clockPolicy: binding.clockPolicy, sourceClock, formalEligible: false, environment: evaluatorEnvironment }));
    return;
  }
  assert(process.platform === 'linux' && process.arch === 'x64', 'Execute hidden evaluation only on native Linux AMD64');
  await mkdir(dirname(outputRoot), { recursive: true, mode: 0o700 });
  await mkdir(outputRoot, { mode: 0o700 });
  await writeJsonAtomic(join(outputRoot, 'request.json'), request);
  await writeJsonAtomic(join(outputRoot, 'launch.json'), { binding, sourceEvaluation, sourceResultSha256, sourceClock, caseIds, environment: evaluatorEnvironment, mode: 'author-validation', formalEligible: false, selectionOnly: true, startedAt: new Date().toISOString() });
  await writeJsonAtomic(join(outputRoot, 'status.json'), { status: 'running', pid: process.pid, caseIds, selectionOnly: true, startedAt: new Date().toISOString() });
  process.env.FRONTAL_OCI_COMMAND = join(repositoryRoot, 'scripts/docker-native-amd64-evaluator.mjs');
  try {
    const result = await runV2EvaluatorProcess({ mode: 'author-validation', repositoryRoot, taskRoot, caseIds,
      argv: ['--request', join(outputRoot, 'request.json'), '--result', join(outputRoot, 'result.json')],
      runtimeFactory: capturedRuntimeFactory });
    verifyCompleted(result, { taskId: request.task.id, task: request.task, submission: request.submission, repairOf: sourceEvaluation }, caseIds);
    await writeJsonAtomic(join(outputRoot, 'status.json'), { status: 'completed', caseIds, counts: result.counts, selectionComplete: true, selectionOnly: true, formalEligible: false, completedAt: new Date().toISOString() });
    console.log(JSON.stringify({ action: 'selected_completed', taskId: request.task.id, outputRoot, caseIds, counts: result.counts, selectionComplete: true, formalEligible: false }));
  } catch (error) {
    await writeJsonAtomic(join(outputRoot, 'status.json'), { status: 'evaluator_error', code: error.code, message: error.message, selectionOnly: true, stoppedAt: new Date().toISOString() });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
