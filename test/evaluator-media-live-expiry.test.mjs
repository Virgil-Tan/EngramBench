import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { openUpload, createGrant } from '../evaluators/learning/mediadock/v2/cases/helpers.mjs';
import { A_CASES } from '../evaluators/learning/mediadock/v2/cases/a.mjs';
import { createFixtureFactory, uploadFixture } from '../evaluators/learning/mediadock/v2/lib/fixtures.mjs';

test('MediaDock live capabilities remain future-dated when the deterministic fixture clock is historical', async (t) => {
  const now = Date.parse('2030-05-06T12:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });
  const contract = JSON.parse(await readFile(new URL('../task-packages/v2/mediadock/public-contract/contract.json', import.meta.url)));
  const shape = (name) => Object.fromEntries(Object.keys(contract.schemas[name].properties).map(key => [key, null]));
  const fixture = { fileName: 'sample.txt', contentType: 'text/plain', expectedSize: 1, expectedSha256: 'a'.repeat(64), partSize: 8192, bytes: Buffer.from('x') };
  const calls = [];
  const ctx = {
    at: () => '2026-09-07T00:00:00.000Z', uniqueKey: () => 'request-key',
    createUpload: async (_url, body) => { calls.push(body); return { status: 200, json: { ...shape('UploadSession'), ...body } }; },
    mutate: async (_url, _path, _key, body) => { calls.push(body); return { status: 200, json: { grant: { ...shape('AccessGrant'), ...body }, url: '/media/grant', token: 'opaque' } }; },
  };
  await openUpload(ctx, { baseUrl: 'http://author.invalid' }, 'tenant', fixture, 'upload');
  await createGrant(ctx, { baseUrl: 'http://author.invalid' }, 'asset');
  assert.equal(Date.parse(calls[0].expiresAt), now + 30 * 60_000);
  assert.equal(Date.parse(calls[1].expiresAt), now + 10 * 60_000);
  assert.ok(Date.parse(calls[1].expiresAt) <= now + 15 * 60_000, 'keep the published grant maximum');
  await createGrant(ctx, { baseUrl: 'http://author.invalid' }, 'asset', { expiresAt: '2026-09-07T00:00:00.000Z' });
  assert.equal(calls[2].expiresAt, '2026-09-07T00:00:00.000Z', 'explicit expiry edge tests are not rewritten');
});

test('MediaDock actual A-05 replays the identical capability request after wall time advances', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-05-06T12:00:00.000Z') });
  const contract = JSON.parse(await readFile(new URL('../task-packages/v2/mediadock/public-contract/contract.json', import.meta.url)));
  const shape = name => Object.fromEntries(Object.keys(contract.schemas[name].properties).map(key => [key, null]));
  const f = createFixtureFactory({ evaluationSeed: 'replay', caseId: 'A-05', baseTime: '2026-09-07T00:00:00.000Z' });
  const reached = new Error('identical replay observed');
  let upload, first;
  const ctx = {
    at: f.at, uniqueKey: f.key, seedFixture: () => ({}), seed: async () => {},
    startApi: async () => ({ baseUrl: 'http://author.invalid' }), startWorker: async () => ({}),
    createTenant: async () => ({ status: 200, json: { tenantId: f.uuid('tenant') } }),
    uploadFixture: (name, options) => uploadFixture(f, name, options),
    createUpload: async (_url, body) => ({ status: 200, json: upload = { ...shape('UploadSession'), ...body, uploadId: f.uuid('upload') } }),
    putPart: async (_url, uploadId, part) => {
      const { bytes, ...metadata } = part;
      return { status: 200, json: { ...shape('UploadPart'), ...metadata, uploadId, createdAt: f.at() } };
    },
    completeUpload: async () => ({ status: 200, json: { ...upload, state: 'COMPLETED', assetId: f.uuid('asset') } }),
    waitFor: async operation => operation(),
    getAsset: async () => ({ status: 200, json: { ...shape('MediaAsset'), assetId: f.uuid('asset'), state: 'READY' } }),
    mutate: async (_url, path, key, body) => {
      if (first) { assert.deepEqual({ path, key, body }, first); throw reached; }
      first = structuredClone({ path, key, body });
      t.mock.timers.tick(500);
      return { status: 200, json: { grant: { ...shape('AccessGrant'), ...body }, url: '/media/grant', token: 'opaque' } };
    },
  };
  await assert.rejects(A_CASES.find(c => c.id === 'A-05').run(ctx), error => error === reached);
});
