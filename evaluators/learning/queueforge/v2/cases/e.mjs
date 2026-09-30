// Policy revision: learning-final-system-2026-09-08.1. One FINAL submission; current public operations, persistence and restart recovery, not a historical binary upgrade.
import assert from "node:assert/strict";
import { CaseExcluded } from "../lib/execution.mjs";
import { attempt, createFixtureFactory, executionLease, jobDefinition, queue, run } from "../lib/fixtures.mjs";
import { operationResult, outputDigest } from "../lib/oracle.mjs";
import {
  LEASE_KEYS, assertFinalSnapshot, assertRun, assertSnapshotClosure, exactKeys,
  guarded, prepare, requireStatus, result, seedOf,
} from "./helpers.mjs";

const PERF_REFERENCE_TIME = Math.floor(Date.now() / 60_000) * 60_000;

function percentile(values, fraction) {
  if (values.length === 0) return Infinity;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function buildPerformanceSeed(fixtures) {
  const perfFixtures = createFixtureFactory({
    evaluationSeed: fixtures.evaluationSeed, caseId: "PERF-V1", baseTime: fixtures.baseTime,
  });
  const queues = Array.from({ length: 100 }, (_, index) => queue(perfFixtures, `perf-${index}`, {
    name: `perf-queue-${String(index).padStart(3, "0")}`, capacity: 100,
  })).toSorted((left, right) => Buffer.from(left.queueId).compare(Buffer.from(right.queueId)));
  const jobDefinitions = Array.from({ length: 1_000 }, (_, index) => jobDefinition(perfFixtures, `perf-${index}`, {
    operation: "ECHO", maxAttempts: 3, timeoutSeconds: 30,
    createdAt: new Date(PERF_REFERENCE_TIME - 7_200_000 - index).toISOString(),
  }));
  const runs = [];
  const attempts = [];
  const executionLeases = [];
  const now = PERF_REFERENCE_TIME;
  const queuedQueues = queues.slice(0, 50);
  const recoveryQueues = queues.slice(50);
  for (let index = 0; index < 20_000; index += 1) {
    const definition = jobDefinitions[index % jobDefinitions.length];
    const targetQueue = queues[index % queues.length];
    const input = { value: `done-${index}` };
    const targetRun = run(perfFixtures, `perf-done-${index}`, definition, targetQueue, {
      priority: 0, notBefore: new Date(now - 7_000_000).toISOString(), input, state: "SUCCEEDED",
      attemptCount: 1, output: input, errorCode: null, createdAt: new Date(now - 6_000_000 + index).toISOString(),
      startedAt: new Date(now - 5_000_000 + index).toISOString(), terminalAt: new Date(now - 4_000_000 + index).toISOString(), sequence: 3,
    });
    runs.push(targetRun);
    attempts.push(attempt(perfFixtures, `perf-done-${index}`, targetRun, {
      attempt: 1, workerId: `seed-worker-${index % 4}`, startedAt: targetRun.startedAt,
      finishedAt: targetRun.terminalAt, outcome: "SUCCEEDED", outputDigest: outputDigest(input),
    }));
  }
  for (let index = 0; index < 5_000; index += 1) {
    const definition = jobDefinitions[(20_000 + index) % jobDefinitions.length];
    const targetQueue = queuedQueues[index % queuedQueues.length];
    runs.push(run(perfFixtures, `perf-queued-${index}`, definition, targetQueue, {
      priority: -100, notBefore: new Date(now - 120_000).toISOString(), input: { value: `queued-${index}` },
      createdAt: new Date(now - 110_000 + index).toISOString(),
    }));
  }
  for (let index = 0; index < 2_000; index += 1) {
    const definition = jobDefinitions[(25_000 + index) % jobDefinitions.length];
    const targetQueue = recoveryQueues[index % recoveryQueues.length];
    const targetRun = run(perfFixtures, `perf-expired-${index}`, definition, targetQueue, {
      priority: 100, notBefore: new Date(now - 240_000).toISOString(), input: { value: `expired-${index}` },
      state: "RUNNING", attemptCount: 1, createdAt: new Date(now - 230_000 + index).toISOString(),
      startedAt: new Date(now - 220_000 + index).toISOString(), sequence: 2,
    });
    const targetAttempt = attempt(perfFixtures, `perf-expired-${index}`, targetRun, {
      attempt: 1, workerId: `dead-worker-${index % 4}`, startedAt: targetRun.startedAt,
    });
    const lease = executionLease(perfFixtures, `perf-expired-${index}`, targetRun, targetAttempt, {
      leasedAt: targetRun.startedAt, expiresAt: new Date(now - 60_000 - index).toISOString(),
    });
    runs.push(targetRun);
    attempts.push(targetAttempt);
    executionLeases.push(lease);
  }
  const seed = seedOf(perfFixtures, "perf-v1", { queues, jobDefinitions, runs, attempts, executionLeases });
  seed.seedVersion = "perf-v1";
  assert.deepEqual([queues.length, jobDefinitions.length, runs.length, attempts.length, executionLeases.length], [100, 1_000, 27_000, 22_000, 2_000]);
  return seed;
}

const E01 = {
  id: "E-01",
  async run(ctx) {
return guarded(["MIGRATION_COMPATIBILITY", "BUILD_MIGRATION_OR_BOOT", "DURABLE_IDEMPOTENCY"], async () => {
      const initialRuntime = ctx;
      const final = ctx.forWorkspace(ctx.workspace);
      await initialRuntime.command("npm", ["ci"], { timeoutMs: 600_000 });
      await initialRuntime.npm("build", [], { timeoutMs: 600_000 });
      await final.command("npm", ["ci"], { timeoutMs: 600_000 });
      await final.npm("build", [], { timeoutMs: 600_000 });
      await initialRuntime.migrate();
      const targetQueue = queue(ctx.fixtures, "reinitialization", { capacity: 5 });
      const definition = jobDefinition(ctx.fixtures, "reinitialization", { maxAttempts: 3 });
      await initialRuntime.seed(seedOf(ctx.fixtures, "reinitialization-initialRuntime", { queues: [targetQueue], jobDefinitions: [definition] }));
      const initialApi = await initialRuntime.startApi();
      const request = {
        jobDefinitionId: definition.jobDefinitionId, jobVersion: 1, queueId: targetQueue.queueId,
        priority: 11, notBefore: new Date(Date.now() - 1_000).toISOString(), input: { value: "saved-replay" },
      };
      const replayKey = ctx.key("reinitialization-saved-replay");
      const saved = await ctx.mutate(initialApi.baseUrl, "/api/v1/runs", replayKey, request);
      assert.equal(saved.status, 202);
      assertRun(saved.json, { final: false });
      const leasedRequest = { ...request, priority: 12, input: { value: "leased-across-reinitialization" } };
      const leasedResponse = await ctx.mutate(initialApi.baseUrl, "/api/v1/runs", ctx.key("reinitialization-leased"), leasedRequest);
      assert.equal(leasedResponse.status, 202);
      assertRun(leasedResponse.json, { final: false });
      const claimResponse = await ctx.mutate(initialApi.baseUrl, "/api/v1/workers/initialRuntime-owner/claim", ctx.key("reinitialization-claim"), { queueIds: [targetQueue.queueId], maxRuns: 1 });
      const claimBody = requireStatus(claimResponse, 200, "base-system claim");
      assert.equal(claimBody.items.length, 1);
      assert.equal(claimBody.items[0].run.runId, leasedResponse.json.runId);
      assertRun(claimBody.items[0].run, { final: false });
      exactKeys(claimBody.items[0].executionLease, LEASE_KEYS, "base-system ExecutionLease");
      const before = await ctx.snapshot(initialApi.baseUrl);
      const oldEventBytes = new Map(before.events.map((event) => [event.eventId, JSON.stringify(event)]));
      const oldAttemptKeys = before.resources.attempts.map(({ runId, attempt }) => `${runId}:${attempt}`);
      const oldLeaseKeys = before.resources.executionLeases.map(({ runId, attempt }) => `${runId}:${attempt}`);
      await ctx.kill(initialApi);

      await final.migrate();
      await final.migrate();
      const api = await final.startApi();
      const replay = await ctx.mutate(api.baseUrl, "/api/v1/runs", replayKey, request);
      assert.equal(replay.status, saved.status);
      assert.deepEqual(replay.json, saved.json);
      assert.equal(Object.hasOwn(replay.json, "workflowRunId"), false, "saved base-system replay body was rewritten");
      const afterMigration = await ctx.snapshot(api.baseUrl);
      assertFinalSnapshot(afterMigration);
      for (const legacy of afterMigration.resources.runs.filter(({ runId }) => [saved.json.runId, leasedResponse.json.runId].includes(runId))) {
        assert.equal(legacy.workflowRunId, null);
        assert.equal(legacy.nodeKey, null);
      }
      for (const [eventId, bytes] of oldEventBytes) assert.equal(JSON.stringify(afterMigration.events.find((event) => event.eventId === eventId)), bytes);
      assert.ok(oldAttemptKeys.every((key) => afterMigration.resources.attempts.some(({ runId, attempt }) => `${runId}:${attempt}` === key)));
      assert.ok(oldLeaseKeys.every((key) => afterMigration.resources.executionLeases.some(({ runId, attempt }) => `${runId}:${attempt}` === key)));

      const workflowResponse = await ctx.mutate(api.baseUrl, "/api/v1/workflow-runs", ctx.key("post-reinitialization-workflow"), { nodes: [{
        nodeKey: "new-node", jobDefinitionId: definition.jobDefinitionId, jobVersion: 1, queueId: targetQueue.queueId,
        priority: 0, input: { value: "new-manager-state" }, dependsOn: [],
      }] });
      assert.equal(workflowResponse.status, 200);
      const worker = await final.startWorker();
      const terminalIds = [saved.json.runId, leasedResponse.json.runId, workflowResponse.json.nodes[0].runId];
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(api.baseUrl);
        return terminalIds.every((id) => snapshot.resources.runs.some(({ runId, state }) => runId === id && state === "SUCCEEDED")) ? snapshot : undefined;
      }, { timeoutMs: 20_000, label: "retained Work drain", processes: [worker] });
      const finalSnapshot = await ctx.snapshot(api.baseUrl);
      assertSnapshotClosure(finalSnapshot);
      return result({ replayRunId: saved.json.runId, leasedRunId: leasedResponse.json.runId, preservedEventIds: [...oldEventBytes.keys()], workflowRunId: workflowResponse.json.workflowRunId });
    });
  },
};

