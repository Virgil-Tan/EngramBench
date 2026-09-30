import assert from "node:assert/strict";

import {
  ndjsonBytes,
  rowFixture,
  schemaFixture,
  splitBytes,
  uploadWorkedExample,
} from "../lib/fixtures.mjs";
import {
  assertBundle,
  assertImportJob,
  assertRecord,
  assembleBytes,
  findingComparator,
  intervalState,
  modelNdjson,
} from "../lib/oracle.mjs";
import {
  CORRECTNESS_CAP,
  allFindings,
  allRecords,
  assertModeledFindings,
  assertModeledRecords,
  assertNoSensitiveMaterial,
  assertReport,
  commitAndWait,
  createImport,
  createValidatedImport,
  defineCase,
  eventsOf,
  expectBundle,
  expectBundleMember,
  expectChunk,
  expectError,
  expectImport,
  expectStatus,
  normalizedRanges,
  publishRevision,
  resource,
  result,
  startScenario,
  waitForBundle,
  waitForImport,
  waitForReport,
  verifyReportContent,
  workOf,
} from "./helpers.mjs";

const JOB_KEYS = [
  "importId", "tenantId", "datasetKey", "schemaRevision", "commitMode", "state",
  "expectedBytes", "expectedSha256", "receivedBytes", "totalRows", "validRows",
  "invalidRows", "createdAt", "completedAt", "sequence",
];

function importProjection(body) {
  return Object.fromEntries(JOB_KEYS.map((key) => [key, body[key]]));
}

async function a01(ctx) {
  const catalog = ctx.catalog("resume");
  const { api } = await startScenario(ctx, { catalogs: catalog });
  const worked = uploadWorkedExample();
  const created = await createImport(ctx, api.baseUrl, catalog, worked.bytes, { commitMode: "ALL_OR_NOTHING" });
  const revision2 = schemaFixture(ctx.fixtures, {
    schemaId: catalog.schema.schemaId,
    revision: 2,
    fields: [...catalog.revision.fields, { name: "country", type: "string", required: true, maxLength: 2 }],
  });
  await publishRevision(ctx, api.baseUrl, catalog, revision2);

  const accepted = [];
  const observations = [];
  for (const piece of worked.pieces) {
    const key = ctx.key(`resume-piece-${piece.chunkNumber}`);
    const response = await ctx.putChunk(api.baseUrl, created.job.importId, worked.bytes.length, piece, { key });
    const chunk = expectChunk(ctx, response, {
      importId: created.job.importId,
      chunkNumber: piece.chunkNumber,
      start: piece.start,
      end: piece.endInclusive,
      size: piece.body.length,
      sha256: ctx.sha256(piece.body),
    }, `out-of-order chunk ${piece.chunkNumber}`);
    accepted.push(piece);
    const detail = expectStatus(ctx, await ctx.getImport(api.baseUrl, created.job.importId), 200, `resume view ${accepted.length}`);
    ctx.assert(`resume view ${accepted.length} preserves the frozen job`, () => assertImportJob(importProjection(detail), {
      importId: created.job.importId,
      schemaRevision: 1,
      commitMode: "ALL_OR_NOTHING",
      expectedBytes: 12,
      expectedSha256: ctx.sha256(worked.bytes),
      receivedBytes: intervalState(12, accepted).receivedBytes,
    }));
    const state = intervalState(12, accepted);
    ctx.equal(`resume view ${accepted.length} missing ranges`, normalizedRanges(detail.missingRanges), state.missing);
    const publicCoverage = intervalState(12, normalizedRanges(detail.receivedRanges).map(([start, endExclusive]) => ({ start, endExclusive })));
    ctx.equal(`resume view ${accepted.length} received-range byte union`, publicCoverage.receivedBytes, state.receivedBytes);
    ctx.equal(`resume view ${accepted.length} received-range holes`, publicCoverage.missing, state.missing);
    observations.push({ chunk, receivedBytes: detail.receivedBytes, missingRanges: state.missing });
    if (accepted.length === 1) {
      const replay = await ctx.putChunk(api.baseUrl, created.job.importId, worked.bytes.length, piece, { key });
      ctx.equal("identical chunk replay preserves status", replay.status, response.status);
      ctx.equal("identical chunk replay preserves bytes and timestamp", ctx.canonical(replay.json), ctx.canonical(response.json));
    }
  }
  ctx.equal("independent assembly ignores arrival order", assembleBytes(12, accepted), worked.bytes);
  const snapshot = await ctx.snapshot(api.baseUrl);
  ctx.assert("snapshot and API logs do not expose managed paths or tokens", () => assertNoSensitiveMaterial({ snapshot, logs: api.logs }));
  ctx.equal("snapshot retains one immutable row per accepted chunk", resource(snapshot, "uploadChunks").filter(({ importId }) => importId === created.job.importId).length, 3, CORRECTNESS_CAP);
  return result(ctx, "frozen job, three out-of-order ranges, replay, resume coverage, and managed-artifact isolation were observed", { evidence: observations });
}

