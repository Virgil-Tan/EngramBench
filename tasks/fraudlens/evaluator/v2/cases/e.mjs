import assert from "node:assert/strict";
import { assertAuditChains, canonicalJson, evaluateRules } from "../oracles/index.mjs";
import { CaseExcluded } from "../lib/execution.mjs";
import {
  acceptRisk,
  activateVersion,
  assertLoad,
  createVersion,
  defineCase,
  findField,
  fixedLoad,
  guardedCase,
  prepare,
  resources,
  rollbackVersion,
  successful,
  waitAssessment,
  waitLeasedWork,
  waitReviewCase,
} from "./helpers.mjs";

function recordSet(items) {
  return new Set(items.map((item) => canonicalJson(item)));
}

function assertRecordsPreserved(actual, expected, label) {
  const records = recordSet(actual);
  for (const item of expected) assert.ok(records.has(canonicalJson(item)), `${label} record changed during migration`);
}

const E01 = guardedCase("E-01", ["MIGRATION_IDENTITY", "HISTORY_IMMUTABILITY"], async (ctx) => {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  const v1 = ctx.forWorkspace(ctx.v1Workspace);
  await v1.migrate();
  await v1.seed(ctx.fixtures.seed("fl-e01-v1"));
  const apiV1 = await v1.startApi();
  const reviewAccepted = await ctx.mutate(apiV1.baseUrl, "/api/v1/risk-events", ctx.key("e01-review"), ctx.fixtures.event(140_000, { attributes: { velocity: 9, country: "US" } }));
  successful(reviewAccepted, "V1 review event");
  const v1Worker = await v1.startWorker();
  const reviewAssessment = await waitAssessment(ctx, apiV1.baseUrl, ctx.fixtures.event(140_000).externalEventId, { processes: [v1Worker] });
  const { reviewCase } = await waitReviewCase(ctx, apiV1.baseUrl, reviewAssessment.assessment.assessmentId, { processes: [v1Worker] });
  await ctx.stop(v1Worker);
  successful(await ctx.mutate(apiV1.baseUrl, `/api/v1/review-cases/${reviewCase.reviewCaseId}/claim`, ctx.key("e01-claim"), { reviewerId: "migration-reviewer", leaseSeconds: 20 }), "V1 review claim");
  successful(await ctx.mutate(apiV1.baseUrl, `/api/v1/review-cases/${reviewCase.reviewCaseId}/decisions`, ctx.key("e01-decision"), { reviewerId: "migration-reviewer", outcome: "APPROVE", reasonCode: "MIGRATION_BASELINE" }), "V1 ReviewDecision");
  const pendingPayload = ctx.fixtures.event(140_001, { attributes: { velocity: 1, country: "US" } });
  const pendingResponse = successful(await ctx.mutate(apiV1.baseUrl, "/api/v1/risk-events", ctx.key("e01-pending"), pendingPayload), "V1 pending event");
  const pending = await waitAssessment(ctx, apiV1.baseUrl, pendingPayload.externalEventId, { terminal: false });
  assert.equal(pending.assessment.state, "PENDING", "V1 pending Work checkpoint");
  const before = await ctx.snapshot(apiV1.baseUrl);
  const beforeResources = Object.fromEntries(Object.entries(resources(before)).map(([key, value]) => [key, [...value]]));
  const beforeWork = [...before.work];
  const beforeEvents = [...before.events];
  await ctx.stop(apiV1);

  await ctx.migrate();
  const apiFinal = await ctx.startApi();
  const afterMigration = await ctx.snapshot(apiFinal.baseUrl);
  for (const [key, expected] of Object.entries(beforeResources)) assertRecordsPreserved(resources(afterMigration)[key] ?? [], expected, key);
  assertRecordsPreserved(afterMigration.work, beforeWork, "Work");
  assertRecordsPreserved(afterMigration.events, beforeEvents, "Event");
  if (Array.isArray(resources(afterMigration).remediationRuns)) assert.equal(resources(afterMigration).remediationRuns.length, 0, "migration creates no RemediationRun");
  if (Array.isArray(resources(afterMigration).assessmentCorrections)) assert.equal(resources(afterMigration).assessmentCorrections.length, 0, "migration creates no AssessmentCorrection");
  const replay = successful(await ctx.mutate(apiFinal.baseUrl, "/api/v1/risk-events", ctx.key("e01-pending"), pendingPayload), "FINAL saved replay");
  assert.equal(replay.status, pendingResponse.status, "saved replay status preserved");
  assert.equal(replay.text, pendingResponse.text, "saved replay body preserved");
  const finalWorker = await ctx.startWorker();
  const completed = await waitAssessment(ctx, apiFinal.baseUrl, pendingPayload.externalEventId, { processes: [finalWorker] });
  assert.notEqual(completed.assessment.state, "PENDING", "pending V1 Work completes under FINAL");
  assertAuditChains(resources(completed.snapshot).auditEntries);
  ctx.mark("migration.v1-final.closed", { pendingAssessmentId: pending.assessment.assessmentId, reviewCaseId: reviewCase.reviewCaseId });
  return ctx.pass();
});

