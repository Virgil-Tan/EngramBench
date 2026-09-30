// Policy revision: learning-final-system-2026-09-08.1. One FINAL submission; current public operations, persistence and restart recovery, not a historical binary upgrade.
import {
  EVALUATION_KEYS,
  assertComparisonResult,
  assertEvaluationOracle,
  assertEventLedger,
  assertSuccessfulLoad,
  byId,
  clone,
  coreFixture,
  createComparison,
  createEvaluation,
  createReplay,
  exactKeys,
  expectedComparisonResult,
  finalEvidence,
  fixedLoad,
  formalPerformanceScale,
  guardedCase,
  prepare,
  processRss,
  replaceVersionRules,
  resource,
  rule,
  scaledCount,
  sha256Canonical,
  stableSnapshot,
  startComparison,
  waitForComparison,
  waitForEvaluation,
  waitForReplay,
  waitForWork,
} from "./helpers.mjs";

async function waitPast(ctx, timestamp, label) {
  const deadline = Date.parse(timestamp);
  ctx.ok(Number.isFinite(deadline), `${label} has a valid lease expiry`);
  if (Date.now() <= deadline) await ctx.waitFor(() => Date.now() > deadline + 25, { timeoutMs: 15_000, intervalMs: 10, label });
}

function migrationRules(ctx, versionId, count = 3_000) {
  return Array.from({ length: count }, (_, index) => rule(ctx, versionId, `migration-${index}`, {
    priority: index + 1,
    condition: index === count - 1
      ? { op: "exists", path: "$.risk", value: true }
      : { op: "eq", path: "$.bucket", value: index + 10_000 },
    effect: index === count - 1 ? { decision: "DENY", tags: ["migration"] } : { decision: null, tags: [] },
    terminal: index === count - 1,
  }));
}

