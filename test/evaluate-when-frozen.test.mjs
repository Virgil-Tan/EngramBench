import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitForFrozen } from '../work/superhard-v2-author-corrections-20260908/evaluate-when-frozen.mjs';

test('one-shot queue waits for atomic freeze, handles an existing freeze, rejects stopped development', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'frontal-freeze-queue-'));
  const path = join(dir, 'harness-state.json');
  const set = async state => {
    await writeFile(join(dir, 'next.json'), JSON.stringify(state));
    await rename(join(dir, 'next.json'), path);
  };
  try {
    await set({ status: 'running', phase: 'implementing' });
    let resolved = false;
    const waiting = waitForFrozen(path).then(() => { resolved = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(resolved, false);
    await set({ status: 'awaiting_evaluation', phase: 'testing' });
    await waiting;
    await waitForFrozen(path);
    await set({ status: 'failed', phase: 'implementing' });
    await assert.rejects(waitForFrozen(path), /stopped before freezing/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
