import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLive } from '../templates/contract-first/check.mjs';
import identitySource from '../contracts/learning/identitymesh.mjs';
import { applyFinalSystemPolicy } from '../contracts/learning/final-system-policy.mjs';

const identity = applyFinalSystemPolicy(structuredClone(identitySource));

test('public checker supplies a real local provider to API/worker and closes it afterwards', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'identitymesh-public-provider-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const author = join(workspace, 'contract'), bin = join(workspace, 'bin');
  for (const directory of [author, bin, join(workspace, 'dist')]) await mkdir(directory);
  await symlink(new URL('../node_modules', import.meta.url).pathname, join(workspace, 'node_modules'), 'dir');
  for (const name of ['runtime.mjs', 'identitymesh-provider.mjs']) await cp(new URL(`../templates/contract-first/${name}`, import.meta.url), join(author, name));
  const account = identity.providerProtocol.accounts[0];
  const contract = { ...identity, commands: ['npm run start:worker'],
    operations: [{ id: 'provider-probe', method: 'GET', path: '/provider-probe', response: { $ref: '#/$defs/ProviderLoginOutcome' } }],
    smoke: [{ operationId: 'provider-probe', expectStatus: 200, expectBody: { outcome: 'SUCCEEDED', userId: account.userId } }],
  };
  await writeFile(join(author, 'protected.json'), JSON.stringify({ files: {}, scripts: {} }));
  await writeFile(join(author, 'contract.json'), JSON.stringify(contract));
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
  // Only build/seed are test doubles. Provider and public-check orchestration are real.
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  await writeFile(join(workspace, 'dist/lifecycle.js'), `
    import {writeFileSync} from 'node:fs';
    if (!process.env.PROVIDER_BASE_URL) throw new Error('worker has no provider');
    writeFileSync('worker-provider-url.txt', process.env.PROVIDER_BASE_URL);
    setInterval(() => {}, 1000);
  `);
  const body = { providerRequestId: 'public-checker-request', tenantId: account.tenantId,
    deviceId: identity.seed.example.devices[0].deviceId, username: account.username, password: account.password };
  await writeFile(join(author, 'server.mjs'), `
    import {createServer} from 'node:http';
    import {writeFileSync} from 'node:fs';
    writeFileSync('api-provider-url.txt', process.env.PROVIDER_BASE_URL ?? 'missing');
    const server = createServer(async (_req, res) => {
      try {
        const upstream = await fetch(process.env.PROVIDER_BASE_URL + '/v1/login', {
          method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':'public-checker-request'},
          body:JSON.stringify(${JSON.stringify(body)}) });
        res.writeHead(upstream.status, {'Content-Type':'application/json'});
        res.end(await upstream.text());
      } catch { res.writeHead(500, {'Content-Type':'application/json'}); res.end('{}'); }
    });
    server.listen(0,'127.0.0.1',() => process.send({kind:'public-api-listening',port:server.address().port}));
  `);
  const result = await checkLive(workspace, author, {
    PATH: bin, DATABASE_URL: 'postgresql://localhost/unused-test-fixture', ADMIN_TOKEN: 'public-test-token',
    PROVIDER_BASE_URL: 'http://127.0.0.1:1',
  });
  assert.equal(result.passed, true, JSON.stringify(result.findings));
  const providerUrl = await readFile(join(workspace, 'api-provider-url.txt'), 'utf8');
  assert.equal(await readFile(join(workspace, 'worker-provider-url.txt'), 'utf8'), providerUrl);
  assert.notEqual(providerUrl, 'http://127.0.0.1:1');
  await assert.rejects(fetch(providerUrl + '/v1/login-requests/public-checker-request'));
});

test('a public provider internal fault remains infrastructure failure after child cleanup', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'identitymesh-provider-fault-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const author = join(workspace, 'contract'), bin = join(workspace, 'bin');
  for (const directory of [author, bin]) await mkdir(directory);
  await writeFile(join(author, 'protected.json'), JSON.stringify({ files: {}, scripts: {} }));
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(author, 'contract.json'), JSON.stringify({ ...identity, commands: [], smoke: [] }));
  await writeFile(join(bin, 'npm'), `#!${process.execPath}\nprocess.exit(0);\n`, { mode: 0o755 });
  await writeFile(join(author, 'identitymesh-provider.mjs'), `
    export async function startIdentityMeshProvider() { return {
      baseUrl:'http://127.0.0.1:1', close:async () => { throw new Error('provider fixture internal fault'); }
    }; }
  `);
  await writeFile(join(author, 'server.mjs'), `
    import {createServer} from 'node:http';
    const server=createServer();
    server.listen(0,'127.0.0.1',() => process.send({kind:'public-api-listening',port:server.address().port}));
  `);
  await assert.rejects(checkLive(workspace, author, {
    PATH: bin, DATABASE_URL: 'postgresql://localhost/unused-test-fixture', ADMIN_TOKEN: 'public-test-token',
  }), error => error.preparationFailed === true && error.stage === 'public-provider'
    && error.message === 'provider fixture internal fault');
});
