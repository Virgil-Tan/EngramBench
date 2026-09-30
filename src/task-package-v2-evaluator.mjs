import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { BenchError } from "./errors.mjs";
import { assertEvaluatorReleased } from './evaluator-release.mjs';
import { hashEnvironmentContext, loadEnvironmentCatalog } from "./environments.mjs";
import { writeJsonAtomic } from "./files.mjs";
import { OciRuntime } from "./oci.mjs";
import {
  createMissingV1CheckpointOutcome,
  createPriorCaseState,
  parsePrivateCaseState,
  parsePriorCaseState,
  PRIOR_CASE_STATE_ENV,
  PRIVATE_CASE_STATE_ENV,
  requiresV1Checkpoint,
} from "./task-evaluator-v2/execution.mjs";
import {
  PREPARE_CANDIDATE_ENV,
  serializeTaskRuntimeDefaults,
  TASK_RUNTIME_DEFAULTS_ENV,
} from "./task-evaluator-v2/runtime.mjs";
import { digestTaskPackagePath } from "./task-package-v1.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const CASE_ID = /^[A-Z][A-Z0-9]*-[0-9]{2}$/u;
export const V2_RUNTIME_FILES = Object.freeze([
  "src/task-package-v2-evaluator.mjs",
  "src/task-evaluator-v2/runtime.mjs",
  "src/task-evaluator-v2/execution.mjs",
  "src/task-evaluator-v2/scoring.mjs",
  "src/task-evaluator-v2/public-contract.mjs",
  "src/task-evaluator-v2/browser.mjs",
  "templates/contract-first/runtime.mjs",
  "templates/contract-first/seed-reader.mjs",
  "templates/contract-first/identitymesh-provider.mjs",
  "src/evaluator-release.mjs",
  "src/task-package-v1.mjs",
  "src/oci.mjs",
  "src/environments.mjs",
  "src/process.mjs",
  "src/files.mjs",
  "src/errors.mjs",
  "environments/catalog.v1.json",
  "package.json",
  "package-lock.json",
]);

export async function validateV2EvaluatorLock(lockPath, { repositoryRoot: configuredRepositoryRoot } = {}) {
  const absoluteLock = resolve(lockPath);
  const taskRoot = resolve(dirname(absoluteLock), "..");
  const repositoryRoot = resolve(configuredRepositoryRoot ?? join(dirname(absoluteLock), "../../../.."));
  const lock = await readJson(absoluteLock, "v2 evaluator lock");
  exactKeys(lock, [
    "kind", "schemaVersion", "taskId", "sourceManifest", "sourceDigest", "evaluatorDigest",
    "runtimeFiles", "phase", "setup", "runtimeEnv", "snapshotExcludes",
  ], "v2 evaluator lock");
  if (lock.kind !== "frontal-v2-evaluator-lock" || lock.schemaVersion !== 1) {
    throw failure("v2_evaluator_lock_invalid", "v2 evaluator lock kind/schemaVersion is unsupported");
  }
  nonEmpty(lock.taskId, "v2 evaluator lock.taskId");
  sha(lock.sourceDigest, "v2 evaluator lock.sourceDigest");
  sha(lock.evaluatorDigest, "v2 evaluator lock.evaluatorDigest");
  if (!new Set(["learning", "transfer"]).has(lock.phase)) throw failure("v2_evaluator_lock_invalid", "v2 evaluator lock phase is invalid");
  if (!Array.isArray(lock.setup) || !Array.isArray(lock.snapshotExcludes)
    || !lock.runtimeEnv || typeof lock.runtimeEnv !== "object" || Array.isArray(lock.runtimeEnv)) {
    throw failure("v2_evaluator_lock_invalid", "v2 evaluator lock runtime metadata is invalid");
  }
  try {
    serializeTaskRuntimeDefaults(lock.runtimeEnv);
  } catch (error) {
    throw failure("v2_evaluator_lock_invalid", `v2 evaluator lock runtimeEnv is invalid: ${error.message}`, error);
  }
  const sourceManifest = resolveInside(repositoryRoot, lock.sourceManifest, "v2 source manifest");
  if (sha256(await readFile(sourceManifest)) !== lock.sourceDigest) throw failure("v2_evaluator_lock_mismatch", "v2 source manifest digest does not match");
  if (await digestTaskPackagePath(join(taskRoot, "evaluator", "v2")) !== lock.evaluatorDigest) {
    throw failure("v2_evaluator_lock_mismatch", "task-local v2 evaluator digest does not match");
  }
  if (!Array.isArray(lock.runtimeFiles)
    || lock.runtimeFiles.length !== V2_RUNTIME_FILES.length
    || lock.runtimeFiles.some(({ path }, index) => path !== V2_RUNTIME_FILES[index])) {
    throw failure("v2_evaluator_lock_invalid", "v2 evaluator runtime inventory is invalid");
  }
  for (const item of lock.runtimeFiles) {
    exactKeys(item, ["path", "digest"], "v2 evaluator runtime file");
    sha(item.digest, `v2 evaluator runtime file ${item.path}`);
    const path = resolveInside(repositoryRoot, item.path, "v2 evaluator runtime file");
    const actual = (await lstat(path)).isDirectory() ? await digestTaskPackagePath(path) : sha256(await readFile(path));
    if (actual !== item.digest) throw failure("v2_evaluator_lock_mismatch", `v2 evaluator runtime file changed: ${item.path}`);
  }
  const source = await readJson(sourceManifest, "v2 source manifest");
  if (source.id !== lock.taskId || source.phase !== lock.phase
    || JSON.stringify(source.setup ?? []) !== JSON.stringify(lock.setup)
    || JSON.stringify(source.runtimeEnv ?? {}) !== JSON.stringify(lock.runtimeEnv)
    || JSON.stringify(source.snapshotExcludes ?? []) !== JSON.stringify(lock.snapshotExcludes)) {
    throw failure("v2_evaluator_lock_mismatch", "v2 evaluator lock does not match its source manifest");
  }
  return { lock, source, sourceManifest, repositoryRoot };
}