const E02 = {
  id: "E-02",
  async run(ctx) {
    return guarded(["DURABLE_IDEMPOTENCY", "QUEUE_DAG_OR_ATOMICITY"], async () => {
      const seed = buildPerformanceSeed(ctx.fixtures);
      const { apis } = await prepare(ctx, seed, { apis: 2 });
      const queues = seed.queues.map(({ queueId }) => queueId).toSorted((a, b) => Buffer.from(a).compare(Buffer.from(b)));
      const definition = seed.jobDefinitions.toSorted((a, b) => Buffer.from(a.jobDefinitionId).compare(Buffer.from(b.jobDefinitionId)))[0];
      const setupTimestamp = new Date().toISOString();
      let ordinal = 0;
      async function window(durationMs, phase) {
        const started = performance.now();
        const deadline = started + durationMs;
        const latencies = [];
        const ids = [];
        let success = 0;
        let unexpected5xx = 0;
        await Promise.all(Array.from({ length: 64 }, async (_, client) => {
          while (performance.now() < deadline) {
            const current = ordinal;
            ordinal += 1;
            const response = await ctx.mutate(apis[client % apis.length].baseUrl, "/api/v1/runs", ctx.key(`${phase}-${current}`), {
              jobDefinitionId: definition.jobDefinitionId, jobVersion: definition.version,
              queueId: queues[current % queues.length], priority: 50, notBefore: setupTimestamp,
              input: { value: String(current).padStart(64, "0").slice(-64) },
            }, { timeoutMs: 10_000 });
            if (response.status >= 500) unexpected5xx += 1;
            if (response.status === 202 && performance.now() <= deadline) {
              success += 1;
              ids.push(response.json.runId);
              if (phase === "measure") latencies.push(response.durationMs);
              assert.equal(response.json.jobDefinitionId, definition.jobDefinitionId);
              assert.equal(response.json.jobVersion, definition.version);
              assert.equal(response.json.state, "QUEUED");
            }
          }
        }));
        return { success, unexpected5xx, latencies, ids, elapsedMs: performance.now() - started };
      }
      const warmup = await window(10_000, "warmup");
      const measured = await window(60_000, "measure");
      const throughput = measured.success / 60;
      const p95 = percentile(measured.latencies, 0.95);
      assert.equal(warmup.unexpected5xx + measured.unexpected5xx, 0);
      assert.ok(throughput >= 300, `run-enqueue throughput ${throughput.toFixed(2)}/s is below 300/s`);
      assert.ok(p95 <= 250, `run-enqueue p95 ${p95.toFixed(2)}ms exceeds 250ms`);
      assert.equal(new Set(warmup.ids).intersection(new Set(measured.ids)).size, 0);
      assert.equal(new Set(measured.ids).size, measured.success);
      const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 60_000 });
      const byId = new Map(snapshot.resources.runs.map((item) => [item.runId, item]));
      assert.ok(measured.ids.every((id) => byId.get(id)?.jobDefinitionId === definition.jobDefinitionId && byId.get(id)?.jobVersion === definition.version));
      assertSnapshotClosure(snapshot);
      return result({ throughput, p50: percentile(measured.latencies, 0.5), p95, p99: percentile(measured.latencies, 0.99), successes: measured.success, unexpected5xx: 0 });
    });
  },
};

