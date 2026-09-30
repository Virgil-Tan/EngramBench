import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number")
      assert.ok(
        Number.isFinite(value),
        "canonical JSON forbids non-finite numbers",
      );
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function exactKeys(value, keys, label = "value") {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} exact fields`,
  );
}

export function assertPublicError(response, status, code) {
  assert.equal(response.status, status, `public error status ${status}`);
  exactKeys(response.json, ["error"], "public error envelope");
  const keys = Object.keys(response.json.error).sort();
  assert.ok(keys.length === 2 || keys.length === 3, "public error field count");
  assert.deepEqual(
    keys.filter((key) => key !== "details"),
    ["code", "message"],
    "public error fields",
  );
  if (code !== undefined)
    assert.equal(response.json.error.code, code, "public error code");
  else
    assert.equal(
      typeof response.json.error.code,
      "string",
      "public error code string",
    );
  assert.equal(
    typeof response.json.error.message,
    "string",
    "public error message string",
  );
  if (Object.hasOwn(response.json.error, "details"))
    assert.ok(
      response.json.error.details &&
        typeof response.json.error.details === "object" &&
        !Array.isArray(response.json.error.details),
      "public error details object",
    );
  return true;
}

const V1_PATH_METHODS = Object.freeze({
  "/api/v1/tenants": ["post"],
  "/api/v1/creators": ["post"],
  "/api/v1/works": ["post"],
  "/api/v1/works/{workId}/rights-splits": ["post"],
  "/api/v1/transcode-profiles": ["post"],
  "/api/v1/uploads": ["post"],
  "/api/v1/uploads/{uploadId}/chunks/{chunkNumber}": ["put"],
  "/api/v1/uploads/{uploadId}": ["get"],
  "/api/v1/uploads/{uploadId}/abort": ["post"],
  "/api/v1/uploads/{uploadId}/complete": ["post"],
  "/api/v1/scanner/results": ["post"],
  "/api/v1/scan-jobs/{scanJobId}/reconcile": ["post"],
  "/api/v1/assets/{assetId}": ["get"],
  "/api/v1/assets/{assetId}/renditions": ["get"],
  "/api/v1/editions": ["post"],
  "/api/v1/editions/{editionId}/publish": ["post"],
  "/api/v1/editions/{editionId}": ["get"],
  "/api/v1/license-offers": ["post"],
  "/api/v1/license-offers/{offerId}": ["get"],
  "/api/v1/purchases": ["post"],
  "/api/v1/review-cases/{reviewCaseId}/claim": ["post"],
  "/api/v1/review-cases/{reviewCaseId}/decisions": ["post"],
  "/api/v1/provider/events": ["post"],
  "/api/v1/payment-intents/{paymentIntentId}/reconcile": ["post"],
  "/api/v1/purchases/{purchaseOrderId}": ["get"],
  "/api/v1/licenses/{licenseId}": ["get"],
  "/api/v1/entitlements/check": ["get"],
  "/api/v1/licenses/{licenseId}/refunds": ["post"],
  "/api/v1/refunds/{refundId}/reconcile": ["post"],
  "/api/v1/royalty-ledger": ["get"],
  "/api/v1/royalty-periods": ["post"],
  "/api/v1/royalty-periods/{royaltyPeriodId}": ["get"],
  "/api/v1/provider/receipts": ["post"],
  "/api/v1/deliveries/{deliveryId}/reconcile": ["post"],
  "/api/v1/verification-snapshot": ["get"],
});
const FINAL_PATH_METHODS = Object.freeze({
  "/api/v1/rights-disputes": ["post"],
  "/api/v1/rights-disputes/{rightsDisputeId}": ["get"],
  "/api/v1/rights-disputes/{rightsDisputeId}/resolve": ["post"],
  "/api/v1/license-holds": ["post"],
  "/api/v1/license-holds/{licenseHoldId}/release": ["post"],
  "/api/v1/royalty-adjustments": ["post"],
});
const BODY_UNPUBLISHED = new Set([
  "/api/v1/uploads/{uploadId}/abort",
  "/api/v1/scan-jobs/{scanJobId}/reconcile",
  "/api/v1/payment-intents/{paymentIntentId}/reconcile",
  "/api/v1/refunds/{refundId}/reconcile",
  "/api/v1/provider/receipts",
  "/api/v1/deliveries/{deliveryId}/reconcile",
]);
const SUCCESS_BODY_UNPUBLISHED = new Set(["/api/v1/provider/receipts"]);

const RESOURCE_FIELDS = Object.freeze({
  Tenant: ["tenantId", "name"],
  Creator: ["creatorId", "tenantId", "displayName", "payoutCurrency"],
  Work: ["workId", "tenantId", "externalRef", "title", "currentRightsRevision"],
  RightsSplit: [
    "workId",
    "revision",
    "creatorId",
    "basisPoints",
    "effectiveFrom",
  ],
  UploadSession: [
    "uploadId",
    "tenantId",
    "workId",
    "fileName",
    "mediaType",
    "totalBytes",
    "chunkSize",
    "contentSha256",
    "requiredProfileIds",
    "state",
    "createdAt",
    "expiresAt",
    "completedAt",
  ],
  UploadChunk: [
    "uploadId",
    "chunkNumber",
    "startByte",
    "endByte",
    "sizeBytes",
    "sha256",
    "createdAt",
  ],
  BlobObject: [
    "blobId",
    "tenantId",
    "sha256",
    "sizeBytes",
    "state",
    "createdAt",
  ],
  ScanJob: [
    "scanJobId",
    "assetId",
    "state",
    "attempt",
    "leaseOwner",
    "leaseToken",
    "leaseExpiresAt",
  ],
  ScanResult: [
    "scanResultId",
    "scanJobId",
    "assetId",
    "verdict",
    "engineVersion",
    "contentSha256",
    "createdAt",
  ],
  TranscodeProfile: [
    "profileId",
    "tenantId",
    "revision",
    "name",
    "operation",
    "prefixBase64",
    "active",
  ],
  TranscodeJob: [
    "transcodeJobId",
    "assetId",
    "profileId",
    "profileRevision",
    "state",
    "attempt",
    "leaseOwner",
    "leaseToken",
    "leaseExpiresAt",
  ],
  Rendition: [
    "renditionId",
    "assetId",
    "profileId",
    "profileRevision",
    "sha256",
    "sizeBytes",
    "state",
    "createdAt",
  ],
  Edition: [
    "editionId",
    "tenantId",
    "workId",
    "title",
    "revision",
    "state",
    "rightsRevision",
    "manifestDigest",
    "publishedAt",
    "createdAt",
  ],
  EditionAsset: [
    "editionId",
    "ordinal",
    "assetId",
    "renditionId",
    "assetSha256",
    "renditionSha256",
  ],
  LicenseOffer: [
    "offerId",
    "tenantId",
    "editionId",
    "state",
    "licenseType",
    "territories",
    "priceMinor",
    "currency",
    "termsVersion",
    "createdAt",
  ],
  PurchaseOrder: [
    "purchaseOrderId",
    "tenantId",
    "buyerRef",
    "offerId",
    "editionId",
    "priceMinor",
    "currency",
    "termsVersion",
    "rightsRevision",
    "state",
    "providerRequestId",
    "sequence",
    "createdAt",
    "terminalAt",
  ],
  FraudAssessment: [
    "assessmentId",
    "purchaseOrderId",
    "rulesVersion",
    "score",
    "recommendation",
    "state",
    "createdAt",
    "completedAt",
  ],
  ReviewCase: [
    "reviewCaseId",
    "purchaseOrderId",
    "state",
    "reviewerId",
    "leaseToken",
    "leaseExpiresAt",
    "outcome",
    "reasonCode",
    "revision",
  ],
  PaymentIntent: [
    "paymentIntentId",
    "purchaseOrderId",
    "providerRequestId",
    "amountMinor",
    "currency",
    "state",
    "sequence",
    "createdAt",
    "resolvedAt",
  ],
  License: [
    "licenseId",
    "tenantId",
    "purchaseOrderId",
    "editionId",
    "buyerRef",
    "licenseType",
    "territories",
    "rightsRevision",
    "state",
    "grantedAt",
    "revokedAt",
  ],
  EntitlementGrant: [
    "grantId",
    "tenantId",
    "licenseId",
    "buyerRef",
    "editionId",
    "state",
    "revision",
    "grantedAt",
    "revokedAt",
  ],
  Refund: [
    "refundId",
    "licenseId",
    "providerRequestId",
    "amountMinor",
    "currency",
    "state",
    "createdAt",
    "resolvedAt",
  ],
  RoyaltyAccount: [
    "royaltyAccountId",
    "tenantId",
    "ownerType",
    "ownerId",
    "currency",
  ],
  RoyaltyEntry: [
    "royaltyEntryId",
    "postingId",
    "tenantId",
    "royaltyPeriodId",
    "royaltyAccountId",
    "ownerId",
    "accountRole",
    "direction",
    "amountMinor",
    "currency",
    "sourceType",
    "sourceId",
    "createdAt",
  ],
  RoyaltyPeriod: [
    "royaltyPeriodId",
    "tenantId",
    "currency",
    "periodStart",
    "periodEnd",
    "state",
    "closedAt",
    "snapshotDigest",
  ],
  Notification: [
    "notificationId",
    "tenantId",
    "aggregateType",
    "aggregateId",
    "sequence",
    "templateKey",
    "payload",
    "state",
    "createdAt",
  ],
  Delivery: [
    "deliveryId",
    "notificationId",
    "eventId",
    "attempt",
    "state",
    "nextAttemptAt",
    "providerReceiptId",
  ],
  RightsDispute: [
    "rightsDisputeId",
    "tenantId",
    "editionId",
    "claimantCreatorId",
    "licenseId",
    "reason",
    "evidenceRefs",
    "state",
    "revision",
    "createdAt",
    "resolvedAt",
    "resolutionReason",
  ],
  LicenseHold: [
    "licenseHoldId",
    "tenantId",
    "rightsDisputeId",
    "scope",
    "editionId",
    "licenseId",
    "state",
    "revision",
    "reason",
    "createdAt",
    "releasedAt",
  ],
  RoyaltyAdjustment: [
    "royaltyAdjustmentId",
    "tenantId",
    "rightsDisputeId",
    "originalPostingId",
    "targetRoyaltyPeriodId",
    "amountMinor",
    "currency",
    "reason",
    "adjustmentPostingId",
    "createdAt",
  ],
});

const RESOURCE_ENUMS = Object.freeze({
  PurchaseOrder: {
    state: [
      "RISK_PENDING",
      "REVIEW",
      "PAYMENT_PENDING",
      "LICENSE_HELD",
      "LICENSED",
      "BLOCKED",
      "FAILED",
    ],
  },
  License: { state: ["ACTIVE", "HELD", "REVOKED"] },
  RoyaltyEntry: {
    accountRole: ["PLATFORM_CLEARING", "CREATOR_PAYABLE", "REFUND_CLEARING"],
    direction: ["DEBIT", "CREDIT"],
    sourceType: ["LICENSE", "REFUND"],
  },
  RightsDispute: { state: ["OPEN", "UPHELD", "REJECTED"] },
  LicenseHold: { scope: ["EDITION", "LICENSE"], state: ["ACTIVE", "RELEASED"] },
});

function dereference(document, schema) {
  if (!schema?.$ref) return schema;
  const prefix = "#/components/schemas/";
  assert.ok(
    schema.$ref.startsWith(prefix),
    `local schema reference ${schema.$ref}`,
  );
  return document.components.schemas[schema.$ref.slice(prefix.length)];
}

function assertConstrainedSchema(document, candidate, label) {
  const schema = dereference(document, candidate);
  assert.ok(
    schema && typeof schema === "object" && Object.keys(schema).length > 0,
    `${label} schema`,
  );
  if (schema.oneOf || schema.anyOf) {
    for (const branch of schema.oneOf ?? schema.anyOf)
      assertConstrainedSchema(document, branch, label);
    return;
  }
  if (schema.type === "array") {
    assertConstrainedSchema(document, schema.items, `${label} item`);
    return;
  }
  if (schema.type === "object" || schema.properties) {
    assert.equal(schema.additionalProperties, false, `${label} closed object`);
    assert.ok(
      schema.properties && Object.keys(schema.properties).length > 0,
      `${label} properties`,
    );
    return;
  }
  assert.ok(
    ["string", "integer", "number", "boolean"].includes(schema.type),
    `${label} constrained scalar`,
  );
}

function enumValues(document, candidate) {
  const schema = dereference(document, candidate);
  if (Array.isArray(schema?.enum))
    return schema.enum.filter((value) => value !== null);
  const branches = schema?.oneOf ?? schema?.anyOf ?? [];
  return branches.flatMap((branch) => enumValues(document, branch));
}

export function assertOpenApiDocument(document, { final = true } = {}) {
  assert.ok(
    document && typeof document === "object" && !Array.isArray(document),
    "OpenAPI object",
  );
  assert.match(document.openapi, /^3\.1(?:\.|$)/u, "OpenAPI 3.1");
  assert.ok(document.info && typeof document.info === "object", "OpenAPI info");
  assert.ok(
    document.paths && typeof document.paths === "object",
    "OpenAPI paths",
  );
  const expected = final
    ? { ...V1_PATH_METHODS, ...FINAL_PATH_METHODS }
    : V1_PATH_METHODS;
  for (const [path, methods] of Object.entries(expected)) {
    assert.ok(document.paths[path], `${path} documented`);
    for (const method of methods) {
      const operation = document.paths[path][method];
      assert.ok(
        operation && typeof operation === "object",
        `${method.toUpperCase()} ${path} documented`,
      );
      assert.ok(
        operation.responses && Object.keys(operation.responses).length > 0,
        `${method.toUpperCase()} ${path} responses`,
      );
      const success = operation.responses["200"];
      assert.ok(success, `${method.toUpperCase()} ${path} exact 200 success`);
      const successSchema = success.content?.["application/json"]?.schema;
      if (successSchema)
        assertConstrainedSchema(
          document,
          successSchema,
          `${method.toUpperCase()} ${path} success`,
        );
      else
        assert.ok(
          SUCCESS_BODY_UNPUBLISHED.has(path),
          `${method.toUpperCase()} ${path} published success body`,
        );
      if (method !== "get") {
        const parameters = [
          ...(document.paths[path].parameters ?? []),
          ...(operation.parameters ?? []),
        ];
        assert.ok(
          parameters.some(
            (entry) =>
              entry?.name?.toLowerCase() === "idempotency-key" &&
              entry.in === "header" &&
              entry.required === true,
          ),
          `${method.toUpperCase()} ${path} Idempotency-Key`,
        );
        const media = operation.requestBody?.content;
        if (!BODY_UNPUBLISHED.has(path))
          assert.ok(
            media && Object.keys(media).length > 0,
            `${method.toUpperCase()} ${path} request body`,
          );
        if (media?.["application/json"])
          assertConstrainedSchema(
            document,
            media["application/json"].schema,
            `${method.toUpperCase()} ${path} request`,
          );
        else if (!BODY_UNPUBLISHED.has(path))
          assert.ok(
            path === "/api/v1/uploads/{uploadId}/chunks/{chunkNumber}" &&
              media["application/octet-stream"],
            `${method.toUpperCase()} ${path} published media type`,
          );
      }
    }
  }
  for (const name of Object.keys(RESOURCE_FIELDS).filter(
    (item) =>
      final ||
      !["RightsDispute", "LicenseHold", "RoyaltyAdjustment"].includes(item),
  )) {
    const schema = document.components?.schemas?.[name];
    assert.ok(schema && schema.type === "object", `${name} schema`);
    assert.equal(schema.additionalProperties, false, `${name} closed schema`);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}).sort(),
      [...RESOURCE_FIELDS[name]].sort(),
      `${name} exact properties`,
    );
    assert.deepEqual(
      [...(schema.required ?? [])].sort(),
      [...RESOURCE_FIELDS[name]].sort(),
      `${name} exact required fields`,
    );
    for (const [field, published] of Object.entries(
      RESOURCE_ENUMS[name] ?? {},
    )) {
      const values = final
        ? published
        : published.filter(
            (value) =>
              !(
                (name === "PurchaseOrder" && value === "LICENSE_HELD") ||
                (name === "License" && value === "HELD")
              ),
          );
      assert.deepEqual(
        [...new Set(enumValues(document, schema.properties[field]))].sort(),
        [...values].sort(),
        `${name}.${field} exact enum`,
      );
    }
  }
  return true;
}

export function assertRightsDispute(value) {
  exactKeys(
    value,
    [
      "rightsDisputeId",
      "tenantId",
      "editionId",
      "claimantCreatorId",
      "licenseId",
      "reason",
      "evidenceRefs",
      "state",
      "revision",
      "createdAt",
      "resolvedAt",
      "resolutionReason",
    ],
    "RightsDispute",
  );
  assert.ok(
    ["OPEN", "UPHELD", "REJECTED"].includes(value.state),
    "RightsDispute state",
  );
  assert.deepEqual(
    value.evidenceRefs,
    [...new Set(value.evidenceRefs)].sort(),
    "RightsDispute evidenceRefs unique sorted",
  );
  return true;
}

export function assertLicenseHold(value) {
  exactKeys(
    value,
    [
      "licenseHoldId",
      "tenantId",
      "rightsDisputeId",
      "scope",
      "editionId",
      "licenseId",
      "state",
      "revision",
      "reason",
      "createdAt",
      "releasedAt",
    ],
    "LicenseHold",
  );
  assert.ok(["EDITION", "LICENSE"].includes(value.scope), "LicenseHold scope");
  assert.ok(["ACTIVE", "RELEASED"].includes(value.state), "LicenseHold state");
  return true;
}

export function assertRoyaltyAdjustment(value) {
  exactKeys(
    value,
    [
      "royaltyAdjustmentId",
      "tenantId",
      "rightsDisputeId",
      "originalPostingId",
      "targetRoyaltyPeriodId",
      "amountMinor",
      "currency",
      "reason",
      "adjustmentPostingId",
      "createdAt",
    ],
    "RoyaltyAdjustment",
  );
  assert.ok(
    Number.isSafeInteger(value.amountMinor) && value.amountMinor !== 0,
    "RoyaltyAdjustment nonzero integer",
  );
  return true;
}

export function tupleSort(items, fields) {
  return [...items].sort((left, right) => {
    for (const field of fields) {
      const a = left[field];
      const b = right[field];
      if (a === b) continue;
      if (a === null) return -1;
      if (b === null) return 1;
      if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a - b;
      return Buffer.from(String(a)).compare(Buffer.from(String(b)));
    }
    return Buffer.from(canonicalJson(left)).compare(
      Buffer.from(canonicalJson(right)),
    );
  });
}

export function chunkOracle(bytes, chunkSize) {
  assert.ok(Buffer.isBuffer(bytes), "raw media fixture must be bytes");
  assert.ok(Number.isSafeInteger(chunkSize) && chunkSize > 0, "chunk size");
  const chunks = [];
  for (
    let offset = 0, chunkNumber = 1;
    offset < bytes.length;
    offset += chunkSize, chunkNumber += 1
  ) {
    const value = bytes.subarray(
      offset,
      Math.min(bytes.length, offset + chunkSize),
    );
    chunks.push({
      chunkNumber,
      startByte: offset,
      endByte: offset + value.length - 1,
      sizeBytes: value.length,
      sha256: sha256(value),
      bytes: Buffer.from(value),
      contentRange: `bytes ${offset}-${offset + value.length - 1}/${bytes.length}`,
    });
  }
  return Object.freeze({
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    chunks: Object.freeze(chunks),
  });
}

export function renditionOracle(source, profile) {
  assert.ok(Buffer.isBuffer(source), "source bytes");
  assert.ok(
    profile?.operation === "COPY" || profile?.operation === "PREFIX_BASE64",
    "published transcode operation",
  );
  const prefix =
    profile.operation === "PREFIX_BASE64"
      ? Buffer.from(profile.prefixBase64, "base64")
      : Buffer.alloc(0);
  assert.ok(prefix.length <= 64 * 1024, "prefix <=64KiB");
  const bytes = Buffer.concat([prefix, source]);
  return Object.freeze({
    bytes,
    sha256: sha256(bytes),
    sizeBytes: bytes.length,
  });
}

export function editionManifestDigest({ rightsRevision, assets }) {
  assert.ok(
    Number.isSafeInteger(rightsRevision) && rightsRevision >= 0,
    "rights revision",
  );
  const normalized = assets.map(
    ({ ordinal, assetId, renditionId, assetSha256, renditionSha256 }) => ({
      ordinal,
      assetId,
      renditionId,
      assetSha256,
      renditionSha256,
    }),
  );
  assert.deepEqual(
    normalized.map(({ ordinal }) => ordinal),
    [...normalized.map(({ ordinal }) => ordinal)].sort((a, b) => a - b),
    "edition assets sorted",
  );
  return sha256(canonicalJson({ rightsRevision, assets: normalized }));
}

export function fraudV1({ velocity, country, deviceTrust }) {
  let score = 0;
  if (velocity >= 50) score += 300;
  if (country === "XX") score += 200;
  if (deviceTrust === "NEW") score += 100;
  return Object.freeze({
    rulesVersion: 1,
    score,
    recommendation: score < 300 ? "APPROVE" : score < 600 ? "REVIEW" : "BLOCK",
  });
}

export function allocateRoyalty(amountMinor, splits) {
  assert.ok(
    Number.isSafeInteger(amountMinor) && amountMinor >= 0,
    "integer royalty amount",
  );
  assert.equal(
    splits.reduce((sum, split) => sum + split.basisPoints, 0),
    10_000,
    "rights sum exactly 10k",
  );
  assert.equal(
    new Set(splits.map(({ creatorId }) => creatorId)).size,
    splits.length,
    "unique creators",
  );
  const rows = splits.map(({ creatorId, basisPoints }) => {
    const numerator = amountMinor * basisPoints;
    return {
      creatorId,
      basisPoints,
      amountMinor: Math.floor(numerator / 10_000),
      remainder: numerator % 10_000,
    };
  });
  let remaining =
    amountMinor - rows.reduce((sum, row) => sum + row.amountMinor, 0);
  const priority = [...rows].sort(
    (left, right) =>
      right.remainder - left.remainder ||
      Buffer.from(left.creatorId).compare(Buffer.from(right.creatorId)),
  );
  for (let index = 0; index < remaining; index += 1)
    priority[index].amountMinor += 1;
  return tupleSort(rows, ["creatorId"]).map(
    ({ remainder: _remainder, ...row }) => row,
  );
}

export function assertBalancedPosting(entries, { postingId, currency } = {}) {
  assert.ok(entries.length >= 2, "posting has at least two entries");
  const targetPosting = postingId ?? entries[0].postingId;
  const targetCurrency = currency ?? entries[0].currency;
  assert.ok(
    entries.every((entry) => entry.postingId === targetPosting),
    "single posting identity",
  );
  assert.ok(
    entries.every((entry) => entry.currency === targetCurrency),
    "single posting currency",
  );
  const debit = entries
    .filter(({ direction }) => direction === "DEBIT")
    .reduce((sum, entry) => sum + entry.amountMinor, 0);
  const credit = entries
    .filter(({ direction }) => direction === "CREDIT")
    .reduce((sum, entry) => sum + entry.amountMinor, 0);
  assert.equal(debit, credit, "posting debits equal credits");
  return true;
}

export function periodEntries(entries, periodStart, periodEnd) {
  return tupleSort(
    entries.filter(
      ({ createdAt }) => createdAt >= periodStart && createdAt < periodEnd,
    ),
    ["createdAt", "royaltyEntryId"],
  );
}

export function royaltyPeriodDigest(entries, periodStart, periodEnd) {
  return sha256(canonicalJson(periodEntries(entries, periodStart, periodEnd)));
}

export function assertAggregateSequences(
  records,
  {
    aggregateTypeField = "aggregateType",
    aggregateIdField = "aggregateId",
    sequenceField = "sequence",
    idField = "eventId",
  } = {},
) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record[aggregateTypeField]}\0${record[aggregateIdField]}`;
    const values = groups.get(key) ?? [];
    values.push(record);
    groups.set(key, values);
  }
  for (const [key, values] of groups) {
    values.sort((left, right) => left[sequenceField] - right[sequenceField]);
    values.forEach((record, index) =>
      assert.equal(record[sequenceField], index + 1, `${key} gapless sequence`),
    );
    assert.equal(
      new Set(values.map((record) => record[idField])).size,
      values.length,
      `${key} stable unique identity`,
    );
  }
  return true;
}

