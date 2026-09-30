import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const policyId = id(2);
const policyVersionId = id(3);
const digest = (value) => createHash("sha256").update(value).digest("hex");
let migrationExpected;

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function categories(action = "ESCALATE") {
  return [{ categoryCode: "ABUSE", severity: 80, level1Action: action }, { categoryCode: "SAFE", severity: 0, level1Action: "ALLOW" }];
}

function seed(seedVersion = "hidden-moderationflow") {
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Tenant" }],
    policies: [{ policyId, tenantId, name: "Community Safety", activePolicyVersionId: policyVersionId }],
    policyVersions: [{ policyVersionId, policyId, version: 1, state: "ACTIVE", categories: categories(), createdAt: "2026-01-01T00:00:00.000Z", activatedAt: "2026-01-01T00:00:00.000Z" }],
    contentItems: [], evidenceVersions: [], moderationCases: [], reviewStages: [], moderationDecisions: [], appeals: [], auditEntries: [], auditCheckpoints: [],
  };
}

function contentPayload(index, overrides = {}) {
  const text = `hidden moderation content ${index}`;
  return {
    tenantId, policyId, externalContentId: `hidden-content-${index}`, contentType: "POST",
    bodyDigest: digest(text), text,
    initialEvidence: { kind: "SUBMISSION", digest: digest(`evidence-${index}`), summary: `submission ${index}`, createdBy: "hidden-import" },
    ...overrides,
  };
}

async function createPolicyVersion(ctx, baseUrl, index, action) {
  const response = await ctx.mutate(baseUrl, `/api/v1/policies/${policyId}/versions`, `policy-${index}`, { categories: categories(action) });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return find(response.json, "policyVersionId");
}

async function activate(ctx, baseUrl, versionId, expectedId, key) {
  const response = await ctx.mutate(baseUrl, `/api/v1/policy-versions/${versionId}/activate`, key, { expectedActivePolicyVersionId: expectedId });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
}

async function finishCases(ctx, baseUrls, caseIds, workers, outcome = "ALLOW") {
  const urls = Array.isArray(baseUrls) ? baseUrls : [baseUrls];
  const caseIdSet = new Set(caseIds);
  const stages = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(urls[0]);
    const result = snapshot.resources.reviewStages.filter(({ caseId, level, state }) => caseIdSet.has(caseId) && level === "LEVEL_1" && state === "OPEN");
    return result.length === caseIds.length ? result : undefined;
  }, { timeoutMs: 120_000, label: "LEVEL_1 stages", children: workers });
  await ctx.concurrent(stages, 64, async (stage, index) => {
    const reviewerId = `reviewer-${index % 32}`;
    const baseUrl = urls[index % urls.length];
    const claimed = await ctx.mutate(baseUrl, `/api/v1/review-stages/${stage.stageId}/claim`, `claim-${stage.stageId}`, { reviewerId, leaseSeconds: 20 });
    assert.ok(claimed.status >= 200 && claimed.status < 300, claimed.text);
    const decided = await ctx.mutate(baseUrl, `/api/v1/review-stages/${stage.stageId}/decisions`, `decision-${stage.stageId}`, {
      reviewerId,
      outcome,
      categoryCode: outcome === "ALLOW" ? "SAFE" : "ABUSE",
      reason: "reviewed",
    });
    assert.ok(decided.status >= 200 && decided.status < 300, decided.text);
  });
}

