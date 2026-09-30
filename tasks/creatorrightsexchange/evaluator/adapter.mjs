import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `ce000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const creatorA = id(2);
const creatorB = id(3);
const creatorC = id(4);
const workId = id(5);
const profileId = id(6);
const seededAssetId = id(7);
const seededRenditionId = id(8);
const seededEditionId = id(9);
const seededOfferId = id(10);
const openPeriodId = id(11);
const now = "2026-08-01T00:00:00.000Z";
const periodEnd = "2026-09-01T00:00:00.000Z";

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function bytesFor(index) {
  const bytes = Buffer.alloc(128 * 1024, index % 251);
  bytes.write(`creator-rights-media-${index}`, 0, "utf8");
  return bytes;
}
const chunksFor = (bytes) => {
  const middle = 64 * 1024;
  return [bytes.subarray(0, middle), bytes.subarray(middle)].map((body, index) => ({
    chunkNumber: index + 1,
    start: index === 0 ? 0 : middle,
    end: (index === 0 ? middle : bytes.length) - 1,
    body,
    sha256: sha256(body),
  }));
};

function seed(seedVersion = "hidden-creatorrightsexchange", extra = {}) {
  const body = bytesFor(0);
  const mediaDigest = sha256(body);
  const manifestDigest = sha256(canonical({
    assets: [{ assetId: seededAssetId, assetSha256: mediaDigest, ordinal: 1, renditionId: seededRenditionId, renditionSha256: mediaDigest }],
    rightsRevision: 1,
  }));
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: now,
    tenants: [{ tenantId, name: "Hidden Rights Studio" }],
    creators: [
      { creatorId: creatorA, tenantId, displayName: "Creator A", payoutCurrency: "USD" },
      { creatorId: creatorB, tenantId, displayName: "Creator B", payoutCurrency: "USD" },
      { creatorId: creatorC, tenantId, displayName: "Creator C", payoutCurrency: "USD" },
    ],
    works: [{ workId, tenantId, externalRef: "hidden-work", title: "Hidden Work", currentRightsRevision: 1 }],
    rightsSplits: [
      { workId, revision: 1, creatorId: creatorA, basisPoints: 3_333, effectiveFrom: now },
      { workId, revision: 1, creatorId: creatorB, basisPoints: 3_333, effectiveFrom: now },
      { workId, revision: 1, creatorId: creatorC, basisPoints: 3_334, effectiveFrom: now },
    ],
    uploadSessions: [], uploadChunks: [],
    blobObjects: [{ blobId: seededAssetId, tenantId, sha256: mediaDigest, sizeBytes: body.length, state: "READY", contentBase64: body.toString("base64"), createdAt: now }],
    scanJobs: [{ scanJobId: id(100), assetId: seededAssetId, state: "CLEAN", attempt: 1, leaseOwner: null, leaseToken: null, leaseExpiresAt: null }],
    scanResults: [{ scanResultId: id(101), scanJobId: id(100), assetId: seededAssetId, verdict: "CLEAN", engineVersion: "seed-v1", contentSha256: mediaDigest, createdAt: now }],
    transcodeProfiles: [{ profileId, tenantId, revision: 1, name: "web-copy", operation: "COPY", prefixBase64: null, active: true }],
    transcodeJobs: [{ transcodeJobId: id(102), assetId: seededAssetId, profileId, profileRevision: 1, state: "READY", attempt: 1, leaseOwner: null, leaseToken: null, leaseExpiresAt: null }],
    renditions: [{ renditionId: seededRenditionId, assetId: seededAssetId, profileId, profileRevision: 1, sha256: mediaDigest, sizeBytes: body.length, state: "READY", contentBase64: body.toString("base64"), createdAt: now }],
    editions: [{ editionId: seededEditionId, tenantId, workId, title: "Seeded Edition", revision: 1, state: "PUBLISHED", rightsRevision: 1, manifestDigest, publishedAt: now, createdAt: now }],
    editionAssets: [{ editionId: seededEditionId, ordinal: 1, assetId: seededAssetId, renditionId: seededRenditionId, assetSha256: mediaDigest, renditionSha256: mediaDigest }],
    licenseOffers: [{ offerId: seededOfferId, tenantId, editionId: seededEditionId, state: "ACTIVE", licenseType: "STREAM", territories: ["US"], priceMinor: 10_001, currency: "USD", termsVersion: 1, createdAt: now }],
    purchaseOrders: [], paymentIntents: [], fraudAssessments: [], reviewCases: [], licenses: [], entitlementGrants: [], refunds: [],
    royaltyAccounts: [
      { royaltyAccountId: id(200), tenantId, ownerType: "PLATFORM", ownerId: tenantId, currency: "USD" },
      { royaltyAccountId: id(201), tenantId, ownerType: "CREATOR", ownerId: creatorA, currency: "USD" },
      { royaltyAccountId: id(202), tenantId, ownerType: "CREATOR", ownerId: creatorB, currency: "USD" },
      { royaltyAccountId: id(203), tenantId, ownerType: "CREATOR", ownerId: creatorC, currency: "USD" },
    ],
    royaltyEntries: [],
    royaltyPeriods: [{ royaltyPeriodId: openPeriodId, tenantId, currency: "USD", periodStart: now, periodEnd, state: "OPEN", closedAt: null, snapshotDigest: null }],
    notifications: [], deliveries: [],
    ...extra,
  };
}

function commercialRows(total, prefix = "seeded") {
  const purchaseOrders = [];
  const paymentIntents = [];
  const fraudAssessments = [];
  const licenses = [];
  const entitlementGrants = [];
  const royaltyEntries = [];
  for (let index = 0; index < total; index += 1) {
    const purchaseOrderId = id(1_000_000 + index);
    const paymentIntentId = id(2_000_000 + index);
    const assessmentId = id(3_000_000 + index);
    const licenseId = id(4_000_000 + index);
    const postingId = id(5_000_000 + index);
    const buyerRef = `${prefix}-${index}`;
    purchaseOrders.push({ purchaseOrderId, tenantId, buyerRef, offerId: seededOfferId, editionId: seededEditionId, priceMinor: 10_001, currency: "USD", termsVersion: 1, rightsRevision: 1, state: "LICENSED", providerRequestId: `${prefix}-provider-${index}`, sequence: 3, createdAt: now, terminalAt: now });
    paymentIntents.push({ paymentIntentId, purchaseOrderId, providerRequestId: `${prefix}-provider-${index}`, amountMinor: 10_001, currency: "USD", state: "SUCCEEDED", sequence: 2, createdAt: now, resolvedAt: now });
    fraudAssessments.push({ assessmentId, purchaseOrderId, rulesVersion: 1, score: 0, recommendation: "APPROVE", state: "COMPLETED", createdAt: now, completedAt: now });
    licenses.push({ licenseId, tenantId, purchaseOrderId, editionId: seededEditionId, buyerRef, licenseType: "STREAM", territories: ["US"], rightsRevision: 1, state: "ACTIVE", grantedAt: now, revokedAt: null });
    entitlementGrants.push({ grantId: id(6_000_000 + index), tenantId, licenseId, buyerRef, editionId: seededEditionId, state: "ACTIVE", revision: 1, grantedAt: now, revokedAt: null });
    for (const [offset, accountId, ownerId, accountRole, direction, amountMinor] of [
      [0, id(200), tenantId, "PLATFORM_CLEARING", "DEBIT", 10_001],
      [1, id(201), creatorA, "CREATOR_PAYABLE", "CREDIT", 3_333],
      [2, id(202), creatorB, "CREATOR_PAYABLE", "CREDIT", 3_333],
      [3, id(203), creatorC, "CREATOR_PAYABLE", "CREDIT", 3_335],
    ]) {
      royaltyEntries.push({ royaltyEntryId: id(10_000_000 + index * 4 + offset), postingId, tenantId, royaltyPeriodId: openPeriodId, royaltyAccountId: accountId, ownerId, accountRole, direction, amountMinor, currency: "USD", sourceType: "LICENSE", sourceId: licenseId, createdAt: now });
    }
  }
  return { purchaseOrders, paymentIntents, fraudAssessments, licenses, entitlementGrants, royaltyEntries };
}

function uploadPayload(index, requiredProfileIds = [profileId]) {
  const bytes = bytesFor(index);
  return {
    tenantId, workId, fileName: `asset-${index}.mp4`, mediaType: "video/mp4",
    totalBytes: bytes.length, chunkSize: Math.ceil(bytes.length / 2), contentSha256: sha256(bytes),
    requiredProfileIds,
  };
}

async function prepare(ctx, value = seed()) {
  await ctx.prepare();
  const imported = await ctx.seed(value);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return ctx.startApi();
}

async function createUpload(ctx, baseUrl, index, key = `upload-${index}`, requiredProfileIds = [profileId]) {
  const response = await ctx.mutate(baseUrl, "/api/v1/uploads", key, uploadPayload(index, requiredProfileIds));
  assert.ok([200, 201, 202].includes(response.status), response.text);
  return { response, uploadId: find(response.json, "uploadId"), bytes: bytesFor(index) };
}

async function putChunk(ctx, baseUrl, uploadId, bytes, chunk, key) {
  return ctx.request(baseUrl, `/api/v1/uploads/${uploadId}/chunks/${chunk.chunkNumber}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "content-range": `bytes ${chunk.start}-${chunk.end}/${bytes.length}`,
      "x-chunk-sha256": chunk.sha256,
      "idempotency-key": key,
    },
    raw: chunk.body,
  });
}

async function completeUpload(ctx, baseUrl, uploadId, bytes, key) {
  const response = await ctx.mutate(baseUrl, `/api/v1/uploads/${uploadId}/complete`, key, {
    contentSha256: sha256(bytes),
    chunks: chunksFor(bytes).map(({ chunkNumber, sha256: digest }) => ({ chunkNumber, sha256: digest })),
  });
  assert.ok([200, 201, 202].includes(response.status), response.text);
  return response;
}

async function uploadAll(ctx, baseUrl, index, prefix = `asset-${index}`, requiredProfileIds = [profileId]) {
  const created = await createUpload(ctx, baseUrl, index, `${prefix}-create`, requiredProfileIds);
  for (const chunk of chunksFor(created.bytes)) {
    const response = await putChunk(ctx, baseUrl, created.uploadId, created.bytes, chunk, `${prefix}-chunk-${chunk.chunkNumber}`);
    assert.ok([200, 201, 204].includes(response.status), response.text);
  }
  const complete = await completeUpload(ctx, baseUrl, created.uploadId, created.bytes, `${prefix}-complete`);
  return { ...created, complete, assetId: find(complete.json, "assetId") };
}