function assertAssessmentBatch(snapshot, expectedByExternal) {
  const events = new Map(resources(snapshot).riskEvents.map((item) => [item.externalEventId, item]));
  const assessments = new Map(resources(snapshot).assessments.map((item) => [item.riskEventId, item]));
  const versions = new Map(resources(snapshot).ruleVersions.map((item) => [item.ruleVersionId, item]));
  const hits = new Map();
  for (const hit of resources(snapshot).ruleHits) {
    const list = hits.get(hit.assessmentId) ?? [];
    list.push(hit);
    hits.set(hit.assessmentId, list);
  }
  for (const [externalEventId, expectedVersionId] of expectedByExternal) {
    const riskEvent = events.get(externalEventId);
    assert.ok(riskEvent, `RiskEvent ${externalEventId}`);
    const assessment = assessments.get(riskEvent.riskEventId);
    assert.ok(assessment && assessment.state !== "PENDING", `terminal Assessment ${externalEventId}`);
    assert.equal(assessment.ruleVersionId, expectedVersionId, `frozen version ${externalEventId}`);
    const expected = evaluateRules(riskEvent, versions.get(expectedVersionId));
    assert.equal(assessment.score, expected.score, `score ${externalEventId}`);
    assert.equal(assessment.recommendation, expected.recommendation, `recommendation ${externalEventId}`);
    assert.deepEqual((hits.get(assessment.assessmentId) ?? []).map(({ ruleId, priority, score, reasonCode }) => ({ ruleId, priority, score, reasonCode })), expected.ruleHits, `RuleHits ${externalEventId}`);
  }
}

const E02 = guardedCase("E-02", ["VERSION_AUTHORITY", "IDENTITY_ATOMICITY"], async (ctx) => {
  const { apis, workers } = await prepare(ctx, { seedVersion: "fl-e02", apiCount: 4, workerCount: 4 });
  const count = 100_000;
  const expected = new Map();
  const load = await fixedLoad(ctx, {
    count,
    concurrency: 96,
    collectResponses: false,
    request: (index) => {
      const payload = ctx.fixtures.event(1_000_000 + index, { externalEventId: `perf-ingest-${index}` });
      expected.set(payload.externalEventId, ctx.fixtures.ids.baseVersionId);
      return ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/risk-events", ctx.key(`e02-${index}`), payload);
    },
  });
  assertLoad(load, { count, minimumThroughput: 300, maximumP95: 300 });
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
    const ids = new Set(resources(value).riskEvents.filter((item) => item.externalEventId.startsWith("perf-ingest-")).map((item) => item.riskEventId));
    const terminal = resources(value).assessments.filter((item) => ids.has(item.riskEventId) && item.state !== "PENDING");
    return terminal.length === count ? value : undefined;
  }, { timeoutMs: 300_000, intervalMs: 500, label: "100000 terminal Assessments", processes: workers });
  assertAssessmentBatch(snapshot, expected);
  const perfRiskIds = new Set(resources(snapshot).riskEvents.filter((item) => item.externalEventId.startsWith("perf-ingest-")).map((item) => item.riskEventId));
  const perfAssessmentIds = new Set(resources(snapshot).assessments.filter((item) => perfRiskIds.has(item.riskEventId)).map((item) => item.assessmentId));
  assert.equal(perfRiskIds.size, count, "unique ingest RiskEvents");
  assert.equal(perfAssessmentIds.size, count, "unique ingest Assessments");
  assert.ok(snapshot.work.filter((item) => perfAssessmentIds.has(item.aggregateId)).every((item) => item.terminal), "ingest Work drained");
  ctx.mark("perf.risk-event-ingest", { count, throughput: load.throughput, p95: load.p95 });
  return ctx.pass();
});

