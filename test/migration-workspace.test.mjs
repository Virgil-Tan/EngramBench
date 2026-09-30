import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, link, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadTaskPackageV1 } from '../src/task-package-v1.mjs';
import { prepareMigrationWorkspace, prepareInPlaceMigrationWorkspace } from '../src/migration-workspace.mjs';
import { checkSource } from '../templates/contract-first/check.mjs';

const root = resolve(import.meta.dirname, '..');
const taskPromise = loadTaskPackageV1(join(root, 'task-packages/v2/queueforge'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'frontal-v2-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), target = join(directory, 'target');
  await mkdir(source);
  const put = async (path, bytes) => {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), bytes);
  };
  return { directory, source, target, put, taskPackage: await taskPromise };
}

test('imports original bytes while preserving every V2 starter file and frozen plan', async t => {
  const fixtureData = await fixture(t);
  const { source, target, put, taskPackage } = fixtureData;
  const business = Buffer.from([0, 13, 10, 255, 65]);
  await put('src/implementation.ts', business);
  await put('package.json', '{"dependencies":{"legacy-library":"1.0.0"}}\n');
  await put('README.md', 'Old implementation documentation\n');
  await put('contract/server.mjs', 'Old server\n');
  const manifest = await prepareMigrationWorkspace(fixtureData);
  for (const path of await readdir(taskPackage.paths.workspace, { recursive: true, withFileTypes: true })) {
    if (!path.isFile()) continue;
    const original = join(path.parentPath, path.name);
    const copied = join(target, original.slice(taskPackage.paths.workspace.length + 1));
    assert.deepEqual(await readFile(copied), await readFile(original));
  }
  assert.deepEqual(await readFile(join(target, 'legacy/src/implementation.ts')), business);
  assert.deepEqual(await readFile(join(source, 'src/implementation.ts')), business);
  assert.deepEqual(await readFile(join(target, 'FROZEN_PLAN.md')), await readFile(taskPackage.paths.plan));
  assert.equal(manifest.taskId, 'queueforge');
  assert.equal(manifest.source, source);
  assert.equal(manifest.copiedFileCount, 4);
  assert.equal(manifest.sourceDigestScope, 'imported-files');
  assert.equal(manifest.sourceDigest, sha256(JSON.stringify(manifest.files)));
  assert.equal(manifest.files.find(file => file.path === 'src/implementation.ts').sha256, sha256(business));
  const migration = await readFile(join(target, 'MIGRATION.md'), 'utf8');
  for (const required of ['migration repair', 'not a from-scratch task', 'legacy/', 'src/implementation.ts', 'src/lifecycle.ts', 'FROZEN_PLAN.md', 'only authoritative', 'Public checks passing does not mean', 'Hidden tests, hidden scores']) assert(migration.includes(required), required);
  assert(!migration.includes(source));
  assert(!(await readdir(target)).some(name => /provenance|manifest|private/.test(name)));
  const second = await prepareMigrationWorkspace({ ...fixtureData, target: join(fixtureData.directory, 'second') });
  assert.equal(second.sourceDigest, manifest.sourceDigest);
  assert.deepEqual(second.files, manifest.files);
});