const e01 = guardedCase({
  id: "E-01",
  fixtureFamily: "RB-F-POPULATED-base-system-reinitialization",
  action: "Using the FINAL runtime before and after restart, create unknown-response idempotency, completed Evaluation and Replay, an observed leased pending Work, and Events before restarting FINAL and checking repeated initialization and recovery.",
  oracle: "Every base-system public identity, response body, Version, explanation digest, replay, lease, Work, Event body and sequence remains exact; the current empty Comparison collections remain unchanged and drains the old frozen Work without rewriting history.",
  async run(ctx) {
    const fixture = coreFixture(ctx, { seedVersion: "rb-e01-initialRuntime-history" });
    replaceVersionRules(fixture, fixture.ids.baselineVersionId, migrationRules(ctx, fixture.ids.baselineVersionId));
    const initialRuntime = await prepare(ctx, { workspace: ctx.workspace, seed: fixture.seed, migrateTwice: true, seedTimeoutMs: 600_000 });
    const initialApi = await initialRuntime.startApi();

    const evaluationKey = ctx.key("initialRuntime-unknown-evaluation");
    const completedFacts = { risk: "high", bucket: -1, requestId: "e01-completed" };
    const completedBody = {
      tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
      ruleSetVersionId: fixture.ids.baselineVersionId, facts: completedFacts,
    };
    const shield = await ctx.responseShield(initialApi.baseUrl);
    shield.dropNextMutation();
    let evaluationDisconnected = false;
    try { await ctx.mutate(shield.baseUrl, "/api/v1/evaluations", evaluationKey, completedBody); }
    catch { evaluationDisconnected = true; }
    ctx.ok(evaluationDisconnected, "base-system Evaluation response is lost after commit");
    const evaluationCapture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "base-system captured Evaluation response" });
    const savedEvaluationBody = JSON.parse(evaluationCapture.response.body);
    exactKeys(savedEvaluationBody, EVALUATION_KEYS, "saved base-system Evaluation response");
    const evaluationRetry = await ctx.mutate(initialApi.baseUrl, "/api/v1/evaluations", evaluationKey, completedBody);
    ctx.equal(evaluationRetry.status, evaluationCapture.response.status, "base-system Evaluation retry status");
    ctx.equal(evaluationRetry.json, savedEvaluationBody, "base-system Evaluation retry body");

    const initialWorker = await initialRuntime.startWorker();
    await waitForEvaluation(ctx, initialApi.baseUrl, savedEvaluationBody.evaluationId, "COMPLETED", { timeoutMs: 180_000, processes: [initialWorker] });
    const replayKey = ctx.key("initialRuntime-replay");
    const replay = await ctx.mutate(initialApi.baseUrl, `/api/v1/evaluations/${savedEvaluationBody.evaluationId}/replay`, replayKey, {});
    ctx.equal(replay.status, 200, "base-system Replay creation");
    const savedReplayBody = clone(replay.json);
    await waitForReplay(ctx, initialApi.baseUrl, savedReplayBody.replayRunId, "MATCHED", { timeoutMs: 180_000, processes: [initialWorker] });
    await ctx.kill(initialWorker);

    const pendingFacts = { risk: "high", bucket: -1, requestId: "e01-pending" };
    const pending = await createEvaluation(ctx, initialApi.baseUrl, fixture, pendingFacts, { key: ctx.key("initialRuntime-pending") });
    const staleWorker = await initialRuntime.startWorker({ env: { WORK_LEASE_SECONDS: "3" } });
    const observed = await waitForWork(ctx, initialApi.baseUrl, ({ kind, aggregateId, state }) => (
      kind === "EVALUATION_EXECUTE" && aggregateId === pending.evaluation.evaluationId && state === "LEASED"
    ), { timeoutMs: 60_000, processes: [staleWorker], label: "base-system leased pending Evaluation" });
    await ctx.kill(staleWorker);
    const before = await ctx.snapshot(initialApi.baseUrl);
    const baseResourceKeys = ["tenants", "ruleSets", "ruleSetVersions", "rules", "evaluations", "explanationNodes", "replayRuns", "conflictReports"];
    const frozenResources = Object.fromEntries(baseResourceKeys.map((key) => [key, clone(resource(before, key))]));
    const frozenWork = clone(before.work);
    const frozenEvents = clone(before.events);
    await ctx.kill(initialApi);

    const final = await prepare(ctx, { workspace: ctx.workspace, migrateTwice: true });
    let finalApi = await final.startApi();
    const retained = await ctx.snapshot(finalApi.baseUrl);
    for (const key of baseResourceKeys) ctx.equal(resource(retained, key), frozenResources[key], `${key} survives FINAL reinitialization`);
    ctx.equal(retained.work, frozenWork, "base-system Work and lease survive FINAL reinitialization");
    ctx.equal(retained.events, frozenEvents, "base-system Event identities and bodies survive FINAL reinitialization");
    ctx.equal(resource(retained, "comparisonRuns"), [], "reinitialization invents no ComparisonRun");
    ctx.equal(resource(retained, "comparisonResults"), [], "reinitialization invents no ComparisonResult");
    const finalEvaluationRetry = await ctx.mutate(finalApi.baseUrl, "/api/v1/evaluations", evaluationKey, completedBody);
    ctx.equal(finalEvaluationRetry.status, evaluationCapture.response.status, "saved base-system Evaluation status survives reinitialization");
    ctx.equal(finalEvaluationRetry.json, savedEvaluationBody, "saved base-system Evaluation body survives reinitialization");
    const finalReplayRetry = await ctx.mutate(finalApi.baseUrl, `/api/v1/evaluations/${savedEvaluationBody.evaluationId}/replay`, replayKey, {});
    ctx.equal(finalReplayRetry.status, replay.status, "saved base-system Replay status survives reinitialization");
    ctx.equal(finalReplayRetry.json, savedReplayBody, "saved base-system Replay body survives reinitialization");

    await waitPast(ctx, observed.work.leaseExpiresAt, "retained base-system lease expiry");
    const replacement = await final.startWorker();
    await waitForEvaluation(ctx, finalApi.baseUrl, pending.evaluation.evaluationId, "COMPLETED", { timeoutMs: 180_000, processes: [replacement] });
    const recovered = await ctx.snapshot(finalApi.baseUrl);
    assertEvaluationOracle(ctx, recovered, fixture, pending.evaluation.evaluationId, pendingFacts);
    ctx.equal(resource(recovered, "evaluations").find(({ evaluationId }) => evaluationId === savedEvaluationBody.evaluationId), frozenResources.evaluations.find(({ evaluationId }) => evaluationId === savedEvaluationBody.evaluationId), "completed base-system Evaluation remains exact after recovery");
    ctx.equal(recovered.events.filter(({ eventId }) => new Set(frozenEvents.map((event) => event.eventId)).has(eventId)), frozenEvents, "all pre-reinitialization Events retain identity and order");

    await ctx.stop(replacement);
    await ctx.stop(finalApi);
    await final.migrate({ timeoutMs: 300_000 });
    finalApi = await final.startApi();
    const replayedMigration = await ctx.snapshot(finalApi.baseUrl);
    ctx.equal(stableSnapshot(replayedMigration), stableSnapshot(recovered), "repeat FINAL reinitialization is publicly idempotent");
    return finalEvidence(ctx, { preservedResources: baseResourceKeys.length, preservedEvents: frozenEvents.length, recoveredWorkId: observed.work.workId });
  },
}, ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY", "WORK_RECOVERY"]);