/** Adapt one task-local v2 evaluator to the Task Package v1 process protocol. */
export async function runV2EvaluatorProcess({
  argv,
  taskRoot: configuredTaskRoot,
  repositoryRoot: configuredRepositoryRoot,
  runtimeFactory = ({ command, runRoot }) => new OciRuntime({ command, runRoot }),
  mode = "formal",
  caseIds,
  resume,
}) {
  if (!["formal", "author-validation"].includes(mode)) throw new TypeError("Unknown evaluator mode");
  if (resume !== undefined && mode !== 'author-validation') throw new TypeError('Resume requires author-validation');
  if (resume !== undefined && caseIds !== undefined) throw new TypeError('Resume cannot combine with case selection');
  if (caseIds !== undefined && mode !== 'author-validation') throw new TypeError('Case selection is diagnostic-only');
  const { request: requestPath, result: resultPath } = parseArgs(argv);
  const taskRoot = resolve(configuredTaskRoot);
  const repositoryRoot = resolve(configuredRepositoryRoot);
  if (mode === "formal") await assertEvaluatorReleased(taskRoot);
  const evaluatorRoot = join(taskRoot, "evaluator", "v2");
  const { lock } = await validateV2EvaluatorLock(join(taskRoot, "evaluator", "runtime-lock.json"), { repositoryRoot });
  const request = await readJson(requestPath, "evaluation request");
  const task = await readJson(join(taskRoot, "task.json"), "task manifest");
  const manifest = await readJson(join(evaluatorRoot, "manifest.v2.json"), "v2 manifest");
  const contractMap = await readJson(join(evaluatorRoot, "contract-map.v2.json"), "v2 contract map");
  await validateRequest({ request, task, taskRoot });
  validateV2Inputs({ task, manifest, contractMap });
  const selectedCases = selectAuthorValidationCases(manifest.cases, caseIds, { taskId: request.task.id });

  const profile = await resolveProfile(task.environment, repositoryRoot);
  const dependencyRoot = join(repositoryRoot, "node_modules");
  await requireEvaluatorDependencies(repositoryRoot, dependencyRoot);
  const taskRuntimeDefaults = serializeTaskRuntimeDefaults(lock.runtimeEnv);
  const outputRoot = dirname(resultPath);
  const runtime = await runtimeFactory({
    command: process.env.FRONTAL_OCI_COMMAND ?? "docker",
    runRoot: outputRoot,
  });
  if (typeof runtime?.preflight === "function") await runtime.preflight();

  const restored = resume === undefined ? { cases: [], privateCaseRecords: [] }
    : validateAuthorResume(resume, request, orderV2CasesForExecution(manifest.cases));
  const cases = restored.cases;
  let cleanupBlocked = false;
  const privateCaseRecords = restored.privateCaseRecords;
  const manifestOrder = new Map(manifest.cases.map(({ id }, index) => [id, index]));
  for (const definition of orderV2CasesForExecution(selectedCases).slice(cases.length)) {
    if (requiresV1Checkpoint(definition)) {
      const item = createMissingV1CheckpointOutcome(definition);
      cases.push(item);
      privateCaseRecords.push({ outcome: item, evidence: null });
      continue;
    }
    const caseRoot = join(outputRoot, "cases", definition.id);
    const priorStatePath = join(caseRoot, "prior-case-state.json");
    const privateStatePath = join(caseRoot, "private-case-state.json");
    await mkdir(caseRoot, { recursive: true, mode: 0o700 });
    await rm(join(caseRoot, "result.json"), { force: true });
    await rm(privateStatePath, { force: true });
    await writeJsonAtomic(priorStatePath, createPriorCaseState(task.id, privateCaseRecords));
    let session;
    let caseError;
    const recordAuthorFailure = error => {
      const previous = cases.at(-1)?.id === definition.id ? cases.at(-1) : undefined;
      const item = { id: definition.id, dimension: definition.dimension, weight: definition.weight,
        status: "evaluator_error", evaluatorErrorCode: String(error.code ?? '').startsWith('EVALUATOR_') ? error.code : "EVALUATOR_EXECUTION_FAILED",
        reason: error.message, durationMs: 0, evidenceDigest: sha256(JSON.stringify({ caseId: definition.id, error: error.message })),
        ...(error.details && { privateErrorDetails: error.details }),
        ...(previous && { privatePriorOutcome: previous }) };
      if (cases.at(-1)?.id === item.id) cases.pop();
      if (privateCaseRecords.at(-1)?.outcome.id === item.id) privateCaseRecords.pop();
      cases.push(item);
      privateCaseRecords.push({ outcome: item, evidence: null });
    };
    try {
    session = await runtime.createSession({
      name: containerName(request.operationId, task.id, definition.id),
      image: profile.image,
      platform: profile.platform,
      workdir: "/workspace",
      mounts: [
        { source: request.submission.path, target: "/submission", readonly: true },
        { source: evaluatorRoot, target: "/evaluator", readonly: true },
        { source: dependencyRoot, target: "/node_modules", readonly: true },
        { source: join(repositoryRoot, "src", "task-evaluator-v2"), target: "/shared-v2", readonly: true },
        { source: join(repositoryRoot, "templates", "contract-first"), target: "/templates/contract-first", readonly: true },
        { source: join(taskRoot, 'public-contract'), target: '/public-contract', readonly: true },
        { source: caseRoot, target: "/results", readonly: false },
      ],
      tmpfs: profile.runtime.tmpfs,
      resources: profile.runtime.resources,
      networkPolicy: profile.runtime.networkPolicy,
      readiness: profile.runtime.readiness,
      env: {
        BENCH_POSTGRES_DATABASES: "postgres",
        HOME: "/tmp/frontal-evaluator-home",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        NODE_OPTIONS: "--max-old-space-size=6144",
        TZ: "UTC",
        FRONTAL_V2_SHARED_RUNTIME_URL: "file:///shared-v2/runtime.mjs",
        FRONTAL_V2_SHARED_ROOT_URL: "file:///shared-v2/",
        FRONTAL_PUBLIC_CONTRACT_ROOT: '/public-contract',
        [PREPARE_CANDIDATE_ENV]: "1",
        [PRIOR_CASE_STATE_ENV]: "/results/prior-case-state.json",
        [PRIVATE_CASE_STATE_ENV]: "/results/private-case-state.json",
        [TASK_RUNTIME_DEFAULTS_ENV]: taskRuntimeDefaults,
      },
    });
      await session.exec("cp", ["-a", "/submission/.", "/workspace/"], { timeoutMs: 120_000 });
      await session.exec("chmod", ["-R", "u+rwX", "/workspace"], { timeoutMs: 120_000 });
      // Match the public gate: project tests may inspect Git metadata, while the
      // frozen submission intentionally excludes .git. Initialize only this copy.
      await session.exec("git", ["init", "/workspace"], { timeoutMs: null });
      await session.exec("node", [
        "/evaluator/run.mjs",
        "--submission", "/workspace",
        "--result", "/results/result.json",
        "--seed", request.seed,
        "--submission-digest", request.submission.digest,
        "--case", definition.id,
      ], { timeoutMs: null, maxOutputBytes: 2 * 1024 * 1024 });
      await session.exec("chmod", ["0644", "/results/result.json"], { timeoutMs: 30_000 });
      await session.exec("chmod", ["0644", "/results/private-case-state.json"], { timeoutMs: 30_000, allowFailure: true });
      const partial = await readJson(join(caseRoot, "result.json"), `${definition.id} v2 result`);
      if (partial?.schemaVersion !== 2
        || partial.taskId !== task.id
        || !Array.isArray(partial.cases)
        || partial.cases.length !== 1
        || partial.cases[0]?.id !== definition.id) {
        throw failure("v2_evaluator_protocol", `${definition.id} returned an invalid v2 result`);
      }
      const item = partial.cases[0];
      if (item.status === "evaluator_error" && mode === "formal") {
        throw failure("v2_evaluator_failed", `${definition.id} reported ${item.evaluatorErrorCode ?? "evaluator_error"}`);
      }
      cases.push(item);
      const privateState = await readPrivateCaseState(privateStatePath, task.id, definition.id);
      privateCaseRecords.push({ outcome: item, evidence: privateState?.evidence ?? null });
    } catch (error) {
      caseError = error;
      if (mode === "author-validation") {
        recordAuthorFailure(error);
      } else {
        if (error instanceof BenchError) throw error;
        throw failure("v2_evaluator_failed", `${definition.id} evaluator execution failed`, error);
      }
    } finally {
      try { await session?.close(); } catch (error) {
        cleanupBlocked = true;
        await writeJsonAtomic(join(caseRoot, 'cleanup-error.json'), {
          code: 'EVALUATOR_CONTAINER_CLEANUP_FAILED', message: error.message,
          ...(caseError && { operationError: { code: caseError.code, message: caseError.message } }),
        });
        if (mode === "formal") {
          if (caseError) { caseError.cleanupError = error; throw caseError; }
          throw failure('v2_evaluator_failed', `${definition.id} container cleanup failed; result retained, isolation unconfirmed`, error);
        }
        recordAuthorFailure(Object.assign(new Error(error.message, { cause: error }), { code: 'EVALUATOR_CONTAINER_CLEANUP_FAILED' }));
      }
      if (!cleanupBlocked) await Promise.all([rm(priorStatePath, { force: true }), rm(privateStatePath, { force: true })]);
    }
    if (mode === "author-validation") {
      await writeJsonAtomic(resultPath, { ...authorValidationReport({ taskId: task.id, request, cases, totalCases: manifest.cases.length, complete: false }),
        ...(restored.provenance && { resumeSource: restored.provenance }) });
    }
    if (cleanupBlocked) break;
  }

  if (await digestTaskPackagePath(request.submission.path) !== request.submission.digest) {
    throw failure("submission_digest_mismatch", "Frozen Submission changed during v2 evaluation");
  }
  if (mode === "author-validation") {
    cases.sort((left, right) => manifestOrder.get(left.id) - manifestOrder.get(right.id));
    const result = authorValidationReport({ taskId: task.id, request, cases, totalCases: manifest.cases.length,
      complete: !cleanupBlocked && cases.length === manifest.cases.length });
    if (restored.provenance) result.resumeSource = restored.provenance;
    if (caseIds !== undefined) Object.assign(result, { selectedCaseIds: selectedCases.map(({ id }) => id),
      selectionComplete: !cleanupBlocked && cases.length === selectedCases.length });
    await writeJsonAtomic(resultPath, result);
    return result;
  }
  const { scoreEvaluation } = await loadTaskScoring({ evaluatorRoot, repositoryRoot, packageDigest: request.task.digest });
  cases.sort((left, right) => manifestOrder.get(left.id) - manifestOrder.get(right.id));
  const report = scoreEvaluation(manifest, contractMap, { cases });
  if (report.verdict === "evaluator_error" || report.verdict === "invalid") {
    throw failure("v2_evaluator_failed", `v2 evaluator returned ${report.verdict}`);
  }
  const result = toV1Result(report);
  await writeJsonAtomic(resultPath, result);
  return result;
}

