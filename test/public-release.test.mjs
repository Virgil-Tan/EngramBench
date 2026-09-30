import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateProfile } from '../scripts/run-v2.mjs';
import { createProcessEvaluator, digestTaskPackagePath } from '../src/task-package-v1.mjs';

test('pinned evaluator override survives the subprocess boundary without forwarding provider secrets', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'engrambench-evaluator-env-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const image = 'sha256:' + 'd'.repeat(64);
  const keys = ['ENGRAMBENCH_EVALUATOR_IMAGE', 'USER_MODEL_API_KEY'];
  const original = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => { if (original[i] === undefined) delete process.env[key]; else process.env[key] = original[i]; }));
  process.env.ENGRAMBENCH_EVALUATOR_IMAGE = image;
  process.env.USER_MODEL_API_KEY = 'synthetic-must-not-be-forwarded';
  const workspace = join(temporary, 'workspace');
  await mkdir(workspace);
  const entry = join(temporary, 'evaluator.mjs');
  await writeFile(entry, `import {writeFileSync} from 'node:fs';
    const output=process.argv[process.argv.indexOf('--result')+1];
    writeFileSync(output,JSON.stringify({kind:'frontal-evaluation-result',schemaVersion:1,verdict:'passed',
      publicFeedback:{code:'ok',summary:'fixture'},privateReport:{image:process.env.ENGRAMBENCH_EVALUATOR_IMAGE,
      secretForwarded:process.env.USER_MODEL_API_KEY!==undefined}}));`);
  const adapter = createProcessEvaluator({ package: { paths: {}, digests: { package: 'a'.repeat(64) },
    evaluator: { command: ['node', entry], taskRoot: temporary, task: { id: 'fixture' } } }, runRoot: join(temporary, 'evaluation') });
  await adapter.run({ operationId: 'fixture', submission: { path: workspace, digest: await digestTaskPackagePath(workspace) } });
  const report = JSON.parse(await readFile(adapter.artifacts.privateReport));
  assert.deepEqual(report, { image, secretForwarded: false });
});

test('native evaluator image override changes only historical image/platform arguments', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'engrambench-wrapper-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const docker = join(temporary, 'docker');
  await writeFile(docker, `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o700 });
  const mapping = JSON.parse(await readFile(new URL('../environments/evaluator-execution.v1.json', import.meta.url)));
  const image = 'sha256:' + 'c'.repeat(64);
  const wrapper = new URL('../scripts/docker-native-amd64-evaluator.mjs', import.meta.url);
  const run = (args, override = image) => spawnSync(process.execPath, [wrapper.pathname, ...args], {
    encoding: 'utf8', env: { ...process.env, FRONTAL_DOCKER_COMMAND: docker, ENGRAMBENCH_EVALUATOR_IMAGE: override },
  });
  const args = ['run', '--platform', 'linux/arm64', mapping.hosts.arm64.image, 'node', '--version'];
  const result = run(args);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['run', '--platform', mapping.hosts[process.arch].platform, image, 'node', '--version']);
  const other = ['inspect', 'unrelated-container'];
  assert.deepEqual(JSON.parse(run(other).stdout), other);
  assert.notEqual(run(args, 'mutable:latest').status, 0);
});

test('public profiles use supported explicit development mode and contain no credentials', async () => {
  for (const arm of ['baseline', 'native', 'guide']) {
    const profile = JSON.parse(await readFile(new URL(`../profiles/${arm}.example.json`, import.meta.url)));
    assert.equal(validateProfile(profile, ['mediadock', 'capacitylease']).arm, arm);
    assert.equal(profile.purpose, 'development');
    assert.equal(profile.evolution, false);
    assert.equal(Object.hasOwn(profile.user, 'apiKey'), false);
  }
});

test('public import inventories contain source content, not nested Git metadata', async () => {
  for (const name of ['import', 'superhard-import', 'transfer-import']) {
    const manifest = JSON.parse(await readFile(new URL(`../provenance/${name}.json`, import.meta.url)));
    assert(!manifest.source.startsWith('/'));
    assert(manifest.files.length > 0);
    assert(manifest.files.every(file => !file.path.split('/').includes('.git')));
  }
});
