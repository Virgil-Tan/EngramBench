import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { resolve } from 'node:path';
import { MIGRATE_CASES as artifactCases } from '../evaluators/learning/artifactvault/v2/cases/migrate.mjs';
import { createCaseContext as artifactContext } from '../evaluators/learning/artifactvault/v2/lib/runtime.mjs';
import { MIGRATE_CASES as auctionCases } from '../evaluators/learning/auctionguard/v2/cases/migrate.mjs';
import { createCaseContext as auctionContext } from '../evaluators/learning/auctionguard/v2/lib/runtime.mjs';
import { observeAvailabilityDuringReinitialization } from '../evaluators/learning/clinicgrid/v2/cases/migrate.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';

const root = resolve(import.meta.dirname, '..');
const settings = { workspace: root, evaluationSeed: 'recovery-regression', baseTime: '2026-09-08T00:00:00.000Z', manageDatabase: false };
// Fault-injection tests execute evaluator code, never a submitted application.
async function artifactRecovery(t, fault) {
  const ctx = await artifactContext({ ...settings, caseId: 'MIGRATE-02' });
  t.after(() => ctx.teardown());
  const ids = [1, 2, 3, 4].map(n => `0000000${n}-0000-4000-8000-000000000001`);
  const state = { asOf: ctx.at(), resources: { packages: [], uploadSessions: [], artifactVersions: [], verificationResults: [], blobs: [], blobReferences: [], releases: [] }, work: [], events: [] };
  let migrations = 0, workers = 0, held, barrierReady = false;
  ctx.migrate = async () => {
    if (++migrations === 2) {
      if (fault === 'missing-verification') state.work = state.work.filter(w => w.workId !== ids[2]);
      if (fault === 'reset-attempt') state.work.find(w => w.workId === ids[2]).attempt = 0;
    }
  };
  ctx.startApi = async () => ({ role: 'api', baseUrl: 'http://127.0.0.1:1' });
  ctx.createUpload = async (_url, body) => {
    const upload = { uploadId: ctx.uuid(body.packageName), ...body, nextOffset: 0, state: 'STAGING', expiresAt: ctx.at({ seconds: 86400 }), artifactVersionId: null, createdAt: ctx.at() };
    const index = state.resources.uploadSessions.length;
    state.resources.uploadSessions.push(upload);
    state.work.push({ workId: ids[index], kind: 'UPLOAD_EXPIRY', aggregateId: upload.uploadId, state: 'PENDING', terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null });
    return { status: 201, json: structuredClone(upload) };
  };
  ctx.putChunk = async (_url, uploadId, bytes, start) => {
    const upload = state.resources.uploadSessions.find(u => u.uploadId === uploadId);
    upload.nextOffset = start + bytes.length;
    return { status: 200, json: { uploadId, start, endExclusive: upload.nextOffset, nextOffset: upload.nextOffset, replayed: false } };
  };
  ctx.completeUpload = async (_url, uploadId) => {
    state.resources.uploadSessions.find(u => u.uploadId === uploadId).state = 'VERIFYING';
    // Both expiry and verification use this aggregateId; expiry sorts first.
    state.work.push({ workId: ids[2], kind: 'ARTIFACT_VERIFICATION', aggregateId: uploadId, state: 'PENDING', terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null });
    return { status: 202 };
  };
  ctx.workerBarrier = async (point, predicate) => {
    assert.equal(point, 'worker.claimed');
    await nextTurn();
    const work = state.work.find(w => w.workId === (fault === 'claimed-expiry' ? ids[1] : ids[2]));
    held = { json: { workId: work.workId, aggregateId: work.aggregateId } };
    assert.equal(predicate(held.json), true);
    barrierReady = true;
    return { url: 'http://127.0.0.1:1/barrier', token: 'test-only', waitFor: async select => { assert.equal(select(held), true); return held; } };
  };
  ctx.startWorker = async options => {
    assert.ok(barrierReady, 'the asynchronous barrier must resolve before worker startup');
    workers += 1;
    const work = state.work.find(w => w.workId === held.json.workId);
    if (workers === 1) {
      assert.equal(options.env.TEST_BARRIER_URL, 'http://127.0.0.1:1/barrier');
      Object.assign(work, { state: 'LEASED', attempt: 1, leaseOwner: 'worker-1', leaseExpiresAt: ctx.at() });
    } else {
      Object.assign(work, { state: 'SUCCEEDED', terminal: true, attempt: fault === 'unchanged-recovery-attempt' ? 1 : 2, leaseOwner: null, leaseExpiresAt: null });
      if (fault === 'replacement-identity') work.workId = ids[3];
      state.resources.uploadSessions.find(u => u.uploadId === work.aggregateId).state = 'COMMITTED';
    }
    return { role: 'worker', child: { exitCode: null } };
  };
  ctx.kill = ctx.stop = async () => {};
  ctx.sleep = async ms => assert.ok(ms >= 0);
  ctx.getUpload = async (_url, uploadId) => ({ status: 200, json: structuredClone(state.resources.uploadSessions.find(u => u.uploadId === uploadId)) });
  ctx.snapshot = async () => {
    const value = structuredClone(state);
    value.resources.uploadSessions.sort((a, b) => a.uploadId.localeCompare(b.uploadId));
    value.work.sort((a, b) => a.workId.localeCompare(b.workId));
    return value;
  };
  const result = await artifactCases.find(c => c.id === 'MIGRATE-02').run(ctx);
  assert.equal(result.evidence[0].workId, ids[2]);
  assert.equal(workers, 2);
}

