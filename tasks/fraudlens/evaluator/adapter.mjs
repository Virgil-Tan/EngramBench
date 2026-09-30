import assert from "node:assert/strict";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const ruleSetId = id(2);
const ruleVersionId = id(3);
let migrationExpected;

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function rule(score, ruleId = "velocity") {
  return { ruleId, priority: 10, field: "attributes.velocity", operator: "GTE", value: 5, score, reasonCode: "HIGH_VELOCITY" };
}

function seed(seedVersion = "hidden-fraudlens") {
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Tenant" }],
    ruleSets: [{ ruleSetId, tenantId, name: "Checkout Risk", activeRuleVersionId: ruleVersionId }],
    ruleVersions: [{ ruleVersionId, ruleSetId, version: 1, state: "ACTIVE", rules: [rule(300)], reviewThreshold: 200, blockThreshold: 700, createdAt: "2026-01-01T00:00:00.000Z", activatedAt: "2026-01-01T00:00:00.000Z" }],
    riskEvents: [], assessments: [], ruleHits: [], reviewCases: [], reviewDecisions: [], ruleRollbacks: [], auditEntries: [],
  };
}

function eventPayload(index, overrides = {}) {
  return {
    tenantId,
    externalEventId: `hidden-risk-${index}`,
    subjectId: `subject-${index % 100}`,
    amountMinor: 10_000 + index,
    currency: "USD",
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
    attributes: { velocity: index % 10, country: index % 3 ? "US" : "GB" },
    ...overrides,
  };
}

async function createVersion(ctx, baseUrl, index, score = 800) {
  const response = await ctx.mutate(baseUrl, `/api/v1/rule-sets/${ruleSetId}/versions`, `version-${index}`, {
    rules: [rule(score, `velocity-${index}`)], reviewThreshold: 200, blockThreshold: 700,
  });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return find(response.json, "ruleVersionId");
}

async function activate(ctx, baseUrl, versionId, key) {
  const response = await ctx.mutate(baseUrl, `/api/v1/rule-versions/${versionId}/activate`, key, { expectedActiveRuleVersionId: ruleVersionId });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return response;
}

async function setupRollback(ctx, baseUrls, index, affectedCount = 1) {
  const urls = Array.isArray(baseUrls) ? baseUrls : [baseUrls];
  const baseUrl = urls[0];
  const fromRuleVersionId = await createVersion(ctx, baseUrl, index);
  await activate(ctx, baseUrl, fromRuleVersionId, `activate-${index}`);
  const events = await ctx.concurrent(Array.from({ length: affectedCount }), Math.min(64, affectedCount), (_, offset) =>
    ctx.mutate(urls[offset % urls.length], "/api/v1/risk-events", `affected-${index}-${offset}`, eventPayload(index * 100_000 + offset, { attributes: { velocity: 9, country: "US" } })));
  assert.ok(events.every(({ status }) => status >= 200 && status < 300));
  const assessmentIds = events.map(({ json }) => find(json, "assessmentId"));
  const assessmentIdSet = new Set(assessmentIds);
  const workers = await Promise.all(Array.from({ length: Math.min(4, Math.max(1, affectedCount)) }, () => ctx.startWorker()));
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const terminal = snapshot.resources.assessments.filter(({ assessmentId, state }) => assessmentIdSet.has(assessmentId) && state !== "PENDING");
    return terminal.length === assessmentIds.length ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "affected assessments", children: workers });
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const rollback = await ctx.mutate(baseUrl, `/api/v1/rule-sets/${ruleSetId}/rollback`, `rollback-${index}`, {
    expectedActiveRuleVersionId: fromRuleVersionId, toRuleVersionId: ruleVersionId, reason: "false positive investigation",
  });
  assert.ok(rollback.status >= 200 && rollback.status < 300, rollback.text);
  const frozen = await ctx.snapshot(baseUrl);
  const riskEventIds = new Set(frozen.resources.assessments
    .filter(({ assessmentId }) => assessmentIdSet.has(assessmentId))
    .map(({ riskEventId }) => riskEventId));
  const reviewCaseIds = new Set(frozen.resources.reviewCases
    .filter(({ assessmentId }) => assessmentIdSet.has(assessmentId))
    .map(({ reviewCaseId }) => reviewCaseId));
  return {
    fromRuleVersionId,
    assessmentIds,
    preserved: {
      riskEvents: ctx.canonical(frozen.resources.riskEvents.filter(({ riskEventId }) => riskEventIds.has(riskEventId))),
      assessments: ctx.canonical(frozen.resources.assessments.filter(({ assessmentId }) => assessmentIdSet.has(assessmentId))),
      ruleHits: ctx.canonical(frozen.resources.ruleHits.filter(({ assessmentId }) => assessmentIdSet.has(assessmentId))),
      reviewDecisions: ctx.canonical(frozen.resources.reviewDecisions.filter(({ reviewCaseId }) => reviewCaseIds.has(reviewCaseId))),
    },
  };
}

