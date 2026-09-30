// Policy revision: learning-final-system-2026-09-08.1. One FINAL submission; current public operations, persistence and restart recovery, not a historical binary upgrade.
import assert from "node:assert/strict";

import { ndjsonBytes, rowFixture, rowsFixture, splitBytes } from "../lib/fixtures.mjs";
import { intervalState, percentile } from "../lib/oracle.mjs";
import { EvaluationInfrastructureError } from "../lib/runtime.mjs";
import {
  CORRECTNESS_CAP,
  assertEventSequences,
  assertNoSensitiveMaterial,
  assertUnique,
  createUploadedImport,
  defineCase,
  eventsOf,
  expectBundle,
  expectBundleMember,
  expectChunk,
  expectImport,
  formalPerfScale,
  resource,
  result,
  scaledCount,
  startScenario,
  waitForBundle,
  waitForImport,
  workOf,
} from "./helpers.mjs";

function stableHistorical(snapshot) {
  const resources = snapshot.resources ?? snapshot;
  return {
    tenants: resources.tenants,
    schemas: resources.schemas,
    schemaRevisions: resources.schemaRevisions,
    imports: resources.imports,
    uploadChunks: resources.uploadChunks,
    validationFindings: resources.validationFindings,
    committedRecords: resources.committedRecords,
    errorReports: resources.errorReports,
    events: snapshot.events,
    work: snapshot.work ?? snapshot.Work ?? snapshot.works,
  };
}

