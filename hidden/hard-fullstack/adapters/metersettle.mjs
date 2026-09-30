import assert from "node:assert/strict";

import { measuredLoad, percentile, performanceScale } from "../performance-runtime.mjs";
import { standardAdapter } from "../standard-adapter.mjs";

const ids = {
  tenant: "20000000-0000-4000-8000-000000000001",
  meters: [
    "20000000-0000-4000-8000-000000000011",
    "20000000-0000-4000-8000-000000000012",
  ],
};
const unitPriceMinor = 3;

const spec = {
  label: "MeterSettle usage batch",
  performanceScenarioIds: ["usage-batch-ingest", "statement-read", "rating-recovery"],
  seed: async () => seed(),
  path: "/api/v1/usage-batches",
  payload: (index) => usageBatch(index),
  perfPayload: (index) => performanceBatch(index),
  conflictPayload: (index) => ({ ...usageBatch(index), events: [{ ...usageBatch(index).events[0], quantity: index + 2 }] }),
  resource: "usageBatches",
  identity: (value) => batchOf(value)?.batchId,
  resourceIdentity: ({ batchId }) => batchId,
  noWork: true,
  workIdentity: (value) => value?.workAggregateId,
  prepareWork,
  minimumThroughput: 10,
  maximumP95Ms: 400,
  performance: sustainedPerformance,
  cases: {
    "H-03": mainFlow,
    "H-04": atomicRejection,
    "H-06": multiProcessContention,
    "H-09": v1Migration,
    "H-10": correctionBehavior,
    "H-11": correctionRecovery,
  },
};

export default standardAdapter(spec);

function seed() {
  return {
    schemaVersion: 1,
    seedVersion: "hidden-metersettle-v1",
    importedAt: "2026-03-01T00:00:00.000Z",
    tenants: [{ tenantId: ids.tenant, name: "Hidden Tenant", watermarkThrough: null }],
    meterDefinitions: ids.meters.map((meterId, index) => ({
      meterId,
      tenantId: ids.tenant,
      name: `Hidden Meter ${index + 1}`,
    })),
    ratePlans: [{
      tenantId: ids.tenant,
      version: 1,
      effectiveFrom: "2025-01-01T00:00:00.000Z",
      effectiveTo: null,
      unitPriceMinor,
    }],
    usageEvents: [{
      eventId: "seed-existing",
      meterId: ids.meters[0],
      tenantId: ids.tenant,
      occurredAt: "2026-01-05T00:00:00.000Z",
      quantity: 5,
    }],
  };
}

function usageBatch(index = 0, { count = 1, occurredAt = "2026-12-15T00:00:00.000Z", prefix = "hidden" } = {}) {
  return {
    tenantId: ids.tenant,
    events: Array.from({ length: count }, (_, member) => ({
      eventId: `${prefix}-${index}-${member}`,
      meterId: ids.meters[(index + member) % ids.meters.length],
      occurredAt,
      quantity: 1,
    })),
  };
}

function performanceBatch(index) {
  return usageBatch(index, { count: 100, prefix: "perf-measured" });
}

function batchOf(value) {
  return value?.usageBatch ?? value?.batch ?? value;
}

function withoutAsOf(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}

function successful(status) {
  return status >= 200 && status < 300;
}

async function setup(ctx, workspace = ctx.workspace) {
  await ctx.prepare(workspace);
  const imported = await ctx.seed(seed(), workspace);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return ctx.startApi(workspace);
}

async function ingest(ctx, baseUrl, key, payload) {
  const response = await ctx.mutate(baseUrl, "/api/v1/usage-batches", key, payload);
  assert.equal(response.status, 202, response.text);
  assert.equal(typeof batchOf(response.json).batchId, "string");
  return response;
}

async function advanceWatermark(ctx, baseUrl, key, through) {
  const response = await ctx.mutate(baseUrl, `/api/v1/tenants/${ids.tenant}/watermark`, key, { through });
  assert.equal(successful(response.status), true, response.text);
  return response;
}

function statementForEvent(snapshot, eventId) {
  return snapshot.resources.statements.find((statement) => statement.lines.some((line) => line.eventId === eventId));
}

