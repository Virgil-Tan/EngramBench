// One-shot dependency job. The existing evaluator retains every delivery check.
import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main as evaluate, parseOptions } from '../superhard-v2-alignment-20260908/evaluate.mjs';

export function waitForFrozen(statePath) {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      watcher.close();
      if (error) reject(error); else resolveReady();
    };
    const check = async () => {
      try {
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        if (state.status === 'awaiting_evaluation' && state.phase === 'testing') finish();
        else if (['failed', 'aborted', 'completed'].includes(state.status)) {
          finish(new Error(`Delivery stopped before freezing: ${state.status}`));
        }
      } catch (error) { finish(error); }
    };
    // Watch the directory before reading: state is replaced atomically by Harness.
    const watcher = watch(dirname(statePath), (_event, filename) => {
      if (!filename || filename === basename(statePath)) void check();
    });
    watcher.on('error', finish);
    void check();
  });
}

export async function main(argv) {
  const options = parseOptions(argv);
  const experiment = JSON.parse(await readFile(join(options.runRoot, 'experiment.json'), 'utf8'));
  const index = experiment.taskIds.indexOf(basename(options.taskRoot));
  if (index < 0) throw new Error('Task is not in the original experiment');
  const statePath = join(options.runRoot, 'projects', `${String(index + 1).padStart(2, '0')}-${basename(options.taskRoot)}`, 'private/harness-state.json');
  console.log(JSON.stringify({ status: 'waiting_for_frozen', pid: process.pid, statePath, outputRoot: options.outputRoot }));
  await waitForFrozen(statePath);
  console.log(JSON.stringify({ status: 'checking_frozen_delivery', statePath }));
  await evaluate(argv);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
