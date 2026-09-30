import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import contract from '../contracts/transfer/creatorrightsexchange.mjs';
import { expectError, assertNoTemporaryMedia } from '../evaluators/transfer/creatorrightsexchange/v2/cases/helpers.mjs';
import { D_CASES } from '../evaluators/transfer/creatorrightsexchange/v2/cases/d.mjs';

const assertions = {
  ok: (value, label) => assert.ok(value, label),
  equal: (actual, expected, label) => assert.deepEqual(actual, expected, label),
  assert: (_label, check) => check(),
};
const response = (json, status = 400) => ({ status, json, text: JSON.stringify(json) });

test('Creator malformed JSON uses the exact published code-only error; other errors stay closed', () => {
  const published = contract.transportErrors.invalidJson;
  assert.doesNotThrow(() => expectError(assertions, response(published.body), published.status, published.code));
  for (const json of [
    { error: { code: published.code, message: 'Unexpected extra field' } },
    { error: { code: published.code, details: {} } },
    { error: { code: 'INVALID_REQUEST' } },
    { error: { code: published.code }, extra: true },
  ]) assert.throws(() => expectError(assertions, response(json), 400, published.code));
  assert.throws(() => expectError(assertions, response(published.body, 200), 400, published.code));
  for (const error of [
    { code: 'INVALID_REQUEST', message: 'Invalid input' },
    { code: 'INVALID_REQUEST', message: 'Invalid input', details: {} },
  ]) assert.doesNotThrow(() => expectError(assertions, response({ error }), 400, 'INVALID_REQUEST'));
  for (const error of [
    { code: 'INVALID_REQUEST' },
    { code: 'INVALID_REQUEST', message: 12 },
    { code: 'INVALID_REQUEST', message: 'Invalid', extra: true },
    { code: 'INVALID_REQUEST', message: 'Invalid', details: [] },
  ]) assert.throws(() => expectError(assertions, response({ error }), 400, 'INVALID_REQUEST'));
});

test('Creator orphan-media check accepts empty directories but rejects real temporary files recursively', async t => {
  const managedDataRoot = await mkdtemp(join(tmpdir(), 'creator-orphan-regression-'));
  t.after(() => rm(managedDataRoot, { recursive: true, force: true }));
  const ctx = { ...assertions, managedDataRoot };
  await mkdir(join(managedDataRoot, 'tmp', 'nested'), { recursive: true });
  await mkdir(join(managedDataRoot, 'objects'), { recursive: true });
  await writeFile(join(managedDataRoot, 'objects', 'completed.bin'), 'complete');
  assert((await assertNoTemporaryMedia(ctx)).includes('tmp'));
  for (const path of ['tmp/nested/orphan.bin', 'objects/upload.partial', 'temp.bin']) {
    await writeFile(join(managedDataRoot, path), 'unfinished');
    await assert.rejects(assertNoTemporaryMedia(ctx), /no orphan temporary media/);
    await rm(join(managedDataRoot, path));
  }
  await assertNoTemporaryMedia({ ...ctx, managedDataRoot: join(managedDataRoot, 'missing') });
});

