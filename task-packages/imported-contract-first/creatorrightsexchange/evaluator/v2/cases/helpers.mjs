import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

import {
  assertAggregateSequences,
  assertBalancedPosting,
  assertNoSensitiveData,
  assertOpenApiDocument,
  assertPublicError,
  assertRetryIdentity,
  assertRightsDispute,
  assertLicenseHold,
  assertRoyaltyAdjustment,
  assertWork,
  canonicalJson,
  chunkOracle,
  editionManifestDigest,
  exactKeys,
  fraudV1,
  renditionOracle,
  tupleSort,
} from "../oracles/index.mjs";
import { CaseExcluded } from "../lib/execution.mjs";

export const V1_RESOURCE_KEYS = Object.freeze([
  "tenants",
  "creators",
  "works",
  "rightsSplits",
  "uploadSessions",
  "uploadChunks",
  "blobObjects",
  "scanJobs",
  "scanResults",
  "transcodeProfiles",
  "transcodeJobs",
  "renditions",
  "editions",
  "editionAssets",
  "licenseOffers",
  "purchaseOrders",
  "paymentIntents",
  "fraudAssessments",
  "reviewCases",
  "licenses",
  "entitlementGrants",
  "refunds",
  "royaltyAccounts",
  "royaltyEntries",
  "royaltyPeriods",
  "notifications",
  "deliveries",
]);
export const FINAL_RESOURCE_KEYS = Object.freeze([
  ...V1_RESOURCE_KEYS,
  "rightsDisputes",
  "licenseHolds",
  "royaltyAdjustments",
]);

export function defineCase(id, fixtureFamily, action, oracle, seams, run) {
  return Object.freeze({
    id,
    taskId: "creatorrightsexchange",
    fixtureFamily,
    action,
    oracle,
    seams: Object.freeze([...seams]),
    run,
  });
}
export function caseResult(ctx, details = {}, diagnostics = []) {
  return ctx.pass({
    evidence: [
      { taskId: "creatorrightsexchange", caseId: ctx.caseId, ...details },
    ],
    ...(diagnostics.length ? { diagnostics } : {}),
  });
}
export function diagnostic(assertionId, blockedBy) {
  return { assertionId, blockedBy, policy: "fail-closed-diagnostic" };
}