async function a02(ctx) {
  const catalog = ctx.catalog("complete");
  const { api, workers } = await startScenario(ctx, { catalogs: catalog, workers: 1 });
  const validBytes = ndjsonBytes([rowFixture(1), rowFixture(2)]);
  const pieces = splitBytes(validBytes, 4, [3, 0, 2, 1]);

  const gap = await createImport(ctx, api.baseUrl, catalog, validBytes, { label: "gap import" });
  expectChunk(ctx, await ctx.putChunk(api.baseUrl, gap.job.importId, validBytes.length, pieces[0]), {
    importId: gap.job.importId,
    chunkNumber: pieces[0].chunkNumber,
  }, "single tail chunk");
  expectError(ctx, await ctx.completeImport(api.baseUrl, gap.job.importId), 409, "UPLOAD_INCOMPLETE", "gap cannot complete");
  const gapSnapshot = await ctx.snapshot(api.baseUrl);
  ctx.equal("gap creates no validation Work", workOf(gapSnapshot).filter(({ aggregateId, kind }) => aggregateId === gap.job.importId && kind === "IMPORT_VALIDATE").length, 0);

  const badChunk = await createImport(ctx, api.baseUrl, catalog, validBytes, { label: "bad chunk digest import" });
  expectError(ctx, await ctx.putChunk(api.baseUrl, badChunk.job.importId, validBytes.length, pieces[1], {
    digest: "0".repeat(64),
  }), 400, "INVALID_CHUNK", "wrong chunk digest is rejected");
  ctx.equal("wrong chunk digest has no durable byte effect", (await ctx.getImport(api.baseUrl, badChunk.job.importId)).json.receivedBytes, 0);

  const overlap = await createImport(ctx, api.baseUrl, catalog, validBytes, { label: "overlap import" });
  expectChunk(ctx, await ctx.putChunk(api.baseUrl, overlap.job.importId, validBytes.length, pieces[1]), { importId: overlap.job.importId }, "overlap source chunk");
  const overlapPiece = {
    chunkNumber: 99,
    start: pieces[1].start + 1,
    endExclusive: pieces[1].endExclusive + 1,
    endInclusive: pieces[1].endInclusive + 1,
    body: validBytes.subarray(pieces[1].start + 1, pieces[1].endExclusive + 1),
  };
  expectError(ctx, await ctx.putChunk(api.baseUrl, overlap.job.importId, validBytes.length, overlapPiece), 409, "CHUNK_CONFLICT", "partial overlap is rejected");
  ctx.equal("overlap loser has no durable effect", (await ctx.getImport(api.baseUrl, overlap.job.importId)).json.receivedBytes, pieces[1].body.length);

  const wrongWhole = await createImport(ctx, api.baseUrl, catalog, validBytes, {
    label: "whole digest import",
    extra: { expectedSha256: "f".repeat(64) },
  });
  for (const piece of pieces) expectChunk(ctx, await ctx.putChunk(api.baseUrl, wrongWhole.job.importId, validBytes.length, piece), { importId: wrongWhole.job.importId }, `whole digest chunk ${piece.chunkNumber}`);
  expectError(ctx, await ctx.completeImport(api.baseUrl, wrongWhole.job.importId), 409, "FILE_DIGEST_MISMATCH", "assembled digest mismatch is rejected");
  const mismatchSnapshot = await ctx.snapshot(api.baseUrl);
  ctx.equal("assembled digest failure creates no validation Work", workOf(mismatchSnapshot).filter(({ aggregateId, kind }) => aggregateId === wrongWhole.job.importId && kind === "IMPORT_VALIDATE").length, 0);

  const cancellable = await createImport(ctx, api.baseUrl, catalog, validBytes, { label: "cancellable import" });
  const cancelKey = ctx.key("cancel-idempotent");
  const cancelled = expectImport(ctx, await ctx.cancelImport(api.baseUrl, cancellable.job.importId, cancelKey), { state: "CANCELLED" }, "cancel before complete");
  const cancelReplay = expectImport(ctx, await ctx.cancelImport(api.baseUrl, cancellable.job.importId, cancelKey), { state: "CANCELLED" }, "cancel replay");
  ctx.equal("cancel replay is byte-stable", ctx.canonical(cancelReplay), ctx.canonical(cancelled));

  const committed = await createValidatedImport(ctx, api.baseUrl, catalog, validBytes, { label: "committed control", processes: workers });
  const commit = expectImport(ctx, await ctx.commitImport(api.baseUrl, committed.job.importId), { importId: committed.job.importId }, "commit control");
  const terminal = await waitForImport(ctx, api.baseUrl, committed.job.importId, "COMMITTED", { processes: workers });
  const recordsBefore = await allRecords(ctx, api.baseUrl, catalog.tenant.tenantId, catalog.schema.datasetKey);
  expectError(ctx, await ctx.cancelImport(api.baseUrl, committed.job.importId), 409, "IMPORT_TERMINAL", "committed import cannot be cancelled");
  const recordsAfter = await allRecords(ctx, api.baseUrl, catalog.tenant.tenantId, catalog.schema.datasetKey);
  ctx.equal("terminal cancel cannot mutate source digest", terminal.expectedSha256, commit.expectedSha256, CORRECTNESS_CAP);
  ctx.equal("terminal cancel cannot mutate records", ctx.canonical(recordsAfter), ctx.canonical(recordsBefore), CORRECTNESS_CAP);
  return result(ctx, "gap, chunk digest, overlap, assembled digest, cancel replay, and committed immutability were exercised");
}

