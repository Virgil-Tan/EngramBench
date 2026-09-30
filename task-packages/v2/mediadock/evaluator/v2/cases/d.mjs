import assert from "node:assert/strict";

import { chromiumExecutable } from "../lib/runtime.mjs";
import { assertSortedUnique } from "../lib/oracle.mjs";
import { assertNoSecrets, openUpload, requireStatus, result, snapshotCollections, uploadAll } from "./helpers.mjs";
import { aliasGrant, assertPinnedBytes, assertSnapshotConsistency, productionShell, publicationScenario, publish } from "./final-system.mjs";

const PUBLIC_PATHS = Object.freeze({
  "/api/v1/tenants": ["post"],
  "/api/v1/transcode-profiles": ["post"],
  "/api/v1/cleanup-policies": ["post"],
  "/api/v1/uploads": ["post"],
  "/api/v1/uploads/{uploadId}": ["get"],
  "/api/v1/uploads/{uploadId}/parts/{partNumber}": ["put"],
  "/api/v1/uploads/{uploadId}/complete": ["post"],
  "/api/v1/uploads/{uploadId}/abort": ["post"],
  "/api/v1/assets/{assetId}": ["get"],
  "/api/v1/assets/{assetId}/renditions": ["get"],
  "/api/v1/assets/{assetId}/access-grants": ["post"],
  "/api/v1/access-grants/{grantId}/revoke": ["post"],
  "/media/{grantId}": ["get", "head"],
  "/api/v1/scanner/results": ["post"],
  "/api/v1/scan-jobs/{scanJobId}/reconcile": ["post"],
  "/api/v1/cleanup-runs": ["post"],
  "/api/v1/cleanup-runs/{cleanupRunId}": ["get"],
  "/api/v1/verification-snapshot": ["get"],
  "/healthz": ["get"],
  "/openapi.json": ["get"],
  "/api/v1/media-aliases": ["post"],
  "/api/v1/media-aliases/{aliasId}": ["get"],
  "/api/v1/media-aliases/{aliasId}/publish": ["post"],
  "/api/v1/media-aliases/{aliasId}/resolve": ["get"],
  "/api/v1/media-aliases/{aliasId}/access-grants": ["post"],
});

async function d01(ctx) {
  const fixture = ctx.uploadFixture("d01", { bytes: Buffer.from("browser media pipeline"), partSize: 8_192 });
  await ctx.seed(ctx.seedFixture("d01"));
  await ctx.npm("build", [], { timeoutMs: 600_000 });
  const dev = await ctx.startDev({ healthPath: "/healthz" });
  const worker = await ctx.startWorker();
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch (cause) { throw new Error("playwright-core is required for MediaDock browser evaluation", { cause }); }
  const browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, baseURL: dev.baseUrl });
  const page = await browserContext.newPage();
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource.*4\d\d/iu.test(message.text())) consoleErrors.push(message.text()); });
  try {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: /MediaDock/iu }).waitFor();
    const tenantButton = page.getByRole("button", { name: /create.*tenant|new.*tenant/iu }).first();
    await tenantButton.click();
    const name = page.getByLabel(/tenant.*name|name/iu).first();
    await name.fill("Browser Tenant");
    await page.getByRole("button", { name: /save|create|submit/iu }).last().click();
    const file = page.locator('input[type="file"]').first();
    await file.setInputFiles({ name: fixture.fileName, mimeType: fixture.contentType, buffer: fixture.bytes });
    await page.getByRole("button", { name: /upload|start/iu }).last().click();
    await page.getByText("READY", { exact: true }).first().waitFor({ timeout: 120_000 });
    await page.getByText(fixture.fileName, { exact: true }).first().click();
    await page.getByRole("button", { name: /create.*grant|temporary access|issue.*grant/iu }).first().click();
    const grantToken = page.getByText(/token|capability/iu).first();
    await grantToken.waitFor();
    await page.getByRole("button", { name: /revoke/iu }).first().click();
    await page.getByRole("button", { name: /create.*cleanup|plan.*cleanup|cleanup run/iu }).first().click();
    await page.getByText(/PLANNED|RUNNING|COMPLETED/iu).first().waitFor();
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
    assert.equal((await page.locator("body").innerText()).includes(ctx.managedDataRoot), false);
    assert.equal(consoleErrors.length, 0);
    assert.equal(worker.child.exitCode, null);
  } finally {
    await browserContext.close();
    await browser.close();
  }
  return result(["production mobile Chromium drove visible tenant/upload controls, observed durable pipeline state, and survived refresh without secret/path leakage"]);
}

