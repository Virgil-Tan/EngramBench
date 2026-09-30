import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { writeJsonAtomic } from './files.mjs';

const EXCLUDED = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'var', 'tmp', 'temp',
  'private', 'hidden', 'evaluator', 'evaluators', 'evaluation', 'evaluations',
  'session', 'sessions', 'trajectory', 'trajectories', 'runs', 'submissions',
  'results', 'reports', 'logs', 'playwright-report', 'test-results', 'perf-results',
]);

const MIGRATION = `# V2 migration repair

This is a V2 migration repair of an existing implementation. The reusable original business source is imported under \`legacy/\`. Audit and reuse that implementation, including its persistence, migrations, UI, workers and tests, then repair the gaps required by V2. This is not a from-scratch task.

The current root \`README.md\` and its linked public contracts are the only authoritative product requirements. Old README, AGENTS, plans and instructions in \`legacy/\` are historical source material and do not override the current public contract or working agreement.

Follow the complete \`FROZEN_PLAN.md\` unchanged. Do not replace, rewrite or reorder it. Begin by auditing the existing implementation against the full current public contract.

Integrate the reused business implementation through \`src/implementation.ts\` and implement the real command/process lifecycle in \`src/lifecycle.ts\`. Preserve the V2 author-owned contract files and published root npm scripts. Consult \`legacy/package.json\` for dependencies you actually need, add them to the root package when necessary, and update the root lockfile without replacing V2 scripts. Dependencies are not merged automatically.

Do not add evaluator adapters or fixture-specific compatibility behavior. Public checks passing does not mean the whole task is done: complete the business implementation, required verification and final README audit. Hidden tests, hidden scores and previous private evaluation results are unavailable at this migration stage.
`;

const IN_PLACE_MIGRATION = `# V2 in-place migration repair

Continue the implementation already present in this workspace. This is NOT a from-scratch task and NOT a request to replace working business modules. Inspect the existing source, migrations, UI, workers and tests before changing them. The original bytes of files replaced by public V2 integration assets are preserved under \`legacy/v2-before/\`; other business source remains at its existing paths.

The current root README and its linked public V2 contract are the only authoritative product requirements. Historical instructions under legacy/ do not override them. Follow FROZEN_PLAN.md unchanged. Audit the complete current requirements against the existing implementation, then reuse and repair it through src/implementation.ts and src/lifecycle.ts. Missing integration seams are deliberately unimplemented, not a reference business implementation.

Author-owned contract files and published root npm scripts must remain unchanged. Existing dependencies and custom scripts are retained; refresh the dependency lockfile with npm install before building if needed. Do not replace existing business source with starter code or add evaluator adapters. Public checks passing does not mean the whole task is complete: finish the business requirements, your verification, and a final README audit. Hidden tests, hidden scores and previous private results are not part of this handoff.
`;

