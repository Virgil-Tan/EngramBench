import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { B_CASES } from '../evaluators/learning/mediadock/v2/cases/b.mjs';
import { createFixtureFactory, uploadFixture } from '../evaluators/learning/mediadock/v2/lib/fixtures.mjs';

test('MediaDock actual B-03 callbacks include the public ScanJob and scanner request identities', async () => {
  const root = new URL('../task-packages/v2/mediadock/public-contract/', import.meta.url);
  const wire = await evaluatorContract(root.pathname);
  const contract = JSON.parse(await readFile(new URL('contract.json', root)));
  const shape = name => Object.fromEntries(Object.keys(contract.schemas[name].properties).map(key => [key, null]));
  const f = createFixtureFactory({ evaluationSeed: 'scan', caseId: 'B-03', baseTime: '2026-09-07T00:00:00.000Z' });
  const job = { scanJobId: f.uuid('scan'), assetId: f.uuid('asset'), scannerRequestId: 'scanner-request' };
  const reached = new Error('callback captured'), requests = [];
  let upload;
  const ctx = {
    at: f.at, uniqueKey: f.key, seedFixture: () => ({}), seed: async () => {},
    startApi: async () => ({ baseUrl: 'http://author.invalid' }),
    createTenant: async () => ({ status: 200, json: { tenantId: f.uuid('tenant') } }),
    uploadFixture: (name, options) => uploadFixture(f, name, options),
    createUpload: async (_url, body) => ({ status: 200, json: upload = { ...shape('UploadSession'), ...body, uploadId: f.uuid('upload') } }),
    putPart: async (_url, uploadId, part) => {
      const { bytes, ...metadata } = part;
      return { status: 200, json: { ...shape('UploadPart'), ...metadata, uploadId, createdAt: f.at() } };
    },
    completeUpload: async () => ({ status: 200, json: { ...upload, state: 'COMPLETED', assetId: job.assetId } }),
    snapshot: async () => ({ resources: { scanJobs: [job] } }),
    mutate: async (_url, path, key, body) => {
      wire.request(path, { method: 'POST', headers: { 'Idempotency-Key': key }, json: body });
      requests.push(body); throw reached;
    },
  };
  await assert.rejects(B_CASES.find(c => c.id === 'B-03').run(ctx), error => error === reached);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.scanJobId, job.scanJobId);
    assert.equal(request.scannerRequestId, job.scannerRequestId);
  }
});