const E03 = {
  id: "E-03",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY", "RECOVERY_OR_FENCING"], async () => {
      const seed = buildPerformanceSeed(ctx.fixtures);
      const selected = seed.runs.filter(({ state }) => state === "QUEUED");
      assert.equal(selected.length, 5_000);
      const queueIds = [...new Set(selected.map(({ queueId }) => queueId))].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
      const { apis } = await prepare(ctx, seed, { apis: 2 });
      let completed = 0;
      let stale = 0;
      let unexpected5xx = 0;
      const started = performance.now();
      await Promise.all(Array.from({ length: 4 }, async (_, workerIndex) => {
        let claimOrdinal = 0;
        while (true) {
          const api = apis[workerIndex % apis.length];
          const response = await ctx.mutate(api.baseUrl, `/api/v1/workers/perf-client-${workerIndex}/claim`, ctx.key(`perf-claim-${workerIndex}-${claimOrdinal += 1}`), { queueIds, maxRuns: 20 }, { timeoutMs: 10_000 });
          if (response.status >= 500) unexpected5xx += 1;
          assert.equal(response.status, 200, response.text);
          if (response.json.items.length === 0) break;
          for (const item of response.json.items) {
            const expected = operationResult("ECHO", item.run.input);
            const finished = await ctx.mutate(api.baseUrl, `/api/v1/runs/${item.run.runId}/attempt-result`, ctx.key(`perf-result-${item.run.runId}`), {
              attempt: item.executionLease.attempt, leaseToken: item.executionLease.leaseToken,
              outcome: "SUCCEEDED", output: expected, errorCode: null,
            }, { timeoutMs: 10_000 });
            if (finished.status === 409 && finished.json?.error?.code === "STALE_EXECUTION_LEASE") stale += 1;
            if (finished.status >= 500) unexpected5xx += 1;
            assert.equal(finished.status, 200, finished.text);
            completed += 1;
          }
        }
      }));
      const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 60_000 });
      const elapsedMs = performance.now() - started;
      const selectedIds = new Set(selected.map(({ runId }) => runId));
      const finished = snapshot.resources.runs.filter(({ runId }) => selectedIds.has(runId));
      assert.ok(elapsedMs <= 60_000, `short-run-execution took ${elapsedMs.toFixed(0)}ms`);
      assert.equal(completed, 5_000);
      assert.equal(stale, 0);
      assert.equal(unexpected5xx, 0);
      assert.ok(finished.every(({ state, attemptCount, output, input }) => state === "SUCCEEDED" && attemptCount === 1 && JSON.stringify(output) === JSON.stringify(input)));
      assert.equal(snapshot.resources.executionLeases.some(({ runId }) => selectedIds.has(runId)), false);
      assertSnapshotClosure(snapshot);
      return result({ elapsedMs, completed, staleLeaseResponses: stale, unexpected5xx });
    });
  },
};