test('excludes private output, hidden metadata, credentials, generated files and all symlinks', async t => {
  const fixtureData = await fixture(t);
  const { source, target, put, directory } = fixtureData;
  await put('src/business.ts', 'export const business = true;\n');
  await put('src/auth.ts', 'export const authenticate = () => true;\n');
  const businessFiles = ['src/reports/report.ts', 'src/session/service.ts', 'src/tokens/token.ts', 'src/results/result.ts', 'src/evaluation/score.ts'];
  for (const path of businessFiles) await put(path, 'export const existingBusiness = true;\n');
  const excluded = [
    '.git/config', '.codex/sessions/session.jsonl', '.agents/SKILL.md', '.repo_memory/PROFILE.md',
    '.memorax-code/config.toml', '.memoryx-cache/state.json', '.env', '.env.local',
    'node_modules/library/index.js', 'dist/index.js', 'build/index.js', 'coverage/data.json',
    'var/state.db', 'tmp/output.json', 'private/result.json', 'hidden/test.mjs', 'reports/output.json',
    'sessions/run.jsonl', 'trajectories/run.json', 'evaluator/tests.mjs', 'test-results/result.json',
    'private-report.json', 'hidden-scores.json', 'auth.json', 'credentials.json', 'secrets.yaml',
    'id_rsa', 'certificate.key', 'server.pem', 'src/.env.production', 'src/credentials.json',
  ];
  for (const path of excluded) await put(path, 'DO NOT IMPORT');
  await writeFile(join(directory, 'outside.txt'), 'EXTERNAL SECRET');
  await symlink(join(directory, 'outside.txt'), join(source, 'external-file'));
  await symlink(directory, join(source, 'external-directory'));
  await symlink('src/business.ts', join(source, 'internal-link'));
  const manifest = await prepareMigrationWorkspace(fixtureData);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), ['src/auth.ts', 'src/business.ts', ...businessFiles].sort());
  assert.equal(manifest.copiedFileCount, 7);
  for (const path of businessFiles) assert.deepEqual(await readFile(join(target, 'legacy', path)), await readFile(join(source, path)));
  assert.deepEqual(manifest.skipped.filter(item => item.reason === 'symlink').map(item => item.path), ['external-directory', 'external-file', 'internal-link']);
  for (const path of excluded) assert(manifest.skipped.some(item => path === item.path || path.startsWith(`${item.path}/`)), path);
  for (const path of excluded) assert.equal(await readFile(join(source, path), 'utf8'), 'DO NOT IMPORT');
});

test('refuses existing targets and targets inside the source, including parent symlinks', async t => {
  const fixtureData = await fixture(t);
  const { source, target, put, directory } = fixtureData;
  await put('business.ts', 'existing code');
  await mkdir(target);
  await writeFile(join(target, 'keep.txt'), 'existing run');
  await assert.rejects(prepareMigrationWorkspace(fixtureData), /never overwrite/);
  assert.equal(await readFile(join(target, 'keep.txt'), 'utf8'), 'existing run');
  await assert.rejects(prepareMigrationWorkspace({ ...fixtureData, target: join(source, 'nested', 'target') }), /outside the source/);
  await symlink(source, join(directory, 'alias'));
  await assert.rejects(prepareMigrationWorkspace({ ...fixtureData, target: join(directory, 'alias', 'target') }), /outside the source/);
  await assert.rejects(prepareMigrationWorkspace({ ...fixtureData, source: join(source, 'business.ts'), target: join(directory, 'unused') }), /regular directory/);
  await assert.rejects(prepareMigrationWorkspace({ ...fixtureData, source: join(directory, 'alias'), target: join(directory, 'unused') }), /regular directory/);
  assert.deepEqual(await readdir(source), ['business.ts']);
});