async function waitReadyAsset(ctx, baseUrl, assetId, children = []) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const asset = snapshot.resources.blobObjects.find(({ blobId }) => blobId === assetId);
    const clean = snapshot.resources.scanResults.some((item) => item.assetId === assetId && item.verdict === "CLEAN");
    const renditions = snapshot.resources.renditions.filter((item) => item.assetId === assetId && item.state === "READY");
    return asset?.state === "READY" && clean && renditions.length > 0 ? { snapshot, asset, rendition: renditions[0] } : undefined;
  }, { timeoutMs: 120_000, label: "clean transcoded asset", children });
}

async function createReadyDraft(ctx, baseUrl, index) {
  const uploaded = await uploadAll(ctx, baseUrl, index);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const ready = await waitReadyAsset(ctx, baseUrl, uploaded.assetId, workers);
  const draft = await ctx.mutate(baseUrl, "/api/v1/editions", `edition-${index}`, {
    tenantId, workId, title: `Edition ${index}`,
    assets: [{ assetId: uploaded.assetId, renditionId: ready.rendition.renditionId, ordinal: 1 }],
  });
  assert.ok([200, 201].includes(draft.status), draft.text);
  const editionId = find(draft.json, "editionId");
  return { uploaded, ready, editionId, workers };
}

async function createPublishedEdition(ctx, baseUrl, index) {
  const readyDraft = await createReadyDraft(ctx, baseUrl, index);
  const { editionId } = readyDraft;
  const published = await ctx.mutate(baseUrl, `/api/v1/editions/${editionId}/publish`, `publish-${index}`, { expectedRevision: 0 });
  assert.ok([200, 201].includes(published.status), published.text);
  const offer = await ctx.mutate(baseUrl, "/api/v1/license-offers", `offer-${index}`, {
    tenantId, editionId, licenseType: "STREAM", territories: ["US"], priceMinor: 10_001, currency: "USD", termsVersion: 1,
  });
  assert.ok([200, 201].includes(offer.status), offer.text);
  return { ...readyDraft, offerId: find(offer.json, "offerId") };
}

async function createPurchase(ctx, baseUrl, index, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/purchases", options.key ?? `purchase-${index}`, {
    tenantId, buyerRef: options.buyerRef ?? `buyer-${index}`, offerId: options.offerId ?? seededOfferId,
    providerRequestId: options.providerRequestId ?? `provider-${index}`,
    riskContext: options.riskContext ?? { velocity: 1, country: "US", deviceTrust: "KNOWN" },
  });
  assert.ok([200, 201, 202].includes(response.status), response.text);
  return response;
}

async function payAndGrant(ctx, baseUrl, purchase, index, workers = []) {
  const purchaseOrderId = find(purchase.json, "purchaseOrderId");
  const paymentIntentId = find(purchase.json, "paymentIntentId");
  const providerRequestId = find(purchase.json, "providerRequestId") ?? `provider-${index}`;
  const provider = await ctx.mutate(baseUrl, "/api/v1/provider/events", `provider-event-${index}`, {
    providerEventId: `provider-event-${index}`, providerRequestId, kind: "PAYMENT", outcome: "SUCCEEDED", occurredAt: now,
  });
  assert.ok([200, 201, 202].includes(provider.status), provider.text);
  const ownedWorkers = workers.length ? [] : [await ctx.startWorker(), await ctx.startWorker()];
  const children = [...workers, ...ownedWorkers];
  const result = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const order = snapshot.resources.purchaseOrders.find((item) => item.purchaseOrderId === purchaseOrderId);
    const license = snapshot.resources.licenses.find((item) => item.purchaseOrderId === purchaseOrderId);
    const grant = snapshot.resources.entitlementGrants.find((item) => item.licenseId === license?.licenseId);
    return order?.state === "LICENSED" && license?.state === "ACTIVE" && grant?.state === "ACTIVE" ? { snapshot, order, license, grant } : undefined;
  }, { timeoutMs: 120_000, label: "paid license grant", children });
  assert.equal(result.snapshot.resources.paymentIntents.filter((item) => item.paymentIntentId === paymentIntentId).length, 1);
  return result;
}

function assertBalanced(snapshot) {
  for (const postingId of new Set(snapshot.resources.royaltyEntries.map(({ postingId }) => postingId))) {
    const entries = snapshot.resources.royaltyEntries.filter((entry) => entry.postingId === postingId);
    assert.ok(entries.length >= 2, `posting ${postingId} has fewer than two entries`);
    assert.equal(new Set(entries.map(({ currency }) => currency)).size, 1, `mixed currency posting ${postingId}`);
    for (const entry of entries) {
      assert.ok(["DEBIT", "CREDIT"].includes(entry.direction), `invalid direction in posting ${postingId}`);
      assert.ok(Number.isSafeInteger(entry.amountMinor) && entry.amountMinor > 0, `invalid amount in posting ${postingId}`);
    }
    assert.equal(entries.reduce((sum, entry) => sum + (entry.direction === "DEBIT" ? entry.amountMinor : -entry.amountMinor), 0), 0, `unbalanced posting ${postingId}`);
  }
}

function withoutAsOf(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}

function assertRowsPreserved(before, after, key, label) {
  const current = new Map(after.map((row) => [row[key], row]));
  for (const row of before) {
    assert.equal(canonical(current.get(row[key])), canonical(row), `${label} ${row[key]} was rewritten`);
  }
}

function assertPipelineInvariants(snapshot, assetIds, expectedDigests = new Map()) {
  for (const assetId of assetIds) {
    const blobs = snapshot.resources.blobObjects.filter(({ blobId }) => blobId === assetId);
    const scans = snapshot.resources.scanResults.filter((item) => item.assetId === assetId);
    const renditions = snapshot.resources.renditions.filter((item) => item.assetId === assetId);
    assert.equal(blobs.length, 1, `asset ${assetId} must have one blob`);
    assert.equal(blobs[0].state, "READY", `asset ${assetId} is not READY`);
    assert.equal(scans.length, 1, `asset ${assetId} must have one scan result`);
    assert.equal(scans[0].verdict, "CLEAN", `asset ${assetId} is not CLEAN`);
    assert.ok(renditions.length > 0, `asset ${assetId} has no rendition`);
    assert.equal(new Set(renditions.map((item) => `${item.profileId}:${item.profileRevision}`)).size, renditions.length, `asset ${assetId} has duplicate renditions`);
    assert.ok(renditions.every(({ state }) => state === "READY"), `asset ${assetId} has a non-READY rendition`);
    const expected = expectedDigests.get(assetId);
    if (expected) {
      assert.equal(blobs[0].sha256, expected);
      assert.equal(scans[0].contentSha256, expected);
      assert.ok(renditions.every(({ sha256: digest }) => digest === expected));
    }
    const work = snapshot.work.filter(({ aggregateId }) => aggregateId === assetId);
    assert.ok(work.length > 0 && work.every(({ terminal, state }) => terminal && state !== "LEASED"), `asset ${assetId} has undrained or leased work`);
  }
}

function assertCommercialInvariants(snapshot, purchaseOrderIds) {
  const intentsByPurchase = new Map();
  const licensesByPurchase = new Map();
  const grantsByLicense = new Map();
  const postingsByLicense = new Map();
  const append = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
  for (const intent of snapshot.resources.paymentIntents) append(intentsByPurchase, intent.purchaseOrderId, intent);
  for (const license of snapshot.resources.licenses) append(licensesByPurchase, license.purchaseOrderId, license);
  for (const grant of snapshot.resources.entitlementGrants) append(grantsByLicense, grant.licenseId, grant);
  for (const entry of snapshot.resources.royaltyEntries) {
    if (entry.sourceType === "LICENSE") append(postingsByLicense, entry.sourceId, entry.postingId);
  }
  for (const purchaseOrderId of purchaseOrderIds) {
    const intents = intentsByPurchase.get(purchaseOrderId) ?? [];
    const licenses = licensesByPurchase.get(purchaseOrderId) ?? [];
    assert.equal(intents.length, 1, `purchase ${purchaseOrderId} must have one PaymentIntent`);
    assert.ok(licenses.length <= 1, `purchase ${purchaseOrderId} has duplicate Licenses`);
    if (licenses.length === 1) {
      const grants = grantsByLicense.get(licenses[0].licenseId) ?? [];
      const postings = new Set(postingsByLicense.get(licenses[0].licenseId) ?? []);
      assert.equal(grants.length, 1, `purchase ${purchaseOrderId} has duplicate grants`);
      assert.ok(postings.size <= 1, `purchase ${purchaseOrderId} has duplicate royalty postings`);
    }
  }
  assertBalanced(snapshot);
}

