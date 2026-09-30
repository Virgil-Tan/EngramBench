import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { BenchError } from "./errors.mjs";
import { assertRegularFile, readJson, resolveInside, sha256File } from "./files.mjs";

const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const PLATFORM = /^linux\/(?:amd64|arm64)$/u;
const IMMUTABLE_IMAGE = /^(?:[a-zA-Z0-9][a-zA-Z0-9._/:@-]*@)?sha256:[a-f0-9]{64}$/u;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;
export async function loadEnvironmentCatalog(catalogPath) {
  const sourcePath = resolve(catalogPath);
  await assertRegularFile(sourcePath, "environment catalog");
  const raw = await readJson(sourcePath);
  exactObject(raw, ["schemaVersion", "profiles"], "environment catalog");
  if (raw.schemaVersion !== 1) fail("environment catalog.schemaVersion must be 1");
  if (!Array.isArray(raw.profiles) || raw.profiles.length === 0) fail("environment catalog.profiles must be a non-empty array");

  const keys = new Set();
  const profiles = raw.profiles.map((profile, index) => {
    const label = `environment catalog.profiles[${index}]`;
    exactObject(profile, ["id", "version", "platform", "image", "context", "contextSha256", "capabilities", "runtime"], label);
    const id = identifier(profile.id, `${label}.id`);
    const version = integer(profile.version, 1, 1_000_000, `${label}.version`);
    const platform = platformValue(profile.platform, `${label}.platform`);
    const key = `${id}\0${version}\0${platform}`;
    if (keys.has(key)) fail(`duplicate environment profile ${id}@${version} for ${platform}`);
    keys.add(key);
    const context = nonEmpty(profile.context, `${label}.context`);
    const contextPath = resolveInside(dirname(sourcePath), context, `${label}.context`);
    const capabilities = stringList(profile.capabilities, `${label}.capabilities`);
    const runtime = runtimePolicy(profile.runtime, `${label}.runtime`);
    return {
      id,
      version,
      platform,
      image: immutableImage(profile.image, `${label}.image`),
      context,
      contextPath,
      contextSha256: sha256(profile.contextSha256, `${label}.contextSha256`),
      capabilities,
      runtime,
    };
  });

  return {
    schemaVersion: 1,
    sourcePath,
    sha256: await sha256File(sourcePath),
    profiles,
  };
}

export async function resolveEnvironmentProfile(reference, taskSourcePath) {
  exactObject(reference, ["catalog", "id", "version", "platform"], "task.environmentProfile");
  const catalogPath = resolve(dirname(taskSourcePath), nonEmpty(reference.catalog, "task.environmentProfile.catalog"));
  const catalog = await loadEnvironmentCatalog(catalogPath);
  const id = identifier(reference.id, "task.environmentProfile.id");
  const version = integer(reference.version, 1, 1_000_000, "task.environmentProfile.version");
  const platform = platformValue(reference.platform, "task.environmentProfile.platform");
  const profile = catalog.profiles.find((candidate) => candidate.id === id
    && candidate.version === version
    && candidate.platform === platform);
  if (!profile) fail(`unknown environment profile ${id}@${version} for ${platform}`);
  const actualContextSha256 = await hashEnvironmentContext(profile.contextPath);
  if (actualContextSha256 !== profile.contextSha256) {
    fail(`environment profile ${id}@${version} context hash does not match catalog`);
  }
  return {
    ...profile,
    catalogPath: catalog.sourcePath,
    catalogSha256: catalog.sha256,
  };
}

export function validateRuntimeEnv(value, label = "task.runtimeEnv") {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([name, entry]) => {
    if (!ENVIRONMENT_NAME.test(name)) fail(`${label} contains invalid environment variable ${name}`);
    if (typeof entry !== "string" || /[\r\n\0]/u.test(entry)) {
      fail(`${label}.${name} must be a string without CR, LF, or NUL bytes`);
    }
    return [name, entry];
  }));
}

export function taskContainerOptions(task, extraEnv = {}) {
  const profile = task.environmentProfile;
  return {
    env: { ...(task.runtimeEnv ?? {}), ...extraEnv },
    ...(profile ? {
      platform: profile.platform,
      workdir: profile.runtime.workdir,
      networkPolicy: profile.runtime.networkPolicy,
      readiness: profile.runtime.readiness,
      tmpfs: profile.runtime.tmpfs,
      resources: profile.runtime.resources,
    } : {}),
  };
}