function evaluationPerformanceFixture(ctx, count = 200) {
  const fixture = coreFixture(ctx, { seedVersion: `rb-e02-${count}-rules` });
  const versionId = fixture.ids.baselineVersionId;
  const rules = Array.from({ length: count }, (_, index) => rule(ctx, versionId, `throughput-${index}`, {
    priority: index + 1,
    condition: { op: "eq", path: "$.bucket", value: index },
    effect: { decision: index % 2 === 0 ? "ALLOW" : "DENY", tags: [`bucket-${index}`] },
    terminal: true,
  }));
  replaceVersionRules(fixture, versionId, rules, { defaultDecision: "REVIEW" });
  return fixture;
}

function deepPerformanceFixture(ctx, count = 5_000, terminalIndex = 5) {
  const fixture = coreFixture(ctx, { seedVersion: `rb-e03-${count}-rules` });
  const versionId = fixture.ids.baselineVersionId;
  const rules = Array.from({ length: count }, (_, index) => rule(ctx, versionId, `deep-${index}`, {
    priority: index + 1,
    condition: index === terminalIndex - 1
      ? { op: "eq", path: "$.risk", value: "high" }
      : { op: "eq", path: "$.bucket", value: index + 10_000 },
    effect: index === terminalIndex - 1 ? { decision: "DENY", tags: ["early-terminal"] } : { decision: null, tags: [] },
    terminal: index === terminalIndex - 1,
  }));
  replaceVersionRules(fixture, versionId, rules, { defaultDecision: "REVIEW" });
  return fixture;
}

async function startFormalTopology(ctx, fixture) {
  await prepare(ctx, { seed: fixture.seed, seedTimeoutMs: 900_000 });
  const apis = [await ctx.startApi(), await ctx.startApi()];
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const dispatcher = await ctx.startDispatcher();
  await new Promise((resolve) => setTimeout(resolve, 100));
  ctx.equal(dispatcher.child.exitCode, null, "formal Dispatcher remains active");
  return { apis, workers, dispatcher };
}

async function waitForDrain(ctx, baseUrl, options = {}) {
  const startedAt = performance.now();
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(baseUrl, { timeoutMs: options.snapshotTimeoutMs ?? 120_000 });
    return value.work.every(({ terminal }) => terminal) ? value : false;
  }, {
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: options.intervalMs ?? 500,
    label: options.label ?? "formal Work drain",
    processes: options.processes,
  });
  return { snapshot, drainMs: performance.now() - startedAt };
}

