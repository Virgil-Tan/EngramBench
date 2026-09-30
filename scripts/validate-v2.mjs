#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { loadTaskPackageV1, digestTaskPackagePath } from '../src/task-package-v1.mjs';
import { validateV2EvaluatorLock, validateFinalSystemManifest } from '../src/task-package-v2-evaluator.mjs';
import { FINAL_SYSTEM_REVISION, currentRequirements } from '../contracts/learning/final-system-policy.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { checkSource } from '../templates/contract-first/check.mjs';
import { openApi } from '../templates/contract-first/runtime.mjs';
import { LEARNING_TASK_ORDER, TRANSFER_TASK_ORDER, resolveTaskOrder } from '../src/task-order.mjs';
const root = resolve(import.meta.dirname, '..');
const learning = JSON.parse(await readFile(join(root, 'learning-tasks.json'))).tasks;
const transfer = JSON.parse(await readFile(join(root, 'transfer-tasks.json'))).tasks;
const inventory = [...learning, ...transfer];
assert.equal(learning.length, 30); assert.equal(new Set(inventory).size, inventory.length);
assert.deepEqual(learning, LEARNING_TASK_ORDER); assert.deepEqual(transfer, TRANSFER_TASK_ORDER);
assert.deepEqual(resolveTaskOrder([...learning.map(id => ({ id, phase: 'learning' })), ...transfer.map(id => ({ id, phase: 'transfer' }))]), inventory);
const generated = (await readdir(join(root, 'task-packages/v2'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
assert.deepEqual(generated, [...inventory].sort(), 'Generated inventory must match Learning and Transfer author inventories');
const provenance = JSON.parse(await readFile(join(root, 'provenance/import.json')));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let preserved = 0;
for (const record of provenance.files.filter(file => /^(tasks|task-packages\/legacy|experiments)\//.test(file.path))) {
  assert.equal(sha(await readFile(join(root, record.path))), record.sha256, `Imported original changed: ${record.path}`); preserved++;
}
for (const manifest of ['superhard-import.json', 'transfer-import.json']) {
  const imported = JSON.parse(await readFile(join(root, 'provenance', manifest)));
  for (const record of imported.files) {
    assert.equal(sha(await readFile(join(root, record.path))), record.sha256, `Imported Transfer original changed: ${record.path}`); preserved++;
  }
}
const tasks = [];
for (const id of inventory) {
  const packageRoot = join(root, 'task-packages/v2', id), workspace = join(packageRoot, 'workspace');
  const task = await loadTaskPackageV1(packageRoot);
  assert.equal(task.manifest.taskVersion, 4);
  await validateV2EvaluatorLock(join(packageRoot, 'evaluator/runtime-lock.json'), { repositoryRoot: root });
  const contract = await checkSource(workspace, join(packageRoot, 'public-contract'));
  const statistics = validatePublicContract(contract);
  assert.deepEqual(JSON.parse(await readFile(join(workspace, 'contract/openapi.json'))), openApi(contract), `${id}: OpenAPI drift`);
  for (const path of ['plan.md', 'scenario.json']) assert.equal(sha(await readFile(join(packageRoot, path))), sha(await readFile(join(root, 'task-packages/legacy', id, path))), `${id}: frozen plan/scenario changed`);
  for (const path of ['README.md', 'manager-requirements.md']) assert.equal(sha(await readFile(join(workspace, 'docs/frontal-legacy', path))), sha(await readFile(join(root, 'task-packages/legacy', id, 'workspace/docs/frontal-legacy', path))), `${id}: original business text changed`);
  const hidden = JSON.parse(await readFile(join(packageRoot, 'evaluator/v2/manifest.v2.json')));
  const phase = learning.includes(id) ? 'learning' : 'transfer';
  assert.equal(await digestTaskPackagePath(join(packageRoot, 'evaluator/v2')),
    await digestTaskPackagePath(join(root, 'evaluators', phase, id, 'v2')), `${id}: generated evaluator differs from author source`);
  assert.equal(await readFile(join(packageRoot, 'evaluator/release.json'), 'utf8'),
    await readFile(join(root, 'evaluators', phase, id, 'release.json'), 'utf8'), `${id}: generated release differs from author source`);
  if (learning.includes(id)) {
    assert.equal(contract.evaluationScope, 'final-system');
    assert.equal(contract.policyRevision, FINAL_SYSTEM_REVISION);
    assert.equal(hidden.evaluationScope, 'final-system');
    assert.equal(hidden.policyRevision, FINAL_SYSTEM_REVISION);
    validateFinalSystemManifest(hidden);
    const base = await readFile(join(workspace, 'docs/frontal-legacy/README.md'), 'utf8');
    const manager = await readFile(join(workspace, 'docs/frontal-legacy/manager-requirements.md'), 'utf8');
    assert.equal(await readFile(join(workspace, 'docs/requirements.md'), 'utf8'),
      currentRequirements({ title: contract.title, base, manager }).text, `${id}: final requirements drift`);
  }
  const release = JSON.parse(await readFile(join(packageRoot, 'evaluator/release.json')));
  tasks.push({ id, phase: learning.includes(id) ? 'learning' : 'transfer', ...statistics, evaluatorStatus: release.status, legacyHiddenCases: hidden.cases.length, packageDigest: task.digests.package });
}
const result = { benchmarkVersion: 2, checkedAt: new Date().toISOString(), status: 'static_validation_passed', tasks: tasks.length, learningTasks: learning.length, transferTasks: transfer.length, preservedSourceFiles: preserved,
  operations: tasks.reduce((n, task) => n + task.operations, 0), publicProbes: tasks.reduce((n, task) => n + task.probes, 0),
  copiedLegacyHiddenCases: tasks.reduce((n, task) => n + task.legacyHiddenCases, 0),
  evaluatorsPendingAlignment: tasks.filter(task => task.evaluatorStatus === 'pending_alignment').length,
  evaluatorsPendingLiveValidation: tasks.filter(task => task.evaluatorStatus === 'pending_live_validation').length,
  evaluatorsUncertified: tasks.filter(task => task.evaluatorStatus !== 'certified').length,
  liveBusinessEvaluationRun: false, note: 'Schema/lock/integrity checks are not business correctness or proof that old hidden fixtures match V2 clarifications.', details: tasks };
await mkdir(join(root, 'reports'), { recursive: true });
await writeFile(join(root, 'reports/validation.json'), JSON.stringify(result, null, 2) + '\n');
await writeFile(join(root, 'reports/validation.md'), [
  '# V2 验证状态', '', `检查时间：${result.checkedAt}`, '',
  `- ${learning.length} 个 Learning + ${transfer.length} 个 Transfer 任务包静态校验通过；${preserved} 份原始任务文件 SHA-256 未变化。`,
  `- ${result.operations} 个公开接口、${result.publicProbes} 个公开探针的 schema/示例/文件锁校验通过。`,
  `- 当前共 ${result.copiedLegacyHiddenCases} 个隐藏用例；Learning 已按最终系统范围修订，原始版本另行归档。${result.evaluatorsUncertified} 题尚未完成 V2 评测认证（${result.evaluatorsPendingAlignment} 题待对齐，${result.evaluatorsPendingLiveValidation} 题待真实业务验证）。`,
  '- 本检查不运行模型或完整业务提交；静态通过不是业务通过。真实批次结果另行记录。', '',
  '| Task | 分组 | 公开接口 | 公开探针 | 私有用例 | 评测发布状态 |', '| --- | --- | ---: | ---: | ---: | --- |',
  ...tasks.map(task => `| ${task.id} | ${task.phase} | ${task.operations} | ${task.probes} | ${task.legacyHiddenCases} | ${task.evaluatorStatus} |`), '',
].join('\n'));
console.log(JSON.stringify({ ...result, details: undefined }, null, 2));