export function taskEnvironmentEvidence(task) {
  const profile = task.environmentProfile;
  if (!profile) {
    return {
      kind: task.execution.kind,
      readiness: task.execution.readiness,
      ...(task.execution.image ? { image: task.execution.image } : {}),
    };
  }
  return {
    kind: "environment-profile",
    profileId: profile.id,
    profileVersion: profile.version,
    platform: profile.platform,
    image: profile.image,
    contextSha256: profile.contextSha256,
    catalogSha256: profile.catalogSha256,
    capabilities: profile.capabilities,
    runtime: profile.runtime,
  };
}

export async function hashEnvironmentContext(contextPath) {
  const root = resolve(contextPath);
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) fail(`environment context contains symlink ${relative(root, path)}`);
      if (metadata.isDirectory()) await visit(path);
      else if (metadata.isFile()) files.push(path);
      else fail(`environment context contains unsupported entry ${relative(root, path)}`);
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const path of files) {
    const name = relative(root, path).split(sep).join("/");
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runtimePolicy(value, label) {
  exactObject(value, ["workdir", "networkPolicy", "readiness", "tmpfs", "resources"], label);
  const workdir = nonEmpty(value.workdir, `${label}.workdir`);
  if (!workdir.startsWith("/") || workdir.includes("\0")) fail(`${label}.workdir must be an absolute container path`);
  if (value.networkPolicy !== "ephemeral-bridge") fail(`${label}.networkPolicy must be ephemeral-bridge`);
  exactObject(value.readiness, ["command", "timeoutMs", "intervalMs"], `${label}.readiness`);
  const readiness = {
    command: stringList(value.readiness.command, `${label}.readiness.command`),
    timeoutMs: integer(value.readiness.timeoutMs, 1_000, 300_000, `${label}.readiness.timeoutMs`),
    intervalMs: integer(value.readiness.intervalMs, 25, 5_000, `${label}.readiness.intervalMs`),
  };
  if (!Array.isArray(value.tmpfs) || value.tmpfs.length === 0) fail(`${label}.tmpfs must be a non-empty array`);
  const tmpfs = value.tmpfs.map((entry, index) => {
    const entryLabel = `${label}.tmpfs[${index}]`;
    exactObject(entry, ["target", "sizeMiB"], entryLabel);
    const target = nonEmpty(entry.target, `${entryLabel}.target`);
    if (!target.startsWith("/") || target.includes("\0") || target.includes(",")) {
      fail(`${entryLabel}.target must be an absolute container path without commas`);
    }
    return { target, sizeMiB: integer(entry.sizeMiB, 16, 65_536, `${entryLabel}.sizeMiB`) };
  });
  if (new Set(tmpfs.map(({ target }) => target)).size !== tmpfs.length) fail(`${label}.tmpfs targets must be unique`);
  exactObject(value.resources, ["cpus", "memoryMiB"], `${label}.resources`);
  return {
    workdir,
    networkPolicy: value.networkPolicy,
    readiness,
    tmpfs,
    resources: {
      cpus: integer(value.resources.cpus, 1, 64, `${label}.resources.cpus`),
      memoryMiB: integer(value.resources.memoryMiB, 256, 262_144, `${label}.resources.memoryMiB`),
    },
  };
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must have exactly ${expected.join(", ")}`);
  }
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(`${label} must be a non-empty array`);
  const entries = value.map((entry, index) => nonEmpty(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) fail(`${label} must not contain duplicates`);
  return entries;
}

function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function platformValue(value, label) {
  if (typeof value !== "string" || !PLATFORM.test(value)) fail(`${label} must be linux/amd64 or linux/arm64`);
  return value;
}

function immutableImage(value, label) {
  const image = nonEmpty(value, label);
  if (!IMMUTABLE_IMAGE.test(image)) fail(`${label} must use an immutable sha256 digest`);
  return image;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(`${label} must be a lowercase SHA256`);
  return value;
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value.trim();
}

function fail(message) {
  throw new BenchError("invalid_manifest", message);
}
