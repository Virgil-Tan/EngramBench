import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function intervalState(total, pieces) {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("total must be a nonnegative safe integer");
  const ranges = pieces.map(({ start, endExclusive }) => [start, endExclusive]).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let cursor = 0;
  let receivedBytes = 0;
  const missing = [];
  for (const [start, end] of ranges) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > total) throw new RangeError("invalid half-open byte range");
    if (start < cursor) throw new RangeError("overlapping byte range");
    if (start > cursor) missing.push([cursor, start]);
    receivedBytes += end - start;
    cursor = end;
  }
  if (cursor < total) missing.push([cursor, total]);
  return { receivedBytes, missing };
}

export function assembleBytes(total, pieces) {
  const state = intervalState(total, pieces);
  if (state.missing.length) throw new Error("cannot assemble incomplete byte coverage");
  const target = Buffer.alloc(total);
  for (const piece of pieces) piece.body.copy(target, piece.start);
  return target;
}

function issue(rowNumber, field, kind, value) {
  return {
    rowNumber,
    field,
    kind,
    valueDigest: value === undefined ? null : sha256(Buffer.from(canonical(value))),
  };
}

function fieldValid(value, field) {
  if (field.type === "string") return typeof value === "string";
  if (field.type === "integer") return Number.isInteger(value);
  if (field.type === "number") return typeof value === "number" && Number.isFinite(value);
  if (field.type === "boolean") return typeof value === "boolean";
  if (field.type === "object") return value && typeof value === "object" && !Array.isArray(value);
  return false;
}

export function modelNdjson(bytes, schema) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const lines = [];
  for (let start = 0; start <= bytes.length;) {
    const newline = bytes.indexOf(0x0a, start);
    if (newline === -1) {
      if (start < bytes.length) lines.push(bytes.subarray(start));
      break;
    }
    lines.push(bytes.subarray(start, newline));
    start = newline + 1;
    if (start === bytes.length) break;
  }
  const allowed = new Map(schema.fields.map((field) => [field.name, field]));
  const seenExternalIds = new Set();
  const rows = [];
  const issues = [];
  for (const [index, lineBytes] of lines.entries()) {
    const rowNumber = index + 1;
    let line;
    try { line = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes); }
    catch {
      issues.push(issue(rowNumber, "$", "INVALID_UTF8"));
      rows.push({ rowNumber, valid: false, externalRowId: null });
      continue;
    }
    let payload;
    try { payload = JSON.parse(line); }
    catch {
      issues.push(issue(rowNumber, "$", "MALFORMED_JSON"));
      rows.push({ rowNumber, valid: false, externalRowId: null });
      continue;
    }
    const rowIssues = [];
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      rowIssues.push(issue(rowNumber, "$", "WRONG_TYPE", payload));
    } else {
      for (const name of Object.keys(payload).filter((name) => !allowed.has(name)).sort()) {
        if (schema.additionalProperties === false) rowIssues.push(issue(rowNumber, name, "UNKNOWN_FIELD", payload[name]));
      }
      for (const field of schema.fields) {
        const value = payload[field.name];
        if (value === undefined) {
          if (field.required) rowIssues.push(issue(rowNumber, field.name, "MISSING_REQUIRED"));
          continue;
        }
        if (!fieldValid(value, field)) {
          rowIssues.push(issue(rowNumber, field.name, "WRONG_TYPE", value));
          continue;
        }
        if (typeof value === "string" && field.maxLength !== undefined && value.length > field.maxLength) rowIssues.push(issue(rowNumber, field.name, "MAX_LENGTH", value));
        if (typeof value === "number" && field.minimum !== undefined && value < field.minimum) rowIssues.push(issue(rowNumber, field.name, "MINIMUM", value));
        if (typeof value === "number" && field.maximum !== undefined && value > field.maximum) rowIssues.push(issue(rowNumber, field.name, "MAXIMUM", value));
      }
    }
    const externalRowId = typeof payload?.[schema.externalIdField] === "string" ? payload[schema.externalIdField] : null;
    if (externalRowId !== null && seenExternalIds.has(externalRowId)) {
      rowIssues.push(issue(rowNumber, schema.externalIdField, "DUPLICATE_EXTERNAL_ID", externalRowId));
    }
    if (externalRowId !== null && !seenExternalIds.has(externalRowId)) seenExternalIds.add(externalRowId);
    rowIssues.sort((left, right) => left.field.localeCompare(right.field) || left.kind.localeCompare(right.kind));
    issues.push(...rowIssues);
    rows.push({
      rowNumber,
      valid: rowIssues.length === 0,
      externalRowId,
      ...(rowIssues.length === 0 ? { payload, payloadDigest: sha256(Buffer.from(JSON.stringify(payload))) } : {}),
    });
  }
  return {
    rows,
    validRows: rows.filter(({ valid }) => valid),
    invalidRows: rows.filter(({ valid }) => !valid),
    issues,
  };
}

