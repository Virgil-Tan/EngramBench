import assert from "node:assert/strict";

import { partManifest, rangeOracle, renditionBytes, sha256 } from "../lib/oracle.mjs";
import {
  ASSET_KEYS, RENDITION_KEYS, assertError, complete, createCompleted, createGrant, digestBody, downloadGrant,
  exactKeys, openUpload, prepare, requireStatus, result, snapshotCollections, uploadAll, waitAsset,
} from "./helpers.mjs";

async function a01(ctx) {
  const fixture = ctx.uploadFixture("a01", { size: 20_000, partSize: 8_192 });
  const { api, tenant } = await prepare(ctx, "a01");
  const opened = await openUpload(ctx, api, tenant.tenantId, fixture, ctx.uniqueKey("create"));
  assert.deepEqual(opened.parts.map(({ start, end }) => [start, end]), [[0, 8191], [8192, 16383], [16384, 19999]]);
  await uploadAll(ctx, api, opened.upload, opened.parts, [2, 0, 1]);
  const resumed = requireStatus(await ctx.getUpload(api.baseUrl, opened.upload.uploadId), 200, "resume upload");
  assert.deepEqual(resumed.parts ?? resumed.uploadParts, opened.parts.map(({ bytes: _bytes, ...part }) => ({ ...part, uploadId: opened.upload.uploadId, createdAt: (resumed.parts ?? resumed.uploadParts).find(({ partNumber }) => partNumber === part.partNumber).createdAt })));
  const replay = await ctx.putPart(api.baseUrl, opened.upload.uploadId, opened.parts[0], fixture.expectedSize, ctx.uniqueKey("part-replay"));
  requireStatus(replay, 200, "semantic part replay");
  const changed = { ...opened.parts[0], bytes: Buffer.from(opened.parts[0].bytes), sha256: "0".repeat(64) };
  assertError(await ctx.putPart(api.baseUrl, opened.upload.uploadId, changed, fixture.expectedSize, ctx.uniqueKey("part-conflict")), 409, "UPLOAD_PART_CONFLICT", "changed part");
  const upload = await complete(ctx, api, opened.upload, opened.parts);
  assert.equal(upload.expectedSha256, sha256(fixture.bytes));
  return result(["MD-W1 exact inclusive ranges, out-of-order resume, immutable part identity, and whole digest passed"]);
}

async function a02(ctx) {
  const fixture = ctx.uploadFixture("a02", { size: 24_777, partSize: 8_192 });
  const { api, tenant } = await prepare(ctx, "a02");
  const missing = await openUpload(ctx, api, tenant.tenantId, fixture);
  await ctx.putPart(api.baseUrl, missing.upload.uploadId, missing.parts[0], fixture.expectedSize);
  assertError(await ctx.completeUpload(api.baseUrl, missing.upload.uploadId, missing.parts), 409, "UPLOAD_INCOMPLETE", "incomplete upload");
  const before = await ctx.snapshot(api.baseUrl);
  const successful = await createCompleted(ctx, api, tenant.tenantId, fixture, "success");
  const after = await ctx.snapshot(api.baseUrl);
  const resources = snapshotCollections(after);
  assert.equal(resources.blobObjects.filter(({ sha256: digest }) => digest === fixture.expectedSha256).length, 1);
  assert.equal(resources.mediaAssets.filter(({ assetId }) => assetId === successful.upload.assetId).length, 1);
  assert.equal(resources.scanJobs.filter(({ assetId }) => assetId === successful.upload.assetId).length, 1);
  assert.equal(resources.mediaAssets.find(({ assetId }) => assetId === successful.upload.assetId).state, "QUARANTINED");
  assert.equal(before.resources.mediaAssets.length + 1, resources.mediaAssets.length);
  return result(["failed completion was side-effect free and successful completion atomically created one committed byte identity, asset, and scan"]);
}