export function findDeep(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeep(item, key);
      if (found !== undefined) return found;
    }
  } else if (value && typeof value === "object") {
    if (Object.hasOwn(value, key)) return value[key];
    for (const item of Object.values(value)) {
      const found = findDeep(item, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function requireStatus(
  ctx,
  response,
  expected,
  label = "request",
  options = {},
) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  ctx.ok(
    statuses.includes(response.status),
    `${label} expected ${statuses.join("/")}, got ${response.status}: ${response.text}`,
    options,
  );
  if (options.json !== false)
    ctx.ok(response.json !== undefined, `${label} returns JSON`, options);
  return response.json;
}
export function expectError(ctx, response, status, code, options = {}) {
  requireStatus(ctx, response, status, code, options);
  ctx.assert(
    `${code} closed public error`,
    () => {
      exactKeys(response.json, ["error"], `${code} envelope`);
      const keys = Object.keys(response.json.error).sort();
      assert.ok(
        keys.length === 2 || keys.length === 3,
        `${code} error field count`,
      );
      assert.deepEqual(
        keys.filter((key) => key !== "details"),
        ["code", "message"],
        `${code} error fields`,
      );
      assert.equal(response.json.error.code, code);
      assert.equal(typeof response.json.error.message, "string");
      if (Object.hasOwn(response.json.error, "details"))
        assert.ok(
          response.json.error.details &&
            typeof response.json.error.details === "object" &&
            !Array.isArray(response.json.error.details),
        );
    },
    options,
  );
  return response;
}
export function expectAnyError(ctx, response, status, options = {}) {
  const statuses = Array.isArray(status) ? status : [status];
  ctx.ok(
    statuses.includes(response.status),
    `${options.label ?? "public error"} expected ${statuses.join("/")}, got ${response.status}: ${response.text}`,
    options,
  );
  ctx.assert(
    options.label ?? `public ${response.status} error`,
    () => assertPublicError(response, response.status),
    options,
  );
  return response;
}
export function resourceFrom(json, idField, envelope) {
  if (
    json &&
    typeof json === "object" &&
    !Array.isArray(json) &&
    Object.hasOwn(json, idField)
  )
    return json;
  const value = json?.[envelope];
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${envelope} response`,
  );
  return value;
}
export function stableSnapshot(snapshot) {
  const copy = structuredClone(snapshot);
  delete copy.asOf;
  return canonicalJson(copy);
}
export function stableResponse(ctx, responses, label, options = {}) {
  ctx.ok(responses.length > 0, `${label} responses`);
  ctx.equal(
    new Set(responses.map(({ status }) => status)).size,
    1,
    `${label} status`,
    options,
  );
  ctx.equal(
    new Set(responses.map(({ text }) => text)).size,
    1,
    `${label} exact body`,
    options,
  );
  return responses[0];
}

export async function prepare(ctx, family, options = {}) {
  if (options.install) await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
  await ctx.migrate({ timeoutMs: 300_000 });
  if (options.migrateTwice) await ctx.migrate({ timeoutMs: 300_000 });
  if (options.build) await ctx.npm("build", [], { timeoutMs: 600_000 });
  if (options.seed !== false)
    await ctx.seed(options.seed ?? family.seed, { timeoutMs: 300_000 });
  const apis = await Promise.all(
    Array.from({ length: options.apiCount ?? 1 }, () =>
      ctx.startApi({ healthTimeoutMs: 60_000 }),
    ),
  );
  const workers = await Promise.all(
    Array.from({ length: options.workerCount ?? 0 }, () =>
      ctx.startWorker(options.workerOptions ?? {}),
    ),
  );
  const dispatchers = await Promise.all(
    Array.from({ length: options.dispatcherCount ?? 0 }, () =>
      ctx.startDispatcher({ webhookUrl: options.webhookUrl }),
    ),
  );
  return { family, apis, api: apis[0], workers, dispatchers };
}

export function assertSnapshot(
  ctx,
  snapshot,
  { final = true, forbidden = [] } = {},
) {
  exactKeys(
    snapshot,
    ["schemaVersion", "asOf", "resources", "work", "events"],
    "verification snapshot",
  );
  assert.equal(snapshot.schemaVersion, 1);
  assert.match(snapshot.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  const expected = final ? FINAL_RESOURCE_KEYS : V1_RESOURCE_KEYS;
  exactKeys(snapshot.resources, expected, "snapshot.resources");
  for (const key of expected)
    assert.ok(Array.isArray(snapshot.resources[key]), `${key} array`);
  assertWork(snapshot.work);
  assertAggregateSequences(snapshot.events);
  assertNoSensitiveData(snapshot, forbidden);
  const sorts = {
    tenants: ["tenantId"],
    creators: ["creatorId"],
    works: ["workId"],
    rightsSplits: ["workId", "revision", "creatorId"],
    uploadSessions: ["uploadId"],
    uploadChunks: ["uploadId", "chunkNumber"],
    blobObjects: ["blobId"],
    scanJobs: ["scanJobId"],
    scanResults: ["scanResultId"],
    transcodeProfiles: ["profileId", "revision"],
    transcodeJobs: ["transcodeJobId"],
    renditions: ["renditionId"],
    editions: ["editionId"],
    editionAssets: ["editionId", "ordinal"],
    licenseOffers: ["offerId"],
    purchaseOrders: ["purchaseOrderId"],
    paymentIntents: ["paymentIntentId"],
    fraudAssessments: ["assessmentId"],
    reviewCases: ["reviewCaseId"],
    licenses: ["licenseId"],
    entitlementGrants: ["grantId"],
    refunds: ["refundId"],
    royaltyAccounts: ["royaltyAccountId"],
    royaltyEntries: ["royaltyEntryId"],
    royaltyPeriods: ["royaltyPeriodId"],
    notifications: ["notificationId"],
    deliveries: ["deliveryId"],
    rightsDisputes: ["rightsDisputeId"],
    licenseHolds: ["licenseHoldId"],
    royaltyAdjustments: ["royaltyAdjustmentId"],
  };
  for (const [key, fields] of Object.entries(sorts))
    if (snapshot.resources[key])
      assert.deepEqual(
        snapshot.resources[key],
        tupleSort(snapshot.resources[key], fields),
        `${key} stable sort`,
      );
  return snapshot;
}
export async function snapshot(ctx, baseUrl, options = {}) {
  const value = await ctx.snapshot(baseUrl, options);
  return assertSnapshot(ctx, value, options);
}
export async function waitSnapshot(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(
    async () => {
      const value = await ctx.snapshot(baseUrl, {
        timeoutMs: options.requestTimeoutMs,
      });
      return predicate(value) ? value : undefined;
    },
    {
      timeoutMs: options.timeoutMs ?? 180_000,
      intervalMs: options.intervalMs ?? 100,
      label: options.label ?? "CreatorRightsExchange durable state",
      processes: options.processes ?? [],
    },
  );
}

export async function mutate(
  ctx,
  baseUrl,
  path,
  label,
  body = {},
  options = {},
) {
  const response = await ctx.mutate(
    baseUrl,
    path,
    options.key ?? ctx.key(label),
    body,
    {
      method: options.method ?? "POST",
      admin: options.admin,
      headers: options.headers,
      timeoutMs: options.timeoutMs,
    },
  );
  if (options.expected)
    requireStatus(
      ctx,
      response,
      options.expected,
      label,
      options.assertionOptions,
    );
  return response;
}
export async function createRightsSplit(
  ctx,
  baseUrl,
  workId,
  body,
  label = "rights",
) {
  return mutate(
    ctx,
    baseUrl,
    `/api/v1/works/${workId}/rights-splits`,
    label,
    body,
    { expected: 200 },
  );
}
export async function createProfile(ctx, baseUrl, body, label = "profile") {
  return mutate(ctx, baseUrl, "/api/v1/transcode-profiles", label, body, {
    expected: 200,
  });
}
export async function createUpload(ctx, baseUrl, body, label = "upload") {
  return mutate(ctx, baseUrl, "/api/v1/uploads", label, body, {
    expected: 200,
  });
}

export async function putChunk(
  ctx,
  baseUrl,
  uploadId,
  chunk,
  label = `chunk-${chunk.chunkNumber}`,
  options = {},
) {
  const response = await ctx.request(
    baseUrl,
    `/api/v1/uploads/${uploadId}/chunks/${chunk.chunkNumber}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "content-range": options.contentRange ?? chunk.contentRange,
        "x-chunk-sha256": options.sha256 ?? chunk.sha256,
        "idempotency-key": options.key ?? ctx.key(label),
      },
      raw: options.bytes ?? chunk.bytes,
      timeoutMs: options.timeoutMs ?? 30_000,
    },
  );
  if (options.expected) requireStatus(ctx, response, options.expected, label);
  return response;
}

