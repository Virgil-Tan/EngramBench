#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestTaskPackagePath, loadTaskPackageV1 } from '../src/task-package-v1.mjs';
import { V2_RUNTIME_FILES } from '../src/task-package-v2-evaluator.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { openApi } from '../templates/contract-first/runtime.mjs';
import { taskTransportErrors } from '../contracts/learning/transport-errors.mjs';
import { applyFinalSystemPolicy, currentRequirements, finalWorkspaceReadme, FINAL_SYSTEM_REVISION } from '../contracts/learning/final-system-policy.mjs';

const repository = resolve(import.meta.dirname, '..');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function materializeLearning({ refresh = false, tasks, group = 'learning' } = {}) {
  const inventory = JSON.parse(await readFile(join(repository, 'learning-tasks.json')));
  const transfer = JSON.parse(await readFile(join(repository, 'transfer-tasks.json')));
  const all = [...inventory.tasks, ...transfer.tasks];
  if (!['learning', 'transfer', 'all'].includes(group)) throw new Error('group must be learning, transfer or all');
  const ids = tasks ?? (group === 'all' ? all : group === 'transfer' ? transfer.tasks : inventory.tasks);
  if (new Set(ids).size !== ids.length || ids.some(id => !all.includes(id))) throw new Error('Unknown/duplicate V2 tasks');
  const generated = [];
  for (const id of ids) {
    const root = join(repository, 'task-packages/v2', id), workspace = join(root, 'workspace');
    const markerPath = join(root, 'contract-first.json');
    if (await lstat(root).catch(() => undefined)) {
      if (!refresh) throw new Error(`${id} exists; --refresh updates generated packages only`);
      const marker = JSON.parse(await readFile(markerPath));
      if (marker.kind !== 'frontal-contract-first-package' || marker.benchmarkVersion !== 2 || marker.taskId !== id) throw new Error('Refusing to overwrite an unknown directory');
    }
    const phase = inventory.tasks.includes(id) ? 'learning' : 'transfer';
    const contract = structuredClone((await import(pathToFileURL(join(repository, 'contracts', phase, `${id}.mjs`)))).default);
    contract.benchmarkVersion = 2;
    contract.publicScaffoldRevision = '2026-09-10.ui-entry.1';
    if (phase === 'learning') {
      applyFinalSystemPolicy(contract);
      contract.publicScaffoldRevision = '2026-09-10.final-system-ui-entry.1';
    }
    contract.transportErrors = { ...(phase === 'learning' ? taskTransportErrors(id) : {}), ...contract.transportErrors };
    contract.notes.push('Browser document query boundary: GET operations whose published response contentMediaType is text/html, outside /api and /media, accept additional implementation-owned URL query state unchanged. This is the sole exception to unknown-query rejection. Published query/path/header parameters and no-body rules remain validated; all API query and body validation remains strict. The implementation must interpret its own deep-link state and still implement authorization, server reads and business behavior.');
    for (const operation of contract.operations) {
      if (operation.successResponses) operation.successStatuses = [...new Set([operation.status ?? 200, ...(operation.successStatuses ?? []), ...Object.keys(operation.successResponses).map(Number)])];
    }
    for (const probe of contract.smoke) probe.expectStatus ??= contract.operations.find(operation => operation.id === probe.operationId)?.status ?? 200;
    const statistics = validatePublicContract(contract);
    await mkdir(root, { recursive: true });
    await writeFile(markerPath, json({ kind: 'frontal-contract-first-package', benchmarkVersion: 2, taskId: id, state: 'building' }));
    await cp(join(repository, 'task-packages/legacy', id), root, { recursive: true });
    // Keep the original imports immutable. Task-level evaluator migrations have
    // their own authoring source and are never per-submission adapters.
    const evaluatorAuthor = join(repository, 'evaluators', phase, id);
    const evaluatorSource = join(evaluatorAuthor, 'v2');
    if (!await lstat(evaluatorSource).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
      await cp(join(repository, 'task-packages/legacy', id, 'evaluator/v2'), evaluatorSource, { recursive: true });
    }
    const releaseSource = join(evaluatorAuthor, 'release.json');
    if (!await lstat(releaseSource).catch(error => { if (error.code !== 'ENOENT') throw error; })) {
      await writeFile(releaseSource, json({ schemaVersion: 1, taskId: id, status: 'pending_alignment', blockers: ['Copied legacy cases have not been certified against the V2 public wire contract. Preserve business assertions while migrating fixtures, calls and intentional invalid-input markers.'] }));
    }
    await cp(evaluatorSource, join(root, 'evaluator/v2'), { recursive: true });
    await cp(releaseSource, join(root, 'evaluator/release.json'));
    if (phase === 'learning') {
      const base = await readFile(join(workspace, 'docs/frontal-legacy/README.md'), 'utf8');
      const manager = await readFile(join(workspace, 'docs/frontal-legacy/manager-requirements.md'), 'utf8');
      const active = currentRequirements({ title: contract.title, base, manager });
      await writeFile(join(workspace, 'docs/requirements.md'), active.text);
      await writeFile(join(workspace, 'README.md'), finalWorkspaceReadme(contract.title));
    }
    await mkdir(join(workspace, 'contract'), { recursive: true });
    await mkdir(join(workspace, 'src'), { recursive: true });
    for (const file of ['runtime.mjs', 'server.mjs', 'seed.mjs', 'seed-reader.mjs', 'check.mjs', ...(id === 'identitymesh' ? ['identitymesh-provider.mjs'] : [])]) await cp(join(repository, 'templates/contract-first', file), join(workspace, 'contract', file));
    for (const file of ['implementation.ts', 'lifecycle.ts']) await cp(join(repository, 'templates/contract-first', file), join(workspace, 'src', file));
    for (const file of ['package.json', 'package-lock.json', 'tsconfig.json']) await cp(join(repository, 'templates/contract-first', file), join(workspace, file));
    const pkg = JSON.parse(await readFile(join(workspace, 'package.json')));
    pkg.name = `frontal-v2-${id}`;
    for (const command of contract.commands) {
      // Installation is an npm builtin, not a package.json script to scaffold.
      if (/^npm (?:ci|install)(?:\s|$)/.test(command)) continue;
      const name = /^npm run ([^ ]+)/.exec(command)?.[1] ?? /^npm (start|test)\b/.exec(command)?.[1];
      if (!name) throw new Error(`Unsupported published npm command: ${command}`);
      pkg.scripts[name] ??= `node dist/lifecycle.js ${name}`;
    }
    if (contract.commands.includes('npm start')) pkg.scripts.start = 'node contract/server.mjs';
    if (contract.seed.command) pkg.scripts[contract.seed.command[2]] = 'node contract/seed.mjs';
    await writeFile(join(workspace, 'package.json'), json(pkg));
    const packageLock = JSON.parse(await readFile(join(workspace, 'package-lock.json')));
    packageLock.name = pkg.name; packageLock.packages[''].name = pkg.name;
    await writeFile(join(workspace, 'package-lock.json'), json(packageLock));
    await writeFile(join(workspace, 'contract/contract.json'), json(contract));
    await writeFile(join(workspace, 'contract/openapi.json'), json(openApi(contract)));
    await writeFile(join(workspace, 'contract/seed.example.json'), json(contract.seed.example));
    await writeFile(join(workspace, 'src/operation-ids.ts'), `export type OperationId = ${contract.operations.map(op => JSON.stringify(op.id)).join(' | ')};\n`);
    const notes = [
      `# ${contract.title} — V2 fixed public interface`, '',
      `Author scaffold revision ${contract.publicScaffoldRevision}: exact decimal validation, incremental seed-file decoding, and implementation-owned browser document query state. This is a revised public scaffold, not the unchanged historical evaluation environment. ${phase === 'learning' ? 'Evaluation scope is one complete final system; historical cross-version duties are withdrawn. Current business requirements and seed scale remain required.' : 'Business requirements and seed scale remain unchanged.'}`, '',
      phase === 'learning'
        ? `Business requirements: read the COMPLETE ../docs/requirements.md. ${FINAL_SYSTEM_REVISION} explicitly withdraws historical cross-version obligations, not current business functionality. Source documents remain unchanged only for provenance.`
        : 'Business requirements: read the COMPLETE ../docs/frontal-legacy/README.md and manager-requirements.md. The files are preserved verbatim. The wire clarifications below override only ambiguous representations, never remove business requirements.',
      ...(contract.policyRevision ? [`Public author policy revision ${contract.policyRevision}: read the supplements below in full. They resolve explicitly identified business-policy and test-protocol omissions; only an explicitly named author-approved exception overrides a corresponding original rule, and every other original obligation remains in force. This revision must not be compared as an unchanged historical benchmark.`] : []), '',
      '## Implementation seam', '',
      '- Implement all operations behind src/implementation.ts; use src/operation-ids.ts and contract.json for exact IDs, schemas, status codes and examples. Split internal modules freely.',
      '- Implement migrations, database seed, worker/dispatcher roles, real UI build and project-owned verification in src/lifecycle.ts. Throwing stubs are deliberate: compilation is not business completion.',
      '- The API process awaits optional src/implementation.ts exports start() before listening and stop() when terminating. Use these for pools and any background work required inside npm start (notably LaunchPass expiration/promotion). They may delegate to your own lifecycle modules; do not keep them only in the build command.',
      '- contract/ is author-owned. Do not edit its router/checker/contract or the README to make tests pass. You may add modules, dependencies, UI assets and your own tests.',
      '- Raw uploads arrive as RequestContext.stream; consume them incrementally. Raw download responses may be Buffer, string or readable stream. The router does not implement file persistence.',
      '- Additional UI endpoints may use publicExtensions; published operation IDs/method/path cannot be replaced.', '',
      '## Contract and examples', '',
      '- contract.json is the single wire source. openapi.json is generated from it, not separately handwritten.',
      `- The fixed HTTP server listens on ${contract.httpHost ?? '0.0.0.0'}; contract.httpHost preserves any task-specific bind requirement. PORT selects its port.`,
      '- transportErrors preserves task-specific HTTP error codes. Otherwise V2 wire defaults are INVALID_REQUEST/400, MALFORMED_JSON/400, UNAUTHORIZED/401, NOT_FOUND/404 and UNSUPPORTED_MEDIA_TYPE/415; domain resource errors still follow the complete README.',
      '- seed.example.json is a legal NONEMPTY seed. Its replay rule and argv are under contract.seed; do not guess db:seed versus seed.',
      '- contract/seed-reader.mjs exports readSeedJsonFile(path): incremental JSON decoding without a whole-file string. The author seed command still validates the entire decoded value against the public schema before invoking your lifecycle. You may reuse this reader in your own importer; foreign keys, digests, duplicate rules and atomic import remain your responsibility. The decoded object tree still occupies memory, and a single JSON string remains subject to the JavaScript engine string limit; this helper is not a database importer.',
      '- operation.example values are independent wire examples, not a complete executable business sequence. smoke contains an ordered public live sequence with captured identifiers.',
      '- A smoke signatures entry constructs a lowercase-hex HMAC-SHA256 request field: {target:["headers"|"body","existingField"],key:"public fixture key",message:"published UTF-8 signing line"}. Captured variables are expanded first; body fields are signed before JSON serialization. This is a public client helper, never server-side authentication or business implementation.',
      '- npm run check:contract-source only verifies author file integrity and schema construction.',
      '- npm run test:public-contract uses a DISPOSABLE database, builds, migrates, imports the seed, starts the real API/roles, then checks nonempty identities and live operations. Do not point it at a valuable database.',
      '- Public failures identify the failed command stage and retain its exit code/stdout/stderr. A probe blocked by an earlier failed identifier capture is reported as blockedBy, not as an independent implementation failure. Fix the first failure, then rerun the public check.',
      '- HTTP probe failures identify method/path, expectedStatus, actualStatus and a named errorCode when available; they do not dump credentials or signatures. The official Harness reruns this author-owned check in an isolated copy before freezing; failed public checks return to the same Coding Agent for repair, while infrastructure errors stop the check without becoming business scores.',
      '- Passing public checks proves only the published example wiring. It does not certify full business requirements, security, recovery, UI or performance, and does not replace the final README audit.',
      '- The official Harness runs the author-owned checker against an isolated copy before freezing. A public failure is feedback, not a hidden business score.', '',
      '## Published operations', '', '| ID | Method / path | Source |', '| --- | --- | --- |',
      ...contract.operations.map(op => `| ${op.id} | ${op.method} ${op.path} | ${op.source} |`), '',
      '## Explicit V2 wire clarifications', '', ...contract.notes.map(note => `- ${note}`), '',
      '## Delivery', '',
      'Public checks are necessary, not sufficient. Re-read the entire README, audit every observable requirement, and run all required project checks. Guide completion does not mean task completion. Do not return fixture-only responses or empty arrays to simulate completed workflows.', '',
    ].join('\n');
    await writeFile(join(workspace, 'contract/README.md'), notes);
    const readme = await readFile(join(workspace, 'README.md'), 'utf8');
    if (phase !== 'learning') await writeFile(join(workspace, 'README.md'), readme.replace('This is a lossless Task Package v1 adapter over the legacy starter workspace.', 'This is the Frontal Benchmark V2 fixed-interface starter.') + '\n## V2 fixed interface\n\nRead [the public V2 contract](contract/README.md) and [schemas, examples and seed rules](contract/contract.json) before implementation. Business requirements remain the COMPLETE original README plus Manager requirements, not just the interface table. V2 wire clarifications resolve representation ambiguities. Baseline and Guide use this identical starter and Frozen Plan.\n' + (contract.policyRevision ? `\nThe public contract also includes author policy supplement **${contract.policyRevision}**. It defines the confirmed business-policy clarifications and explicitly scoped exceptions, and must be read together with the original texts. All other original requirements remain unchanged.\n` : ''));
    const agents = await readFile(join(workspace, 'AGENTS.md'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return ''; });
    await writeFile(join(workspace, 'AGENTS.md'), agents + '\n## Benchmark V2\nRead contract/README.md. Preserve author-owned contract files. Implement real production business behavior, persistence, UI and verification in src/ and your own modules. Run public checks, then audit the entire README. No fake successful stubs or fixture-specific implementations.\n');
    await writeFile(join(workspace, '.env.example'), contract.environmentVariables.map(name => `${name}=`).join('\n') + '\n');
    await writeFile(join(workspace, '.gitignore'), 'node_modules/\ndist/\n.env\nvar/\ncoverage/\n');
    const protectedFiles = ['README.md', 'AGENTS.md', 'tsconfig.json', ...await listFiles(join(workspace, 'contract'), 'contract'), ...await listFiles(join(workspace, 'docs'), 'docs')];
    const files = Object.fromEntries(await Promise.all(protectedFiles.map(async path => [path, sha(await readFile(join(workspace, path)))])));
    await writeFile(join(workspace, 'contract/protected.json'), json({ kind: 'frontal-public-contract-lock', schemaVersion: 1, taskId: id, files, scripts: pkg.scripts }));
    await cp(join(workspace, 'contract'), join(root, 'public-contract'), { recursive: true });
    const manifest = JSON.parse(await readFile(join(root, 'task.json'))); manifest.taskVersion = 4;
    await writeFile(join(root, 'task.json'), json(manifest));
    const runtimeLock = JSON.parse(await readFile(join(root, 'evaluator/runtime-lock.json')));
    runtimeLock.runtimeFiles = await Promise.all(V2_RUNTIME_FILES.map(async path => ({ path, digest: sha(await readFile(join(repository, path))) })));
    runtimeLock.sourceDigest = sha(await readFile(join(repository, runtimeLock.sourceManifest)));
    runtimeLock.evaluatorDigest = await digestTaskPackagePath(join(root, 'evaluator/v2'));
    await writeFile(join(root, 'evaluator/runtime-lock.json'), json(runtimeLock));
    await writeFile(markerPath, json({ kind: 'frontal-contract-first-package', schemaVersion: 1, benchmarkVersion: 2, taskVersion: 4, taskId: id, phase, publicScaffoldRevision: contract.publicScaffoldRevision, publicContractDigest: sha(json(contract)), basedOn: `task-packages/legacy/${id}`, hiddenEvaluatorDigest: runtimeLock.evaluatorDigest }));
    await loadTaskPackageV1(root);
    generated.push({ id, ...statistics });
  }
  return generated;
}
async function listFiles(root, prefix) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'protected.json') continue;
    const path = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) output.push(...await listFiles(join(root, entry.name), path));
    else if (entry.isFile()) output.push(path);
    else throw new Error(`Unexpected symlink: ${path}`);
  }
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), tasksIndex = args.indexOf('--tasks'), groupIndex = args.indexOf('--group');
  console.log(json(await materializeLearning({ refresh: args.includes('--refresh'), tasks: tasksIndex < 0 ? undefined : args[tasksIndex + 1].split(','), group: groupIndex < 0 ? 'learning' : args[groupIndex + 1] })));
}