const E04 = {
  id: "E-04",
  async run(ctx) {
    return guarded(["RECOVERY_OR_FENCING", "QUEUE_DAG_OR_ATOMICITY"], async () => {
      const seed = buildPerformanceSeed(ctx.fixtures);
      const selected = seed.runs.filter(({ state }) => state === "RUNNING");
      assert.equal(selected.length, 2_000);
      const staleTokens = new Set(seed.executionLeases.map(({ leaseToken }) => leaseToken));
      const { api } = await prepare(ctx, seed);
      const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
      const started = performance.now();
      const selectedIds = new Set(selected.map(({ runId }) => runId));
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(api.baseUrl, { timeoutMs: 60_000 });
        return value.resources.runs.filter(({ runId }) => selectedIds.has(runId)).every(({ state }) => state === "SUCCEEDED") ? value : undefined;
      }, { timeoutMs: 45_000, intervalMs: 200, label: "2,000 expired leases recovered", processes: workers });
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs <= 45_000, `expired-lease-recovery took ${elapsedMs.toFixed(0)}ms`);
      const recovered = snapshot.resources.runs.filter(({ runId }) => selectedIds.has(runId));
      assert.equal(recovered.length, 2_000);
      assert.ok(recovered.every(({ attemptCount, state, output, input }) => attemptCount === 2 && state === "SUCCEEDED" && JSON.stringify(output) === JSON.stringify(input)));
      const recoveredAttempts = snapshot.resources.attempts.filter(({ runId }) => selectedIds.has(runId));
      assert.equal(recoveredAttempts.length, 4_000);
      assert.equal(recoveredAttempts.filter(({ attempt: number, outcome }) => number === 1 && outcome === "TIMED_OUT").length, 2_000);
      assert.equal(recoveredAttempts.filter(({ attempt: number, outcome }) => number === 2 && outcome === "SUCCEEDED").length, 2_000);
      assert.equal(snapshot.resources.executionLeases.some(({ runId }) => selectedIds.has(runId)), false);
      assert.ok([...staleTokens].every((token) => !JSON.stringify(snapshot).includes(token)));
      assert.ok(workers.every(({ child }) => child.exitCode === null));
      const originalLeaseByRun = new Map(seed.executionLeases.map((lease) => [lease.runId, lease]));
      const staleResponses = await ctx.concurrent(selected, 64, async (targetRun) => ctx.mutate(
        api.baseUrl, `/api/v1/runs/${targetRun.runId}/attempt-result`, ctx.key(`expired-token-${targetRun.runId}`), {
          attempt: 1, leaseToken: originalLeaseByRun.get(targetRun.runId).leaseToken,
          outcome: "SUCCEEDED", output: targetRun.input, errorCode: null,
        }, { timeoutMs: 10_000 },
      ));
      assert.ok(staleResponses.every(({ status, json }) => status === 409 && json?.error?.code === "STALE_EXECUTION_LEASE"));
      const afterFenceChecks = await ctx.snapshot(api.baseUrl, { timeoutMs: 60_000 });
      assert.equal(afterFenceChecks.resources.attempts.filter(({ runId }) => selectedIds.has(runId)).length, 4_000);
      assertSnapshotClosure(afterFenceChecks);
      return result({ elapsedMs, recovered: recovered.length, attempts: recoveredAttempts.length, workerCount: workers.length, staleTokensRejected: staleResponses.length });
    });
  },
};

export const E_CASES = Object.freeze([E01, E02, E03, E04]);