const E03 = guardedCase("E-03", ["REVIEW_TERMINAL", "TENANT_ISOLATION"], async (ctx) => {
  const { apis, workers } = await prepare(ctx, { seedVersion: "fl-e03", apiCount: 4, workerCount: 4 });
  const count = 20_000;
  await ctx.concurrent(Array.from({ length: count }), 64, async (_, index) => {
    const payload = ctx.fixtures.event(2_000_000 + index, {
      externalEventId: `perf-review-${index}`,
      subjectId: `hot-subject-${index % 100}`,
      attributes: { velocity: 9, country: "US" },
    });
    successful(await ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/risk-events", ctx.key(`e03-risk-${index}`), payload), "hot-subject event");
  });
  const reviewCases = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
    const riskIds = new Set(resources(snapshot).riskEvents.filter((item) => item.externalEventId.startsWith("perf-review-")).map((item) => item.riskEventId));
    const assessmentIds = new Set(resources(snapshot).assessments.filter((item) => riskIds.has(item.riskEventId)).map((item) => item.assessmentId));
    const cases = resources(snapshot).reviewCases.filter((item) => assessmentIds.has(item.assessmentId));
    return cases.length === count ? cases : undefined;
  }, { timeoutMs: 300_000, intervalMs: 500, label: "20000 ReviewCases", processes: workers });
  const load = await fixedLoad(ctx, {
    count,
    concurrency: 64,
    collectResponses: false,
    request: async (index) => {
      const reviewCaseId = reviewCases[index].reviewCaseId;
      const reviewerId = `load-reviewer-${index % 64}`;
      const api = apis[index % apis.length];
      const claim = await ctx.mutate(api.baseUrl, `/api/v1/review-cases/${reviewCaseId}/claim`, ctx.key(`e03-claim-${index}`), { reviewerId, leaseSeconds: 10 });
      if (claim.status < 200 || claim.status >= 300) return claim;
      return ctx.mutate(api.baseUrl, `/api/v1/review-cases/${reviewCaseId}/decisions`, ctx.key(`e03-decision-${index}`), { reviewerId, outcome: index % 2 ? "APPROVE" : "BLOCK", reasonCode: "SUSTAINED_REVIEW" });
    },
  });
  assertLoad(load, { count, minimumThroughput: 180, maximumP95: 700 });
  const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
  const ids = new Set(reviewCases.map((item) => item.reviewCaseId));
  const decisions = resources(snapshot).reviewDecisions.filter((item) => ids.has(item.reviewCaseId));
  assert.equal(decisions.length, count, "one terminal decision per hot ReviewCase");
  assert.equal(new Set(decisions.map((item) => item.reviewCaseId)).size, count, "no duplicate decisions");
  assert.ok(resources(snapshot).riskEvents.filter((item) => item.externalEventId.startsWith("perf-review-")).every((item) => item.tenantId === ctx.fixtures.ids.tenantId), "no cross-tenant hot-subject state");
  ctx.mark("perf.hot-subject-review", { count, subjectCount: 100, throughput: load.throughput, p95: load.p95 });
  return ctx.pass();
});

