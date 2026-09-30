import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import contract from '../contracts/learning/identitymesh.mjs';
import { openApi } from '../templates/contract-first/runtime.mjs';
import { CASES } from '../evaluators/learning/identitymesh/v2/cases/index.mjs';
import { auditSeed, createFixtureFactory, identityCatalog, loginAttemptBody, providerCallback, v1Seed } from '../evaluators/learning/identitymesh/v2/lib/fixtures.mjs';

// Run the actual case orchestration against valid canned snapshots. This probe
// asserts only ownership of concurrent rejections, never candidate correctness.
async function probe(caseId, first) {
  const fixtures = createFixtureFactory({ caseId, evaluationSeed: 'identity-async', baseTime: '2026-09-08T00:00:00.000Z' });
  const requestFailure = new Error('injected concurrent login failure');
  const observerFailure = new Error('injected observation failure');
  let resources, catalog, parallel = false, finished = 0, page = 0;
  const widths = [];
  const response = json => ({ status: 200, json, text: JSON.stringify(json) });
  const ctx = {
    caseId, fixtures, key: fixtures.key, at: fixtures.at,
    catalog: label => (catalog = identityCatalog(fixtures, label)),
    seedFor: (label, options) => v1Seed(fixtures, label, options),
    seed: async seed => {
      const { schemaVersion, seedVersion, importedAt, ...initial } = structuredClone(seed);
      resources = { ...initial, loginAttempts: [], deviceChallenges: [] };
      const material = fixtures.deviceMaterial('async-key');
      resources.signingKeys = [{ keyId: fixtures.uuid('key'), tenantId: catalog.tenant.tenantId, publicJwk: material.publicJwk,
        publicKeyFingerprint: material.fingerprint, state: 'ACTIVE', activatedAt: importedAt, retireAt: null, retiredAt: null, sequence: 0 }];
      if (caseId === 'E-04') resources.auditEntries = auditSeed(fixtures, catalog, 105);
    },
    startProvider: async () => {}, startApi: async () => ({ baseUrl: 'http://author.invalid', logs: '' }),
    provider: { resolve() {}, callback: id => providerCallback(fixtures, catalog, 'session', 'SUCCEEDED', { providerRequestId: id }) },
    loginBody: loginAttemptBody,
    callbackBody: (item, label, outcome, options) => providerCallback(fixtures, item, label, outcome, options),
    find: (value, key) => value?.[key],
    assert: (_label, operation) => operation(),
    ok: (_label, value) => assert.ok(value), equal: (_label, actual, expected) => assert.deepEqual(actual, expected),
    waitFor: operation => operation(),
    concurrent: async (items, width, operation) => {
      widths.push([items.length, width]);
      if (caseId === 'D-03' || items.length === 10) parallel = true;
      return Promise.all(items.map(operation));
    },
    createLoginAttempt: async () => {
      if (parallel) {
        if (first === 'observer') await tick();
        finished++;
        throw requestFailure;
      }
      const attempt = { loginAttemptId: fixtures.uuid('attempt'), tenantId: catalog.tenant.tenantId, deviceId: catalog.device.deviceId,
        providerRequestId: 'provider-request', state: 'SUCCEEDED', userId: catalog.user.userId, sessionId: fixtures.uuid('session'),
        createdAt: fixtures.at(), resolvedAt: fixtures.at(), sequence: 0 };
      const session = { sessionId: attempt.sessionId, tenantId: attempt.tenantId, userId: attempt.userId, deviceId: attempt.deviceId,
        tokenFamilyId: fixtures.uuid('family'), state: 'ACTIVE', refreshGeneration: 0, requiredRevocationVersion: 0,
        createdAt: fixtures.at(), expiresAt: fixtures.at({ seconds: 300 }), revokedAt: null, sequence: 0 };
      resources.loginAttempts = [attempt]; resources.sessions = [session];
      return response({ loginAttempt: attempt, session, tokens: { accessToken: 'direct-access', refreshToken: 'direct-refresh' } });
    },
    providerCallback: async () => response(resources.loginAttempts[0]),
    readOpenApi: async () => openApi(contract),
    snapshot: async () => {
      if (caseId === 'D-03' && parallel) {
        if (first === 'observer') throw observerFailure;
        await tick();
      }
      return structuredClone({ asOf: fixtures.at(), resources, work: [] });
    },
    audit: async () => {
      if (parallel) {
        if (first === 'observer') throw observerFailure;
        await tick();
      }
      const entry = resources.auditEntries[page++];
      return response({ items: [entry], nextCursor: page === 105 ? null : `cursor-${page}` });
    },
  };
  await assert.rejects(CASES.find(item => item.id === caseId).run(ctx), error => error === (first === 'observer' ? observerFailure : requestFailure));
  // Delayed requests must not leak an unhandled rejection after observation fails.
  await tick(); await tick();
  assert.equal(finished, caseId === 'D-03' ? 12 : 10);
  assert.deepEqual(widths, caseId === 'D-03' ? [[12, 6]] : [[105, 20], [10, 5]]);
}

if (process.argv[2]) await probe(process.argv[2], process.argv[3]);
else for (const caseId of ['D-03', 'E-04']) for (const first of ['request', 'observer']) {
  test(`IdentityMesh ${caseId} retains handled failures when ${first} fails first`, () => {
    execFileSync(process.execPath, ['--unhandled-rejections=strict', fileURLToPath(import.meta.url), caseId, first], { encoding: 'utf8', stdio: 'pipe', timeout: 5000 });
  });
}