async function assertNoTemporaryMedia(ctx) {
  const paths = await readdir(`${ctx.temporary}/managed`, { recursive: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  assert.ok(paths.every((path) => !/(?:^|[./_-])(?:tmp|temp|partial)(?:$|[./_-])/iu.test(path)), `orphan temporary media: ${paths.join(",")}`);
}

function latencySummary(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (fraction) => ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

const spec = {
  label: "CreatorRightsExchange upload acceptance",
  performanceScenarioIds: [
    "multipart-edition-pipeline", "license-checkout-uncertainty", "fraud-review-release",
    "entitlement-read-storm", "royalty-ledger-close", "notification-recovery",
  ],
  seed: async () => seed(),
  path: "/api/v1/uploads",
  payload: (index) => uploadPayload(index),
  conflictPayload: (index) => ({ ...uploadPayload(index), fileName: `conflicting-${index}.mp4` }),
  resource: "uploadSessions",
  identity: (json) => find(json, "uploadId"),
  resourceIdentity: ({ uploadId }) => uploadId,
  workIdentity: (json) => find(json, "assetId") ?? find(json, "uploadId"),
  async verify(ctx, baseUrl, response) {
    const uploadId = find(response.json, "uploadId");
    const bytes = bytesFor(0);
    for (const chunk of chunksFor(bytes)) {
      const part = await putChunk(ctx, baseUrl, uploadId, bytes, chunk, `h03-chunk-${chunk.chunkNumber}`);
      assert.ok([200, 201, 204].includes(part.status), part.text);
    }
    const completed = await completeUpload(ctx, baseUrl, uploadId, bytes, "h03-complete");
    const assetId = find(completed.json, "assetId");
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const ready = await waitReadyAsset(ctx, baseUrl, assetId, workers);
    assert.equal(ready.asset.sha256, sha256(bytes));
    assert.equal(ready.rendition.profileRevision, 1);
  },
  async atomic(ctx, baseUrl) {
    const created = await createUpload(ctx, baseUrl, 40, "h04-upload");
    const chunk = chunksFor(created.bytes)[0];
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.request(baseUrl, `/api/v1/uploads/${created.uploadId}/chunks/1`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-range": `bytes 0-${chunk.end}/${created.bytes.length}`, "x-chunk-sha256": "0".repeat(64), "idempotency-key": "h04-bad-digest" },
      raw: chunk.body,
    });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.uploadChunks.length, before.resources.uploadChunks.length);
    assert.equal(after.resources.blobObjects.length, before.resources.blobObjects.length);
  },
  async contention(ctx, baseUrls) {
    const created = await createUpload(ctx, baseUrls[0], 60, "h06-upload");
    const chunk = chunksFor(created.bytes)[0];
    const responses = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      putChunk(ctx, baseUrls[index % 2], created.uploadId, created.bytes, chunk, "h06-shared-chunk")));
    assert.equal(new Set(responses.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    assert.equal(snapshot.resources.uploadChunks.filter((item) => item.uploadId === created.uploadId && item.chunkNumber === 1).length, 1);
  },
  async prepareWork(ctx, baseUrl) {
    return (await uploadAll(ctx, baseUrl, 70, "h07")).complete;
  },
  async migrationVerify(_ctx, { snapshot }) {
    assert.equal(snapshot.resources.rightsDisputes.length, 0);
    assert.equal(snapshot.resources.licenseHolds.length, 0);
    assert.equal(snapshot.resources.royaltyAdjustments.length, 0);
  },
  manager: {
    async prepare(ctx, baseUrl) {
      const purchase = await createPurchase(ctx, baseUrl, 800);
      const workers = [await ctx.startWorker(), await ctx.startWorker()];
      const granted = await payAndGrant(ctx, baseUrl, purchase, 800, workers);
      return {
        path: "/api/v1/rights-disputes",
        payload: () => ({ tenantId, editionId: seededEditionId, claimantCreatorId: creatorA, reason: "OWNERSHIP_CONFLICT", evidenceRefs: ["evidence://hidden/claim-800"], expectedEditionRevision: 1, licenseId: granted.license.licenseId }),
      };
    },
    async verify(ctx, baseUrl, response) {
      const rightsDisputeId = find(response.json, "rightsDisputeId");
      const hold = await ctx.mutate(baseUrl, "/api/v1/license-holds", "h10-hold", { rightsDisputeId, scope: "EDITION", reason: "PENDING_RIGHTS_REVIEW" });
      assert.ok([200, 201, 202].includes(hold.status), hold.text);
      const licenseHoldId = find(hold.json, "licenseHoldId");
      const resolved = await ctx.mutate(baseUrl, `/api/v1/rights-disputes/${rightsDisputeId}/resolve`, "h10-resolve", { expectedRevision: 1, outcome: "REJECTED", reason: "CLAIM_NOT_SUPPORTED" });
      assert.ok([200, 201, 202].includes(resolved.status), resolved.text);
      const released = await ctx.mutate(baseUrl, `/api/v1/license-holds/${licenseHoldId}/release`, "h10-release", { expectedRevision: 1, reason: "DISPUTE_REJECTED" });
      assert.ok([200, 201, 202].includes(released.status), released.text);
      const snapshot = await ctx.snapshot(baseUrl);
      assert.equal(snapshot.resources.rightsDisputes.find((item) => item.rightsDisputeId === rightsDisputeId)?.state, "REJECTED");
      assert.equal(snapshot.resources.licenseHolds.find((item) => item.licenseHoldId === licenseHoldId)?.state, "RELEASED");
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const rightsDisputeId = find(response.json, "rightsDisputeId");
      const results = await Promise.all([0, 1].map((index) => ctx.mutate(baseUrls[index], "/api/v1/license-holds", `h11-hold-${index}`, { rightsDisputeId, scope: "EDITION", reason: "CONCURRENT_REVIEW" })));
      assert.equal(results.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.equal(results.filter(({ status }) => status === 409).length, 1);
      const snapshot = await ctx.snapshot(baseUrls[0]);
      assert.equal(snapshot.resources.licenseHolds.filter((item) => item.rightsDisputeId === rightsDisputeId && item.state === "ACTIVE").length, 1);
    },
  },
  cases: {
    "H-08": legalNotificationRecovery,
    "H-14": uploadIntegrity,
    "H-15": pipelineFencing,
    "H-16": editionImmutability,
    "H-17": checkoutUncertainty,
    "H-18": fraudReviewRelease,
    "H-19": royaltyConservation,
    "H-20": notificationOrdering,
    "H-21": refundEntitlementFence,
    "H-22": disputeHoldRace,
    "H-23": settledAdjustment,
  },
  performance: performanceScenarios,
};

async function legalNotificationRecovery(ctx, out) {
  const api = await prepare(ctx);
  const purchase = await createPurchase(ctx, api.baseUrl, 80);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const granted = await payAndGrant(ctx, api.baseUrl, purchase, 80, workers);
  assert.ok(granted.snapshot.resources.notifications.length > 0, "License grant emitted no Notification");

  const webhook = await ctx.receiver();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? held : { status: 204 });
  const first = await ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h08" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
    label: "licensed notification response",
    children: [first],
  });
  await ctx.stop(first, "SIGKILL");
  release({ status: 204 });
  const replacement = await ctx.startDispatcher(webhook.url);
  await ctx.waitFor(() => webhook.ledger.length >= 2, { timeoutMs: 60_000, label: "licensed notification retry", children: [replacement] });
  const [firstDelivery, retry] = webhook.ledger;
  const eventHeader = Object.keys(firstDelivery.headers).find((name) => name.endsWith("-event-id"));
  assert.ok(eventHeader, "dispatcher did not publish an event ID");
  assert.equal(firstDelivery.headers[eventHeader], retry.headers[eventHeader]);
  assert.equal(firstDelivery.raw, retry.raw);
  out.push("a real License grant Notification keeps its event identity and byte body after unknown ACK");
}

async function uploadIntegrity(ctx, out) {
  const apiA = await prepare(ctx);
  const apiB = await ctx.startApi();
  const created = await createUpload(ctx, apiA.baseUrl, 140, "h14-upload");
  const [first, second] = chunksFor(created.bytes);
  const accepted = await putChunk(ctx, apiA.baseUrl, created.uploadId, created.bytes, first, "h14-part");
  assert.ok([200, 201, 204].includes(accepted.status), accepted.text);
  const replay = await putChunk(ctx, apiB.baseUrl, created.uploadId, created.bytes, first, "h14-part");
  assert.equal(`${replay.status}:${replay.text}`, `${accepted.status}:${accepted.text}`);
  const afterFirst = await ctx.snapshot(apiA.baseUrl);
  const corrupt = Buffer.from(first.body);
  corrupt[0] ^= 1;
  const rejected = await ctx.request(apiB.baseUrl, `/api/v1/uploads/${created.uploadId}/chunks/1`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "content-range": `bytes 0-${first.end}/${created.bytes.length}`, "x-chunk-sha256": sha256(corrupt), "idempotency-key": "h14-conflict" },
    raw: corrupt,
  });
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal(rejected.json?.error?.code, "CHUNK_CONFLICT");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(apiA.baseUrl)), withoutAsOf(afterFirst));

  const secondAccepted = await putChunk(ctx, apiA.baseUrl, created.uploadId, created.bytes, second, "h14-part-2");
  assert.ok([200, 201, 204].includes(secondAccepted.status), secondAccepted.text);
  const beforeComplete = await ctx.snapshot(apiA.baseUrl);
  const completed = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) =>
    completeUpload(ctx, index % 2 ? apiA.baseUrl : apiB.baseUrl, created.uploadId, created.bytes, "h14-complete"));
  assert.equal(new Set(completed.map(({ status, text }) => `${status}:${text}`)).size, 1);
  const assetId = find(completed[0].json, "assetId");
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  const session = snapshot.resources.uploadSessions.find(({ uploadId }) => uploadId === created.uploadId);
  const blobs = snapshot.resources.blobObjects.filter(({ blobId }) => blobId === assetId);
  assert.equal(session?.state, "COMPLETED");
  assert.equal(snapshot.resources.uploadChunks.filter((item) => item.uploadId === created.uploadId).length, 2);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].sha256, sha256(created.bytes));
  assert.equal(blobs[0].sizeBytes, created.bytes.length);
  assert.equal(snapshot.events.length, beforeComplete.events.length + 1);
  assert.equal(snapshot.work.filter(({ kind, aggregateId }) => kind === "VIRUS_SCAN" && aggregateId === assetId).length, 1);
  await assertNoTemporaryMedia(ctx);
  out.push("64 KiB chunks, exact replay, conflict rollback, and 20-way complete converge on one media digest without orphan temporary files");
}

async function pipelineFencing(ctx, out) {
  const secondProfileId = id(12);
  const value = seed("h15-pipeline");
  value.transcodeProfiles.push({ profileId: secondProfileId, tenantId, revision: 1, name: "archive-copy", operation: "COPY", prefixBase64: null, active: true });
  const api = await prepare(ctx, value);
  const uploaded = await uploadAll(ctx, api.baseUrl, 150, "h15", [profileId, secondProfileId]);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h15" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === uploaded.assetId), { label: "asset pipeline claim", children: [first] });
  const staleToken = barrier.ledger.find((entry) => entry.json?.aggregateId === uploaded.assetId)?.json?.leaseToken;
  assert.equal(typeof staleToken, "string");
  await ctx.stop(first, "SIGKILL");
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const snapshot = await ctx.waitFor(async () => {
    const current = await ctx.snapshot(api.baseUrl);
    const asset = current.resources.blobObjects.find(({ blobId }) => blobId === uploaded.assetId);
    const renditions = current.resources.renditions.filter((item) => item.assetId === uploaded.assetId && item.state === "READY");
    return asset?.state === "READY" && renditions.length === 2 ? current : undefined;
  }, { timeoutMs: 120_000, label: "fenced two-profile pipeline", children: replacements });
  const scanJobs = snapshot.resources.scanJobs.filter((item) => item.assetId === uploaded.assetId);
  const transcodeJobs = snapshot.resources.transcodeJobs.filter((item) => item.assetId === uploaded.assetId);
  assert.equal(scanJobs.length, 1);
  assert.ok(scanJobs[0].attempt >= 2, "replacement did not reclaim the killed scan lease");
  assert.equal(transcodeJobs.length, 2);
  assert.equal(new Set(transcodeJobs.map((item) => `${item.profileId}:${item.profileRevision}`)).size, 2);
  assertPipelineInvariants(snapshot, [uploaded.assetId], new Map([[uploaded.assetId, sha256(uploaded.bytes)]]));
  assert.ok(snapshot.work.filter(({ aggregateId }) => aggregateId === uploaded.assetId).every(({ leaseToken }) => leaseToken !== staleToken));
  out.push("scan/transcode recovery reclaims the killed token and produces one CLEAN result plus one frozen rendition per profile");
}

