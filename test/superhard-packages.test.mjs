import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { loadTaskPackageV1 } from '../src/task-package-v1.mjs';
import { validateV2EvaluatorLock } from '../src/task-package-v2-evaluator.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { checkSource } from '../templates/contract-first/check.mjs';
import { openApi } from '../templates/contract-first/runtime.mjs';
import { TRANSFER_TASK_ORDER } from '../src/task-order.mjs';

const root = resolve(import.meta.dirname, '..');
const json = async path => JSON.parse(await readFile(path));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('all 13 imported Transfer originals remain byte-identical without imported dependencies', async () => {
  const importedIds = [];
  for (const name of ['superhard-import.json', 'transfer-import.json']) {
    const record = await json(join(root, 'provenance', name));
    importedIds.push(...record.tasks);
    for (const file of record.files) {
      assert(!file.path.includes('/node_modules/'), 'dependency artifacts are not task sources');
      assert.equal(sha(await readFile(join(root, file.path))), file.sha256, file.path);
    }
  }
  assert.deepEqual(importedIds.sort(), [...TRANSFER_TASK_ORDER].sort());
});

for (const id of TRANSFER_TASK_ORDER) test(`${id}: one V2 package, full contract, unchanged requirements/Plan and private evaluator`, async t => {
  const packageRoot = join(root, 'task-packages/v2', id);
  const task = await loadTaskPackageV1(packageRoot);
  assert.equal(task.manifest.taskVersion, 4);
  await validateV2EvaluatorLock(join(packageRoot, 'evaluator/runtime-lock.json'), { repositoryRoot: root });
  const contract = await checkSource(task.paths.workspace, join(packageRoot, 'public-contract'));
  validatePublicContract(contract);
  assert.deepEqual(await json(join(packageRoot, 'public-contract/openapi.json')), openApi(contract));
  if (['flagfoundry', 'permitforge'].includes(id)) {
    assert.equal(typeof contract.policyRevision, 'string', 'confirmed policy needs a named public revision');
    const entry = await readFile(join(task.paths.workspace, 'README.md'), 'utf8');
    const policy = await readFile(join(task.paths.workspace, 'contract/README.md'), 'utf8');
    assert(entry.includes(contract.policyRevision), 'Coding Agent entry must identify the confirmed policy');
    assert(entry.includes('explicitly scoped exceptions'), 'entry must distinguish policy exceptions from wire-only clarification');
    assert(policy.includes(contract.policyRevision));
    assert(policy.includes('every other original obligation remains in force'));
  }
  const legacy = join(root, 'task-packages/legacy', id);
  for (const path of ['plan.md', 'scenario.json', 'workspace/docs/frontal-legacy/README.md', 'workspace/docs/frontal-legacy/manager-requirements.md']) {
    assert.deepEqual(await readFile(join(packageRoot, path)), await readFile(join(legacy, path)), `${id}: ${path}`);
  }
  const lock = await json(join(packageRoot, 'evaluator/runtime-lock.json'));
  assert.equal(lock.phase, 'transfer');
  const marker = await json(join(packageRoot, 'contract-first.json'));
  assert.equal(marker.benchmarkVersion, 2);
  assert.equal(marker.phase, 'transfer');

  await mkdir(join(root, '.tmp'), { recursive: true });
  const temporary = await mkdtemp(join(root, '.tmp/superhard-export-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = join(temporary, 'public');
  const result = spawnSync(process.execPath, ['scripts/prepare-task.mjs', '--task', id, '--output', output], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const names = await readdir(output, { recursive: true });
  assert(!names.some(name => /(^|[/\\])(evaluator|private|release\.json)([/\\]|$)/.test(name)), 'public export must not contain hidden assets');
  const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(output, 'tsconfig.json')], { cwd: output, encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const stub = spawnSync(process.execPath, ['dist/lifecycle.js', 'build'], { cwd: output, encoding: 'utf8' });
  assert.notEqual(stub.status, 0, 'business scaffold must remain unimplemented');
  assert.match(stub.stderr, /NOT_IMPLEMENTED/);
});
