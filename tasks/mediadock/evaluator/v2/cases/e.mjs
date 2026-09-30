import assert from "node:assert/strict";

import { CaseExcluded } from "../lib/execution.mjs";
import { partManifest, sha256 } from "../lib/oracle.mjs";
import {
  createCompleted, createGrant, openUpload, requireStatus, result, uploadAll, waitAsset,
} from "./helpers.mjs";

async function e01(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  const fixture = ctx.uploadFixture("e01", { bytes: Buffer.from("V1 bytes retained through FINAL"), partSize: 8_192 });
  const legacy = ctx.forWorkspace(ctx.v1Workspace);
  await legacy.command("npm", ["ci"], { timeoutMs: 600_000 });
  await legacy.npm("build", [], { timeoutMs: 600_000 });
  await legacy.migrate();
  await legacy.seed(ctx.seedFixture("e01"));
  const oldApi = await legacy.startApi();
  const tenantKey = ctx.key("v1-tenant");
  const tenantBody = { name: "V1 Tenant" };
  const tenantResponse = requireStatus(await ctx.mutate(oldApi.baseUrl, "/api/v1/tenants", tenantKey, tenantBody), 200, "V1 tenant");
  const opened = await openUpload(ctx, oldApi, tenantResponse.tenantId, fixture, ctx.key("v1-upload"));
  await uploadAll(ctx, oldApi, opened.upload, opened.parts);
  const completeKey = ctx.key("v1-complete");
  const completedResponse = requireStatus(await ctx.completeUpload(oldApi.baseUrl, opened.upload.uploadId, opened.parts, completeKey), 200, "V1 complete");
  const oldWorker = await legacy.startWorker();
  const oldAsset = await waitAsset(ctx, oldApi, completedResponse.assetId, "READY", [oldWorker]);
  const grantKey = ctx.key("v1-grant");
  const originalGrant = await createGrant(ctx, oldApi, oldAsset.assetId, {}, grantKey);
  const originalBytes = await ctx.request(oldApi.baseUrl, `/media/${originalGrant.grant.grantId}?token=${encodeURIComponent(originalGrant.token)}`, { binary: true });
  assert.deepEqual(originalBytes.body, fixture.bytes);
  const before = await ctx.snapshot(oldApi.baseUrl);
  await legacy.stop(oldWorker);
  await legacy.stop(oldApi);
  await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
  await ctx.npm("build", [], { timeoutMs: 600_000 });
  await ctx.migrate();
  await ctx.migrate();
  const api = await ctx.startApi();
  const tenantReplay = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/tenants", tenantKey, tenantBody), 200, "FINAL tenant replay");
  assert.deepEqual(tenantReplay, tenantResponse);
  const completeReplay = requireStatus(await ctx.completeUpload(api.baseUrl, opened.upload.uploadId, opened.parts, completeKey), 200, "FINAL complete replay");
  assert.deepEqual(completeReplay, completedResponse);
  const grantReplay = await createGrant(ctx, api, oldAsset.assetId, {}, grantKey);
  assert.deepEqual(grantReplay, originalGrant);
  const finalBytes = await ctx.request(api.baseUrl, `/media/${grantReplay.grant.grantId}?token=${encodeURIComponent(grantReplay.token)}`, { binary: true });
  assert.deepEqual(finalBytes.body, fixture.bytes);
  const after = await ctx.snapshot(api.baseUrl);
  for (const collection of ["uploadSessions", "uploadParts", "blobObjects", "mediaAssets", "scanJobs", "scanResults", "transcodeProfiles", "transcodeJobs", "renditions", "accessGrants", "cleanupPolicies", "cleanupRuns", "cleanupEntries"]) {
    assert.deepEqual(after.resources[collection], before.resources[collection], `migration changed ${collection}`);
  }
  assert.deepEqual(after.work, before.work);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.resources.mediaAliases ?? [], []);
  assert.deepEqual(after.resources.publicationRevisions ?? [], []);
  return result(["same-database FINAL migration preserved V1 public identities, replay bodies, Work, Events, and every reachable byte"]);
}