/** Preserve an interrupted evaluator's actual contiguous outcomes and private evidence. */
export function validateAuthorResume(resume, request, orderedCases) {
  const result = resume?.result;
  const require = (condition, message) => { if (!condition) throw new TypeError(`Invalid author resume: ${message}`); };
  require(result?.kind === 'frontal-v2-author-validation' && result.mode === 'author-validation'
    && result.complete === false && result.formalEligible === false && result.score === null && result.rawScore === null,
  'expected an unfinished diagnostic evaluation');
  require(result.taskId === request.task.id && result.task?.id === request.task.id
    && result.task.version === request.task.version && result.task.contractDigest === request.task.contractDigest,
  'public task identity changed');
  require(result.seed === request.seed && isDeepStrictEqual(result.submission, request.submission), 'seed or frozen submission changed');
  require(Array.isArray(result.cases) && result.cases.length > 0 && result.cases.length < orderedCases.length
    && result.completedCases === result.cases.length && result.totalCases === orderedCases.length
    && !result.selectedCaseIds, 'not a partial full-suite prefix');
  const records = parsePriorCaseState(JSON.stringify(resume.priorState), request.task.id).cases;
  require(records.length === result.cases.length, 'private evidence prefix is incomplete');
  for (let index = 0; index < result.cases.length; index++) {
    const outcome = result.cases[index], definition = orderedCases[index];
    require(outcome.id === definition.id && outcome.dimension === definition.dimension && outcome.weight === definition.weight,
      'completed cases are not an unchanged manifest prefix');
  }
  require(isDeepStrictEqual(createPriorCaseState(request.task.id, result.cases.map((outcome, index) => ({ outcome, evidence: records[index].evidence }))).cases, records),
    'private outcomes do not match the completed result');
  const counts = Object.fromEntries(['passed','failed','diagnostic','excluded','evaluator_error'].map(status => [status, result.cases.filter(item => item.status === status).length]));
  require(isDeepStrictEqual(counts, result.counts), 'source counts do not match outcomes');
  return { cases: structuredClone(result.cases), privateCaseRecords: structuredClone(records), provenance: {
    task: structuredClone(result.task), resultDigest: sha256(JSON.stringify(result)), reusedCaseIds: result.cases.map(item => item.id),
  } };
}

