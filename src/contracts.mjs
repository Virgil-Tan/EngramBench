import { dirname, relative, resolve, sep } from "node:path";

import { BenchError } from "./errors.mjs";
import {
  resolveEnvironmentProfile,
  validateRuntimeEnv,
} from "./environments.mjs";
import { assertRegularFile, readJson, sha256File, sha256Text } from "./files.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export async function loadExperiment(manifestPath) {
  const absoluteManifest = resolve(manifestPath);
  const base = dirname(absoluteManifest);
  const raw = await readJson(absoluteManifest);
  object(raw, "experiment");
  exactVersion(raw.schemaVersion, "experiment");
  id(raw.id, "experiment.id");
  nonEmpty(raw.seed, "experiment.seed");
  if (raw.replicateCount !== 1) fail("experiment.replicateCount must be 1 in v1");
  object(raw.runtime, "experiment.runtime");
  nonEmpty(raw.runtime.ociCommand, "runtime.ociCommand");
  nonEmpty(raw.runtime.runRoot, "runtime.runRoot");
  object(raw.artifacts, "experiment.artifacts");
  const frontalTarball = resolve(base, nonEmpty(raw.artifacts.frontalTarball, "artifacts.frontalTarball"));
  await assertRegularFile(frontalTarball, "Frontal tarball");
  const expectedHash = sha(raw.artifacts.frontalSha256, "artifacts.frontalSha256");
  const actualHash = await sha256File(frontalTarball);
  if (actualHash !== expectedHash) throw new BenchError("artifact_hash_mismatch", "Frontal tarball SHA256 does not match the manifest");
  const codexNpmSpec = nonEmpty(raw.artifacts.codexNpmSpec, "artifacts.codexNpmSpec");
  if (!/^@openai\/codex@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/u.test(codexNpmSpec)) {
    fail("artifacts.codexNpmSpec must pin an exact @openai/codex version");
  }
  object(raw.models, "experiment.models");
  validateModel(raw.models.agent, "models.agent", "gpt-5.6-terra", "medium");
  validateRemoteModel(raw.models.user, "models.user", "deepseek-v4-flash");
  validateRemoteModel(raw.models.evolution, "models.evolution", "deepseek-v4-pro");
  validateModel(raw.models.judge, "models.judge", "gpt-5.6-sol", "max");
  const budgets = validateBudgets(raw.budgets);
  object(raw.images, "experiment.images");
  immutableImage(raw.images.judgeBase, "images.judgeBase");
  object(raw.secrets, "experiment.secrets");
  const codexHomeSeed = resolve(base, nonEmpty(raw.secrets.codexHomeSeed, "secrets.codexHomeSeed"));
  const judgeCodexHomeSeed = resolve(base, nonEmpty(raw.secrets.judgeCodexHomeSeed, "secrets.judgeCodexHomeSeed"));

  const personaPaths = uniquePaths(raw.personas, "personas", base);
  const taskPaths = uniquePaths(raw.curriculum, "curriculum", base);
  const personas = await Promise.all(personaPaths.map(loadPersona));
  const tasks = await Promise.all(taskPaths.map(loadLegacyTask));
  uniqueIds(personas, "persona");
  uniqueIds(tasks, "task");
  for (const task of tasks) {
    const hiddenMetadata = [
      task.sourcePath,
      ...(task.environmentProfile ? [task.environmentProfile.catalogPath] : []),
      ...personas.map(({ sourcePath }) => sourcePath),
      ...personas.flatMap(({ checklists }) => Object.values(checklists)),
      ...task.hiddenTests.flatMap(({ assetsPath, frameworkAssetsPath }) => [assetsPath, frameworkAssetsPath].filter(Boolean)),
    ];
    if (hiddenMetadata.some((path) => isInside(task.fixture.path, path))) {
      fail(`task ${task.id} fixture contains benchmark metadata or hidden assets`);
    }
  }
  for (const persona of personas) {
    persona.checklistData = {};
    for (const task of tasks) {
      const checklist = persona.checklists[task.id];
      if (!checklist) fail(`persona ${persona.id} has no checklist for task ${task.id}`);
      await assertRegularFile(checklist, `checklist ${persona.id}/${task.id}`);
      persona.checklistData[task.id] = await validateChecklist(checklist, task, persona);
    }
  }

  const definitionFiles = [
    absoluteManifest,
    ...personas.map(({ sourcePath }) => sourcePath),
    ...tasks.map(({ sourcePath }) => sourcePath),
    ...tasks.flatMap(({ environmentProfile }) => environmentProfile ? [environmentProfile.catalogPath] : []),
    ...personas.flatMap(({ checklists }) => Object.values(checklists)),
  ];
  const definitionEntries = await Promise.all([...new Set(definitionFiles)].map(async (path) => ({
    path: relative(base, path),
    sha256: await sha256File(path),
  })));
  definitionEntries.sort((left, right) => left.path.localeCompare(right.path));

  return {
    ...raw,
    manifestPath: absoluteManifest,
    base,
    artifacts: { ...raw.artifacts, frontalTarball, frontalSha256: actualHash },
    secrets: { ...raw.secrets, codexHomeSeed, judgeCodexHomeSeed },
    budgets,
    personas,
    tasks,
    definitionSha256: sha256Text(JSON.stringify(definitionEntries)),
    definitionEntries,
  };
}