const e02 = guardedCase({
  id: "E-02",
  fixtureFamily: "RB-F-FORMAL-EVALUATION-THROUGHPUT",
  action: "Run the published 200-rule, 200,000-Evaluation, 64-client workload through two APIs, four Workers, and one Dispatcher, then drain for at most sixty seconds and replay sampled results.",
  oracle: "All fixed requests are real 2xx acceptances at at least 600 per second with p95 at most 250ms and zero 5xx; post-load decisions, explanations, pinning, replay, Work, Events, RSS, and database metrics remain valid.",
  async run(ctx) {
    const scale = formalPerformanceScale();
    const publicCount = 200_000;
    const count = scaledCount(publicCount, scale, 1_000);
    const fixture = evaluationPerformanceFixture(ctx, 200);
    const topology = await startFormalTopology(ctx, fixture);
    const evaluationIds = new Array(count);
    const factsById = new Map();
    const metric = await fixedLoad({
      count, concurrency: 64,
      operation: async (index) => {
        const facts = { bucket: index % 200, risk: index % 3 === 0 ? "high" : "low", requestId: `perf-evaluation-${index}` };
        const response = await ctx.mutate(topology.apis[index % 2].baseUrl, "/api/v1/evaluations", ctx.key(`perf-evaluation-${index}`), {
          tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
          ruleSetVersionId: fixture.ids.baselineVersionId, facts,
        }, { timeoutMs: 30_000 });
        if (response.status === 200) {
          exactKeys(response.json, EVALUATION_KEYS, "formal Evaluation response");
          evaluationIds[index] = response.json.evaluationId;
          if (index % Math.max(1, Math.floor(count / 32)) === 0) factsById.set(response.json.evaluationId, facts);
        }
        return response;
      },
    });
    assertSuccessfulLoad(ctx, metric, { throughput: 600, p95Ms: 250 }, "evaluation-throughput");
    const drained = await waitForDrain(ctx, topology.apis[0].baseUrl, { timeoutMs: 60_000, processes: topology.workers, label: "evaluation-throughput drain" });
    ctx.ok(drained.drainMs <= 60_000, "evaluation-throughput drains within sixty seconds");
    for (const [evaluationId, facts] of [...factsById].slice(0, 32)) assertEvaluationOracle(ctx, drained.snapshot, fixture, evaluationId, facts);
    ctx.ok(evaluationIds.every((evaluationId) => byId(resource(drained.snapshot, "evaluations"), "evaluationId", evaluationId)?.state === "COMPLETED"), "every accepted Evaluation completes");
    const replay = await createReplay(ctx, topology.apis[0].baseUrl, evaluationIds[0], { key: ctx.key("perf-replay") });
    await waitForReplay(ctx, topology.apis[0].baseUrl, replay.replay.replayRunId, "MATCHED", { timeoutMs: 60_000, processes: topology.workers });
    assertEventLedger(ctx, drained.snapshot.events);
    const rssBytes = await processRss(ctx, [...topology.apis, ...topology.workers, topology.dispatcher]);
    return finalEvidence(ctx, {
      scenarioId: "evaluation-throughput", publicCount, actualCount: count, scale,
      throughput: metric.throughput, p95Ms: metric.p95Ms, drainMs: drained.drainMs,
      rssBytes, databaseBytes: drained.snapshot.metrics?.databaseBytes ?? null,
    });
  },
}, ["DURABLE_IDEMPOTENCY", "DETERMINISTIC_EVALUATION"]);

