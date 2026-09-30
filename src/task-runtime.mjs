import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BenchError } from "./errors.mjs";
import { hashEnvironmentContext, loadEnvironmentCatalog } from "./environments.mjs";
import { validateLegacyEvaluatorLock } from "./legacy-process-evaluator.mjs";
import { validateV2EvaluatorLock } from "./task-package-v2-evaluator.mjs";

export async function resolveTaskRuntime(taskPackage, {
  catalogPath = fileURLToPath(new URL("../environments/catalog.v1.json", import.meta.url)),
  legacyRepositoryRoot,
  repositoryRoot,
  platform,
} = {}) {
  const reference = taskPackage?.manifest?.environment;
  const match = /^([a-z0-9][a-z0-9._-]{0,63})@([1-9][0-9]*)$/u.exec(reference ?? "");
  if (!match) throw new BenchError("invalid_task_runtime", "Task Package environment is invalid");
  const [, id, versionText] = match;
  const version = Number(versionText);
  const catalog = await loadEnvironmentCatalog(catalogPath);
  const candidates = catalog.profiles.filter((entry) => entry.id === id
    && entry.version === version
    && (!platform || entry.platform === platform));
  if (candidates.length !== 1) {
    throw new BenchError("invalid_task_runtime", `Cannot resolve one environment profile for ${reference}`);
  }
  const profile = candidates[0];
  if (await hashEnvironmentContext(profile.contextPath) !== profile.contextSha256) {
    throw new BenchError("environment_context_mismatch", `${reference} context does not match the catalog`);
  }

  const lockPath = join(taskPackage.paths.root, "evaluator", "runtime-lock.json");
  const lockKind = await exists(lockPath)
    ? JSON.parse(await readFile(lockPath, "utf8")).kind
    : undefined;
  const legacy = lockKind === "frontal-legacy-evaluator-lock"
    ? await validateLegacyEvaluatorLock(lockPath, { repositoryRoot: legacyRepositoryRoot ?? repositoryRoot })
    : undefined;
  const v2 = lockKind === "frontal-v2-evaluator-lock"
    ? await validateV2EvaluatorLock(lockPath, { repositoryRoot: repositoryRoot ?? legacyRepositoryRoot })
    : undefined;
  if (lockKind && !legacy && !v2) throw new BenchError("invalid_task_runtime", `Unsupported evaluator runtime lock: ${lockKind}`);
  if (legacy?.task.environmentProfile
    && (legacy.task.environmentProfile.id !== profile.id
      || legacy.task.environmentProfile.version !== profile.version
      || legacy.task.environmentProfile.platform !== profile.platform)) {
    throw new BenchError("invalid_task_runtime", "Adapted legacy task runtime does not match task.json");
  }
  const containerEnv = legacy?.task.runtimeEnv ?? v2?.source.runtimeEnv ?? {};
  const runtime = {
    profile: {
      id: profile.id,
      version: profile.version,
      platform: profile.platform,
      image: profile.image,
      contextSha256: profile.contextSha256,
      runtime: profile.runtime,
    },
    containerEnv,
    legacy: legacy ? {
      sourceManifest: legacy.lock.sourceManifest,
      setup: legacy.task.setup,
      snapshotExcludes: legacy.task.snapshotExcludes,
    } : undefined,
    v2: v2 ? {
      sourceManifest: v2.lock.sourceManifest,
      setup: v2.source.setup ?? [],
      snapshotExcludes: v2.source.snapshotExcludes ?? [],
    } : undefined,
  };
  return {
    ...runtime,
    digest: createHash("sha256").update(JSON.stringify(runtime)).digest("hex"),
  };
}

async function exists(path) {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
