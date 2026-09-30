import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureFactory } from '../evaluators/transfer/creatorrightsexchange/v2/fixtures/index.mjs';
import { renditionOracle } from '../evaluators/transfer/creatorrightsexchange/v2/oracles/index.mjs';
import { CASES } from '../evaluators/transfer/creatorrightsexchange/v2/cases/index.mjs';
import { FINAL_RESOURCE_KEYS, V1_RESOURCE_KEYS } from '../evaluators/transfer/creatorrightsexchange/v2/cases/helpers.mjs';

async function runMediaCase(caseId, options = {}) {
  const fixtures = { ...createFixtureFactory({ evaluationSeed: 'media-work-public-relations', caseId, baseTime: '2032-04-05T06:07:08Z' }) };
  const base = fixtures.base(), uploads = new Map(), completed = [], barriers = [], cleanups = [];
  const performanceSpec = fixtures.performance();
  fixtures.performance = () => ({ ...performanceSpec, scenarios: { ...performanceSpec.scenarios,
    multipartEditionPipeline: { ...performanceSpec.scenarios.multipartEditionPipeline, assets: options.assets ?? 2 } } });
  let workerCount = 0, claimed = false, killed = false, claimSnapshots = 0, migrations = 0, period;
  const kind = caseId === 'C-02' ? 'VIRUS_SCAN' : 'TRANSCODE';
  const uuid = fixtures.uuid;
  const work = (id, workKind, aggregateId) => ({ workId: uuid(id), kind: workKind, aggregateId,
    state: 'DONE', attempt: killed ? 2 : 1, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, terminal: !claimed || killed });
  function mediaSnapshot() {
    const keys = caseId === 'E-03' && migrations < 2 ? V1_RESOURCE_KEYS : FINAL_RESOURCE_KEYS;
    const resources = Object.fromEntries(keys.map(key => [key, []]));
    resources.fraudAssessments = [{ purchaseOrderId: uuid('purchase'), state: 'COMPLETED' }];
    resources.transcodeProfiles = base.profiles;
    const durable = [];
    for (const row of completed) {
      const { assetId, upload, digest, profiles } = row;
      resources.blobObjects.push({ blobId: assetId, sha256: digest, state: 'READY' });
      const scanJobId = uuid(`scan:${assetId}`);
      resources.scanJobs.push({ scanJobId, assetId, state: 'CLEAN' });
      resources.scanResults.push({ scanResultId: uuid(`result:${assetId}`), scanJobId, assetId, verdict: 'CLEAN', contentSha256: digest });
      durable.push(work(`scan-work:${assetId}`, 'VIRUS_SCAN', options.mode === 'job' ? scanJobId : assetId));
      for (const profile of profiles) {
        const transcodeJobId = uuid(`transcode:${assetId}:${profile.profileId}`);
        resources.transcodeJobs.push({ transcodeJobId, assetId, profileId: profile.profileId, profileRevision: profile.revision, state: 'READY' });
        resources.renditions.push({ renditionId: uuid(`rendition:${transcodeJobId}`), assetId, profileId: profile.profileId,
          profileRevision: profile.revision, sha256: renditionOracle(upload.media, profile).sha256, state: 'READY' });
        durable.push(work(`transcode-work:${transcodeJobId}`, 'TRANSCODE', options.mode === 'blob' ? assetId : transcodeJobId));
      }
      durable.push(work(`expiry:${assetId}`, 'UPLOAD_EXPIRY', upload.uploadSession.uploadId));
    }
    // A same-kind claim for another asset must be released, never selected.
    resources.scanJobs.push({ scanJobId: uuid('foreign-scan'), assetId: uuid('foreign-asset'), state: 'CLEAN' });
    resources.transcodeJobs.push({ transcodeJobId: uuid('foreign-transcode'), assetId: uuid('foreign-asset'), profileId: base.profiles[0].profileId, profileRevision: 1, state: 'READY' });
    durable.push(work('foreign-work', kind, uuid(kind === 'VIRUS_SCAN' ? 'foreign-scan' : 'foreign-transcode')));
    if (caseId === 'E-03') {
      resources.paymentIntents = [{ paymentIntentId: uuid('payment'), purchaseOrderId: uuid('purchase'), state: 'UNKNOWN' }];
      durable.push(work('payment-work', 'PAYMENT_RECONCILE', uuid('payment')));
      resources.deliveries = fixtures.migration().deliveries.map(row => ({ ...row, state: killed ? 'DELIVERED' : 'PENDING' }));
      if (period) {
        resources.royaltyPeriods = [{ ...period, state: killed ? 'CLOSED' : 'CLOSING' }];
        durable.push(work('close-work', 'ROYALTY_CLOSE', period.royaltyPeriodId));
      }
    }
    const state = { schemaVersion: 1, asOf: fixtures.at(), resources, work: durable, events: [] };
    if (options.lateJob && claimed && !killed && claimSnapshots++ === 0) {
      resources.transcodeJobs = resources.transcodeJobs.filter(row => row.assetId === uuid('foreign-asset'));
    }
    options.change?.(state, completed);
    const fields = { blobObjects: 'blobId', scanJobs: 'scanJobId', scanResults: 'scanResultId', transcodeJobs: 'transcodeJobId',
      transcodeProfiles: 'profileId', renditions: 'renditionId', deliveries: 'deliveryId' };
    for (const [key, field] of Object.entries(fields)) resources[key].sort((a, b) => a[field].localeCompare(b[field]));
    return state;
  }
  const ctx = {
    caseId, fixtures, key: fixtures.key, at: fixtures.at, v1Workspace: '/unused-v1', forWorkspace: () => ctx,
    migrate: async () => { migrations++; }, seed: async () => {}, stop: async () => {}, sleep: async () => {},
    receiver: async () => ({ url: 'http://unused-receiver' }), startDispatcher: async () => ({}),
    startApi: async () => ({ baseUrl: 'http://unused' }),
    startWorker: async ({ env } = {}) => {
      const worker = { id: ++workerCount };
      if (env?.TEST_BARRIER_URL) {
        claimed = true;
        const state = mediaSnapshot(); claimSnapshots = 0;
        const target = state.work.find(row => row.kind === kind && row.workId !== uuid('foreign-work'));
        for (const item of [state.work.find(row => row.workId === uuid('foreign-work')), target]) {
          const json = { point: 'worker.claimed', kind: item.kind, workId: item.workId, aggregateId: item.aggregateId, attempt: 1, leaseToken: 'private-claim-token' };
          if (item === target) options.changeClaim?.(json);
          const entry = { json, released: false };
          const barrier = barriers.at(-1);
          const held = barrier.hold(json, entry);
          assert.equal(typeof held, 'boolean', 'shared barrier callbacks are synchronous');
          entry.released = !held;
          barrier.ledger.push(entry);
        }
      }
      return worker;
    },
    kill: async () => { killed = true; },
    request: async () => ({ status: 200, json: {} }),
    mutate: async (_url, path, _key, body) => {
      if (path === '/api/v1/purchases') return { status: 200, json: { purchaseOrder: { purchaseOrderId: uuid('purchase') } } };
      if (path === '/api/v1/provider/events') return { status: 200, json: {} };
      if (path === '/api/v1/royalty-periods') {
        period = { ...body, royaltyPeriodId: uuid('period') };
        return { status: 200, json: { royaltyPeriod: period } };
      }
      if (path === '/api/v1/uploads') {
        const label = body.fileName.replace(/\.mp4$/, '');
        const upload = fixtures.upload(label, { size: body.totalBytes, chunkSize: body.chunkSize, profileIds: body.requiredProfileIds });
        uploads.set(upload.uploadSession.uploadId, upload);
        return { status: 200, json: { uploadSession: upload.uploadSession } };
      }
      const upload = uploads.get(path.split('/')[4]);
      assert(upload && path.endsWith('/complete'), path);
      const assetId = uuid(`blob:${upload.uploadSession.uploadId}`);
      completed.push({ assetId, upload, digest: body.contentSha256,
        profiles: base.profiles.filter(profile => upload.uploadSession.requiredProfileIds.includes(profile.profileId)) });
      return { status: 200, json: { uploadSession: upload.uploadSession, blobObject: { blobId: assetId } } };
    },
    concurrent: async (values, limit, operation) => {
      assert.equal(limit, 32);
      return Promise.all(Array.from(values, operation));
    },
    snapshot: async () => mediaSnapshot(),
    waitFor: async (predicate, waitOptions) => {
      const timeout = { '240 assets READY': 1_800_000, 'recovery barrier request': 120_000,
        'post-upgrade drain': 300_000, 'worker.claimed replacement': caseId === 'C-03' ? 240_000 : 180_000 }[waitOptions.label];
      if (timeout) assert.equal(waitOptions.timeoutMs, timeout, 'existing timeout is preserved');
      for (let i = 0; i < 3; i++) { const result = await predicate(); if (result) return result; }
      assert.fail(`registered case condition unsatisfied: ${waitOptions.label}`);
    },
    barrier: async ({ hold }) => {
      const barrier = { hold, ledger: [], url: 'http://barrier', token: 'test-token',
        release(entry) { entry.released = true; }, releaseAll() { for (const entry of this.ledger) this.release(entry); },
        async waitFor(predicate) { const entry = this.ledger.find(predicate); assert(entry && !entry.released, 'intended claim must be held'); return entry; } };
      barriers.push(barrier); return barrier;
    },
    managedDataRoot: `/tmp/creator-media-regression-absent-${process.pid}`,
    defer: cleanup => cleanups.push(cleanup),
    equal: (actual, expected, label) => assert.deepEqual(actual, expected, label),
    ok: (value, label) => assert.ok(value, label), assert: (_label, operation) => operation(),
    pass: fields => ({ status: 'passed', ...fields }),
  };
  try {
    const result = await CASES.find(row => row.id === caseId).run(ctx);
    assert.equal(result.status, 'passed');
    if (caseId !== 'E-04') {
      assert(killed, 'the claimant was killed');
      assert(barriers[0].ledger[0].released, 'unrelated held claim was released');
    }
    return { result, completed };
  } finally { for (const cleanup of cleanups.reverse()) await cleanup(); }
}