function assertPreservedAssessments(ctx, snapshot, expected) {
  const assessmentIds = new Set(expected.assessmentIds);
  const riskEventIds = new Set(snapshot.resources.assessments
    .filter(({ assessmentId }) => assessmentIds.has(assessmentId))
    .map(({ riskEventId }) => riskEventId));
  const reviewCaseIds = new Set(snapshot.resources.reviewCases
    .filter(({ assessmentId }) => assessmentIds.has(assessmentId))
    .map(({ reviewCaseId }) => reviewCaseId));
  assert.equal(ctx.canonical(snapshot.resources.riskEvents.filter(({ riskEventId }) => riskEventIds.has(riskEventId))), expected.preserved.riskEvents);
  assert.equal(ctx.canonical(snapshot.resources.assessments.filter(({ assessmentId }) => assessmentIds.has(assessmentId))), expected.preserved.assessments);
  assert.equal(ctx.canonical(snapshot.resources.ruleHits.filter(({ assessmentId }) => assessmentIds.has(assessmentId))), expected.preserved.ruleHits);
  assert.equal(ctx.canonical(snapshot.resources.reviewDecisions.filter(({ reviewCaseId }) => reviewCaseIds.has(reviewCaseId))), expected.preserved.reviewDecisions);
}

function assertRecordsPreserved(ctx, actual, expected) {
  const records = new Set(actual.map((item) => ctx.canonical(item)));
  for (const item of expected) assert.ok(records.has(ctx.canonical(item)), "V1 record changed during FINAL migration");
}

async function prepareMigrationState(ctx, api, workspace) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/risk-events", "h09-reviewed-event", eventPayload(90_001, {
    attributes: { velocity: 9, country: "US" },
  }));
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  const assessmentId = find(response.json, "assessmentId");
  const worker = await ctx.startWorker({}, workspace);
  const reviewCase = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.reviewCases.find((item) => item.assessmentId === assessmentId && item.state === "OPEN");
  }, { label: "V1 review case", children: [worker] });
  await ctx.stop(worker);
  const reviewerId = "h09-reviewer";
  const claimed = await ctx.mutate(api.baseUrl, `/api/v1/review-cases/${reviewCase.reviewCaseId}/claim`, "h09-review-claim", { reviewerId, leaseSeconds: 20 });
  assert.ok(claimed.status >= 200 && claimed.status < 300, claimed.text);
  const decided = await ctx.mutate(api.baseUrl, `/api/v1/review-cases/${reviewCase.reviewCaseId}/decisions`, "h09-review-decision", {
    reviewerId, outcome: "APPROVE", reasonCode: "MIGRATION_BASELINE",
  });
  assert.ok(decided.status >= 200 && decided.status < 300, decided.text);
  const snapshot = await ctx.snapshot(api.baseUrl);
  const riskEventId = find(response.json, "riskEventId");
  migrationExpected = {
    resources: {
      ruleSets: snapshot.resources.ruleSets,
      ruleVersions: snapshot.resources.ruleVersions,
      riskEvents: snapshot.resources.riskEvents.filter((item) => item.riskEventId === riskEventId),
      assessments: snapshot.resources.assessments.filter((item) => item.assessmentId === assessmentId),
      ruleHits: snapshot.resources.ruleHits.filter((item) => item.assessmentId === assessmentId),
      reviewCases: snapshot.resources.reviewCases.filter((item) => item.reviewCaseId === reviewCase.reviewCaseId),
      reviewDecisions: snapshot.resources.reviewDecisions.filter((item) => item.reviewCaseId === reviewCase.reviewCaseId),
      auditEntries: snapshot.resources.auditEntries,
    },
    work: snapshot.work,
    events: snapshot.events,
  };
}

