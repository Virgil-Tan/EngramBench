import assert from "node:assert/strict";

import { partManifest, sha256 } from "../lib/oracle.mjs";

export const UPLOAD_KEYS = Object.freeze(["uploadId", "tenantId", "fileName", "contentType", "expectedSize", "expectedSha256", "partSize", "state", "expiresAt", "assetId", "createdAt", "completedAt", "sequence"]);
export const PART_KEYS = Object.freeze(["uploadId", "partNumber", "start", "end", "size", "sha256", "createdAt"]);
export const ASSET_KEYS = Object.freeze(["assetId", "tenantId", "sourceBlobId", "fileName", "contentType", "size", "sha256", "state", "createdAt", "readyAt", "sequence"]);
export const RENDITION_KEYS = Object.freeze(["renditionId", "assetId", "profileId", "profileRevision", "blobId", "size", "sha256", "state", "createdAt", "deletedAt"]);
export const GRANT_KEYS = Object.freeze(["grantId", "tenantId", "assetId", "renditionId", "expiresAt", "state", "createdAt", "revokedAt", "publicationRevisionId"]);
export const WORK_KEYS = Object.freeze(["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"]);

export function result(evidence = []) { return { evidence }; }

// Live expiry is relative to request time; the seeded history clock is not the service clock.
export function expiresAfter(minutes) { return new Date(Date.now() + minutes * 60_000).toISOString(); }

export function requireStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label}: ${response.text ?? ""}`);
  assert.ok(response.json && typeof response.json === "object", `${label}: response must be JSON`);
  return response.json;
}

export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has an open or incomplete wire shape`);
}

export function assertError(response, status, code, label) {
  assert.equal(response.status, status, `${label}: ${response.text ?? ""}`);
  assert.deepEqual(Object.keys(response.json ?? {}).sort(), ["error"]);
  assert.deepEqual(Object.keys(response.json.error ?? {}).sort(), ["code", "details", "message"]);
  assert.equal(response.json.error.code, code);
}

export async function prepare(ctx, label, profiles = []) {
  await ctx.seed(ctx.seedFixture(label));
  const api = await ctx.startApi();
  const tenant = requireStatus(await ctx.createTenant(api.baseUrl, label), 200, "create tenant");
  const createdProfiles = [];
  for (const profile of profiles) {
    const body = { tenantId: tenant.tenantId, name: profile.name, operation: profile.operation, prefixBase64: profile.prefixBase64, maxAttempts: profile.maxAttempts };
    createdProfiles.push(requireStatus(await ctx.createProfile(api.baseUrl, body), 200, "create transcode profile"));
  }
  return { api, tenant, profiles: createdProfiles };
}

export async function openUpload(ctx, api, tenantId, fixture, key) {
  const body = {
    tenantId,
    fileName: fixture.fileName,
    contentType: fixture.contentType,
    expectedSize: fixture.expectedSize,
    expectedSha256: fixture.expectedSha256,
    partSize: fixture.partSize,
    expiresAt: expiresAfter(30),
  };
  const response = await ctx.createUpload(api.baseUrl, body, key);
  const upload = requireStatus(response, 200, "create upload");
  exactKeys(upload, UPLOAD_KEYS, "UploadSession");
  return { body, response, upload, parts: partManifest(fixture.bytes, fixture.partSize) };
}

export async function uploadAll(ctx, api, upload, parts, order = parts.map((_, index) => index)) {
  for (const index of order) {
    const response = await ctx.putPart(api.baseUrl, upload.uploadId, parts[index], upload.expectedSize);
    const body = requireStatus(response, 200, `upload part ${parts[index].partNumber}`);
    exactKeys(body, PART_KEYS, "UploadPart");
    assert.equal(body.start, parts[index].start);
    assert.equal(body.end, parts[index].end);
    assert.equal(body.size, parts[index].size);
    assert.equal(body.sha256, parts[index].sha256);
  }
}

export async function complete(ctx, api, upload, parts, key) {
  const response = await ctx.completeUpload(api.baseUrl, upload.uploadId, parts, key);
  const body = requireStatus(response, 200, "complete upload");
  exactKeys(body, UPLOAD_KEYS, "completed UploadSession");
  assert.equal(body.state, "COMPLETED");
  assert.ok(body.assetId);
  return body;
}

export async function createCompleted(ctx, api, tenantId, fixture, label) {
  const opened = await openUpload(ctx, api, tenantId, fixture, ctx.uniqueKey(`${label}-create`));
  await uploadAll(ctx, api, opened.upload, opened.parts, [...opened.parts.keys()].reverse());
  const upload = await complete(ctx, api, opened.upload, opened.parts, ctx.uniqueKey(`${label}-complete`));
  return { ...opened, upload };
}

export async function waitAsset(ctx, api, assetId, states, processes = []) {
  const accepted = new Set(Array.isArray(states) ? states : [states]);
  return ctx.waitFor(async () => {
    const response = await ctx.getAsset(api.baseUrl, assetId);
    if (response.status !== 200) return undefined;
    exactKeys(response.json, ASSET_KEYS, "MediaAsset");
    return accepted.has(response.json.state) ? response.json : undefined;
  }, { timeoutMs: 120_000, intervalMs: 100, label: `asset ${assetId} -> ${[...accepted].join("|")}`, processes });
}

export async function createGrant(ctx, api, assetId, options = {}, key = ctx.uniqueKey("grant")) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/assets/${assetId}/access-grants`, key, {
    renditionId: options.renditionId ?? null,
    expiresAt: options.expiresAt ?? expiresAfter(10),
  });
  const body = requireStatus(response, 200, "create grant");
  assert.deepEqual(Object.keys(body).sort(), ["grant", "token", "url"]);
  exactKeys(body.grant, GRANT_KEYS, "AccessGrant");
  assert.equal(typeof body.token, "string");
  assert.ok(!JSON.stringify(body.grant).includes(body.token));
  return body;
}

export async function downloadGrant(ctx, api, grant, options = {}) {
  return ctx.request(api.baseUrl, `/media/${grant.grant.grantId}?token=${encodeURIComponent(grant.token)}`, {
    method: options.method ?? "GET",
    headers: options.headers,
    binary: true,
  });
}

export function snapshotCollections(snapshot) {
  assert.ok(snapshot && typeof snapshot === "object");
  assert.ok(snapshot.resources && Array.isArray(snapshot.work) && Array.isArray(snapshot.events));
  return snapshot.resources;
}

export function assertNoSecrets(value, sentinels = []) {
  const source = JSON.stringify(value);
  for (const sentinel of sentinels.filter(Boolean)) assert.equal(source.includes(String(sentinel)), false, `public data leaked ${sentinel}`);
  assert.equal(/(?:managed_data_root|tokenHash|rawToken|scannerPayload|temporaryFilename|physicalRefCount)/iu.test(source), false);
}

export function eventIds(snapshot) { return new Set((snapshot.events ?? []).map(({ eventId }) => eventId)); }
export function digestBody(response) { return sha256(response.body ?? Buffer.alloc(0)); }
