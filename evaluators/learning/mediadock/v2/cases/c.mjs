import assert from "node:assert/strict";

import { partManifest, renditionBytes, sha256 } from "../lib/oracle.mjs";
import {
  createCompleted, createGrant, downloadGrant, eventIds, openUpload, prepare, requireStatus, result, uploadAll, waitAsset,
} from "./helpers.mjs";

async function c01(ctx) {
  const fixture = ctx.uploadFixture("c01", { size: 31_007, partSize: 8_192 });
  const { api, tenant } = await prepare(ctx, "c01");
  const opened = await openUpload(ctx, api, tenant.tenantId, fixture);
  await uploadAll(ctx, api, opened.upload, opened.parts);
  const shield = await ctx.responseShield(api.baseUrl);
  shield.dropNextMutation();
  await assert.rejects(
    () => ctx.completeUpload(shield.baseUrl, opened.upload.uploadId, opened.parts, ctx.key("complete-unknown")),
    /fetch|socket|other side|terminated|aborted/iu,
  );
  await ctx.stop(api);
  const restarted = await ctx.startApi();
  const replay = requireStatus(await ctx.completeUpload(restarted.baseUrl, opened.upload.uploadId, opened.parts, ctx.key("complete-unknown")), 200, "replay unknown completion");
  assert.equal(replay.state, "COMPLETED");
  const snapshot = await ctx.snapshot(restarted.baseUrl);
  const assets = snapshot.resources.mediaAssets.filter(({ assetId }) => assetId === replay.assetId);
  assert.equal(assets.length, 1);
  assert.equal(snapshot.resources.blobObjects.filter(({ sha256: digest, state }) => digest === fixture.expectedSha256 && state !== "DELETED").length, 1);
  assert.equal(snapshot.resources.scanJobs.filter(({ assetId }) => assetId === replay.assetId).length, 1);
  return result(["lost completion response plus API restart replayed one committed byte identity, asset, scan, and response"]);
}

async function recoverLeasedWork(ctx, api, kind, aggregateId) {
  const first = await ctx.startWorker();
  const leased = await ctx.waitSnapshot(api.baseUrl, (snapshot) => snapshot.work.find((work) => (
    work.kind === kind && work.aggregateId === aggregateId
  )), { timeoutMs: 30_000, intervalMs: 10, label: `${kind} committed Work`, processes: [first] });
  const original = leased.work.find((work) => work.kind === kind && work.aggregateId === aggregateId);
  await ctx.kill(first);
  const replacement = await ctx.startWorker();
  return { original, replacement };
}

async function c02(ctx) {
  const fixture = ctx.uploadFixture("c02", { bytes: Buffer.alloc(8 * 1024 * 1024, 0x51), partSize: 8_388_608 });
  const profile = ctx.profileFixture("prefix", "PREFIX", Buffer.alloc(1_048_576, 0x50));
  const { api, tenant, profiles } = await prepare(ctx, "c02", [profile]);
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const scanRecovery = await recoverLeasedWork(ctx, api, "VIRUS_SCAN", completed.upload.assetId);
  const clean = await waitAsset(ctx, api, completed.upload.assetId, ["CLEAN", "PROCESSING", "READY"], [scanRecovery.replacement]);
  assert.notEqual(clean.state, "INFECTED");
  const transcodeJob = await ctx.waitSnapshot(api.baseUrl, (snapshot) => snapshot.resources.transcodeJobs.find(({ assetId }) => assetId === completed.upload.assetId), { timeoutMs: 60_000, processes: [scanRecovery.replacement] });
  await ctx.stop(scanRecovery.replacement);
  const job = transcodeJob.resources.transcodeJobs.find(({ assetId }) => assetId === completed.upload.assetId);
  const transcodeRecovery = await recoverLeasedWork(ctx, api, "TRANSCODE", job.transcodeJobId);
  const ready = await waitAsset(ctx, api, completed.upload.assetId, "READY", [transcodeRecovery.replacement]);
  const final = await ctx.snapshot(api.baseUrl);
  const rendition = final.resources.renditions.find(({ assetId }) => assetId === ready.assetId);
  const expected = renditionBytes(fixture.bytes, profiles[0]);
  assert.equal(rendition.sha256, sha256(expected));
  assert.equal(final.resources.renditions.filter(({ assetId }) => assetId === ready.assetId).length, 1);
  assert.equal(final.work.filter(x => x.workId === scanRecovery.original.workId).length, 1);
  assert.equal(final.work.filter(x => x.workId === transcodeRecovery.original.workId).length, 1);
  return result([`committed scan/transcode Work survived process replacement with one exact rendition; observed states ${scanRecovery.original.state}/${transcodeRecovery.original.state}, no internal checkpoint claimed`]);
}

