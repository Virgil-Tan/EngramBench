#!/usr/bin/env node
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { arch } from "node:os";
import { join, resolve } from "node:path";

import { createCodexAgentDriver } from "../src/codex-agent-driver.mjs";
import { runConversationHarness } from "../src/conversation-harness.mjs";
import { asFailure, BenchError } from "../src/errors.mjs";
import { copyTree, writeJsonAtomic } from "../src/files.mjs";
import { createDeferredEvolutionAdapter, createMemoraxEvolutionAdapter } from "../src/memorax-evolution-adapter.mjs";
import { createModelUserAgent } from "../src/model-user-agent.mjs";
import { OciRuntime } from "../src/oci.mjs";
import { runProcess } from "../src/process.mjs";
import { createProcessEvaluator, loadTaskPackageV1 } from "../src/task-package-v1.mjs";
import { resolveTaskRuntime } from "../src/task-runtime.mjs";
import { resolveTaskOrder } from "../src/task-order.mjs";
import { createPublicContractGate } from "../src/public-contract-gate.mjs";
import { prepareMigrationWorkspace, prepareInPlaceMigrationWorkspace } from "../src/migration-workspace.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const runsRoot = resolve(process.env.FRONTAL_RUNS_ROOT ?? join(repositoryRoot, "runs"));
const runId = process.env.FRONTAL_RUN_ID ?? `curriculum-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}`;
const runRoot = join(runsRoot, runId);
const journalPath = join(runRoot, "journal.json");
const sharedRoot = join(runRoot, "shared");
const codexHome = join(sharedRoot, "codex-home");
const memoraxHome = join(sharedRoot, "memorax-code-home");
const image = required(process.env.FRONTAL_AGENT_IMAGE, "FRONTAL_AGENT_IMAGE");
const ownerId = required(process.env.FRONTAL_OWNER_ID, "FRONTAL_OWNER_ID");
const agentModel = process.env.FRONTAL_AGENT_MODEL ?? "gpt-5.5";
const agentEffort = process.env.FRONTAL_AGENT_EFFORT ?? "medium";
const userModel = process.env.FRONTAL_USER_MODEL ?? "deepseek-v4-pro";
const userThinking = (process.env.FRONTAL_USER_THINKING ?? "true") === "true";
const userReasoningEffort = process.env.FRONTAL_USER_REASONING_EFFORT ?? "high";
const deferEvolution = process.env.FRONTAL_DEFER_EVOLUTION === "true";
const runtimeGuideEnabled = optionalBoolean(process.env.FRONTAL_RUNTIME_GUIDE_ENABLED) ?? true;
const experimentArm = process.env.FRONTAL_EXPERIMENT_ARM ?? (runtimeGuideEnabled ? "treatment" : "baseline");
const purpose = process.env.FRONTAL_RUN_PURPOSE ?? "benchmark";
const migrationRepair = purpose === "migration-repair";
const pauseBeforeEvaluation = migrationRepair || purpose === "development";
const migrationSources = migrationRepair ? JSON.parse(required(process.env.FRONTAL_MIGRATION_SOURCES, "FRONTAL_MIGRATION_SOURCES")) : undefined;
const inPlaceMigration = migrationRepair && process.env.FRONTAL_MIGRATION_MODE === "in-place";
const migrationBackups = inPlaceMigration ? JSON.parse(required(process.env.FRONTAL_MIGRATION_BACKUPS, "FRONTAL_MIGRATION_BACKUPS")) : undefined;
if (pauseBeforeEvaluation && !deferEvolution) throw new Error("Development and migration repair must defer Evolution until a certified evaluation");
const ablationVariant = optional(process.env.MEMORAX_ABLATION_VARIANT);
if (ablationVariant && (!["selector_direct", "generic_advisor"].includes(ablationVariant) || !runtimeGuideEnabled || experimentArm !== "treatment" || !deferEvolution)) {
  throw new Error("Component ablation requires a known variant, guide transport and deferred Evolution");
}
const ablation = ablationVariant ? { kind: "component_ablation", variant: ablationVariant, isFullGuide: false, transportArm: "treatment" } : undefined;
const completedHistory = new Set((process.env.FRONTAL_COMPLETED_TASKS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const ociCommand = process.env.FRONTAL_OCI_COMMAND ?? "docker";
const evaluatorOciCommand = process.env.FRONTAL_EVALUATOR_OCI_COMMAND
  ?? (arch() === "x64" ? join(repositoryRoot, "scripts", "docker-native-amd64-evaluator.mjs") : ociCommand);

const providerBaseUrl = required(process.env.FRONTAL_MODEL_BASE_URL, "FRONTAL_MODEL_BASE_URL");
const providerApiKey = required(process.env.FRONTAL_MODEL_API_KEY, "FRONTAL_MODEL_API_KEY");
process.env.FRONTAL_LEGACY_RUNTIME_ROOT = repositoryRoot;
process.env.FRONTAL_V2_RUNTIME_ROOT = repositoryRoot;
// The Agent runtime keeps the captured `ociCommand`; evaluator subprocesses
// inherit the native, evaluator-only wrapper through the existing protocol.
process.env.FRONTAL_OCI_COMMAND = evaluatorOciCommand;

const packagesRoot = resolve(process.env.FRONTAL_TASK_PACKAGES_ROOT ?? join(repositoryRoot, "task-packages/v2"));
// Optional versioned public starter overlay; the legacy curriculum and order stay intact.
const variantRoot = optional(process.env.FRONTAL_TASK_PACKAGE_VARIANT_ROOT)
  ? resolve(process.env.FRONTAL_TASK_PACKAGE_VARIANT_ROOT) : undefined;
const selectedPackageRoot = async (id) => variantRoot && await exists(join(variantRoot, id, "task.json"))
  ? join(variantRoot, id) : join(packagesRoot, id);
const requested = optional(process.env.FRONTAL_TASK_IDS)?.split(",").map((value) => value.trim()).filter(Boolean);
const packageIds = await orderedTaskIds(packagesRoot, requested);
const pending = (await Promise.all(packageIds.map(loadTaskEntry)))
  .filter(({ id }) => !completedHistory.has(id));

await mkdir(runRoot, { recursive: true, mode: 0o700 });
await initializeSharedHome(codexHome, required(process.env.FRONTAL_CODEX_HOME_SEED, "FRONTAL_CODEX_HOME_SEED"), ["sessions", "session_index.jsonl", "tmp"]);
if (runtimeGuideEnabled) {
  await initializeSharedHome(memoraxHome, required(process.env.FRONTAL_MEMORAX_HOME_SEED, "FRONTAL_MEMORAX_HOME_SEED"), ["runtime"]);
} else await mkdir(memoraxHome, { recursive: true, mode: 0o700 });

let journal = await readOptionalJson(journalPath) ?? {
  schemaVersion: 1,
  kind: "frontal-general-sequence",
  purpose,
  runId,
  ownerId,
  agent: { driver: "codex", model: agentModel, effort: agentEffort },
  userAgent: { model: userModel, thinking: userThinking, reasoningEffort: userReasoningEffort },
  experimentArm,
  runtimeGuide: { enabled: runtimeGuideEnabled },
  ...(ablation ? { ablation } : {}),
  historicalCompleted: [...completedHistory].sort(),
  projects: [],
  status: "running",
  startedAt: new Date().toISOString(),
};
if (journal.ablation?.variant !== ablationVariant) throw new Error("Stored ablation variant differs from this run");
journal.status = "running";
journal.userAgent = { model: userModel, thinking: userThinking, reasoningEffort: userReasoningEffort };
journal.experimentArm = experimentArm;
journal.runtimeGuide = { enabled: runtimeGuideEnabled };
delete journal.finishedAt;
await writeJsonAtomic(journalPath, journal);

const runtime = new OciRuntime({ command: ociCommand, runRoot });
await runtime.preflight();

for (const [index, { id: taskId, phase }] of pending.entries()) {
  let record = journal.projects.find((entry) => entry.taskId === taskId);
  if (["passed", "rejected"].includes(record?.status) || (pauseBeforeEvaluation && record?.status === "awaiting_evaluation")) continue;
  record ??= { taskId, index: index + 1, phase, status: "pending" };
  if (!journal.projects.includes(record)) journal.projects.push(record);
  record.index = index + 1;
  record.phase = phase;
  record.status = "running";
  record.startedAt ??= new Date().toISOString();
  delete record.failure;
  await writeJsonAtomic(journalPath, journal);

  try {
    const projectRoot = join(runRoot, "projects", `${String(index + 1).padStart(2, "0")}-${taskId}`);
    const workspace = inPlaceMigration ? resolve(required(migrationSources[taskId], `in-place workspace ${taskId}`)) : join(projectRoot, "workspace");
    const privateRoot = join(projectRoot, "private");
    const scratchRoot = join(projectRoot, 'agent-io');
    const taskPackage = await loadTaskPackageV1(await selectedPackageRoot(taskId));
    const taskRuntime = await resolveTaskRuntime(taskPackage, { repositoryRoot });
    await mkdir(privateRoot, { recursive: true, mode: 0o700 });
    if (migrationRepair) {
      const source = resolve(required(migrationSources[taskId], `migration source ${taskId}`));
      const manifestPath = join(privateRoot, "migration.json");
      if (inPlaceMigration) {
        await writeJsonAtomic(manifestPath, await prepareInPlaceMigrationWorkspace({ source, backup: migrationBackups[taskId], taskPackage }));
      } else if (await exists(workspace)) {
        const manifest = await readOptionalJson(manifestPath);
        if (!manifest || manifest.source !== source || manifest.taskId !== taskId) throw new Error("Existing workspace does not match this migration source");
      } else {
        await writeJsonAtomic(manifestPath, await prepareMigrationWorkspace({ source, target: workspace, taskPackage }));
        await initializeWorkspaceGit(workspace, "V2 migration starter and original business implementation");
      }
    } else await prepareWorkspace(taskPackage.paths.workspace, workspace);
    await mkdir(scratchRoot, { recursive: true, mode: 0o700 });

    const container = await runtime.createSession({
      name: safeContainerName(`fg-${runId}-${taskId}`),
      image,
      workdir: "/workspace",
      mounts: [
        { source: workspace, target: "/workspace" },
        { source: scratchRoot, target: "/bench" },
        { source: codexHome, target: "/state/codex" },
        { source: codexHome, target: "/root/.codex" },
        { source: memoraxHome, target: "/state/memorax-code" },
      ],
      tmpfs: [{ target: "/tmp/frontal-benchmark-pgdata", sizeMiB: 2048 }],
      resources: { cpus: 4, memoryMiB: 8192 },
      networkPolicy: "ephemeral-bridge",
      readiness: {
        command: ["test", "-f", "/tmp/frontal-benchmark-pgdata/.frontal-benchmark-ready"],
        timeoutMs: 30_000,
        intervalMs: 100,
      },
      env: {
        ...taskRuntime.containerEnv,
        FRONTAL_RUN_ID: runId,
        FRONTAL_EXPERIMENT_ARM: experimentArm,
        FRONTAL_RUNTIME_GUIDE_ENABLED: String(runtimeGuideEnabled),
        MEMORAX_ABLATION_VARIANT: ablationVariant,
        CODEX_HOME: "/state/codex",
        HTTP_PROXY: process.env.FRONTAL_CODEX_PROXY,
        HTTPS_PROXY: process.env.FRONTAL_CODEX_PROXY,
        ALL_PROXY: process.env.FRONTAL_CODEX_PROXY,
        NO_PROXY: "127.0.0.1,localhost,::1",
        MEMORAX_CODE_HOME: "/state/memorax-code",
        MEMORAX_CODE_MEMORAX_USER_ID: ownerId,
        MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
        MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
        MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED: "false",
        MEMORAX_CODE_INTERNAL_DATA_COLLECTION_ENABLED: "false",
        MEMORAX_CODE_BACKEND_DEBUG_REQUESTS: process.env.FRONTAL_MEMORAX_DEBUG_REQUESTS ?? "false",
        MEMORAX_CODE_SKILL_EVOLUTION_ENABLED: "true",
        MEMORAX_CODE_SKILL_EVOLUTION_MODEL: userModel,
        MEMORAX_CODE_SKILL_EVOLUTION_MODEL_BASE_URL: providerBaseUrl,
        MEMORAX_CODE_SKILL_EVOLUTION_MODEL_API_KEY: providerApiKey,
      },
    });
    try {
      await container.exec("git", ["config", "--global", "--add", "safe.directory", "/workspace"], { timeoutMs: 60_000 });
      if (runtimeGuideEnabled) await prepareMemorax(container);
      for (const [command, ...args] of taskRuntime.legacy?.setup ?? taskRuntime.v2?.setup ?? []) {
        await container.exec(command, args, { timeoutMs: null });
      }
      const statePath = join(privateRoot, "harness-state.json");
      const resume = await exists(statePath);
      const result = await runConversationHarness({
        task: taskPackage.task,
        owner: { id: ownerId },
        runId: `${runId}-${taskId}`,
        statePath,
        resume,
        pauseBeforeEvaluation,
        handoffContext: migrationRepair
          ? inPlaceMigration
            ? "This is a V2 in-place continuation in the existing workspace, NOT a from-scratch task. Read MIGRATION.md and audit the existing source at its current paths. Reuse working business code and repair it to the current public V2 contract. Only replaced public integration files were preserved under legacy/v2-before/. Keep the Frozen Plan unchanged. Public integration success is not a hidden-test score; formal evaluation is pending author certification."
            : "This is a V2 migration repair of an existing implementation, NOT a from-scratch task. Read MIGRATION.md and inspect legacy/ before implementing. Reuse the business code, migrate it behind the fixed V2 public contract, and audit remaining README requirements yourself. Keep the Frozen Plan unchanged. Public integration success is not a hidden-test score; formal evaluation is pending author certification."
          : "",
        agentDriver: createCodexAgentDriver({
          container,
          workspacePath: workspace,
          workspaceId: `workspace-${taskId}`,
          stateDir: join(privateRoot, "agent-driver"),
          scratchHostPath: scratchRoot,
          codexHomePath: codexHome,
          model: agentModel,
          effort: agentEffort,
        }),
        userAgent: createModelUserAgent({
          stateDir: join(privateRoot, "user-agent"),
          baseUrl: providerBaseUrl,
          apiKey: providerApiKey,
          model: userModel,
          thinking: userThinking,
          reasoningEffort: userReasoningEffort,
          scenario: taskPackage.scenario,
        }),
        evaluator: createProcessEvaluator({ package: taskPackage, runRoot: join(privateRoot, "evaluator") }),
        publicContractCheck: await exists(join(taskPackage.paths.root, "contract-first.json"))
          ? createPublicContractGate({
              taskPackage, taskRuntime, repositoryRoot,
              runtime: new OciRuntime({ command: evaluatorOciCommand, runRoot: join(privateRoot, "public-contract") }),
              runRoot: join(privateRoot, "public-contract"),
            })
          : undefined,
        evolution: phase === "learning" && runtimeGuideEnabled
          ? deferEvolution ? createDeferredEvolutionAdapter() : createMemoraxEvolutionAdapter()
          : createDeferredEvolutionAdapter(),
      });
      Object.assign(record, {
        status: result.status,
        taskOutcome: result.taskOutcome,
        sessionId: result.sessionId,
        evaluation: result.evaluation,
        evolution: result.evolution,
        ...(result.status === "awaiting_evaluation" ? { pausedAt: new Date().toISOString() } : { finishedAt: new Date().toISOString() }),
      });
    } finally {
      if (runtimeGuideEnabled) await stopMemorax(container).catch(() => undefined);
      await container.close();
    }
  } catch (error) {
    Object.assign(record, { status: "failed", failure: asFailure(error, "general_sequence_task_failed"), finishedAt: new Date().toISOString() });
    await writeJsonAtomic(journalPath, journal);
    if (phase === "learning") break;
  }
  await writeJsonAtomic(journalPath, journal);
}

journal.status = journal.projects.some(({ status }) => status === "failed") ? "completed_with_failures"
  : journal.projects.some(({ status }) => status === "awaiting_evaluation") ? "awaiting_evaluation" : "completed";
if (journal.status === "awaiting_evaluation") journal.pausedAt = new Date().toISOString();
else journal.finishedAt = new Date().toISOString();
await writeJsonAtomic(journalPath, journal);
console.log(JSON.stringify({ runId, runRoot, status: journal.status, projects: journal.projects.map(({ taskId, status }) => ({ taskId, status })) }, null, 2));

async function prepareWorkspace(source, target) {
  if (await exists(target)) return;
  await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
  await copyTree(source, target, ["node_modules", "var", ".repo_memory"]);
  await initializeWorkspaceGit(target, "task package starter");
}

async function initializeWorkspaceGit(target, message) {
  await runProcess("git", ["init", "-q"], { cwd: target, timeoutMs: 60_000 });
  await runProcess("git", ["config", "user.email", "frontal-harness@example.invalid"], { cwd: target, timeoutMs: 60_000 });
  await runProcess("git", ["config", "user.name", "Frontal Harness"], { cwd: target, timeoutMs: 60_000 });
  await runProcess("git", ["add", "-A"], { cwd: target, timeoutMs: 60_000 });
  await runProcess("git", ["commit", "-q", "-m", message], { cwd: target, timeoutMs: 60_000 });
}

async function orderedTaskIds(packagesRoot, requestedIds) {
  const available = (await readdir(packagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const entries = await Promise.all(available.map(loadTaskEntry));
  return resolveTaskOrder(entries, requestedIds);
}

async function loadTaskEntry(id) {
  const lock = JSON.parse(await readFile(join(await selectedPackageRoot(id), "evaluator/runtime-lock.json"), "utf8"));
  const source = JSON.parse(await readFile(resolve(repositoryRoot, lock.sourceManifest), "utf8"));
  if (source.id !== id || !["learning", "transfer"].includes(source.phase)) {
    throw new BenchError("legacy_task_phase_invalid", `Legacy task ${id} must declare phase learning or transfer`);
  }
  return { id, phase: source.phase };
}

function createTransferEvaluationAdapter() {
  return {
    async supports({ agentDriverId }) { return agentDriverId === "codex"; },
    async run() { return { status: "completed", mode: "transfer_evaluation_only" }; },
  };
}

async function initializeSharedHome(target, seed, excludes) {
  if (await exists(target)) return;
  await mkdir(resolve(target, ".."), { recursive: true, mode: 0o700 });
  await copyTree(seed, target, excludes);
}

async function prepareMemorax(container) {
  await container.exec("memorax-code", ["codex-plugin", "activate", "--yes", "--json", "--codex-home", "/state/codex", "--workspace", "/workspace"], { timeoutMs: null });
  await container.exec("mkdir", ["-p", "/state/memorax-code/runtime"], { timeoutMs: null });
  await container.exec("chmod", ["-R", "a+rwX", "/state/memorax-code/runtime"], { timeoutMs: null });
  await container.exec("memorax-code", ["start", "--json", "--clients", "codex", "--home", "/state/memorax-code", "--codex-home", "/state/codex"], { timeoutMs: null });
  const result = await container.exec("memorax-code", ["status", "--json", "--clients", "codex", "--home", "/state/memorax-code", "--codex-home", "/state/codex"], { timeoutMs: null });
  let status;
  try { status = JSON.parse(result.stdout); }
  catch { throw new BenchError("treatment_m5_unavailable", "MemoraX status did not return JSON"); }
  assertM5Ready(status);
}

function assertM5Ready(status) {
  const adapter = status?.codexAdapter;
  if (status?.ok !== true
    || status.backend?.ok !== true
    || adapter?.installed !== true
    || adapter.enabled !== true
    || adapter.codexSkills?.ok !== true) {
    throw new BenchError("treatment_m5_unavailable", "Treatment cannot expose the MemoraX Runtime Guide before task execution", status);
  }
}

async function stopMemorax(container) {
  await container.exec("memorax-code", ["stop", "--json", "--clients", "codex", "--home", "/state/memorax-code", "--codex-home", "/state/codex"], { timeoutMs: null, allowFailure: true });
}

async function readOptionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function safeContainerName(value) { return value.toLowerCase().replace(/[^a-z0-9_.-]+/gu, "-").slice(0, 120); }
function optional(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function required(value, label) { const result = optional(value); if (!result) throw new BenchError("missing_configuration", `${label} is required`); return result; }
function optionalBoolean(value) {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true"].includes(normalized)) return true;
  if (["0", "false"].includes(normalized)) return false;
  throw new BenchError("runtime_guide_flag_invalid", "FRONTAL_RUNTIME_GUIDE_ENABLED must be true or false");
}