async function setupRecall(ctx, baseUrls, index, affectedCount = 1) {
  const urls = Array.isArray(baseUrls) ? baseUrls : [baseUrls];
  const baseUrl = urls[0];
  const recalledPolicyVersionId = await createPolicyVersion(ctx, baseUrl, index, "REMOVE");
  await activate(ctx, baseUrl, recalledPolicyVersionId, policyVersionId, `activate-recalled-${index}`);
  const responses = await ctx.concurrent(Array.from({ length: affectedCount }), Math.min(64, affectedCount), (_, offset) =>
    ctx.mutate(urls[offset % urls.length], "/api/v1/content-items", `affected-content-${index}-${offset}`, contentPayload(index * 100_000 + offset)));
  assert.ok(responses.every(({ status }) => status >= 200 && status < 300));
  const caseIds = responses.map(({ json }) => find(json, "caseId"));
  const workers = await Promise.all(Array.from({ length: Math.min(4, Math.max(1, affectedCount)) }, () => ctx.startWorker()));
  await finishCases(ctx, urls, caseIds, workers, "REMOVE");
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const replacementPolicyVersionId = await createPolicyVersion(ctx, baseUrl, index + 1, "ALLOW");
  await activate(ctx, baseUrl, replacementPolicyVersionId, recalledPolicyVersionId, `activate-replacement-${index}`);
  const frozen = await ctx.snapshot(baseUrl);
  const caseIdSet = new Set(caseIds);
  const contentItemIds = new Set(frozen.resources.moderationCases
    .filter(({ caseId }) => caseIdSet.has(caseId))
    .map(({ contentItemId }) => contentItemId));
  const stageIds = new Set(frozen.resources.reviewStages
    .filter(({ caseId }) => caseIdSet.has(caseId))
    .map(({ stageId }) => stageId));
  return {
    recalledPolicyVersionId,
    replacementPolicyVersionId,
    caseIds,
    preserved: {
      contentItems: ctx.canonical(frozen.resources.contentItems.filter(({ contentItemId }) => contentItemIds.has(contentItemId))),
      evidenceVersions: ctx.canonical(frozen.resources.evidenceVersions.filter(({ contentItemId }) => contentItemIds.has(contentItemId))),
      moderationCases: ctx.canonical(frozen.resources.moderationCases.filter(({ caseId }) => caseIdSet.has(caseId))),
      reviewStages: ctx.canonical(frozen.resources.reviewStages.filter(({ caseId }) => caseIdSet.has(caseId))),
      moderationDecisions: ctx.canonical(frozen.resources.moderationDecisions.filter(({ stageId }) => stageIds.has(stageId))),
      appeals: ctx.canonical(frozen.resources.appeals.filter(({ caseId }) => caseIdSet.has(caseId))),
    },
  };
}

function assertPreservedCases(ctx, snapshot, expected) {
  const caseIds = new Set(expected.caseIds);
  const contentItemIds = new Set(snapshot.resources.moderationCases
    .filter(({ caseId }) => caseIds.has(caseId))
    .map(({ contentItemId }) => contentItemId));
  const originalStages = snapshot.resources.reviewStages.filter(({ caseId, level }) => caseIds.has(caseId) && level !== "RECONSIDERATION");
  const stageIds = new Set(originalStages.map(({ stageId }) => stageId));
  assert.equal(ctx.canonical(snapshot.resources.contentItems.filter(({ contentItemId }) => contentItemIds.has(contentItemId))), expected.preserved.contentItems);
  assert.equal(ctx.canonical(snapshot.resources.evidenceVersions.filter(({ contentItemId }) => contentItemIds.has(contentItemId))), expected.preserved.evidenceVersions);
  assert.equal(ctx.canonical(snapshot.resources.moderationCases.filter(({ caseId }) => caseIds.has(caseId))), expected.preserved.moderationCases);
  assert.equal(ctx.canonical(originalStages), expected.preserved.reviewStages);
  assert.equal(ctx.canonical(snapshot.resources.moderationDecisions.filter(({ stageId }) => stageIds.has(stageId))), expected.preserved.moderationDecisions);
  assert.equal(ctx.canonical(snapshot.resources.appeals.filter(({ caseId }) => caseIds.has(caseId))), expected.preserved.appeals);
}

function assertRecordsPreserved(ctx, actual, expected) {
  const records = new Set(actual.map((item) => ctx.canonical(item)));
  for (const item of expected) assert.ok(records.has(ctx.canonical(item)), "V1 record changed during FINAL migration");
}