export async function uploadAll(ctx, baseUrl, fixture, options = {}) {
  const body = {
    tenantId: fixture.uploadSession.tenantId,
    workId: fixture.uploadSession.workId,
    fileName: fixture.uploadSession.fileName,
    mediaType: fixture.uploadSession.mediaType,
    totalBytes: fixture.uploadSession.totalBytes,
    chunkSize: fixture.uploadSession.chunkSize,
    contentSha256: fixture.uploadSession.contentSha256,
    requiredProfileIds: fixture.uploadSession.requiredProfileIds,
  };
  const created = await createUpload(
    ctx,
    baseUrl,
    body,
    options.label ?? "upload-create",
  );
  const uploadSession = resourceFrom(created.json, "uploadId", "uploadSession");
  const plan = chunkOracle(fixture.media, fixture.chunkSize);
  const ordered = options.arrivalOrder
    ? options.arrivalOrder.map((number) => plan.chunks[number - 1])
    : plan.chunks;
  for (const chunk of ordered)
    requireStatus(
      ctx,
      await putChunk(
        ctx,
        baseUrl,
        uploadSession.uploadId,
        chunk,
        `${options.label ?? "upload"}:${chunk.chunkNumber}`,
      ),
      [200, 201],
      `chunk ${chunk.chunkNumber}`,
    );
  return { created, uploadSession, plan };
}

export async function completeUpload(
  ctx,
  baseUrl,
  uploadId,
  plan,
  label = "upload-complete",
  options = {},
) {
  return mutate(
    ctx,
    baseUrl,
    `/api/v1/uploads/${uploadId}/complete`,
    label,
    {
      contentSha256: plan.sha256,
      chunks: plan.chunks.map(({ chunkNumber, sha256 }) => ({
        chunkNumber,
        sha256,
      })),
    },
    { expected: options.expected ?? 200, key: options.key },
  );
}
export function assetIdFromCompletion(completion, before, after) {
  const direct =
    completion.json?.assetId ??
    completion.json?.asset?.assetId ??
    completion.json?.scanJob?.assetId;
  if (direct) return direct;
  const prior = new Set(
    (before?.resources?.scanJobs ?? []).map(({ assetId }) => assetId),
  );
  const created = after.resources.scanJobs
    .map(({ assetId }) => assetId)
    .filter((assetId) => !prior.has(assetId));
  assert.equal(
    new Set(created).size,
    1,
    "SPEC-GAP-01 opaque asset identity is discoverable through public completion/snapshot",
  );
  return created[0];
}
export async function waitAssetReady(ctx, baseUrl, assetId, options = {}) {
  return ctx.waitFor(
    async () => {
      const detail = await ctx.request(baseUrl, `/api/v1/assets/${assetId}`);
      if (detail.status !== 200) return;
      const renditions = await ctx.request(
        baseUrl,
        `/api/v1/assets/${assetId}/renditions`,
      );
      if (renditions.status !== 200) return;
      const asset = detail.json?.asset ?? detail.json;
      const items =
        renditions.json?.items ??
        renditions.json?.renditions ??
        renditions.json;
      return asset?.state === "READY" &&
        Array.isArray(items) &&
        items.length > 0
        ? { detail, renditions, asset, items }
        : undefined;
    },
    {
      timeoutMs: options.timeoutMs ?? 180_000,
      intervalMs: 100,
      label: options.label ?? `asset ${assetId} READY`,
      processes: options.processes ?? [],
    },
  );
}

