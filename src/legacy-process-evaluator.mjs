import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadLegacyTask } from "./contracts.mjs";
import { BenchError } from "./errors.mjs";
import { writeJsonAtomic } from "./files.mjs";
import { OciRuntime } from "./oci.mjs";
import { runHiddenTests } from "./scoring.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const LOCK_KEYS = [
  "kind",
  "schemaVersion",
  "taskId",
  "sourceManifest",
  "sourceDigest",
  "runtimeFiles",
  "assets",
  "supportedTestIds",
  "excludedTests",
];
export const LEGACY_RUNTIME_FILES = Object.freeze([
  "src/legacy-process-evaluator.mjs",
  "src/contracts.mjs",
  "src/scoring.mjs",
  "src/codex.mjs",
  "src/oci.mjs",
  "src/environments.mjs",
  "src/files.mjs",
  "src/process.mjs",
  "src/errors.mjs",
  "environments/catalog.v1.json",
  "package.json",
  "package-lock.json",
  "node_modules/playwright-core",
]);

export async function runLegacyEvaluatorProcess({
  argv,
  lockPath,
  repositoryRoot,
  runtimeFactory = defaultRuntime,
  hiddenTestRunner = runHiddenTests,
}) {
  const options = parseArgs(argv);
  const locked = await validateLegacyEvaluatorLock(lockPath, { repositoryRoot });
  const request = await readJson(options.request, "evaluation request");
  validateRequest(request, locked.lock.taskId);
  await validateRequestBindings(request, lockPath);

  const task = await loadLegacyTask(locked.sourceManifest);
  const selected = new Set(locked.lock.supportedTestIds);
  task.hiddenTests = task.hiddenTests.filter(({ id }) => selected.has(id));
  task.testIds = new Set(task.hiddenTests.map(({ id }) => id));

  const scoreRoot = dirname(resolve(options.result));
  const runtime = await runtimeFactory({
    command: process.env.FRONTAL_OCI_COMMAND ?? "docker",
    runRoot: scoreRoot,
    task,
  });
  if (typeof runtime?.preflight === "function") await runtime.preflight();

  const evaluatorNodeModulesPath = join(locked.repositoryRoot, "node_modules");
  const results = await hiddenTestRunner({
    runtime,
    image: task.execution.image,
    task,
    snapshotPath: request.submission.path,
    scoreRoot,
    seed: request.seed,
    timeoutMs: Math.max(3_600_000, ...task.hiddenTests.map(({ timeoutMs = 0 }) => timeoutMs)),
    ...(await isDirectory(evaluatorNodeModulesPath) ? { evaluatorNodeModulesPath } : {}),
  });
  assertResultIds(results, locked.lock.supportedTestIds);

  const result = evaluationResult(results, locked.lock.excludedTests);
  await writeJsonAtomic(resolve(options.result), result);
  return result;
}

export async function validateLegacyEvaluatorLock(lockPath, { repositoryRoot: configuredRepositoryRoot } = {}) {
  const absoluteLock = resolve(lockPath);
  const lock = await readJson(absoluteLock, "legacy evaluator lock");
  exactKeys(lock, LOCK_KEYS, "legacy evaluator lock");
  if (lock.kind !== "frontal-legacy-evaluator-lock" || lock.schemaVersion !== 1) {
    invalid("legacy evaluator lock kind/schemaVersion is unsupported");
  }
  nonEmpty(lock.taskId, "legacy evaluator lock.taskId");
  safeRelative(lock.sourceManifest, "legacy evaluator lock.sourceManifest");
  sha(lock.sourceDigest, "legacy evaluator lock.sourceDigest");
  if (configuredRepositoryRoot !== undefined) {
    nonEmpty(configuredRepositoryRoot, "legacy evaluator repositoryRoot");
  }
  const repositoryRoot = configuredRepositoryRoot === undefined
    ? resolve(dirname(absoluteLock), "../../../..")
    : resolve(configuredRepositoryRoot);
  const sourceManifest = resolveInside(repositoryRoot, lock.sourceManifest, "legacy source manifest");
  await verifyDigest(sourceManifest, lock.sourceDigest, "legacy source manifest");

  await validateLockedPaths(lock.runtimeFiles, repositoryRoot, "runtimeFiles");
  if (lock.runtimeFiles.length !== LEGACY_RUNTIME_FILES.length
    || lock.runtimeFiles.some(({ path }, index) => path !== LEGACY_RUNTIME_FILES[index])) {
    invalid("legacy evaluator lock.runtimeFiles does not match the required runtime inventory");
  }
  await validateLockedPaths(lock.assets, repositoryRoot, "assets", true);
  stringArray(lock.supportedTestIds, "legacy evaluator lock.supportedTestIds", true);
  if (!Array.isArray(lock.excludedTests)) invalid("legacy evaluator lock.excludedTests must be an array");
  for (const [index, entry] of lock.excludedTests.entries()) {
    exactKeys(entry, ["id", "reason"], `legacy evaluator lock.excludedTests[${index}]`);
    nonEmpty(entry.id, `legacy evaluator lock.excludedTests[${index}].id`);
    if (entry.reason !== "requires-intermediate-v1-snapshot") {
      invalid(`legacy evaluator lock.excludedTests[${index}].reason is unsupported`);
    }
  }

  const task = await loadLegacyTask(sourceManifest);
  if (task.id !== lock.taskId) invalid("legacy evaluator lock taskId does not match its source manifest");
  const expected = task.hiddenTests.map(({ id }) => id);
  const actual = [...lock.supportedTestIds, ...lock.excludedTests.map(({ id }) => id)];
  if (new Set(actual).size !== actual.length
    || expected.length !== actual.length
    || expected.some((id) => !actual.includes(id))) {
    invalid("legacy evaluator lock test inventory does not match its source manifest");
  }
  for (const test of task.hiddenTests) {
    const excluded = lock.excludedTests.some(({ id }) => id === test.id);
    if (excluded !== test.command.includes("V1_TO_FINAL")) {
      invalid(`legacy evaluator lock has an invalid V1 checkpoint classification for ${test.id}`);
    }
  }
  const selected = new Set(lock.supportedTestIds);
  const expectedAssets = [...new Set(task.hiddenTests
    .filter(({ id }) => selected.has(id))
    .flatMap(({ assetsPath, frameworkAssetsPath }) => [assetsPath, frameworkAssetsPath].filter(Boolean))
    .map((path) => repositoryPath(repositoryRoot, path)))].sort((left, right) => left.localeCompare(right, "en"));
  const actualAssets = lock.assets.map(({ path }) => path);
  if (expectedAssets.length !== actualAssets.length
    || expectedAssets.some((path, index) => path !== actualAssets[index])) {
    invalid("legacy evaluator lock.assets does not match the supported hidden-test inventory");
  }
  return { lock, repositoryRoot, sourceManifest, task };
}