async function prepareMigrationState(ctx, api, workspace) {
  const created = await ctx.mutate(api.baseUrl, "/api/v1/content-items", "h09-reviewed-content", contentPayload(90_001));
  assert.ok(created.status >= 200 && created.status < 300, created.text);
  const contentItemId = find(created.json, "contentItemId");
  const caseId = find(created.json, "caseId");
  const worker = await ctx.startWorker({}, workspace);
  const stage = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.reviewStages.find((item) => item.caseId === caseId && item.level === "LEVEL_1" && item.state === "OPEN");
  }, { label: "V1 LEVEL_1 stage", children: [worker] });
  await ctx.stop(worker);
  const reviewerId = "h09-reviewer";
  const claimed = await ctx.mutate(api.baseUrl, `/api/v1/review-stages/${stage.stageId}/claim`, "h09-stage-claim", { reviewerId, leaseSeconds: 20 });
  assert.ok(claimed.status >= 200 && claimed.status < 300, claimed.text);
  const decided = await ctx.mutate(api.baseUrl, `/api/v1/review-stages/${stage.stageId}/decisions`, "h09-stage-decision", {
    reviewerId, outcome: "ESCALATE", categoryCode: "ABUSE", reason: "migration escalation",
  });
  assert.ok(decided.status >= 200 && decided.status < 300, decided.text);
  const levelTwoWorker = await ctx.startWorker({}, workspace);
  const levelTwo = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.reviewStages.find((item) => item.caseId === caseId && item.level === "LEVEL_2" && item.state === "OPEN");
  }, { label: "V1 LEVEL_2 stage", children: [levelTwoWorker] });
  await ctx.stop(levelTwoWorker);
  const levelTwoReviewer = "h09-level-two-reviewer";
  const levelTwoClaim = await ctx.mutate(api.baseUrl, `/api/v1/review-stages/${levelTwo.stageId}/claim`, "h09-level-two-claim", {
    reviewerId: levelTwoReviewer, leaseSeconds: 20,
  });
  assert.ok(levelTwoClaim.status >= 200 && levelTwoClaim.status < 300, levelTwoClaim.text);
  const levelTwoDecision = await ctx.mutate(api.baseUrl, `/api/v1/review-stages/${levelTwo.stageId}/decisions`, "h09-level-two-decision", {
    reviewerId: levelTwoReviewer, outcome: "ALLOW", categoryCode: "SAFE", reason: "migration baseline",
  });
  assert.ok(levelTwoDecision.status >= 200 && levelTwoDecision.status < 300, levelTwoDecision.text);
  const appeal = await ctx.mutate(api.baseUrl, `/api/v1/moderation-cases/${caseId}/appeals`, "h09-appeal", { reason: "migration appeal" });
  assert.ok(appeal.status >= 200 && appeal.status < 300, appeal.text);
  const appealId = find(appeal.json, "appealId");
  const snapshot = await ctx.snapshot(api.baseUrl);
  const stageIds = new Set(snapshot.resources.reviewStages.filter((item) => item.caseId === caseId).map(({ stageId }) => stageId));
  migrationExpected = {
    appealId,
    resources: {
      policies: snapshot.resources.policies,
      policyVersions: snapshot.resources.policyVersions,
      contentItems: snapshot.resources.contentItems.filter((item) => item.contentItemId === contentItemId),
      evidenceVersions: snapshot.resources.evidenceVersions.filter((item) => item.contentItemId === contentItemId),
      moderationCases: snapshot.resources.moderationCases.filter((item) => item.caseId === caseId),
      reviewStages: snapshot.resources.reviewStages.filter((item) => item.caseId === caseId),
      moderationDecisions: snapshot.resources.moderationDecisions.filter((item) => stageIds.has(item.stageId)),
      appeals: snapshot.resources.appeals.filter((item) => item.caseId === caseId),
      auditEntries: snapshot.resources.auditEntries,
    },
    work: snapshot.work,
    events: snapshot.events,
  };
}