async function waitForFinalizedEvents(ctx, baseUrl, eventIds, children = []) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return eventIds.every((eventId) => statementForEvent(snapshot, eventId)?.state === "FINALIZED")
      ? snapshot
      : undefined;
  }, { timeoutMs: 60_000, label: `Statements for ${eventIds.join(", ")} to finalize`, children });
}

async function prepareWork(ctx, baseUrl) {
  const payload = usageBatch(700, { occurredAt: "2026-01-20T00:00:00.000Z", prefix: "h07" });
  await ingest(ctx, baseUrl, "h07-ingest", payload);
  await advanceWatermark(ctx, baseUrl, "h07-watermark", "2026-02-01T00:00:00.000Z");
  const snapshot = await ctx.snapshot(baseUrl);
  const work = snapshot.work.find(({ kind, terminal }) => kind === "RATING" && !terminal);
  assert.ok(work, "watermark did not schedule RATING Work");
  return { json: { workAggregateId: work.aggregateId } };
}

async function mainFlow(ctx, assertions) {
  const api = await setup(ctx);
  const payload = {
    tenantId: ids.tenant,
    events: [
      { eventId: "h03-first", meterId: ids.meters[0], occurredAt: "2026-01-10T00:00:00.000Z", quantity: 7 },
      { eventId: "h03-second", meterId: ids.meters[1], occurredAt: "2026-01-20T00:00:00.000Z", quantity: 11 },
    ],
  };
  const accepted = await ingest(ctx, api.baseUrl, "h03-ingest", payload);
  assert.deepEqual(batchOf(accepted.json).acceptedEventIds, ["h03-first", "h03-second"]);
  await advanceWatermark(ctx, api.baseUrl, "h03-watermark", "2026-02-01T00:00:00.000Z");
  const worker = await ctx.startWorker();
  const final = await waitForFinalizedEvents(ctx, api.baseUrl, payload.events.map(({ eventId }) => eventId), [worker]);
  const statement = statementForEvent(final, "h03-first");
  assert.equal(statement, statementForEvent(final, "h03-second"));
  assert.equal(statement.lines.reduce((sum, line) => sum + line.quantity, 0), statement.totalQuantity);
  assert.equal(statement.lines.reduce((sum, line) => sum + line.chargeMinor, 0), statement.totalMinor);
  for (const event of payload.events) {
    const line = statement.lines.find(({ eventId }) => eventId === event.eventId);
    assert.equal(line.ratePlanVersion, 1);
    assert.equal(line.unitPriceMinor, unitPriceMinor);
    assert.equal(line.chargeMinor, event.quantity * unitPriceMinor);
  }
  assert.equal(final.work.filter(({ kind, terminal }) => kind === "RATING" && !terminal).length, 0);
  assert.equal(final.events.some(({ type }) => type === "usage.batch-accepted"), true);
  assert.equal(final.events.some(({ type }) => type === "watermark.advanced"), true);
  assert.equal(final.events.some(({ type }) => type === "statement.finalized"), true);
  assertions.push("V1 batch ingestion, occurredAt rating, watermark finalization, totals, work, and events agree");
}

async function atomicRejection(ctx, assertions) {
  const api = await setup(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const conflict = await ctx.mutate(api.baseUrl, "/api/v1/usage-batches", "h04-conflict", {
    tenantId: ids.tenant,
    events: [
      { eventId: "h04-new", meterId: ids.meters[1], occurredAt: "2026-01-10T00:00:00.000Z", quantity: 1 },
      { eventId: "seed-existing", meterId: ids.meters[0], occurredAt: "2026-01-05T00:00:00.000Z", quantity: 6 },
    ],
  });
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(conflict.json?.error?.code, "EVENT_ID_CONFLICT");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(before));

  const uncovered = await ctx.mutate(api.baseUrl, "/api/v1/usage-batches", "h04-rate", {
    tenantId: ids.tenant,
    events: [{ eventId: "h04-unrated", meterId: ids.meters[0], occurredAt: "2024-12-31T23:59:59.999Z", quantity: 1 }],
  });
  assert.equal(uncovered.status, 409, uncovered.text);
  assert.equal(uncovered.json?.error?.code, "RATE_PLAN_UNAVAILABLE");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(before));
  assertions.push("event conflicts and uncovered Rate Plans reject the whole batch without usage, work, Statement, or event changes");
}

