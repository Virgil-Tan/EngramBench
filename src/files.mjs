import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { BenchError } from "./errors.mjs";

export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new BenchError("invalid_json", `Cannot read JSON ${path}: ${error.message}`);
  }
}

export async function writeJsonAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, path);
}

export async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveInside(base, candidate, label = "path") {
  const absolute = resolve(base, candidate);
  const rel = relative(resolve(base), absolute);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return absolute;
  throw new BenchError("unsafe_path", `${label} escapes its allowed root`);
}

export async function assertRegularFile(path, label = path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw new BenchError("missing_file", `${label} does not exist`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new BenchError("unsafe_file", `${label} must be a regular file`);
  }
}

export async function copyTree(source, target, excludes = []) {
  await rm(target, { recursive: true, force: true });
  const excluded = new Set(excludes);
  await cp(source, target, {
    recursive: true,
    preserveTimestamps: true,
    filter(path) {
      if (path === source) return true;
      const rel = relative(source, path);
      return !rel.split(sep).some((part) => excluded.has(part));
    },
  });
}

export async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const marker = join(path, ".frontal-benchmark-root");
  try {
    const handle = await open(marker, "wx", 0o600);
    await handle.writeFile("frontal-benchmark/v1\n");
    await handle.close();
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  return path;
}