const spec = {
  label: "FraudLens RiskEvent acceptance",
  performanceScenarioIds: ["risk-event-ingest", "hot-subject-review", "rollback-boundary-recovery"],
  seed: async () => seed(),
  path: "/api/v1/risk-events",
  payload: (index) => eventPayload(index),
  conflictPayload: (index) => eventPayload(index, { amountMinor: 999_999 }),
  resource: "riskEvents",
  identity: (json) => find(json, "riskEventId"),
  resourceIdentity: ({ riskEventId }) => riskEventId,
  workIdentity: (json) => find(json, "assessmentId") ?? find(json, "riskEventId"),
  async afterPrepare(ctx, api, _receiver, workspace) {
    if (workspace !== ctx.workspace) await prepareMigrationState(ctx, api, workspace);
  },
  async migrationVerify(ctx, { created, snapshot }) {
    assert.ok(migrationExpected, "V1 migration fixture was not prepared");
    for (const [key, expected] of Object.entries(migrationExpected.resources)) {
      assertRecordsPreserved(ctx, snapshot.resources[key], expected);
    }
    assertRecordsPreserved(ctx, snapshot.work, migrationExpected.work);
    assertRecordsPreserved(ctx, snapshot.events, migrationExpected.events);
    const pendingAssessmentId = find(created.json, "assessmentId");
    assert.ok(snapshot.work.some(({ aggregateId, terminal }) => aggregateId === pendingAssessmentId && !terminal), "V1 pending Assessment Work was not preserved");
    assert.equal(snapshot.resources.remediationRuns.length, 0);
    assert.equal(snapshot.resources.assessmentCorrections.length, 0);
    assertAuditChain(snapshot);
  },
  async verify(ctx, baseUrl, response) {
    const assessmentId = find(response.json, "assessmentId");
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      const assessment = value.resources.assessments.find((item) => item.assessmentId === assessmentId);
      return assessment && assessment.state !== "PENDING" ? value : undefined;
    }, { label: "risk assessment", children: [worker] });
    const assessment = snapshot.resources.assessments.find((item) => item.assessmentId === assessmentId);
    const hits = snapshot.resources.ruleHits.filter((item) => item.assessmentId === assessmentId);
    assert.equal(assessment.ruleVersionId, ruleVersionId);
    assert.equal(assessment.score, hits.reduce((sum, hit) => sum + hit.score, 0));
    assert.ok(["APPROVE", "REVIEW", "BLOCK"].includes(assessment.recommendation));
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, `/api/v1/rule-sets/${ruleSetId}/versions`, "h04-invalid-rule", {
      rules: [rule(10)], reviewThreshold: 900, blockThreshold: 100,
    });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.ruleVersions.length, before.resources.ruleVersions.length);
    assert.equal(after.resources.auditEntries.length, before.resources.auditEntries.length);
  },
  async contention(ctx, baseUrls) {
    const payload = eventPayload(66_666);
    const responses = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      ctx.mutate(baseUrls[index % 2], "/api/v1/risk-events", `external-${index}`, payload)));
    assert.ok(responses.every(({ status }) => status >= 200 && status < 300));
    assert.equal(new Set(responses.map(({ json }) => find(json, "assessmentId"))).size, 1);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    assert.equal(snapshot.resources.riskEvents.filter(({ externalEventId }) => externalEventId === payload.externalEventId).length, 1);

    const reviewEvent = await ctx.mutate(baseUrls[0], "/api/v1/risk-events", "h06-review-event", eventPayload(66_667, {
      attributes: { velocity: 9, country: "US" },
    }));
    const assessmentId = find(reviewEvent.json, "assessmentId");
    const worker = await ctx.startWorker();
    const reviewCase = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrls[0]);
      return value.resources.reviewCases.find((item) => item.assessmentId === assessmentId && item.state === "OPEN");
    }, { label: "contended review case", children: [worker] });
    const reviewerId = "h06-reviewer";
    const claimed = await ctx.mutate(baseUrls[0], `/api/v1/review-cases/${reviewCase.reviewCaseId}/claim`, "h06-review-claim", { reviewerId, leaseSeconds: 20 });
    assert.ok(claimed.status >= 200 && claimed.status < 300, claimed.text);
    const decisions = await Promise.all(["APPROVE", "BLOCK"].map((outcome, index) =>
      ctx.mutate(baseUrls[index], `/api/v1/review-cases/${reviewCase.reviewCaseId}/decisions`, `h06-review-${outcome}`, { reviewerId, outcome, reasonCode: "MANUAL_REVIEW" })));
    assert.equal(decisions.filter(({ status }) => status >= 200 && status < 300).length, 1);
    const rejectedDecisions = decisions.filter(({ status }) => status < 200 || status >= 300);
    assert.equal(rejectedDecisions.length, 1);
    assert.ok(rejectedDecisions.every(({ status, json }) => status === 409 && json?.error?.code === "REVIEW_TERMINAL"));
    const final = await ctx.snapshot(baseUrls[0]);
    assert.equal(final.resources.reviewDecisions.filter((item) => item.reviewCaseId === reviewCase.reviewCaseId).length, 1);
  },
  manager: {
    async prepare(ctx, baseUrl) {
      const expected = await setupRollback(ctx, baseUrl, 80, 3);
      return {
        path: "/api/v1/remediation-runs",
        payload: () => ({ tenantId, fromRuleVersionId: expected.fromRuleVersionId, toRuleVersionId: ruleVersionId, occurredFrom: "2026-01-01T00:00:00.000Z", occurredTo: "2027-01-01T00:00:00.000Z" }),
        expected,
      };
    },
    async verify(ctx, baseUrl, response, operation) {
      const remediationRunId = find(response.json, "remediationRunId");
      const queried = await ctx.request(baseUrl, `/api/v1/remediation-runs/${remediationRunId}`);
      assert.equal(queried.status, 200, queried.text);
      const worker = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const run = value.resources.remediationRuns.find((item) => item.remediationRunId === remediationRunId);
        return run?.state === "COMPLETED" ? value : undefined;
      }, { timeoutMs: 60_000, label: "remediation completion", children: [worker] });
      const run = snapshot.resources.remediationRuns.find((item) => item.remediationRunId === remediationRunId);
      const corrections = snapshot.resources.assessmentCorrections.filter((item) => item.remediationRunId === remediationRunId);
      assert.equal(run.totalCount, operation.expected.assessmentIds.length);
      assert.equal(run.completedCount, run.correctionCount + run.noChangeCount);
      assert.equal(run.completedCount, run.totalCount);
      assert.equal(corrections.length, run.totalCount);
      assert.equal(new Set(corrections.map(({ assessmentId }) => assessmentId)).size, corrections.length);
      assert.deepEqual(new Set(corrections.map(({ assessmentId }) => assessmentId)), new Set(operation.expected.assessmentIds));
      assert.ok(corrections.every(({ outcome }) => ["CORRECTED", "NO_CHANGE"].includes(outcome)));
      const completedView = await ctx.request(baseUrl, `/api/v1/remediation-runs/${remediationRunId}`);
      assert.equal(completedView.status, 200, completedView.text);
      assert.equal(ctx.canonical(completedView.json?.run), ctx.canonical(run));
      assert.equal(ctx.canonical(completedView.json?.corrections), ctx.canonical(corrections));
      assertPreservedAssessments(ctx, snapshot, operation.expected);
    },
    async concurrentVerify(ctx, baseUrls, response, operation) {
      const remediationRunId = find(response.json, "remediationRunId");
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === remediationRunId ? held : { status: 204 });
      const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "fraudlens-h11" });
      await ctx.waitFor(() => barrier.ledger.some((entry) =>
        entry.json?.point === "worker.claimed" && entry.json?.aggregateId === remediationRunId), {
        label: "remediation claim before cancel",
        children: [first],
      });
      const cancellations = await Promise.all(baseUrls.map((baseUrl, index) =>
        ctx.mutate(baseUrl, `/api/v1/remediation-runs/${remediationRunId}/cancel`, `cancel-${index}`, {})));
      assert.ok(cancellations.some(({ status }) => status >= 200 && status < 300));
      assert.ok(cancellations.every(({ status, json }) => (status >= 200 && status < 300)
        || (status === 409 && json?.error?.code === "REMEDIATION_RUN_TERMINAL")));
      await ctx.stop(first, "SIGKILL");
      release({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const replacements = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const run = value.resources.remediationRuns.find((item) => item.remediationRunId === remediationRunId);
        const work = value.work.filter((item) => item.kind === "REMEDIATION_RECHECK" && item.aggregateId === remediationRunId);
        return ["COMPLETED", "CANCELLED"].includes(run?.state) && work.length > 0 && work.every(({ terminal }) => terminal)
          ? value : undefined;
      }, { timeoutMs: 60_000, label: "cancelled remediation drain", children: replacements });
      assert.equal(snapshot.resources.remediationRuns.filter((item) => item.remediationRunId === remediationRunId).length, 1);
      const run = snapshot.resources.remediationRuns.find((item) => item.remediationRunId === remediationRunId);
      const corrections = snapshot.resources.assessmentCorrections.filter((item) => item.remediationRunId === remediationRunId);
      assert.equal(new Set(corrections.map(({ assessmentId }) => assessmentId)).size, corrections.length);
      assert.ok(corrections.length <= operation.expected.assessmentIds.length);
      assert.equal(run.completedCount, corrections.length);
      assert.equal(run.completedCount, run.correctionCount + run.noChangeCount);
      if (run.state === "CANCELLED") assert.equal(typeof run.cancelledAt, "string");
      assertPreservedAssessments(ctx, snapshot, operation.expected);
    },
  },
  performance: fraudlensPerformance,
};