async function loadPersona(path) {
  const raw = await readJson(path);
  object(raw, `persona ${path}`);
  exactVersion(raw.schemaVersion, "persona");
  id(raw.id, "persona.id");
  object(raw.profile, `persona ${raw.id}.profile`);
  for (const key of ["goals", "expertise", "interactionStyle", "clarificationStyle", "acceptanceStyle", "boundaries"]) {
    nonEmpty(raw.profile[key], `persona ${raw.id}.profile.${key}`);
  }
  object(raw.checklists, `persona ${raw.id}.checklists`);
  const base = dirname(path);
  return {
    ...raw,
    sourcePath: path,
    checklists: Object.fromEntries(Object.entries(raw.checklists).map(([taskId, checklist]) => [taskId, resolve(base, nonEmpty(checklist, `checklist ${taskId}`))])),
  };
}

export async function loadLegacyTask(path) {
  const raw = await readJson(path);
  object(raw, `task ${path}`);
  exactVersion(raw.schemaVersion, "task");
  id(raw.id, "task.id");
  if (!["learning", "transfer"].includes(raw.phase)) fail(`task ${raw.id}.phase must be learning or transfer`);
  const environmentProfile = raw.environmentProfile === undefined
    ? undefined
    : await resolveEnvironmentProfile(raw.environmentProfile, path);
  const runtimeEnv = validateRuntimeEnv(raw.runtimeEnv, `task ${raw.id}.runtimeEnv`);
  const execution = taskExecution(raw, environmentProfile);
  if (raw.definitionFiles !== undefined) fail(`task ${raw.id}.definitionFiles is not supported`);
  object(raw.fixture, `task ${raw.id}.fixture`);
  const fixturePath = resolve(dirname(path), nonEmpty(raw.fixture.path, `task ${raw.id}.fixture.path`));
  const commit = nonEmpty(raw.fixture.commit, `task ${raw.id}.fixture.commit`);
  if (!/^[a-f0-9]{40}$/u.test(commit)) fail(`task ${raw.id}.fixture.commit must be a full 40-character Git commit`);
  if (raw.fixture.format !== undefined && raw.fixture.format !== "source") {
    fail(`task ${raw.id}.fixture.format must be source when present`);
  }
  nonEmpty(raw.publicTask, `task ${raw.id}.publicTask`);
  commandList(raw.setup ?? [], `task ${raw.id}.setup`);
  if (!Array.isArray(raw.hiddenTests) || raw.hiddenTests.length === 0) fail(`task ${raw.id}.hiddenTests must not be empty`);
  const testIds = new Set();
  const hiddenTests = raw.hiddenTests.map((test, index) => {
    object(test, `task ${raw.id}.hiddenTests[${index}]`);
    asciiIdentifier(test.id, "hidden test id");
    if (testIds.has(test.id)) fail(`duplicate hidden test id ${test.id}`);
    testIds.add(test.id);
    const command = commandValue(test.command, `hidden test ${test.id}.command`);
    const executor = test.executor ?? "agent";
    if (executor !== "agent") fail(`hidden test ${test.id}.executor must be agent`);
    const assetsPath = test.assetsPath ? resolve(dirname(path), test.assetsPath) : undefined;
    const frameworkAssetsPath = test.frameworkAssetsPath ? resolve(dirname(path), test.frameworkAssetsPath) : undefined;
    if (frameworkAssetsPath && !assetsPath) fail(`hidden test ${test.id}.frameworkAssetsPath requires assetsPath`);
    return {
      ...test,
      command,
      executor,
      ...(assetsPath ? { assetsPath } : {}),
      ...(frameworkAssetsPath ? { frameworkAssetsPath } : {}),
    };
  });
  return {
    ...raw,
    sourcePath: path,
    ...(environmentProfile ? { environmentProfile } : {}),
    runtimeEnv,
    execution,
    fixture: { ...raw.fixture, path: fixturePath },
    setup: raw.setup ?? [],
    hiddenTests,
    testIds,
    snapshotExcludes: raw.snapshotExcludes ?? [".git", "node_modules", ".cache"],
  };
}