async function editionImmutability(ctx, out) {
  const apiA = await prepare(ctx);
  const apiB = await ctx.startApi();
  const { editionId } = await createReadyDraft(ctx, apiA.baseUrl, 160);
  const publishes = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) =>
    ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/editions/${editionId}/publish`, `h16-publish-${index}`, { expectedRevision: 0 }));
  assert.equal(publishes.filter(({ status }) => status >= 200 && status < 300).length, 1);
  assert.equal(publishes.filter(({ status }) => status === 409).length, 31);

  const frozen = await ctx.snapshot(apiA.baseUrl);
  const frozenEdition = frozen.resources.editions.find((item) => item.editionId === editionId);
  const frozenAssets = frozen.resources.editionAssets.filter((item) => item.editionId === editionId);
  const frozenRights = frozen.resources.rightsSplits.filter((item) => item.workId === workId && item.revision === frozenEdition.rightsRevision);
  assert.equal(frozenEdition.state, "PUBLISHED");
  assert.match(frozenEdition.manifestDigest, /^[0-9a-f]{64}$/u);
  assert.equal(frozenRights.reduce((sum, item) => sum + item.basisPoints, 0), 10_000);

  const changedRights = await ctx.mutate(apiB.baseUrl, `/api/v1/works/${workId}/rights-splits`, "h16-rights-v2", {
    expectedRevision: 1,
    effectiveFrom: periodEnd,
    splits: [
      { creatorId: creatorA, basisPoints: 6_000 },
      { creatorId: creatorB, basisPoints: 4_000 },
    ],
  });
  assert.ok([200, 201].includes(changedRights.status), changedRights.text);
  const stale = await ctx.mutate(apiA.baseUrl, `/api/v1/editions/${editionId}/publish`, "h16-stale-publish", { expectedRevision: 0 });
  assert.equal(stale.status, 409, stale.text);

  const final = await ctx.snapshot(apiB.baseUrl);
  assert.equal(canonical(final.resources.editions.find((item) => item.editionId === editionId)), canonical(frozenEdition));
  assert.equal(canonical(final.resources.editionAssets.filter((item) => item.editionId === editionId)), canonical(frozenAssets));
  assert.equal(canonical(final.resources.rightsSplits.filter((item) => item.workId === workId && item.revision === frozenEdition.rightsRevision)), canonical(frozenRights));
  assert.equal(final.resources.works.find((item) => item.workId === workId)?.currentRightsRevision, 2);
  out.push("32-way publication freezes one immutable manifest and rights revision while later Work rights advance independently");
}

async function checkoutUncertainty(ctx, out) {
  const apiA = await prepare(ctx);
  const apiB = await ctx.startApi();
  const shield = await ctx.responseShield(apiA.baseUrl);
  shield.dropNextMutation();
  const payload = { tenantId, buyerRef: "h17-buyer", offerId: seededOfferId, providerRequestId: "h17-provider", riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" } };
  await ctx.mutate(shield.baseUrl, "/api/v1/purchases", "h17-purchase", payload).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label: "committed purchase response" });
  const replay = await ctx.mutate(apiA.baseUrl, "/api/v1/purchases", "h17-purchase", payload);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(JSON.parse(shield.captures[0].body)));
  const purchaseReplays = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) =>
    ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/purchases", "h17-purchase", payload));
  assert.equal(new Set(purchaseReplays.map(({ status, text }) => `${status}:${text}`)).size, 1);

  const unknown = await ctx.mutate(apiB.baseUrl, "/api/v1/provider/events", "h17-provider-unknown", {
    providerEventId: "provider-event-unknown-170",
    providerRequestId: "h17-provider",
    kind: "PAYMENT",
    outcome: "UNKNOWN",
    occurredAt: "2026-08-01T00:00:00.000Z",
  });
  assert.ok([200, 201, 202].includes(unknown.status), unknown.text);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const granted = await payAndGrant(ctx, apiA.baseUrl, replay, 170, workers);
  const successEvent = { providerEventId: "provider-event-170", providerRequestId: "h17-provider", kind: "PAYMENT", outcome: "SUCCEEDED", occurredAt: now };
  const duplicateEvents = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) =>
    ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/provider/events", `h17-provider-replay-${index}`, successEvent));
  assert.ok(duplicateEvents.every(({ status }) => [200, 201, 202].includes(status)));
  const stale = await ctx.mutate(apiB.baseUrl, "/api/v1/provider/events", "h17-provider-stale", { providerEventId: "provider-event-stale-170", providerRequestId: "h17-provider", kind: "PAYMENT", outcome: "FAILED", occurredAt: "2026-07-01T00:00:00.000Z" });
  assert.ok([200, 202, 409].includes(stale.status), stale.text);
  const final = await ctx.snapshot(apiB.baseUrl);
  const purchases = final.resources.purchaseOrders.filter(({ providerRequestId }) => providerRequestId === "h17-provider");
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].state, "LICENSED");
  assert.equal(final.resources.paymentIntents.filter(({ providerRequestId }) => providerRequestId === "h17-provider").length, 1);
  assert.equal(final.resources.paymentIntents.find(({ providerRequestId }) => providerRequestId === "h17-provider")?.state, "SUCCEEDED");
  assertCommercialInvariants(final, [granted.order.purchaseOrderId]);
  assert.equal(new Set(final.resources.royaltyEntries.filter((item) => item.sourceId === granted.license.licenseId).map(({ postingId }) => postingId)).size, 1);
  out.push("unknown response, 20-way request/event replay, and out-of-order provider outcomes converge on one paid authority");
}

async function fraudReviewRelease(ctx, out) {
  const apiA = await prepare(ctx);
  const apiB = await ctx.startApi();
  const purchase = await createPurchase(ctx, apiA.baseUrl, 180, { riskContext: { velocity: 99, country: "US", deviceTrust: "NEW" } });
  const purchaseOrderId = find(purchase.json, "purchaseOrderId");
  const worker = await ctx.startWorker();
  const review = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    return snapshot.resources.reviewCases.find((item) => item.purchaseOrderId === purchaseOrderId && item.state === "OPEN");
  }, { label: "fraud review case", children: [worker] });

  const earlyProvider = await ctx.mutate(apiB.baseUrl, "/api/v1/provider/events", "h18-early-payment", {
    providerEventId: "h18-early-payment",
    providerRequestId: "provider-180",
    kind: "PAYMENT",
    outcome: "SUCCEEDED",
    occurredAt: now,
  });
  assert.ok([200, 201, 202].includes(earlyProvider.status), earlyProvider.text);
  const frozen = await ctx.snapshot(apiA.baseUrl);
  assert.equal(frozen.resources.licenses.filter((item) => item.purchaseOrderId === purchaseOrderId).length, 0);
  assert.notEqual(frozen.resources.paymentIntents.find((item) => item.purchaseOrderId === purchaseOrderId)?.state, "SUCCEEDED");

  const claims = await Promise.all([
    ctx.mutate(apiA.baseUrl, `/api/v1/review-cases/${review.reviewCaseId}/claim`, "h18-claim-a", { reviewerId: "reviewer-a", leaseSeconds: 30 }),
    ctx.mutate(apiB.baseUrl, `/api/v1/review-cases/${review.reviewCaseId}/claim`, "h18-claim-b", { reviewerId: "reviewer-b", leaseSeconds: 30 }),
  ]);
  assert.equal(claims.filter(({ status }) => [200, 201].includes(status)).length, 1);
  assert.equal(claims.filter(({ status }) => status === 409).length, 1);
  const claimed = claims.find(({ status }) => [200, 201].includes(status));
  const reviewerId = find(claimed.json, "reviewerId");
  const leaseToken = find(claimed.json, "leaseToken");
  const stale = await ctx.mutate(apiB.baseUrl, `/api/v1/review-cases/${review.reviewCaseId}/decisions`, "h18-stale", {
    reviewerId: reviewerId === "reviewer-a" ? "reviewer-b" : "reviewer-a",
    leaseToken: "stale-review-token",
    outcome: "BLOCK",
    reasonCode: "STALE_REVIEWER",
  });
  assert.equal(stale.status, 409, stale.text);
  const decision = await ctx.mutate(apiA.baseUrl, `/api/v1/review-cases/${review.reviewCaseId}/decisions`, "h18-approve", { reviewerId, leaseToken, outcome: "APPROVE", reasonCode: "VERIFIED_CREATOR" });
  assert.ok([200, 201].includes(decision.status), decision.text);
  const doubleDecision = await ctx.mutate(apiB.baseUrl, `/api/v1/review-cases/${review.reviewCaseId}/decisions`, "h18-block-after-approve", { reviewerId, leaseToken, outcome: "BLOCK", reasonCode: "LATE_BLOCK" });
  assert.equal(doubleDecision.status, 409, doubleDecision.text);
  const granted = await payAndGrant(ctx, apiA.baseUrl, purchase, 180, [worker]);
  const assessment = granted.snapshot.resources.fraudAssessments.find((item) => item.purchaseOrderId === purchaseOrderId);
  const cases = granted.snapshot.resources.reviewCases.filter((item) => item.purchaseOrderId === purchaseOrderId);
  assert.equal(assessment?.rulesVersion, 1);
  assert.equal(assessment?.score, 400);
  assert.equal(assessment?.recommendation, "REVIEW");
  assert.equal(cases.length, 1);
  assert.equal(cases[0].state, "DECIDED");
  assert.equal(cases[0].outcome, "APPROVE");
  out.push("frozen REVIEW authority blocks premature payment and permits only one active reviewer lease and immutable decision");
}

async function royaltyConservation(ctx, out) {
  const api = await prepare(ctx);
  const purchase = await createPurchase(ctx, api.baseUrl, 190);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const granted = await payAndGrant(ctx, api.baseUrl, purchase, 190, workers);
  const originalEntries = granted.snapshot.resources.royaltyEntries.filter((item) => item.sourceType === "LICENSE" && item.sourceId === granted.license.licenseId);
  const creatorCredits = originalEntries.filter((item) => item.accountRole === "CREATOR_PAYABLE" && item.direction === "CREDIT");
  assert.equal(creatorCredits.reduce((sum, item) => sum + item.amountMinor, 0), 10_001);
  assert.equal(creatorCredits.find((item) => item.ownerId === creatorA)?.amountMinor, 3_333);
  assert.equal(creatorCredits.find((item) => item.ownerId === creatorB)?.amountMinor, 3_333);
  assert.equal(creatorCredits.find((item) => item.ownerId === creatorC)?.amountMinor, 3_335);
  assertBalanced(granted.snapshot);

  const providerReplay = await ctx.mutate(api.baseUrl, "/api/v1/provider/events", "h19-payment-replay", {
    providerEventId: "provider-event-190",
    providerRequestId: "provider-190",
    kind: "PAYMENT",
    outcome: "SUCCEEDED",
    occurredAt: now,
  });
  assert.ok([200, 201, 202].includes(providerReplay.status), providerReplay.text);
  const afterReplay = await ctx.snapshot(api.baseUrl);
  assert.equal(canonical(afterReplay.resources.royaltyEntries.filter((item) => item.sourceId === granted.license.licenseId)), canonical(originalEntries));

  const refund = await ctx.mutate(api.baseUrl, `/api/v1/licenses/${granted.license.licenseId}/refunds`, "h19-refund", {
    amountMinor: 1_001,
    reason: "PARTIAL_RIGHTS_RETURN",
    providerRequestId: "h19-refund-provider",
  });
  assert.ok([200, 201, 202].includes(refund.status), refund.text);
  const refundId = find(refund.json, "refundId");
  const refundEvent = await ctx.mutate(api.baseUrl, "/api/v1/provider/events", "h19-refund-success", {
    providerEventId: "h19-refund-success",
    providerRequestId: "h19-refund-provider",
    kind: "REFUND",
    outcome: "SUCCEEDED",
    occurredAt: now,
  });
  assert.ok([200, 201, 202].includes(refundEvent.status), refundEvent.text);
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.refunds.find((item) => item.refundId === refundId)?.state === "SUCCEEDED" ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "royalty refund reversal", children: workers });
  const reversal = final.resources.royaltyEntries.filter((item) => item.sourceType === "REFUND" && item.sourceId === refundId);
  assert.ok(reversal.length >= 2);
  assert.equal(new Set(reversal.map(({ postingId }) => postingId)).size, 1);
  assert.equal(reversal.filter(({ direction }) => direction === "DEBIT").reduce((sum, item) => sum + item.amountMinor, 0), 1_001);
  assertRowsPreserved(originalEntries, final.resources.royaltyEntries, "royaltyEntryId", "original RoyaltyEntry");
  assertBalanced(final);

  const period = await ctx.request(api.baseUrl, `/api/v1/royalty-periods/${openPeriodId}`);
  assert.equal(period.status, 200, period.text);
  assert.equal(find(period.json, "entryCount"), final.resources.royaltyEntries.filter((item) => item.royaltyPeriodId === openPeriodId).length);
  const validSources = new Set([...final.resources.licenses.map(({ licenseId }) => licenseId), ...final.resources.refunds.map(({ refundId: value }) => value)]);
  assert.ok(final.resources.royaltyEntries.every(({ sourceId }) => validSources.has(sourceId)), "orphan royalty source lineage");
  out.push("10,001 allocation, exact replay, partial refund reversal, period query, and source lineage conserve every minor unit");
}

async function notificationOrdering(ctx, out) {
  const api = await prepare(ctx);
  const purchase = await createPurchase(ctx, api.baseUrl, 200, { buyerRef: "h20-buyer" });
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const granted = await payAndGrant(ctx, api.baseUrl, purchase, 200, workers);
  const afterGrant = await ctx.snapshot(api.baseUrl);
  const refund = await ctx.mutate(api.baseUrl, `/api/v1/licenses/${granted.license.licenseId}/refunds`, "h20-refund", {
    amountMinor: 1,
    reason: "ORDERING_PROBE",
    providerRequestId: "h20-refund-provider",
  });
  assert.ok([200, 201, 202].includes(refund.status), refund.text);
  const refundId = find(refund.json, "refundId");
  const refundEvent = await ctx.mutate(api.baseUrl, "/api/v1/provider/events", "h20-refund-success", {
    providerEventId: "h20-refund-success",
    providerRequestId: "h20-refund-provider",
    kind: "REFUND",
    outcome: "SUCCEEDED",
    occurredAt: now,
  });
  assert.ok([200, 201, 202].includes(refundEvent.status), refundEvent.text);
  const queued = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const completed = snapshot.resources.refunds.find((item) => item.refundId === refundId)?.state === "SUCCEEDED";
    return completed && snapshot.resources.notifications.length > afterGrant.resources.notifications.length ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "second ordered License notification", children: workers });
  const aggregateCounts = new Map();
  for (const notification of queued.resources.notifications) {
    const key = `${notification.aggregateType}:${notification.aggregateId}`;
    aggregateCounts.set(key, (aggregateCounts.get(key) ?? 0) + 1);
  }
  assert.ok([...aggregateCounts.values()].some((count) => count >= 2), "grant and refund produced no shared ordered aggregate");

  const webhook = await ctx.receiver();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? held : { status: 204 });
  const first = await ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h20" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), { label: "notification response", children: [first] });
  await ctx.stop(first, "SIGKILL");
  release({ status: 204 });
  const replacement = await ctx.startDispatcher(webhook.url);
  const delivered = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.notifications.every(({ state }) => state === "DELIVERED") ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "ordered notification drain", children: [replacement] });
  await ctx.waitFor(() => webhook.ledger.length >= delivered.resources.notifications.length + 1, { label: "unknown ACK retry ledger", children: [replacement] });

  const eventHeader = Object.keys(webhook.ledger[0].headers).find((key) => key.endsWith("-event-id"));
  assert.ok(eventHeader);
  assert.equal(webhook.ledger[0].headers[eventHeader], webhook.ledger[1].headers[eventHeader]);
  assert.equal(webhook.ledger[0].raw, webhook.ledger[1].raw);
  const notificationById = new Map(delivered.resources.notifications.map((item) => [item.notificationId, item]));
  const deliveryByEvent = new Map(delivered.resources.deliveries.map((item) => [item.eventId, item]));
  const seenByAggregate = new Map();
  const bodiesByEvent = new Map();
  for (const entry of webhook.ledger) {
    const header = Object.keys(entry.headers).find((key) => key.endsWith("-event-id"));
    assert.ok(header);
    const eventId = entry.headers[header];
    const notification = notificationById.get(deliveryByEvent.get(eventId)?.notificationId);
    assert.ok(notification, `unknown delivery event ${eventId}`);
    const key = `${notification.aggregateType}:${notification.aggregateId}`;
    const sequence = Number(notification.sequence);
    const seen = seenByAggregate.get(key) ?? [];
    seen.push(sequence);
    seenByAggregate.set(key, seen);
    const priorBody = bodiesByEvent.get(eventId);
    if (priorBody !== undefined) assert.equal(entry.raw, priorBody);
    bodiesByEvent.set(eventId, entry.raw);
    assert.doesNotMatch(entry.raw, /riskContext|contentBase64|payoutCurrency|providerRequestId|providerEventId/iu);
  }
  for (const sequences of seenByAggregate.values()) {
    let highest = 0;
    for (const sequence of sequences) {
      assert.ok(sequence === highest || sequence === highest + 1, `aggregate sequence skipped or reordered: ${sequences.join(",")}`);
      highest = Math.max(highest, sequence);
    }
  }
  assert.ok([...seenByAggregate.values()].some((sequences) => new Set(sequences).size >= 2));
  out.push("grant/refund notifications block later aggregate sequence behind an unknown ACK and retry exact public bytes");
}

async function refundEntitlementFence(ctx, out) {
  const apiA = await prepare(ctx);
  const apiB = await ctx.startApi();
  const purchase = await createPurchase(ctx, apiA.baseUrl, 210, { buyerRef: "h21-buyer" });
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const granted = await payAndGrant(ctx, apiA.baseUrl, purchase, 210, workers);

  let fenceVisible = false;
  let stopReaders = false;
  let postFenceReads = 0;
  const falseAllows = [];
  const readers = Promise.all(Array.from({ length: 64 }, async (_, index) => {
    while (!stopReaders) {
      const startedAfterFence = fenceVisible;
      const response = await ctx.request(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&buyerRef=h21-buyer&editionId=${seededEditionId}`);
      assert.equal(response.status, 200, response.text);
      if (startedAfterFence) {
        postFenceReads += 1;
        if (response.json?.allowed !== false) falseAllows.push(response.json);
      }
    }
  }));

  const refunds = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) =>
    ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/licenses/${granted.license.licenseId}/refunds`, `h21-refund-${index}`, {
      amountMinor: 10_001,
      reason: "CUSTOMER_REQUEST",
      providerRequestId: `h21-refund-provider-${index}`,
    }));
  assert.equal(refunds.filter(({ status }) => [200, 201, 202].includes(status)).length, 1);
  assert.equal(refunds.filter(({ status }) => status === 409).length, 31);
  const accepted = refunds.find(({ status }) => [200, 201, 202].includes(status));
  const refundProviderRequestId = find(accepted.json, "providerRequestId");
  const refundId = find(accepted.json, "refundId");
  const provider = await ctx.mutate(apiB.baseUrl, "/api/v1/provider/events", "h21-refund-success", {
    providerEventId: "h21-refund-success",
    providerRequestId: refundProviderRequestId,
    kind: "REFUND",
    outcome: "SUCCEEDED",
    occurredAt: now,
  });
  assert.ok([200, 201, 202].includes(provider.status), provider.text);
  const revoked = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const grant = snapshot.resources.entitlementGrants.find((item) => item.licenseId === granted.license.licenseId);
    return grant?.state === "REVOKED" ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "refund entitlement revocation", children: workers });
  fenceVisible = true;
  const checks = await ctx.concurrent(Array.from({ length: 64 }), 64, (_, index) =>
    ctx.request(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&buyerRef=h21-buyer&editionId=${seededEditionId}`));
  assert.ok(checks.every(({ status, json }) => status === 200 && json?.allowed === false));
  stopReaders = true;
  await readers;
  assert.ok(postFenceReads > 0);
  assert.equal(falseAllows.length, 0);

  const late = await ctx.mutate(apiA.baseUrl, "/api/v1/provider/events", "h21-late-failed", {
    providerEventId: "h21-late-failed",
    providerRequestId: refundProviderRequestId,
    kind: "REFUND",
    outcome: "FAILED",
    occurredAt: "2026-07-01T00:00:00.000Z",
  });
  assert.ok([200, 202, 409].includes(late.status), late.text);
  const final = await ctx.snapshot(apiB.baseUrl);
  assert.equal(final.resources.licenses.find((item) => item.licenseId === granted.license.licenseId)?.state, "REVOKED");
  assert.equal(final.resources.entitlementGrants.filter((item) => item.licenseId === granted.license.licenseId).length, 1);
  assert.equal(final.resources.entitlementGrants.find((item) => item.licenseId === granted.license.licenseId)?.state, "REVOKED");
  assert.equal(final.resources.refunds.filter((item) => item.licenseId === granted.license.licenseId && item.state === "SUCCEEDED").reduce((sum, item) => sum + item.amountMinor, 0), 10_001);
  assert.equal(new Set(final.resources.royaltyEntries.filter((item) => item.sourceType === "REFUND" && item.sourceId === refundId).map(({ postingId }) => postingId)).size, 1);
  assertBalanced(final);
  out.push("64 live readers, 32 competing full refunds, revocation commit, and late provider events preserve one no-access fence");
}

