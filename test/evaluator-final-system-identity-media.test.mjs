import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import identity from '../contracts/learning/identitymesh.mjs';
import media from '../contracts/learning/mediadock.mjs';
import { matchOperation, validator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory, identityCatalog, v1Seed } from '../evaluators/learning/identitymesh/v2/lib/fixtures.mjs';
import { recoverIncident } from '../evaluators/learning/identitymesh/v2/cases/final-system.mjs';
import { aliasGrant, assertPinnedBytes, assertSnapshotConsistency, createAlias, publish } from '../evaluators/learning/mediadock/v2/cases/final-system.mjs';

// These isolated HTTP response doubles test evaluator sensitivity, not candidate
// business correctness. They are never imported by the runtime or its seed path.
async function endpoint(t, contract, dispatch) {
  const calls = [], compile = validator(contract);
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks), body = bytes.length ? JSON.parse(bytes) : undefined;
      const path = new URL(req.url, 'http://local').pathname;
      const matched = matchOperation(contract.operations, req.method, path);
      assert.ok(matched, `public route ${req.method} ${path}`);
      const check = matched.operation.request && compile(matched.operation.request);
      if (check) assert.ok(check(body), JSON.stringify(check.errors));
      calls.push({ path, body, key: req.headers['idempotency-key'] });
      const result = await dispatch(path, body, req.headers['idempotency-key']);
      res.writeHead(result.status ?? 200, { 'content-type': result.bytes ? 'application/octet-stream' : 'application/json' });
      res.end(result.bytes ?? JSON.stringify(result.json));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ failure: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (base, path, options = {}) => {
    const response = await fetch(new URL(path, base), { method: options.method, headers: options.headers, body: options.json === undefined ? undefined : JSON.stringify(options.json) });
    const bytes = Buffer.from(await response.arrayBuffer()), text = bytes.toString();
    return { status: response.status, text, body: bytes, json: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };
  const mutate = (base, path, key, json) => request(base, path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, json });
  return { baseUrl, calls, request, mutate };
}