function validationBytes(sentinel) {
  return Buffer.concat([
    ndjsonBytes([rowFixture(1, { externalId: "X" })]),
    Buffer.from('{"externalId":"broken"\n'),
    ndjsonBytes([rowFixture(3, { externalId: "Y", age: "wrong" })]),
    ndjsonBytes([rowFixture(4, { externalId: "Z", secretField: sentinel })]),
    ndjsonBytes([{ externalId: "M", age: 30 }]),
    ndjsonBytes([rowFixture(6, { externalId: "X" })]),
    Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d, 0x0a]),
  ]);
}

async function a03(ctx) {
  const catalog = ctx.catalog("findings");
  const sentinel = `IW-RAW-${ctx.key("rejected")}`;
  const bytes = validationBytes(sentinel);
  const { api, workers } = await startScenario(ctx, { catalogs: catalog, workers: 1 });
  const created = await createImport(ctx, api.baseUrl, catalog, bytes, { label: "frozen schema import" });
  const revision2 = schemaFixture(ctx.fixtures, {
    schemaId: catalog.schema.schemaId,
    revision: 2,
    fields: catalog.revision.fields.map((field) => field.name === "age"
      ? { name: field.name, type: "string", required: field.required }
      : field),
  });
  await publishRevision(ctx, api.baseUrl, catalog, revision2);
  const pieces = splitBytes(bytes, 4, [2, 0, 3, 1]);
  for (const piece of pieces) expectChunk(ctx, await ctx.putChunk(api.baseUrl, created.job.importId, bytes.length, piece), { importId: created.job.importId }, `validation chunk ${piece.chunkNumber}`);
  expectImport(ctx, await ctx.completeImport(api.baseUrl, created.job.importId), { importId: created.job.importId }, "complete validation fixture");
  const validated = await waitForImport(ctx, api.baseUrl, created.job.importId, "VALIDATED", { processes: workers });
  const model = modelNdjson(bytes, catalog.revision);
  ctx.assert("validation uses the revision captured at create", () => assertImportJob(importProjection(validated), {
    schemaRevision: 1,
    totalRows: model.rows.length,
    validRows: model.validRows.length,
    invalidRows: model.invalidRows.length,
  }));
  const findings = await allFindings(ctx, api.baseUrl, created.job.importId, 2);
  ctx.assert("findings exactly match the independent byte/schema model", () => assertModeledFindings(findings, model));
  ctx.equal("findings are in deterministic public order", findings, [...findings].sort(findingComparator));
  ctx.assert("findings redact every rejected raw value", () => assertNoSensitiveMaterial(findings, [sentinel, "wrong"]), CORRECTNESS_CAP);

  const report = await waitForReport(ctx, api.baseUrl, created.job.importId, ["READY"], { processes: workers });
  ctx.assert("READY report metadata is closed and counts findings", () => assertReport(report, {
    importId: created.job.importId,
    state: "READY",
    rowCount: findings.length,
  }));
  const reportAgain = expectStatus(ctx, await ctx.getErrorReport(api.baseUrl, created.job.importId), 200, "read stable report metadata");
  ctx.equal("report identity, digest, and row count are stable", reportAgain, report);
  await verifyReportContent(ctx, api.baseUrl, created.job.importId, findings, report);
  const snapshot = await ctx.snapshot(api.baseUrl);
  ctx.assert("snapshot contains only redacted validation evidence", () => assertNoSensitiveMaterial(snapshot, [sentinel, "wrong"]), CORRECTNESS_CAP);
  return result(ctx, "frozen revision validation, seven stable rows, paginated findings, redaction, and report metadata were verified");
}

