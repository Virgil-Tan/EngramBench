import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicContractGate } from '../src/public-contract-gate.mjs';
import { digestTaskPackagePath } from '../src/task-package-v1.mjs';
import { runProcess } from '../src/process.mjs';

for (const [encodedPassword, plainPassword] of [['database%21secret', 'database!secret'], ['database%ZZsecret', 'database%ZZsecret']])
test(`public gate preserves clean-build diagnostics and redacts credentials (${encodedPassword})`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'public-gate-feedback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'task'), author = join(packageRoot, 'public-contract'), workspace = join(root, 'workspace');
  await mkdir(author, { recursive: true });
  await mkdir(join(workspace, 'contract'), { recursive: true });
  const contract = JSON.stringify({ schemas: {}, seed: { schema: { type: 'object' }, example: {} }, operations: [] });
  const scripts = { build: 'node build.mjs' }, lock = JSON.stringify({ files: {}, scripts });
  await writeFile(join(author, 'contract.json'), contract);
  await writeFile(join(author, 'protected.json'), lock);
  await writeFile(join(workspace, 'contract/protected.json'), lock);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'public-gate-fixture', version: '1.0.0', type: 'module', scripts }));
  await writeFile(join(workspace, 'package-lock.json'), JSON.stringify({ name: 'public-gate-fixture', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'public-gate-fixture', version: '1.0.0' } } }));
  await writeFile(join(workspace, 'build.mjs'), `import { readFile } from 'node:fs/promises';
console.log('PUBLIC_BUILD_STDOUT', process.env.DATABASE_URL, new URL(process.env.DATABASE_URL).password, ${JSON.stringify(plainPassword)});
console.error('PUBLIC_BUILD_STDERR', process.env.ADMIN_TOKEN, process.env.SERVICE_API_KEY);
await readFile(new URL('./dist/public/app.js', import.meta.url));
`);
  // The existing workspace succeeds only because of this stale build output.
  await mkdir(join(workspace, 'dist/public'), { recursive: true });
  await writeFile(join(workspace, 'dist/public/app.js'), 'stale-build-output');
  await writeFile(join(packageRoot, 'contract-first.json'), JSON.stringify({ kind: 'frontal-contract-first-package', taskId: 'gate-fixture', publicContractDigest: createHash('sha256').update(contract).digest('hex') }));
  const containerEnv = { DATABASE_URL: `postgres://postgres:${encodedPassword}@127.0.0.1/fixture`, ADMIN_TOKEN: 'admin-secret', SERVICE_API_KEY: 'service-secret' };
  let closed = false, checkedCopy;
  const runtime = {
    async createSession({ mounts }) {
      checkedCopy = mounts.find(mount => mount.target === '/workspace').source;
      return {
        async exec(command, args, options) {
          // Only the OCI/PG boundary is substituted. Run the real public checker,
          // dependency preparation and failing npm build on the real gate copy.
          if (command === 'git' || command === 'psql') return { exitCode: 0, stdout: '', stderr: '' };
          assert.equal(command, 'node');
          assert.equal(args[0], '/public-contract/check.mjs');
          return runProcess(process.execPath, [resolve('templates/contract-first/check.mjs'), '--workspace', checkedCopy, '--author', author, '--live'], {
            ...options, cwd: checkedCopy, env: { ...process.env, ...containerEnv },
          });
        },
        async close() { closed = true; },
      };
    },
  };
  const taskPackage = { paths: { root: packageRoot }, task: { id: 'gate-fixture' }, digests: { package: await digestTaskPackagePath(packageRoot) } };
  const gate = createPublicContractGate({ taskPackage, taskRuntime: { profile: { runtime: {} }, containerEnv }, runtime, repositoryRoot: resolve('.'), runRoot: join(root, 'private-public-checks') });
  const result = await gate({ operationId: 'fixture:public-contract:1', workspace: { path: workspace } });
  assert.equal(closed, true);
  assert.equal(result.passed, false);
  assert.match(result.summary, /build: npm run build exited 1/);
  assert.match(result.summary, /Public check stage: build/);
  assert.match(result.summary, /ENOENT.*dist\/public\/app\.js/);
  assert.match(result.summary, /PUBLIC_BUILD_STDOUT/);
  assert.match(result.summary, /PUBLIC_BUILD_STDERR/);
  for (const secret of [...Object.values(containerEnv), encodedPassword, plainPassword]) assert.equal(result.summary.includes(secret), false, 'public feedback must not expose environment credentials');
  assert.equal(await readFile(join(workspace, 'dist/public/app.js'), 'utf8'), 'stale-build-output');
  await assert.rejects(readFile(join(checkedCopy, 'dist/public/app.js')), { code: 'ENOENT' });
  const recorded = JSON.parse(await readFile(join(result.artifactPath, 'result.json')));
  assert.equal(recorded.summary, result.summary);
});
