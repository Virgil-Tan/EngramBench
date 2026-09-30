import assert from "node:assert/strict";

import { chromiumExecutable } from "../lib/runtime.mjs";
import { assertSortedUnique } from "../lib/oracle.mjs";
import { assertNoSecrets, prepare, requireStatus, result, snapshotCollections } from "./helpers.mjs";

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
  ctx.blocked("alias-public-wire", "MD-GAP-01");
  ctx.blocked("alias-render-target", "MD-GAP-02");
  return result(["MediaAlias UI cannot be executed until its request, response, status, error, and rendition target wire are public"]);
}

async function d03(ctx) {
  const { api } = await prepare(ctx, "d03");
  const openapi = requireStatus(await ctx.request(api.baseUrl, "/openapi.json"), 200, "OpenAPI");
  assert.equal(openapi.openapi, "3.1.0");
  for (const [path, methods] of Object.entries(PUBLIC_PATHS)) {
    assert.ok(openapi.paths?.[path], `OpenAPI missing ${path}`);
    for (const method of methods) assert.ok(openapi.paths[path][method], `OpenAPI missing ${method.toUpperCase()} ${path}`);
  }
  const snapshot = await ctx.snapshot(api.baseUrl);
  const resources = snapshotCollections(snapshot);
  const identityKeys = {
    tenants: "tenantId", uploadSessions: "uploadId", uploadParts: "partNumber", blobObjects: "blobId",
    mediaAssets: "assetId", scanJobs: "scanJobId", scanResults: "scanResultId", transcodeProfiles: "profileId",
    transcodeJobs: "transcodeJobId", renditions: "renditionId", accessGrants: "grantId", cleanupPolicies: "policyId",
    cleanupRuns: "cleanupRunId", cleanupEntries: "cleanupEntryId",
  };
  for (const [collection, key] of Object.entries(identityKeys)) {
    assert.ok(Array.isArray(resources[collection]), `snapshot missing ${collection}`);
    if (resources[collection].length > 0 && resources[collection].every((item) => typeof item[key] === "string")) assertSortedUnique(resources[collection], key);
  }
  assertSortedUnique(snapshot.work, "workId");
  assertSortedUnique(snapshot.events, "eventId");
  assertNoSecrets(snapshot, [ctx.managedDataRoot, ctx.adminToken, ctx.barrierToken]);
  ctx.blocked("alias-snapshot-shape", "MD-GAP-01");
  return result(["frozen V1 OpenAPI paths and point-in-time sorted secret-free snapshot were verified independently"]);
}

async function d04(ctx) {
  ctx.blocked("publication-wire", "MD-GAP-01");
  ctx.blocked("grant-lineage", "MD-GAP-02");
  ctx.blocked("old-revision-retention", "MD-GAP-03");
  return result(["alias stream, revision-bound Grant, and old-revision retention assertions remain fail-closed until their public contracts exist"]);
}

export const D_CASES = Object.freeze([
  { id: "D-01", taskId: "mediadock", run: d01 },
  { id: "D-02", taskId: "mediadock", run: d02 },
  { id: "D-03", taskId: "mediadock", run: d03 },
  { id: "D-04", taskId: "mediadock", run: d04 },
]);