test('in-place migration fully backs up original workspace, retains business code and installs only public integration assets', async t => {
  const { source, directory, put, taskPackage } = await fixture(t);
  const backup = join(directory, 'private-backup');
  await put('src/implementation.ts', 'export const actualBusiness = 42;\n');
  await put('src/lifecycle.ts', 'export const realWorker = true;\n');
  await put('src/service.ts', 'existing implementation must remain at this path\n');
  await put('package.json', JSON.stringify({ name: 'existing-product', type: 'commonjs', scripts: { custom: 'node custom.js', build: 'old-build' }, dependencies: { 'existing-dependency': '1.0.0' } }));
  await put('package-lock.json', 'original lockfile; model must refresh it\n');
  await put('README.md', 'historical README\n');
  await put('.git/HEAD', 'ref: refs/heads/original\n');
  await put('.env', 'private fake fixture, kept out of model-facing legacy\n');
  await put('node_modules/fixture/index.js', 'full backup includes existing dependencies\n');
  await symlink('src/service.ts', join(source, 'business-link'));
  const args = { source, backup, taskPackage };
  const manifest = await prepareInPlaceMigrationWorkspace(args);
  assert.equal(manifest.mode, 'in-place');
  assert.equal(manifest.status, 'prepared');
  assert.equal(manifest.target, source);
  for (const path of ['src/implementation.ts', 'src/lifecycle.ts', 'src/service.ts', 'package-lock.json', '.git/HEAD', '.env', 'node_modules/fixture/index.js']) assert.deepEqual(await readFile(join(source, path)), await readFile(join(backup, 'workspace', path)), path);
  assert.equal(await readlink(join(backup, 'workspace/business-link')), 'src/service.ts');
  assert.equal(manifest.sourceVersion, 1);
  assert.equal(await readFile(join(source, manifest.archive, 'README.md'), 'utf8'), 'historical README\n');
  assert(!manifest.installedFiles.includes('src/implementation.ts'));
  assert(!manifest.installedFiles.includes('src/lifecycle.ts'));
  assert(manifest.files.some(item => item.path === '.env'));
  await assert.rejects(readFile(join(source, manifest.archive, '.env')), { code: 'ENOENT' });
  const pkg = JSON.parse(await readFile(join(source, 'package.json')));
  assert.equal(pkg.name, 'existing-product');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dependencies['existing-dependency'], '1.0.0');
  assert.equal(pkg.scripts.custom, 'node custom.js');
  await checkSource(source, join(taskPackage.paths.root, 'public-contract'));
  assert.equal(await readFile(join(source, 'FROZEN_PLAN.md'), 'utf8'), await readFile(taskPackage.paths.plan, 'utf8'));
  // A resume validates provenance, but never overwrites later model changes.
  await writeFile(join(source, 'src/implementation.ts'), 'model continued here\n');
  assert.deepEqual(await prepareInPlaceMigrationWorkspace(args), manifest);
  assert.equal(await readFile(join(source, 'src/implementation.ts'), 'utf8'), 'model continued here\n');
  await assert.rejects(prepareInPlaceMigrationWorkspace({ ...args, backup: join(directory, 'duplicate') }), /already on this public V2/);
  await assert.rejects(prepareInPlaceMigrationWorkspace({ ...args, taskPackage: { ...taskPackage, digests: { package: 'different' } } }), /different source or V2 package/);
});

test('in-place adds missing integration seams without solving business behavior or deleting old implementation', async t => {
  const { source, directory, put, taskPackage } = await fixture(t);
  await put('server.js', 'module.exports = realBusiness;\n');
  await prepareInPlaceMigrationWorkspace({ source, backup: join(directory, 'backup'), taskPackage });
  assert.equal(await readFile(join(source, 'server.js'), 'utf8'), 'module.exports = realBusiness;\n');
  for (const path of ['src/implementation.ts', 'src/lifecycle.ts']) assert.deepEqual(await readFile(join(source, path)), await readFile(join(taskPackage.paths.workspace, path)));
  assert.match(await readFile(join(source, 'src/implementation.ts'), 'utf8'), /NOT_IMPLEMENTED/);
});

test('in-place rejects unsafe backup locations, symlink targets and incomplete prior attempts without changing existing source', async t => {
  const { source, directory, put, taskPackage } = await fixture(t);
  await put('business.js', 'keep me');
  await assert.rejects(prepareInPlaceMigrationWorkspace({ source, backup: join(source, 'backup'), taskPackage }), /external/);
  await assert.rejects(prepareInPlaceMigrationWorkspace({ source, backup: directory, taskPackage }), /external/);
  await symlink(source, join(directory, 'alias'));
  await assert.rejects(prepareInPlaceMigrationWorkspace({ source, backup: join(directory, 'alias/backup'), taskPackage }), /external/);
  const outside = join(directory, 'outside'); await mkdir(outside);
  await symlink(outside, join(source, 'contract'));
  await assert.rejects(prepareInPlaceMigrationWorkspace({ source, backup: join(directory, 'backup'), taskPackage }), /Unsafe in-place/);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await readFile(join(source, 'business.js'), 'utf8'), 'keep me');
});