async function e01(ctx) {
  const catalog = ctx.catalog("initialRuntime-final");
  const initialRuntime = ctx;
  await initialRuntime.migrate({ timeoutMs: 300_000 });
  const seeded = await initialRuntime.seed(ctx.seedFor(`initialRuntime-${ctx.key("seed")}`, {
    tenants: [catalog.tenant], schemas: [catalog.schema], schemaRevisions: [catalog.revision],
  }));
  ctx.equal("base-system seed exits zero", seeded.exitCode, 0, { failureCodeSuffix: "V1_SEED_FAILED" });
  const initialApi = await initialRuntime.startApi();
  const initialWorker = await initialRuntime.startWorker();
  const bytes = ndjsonBytes([
    rowFixture(1, { externalId: "historical-good" }),
    rowFixture(2, { externalId: "historical-bad", age: "bad" }),
  ]);
  const createKey = ctx.key("historical-create");
  const createResponse = await ctx.createImport(initialApi.baseUrl, catalog, bytes, { key: createKey });
  const created = expectImport(ctx, createResponse, { commitMode: "VALID_ROWS" }, "base-system create import");
  const pieces = splitBytes(bytes, 4, [3, 0, 2, 1]);
  const chunkKeys = new Map();
  const chunkResponses = new Map();
  for (const piece of pieces) {
    const key = ctx.key(`historical-chunk-${piece.chunkNumber}`);
    chunkKeys.set(piece.chunkNumber, key);
    const response = await ctx.putChunk(initialApi.baseUrl, created.importId, bytes.length, piece, { key });
    expectChunk(ctx, response, { importId: created.importId, chunkNumber: piece.chunkNumber }, `base-system chunk ${piece.chunkNumber}`);
    chunkResponses.set(piece.chunkNumber, response);
  }
  const completeKey = ctx.key("historical-complete");
  const completeResponse = await ctx.completeImport(initialApi.baseUrl, created.importId, completeKey);
  expectImport(ctx, completeResponse, { importId: created.importId }, "base-system complete");
  await waitForImport(ctx, initialApi.baseUrl, created.importId, "VALIDATED", { processes: [initialWorker] });
  const commitKey = ctx.key("historical-commit");
  const commitResponse = await ctx.commitImport(initialApi.baseUrl, created.importId, commitKey);
  expectImport(ctx, commitResponse, { importId: created.importId }, "base-system commit");
  await waitForImport(ctx, initialApi.baseUrl, created.importId, "PARTIALLY_COMMITTED", { processes: [initialWorker] });

  await ctx.kill(initialWorker);
  const pendingBytes = ndjsonBytes([rowFixture(3, { externalId: "pending-across-reinitialization" })]);
  const pending = await createUploadedImport(ctx, initialApi.baseUrl, catalog, pendingBytes, { label: "base-system pending Work" });
  const receiver = await ctx.receiver(() => ({ status: 500 }));
  const initialDispatcher = await initialRuntime.startDispatcher({ webhookUrl: receiver.url });
  await ctx.waitFor(() => receiver.ledger.length > 0, { timeoutMs: 30_000, label: "base-system unacknowledged Event", processes: [initialDispatcher] });
  await ctx.kill(initialDispatcher);
  const before = await ctx.snapshot(initialApi.baseUrl);
  const oldEvent = receiver.ledger[0].json?.event ?? receiver.ledger[0].json;
  ctx.ok("base-system snapshot has pending validation Work", workOf(before).some(({ aggregateId, kind, terminal }) => aggregateId === pending.job.importId && kind === "IMPORT_VALIDATE" && terminal === false));
  ctx.ok("base-system snapshot retains an unacknowledged event", workOf(before).some(({ kind, terminal }) => kind === "EVENT_DELIVERY" && terminal === false));
  await ctx.kill(initialApi);

  await ctx.migrate({ timeoutMs: 300_000 });
  const finalApi = await ctx.startApi();
  const afterMigration = await ctx.snapshot(finalApi.baseUrl);
  ctx.equal("new FINAL Bundle resources start empty", resource(afterMigration, "importBundles"), []);
  ctx.equal("new FINAL member resources start empty", resource(afterMigration, "bundleMembers"), []);
  const beforeStable = stableHistorical(before);
  const afterStable = stableHistorical(afterMigration);
  for (const name of ["tenants", "schemas", "schemaRevisions", "imports", "uploadChunks", "validationFindings", "committedRecords", "errorReports"]) {
    ctx.equal(`FINAL reinitialization preserves base-system ${name}`, afterStable[name], beforeStable[name], CORRECTNESS_CAP);
  }
  const oldEventIds = new Set(beforeStable.events.map(({ eventId }) => eventId));
  ctx.equal("FINAL reinitialization preserves every base-system Event byte-for-byte", afterStable.events.filter(({ eventId }) => oldEventIds.has(eventId)), beforeStable.events, CORRECTNESS_CAP);

  const createReplay = await ctx.createImport(finalApi.baseUrl, catalog, bytes, { key: createKey });
  ctx.equal("old create replay status survives FINAL reinitialization", createReplay.status, createResponse.status);
  ctx.equal("old create replay body survives FINAL reinitialization", ctx.canonical(createReplay.json), ctx.canonical(createResponse.json));
  for (const piece of pieces) {
    const replay = await ctx.putChunk(finalApi.baseUrl, created.importId, bytes.length, piece, { key: chunkKeys.get(piece.chunkNumber) });
    ctx.equal(`old chunk ${piece.chunkNumber} replay survives FINAL reinitialization`, ctx.canonical(replay.json), ctx.canonical(chunkResponses.get(piece.chunkNumber).json));
  }
  const completeReplay = await ctx.completeImport(finalApi.baseUrl, created.importId, completeKey);
  ctx.equal("old complete replay survives FINAL reinitialization", ctx.canonical(completeReplay.json), ctx.canonical(completeResponse.json));
  const commitReplay = await ctx.commitImport(finalApi.baseUrl, created.importId, commitKey);
  ctx.equal("old commit replay survives FINAL reinitialization", ctx.canonical(commitReplay.json), ctx.canonical(commitResponse.json));

  const finalWorker = await ctx.startWorker();
  await waitForImport(ctx, finalApi.baseUrl, pending.job.importId, "VALIDATED", { processes: [finalWorker] });
  const bundle = expectBundle(ctx, await ctx.createBundle(finalApi.baseUrl, catalog.tenant.tenantId, "Post-reinitialization Bundle"), { state: "DRAFT" }, "create post-reinitialization Bundle");
  expectBundleMember(ctx, await ctx.addBundleMember(finalApi.baseUrl, bundle.bundleId, pending.job.importId), { position: 0 }, "add post-reinitialization member");
  expectBundle(ctx, await ctx.stageBundle(finalApi.baseUrl, bundle.bundleId), { state: "STAGED" }, "stage post-reinitialization Bundle");
  expectBundle(ctx, await ctx.publishBundle(finalApi.baseUrl, bundle.bundleId), { bundleId: bundle.bundleId }, "publish post-reinitialization Bundle");
  await waitForBundle(ctx, finalApi.baseUrl, bundle.bundleId, "PUBLISHED");
  const finalReceiver = await ctx.receiver(() => ({ status: 204 }));
  const finalDispatcher = await ctx.startEventDispatcher(finalReceiver.url);
  const finalSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(finalApi.baseUrl);
    return workOf(snapshot).filter(({ kind }) => kind === "EVENT_DELIVERY").every(({ terminal }) => terminal === true) ? snapshot : undefined;
  }, { timeoutMs: 90_000, intervalMs: 100, label: "retained event delivery drain", processes: [finalDispatcher] });
  ctx.equal("committed base-system history is never backfilled as a Bundle member", resource(finalSnapshot, "bundleMembers").filter(({ importId }) => importId === created.importId).length, 0, CORRECTNESS_CAP);
  const preservedEvent = eventsOf(finalSnapshot).find(({ eventId }) => eventId === oldEvent.eventId);
  ctx.equal("previously unacknowledged Event retains its exact identity/body", preservedEvent, beforeStable.events.find(({ eventId }) => eventId === oldEvent.eventId), CORRECTNESS_CAP);
  return result(ctx, "base-system resources, replays, pending Work, and unacknowledged Event survived FINAL reinitialization before a new Bundle published");
}

