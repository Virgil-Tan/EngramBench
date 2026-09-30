import assert from 'node:assert/strict';
import { renditionOracle } from '../oracles/index.mjs';
import { snapshot, waitSnapshot } from './helpers.mjs';

const jobsForKind = {
  VIRUS_SCAN: ['scanJobs', 'scanJobId'],
  TRANSCODE: ['transcodeJobs', 'transcodeJobId'],
};

// Public DurableWork permits either the asset or its named processing Job as
// aggregate. Resolve only public identities; never inspect a submission's DB.
function assetIdsForWork(value, work) {
  const fields = jobsForKind[work.kind];
  if (!fields) return new Set();
  const ids = value.resources.blobObjects.filter(row => row.blobId === work.aggregateId).map(row => row.blobId);
  for (const job of value.resources[fields[0]]) if (job[fields[1]] === work.aggregateId) ids.push(job.assetId);
  return new Set(ids);
}

export function expectedMediaAsset(completion, uploaded, family) {
  const assetId = completion.json?.blobObject?.blobId;
  assert.equal(typeof assetId, 'string', 'completion exposes its Blob identity');
  const profiles = family.uploadSession.requiredProfileIds.map(profileId => {
    const matching = family.profiles.filter(profile => profile.profileId === profileId);
    assert.equal(matching.length, 1, 'one frozen public profile');
    const profile = matching[0];
    return { profileId, profileRevision: profile.revision, sha256: renditionOracle(family.media, profile).sha256 };
  });
  return { assetId, sha256: uploaded.plan.sha256, profiles };
}

export function mediaAssetsReady(value, expected) {
  const expectedIds = new Set(expected.map(row => row.assetId));
  if (expectedIds.size !== expected.length
    || new Set(value.work.map(row => row.workId)).size !== value.work.length) return false;
  const byAsset = new Map();
  for (const work of value.work) {
    const ids = assetIdsForWork(value, work);
    // Ambiguous cross-resource identities must not cover multiple assets.
    if (ids.size > 1 && [...ids].some(id => expectedIds.has(id))) return false;
    if (ids.size !== 1) continue;
    const [id] = ids;
    if (!byAsset.has(id)) byAsset.set(id, []);
    byAsset.get(id).push(work);
  }
  return expected.every(({ assetId, sha256, profiles }) => {
    const blobs = value.resources.blobObjects.filter(row => row.blobId === assetId);
    if (blobs.length !== 1 || blobs[0].state !== 'READY' || blobs[0].sha256 !== sha256) return false;
    const scans = value.resources.scanJobs.filter(row => row.assetId === assetId);
    const results = value.resources.scanResults.filter(row => row.assetId === assetId);
    if (scans.length !== 1 || scans[0].state !== 'CLEAN' || results.length !== 1
      || results[0].scanJobId !== scans[0].scanJobId || results[0].verdict !== 'CLEAN'
      || results[0].contentSha256 !== sha256) return false;
    const transcodes = value.resources.transcodeJobs.filter(row => row.assetId === assetId);
    const renditions = value.resources.renditions.filter(row => row.assetId === assetId);
    if (transcodes.length !== profiles.length || renditions.length !== profiles.length
      || new Set(transcodes.map(row => row.transcodeJobId)).size !== transcodes.length
      || new Set(renditions.map(row => row.renditionId)).size !== renditions.length) return false;
    for (const profile of profiles) {
      const match = row => row.profileId === profile.profileId && row.profileRevision === profile.profileRevision;
      const jobs = transcodes.filter(match), outputs = renditions.filter(match);
      if (jobs.length !== 1 || jobs[0].state !== 'READY' || outputs.length !== 1
        || outputs[0].state !== 'READY' || outputs[0].sha256 !== profile.sha256) return false;
    }
    const work = byAsset.get(assetId) ?? [];
    if (!work.every(row => row.terminal === true)) return false;
    const scanWork = work.filter(row => row.kind === 'VIRUS_SCAN');
    const transcodeWork = work.filter(row => row.kind === 'TRANSCODE');
    if (scanWork.length !== 1 || transcodeWork.length !== profiles.length) return false;
    // Job-bound claims cover that Job once; asset-bound claims cover only the
    // remaining Jobs. One Work can never stand in for several frozen profiles.
    const jobBound = transcodeWork.filter(row => row.aggregateId !== assetId);
    return new Set(jobBound.map(row => row.aggregateId)).size === jobBound.length;
  });
}

export async function mediaClaimBarrier(ctx, baseUrl, assetId, kind, { final = true } = {}) {
  const point = 'worker.claimed';
  let armed = true;
  // The shared barrier API is synchronous. Hold this kind first, then inspect
  // its committed public Job relation asynchronously outside the HTTP callback.
  const barrier = await ctx.barrier({ hold: payload => armed && payload.point === point && payload.kind === kind });
  return {
    barrier,
    disarm() { armed = false; barrier.releaseAll(); },
    waitForClaim(processes, timeoutMs = 120_000) {
      return ctx.waitFor(async () => {
        const pending = barrier.ledger.filter(entry => !entry.released && !entry.disconnected
          && entry.json.point === point && entry.json.kind === kind);
        if (!pending.length) return;
        const value = await snapshot(ctx, baseUrl, { final });
        let matched;
        for (const entry of pending) {
          const rows = value.work.filter(row => row.workId === entry.json.workId);
          if (rows.length !== 1) continue;
          const work = rows[0], ids = assetIdsForWork(value, work);
          const sameClaim = work.kind === entry.json.kind && work.aggregateId === entry.json.aggregateId
            && work.attempt === entry.json.attempt && work.terminal === false;
          if (sameClaim && ids.size === 1 && ids.has(assetId)) matched ??= entry;
          else if (!sameClaim || ids.size > 0) barrier.release(entry);
          // A Job may appear in a subsequent snapshot. Keep unresolved claims
          // held until the existing bounded wait resolves their public identity.
        }
        return matched;
      }, { label: 'recovery barrier request', timeoutMs, processes });
    },
  };
}

export async function crashMediaWorkerAt(ctx, baseUrl, expected, kind, options = {}) {
  const control = await mediaClaimBarrier(ctx, baseUrl, expected.assetId, kind);
  const { barrier } = control;
  const first = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const entry = await control.waitForClaim([first], options.timeoutMs ?? 120_000);
  const before = await snapshot(ctx, baseUrl);
  await ctx.kill(first);
  control.disarm();
  await ctx.sleep(options.leaseWaitMs ?? 3_300);
  const replacements = [];
  for (let index = 0; index < (options.replacements ?? 2); index++) replacements.push(await ctx.startWorker());
  const after = await waitSnapshot(ctx, baseUrl,
    value => value.work.find(row => row.workId === entry.json.workId)?.terminal,
    { label: 'worker.claimed replacement', timeoutMs: options.drainTimeoutMs ?? 180_000, processes: replacements });
  return { barrier, entry, before, after, first, replacements };
}