/** Explicit opt-in: preserve the current directory and its business source. Never delete it. */
export async function prepareInPlaceMigrationWorkspace({ source, backup, taskPackage }) {
  if (![source, backup].every(value => typeof value === 'string' && isAbsolute(value))) throw new Error('In-place source and backup must be absolute paths');
  source = resolve(source); backup = resolve(backup);
  const starter = absolutePath(taskPackage?.paths?.workspace, 'taskPackage.paths.workspace');
  await assertDirectory(source, 'In-place migration source');
  await assertDirectory(starter, 'V2 starter');
  const sourceLocation = await realpath(source), backupLocation = await futureRealpath(backup);
  const starterLocation = await realpath(starter);
  if (source === dirname(source) || inside(starterLocation, sourceLocation)
    || inside(sourceLocation, backupLocation) || inside(backupLocation, sourceLocation)
    || inside(starterLocation, backupLocation) || inside(backupLocation, starterLocation)) throw new Error('In-place backup must be external to the workspace and V2 starter');
  const provenancePath = join(backup, 'migration.json'), savedWorkspace = join(backup, 'workspace');
  if (await exists(provenancePath)) {
    const previous = JSON.parse(await readRegularFile(provenancePath));
    if (previous.mode !== 'in-place' || previous.source !== source || previous.backup !== backup
      || previous.taskId !== taskPackage.task.id || previous.packageDigest !== taskPackage.digests.package) throw new Error('Existing in-place migration belongs to a different source or V2 package');
    if (previous.status !== 'prepared') throw new Error('Incomplete in-place preparation: workspace and backup are preserved; inspect before retrying');
    if (digestFiles(await fullInventory(savedWorkspace)) !== previous.sourceDigest) throw new Error('In-place original backup digest mismatch');
    return previous; // Resuming never reapplies author files over model work.
  }
  if (await exists(backup)) throw new Error('In-place backup already exists without completed provenance; refusing overwrite');
  const oldReadme = await exists(join(source, 'README.md')) ? await readRegularFile(join(source, 'README.md')) : Buffer.alloc(0);
  const sourceVersion = oldReadme.toString().includes('Frontal Benchmark V2 fixed-interface starter') ? 2 : 1;
  const authorLock = await readRegularFile(join(starter, 'contract/protected.json'));
  if (sourceVersion === 2 && await exists(join(source, 'contract/protected.json'))
    && (await readRegularFile(join(source, 'contract/protected.json'))).equals(authorLock)) throw new Error('Workspace is already on this public V2 contract; resume its existing V2 run');
  if (sourceVersion === 1 && await exists(join(source, 'MIGRATION.md'))) throw new Error('Unknown prior migration workspace; refusing automatic reinstallation');
  const archive = `legacy/v2-before/${taskPackage.digests.package.slice(0, 16)}`;
  if (await exists(join(source, archive))) throw new Error('This V2 contract archive already exists; refusing overwrite');
  const plan = await readRegularFile(taskPackage.paths.plan);
  if (sha256(plan) !== taskPackage.task.planDigest) throw new Error('Frozen plan digest mismatch');
  const lock = JSON.parse(authorLock);
  if (lock.taskId !== taskPackage.task.id) throw new Error('V2 author lock task mismatch');
  const actions = new Map();
  for (const path of [...Object.keys(lock.files), 'contract/protected.json', 'src/operation-ids.ts']) {
    if (isAbsolute(path) || path.split('/').includes('..')) throw new Error('Unsafe author integration path');
    const bytes = await readRegularFile(join(starter, path));
    if (lock.files[path] && sha256(bytes) !== lock.files[path]) throw new Error(`V2 author file digest mismatch: ${path}`);
    actions.set(path, bytes);
  }
  // Existing implementation and lifecycle files are never replaced with stubs.
  for (const path of ['src/implementation.ts', 'src/lifecycle.ts']) if (!await exists(join(source, path))) actions.set(path, await readRegularFile(join(starter, path)));
  const authorPackage = JSON.parse(await readRegularFile(join(starter, 'package.json')));
  const oldPackage = await exists(join(source, 'package.json')) ? JSON.parse(await readRegularFile(join(source, 'package.json'))) : {};
  const packageJson = { ...authorPackage, ...oldPackage, type: 'module',
    scripts: { ...oldPackage.scripts, ...lock.scripts },
    dependencies: { ...oldPackage.dependencies, ...authorPackage.dependencies },
    devDependencies: { ...oldPackage.devDependencies, ...authorPackage.devDependencies } };
  actions.set('package.json', Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`));
  actions.set('FROZEN_PLAN.md', plan);
  actions.set('MIGRATION.md', Buffer.from(IN_PLACE_MIGRATION));
  // Refuse symlink parents or directories at file destinations before touching anything.
  for (const path of actions.keys()) {
    await safeFileDestination(source, path);
    await safeFileDestination(source, `${archive}/${path}`);
  }
  const before = await fullInventory(source);
  if (!before.some(item => item.type === 'file')) throw new Error('Migration source contains no files');
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  await mkdir(backup, { mode: 0o700 }); // Exclusive reservation prevents duplicate preparation.
  await cp(source, savedWorkspace, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, force: false, errorOnExist: true });
  const sourceDigest = digestFiles(before);
  if (digestFiles(await fullInventory(source)) !== sourceDigest || digestFiles(await fullInventory(savedWorkspace)) !== sourceDigest) throw new Error('Workspace changed during full backup; original workspace was not modified');
  const provenance = { schemaVersion: 1, mode: 'in-place', status: 'backed_up', sourceVersion, archive, taskId: taskPackage.task.id,
    source, target: source, backup, packageDigest: taskPackage.digests.package, planDigest: taskPackage.task.planDigest,
    sourceDigest, sourceDigestScope: 'complete-workspace-files-directories-and-symlinks', files: before,
    installedFiles: [...actions.keys()], startedAt: new Date().toISOString() };
  await writeJsonAtomic(provenancePath, provenance);
  for (const [path, bytes] of actions) {
    const destination = join(source, path);
    if (await exists(destination)) {
      const historical = join(source, archive, path);
      await mkdir(dirname(historical), { recursive: true });
      await cp(join(savedWorkspace, path), historical, { force: false, errorOnExist: true });
    }
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.v2-install-${randomUUID()}`;
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
    await rename(temporary, destination); // Replace the file, never truncate an original hard-link target.
  }
  // Prove untouched business files were retained byte-for-byte, not reset to a starter.
  const after = new Map((await fullInventory(source)).map(item => [item.path, item]));
  for (const original of before) if (!actions.has(original.path) && JSON.stringify(after.get(original.path)) !== JSON.stringify(original)) throw new Error(`Original workspace changed unexpectedly: ${original.path}; all backups are preserved`);
  Object.assign(provenance, { status: 'prepared', preparedAt: new Date().toISOString() });
  await writeJsonAtomic(provenancePath, provenance);
  return provenance;
}