function oneMib(index) {
  const bytes = Buffer.alloc(1024 * 1024, index % 251);
  bytes.writeUInt32BE(index >>> 0, 0);
  return bytes;
}

function performanceSummary(ctx, name, scale, count, durations, elapsedMs) {
  const throughput = count / (elapsedMs / 1_000);
  const p95 = percentile(durations, 0.95);
  ctx.metric("scale", scale);
  ctx.metric("count", count);
  ctx.metric(`${name}ThroughputPerSecond`, throughput);
  ctx.metric(`${name}P95Ms`, p95);
  return { throughput, p95 };
}

async function e02(ctx) {
  const scale = formalPerfScale();
  const count = scaledCount(2_000);
  const catalog = ctx.catalog("perf-upload");
  const { api } = await startScenario(ctx, { catalogs: catalog });
  const jobs = new Array(count);
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }, (_, index) => index), 64, async (index) => {
    const bytes = oneMib(index);
    const start = performance.now();
    const create = await ctx.createImport(api.baseUrl, catalog, bytes, { key: ctx.key(`perf-upload-create-${index}`) });
    assert.equal(create.status, 200, create.text);
    const importId = create.json.importId;
    const pieces = splitBytes(bytes, 4, [3, 0, 2, 1]);
    const keys = pieces.map((piece) => ctx.key(`perf-upload-${index}-${piece.chunkNumber}`));
    for (const [pieceIndex, piece] of pieces.entries()) {
      const response = await ctx.putChunk(api.baseUrl, importId, bytes.length, piece, { key: keys[pieceIndex] });
      assert.equal(response.status, 200, response.text);
    }
    const replay = await ctx.putChunk(api.baseUrl, importId, bytes.length, pieces[0], { key: keys[0] });
    assert.equal(replay.status, 200, replay.text);
    const complete = await ctx.completeImport(api.baseUrl, importId, ctx.key(`perf-upload-complete-${index}`));
    assert.equal(complete.status, 200, complete.text);
    jobs[index] = { importId, sha256: ctx.sha256(bytes), durationMs: performance.now() - start };
  });
  const elapsedMs = performance.now() - startedAt;
  const { throughput, p95 } = performanceSummary(ctx, "completedUploads", scale, count, jobs.map(({ durationMs }) => durationMs), elapsedMs);
  if (scale === 1) {
    ctx.ok("2,000-import throughput is at least 40 completed uploads/s", throughput >= 40, `observed ${throughput}`);
    ctx.ok("2,000-import p95 is at most 1,500 ms", p95 <= 1_500, `observed ${p95}`);
  }
  const snapshot = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
  const ids = new Set(jobs.map(({ importId }) => importId));
  const imports = resource(snapshot, "imports").filter(({ importId }) => ids.has(importId));
  const chunks = resource(snapshot, "uploadChunks").filter(({ importId }) => ids.has(importId));
  ctx.equal("load snapshot has every completed import", imports.length, count, CORRECTNESS_CAP);
  ctx.equal("load snapshot has exactly four chunks per import", chunks.length, count * 4, CORRECTNESS_CAP);
  const byJob = new Map(jobs.map((job) => [job.importId, job]));
  ctx.assert("every post-load range union and digest is exact", () => {
    for (const job of imports) {
      const expected = byJob.get(job.importId);
      assert.equal(job.receivedBytes, 1024 * 1024);
      assert.equal(job.expectedSha256, expected.sha256);
      const state = intervalState(1024 * 1024, chunks.filter(({ importId }) => importId === job.importId).map(({ start, end }) => ({ start, endExclusive: end + 1 })));
      assert.equal(state.receivedBytes, 1024 * 1024);
      assert.deepEqual(state.missing, []);
    }
    const validationWork = workOf(snapshot).filter(({ kind, aggregateId }) => kind === "IMPORT_VALIDATE" && ids.has(aggregateId));
    assert.equal(validationWork.length, count);
    assertUnique(validationWork, ({ aggregateId }) => aggregateId, "upload-load validation Work");
    assert.ok(validationWork.every(({ state, terminal }) => state === "PENDING" && terminal === false));
    const events = eventsOf(snapshot).filter(({ aggregateId }) => ids.has(aggregateId));
    assertUnique(events, ({ eventId }) => eventId, "upload-load events");
    assertEventSequences(events);
    for (const importId of ids) {
      assert.equal(events.filter(({ aggregateId, type }) => aggregateId === importId && type === "import.created").length, 1);
      assert.equal(events.filter(({ aggregateId, type }) => aggregateId === importId && type === "import.uploaded").length, 1);
    }
  }, CORRECTNESS_CAP);
  ctx.assert("post-load snapshot has no path/token leakage", () => assertNoSensitiveMaterial(snapshot), CORRECTNESS_CAP);
  return result(ctx, `${count} independent 1 MiB imports completed with four out-of-order chunks, replay, latency/throughput, and snapshot coverage verification`);
}