test('registered E-04 accepts 240 READY assets whose terminal media Work uses job IDs', async () => {
  await runMediaCase('E-04', { mode: 'job', assets: 240 });
});

test('registered media recovery cases reach job-ID claims, including a Job appearing in a later snapshot', async () => {
  await runMediaCase('C-02', { mode: 'job' });
  await runMediaCase('C-03', { mode: 'mixed', lateJob: true });
  await runMediaCase('E-03', { mode: 'job', lateJob: true });
});

test('registered E-04 retains blob and mixed aggregate support and ignores unrelated expiry/backlog', async () => {
  for (const mode of ['blob', 'mixed', 'job']) await runMediaCase('E-04', { mode,
    change: value => { for (const row of value.work) if (row.kind === 'UPLOAD_EXPIRY') row.terminal = false; } });
});

const invalidPipeline = {
  'missing scan cannot be filled by a second asset': (value, assets) => {
    const first = value.work.find(row => row.kind === 'VIRUS_SCAN' && row.aggregateId === assets[0].assetId);
    first.aggregateId = assets[1].assetId;
  },
  'wrong Work kind cannot cover a transcode': value => { value.work.find(row => row.kind === 'TRANSCODE').kind = 'UPLOAD_EXPIRY'; },
  'duplicate workId cannot be silently deduplicated': value => { value.work.push({ ...value.work[0] }); },
  'duplicate independent scan Work cannot pass': value => { value.work.push({ ...value.work[0], workId: 'duplicate-independent-work' }); },
  'nonterminal relevant Work cannot be ignored': value => { value.work[0].terminal = false; },
  'missing Work cannot be replaced by an expiry Work': value => { value.work = value.work.filter(row => row.kind !== 'VIRUS_SCAN'); },
  'READY requires a CLEAN result': value => { value.resources.scanResults[0].verdict = 'INFECTED'; },
  'scan digest must match the uploaded bytes': value => { value.resources.scanResults[0].contentSha256 = 'wrong'; },
  'Blob digest must match the completed upload': value => { value.resources.blobObjects[0].sha256 = 'wrong'; },
  'Blob cannot remain processing': value => { value.resources.blobObjects[0].state = 'PROCESSING'; },
  'frozen profile revision cannot change': (value, assets) => {
    value.resources.transcodeJobs.find(row => row.assetId === assets[0].assetId).profileRevision++;
  },
  'rendition bytes remain verified': value => { value.resources.renditions[0].sha256 = 'wrong'; },
  'extra source-digest Blob cannot replace missing completion identity': (value, assets) => {
    value.resources.blobObjects.find(row => row.blobId === assets[0].assetId).blobId = 'other-blob';
  },
};
for (const [label, change] of Object.entries(invalidPipeline)) test(`registered E-04 rejects ${label}`, async () => {
  await assert.rejects(runMediaCase('E-04', { mode: 'blob', change }), /registered case condition unsatisfied/);
});