async function disputeHoldRace(ctx, out) {
  const apiA = await prepare(ctx);
  const apiB = await ctx.startApi();
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const existingPurchase = await createPurchase(ctx, apiA.baseUrl, 220, { buyerRef: "h22-existing" });
  const existing = await payAndGrant(ctx, apiA.baseUrl, existingPurchase, 220, workers);
  const pendingPurchase = await createPurchase(ctx, apiB.baseUrl, 221, { buyerRef: "h22-inflight" });
  const pendingOrderId = find(pendingPurchase.json, "purchaseOrderId");
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const assessment = snapshot.resources.fraudAssessments.find((item) => item.purchaseOrderId === pendingOrderId);
    return assessment?.state === "COMPLETED" && assessment.recommendation === "APPROVE" ? snapshot : undefined;
  }, { label: "in-flight purchase risk approval", children: workers });

  const dispute = await ctx.mutate(apiA.baseUrl, "/api/v1/rights-disputes", "h22-dispute", { tenantId, editionId: seededEditionId, claimantCreatorId: creatorA, reason: "OWNERSHIP_CONFLICT", evidenceRefs: ["evidence://hidden/h22"], expectedEditionRevision: 1 });
  assert.ok([200, 201, 202].includes(dispute.status), dispute.text);
  const rightsDisputeId = find(dispute.json, "rightsDisputeId");

  const holdRequests = ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) =>
    ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/license-holds", `h22-hold-${index}`, { rightsDisputeId, scope: "EDITION", reason: "RIGHTS_REVIEW" }));
  const payment = ctx.mutate(apiB.baseUrl, "/api/v1/provider/events", "h22-inflight-payment", {
    providerEventId: "h22-inflight-payment",
    providerRequestId: "provider-221",
    kind: "PAYMENT",
    outcome: "SUCCEEDED",
    occurredAt: now,
  });
  const racingPurchases = ctx.concurrent(Array.from({ length: 16 }), 16, (_, index) =>
    ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/purchases", `h22-racing-purchase-${index}`, {
      tenantId,
      buyerRef: `h22-racer-${index}`,
      offerId: seededOfferId,
      providerRequestId: `h22-racing-provider-${index}`,
      riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" },
    }));
  const [results, paymentResult, purchases] = await Promise.all([holdRequests, payment, racingPurchases]);
  assert.equal(results.filter(({ status }) => status >= 200 && status < 300).length, 1);
  assert.equal(results.filter(({ status }) => status === 409).length, 31);
  assert.ok([200, 201, 202].includes(paymentResult.status), paymentResult.text);
  assert.ok(purchases.every(({ status }) => [200, 201, 202, 409].includes(status)));

  const held = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const activeHold = snapshot.resources.licenseHolds.find((item) => item.rightsDisputeId === rightsDisputeId && item.state === "ACTIVE");
    const existingLicense = snapshot.resources.licenses.find((item) => item.licenseId === existing.license.licenseId);
    return activeHold && existingLicense?.state === "HELD" ? { snapshot, activeHold } : undefined;
  }, { timeoutMs: 120_000, label: "Edition Hold authority fence", children: workers });
  assert.equal(held.snapshot.resources.licenseHolds.filter((item) => item.rightsDisputeId === rightsDisputeId && item.state === "ACTIVE").length, 1);
  const heldCheck = await ctx.request(apiB.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&buyerRef=h22-existing&editionId=${seededEditionId}`);
  assert.equal(heldCheck.status, 200);
  assert.equal(heldCheck.json?.allowed, false);

  const blocked = await ctx.mutate(apiA.baseUrl, "/api/v1/purchases", "h22-blocked-purchase", {
    tenantId, buyerRef: "h22-buyer", offerId: seededOfferId, providerRequestId: "h22-provider",
    riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" },
  });
  assert.equal(blocked.status, 409);
  const heldPending = await ctx.snapshot(apiA.baseUrl);
  const pendingLicense = heldPending.resources.licenses.find((item) => item.purchaseOrderId === pendingOrderId);
  assert.ok(!pendingLicense || pendingLicense.state === "HELD");
  if (!pendingLicense) assert.equal(heldPending.resources.purchaseOrders.find((item) => item.purchaseOrderId === pendingOrderId)?.state, "LICENSE_HELD");

  const refund = await ctx.mutate(apiA.baseUrl, `/api/v1/licenses/${existing.license.licenseId}/refunds`, "h22-refund", {
    amountMinor: 10_001,
    reason: "DISPUTED_LICENSE",
    providerRequestId: "h22-refund-provider",
  });
  assert.ok([200, 201, 202].includes(refund.status), refund.text);
  const resolved = await ctx.mutate(apiA.baseUrl, `/api/v1/rights-disputes/${rightsDisputeId}/resolve`, "h22-resolve", {
    expectedRevision: 1,
    outcome: "REJECTED",
    reason: "CLAIM_NOT_SUPPORTED",
  });
  assert.ok([200, 201, 202].includes(resolved.status), resolved.text);
  const [released, refundResult] = await Promise.all([
    ctx.mutate(apiB.baseUrl, `/api/v1/license-holds/${held.activeHold.licenseHoldId}/release`, "h22-release", { expectedRevision: 1, reason: "DISPUTE_REJECTED" }),
    ctx.mutate(apiA.baseUrl, "/api/v1/provider/events", "h22-refund-success", {
      providerEventId: "h22-refund-success",
      providerRequestId: "h22-refund-provider",
      kind: "REFUND",
      outcome: "SUCCEEDED",
      occurredAt: now,
    }),
  ]);
  assert.ok([200, 201, 202].includes(released.status), released.text);
  assert.ok([200, 201, 202].includes(refundResult.status), refundResult.text);
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const hold = snapshot.resources.licenseHolds.find((item) => item.licenseHoldId === held.activeHold.licenseHoldId);
    const license = snapshot.resources.licenses.find((item) => item.licenseId === existing.license.licenseId);
    return hold?.state === "RELEASED" && license?.state === "REVOKED" ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "Hold release and refund convergence", children: workers });
  const finalCheck = await ctx.request(apiB.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&buyerRef=h22-existing&editionId=${seededEditionId}`);
  assert.equal(finalCheck.status, 200);
  assert.equal(finalCheck.json?.allowed, false);
  assert.ok(final.resources.licenses.filter((item) => item.purchaseOrderId === pendingOrderId).length <= 1);
  assertBalanced(final);
  out.push("Edition Hold linearizes 32-way creation with purchase/payment/grant and release/refund races across two APIs");
}