async function a04(ctx) {
  const primary = ctx.catalog("commit-primary");
  const otherTenant = ctx.catalog("commit-other", { datasetKey: primary.schema.datasetKey });
  const { api, workers } = await startScenario(ctx, { catalogs: [primary, otherTenant], workers: 2 });
  const mixed = ndjsonBytes([
    rowFixture(1, { externalId: "shared", email: "stable@example.test" }),
    rowFixture(2, { externalId: "bad", email: 42 }),
  ]);

  const aon = await createValidatedImport(ctx, api.baseUrl, primary, mixed, { commitMode: "ALL_OR_NOTHING", label: "AON mixed", processes: workers });
  const aonTerminal = await commitAndWait(ctx, api.baseUrl, aon.job.importId, { processes: workers });
  ctx.equal("AON mixed import is rejected", aonTerminal.job.state, "REJECTED", CORRECTNESS_CAP);
  let primaryRecords = await allRecords(ctx, api.baseUrl, primary.tenant.tenantId, primary.schema.datasetKey);
  ctx.equal("AON mixed import publishes zero records", primaryRecords.filter(({ sourceImportId }) => sourceImportId === aon.job.importId).length, 0, CORRECTNESS_CAP);

  const validRows = await createValidatedImport(ctx, api.baseUrl, primary, mixed, { commitMode: "VALID_ROWS", label: "VALID_ROWS mixed", processes: workers });
  const partial = await commitAndWait(ctx, api.baseUrl, validRows.job.importId, { processes: workers });
  ctx.equal("VALID_ROWS mixed import is partial", partial.job.state, "PARTIALLY_COMMITTED", CORRECTNESS_CAP);
  ctx.equal("VALID_ROWS counts conserve rows", partial.job.totalRows, partial.job.validRows + partial.job.invalidRows);
  primaryRecords = await allRecords(ctx, api.baseUrl, primary.tenant.tenantId, primary.schema.datasetKey);
  ctx.assert("VALID_ROWS publishes exactly the independently valid rows", () => assertModeledRecords(primaryRecords, validRows.model, {
    sourceImportId: validRows.job.importId,
    tenantId: primary.tenant.tenantId,
    datasetKey: primary.schema.datasetKey,
  }), CORRECTNESS_CAP);

  const identicalBytes = ndjsonBytes([rowFixture(1, { externalId: "shared", email: "stable@example.test" })]);
  const identical = await createValidatedImport(ctx, api.baseUrl, primary, identicalBytes, { label: "identity replay", processes: workers });
  const identicalTerminal = await commitAndWait(ctx, api.baseUrl, identical.job.importId, { processes: workers });
  ctx.equal("identical external-row payload can replay", identicalTerminal.job.state, "COMMITTED");
  primaryRecords = await allRecords(ctx, api.baseUrl, primary.tenant.tenantId, primary.schema.datasetKey);
  ctx.equal("identical payload replay does not duplicate external identity", primaryRecords.filter(({ externalRowId }) => externalRowId === "shared").length, 1, CORRECTNESS_CAP);

  const conflictingBytes = ndjsonBytes([rowFixture(1, { externalId: "shared", email: "changed@example.test" })]);
  const conflicting = await createValidatedImport(ctx, api.baseUrl, primary, conflictingBytes, { label: "identity conflict", processes: workers });
  expectError(ctx, await ctx.commitImport(api.baseUrl, conflicting.job.importId), 409, "ROW_IDENTITY_CONFLICT", "different payload conflicts", CORRECTNESS_CAP);
  const afterConflict = await allRecords(ctx, api.baseUrl, primary.tenant.tenantId, primary.schema.datasetKey);
  const canonicalRecord = afterConflict.find(({ externalRowId }) => externalRowId === "shared");
  ctx.equal("conflict cannot replace the canonical payload", canonicalRecord.payload.email, "stable@example.test", CORRECTNESS_CAP);

  const crossTenant = await createValidatedImport(ctx, api.baseUrl, otherTenant, conflictingBytes, { label: "cross-tenant control", processes: workers });
  const crossTenantTerminal = await commitAndWait(ctx, api.baseUrl, crossTenant.job.importId, { processes: workers });
  ctx.equal("same external identity is isolated across tenants", crossTenantTerminal.job.state, "COMMITTED", CORRECTNESS_CAP);
  const otherRecords = await allRecords(ctx, api.baseUrl, otherTenant.tenant.tenantId, otherTenant.schema.datasetKey);
  ctx.assert("cross-tenant record retains its own payload", () => assertRecord(otherRecords[0], {
    tenantId: otherTenant.tenant.tenantId,
    externalRowId: "shared",
    payload: JSON.parse(conflictingBytes.toString("utf8")),
  }), CORRECTNESS_CAP);
  return result(ctx, "AON rejection, selective publication, identical replay, conflicting identity, and tenant isolation converged");
}

