import assert from "node:assert/strict";

import { partManifest, renditionBytes, sha256 } from "../lib/oracle.mjs";
import {
  assertError, createCompleted, createGrant, eventIds, openUpload, prepare, requireStatus, result,
  snapshotCollections, uploadAll, waitAsset,
} from "./helpers.mjs";

async function b01(ctx) {
  const fixture = ctx.uploadFixture("b01", { size: 16_500, partSize: 8_192 });
  const { api, tenant } = await prepare(ctx, "b01");
  const opened = await openUpload(ctx, api, tenant.tenantId, fixture);
  const part = opened.parts[0];
  const key = ctx.uniqueKey("stable-part-key");
  const first = requireStatus(await ctx.putPart(api.baseUrl, opened.upload.uploadId, part, fixture.expectedSize, key), 200, "first part");
  const exactReplay = requireStatus(await ctx.putPart(api.baseUrl, opened.upload.uploadId, part, fixture.expectedSize, key), 200, "request replay");
  assert.deepEqual(exactReplay, first);
  const changedBytes = Buffer.from(part.bytes);
  changedBytes[0] ^= 0xff;
  const changed = { ...part, bytes: changedBytes, sha256: sha256(changedBytes) };
  assertError(await ctx.putPart(api.baseUrl, opened.upload.uploadId, changed, fixture.expectedSize, key), 409, "IDEMPOTENCY_CONFLICT", "same key changed bytes");
  assertError(await ctx.putPart(api.baseUrl, opened.upload.uploadId, changed, fixture.expectedSize, ctx.uniqueKey("semantic-conflict")), 409, "UPLOAD_PART_CONFLICT", "new key changed semantic part");
  const resumed = requireStatus(await ctx.getUpload(api.baseUrl, opened.upload.uploadId), 200, "resume after conflicts");
  const manifest = resumed.parts ?? resumed.uploadParts;
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].sha256, part.sha256);
  return result(["request replay precedence is distinct from semantic part conflict and preserves the first accepted bytes"]);
}

async function b02(ctx) {
  const bytes = ctx.fixtures.bytes("shared-content", 20_000);
  const fixtureOne = ctx.uploadFixture("tenant-one", { bytes, partSize: 8_192 });
  const fixtureTwo = ctx.uploadFixture("tenant-two", { bytes, partSize: 8_192 });
  await ctx.seed(ctx.seedFixture("b02"));
  const apiOne = await ctx.startApi();
  const apiTwo = await ctx.startApi();
  const tenantOne = requireStatus(await ctx.createTenant(apiOne.baseUrl, "one"), 200, "tenant one");
  const tenantTwo = requireStatus(await ctx.createTenant(apiTwo.baseUrl, "two"), 200, "tenant two");
  const one = await openUpload(ctx, apiOne, tenantOne.tenantId, fixtureOne);
  const two = await openUpload(ctx, apiTwo, tenantTwo.tenantId, fixtureTwo);
  await Promise.all([uploadAll(ctx, apiOne, one.upload, one.parts), uploadAll(ctx, apiTwo, two.upload, two.parts)]);
  const attempts = await Promise.all(Array.from({ length: 64 }, (_, index) => ctx.completeUpload(
    index % 2 ? apiOne.baseUrl : apiTwo.baseUrl,
    index % 2 ? one.upload.uploadId : two.upload.uploadId,
    index % 2 ? one.parts : two.parts,
    index % 2 ? ctx.key("tenant-one-complete") : ctx.key("tenant-two-complete"),
  )));
  assert.ok(attempts.every(({ status }) => status === 200));
  const snapshot = await ctx.snapshot(apiOne.baseUrl);
  const assets = snapshot.resources.mediaAssets.filter(({ sha256: digest }) => digest === sha256(bytes));
  assert.equal(assets.length, 2);
  assert.equal(new Set(assets.map(({ tenantId }) => tenantId)).size, 2);
  const blobCount = snapshot.resources.blobObjects.filter(({ sha256: digest }) => digest === sha256(bytes)).length;
  assert.ok(blobCount === 1 || blobCount === 2, "the public contract permits but does not require physical sharing");
  assert.ok(assets.every(({ sourceBlobId }) => snapshot.resources.blobObjects.some(({ blobId, sha256: digest }) => blobId === sourceBlobId && digest === sha256(bytes))));
  assert.equal(JSON.stringify(snapshot).includes("physicalRefCount"), false);
  return result(["64 concurrent complete calls created one logical asset per tenant while keeping physical sharing private"]);
}