export async function createReadyAsset(ctx, baseUrl, family, options = {}) {
  const before = await snapshot(ctx, baseUrl);
  const uploaded = await uploadAll(ctx, baseUrl, family, options);
  const completion = await completeUpload(
    ctx,
    baseUrl,
    uploaded.uploadSession.uploadId,
    uploaded.plan,
    `${options.label ?? "asset"}:complete`,
    { key: options.completeKey },
  );
  const completed = await snapshot(ctx, baseUrl);
  const assetId = assetIdFromCompletion(completion, before, completed);
  const workers = [];
  for (let index = 0; index < (options.workerCount ?? 2); index += 1)
    workers.push(await ctx.startWorker(options.workerOptions ?? {}));
  const ready = await waitAssetReady(ctx, baseUrl, assetId, {
    processes: workers,
    timeoutMs: options.timeoutMs,
    label: `${options.label ?? "asset"} READY`,
  });
  const state = await snapshot(ctx, baseUrl);
  const blob = state.resources.blobObjects.find(
    ({ blobId }) => blobId === assetId,
  );
  const scan = state.resources.scanResults.filter(
    (item) => item.assetId === assetId,
  );
  const renditions = state.resources.renditions.filter(
    (item) => item.assetId === assetId,
  );
  ctx.equal(
    blob?.sha256,
    uploaded.plan.sha256,
    "Blob digest follows uploaded bytes",
    { hardCapIds: ["MEDIA_LINEAGE_ATOMICITY"] },
  );
  ctx.equal(scan.length, 1, "one ScanResult", {
    hardCapIds: ["STALE_WORK_FENCING"],
  });
  ctx.equal(
    scan[0]?.contentSha256,
    uploaded.plan.sha256,
    "Scan digest follows uploaded bytes",
  );
  for (const rendition of renditions) {
    const profile = family.profiles.find(
      ({ profileId, revision }) =>
        profileId === rendition.profileId &&
        revision === rendition.profileRevision,
    );
    const expected = renditionOracle(family.media, profile);
    ctx.equal(
      { sha256: rendition.sha256, sizeBytes: rendition.sizeBytes },
      { sha256: expected.sha256, sizeBytes: expected.sizeBytes },
      "Rendition follows frozen profile",
    );
  }
  return {
    ...uploaded,
    completion,
    assetId,
    ready,
    workers,
    state,
    blob,
    scan: scan[0],
    renditions,
  };
}

export async function createPublishedEditionFlow(
  ctx,
  baseUrl,
  family,
  options = {},
) {
  const asset = await createReadyAsset(ctx, baseUrl, family, options);
  const rendition = asset.renditions[0];
  const draftResponse = await createEdition(
    ctx,
    baseUrl,
    {
      tenantId: family.tenant.tenantId,
      workId: family.work.workId,
      title: options.title ?? `Edition ${ctx.caseId}`,
      assets: [
        {
          assetId: asset.assetId,
          renditionId: rendition.renditionId,
          ordinal: 1,
        },
      ],
    },
    `${options.label ?? "edition"}:draft`,
  );
  const draft = resourceFrom(draftResponse.json, "editionId", "edition");
  const publishedResponse = await publishEdition(
    ctx,
    baseUrl,
    draft.editionId,
    0,
    `${options.label ?? "edition"}:publish`,
  );
  const published = resourceFrom(
    publishedResponse.json,
    "editionId",
    "edition",
  );
  const detail = await ctx.request(
    baseUrl,
    `/api/v1/editions/${published.editionId}`,
  );
  requireStatus(ctx, detail, 200, "Edition detail");
  const edition = detail.json.edition ?? detail.json;
  const assets = detail.json.assets ?? [
    asset.state.resources.editionAssets.find(
      ({ editionId }) => editionId === published.editionId,
    ),
  ];
  ctx.equal(
    edition.manifestDigest,
    editionManifestDigest({ rightsRevision: edition.rightsRevision, assets }),
    "Edition RFC8785 manifest",
    { hardCapIds: ["MEDIA_LINEAGE_ATOMICITY"] },
  );
  return {
    ...asset,
    draft,
    published,
    detail: detail.json,
    edition,
    editionAssets: assets,
  };
}

export async function createEdition(ctx, baseUrl, body, label = "edition") {
  return mutate(ctx, baseUrl, "/api/v1/editions", label, body, {
    expected: 200,
  });
}
export async function publishEdition(
  ctx,
  baseUrl,
  editionId,
  expectedRevision = 0,
  label = "edition-publish",
) {
  return mutate(
    ctx,
    baseUrl,
    `/api/v1/editions/${editionId}/publish`,
    label,
    { expectedRevision },
    { expected: 200 },
  );
}
export async function createOffer(ctx, baseUrl, body, label = "offer") {
  return mutate(ctx, baseUrl, "/api/v1/license-offers", label, body, {
    expected: 200,
  });
}
export async function createPurchase(
  ctx,
  baseUrl,
  body,
  label = "purchase",
  options = {},
) {
  return mutate(ctx, baseUrl, "/api/v1/purchases", label, body, {
    expected: options.expected ?? 200,
    key: options.key,
  });
}
export async function providerEvent(
  ctx,
  baseUrl,
  body,
  label = "provider-event",
  options = {},
) {
  return mutate(ctx, baseUrl, "/api/v1/provider/events", label, body, {
    expected: options.expected ?? 200,
    key: options.key,
  });
}
export async function createRefund(
  ctx,
  baseUrl,
  licenseId,
  body,
  label = "refund",
  options = {},
) {
  return mutate(
    ctx,
    baseUrl,
    `/api/v1/licenses/${licenseId}/refunds`,
    label,
    body,
    { expected: options.expected ?? 200, key: options.key },
  );
}
export async function createDispute(ctx, baseUrl, body, label = "dispute") {
  return mutate(ctx, baseUrl, "/api/v1/rights-disputes", label, body, {
    expected: 200,
  });
}
export async function resolveDispute(
  ctx,
  baseUrl,
  disputeId,
  body,
  label = "resolve-dispute",
) {
  return mutate(
    ctx,
    baseUrl,
    `/api/v1/rights-disputes/${disputeId}/resolve`,
    label,
    body,
    { expected: 200 },
  );
}
export async function createHold(ctx, baseUrl, body, label = "hold") {
  return mutate(ctx, baseUrl, "/api/v1/license-holds", label, body, {
    expected: 200,
  });
}
export async function releaseHold(
  ctx,
  baseUrl,
  holdId,
  body,
  label = "release-hold",
) {
  return mutate(
    ctx,
    baseUrl,
    `/api/v1/license-holds/${holdId}/release`,
    label,
    body,
    { expected: 200 },
  );
}
export async function createAdjustment(
  ctx,
  baseUrl,
  body,
  label = "adjustment",
) {
  return mutate(ctx, baseUrl, "/api/v1/royalty-adjustments", label, body, {
    expected: 200,
  });
}