test('actual Creator D-02/D-06 discover semantic controls and still require working upload traffic', {
  skip: !process.env.FRONTAL_TEST_CHROMIUM,
}, async t => {
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({ executablePath: process.env.FRONTAL_TEST_CHROMIUM, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const reachedSnapshot = new Error('verified upload responses reached business snapshot');
  const family = {
    tenant: { tenantId: 'tenant-public' }, work: { workId: 'work-public' },
    profiles: [{ profileId: 'profile-public' }], chunkSize: 65536,
    uploadSession: { fileName: 'media.bin', mediaType: 'application/octet-stream' },
    media: Buffer.from('real-file-selection'), seed: {},
  };
  const fields = [
    ['media', 'Media file', 'file'], ['tenant', 'Tenant ID'], ['work', 'Work ID'],
    ['chunk', 'Chunk size'], ['profile', 'Profile'],
  ];
  for (const [caseId, labelMode, button, functional, expectedFailure] of [
    ['D-02', 'nested', 'Upload and complete', true],
    ['D-02', 'nested', 'Upload media', true],
    ['D-06', 'nested', 'Upload and complete', true],
    ['D-06', 'for', 'Start upload', true],
    ['D-06', 'aria-labelledby', 'Create upload', true],
    ['D-06', 'aria-label', 'Upload', true],
    ['D-06', 'missing', 'Upload', true, /visible control has accessible label/],
    ['D-02', 'nested', 'Unrelated action', true, /visible button not found/],
    ['D-02', 'nested', 'Upload and complete', false, /waitForResponse: Timeout.*exceeded/s],
    ['D-06', 'nested', 'Upload and complete', false, /waitForResponse: Timeout.*exceeded/s],
  ]) await t.test(`${caseId}: ${labelMode}, ${button}, functional=${functional}`, async t => {
    const traffic = [];
    const html = fields.map(([id, label, type = 'text']) => {
      const input = `<input id="${id}" type="${type}"`;
      if (labelMode === 'nested') return `<label>${label} ${input}></label>`;
      if (labelMode === 'for') return `<label for="${id}">${label}</label>${input}>`;
      if (labelMode === 'aria-labelledby') return `<span id="label-${id}">${label}</span>${input} aria-labelledby="label-${id}">`;
      if (labelMode === 'aria-label') return `${input} aria-label="${label}">`;
      return `${input}>`;
    }).join('') + `<button type="button">${button}</button><output></output><script>
      document.querySelector('button').onclick = async () => {
        if (!${functional}) return;
        const file = document.querySelector('input[type=file]').files[0];
        if (!file || !['tenant', 'work', 'chunk', 'profile'].every(id => document.getElementById(id).value)) return;
        const upload = await fetch('/api/v1/uploads', { method: 'POST', body: await file.text() }).then(r => r.json());
        document.querySelector('output').textContent = upload.uploadId;
        await fetch('/api/v1/uploads/' + upload.uploadId + '/complete', { method: 'POST' });
      };
    </script>`;
    const server = createServer(async (request, reply) => {
      if (request.method !== 'POST') { reply.setHeader('Content-Type', 'text/html'); reply.end(html); return; }
      let body = '';
      for await (const chunk of request) body += chunk;
      traffic.push({ path: request.url, body });
      reply.setHeader('Content-Type', 'application/json');
      reply.end(JSON.stringify({ uploadId: 'uploaded-public', assetId: 'asset-public' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    let page;
    const ctx = {
      ...assertions, fixtures: { base: () => family, browser: () => family, upload: () => family },
      migrate: async () => {}, seed: async () => {}, startWorker: async () => ({}),
      startApi: async () => ({ baseUrl: `http://127.0.0.1:${server.address().port}` }),
      defer: cleanup => t.after(cleanup),
      snapshot: async () => { throw reachedSnapshot; },
      loadChromium: async () => ({ launch: async () => ({
        newPage: async options => {
          page = await browser.newPage(options);
          const waitForResponse = page.waitForResponse.bind(page);
          page.setDefaultTimeout(1500);
          page.waitForResponse = (predicate, options) => waitForResponse(predicate, { ...options, timeout: 1500 });
          return page;
        },
        close: () => page?.context().close(),
      }) }),
      pass: () => assert.fail('isolated UI setup must not bypass the remaining business assertions'),
    };
    await assert.rejects(D_CASES.find(row => row.id === caseId).run(ctx),
      expectedFailure ?? (error => error === reachedSnapshot));
    assert.deepEqual(traffic, expectedFailure ? [] : [
      { path: '/api/v1/uploads', body: family.media.toString() },
      { path: '/api/v1/uploads/uploaded-public/complete', body: '' },
    ]);
  });
});