function partialRows(importIndex) {
  return rowsFixture(100, { prefix: `perf-${importIndex}`, invalidEvery: 10 });
}

async function e03(ctx) {
  const scale = formalPerfScale();
  const count = scaledCount(5_000);
  const catalog = ctx.catalog("perf-partial");
  const { api, workers } = await startScenario(ctx, { catalogs: catalog, workers: 4 });
  const jobs = new Array(count);
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }, (_, index) => index), 32, async (index) => {
    const bytes = ndjsonBytes(partialRows(index));
    const start = performance.now();
    const created = await ctx.createImport(api.baseUrl, catalog, bytes, { key: ctx.key(`perf-partial-create-${index}`) });
    assert.equal(created.status, 200, created.text);
    const importId = created.json.importId;
    const piece = splitBytes(bytes, 1)[0];
    const chunk = await ctx.putChunk(api.baseUrl, importId, bytes.length, piece, { key: ctx.key(`perf-partial-upload-${index}`) });
    assert.equal(chunk.status, 200, chunk.text);
    const complete = await ctx.completeImport(api.baseUrl, importId, ctx.key(`perf-partial-complete-${index}`));
    assert.equal(complete.status, 200, complete.text);
    await waitForImport(ctx, api.baseUrl, importId, "VALIDATED", { timeoutMs: 120_000, processes: workers });
    const commit = await ctx.commitImport(api.baseUrl, importId, ctx.key(`perf-partial-commit-${index}`));
    assert.equal(commit.status, 200, commit.text);
    const terminal = await waitForImport(ctx, api.baseUrl, importId, "PARTIALLY_COMMITTED", { timeoutMs: 120_000, processes: workers });
    assert.deepEqual([terminal.totalRows, terminal.validRows, terminal.invalidRows], [100, 90, 10]);
    jobs[index] = { importId, durationMs: performance.now() - start };
  });
  const elapsedMs = performance.now() - startedAt;
  const { throughput, p95 } = performanceSummary(ctx, "committedImports", scale, count, jobs.map(({ durationMs }) => durationMs), elapsedMs);
  if (scale === 1) {
    ctx.ok("5,000-import throughput is at least 20 committed imports/s", throughput >= 20, `observed ${throughput}`);
    ctx.ok("5,000-import p95 is at most 2,500 ms", p95 <= 2_500, `observed ${p95}`);
  }
  const ids = new Set(jobs.map(({ importId }) => importId));
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl, { timeoutMs: 180_000 });
    const relevant = workOf(value).filter(({ aggregateId, kind }) => ids.has(aggregateId) && ["IMPORT_VALIDATE", "IMPORT_COMMIT", "ERROR_REPORT"].includes(kind));
    return relevant.length === count * 3 && relevant.every(({ terminal, state }) => terminal === true && state === "SUCCEEDED") ? value : undefined;
  }, { timeoutMs: 180_000, intervalMs: 500, label: "partial-load Work and reports to drain", processes: workers });
  const imports = resource(snapshot, "imports").filter(({ importId }) => ids.has(importId));
  const findings = resource(snapshot, "validationFindings").filter(({ importId }) => ids.has(importId));
  const records = resource(snapshot, "committedRecords").filter(({ sourceImportId }) => ids.has(sourceImportId));
  const reports = resource(snapshot, "errorReports").filter(({ importId }) => ids.has(importId));
  ctx.equal("partial workload has every terminal ImportJob", imports.length, count, CORRECTNESS_CAP);
  ctx.equal("partial workload publishes exactly 90 records/import", records.length, count * 90, CORRECTNESS_CAP);
  ctx.equal("partial workload publishes exactly 10 findings/import", findings.length, count * 10, CORRECTNESS_CAP);
  ctx.equal("partial workload creates one deterministic report/import", reports.length, count, CORRECTNESS_CAP);
  ctx.assert("post-load identities, counts, tenant scope, and Work drain hold", () => {
    assertUnique(records, ({ tenantId, datasetKey, externalRowId }) => `${tenantId}\0${datasetKey}\0${externalRowId}`, "partial-load external identities");
    assertUnique(findings, ({ findingId }) => findingId, "partial-load finding IDs");
    assertUnique(reports, ({ reportId }) => reportId, "partial-load report IDs");
    assertUnique(reports, ({ importId }) => importId, "partial-load report imports");
    assert.ok(records.every(({ tenantId, datasetKey }) => tenantId === catalog.tenant.tenantId && datasetKey === catalog.schema.datasetKey));
    assert.ok(imports.every(({ state, totalRows, validRows, invalidRows }) => state === "PARTIALLY_COMMITTED" && totalRows === validRows + invalidRows));
    const relevantWork = workOf(snapshot).filter(({ aggregateId, kind }) => ids.has(aggregateId) && ["IMPORT_VALIDATE", "IMPORT_COMMIT", "ERROR_REPORT"].includes(kind));
    assert.ok(relevantWork.every(({ terminal, state }) => terminal === true && state === "SUCCEEDED"));
    assertUnique(relevantWork, ({ kind, aggregateId }) => `${kind}\0${aggregateId}`, "partial-load Work identities");
    const events = eventsOf(snapshot).filter(({ aggregateId }) => ids.has(aggregateId));
    assertUnique(events, ({ eventId }) => eventId, "partial-load events");
    assertEventSequences(events);
    for (const importId of ids) {
      for (const type of ["import.created", "import.uploaded", "import.validated", "import.partially_committed"]) {
        assert.equal(events.filter(({ aggregateId, type: actual }) => aggregateId === importId && actual === type).length, 1);
      }
    }
  }, CORRECTNESS_CAP);
  return result(ctx, `${count} 100-row VALID_ROWS imports produced exact 90/10 records/findings with throughput, p95, and post-load invariants`);
}