async function multiProcessContention(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const results = await ctx.concurrent(Array.from({ length: 40 }), 40, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/usage-batches",
    `h06-${index}`,
    {
      tenantId: ids.tenant,
      events: [{
        eventId: "h06-race",
        meterId: ids.meters[0],
        occurredAt: "2026-12-10T00:00:00.000Z",
        quantity: index % 2 ? 7 : 8,
      }],
    },
  ));
  const accepted = results.filter(({ status }) => status === 202);
  const rejected = results.filter(({ status, json }) => status === 409 && json?.error?.code === "EVENT_ID_CONFLICT");
  assert.equal(accepted.length, 20);
  assert.equal(rejected.length, 20);
  const snapshot = await ctx.snapshot(apiB.baseUrl);
  const events = snapshot.resources.usageEvents.filter(({ eventId }) => eventId === "h06-race");
  assert.equal(events.length, 1);
  assert.ok([7, 8].includes(events[0].quantity));
  assert.equal(accepted.every(({ json }) => {
    const batch = batchOf(json);
    return batch.acceptedEventIds.includes("h06-race") || batch.duplicateEventIds.includes("h06-race");
  }), true);
  assertions.push("two APIs converge on one tenant event semantic while identical contenders replay and conflicting contenders roll back");
}

async function v1Migration(ctx, assertions) {
  const v1Workspace = await ctx.copyV1Workspace();
  const v1Api = await setup(ctx, v1Workspace);
  const payload = usageBatch(900, { occurredAt: "2026-01-15T00:00:00.000Z", prefix: "h09" });
  const accepted = await ingest(ctx, v1Api.baseUrl, "h09-saved", payload);
  await advanceWatermark(ctx, v1Api.baseUrl, "h09-watermark", "2026-02-01T00:00:00.000Z");
  const before = await ctx.snapshot(v1Api.baseUrl);
  const statement = before.resources.statements.find(({ state }) => state === "FINALIZING");
  assert.ok(statement, "V1 watermark did not create a FINALIZING Statement");
  const beforeWork = before.work.find(({ aggregateId }) => aggregateId === statement.statementId);
  const beforeEvents = before.events.map(({ eventId, aggregateId, sequence, type, payload: body }) => ({ eventId, aggregateId, sequence, type, body }));
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/usage-batches", "h09-saved", payload);
  assert.equal(replay.status, accepted.status);
  assert.equal(replay.text, accepted.text);
  const migrated = await ctx.snapshot(finalApi.baseUrl);
  assert.deepEqual(migrated.resources.correctionEvents, []);
  assert.deepEqual(migrated.resources.statementRevisions, []);
  const migratedStatement = migrated.resources.statements.find(({ statementId }) => statementId === statement.statementId);
  assert.equal(migratedStatement.revision, 1);
  assert.equal(migratedStatement.state, statement.state);
  assert.deepEqual(migrated.work.find(({ aggregateId }) => aggregateId === statement.statementId), beforeWork);
  assert.deepEqual(
    migrated.events.map(({ eventId, aggregateId, sequence, type, payload: body }) => ({ eventId, aggregateId, sequence, type, body })),
    beforeEvents,
  );
  const worker = await ctx.startWorker();
  await waitForFinalizedEvents(ctx, finalApi.baseUrl, [payload.events[0].eventId], [worker]);
  assertions.push("V1 replay bytes, revision-1 Statement, pending Rating Work, Watermark, and event identity survive FINAL migration");
}

async function finalizedFixture(ctx, events) {
  const api = await setup(ctx);
  await ingest(ctx, api.baseUrl, "fixture-ingest", { tenantId: ids.tenant, events });
  await advanceWatermark(ctx, api.baseUrl, "fixture-watermark", "2026-03-01T00:00:00.000Z");
  const worker = await ctx.startWorker();
  const snapshot = await waitForFinalizedEvents(ctx, api.baseUrl, events.map(({ eventId }) => eventId), [worker]);
  await ctx.stop(worker);
  return { api, snapshot };
}