async function d02(ctx) {
  const { api, assets, alias, profiles } = await publicationScenario(ctx, "d02");
  const first = await publish(ctx, api, alias, assets[0].asset.assetId, 0);
  const read = requireStatus(await ctx.request(api.baseUrl, `/api/v1/media-aliases/${alias.aliasId}`), 200, "read Alias");
  assert.deepEqual(read.alias, first.alias);
  assert.deepEqual(read.revisions, [first.revision]);
  const resolved = requireStatus(await ctx.request(api.baseUrl, `/api/v1/media-aliases/${alias.aliasId}/resolve`), 200, "resolve Alias");
  assert.equal(resolved.publicationRevisionId, first.revision.publicationRevisionId);
  assert.equal(resolved.source.sha256, assets[0].fixture.expectedSha256);
  assert.deepEqual(resolved.renditions.map(x => x.profileId).sort(), profiles.map(x => x.profileId).sort());
  assert.ok(resolved.renditions.every(x => x.sha256 === assets[0].fixture.expectedSha256), "COPY publications capture their exact required rendition bytes");
  await productionShell(ctx, api);
  return result(["public Alias create/publish/read/resolve agree with real uploaded bytes; production page renders and reloads without imposing undisclosed Alias buttons"]);
}

async function d03(ctx) {
  const { api, tenant, alias, assets } = await publicationScenario(ctx, "d03");
  const openapi = requireStatus(await ctx.request(api.baseUrl, "/openapi.json"), 200, "OpenAPI");
  assert.equal(openapi.openapi, "3.1.0");
  for (const [path, methods] of Object.entries(PUBLIC_PATHS)) {
    assert.ok(openapi.paths?.[path], `OpenAPI missing ${path}`);
    for (const method of methods) assert.ok(openapi.paths[path][method], `OpenAPI missing ${method.toUpperCase()} ${path}`);
  }
  const opened = [];
  for (let index = 0; index < 24; index += 1) {
    const fixture = ctx.uploadFixture(`d03-concurrent-${index}`, { bytes: Buffer.from(`snapshot-${index}`), partSize: 8192 });
    const upload = await openUpload(ctx, api, tenant.tenantId, fixture);
    await uploadAll(ctx, api, upload.upload, upload.parts);
    opened.push(upload);
  }
  const uploadIds = opened.map(x => x.upload.uploadId);
  const samples = [];
  const sample = async () => {
    const value = await ctx.snapshot(api.baseUrl);
    assertSnapshotConsistency(value, uploadIds);
    samples.push(value);
  };
  await sample();
  await Promise.all([
    ctx.concurrent(opened, 8, async item => {
      requireStatus(await ctx.completeUpload(api.baseUrl, item.upload.uploadId, item.parts, ctx.uniqueKey("snapshot-complete")), 200, "concurrent complete");
    }),
    (async () => {
      for (let revision = 0; revision < 16; revision += 1) await publish(ctx, api, alias, assets[revision % 2].asset.assetId, revision);
    })(),
    (async () => { for (let index = 0; index < 32; index += 1) await sample(); })(),
  ]);
  await sample();
  const snapshot = samples.at(-1);
  const resources = snapshotCollections(snapshot);
  const identityKeys = {
    tenants: "tenantId", uploadSessions: "uploadId", blobObjects: "blobId",
    mediaAssets: "assetId", scanJobs: "scanJobId", scanResults: "scanResultId",
    transcodeJobs: "transcodeJobId", renditions: "renditionId", accessGrants: "grantId", cleanupPolicies: "policyId",
    cleanupRuns: "cleanupRunId", cleanupEntries: "cleanupEntryId", mediaAliases: "aliasId", publicationRevisions: "publicationRevisionId",
  };
  for (const [collection, key] of Object.entries(identityKeys)) {
    assert.ok(Array.isArray(resources[collection]), `snapshot missing ${collection}`);
    if (resources[collection].length > 0 && resources[collection].every((item) => typeof item[key] === "string")) assertSortedUnique(resources[collection], key);
  }
  assertSortedUnique(snapshot.work, "workId");
  const tupleOrder = (items, keys) => {
    const compare = (left, right) => {
      for (const key of keys) if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
      return 0;
    };
    assert.deepEqual(items, [...items].sort(compare), `snapshot order ${keys.join(",")}`);
    for (let index = 1; index < items.length; index += 1) assert.notEqual(compare(items[index - 1], items[index]), 0, "duplicate tuple identity");
  };
  tupleOrder(resources.uploadParts, ["uploadId", "partNumber"]);
  tupleOrder(resources.transcodeProfiles, ["profileId", "revision"]);
  tupleOrder(snapshot.events, ["aggregateId", "sequence", "eventId"]);
  assertNoSecrets(snapshot, [ctx.managedDataRoot, ctx.adminToken, ctx.barrierToken]);
  return result([`${samples.length} real concurrent snapshots preserved atomic upload/asset/blob/scan/event and Alias/revision relationships; final ordering and secrecy verified`]);
}

