import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BenchError } from './errors.mjs';
import { digestTaskPackagePath } from './task-package-v1.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/u;
const denied = message => Object.assign(new BenchError('v2_evaluator_not_released', message), { origin: 'evaluator' });

/** Formal evaluation requires an author certification bound to the exact package inputs. */
export async function assertEvaluatorReleased(taskRoot) {
  try {
    const [markerBytes, releaseBytes] = await Promise.all([
      readFile(join(taskRoot, 'contract-first.json')),
      readFile(join(taskRoot, 'evaluator/release.json')),
    ]);
    const marker = JSON.parse(markerBytes), release = JSON.parse(releaseBytes);
    if (marker?.kind !== 'frontal-contract-first-package' || marker.schemaVersion !== 1 || marker.benchmarkVersion !== 2
      || typeof marker.taskId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(marker.taskId)) {
      throw denied('A valid V2 contract-first package marker is required for evaluator release');
    }
    if (release?.schemaVersion !== 1 || release.taskId !== marker.taskId || release.status !== 'certified') {
      throw denied(`${marker.taskId} evaluator is not certified for formal evaluation`);
    }
    if (release.blockers !== undefined && (!Array.isArray(release.blockers) || release.blockers.length > 0)) {
      throw denied(`${marker.taskId} evaluator still has unresolved release blockers`);
    }
    const [contractBytes, hiddenEvaluatorDigest, lockBytes] = await Promise.all([
      readFile(join(taskRoot, 'public-contract/contract.json')),
      digestTaskPackagePath(join(taskRoot, 'evaluator/v2')),
      readFile(join(taskRoot, 'evaluator/runtime-lock.json')),
    ]);
    const actual = { publicContractDigest: sha(contractBytes), hiddenEvaluatorDigest, runtimeLockDigest: sha(lockBytes) };
    for (const [key, digest] of Object.entries(actual)) {
      if (!digestPattern.test(release[key] ?? '') || release[key] !== digest) {
        throw denied(`${marker.taskId} evaluator certification does not match ${key}`);
      }
    }
    for (const key of ['publicContractDigest', 'hiddenEvaluatorDigest']) {
      if (marker[key] !== actual[key]) throw denied(`${marker.taskId} package marker does not match ${key}`);
    }
    return release;
  } catch (error) {
    if (error instanceof BenchError && error.code === 'v2_evaluator_not_released') throw error;
    throw denied(`Evaluator release metadata or frozen inputs are missing or invalid: ${error.message}`);
  }
}