async function settledAdjustment(ctx, out) {
  const apiA = await prepare(ctx);
  const apiB = await ctx.startApi();
  const purchase = await createPurchase(ctx, apiA.baseUrl, 230);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const granted = await payAndGrant(ctx, apiA.baseUrl, purchase, 230, workers);
  const closePayload = { tenantId, currency: "USD", periodStart: now, periodEnd };
  const close = await ctx.mutate(apiA.baseUrl, "/api/v1/royalty-periods", "h23-close", closePayload);
  assert.ok([200, 201, 202].includes(close.status), close.text);
  const royaltyPeriodId = find(close.json, "royaltyPeriodId") ?? openPeriodId;
  const closed = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const period = snapshot.resources.royaltyPeriods.find((item) => item.royaltyPeriodId === royaltyPeriodId);
    return period?.state === "CLOSED" ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "royalty close", children: workers });
  const closeReplay = await ctx.mutate(apiB.baseUrl, "/api/v1/royalty-periods", "h23-close", closePayload);
  assert.equal(`${closeReplay.status}:${closeReplay.text}`, `${close.status}:${close.text}`);
  const originalEntries = closed.resources.royaltyEntries.filter((item) => item.sourceId === granted.license.licenseId);
  const original = originalEntries.find((item) => item.direction === "CREDIT");
  const frozenPeriod = closed.resources.royaltyPeriods.find((item) => item.royaltyPeriodId === royaltyPeriodId);
  assert.match(frozenPeriod.snapshotDigest, /^[0-9a-f]{64}$/u);
  const frozenEvents = closed.events;
  const frozenNotifications = closed.resources.notifications;
  const payload = { tenantId, originalPostingId: original.postingId, amountMinor: -1, currency: "USD", reason: "SETTLED_RIGHTS_CORRECTION", targetPeriodStart: periodEnd };
  const adjustments = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) =>
    ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/royalty-adjustments", `h23-adjustment-${index}`, payload));
  assert.ok(adjustments.some(({ status }) => [200, 201, 202].includes(status)));
  assert.ok(adjustments.every(({ status }) => [200, 201, 202, 409].includes(status)));
  const final = await ctx.snapshot(apiA.baseUrl);
  const created = final.resources.royaltyAdjustments.filter((item) =>
    item.originalPostingId === original.postingId &&
    item.amountMinor === -1 &&
    item.reason === "SETTLED_RIGHTS_CORRECTION");
  assert.equal(created.length, 1);
  const newEntries = final.resources.royaltyEntries.filter((item) => item.postingId === created[0].adjustmentPostingId);
  assert.ok(newEntries.length >= 2);
  assert.equal(new Set(newEntries.map(({ postingId }) => postingId)).size, 1);
  assert.equal(canonical(final.resources.royaltyPeriods.find((item) => item.royaltyPeriodId === royaltyPeriodId)), canonical(frozenPeriod));
  const targetPeriod = final.resources.royaltyPeriods.find((item) => item.royaltyPeriodId === created[0].targetRoyaltyPeriodId);
  assert.equal(targetPeriod?.state, "OPEN");
  assert.equal(targetPeriod?.periodStart, periodEnd);
  assertRowsPreserved(originalEntries, final.resources.royaltyEntries, "royaltyEntryId", "closed RoyaltyEntry");
  assertRowsPreserved(frozenEvents, final.events, "eventId", "historical Event");
  assertRowsPreserved(frozenNotifications, final.resources.notifications, "notificationId", "historical Notification");
  assertBalanced(final);

  const rejectWithoutMutation = async (key, rejectedPayload) => {
    const before = await ctx.snapshot(apiA.baseUrl);
    const response = await ctx.mutate(apiB.baseUrl, "/api/v1/royalty-adjustments", key, rejectedPayload);
    assert.ok([400, 404, 409].includes(response.status), response.text);
    assert.deepEqual(withoutAsOf(await ctx.snapshot(apiA.baseUrl)), withoutAsOf(before));
  };
  await rejectWithoutMutation("h23-open-source", {
    ...payload,
    originalPostingId: created[0].adjustmentPostingId,
    amountMinor: 1,
    reason: "OPEN_PERIOD_SOURCE",
    targetPeriodStart: "2026-10-01T00:00:00.000Z",
  });
  await rejectWithoutMutation("h23-over-balance", { ...payload, amountMinor: -10_002, reason: "OVER_BALANCE" });
  await rejectWithoutMutation("h23-currency", { ...payload, currency: "EUR", reason: "CURRENCY_MISMATCH" });
  await rejectWithoutMutation("h23-tenant", { ...payload, tenantId: id(999), reason: "TENANT_MISMATCH" });
  out.push("32-way settled correction creates one balanced next-period posting while closed facts and four rejection boundaries stay immutable");
}