async function recoveryDouble(t, fault) {
  const f = createFixtureFactory({ evaluationSeed: 'final-system-regression', caseId: 'B-05', baseTime: '2026-09-08T00:00:00.000Z' });
  const catalog = identityCatalog(f), seed = v1Seed(f, 'regression', { catalogs: [catalog] });
  const { schemaVersion: _version, importedAt: _time, seedVersion: _seed, ...resources } = seed;
  const incident = { incidentId: f.uuid('incident'), tenantId: catalog.tenant.tenantId, compromiseEpoch: 1, approverIds: ['owner', 'reviewer'], requiredApprovals: 2, state: 'QUARANTINED', newKeyId: null, createdAt: f.at(), recoveryReadyAt: null, recoveredAt: null, sequence: 0 };
  const session = { sessionId: f.uuid('session'), tenantId: catalog.tenant.tenantId, userId: catalog.user.userId, deviceId: catalog.device.deviceId, tokenFamilyId: f.uuid('family'), state: 'REVOKED', refreshGeneration: 0, requiredRevocationVersion: 1, createdAt: f.at(), expiresAt: f.at({ seconds: 300 }), revokedAt: f.at(), sequence: 1 };
  resources.devices[0].state = 'SUSPENDED';
  Object.assign(resources, { sessions: [session], loginAttempts: [], deviceChallenges: [], compromiseIncidents: [structuredClone(incident)], recoveryApprovals: [] });
  const state = { schemaVersion: 1, asOf: f.at(), resources, work: [], events: [] }, saved = new Map();
  let ordinal = 0, killed = 0;
  const event = type => state.events.push({ eventId: f.uuid(`event-${state.events.length}`), aggregateId: incident.incidentId, type, sequence: state.events.length + 1, occurredAt: f.at(), payload: {} });
  const http = await endpoint(t, identity, async (path, body, key) => {
    if (path.endsWith('verification-snapshot')) return { json: state };
    if (saved.has(key)) return { json: saved.get(key) };
    let value;
    const current = resources.compromiseIncidents[0];
    if (path.endsWith('/approvals')) {
      if (!incident.approverIds.includes(body.approverId)) return { status: 409, json: { error: { code: 'APPROVER_NOT_ALLOWED', message: 'denied', details: {} } } };
      const approval = { incidentId: incident.incidentId, approverId: body.approverId, compromiseEpoch: 1, approvedAt: f.at() };
      resources.recoveryApprovals.push(approval);
      if (resources.recoveryApprovals.length === 2 || fault === 'early-quorum') {
        current.state = 'RECOVERY_READY'; current.recoveryReadyAt = f.at(); event('tenant.recovery_ready');
      }
      value = { incident: current, approval };
    } else if (path.endsWith('/rotate')) {
      const keyId = f.uuid('new-key'), material = f.deviceMaterial('new-key');
      value = { keyId, tenantId: incident.tenantId, publicJwk: { ...material.publicJwk, kid: keyId, alg: 'EdDSA', use: 'sig' }, publicKeyFingerprint: material.fingerprint, state: 'ACTIVE', activatedAt: f.at({ seconds: 1 }), retireAt: null, retiredAt: null, sequence: 0 };
      resources.signingKeys.push(value);
    } else if (path.endsWith('/recover')) {
      Object.assign(current, { state: 'RECOVERED', recoveredAt: f.at(), newKeyId: body.newKeyId });
      event('tenant.recovered');
      if (fault === 'duplicate-recovery') event('tenant.recovered');
      if (fault === 'resurrection') resources.sessions[0].state = 'ACTIVE';
      state.work.push({ workId: f.uuid('recovery-work'), kind: 'TENANT_RECOVERY', aggregateId: incident.incidentId, state: 'SUCCEEDED', terminal: true, attempt: 1, leaseOwner: null, leaseExpiresAt: null });
      value = current;
    } else throw new Error(`unexpected public mutation ${path}`);
    saved.set(key, structuredClone(value));
    return { json: value };
  });
  const ctx = {
    key: label => f.key(`${label}-${ordinal++}`), request: http.request, mutate: http.mutate,
    snapshot: async base => (await http.request(base, '/api/v1/verification-snapshot')).json,
    assert: (_label, operation) => operation(),
    waitFor: async operation => { const value = await operation(); assert.ok(value, 'double supplies the observed public state'); return value; },
    stop: async () => {}, kill: async () => { killed += 1; }, startApi: async () => ({ baseUrl: http.baseUrl }), startWorker: async () => ({}),
    rotateKey: (base, body) => http.mutate(base, '/api/v1/signing-keys/rotate', f.key(`rotate-${ordinal++}`), body),
  };
  return { ctx, calls: http.calls, get killed() { return killed; }, scenario: { api: { baseUrl: http.baseUrl }, catalog, incident, login: { session } } };
}

test('Identity recovery oracle sends schema-valid real HTTP approvals/recover and preserves concurrent replay', async t => {
  const candidate = await recoveryDouble(t);
  const result = await recoverIncident(candidate.ctx, candidate.scenario, { concurrent: true, restart: true });
  assert.equal(result.recoveryResponses, 16);
  assert.equal(candidate.calls.filter(x => x.path.endsWith('/approvals')).length, 18);
  assert.equal(candidate.calls.filter(x => x.path.endsWith('/recover')).length, 16);
  assert.equal(candidate.killed, 1);
});
for (const [fault, message] of [['early-quorum', /one approval cannot/], ['duplicate-recovery', /2 !== 1/], ['resurrection', /never resurrects/]]) {
  test(`Identity recovery rejects independent ${fault} candidate response`, async t => {
    const candidate = await recoveryDouble(t, fault);
    await assert.rejects(recoverIncident(candidate.ctx, candidate.scenario, { concurrent: true }), message);
    assert.ok(candidate.calls.some(x => x.path.endsWith('/approvals')));
  });
}