test('ArtifactVault awaits barrier and selects verification despite an earlier expiry Work', t => artifactRecovery(t));
for (const fault of ['claimed-expiry', 'missing-verification', 'reset-attempt', 'replacement-identity', 'unchanged-recovery-attempt']) {
  test(`ArtifactVault recovery oracle rejects ${fault}`, async t => {
    await assert.rejects(artifactRecovery(t, fault), /verification Work|reclaimed/);
  });
}

async function auctionSeedMatrix(t, acceptInvalid) {
  const ctx = await auctionContext({ ...settings, caseId: 'MIGRATE-03' });
  t.after(() => ctx.teardown());
  const boundary = await evaluatorContract(resolve(root, 'task-packages/v2/auctionguard/public-contract'));
  const seen = [], state = { resources: {}, work: [], events: [] };
  ctx.startApi = async () => ({ baseUrl: 'http://127.0.0.1:1' });
  ctx.snapshot = async () => state;
  ctx.seed = async (value, options = {}) => {
    const label = value.seedVersion.startsWith('invalid-') ? value.seedVersion.slice(8) : 'valid';
    const wireInvalid = ['unknown-root', 'bad-money'].includes(label);
    assert.equal(options.contractExpectation, wireInvalid ? 'invalid' : undefined, label);
    if (!wireInvalid) boundary.seed(value);
    else assert.throws(() => boundary.seed(value), /published V2 contract/);
    seen.push(label);
    const conflict = value.bidders[0].displayName === 'Changed';
    return { exitCode: label === acceptInvalid ? 0 : (label !== 'valid' || conflict ? 1 : 0), stdout: conflict ? 'SEED_VERSION_CONFLICT' : '', stderr: '' };
  };
  await auctionCases.find(c => c.id === 'MIGRATE-03').run(ctx);
  assert.deepEqual(seen.slice(-4), ['unknown-root', 'missing-lot', 'bad-money', 'bad-time']);
}
test('AuctionGuard seed matrix reaches every negative with only schema-invalid seeds exempted', t => auctionSeedMatrix(t));
test('AuctionGuard seed matrix still rejects a candidate accepting illegal money', async t => {
  await assert.rejects(auctionSeedMatrix(t, 'bad-money'), /bad-money seed is rejected/);
});

async function clinicReaders(mode) {
  let requests = 0, active = 0, migrations = 0;
  const failure = new Error(mode), unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const ctx = {
    equal: (actual, expected, label) => assert.deepEqual(actual, expected, label),
    async request() {
      const ordinal = ++requests; active += 1;
      try {
        await nextTurn();
        if (mode === 'reader-early' && ordinal === 1) throw failure;
        if (mode === 'reader-during-migrate' && migrations) throw failure;
        return { status: 200, json: { items: [{ startAt: '2026-09-08T00:00:00.000Z' }] }, durationMs: 1 };
      } finally { active -= 1; }
    },
    async waitFor(predicate) {
      if (mode === 'setup-failure') throw failure;
      for (let n = 0; n < 20; n += 1) { if (predicate()) return; await nextTurn(); }
      throw new Error('test wait exhausted');
    },
    async migrate() {
      migrations += 1;
      await nextTurn(); await nextTurn();
      if (mode === 'migrate-failure') throw failure;
    },
  };
  try {
    if (mode === 'success') assert.ok((await observeAvailabilityDuringReinitialization(ctx, 'unused', '/api/v1/availability')).length >= 64);
    else await assert.rejects(observeAvailabilityDuringReinitialization(ctx, 'unused', '/api/v1/availability'), error => error === failure);
    assert.equal(active, 0, 'all launched readers settle before returning');
    const stoppedAt = requests;
    await nextTurn(); await nextTurn();
    assert.equal(requests, stoppedAt, 'no reader loop survives failure or completion');
    assert.deepEqual(unhandled, []);
    assert.equal(migrations, ['reader-early', 'setup-failure'].includes(mode) ? 0 : 1);
  } finally { process.off('unhandledRejection', onUnhandled); }
}
for (const mode of ['success', 'reader-early', 'reader-during-migrate', 'setup-failure', 'migrate-failure']) {
  test(`ClinicGrid reader lifecycle settles and preserves errors: ${mode}`, () => clinicReaders(mode));
}