const spec = {
  label: "ModerationFlow ContentItem submission",
  performanceScenarioIds: ["moderation-ingest", "evidence-appeal-contention", "policy-boundary-recovery"],
  seed: async () => seed(),
  path: "/api/v1/content-items",
  payload: (index) => contentPayload(index),
  conflictPayload: (index) => contentPayload(index, { text: "changed", bodyDigest: digest("changed") }),
  resource: "contentItems",
  identity: (json) => find(json, "contentItemId"),
  resourceIdentity: ({ contentItemId }) => contentItemId,
  workIdentity: (json) => find(json, "caseId") ?? find(json, "contentItemId"),
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
    assert.ok(snapshot.work.some(({ aggregateId, terminal }) => aggregateId === migrationExpected.appealId && !terminal), "V1 pending Appeal Work was not preserved");
    const pendingCaseId = find(created.json, "caseId");
    assert.ok(snapshot.work.some(({ aggregateId, terminal }) => aggregateId === pendingCaseId && !terminal), "V1 pending Case Work was not preserved");
    assert.equal(snapshot.resources.policyRecallRuns.length, 0);
    assert.equal(snapshot.resources.reconsiderations.length, 0);
    verifyAudit(snapshot);
  },
  async verify(ctx, baseUrl, response) {
    const caseId = find(response.json, "caseId");
    const contentItemId = find(response.json, "contentItemId");
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      return value.resources.reviewStages.some((stage) => stage.caseId === caseId) ? value : undefined;
    }, { label: "review stage opening", children: [worker] });
    const moderationCase = snapshot.resources.moderationCases.find((item) => item.caseId === caseId);
    assert.equal(moderationCase.policyVersionId, policyVersionId);
    assert.equal(moderationCase.evidenceHeadVersion, 1);
    assert.equal(snapshot.resources.evidenceVersions.filter((item) => item.contentItemId === contentItemId).length, 1);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, `/api/v1/policies/${policyId}/versions`, "h04-invalid-policy", {
      categories: [{ categoryCode: "DUP", severity: 101, level1Action: "ALLOW" }, { categoryCode: "DUP", severity: 1, level1Action: "ALLOW" }],
    });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.policyVersions.length, before.resources.policyVersions.length);
    assert.equal(after.resources.auditEntries.length, before.resources.auditEntries.length);
  },
  async contention(ctx, baseUrls) {
    const payload = contentPayload(66_666);
    const responses = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      ctx.mutate(baseUrls[index % 2], "/api/v1/content-items", `external-content-${index}`, payload)));
    assert.ok(responses.every(({ status }) => status >= 200 && status < 300));
    assert.equal(new Set(responses.map(({ json }) => find(json, "caseId"))).size, 1);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    assert.equal(snapshot.resources.contentItems.filter(({ externalContentId }) => externalContentId === payload.externalContentId).length, 1);

    const created = await ctx.mutate(baseUrls[0], "/api/v1/content-items", "h06-review-content", contentPayload(66_667));
    const contentItemId = find(created.json, "contentItemId");
    const caseId = find(created.json, "caseId");
    const worker = await ctx.startWorker();
    const stage = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrls[0]);
      return value.resources.reviewStages.find((item) => item.caseId === caseId && item.level === "LEVEL_1" && item.state === "OPEN");
    }, { label: "contended LEVEL_1 stage", children: [worker] });
    const appends = await Promise.all(baseUrls.map((baseUrl, index) => ctx.mutate(
      baseUrl, `/api/v1/content-items/${contentItemId}/evidence-versions`, `h06-evidence-${index}`,
      { expectedHeadVersion: 1, kind: "REPORT", digest: digest(`h06-report-${index}`), summary: `report ${index}`, createdBy: `reviewer-${index}` },
    )));
    assert.equal(appends.filter(({ status }) => status >= 200 && status < 300).length, 1);
    const rejectedAppends = appends.filter(({ status }) => status < 200 || status >= 300);
    assert.equal(rejectedAppends.length, 1);
    assert.ok(rejectedAppends.every(({ status, json }) => status === 409 && json?.error?.code === "EVIDENCE_HEAD_CHANGED"));
    const reviewerId = "h06-reviewer";
    const claimed = await ctx.mutate(baseUrls[0], `/api/v1/review-stages/${stage.stageId}/claim`, "h06-stage-claim", { reviewerId, leaseSeconds: 20 });
    assert.ok(claimed.status >= 200 && claimed.status < 300, claimed.text);
    const decisions = await Promise.all(["ALLOW", "REMOVE"].map((outcome, index) => ctx.mutate(
      baseUrls[index], `/api/v1/review-stages/${stage.stageId}/decisions`, `h06-stage-${outcome}`,
      { reviewerId, outcome, categoryCode: outcome === "ALLOW" ? "SAFE" : "ABUSE", reason: "contended review" },
    )));
    assert.equal(decisions.filter(({ status }) => status >= 200 && status < 300).length, 1);
    const rejectedDecisions = decisions.filter(({ status }) => status < 200 || status >= 300);
    assert.equal(rejectedDecisions.length, 1);
    assert.ok(rejectedDecisions.every(({ status, json }) => status === 409 && json?.error?.code === "REVIEW_TERMINAL"));
    const appeals = await Promise.all(baseUrls.map((baseUrl, index) => ctx.mutate(
      baseUrl, `/api/v1/moderation-cases/${caseId}/appeals`, `h06-appeal-${index}`,
      { reason: "request reconsideration" },
    )));
    assert.equal(appeals.filter(({ status }) => status >= 200 && status < 300).length, 1);
    const rejectedAppeals = appeals.filter(({ status }) => status < 200 || status >= 300);
    assert.equal(rejectedAppeals.length, 1);
    assert.ok(rejectedAppeals.every(({ status, json }) => status === 409 && json?.error?.code === "APPEAL_ALREADY_EXISTS"));
    const final = await ctx.snapshot(baseUrls[0]);
    assert.equal(final.resources.moderationDecisions.filter((item) => item.stageId === stage.stageId).length, 1);
    assert.equal(final.resources.appeals.filter((item) => item.caseId === caseId).length, 1);
  },
  manager: {
    async prepare(ctx, baseUrl) {
      const expected = await setupRecall(ctx, baseUrl, 80, 3);
      return { path: "/api/v1/policy-recall-runs", payload: () => ({
        tenantId, recalledPolicyVersionId: expected.recalledPolicyVersionId,
        replacementPolicyVersionId: expected.replacementPolicyVersionId,
        decidedFrom: "2026-01-01T00:00:00.000Z", decidedTo: "2027-01-01T00:00:00.000Z",
      }), expected };
    },
    async verify(ctx, baseUrl, response, operation) {
      const policyRecallRunId = find(response.json, "policyRecallRunId");
      const queried = await ctx.request(baseUrl, `/api/v1/policy-recall-runs/${policyRecallRunId}`);
      assert.equal(queried.status, 200, queried.text);
      const worker = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const run = value.resources.policyRecallRuns.find((item) => item.policyRecallRunId === policyRecallRunId);
        return run?.state === "COMPLETED" ? value : undefined;
      }, { timeoutMs: 60_000, label: "policy recall", children: [worker] });
      const run = snapshot.resources.policyRecallRuns.find((item) => item.policyRecallRunId === policyRecallRunId);
      const results = snapshot.resources.reconsiderations.filter((item) => item.policyRecallRunId === policyRecallRunId);
      assert.equal(run.totalCount, operation.expected.caseIds.length);
      assert.equal(run.completedCount, run.changedCount + run.noChangeCount);
      assert.equal(run.completedCount, run.totalCount);
      assert.equal(results.length, run.totalCount);
      assert.equal(new Set(results.map(({ caseId }) => caseId)).size, results.length);
      assert.deepEqual(new Set(results.map(({ caseId }) => caseId)), new Set(operation.expected.caseIds));
      assert.ok(results.every(({ outcome, reconsiderationStageId }) => outcome === "CHANGED" && typeof reconsiderationStageId === "string"));
      const resultStageIds = new Set(results.map(({ reconsiderationStageId }) => reconsiderationStageId));
      const stages = snapshot.resources.reviewStages.filter(({ stageId }) => resultStageIds.has(stageId));
      assert.equal(stages.length, results.length);
      assert.ok(stages.every(({ level, state }) => level === "RECONSIDERATION" && ["OPEN", "CLAIMED", "DECIDED"].includes(state)));
      assert.equal(snapshot.resources.moderationDecisions.filter(({ stageId }) => resultStageIds.has(stageId)).length, 0);
      const completedView = await ctx.request(baseUrl, `/api/v1/policy-recall-runs/${policyRecallRunId}`);
      assert.equal(completedView.status, 200, completedView.text);
      assert.equal(ctx.canonical(completedView.json?.run), ctx.canonical(run));
      assert.equal(ctx.canonical(completedView.json?.reconsiderations), ctx.canonical(results));
      assertPreservedCases(ctx, snapshot, operation.expected);
    },
    async concurrentVerify(ctx, baseUrls, response, operation) {
      const policyRecallRunId = find(response.json, "policyRecallRunId");
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === policyRecallRunId ? held : { status: 204 });
      const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "moderationflow-h11" });
      await ctx.waitFor(() => barrier.ledger.some((entry) =>
        entry.json?.point === "worker.claimed" && entry.json?.aggregateId === policyRecallRunId), {
        label: "policy recall claim before cancel",
        children: [first],
      });
      const cancelled = await Promise.all(baseUrls.map((baseUrl, index) =>
        ctx.mutate(baseUrl, `/api/v1/policy-recall-runs/${policyRecallRunId}/cancel`, `recall-cancel-${index}`, {})));
      assert.ok(cancelled.some(({ status }) => status >= 200 && status < 300));
      assert.ok(cancelled.every(({ status, json }) => (status >= 200 && status < 300)
        || (status === 409 && json?.error?.code === "POLICY_RECALL_RUN_TERMINAL")));
      await ctx.stop(first, "SIGKILL");
      release({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const replacements = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const run = value.resources.policyRecallRuns.find((item) => item.policyRecallRunId === policyRecallRunId);
        const work = value.work.filter((item) => item.kind === "POLICY_RECALL" && item.aggregateId === policyRecallRunId);
        return ["COMPLETED", "CANCELLED"].includes(run?.state) && work.length > 0 && work.every(({ terminal }) => terminal)
          ? value : undefined;
      }, { timeoutMs: 60_000, label: "cancelled policy recall drain", children: replacements });
      assert.equal(snapshot.resources.policyRecallRuns.filter((item) => item.policyRecallRunId === policyRecallRunId).length, 1);
      const run = snapshot.resources.policyRecallRuns.find((item) => item.policyRecallRunId === policyRecallRunId);
      const results = snapshot.resources.reconsiderations.filter((item) => item.policyRecallRunId === policyRecallRunId);
      assert.equal(new Set(results.map(({ caseId }) => caseId)).size, results.length);
      assert.ok(results.length <= operation.expected.caseIds.length);
      assert.equal(run.completedCount, results.length);
      assert.equal(run.completedCount, run.changedCount + run.noChangeCount);
      if (run.state === "CANCELLED") assert.equal(typeof run.cancelledAt, "string");
      const stageIds = results.map(({ reconsiderationStageId }) => reconsiderationStageId).filter(Boolean);
      assert.equal(new Set(stageIds).size, stageIds.length);
      assertPreservedCases(ctx, snapshot, operation.expected);
    },
  },
  performance: moderationPerformance,
};