async function d04(ctx) {
  const { api, tenant, worker, alias, assets } = await publicationScenario(ctx, "d04");
  const first = await publish(ctx, api, alias, assets[0].asset.assetId, 0);
  const oldGrant = await aliasGrant(ctx, api, alias);
  const second = await publish(ctx, api, alias, assets[1].asset.assetId, 1);
  const newGrant = await aliasGrant(ctx, api, alias);
  await assertPinnedBytes(ctx, api, oldGrant, first.revision, assets[0].fixture.bytes);
  await assertPinnedBytes(ctx, api, newGrant, second.revision, assets[1].fixture.bytes);
  const policy = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/cleanup-policies", ctx.uniqueKey("policy"), { tenantId: tenant.tenantId, retention: { expiredUploadSeconds: 0, stagingSeconds: 0, infectedSourceSeconds: 0, failedRenditionSeconds: 0, expiredGrantSeconds: 0, unreferencedBlobSeconds: 0 } }), 200, "cleanup policy");
  const cleanup = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/cleanup-runs", ctx.uniqueKey("cleanup"), { tenantId: tenant.tenantId, policyRevision: policy.revision, cutoffAt: new Date().toISOString() }), 200, "cleanup live publication references");
  await ctx.waitSnapshot(api.baseUrl, state => state.resources.cleanupRuns.some(x => x.cleanupRunId === cleanup.cleanupRunId && x.state === "COMPLETED"), { timeoutMs: 120_000, processes: [worker] });
  await assertPinnedBytes(ctx, api, oldGrant, first.revision, assets[0].fixture.bytes);
  await assertPinnedBytes(ctx, api, newGrant, second.revision, assets[1].fixture.bytes);
  const read = requireStatus(await ctx.request(api.baseUrl, `/api/v1/media-aliases/${alias.aliasId}`), 200, "publication history after cleanup");
  assert.deepEqual(read.revisions.find(x => x.publicationRevisionId === first.revision.publicationRevisionId), first.revision);
  return result(["two real publication revisions retained immutable lineage and exact old/new Grant bytes across republish and cleanup"]);
}

export const D_CASES = Object.freeze([
  { id: "D-01", taskId: "mediadock", run: d01 },
  { id: "D-02", taskId: "mediadock", run: d02 },
  { id: "D-03", taskId: "mediadock", run: d03 },
  { id: "D-04", taskId: "mediadock", run: d04 },
]);
