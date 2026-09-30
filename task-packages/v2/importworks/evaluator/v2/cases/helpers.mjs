import assert from "node:assert/strict";

import {
  assertBundle,
  assertBundleMember,
  assertErrorReport,
  assertFinding,
  assertImportJob,
  assertPublicError,
  assertRecord,
  assertUploadChunk,
  canonical,
  findingComparator,
  modelNdjson,
} from "../lib/oracle.mjs";

export const CORRECTNESS_CAP = Object.freeze({ hardCapIds: ["CORRECTNESS_INVARIANT"] });
const IMPORT_JOB_KEYS = [
  "importId", "tenantId", "datasetKey", "schemaRevision", "commitMode", "state",
  "expectedBytes", "expectedSha256", "receivedBytes", "totalRows", "validRows",
  "invalidRows", "createdAt", "completedAt", "sequence",
];

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !fixtureFamily || !action || !oracle || typeof run !== "function") {
    throw new TypeError("invalid ImportWorks case definition");
  }
  return Object.freeze({ id, taskId: "importworks", fixtureFamily, action, oracle, run });
}

export function expectStatus(ctx, response, expected, label, options = {}) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  ctx.ok(label, statuses.includes(response.status), `expected ${statuses.join("/")}, received ${response.status}: ${response.text}`, options);
  ctx.ok(`${label} returns JSON`, response.json !== undefined, `response was ${response.text}`, options);
  return response.json;
}

export function expectError(ctx, response, status, code, label, options = {}) {
  ctx.assert(label, () => assertPublicError(response, status, code), options);
  return response.json.error;
}

export function expectImport(ctx, response, expected, label, options = {}) {
  const body = expectStatus(ctx, response, 200, label, options);
  ctx.assert(`${label} has the closed ImportJob shape`, () => assertImportJob(body, expected), options);
  return body;
}

export function jobResource(value) {
  return Object.fromEntries(IMPORT_JOB_KEYS.map((key) => [key, value?.[key]]));
}

export function expectChunk(ctx, response, expected, label, options = {}) {
  const body = expectStatus(ctx, response, 200, label, options);
  ctx.assert(`${label} has the closed UploadChunk shape`, () => assertUploadChunk(body, expected), options);
  return body;
}

export function expectBundle(ctx, response, expected, label, options = {}) {
  const body = expectStatus(ctx, response, 200, label, options);
  ctx.assert(`${label} has the closed ImportBundle shape`, () => assertBundle(body, expected), options);
  return body;
}

export function expectBundleMember(ctx, response, expected, label, options = {}) {
  const body = expectStatus(ctx, response, 200, label, options);
  ctx.assert(`${label} has the closed BundleMember shape`, () => assertBundleMember(body, expected), options);
  return body;
}

export function items(ctx, response, label) {
  const body = expectStatus(ctx, response, 200, label);
  ctx.assert(`${label} has the collection envelope`, () => {
    assert.deepEqual(Object.keys(body).sort(), ["items", "nextCursor"]);
    assert.ok(Array.isArray(body.items));
    assert.ok(body.nextCursor === null || typeof body.nextCursor === "string");
  });
  return body;
}

