import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { BenchError } from "./errors.mjs";
import { copyTree, writeJsonAtomic } from "./files.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const README_HEADINGS = [
  "Goal",
  "Starting Point",
  "Required Behaviour",
  "Public Interfaces",
  "Constraints and Invariants",
  "Required Commands",
  "Acceptance",
  "Out of Scope",
];
const PLAN_HEADINGS = ["Objective", "Stages", "Verification and Delivery"];
export const SUBMISSION_EXCLUDES = Object.freeze([
  ".git",
  ".repo_memory",
  "node_modules",
  ".cache",
  "dist",
  "coverage",
  "var",
  "playwright-report",
  "test-results",
  "perf-results",
]);

export async function loadTaskPackageV1(inputRoot) {
  const root = resolve(nonEmpty(inputRoot, "Task Package root"));
  await assertDirectory(root, "Task Package root");
  await assertSafeTree(root);

  const manifestPath = join(root, "task.json");
  const manifest = await readJsonFile(manifestPath, "task.json");
  validateManifest(manifest, basename(root));

  const workspace = resolvePackagePath(root, manifest.workspace, "task.workspace");
  const contract = resolvePackagePath(root, manifest.contract, "task.contract");
  const plan = resolvePackagePath(root, manifest.plan, "task.plan");
  const scenarioPath = resolvePackagePath(root, manifest.scenario, "task.scenario");
  await assertDirectory(workspace, "task.workspace");
  await assertFile(contract, "task.contract");
  await assertFile(plan, "task.plan");
  await assertFile(scenarioPath, "task.scenario");
  assertDescendant(workspace, contract, "task.contract must be inside task.workspace");
  assertOutside(workspace, plan, "task.plan must be outside task.workspace");
  assertOutside(workspace, scenarioPath, "task.scenario must be outside task.workspace");

  const command = [...manifest.evaluator.command];
  const evaluatorEntry = await resolveEvaluatorEntry(root, workspace, command);
  const [contractBytes, planBytes, scenarioBytes, evaluatorBytes] = await Promise.all([
    readFile(contract),
    readFile(plan),
    readFile(scenarioPath),
    readFile(evaluatorEntry),
  ]);
  const readme = decodeUtf8(contractBytes, "task.contract");
  const executionPlan = decodeUtf8(planBytes, "task.plan");
  validateHeadings(readme, README_HEADINGS, "task.contract");
  validateHeadings(executionPlan, PLAN_HEADINGS, "task.plan");
  if (!/README/iu.test(executionPlan) || !/(authoritative|权威|为准)/iu.test(executionPlan)) {
    fail("task.plan must declare README authoritative");
  }

  const scenario = JSON.parse(decodeUtf8(scenarioBytes, "task.scenario"));
  validateScenario(scenario);

  const digests = {
    contract: sha256(contractBytes),
    plan: sha256(planBytes),
    scenario: sha256(scenarioBytes),
    evaluator: sha256(evaluatorBytes),
    package: await digestTaskPackagePath(root),
  };
  const paths = { root, manifest: manifestPath, workspace, contract, plan, scenario: scenarioPath, evaluator: evaluatorEntry };
  const task = {
    schemaVersion: 1,
    id: manifest.id,
    readme,
    executionPlan,
    planDigest: digests.plan,
    metadata: {
      taskVersion: manifest.taskVersion,
      environment: manifest.environment,
      packageDigest: digests.package,
      contractDigest: digests.contract,
      scenarioDigest: digests.scenario,
      evaluatorDigest: digests.evaluator,
    },
  };
  const evaluator = {
    command,
    taskRoot: root,
    entryPath: evaluatorEntry,
    task: {
      id: manifest.id,
      version: manifest.taskVersion,
      digest: digests.package,
      contractDigest: digests.contract,
    },
  };

  return { task, scenario, evaluator, paths, digests, manifest };
}

export const loadTaskPackage = loadTaskPackageV1;

