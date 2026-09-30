import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { install } from '../scripts/public-ui-entry-overlay.cjs';
const sha = data => createHash('sha256').update(data).digest('hex');

test('overlay is exact-file and exact-digest scoped; original source remains intact', async t => {
  await mkdir(resolve('.tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.tmp/transport-overlay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'contract'));
  const target = join(root, 'contract/runtime.mjs'), unrelated = join(root, 'business.mjs'), replacement = join(root, 'replacement.mjs');
  const original = 'export const value = "old";', revised = 'export const value = "revised";';
  await writeFile(target, original); await writeFile(unrelated, original); await writeFile(replacement, revised);
  const config = { targets: [pathToFileURL(target).href], replacement, originalSha256: sha(original), replacementSha256: sha(revised) };
  assert.throws(() => install({ ...config, targets: [pathToFileURL(unrelated).href] }), /Only author runtime/);
  assert.throws(() => install({ ...config, replacementSha256: sha(original) }), /Revised author transport changed/);
  const wrong = install({ ...config, originalSha256: sha(revised) });
  assert.throws(() => requireModule(target), /Historical author transport differs/); wrong.deregister();
  const hook = install(config); t.after(() => hook.deregister());
  assert.equal(requireModule(target).value, 'revised');
  assert.equal(requireModule(unrelated).value, 'old');
  assert.equal(await readFile(target, 'utf8'), original);
});
import { createRequire } from 'node:module';
const requireModule = createRequire(import.meta.url);