test('in-place rejects damaged backup or partial preparation without deleting or resetting model workspace', async t => {
  const { source, directory, put, taskPackage } = await fixture(t);
  await put('business.js', 'keep me');
  const backup = join(directory, 'backup'), args = { source, backup, taskPackage };
  const manifest = await prepareInPlaceMigrationWorkspace(args);
  await writeFile(join(source, 'business.js'), 'new model work');
  await writeFile(join(backup, 'migration.json'), JSON.stringify({ ...manifest, status: 'backed_up' }));
  await assert.rejects(prepareInPlaceMigrationWorkspace(args), /Incomplete in-place/);
  await writeFile(join(backup, 'migration.json'), JSON.stringify(manifest));
  await writeFile(join(backup, 'workspace/business.js'), 'corrupted backup');
  await assert.rejects(prepareInPlaceMigrationWorkspace(args), /backup digest mismatch/);
  assert.equal(await readFile(join(source, 'business.js'), 'utf8'), 'new model work');
  assert(await readFile(join(source, 'MIGRATION.md')));
});

test('in-place public-file replacement never truncates another file linked to the historical README', async t => {
  const { source, directory, put, taskPackage } = await fixture(t);
  await put('README.md', 'original linked source bytes');
  await link(join(source, 'README.md'), join(directory, 'external-history.md'));
  const manifest = await prepareInPlaceMigrationWorkspace({ source, backup: join(directory, 'backup'), taskPackage });
  assert.equal(await readFile(join(directory, 'external-history.md'), 'utf8'), 'original linked source bytes');
  assert.equal(await readFile(join(source, manifest.archive, 'README.md'), 'utf8'), 'original linked source bytes');
});

test('explicit in-place upgrade reuses an existing V2 implementation with a new complete backup and versioned archive', async t => {
  const { source, directory, put, taskPackage } = await fixture(t);
  await put('business.js', 'old completed code');
  const original = await prepareInPlaceMigrationWorkspace({ source, backup: join(directory, 'backup-v1'), taskPackage });
  await writeFile(join(source, 'src/implementation.ts'), 'V2 model implementation must survive public upgrade');
  const starter = join(directory, 'upgraded-starter');
  await cp(taskPackage.paths.workspace, starter, { recursive: true });
  const publicReadme = Buffer.from(`${await readFile(join(starter, 'README.md'), 'utf8')}\nAuthorized public contract revision\n`);
  await writeFile(join(starter, 'README.md'), publicReadme);
  const lock = JSON.parse(await readFile(join(starter, 'contract/protected.json')));
  lock.files['README.md'] = sha256(publicReadme);
  await writeFile(join(starter, 'contract/protected.json'), JSON.stringify(lock));
  const upgradedPackage = { ...taskPackage, paths: { ...taskPackage.paths, workspace: starter }, digests: { ...taskPackage.digests, package: sha256('new-author-package') } };
  const upgraded = await prepareInPlaceMigrationWorkspace({ source, backup: join(directory, 'backup-v2'), taskPackage: upgradedPackage });
  assert.equal(upgraded.sourceVersion, 2);
  assert.notEqual(upgraded.archive, original.archive);
  assert.equal(await readFile(join(source, 'src/implementation.ts'), 'utf8'), 'V2 model implementation must survive public upgrade');
  assert.equal(await readFile(join(directory, 'backup-v2/workspace/src/implementation.ts'), 'utf8'), 'V2 model implementation must survive public upgrade');
  assert.deepEqual(await readFile(join(source, 'README.md')), publicReadme);
  assert(await readFile(join(source, upgraded.archive, 'MIGRATION.md')));
  assert.deepEqual(await prepareInPlaceMigrationWorkspace({ source, backup: join(directory, 'backup-v2'), taskPackage: upgradedPackage }), upgraded);
});