async function performanceScenarios(ctx, assertions) {
  const scale = performanceScale();
  const count = (full, floor = 1) => Math.max(floor, Math.round(full * scale));
  const metrics = [];

  let api = await prepare(ctx, seed("perf-pipeline"));
  const workers = [await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker()];
  const pipelineCount = count(240, 12);
  const pipelineStarted = performance.now();
  const pipelineLatencies = [];
  const assets = await ctx.concurrent(Array.from({ length: pipelineCount }), 32, async (_, index) => {
    const started = performance.now();
    const uploaded = await uploadAll(ctx, api.baseUrl, 10_000 + index, `perf-pipeline-${index}`);
    await waitReadyAsset(ctx, api.baseUrl, uploaded.assetId, workers);
    pipelineLatencies.push(performance.now() - started);
    return uploaded.assetId;
  });
  const pipelineDurationMs = performance.now() - pipelineStarted;
  const pipelineSnapshot = await ctx.snapshot(api.baseUrl);
  const pipelineDigests = new Map(assets.map((assetId, index) => [assetId, sha256(bytesFor(10_000 + index))]));
  assertPipelineInvariants(pipelineSnapshot, assets, pipelineDigests);
  await assertNoTemporaryMedia(ctx);
  const pipelineRssBytes = [await ctx.rssBytes(api), ...await Promise.all(workers.map((worker) => ctx.rssBytes(worker)))];
  assert.ok(pipelineRssBytes.every((rss) => rss < 768 * 1024 * 1024), `pipeline process RSS ${pipelineRssBytes.join(",")}`);
  assert.ok(pipelineCount / (pipelineDurationMs / 60_000) >= 20, `multipart-edition-pipeline ${pipelineCount} in ${pipelineDurationMs}ms`);
  metrics.push({
    scenarioId: "multipart-edition-pipeline",
    fixture: { assets: pipelineCount, bytesPerAsset: bytesFor(0).length, chunksPerAsset: 2 },
    concurrency: 32,
    workers: 4,
    completed: pipelineCount,
    durationMs: pipelineDurationMs,
    throughput: pipelineCount / (pipelineDurationMs / 60_000),
    throughputUnit: "assets/minute",
    statuses: { READY: assets.length },
    ...latencySummary(pipelineLatencies),
    rssBytes: pipelineRssBytes,
    postLoad: { blobs: assets.length, cleanResults: assets.length, renditions: assets.length, orphanTemporaryFiles: 0, staleLeases: 0 },
  });
  assertions.push(`multipart-edition-pipeline completed ${pipelineCount} clean renditions in ${pipelineDurationMs.toFixed(0)}ms`);

  await ctx.resetDatabase();
  api = await prepare(ctx, seed("perf-checkout"));
  const checkoutWorkers = [await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker()];
  let checkoutSequence = 0;
  const uncertainProviderRequests = [];
  const checkout = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: ({ measured }) => {
      const index = checkoutSequence++;
      if (measured && index % 10 === 0) uncertainProviderRequests.push(index);
      return ctx.mutate(api.baseUrl, "/api/v1/purchases", `perf-purchase-${index}`, { tenantId, buyerRef: `perf-buyer-${index}`, offerId: seededOfferId, providerRequestId: `perf-provider-${index}`, riskContext: { velocity: 1, country: "US", deviceTrust: "KNOWN" } });
    },
  });
  assert.ok(checkout.throughput >= 150 && checkout.p95 <= 500, `license-checkout-uncertainty ${checkout.throughput}/s p95=${checkout.p95}`);
  assert.deepEqual(Object.keys(checkout.statuses).filter((status) => !["200", "201", "202"].includes(status)), []);
  await ctx.concurrent(uncertainProviderRequests, 64, async (index) => {
    const providerRequestId = `perf-provider-${index}`;
    const unknown = { providerEventId: `perf-unknown-${index}`, providerRequestId, kind: "PAYMENT", outcome: "UNKNOWN", occurredAt: now };
    const success = { providerEventId: `perf-success-${index}`, providerRequestId, kind: "PAYMENT", outcome: "SUCCEEDED", occurredAt: "2026-08-01T00:00:01.000Z" };
    const stale = { providerEventId: `perf-stale-${index}`, providerRequestId, kind: "PAYMENT", outcome: "FAILED", occurredAt: "2026-07-31T23:59:59.000Z" };
    for (const [suffix, payload] of [["unknown", unknown], ["success", success], ["success-replay", success], ["stale", stale]]) {
      const response = await ctx.mutate(api.baseUrl, "/api/v1/provider/events", `perf-${suffix}-${index}`, payload);
      assert.ok([200, 201, 202, 409].includes(response.status), response.text);
    }
  });
  const selectedProviders = new Set(uncertainProviderRequests.map((index) => `perf-provider-${index}`));
  const checkoutFinal = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const succeeded = snapshot.resources.paymentIntents.filter((item) => selectedProviders.has(item.providerRequestId) && item.state === "SUCCEEDED");
    const selectedOrders = new Set(snapshot.resources.purchaseOrders.filter((item) => selectedProviders.has(item.providerRequestId)).map((item) => item.purchaseOrderId));
    const licenses = snapshot.resources.licenses.filter((item) => selectedOrders.has(item.purchaseOrderId));
    return succeeded.length === selectedProviders.size && licenses.length === selectedOrders.size ? snapshot : undefined;
  }, { timeoutMs: 180_000, label: "uncertain checkout convergence", children: checkoutWorkers });
  assert.equal(checkoutFinal.resources.paymentIntents.filter((item) => selectedProviders.has(item.providerRequestId)).length, selectedProviders.size);
  const selectedOrders = new Set(checkoutFinal.resources.purchaseOrders.filter((item) => selectedProviders.has(item.providerRequestId)).map((item) => item.purchaseOrderId));
  assert.equal(checkoutFinal.resources.licenses.filter((item) => selectedOrders.has(item.purchaseOrderId)).length, selectedOrders.size);
  const checkoutPurchaseIds = checkoutFinal.resources.purchaseOrders.map(({ purchaseOrderId }) => purchaseOrderId);
  assertCommercialInvariants(checkoutFinal, checkoutPurchaseIds);
  assert.equal(new Set(checkoutFinal.resources.paymentIntents.map(({ providerRequestId }) => providerRequestId)).size, checkoutFinal.resources.paymentIntents.length);
  assert.ok(checkoutFinal.work.filter(({ kind }) => kind === "FRAUD_ASSESS").every(({ terminal }) => terminal));
  const checkoutRssBytes = [await ctx.rssBytes(api), ...await Promise.all(checkoutWorkers.map((worker) => ctx.rssBytes(worker)))];
  metrics.push({
    scenarioId: "license-checkout-uncertainty",
    fixture: { acceptedPurchases: checkoutPurchaseIds.length, uncertainOutcomes: selectedProviders.size },
    concurrency: 64,
    workers: 4,
    durationMs: 60_000 * scale,
    ...checkout,
    rssBytes: checkoutRssBytes,
    postLoad: {
      paymentIntents: checkoutFinal.resources.paymentIntents.length,
      licenses: checkoutFinal.resources.licenses.length,
      grants: checkoutFinal.resources.entitlementGrants.length,
      duplicateAuthorities: 0,
      unbalancedPostings: 0,
    },
  });
  assertions.push(`license-checkout-uncertainty ${checkout.throughput.toFixed(1)}/s p95 ${checkout.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  api = await prepare(ctx, seed("perf-fraud"));
  const fraudWorkers = [await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker()];
  const reviewCount = count(1_000, 50);
  const reviewsStarted = performance.now();
  await ctx.concurrent(Array.from({ length: reviewCount }), 64, (_, index) => ctx.mutate(api.baseUrl, "/api/v1/purchases", `perf-review-${index}`, { tenantId, buyerRef: `review-buyer-${index}`, offerId: seededOfferId, providerRequestId: `review-provider-${index}`, riskContext: { velocity: 99, country: "US", deviceTrust: "NEW" } }));
  const reviews = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.reviewCases.length >= reviewCount ? snapshot.resources.reviewCases.slice(0, reviewCount) : undefined;
  }, { timeoutMs: 120_000, label: "performance review cases", children: fraudWorkers });
  const reviewLatencies = [];
  const reviewResults = await ctx.concurrent(reviews, 64, async (review, index) => {
    const started = performance.now();
    const reviewerId = `perf-reviewer-${index}`;
    const claim = await ctx.mutate(api.baseUrl, `/api/v1/review-cases/${review.reviewCaseId}/claim`, `perf-review-claim-${index}`, { reviewerId, leaseSeconds: 60 });
    assert.ok([200, 201].includes(claim.status), claim.text);
    const response = await ctx.mutate(api.baseUrl, `/api/v1/review-cases/${review.reviewCaseId}/decisions`, `perf-review-decision-${index}`, { reviewerId, leaseToken: find(claim.json, "leaseToken"), outcome: "APPROVE", reasonCode: "BULK_VERIFIED" });
    reviewLatencies.push(performance.now() - started);
    return response;
  });
  assert.ok(reviewResults.every(({ status }) => [200, 201].includes(status)));
  const decidedReviews = await ctx.snapshot(api.baseUrl);
  assert.equal(decidedReviews.resources.reviewCases.filter((item) => reviews.some((review) => review.reviewCaseId === item.reviewCaseId) && item.state === "DECIDED").length, reviewCount);
  const reviewsDurationMs = performance.now() - reviewsStarted;
  assert.ok(reviewCount / (reviewsDurationMs / 1_000) >= 20, `fraud-review-release ${reviewCount} in ${reviewsDurationMs}ms`);
  metrics.push({ scenarioId: "fraud-review-release", completed: reviewCount, durationMs: reviewsDurationMs, throughput: reviewCount / (reviewsDurationMs / 1_000), workers: 4, statuses: { DECIDED: reviewCount }, ...latencySummary(reviewLatencies) });
  assertions.push(`fraud-review-release handled ${reviewCount} frozen cases in ${reviewsDurationMs.toFixed(0)}ms`);

  const licenseCount = count(20_000, 1_000);
  const entitlementFixture = commercialRows(licenseCount, "entitled");
  await ctx.resetDatabase();
  api = await prepare(ctx, seed("perf-entitlement", entitlementFixture));
  const entitlementApiB = await ctx.startApi();
  const entitlementWorkers = [await ctx.startWorker(), await ctx.startWorker()];
  const revokedCount = count(100, 10);
  const revokedLicenses = entitlementFixture.licenses.slice(0, revokedCount);
  const revocations = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 12_000 * scale));
    await ctx.concurrent(revokedLicenses, 32, async (license, index) => {
      const providerRequestId = `perf-entitlement-refund-${index}`;
      const refund = await ctx.mutate(index % 2 ? api.baseUrl : entitlementApiB.baseUrl, `/api/v1/licenses/${license.licenseId}/refunds`, `perf-entitlement-refund-${index}`, { amountMinor: 10_001, reason: "PERFORMANCE_FENCE", providerRequestId });
      assert.ok([200, 201, 202].includes(refund.status), refund.text);
      const event = await ctx.mutate(index % 2 ? entitlementApiB.baseUrl : api.baseUrl, "/api/v1/provider/events", `perf-entitlement-refund-success-${index}`, { providerEventId: `perf-entitlement-refund-success-${index}`, providerRequestId, kind: "REFUND", outcome: "SUCCEEDED", occurredAt: now });
      assert.ok([200, 201, 202].includes(event.status), event.text);
    });
    return ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(api.baseUrl);
      const selected = new Set(revokedLicenses.map((item) => item.licenseId));
      return snapshot.resources.entitlementGrants.filter((item) => selected.has(item.licenseId) && item.state === "REVOKED").length === selected.size ? snapshot : undefined;
    }, { timeoutMs: 180_000, label: "performance entitlement fences", children: entitlementWorkers });
  })();
  let entitlementSequence = 0;
  const entitlement = await measuredLoad(ctx, {
    concurrency: 128, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: ({ client }) => {
      const index = entitlementSequence++ % licenseCount;
      return ctx.request(client % 2 ? api.baseUrl : entitlementApiB.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&buyerRef=entitled-${index}&editionId=${seededEditionId}`);
    },
  });
  assert.ok(entitlement.throughput >= 2_000 && entitlement.p95 <= 80, `entitlement-read-storm ${entitlement.throughput}/s p95=${entitlement.p95}`);
  await revocations;
  const postFence = await ctx.concurrent(revokedLicenses, 64, (license, index) => ctx.request(index % 2 ? api.baseUrl : entitlementApiB.baseUrl, `/api/v1/entitlements/check?tenantId=${tenantId}&buyerRef=${encodeURIComponent(license.buyerRef)}&editionId=${seededEditionId}`));
  assert.ok(postFence.every(({ status, json }) => status === 200 && json?.allowed === false));
  metrics.push({ scenarioId: "entitlement-read-storm", ...entitlement, revokedFences: revokedCount, postFenceFalseAllows: 0 });
  assertions.push(`entitlement-read-storm ${entitlement.throughput.toFixed(1)}/s p95 ${entitlement.p95.toFixed(1)}ms`);

  const royaltyCount = Math.ceil(count(100_000, 5_000) / 4) * 4;
  const royaltyFixture = commercialRows(Math.ceil(royaltyCount / 4), "royalty-close");
  royaltyFixture.royaltyEntries = royaltyFixture.royaltyEntries.slice(0, royaltyCount);
  await ctx.resetDatabase();
  api = await prepare(ctx, seed("perf-royalty", royaltyFixture));
  const closeStarted = performance.now();
  const close = await ctx.mutate(api.baseUrl, "/api/v1/royalty-periods", "perf-close", { tenantId, currency: "USD", periodStart: now, periodEnd });
  assert.ok([200, 201, 202].includes(close.status), close.text);
  const royaltyPeriodId = find(close.json, "royaltyPeriodId") ?? openPeriodId;
  let releaseClose;
  const heldClose = new Promise((resolve) => { releaseClose = resolve; });
  const closeBarrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? heldClose : { status: 204 });
  const killedCloseWorker = await ctx.startWorker({ TEST_BARRIER_URL: closeBarrier.url, TEST_BARRIER_TOKEN: "perf-close" });
  await ctx.waitFor(() => closeBarrier.ledger.some((entry) => entry.json?.aggregateId === royaltyPeriodId), { timeoutMs: 60_000, label: "royalty close claim", children: [killedCloseWorker] });
  await ctx.stop(killedCloseWorker, "SIGKILL");
  releaseClose({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const closeWorkers = [await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker()];
  const closed = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.royaltyPeriods.find((item) => item.royaltyPeriodId === royaltyPeriodId)?.state === "CLOSED" ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "performance royalty close", children: closeWorkers });
  const closeDurationMs = performance.now() - closeStarted;
  assert.ok(closeDurationMs <= 60_000, `royalty-ledger-close ${closeDurationMs}ms`);
  assertBalanced(closed);
  metrics.push({ scenarioId: "royalty-ledger-close", completed: royaltyCount, durationMs: closeDurationMs, workers: 4, killedWorkers: 1, statuses: { CLOSED: 1 }, p50: closeDurationMs, p95: closeDurationMs, p99: closeDurationMs });
  assertions.push(`royalty-ledger-close froze ${royaltyCount} balanced entries in ${closeDurationMs.toFixed(0)}ms`);

  const notificationCount = count(10_000, 500);
  const notifications = Array.from({ length: notificationCount }, (_, index) => ({ notificationId: id(900_000 + index), tenantId, aggregateType: "LICENSE", aggregateId: id(910_000 + index), sequence: 1, templateKey: "license.granted", payload: { licenseId: id(910_000 + index) }, state: "PENDING", createdAt: now }));
  await ctx.resetDatabase();
  api = await prepare(ctx, seed("perf-notification", { notifications }));
  let deliveryStarted;
  const deliveryArrivalMs = [];
  const webhook = await ctx.receiver(() => {
    deliveryArrivalMs.push(performance.now() - deliveryStarted);
    return { status: 204 };
  });
  let releaseDelivery;
  const heldDelivery = new Promise((resolve) => { releaseDelivery = resolve; });
  const deliveryBarrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? heldDelivery : { status: 204 });
  deliveryStarted = performance.now();
  const killedDispatcher = await ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: deliveryBarrier.url, TEST_BARRIER_TOKEN: "perf-delivery" });
  await ctx.waitFor(() => deliveryBarrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), { timeoutMs: 60_000, label: "notification response barrier", children: [killedDispatcher] });
  await ctx.stop(killedDispatcher, "SIGKILL");
  releaseDelivery({ status: 204 });
  const dispatchers = [await ctx.startDispatcher(webhook.url), await ctx.startDispatcher(webhook.url)];
  await ctx.waitFor(() => new Set(webhook.ledger.map((entry) => Object.entries(entry.headers).find(([name]) => name.endsWith("-event-id"))?.[1]).filter(Boolean)).size >= notificationCount, { timeoutMs: 120_000, label: "performance notification drain", children: dispatchers });
  const deliveryDurationMs = performance.now() - deliveryStarted;
  assert.ok(deliveryDurationMs <= 45_000, `notification-recovery ${deliveryDurationMs}ms`);
  const eventIds = webhook.ledger.map((entry) => Object.entries(entry.headers).find(([name]) => name.endsWith("-event-id"))?.[1]);
  assert.equal(new Set(eventIds).size, notificationCount);
  const duplicated = eventIds.find((eventId, index) => eventIds.indexOf(eventId) !== index);
  assert.ok(duplicated, "unknown ACK did not retry an event identity");
  const duplicateBodies = webhook.ledger.filter((entry) => Object.entries(entry.headers).find(([name]) => name.endsWith("-event-id"))?.[1] === duplicated).map((entry) => entry.raw);
  assert.equal(new Set(duplicateBodies).size, 1);
  metrics.push({ scenarioId: "notification-recovery", completed: notificationCount, durationMs: deliveryDurationMs, dispatchers: 2, killedDispatchers: 1, uniqueEventIds: new Set(eventIds).size, statuses: { DELIVERED: notificationCount, UNKNOWN_ACK_RETRY: 1 }, ...latencySummary(deliveryArrivalMs) });
  assertions.push(`notification-recovery delivered ${notificationCount} stable event identities in ${deliveryDurationMs.toFixed(0)}ms`);

  return { metrics };
}

export default standardAdapter(spec);