function percentile(values, fraction) {
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

async function fixedLoad(ctx, { count, concurrency, request }) {
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const started = performance.now();
    const response = await request(index);
    latencies.push(performance.now() - started);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);
  return { completed: count, durationMs, throughput: count / (durationMs / 1_000), p50: percentile(latencies, .5), p95: percentile(latencies, .95), p99: percentile(latencies, .99), statuses: Object.fromEntries(statuses) };
}

function assertSuccessful(load, expected) {
  const successful = Object.entries(load.statuses)
    .filter(([status]) => Number(status) >= 200 && Number(status) < 300)
    .reduce((sum, [, count]) => sum + count, 0);
  assert.equal(successful, expected);
  assert.equal(Object.entries(load.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0), 0);
}

function assertAssessmentBatch(snapshot, assessmentIds, expectedRuleVersionId) {
  const ids = new Set(assessmentIds);
  const assessments = snapshot.resources.assessments.filter(({ assessmentId }) => ids.has(assessmentId));
  const hitTotals = new Map();
  for (const hit of snapshot.resources.ruleHits) {
    if (ids.has(hit.assessmentId)) hitTotals.set(hit.assessmentId, (hitTotals.get(hit.assessmentId) ?? 0) + hit.score);
  }
  assert.equal(assessments.length, assessmentIds.length);
  for (const assessment of assessments) {
    assert.notEqual(assessment.state, "PENDING");
    assert.equal(assessment.ruleVersionId, expectedRuleVersionId);
    assert.equal(assessment.score, hitTotals.get(assessment.assessmentId) ?? 0);
    assert.ok(["APPROVE", "REVIEW", "BLOCK"].includes(assessment.recommendation));
  }
}