export async function waitPurchase(
  ctx,
  baseUrl,
  purchaseOrderId,
  predicate,
  options = {},
) {
  return ctx.waitFor(
    async () => {
      const response = await ctx.request(
        baseUrl,
        `/api/v1/purchases/${purchaseOrderId}`,
      );
      if (response.status !== 200) return undefined;
      return predicate(response.json) ? response.json : undefined;
    },
    {
      timeoutMs: options.timeoutMs ?? 180_000,
      intervalMs: 100,
      label: options.label ?? `Purchase ${purchaseOrderId}`,
      processes: options.processes ?? [],
    },
  );
}

export async function createApprovedLicense(
  ctx,
  baseUrl,
  family,
  options = {},
) {
  const body = {
    ...family.purchaseBody,
    buyerRef: options.buyerRef ?? family.purchaseBody.buyerRef,
    providerRequestId:
      options.providerRequestId ?? family.purchaseBody.providerRequestId,
    ...(options.riskContext ? { riskContext: options.riskContext } : {}),
  };
  const purchaseResponse = await createPurchase(
    ctx,
    baseUrl,
    body,
    options.label ?? "approved-purchase",
    { key: options.key },
  );
  exactKeys(
    purchaseResponse.json,
    ["purchaseOrder", "paymentIntent"],
    "Purchase acceptance",
  );
  const workers = [];
  for (let index = 0; index < (options.workerCount ?? 2); index += 1)
    workers.push(await ctx.startWorker(options.workerOptions ?? {}));
  await waitPurchase(
    ctx,
    baseUrl,
    purchaseResponse.json.purchaseOrder.purchaseOrderId,
    (value) => value.fraudAssessment?.state === "COMPLETED",
    { label: "fraud assessment", processes: workers },
  );
  const event = {
    providerEventId:
      options.providerEventId ??
      `event-${ctx.key(`${options.label ?? "approved"}:payment`)}`,
    providerRequestId: body.providerRequestId,
    kind: "PAYMENT",
    outcome: options.outcome ?? "SUCCEEDED",
    occurredAt: options.occurredAt ?? ctx.at(),
  };
  await providerEvent(
    ctx,
    baseUrl,
    event,
    `${options.label ?? "approved"}:provider`,
    { key: options.eventKey },
  );
  if (event.outcome !== "SUCCEEDED")
    return {
      purchaseResponse,
      purchaseOrder: purchaseResponse.json.purchaseOrder,
      paymentIntent: purchaseResponse.json.paymentIntent,
      workers,
      event,
    };
  const state = await waitSnapshot(
    ctx,
    baseUrl,
    (value) => {
      const license = value.resources.licenses.find(
        ({ purchaseOrderId }) =>
          purchaseOrderId ===
          purchaseResponse.json.purchaseOrder.purchaseOrderId,
      );
      const grant = value.resources.entitlementGrants.find(
        ({ licenseId }) => licenseId === license?.licenseId,
      );
      return license?.state === "ACTIVE" && grant?.state === "ACTIVE"
        ? value
        : undefined;
    },
    { label: "atomic License authority", processes: workers },
  );
  const license = state.resources.licenses.find(
    ({ purchaseOrderId }) =>
      purchaseOrderId === purchaseResponse.json.purchaseOrder.purchaseOrderId,
  );
  const grant = state.resources.entitlementGrants.find(
    ({ licenseId }) => licenseId === license.licenseId,
  );
  const posting = state.resources.royaltyEntries.filter(
    ({ sourceType, sourceId }) =>
      sourceType === "LICENSE" && sourceId === license.licenseId,
  );
  ctx.assert("balanced License posting", () => assertBalancedPosting(posting), {
    hardCapIds: ["LICENSE_AUTHORITY_ATOMICITY", "ROYALTY_IMMUTABILITY"],
  });
  return {
    purchaseResponse,
    purchaseOrder: purchaseResponse.json.purchaseOrder,
    paymentIntent: purchaseResponse.json.paymentIntent,
    event,
    workers,
    state,
    license,
    grant,
    posting,
  };
}

