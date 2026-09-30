import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `42000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const ruleSetId = id(2);
const baselineVersionId = id(3);
const candidateVersionId = id(4);
const errorCandidateVersionId = id(5);
const draftVersionId = id(6);
const createdAt = "2026-01-01T00:00:00.000Z";
let migrationHistory;

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function rules(versionId, count, { candidate = false, namespace = candidate ? 200_000 : 100_000 } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    ruleId: id(namespace + index),
    ruleSetVersionId: versionId,
    priority: index + 1,
    name: `rule-${index + 1}`,
    condition: index === 0
      ? { op: "eq", path: "$.risk", value: "high" }
      : { op: "eq", path: "$.bucket", value: index },
    effect: {
      decision: index === 0 ? (candidate ? "REVIEW" : "DENY") : "ALLOW",
      tags: index === 0 ? [candidate ? "candidate-high" : "baseline-high"] : [`bucket-${index}`],
    },
    terminal: index < 10,
  }));
}

function errorRules() {
  return [{
    ruleId: id(300_000),
    ruleSetVersionId: errorCandidateVersionId,
    priority: 1,
    name: "safe-integer-score",
    condition: { op: "lt", path: "$.score", value: 10 },
    effect: { decision: "REVIEW", tags: ["score-review"] },
    terminal: true,
  }];
}

export function ruleBenchSeed(seedVersion = "hidden-rulebench", baselineCount = 20, candidateCount = 20) {
  const baselineRules = rules(baselineVersionId, baselineCount);
  const candidateRules = rules(candidateVersionId, candidateCount, { candidate: true });
  const invalidFactRules = errorRules();
  const draftRules = rules(draftVersionId, 2, { namespace: 400_000 });
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Rules Tenant" }],
    ruleSets: [{
      ruleSetId, tenantId, name: "Hidden Decisions", currentRevision: 4,
      currentPublishedVersionId: baselineVersionId, publicationRevision: 1, createdAt,
    }],
    ruleSetVersions: [
      { ruleSetVersionId: baselineVersionId, ruleSetId, tenantId, revision: 1, state: "PUBLISHED", defaultDecision: "REVIEW", rulesDigest: sha256Canonical(baselineRules), publishedAt: createdAt },
      { ruleSetVersionId: candidateVersionId, ruleSetId, tenantId, revision: 2, state: "PUBLISHED", defaultDecision: "REVIEW", rulesDigest: sha256Canonical(candidateRules), publishedAt: createdAt },
      { ruleSetVersionId: errorCandidateVersionId, ruleSetId, tenantId, revision: 3, state: "PUBLISHED", defaultDecision: "REVIEW", rulesDigest: sha256Canonical(invalidFactRules), publishedAt: createdAt },
      { ruleSetVersionId: draftVersionId, ruleSetId, tenantId, revision: 4, state: "DRAFT", defaultDecision: "REVIEW", rulesDigest: sha256Canonical(draftRules), publishedAt: null },
    ],
    rules: [...baselineRules, ...candidateRules, ...invalidFactRules, ...draftRules],
    evaluations: [], explanationNodes: [], replayRuns: [], conflictReports: [],
  };
}

function evaluationPayload(index, versionId = baselineVersionId, facts = undefined) {
  return {
    tenantId,
    ruleSetId,
    ruleSetVersionId: versionId,
    facts: facts ?? { risk: index % 3 === 0 ? "high" : "low", bucket: index % 50, requestId: `request-${index}` },
  };
}

function success(response) {
  return response.status >= 200 && response.status < 300;
}

function responseRun(response) {
  const run = response.json?.run;
  assert.ok(run && typeof run === "object", `missing ComparisonRun: ${response.text}`);
  assert.deepEqual(Object.keys(run).sort(), [
    "baselineVersionId", "cancelledAt", "candidateVersionId", "comparisonRunId", "completedAt",
    "corpusDigest", "createdAt", "evaluationIds", "promotedAt", "resultCounts", "revision",
    "ruleSetId", "startedAt", "state", "tenantId",
  ].sort());
  return run;
}

function resultProjection(result) {
  const { resultDigest: _digest, ...projection } = result;
  return projection;
}

function assertComparisonResult(result) {
  assert.deepEqual(Object.keys(result).sort(), [
    "baseline", "candidate", "comparisonRunId", "errorCode", "evaluationId", "ordinal", "resultDigest", "status",
  ].sort());
  assert.ok(["MATCH", "DIFF", "ERROR"].includes(result.status));
  assert.match(result.resultDigest, /^[0-9a-f]{64}$/u);
  assert.equal(result.resultDigest, sha256Canonical(resultProjection(result)));
  if (result.status === "MATCH") {
    assert.deepEqual(result.baseline, result.candidate);
    assert.equal(result.errorCode, null);
  }
  if (result.status === "DIFF") {
    assert.notDeepEqual(result.baseline, result.candidate);
    assert.equal(result.errorCode, null);
  }
  if (result.status === "ERROR") assert.equal(typeof result.errorCode, "string");
  for (const side of [result.baseline, result.candidate].filter(Boolean)) {
    assert.deepEqual(Object.keys(side).sort(), ["decision", "explanationDigest", "tags"]);
  }
}

async function waitForDrain(ctx, baseUrl, children, timeoutMs = 120_000) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs, label: "RuleBench work drain", children });
}

async function createComparison(ctx, baseUrl, key, evaluationIds, candidateId = candidateVersionId) {
  const response = await ctx.mutate(baseUrl, "/api/v1/comparison-runs", key, {
    tenantId, ruleSetId, baselineVersionId, candidateVersionId: candidateId, evaluationIds,
  });
  assert.ok(success(response), response.text);
  assert.deepEqual(Object.keys(response.json).sort(), ["run"]);
  return response;
}

async function startComparison(ctx, baseUrl, response, key) {
  const run = responseRun(response);
  const started = await ctx.mutate(baseUrl, `/api/v1/comparison-runs/${run.comparisonRunId}/start`, key, {
    expectedRevision: run.revision,
  });
  assert.ok(success(started), started.text);
  assert.deepEqual(Object.keys(started.json).sort(), ["run"]);
  return started;
}

const spec = {
  label: "RuleBench Evaluation acceptance",
  performanceScenarioIds: ["evaluation-throughput", "deep-short-circuit", "comparison-recovery"],
  seed: async () => ruleBenchSeed(),
  path: "/api/v1/evaluations",
  payload: (index) => evaluationPayload(index),
  conflictPayload: () => evaluationPayload(0, baselineVersionId, { risk: "low", bucket: 99, requestId: "conflict" }),
  resource: "evaluations",
  identity: (json) => find(json, "evaluationId"),
  resourceIdentity: ({ evaluationId }) => evaluationId,
  workIdentity: (json) => find(json, "evaluationId"),
  async afterPrepare(ctx, api, receiver, workspace) {
    if (workspace === ctx.workspace) return;

    const completed = await ctx.mutate(api.baseUrl, "/api/v1/evaluations", "h09-history-evaluation", evaluationPayload(700));
    assert.ok(success(completed), completed.text);
    const completedEvaluationId = find(completed.json, "evaluationId");
    const worker = await ctx.startWorker({}, workspace);
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(api.baseUrl);
      return snapshot.resources.evaluations.find(({ evaluationId, state }) => (
        evaluationId === completedEvaluationId && state === "COMPLETED"
      ));
    }, { timeoutMs: 60_000, label: "V1 completed Evaluation", children: [worker] });

    const replay = await ctx.mutate(api.baseUrl, `/api/v1/evaluations/${completedEvaluationId}/replay`, "h09-history-replay", {});
    assert.ok(success(replay), replay.text);
    const replayRunId = find(replay.json, "replayRunId");
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(api.baseUrl);
      return snapshot.resources.replayRuns.find(({ replayRunId: value, state }) => value === replayRunId && state === "MATCHED");
    }, { timeoutMs: 60_000, label: "V1 matched ReplayRun", children: [worker] });
    await ctx.stop(worker);

    const pending = await ctx.mutate(api.baseUrl, "/api/v1/evaluations", "h09-history-pending", evaluationPayload(701));
    assert.ok(success(pending), pending.text);
    const pendingEvaluationId = find(pending.json, "evaluationId");
    let releaseWorker;
    const heldWorker = new Promise((resolve) => { releaseWorker = resolve; });
    const workerBarrier = await ctx.receiver((entry) => (
      entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingEvaluationId
    ) ? heldWorker : { status: 204 });
    const staleWorker = await ctx.startWorker({
      TEST_BARRIER_URL: workerBarrier.url, TEST_BARRIER_TOKEN: "rulebench-h09-worker",
    }, workspace);
    await ctx.waitFor(() => workerBarrier.ledger.some((entry) => (
      entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingEvaluationId
    )), { timeoutMs: 60_000, label: "V1 pending Evaluation lease", children: [staleWorker] });
    await ctx.stop(staleWorker, "SIGKILL");
    releaseWorker({ status: 204 });

    let releaseDispatcher;
    const heldDispatcher = new Promise((resolve) => { releaseDispatcher = resolve; });
    const dispatcherBarrier = await ctx.receiver((entry) => (
      entry.json?.point === "dispatcher.response-received"
    ) ? heldDispatcher : { status: 204 });
    const dispatcher = await ctx.startDispatcher(receiver.url, {
      TEST_BARRIER_URL: dispatcherBarrier.url, TEST_BARRIER_TOKEN: "rulebench-h09-dispatcher",
    }, workspace);
    await ctx.waitFor(() => dispatcherBarrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
      timeoutMs: 60_000, label: "V1 unconfirmed Event", children: [dispatcher],
    });
    await ctx.stop(dispatcher, "SIGKILL");
    releaseDispatcher({ status: 204 });

    const snapshot = await ctx.snapshot(api.baseUrl);
    migrationHistory = {
      completedEvaluation: structuredClone(snapshot.resources.evaluations.find(({ evaluationId }) => evaluationId === completedEvaluationId)),
      explanationNodes: snapshot.resources.explanationNodes.filter(({ evaluationId }) => evaluationId === completedEvaluationId).map((entry) => structuredClone(entry)),
      replayRun: structuredClone(snapshot.resources.replayRuns.find(({ replayRunId: value }) => value === replayRunId)),
      pendingEvaluation: structuredClone(snapshot.resources.evaluations.find(({ evaluationId }) => evaluationId === pendingEvaluationId)),
      pendingWork: snapshot.work.filter(({ aggregateId }) => aggregateId === pendingEvaluationId).map((entry) => structuredClone(entry)),
      eventIds: snapshot.events.map(({ eventId }) => eventId),
      versions: snapshot.resources.ruleSetVersions.filter(({ ruleSetVersionId }) => (
        ruleSetVersionId === baselineVersionId || ruleSetVersionId === candidateVersionId
      )).map((entry) => structuredClone(entry)),
    };
    assert.ok(migrationHistory.completedEvaluation);
    assert.ok(migrationHistory.explanationNodes.length > 0);
    assert.equal(migrationHistory.replayRun.state, "MATCHED");
    assert.ok(migrationHistory.pendingWork.some(({ terminal }) => !terminal));
  },
  async verify(ctx, baseUrl, response) {
    const evaluationId = find(response.json, "evaluationId");
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      const evaluation = value.resources.evaluations.find((entry) => entry.evaluationId === evaluationId);
      return evaluation?.state === "COMPLETED" ? value : undefined;
    }, { timeoutMs: 60_000, label: "Evaluation COMPLETED", children: [worker] });
    const evaluation = snapshot.resources.evaluations.find((entry) => entry.evaluationId === evaluationId);
    assert.equal(evaluation.decision, "DENY");
    assert.equal(evaluation.matchedRuleIds[0], id(100_000));
    const nodes = snapshot.resources.explanationNodes.filter((entry) => entry.evaluationId === evaluationId);
    assert.ok(nodes.length >= 1);
    assert.deepEqual(nodes.map(({ ordinal }) => ordinal), Array.from({ length: nodes.length }, (_, index) => index + 1));
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, "/api/v1/evaluations", "h04-invalid-facts", {
      tenantId, ruleSetId, ruleSetVersionId: baselineVersionId, facts: { score: 1.25 },
    });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.evaluations.length, before.resources.evaluations.length);
    assert.equal(after.resources.explanationNodes.length, before.resources.explanationNodes.length);
    assert.equal(after.work.length, before.work.length);
    assert.equal(after.events.length, before.events.length);
  },
  async contention(ctx, baseUrls) {
    const publication = await Promise.all([
      ctx.mutate(baseUrls[0], `/api/v1/rule-set-versions/${draftVersionId}/publish`, "h06-publish-a", { expectedRevision: 4 }),
      ctx.mutate(baseUrls[1], `/api/v1/rule-set-versions/${draftVersionId}/publish`, "h06-publish-b", { expectedRevision: 4 }),
    ]);
    assert.equal(publication.filter(success).length, 1);
    assert.equal(publication.filter(({ status }) => status === 409).length, 1);

    const bodyRace = await Promise.all([
      ctx.mutate(baseUrls[0], "/api/v1/evaluations", "h06-conflicting-body", evaluationPayload(21)),
      ctx.mutate(baseUrls[1], "/api/v1/evaluations", "h06-conflicting-body", evaluationPayload(22)),
    ]);
    assert.equal(bodyRace.filter(success).length, 1);
    assert.equal(bodyRace.filter(({ status }) => status === 409).length, 1);
    assert.equal(bodyRace.find(({ status }) => status === 409)?.json?.error?.code, "IDEMPOTENCY_CONFLICT");

    const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const snapshot = await waitForDrain(ctx, baseUrls[0], workers);
    assert.equal(new Set(snapshot.resources.evaluations.map(({ evaluationId }) => evaluationId)).size, snapshot.resources.evaluations.length);
    const published = snapshot.resources.ruleSetVersions.filter(({ ruleSetVersionId, state }) => (
      ruleSetVersionId === draftVersionId && state === "PUBLISHED"
    ));
    assert.equal(published.length, 1);
    for (const evaluation of snapshot.resources.evaluations.filter(({ state }) => state === "COMPLETED")) {
      const nodes = snapshot.resources.explanationNodes.filter(({ evaluationId }) => evaluationId === evaluation.evaluationId);
      assert.deepEqual(nodes.map(({ ordinal }) => ordinal), Array.from({ length: nodes.length }, (_, index) => index + 1));
      const baselineRules = snapshot.resources.rules
        .filter(({ ruleSetVersionId }) => ruleSetVersionId === evaluation.ruleSetVersionId)
        .sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
      const terminalRule = baselineRules.find(({ ruleId, terminal }) => terminal && evaluation.matchedRuleIds.includes(ruleId));
      if (!terminalRule) continue;
      for (const rule of baselineRules.filter(({ priority }) => priority > terminalRule.priority)) {
        const skipped = nodes.filter(({ ruleId, result }) => ruleId === rule.ruleId && result === "SKIPPED");
        assert.equal(skipped.length, 1, `rule ${rule.ruleId} was not represented by one SKIPPED node`);
      }
    }
  },
  async migrationVerify(ctx, { created, snapshot }) {
    assert.ok(migrationHistory, "V1 migration history was not prepared");
    assert.deepEqual(snapshot.resources.evaluations.find(({ evaluationId }) => (
      evaluationId === migrationHistory.completedEvaluation.evaluationId
    )), migrationHistory.completedEvaluation);
    assert.deepEqual(snapshot.resources.evaluations.find(({ evaluationId }) => (
      evaluationId === migrationHistory.pendingEvaluation.evaluationId
    )), migrationHistory.pendingEvaluation);
    for (const expected of migrationHistory.explanationNodes) {
      assert.deepEqual(snapshot.resources.explanationNodes.find(({ evaluationId, ordinal }) => (
        evaluationId === expected.evaluationId && ordinal === expected.ordinal
      )), expected);
    }
    assert.deepEqual(snapshot.resources.replayRuns.find(({ replayRunId }) => (
      replayRunId === migrationHistory.replayRun.replayRunId
    )), migrationHistory.replayRun);
    for (const expected of migrationHistory.pendingWork) {
      assert.deepEqual(snapshot.work.find(({ workId }) => workId === expected.workId), expected);
    }
    const eventIds = new Set(snapshot.events.map(({ eventId }) => eventId));
    assert.ok(migrationHistory.eventIds.every((eventId) => eventIds.has(eventId)));
    for (const expected of migrationHistory.versions) {
      assert.deepEqual(snapshot.resources.ruleSetVersions.find(({ ruleSetVersionId }) => (
        ruleSetVersionId === expected.ruleSetVersionId
      )), expected);
    }
    const createdEvaluationId = find(created.json, "evaluationId");
    assert.ok(snapshot.resources.evaluations.some(({ evaluationId }) => evaluationId === createdEvaluationId));
    assert.ok(snapshot.work.some(({ aggregateId }) => aggregateId === createdEvaluationId));
    assert.equal(snapshot.resources.comparisonRuns.length, 0);
    assert.equal(snapshot.resources.comparisonResults.length, 0);
  },
  manager: {
    async prepare(ctx, baseUrl) {
      const worker = await ctx.startWorker();
      const evaluations = await Promise.all(Array.from({ length: 16 }, (_, index) => ctx.mutate(
        baseUrl, "/api/v1/evaluations", `manager-evaluation-${index}`, evaluationPayload(1_000 + index),
      )));
      assert.ok(evaluations.every(success));
      const evaluationIds = evaluations.map(({ json }) => find(json, "evaluationId"));
      const before = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        return evaluationIds.every((evaluationId) => snapshot.resources.evaluations.some((entry) => (
          entry.evaluationId === evaluationId && entry.state === "COMPLETED"
        ))) ? snapshot : undefined;
      }, { timeoutMs: 60_000, label: "Comparison corpus completed", children: [worker] });
      const sortedIds = [...evaluationIds].sort();
      return {
        path: "/api/v1/comparison-runs",
        payload: () => ({
          tenantId, ruleSetId, baselineVersionId, candidateVersionId,
          evaluationIds: [...evaluationIds].reverse().concat(evaluationIds[0], evaluationIds.at(-1)),
        }),
        evaluationIds: sortedIds,
        originalEvaluations: before.resources.evaluations
          .filter(({ evaluationId }) => evaluationIds.includes(evaluationId))
          .map((entry) => structuredClone(entry)),
      };
    },
    async verify(ctx, baseUrl, response, operation) {
      assert.deepEqual(Object.keys(response.json).sort(), ["run"]);
      const createdRun = responseRun(response);
      assert.deepEqual(createdRun.evaluationIds, operation.evaluationIds);
      assert.equal(createdRun.corpusDigest, sha256Canonical(operation.evaluationIds));
      const frozenRun = structuredClone(createdRun);

      const publication = await ctx.mutate(baseUrl, `/api/v1/rule-set-versions/${draftVersionId}/publish`, "h10-change-publication", {
        expectedRevision: 4,
      });
      assert.ok(success(publication), publication.text);
      const started = await startComparison(ctx, baseUrl, response, "h10-start");
      assert.equal(responseRun(started).state, "RUNNING");
      const worker = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const run = value.resources.comparisonRuns.find(({ comparisonRunId }) => comparisonRunId === createdRun.comparisonRunId);
        return run?.state === "COMPLETED" ? value : undefined;
      }, { timeoutMs: 60_000, label: "ComparisonRun COMPLETED", children: [worker] });
      const run = snapshot.resources.comparisonRuns.find(({ comparisonRunId }) => comparisonRunId === createdRun.comparisonRunId);
      assert.deepEqual(run.evaluationIds, frozenRun.evaluationIds);
      assert.equal(run.corpusDigest, frozenRun.corpusDigest);
      assert.equal(run.baselineVersionId, baselineVersionId);
      assert.equal(run.candidateVersionId, candidateVersionId);
      const results = snapshot.resources.comparisonResults
        .filter(({ comparisonRunId }) => comparisonRunId === createdRun.comparisonRunId)
        .sort((left, right) => left.ordinal - right.ordinal);
      assert.equal(results.length, operation.evaluationIds.length);
      assert.deepEqual(results.map(({ evaluationId }) => evaluationId), operation.evaluationIds);
      assert.deepEqual(results.map(({ ordinal }) => ordinal), Array.from({ length: results.length }, (_, index) => index + 1));
      for (const result of results) assertComparisonResult(result);
      assert.deepEqual(run.resultCounts, {
        MATCH: results.filter(({ status }) => status === "MATCH").length,
        DIFF: results.filter(({ status }) => status === "DIFF").length,
        ERROR: results.filter(({ status }) => status === "ERROR").length,
      });
      for (const original of operation.originalEvaluations) {
        const current = snapshot.resources.evaluations.find(({ evaluationId }) => evaluationId === original.evaluationId);
        assert.deepEqual(current, original);
      }
      assert.ok(snapshot.work.some(({ kind, aggregateId }) => kind === "COMPARISON_EXECUTE" && aggregateId === createdRun.comparisonRunId));
      assert.ok(snapshot.events.some(({ type, aggregateId }) => type === "comparison.completed" && aggregateId === createdRun.comparisonRunId));
      const read = await ctx.request(baseUrl, `/api/v1/comparison-runs/${createdRun.comparisonRunId}`);
      assert.equal(read.status, 200, read.text);
      assert.deepEqual(Object.keys(read.json).sort(), ["results", "run"]);
      assert.deepEqual(responseRun(read), run);
      assert.deepEqual(read.json.results, results);
      const html = await ctx.request(baseUrl, "/");
      assert.equal(html.status, 200);
      assert.match(html.text, /<html|<!doctype/iu);
    },
    async concurrentVerify(ctx, baseUrls, response, operation) {
      const originalRun = responseRun(response);
      const startCancel = await Promise.all([
        ctx.mutate(baseUrls[0], `/api/v1/comparison-runs/${originalRun.comparisonRunId}/start`, "h11-start", { expectedRevision: originalRun.revision }),
        ctx.mutate(baseUrls[1], `/api/v1/comparison-runs/${originalRun.comparisonRunId}/cancel`, "h11-cancel", { expectedRevision: originalRun.revision }),
      ]);
      assert.equal(startCancel.filter(success).length, 1);
      assert.equal(startCancel.filter(({ status }) => status === 409).length, 1);
      assert.equal(startCancel.find(({ status }) => status === 409)?.json?.error?.code, "COMPARISON_REVISION_CONFLICT");

      const fenced = await createComparison(ctx, baseUrls[0], "h11-fenced-run", operation.evaluationIds);
      const fencedStarted = await startComparison(ctx, baseUrls[0], fenced, "h11-fenced-start");
      const fencedRun = responseRun(fencedStarted);
      let releaseFence;
      const fenceHeld = new Promise((resolve) => { releaseFence = resolve; });
      const fenceBarrier = await ctx.receiver((entry) => (
        entry.json?.point === "worker.claimed" && entry.json?.aggregateId === fencedRun.comparisonRunId
      ) ? fenceHeld : { status: 204 });
      const staleWorker = await ctx.startWorker({ TEST_BARRIER_URL: fenceBarrier.url, TEST_BARRIER_TOKEN: "rulebench-cancel-fence" });
      await ctx.waitFor(() => fenceBarrier.ledger.some((entry) => entry.json?.aggregateId === fencedRun.comparisonRunId), {
        timeoutMs: 60_000, label: "cancelled comparison claim", children: [staleWorker],
      });
      const cancelled = await ctx.mutate(baseUrls[1], `/api/v1/comparison-runs/${fencedRun.comparisonRunId}/cancel`, "h11-fenced-cancel", {
        expectedRevision: fencedRun.revision,
      });
      assert.ok(success(cancelled), cancelled.text);
      assert.deepEqual(Object.keys(cancelled.json).sort(), ["run"]);
      assert.equal(responseRun(cancelled).state, "CANCELLED");
      await ctx.stop(staleWorker, "SIGKILL");
      releaseFence({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const fenceReplacement = await ctx.startWorker();
      await new Promise((resolve) => setTimeout(resolve, 500));
      let snapshot = await ctx.snapshot(baseUrls[0]);
      assert.equal(snapshot.resources.comparisonRuns.find(({ comparisonRunId }) => comparisonRunId === fencedRun.comparisonRunId)?.state, "CANCELLED");
      assert.equal(snapshot.resources.comparisonResults.filter(({ comparisonRunId }) => comparisonRunId === fencedRun.comparisonRunId).length, 0);
      assert.equal(snapshot.events.filter(({ type, aggregateId }) => (
        type === "comparison.cancelled" && aggregateId === fencedRun.comparisonRunId
      )).length, 1);
      await ctx.stop(fenceReplacement);

      const recovery = await createComparison(ctx, baseUrls[0], "h11-recovery-run", operation.evaluationIds);
      const recoveryStarted = await startComparison(ctx, baseUrls[0], recovery, "h11-recovery-start");
      const recoveryRun = responseRun(recoveryStarted);
      let releaseRecovery;
      const recoveryHeld = new Promise((resolve) => { releaseRecovery = resolve; });
      const recoveryBarrier = await ctx.receiver((entry) => (
        entry.json?.point === "worker.claimed" && entry.json?.aggregateId === recoveryRun.comparisonRunId
      ) ? recoveryHeld : { status: 204 });
      const killed = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({
        TEST_BARRIER_URL: recoveryBarrier.url, TEST_BARRIER_TOKEN: "rulebench-recovery",
      })));
      await ctx.waitFor(() => recoveryBarrier.ledger.filter(({ json }) => json?.aggregateId === recoveryRun.comparisonRunId).length >= 2, {
        timeoutMs: 60_000, label: "two comparison claims", children: killed,
      });
      await Promise.all(killed.map((worker) => ctx.stop(worker, "SIGKILL")));
      releaseRecovery({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const run = value.resources.comparisonRuns.find(({ comparisonRunId }) => comparisonRunId === recoveryRun.comparisonRunId);
        return run?.state === "COMPLETED" ? value : undefined;
      }, { timeoutMs: 60_000, label: "comparison recovery", children: replacements });
      const completedRun = snapshot.resources.comparisonRuns.find(({ comparisonRunId }) => comparisonRunId === recoveryRun.comparisonRunId);
      const recoveryResults = snapshot.resources.comparisonResults.filter(({ comparisonRunId }) => comparisonRunId === recoveryRun.comparisonRunId);
      assert.equal(recoveryResults.length, operation.evaluationIds.length);
      assert.equal(new Set(recoveryResults.map(({ evaluationId }) => evaluationId)).size, operation.evaluationIds.length);
      assert.ok(recoveryResults.every((entry) => {
        assertComparisonResult(entry);
        return true;
      }));
      assert.equal(snapshot.events.filter(({ type, aggregateId }) => (
        type === "comparison.completed" && aggregateId === recoveryRun.comparisonRunId
      )).length, 1);

      const publicationBefore = snapshot.resources.ruleSets.find(({ ruleSetId: value }) => value === ruleSetId);
      const promotions = await Promise.all([
        ctx.mutate(baseUrls[0], `/api/v1/comparison-runs/${recoveryRun.comparisonRunId}/promote`, "h11-promote-a", { expectedRevision: completedRun.revision }),
        ctx.mutate(baseUrls[1], `/api/v1/comparison-runs/${recoveryRun.comparisonRunId}/promote`, "h11-promote-b", { expectedRevision: completedRun.revision }),
      ]);
      assert.equal(promotions.filter(success).length, 1);
      assert.equal(promotions.filter(({ status }) => status === 409).length, 1);
      assert.equal(promotions.find(({ status }) => status === 409)?.json?.error?.code, "COMPARISON_REVISION_CONFLICT");
      const promoted = promotions.find(success);
      assert.deepEqual(Object.keys(promoted.json).sort(), ["ruleSet", "run"]);
      assert.equal(responseRun(promoted).state, "COMPLETED");
      assert.ok(promoted.json?.ruleSet && typeof promoted.json.ruleSet === "object");
      snapshot = await ctx.snapshot(baseUrls[0]);
      const publicationAfter = snapshot.resources.ruleSets.find(({ ruleSetId: value }) => value === ruleSetId);
      assert.equal(publicationAfter.currentPublishedVersionId, candidateVersionId);
      assert.equal(publicationAfter.publicationRevision, publicationBefore.publicationRevision + 1);
      assert.equal(snapshot.events.filter(({ type, aggregateId }) => (
        type === "comparison.promoted" && aggregateId === recoveryRun.comparisonRunId
      )).length, 1);

      const errorEvaluation = await ctx.mutate(baseUrls[0], "/api/v1/evaluations", "h11-error-evaluation", evaluationPayload(
        90_000, baselineVersionId, { risk: "low", bucket: 42, score: "not-an-integer", requestId: "error-corpus" },
      ));
      assert.ok(success(errorEvaluation), errorEvaluation.text);
      const errorEvaluationId = find(errorEvaluation.json, "evaluationId");
      await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        return value.resources.evaluations.some(({ evaluationId, state }) => (
          evaluationId === errorEvaluationId && state === "COMPLETED"
        ));
      }, { timeoutMs: 60_000, label: "ERROR corpus evaluation", children: replacements });
      const errorComparison = await createComparison(ctx, baseUrls[0], "h11-error-run", [errorEvaluationId], errorCandidateVersionId);
      const errorStarted = await startComparison(ctx, baseUrls[0], errorComparison, "h11-error-start");
      const errorRun = responseRun(errorStarted);
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const run = value.resources.comparisonRuns.find(({ comparisonRunId }) => comparisonRunId === errorRun.comparisonRunId);
        return run?.state === "COMPLETED" ? value : undefined;
      }, { timeoutMs: 60_000, label: "ERROR comparison", children: replacements });
      const completedErrorRun = snapshot.resources.comparisonRuns.find(({ comparisonRunId }) => comparisonRunId === errorRun.comparisonRunId);
      const errorResult = snapshot.resources.comparisonResults.find(({ comparisonRunId }) => comparisonRunId === errorRun.comparisonRunId);
      assert.equal(completedErrorRun.resultCounts.ERROR, 1);
      assert.equal(errorResult.status, "ERROR");
      assertComparisonResult(errorResult);
      const pointerBeforeErrorPromotion = structuredClone(snapshot.resources.ruleSets.find(({ ruleSetId: value }) => value === ruleSetId));
      const blocked = await ctx.mutate(baseUrls[1], `/api/v1/comparison-runs/${errorRun.comparisonRunId}/promote`, "h11-error-promote", {
        expectedRevision: completedErrorRun.revision,
      });
      assert.equal(blocked.status, 409, blocked.text);
      assert.equal(blocked.json?.error?.code, "COMPARISON_HAS_ERRORS");
      const afterBlocked = await ctx.snapshot(baseUrls[0]);
      assert.deepEqual(afterBlocked.resources.ruleSets.find(({ ruleSetId: value }) => value === ruleSetId), pointerBeforeErrorPromotion);
    },
  },
  performance: ruleBenchPerformance,
};

function scaledCount(base, scale, minimum) {
  return Math.min(base, Math.max(minimum, Math.ceil(base * scale)));
}

function percentile(values, fraction) {
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

async function fixedLoad({ count, concurrency, request }) {
  let next = 0;
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next++;
      const started = performance.now();
      const response = await request(index);
      latencies.push(performance.now() - started);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    }
  }));
  const durationMs = Math.max(1, performance.now() - startedAt);
  latencies.sort((left, right) => left - right);
  return {
    requested: count,
    completed: latencies.length,
    durationMs,
    throughput: count / (durationMs / 1_000),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    statuses: Object.fromEntries(statuses),
  };
}

function assertSuccessfulLoad(metric, label) {
  assert.equal(metric.completed, metric.requested, `${label} did not execute its fixed request count`);
  const failures = Object.entries(metric.statuses)
    .filter(([status]) => Number(status) < 200 || Number(status) >= 300)
    .reduce((sum, [, count]) => sum + count, 0);
  assert.equal(failures, 0, `${label} returned non-2xx responses: ${JSON.stringify(metric.statuses)}`);
}

function assertEventOrder(events) {
  const groups = new Map();
  for (const event of events) {
    const values = groups.get(event.aggregateId) ?? [];
    values.push(event.sequence);
    groups.set(event.aggregateId, values);
  }
  for (const sequences of groups.values()) {
    sequences.sort((left, right) => left - right);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  }
}

async function ruleBenchPerformance(ctx, assertions) {
  const scale = performanceScale();
  const evaluationCount = scaledCount(200_000, scale, 1_000);
  const deepCount = scaledCount(100_000, scale, 1_000);
  const corpusCount = scaledCount(50_000, scale, 500);
  await ctx.prepare();
  assert.equal((await ctx.seed(ruleBenchSeed(`perf-rulebench-${scale}`, 200, 5_000))).exitCode, 0);
  const apis = [await ctx.startApi(), await ctx.startApi()];
  let workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const webhook = await ctx.receiver();
  const dispatcher = await ctx.startDispatcher(webhook.url);

  const evaluationIds = new Array(evaluationCount);
  const evaluation = await fixedLoad({ count: evaluationCount, concurrency: 64, request: async (index) => {
    const response = await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/evaluations", `perf-evaluation-${index}`, evaluationPayload(100_000 + index));
    if (success(response)) evaluationIds[index] = find(response.json, "evaluationId");
    return response;
  } });
  assertSuccessfulLoad(evaluation, "evaluation-throughput");
  assert.ok(evaluation.throughput >= 600 && evaluation.p95 <= 250, `evaluation-throughput ${evaluation.throughput}/s p95=${evaluation.p95}`);
  assertions.push(`evaluation-throughput ${evaluation.completed}/${200_000} Evaluations at scale ${scale}; ${evaluation.throughput.toFixed(1)}/s p95 ${evaluation.p95.toFixed(1)}ms`);

  const deepIds = new Array(deepCount);
  const deep = await fixedLoad({ count: deepCount, concurrency: 64, request: async (index) => {
    const response = await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/evaluations", `perf-deep-${index}`, evaluationPayload(
      400_000 + index, candidateVersionId,
      { risk: "high", bucket: index % 5_000, requestId: `deep-${index}` },
    ));
    if (success(response)) deepIds[index] = find(response.json, "evaluationId");
    return response;
  } });
  assertSuccessfulLoad(deep, "deep-short-circuit");
  assert.ok(deep.throughput >= 400 && deep.p95 <= 350, `deep-short-circuit ${deep.throughput}/s p95=${deep.p95}`);
  assertions.push(`deep-short-circuit ${deep.completed}/${100_000} Evaluations at scale ${scale}; ${deep.throughput.toFixed(1)}/s p95 ${deep.p95.toFixed(1)}ms`);

  const drained = await waitForDrain(ctx, apis[0].baseUrl, workers, 60_000);
  const evaluationById = new Map(drained.resources.evaluations.map((entry) => [entry.evaluationId, entry]));
  assert.ok(evaluationIds.every((evaluationId) => evaluationById.get(evaluationId)?.state === "COMPLETED"));
  assert.ok(deepIds.every((evaluationId) => {
    const entry = evaluationById.get(evaluationId);
    return entry?.state === "COMPLETED" && entry.ruleSetVersionId === candidateVersionId
      && entry.decision === "REVIEW" && entry.matchedRuleIds[0] === id(200_000);
  }));
  const sampledDeepIds = new Set(deepIds.filter((_, index) => index % Math.max(1, Math.floor(deepCount / 64)) === 0).slice(0, 64));
  const sampledNodes = drained.resources.explanationNodes.filter(({ evaluationId }) => sampledDeepIds.has(evaluationId));
  for (const evaluationId of sampledDeepIds) {
    const nodes = sampledNodes.filter((entry) => entry.evaluationId === evaluationId);
    for (const rule of drained.resources.rules.filter(({ ruleSetVersionId, priority }) => (
      ruleSetVersionId === candidateVersionId && priority > 1
    ))) {
      assert.equal(nodes.filter(({ ruleId, result }) => ruleId === rule.ruleId && result === "SKIPPED").length, 1);
    }
  }

  const corpusIds = [...evaluationIds].sort().slice(0, corpusCount);
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const comparison = await createComparison(ctx, apis[0].baseUrl, "perf-comparison", corpusIds);
  const started = await startComparison(ctx, apis[0].baseUrl, comparison, "perf-comparison-start");
  const comparisonRun = responseRun(started);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => (
    entry.json?.point === "worker.claimed" && entry.json?.aggregateId === comparisonRun.comparisonRunId
  ) ? held : { status: 204 });
  const first = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({
    TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "rulebench-perf",
  })));
  await ctx.waitFor(() => barrier.ledger.filter(({ json }) => json?.aggregateId === comparisonRun.comparisonRunId).length >= 2, {
    timeoutMs: 60_000, label: "Comparison workers claimed", children: first,
  });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const run = snapshot.resources.comparisonRuns.find(({ comparisonRunId }) => comparisonRunId === comparisonRun.comparisonRunId);
    return run?.state === "COMPLETED" ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "Comparison recovery", children: workers });
  const durationMs = Date.now() - startedAt;
  const results = final.resources.comparisonResults.filter(({ comparisonRunId }) => comparisonRunId === comparisonRun.comparisonRunId);
  assert.equal(results.length, corpusCount);
  assert.equal(new Set(results.map(({ evaluationId }) => evaluationId)).size, corpusCount);
  assert.ok(results.every((result) => {
    assertComparisonResult(result);
    return true;
  }));
  assert.equal(final.events.filter(({ type, aggregateId }) => (
    type === "comparison.completed" && aggregateId === comparisonRun.comparisonRunId
  )).length, 1);

  const replay = await ctx.mutate(apis[0].baseUrl, `/api/v1/evaluations/${evaluationIds[0]}/replay`, "perf-replay", {});
  assert.ok(success(replay), replay.text);
  const replayRunId = find(replay.json, "replayRunId");
  const replayed = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    return snapshot.resources.replayRuns.find(({ replayRunId: value, state }) => value === replayRunId && state === "MATCHED");
  }, { timeoutMs: 60_000, label: "performance replay", children: workers });
  assert.ok(replayed.resultDigest);
  assertEventOrder(final.events);
  assert.ok(final.work.every(({ terminal }) => terminal));
  for (const collection of Object.values(final.resources)) {
    assert.ok(collection.every((entry) => entry.tenantId === undefined || entry.tenantId === tenantId));
  }
  const rssBytes = (await Promise.all([...apis, ...workers, dispatcher].map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  assertions.push(`comparison-recovery ${results.length}/${50_000} Results in ${durationMs}ms after two SIGKILLs`);
  return {
    metrics: [
      { scenarioId: "evaluation-throughput", publicCount: 200_000, actualCount: evaluationCount, scale, ...evaluation },
      { scenarioId: "deep-short-circuit", publicCount: 100_000, actualCount: deepCount, scale, ...deep },
      { scenarioId: "comparison-recovery", publicCount: 50_000, actualCount: corpusCount, scale, completed: results.length, durationMs, killedWorkers: 2, replacementWorkers: 4 },
    ],
    topology: { apiProcesses: 2, workers: 4, dispatchers: 1 },
    rssBytes,
    databaseBytes: final.metrics?.databaseBytes ?? null,
  };
}

export default standardAdapter(spec);