function assertAuditChain(snapshot) {
  const entries = snapshot.resources.auditEntries
    .filter((entry) => entry.tenantId === tenantId)
    .sort((a, b) => a.sequence - b.sequence);
  for (let index = 0; index < entries.length; index += 1) {
    assert.equal(entries[index].sequence, index + 1);
    assert.equal(entries[index].priorDigest, index ? entries[index - 1].digest : null);
  }
}

async function fraudlensPerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  assert.equal((await ctx.seed(seed("perf-fraudlens"))).exitCode, 0);
  const apis = await Promise.all(Array.from({ length: 4 }, () => ctx.startApi()));
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));

  const ingestCount = Math.max(1_000, Math.ceil(100_000 * scale));
  const ingest = await fixedLoad(ctx, { count: ingestCount, concurrency: 96,
    request: (index) => ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/risk-events", `perf-risk-${index}`, eventPayload(1_000_000 + index)) });
  assert.ok(ingest.throughput >= 300 && ingest.p95 <= 300, `risk-event-ingest ${ingest.throughput}/s p95=${ingest.p95}`);
  assertSuccessful(ingest, ingestCount);
  const ingestAssessmentIds = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const riskEventIds = new Set(snapshot.resources.riskEvents
      .filter(({ externalEventId }) => externalEventId.startsWith("hidden-risk-1"))
      .map(({ riskEventId }) => riskEventId));
    const assessments = snapshot.resources.assessments.filter(({ riskEventId, state }) => riskEventIds.has(riskEventId) && state !== "PENDING");
    return assessments.length === ingestCount ? assessments.map(({ assessmentId }) => assessmentId) : undefined;
  }, { timeoutMs: 180_000, label: "ingest assessments", children: workers });
  assertAssessmentBatch(await ctx.snapshot(apis[0].baseUrl), ingestAssessmentIds, ruleVersionId);
  assertions.push(`risk-event-ingest ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  const reviewCount = Math.max(500, Math.ceil(20_000 * scale));
  const reviewEvents = await ctx.concurrent(Array.from({ length: reviewCount }), 64, (_, index) =>
    ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/risk-events", `perf-review-${index}`, eventPayload(2_000_000 + index, { attributes: { velocity: 8, country: "US" } })));
  assert.ok(reviewEvents.every(({ status }) => status >= 200 && status < 300));
  const reviewIds = reviewEvents.map(({ json }) => find(json, "assessmentId"));
  const reviewIdSet = new Set(reviewIds);
  const reviewCases = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const relevant = snapshot.resources.reviewCases.filter(({ assessmentId }) => reviewIdSet.has(assessmentId));
    return relevant.length === reviewCount ? relevant : undefined;
  }, { timeoutMs: 120_000, label: "performance review cases", children: workers });
  const review = await fixedLoad(ctx, { count: reviewCases.length, concurrency: 64, request: async (index) => {
    const reviewCaseId = reviewCases[index].reviewCaseId;
    const baseUrl = apis[index % apis.length].baseUrl;
    const claimed = await ctx.mutate(baseUrl, `/api/v1/review-cases/${reviewCaseId}/claim`, `perf-claim-${index}`, { reviewerId: `reviewer-${index % 32}`, leaseSeconds: 10 });
    if (claimed.status < 200 || claimed.status >= 300) return claimed;
    return ctx.mutate(baseUrl, `/api/v1/review-cases/${reviewCaseId}/decisions`, `perf-decision-${index}`, { reviewerId: `reviewer-${index % 32}`, outcome: "APPROVE", reasonCode: "VERIFIED" });
  }});
  assert.ok(review.throughput >= 180 && review.p95 <= 700, `hot-subject-review ${review.throughput}/s p95=${review.p95}`);
  assertSuccessful(review, reviewCount);
  const reviewCaseIds = new Set(reviewCases.map(({ reviewCaseId }) => reviewCaseId));
  const afterReview = await ctx.snapshot(apis[0].baseUrl);
  const decisions = afterReview.resources.reviewDecisions.filter(({ reviewCaseId }) => reviewCaseIds.has(reviewCaseId));
  assert.equal(decisions.length, reviewCount);
  assert.equal(new Set(decisions.map(({ reviewCaseId }) => reviewCaseId)).size, reviewCount);
  assertAssessmentBatch(afterReview, reviewIds, ruleVersionId);
  assertions.push(`hot-subject-review ${review.throughput.toFixed(1)}/s p95 ${review.p95.toFixed(1)}ms`);

  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const boundaryCount = Math.max(250, Math.ceil(10_000 * scale));
  const beforeCount = Math.max(1, Math.floor(boundaryCount * .8));
  const afterCount = boundaryCount - beforeCount;
  const highRiskVersionId = await createVersion(ctx, apis[0].baseUrl, 90);
  await activate(ctx, apis[0].baseUrl, highRiskVersionId, "perf-activate-high-risk");
  const beforeRollback = await ctx.concurrent(Array.from({ length: beforeCount }), 64, (_, index) =>
    ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/risk-events", `perf-boundary-before-${index}`,
      eventPayload(3_000_000 + index, { attributes: { velocity: 9, country: "US" } })));
  assert.ok(beforeRollback.every(({ status }) => status >= 200 && status < 300));
  const beforeAssessmentIds = beforeRollback.map(({ json }) => find(json, "assessmentId"));
  const beforeAssessmentIdSet = new Set(beforeAssessmentIds);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && beforeAssessmentIdSet.has(entry.json?.aggregateId) ? held : { status: 204 });
  const first = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "fraudlens-perf" })));
  await ctx.waitFor(() => barrier.ledger.filter((entry) =>
    entry.json?.point === "worker.claimed" && beforeAssessmentIdSet.has(entry.json?.aggregateId)).length >= 2, {
    label: "two pre-rollback Assessment claims", children: first,
  });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  release({ status: 204 });
  const rollback = await ctx.mutate(apis[0].baseUrl, `/api/v1/rule-sets/${ruleSetId}/rollback`, "perf-boundary-rollback", {
    expectedActiveRuleVersionId: highRiskVersionId, toRuleVersionId: ruleVersionId, reason: "performance boundary",
  });
  assert.ok(rollback.status >= 200 && rollback.status < 300, rollback.text);
  const afterRollback = await ctx.concurrent(Array.from({ length: afterCount }), 64, (_, index) =>
    ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/risk-events", `perf-boundary-after-${index}`,
      eventPayload(4_000_000 + index, { attributes: { velocity: 9, country: "US" } })));
  assert.ok(afterRollback.every(({ status }) => status >= 200 && status < 300));
  const afterAssessmentIds = afterRollback.map(({ json }) => find(json, "assessmentId"));
  const allAssessmentIds = new Set([...beforeAssessmentIds, ...afterAssessmentIds]);
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const assessments = snapshot.resources.assessments.filter(({ assessmentId, state }) => allAssessmentIds.has(assessmentId) && state !== "PENDING");
    const work = snapshot.work.filter(({ aggregateId }) => allAssessmentIds.has(aggregateId));
    return assessments.length === boundaryCount && work.length === boundaryCount && work.every(({ terminal }) => terminal)
      ? snapshot : undefined;
  }, { timeoutMs: 90_000, label: "rollback boundary recovery", children: replacements });
  const durationMs = Date.now() - startedAt;
  assertAssessmentBatch(final, beforeAssessmentIds, highRiskVersionId);
  assertAssessmentBatch(final, afterAssessmentIds, ruleVersionId);
  assert.ok(durationMs <= 90_000);
  assertAuditChain(final);
  assertions.push(`rollback-boundary-recovery ${boundaryCount} assessments in ${durationMs}ms after two SIGKILLs`);

  return { metrics: [{ scenarioId: "risk-event-ingest", ...ingest }, { scenarioId: "hot-subject-review", ...review }, { scenarioId: "rollback-boundary-recovery", completed: boundaryCount, durationMs, killedWorkers: 2, replacementWorkers: 4 }] };
}

export default standardAdapter(spec);
