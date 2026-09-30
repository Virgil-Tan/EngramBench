import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
test('public export contains no private tests, refuses overwrite and leaves business unimplemented', async t => {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(root, '.tmp/package-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace');
  const args = ['scripts/prepare-task.mjs', '--task', 'queueforge', '--output', workspace];
  const first = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).containsPrivateTests, false);
  assert.equal(await readFile(join(workspace, 'FROZEN_PLAN.md'), 'utf8'), await readFile(join(root, 'task-packages/v2/queueforge/plan.md'), 'utf8'));
  const names = await readdir(workspace, { recursive: true });
  assert(!names.some(name => /(^|[/\\])(evaluator|private|release\.json)([/\\]|$)/.test(name)));
  const second = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /never overwrite/);
  const compile = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(workspace, 'tsconfig.json')], { cwd: workspace, encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  const lifecycle = spawnSync(process.execPath, ['dist/lifecycle.js', 'build'], { cwd: workspace, encoding: 'utf8' });
  assert.notEqual(lifecycle.status, 0);
  assert.match(lifecycle.stderr, /NOT_IMPLEMENTED: build/);
});