export function assertWork(work) {
  const identities = new Set();
  for (const item of work) {
    exactKeys(
      item,
      [
        "workId",
        "kind",
        "aggregateId",
        "state",
        "attempt",
        "leaseOwner",
        "leaseToken",
        "leaseExpiresAt",
        "terminal",
      ],
      "Work",
    );
    assert.equal(identities.has(item.workId), false, "unique Work identity");
    identities.add(item.workId);
    assert.ok(
      Number.isSafeInteger(item.attempt) && item.attempt >= 0,
      "Work attempt",
    );
    assert.equal(typeof item.terminal, "boolean", "Work terminal flag");
    if (item.terminal)
      assert.notEqual(item.state, "LEASED", "terminal Work is not leased");
  }
  return true;
}

export function assertNoSensitiveData(value, forbidden = []) {
  const encoded = JSON.stringify(value);
  assert.equal(
    /(?:riskContext|contentBase64|storageKey|providerBody|payoutDetails|authorization|leaseTokenHash|postgres(?:ql)?:\/\/|\/(?:Users|home|tmp)\/)/iu.test(
      encoded,
    ),
    false,
    "public evidence omits private media, authority and path data",
  );
  for (const secret of forbidden.filter(Boolean))
    assert.equal(
      encoded.includes(secret),
      false,
      "public evidence omits supplied secret material",
    );
  return true;
}

export function assertRetryIdentity(
  receiverEntries,
  headerName = "x-event-id",
) {
  const groups = Map.groupBy(
    receiverEntries,
    (entry) => entry.headers[headerName],
  );
  for (const [eventId, entries] of groups) {
    assert.ok(eventId, "receiver event identity");
    const raw = entries[0].raw;
    assert.equal(typeof raw, "string", `${eventId} receiver captured raw body`);
    assert.ok(
      entries.every((entry) => entry.raw === raw),
      `${eventId} retry body byte-identical`,
    );
  }
  return true;
}
