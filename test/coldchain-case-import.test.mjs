import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import contract from '../contracts/transfer/coldchaincontrol.mjs';
import { openApi } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/coldchaincontrol/v2/fixtures/index.mjs';
import { assertPublishedResponse } from '../evaluators/transfer/coldchaincontrol/v2/oracles/openapi.mjs';

test('the author default Error schema accepts documented 400 bodies and rejects malformed envelopes', () => {
  const response = { status: 400, json: { error: { code: 'INVALID_REQUEST', message: 'missing required body', details: {} } } };
  assertPublishedResponse('POST', '/api/v1/tenants', response);
  for (const json of [{}, { error: 'INVALID_REQUEST' }, { error: { code: 'INVALID_REQUEST', message: 'missing details' } }, { ...response.json, extra: true }]) {
    assert.throws(() => assertPublishedResponse('POST', '/api/v1/tenants', { status: 400, json }), /published response/);
  }
});

test('the actual ColdChain case registry imports without per-request context and contains every declared case', async () => {
  const { CASES } = await import('../evaluators/transfer/coldchaincontrol/v2/cases/index.mjs');
  const manifest = JSON.parse(await readFile(new URL('../evaluators/transfer/coldchaincontrol/v2/manifest.v2.json', import.meta.url)));
  assert.deepEqual(CASES.map(row => row.id).sort(), manifest.cases.map(row => row.id).sort());
  assert(CASES.every(row => typeof row.run === 'function'));
});

test('D-01 applies the author response assertion inside the real live-request loop, even with permissive submission OpenAPI', async () => {
  const { D_CASES } = await import('../evaluators/transfer/coldchaincontrol/v2/cases/d.mjs');
  const f = createFixtureFactory({ evaluationSeed: 'response-loop-regression', caseId: 'D-01', baseTime: '2026-09-08T00:00:00Z' });
  const document = openApi(contract);
  document.paths['/api/v1/tenants'].post.responses['400'].content['application/json'].schema = { type: 'object', additionalProperties: true };
  const nextRoute = new Error('first response validated; reached the next route');
  let malformed = true, checked = 0;
  const ctx = { fixtures: f, uuid: f.uuid, key: f.key, mark() {}, migrate: async () => {}, seed: async () => {},
    startApi: async () => ({ baseUrl: 'http://test-unused' }), snapshot: async () => ({ asOf: f.at(), resources: {} }),
    request: async (_base, path) => {
      if (path === '/openapi.json') return { status: 200, json: document };
      if (path !== '/api/v1/tenants') throw nextRoute;
      checked++;
      return { status: 400, json: { error: { code: 'INVALID_REQUEST', message: 'missing required body', details: {} }, ...(malformed ? { extra: 'not in the author contract' } : {}) } };
    } };
  const run = () => D_CASES.find(row => row.id === 'D-01').run(ctx);
  await assert.rejects(run(), /published response/);
  malformed = false;
  await assert.rejects(run(), error => error === nextRoute);
  assert.equal(checked, 2);
});