export async function createReviewedLicense(
  ctx,
  baseUrl,
  family,
  options = {},
) {
  const body = {
    ...family.purchaseBody,
    buyerRef: options.buyerRef ?? family.purchaseBody.buyerRef,
    providerRequestId:
      options.providerRequestId ?? family.purchaseBody.providerRequestId,
  };
  const purchaseResponse = await createPurchase(
    ctx,
    baseUrl,
    body,
    options.label ?? "review-purchase",
    { key: options.key },
  );
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const reviewState = await waitSnapshot(
    ctx,
    baseUrl,
    (value) =>
      value.resources.reviewCases.find(
        ({ purchaseOrderId, state }) =>
          purchaseOrderId ===
            purchaseResponse.json.purchaseOrder.purchaseOrderId &&
          state === "OPEN",
      )
        ? value
        : undefined,
    { label: "ReviewCase OPEN", processes: workers },
  );
  const review = reviewState.resources.reviewCases.find(
    ({ purchaseOrderId }) =>
      purchaseOrderId === purchaseResponse.json.purchaseOrder.purchaseOrderId,
  );
  const claim = await mutate(
    ctx,
    baseUrl,
    `/api/v1/review-cases/${review.reviewCaseId}/claim`,
    `${options.label ?? "review"}:claim`,
    { reviewerId: options.reviewerId ?? "reviewer-a", leaseSeconds: 30 },
    { expected: 200 },
  );
  const claimed = resourceFrom(claim.json, "reviewCaseId", "reviewCase");
  const decision = await mutate(
    ctx,
    baseUrl,
    `/api/v1/review-cases/${review.reviewCaseId}/decisions`,
    `${options.label ?? "review"}:decision`,
    {
      reviewerId: claimed.reviewerId,
      leaseToken: claimed.leaseToken,
      outcome: options.reviewOutcome ?? "APPROVE",
      reasonCode: "VERIFIED_RIGHTS",
    },
    { expected: 200 },
  );
  if ((options.reviewOutcome ?? "APPROVE") === "BLOCK")
    return {
      purchaseResponse,
      workers,
      review,
      claim: claimed,
      decision: decision.json,
    };
  await providerEvent(
    ctx,
    baseUrl,
    {
      providerEventId: `event-${ctx.key(`${options.label ?? "review"}:payment`)}`,
      providerRequestId: body.providerRequestId,
      kind: "PAYMENT",
      outcome: "SUCCEEDED",
      occurredAt: ctx.at(),
    },
    `${options.label ?? "review"}:provider`,
  );
  const state = await waitSnapshot(
    ctx,
    baseUrl,
    (value) =>
      value.resources.licenses.some(
        ({ purchaseOrderId }) =>
          purchaseOrderId ===
          purchaseResponse.json.purchaseOrder.purchaseOrderId,
      )
        ? value
        : undefined,
    { label: "reviewed License", processes: workers },
  );
  const license = state.resources.licenses.find(
    ({ purchaseOrderId }) =>
      purchaseOrderId === purchaseResponse.json.purchaseOrder.purchaseOrderId,
  );
  return {
    purchaseResponse,
    workers,
    review,
    claim: claimed,
    decision: decision.json,
    state,
    license,
    grant: state.resources.entitlementGrants.find(
      ({ licenseId }) => licenseId === license.licenseId,
    ),
  };
}

export async function completeRefund(ctx, baseUrl, license, options = {}) {
  const providerRequestId =
    options.providerRequestId ??
    `refund-${ctx.key(options.label ?? license.licenseId)}`;
  const response = await createRefund(
    ctx,
    baseUrl,
    license.licenseId,
    {
      amountMinor: options.amountMinor,
      reason: options.reason ?? "CUSTOMER_REQUEST",
      providerRequestId,
    },
    options.label ?? "refund",
    { key: options.key },
  );
  const refund = resourceFrom(response.json, "refundId", "refund");
  await providerEvent(
    ctx,
    baseUrl,
    {
      providerEventId:
        options.providerEventId ??
        `event-${ctx.key(`${options.label ?? "refund"}:success`)}`,
      providerRequestId,
      kind: "REFUND",
      outcome: options.outcome ?? "SUCCEEDED",
      occurredAt: ctx.at(),
    },
    `${options.label ?? "refund"}:provider`,
    { key: options.eventKey },
  );
  const state = await waitSnapshot(
    ctx,
    baseUrl,
    (value) =>
      value.resources.refunds.find(
        ({ refundId }) => refundId === refund.refundId,
      )?.state === (options.outcome ?? "SUCCEEDED")
        ? value
        : undefined,
    {
      label: `${options.label ?? "refund"} authority`,
      processes: options.processes ?? [],
    },
  );
  return { response, refund, state };
}

export async function createDisputeFor(ctx, baseUrl, family, options = {}) {
  const body = {
    tenantId: family.tenant.tenantId,
    editionId: family.edition.editionId,
    claimantCreatorId:
      options.claimantCreatorId ?? family.creators[0].creatorId,
    reason: options.reason ?? "OWNERSHIP_CONFLICT",
    evidenceRefs: options.evidenceRefs ??
      family.evidenceRefs ?? ["evidence:opaque:1"],
    expectedEditionRevision:
      options.expectedEditionRevision ?? family.edition.revision,
    ...(options.licenseId === undefined
      ? {}
      : { licenseId: options.licenseId }),
  };
  const response = await createDispute(
    ctx,
    baseUrl,
    body,
    options.label ?? "dispute",
  );
  exactKeys(response.json, ["rightsDispute"], "RightsDispute response");
  ctx.assert("RightsDispute shape", () =>
    assertRightsDispute(response.json.rightsDispute),
  );
  return { response, body, dispute: response.json.rightsDispute };
}