async function a03(ctx) {
  const clean = ctx.uploadFixture("a03-clean", { bytes: Buffer.from("clean media bytes"), partSize: 8_192 });
  const infected = ctx.uploadFixture("a03-infected", { bytes: Buffer.from("before EICAR-STANDARD-ANTIVIRUS-TEST-FILE after"), partSize: 8_192 });
  const { api, tenant } = await prepare(ctx, "a03");
  const cleanUpload = await createCompleted(ctx, api, tenant.tenantId, clean, "clean");
  const blockedGrant = await ctx.mutate(api.baseUrl, `/api/v1/assets/${cleanUpload.upload.assetId}/access-grants`, ctx.uniqueKey("blocked-grant"), { renditionId: null, expiresAt: ctx.at({ minutes: 5 }) });
  assertError(blockedGrant, 409, "ASSET_QUARANTINED", "quarantined source grant");
  const infectedUpload = await createCompleted(ctx, api, tenant.tenantId, infected, "infected");
  const worker = await ctx.startWorker();
  const cleanAsset = await waitAsset(ctx, api, cleanUpload.upload.assetId, ["CLEAN", "PROCESSING", "READY"], [worker]);
  const infectedAsset = await waitAsset(ctx, api, infectedUpload.upload.assetId, "INFECTED", [worker]);
  assert.ok(["CLEAN", "PROCESSING", "READY"].includes(cleanAsset.state));
  assert.equal(infectedAsset.state, "INFECTED");
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.resources.scanJobs.filter(({ assetId }) => assetId === cleanAsset.assetId).length, 1);
  assert.equal(snapshot.resources.scanJobs.filter(({ assetId }) => assetId === infectedAsset.assetId).length, 1);
  assert.equal(snapshot.resources.renditions.some(({ assetId }) => assetId === infectedAsset.assetId), false);
  return result(["scan gate rejected pre-CLEAN access and deterministic CLEAN/INFECTED outcomes converged to one semantic ScanJob each"]);
}

async function a04(ctx) {
  const fixture = ctx.uploadFixture("a04", { bytes: Buffer.from("source-media-payload"), partSize: 8_192 });
  const copy = ctx.profileFixture("copy", "COPY");
  const prefix = ctx.profileFixture("prefix", "PREFIX", Buffer.from("ABC"));
  const { api, tenant, profiles } = await prepare(ctx, "a04", [copy, prefix]);
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const worker = await ctx.startWorker();
  const asset = await waitAsset(ctx, api, completed.upload.assetId, "READY", [worker]);
  exactKeys(asset, ASSET_KEYS, "READY MediaAsset");
  const response = requireStatus(await ctx.getRenditions(api.baseUrl, asset.assetId), 200, "list renditions");
  const items = response.items ?? response;
  assert.equal(items.length, 2);
  for (const rendition of items) {
    exactKeys(rendition, RENDITION_KEYS, "Rendition");
    const profile = profiles.find(({ profileId }) => profileId === rendition.profileId);
    const expected = renditionBytes(fixture.bytes, profile);
    assert.equal(rendition.size, expected.length);
    assert.equal(rendition.sha256, sha256(expected));
    const grant = await createGrant(ctx, api, asset.assetId, { renditionId: rendition.renditionId });
    const downloaded = await downloadGrant(ctx, api, grant);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(downloaded.body, expected);
  }
  return result(["frozen COPY and PREFIX revisions produced two exact promoted renditions before the aggregate became READY"]);
}

async function a05(ctx) {
  const fixture = ctx.uploadFixture("a05", { bytes: Buffer.from("0123456789abcdefghijklmnopqrstuvwxyz"), partSize: 8_192 });
  const { api, tenant } = await prepare(ctx, "a05");
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const worker = await ctx.startWorker();
  const asset = await waitAsset(ctx, api, completed.upload.assetId, "READY", [worker]);
  const key = ctx.uniqueKey("grant-replay");
  const grant = await createGrant(ctx, api, asset.assetId, {}, key);
  const replay = await createGrant(ctx, api, asset.assetId, {}, key);
  assert.deepEqual(replay, grant);
  for (const range of [undefined, "bytes=0-4", "bytes=8-17", "bytes=-5"]) {
    const expected = rangeOracle(fixture.bytes, range);
    const response = await downloadGrant(ctx, api, grant, { headers: range ? { range } : undefined });
    assert.equal(response.status, expected.status);
    assert.deepEqual(response.body, expected.body);
    assert.equal(digestBody(response), sha256(expected.body));
  }
  const head = await downloadGrant(ctx, api, grant, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  const revoked = await ctx.mutate(api.baseUrl, `/api/v1/access-grants/${grant.grant.grantId}/revoke`, ctx.uniqueKey("revoke"), {});
  requireStatus(revoked, 200, "revoke grant");
  assert.equal((await downloadGrant(ctx, api, grant)).status, 409);
  return result(["stable capability replay, full/HEAD/single-range bytes, and immediate revoke behavior matched the independent byte oracle"]);
}

export const A_CASES = Object.freeze([
  { id: "A-01", taskId: "mediadock", run: a01 },
  { id: "A-02", taskId: "mediadock", run: a02 },
  { id: "A-03", taskId: "mediadock", run: a03 },
  { id: "A-04", taskId: "mediadock", run: a04 },
  { id: "A-05", taskId: "mediadock", run: a05 },
]);