export function assertExactKeys(value, keys, label = "object") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} must have an exact closed shape`);
}

export function assertUuid(value, label = "uuid") {
  assert.equal(typeof value, "string", `${label} must be text`);
  assert.match(value, UUID, `${label} must be a lowercase RFC 4122 UUID`);
  assert.equal(value, value.toLowerCase(), `${label} must be lowercase`);
}

export function assertTimestamp(value, label = "timestamp") {
  assert.equal(typeof value, "string", `${label} must be text`);
  assert.match(value, TIMESTAMP, `${label} must be UTC ISO-8601 with milliseconds`);
}

export function assertImportJob(value, expected = {}) {
  assertExactKeys(value, ["importId", "tenantId", "datasetKey", "schemaRevision", "commitMode", "state", "expectedBytes", "expectedSha256", "receivedBytes", "totalRows", "validRows", "invalidRows", "createdAt", "completedAt", "sequence"], "ImportJob");
  assertUuid(value.importId, "ImportJob.importId");
  assertUuid(value.tenantId, "ImportJob.tenantId");
  assert.match(value.expectedSha256, SHA256);
  assertTimestamp(value.createdAt, "ImportJob.createdAt");
  if (value.completedAt !== null) assertTimestamp(value.completedAt, "ImportJob.completedAt");
  assert.ok(["ALL_OR_NOTHING", "VALID_ROWS"].includes(value.commitMode));
  for (const field of ["schemaRevision", "expectedBytes", "receivedBytes", "totalRows", "validRows", "invalidRows", "sequence"]) assert.ok(Number.isSafeInteger(value[field]) && value[field] >= 0, `ImportJob.${field}`);
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `ImportJob.${key}`);
}

export function assertUploadChunk(value, expected = {}) {
  assertExactKeys(value, ["importId", "chunkNumber", "start", "end", "size", "sha256", "receivedAt"], "UploadChunk");
  assertUuid(value.importId, "UploadChunk.importId");
  assert.match(value.sha256, SHA256);
  assertTimestamp(value.receivedAt, "UploadChunk.receivedAt");
  assert.equal(value.size, value.end - value.start + 1);
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `UploadChunk.${key}`);
}

export function assertFinding(value, expected = {}) {
  assertExactKeys(value, ["findingId", "importId", "rowNumber", "externalRowId", "field", "code", "message", "valueDigest"], "ValidationFinding");
  assertUuid(value.findingId, "ValidationFinding.findingId");
  assertUuid(value.importId, "ValidationFinding.importId");
  assert.ok(Number.isSafeInteger(value.rowNumber) && value.rowNumber >= 1);
  assert.equal(typeof value.code, "string");
  assert.equal(typeof value.message, "string");
  if (value.valueDigest !== null) assert.match(value.valueDigest, SHA256);
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `ValidationFinding.${key}`);
}

export function assertRecord(value, expected = {}) {
  assertExactKeys(value, ["recordId", "tenantId", "datasetKey", "externalRowId", "sourceImportId", "payload", "payloadDigest", "committedAt"], "CommittedRecord");
  for (const field of ["recordId", "tenantId", "sourceImportId"]) assertUuid(value[field], `CommittedRecord.${field}`);
  assert.match(value.payloadDigest, SHA256);
  assertTimestamp(value.committedAt, "CommittedRecord.committedAt");
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `CommittedRecord.${key}`);
}

export function assertErrorReport(value, expected = {}) {
  assertExactKeys(value, ["reportId", "importId", "state", "rowCount", "sha256", "createdAt", "readyAt"], "ErrorReport");
  assertUuid(value.reportId, "ErrorReport.reportId");
  assertUuid(value.importId, "ErrorReport.importId");
  assert.ok(["PENDING", "READY", "FAILED"].includes(value.state));
  if (value.sha256 !== null) assert.match(value.sha256, SHA256);
  assertTimestamp(value.createdAt, "ErrorReport.createdAt");
  if (value.readyAt !== null) assertTimestamp(value.readyAt, "ErrorReport.readyAt");
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `ErrorReport.${key}`);
}

export function assertBundle(value, expected = {}) {
  assertExactKeys(value, ["bundleId", "tenantId", "name", "state", "createdAt", "stagedAt", "publishedAt"], "ImportBundle");
  assertUuid(value.bundleId, "ImportBundle.bundleId");
  assertUuid(value.tenantId, "ImportBundle.tenantId");
  assertTimestamp(value.createdAt, "ImportBundle.createdAt");
  if (value.stagedAt !== null) assertTimestamp(value.stagedAt, "ImportBundle.stagedAt");
  if (value.publishedAt !== null) assertTimestamp(value.publishedAt, "ImportBundle.publishedAt");
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `ImportBundle.${key}`);
}

export function assertBundleMember(value, expected = {}) {
  assertExactKeys(value, ["bundleId", "importId", "position", "schemaRevision", "sourceSha256", "commitMode"], "BundleMember");
  assertUuid(value.bundleId, "BundleMember.bundleId");
  assertUuid(value.importId, "BundleMember.importId");
  assert.match(value.sourceSha256, SHA256);
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `BundleMember.${key}`);
}

export function assertPublicError(response, status, code) {
  assert.equal(response.status, status);
  assertExactKeys(response.json, ["error"], "error envelope");
  assertExactKeys(response.json.error, ["code", "message", "details"], "error");
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details));
  assert.doesNotMatch(response.text, /postgres(?:ql)?:\/\/|select\s|insert\s|\/Users\/|\/workspace\/|managed[_-]?data[_-]?root|admin[_-]?token/iu);
}

export function findingComparator(left, right) {
  return left.rowNumber - right.rowNumber
    || left.field.localeCompare(right.field)
    || left.code.localeCompare(right.code)
    || left.findingId.localeCompare(right.findingId);
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