export function selectAuthorValidationCases(cases, ids, { taskId } = {}) {
  if (ids === undefined) return cases;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
    || ids.some(id => !cases.some(item => item.id === id))) throw new TypeError('Expected unique known diagnostic case IDs');
  // CarbonLedger D-08 creates its own browser/HTTP evidence; it does not consume prior cases.
  // Other closures retain the existing prerequisite guard, including unknown task identities.
  if (taskId !== 'carbonledger' && ids.includes('D-08') && ids.length !== cases.length) throw new TypeError('D-08 requires the complete private evidence sequence');
  return cases.filter(({ id }) => ids.includes(id));
}

/** Author validation executes real hidden cases but cannot emit a benchmark score. */
export function authorValidationReport({ taskId, request, cases, totalCases, complete }) {
  return { kind: "frontal-v2-author-validation", schemaVersion: 1, taskId,
    mode: "author-validation", formalEligible: false, verdict: "diagnostic", score: null, rawScore: null,
    complete, totalCases, completedCases: cases.length, updatedAt: new Date().toISOString(),
    task: request.task, submission: request.submission, seed: request.seed,
    counts: Object.fromEntries(["passed", "failed", "diagnostic", "excluded", "evaluator_error"].map(status => [status, cases.filter(item => item.status === status).length])),
    cases: [...cases] };
}