const e03 = guardedCase({
  id: "E-03",
  fixtureFamily: "RB-F-FORMAL-DEEP-SHORT-CIRCUIT",
  action: "Run the published 5,000-rule, 100,000-Evaluation, 64-client deep-short-circuit workload with its terminal Rule in the first ten while retaining every later Rule for explanation.",
  oracle: "Real acceptance reaches at least 400 per second with p95 at most 350ms and zero 5xx; sampled complete ledgers contain exactly one SKIPPED node for every later Rule and recompute the same deterministic digest.",
  async run(ctx) {
    const scale = formalPerformanceScale();
    const publicCount = 100_000;
    const count = scaledCount(publicCount, scale, 1_000);
    const fixture = deepPerformanceFixture(ctx, 5_000, 5);
    const topology = await startFormalTopology(ctx, fixture);
    const evaluationIds = new Array(count);
    const facts = { risk: "high", bucket: -1, requestId: "deep-short-circuit" };
    const metric = await fixedLoad({
      count, concurrency: 64,
      operation: async (index) => {
        const response = await ctx.mutate(topology.apis[index % 2].baseUrl, "/api/v1/evaluations", ctx.key(`perf-deep-${index}`), {
          tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
          ruleSetVersionId: fixture.ids.baselineVersionId, facts: { ...facts, requestId: `deep-${index}` },
        }, { timeoutMs: 30_000 });
        if (response.status === 200) evaluationIds[index] = response.json.evaluationId;
        return response;
      },
    });
    assertSuccessfulLoad(ctx, metric, { throughput: 400, p95Ms: 350 }, "deep-short-circuit");
    const drained = await waitForDrain(ctx, topology.apis[0].baseUrl, { timeoutMs: 60_000, snapshotTimeoutMs: 300_000, processes: topology.workers, label: "deep-short-circuit drain" });
    const sampleIndexes = Array.from({ length: Math.min(16, count) }, (_, index) => Math.floor(index * count / Math.min(16, count)));
    for (const index of sampleIndexes) {
      const evaluationId = evaluationIds[index];
      const sampleFacts = { ...facts, requestId: `deep-${index}` };
      const oracle = assertEvaluationOracle(ctx, drained.snapshot, fixture, evaluationId, sampleFacts);
      const laterRules = fixture.baselineRules.slice(5);
      const skipped = oracle.nodes.filter(({ result }) => result === "SKIPPED");
      ctx.equal(skipped.length, laterRules.length, `Evaluation ${evaluationId} retains every later SKIPPED Rule`);
      ctx.equal(skipped.map(({ ruleId }) => ruleId), laterRules.map(({ ruleId }) => ruleId), `Evaluation ${evaluationId} SKIPPED order`);
    }
    const rssBytes = await processRss(ctx, [...topology.apis, ...topology.workers, topology.dispatcher]);
    return finalEvidence(ctx, {
      scenarioId: "deep-short-circuit", publicCount, actualCount: count, scale,
      rules: 5_000, terminalPriority: 5, throughput: metric.throughput, p95Ms: metric.p95Ms,
      sampledExplanations: sampleIndexes.length, rssBytes, databaseBytes: drained.snapshot.metrics?.databaseBytes ?? null,
    });
  },
}, ["DETERMINISTIC_EVALUATION"]);

async function createFormalCorpus(ctx, topology, fixture, count) {
  const evaluationIds = new Array(count);
  const factsById = new Map();
  const metric = await fixedLoad({
    count, concurrency: 64,
    operation: async (index) => {
      const facts = { risk: index % 2 === 0 ? "high" : "low", requestId: `comparison-input-${index}` };
      const response = await ctx.mutate(topology.apis[index % 2].baseUrl, "/api/v1/evaluations", ctx.key(`comparison-input-${index}`), {
        tenantId: fixture.ids.tenantId, ruleSetId: fixture.ids.ruleSetId,
        ruleSetVersionId: fixture.ids.baselineVersionId, facts,
      }, { timeoutMs: 30_000 });
      if (response.status === 200) {
        evaluationIds[index] = response.json.evaluationId;
        factsById.set(response.json.evaluationId, facts);
      }
      return response;
    },
  });
  const failures = Object.entries(metric.statuses).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((sum, [, amount]) => sum + amount, 0);
  ctx.equal(failures, 0, "comparison input preparation has no failed acceptance");
  await waitForDrain(ctx, topology.apis[0].baseUrl, { timeoutMs: 180_000, processes: topology.workers, label: "comparison input drain" });
  return { evaluationIds, factsById };
}

