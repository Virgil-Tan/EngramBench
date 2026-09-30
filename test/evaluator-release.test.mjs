import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchError } from '../src/errors.mjs';
import { assertEvaluatorReleased } from '../src/evaluator-release.mjs';
import { digestTaskPackagePath } from '../src/task-package-v1.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value) + '\n';
const isDenied = error => error instanceof BenchError && error.code === 'v2_evaluator_not_released' && error.origin === 'evaluator';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'frontal-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'evaluator/v2'), { recursive: true });
  await mkdir(join(root, 'public-contract'));
  const contract = json({ taskId: 'release-fixture', operations: [] }), lock = json({ taskId: 'release-fixture' });
  await writeFile(join(root, 'public-contract/contract.json'), contract);
  await writeFile(join(root, 'evaluator/runtime-lock.json'), lock);
  await writeFile(join(root, 'evaluator/v2/cases.mjs'), 'export const cases = [];\n');
  const marker = {
    kind: 'frontal-contract-first-package', schemaVersion: 1, benchmarkVersion: 2, taskId: 'release-fixture',
    publicContractDigest: sha(contract), hiddenEvaluatorDigest: await digestTaskPackagePath(join(root, 'evaluator/v2')),
  };
  const release = {
    schemaVersion: 1, taskId: marker.taskId, status: 'certified', blockers: [],
    publicContractDigest: marker.publicContractDigest, hiddenEvaluatorDigest: marker.hiddenEvaluatorDigest, runtimeLockDigest: sha(lock),
  };
  await writeFile(join(root, 'contract-first.json'), json(marker));
  await writeFile(join(root, 'evaluator/release.json'), json(release));
  return { root, marker, release };
}

test('certification accepts only the exact public contract, hidden evaluator and runtime lock', async t => {
  const { root, release } = await fixture(t);
  assert.deepEqual(await assertEvaluatorReleased(root), release);
});

for (const status of ['pending_alignment', 'imported', 'blocked']) {
  test(`${status} evaluator cannot produce a formal release`, async t => {
    const { root, release } = await fixture(t);
    await writeFile(join(root, 'evaluator/release.json'), json({ ...release, status }));
    await assert.rejects(assertEvaluatorReleased(root), isDenied);
  });
}

for (const path of ['contract-first.json', 'evaluator/release.json', 'public-contract/contract.json', 'evaluator/runtime-lock.json', 'evaluator/v2/cases.mjs']) {
  test(`missing required release input is denied: ${path}`, async t => {
    const { root } = await fixture(t);
    await rm(join(root, path));
    await assert.rejects(assertEvaluatorReleased(root), isDenied);
  });
}

for (const path of ['public-contract/contract.json', 'evaluator/v2/cases.mjs', 'evaluator/runtime-lock.json']) {
  test(`certification is invalidated by drift: ${path}`, async t => {
    const { root } = await fixture(t);
    await writeFile(join(root, path), (await readFile(join(root, path))) + '\n');
    await assert.rejects(assertEvaluatorReleased(root), isDenied);
  });
}

for (const field of ['publicContractDigest', 'hiddenEvaluatorDigest', 'runtimeLockDigest']) {
  test(`release requires a matching ${field}`, async t => {
    const { root, release } = await fixture(t);
    delete release[field];
    await writeFile(join(root, 'evaluator/release.json'), json(release));
    await assert.rejects(assertEvaluatorReleased(root), isDenied);
  });
}

for (const field of ['publicContractDigest', 'hiddenEvaluatorDigest']) {
  test(`marker must independently agree with actual ${field}`, async t => {
    const { root, marker } = await fixture(t);
    await writeFile(join(root, 'contract-first.json'), json({ ...marker, [field]: 'f'.repeat(64) }));
    await assert.rejects(assertEvaluatorReleased(root), isDenied);
  });
}

test('another task certification and unresolved blockers are denied', async t => {
  const { root, release } = await fixture(t);
  for (const change of [{ taskId: 'another-task' }, { schemaVersion: 2 }, { blockers: ['Unresolved original README requirement'] }]) {
    await writeFile(join(root, 'evaluator/release.json'), json({ ...release, ...change }));
    await assert.rejects(assertEvaluatorReleased(root), isDenied);
  }
});

test('malformed author release metadata remains an evaluator error', async t => {
  const { root } = await fixture(t);
  await writeFile(join(root, 'evaluator/release.json'), '{');
  await assert.rejects(assertEvaluatorReleased(root), isDenied);
});
