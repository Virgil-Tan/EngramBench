import assert from "node:assert/strict";
import { chromiumExecutable } from "../lib/runtime.mjs";
import { createCompleted, downloadGrant, expiresAfter, prepare, requireStatus, waitAsset } from "./helpers.mjs";

export async function createAlias(ctx, api, tenantId, profileIds, label) {
  const response = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/media-aliases", ctx.uniqueKey("alias"), {
    tenantId, name: label, requiredProfileIds: profileIds, retentionSeconds: 3600,
  }), 200, "create Alias");
  assert.ok(response.alias?.aliasId);
  assert.deepEqual(response.alias.requiredProfileIds, [...new Set(profileIds)].sort());
  assert.equal(response.alias.currentRevision, 0);
  assert.equal(response.alias.currentPublicationRevisionId, null);
  return response.alias;
}

export async function publicationScenario(ctx, label) {
  const profile = ctx.profileFixture(`${label}-copy`, "COPY");
  const { api, tenant, profiles } = await prepare(ctx, label, [profile]);
  const assets = [];
  const worker = await ctx.startWorker();
  for (let index = 0; index < 2; index += 1) {
    const fixture = ctx.uploadFixture(`${label}-${index}`, { bytes: Buffer.from(`${label} publication ${index}`), partSize: 8192 });
    const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, `${label}-${index}`);
    const asset = await waitAsset(ctx, api, completed.upload.assetId, "READY", [worker]);
    assets.push({ asset, fixture });
  }
  const alias = await createAlias(ctx, api, tenant.tenantId, [profiles[0].profileId], label);
  return { api, tenant, profiles, worker, assets, alias };
}

export async function publish(ctx, api, alias, assetId, expectedRevision, key = ctx.uniqueKey("publish")) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/media-aliases/${alias.aliasId}/publish`, key, { expectedRevision, assetId });
  const value = requireStatus(response, 200, "publish Alias");
  assert.equal(value.alias.currentRevision, expectedRevision + 1);
  assert.equal(value.revision.revision, expectedRevision + 1);
  assert.equal(value.alias.currentPublicationRevisionId, value.revision.publicationRevisionId);
  assert.equal(value.revision.assetId, assetId);
  return value;
}

export async function aliasGrant(ctx, api, alias) {
  return requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/media-aliases/${alias.aliasId}/access-grants`, ctx.uniqueKey("alias-grant"), { renditionId: null, expiresAt: expiresAfter(10) }), 200, "Alias Grant");
}

export async function assertPinnedBytes(ctx, api, grant, publication, bytes) {
  assert.equal(grant.grant.publicationRevisionId, publication.publicationRevisionId, "Grant pins its resolved publication");
  const response = await downloadGrant(ctx, api, grant);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, bytes, "publication Grant serves its original bytes");
}

export function assertSnapshotConsistency(state, uploadIds = []) {
  const r = state.resources;
  assert.ok(r && Array.isArray(state.work) && Array.isArray(state.events));
  for (const uploadId of uploadIds) {
    const upload = r.uploadSessions.find(x => x.uploadId === uploadId);
    assert.ok(upload, "snapshot cannot lose a committed UploadSession");
    const completion = state.events.filter(x => x.type === "upload.completed" && (x.aggregateId === uploadId || x.payload?.uploadId === uploadId));
    if (upload.state !== "COMPLETED") {
      assert.equal(completion.length, 0, "completion Event cannot precede its UploadSession in one snapshot");
      continue;
    }
    const asset = r.mediaAssets.find(x => x.assetId === upload.assetId);
    assert.ok(asset, "completed UploadSession and MediaAsset must share one snapshot");
    const blob = r.blobObjects.find(x => x.blobId === asset.sourceBlobId);
    assert.ok(blob, "completed MediaAsset and source Blob must share one snapshot");
    assert.equal(blob.sha256, upload.expectedSha256);
    assert.equal(Number(blob.size), upload.expectedSize);
    assert.equal(r.scanJobs.filter(x => x.assetId === asset.assetId).length, 1, "completion creates exactly one ScanJob atomically");
    assert.equal(completion.length, 1, "completed UploadSession has exactly one completion Event");
  }
  for (const alias of r.mediaAliases) {
    const revisions = r.publicationRevisions.filter(x => x.aliasId === alias.aliasId);
    assert.equal(revisions.length, alias.currentRevision, "Alias revision pointer and immutable history are atomic");
    if (!alias.currentRevision) { assert.equal(alias.currentPublicationRevisionId, null); continue; }
    const current = revisions.find(x => x.publicationRevisionId === alias.currentPublicationRevisionId);
    assert.ok(current, "Alias pointer cannot reference a missing publication");
    assert.equal(current.revision, alias.currentRevision);
    assert.equal(Math.max(...revisions.map(x => x.revision)), alias.currentRevision);
  }
}

export async function productionShell(ctx, api) {
  const response = await ctx.request(api.baseUrl, "/");
  assert.equal(response.status, 200);
  assert.match(response.text, /<(?:html|body|main|div)\b/iu, "production HTML");
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    assert.ok((await page.locator("body").innerText()).trim(), "production React page renders visible content");
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(errors, [], "page remains usable after reload");
  } finally { await browser.close(); }
}