const e04 = guardedCase({
  id: "E-04",
  fixtureFamily: "RB-F-FORMAL-COMPARISON-RECOVERY",
  action: "Freeze 50,000 completed inputs, start Comparison execution, publicly observe two leased Comparison Work owners, SIGKILL both Workers, then time four replacements until the Run closes.",
  oracle: "Within sixty seconds every frozen Evaluation has one immutable evaluator-recomputed Result and ordinal, counts close, all Work terminates, result and Event digests stay stable, and no completed Event duplicates.",
  async run(ctx) {
    const scale = formalPerformanceScale();
    const publicCount = 50_000;
    const count = scaledCount(publicCount, scale, 500);
    const fixture = coreFixture(ctx, { seedVersion: `rb-e04-${count}-comparison` });
    const topology = await startFormalTopology(ctx, fixture);
    const corpus = await createFormalCorpus(ctx, topology, fixture, count);
    await Promise.all(topology.workers.map((worker) => ctx.stop(worker)));
    const comparison = await createComparison(ctx, topology.apis[0].baseUrl, fixture, [...corpus.evaluationIds].reverse(), { key: ctx.key("formal-comparison") });
    ctx.equal(comparison.run.evaluationIds.length, count, "formal corpus freezes every input");
    ctx.equal(comparison.run.corpusDigest, sha256Canonical([...corpus.evaluationIds].sort()), "formal corpus digest");
    const started = await startComparison(ctx, topology.apis[0].baseUrl, comparison.run, { key: ctx.key("formal-start") });
    const victims = await Promise.all([ctx.startWorker({ env: { WORK_LEASE_SECONDS: "2" } }), ctx.startWorker({ env: { WORK_LEASE_SECONDS: "2" } })]);
    const observed = await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(topology.apis[0].baseUrl, { timeoutMs: 120_000 });
      const leased = snapshot.work.filter(({ kind, aggregateId, state, leaseExpiresAt }) => (
        kind === "COMPARISON_EXECUTE" && aggregateId === started.run.comparisonRunId && state === "LEASED" && leaseExpiresAt !== null
      ));
      return new Set(leased.map(({ leaseOwner }) => leaseOwner)).size >= 2 ? leased : false;
    }, { timeoutMs: 60_000, intervalMs: 10, label: "two publicly leased Comparison Work owners", processes: victims });
    await Promise.all(victims.map((worker) => ctx.kill(worker)));
    const reclaimAt = Math.max(...observed.map(({ leaseExpiresAt }) => Date.parse(leaseExpiresAt)));
    await waitPast(ctx, new Date(reclaimAt).toISOString(), "formal Comparison leases expiry");
    const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const recoveryStartedAt = performance.now();
    const completed = await waitForComparison(ctx, topology.apis[0].baseUrl, started.run.comparisonRunId, "COMPLETED", {
      timeoutMs: 60_000, intervalMs: 250, processes: replacements, label: "50,000-input comparison recovery",
    });
    const recoveryMs = performance.now() - recoveryStartedAt;
    ctx.ok(recoveryMs <= 60_000, `comparison recovery took ${recoveryMs.toFixed(0)}ms`);
    const results = [...completed.results].sort((left, right) => left.ordinal - right.ordinal);
    ctx.equal(results.length, count, "formal recovery closes every Result");
    ctx.equal(new Set(results.map(({ evaluationId }) => evaluationId)).size, count, "formal recovery has no duplicate Result");
    results.forEach((actual, index) => assertComparisonResult(ctx, actual, expectedComparisonResult(fixture, actual.evaluationId, index + 1, corpus.factsById.get(actual.evaluationId), {
      comparisonRunId: started.run.comparisonRunId,
    })));
    const counts = { MATCH: 0, DIFF: 0, ERROR: 0 };
    results.forEach(({ status }) => { counts[status] += 1; });
    ctx.equal(completed.run.resultCounts, counts, "formal result counts close");
    const snapshot = await ctx.snapshot(topology.apis[0].baseUrl, { timeoutMs: 180_000 });
    const runWork = snapshot.work.filter(({ kind, aggregateId }) => kind === "COMPARISON_EXECUTE" && aggregateId === started.run.comparisonRunId);
    ctx.ok(runWork.every(({ terminal }) => terminal), "all formal Comparison Work is terminal");
    ctx.equal(snapshot.events.filter(({ type, aggregateId }) => type === "comparison.completed" && aggregateId === started.run.comparisonRunId).length, 1, "formal recovery emits one completion Event");
    assertEventLedger(ctx, snapshot.events);
    return finalEvidence(ctx, {
      scenarioId: "comparison-recovery", publicCount, actualCount: count, scale,
      recoveryMs, killedWorkers: victims.length, replacementWorkers: replacements.length, resultCounts: counts,
    });
  },
}, ["WORK_RECOVERY", "COMPARISON_ATOMICITY"]);

export const E_CASES = Object.freeze([e01, e02, e03, e04]);

export default E_CASES;