export async function createHoldFor(ctx, baseUrl, dispute, options = {}) {
  const body = {
    rightsDisputeId: dispute.rightsDisputeId,
    scope: options.scope ?? "EDITION",
    ...(options.licenseId === undefined
      ? {}
      : { licenseId: options.licenseId }),
    reason: options.reason ?? "RIGHTS_REVIEW",
  };
  const response = await createHold(
    ctx,
    baseUrl,
    body,
    options.label ?? "hold",
  );
  exactKeys(response.json, ["licenseHold"], "LicenseHold response");
  ctx.assert("LicenseHold shape", () =>
    assertLicenseHold(response.json.licenseHold),
  );
  return { response, body, hold: response.json.licenseHold };
}

export async function createAdjustmentFor(ctx, baseUrl, family, options = {}) {
  const body = {
    tenantId: family.tenant.tenantId,
    ...(options.rightsDisputeId === undefined
      ? {}
      : { rightsDisputeId: options.rightsDisputeId }),
    originalPostingId: options.originalPostingId ?? family.postingId,
    amountMinor: options.amountMinor ?? 3_335,
    currency: options.currency ?? "USD",
    reason: options.reason ?? "RIGHTS_CORRECTION",
    targetPeriodStart: options.targetPeriodStart ?? ctx.at({ days: 2 }),
  };
  const response = await createAdjustment(
    ctx,
    baseUrl,
    body,
    options.label ?? "adjustment",
  );
  exactKeys(
    response.json,
    ["royaltyAdjustment", "entries"],
    "RoyaltyAdjustment response",
  );
  ctx.assert("RoyaltyAdjustment shape", () =>
    assertRoyaltyAdjustment(response.json.royaltyAdjustment),
  );
  ctx.assert(
    "RoyaltyAdjustment posting balanced",
    () =>
      assertBalancedPosting(response.json.entries, {
        postingId: response.json.royaltyAdjustment.adjustmentPostingId,
        currency: body.currency,
      }),
    { hardCapIds: ["HOLD_ADJUSTMENT_AUTHORITY", "ROYALTY_IMMUTABILITY"] },
  );
  return {
    response,
    body,
    adjustment: response.json.royaltyAdjustment,
    entries: response.json.entries,
  };
}

export function assertAllPostings(ctx, state, options = {}) {
  for (const postingId of new Set(
    state.resources.royaltyEntries.map(({ postingId }) => postingId),
  ))
    ctx.assert(
      `posting ${postingId} balanced`,
      () =>
        assertBalancedPosting(
          state.resources.royaltyEntries.filter(
            (entry) => entry.postingId === postingId,
          ),
        ),
      options,
    );
  return state;
}

export function assertCommercialAuthority(
  ctx,
  state,
  purchaseOrderIds,
  options = {},
) {
  for (const purchaseOrderId of purchaseOrderIds) {
    const intents = state.resources.paymentIntents.filter(
      (item) => item.purchaseOrderId === purchaseOrderId,
    );
    const licenses = state.resources.licenses.filter(
      (item) => item.purchaseOrderId === purchaseOrderId,
    );
    ctx.equal(
      intents.length,
      1,
      `${purchaseOrderId} one PaymentIntent`,
      options,
    );
    ctx.ok(
      licenses.length <= 1,
      `${purchaseOrderId} at most one License`,
      options,
    );
    if (licenses.length === 1) {
      ctx.equal(
        state.resources.entitlementGrants.filter(
          ({ licenseId }) => licenseId === licenses[0].licenseId,
        ).length,
        1,
        `${purchaseOrderId} one Grant`,
        options,
      );
      ctx.equal(
        new Set(
          state.resources.royaltyEntries
            .filter(
              ({ sourceType, sourceId }) =>
                sourceType === "LICENSE" && sourceId === licenses[0].licenseId,
            )
            .map(({ postingId }) => postingId),
        ).size,
        1,
        `${purchaseOrderId} one posting`,
        options,
      );
    }
  }
  assertAllPostings(ctx, state, options);
  return state;
}

export async function openApi(ctx, baseUrl, options = {}) {
  const response = await ctx.openApi(baseUrl);
  requireStatus(ctx, response, 200, "OpenAPI");
  ctx.assert(
    "task-local OpenAPI 3.1 contract",
    () => assertOpenApiDocument(response.json, options),
    options.assertionOptions,
  );
  return response.json;
}

export async function listManaged(ctx) {
  return (
    await readdir(ctx.managedDataRoot, { recursive: true }).catch((error) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
    )
  ).sort();
}
export async function assertNoTemporaryMedia(ctx) {
  const entries = await listManaged(ctx);
  ctx.ok(
    entries.every(
      (path) => !/(?:^|[./_-])(?:tmp|temp|partial)(?:$|[./_-])/iu.test(path),
    ),
    `no orphan temporary media: ${entries.join(",")}`,
  );
  return entries;
}