export async function digestLegacyPath(inputPath) {
  const root = resolve(inputPath);
  const metadata = await lstat(root);
  if (metadata.isSymbolicLink()) invalid(`cannot digest symlink ${root}`);
  if (metadata.isFile()) return sha256(await readFile(root));
  if (!metadata.isDirectory()) invalid(`cannot digest unsupported path ${root}`);

  const hash = createHash("sha256");
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const name = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) invalid(`cannot digest symlink ${path}`);
      if (entry.isDirectory()) {
        hash.update(`directory\0${name}\0`);
        await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        hash.update(`file\0${name}\0${bytes.length}\0`);
        hash.update(bytes);
      } else invalid(`cannot digest unsupported path ${path}`);
    }
  };
  await visit(root);
  return hash.digest("hex");
}

export function evaluationResult(results, excludedTests = []) {
  const passed = results.filter((entry) => entry.passed === true).length;
  const failed = results.length - passed;
  const excluded = excludedTests.length;
  const total = results.length;
  const score = total === 0 ? 0 : Math.round((passed / total) * 10_000) / 100;
  const verdict = failed === 0 ? "passed" : "failed";
  const summary = failed > 0
    ? `${failed} 项公开合同验证未通过；已通过 ${passed}/${total} 项。`
    : excluded > 0
      ? `全部 ${passed} 项适用的最终交付验证均已通过；${excluded} 项旧跨版本检查依赖已退役的中间快照，未执行且不参与评分。`
      : `全部 ${passed} 项公开合同验证均已通过。`;

  return {
    kind: "frontal-evaluation-result",
    schemaVersion: 1,
    verdict,
    publicFeedback: {
      code: verdict === "passed" ? "contract-satisfied" : "contract-checks-failed",
      summary,
      observations: [
        `已执行 ${results.length} 项最终交付验证。`,
        ...(excluded > 0 ? [`${excluded} 项旧中间快照验证已在新任务版本中明确退役。`] : []),
      ],
    },
    privateReport: {
      score,
      counts: { total, executed: results.length, passed, failed, excluded },
      checks: results.map(({ id, passed: ok, exitCode, durationMs, stdout, stderr, error, blocked, blockedBy }) => ({
        id,
        passed: ok === true,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...(durationMs === undefined ? {} : { durationMs }),
        ...(stdout === undefined ? {} : { stdout }),
        ...(stderr === undefined ? {} : { stderr }),
        ...(error === undefined ? {} : { error }),
        ...(blocked === undefined ? {} : { blocked }),
        ...(blockedBy === undefined ? {} : { blockedBy }),
      })),
      excludedChecks: excludedTests,
    },
  };
}

async function defaultRuntime(options) {
  return new OciRuntime(options);
}

