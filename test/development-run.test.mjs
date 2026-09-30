import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepareRun } from '../scripts/run-v2.mjs';

for (const variant of ['selector_direct', 'generic_advisor']) test(`${variant}: development prepares an isolated API home and records the actual container transport`, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'v2-development-'));
  const runId = basename(temporary).toLowerCase();
  const runRoot = resolve('runs', runId);
  t.after(() => Promise.all([rm(temporary, { recursive: true, force: true }), rm(runRoot, { recursive: true, force: true })]));
  await mkdir(join(temporary, 'sessions'));
  await mkdir(join(temporary, 'plugins'));
  await mkdir(join(temporary, 'empty-advisor-seed'));
  await writeFile(join(temporary, 'sessions/private.jsonl'), 'not experiment input');
  await writeFile(join(temporary, 'plugins/personal.json'), 'not experiment input');
  await writeFile(join(temporary, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fake-test-only' }));
  const config = 'model_provider = "experiment_api"\n[model_providers.experiment_api]\nbase_url = "https://example.invalid/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n';
  await writeFile(join(temporary, 'config.toml'), config);
  const profile = { benchmarkVersion: 2, purpose: 'development', runId, taskIds: ['dockchain'], arm: 'guide', ablationVariant: variant, ownerId: 'test', authFile: 'auth.json', codexConfigFile: 'config.toml', agentImage: 'fixture', memoraxHomeSeed: './empty-advisor-seed', agent: { model: 'gpt-5.5', effort: 'medium' }, user: { model: 'deepseek-v4-pro', thinking: true, reasoningEffort: 'high', baseUrlEnv: 'USER_URL', apiKeyEnv: 'USER_KEY' }, evolution: false };
  const path = join(temporary, 'profile.json');
  await writeFile(path, JSON.stringify(profile));
  const env = { USER_URL: 'https://example.invalid/v1', USER_KEY: 'fake-user-test-only' };
  const prepared = await prepareRun(path, { env });
  assert.equal(prepared.runRoot, runRoot);
  assert.equal(env.FRONTAL_RUN_PURPOSE, 'development');
  assert.equal(env.FRONTAL_DEFER_EVOLUTION, 'true');
  assert.equal(env.MEMORAX_ABLATION_VARIANT, variant);
  assert.equal(env.FRONTAL_AGENT_MODEL, 'gpt-5.5');
  assert.equal(env.FRONTAL_AGENT_EFFORT, 'medium');
  assert.equal(env.FRONTAL_USER_THINKING, 'true');
  assert.deepEqual((await readdir(env.FRONTAL_CODEX_HOME_SEED)).sort(), ['auth.json', 'config.toml']);
  assert.equal(await readFile(join(env.FRONTAL_CODEX_HOME_SEED, 'config.toml'), 'utf8'), config);
  const recorded = JSON.parse(await readFile(join(runRoot, 'experiment.json')));
  assert.equal(recorded.purpose, 'development');
  assert.equal(recorded.ablationVariant, variant);
  assert.equal(recorded.packages[0].id, 'dockchain');
  assert.match(recorded.packages[0].planDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual((await readdir(runRoot)).sort(), ['experiment.json', 'private-seed']);

  // Exercise the real Runner through its external Docker boundary; no model,
  // Docker daemon or evaluator is invoked by this recording executable.
  const docker = join(temporary, 'docker');
  const capture = join(temporary, 'docker-create.json');
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'create') {
  const env = Object.fromEntries(fs.readFileSync(args[args.indexOf('--env-file') + 1], 'utf8').trim().split('\\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  fs.writeFileSync(process.env.OCI_CAPTURE, JSON.stringify({ variant: env.MEMORAX_ABLATION_VARIANT, runId: env.FRONTAL_RUN_ID, transport: env.FRONTAL_EXPERIMENT_ARM, search: env.MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED }));
  process.exit(37);
}
if (args[0] === 'exec' || args[0] === 'start') throw new Error('The recording boundary must never start an Agent');
`, { mode: 0o700 });
  const runnerOutput = execFileSync(process.execPath, ['scripts/run-general-codex-sequence.mjs'], {
    cwd: process.cwd(), env: { ...process.env, ...env, FRONTAL_OCI_COMMAND: docker, OCI_CAPTURE: capture },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const journal = JSON.parse(await readFile(join(runRoot, 'journal.json')));
  assert.ok(await lstat(capture).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  }), `Runner did not reach Docker create: ${JSON.stringify({ output: runnerOutput.toString(), projects: journal.projects })}`);
  assert.deepEqual(JSON.parse(await readFile(capture)), { variant, runId, transport: 'treatment', search: 'false' });
  assert.equal(journal.purpose, 'development');
  assert.deepEqual(journal.ablation, { kind: 'component_ablation', variant, isFullGuide: false, transportArm: 'treatment' });

  const formalId = `${runId}-formal`;
  const formalRoot = resolve('runs', formalId);
  t.after(() => rm(formalRoot, { recursive: true, force: true }));
  await writeFile(path, JSON.stringify({ ...profile, purpose: 'benchmark', runId: formalId }));
  await assert.rejects(prepareRun(path, { env: { ...env } }), error => error.code === 'v2_evaluator_not_released');
  await assert.rejects(lstat(formalRoot), { code: 'ENOENT' });
});

test('in-place migration binds the original workspace to a new V2 run without reading old state or copying a new starter workspace', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'v2-in-place-'));
  const runId = basename(temporary).toLowerCase(), runRoot = resolve('runs', runId);
  t.after(() => Promise.all([rm(temporary, { recursive: true, force: true }), rm(runRoot, { recursive: true, force: true })]));
  const source = join(temporary, 'original/workspace'), backup = join(temporary, 'private-backup');
  await mkdir(source, { recursive: true });
  await mkdir(join(temporary, 'original/private'));
  const oldState = join(temporary, 'original/private/harness-state.json');
  await writeFile(oldState, '{"taskDigest":"historical-v1","phase":"finished"}\n');
  await writeFile(join(source, 'business.js'), 'original completed business implementation\n');
  await writeFile(join(temporary, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"fake-test-only"}');
  const profile = { benchmarkVersion: 2, purpose: 'migration-repair', migrationMode: 'in-place', runId, taskIds: ['dockchain'], arm: 'baseline', ownerId: 'test', authFile: 'auth.json', agentImage: 'fixture', agent: { model: 'gpt-5.5', effort: 'medium' }, user: { model: 'deepseek-v4-pro', baseUrlEnv: 'USER_URL', apiKeyEnv: 'USER_KEY' }, evolution: false, sourceWorkspaces: { dockchain: source }, backupWorkspaces: { dockchain: backup } };
  const path = join(temporary, 'profile.json'); await writeFile(path, JSON.stringify(profile));
  const env = { USER_URL: 'https://example.invalid/v1', USER_KEY: 'fake-user-only' };
  await prepareRun(path, { env });
  assert.equal(env.FRONTAL_MIGRATION_MODE, 'in-place');
  assert.deepEqual(JSON.parse(env.FRONTAL_MIGRATION_SOURCES), { dockchain: source });
  assert.deepEqual(JSON.parse(env.FRONTAL_MIGRATION_BACKUPS), { dockchain: backup });
  const docker = join(temporary, 'docker'), capture = join(temporary, 'docker-create.json');
  await writeFile(docker, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'create') { fs.writeFileSync(process.env.OCI_CAPTURE, JSON.stringify(args)); process.exit(37); }
if (args[0] === 'exec' || args[0] === 'start') throw new Error('Never start a model in this boundary regression');
`, { mode: 0o700 });
  execFileSync(process.execPath, ['scripts/run-general-codex-sequence.mjs'], { cwd: process.cwd(), env: { ...process.env, ...env, FRONTAL_OCI_COMMAND: docker, OCI_CAPTURE: capture }, stdio: ['ignore', 'pipe', 'pipe'] });
  const args = JSON.parse(await readFile(capture));
  assert(args.some(value => value.includes(`src=${source},dst=/workspace`)), JSON.stringify(args));
  const manifest = JSON.parse(await readFile(join(runRoot, 'projects/01-dockchain/private/migration.json')));
  assert.equal(manifest.target, source);
  assert.equal(manifest.backup, backup);
  assert.equal(manifest.status, 'prepared');
  await assert.rejects(lstat(join(runRoot, 'projects/01-dockchain/workspace')), { code: 'ENOENT' });
  assert.equal(await readFile(oldState, 'utf8'), '{"taskDigest":"historical-v1","phase":"finished"}\n');
  assert.equal(await readFile(join(source, 'business.js'), 'utf8'), 'original completed business implementation\n');
  const journal = JSON.parse(await readFile(join(runRoot, 'journal.json')));
  assert.equal(journal.purpose, 'migration-repair');
  assert.equal(journal.runId, runId);
});