export function createProcessEvaluator({ package: taskPackage, runRoot, seed }) {
  object(taskPackage, "package");
  object(taskPackage.evaluator, "package.evaluator");
  object(taskPackage.paths, "package.paths");
  const evaluationSeed = seed ?? sha256(Buffer.from(`${taskPackage.digests.package}\0evaluator-v1`, "utf8"));
  if (!SHA256.test(evaluationSeed)) fail("seed must be a lowercase SHA-256");
  const configuredRoot = runRoot ? resolve(runRoot) : undefined;
  const rootPromise = configuredRoot
    ? Promise.resolve(configuredRoot).then(async (path) => (await mkdir(path, { recursive: true, mode: 0o700 }), path))
    : mkdtemp(join(tmpdir(), "frontal-process-evaluator-"));

  const adapter = {
    artifacts: configuredRoot
      ? {
          root: configuredRoot,
          request: join(configuredRoot, "request.json"),
          result: join(configuredRoot, "result.json"),
          privateReport: join(configuredRoot, "private-report.json"),
        }
      : undefined,
    async freeze({ operationId, workspace }) {
      nonEmpty(operationId, "freeze.operationId");
      object(workspace, "freeze.workspace");
      const source = resolve(nonEmpty(workspace.path, "freeze.workspace.path"));
      await assertDirectory(source, "freeze.workspace.path");
      await assertSafeTree(source, new Set(SUBMISSION_EXCLUDES));
      const root = await rootPromise;
      const id = `submission-${sha256(Buffer.from(operationId)).slice(0, 24)}`;
      const target = join(root, "submissions", id);
      if (!(await exists(target))) {
        const parent = dirname(target);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const temporaryRoot = await mkdtemp(join(parent, ".freeze-"));
        const temporary = join(temporaryRoot, "submission");
        let failure;
        try {
          await copyTree(source, temporary, SUBMISSION_EXCLUDES);
          await makeTreeRemovable(temporary);
          try {
            await rename(temporary, target);
            await makeReadOnly(target);
          } catch (error) {
            if (!(await exists(target))) throw error;
          }
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          try {
            await makeTreeRemovable(temporaryRoot);
            await rm(temporaryRoot, { recursive: true, force: true });
          } catch (cleanupError) {
            if (!failure) throw cleanupError;
          }
        }
      }
      await assertSafeTree(target);
      return { id, path: target, digest: await digestTaskPackagePath(target) };
    },

    async run({ operationId, submission }) {
      nonEmpty(operationId, "evaluation.operationId");
      object(submission, "evaluation.submission");
      const submissionPath = resolve(nonEmpty(submission.path, "evaluation.submission.path"));
      if (!isAbsolute(submission.path)) fail("evaluation.submission.path must be absolute");
      if (!SHA256.test(submission.digest)) fail("evaluation.submission.digest must be a lowercase SHA-256");
      if (await digestTaskPackagePath(submissionPath) !== submission.digest) {
        throw new BenchError("submission_digest_mismatch", "Frozen Submission changed before evaluation");
      }

      const root = await rootPromise;
      const requestPath = join(root, "request.json");
      const resultPath = join(root, "result.json");
      const privateReportPath = join(root, "private-report.json");
      if (!(await exists(resultPath))) {
        await writeJsonAtomic(requestPath, {
          kind: "frontal-evaluation-request",
          schemaVersion: 1,
          operationId,
          seed: evaluationSeed,
          task: { ...taskPackage.evaluator.task },
          submission: { path: submissionPath, digest: submission.digest },
        });
        await runEvaluatorProcess(taskPackage.evaluator, requestPath, resultPath);
      }
      const resultBytes = await readFile(resultPath);
      const result = JSON.parse(decodeUtf8(resultBytes, "Evaluator result"));
      validateEvaluationResult(result);
      await writeJsonAtomic(privateReportPath, result.privateReport);
      return {
        passed: result.verdict === "passed",
        feedback: structuredClone(result.publicFeedback),
        reportDigest: sha256(resultBytes),
      };
    },
  };
  return adapter;
}