function taskExecution(task, environmentProfile) {
  const label = `task ${task.id}`;
  if (task.execution !== undefined) fail(`${label}.execution is not supported`);
  if (task.image !== undefined && environmentProfile) fail(`${label}.image and environmentProfile are mutually exclusive`);
  if (task.image === undefined && !environmentProfile) fail(`${label} must declare image or environmentProfile`);
  return {
    kind: "legacy-oci",
    readiness: "executable",
    image: environmentProfile?.image ?? immutableImage(task.image, `${label}.image`),
  };
}

async function validateChecklist(path, task, persona) {
  const raw = await readJson(path);
  object(raw, `checklist ${path}`);
  exactVersion(raw.schemaVersion, "checklist");
  if (raw.taskId !== task.id) fail(`checklist ${path} has the wrong taskId`);
  if (raw.personaId !== persona.id) fail(`checklist ${path} has the wrong personaId`);
  if (!Array.isArray(raw.items) || raw.items.length === 0) fail(`checklist ${path} has no items`);
  const ids = new Set();
  for (const item of raw.items) {
    object(item, `checklist item`);
    id(item.id, "checklist item id");
    if (ids.has(item.id)) fail(`duplicate checklist item ${item.id}`);
    ids.add(item.id);
    nonEmpty(item.requirement, `checklist ${item.id}.requirement`);
    if (!["correctness", "persona"].includes(item.category)) fail(`checklist ${item.id}.category must be correctness or persona`);
    if (!Number.isFinite(item.weight) || item.weight <= 0) fail(`checklist ${item.id}.weight must be positive`);
    if (item.testGates !== undefined && !Array.isArray(item.testGates)) fail(`checklist ${item.id}.testGates must be an array`);
    for (const gate of item.testGates ?? []) {
      nonEmpty(gate, `checklist ${item.id}.testGates`);
      if (!task.testIds.has(gate)) fail(`checklist ${item.id} references unknown test gate ${gate}`);
    }
  }
  return raw;
}

function validateBudgets(value) {
  object(value, "experiment.budgets");
  integer(value.taskTurns, 1, 120, "budgets.taskTurns");
  integer(value.evolutionTurns, 1, 10, "budgets.evolutionTurns");
  integer(value.projectTimeoutMs, 60_000, 24 * 60 * 60 * 1000, "budgets.projectTimeoutMs");
  integer(value.commandTimeoutMs, 1_000, value.projectTimeoutMs, "budgets.commandTimeoutMs");
  return value;
}

function validateModel(value, label, expectedModel, expectedEffort) {
  object(value, label);
  if (value.model !== expectedModel) fail(`${label}.model must be ${expectedModel}`);
  if (value.effort !== expectedEffort) fail(`${label}.effort must be ${expectedEffort}`);
}

function validateRemoteModel(value, label, expectedModel) {
  object(value, label);
  if (value.model !== expectedModel) fail(`${label}.model must be ${expectedModel}`);
  for (const key of ["baseUrlEnv", "apiKeyEnv"]) nonEmpty(value[key], `${label}.${key}`);
}

function uniquePaths(value, label, base) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  return value.map((path, index) => resolve(base, nonEmpty(path, `${label}[${index}]`)));
}

function uniqueIds(values, label) {
  const ids = new Set();
  for (const value of values) {
    if (ids.has(value.id)) fail(`duplicate ${label} id ${value.id}`);
    ids.add(value.id);
  }
}

function commandList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  value.forEach((entry, index) => commandValue(entry, `${label}[${index}]`));
}

function commandValue(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty argv array`);
  return value.map((part, index) => nonEmpty(part, `${label}[${index}]`));
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function exactVersion(value, label) {
  if (value !== 1) fail(`${label}.schemaVersion must be 1`);
}

function id(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function asciiIdentifier(value, label) {
  const result = nonEmpty(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(result)) fail(`${label} must be an ASCII identifier of at most 64 characters`);
  return result;
}

function sha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be a lowercase SHA256`);
  return value;
}

function immutableImage(value, label) {
  const image = nonEmpty(value, label);
  if (!/^sha256:[a-f0-9]{64}$/u.test(image) && !/@sha256:[a-f0-9]{64}$/u.test(image)) {
    fail(`${label} must use an immutable sha256 digest`);
  }
  return image;
}

function isInside(parent, candidate) {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} must be between ${minimum} and ${maximum}`);
}

function fail(message) {
  throw new BenchError("invalid_manifest", message);
}
