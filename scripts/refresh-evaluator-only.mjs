#!/usr/bin/env node
// Rebuild evaluator artifacts without regenerating a task's frozen public scaffolding.
import { createHash } from 'node:crypto';
import { cp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digestTaskPackagePath } from '../src/task-package-v1.mjs';
import { V2_RUNTIME_FILES, validateV2EvaluatorLock } from '../src/task-package-v2-evaluator.mjs';
import { writeJsonAtomic } from '../src/files.mjs';

const root = resolve(import.meta.dirname, '..');
const sha = data => createHash('sha256').update(data).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const args = process.argv.slice(2), learning = (await json(join(root, 'learning-tasks.json'))).tasks;
const allowed = [...learning, ...(await json(join(root, 'transfer-tasks.json'))).tasks];
const ids = args.length === 1 && args[0] === '--all' ? allowed : args;
if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !allowed.includes(id))) throw new Error('Pass unique canonical task IDs');
for (const id of ids) {
  const phase = learning.includes(id) ? 'learning' : 'transfer';
  const packageRoot = join(root, 'task-packages/v2', id), evaluator = join(packageRoot, 'evaluator');
  const markerPath = join(packageRoot, 'contract-first.json'), lockPath = join(evaluator, 'runtime-lock.json');
  const marker = await json(markerPath), lock = await json(lockPath);
  if (marker.kind !== 'frontal-contract-first-package' || marker.taskId !== id) throw new Error('Unknown generated package');
  const publicBefore = await digestTaskPackagePath(join(packageRoot, 'public-contract'));
  const workspaceBefore = await digestTaskPackagePath(join(packageRoot, 'workspace'));
  await cp(join(root, 'evaluators', phase, id, 'v2'), join(evaluator, 'v2'), { recursive: true });
  await cp(join(root, 'evaluators', phase, id, 'release.json'), join(evaluator, 'release.json'));
  lock.evaluatorDigest = await digestTaskPackagePath(join(evaluator, 'v2'));
  lock.runtimeFiles = await Promise.all(V2_RUNTIME_FILES.map(async path => ({ path, digest: sha(await readFile(join(root, path))) })));
  lock.sourceDigest = sha(await readFile(join(root, lock.sourceManifest)));
  marker.hiddenEvaluatorDigest = lock.evaluatorDigest;
  await writeJsonAtomic(lockPath, lock);
  await writeJsonAtomic(markerPath, marker);
  await validateV2EvaluatorLock(lockPath, { repositoryRoot: root });
  if (publicBefore !== await digestTaskPackagePath(join(packageRoot, 'public-contract'))
    || workspaceBefore !== await digestTaskPackagePath(join(packageRoot, 'workspace'))) throw new Error('Public scaffolding changed');
  console.log(JSON.stringify({ taskId: id, evaluatorDigest: lock.evaluatorDigest, publicPreserved: true, workspacePreserved: true }));
}