function percentile(values, fraction) { return values[Math.max(0, Math.ceil(values.length * fraction) - 1)]; }

async function fixedLoad(ctx, { count, concurrency, request }) {
  const latencies = [], statuses = new Map(), startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const started = performance.now(), response = await request(index);
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

function assertFrozenCases(snapshot, caseIds, expectedPolicyVersionId, expectedEvidenceHead) {
  const ids = new Set(caseIds);
  const cases = snapshot.resources.moderationCases.filter(({ caseId }) => ids.has(caseId));
  assert.equal(cases.length, caseIds.length);
  assert.ok(cases.every((item) => item.policyVersionId === expectedPolicyVersionId && item.evidenceHeadVersion === expectedEvidenceHead));
}

function verifyAudit(snapshot) {
  const entries = snapshot.resources.auditEntries.filter((entry) => entry.tenantId === tenantId).sort((a, b) => a.sequence - b.sequence);
  for (let index = 0; index < entries.length; index += 1) {
    assert.equal(entries[index].sequence, index + 1);
    assert.equal(entries[index].priorDigest, index ? entries[index - 1].digest : null);
  }
}

async function moderationPerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  assert.equal((await ctx.seed(seed("perf-moderationflow"))).exitCode, 0);
  const apis = await Promise.all(Array.from({ length: 4 }, () => ctx.startApi()));
  let workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));

  const ingestCount = Math.max(1_000, Math.ceil(50_000 * scale));
  const ingest = await fixedLoad(ctx, { count: ingestCount, concurrency: 96,
    request: (index) => ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/content-items", `perf-content-${index}`, contentPayload(1_000_000 + index)) });
  assert.ok(ingest.throughput >= 250 && ingest.p95 <= 350, `moderation-ingest ${ingest.throughput}/s p95=${ingest.p95}`);
  assertSuccessful(ingest, ingestCount);
  const ingestCases = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const contentIds = new Set(snapshot.resources.contentItems
      .filter(({ externalContentId }) => externalContentId.startsWith("hidden-content-1"))
      .map(({ contentItemId }) => contentItemId));
    const cases = snapshot.resources.moderationCases.filter(({ contentItemId }) => contentIds.has(contentItemId));
    const caseIds = new Set(cases.map(({ caseId }) => caseId));
    const opened = snapshot.resources.reviewStages.filter(({ caseId, level }) => caseIds.has(caseId) && level === "LEVEL_1");
    return cases.length === ingestCount && opened.length === ingestCount ? cases : undefined;
  }, { timeoutMs: 180_000, label: "ingest review stages", children: workers });
  assertFrozenCases(await ctx.snapshot(apis[0].baseUrl), ingestCases.map(({ caseId }) => caseId), policyVersionId, 1);
  assertions.push(`moderation-ingest ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  const operationCount = Math.max(500, Math.ceil(20_000 * scale));
  const created = await ctx.concurrent(Array.from({ length: operationCount }), 64, (_, index) =>
    ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/content-items", `perf-review-content-${index}`, contentPayload(2_000_000 + index)));
  assert.ok(created.every(({ status }) => status >= 200 && status < 300));
  const caseIds = created.map(({ json }) => find(json, "caseId"));
  const caseIdSet = new Set(caseIds);
  const stages = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const found = snapshot.resources.reviewStages.filter(({ caseId, level }) => caseIdSet.has(caseId) && level === "LEVEL_1");
    return found.length === operationCount ? found : undefined;
  }, { timeoutMs: 120_000, label: "performance review stages", children: workers });
  const operations = await fixedLoad(ctx, { count: operationCount, concurrency: 64, request: async (index) => {
    const stage = stages[index], reviewerId = `perf-reviewer-${index % 32}`;
    const contentItemId = find(created[index].json, "contentItemId");
    const one = apis[index % apis.length].baseUrl;
    const two = apis[(index + 1) % apis.length].baseUrl;
    const appends = await Promise.all([one, two].map((baseUrl, contender) => ctx.mutate(
      baseUrl,
      `/api/v1/content-items/${contentItemId}/evidence-versions`,
      `perf-evidence-${index}-${contender}`,
      { expectedHeadVersion: 1, kind: "REPORT", digest: digest(`report-${index}-${contender}`), summary: `report ${index} ${contender}`, createdBy: reviewerId },
    )));
    assert.equal(appends.filter(({ status }) => status >= 200 && status < 300).length, 1);
    const rejectedAppends = appends.filter(({ status }) => status < 200 || status >= 300);
    assert.equal(rejectedAppends.length, 1);
    assert.ok(rejectedAppends.every(({ status, json }) => status === 409 && json?.error?.code === "EVIDENCE_HEAD_CHANGED"));
    const claimed = await ctx.mutate(one, `/api/v1/review-stages/${stage.stageId}/claim`, `perf-claim-${index}`, { reviewerId, leaseSeconds: 20 });
    if (claimed.status < 200 || claimed.status >= 300) return claimed;
    const decisions = await Promise.all([
      ctx.mutate(one, `/api/v1/review-stages/${stage.stageId}/decisions`, `perf-decide-${index}-allow`, { reviewerId, outcome: "ALLOW", categoryCode: "SAFE", reason: "verified" }),
      ctx.mutate(two, `/api/v1/review-stages/${stage.stageId}/decisions`, `perf-decide-${index}-remove`, { reviewerId, outcome: "REMOVE", categoryCode: "ABUSE", reason: "verified" }),
    ]);
    assert.equal(decisions.filter(({ status }) => status >= 200 && status < 300).length, 1);
    const rejectedDecisions = decisions.filter(({ status }) => status < 200 || status >= 300);
    assert.equal(rejectedDecisions.length, 1);
    assert.ok(rejectedDecisions.every(({ status, json }) => status === 409 && json?.error?.code === "REVIEW_TERMINAL"));
    const appeals = await Promise.all([one, two].map((baseUrl, contender) => ctx.mutate(
      baseUrl,
      `/api/v1/moderation-cases/${caseIds[index]}/appeals`,
      `perf-appeal-${index}-${contender}`,
      { reason: "performance appeal" },
    )));
    assert.equal(appeals.filter(({ status }) => status >= 200 && status < 300).length, 1);
    const rejectedAppeals = appeals.filter(({ status }) => status < 200 || status >= 300);
    assert.equal(rejectedAppeals.length, 1);
    assert.ok(rejectedAppeals.every(({ status, json }) => status === 409 && json?.error?.code === "APPEAL_ALREADY_EXISTS"));
    return appeals.find(({ status }) => status >= 200 && status < 300);
  }});
  assert.ok(operations.throughput >= 150 && operations.p95 <= 800, `evidence-appeal-contention ${operations.throughput}/s p95=${operations.p95}`);
  assertSuccessful(operations, operationCount);
  const afterContention = await ctx.snapshot(apis[0].baseUrl);
  const contentItemIds = new Set(created.map(({ json }) => find(json, "contentItemId")));
  const evidenceCounts = new Map();
  for (const evidence of afterContention.resources.evidenceVersions) {
    if (contentItemIds.has(evidence.contentItemId)) evidenceCounts.set(evidence.contentItemId, (evidenceCounts.get(evidence.contentItemId) ?? 0) + 1);
  }
  assert.equal(evidenceCounts.size, operationCount);
  assert.ok([...evidenceCounts.values()].every((count) => count === 2));
  const stageIds = new Set(stages.map(({ stageId }) => stageId));
  const decisions = afterContention.resources.moderationDecisions.filter(({ stageId }) => stageIds.has(stageId));
  assert.equal(decisions.length, operationCount);
  assert.equal(new Set(decisions.map(({ stageId }) => stageId)).size, operationCount);
  const appeals = afterContention.resources.appeals.filter(({ caseId }) => caseIdSet.has(caseId));
  assert.equal(appeals.length, operationCount);
  assert.equal(new Set(appeals.map(({ caseId }) => caseId)).size, operationCount);
  assertions.push(`evidence-appeal-contention ${operations.throughput.toFixed(1)}/s p95 ${operations.p95.toFixed(1)}ms`);

  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const boundaryCount = Math.max(250, Math.ceil(10_000 * scale));
  const beforeCount = Math.max(1, Math.floor(boundaryCount * .8));
  const afterCount = boundaryCount - beforeCount;
  const oldPolicyVersionId = await createPolicyVersion(ctx, apis[0].baseUrl, 90, "REMOVE");
  await activate(ctx, apis[0].baseUrl, oldPolicyVersionId, policyVersionId, "perf-activate-old-policy");
  const beforeActivation = await ctx.concurrent(Array.from({ length: beforeCount }), 64, (_, index) =>
    ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/content-items", `perf-boundary-before-${index}`, contentPayload(3_000_000 + index)));
  assert.ok(beforeActivation.every(({ status }) => status >= 200 && status < 300));
  const beforeCaseIds = beforeActivation.map(({ json }) => find(json, "caseId"));
  const beforeCaseIdSet = new Set(beforeCaseIds);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && beforeCaseIdSet.has(entry.json?.aggregateId) ? held : { status: 204 });
  const first = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "moderationflow-perf" })));
  await ctx.waitFor(() => barrier.ledger.filter((entry) =>
    entry.json?.point === "worker.claimed" && beforeCaseIdSet.has(entry.json?.aggregateId)).length >= 2, {
    label: "two pre-activation Case claims", children: first,
  });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  release({ status: 204 });
  const newPolicyVersionId = await createPolicyVersion(ctx, apis[0].baseUrl, 91, "ALLOW");
  await activate(ctx, apis[0].baseUrl, newPolicyVersionId, oldPolicyVersionId, "perf-activate-new-policy");
  const afterActivation = await ctx.concurrent(Array.from({ length: afterCount }), 64, (_, index) =>
    ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/content-items", `perf-boundary-after-${index}`, contentPayload(4_000_000 + index)));
  assert.ok(afterActivation.every(({ status }) => status >= 200 && status < 300));
  const afterCaseIds = afterActivation.map(({ json }) => find(json, "caseId"));
  const allCaseIds = new Set([...beforeCaseIds, ...afterCaseIds]);
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const stages = snapshot.resources.reviewStages.filter(({ caseId, level }) => allCaseIds.has(caseId) && level === "LEVEL_1");
    const work = snapshot.work.filter(({ aggregateId }) => allCaseIds.has(aggregateId));
    return stages.length === boundaryCount && work.length === boundaryCount && work.every(({ terminal }) => terminal)
      ? snapshot : undefined;
  }, { timeoutMs: 90_000, label: "policy boundary recovery", children: replacements });
  const durationMs = Date.now() - startedAt;
  assertFrozenCases(final, beforeCaseIds, oldPolicyVersionId, 1);
  assertFrozenCases(final, afterCaseIds, newPolicyVersionId, 1);
  const levelOneStages = final.resources.reviewStages.filter(({ caseId, level }) => allCaseIds.has(caseId) && level === "LEVEL_1");
  assert.equal(new Set(levelOneStages.map(({ caseId }) => caseId)).size, boundaryCount);
  assert.ok(durationMs <= 90_000);
  verifyAudit(final);
  assertions.push(`policy-boundary-recovery ${boundaryCount} cases in ${durationMs}ms after two SIGKILLs`);
  return { metrics: [{ scenarioId:"moderation-ingest",...ingest},{scenarioId:"evidence-appeal-contention",...operations},{scenarioId:"policy-boundary-recovery",completed:boundaryCount,durationMs,killedWorkers:2,replacementWorkers:4}] };
}

export default standardAdapter(spec);