export async function maxResidentBytes(processes) {
  const values = [];
  for (const process of processes) {
    if (!process.pid) continue;
    const status = await readFile(`/proc/${process.pid}/status`, "utf8").catch(
      () => "",
    );
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    if (match) values.push(Number(match[1]) * 1024);
  }
  return Math.max(0, ...values);
}

export async function crashWorkerAt(ctx, baseUrl, point, options = {}) {
  let armed = true;
  const barrier = await ctx.barrier({
    hold: (payload) =>
      armed &&
      payload.point === point &&
      (!options.kind || payload.kind === options.kind) &&
      (!options.aggregateId || payload.aggregateId === options.aggregateId),
  });
  const first = await ctx.startWorker({
    env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
  });
  const entry = await barrier.waitFor(
    ({ json }) =>
      json.point === point &&
      (!options.kind || json.kind === options.kind) &&
      (!options.aggregateId || json.aggregateId === options.aggregateId),
    { timeoutMs: options.timeoutMs ?? 120_000, processes: [first] },
  );
  const before = await snapshot(ctx, baseUrl);
  await ctx.kill(first);
  armed = false;
  await ctx.sleep(options.leaseWaitMs ?? 3_300);
  const replacements = [];
  for (let index = 0; index < (options.replacements ?? 2); index += 1)
    replacements.push(await ctx.startWorker());
  const after = await waitSnapshot(
    ctx,
    baseUrl,
    (value) =>
      value.work.find(({ workId }) => workId === entry.json.workId)?.terminal
        ? value
        : undefined,
    {
      label: `${point} replacement`,
      timeoutMs: options.drainTimeoutMs ?? 180_000,
      processes: replacements,
    },
  );
  return { barrier, entry, before, after, first, replacements };
}

export async function fillVisible(page, patterns, value) {
  for (const pattern of patterns) {
    const locator = page.getByLabel(pattern).first();
    if (await locator.count()) {
      if (await locator.locator("xpath=self::select").count())
        await locator.selectOption(String(value));
      else await locator.fill(String(value));
      return locator;
    }
  }
  throw new Error(
    `visible labeled input not found: ${patterns.map(String).join(", ")}`,
  );
}
export async function clickVisible(page, patterns) {
  for (const pattern of patterns) {
    const locator = page.getByRole("button", { name: pattern }).first();
    if (await locator.count()) {
      await locator.click();
      return locator;
    }
  }
  throw new Error(
    `visible button not found: ${patterns.map(String).join(", ")}`,
  );
}
export async function keyboardActivate(page, patterns) {
  for (const pattern of patterns) {
    const locator = page.getByRole("button", { name: pattern }).first();
    if (await locator.count()) {
      await locator.focus();
      await page.keyboard.press("Enter");
      return locator;
    }
  }
  throw new Error(
    `keyboard-accessible button not found: ${patterns.map(String).join(", ")}`,
  );
}
export async function keyboardFillVisible(page, patterns, value) {
  for (const pattern of patterns) {
    const locator = page.getByLabel(pattern).first();
    if (!(await locator.count())) continue;
    await locator.focus();
    if (await locator.locator("xpath=self::select").count()) {
      await page.keyboard.type(String(value));
      await page.keyboard.press("Enter");
    } else {
      await page.keyboard.press(
        process.platform === "darwin" ? "Meta+A" : "Control+A",
      );
      await page.keyboard.type(String(value));
    }
    return locator;
  }
  throw new Error(
    `keyboard labeled input not found: ${patterns.map(String).join(", ")}`,
  );
}
export async function keyboardChooseFile(page, file) {
  const input = page.locator('input[type="file"]:visible').first();
  if (!(await input.count()))
    throw new Error("visible keyboard file input not found");
  await input.focus();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles(file);
  return input;
}
export async function captureJsonResponse(page, predicate, action) {
  const response = page.waitForResponse(
    (candidate) => predicate(new URL(candidate.url()), candidate),
    { timeout: 60_000 },
  );
  await action();
  const resolved = await response;
  return {
    status: resolved.status(),
    json: await resolved.json(),
    headers: await resolved.allHeaders(),
  };
}
export async function expectVisibleIdentity(page, identity) {
  await page
    .getByText(String(identity), { exact: false })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  return identity;
}

export function requireV1Workspace(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  return ctx.forWorkspace(ctx.v1Workspace);
}
export async function publishedGate(ctx, script, timeoutMs = 900_000) {
  const result = await ctx.npm(script, [], { timeoutMs });
  ctx.equal(result.exitCode, 0, `${script} exit`);
  ctx.ok(
    `${result.stdout}${result.stderr}`.trim().length > 0,
    `${script} executes observable work`,
  );
  return result;
}
export async function launchBrowser(ctx, api, options = {}) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  ctx.defer(() => browser.close());
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1280, height: 900 },
  });
  await page.goto(api.baseUrl, { waitUntil: "networkidle", timeout: 60_000 });
  return { browser, page };
}