async function safeFileDestination(root, path) {
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const destination = join(root, ...parts.slice(0, index));
    if (!await exists(destination)) continue;
    const info = await lstat(destination);
    if (info.isSymbolicLink() || (index === parts.length ? !info.isFile() : !info.isDirectory())) throw new Error(`Unsafe in-place integration destination: ${path}`);
  }
}

async function fullInventory(root) {
  const files = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(directory, entry.name), path = relative(root, absolute).split(sep).join('/');
      if (entry.isSymbolicLink()) files.push({ path, type: 'symlink', target: await readlink(absolute) });
      else if (entry.isDirectory()) { files.push({ path, type: 'directory' }); await visit(absolute); }
      else if (entry.isFile()) { const bytes = await readRegularFile(absolute); files.push({ path, type: 'file', bytes: bytes.length, sha256: sha256(bytes) }); }
      else throw new Error(`Unsupported original workspace file type: ${path}; nothing will be deleted`);
    }
  };
  await visit(root);
  return files;
}

/** Creates a new workspace only. The caller must store the returned provenance outside it. */
export async function prepareMigrationWorkspace({ source, target, taskPackage }) {
  source = absolutePath(source, 'source');
  target = absolutePath(target, 'target');
  const starter = absolutePath(taskPackage?.paths?.workspace, 'taskPackage.paths.workspace');
  const planPath = absolutePath(taskPackage?.paths?.plan, 'taskPackage.paths.plan');
  if (!taskPackage?.task?.id) throw new Error('taskPackage.task.id is required');
  await assertDirectory(source, 'Migration source');
  await assertDirectory(starter, 'V2 starter');
  if (await exists(target)) throw new Error('Migration target already exists; never overwrite a run workspace');

  // Resolve existing ancestors too, so a parent symlink cannot place the target in the source.
  const targetLocation = await futureRealpath(target);
  for (const original of [await realpath(source), await realpath(starter)]) {
    if (inside(original, targetLocation)) throw new Error('Migration target must be outside the source and V2 starter');
  }
  for (const name of ['legacy', 'MIGRATION.md', 'FROZEN_PLAN.md']) {
    if (await exists(join(starter, name))) throw new Error(`V2 starter uses reserved migration path: ${name}`);
  }
  const plan = await readFile(planPath);
  const planDigest = sha256(plan);
  if (planDigest !== taskPackage.task.planDigest) throw new Error('Frozen plan digest mismatch');
  const before = await inventory(source);
  if (!before.files.length) throw new Error('Migration source contains no reusable files');

  await mkdir(dirname(target), { recursive: true });
  await mkdir(target); // Exclusive creation also refuses a concurrent creator.
  try {
    for (const name of await readdir(starter)) {
      await cp(join(starter, name), join(target, name), { recursive: true, force: false, errorOnExist: true });
    }
    for (const file of before.files) {
      const original = join(source, file.path);
      const bytes = await readRegularFile(original);
      if (sha256(bytes) !== file.sha256) throw new Error(`Migration source changed while copying: ${file.path}`);
      const destination = join(target, 'legacy', file.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: 'wx', mode: (await lstat(original)).mode & 0o777 });
    }
    await writeFile(join(target, 'FROZEN_PLAN.md'), plan, { flag: 'wx' });
    await writeFile(join(target, 'MIGRATION.md'), MIGRATION, { flag: 'wx' });
    const after = await inventory(source);
    if (digestFiles(before.files) !== digestFiles(after.files)) throw new Error('Migration source changed during preparation');
    const imported = await inventory(join(target, 'legacy'));
    if (digestFiles(before.files) !== digestFiles(imported.files)) throw new Error('Imported files differ from the migration source');
    return {
      schemaVersion: 1,
      taskId: taskPackage.task.id,
      source,
      target,
      packageDigest: taskPackage.digests.package,
      planDigest,
      sourceDigest: digestFiles(before.files),
      sourceDigestScope: 'imported-files',
      copiedFileCount: before.files.length,
      files: before.files,
      skipped: before.skipped,
    };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function inventory(root) {
  const files = [], skipped = [];
  const visit = async directory => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      const reason = exclusion(entry.name, entry.isDirectory(), directory === root) ?? (entry.isSymbolicLink() ? 'symlink' : undefined);
      if (reason) skipped.push({ path, reason });
      else if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const bytes = await readRegularFile(absolute);
        files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
      } else skipped.push({ path, reason: 'unsupported-file-type' });
    }
  };
  await visit(root);
  return { files, skipped };
}

