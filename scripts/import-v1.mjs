#!/usr/bin/env node
// One-time, lossless import. Never reads runs, credentials, or model outputs.
import { cp, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, relative } from 'node:path';

const destination = resolve(import.meta.dirname, '..');
if (!process.argv[2]) throw new Error('Usage: import-v1.mjs /absolute/path/to/original-source');
const source = resolve(process.argv[2]);
if (source === destination) throw new Error('Source and destination must differ');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const taskText = await readFile(join(source, 'TASKS.md'), 'utf8');
const learning = taskText.split('## 二、')[0];
const ids = [...learning.matchAll(/^### \d+\. .*（`([a-z0-9]+)`）/gm)].map((m) => m[1]);
if (ids.length !== 30 || new Set(ids).size !== 30) throw new Error('Canonical Learning inventory must contain exactly 30 distinct tasks');
const manifestPath = join(destination, 'provenance/import.json');
try { await lstat(manifestPath); throw new Error('Import already exists; refusing to overwrite'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const excluded = new Set(['node_modules', '.git', '.DS_Store', 'dist', '.env', '.repo_memory']);
const files = [];
async function copy(name) {
  const from = join(source, name), to = join(destination, name);
  const metadata = await lstat(from);
  if (excluded.has(name.split('/').at(-1))) return;
  if (metadata.isSymbolicLink()) throw new Error(`Refusing source symlink: ${name}`);
  if (metadata.isDirectory()) {
    for (const entry of (await readdir(from)).sort()) await copy(`${name}/${entry}`);
  } else if (metadata.isFile()) {
    await mkdir(resolve(to, '..'), { recursive: true });
    await cp(from, to, { errorOnExist: true, force: false });
    const before = sha(await readFile(from)), after = sha(await readFile(to));
    if (before !== after) throw new Error(`Copy hash mismatch: ${name}`);
    files.push({ path: name, sha256: before });
  }
}
// Only general modules and their local import closure, not experiment adapters.
const roots = ['scripts/run-general-codex-sequence.mjs', 'src/opencode-agent-driver.mjs',
  'src/task-evaluator-v2/runtime.mjs', 'src/task-evaluator-v2/execution.mjs',
  'src/task-evaluator-v2/scoring.mjs', 'src/general-experiment-arm.mjs'];
const visited = new Set();
async function closure(name) {
  if (visited.has(name)) return;
  visited.add(name);
  await copy(name);
  const text = await readFile(join(source, name), 'utf8');
  for (const match of text.matchAll(/(?:from\s+|import\s*\()\s*["'](\.[^"']+\.mjs)["']/g)) {
    const dependency = relative(source, resolve(source, name, '..', match[1]));
    if (dependency.startsWith('..')) throw new Error(`Import escapes source: ${name}`);
    await closure(dependency);
  }
}
for (const name of roots) await closure(name);
for (const name of ['templates/contract-first', 'environments', 'docker/general-agent-amd64.Dockerfile',
  'docker/fullstack-amd64.Dockerfile', 'hidden/hard-fullstack', 'package.json', 'package-lock.json']) {
  if (!visited.has(name)) {
    // Templates may have been pulled into the import closure already.
    if (name === 'templates/contract-first') {
      for (const file of await readdir(join(source, name))) if (!visited.has(`${name}/${file}`)) await copy(`${name}/${file}`);
    } else await copy(name);
  }
}
for (const id of ids) {
  await copy(`tasks/${id}`);
  await copy(`task-packages/legacy/${id}`);
  const lock = JSON.parse(await readFile(join(source, `task-packages/legacy/${id}/evaluator/runtime-lock.json`)));
  if (!files.some(file => file.path === lock.sourceManifest)) await copy(lock.sourceManifest);
}
await copy('scripts/check-conversation-harness.mjs');
await mkdir(join(destination, 'provenance'), { recursive: true });
await writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, source, importedAt: new Date().toISOString(),
  inventoryAuthority: 'TASKS.md / Learning section', tasks: ids, files }, null, 2) + '\n');
await writeFile(join(destination, 'learning-tasks.json'), JSON.stringify({ benchmarkVersion: 2, phase: 'learning', tasks: ids }, null, 2) + '\n');
await writeFile(join(destination, 'TASKS.md'), learning.replace('当前冻结的 43 个 Benchmark 任务：30 个 Learning 任务和 13 个 Transfer/Test 任务', 'Frontal Benchmark V2 的 30 个 Learning 任务（保持原任务顺序与业务需求）'));
console.log(JSON.stringify({ importedTasks: ids.length, copiedFiles: files.length, destination }));