async function correctionBehavior(ctx, assertions) {
  const sourceEvents = [
    { eventId: "h10-source-jan", meterId: ids.meters[0], occurredAt: "2026-01-10T00:00:00.000Z", quantity: 10 },
    { eventId: "h10-source-feb", meterId: ids.meters[1], occurredAt: "2026-02-10T00:00:00.000Z", quantity: 20 },
  ];
  const { api, snapshot: base } = await finalizedFixture(ctx, sourceEvents);
  const jan = statementForEvent(base, "h10-source-jan");
  const feb = statementForEvent(base, "h10-source-feb");
  assert.notEqual(jan.statementId, feb.statementId);
  const negative = await ctx.mutate(api.baseUrl, "/api/v1/correction-batches", "h10-negative", {
    tenantId: ids.tenant,
    corrections: [{ correctionId: "corr-negative", sourceEventId: "h10-source-jan", quantityDelta: -11, reason: "invalid", occurredAt: "2026-04-01T00:00:00.000Z" }],
  });
  assert.equal(negative.status, 409, negative.text);
  assert.equal(negative.json?.error?.code, "NEGATIVE_EFFECTIVE_USAGE");
  const overflow = await ctx.mutate(api.baseUrl, "/api/v1/correction-batches", "h10-overflow", {
    tenantId: ids.tenant,
    corrections: [{ correctionId: "corr-overflow", sourceEventId: "h10-source-jan", quantityDelta: Number.MAX_SAFE_INTEGER, reason: "invalid", occurredAt: "2026-04-01T00:00:00.000Z" }],
  });
  assert.equal(overflow.status, 400, overflow.text);
  assert.equal(overflow.json?.error?.code, "CORRECTION_TOTAL_OVERFLOW");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(base));

  const corrections = [
    { correctionId: "corr-z", sourceEventId: "h10-source-jan", quantityDelta: 2, reason: "late adjustment", occurredAt: "2026-04-01T00:00:00.000Z" },
    { correctionId: "corr-a", sourceEventId: "h10-source-jan", quantityDelta: -1, reason: "late adjustment", occurredAt: "2026-04-01T00:00:01.000Z" },
    { correctionId: "corr-m", sourceEventId: "h10-source-feb", quantityDelta: 3, reason: "late adjustment", occurredAt: "2026-04-01T00:00:02.000Z" },
  ];
  const accepted = await ctx.mutate(api.baseUrl, "/api/v1/correction-batches", "h10-corrections", { tenantId: ids.tenant, corrections });
  assert.equal(successful(accepted.status), true, accepted.text);
  const worker = await ctx.startWorker();
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const revisions = snapshot.resources.statementRevisions.filter(({ statementId }) => [jan.statementId, feb.statementId].includes(statementId));
    return revisions.length === 2 && revisions.every(({ state }) => state === "FINALIZED") ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "two correction revisions to finalize", children: [worker] });

  const janRevision = final.resources.statementRevisions.find(({ statementId }) => statementId === jan.statementId);
  assert.equal(janRevision.revision, 2);
  assert.deepEqual(janRevision.correctionIds, ["corr-a", "corr-z"]);
  assert.equal(janRevision.priorTotalMinor, jan.totalMinor);
  assert.equal(janRevision.deltaMinor, unitPriceMinor);
  assert.equal(janRevision.effectiveTotalMinor, jan.totalMinor + unitPriceMinor);
  const febRevision = final.resources.statementRevisions.find(({ statementId }) => statementId === feb.statementId);
  assert.equal(febRevision.deltaMinor, 3 * unitPriceMinor);
  assert.equal(febRevision.effectiveTotalMinor, feb.totalMinor + 3 * unitPriceMinor);

  for (const statement of [jan, feb]) {
    const detail = await ctx.request(api.baseUrl, `/api/v1/statements/${statement.statementId}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.json.pendingRevision, null);
    assert.equal(detail.json.effectiveTotalMinor, final.resources.statementRevisions.find(({ statementId }) => statementId === statement.statementId).effectiveTotalMinor);
  }
  assert.equal(final.events.filter(({ type }) => type === "statement.revision-finalized").length, 2);
  assertions.push("one Correction batch groups two periods into ordered, exact, independently finalized Statement revisions");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function correctionRecovery(ctx, assertions) {
  const source = { eventId: "h11-source", meterId: ids.meters[0], occurredAt: "2026-01-12T00:00:00.000Z", quantity: 20 };
  const { api } = await finalizedFixture(ctx, [source]);
  const apiB = await ctx.startApi();
  const payloads = [2, 3].map((quantityDelta, index) => ({
    tenantId: ids.tenant,
    corrections: [{
      correctionId: `h11-correction-${index + 1}`,
      sourceEventId: source.eventId,
      quantityDelta,
      reason: "concurrent correction",
      occurredAt: `2026-04-02T00:00:0${index}.000Z`,
    }],
  }));
  const attempts = await ctx.concurrent(payloads, 2, (payload, index) => ctx.mutate(
    index ? apiB.baseUrl : api.baseUrl,
    "/api/v1/correction-batches",
    `h11-race-${index}`,
    payload,
  ));
  const winner = attempts.findIndex(({ status }) => successful(status));
  const loser = winner === 0 ? 1 : 0;
  assert.notEqual(winner, -1);
  assert.equal(attempts.filter(({ status }) => successful(status)).length, 1);
  assert.equal(attempts[loser].status, 409, attempts[loser].text);
  assert.equal(attempts[loser].json?.error?.code, "STATEMENT_REVISION_PENDING");

  const held = deferred();
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.before-commit" ? held.promise : { status: 204 });
  const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h11-meter" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.before-commit"), {
    timeoutMs: 30_000,
    label: "revision worker before-commit barrier",
    children: [first],
  });
  await ctx.stop(first, "SIGKILL");
  held.resolve({ status: 204 });
  const replacement = await ctx.startWorker();
  const firstFinal = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const revisions = snapshot.resources.statementRevisions.filter(({ state }) => state === "FINALIZED");
    return revisions.length === 1 ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "revision 2 recovery", children: [replacement] });
  assert.equal(firstFinal.resources.statementRevisions[0].revision, 2);
  assert.deepEqual(firstFinal.resources.statementRevisions[0].correctionIds, [payloads[winner].corrections[0].correctionId]);
  assert.equal(firstFinal.events.filter(({ type }) => type === "statement.revision-finalized").length, 1);
  await ctx.stop(replacement);

  const retry = await ctx.mutate(apiB.baseUrl, "/api/v1/correction-batches", "h11-loser-retry", payloads[loser]);
  assert.equal(successful(retry.status), true, retry.text);
  const finalWorker = await ctx.startWorker();
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiB.baseUrl);
    const revisions = snapshot.resources.statementRevisions.filter(({ state }) => state === "FINALIZED");
    return revisions.length === 2 ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "revision 3 to finalize", children: [finalWorker] });
  assert.deepEqual(final.resources.statementRevisions.map(({ revision }) => revision), [2, 3]);
  assert.equal(final.resources.statementRevisions[1].priorTotalMinor, final.resources.statementRevisions[0].effectiveTotalMinor);
  assert.equal(final.events.filter(({ type }) => type === "statement.revision-finalized").length, 2);
  assertions.push("concurrent corrections serialize, rejected work retries after revision 2, and SIGKILL recovery preserves gapless revisions");
}

async function sustainedPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];

  const ingestMetric = await meterPerformanceDatabase(ctx, async ({ apiA, apiB, initialEventCount }) => {
    const warmupCount = Math.max(1, Math.floor(100 * scale));
    const measuredCount = Math.max(1, Math.floor(600 * scale));
    await fixedRateLoad(ctx, {
      count: warmupCount,
      durationMs: 10_000 * scale,
      concurrency: 64,
      request: async (ordinal) => {
        const response = await ctx.mutate(
          ordinal % 2 ? apiA.baseUrl : apiB.baseUrl,
          "/api/v1/usage-batches",
          `perf-warmup-${ordinal}`,
          perfUsageBatch("warmup", ordinal),
        );
        assert.equal(response.status, 202, response.text);
        return response;
      },
    });
    const measured = await fixedRateLoad(ctx, {
      count: measuredCount,
      durationMs: 60_000 * scale,
      concurrency: 64,
      request: async (ordinal) => {
        const response = await ctx.mutate(
          ordinal % 2 ? apiA.baseUrl : apiB.baseUrl,
          "/api/v1/usage-batches",
          `perf-measured-${ordinal}`,
          perfUsageBatch("measured", ordinal),
        );
        assert.equal(response.status, 202, response.text);
        return response;
      },
    });
    assert.equal(Object.entries(measured.statuses).every(([status]) => Number(status) === 202), true);
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    assert.equal(snapshot.resources.usageEvents.length, initialEventCount + (warmupCount + measuredCount) * 100);
    return measured;
  });
  assert.ok(ingestMetric.throughput >= 10, `usage-batch-ingest throughput ${ingestMetric.throughput.toFixed(1)} < 10 batches/s`);
  assert.ok(ingestMetric.p95 <= 400, `usage-batch-ingest p95 ${ingestMetric.p95.toFixed(1)}ms > 400ms`);
  metrics.push({ scenarioId: "usage-batch-ingest", acceptedEventsPerSecond: ingestMetric.throughput * 100, ...ingestMetric });
  assertions.push(`usage-batch-ingest: ${(ingestMetric.throughput * 100).toFixed(1)} events/s, batch p95 ${ingestMetric.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const statementRead = await meterPerformanceDatabase(ctx, async ({ apiA, apiB, tenantIds }) => {
    await advanceAllWatermarks(ctx, apiA.baseUrl, tenantIds);
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const finalized = await waitForPerformanceRating(ctx, apiA.baseUrl, workers);
    await Promise.all(workers.map((worker) => ctx.stop(worker)));
    const statementIds = finalized.resources.statements
      .filter(({ state }) => state === "FINALIZED")
      .map(({ statementId }) => statementId)
      .sort();
    let sequence = 0;
    return measuredLoad(ctx, {
      concurrency: 64,
      warmupMs: 10_000 * scale,
      measureMs: 60_000 * scale,
      request: async () => {
        const ordinal = sequence++;
        const response = await ctx.request(
          ordinal % 2 ? apiA.baseUrl : apiB.baseUrl,
          `/api/v1/statements/${statementIds[ordinal % statementIds.length]}`,
        );
        assert.equal(response.status, 200, response.text);
        const statement = response.json?.statement ?? response.json;
        assert.equal(statement.lines.reduce((sum, line) => sum + line.quantity, 0), statement.totalQuantity);
        assert.equal(statement.lines.reduce((sum, line) => sum + line.chargeMinor, 0), statement.totalMinor);
        return response;
      },
    });
  });
  assert.ok(statementRead.throughput >= 200, `statement-read throughput ${statementRead.throughput.toFixed(1)} < 200/s`);
  assert.ok(statementRead.p95 <= 150, `statement-read p95 ${statementRead.p95.toFixed(1)}ms > 150ms`);
  assert.equal(statementRead.statuses[500] ?? 0, 0);
  metrics.push({ scenarioId: "statement-read", ...statementRead });
  assertions.push(`statement-read: ${statementRead.throughput.toFixed(1)}/s, p95 ${statementRead.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const recovery = await meterPerformanceDatabase(ctx, async ({ apiA, tenantIds }) => {
    await advanceAllWatermarks(ctx, apiA.baseUrl, tenantIds);
    const held = deferred();
    const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held.promise : { status: 204 });
    const killed = [
      await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-meter" }),
      await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-meter" }),
    ];
    await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, {
      timeoutMs: 30_000,
      label: "two claimed Rating Tasks",
      children: killed,
    });
    await Promise.all(killed.map((worker) => ctx.stop(worker, "SIGKILL")));
    held.resolve({ status: 204 });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const startedAt = Date.now();
    const replacements = [await ctx.startWorker(), await ctx.startWorker()];
    const snapshot = await waitForPerformanceRating(ctx, apiA.baseUrl, replacements);
    const durationMs = Date.now() - startedAt;
    assert.ok(durationMs <= 60_000, `rating-recovery took ${durationMs}ms`);
    assert.equal(snapshot.resources.statements.reduce((sum, statement) => sum + statement.lines.length, 0), 10_000);
    assert.equal(new Set(snapshot.resources.statements.flatMap(({ lines }) => lines.map(({ eventId }) => eventId))).size, 10_000);
    return { completedRatedLines: 10_000, durationMs, killedWorkers: 2, replacementWorkers: 2 };
  });
  metrics.push({ scenarioId: "rating-recovery", ...recovery });
  assertions.push(`rating-recovery: ${recovery.completedRatedLines} lines finalized in ${recovery.durationMs}ms after two SIGKILLs`);
  return { metrics, fixtureSummary: { tenants: 100, meterDefinitions: 10_000, ratePlans: 100, usageEvents: 1_000_000, closedUnfinalizedEvents: 10_000 } };
}

async function fixedRateLoad(ctx, { count, durationMs, concurrency, request }) {
  const startedAt = Date.now();
  const responses = await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, ordinal) => {
    const scheduledAt = startedAt + ordinal * durationMs / count;
    const delayMs = scheduledAt - Date.now();
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return request(ordinal);
  });
  const latencies = responses.map(({ durationMs: latency }) => latency).sort((left, right) => left - right);
  const statuses = {};
  for (const { status } of responses) statuses[status] = (statuses[status] ?? 0) + 1;
  return {
    completed: responses.length,
    throughput: responses.length / (durationMs / 1_000),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    statuses,
  };
}

function perfUuid(namespace, ordinal) {
  return `${String(namespace).padStart(8, "0")}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function meterPerformanceSeed() {
  const tenants = Array.from({ length: 100 }, (_, index) => ({
    tenantId: perfUuid(1, index),
    name: `Tenant ${index}`,
    watermarkThrough: null,
  }));
  const meterDefinitions = Array.from({ length: 10_000 }, (_, index) => ({
    meterId: perfUuid(2, index),
    tenantId: tenants[index % tenants.length].tenantId,
    name: `Meter ${index}`,
  }));
  const ratePlans = tenants.map(({ tenantId }) => ({
    tenantId,
    version: 1,
    effectiveFrom: "2025-01-01T00:00:00.000Z",
    effectiveTo: null,
    unitPriceMinor: 2,
  }));
  const usageEvents = Array.from({ length: 1_000_000 }, (_, index) => ({
    eventId: `seed-${index}`,
    meterId: meterDefinitions[index % meterDefinitions.length].meterId,
    tenantId: meterDefinitions[index % meterDefinitions.length].tenantId,
    occurredAt: index < 10_000 ? "2025-12-15T00:00:00.000Z" : "2026-01-01T00:00:00.000Z",
    quantity: 1,
  }));
  return {
    schemaVersion: 1,
    seedVersion: "perf-v1",
    importedAt: "2026-01-01T00:00:00.000Z",
    tenants,
    meterDefinitions,
    ratePlans,
    usageEvents,
  };
}

function perfUsageBatch(phase, ordinal) {
  const tenantIndex = ordinal % 100;
  return {
    tenantId: perfUuid(1, tenantIndex),
    events: Array.from({ length: 100 }, (_, member) => ({
      eventId: `perf-${phase}-${ordinal}-${member}`,
      meterId: perfUuid(2, tenantIndex + (member % 100) * 100),
      occurredAt: "2026-01-15T00:00:00.000Z",
      quantity: 1,
    })),
  };
}

async function meterPerformanceDatabase(ctx, operation) {
  await ctx.prepare();
  const data = meterPerformanceSeed();
  const imported = await ctx.seed(data);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const apiA = await ctx.startApi();
  const apiB = await ctx.startApi();
  return operation({
    apiA,
    apiB,
    initialEventCount: data.usageEvents.length,
    tenantIds: data.tenants.map(({ tenantId }) => tenantId),
  });
}

async function advanceAllWatermarks(ctx, baseUrl, tenantIds) {
  await ctx.concurrent(tenantIds, 20, (tenantId, index) => ctx.mutate(
    baseUrl,
    `/api/v1/tenants/${tenantId}/watermark`,
    `perf-watermark-${index}`,
    { through: "2026-01-01T00:00:00.000Z" },
  ).then((response) => assert.equal(successful(response.status), true, response.text)));
}

async function waitForPerformanceRating(ctx, baseUrl, children) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const ratedLines = snapshot.resources.statements.reduce((sum, statement) => sum + statement.lines.length, 0);
    const pending = snapshot.work.some(({ kind, terminal }) => kind === "RATING" && !terminal);
    return ratedLines === 10_000 && !pending
      ? snapshot
      : undefined;
  }, { timeoutMs: 60_000, label: "10,000 rated lines to finalize", children });
}
