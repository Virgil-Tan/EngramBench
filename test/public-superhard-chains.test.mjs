import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import creator from '../contracts/transfer/creatorrightsexchange.mjs';
import access from '../contracts/transfer/accesssentinel.mjs';
import { probe, prepareProbe } from '../templates/contract-first/check.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { assertStoredReview } from '../evaluators/transfer/accesssentinel/v2/cases/helpers.mjs';

test('public upload probes transmit the published bytes and reject uncommitted completion identities', async t => {
  const start = creator.smoke.findIndex(p => p.operationId === 'createUpload');
  const contract = { ...creator, smoke: creator.smoke.slice(start, start + 5) };
  const input = contract.smoke[0].body, now = '2026-09-08T00:00:00Z';
  const uploadId = '40000000-0000-4000-8000-000000000001', blobId = '40000000-0000-4000-8000-000000000002';
  const upload = { ...input, uploadId, state: 'OPEN', createdAt: now, expiresAt: '2099-01-01T00:00:00Z', completedAt: null };
  const chunk = { uploadId, chunkNumber: 1, startByte: 0, endByte: 0, sizeBytes: 1, sha256: input.contentSha256, createdAt: now };
  const blob = { blobId, tenantId: input.tenantId, sha256: input.contentSha256, sizeBytes: 1, state: 'QUARANTINED', createdAt: now };
  let persist = true;
  // Test-only HTTP fixture for the checker; never shipped as submission code.
  const server = createServer(async (req, res) => {
    let body;
    if (req.method === 'PUT') {
      const chunks = []; for await (const bytes of req) chunks.push(bytes);
      const wire = Buffer.concat(chunks);
      assert.equal(wire.toString(), 'a');
      assert.equal(req.headers['content-range'], 'bytes 0-0/1');
      assert.equal(req.headers['x-chunk-sha256'], createHash('sha256').update(wire).digest('hex'));
      body = chunk;
    } else if (req.url.endsWith('/complete')) {
      upload.state = 'COMPLETED'; upload.completedAt = now; body = { uploadSession: upload, blobObject: blob };
    } else if (req.url.endsWith('/verification-snapshot')) {
      body = { schemaVersion: 1, asOf: now, resources: Object.fromEntries(Object.keys(creator.schemas.VerificationSnapshot.properties.resources.properties).map(k => [k, []])), work: [], events: [] };
      body.resources.uploadSessions = [upload]; body.resources.blobObjects = persist ? [blob] : [];
    } else if (req.method === 'GET') body = { uploadSession: upload, chunks: [chunk] };
    else { upload.state = 'OPEN'; upload.completedAt = null; body = { uploadSession: upload }; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const valid = await probe(contract, url, { ADMIN_TOKEN: 'public-fixture' });
  assert.equal(valid.passed, true, JSON.stringify(valid.findings));
  persist = false;
  const missing = await probe(contract, url, { ADMIN_TOKEN: 'public-fixture' });
  assert.equal(missing.passed, false);
  assert.match(missing.findings.at(-1).message, /nonempty record identity mismatch/);
});

test('public Access request depends on the accepted Session, published policy and seeded risk revision', () => {
  const session = access.smoke.find(p => p.operationId === 'createSession' && p.expectStatus === 200);
  const request = access.smoke.find(p => p.operationId === 'createAccessRequest');
  const seed = access.seed.example;
  assert(validator(access)(access.seed.schema)(seed));
  assert.equal(session.body.deviceTrustRevisionId, seed.deviceTrustRevisions[0].deviceTrustRevisionId);
  const variables = { publicSessionId: '40000000-0000-4000-8000-000000000003', publicSessionGeneration: 1, publicPolicyRevisionId: '40000000-0000-4000-8000-000000000004' };
  const wire = prepareProbe(request, variables);
  assert.equal(wire.body.sessionId, variables.publicSessionId);
  assert.equal(wire.expectBody.sessionGeneration, 1);
  assert.equal(wire.expectBody.policyRevisionId, variables.publicPolicyRevisionId);
  assert.equal(wire.expectBody.riskModelRevisionId, seed.riskModelRevisions[0].riskModelRevisionId);
  assert(access.smoke.at(-1).expectContains.some(row => row.path.join('.') === 'resources.accessRequests' && row.match.accessRequestId === '${publicAccessRequestId}'));
});

test('published Review success cannot pass with an unpersisted response or unchanged request state', async () => {
  const body = { reviewerId: 'reviewer', decision: 'APPROVE', comment: 'Independent review' };
  const review = { accessReviewId: 'review', accessRequestId: 'request', tenantId: 'tenant', ...body, createdAt: '2026-09-08T00:00:00Z' };
  const state = { schemaVersion: 1, asOf: review.createdAt, resources: Object.fromEntries(Object.keys(access.schemas.Snapshot.properties.resources.properties).map(k => [k, []])), work: [], events: [], metrics: { databaseBytes: 0 } };
  state.resources.accessRequests = [{ accessRequestId: 'request', tenantId: 'tenant', state: 'APPROVED' }]; state.resources.accessReviews = [review];
  const ctx = { equal: assert.deepEqual, ok: assert.ok, assert: (_label, fn) => fn(), snapshot: async () => state };
  await assertStoredReview(ctx, 'http://fixture', 'request', body, { status: 200, json: review });
  state.resources.accessReviews = [];
  await assert.rejects(assertStoredReview(ctx, 'http://fixture', 'request', body, { status: 200, json: review }), /accessReviews/);
  state.resources.accessReviews = [review]; state.resources.accessRequests[0].state = 'PENDING_REVIEW';
  await assert.rejects(assertStoredReview(ctx, 'http://fixture', 'request', body, { status: 200, json: review }), /review updates the request/);
});
