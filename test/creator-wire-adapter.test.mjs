import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import contract from '../contracts/transfer/creatorrightsexchange.mjs';

const adapter = resolve('work/creator-guide-wire-adapter-20260909/json-order.cjs');
async function startApi(t, adapted) {
  const root = await mkdtemp(join(tmpdir(), 'creator-wire-regression-'));
  await mkdir(join(root, 'contract')); await mkdir(join(root, 'dist'));
  // Use the actual author HTTP transport and schemas, not a replacement router.
  for (const name of ['server.mjs', 'runtime.mjs']) await cp(resolve('templates/contract-first', name), join(root, 'contract', name));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'contract/contract.json'), JSON.stringify(contract));
  const { symlink } = await import('node:fs/promises');
  await symlink(resolve('node_modules'), join(root, 'node_modules'));
  await writeFile(join(root, 'dist/implementation.js'), `
    let calls = 0;
    export async function execute(id, {body}) {
      if (id === 'ui') return {body:'{"z":1,"a":2}'};
      if (body.name === 'broken') return {body:{unexpected:1}};
      if (body.name === 'error') throw Object.assign(new Error('Still rejected'), {status:409,code:'CONFLICT',details:{z:[2,1],a:{z:1,a:2}}});
      const name = body.name === 'changes' ? String(++calls) : body.name;
      const tenantId = '30000000-0000-4000-8000-000000000001';
      // JSONB decoding may reorder keys without changing any business value.
      return {body:++calls % 2 ? {tenantId,name} : {name,tenantId}};
    }
  `);
  const child = fork(join(root, 'contract/server.mjs'), [], {
    cwd: root, execArgv: adapted ? ['--require', adapter] : [],
    env: {...process.env, NODE_OPTIONS:'', PORT:'0'}, silent:true,
  });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    const {rm} = await import('node:fs/promises'); await rm(root, {recursive:true});
  });
  const listening = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(() => { throw new Error(stderr); }),
  ]);
  return async (name, path = '/api/v1/tenants') => {
    const response = await fetch(`http://127.0.0.1:${listening.port}${path}`, path === '/' ? {} : {
      method:'POST', headers:{'Content-Type':'application/json','Idempotency-Key':'fixed-replay'}, body:JSON.stringify({name}),
    });
    return {status:response.status, text:await response.text()};
  };
}

test('actual V2 transport reproduces JSONB key-order drift on an identical reply', async t => {
  const request = await startApi(t, false);
  const first = await request('same'), replay = await request('same');
  assert.equal(first.status, 200); assert.equal(replay.status, 200);
  assert.deepEqual(JSON.parse(first.text), JSON.parse(replay.text));
  assert.notEqual(first.text, replay.text, 'red-capable: unchanged transport produces different wire bytes');
});

test('isolated JSON wire adapter makes identical replies byte-stable without hiding real failures', async t => {
  const request = await startApi(t, true);
  const first = await request('same'), replay = await request('same');
  assert.deepEqual(replay, first, 'exact replay bytes');
  assert.deepEqual(JSON.parse(first.text), {tenantId:'30000000-0000-4000-8000-000000000001',name:'same'});
  assert.notEqual((await request('changes')).text, (await request('changes')).text, 'changed business results stay changed');
  const conflict = await request('error');
  assert.equal(conflict.status, 409);
  assert.deepEqual(JSON.parse(conflict.text), {error:{code:'CONFLICT',message:'Still rejected',details:{z:[2,1],a:{z:1,a:2}}}});
  const broken = await request('broken');
  assert.equal(broken.status, 500); assert.equal(JSON.parse(broken.text).error.code, 'RESPONSE_CONTRACT_VIOLATION');
  assert.equal((await request('', '/')).text, '{"z":1,"a":2}', 'HTML and binary streams are not JSON-normalized');
});
