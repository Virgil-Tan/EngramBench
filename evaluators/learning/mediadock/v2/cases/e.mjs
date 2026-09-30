import assert from "node:assert/strict";

import { partManifest, sha256 } from "../lib/oracle.mjs";
import {
  createCompleted, createGrant, expiresAfter, openUpload, requireStatus, result, uploadAll, waitAsset,
} from "./helpers.mjs";
import { aliasGrant, assertPinnedBytes, assertSnapshotConsistency, publicationScenario } from "./final-system.mjs";

async function e01(ctx) {
  const fixture = ctx.uploadFixture("e01", { bytes: Buffer.from("Final-system bytes retained through FINAL"), partSize: 8_192 });
  await ctx.seed(ctx.seedFixture("e01"));
  const oldApi = await ctx.startApi();
  const tenantKey = ctx.key("durable-tenant");
  const tenantBody = { name: "Final-system Tenant" };
  const tenantResponse = requireStatus(await ctx.mutate(oldApi.baseUrl, "/api/v1/tenants", tenantKey, tenantBody), 200, "Final-system tenant");
  const opened = await openUpload(ctx, oldApi, tenantResponse.tenantId, fixture, ctx.key("durable-upload"));
  await uploadAll(ctx, oldApi, opened.upload, opened.parts);
  const completeKey = ctx.key("durable-complete");
  const completedResponse = requireStatus(await ctx.completeUpload(oldApi.baseUrl, opened.upload.uploadId, opened.parts, completeKey), 200, "Final-system complete");
  const oldWorker = await ctx.startWorker();
  const oldAsset = await waitAsset(ctx, oldApi, completedResponse.assetId, "READY", [oldWorker]);
  const grantKey = ctx.key("durable-grant");
  const grantOptions = { expiresAt: expiresAfter(10) };
  const originalGrant = await createGrant(ctx, oldApi, oldAsset.assetId, grantOptions, grantKey);
  const originalBytes = await ctx.request(oldApi.baseUrl, `/media/${originalGrant.grant.grantId}?token=${encodeURIComponent(originalGrant.token)}`, { binary: true });
  assert.deepEqual(originalBytes.body, fixture.bytes);
  await ctx.stop(oldWorker);
  const before = await ctx.snapshot(oldApi.baseUrl);
  await ctx.stop(oldApi);
  const api = await ctx.startApi();
  const tenantReplay = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/tenants", tenantKey, tenantBody), 200, "FINAL tenant replay");
  assert.deepEqual(tenantReplay, tenantResponse);
  const completeReplay = requireStatus(await ctx.completeUpload(api.baseUrl, opened.upload.uploadId, opened.parts, completeKey), 200, "FINAL complete replay");
  assert.deepEqual(completeReplay, completedResponse);
  const grantReplay = await createGrant(ctx, api, oldAsset.assetId, grantOptions, grantKey);
  assert.deepEqual(grantReplay, originalGrant);
  const finalBytes = await ctx.request(api.baseUrl, `/media/${grantReplay.grant.grantId}?token=${encodeURIComponent(grantReplay.token)}`, { binary: true });
  assert.deepEqual(finalBytes.body, fixture.bytes);
  const after = await ctx.snapshot(api.baseUrl);
  for (const collection of ["uploadSessions", "uploadParts", "blobObjects", "mediaAssets", "scanJobs", "scanResults", "transcodeProfiles", "transcodeJobs", "renditions", "accessGrants", "cleanupPolicies", "cleanupRuns", "cleanupEntries"]) {
    assert.deepEqual(after.resources[collection], before.resources[collection], `restart changed ${collection}`);
  }
  assert.deepEqual(after.work, before.work);
  assert.deepEqual(after.events, before.events);
  assert.deepEqual(after.resources.mediaAliases, before.resources.mediaAliases);
  assert.deepEqual(after.resources.publicationRevisions, before.resources.publicationRevisions);
  return result(["same-database FINAL restart preserved Final-system public identities, replay bodies, Work, Events, and every reachable byte"]);
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
    expectedSize: tooMany.expectedSize, expectedSha256: tooMany.expectedSha256, partSize, expiresAt: expiresAfter(30),
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
  const policy = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/cleanup-policies", ctx.uniqueKey("policy"), { tenantId: tenant.tenantId, retention: { expiredUploadSeconds: 0, stagingSeconds: 0, infectedSourceSeconds: 0, failedRenditionSeconds: 0, expiredGrantSeconds: 0, unreferencedBlobSeconds: 0 } }), 200, "policy");
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
  const { api, alias, assets, worker } = await publicationScenario(ctx, "e04");
  const requests = Array.from({ length: 16 }, (_, index) => ({ key: ctx.uniqueKey(`cas-${index}`), body: { expectedRevision: 0, assetId: assets[index % 2].asset.assetId } }));
  const responses = await ctx.concurrent(requests, 16, request => ctx.mutate(api.baseUrl, `/api/v1/media-aliases/${alias.aliasId}/publish`, request.key, request.body));
  const winners = responses.map((response, index) => ({ response, index })).filter(x => x.response.status === 200);
  assert.equal(winners.length, 1, "one concurrent CAS may advance revision zero");
  for (const response of responses.filter(x => x.status !== 200)) {
    assert.equal(response.status, 409);
    assert.equal(response.json.error.code, "PUBLICATION_REVISION_CONFLICT");
  }
  const { response: winner, index } = winners[0];
  const before = await ctx.snapshot(api.baseUrl);
  assertSnapshotConsistency(before);
  const works = before.work.filter(x => x.kind === "PUBLICATION_SWITCH");
  assert.equal(works.length, 1, "one committed publication Work");
  await ctx.kill(worker);
  await ctx.stop(api);
  const restarted = await ctx.startApi();
  const replacement = await ctx.startWorker();
  const replay = requireStatus(await ctx.mutate(restarted.baseUrl, `/api/v1/media-aliases/${alias.aliasId}/publish`, requests[index].key, requests[index].body), 200, "publication replay after process replacement");
  assert.deepEqual(replay, winner.json);
  const final = await ctx.waitSnapshot(restarted.baseUrl, state => state.work.some(x => x.workId === works[0].workId && x.state === "SUCCEEDED"), { timeoutMs: 120_000, processes: [replacement], label: "publication Work succeeded" });
  assertSnapshotConsistency(final);
  assert.equal(final.resources.publicationRevisions.filter(x => x.aliasId === alias.aliasId).length, 1);
  assert.equal(final.events.filter(x => x.type === "PUBLICATION_SWITCH").length, 1);
  const grant = await aliasGrant(ctx, restarted, alias);
  await assertPinnedBytes(ctx, restarted, grant, winner.json.revision, assets[index % 2].fixture.bytes);
  return result([`16 real CAS requests produced one durable publication; replay, Work and exact Grant bytes survived process replacement from observed ${works[0].state}`]);
}

export const E_CASES = Object.freeze([
  { id: "E-01", taskId: "mediadock", run: e01 },
  { id: "E-02", taskId: "mediadock", run: e02 },
  { id: "E-03", taskId: "mediadock", run: e03 },
  { id: "E-04", taskId: "mediadock", run: e04 },
]);