test('registered C-03 cannot use one Work for several frozen profiles or duplicate a Job-bound claim', async () => {
  for (const corrupt of ['missing', 'same-job', 'same-job-id']) await assert.rejects(runMediaCase('C-03', { mode: 'job',
    change: (value, assets) => {
      if (!assets.length || value.work.some(row => !row.terminal)) return;
      const jobs = value.resources.transcodeJobs.filter(row => row.assetId === assets[0].assetId);
      const work = value.work.filter(row => jobs.some(job => job.transcodeJobId === row.aggregateId));
      if (corrupt === 'missing') value.work = value.work.filter(row => row !== work[1]);
      else if (corrupt === 'same-job') work[1].aggregateId = work[0].aggregateId;
      else jobs[1].transcodeJobId = jobs[0].transcodeJobId;
    },
  }), /registered case condition unsatisfied/);
});

test('registered C-02 does not kill a claim with a different Work identity, kind, aggregate or attempt', async () => {
  for (const changeClaim of [
    payload => { payload.workId = 'unknown-work'; },
    payload => { payload.kind = 'UPLOAD_EXPIRY'; },
    payload => { payload.aggregateId = 'unknown-aggregate'; },
    payload => { payload.attempt++; },
  ]) await assert.rejects(runMediaCase('C-02', { mode: 'job', changeClaim }), /registered case condition unsatisfied/);
});