/** Evidence-closure Case runs after every independently isolated prerequisite Case. */
export function orderV2CasesForExecution(definitions) {
  const closure = definitions.filter(({ id }) => id === "D-08");
  return [...definitions.filter(({ id }) => id !== "D-08"), ...closure];
}

async function loadTaskScoring({ evaluatorRoot, repositoryRoot, packageDigest }) {
  const key = "FRONTAL_V2_SHARED_ROOT_URL";
  const previous = process.env[key];
  process.env[key] = pathToFileURL(join(repositoryRoot, "src", "task-evaluator-v2") + sep).href;
  try {
    const scoringUrl = pathToFileURL(join(evaluatorRoot, "lib", "scoring.mjs"));
    return await import(`${scoringUrl.href}?package=${encodeURIComponent(packageDigest)}`);
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function toV1Result(report) {
  const passed = report.verdict === "accepted";
  const diagnostic = report.verdict === "diagnostic";
  const observations = passed
    ? []
    : [...new Set(report.cases
      .filter(({ status }) => status === (diagnostic ? "diagnostic" : "failed"))
      .map(({ publicFeedbackCategory }) => `Public contract area remains unsatisfied: ${publicFeedbackCategory}.`))]
      .slice(0, 20);
  return {
    kind: "frontal-evaluation-result",
    schemaVersion: 1,
    verdict: passed ? "passed" : "failed",
    publicFeedback: {
      code: passed ? "ok" : diagnostic ? "evaluation-diagnostic" : "contract-checks-failed",
      summary: passed
        ? "The frozen submission satisfies the complete public contract."
        : diagnostic
          ? "The public contract has declared blockers, so this submission cannot receive a formal verdict."
        : "The frozen submission does not yet satisfy the complete public contract.",
      observations,
    },
    privateReport: report,
  };
}

async function validateRequest({ request, task, taskRoot }) {
  exactKeys(request, ["kind", "schemaVersion", "operationId", "seed", "task", "submission"], "evaluation request");
  if (request.kind !== "frontal-evaluation-request" || request.schemaVersion !== 1) {
    throw failure("v2_evaluator_protocol", "evaluation request kind/schemaVersion is unsupported");
  }
  nonEmpty(request.operationId, "evaluation request.operationId");
  sha(request.seed, "evaluation request.seed");
  exactKeys(request.task, ["id", "version", "digest", "contractDigest"], "evaluation request.task");
  if (request.task.id !== task.id || request.task.version !== task.taskVersion) {
    throw failure("v2_evaluator_protocol", "evaluation request task does not match Task Package");
  }
  sha(request.task.digest, "evaluation request.task.digest");
  sha(request.task.contractDigest, "evaluation request.task.contractDigest");
  if (await digestTaskPackagePath(taskRoot) !== request.task.digest) {
    throw failure("task_digest_mismatch", "Evaluation request Task Package digest does not match the mounted Task Package");
  }
  if (sha256(await readFile(join(taskRoot, task.contract))) !== request.task.contractDigest) {
    throw failure("contract_digest_mismatch", "Evaluation request contract digest does not match the mounted Task Package");
  }
  exactKeys(request.submission, ["path", "digest"], "evaluation request.submission");
  if (!isAbsolute(request.submission.path)) throw failure("v2_evaluator_protocol", "submission path must be absolute");
  sha(request.submission.digest, "evaluation request.submission.digest");
  await assertDirectory(request.submission.path, "evaluation request submission");
  if (await digestTaskPackagePath(request.submission.path) !== request.submission.digest) {
    throw failure("submission_digest_mismatch", "Frozen Submission changed before v2 evaluation");
  }
}

function validateV2Inputs({ task, manifest, contractMap }) {
  validateFinalSystemManifest(manifest);
  if (manifest?.schemaVersion !== 2 || manifest.taskId !== task.id || !Array.isArray(manifest.cases) || manifest.cases.length === 0) {
    throw failure("v2_evaluator_protocol", "v2 manifest does not match Task Package");
  }
  if (contractMap?.schemaVersion !== 2 || contractMap.taskId !== task.id) {
    throw failure("v2_evaluator_protocol", "v2 contract map does not match Task Package");
  }
  const ids = new Set();
  for (const item of manifest.cases) {
    if (!CASE_ID.test(item?.id) || ids.has(item.id)) throw failure("v2_evaluator_protocol", "v2 manifest case IDs are invalid");
    ids.add(item.id);
  }
}

// Final-system cases must actually run against the submitted system. An author
// placeholder or an unavailable second submission must never shrink its score.
export function validateFinalSystemManifest(manifest) {
  if (manifest?.evaluationScope !== 'final-system') return;
  for (const item of manifest.cases ?? []) {
    if (requiresV1Checkpoint(item) || item.blockedAssertions?.length) {
      throw failure('v2_evaluator_protocol', `Final-system case ${item.id} still has a historical prerequisite or author placeholder`);
    }
  }
}

async function resolveProfile(reference, repositoryRoot) {
  const match = /^([a-z0-9][a-z0-9._-]{0,63})@([1-9][0-9]*)$/u.exec(reference ?? "");
  if (!match) throw failure("invalid_task_runtime", "Task Package environment is invalid");
  const catalog = await loadEnvironmentCatalog(join(repositoryRoot, "environments", "catalog.v1.json"));
  const matches = catalog.profiles.filter(({ id, version }) => id === match[1] && version === Number(match[2]));
  if (matches.length !== 1) throw failure("invalid_task_runtime", `Cannot resolve one environment profile for ${reference}`);
  const profile = matches[0];
  if (!/^sha256:[a-f0-9]{64}$/u.test(profile.image)) throw failure("invalid_task_runtime", `${reference} must use an immutable OCI image`);
  if (await hashEnvironmentContext(profile.contextPath) !== profile.contextSha256) {
    throw failure("environment_context_mismatch", `${reference} context does not match the catalog`);
  }
  return profile;
}

async function requireEvaluatorDependencies(repositoryRoot, dependencyRoot) {
  const packageManifest = await readJson(join(repositoryRoot, "package.json"), "repository package.json");
  for (const name of ["ajv", "playwright-core"]) {
    if (typeof packageManifest.dependencies?.[name] !== "string") {
      throw failure("v2_evaluator_dependency_missing", `${name} must be a repository dependency`);
    }
    await assertDirectory(join(dependencyRoot, name), `repository dependency ${name}`);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = flag === "--request" ? "request" : flag === "--result" ? "result" : undefined;
    if (!key || !value || options[key]) throw failure("v2_evaluator_protocol", `invalid evaluator argument ${flag ?? "<missing>"}`);
    options[key] = resolve(value);
  }
  if (!options.request || !options.result) throw failure("v2_evaluator_protocol", "v2 evaluator requires --request and --result");
  if (!isAbsolute(options.request) || !isAbsolute(options.result)) throw failure("v2_evaluator_protocol", "request and result paths must be absolute");
  return options;
}

function containerName(operationId, taskId, caseId) {
  const suffix = createHash("sha256").update(operationId).digest("hex").slice(0, 12);
  return `fv2-${taskId}-${caseId}-${suffix}`.toLowerCase();
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw failure("v2_evaluator_protocol", `Cannot read ${label}: ${error.message}`, error);
  }
}

async function readPrivateCaseState(path, taskId, caseId) {
  try {
    return parsePrivateCaseState(await readFile(path), taskId, caseId);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw failure("v2_evaluator_protocol", `Cannot read ${caseId} private Case state: ${error.message}`, error);
  }
}

async function assertDirectory(path, label) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a regular directory");
  } catch (error) {
    throw failure("v2_evaluator_protocol", `${label} must be a regular directory`, error);
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("v2_evaluator_protocol", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw failure("v2_evaluator_protocol", `${label} has unsupported fields`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw failure("v2_evaluator_protocol", `${label} must be a non-empty string`);
}

function sha(value, label) {
  if (!SHA256.test(value)) throw failure("v2_evaluator_protocol", `${label} must be a lowercase SHA-256`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveInside(root, candidate, label) {
  if (typeof candidate !== "string" || !candidate || isAbsolute(candidate)) throw failure("v2_evaluator_lock_invalid", `${label} path is invalid`);
  const path = resolve(root, candidate);
  const rel = relative(resolve(root), path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw failure("v2_evaluator_lock_invalid", `${label} escapes the repository root`);
  }
  return path;
}

function failure(code, message, cause) {
  return new BenchError(code, message, cause ? { cause: cause.message ?? String(cause) } : undefined);
}