async function publicationDouble(t, fault) {
  const source = structuredClone(media.seed.example), alias = source.mediaAliases[0];
  const assetId = '40000000-0000-4000-8000-000000000005';
  let revision, ordinal = 0;
  const bytes = Buffer.from('candidate served immutable publication bytes');
  const http = await endpoint(t, media, async (path, body) => {
    if (path === '/api/v1/media-aliases') return { json: { alias: { ...alias, ...body } } };
    if (path.endsWith('/publish')) {
      revision = { publicationRevisionId: '40000000-0000-4000-8000-000000000009', aliasId: alias.aliasId, tenantId: alias.tenantId, revision: body.expectedRevision + 1, assetId: body.assetId, sourceBlobId: '40000000-0000-4000-8000-000000000010', renditionIds: [], createdAt: source.importedAt, retainUntil: '2031-04-05T07:07:08.000Z' };
      return { json: { alias: { ...alias, currentRevision: revision.revision, currentPublicationRevisionId: fault === 'half-switch' ? null : revision.publicationRevisionId }, revision } };
    }
    if (path.endsWith('/access-grants')) return { json: { grant: { grantId: '40000000-0000-4000-8000-000000000007', tenantId: alias.tenantId, assetId, renditionId: null, state: 'ACTIVE', expiresAt: body.expiresAt, createdAt: source.importedAt, revokedAt: null, publicationRevisionId: revision.publicationRevisionId }, token: 'opaque-capability', url: '/media/40000000-0000-4000-8000-000000000007' } };
    if (path.startsWith('/media/')) return { bytes: fault === 'wrong-bytes' ? Buffer.from('wrong revision') : bytes };
    throw new Error(path);
  });
  return { ctx: { ...http, uniqueKey: label => `${label}-${ordinal++}` }, api: { baseUrl: http.baseUrl }, alias, assetId, bytes, calls: http.calls };
}

test('Media publication oracles call real published HTTP and compare downloaded bytes', async t => {
  const c = await publicationDouble(t);
  const alias = await createAlias(c.ctx, c.api, c.alias.tenantId, c.alias.requiredProfileIds, 'Public alias');
  const published = await publish(c.ctx, c.api, alias, c.assetId, 0);
  const grant = await aliasGrant(c.ctx, c.api, alias);
  await assertPinnedBytes(c.ctx, c.api, grant, published.revision, c.bytes);
  assert.equal(c.calls.length, 4);
});
for (const fault of ['half-switch', 'wrong-bytes']) {
  test(`Media publication rejects independent ${fault} candidate response`, async t => {
    const c = await publicationDouble(t, fault);
    await assert.rejects(async () => {
      const published = await publish(c.ctx, c.api, c.alias, c.assetId, 0);
      const grant = await aliasGrant(c.ctx, c.api, c.alias);
      await assertPinnedBytes(c.ctx, c.api, grant, published.revision, c.bytes);
    }, /AssertionError/);
    assert.ok(c.calls.length > 0);
  });
}

test('Media point-in-time oracle rejects torn upload and publication snapshots', () => {
  const resources = Object.fromEntries(Object.keys(media.schemas.Snapshot.properties.resources.properties).map(key => [key, []]));
  const state = { resources, work: [], events: [] };
  resources.uploadSessions.push({ uploadId: 'u', state: 'COMPLETED', assetId: 'a', expectedSize: 1, expectedSha256: 'digest' });
  resources.mediaAssets.push({ assetId: 'a', sourceBlobId: 'b' });
  resources.blobObjects.push({ blobId: 'b', size: 1, sha256: 'digest' });
  resources.scanJobs.push({ scanJobId: 's', assetId: 'a' });
  state.events.push({ type: 'upload.completed', aggregateId: 'u' });
  resources.mediaAliases.push({ aliasId: 'alias', currentRevision: 1, currentPublicationRevisionId: 'revision' });
  resources.publicationRevisions.push({ aliasId: 'alias', revision: 1, publicationRevisionId: 'revision' });
  assert.doesNotThrow(() => assertSnapshotConsistency(state, ['u']));
  for (const mutate of [x => { x.resources.mediaAssets = []; }, x => { x.resources.scanJobs = []; }, x => { x.events = []; }, x => { x.resources.uploadSessions[0].state = 'OPEN'; }, x => { x.resources.publicationRevisions = []; }, x => { x.resources.mediaAliases[0].currentRevision = 0; }]) {
    const torn = structuredClone(state); mutate(torn);
    assert.throws(() => assertSnapshotConsistency(torn, ['u']), /AssertionError/);
  }
});