export async function paginate(ctx, baseUrl, path, label, limit = 31) {
  const result = [];
  let cursor;
  const seen = new Set();
  do {
    const separator = path.includes("?") ? "&" : "?";
    const response = await ctx.request(baseUrl, `${path}${separator}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const page = items(ctx, response, label);
    result.push(...page.items);
    cursor = page.nextCursor;
    if (cursor !== null) {
      ctx.ok(`${label} cursor is opaque and non-repeating`, !seen.has(cursor) && cursor.length > 0);
      seen.add(cursor);
    }
  } while (cursor !== null);
  return result;
}

export async function seedCatalogs(ctx, catalogs, label = "catalogs") {
  const list = Array.isArray(catalogs) ? catalogs : [catalogs];
  const imported = await ctx.seed(ctx.seedFor(`${label}-${ctx.key(label)}`, {
    tenants: uniqueBy(list.map(({ tenant }) => tenant), "tenantId"),
    schemas: uniqueBy(list.map(({ schema }) => schema), "schemaId"),
    schemaRevisions: list.map(({ revision }) => revision),
  }));
  ctx.equal(`${label} seed exits zero`, imported.exitCode, 0, { failureCodeSuffix: "SEED_FAILED" });
  return list;
}

export async function startScenario(ctx, { catalogs, workers = 0, apiCount = 1, label = ctx.caseId } = {}) {
  if (catalogs) await seedCatalogs(ctx, catalogs, label);
  const apis = [];
  for (let index = 0; index < apiCount; index += 1) apis.push(await ctx.startApi());
  const workerProcesses = [];
  for (let index = 0; index < workers; index += 1) workerProcesses.push(await ctx.startWorker());
  return { api: apis[0], apis, workers: workerProcesses };
}

export async function createImport(ctx, baseUrl, catalog, bytes, options = {}) {
  const response = await ctx.createImport(baseUrl, catalog, bytes, options);
  const job = expectImport(ctx, response, {
    tenantId: catalog.tenant.tenantId,
    datasetKey: catalog.schema.datasetKey,
    schemaRevision: options.schemaRevision ?? catalog.revision.revision,
    commitMode: options.commitMode ?? "VALID_ROWS",
    expectedBytes: options.extra?.expectedBytes ?? bytes.length,
    expectedSha256: options.extra?.expectedSha256 ?? ctx.sha256(bytes),
    receivedBytes: 0,
  }, options.label ?? "create import", options.assertionOptions);
  return { response, job, key: options.key };
}

export async function uploadPieces(ctx, baseUrl, importId, bytes, pieces, label = "upload") {
  const chunks = [];
  for (const piece of pieces) {
    const response = await ctx.putChunk(baseUrl, importId, bytes.length, piece, { key: ctx.key(`${label}-${piece.chunkNumber}`) });
    chunks.push(expectChunk(ctx, response, {
      importId,
      chunkNumber: piece.chunkNumber,
      start: piece.start,
      end: piece.endInclusive,
      size: piece.body.length,
      sha256: ctx.sha256(piece.body),
    }, `${label} chunk ${piece.chunkNumber}`));
  }
  return chunks;
}

export async function createUploadedImport(ctx, baseUrl, catalog, bytes, options = {}) {
  const created = await createImport(ctx, baseUrl, catalog, bytes, options);
  const { splitBytes } = await import("../lib/fixtures.mjs");
  const pieces = options.pieces ?? splitBytes(bytes, options.count ?? 4, options.order ?? [3, 0, 2, 1]);
  const chunks = await uploadPieces(ctx, baseUrl, created.job.importId, bytes, pieces, options.label ?? "upload");
  const completed = expectImport(ctx, await ctx.completeImport(baseUrl, created.job.importId, options.completeKey ?? ctx.key("complete")), {
    importId: created.job.importId,
    expectedSha256: ctx.sha256(bytes),
    receivedBytes: bytes.length,
  }, `${options.label ?? "upload"} complete`, options.assertionOptions);
  return { ...created, pieces, chunks, completed };
}

export async function waitForImport(ctx, baseUrl, importId, states, options = {}) {
  const accepted = new Set(Array.isArray(states) ? states : [states]);
  return ctx.waitFor(async () => {
    const response = await ctx.getImport(baseUrl, importId);
    if (response.status !== 200 || !accepted.has(response.json?.state)) return undefined;
    return response.json;
  }, {
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: options.intervalMs ?? 40,
    label: options.label ?? `ImportJob ${importId} to reach ${[...accepted].join("/")}`,
    processes: options.processes,
  });
}

export async function createValidatedImport(ctx, baseUrl, catalog, bytes, options = {}) {
  const uploaded = await createUploadedImport(ctx, baseUrl, catalog, bytes, options);
  const validated = await waitForImport(ctx, baseUrl, uploaded.job.importId, "VALIDATED", {
    timeoutMs: options.timeoutMs,
    processes: options.processes,
  });
  const model = modelNdjson(bytes, options.schema ?? catalog.revision);
  ctx.assert(`${options.label ?? "validation"} ImportJob counts match source oracle`, () => assertImportJob(jobResource(validated), {
    totalRows: model.rows.length,
    validRows: model.validRows.length,
    invalidRows: model.invalidRows.length,
  }), options.assertionOptions);
  return { ...uploaded, validated, model };
}

export async function commitAndWait(ctx, baseUrl, importId, options = {}) {
  const response = await ctx.commitImport(baseUrl, importId, options.key ?? ctx.key("commit"));
  const body = expectStatus(ctx, response, options.expectedStatus ?? 200, options.label ?? "commit import", options.assertionOptions);
  if (response.status !== 200) return { response, job: body };
  ctx.assert(`${options.label ?? "commit"} response has the closed ImportJob shape`, () => assertImportJob(body, { importId }), options.assertionOptions);
  const terminal = await waitForImport(ctx, baseUrl, importId, options.states ?? ["COMMITTED", "PARTIALLY_COMMITTED", "REJECTED"], {
    timeoutMs: options.timeoutMs,
    processes: options.processes,
  });
  return { response, job: terminal };
}

export async function allFindings(ctx, baseUrl, importId, limit = 2) {
  const findings = await paginate(ctx, baseUrl, `/api/v1/imports/${importId}/findings`, "findings", limit);
  for (const finding of findings) ctx.assert("finding has the closed public shape", () => assertFinding(finding));
  return findings;
}

export async function allRecords(ctx, baseUrl, tenantId, datasetKey, limit = 37) {
  const path = `/api/v1/records?tenantId=${encodeURIComponent(tenantId)}&datasetKey=${encodeURIComponent(datasetKey)}`;
  const records = await paginate(ctx, baseUrl, path, "records", limit);
  for (const record of records) ctx.assert("record has the closed public shape", () => assertRecord(record));
  return records;
}

export async function waitForReport(ctx, baseUrl, importId, states = ["READY", "FAILED"], options = {}) {
  const accepted = new Set(states);
  return ctx.waitFor(async () => {
    const response = await ctx.getErrorReport(baseUrl, importId);
    if (response.status !== 200 || !accepted.has(response.json?.state)) return undefined;
    return response.json;
  }, { timeoutMs: options.timeoutMs ?? 60_000, intervalMs: 40, label: `ErrorReport for ${importId}`, processes: options.processes });
}

export function resourcesOf(snapshot) {
  return snapshot?.resources ?? snapshot;
}

export function workOf(snapshot) {
  return snapshot?.work ?? snapshot?.Work ?? snapshot?.works ?? [];
}

export function eventsOf(snapshot) {
  return snapshot?.events ?? [];
}

export function resource(snapshot, name) {
  const resources = resourcesOf(snapshot);
  const value = resources?.[name];
  assert.ok(Array.isArray(value), `snapshot resource ${name} must be an array`);
  return value;
}

export function byId(values, key, id, label = key) {
  const value = values.find((item) => item?.[key] === id);
  assert.ok(value, `${label} ${id} is absent`);
  return value;
}

export function normalizedRanges(value) {
  assert.ok(Array.isArray(value), "ranges must be an array");
  return value.map((range) => {
    if (Array.isArray(range)) {
      assert.equal(range.length, 2);
      return [range[0], range[1]];
    }
    assert.ok(range && typeof range === "object");
    const start = range.start;
    const endExclusive = range.endExclusive ?? (range.end === undefined ? undefined : range.end + 1);
    return [start, endExclusive];
  }).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

export function assertModeledFindings(actual, model) {
  const expected = model.issues.map((issue) => {
    const row = model.rows.find(({ rowNumber }) => rowNumber === issue.rowNumber);
    return {
      rowNumber: issue.rowNumber,
      externalRowId: row?.externalRowId ?? null,
      field: issue.field,
      code: issue.kind,
      valueDigest: issue.valueDigest,
    };
  });
  assert.deepEqual([...actual].sort(findingComparator).map(({ rowNumber, externalRowId, field, code, valueDigest }) => ({
    rowNumber, externalRowId, field, code, valueDigest,
  })), expected);
}

export function assertModeledRecords(actual, model, expected = {}) {
  const wanted = model.validRows.map(({ externalRowId, payload, payloadDigest }) => ({ externalRowId, payload, payloadDigest }))
    .sort((left, right) => left.externalRowId.localeCompare(right.externalRowId));
  const selected = actual.filter((record) => (
    (!expected.sourceImportId || record.sourceImportId === expected.sourceImportId)
      && (!expected.tenantId || record.tenantId === expected.tenantId)
      && (!expected.datasetKey || record.datasetKey === expected.datasetKey)
  )).map(({ externalRowId, payload, payloadDigest }) => ({ externalRowId, payload, payloadDigest }))
    .sort((left, right) => left.externalRowId.localeCompare(right.externalRowId));
  assert.deepEqual(selected, wanted);
}

export function assertNoSensitiveMaterial(value, sentinels = []) {
  const text = typeof value === "string" ? value : canonical(value);
  assert.doesNotMatch(text, /postgres(?:ql)?:\/\/|\/Users\/|\/workspace\/|managed[_-]?data[_-]?root|admin[_-]?token|test[_-]?barrier[_-]?token/iu);
  for (const sentinel of sentinels) assert.equal(text.includes(String(sentinel)), false, `public evidence leaked ${sentinel}`);
}

export function assertUnique(values, selector, label) {
  const selected = values.map(selector);
  assert.equal(new Set(selected).size, selected.length, `${label} contains duplicates`);
}

export function assertEventSequences(events) {
  assert.deepEqual(events.map(({ eventId }) => eventId), events.map(({ eventId }) => eventId).sort(), "snapshot Events must be sorted by public eventId");
  const grouped = new Map();
  for (const event of events) {
    assert.equal(typeof event.eventId, "string");
    assert.ok(Number.isSafeInteger(event.sequence) && event.sequence >= 1);
    if (!grouped.has(event.aggregateId)) grouped.set(event.aggregateId, []);
    grouped.get(event.aggregateId).push(event.sequence);
  }
  for (const [aggregateId, sequences] of grouped) {
    const ordered = [...sequences].sort((left, right) => left - right);
    assert.ok(ordered.every(Number.isSafeInteger), `events for ${aggregateId} require integer sequences`);
    assert.equal(new Set(sequences).size, sequences.length, `events for ${aggregateId} repeat a sequence`);
  }
}

export function assertReport(value, expected = {}) {
  assertErrorReport(value, expected);
  assert.ok(value.state !== "READY" || value.sha256 !== null, "READY ErrorReport requires sha256");
}

export async function verifyReportContent(ctx, baseUrl, importId, findings, report) {
  const response = await ctx.request(baseUrl, `/api/v1/imports/${importId}/error-report/content`, { binary: true });
  ctx.equal("READY report content returns 200", response.status, 200);
  ctx.ok("report content uses NDJSON media type", /^application\/x-ndjson(?:;|$)/iu.test(response.headers.get("content-type") ?? ""));
  assertReportBytes(ctx, response.body, findings, report);
}

export function assertReportBytes(ctx, bytes, findings, report) {
  const expected = Buffer.from([...findings].sort(findingComparator).map(finding => `${canonical(finding)}\n`).join(""));
  ctx.equal("report bytes are canonical findings followed by LF", bytes, expected);
  ctx.equal("report SHA-256 covers exactly the downloaded bytes", report.sha256, ctx.sha256(bytes));
}

export async function publishRevision(ctx, baseUrl, catalog, revision, key = ctx.key(`schema-revision-${revision.revision}`)) {
  const { schemaId: _schemaId, revision: _revision, ...request } = revision;
  const response = await ctx.mutate(baseUrl, `/api/v1/schemas/${catalog.schema.schemaId}/revisions`, key, request);
  expectStatus(ctx, response, 200, `publish schema revision ${revision.revision}`);
  ctx.equal("published schema revision is server assigned", response.json.revision, revision.revision);
  return response.json;
}

export async function waitForBundle(ctx, baseUrl, bundleId, states, options = {}) {
  const accepted = new Set(Array.isArray(states) ? states : [states]);
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl, { timeoutMs: options.snapshotTimeoutMs });
    const bundle = resource(snapshot, "importBundles").find((item) => item.bundleId === bundleId);
    return bundle && accepted.has(bundle.state) ? { bundle, snapshot } : undefined;
  }, { timeoutMs: options.timeoutMs ?? 60_000, intervalMs: options.intervalMs ?? 40, label: `ImportBundle ${bundleId}` });
}

export function result(ctx, summary, extra = {}) {
  return { evidence: [{ kind: "case-summary", summary, metrics: { ...ctx.evidence.metrics } }], ...extra };
}

export function formalPerfScale() {
  const value = Number(process.env.BENCH_PERF_SCALE ?? "1");
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new TypeError("BENCH_PERF_SCALE must be in (0, 1]");
  return value;
}

export function scaledCount(full, minimum = 1) {
  return Math.max(minimum, Math.round(full * formalPerfScale()));
}

function uniqueBy(values, key) {
  return [...new Map(values.map((value) => [value[key], value])).values()];
}