async function b03(ctx) {
  const fixture = ctx.uploadFixture("b03", { bytes: Buffer.from("scan race source"), partSize: 8_192 });
  const { api, tenant } = await prepare(ctx, "b03");
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const before = await ctx.snapshot(api.baseUrl);
  const job = before.resources.scanJobs.find(({ assetId }) => assetId === completed.upload.assetId);
  assert.ok(job?.scannerRequestId);
  const submit = (state, key) => ctx.mutate(api.baseUrl, "/api/v1/scanner/results", key, {
    scanJobId: job.scanJobId,
    scannerRequestId: job.scannerRequestId,
    state,
    signature: state === "INFECTED" ? "EICAR" : null,
  });
  const results = await Promise.all([
    submit("UNKNOWN", ctx.uniqueKey("unknown")),
    submit("CLEAN", ctx.uniqueKey("clean")),
    submit("CLEAN", ctx.uniqueKey("clean-duplicate")),
  ]);
  assert.ok(results.every(({ status }) => [200, 409].includes(status)));
  const worker = await ctx.startWorker();
  const asset = await waitAsset(ctx, api, completed.upload.assetId, ["CLEAN", "PROCESSING", "READY"], [worker]);
  const late = await submit("INFECTED", ctx.uniqueKey("late-infected"));
  assert.ok([200, 409].includes(late.status));
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(after.resources.scanJobs.filter(({ assetId }) => assetId === asset.assetId).length, 1);
  assert.notEqual(after.resources.mediaAssets.find(({ assetId }) => assetId === asset.assetId).state, "INFECTED");
  return result(["duplicate and reordered scan results converged without a second ScanJob or stale terminal reversal"]);
}

async function b04(ctx) {
  const fixture = ctx.uploadFixture("b04", { bytes: Buffer.from("transcode race source"), partSize: 8_192 });
  const profiles = [ctx.profileFixture("copy", "COPY"), ctx.profileFixture("prefix", "PREFIX", Buffer.from("PFX"))];
  const { api, tenant, profiles: createdProfiles } = await prepare(ctx, "b04", profiles);
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const asset = await waitAsset(ctx, api, completed.upload.assetId, "READY", workers);
  const snapshot = await ctx.snapshot(api.baseUrl);
  const jobs = snapshot.resources.transcodeJobs.filter(({ assetId }) => assetId === asset.assetId);
  const renditions = snapshot.resources.renditions.filter(({ assetId }) => assetId === asset.assetId);
  assert.equal(jobs.length, createdProfiles.length);
  assert.equal(renditions.length, createdProfiles.length);
  assert.equal(new Set(jobs.map(({ profileId, profileRevision }) => `${profileId}:${profileRevision}`)).size, jobs.length);
  assert.equal(new Set(renditions.map(({ profileId, profileRevision }) => `${profileId}:${profileRevision}`)).size, renditions.length);
  for (const rendition of renditions) {
    const profile = createdProfiles.find(({ profileId }) => profileId === rendition.profileId);
    const expected = renditionBytes(fixture.bytes, profile);
    assert.equal(rendition.sha256, sha256(expected));
    assert.equal(rendition.size, expected.length);
  }
  return result(["four workers converged to one exact rendition per frozen profile and READY followed complete fan-out"]);
}

async function b05(ctx) {
  const fixture = ctx.uploadFixture("b05", { bytes: Buffer.from("cleanup protected bytes"), partSize: 8_192 });
  const { api, tenant } = await prepare(ctx, "b05");
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const worker = await ctx.startWorker();
  const asset = await waitAsset(ctx, api, completed.upload.assetId, "READY", [worker]);
  const grant = await createGrant(ctx, api, asset.assetId);
  const policy = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/cleanup-policies", ctx.uniqueKey("policy"), {
    tenantId: tenant.tenantId,
    retention: { expiredUploadSeconds: 0, stagingSeconds: 0, infectedSourceSeconds: 0, failedRenditionSeconds: 0, expiredGrantSeconds: 0, unreferencedBlobSeconds: 0 },
  }), 200, "create cleanup policy");
  const run = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/cleanup-runs", ctx.uniqueKey("cleanup"), {
    tenantId: tenant.tenantId,
    policyRevision: policy.revision,
    cutoffAt: ctx.at(),
  }), 200, "plan cleanup");
  const planned = await ctx.snapshot(api.baseUrl);
  const frozenIds = new Set(planned.resources.cleanupEntries.filter(({ cleanupRunId }) => cleanupRunId === run.cleanupRunId).map(({ objectId }) => objectId));
  const later = await createCompleted(ctx, api, tenant.tenantId, ctx.uploadFixture("later", { bytes: Buffer.from("later bytes"), partSize: 8_192 }), "later");
  assert.equal(frozenIds.has(later.upload.assetId), false);
  await ctx.waitSnapshot(api.baseUrl, (snapshot) => snapshot.resources.cleanupRuns.some(({ cleanupRunId, state }) => cleanupRunId === run.cleanupRunId && ["COMPLETED", "FAILED"].includes(state)), { timeoutMs: 120_000, processes: [worker] });
  const stillReadable = await ctx.request(api.baseUrl, `/media/${grant.grant.grantId}?token=${encodeURIComponent(grant.token)}`, { binary: true });
  assert.equal(stillReadable.status, 200);
  assert.deepEqual(stillReadable.body, fixture.bytes);
  return result(["cleanup froze candidates before later objects and rechecked the active grant before deletion"]);
}

export const B_CASES = Object.freeze([
  { id: "B-01", taskId: "mediadock", run: b01 },
  { id: "B-02", taskId: "mediadock", run: b02 },
  { id: "B-03", taskId: "mediadock", run: b03 },
  { id: "B-04", taskId: "mediadock", run: b04 },
  { id: "B-05", taskId: "mediadock", run: b05 },
]);