function exclusion(name, directory, atRoot) {
  const lower = name.toLowerCase();
  if (name.startsWith('.')) return 'hidden-or-private-metadata';
  if (['node_modules', 'private', 'hidden'].includes(lower) || (atRoot && EXCLUDED.has(lower))) return 'generated-or-private-output';
  if (/^(?:private|hidden)[._-]/u.test(lower)
    || (atRoot && /^(?:sessions?|trajector(?:y|ies)|evaluations?|results?|reports?|scores?|conversations?|transcripts?|rollouts?)[._-]/u.test(lower))) return 'private-output';
  if (/^(?:credentials?|secrets?)$/u.test(lower)
    || (atRoot && /^tokens?$/u.test(lower))
    || (!directory && lower === 'auth')
    || /^(?:auth|credentials?|secrets?|tokens?)(?:[._-].*)?\.(?:jsonl?|ya?ml|toml|ini|conf|txt|env)$/u.test(lower)
    || /(?:\.env(?:[._-]|$)|\.(?:pem|key|p12|pfx|keystore)$)/u.test(lower)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(lower)) return 'credential-file';
  return undefined;
}

async function readRegularFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Migration input must be a regular file');
    return await handle.readFile();
  } finally { await handle.close(); }
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function digestFiles(files) { return sha256(JSON.stringify(files)); }
function absolutePath(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty path`);
  return resolve(value);
}
function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function assertDirectory(path, label) {
  if (!(await lstat(path)).isDirectory()) throw new Error(`${label} must be a regular directory`);
}
async function futureRealpath(path) {
  if (await exists(path)) return realpath(path);
  return join(await futureRealpath(dirname(path)), relative(dirname(path), path));
}