async function e02(ctx) {
  const partSize = 8_192;
  const bytes = Buffer.alloc(partSize * 10_000, 0x4d);
  const fixture = ctx.uploadFixture("e02", { bytes, partSize });
  await ctx.seed(ctx.seedFixture("e02"));
  const apiOne = await ctx.startApi();
  const apiTwo = await ctx.startApi();
  const tenant = requireStatus(await ctx.createTenant(apiOne.baseUrl, "e02"), 200, "tenant");
  const opened = await openUpload(ctx, apiOne, tenant.tenantId, fixture);
  assert.equal(opened.parts.length, 10_000);
  await ctx.concurrent(opened.parts, 32, (part, index) => ctx.putPart(index % 2 ? apiOne.baseUrl : apiTwo.baseUrl, opened.upload.uploadId, part, fixture.expectedSize, ctx.uniqueKey(`part-${part.partNumber}`)).then((response) => {
    assert.equal(response.status, 200, `part ${part.partNumber}: ${response.text ?? ""}`);
  }));
  const resumed = requireStatus(await ctx.getUpload(apiTwo.baseUrl, opened.upload.uploadId), 200, "10k resume");
  assert.equal((resumed.parts ?? resumed.uploadParts).length, 10_000);
  const completed = requireStatus(await ctx.completeUpload(apiOne.baseUrl, opened.upload.uploadId, opened.parts, ctx.uniqueKey("complete")), 200, "10k complete");
  assert.equal(completed.expectedSha256, sha256(bytes));
  const tooMany = ctx.uploadFixture("too-many", { bytes: Buffer.alloc(partSize * 10_000 + 1, 0x58), partSize, fileName: "../../escape.bin" });
  const rejected = await ctx.createUpload(apiOne.baseUrl, {
    tenantId: tenant.tenantId, fileName: tooMany.fileName, contentType: tooMany.contentType,
    expectedSize: tooMany.expectedSize, expectedSha256: tooMany.expectedSha256, partSize, expiresAt: ctx.at({ minutes: 30 }),
  }, ctx.uniqueKey("too-many"));
  assert.equal(rejected.status, 400);
  const snapshot = await ctx.snapshot(apiOne.baseUrl);
  assert.equal(JSON.stringify(snapshot).includes("../"), false);
  assert.equal(JSON.stringify(snapshot).includes(ctx.managedDataRoot), false);
  return result(["exact 10,000-part boundary resumed and completed across two APIs while 10,001/path-like input was atomically rejected"]);
}

async function e03(ctx) {
  const fixture = ctx.uploadFixture("e03", { bytes: Buffer.alloc(16 * 1024 * 1024, 0x53), partSize: 8_388_608 });
  await ctx.seed(ctx.seedFixture("e03"));
  const api = await ctx.startApi();
  const tenant = requireStatus(await ctx.createTenant(api.baseUrl, "e03"), 200, "tenant");
  const completed = await createCompleted(ctx, api, tenant.tenantId, fixture, "asset");
  const worker = await ctx.startWorker();
  const asset = await waitAsset(ctx, api, completed.upload.assetId, "READY", [worker]);
  const grant = await createGrant(ctx, api, asset.assetId);
  const url = new URL(`/media/${grant.grant.grantId}?token=${encodeURIComponent(grant.token)}`, api.baseUrl);
  const responses = await Promise.all(Array.from({ length: 4 }, () => fetch(url)));
  assert.ok(responses.every(({ status }) => status === 200));
  const readers = responses.map((response) => response.body.getReader());
  const firstChunks = await Promise.all(readers.map((reader) => reader.read()));
  assert.ok(firstChunks.every(({ done, value }) => !done && value.length > 0));
  await ctx.mutate(api.baseUrl, `/api/v1/access-grants/${grant.grant.grantId}/revoke`, ctx.uniqueKey("revoke"), {});
  const policy = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/cleanup-policies", ctx.uniqueKey("policy"), { tenantId: tenant.tenantId, retentionSeconds: 0 }), 200, "policy");
  await ctx.mutate(api.baseUrl, "/api/v1/cleanup-runs", ctx.uniqueKey("cleanup"), { tenantId: tenant.tenantId, policyRevision: policy.revision, cutoffAt: ctx.at() });
  const bodies = [];
  for (let index = 0; index < readers.length; index += 1) {
    const chunks = [Buffer.from(firstChunks[index].value)];
    while (true) {
      const next = await readers[index].read();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    bodies.push(Buffer.concat(chunks));
  }
  assert.ok(bodies.every((body) => body.length === fixture.bytes.length && sha256(body) === fixture.expectedSha256));
  const next = await fetch(url);
  assert.equal(next.status, 409);
  return result(["four resolved live streams remained byte-complete through revoke and cleanup while the next request observed revocation"]);
}

async function e04(ctx) {
  ctx.blocked("publication-cas-wire", "MD-GAP-01");
  ctx.blocked("publication-effect-window", "MD-GAP-05");
  return result(["publication CAS and crash recovery stay fail-closed until both the public wire and barrier checkpoint exist"]);
}

export const E_CASES = Object.freeze([
  { id: "E-01", taskId: "mediadock", run: e01 },
  { id: "E-02", taskId: "mediadock", run: e02 },
  { id: "E-03", taskId: "mediadock", run: e03 },
  { id: "E-04", taskId: "mediadock", run: e04 },
]);
