import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { requestValidator } from '../templates/contract-first/runtime.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';

const root = resolve(import.meta.dirname, '..');
const commerce = JSON.parse(await readFile(join(root, 'task-packages/v2/commercecommand/public-contract/contract.json')));
const ui = commerce.operations.find(op => op.id === 'getUi');

test('HTML entry query belongs to UI; API and declared parameters remain strict', () => {
  const declared = { ...ui, id: 'declared', path: '/view/:id', parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^item-' } },
    { name: 'page', in: 'query', required: true, schema: { type: 'integer', minimum: 1 } },
    { name: 'x-view-token', in: 'header', required: true, schema: { const: 'view-token' } },
  ] };
  const json = { ...ui, id: 'json', response: { type: 'object' } };
  const post = { ...ui, id: 'post', method: 'POST' };
  const api = { ...ui, id: 'api', path: '/api/v1/html' };
  const media = { ...ui, id: 'media', path: '/media/html' };
  const check = requestValidator({ ...commerce, operations: [...commerce.operations, declared, json, post, api, media] });
  const query = { orderId: 'a', tag: ['one', 'two'] };
  assert.equal(check(ui, { query }).valid, true);
  assert.deepEqual(query, { orderId: 'a', tag: ['one', 'two'] }, 'do not remove browser state');
  for (const op of [json, post, api, media]) assert.equal(check(op, { query }).valid, false, op.id);
  assert.equal(check(ui, { hasBody: true }).valid, false, 'GET body still forbidden');
  const valid = { params: { id: 'item-1' }, query: { page: '2', tab: 'activity' }, headers: { 'x-view-token': 'view-token' } };
  assert.equal(check(declared, structuredClone(valid)).valid, true);
  for (const change of [v => delete v.query.page, v => v.query.page = 'bad', v => v.query.page = ['1', '2'], v => v.params.id = 'bad', v => v.headers = {}]) {
    const value = structuredClone(valid); change(value); assert.equal(check(declared, value).valid, false);
  }
});

async function server(t, overlay = false) {
  await mkdir(join(root, '.tmp'), { recursive: true });
  const dir = await mkdtemp(join(root, '.tmp/browser-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'contract')); await mkdir(join(dir, 'dist'));
  for (const name of ['runtime.mjs', 'server.mjs']) await cp(join(root, 'templates/contract-first', name), join(dir, 'contract', name));
  const env = { ...process.env, PORT: '0' };
  let original;
  if (overlay) {
    const current = await readFile(join(dir, 'contract/runtime.mjs'), 'utf8');
    original = current.replace(/    \/\/ HTML document navigation[\s\S]*?    for \(const name of Object.keys\(query\)\).*?\n/, "    for (const name of Object.keys(query)) if (!queryNames.has(name)) return fail(`Unknown query parameter: ${name}`, [], 'unknownQuery');\n");
    const sha = bytes => createHash('sha256').update(bytes).digest('hex');
    assert.equal(sha(original), 'b3fe1cdbb4aed080ee7aaf5a5a5a76b5de8e25e9eaac5e86547086c4c99806c1', 'exact historical runtime');
    await writeFile(join(dir, 'contract/runtime.mjs'), original);
    await mkdir(join(dir, 'overlay'));
    await cp(join(root, 'scripts/public-ui-entry-overlay.cjs'), join(dir, 'overlay/loader.cjs'));
    await writeFile(join(dir, 'overlay/manifest.json'), JSON.stringify({ targets: [pathToFileURL(join(dir, 'contract/runtime.mjs')).href],
      replacement: join(root, 'templates/contract-first/runtime.mjs'), originalSha256: sha(original), replacementSha256: sha(current) }));
    delete env.FRONTAL_UI_ENTRY_OVERLAY_MANIFEST;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${join(dir, 'overlay/loader.cjs')}`;
  }
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(join(dir, 'contract/contract.json'), JSON.stringify(commerce));
  // Transport fixture only: no production business implementation or hidden assertions.
  await writeFile(join(dir, 'dist/implementation.js'), `export async function execute(id, context) {
    if (id !== 'getUi') throw new Error('No test business implementation');
    return { body: '<!doctype html><title>Entry</title><div id="state"></div><button id="navigate">Navigate</button><script>' +
      'document.querySelector("#state").textContent = new URLSearchParams(location.search).get("orderId") || "initial";' +
      'document.querySelector("#navigate").onclick = () => history.replaceState(null, "", "/?orderId=item-1");' +
      '</script><pre id="received">' + JSON.stringify(context.query) + '</pre>' };
  }`);
  const child = fork(join(dir, 'contract/server.mjs'), [], { cwd: dir, env, silent: true });
  const done = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await done; });
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const listening = await new Promise((yes, no) => { child.once('error', no); child.once('exit', () => no(new Error(stderr))); child.once('message', yes); });
  return { dir, original, base: `http://127.0.0.1:${listening.port}`, diagnostics: () => stderr };
}

test('actual server and evaluator guard accept UI query without bypassing API validation', async t => {
  const { dir, base } = await server(t);
  const boundary = await evaluatorContract(join(dir, 'contract'));
  assert.doesNotThrow(() => boundary.request('/?orderId=item-1'));
  const apiPath = '/api/v1/orders/00000000-0000-4000-8000-000000000001?invented=1';
  assert.throws(() => boundary.request(apiPath), /Unknown query/);
  const response = await fetch(base + '/?orderId=item-1&tab=one&tab=two');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(await response.text(), /"orderId":"item-1","tab":\["one","two"\]/);
  assert.equal((await fetch(base + apiPath)).status, 400);
});

test('versioned overlay repairs the real historical transport without writing its file', async t => {
  const { dir, original, base, diagnostics } = await server(t, true);
  const result = await fetch(base + '/?orderId=item-1');
  assert.equal(result.status, 200);
  assert.match(await result.text(), /"orderId":"item-1"/);
  assert.equal((await fetch(base + '/api/v1/orders/00000000-0000-4000-8000-000000000001?extra=1')).status, 400);
  assert.match(diagnostics(), /public-ui-entry-overlay/);
  assert.equal(await readFile(join(dir, 'contract/runtime.mjs'), 'utf8'), original);
});

test('real browser reload retains self-generated deep link and mounts the page', { skip: !process.env.FRONTAL_TEST_CHROMIUM }, async t => {
  const { base } = await server(t);
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  assert.equal((await page.goto(base)).status(), 200);
  await page.locator('#navigate').click();
  assert.equal(page.url(), base + '/?orderId=item-1');
  assert.equal((await page.reload()).status(), 200);
  assert.equal(await page.locator('#state').innerText(), 'item-1');
});
