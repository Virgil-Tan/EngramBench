#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, lstat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

// Import immutable source copies once; never copy runs, credentials or submissions.
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const remaining = args.includes('--remaining');
const resume = args.includes('--resume');
const include = path => !['.DS_Store', 'node_modules', '.git', '.env'].includes(basename(path)) && !basename(path).startsWith('._');
const sourceArg = args.find(value => !value.startsWith('--'));
if (!sourceArg) throw new Error('Usage: import-superhard.mjs /absolute/path/to/original-source [--remaining] [--resume]');
const source = resolve(sourceArg);
const ids = remaining
  ? ['metersettle', 'dockchain', 'incidentrelay', 'flagfoundry', 'carbonledger', 'parcelflow', 'escrowguard', 'permitforge', 'capacitylease']
  : ['commercecommand', 'coldchaincontrol', 'creatorrightsexchange', 'accesssentinel'];
const copies = ids.flatMap(id => remaining ? [
  [`task-packages/legacy/${id}`, `task-packages/legacy/${id}`],
  [`tasks/${id}`, `tasks/${id}`],
  [`task-packages/legacy/${id}/evaluator/v2`, `evaluators/transfer/${id}/v2`],
] : [
  [`task-packages/contract-first/${id}`, `task-packages/imported-contract-first/${id}`],
  [`task-packages/legacy/${id}`, `task-packages/legacy/${id}`],
  [`tasks/${id}`, `tasks/${id}`],
  [`contracts/superhard/${id}.mjs`, `contracts/transfer/${id}.mjs`],
  [`task-packages/contract-first/${id}/evaluator/v2`, `evaluators/transfer/${id}/v2`],
]);
if (remaining) copies.push(...ids.map(id => [`experiments/${id}/task.json`, `experiments/${id}/task.json`]));
for (const [from, to] of copies) {
  await lstat(join(source, from));
  if (!resume && await lstat(join(root, to)).catch(error => { if (error.code !== 'ENOENT') throw error; })) throw new Error(`Import destination already exists: ${to}`);
}
const records = [];
async function record(directory, relative, target) {
  if (!include(directory)) return;
  const stat = await lstat(directory);
  if (stat.isDirectory()) for (const name of await readdir(directory)) await record(join(directory, name), `${relative}/${name}`, join(target, name));
  else if (stat.isFile()) {
    const bytes = await readFile(directory);
    if (!bytes.equals(await readFile(target))) throw new Error(`Imported source mismatch: ${relative}`);
    records.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  else throw new Error(`Unexpected non-regular import: ${relative}`);
}
for (const [from, to] of copies) {
  await mkdir(resolve(root, to, '..'), { recursive: true });
  if (!await lstat(join(root, to)).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
    await cp(join(source, from), join(root, to), { recursive: true, force: false, errorOnExist: true, filter: include });
  }
  // Contract/evaluator author sources are editable; originals remain in imported-contract-first.
  if (!to.startsWith('contracts/') && !to.startsWith('evaluators/')) await record(join(source, from), to, join(root, to));
}
await mkdir(join(root, 'provenance'), { recursive: true });
await writeFile(join(root, remaining ? 'provenance/transfer-import.json' : 'provenance/superhard-import.json'), JSON.stringify({ source, importedAt: new Date().toISOString(), tasks: ids, files: records }, null, 2) + '\n');
console.log(JSON.stringify({ importedTasks: ids, immutableFiles: records.length }));
