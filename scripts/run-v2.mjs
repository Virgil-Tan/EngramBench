#!/usr/bin/env node
import { cp, mkdir, readFile, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadTaskPackageV1 } from '../src/task-package-v1.mjs';
import { writeJsonAtomic } from '../src/files.mjs';
import { assertEvaluatorReleased } from '../src/evaluator-release.mjs';
import { LEARNING_TASK_ORDER, TASK_ORDER } from '../src/task-order.mjs';

const root = resolve(import.meta.dirname, '..');
export function validateProfile(profile, inventory) {
  if (profile.benchmarkVersion !== 2) throw new Error('Profile must explicitly select benchmarkVersion 2');
  if (!['baseline', 'native', 'guide'].includes(profile.arm)) throw new Error('arm must be baseline, native or guide');
  if (!/^[a-z0-9][a-z0-9._-]{0,80}$/.test(profile.runId ?? '')) throw new Error('Explicit safe runId required');
  if (!profile.taskIds?.length || new Set(profile.taskIds).size !== profile.taskIds.length || profile.taskIds.some(id => !inventory.includes(id))) throw new Error('Explicit, distinct V2 taskIds required');
  for (const key of ['ownerId', 'agentImage', 'authFile']) if (typeof profile[key] !== 'string' || !profile[key]) throw new Error(`Missing ${key}`);
  if (!profile.agent?.model || !profile.agent?.effort || !profile.user?.model || !profile.user?.baseUrlEnv || !profile.user?.apiKeyEnv) throw new Error('Agent/User model settings and provider environment names must be explicit');
  if (profile.arm === 'guide' && !profile.memoraxHomeSeed) throw new Error('Guide requires a dedicated MemoraX skill bank seed');
  if (profile.arm === 'native' && !profile.nativeSkillsRoot) throw new Error('Native requires an explicit skills directory');
  if (profile.evolution === true && profile.arm !== 'guide') throw new Error('Evolution requires the MemoraX integration; baseline/native remain execution-only');
  if (profile.evolution === true && profile.taskIds.some(id => !LEARNING_TASK_ORDER.includes(id))) throw new Error('Transfer tasks are execution-only; Skill Evolution is limited to Learning tasks');
  if (!['benchmark', 'development', 'migration-repair'].includes(profile.purpose ?? 'benchmark')) throw new Error('Unknown run purpose');
  if (profile.purpose === 'development' && profile.evolution !== false) throw new Error('Development requires explicit evolution:false until certified evaluation');
  if (profile.codexConfigFile !== undefined && (typeof profile.codexConfigFile !== 'string' || !profile.codexConfigFile.trim())) throw new Error('codexConfigFile must name an explicit independent provider configuration file');
  if (profile.ablationVariant !== undefined) {
    if (!['selector_direct', 'generic_advisor'].includes(profile.ablationVariant) || profile.arm !== 'guide') throw new Error('ablationVariant must be selector_direct or generic_advisor using guide transport');
    if (profile.evolution !== false) throw new Error('Component ablation requires explicit evolution:false');
  }
  if (profile.purpose === 'migration-repair') {
    if (profile.evolution === true) throw new Error('Migration repair defers Evolution until a certified evaluation');
    const sources = profile.sourceWorkspaces;
    if (!sources || Object.keys(sources).length !== profile.taskIds.length || profile.taskIds.some(id => typeof sources[id] !== 'string' || !sources[id].trim())) throw new Error('Migration requires one source workspace for each selected task');
    if (profile.migrationMode !== undefined && !['copy', 'in-place'].includes(profile.migrationMode)) throw new Error('migrationMode must be copy or in-place');
    if (profile.migrationMode === 'in-place') {
      const backups = profile.backupWorkspaces;
      if (!backups || Object.keys(backups).length !== profile.taskIds.length
        || profile.taskIds.some(id => typeof backups[id] !== 'string' || !isAbsolute(backups[id]) || !isAbsolute(sources[id]))) throw new Error('In-place migration requires absolute source and backup paths for every task');
      if (new Set(Object.values(sources).map(path => resolve(path))).size !== profile.taskIds.length
        || new Set(Object.values(backups).map(path => resolve(path))).size !== profile.taskIds.length) throw new Error('In-place migration requires distinct workspace and backup paths');
    } else if (profile.backupWorkspaces !== undefined) throw new Error('backupWorkspaces requires explicit in-place migration');
  } else if (profile.sourceWorkspaces || profile.migrationMode !== undefined || profile.backupWorkspaces !== undefined) throw new Error('Existing source workspaces require explicit migration-repair purpose');
  return profile;
}
/** Prepare and bind one run without starting its Coding Agent or evaluator. */
export async function prepareRun(profilePath, { env = process.env } = {}) {
  const file = resolve(profilePath), directory = dirname(file);
  const inventory = TASK_ORDER;
  const profile = validateProfile(JSON.parse(await readFile(file)), inventory);
  const requiredEnv = name => { if (!env[name]) throw new Error(`Set environment variable ${name}; do not put secrets in a profile`); return env[name]; };
  const packages = await Promise.all(profile.taskIds.map(async id => {
    const task = await loadTaskPackageV1(join(root, 'task-packages/v2', id));
    if ((profile.purpose ?? 'benchmark') === 'benchmark') await assertEvaluatorReleased(task.paths.root);
    if (profile.purpose === 'migration-repair' && !(await lstat(resolve(directory, profile.sourceWorkspaces[id]))).isDirectory()) throw new Error(`Migration source must be a directory: ${id}`);
    return { id, packageDigest: task.digests.package, planDigest: task.task.planDigest };
  }));
  const baseUrl = requiredEnv(profile.user.baseUrlEnv), apiKey = requiredEnv(profile.user.apiKeyEnv);
  const runRoot = join(root, 'runs', profile.runId), seed = join(runRoot, 'private-seed/codex');
  const recorded = join(runRoot, 'experiment.json');
  const identity = { ...profile, packages };
  let previous;
  try { previous = JSON.parse(await readFile(recorded)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous && JSON.stringify(previous) !== JSON.stringify(identity)) throw new Error('Run ID already binds different settings or task package digests; choose a new run ID');
  if (!previous) {
    const auth = resolve(directory, profile.authFile);
    if (!(await lstat(auth)).isFile()) throw new Error('authFile must be a regular credential file');
    await mkdir(seed, { recursive: true, mode: 0o700 });
    // Copy only the explicit credential and optional experiment provider file,
    // never their parent home's plugins, Skills, or session history.
    await cp(auth, join(seed, 'auth.json'), { force: false, errorOnExist: true });
    if (profile.codexConfigFile) {
      const config = resolve(directory, profile.codexConfigFile);
      if (!(await lstat(config)).isFile()) throw new Error('codexConfigFile must be a regular file');
      await cp(config, join(seed, 'config.toml'), { force: false, errorOnExist: true });
    }
    if (profile.arm === 'native') await cp(resolve(directory, profile.nativeSkillsRoot), join(seed, 'skills'), { recursive: true, dereference: true, filter: path => !['node_modules', '.git', '.env'].includes(path.split('/').at(-1)) });
    await writeJsonAtomic(recorded, identity);
  }
  Object.assign(env, {
    FRONTAL_RUNS_ROOT: join(root, 'runs'), FRONTAL_RUN_ID: profile.runId,
    FRONTAL_OWNER_ID: profile.ownerId, FRONTAL_AGENT_IMAGE: profile.agentImage,
    FRONTAL_AGENT_MODEL: profile.agent.model, FRONTAL_AGENT_EFFORT: profile.agent.effort,
    FRONTAL_USER_MODEL: profile.user.model, FRONTAL_USER_THINKING: String(profile.user.thinking ?? false),
    FRONTAL_USER_REASONING_EFFORT: profile.user.reasoningEffort ?? 'high',
    FRONTAL_MODEL_BASE_URL: baseUrl, FRONTAL_MODEL_API_KEY: apiKey,
    FRONTAL_CODEX_HOME_SEED: seed, FRONTAL_TASK_PACKAGES_ROOT: join(root, 'task-packages/v2'),
    FRONTAL_TASK_IDS: profile.taskIds.join(','), FRONTAL_COMPLETED_TASKS: '',
    FRONTAL_RUNTIME_GUIDE_ENABLED: String(profile.arm === 'guide'),
    FRONTAL_EXPERIMENT_ARM: profile.arm === 'guide' ? 'treatment' : profile.arm === 'native' ? 'ablation_native_skills' : 'baseline',
    FRONTAL_DEFER_EVOLUTION: String(profile.evolution !== true),
    FRONTAL_OCI_COMMAND: profile.dockerCommand ?? 'docker',
    FRONTAL_DOCKER_COMMAND: profile.dockerCommand ?? 'docker',
    FRONTAL_EVALUATOR_OCI_COMMAND: join(root, 'scripts/docker-native-amd64-evaluator.mjs'),
    FRONTAL_RUN_PURPOSE: profile.purpose ?? 'benchmark',
  });
  delete env.FRONTAL_MIGRATION_SOURCES;
  delete env.FRONTAL_MIGRATION_MODE;
  delete env.FRONTAL_MIGRATION_BACKUPS;
  if (profile.purpose === 'migration-repair') env.FRONTAL_MIGRATION_SOURCES = JSON.stringify(Object.fromEntries(profile.taskIds.map(id => [id, resolve(directory, profile.sourceWorkspaces[id])])));
  if (profile.migrationMode === 'in-place') {
    env.FRONTAL_MIGRATION_MODE = 'in-place';
    env.FRONTAL_MIGRATION_BACKUPS = JSON.stringify(profile.backupWorkspaces);
  }
  delete env.FRONTAL_TASK_PACKAGE_VARIANT_ROOT;
  delete env.FRONTAL_MEMORAX_HOME_SEED;
  delete env.FRONTAL_CODEX_PROXY;
  delete env.MEMORAX_ABLATION_VARIANT;
  if (profile.memoraxHomeSeed) env.FRONTAL_MEMORAX_HOME_SEED = resolve(directory, profile.memoraxHomeSeed);
  if (profile.proxyEnv) env.FRONTAL_CODEX_PROXY = requiredEnv(profile.proxyEnv);
  if (profile.ablationVariant) env.MEMORAX_ABLATION_VARIANT = profile.ablationVariant;
  return { profile, runRoot, seed };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Usage: npm run run -- profiles/my-run.json');
  await prepareRun(process.argv[2]);
  await import('./run-general-codex-sequence.mjs');
}