const E04 = guardedCase("E-04", ["WORK_FENCE", "VERSION_AUTHORITY", "HISTORY_IMMUTABILITY"], async (ctx) => {
  const { apis } = await prepare(ctx, { seedVersion: "fl-e04", apiCount: 4 });
  const strict = await createVersion(ctx, apis[0].baseUrl, "e04-strict", { rules: [ctx.fixtures.rule({ score: 800, ruleId: "boundary-strict" })] });
  await activateVersion(ctx, apis[0].baseUrl, strict.ruleVersionId, ctx.fixtures.ids.baseVersionId, "e04-strict");
  const expected = new Map();
  await ctx.concurrent(Array.from({ length: 5_000 }), 96, async (_, index) => {
    const payload = ctx.fixtures.event(3_000_000 + index, { externalEventId: `perf-boundary-before-${index}`, attributes: { velocity: 9, country: "US" } });
    expected.set(payload.externalEventId, strict.ruleVersionId);
    successful(await ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/risk-events", ctx.key(`e04-before-${index}`), payload), "pre-rollback event");
  });
  await rollbackVersion(ctx, apis[1].baseUrl, strict.ruleVersionId, ctx.fixtures.ids.baseVersionId, "e04-boundary");
  await ctx.concurrent(Array.from({ length: 5_000 }), 96, async (_, index) => {
    const payload = ctx.fixtures.event(3_100_000 + index, { externalEventId: `perf-boundary-after-${index}`, attributes: { velocity: 9, country: "US" } });
    expected.set(payload.externalEventId, ctx.fixtures.ids.baseVersionId);
    successful(await ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/risk-events", ctx.key(`e04-after-${index}`), payload), "post-rollback event");
  });
  const victims = [await ctx.startWorker(), await ctx.startWorker()];
  const leased = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
    const items = snapshot.work.filter((item) => item.kind === "RISK_ASSESSMENT" && item.state === "LEASED");
    return items.length >= 2 && new Set(items.map((item) => item.leaseOwner)).size >= 2 ? items.slice(0, 2) : undefined;
  }, { timeoutMs: 30_000, intervalMs: 10, label: "two publicly leased Assessment Work", processes: victims });
  await Promise.all(victims.map((worker) => ctx.kill(worker)));
  const startedAt = performance.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
    const riskIds = new Set(resources(value).riskEvents.filter((item) => item.externalEventId.startsWith("perf-boundary-")).map((item) => item.riskEventId));
    const assessments = resources(value).assessments.filter((item) => riskIds.has(item.riskEventId));
    return assessments.length === 10_000 && assessments.every((item) => item.state !== "PENDING") ? value : undefined;
  }, { timeoutMs: 90_000, intervalMs: 250, label: "rollback-boundary drain", processes: replacements });
  const drainMs = performance.now() - startedAt;
  assert.ok(drainMs <= 90_000, "rollback-boundary drain within 90 seconds");
  assertAssessmentBatch(snapshot, expected);
  const riskIds = new Set(resources(snapshot).riskEvents.filter((item) => item.externalEventId.startsWith("perf-boundary-")).map((item) => item.riskEventId));
  const assessmentIds = new Set(resources(snapshot).assessments.filter((item) => riskIds.has(item.riskEventId)).map((item) => item.assessmentId));
  assert.ok(snapshot.work.filter((item) => assessmentIds.has(item.aggregateId)).every((item) => item.terminal), "all boundary Work terminal");
  assert.ok(leased.every((item) => snapshot.work.find((candidate) => candidate.workId === item.workId)?.terminal), "killed leases recovered");
  assertAuditChains(resources(snapshot).auditEntries);
  ctx.mark("perf.rollback-boundary-recovery", { count: 10_000, killedWorkers: 2, replacementWorkers: 4, drainMs });
  return ctx.pass();
});

export const E_CASES = [E01, E02, E03, E04];