async function e04(ctx) {
  const scale = formalPerfScale();
  const count = scaledCount(10_000, 2);
  const catalog = ctx.catalog("perf-recovery");
  const { api } = await startScenario(ctx, { catalogs: catalog });
  const jobs = new Array(count);
  await ctx.concurrent(Array.from({ length: count }, (_, index) => index), 64, async (index) => {
    const bytes = ndjsonBytes([rowFixture(index, { externalId: `recovery-${index}` })]);
    const created = await ctx.createImport(api.baseUrl, catalog, bytes, { key: ctx.key(`recovery-create-${index}`) });
    assert.equal(created.status, 200, created.text);
    const importId = created.json.importId;
    const piece = splitBytes(bytes, 1)[0];
    assert.equal((await ctx.putChunk(api.baseUrl, importId, bytes.length, piece, { key: ctx.key(`recovery-upload-${index}`) })).status, 200);
    assert.equal((await ctx.completeImport(api.baseUrl, importId, ctx.key(`recovery-complete-${index}`))).status, 200);
    jobs[index] = { importId, bytes: bytes.length, sha256: ctx.sha256(bytes) };
  });
  const ids = new Set(jobs.map(({ importId }) => importId));
  const barrier = await ctx.claimedBarrier();
  const killedWorkers = [await ctx.startWorkerAtBarrier(barrier), await ctx.startWorkerAtBarrier(barrier)];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => !entry.released).length >= 2, {
    timeoutMs: 30_000,
    label: "two claimed validation workers",
    processes: killedWorkers,
  });
  const claimedSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
    const leased = workOf(snapshot).filter(({ kind, aggregateId, state }) => kind === "IMPORT_VALIDATE" && ids.has(aggregateId) && state === "LEASED");
    return leased.length >= 2 ? { snapshot, leased } : undefined;
  }, { timeoutMs: 30_000, intervalMs: 50, label: "two publicly LEASED validation Work rows" });
  ctx.equal("two workers lease distinct validation Work identities", new Set(claimedSnapshot.leased.map(({ workId }) => workId)).size >= 2, true);
  await Promise.all(killedWorkers.map((worker) => ctx.kill(worker)));
  await ctx.sleep(3_250);
  const drainStartedAt = performance.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker(), await ctx.startWorker()];
  const drained = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl, { timeoutMs: 180_000 });
    const validation = workOf(snapshot).filter(({ kind, aggregateId }) => kind === "IMPORT_VALIDATE" && ids.has(aggregateId));
    return validation.length === count && validation.every(({ terminal, state }) => terminal === true && state === "SUCCEEDED") ? snapshot : undefined;
  }, { timeoutMs: 120_000, intervalMs: 500, label: "four replacement workers to drain validation", processes: replacements });
  const drainSeconds = (performance.now() - drainStartedAt) / 1_000;
  ctx.metric("scale", scale);
  ctx.metric("importCount", count);
  ctx.metric("drainSeconds", drainSeconds);
  if (scale === 1) ctx.ok("10,000-import recovery drains within 120 seconds", drainSeconds <= 120, `observed ${drainSeconds}`);
  const imports = resource(drained, "imports").filter(({ importId }) => ids.has(importId));
  const chunks = resource(drained, "uploadChunks").filter(({ importId }) => ids.has(importId));
  const findings = resource(drained, "validationFindings").filter(({ importId }) => ids.has(importId));
  const reports = resource(drained, "errorReports").filter(({ importId }) => ids.has(importId));
  const records = resource(drained, "committedRecords").filter(({ sourceImportId }) => ids.has(sourceImportId));
  ctx.equal("every recovery import validates exactly once", imports.length, count, CORRECTNESS_CAP);
  ctx.equal("valid recovery fixture creates no finding duplicates", findings.length, 0, CORRECTNESS_CAP);
  ctx.equal("valid recovery fixture creates no report duplicates", reports.length, 0, CORRECTNESS_CAP);
  ctx.equal("validation-only recovery creates no committed records", records.length, 0, CORRECTNESS_CAP);
  const expected = new Map(jobs.map((job) => [job.importId, job]));
  ctx.assert("post-load byte, row, Work, and Event invariants all close", () => {
    assert.equal(chunks.length, count);
    for (const job of imports) {
      const source = expected.get(job.importId);
      assert.equal(job.expectedSha256, source.sha256);
      assert.equal(job.receivedBytes, source.bytes);
      assert.deepEqual([job.state, job.totalRows, job.validRows, job.invalidRows], ["VALIDATED", 1, 1, 0]);
    }
    const validation = workOf(drained).filter(({ kind, aggregateId }) => kind === "IMPORT_VALIDATE" && ids.has(aggregateId));
    assertUnique(validation, ({ aggregateId }) => aggregateId, "recovery validation Work");
    assert.ok(validation.filter(({ attempt }) => attempt >= 2).length >= 2);
    const events = eventsOf(drained).filter(({ aggregateId }) => ids.has(aggregateId));
    assertUnique(events, ({ eventId }) => eventId, "recovery events");
    assertEventSequences(events);
    for (const importId of ids) {
      for (const type of ["import.created", "import.uploaded", "import.validated"]) {
        assert.equal(events.filter(({ aggregateId, type: actual }) => aggregateId === importId && actual === type).length, 1);
      }
    }
  }, CORRECTNESS_CAP);
  ctx.assert("post-recovery snapshot contains no managed path or token", () => assertNoSensitiveMaterial(drained), CORRECTNESS_CAP);
  return result(ctx, `${count} completed imports survived two claimed-worker SIGKILLs and drained through four replacements with full public invariants`);
}

export const E_CASES = Object.freeze([
  defineCase({ id: "E-01", fixtureFamily: "F-V1-FINAL historical resources/replays/Work/Event", action: "V1 public workflow, same-DB FINAL migration, replay and Bundle", oracle: "byte-stable public snapshot/resource/replay identity comparison", run: e01 }),
  defineCase({ id: "E-02", fixtureFamily: "published resumable-upload workload", action: "2,000 independent 1 MiB imports, four chunks, 64 clients", oracle: "throughput/p95 plus per-import snapshot interval/digest conservation", run: e02 }),
  defineCase({ id: "E-03", fixtureFamily: "published partial-commit workload", action: "5,000 100-row/10-invalid imports, 32 clients", oracle: "exact 450,000 records/50,000 findings and identity/Work/Event invariants", run: e03 }),
  defineCase({ id: "E-04", fixtureFamily: "published validation-recovery workload", action: "10,000 completed imports, two claimed SIGKILLs, four replacements", oracle: "120-second drain and byte/row/Work/Event uniqueness", run: e04 }),
]);