async function validateBundleSources(ctx, baseUrl, catalog, workerProcesses, label, rows, mode = "VALID_ROWS") {
  return createValidatedImport(ctx, baseUrl, catalog, ndjsonBytes(rows), {
    commitMode: mode,
    label,
    processes: workerProcesses,
  });
}

async function a05(ctx) {
  const catalog = ctx.catalog("bundle");
  const otherTenant = ctx.catalog("bundle-other");
  const { api, workers } = await startScenario(ctx, { catalogs: [catalog, otherTenant], workers: 1 });
  const first = await validateBundleSources(ctx, api.baseUrl, catalog, workers, "bundle first", [rowFixture(1, { externalId: "bundle-a" })]);
  const second = await validateBundleSources(ctx, api.baseUrl, catalog, workers, "bundle second", [
    rowFixture(2, { externalId: "bundle-b" }), rowFixture(3, { externalId: "bundle-bad", age: "bad" }),
  ]);
  const rejectedMember = await validateBundleSources(ctx, api.baseUrl, catalog, workers, "bundle AON bad", [
    rowFixture(4, { externalId: "bundle-c" }), rowFixture(5, { externalId: "bundle-c-bad", email: 1 }),
  ], "ALL_OR_NOTHING");
  const other = await validateBundleSources(ctx, api.baseUrl, otherTenant, workers, "other tenant member", [rowFixture(6, { externalId: "other" })]);
  for (const worker of workers) await ctx.stop(worker);

  const bundle = expectBundle(ctx, await ctx.createBundle(api.baseUrl, catalog.tenant.tenantId, "Atomic cohort"), {
    tenantId: catalog.tenant.tenantId,
    name: "Atomic cohort",
    state: "DRAFT",
  }, "create Bundle");
  const member1 = expectBundleMember(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, first.job.importId), {
    bundleId: bundle.bundleId,
    importId: first.job.importId,
    position: 0,
    schemaRevision: first.job.schemaRevision,
    sourceSha256: first.job.expectedSha256,
    commitMode: first.job.commitMode,
  }, "add first Bundle member");
  const member2 = expectBundleMember(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, second.job.importId), {
    bundleId: bundle.bundleId,
    importId: second.job.importId,
    position: 1,
  }, "add second Bundle member");
  expectError(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, other.job.importId), 409, "BUNDLE_MEMBER_CONFLICT", "cross-tenant member is rejected");
  const staged = expectBundle(ctx, await ctx.stageBundle(api.baseUrl, bundle.bundleId), { state: "STAGED" }, "stage Bundle");
  expectError(ctx, await ctx.addBundleMember(api.baseUrl, bundle.bundleId, rejectedMember.job.importId), 409, "BUNDLE_FROZEN", "staged Bundle rejects mutation");
  const publishKey = ctx.key("publish-success");
  expectBundle(ctx, await ctx.publishBundle(api.baseUrl, bundle.bundleId, publishKey), { bundleId: bundle.bundleId }, "publish Bundle");
  const publishWorker = await ctx.startWorker();
  const observedCounts = [];
  const published = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const records = resource(snapshot, "committedRecords").filter(({ sourceImportId }) => [first.job.importId, second.job.importId].includes(sourceImportId));
    observedCounts.push(records.length);
    const value = resource(snapshot, "importBundles").find(({ bundleId }) => bundleId === bundle.bundleId);
    return value?.state === "PUBLISHED" ? { value, snapshot } : undefined;
  }, { timeoutMs: 60_000, intervalMs: 10, label: "atomic Bundle publication", processes: [publishWorker] });
  ctx.ok("Bundle records are observed only as none or the complete cohort", observedCounts.every((count) => count === 0 || count === 2), undefined, CORRECTNESS_CAP);
  ctx.assert("published Bundle keeps the frozen public shape", () => assertBundle(published.value, {
    bundleId: bundle.bundleId,
    state: "PUBLISHED",
    stagedAt: staged.stagedAt,
  }), CORRECTNESS_CAP);
  ctx.equal("frozen member order survives publication", resource(published.snapshot, "bundleMembers").filter(({ bundleId }) => bundleId === bundle.bundleId), [member1, member2]);
  ctx.equal("member ImportJobs retain their validated history", resource(published.snapshot, "imports").filter(({ importId }) => [first.job.importId, second.job.importId].includes(importId)).map(({ state }) => state), ["VALIDATED", "VALIDATED"]);

  const badBundle = expectBundle(ctx, await ctx.createBundle(api.baseUrl, catalog.tenant.tenantId, "Rejected cohort"), { state: "DRAFT" }, "create rejecting Bundle");
  expectBundleMember(ctx, await ctx.addBundleMember(api.baseUrl, badBundle.bundleId, rejectedMember.job.importId), { position: 0 }, "add bad AON member");
  const untouched = await validateBundleSources(ctx, api.baseUrl, catalog, [publishWorker], "rejection control", [rowFixture(7, { externalId: "must-not-publish" })]);
  expectBundleMember(ctx, await ctx.addBundleMember(api.baseUrl, badBundle.bundleId, untouched.job.importId), { position: 1 }, "add valid rejection control");
  expectBundle(ctx, await ctx.stageBundle(api.baseUrl, badBundle.bundleId), { state: "STAGED" }, "stage rejecting Bundle");
  expectBundle(ctx, await ctx.publishBundle(api.baseUrl, badBundle.bundleId), { bundleId: badBundle.bundleId }, "publish rejecting Bundle");
  const rejected = await waitForBundle(ctx, api.baseUrl, badBundle.bundleId, "REJECTED");
  ctx.equal("bad AON member rejects the entire Bundle", rejected.bundle.state, "REJECTED", CORRECTNESS_CAP);
  ctx.equal("rejected Bundle publishes no member records", resource(rejected.snapshot, "committedRecords").filter(({ sourceImportId }) => [rejectedMember.job.importId, untouched.job.importId].includes(sourceImportId)).length, 0, CORRECTNESS_CAP);
  ctx.ok("Bundle publication creates aggregate events", eventsOf(published.snapshot).some(({ aggregateId }) => aggregateId === bundle.bundleId));
  return result(ctx, "ordered frozen members, atomic publication visibility, and bad-AON all-or-none rejection were observed");
}

export const A_CASES = Object.freeze([
  defineCase({ id: "A-01", fixtureFamily: "F-UPLOAD/W1", action: "HTTP create, schema publish, out-of-order PUT, GET resume, replay", oracle: "independent half-open interval union and SHA-256", run: a01 }),
  defineCase({ id: "A-02", fixtureFamily: "F-UPLOAD integrity variants", action: "HTTP chunk failures, complete, cancel, commit", oracle: "coverage/digest state machine plus public Work/snapshot", run: a02 }),
  defineCase({ id: "A-03", fixtureFamily: "F-NDJSON mixed bytes", action: "schema publish, worker validation, findings pagination, report GET", oracle: "independent fatal UTF-8/NDJSON/schema/duplicate model", run: a03 }),
  defineCase({ id: "A-04", fixtureFamily: "F-COMMIT two modes and two tenants", action: "worker commit and external identity conflicts", oracle: "source-row record set and tenant identity model", run: a04 }),
  defineCase({ id: "A-05", fixtureFamily: "F-BUNDLE ordered valid and bad-AON members", action: "Bundle create/add/stage/publish through HTTP and Worker", oracle: "snapshot cohort freeze and all-or-none record visibility", run: a05 }),
]);
