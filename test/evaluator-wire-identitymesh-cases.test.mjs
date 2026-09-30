import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import test from 'node:test';
import contract from '../contracts/learning/identitymesh.mjs';
import { matchOperation, openApi, validator } from '../templates/contract-first/runtime.mjs';
import { CASES } from '../evaluators/learning/identitymesh/v2/cases/index.mjs';
import { createFixtureFactory } from '../evaluators/learning/identitymesh/v2/lib/fixtures.mjs';
import { decorateIdentityMeshContext } from '../evaluators/learning/identitymesh/v2/lib/runtime.mjs';

const compile = validator(contract);
const requests = new Map(contract.operations.filter(item => item.request).map(item => [item.id, compile(item.request)]));
const replies = new Map(contract.operations.filter(item => item.response).map(item => [item.id, compile(item.response)]));
const response = (json, status = 200) => ({ status, json, text: JSON.stringify(json) });
const conflict = code => response({ error: { code, message: code, details: {} } }, 409);

// Canned public responses let actual case code reach its next request. Every run
// stops at a named wire checkpoint; none is a substitute IdentityMesh business pass.
async function wireContext(caseId) {
  const fixtures = createFixtureFactory({ caseId, evaluationSeed: 'identity-wire', baseTime: '2026-09-08T00:00:00.000Z' });
  const calls = [], records = new Map(), saved = new Map(), parallelism = [];
  const stop = new Error(`${caseId}: wire checkpoint reached`);
  let state, loginCount = 0, snapshotCount = 0, workerCount = 0, drop = false;
  const captures = [];
  const raw = {
    caseId, fixtures, key: fixtures.key, at: fixtures.at,
    startApi: async () => ({ baseUrl: 'http://wire.invalid', logs: '' }),
    startWorker: async () => {
      workerCount += 1;
      if (state.work[0]) Object.assign(state.work[0], { state: 'LEASED', leaseOwner: `wire-worker-${workerCount}`, leaseExpiresAt: fixtures.at({ seconds: 60 }), attempt: workerCount });
      return { logs: '' };
    },
    kill: async () => {},
    waitFor: async probe => { const value = await probe(); assert.ok(value, 'canned checkpoint is available'); return value; },
    concurrent: async (items, width, operation) => { parallelism.push([items.length, width]); return Promise.all(items.map(operation)); },
    responseShield: async () => ({ baseUrl: 'http://shield.invalid', captures, dropNextMutation() { drop = true; } }),
    request: async (baseUrl, path, options = {}) => {
      const route = matchOperation(contract.operations, options.method ?? 'GET', new URL(path, baseUrl).pathname);
      assert.ok(route, `published route: ${path}`);
      const id = route.operation.id, body = options.json, check = requests.get(id);
      if (check) assert.ok(check(body), `${caseId} ${id}: ${JSON.stringify(check.errors)}`);
      calls.push({ id, body: structuredClone(body), key: options.headers?.['Idempotency-Key'] });
      if ((caseId === 'A-02' && id === 'refresh-session')
        || (['A-04', 'C-04', 'E-02'].includes(caseId) && id === 'rotate-signing-key')
        || (['A-01', 'C-01'].includes(caseId) && id === 'reconcile-login-attempt')
        || (caseId === 'A-03' && id === 'approve-device-challenge')
        || (caseId === 'C-02' && id === 'refresh-session')
        || (caseId === 'B-03' && id === 'create-device-challenge' && calls.filter(item => item.id === id).length === 2)) throw stop;
      let result;
      if (id === 'create-login-attempt') {
        const key = options.headers['Idempotency-Key'];
        if (saved.has(key)) {
          const previous = saved.get(key);
          result = JSON.stringify(previous.body) === JSON.stringify(body) ? previous.response : conflict('IDEMPOTENCY_CONFLICT');
        } else if (caseId === 'A-01' && loginCount === 2) result = conflict('LOGIN_RESULT_UNKNOWN');
        else {
          loginCount += 1;
          const unknown = caseId === 'C-01' || (caseId === 'A-01' && loginCount === 2) || caseId === 'B-01';
          const outcome = unknown ? 'UNKNOWN' : caseId === 'E-04' ? 'FAILED' : 'SUCCEEDED';
          const user = state.resources.users.find(item => item.tenantId === body.tenantId && item.username === body.username);
          assert.ok(user, 'fixture login identifies an explicitly seeded User');
          const attempt = { loginAttemptId: fixtures.uuid(`attempt-${loginCount}`), tenantId: body.tenantId, deviceId: body.deviceId,
            providerRequestId: `opaque/server-request/${loginCount}`, state: outcome, userId: outcome === 'SUCCEEDED' ? user.userId : null,
            sessionId: outcome === 'SUCCEEDED' ? fixtures.uuid(`session-${loginCount}`) : null,
            createdAt: fixtures.at(), resolvedAt: unknown ? null : fixtures.at(), sequence: 0 };
          const session = outcome === 'SUCCEEDED' ? { sessionId: attempt.sessionId, tenantId: body.tenantId, userId: user.userId,
            deviceId: body.deviceId, tokenFamilyId: fixtures.uuid(`family-${loginCount}`), state: 'ACTIVE',
            refreshGeneration: 7, requiredRevocationVersion: 83, createdAt: fixtures.at(), expiresAt: fixtures.at({ seconds: 300 }), revokedAt: null, sequence: 0 } : null;
          const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: state.resources.signingKeys[0].keyId })).toString('base64url');
          const payload = Buffer.from(JSON.stringify({ iat: Date.parse(fixtures.at()) / 1000, exp: Date.parse(fixtures.at()) / 1000 + 300 })).toString('base64url');
          const accessToken = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), fixtures.deviceMaterial('wire-signing').privateKey).toString('base64url')}`;
          const tokens = session ? { accessToken, refreshToken: `issued-wire-refresh-${loginCount}`, expiresAt: session.expiresAt } : null;
          records.set(attempt.providerRequestId, { attempt, userId: user.userId, outcome });
          state.resources.loginAttempts.push(attempt);
          if (session) state.resources.sessions.push(session);
          if (caseId === 'C-01') state.work.push({ workId: fixtures.uuid('login-work'), kind: 'LOGIN_RECONCILIATION', aggregateId: attempt.loginAttemptId,
            state: 'PENDING', terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null });
          result = response({ loginAttempt: attempt, session, tokens });
          saved.set(key, { body, response: result });
        }
      } else if (id === 'provider-callback') {
        const record = records.get(body.providerRequestId);
        assert.ok(record, 'callback uses the actual returned provider request identity');
        result = response(record.attempt);
      } else if (id === 'register-device') {
        let device = state.resources.devices.find(item => item.publicKeyFingerprint === body.publicKeyFingerprint);
        if (!device) {
          device = { ...body, deviceId: fixtures.uuid('new-wire-device'), state: 'PENDING', trustRevision: 0, createdAt: fixtures.at(), terminalAt: null };
          state.resources.devices.push(device);
        }
        result = response(device);
      }
      else if (id === 'create-device-challenge') {
        result = response({ challenge: { challengeId: fixtures.uuid('wire-challenge'), deviceId: route.params.deviceId,
          userId: body.userId, nonceDigest: 'a'.repeat(64), state: 'PENDING', expiresAt: fixtures.at({ seconds: body.expiresInSeconds }), usedAt: null }, nonce: 'server-issued-nonce' });
      } else if (id === 'revoke-device') result = response({ ...state.resources.devices.find(item => item.deviceId === route.params.deviceId), state: 'REVOKED', terminalAt: fixtures.at() });
      else if (id === 'approve-device-challenge' || id === 'refresh-session') result = conflict('SUBJECT_REVOKED');
      else if (id === 'create-revocation') {
        const revocationId = fixtures.uuid('revocation');
        result = response({ revocationId, tenantId: body.tenantId, subjectType: body.subjectType, subjectId: body.subjectId,
          version: 84, state: 'REQUESTED', createdAt: fixtures.at(), propagatedAt: null });
        state.work.push({ workId: fixtures.uuid('revoke-work'), kind: 'REVOCATION_PROPAGATION', aggregateId: revocationId,
          state: 'PENDING', terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null });
      } else if (id === 'read-jwks') result = response({ keys: state.resources.signingKeys.map(item => item.publicJwk) });
      else if (id === 'openapi') result = response(openApi(contract));
      else throw new Error(`No canned wire response for ${id}`);
      const valid = replies.get(id);
      if (result.status === 200 && valid) assert.ok(valid(result.json), `canned ${id} reply matches public schema: ${JSON.stringify(valid.errors)}`);
      if (drop && baseUrl === 'http://shield.invalid') {
        drop = false; captures.push({ dropped: true, response: { status: result.status, body: result.text } });
        throw new Error('canned lost response');
      }
      return result;
    },
  };
  raw.mutate = (base, path, key, json, options = {}) => raw.request(base, path, { ...options, method: 'POST', headers: { 'Idempotency-Key': key }, json });
  const ctx = await decorateIdentityMeshContext(raw);
  ctx.seed = async seed => {
    assert.ok(compile(contract.seed.schema)(seed), 'actual case seed satisfies the public schema');
    const { schemaVersion: _schema, seedVersion: _version, importedAt, ...resources } = structuredClone(seed);
    const material = fixtures.deviceMaterial('wire-signing'), keyId = fixtures.uuid('signing-key');
    resources.signingKeys = [{ keyId, tenantId: resources.tenants[0].tenantId,
      publicJwk: { ...material.publicJwk, kid: keyId, alg: 'EdDSA', use: 'sig' }, publicKeyFingerprint: material.fingerprint,
      state: 'ACTIVE', activatedAt: importedAt, retireAt: null, retiredAt: null, sequence: 0 }];
    Object.assign(resources, { loginAttempts: [], deviceChallenges: [], compromiseIncidents: [], recoveryApprovals: [] });
    state = { schemaVersion: 1, asOf: importedAt, resources, work: [] };
  };
  ctx.startProvider = async (options = {}) => {
    ctx.provider ??= {
      options,
      baseUrl: 'http://provider-wire.invalid',
      assertHealthy() {},
      get requests() { return [...records.keys()].map(providerRequestId => ({ providerRequestId })); },
      resolve(id, outcome) { const record = records.get(id); assert.ok(record, 'provider resolution uses a real response ID'); record.outcome = outcome; },
      callback(id, metadata) { const record = records.get(id); assert.ok(record); return { ...metadata, providerRequestId: id,
        outcome: record.outcome, userId: record.outcome === 'SUCCEEDED' ? record.userId : null }; },
    };
    return ctx.provider;
  };
  ctx.snapshot = async () => {
    snapshotCount += 1;
    if ((caseId === 'B-01' && calls.filter(item => item.id === 'provider-callback').length === 3)
      || (caseId === 'D-03' && loginCount === 13) || (caseId === 'E-04' && loginCount === 105)) throw stop;
    for (const [name, key] of [['tenants', 'tenantId'], ['users', 'userId'], ['devices', 'deviceId'], ['sessions', 'sessionId'], ['loginAttempts', 'loginAttemptId']]) {
      state.resources[name].sort((a, b) => a[key].localeCompare(b[key]));
    }
    return structuredClone(state);
  };
  ctx.readOpenApi = async () => openApi(contract);
  return { ctx, calls, parallelism, stop, records, get snapshotCount() { return snapshotCount; } };
}

for (const caseId of ['A-01', 'A-02', 'A-03', 'A-04', 'B-01', 'B-03', 'C-01', 'C-02', 'C-04', 'D-03', 'E-02', 'E-04']) {
  test(`IdentityMesh actual ${caseId} requests reach a schema-checked wire checkpoint`, async () => {
    const fixture = await wireContext(caseId), { ctx, calls, stop } = fixture;
    await assert.rejects(CASES.find(item => item.id === caseId).run(ctx), error => error === stop);
    for (const call of calls.filter(item => item.id === 'refresh-session')) assert.equal(call.body.expectedGeneration, 7, 'token generation is independent of revocation version 83');
    for (const call of calls.filter(item => item.id === 'reconcile-login-attempt')) assert.deepEqual(call.body, {});
    if (['A-03', 'B-03'].includes(caseId)) {
      const approvals = calls.filter(item => item.id === 'approve-device-challenge');
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].body.nonce, 'server-issued-nonce');
      assert.equal(approvals[0].body.expectedTrustRevision, 1);
      if (caseId === 'A-03') {
        const registrations = calls.filter(item => item.id === 'register-device');
        assert.equal(registrations.length, 2);
        assert.equal(registrations[0].key, registrations[1].key, 'registration tests public same-key replay, not unspecified duplicate-fingerprint/new-key behavior');
      }
    }
    if (caseId === 'B-01') {
      assert.deepEqual(calls.filter(item => item.id === 'provider-callback').map(item => item.body.outcome), ['SUCCEEDED', 'FAILED', 'SUCCEEDED']);
      assert.equal(calls.find(item => item.id === 'provider-callback' && item.body.outcome === 'FAILED').body.userId, null);
      assert.equal(fixture.records.values().next().value.outcome, 'SUCCEEDED', 'conflicting notification does not rewrite provider truth');
      assert.equal(calls.filter(item => item.id === 'create-login-attempt').length, 3, 'lost response, replay and valid-wire key conflict are all exercised');
    }
    if (caseId === 'A-04') assert.deepEqual(fixture.parallelism, [[20, 20]]);
    if (caseId === 'D-03') { assert.equal(ctx.provider.options.initialOutcome, 'SUCCEEDED'); assert.deepEqual(fixture.parallelism, [[12, 6]]); }
    if (caseId === 'E-04') {
      assert.equal(ctx.provider.options.initialOutcome, 'FAILED');
      assert.deepEqual(fixture.parallelism, [[105, 20]]);
      assert.equal(calls.filter(item => item.id === 'provider-callback').length, 105);
    }
  });
}