async function validateLockedPaths(entries, repositoryRoot, label, allowEmpty = false) {
  if (!Array.isArray(entries) || (!allowEmpty && entries.length === 0)) {
    invalid(`legacy evaluator lock.${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const paths = new Set();
  for (const [index, entry] of entries.entries()) {
    exactKeys(entry, ["path", "digest"], `legacy evaluator lock.${label}[${index}]`);
    safeRelative(entry.path, `legacy evaluator lock.${label}[${index}].path`);
    sha(entry.digest, `legacy evaluator lock.${label}[${index}].digest`);
    if (paths.has(entry.path)) invalid(`legacy evaluator lock.${label} contains duplicate path ${entry.path}`);
    paths.add(entry.path);
    await verifyDigest(resolveInside(repositoryRoot, entry.path, entry.path), entry.digest, entry.path);
  }
}

async function verifyDigest(path, expected, label) {
  let actual;
  try {
    actual = await digestLegacyPath(path);
  } catch (error) {
    throw new BenchError("legacy_evaluator_lock_mismatch", `${label} is unavailable: ${error.message}`);
  }
  if (actual !== expected) {
    throw new BenchError("legacy_evaluator_lock_mismatch", `${label} changed after the adapted Task Package was generated`);
  }
}

function validateRequest(value, taskId) {
  exactKeys(value, ["kind", "schemaVersion", "operationId", "seed", "task", "submission"], "evaluation request");
  if (value.kind !== "frontal-evaluation-request" || value.schemaVersion !== 1) invalid("evaluation request kind/schemaVersion is unsupported");
  nonEmpty(value.operationId, "evaluation request.operationId");
  sha(value.seed, "evaluation request.seed");
  exactKeys(value.task, ["id", "version", "digest", "contractDigest"], "evaluation request.task");
  if (value.task.id !== taskId) invalid("evaluation request task does not match the evaluator lock");
  if (!Number.isSafeInteger(value.task.version) || value.task.version < 1) invalid("evaluation request.task.version is invalid");
  sha(value.task.digest, "evaluation request.task.digest");
  sha(value.task.contractDigest, "evaluation request.task.contractDigest");
  exactKeys(value.submission, ["path", "digest"], "evaluation request.submission");
  if (!isAbsolute(value.submission.path)) invalid("evaluation request submission path must be absolute");
  sha(value.submission.digest, "evaluation request.submission.digest");
}

async function validateRequestBindings(request, lockPath) {
  const taskRoot = resolve(dirname(resolve(lockPath)), "..");
  const manifest = await readJson(join(taskRoot, "task.json"), "adapted task manifest");
  if (request.task.version !== manifest.taskVersion) {
    invalid("evaluation request task version does not match the adapted task");
  }
  if (await digestLegacyPath(taskRoot) !== request.task.digest) {
    throw new BenchError("task_digest_mismatch", "Evaluation request Task Package digest does not match the adapted task");
  }
  if (await digestLegacyPath(join(taskRoot, "workspace", "README.md")) !== request.task.contractDigest) {
    throw new BenchError("contract_digest_mismatch", "Evaluation request contract digest does not match the adapted task");
  }
  if (!await isDirectory(request.submission.path)) invalid("evaluation request submission path must be a regular directory");
  if (await digestLegacyPath(request.submission.path) !== request.submission.digest) {
    throw new BenchError("submission_digest_mismatch", "Frozen Submission changed before legacy evaluation");
  }
}

function assertResultIds(results, expectedIds) {
  if (!Array.isArray(results)
    || results.length !== expectedIds.length
    || results.some((entry, index) => entry?.id !== expectedIds[index] || typeof entry.passed !== "boolean")) {
    throw new BenchError("legacy_evaluator_protocol", "Legacy hidden-test runner returned an invalid result inventory");
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    const key = typeof flag === "string" ? flag.slice(2) : "";
    if (!["--request", "--result"].includes(flag) || !value || options[key]) {
      invalid(`invalid legacy evaluator argument ${flag ?? "<missing>"}`);
    }
    options[key] = value;
  }
  if (!options.request || !options.result) invalid("legacy evaluator requires --request and --result");
  if (!isAbsolute(options.request) || !isAbsolute(options.result)) {
    invalid("legacy evaluator request and result paths must be absolute");
  }
  return options;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    invalid(`cannot read ${label}: ${error.message}`);
  }
}

function resolveInside(root, candidate, label) {
  const path = resolve(root, candidate);
  const rel = relative(resolve(root), path);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return path;
  invalid(`${label} escapes the repository root`);
}

function repositoryPath(repositoryRoot, path) {
  const rel = relative(resolve(repositoryRoot), resolve(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    invalid(`hidden-test asset escapes the legacy repository root: ${path}`);
  }
  return rel.split(sep).join("/");
}

async function isDirectory(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function exactKeys(value, expected, label) {
  object(value, label);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    invalid(`${label} must have exactly ${wanted.join(", ")}`);
  }
}

function stringArray(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) invalid(`${label} must be a string array`);
  value.forEach((entry, index) => nonEmpty(entry, `${label}[${index}]`));
}

function safeRelative(value, label) {
  nonEmpty(value, label);
  if (isAbsolute(value) || value.split(/[\\/]/u).includes("..")) invalid(`${label} must be a safe relative path`);
}

function sha(value, label) {
  if (!SHA256.test(value)) invalid(`${label} must be a lowercase SHA-256`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") invalid(`${label} must be a non-empty string`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalid(message) {
  throw new BenchError("invalid_legacy_evaluator", message);
}