async function c03(ctx) {
  const fixture = ctx.uploadFixture("c03", { bytes: Buffer.alloc(4 * 1024 * 1024, 0x43), partSize: 4 * 1024 * 1024 });
  const { api, tenant } = await prepare(ctx, "c03");
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const pipeline = await ctx.startWorker();
  await waitAsset(ctx, api, completed.upload.assetId, "READY", [pipeline]);
  await ctx.stop(pipeline);
  const expiring = ctx.uploadFixture("c03-expiring", { bytes: Buffer.from("expired multipart bytes"), partSize: 8192 });
  const expiresAt = new Date(Date.now() + 10_000).toISOString();
  const abandoned = requireStatus(await ctx.createUpload(api.baseUrl, { tenantId: tenant.tenantId, fileName: expiring.fileName, contentType: expiring.contentType, expectedSize: expiring.expectedSize, expectedSha256: expiring.expectedSha256, partSize: expiring.partSize, expiresAt }), 200, "expiring upload");
  await uploadAll(ctx, api, abandoned, partManifest(expiring.bytes, expiring.partSize));
  await ctx.waitFor(() => Date.now() > Date.parse(expiresAt) + 1_100, { timeoutMs: 20_000, intervalMs: 100, label: "published upload expiry has elapsed" });
  const policy = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/cleanup-policies", ctx.uniqueKey("policy"), { tenantId: tenant.tenantId, retention: { expiredUploadSeconds: 0, stagingSeconds: 0, infectedSourceSeconds: 0, failedRenditionSeconds: 0, expiredGrantSeconds: 0, unreferencedBlobSeconds: 0 } }), 200, "policy");
  const cleanup = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/cleanup-runs", ctx.uniqueKey("run"), { tenantId: tenant.tenantId, policyRevision: policy.revision, cutoffAt: new Date().toISOString() }), 200, "cleanup run");
  const planned = await ctx.snapshot(api.baseUrl);
  const entry = planned.resources.cleanupEntries.find(x => x.cleanupRunId === cleanup.cleanupRunId && x.targetType === "UPLOAD_PARTS" && x.targetId === abandoned.uploadId);
  assert.ok(entry, "expired real multipart upload supplies an eligible cleanup target");
  const recovery = await recoverLeasedWork(ctx, api, "CLEANUP_DELETE", entry.cleanupEntryId ?? entry.objectId);
  const terminal = await ctx.waitSnapshot(api.baseUrl, (snapshot) => snapshot.resources.cleanupRuns.some(({ cleanupRunId, state }) => cleanupRunId === cleanup.cleanupRunId && state === "COMPLETED"), { timeoutMs: 120_000, processes: [recovery.replacement] });
  assert.equal(terminal.resources.cleanupEntries.filter(({ cleanupRunId }) => cleanupRunId === cleanup.cleanupRunId).length, planned.resources.cleanupEntries.filter(({ cleanupRunId }) => cleanupRunId === cleanup.cleanupRunId).length);
  assert.equal(terminal.events.filter(({ aggregateId, type }) => aggregateId === cleanup.cleanupRunId && type === "cleanup.completed").length, 1);
  assert.equal(terminal.resources.cleanupEntries.find(x => x.cleanupEntryId === entry.cleanupEntryId).state, "DELETED");
  assert.equal(terminal.resources.uploadParts.filter(x => x.uploadId === abandoned.uploadId).length, 0);
  const preserved = requireStatus(await ctx.getAsset(api.baseUrl, completed.upload.assetId), 200, "reachable control asset");
  assert.equal(preserved.state, "READY");
  const grant = await createGrant(ctx, api, preserved.assetId);
  const bytes = await downloadGrant(ctx, api, grant);
  assert.equal(bytes.status, 200);
  assert.deepEqual(bytes.body, fixture.bytes, "cleanup recovery preserves the reachable control bytes");
  return result([`cleanup Work survived process replacement from observed ${recovery.original.state}, deleting the expired target once while preserving the live control asset`]);
}

async function c04(ctx) {
  const fixture = ctx.uploadFixture("c04", { bytes: Buffer.from("event delivery source"), partSize: 8_192 });
  const receiver = await ctx.receiver(({ attempt }) => attempt === 1 ? { disconnect: true } : attempt === 2 ? { status: 500 } : { status: 204 });
  await ctx.seed(ctx.seedFixture("c04"));
  const api = await ctx.startApi();
  const tenant = requireStatus(await ctx.createTenant(api.baseUrl, "c04"), 200, "tenant");
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const worker = await ctx.startWorker();
  await waitAsset(ctx, api, completed.upload.assetId, "READY", [worker]);
  const before = await ctx.snapshot(api.baseUrl);
  const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
  await ctx.waitFor(() => receiver.ledger.length >= 3, { timeoutMs: 60_000, processes: [dispatcher], label: "event retry attempts" });
  await ctx.kill(dispatcher);
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
  await ctx.waitFor(() => receiver.ledger.some(({ acknowledged }) => acknowledged), { timeoutMs: 60_000, processes: [replacement], label: "event ACK" });
  const groups = new Map();
  for (const delivery of receiver.ledger) {
    const id = delivery.json?.eventId;
    if (!id) continue;
    const group = groups.get(id) ?? [];
    group.push(delivery);
    groups.set(id, group);
  }
  const retried = [...groups.values()].find((group) => group.length >= 2);
  assert.ok(retried);
  assert.equal(new Set(retried.map(({ raw }) => raw)).size, 1);
  assert.equal(new Set(retried.map(({ json }) => json.eventId)).size, 1);
  assert.equal(/token|managed|scannerPayload|temporary/iu.test(retried[0].raw), false);
  const after = await ctx.snapshot(api.baseUrl);
  assert.deepEqual(eventIds(after), eventIds(before));
  return result(["disconnect, 500, dispatcher SIGKILL, and restart retried one stable secret-free event identity and body"]);
}

export const C_CASES = Object.freeze([
  { id: "C-01", taskId: "mediadock", run: c01 },
  { id: "C-02", taskId: "mediadock", run: c02 },
  { id: "C-03", taskId: "mediadock", run: c03 },
  { id: "C-04", taskId: "mediadock", run: c04 },
]);