async function runEvaluatorProcess(descriptor, requestPath, resultPath) {
  const [command, ...baseArgs] = descriptor.command;
  const args = [...baseArgs, "--request", requestPath, "--result", resultPath];
  const child = spawn(command === "node" ? process.execPath : command, args, {
    cwd: descriptor.taskRoot,
    env: evaluatorEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 32_768) stderr += chunk.toString("utf8");
  });
  child.stdout.resume();
  const { code, signal } = await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, exitSignal) => resolvePromise({ code: exitCode, signal: exitSignal }));
  });
  if (code !== 0) {
    throw new BenchError(
      "evaluator_process_failed",
      `Evaluator exited with ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
    );
  }
  if (!(await exists(resultPath))) throw new BenchError("evaluator_result_missing", "Evaluator did not write a result");
}

function evaluatorEnvironment() {
  const environment = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SYSTEMROOT",
    "ComSpec",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "FRONTAL_OCI_COMMAND",
    "FRONTAL_DOCKER_COMMAND",
    "ENGRAMBENCH_EVALUATOR_IMAGE",
    "FRONTAL_LEGACY_RUNTIME_ROOT",
    "FRONTAL_V2_RUNTIME_ROOT",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

function validateManifest(value, directoryName) {
  object(value, "task.json");
  exactKeys(value, ["kind", "schemaVersion", "id", "taskVersion", "environment", "workspace", "contract", "plan", "scenario", "evaluator"], "task.json");
  if (value.kind !== "frontal-task" || value.schemaVersion !== 1) fail("task.json must be frontal-task schemaVersion 1");
  if (!ID.test(value.id) || value.id !== directoryName) fail("task.id must be valid and match the Task directory name");
  integer(value.taskVersion, 1, Number.MAX_SAFE_INTEGER, "task.taskVersion");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}@[1-9][0-9]*$/u.test(value.environment)) fail("task.environment must be <id>@<version>");
  for (const key of ["workspace", "contract", "plan", "scenario"]) relativePath(value[key], `task.${key}`);
  object(value.evaluator, "task.evaluator");
  exactKeys(value.evaluator, ["command"], "task.evaluator");
  if (!Array.isArray(value.evaluator.command) || value.evaluator.command.length < 2) fail("task.evaluator.command must be a non-empty argv with an evaluator entry");
  for (const [index, item] of value.evaluator.command.entries()) nonEmpty(item, `task.evaluator.command[${index}]`);
}

function validateScenario(value) {
  object(value, "scenario.json");
  exactKeys(value, ["kind", "schemaVersion", "user", "milestones", "delivery"], "scenario.json");
  if (value.kind !== "frontal-scenario" || value.schemaVersion !== 1) fail("scenario.json must be frontal-scenario schemaVersion 1");
  object(value.user, "scenario.user");
  exactKeys(value.user, ["role", "goal", "style"], "scenario.user");
  for (const key of ["role", "goal", "style"]) nonEmpty(value.user[key], `scenario.user.${key}`);
  if (!Array.isArray(value.milestones)) fail("scenario.milestones must be an array");
  const ids = new Set();
  for (const [index, milestone] of value.milestones.entries()) {
    object(milestone, `scenario.milestones[${index}]`);
    exactKeys(milestone, ["id", "objective", "evidence"], `scenario.milestones[${index}]`);
    if (!ID.test(milestone.id) || ids.has(milestone.id)) fail("scenario milestone ids must be valid and unique");
    ids.add(milestone.id);
    nonEmpty(milestone.objective, `scenario.milestones[${index}].objective`);
    stringArray(milestone.evidence, `scenario.milestones[${index}].evidence`);
  }
  object(value.delivery, "scenario.delivery");
  exactKeys(value.delivery, ["request", "acceptWhen"], "scenario.delivery");
  nonEmpty(value.delivery.request, "scenario.delivery.request");
  stringArray(value.delivery.acceptWhen, "scenario.delivery.acceptWhen");
}

function validateEvaluationResult(value) {
  object(value, "Evaluator result");
  exactKeys(value, ["kind", "schemaVersion", "verdict", "publicFeedback", "privateReport"], "Evaluator result");
  if (value.kind !== "frontal-evaluation-result" || value.schemaVersion !== 1) fail("Evaluator result has an unsupported protocol");
  if (!new Set(["passed", "failed"]).has(value.verdict)) fail("Evaluator result verdict must be passed or failed");
  object(value.publicFeedback, "Evaluator result publicFeedback");
  exactKeys(value.publicFeedback, ["code", "summary"], "Evaluator result publicFeedback", ["observations"]);
  nonEmpty(value.publicFeedback.code, "Evaluator result publicFeedback.code");
  nonEmpty(value.publicFeedback.summary, "Evaluator result publicFeedback.summary");
  if (value.publicFeedback.observations !== undefined) {
    stringArray(value.publicFeedback.observations, "Evaluator result publicFeedback.observations", 20, true);
  }
  if (!("privateReport" in value)) fail("Evaluator result privateReport is required");
}

async function resolveEvaluatorEntry(root, workspace, command) {
  let entry;
  for (const argument of command.slice(1)) {
    if (argument.startsWith("-")) continue;
    const candidate = resolvePackagePath(root, argument, "task.evaluator.command path");
    if (await exists(candidate)) {
      await assertFile(candidate, "task.evaluator.command entry");
      entry = candidate;
      break;
    }
  }
  if (!entry) fail("task.evaluator.command must reference an existing Task file");
  assertOutside(workspace, entry, "Evaluator entry must be outside task.workspace");
  assertDescendant(join(root, "evaluator"), entry, "Evaluator entry must be inside evaluator/");
  return entry;
}

export async function digestTaskPackagePath(root) {
  const hash = createHash("sha256");
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new BenchError("unsafe_task_package", `Symlink is not allowed: ${rel}`);
      if (entry.isDirectory()) {
        hash.update(`directory\0${rel}\0`);
        await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        hash.update(`file\0${rel}\0${bytes.length}\0`);
        hash.update(bytes);
      } else throw new BenchError("unsafe_task_package", `Unsupported file type: ${rel}`);
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function assertSafeTree(root, excludes = new Set()) {
  const stat = await lstat(root);
  if (stat.isSymbolicLink()) throw new BenchError("unsafe_task_package", `${root} must not be a symlink`);
  if (!stat.isDirectory()) fail(`${root} must be a directory`);
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (excludes.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new BenchError("unsafe_task_package", `Symlink is not allowed: ${path}`);
    if (entry.isDirectory()) await assertSafeTree(path, excludes);
    else if (!entry.isFile()) throw new BenchError("unsafe_task_package", `Unsupported file type: ${path}`);
  }
}

async function makeReadOnly(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await makeReadOnly(path);
    const stat = await lstat(path);
    await chmod(path, stat.mode & ~0o222);
  }
  const stat = await lstat(root);
  await chmod(root, stat.mode & ~0o222);
}

async function makeTreeRemovable(root) {
  let stat;
  try {
    stat = await lstat(root);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) return;
  await chmod(root, stat.mode | 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeTreeRemovable(join(root, entry.name));
  }
}

function validateHeadings(text, headings, label) {
  let cursor = 0;
  for (const heading of headings) {
    const pattern = new RegExp(`^## ${escapeRegExp(heading)}[ \\t]*$`, "gmu");
    pattern.lastIndex = cursor;
    const match = pattern.exec(text);
    if (!match) fail(`${label} is missing or misorders heading: ## ${heading}`);
    const bodyStart = pattern.lastIndex;
    const remaining = text.slice(bodyStart);
    const nextHeading = remaining.search(/^## [^#]/mu);
    const body = nextHeading === -1 ? remaining : remaining.slice(0, nextHeading);
    if (!body.trim()) fail(`${label} heading is empty: ## ${heading}`);
    cursor = pattern.lastIndex;
  }
}

function resolvePackagePath(root, candidate, label) {
  relativePath(candidate, label);
  const absolute = resolve(root, candidate);
  assertDescendant(root, absolute, `${label} escapes the Task Package root`);
  return absolute;
}

function relativePath(value, label) {
  nonEmpty(value, label);
  if (isAbsolute(value) || value.split(/[\\/]/u).includes("..")) fail(`${label} must be a safe relative path`);
}

function assertDescendant(root, candidate, message) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return;
  fail(message);
}

function assertOutside(root, candidate, message) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) fail(message);
}

async function readJsonFile(path, label) {
  try {
    return JSON.parse(decodeUtf8(await readFile(path), label));
  } catch (error) {
    if (error instanceof BenchError) throw error;
    throw new BenchError("invalid_task_package", `Cannot read ${label}: ${error.message}`);
  }
}

async function assertDirectory(path, label) {
  let stat;
  try { stat = await lstat(path); } catch { fail(`${label} does not exist`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a regular directory`);
}

async function assertFile(path, label) {
  let stat;
  try { stat = await lstat(path); } catch { fail(`${label} does not exist`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function exactKeys(value, required, label, optional = []) {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!(key in value)) fail(`${label}.${key} is required`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${label}.${key} is not supported`);
}

function stringArray(value, label, max = Number.MAX_SAFE_INTEGER, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > max) fail(`${label} must be a non-empty string array`);
  value.forEach((item, index) => nonEmpty(item, `${label}[${index}]`));
}

function integer(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(`${label} must be an integer from ${minimum} to ${maximum}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be a non-empty string`);
  return value;
}

function decodeUtf8(bytes, label) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail(`${label} must be valid UTF-8`); }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function fail(message) {
  throw new BenchError("invalid_task_package", message);
}
