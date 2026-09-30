import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { measuredLoad, percentile, performanceScale } from "../performance-runtime.mjs";
import { standardAdapter } from "../standard-adapter.mjs";

const timestamp = "2026-08-01T00:00:00.000Z";
const ids = {
  queue: uuid("a1000000", 0),
  definition: uuid("a2000000", 0),
  sumDefinition: uuid("a2000000", 1),
};

const spec = {
  label: "QueueForge run execution",
  performanceScenarioIds: ["run-enqueue", "short-run-execution", "expired-lease-recovery"],
  seed: async () => seed(),
  path: "/api/v1/runs",
  payload: (index) => runPayload(index),
  conflictPayload: (index) => ({ ...runPayload(index), priority: 99 }),
  resource: "runs",
  identity: (value) => runOf(value)?.runId,
  workIdentity: (value) => runOf(value)?.runId,
  resourceIdentity: ({ runId }) => runId,
  cases: {
    "H-03": mainFlow,
    "H-04": atomicRejection,
    "H-06": queueCapacityContention,
    "H-09": v1Migration,
    "H-10": workflowDagBehavior,
    "H-11": workflowFailureAndRetry,
  },
  performance: runPerformance,
};

export default standardAdapter(spec);

function uuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function seed() {
  return {
    schemaVersion: 1,
    seedVersion: "hidden-queueforge-v1",
    queues: [{ queueId: ids.queue, name: "Hidden queue", capacity: 2 }],
    jobDefinitions: [
      definition(ids.definition, 1, 2),
      { ...definition(ids.sumDefinition, 1, 2), operation: "SUM_INTEGERS" },
    ],
    runs: [],
    attempts: [],
    executionLeases: [],
  };
}

function definition(jobDefinitionId, version, maxAttempts = 2) {
  return {
    jobDefinitionId,
    version,
    operation: "ECHO",
    maxAttempts,
    timeoutSeconds: 30,
    createdAt: timestamp,
  };
}

function runPayload(index = 0, queueId = ids.queue, jobDefinitionId = ids.definition) {
  return {
    jobDefinitionId,
    jobVersion: 1,
    queueId,
    priority: index % 101,
    notBefore: timestamp,
    input: { value: `hidden-${index}` },
  };
}

function runOf(value) {
  return value?.run ?? value;
}

function workflowOf(value) {
  return value?.workflowRun ?? value;
}

function stable(snapshot) {
  const { asOf: _asOf, ...value } = snapshot;
  return value;
}

async function setup(ctx, workspace = ctx.workspace) {
  await ctx.prepare(workspace);
  const imported = await ctx.seed(seed(), workspace);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return ctx.startApi(workspace);
}

async function enqueue(ctx, baseUrl, key, payload = runPayload()) {
  const response = await ctx.mutate(baseUrl, "/api/v1/runs", key, payload);
  assert.equal(response.status, 202, response.text);
  const run = runOf(response.json);
  assert.equal(run.state, "QUEUED");
  return { response, run, payload };
}

async function claim(ctx, baseUrl, key, workerId, queueIds = [ids.queue], maxRuns = 20) {
  const response = await ctx.mutate(baseUrl, `/api/v1/workers/${workerId}/claim`, key, { queueIds, maxRuns });
  assert.equal(response.status, 200, response.text);
  assert.ok(Array.isArray(response.json?.items), "claim response is missing items");
  return response.json.items;
}

async function finish(ctx, baseUrl, key, item, outcome = "SUCCEEDED") {
  const success = outcome === "SUCCEEDED";
  const response = await ctx.mutate(baseUrl, `/api/v1/runs/${item.run.runId}/attempt-result`, key, {
    attempt: item.executionLease.attempt,
    leaseToken: item.executionLease.leaseToken,
    outcome,
    output: success ? item.run.input : null,
    errorCode: success ? null : "HIDDEN_FAILURE",
  });
  assert.equal(response.status, 200, response.text);
  return response;
}

async function mainFlow(ctx, assertions) {
  const api = await setup(ctx);
  const { run } = await enqueue(ctx, api.baseUrl, "h03-enqueue", runPayload(1));
  const items = await claim(ctx, api.baseUrl, "h03-claim", "h03-worker", [ids.queue], 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].run.runId, run.runId);
  assert.equal(items[0].run.state, "RUNNING");
  assert.equal(items[0].executionLease.attempt, 1);

  const completed = await finish(ctx, api.baseUrl, "h03-result", items[0]);
  assert.equal(runOf(completed.json).state, "SUCCEEDED");
  assert.deepEqual(runOf(completed.json).output, runPayload(1).input);
  assert.match(completed.json.attempt.outputDigest, /^[a-f0-9]{64}$/u);

  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.resources.executionLeases.some(({ runId }) => runId === run.runId), false);
  assert.deepEqual(
    snapshot.events.filter(({ aggregateId }) => aggregateId === run.runId).map(({ type }) => type),
    ["run.queued", "run.started", "run.succeeded"],
  );
  assert.deepEqual(
    snapshot.resources.attempts.filter(({ runId }) => runId === run.runId).map(({ outcome }) => outcome),
    ["SUCCEEDED"],
  );
  assertions.push("enqueue, lease, ECHO result, output digest, Attempt, and Run Events agree through public APIs");
}

async function atomicRejection(ctx, assertions) {
  const api = await setup(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const invalid = await ctx.mutate(api.baseUrl, "/api/v1/runs", "h04-invalid-input", {
    ...runPayload(2, ids.queue, ids.sumDefinition),
    input: { values: [] },
  });
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(invalid.json?.error?.code, "INVALID_JOB_INPUT");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(before));

  const version = await ctx.mutate(api.baseUrl, `/api/v1/job-definitions/${ids.definition}/versions`, "h04-version", {
    expectedLatestVersion: 0,
    operation: "ECHO",
    maxAttempts: 2,
    timeoutSeconds: 30,
  });
  assert.equal(version.status, 409, version.text);
  assert.equal(version.json?.error?.code, "JOB_DEFINITION_VERSION_CHANGED");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(before));
  assertions.push("invalid operation input and stale Job Definition revision reject atomically without Runs, Attempts, Work, or Events");
}

async function queueCapacityContention(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  await ctx.concurrent(Array.from({ length: 8 }), 8, (_, index) => enqueue(ctx, apiA.baseUrl, `h06-enqueue-${index}`, runPayload(index + 10)));

  const claims = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => claim(
    ctx,
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `h06-claim-${index}`,
    `h06-worker-${index}`,
  ));
  const leased = claims.flat();
  assert.equal(leased.length, 2, "Queue capacity two admitted a different number of live leases");
  assert.equal(new Set(leased.map(({ run }) => run.runId)).size, 2);
  const snapshot = await ctx.snapshot(apiB.baseUrl);
  assert.equal(snapshot.resources.executionLeases.length, 2);
  assert.equal(snapshot.resources.runs.filter(({ state }) => state === "RUNNING").length, 2);
  assert.equal(snapshot.resources.attempts.length, 2);

  await Promise.all(leased.map((item, index) => finish(ctx, index % 2 ? apiA.baseUrl : apiB.baseUrl, `h06-result-${index}`, item)));
  const next = await claim(ctx, apiA.baseUrl, "h06-next-claim", "h06-next-worker");
  assert.equal(next.length, 2);
  assertions.push("32 claims across two API processes never exceed Queue capacity and release capacity only after terminal results");
}

async function v1Migration(ctx, assertions) {
  const v1Workspace = await ctx.copyV1Workspace();
  const v1Api = await setup(ctx, v1Workspace);
  const created = await enqueue(ctx, v1Api.baseUrl, "h09-saved", runPayload(21));
  const [leased] = await claim(ctx, v1Api.baseUrl, "h09-claim", "h09-worker", [ids.queue], 1);
  const before = await ctx.snapshot(v1Api.baseUrl);
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/runs", "h09-saved", created.payload);
  assert.equal(replay.status, created.response.status);
  assert.equal(replay.text, created.response.text);
  const migrated = await ctx.snapshot(finalApi.baseUrl);
  const run = migrated.resources.runs.find(({ runId }) => runId === created.run.runId);
  assert.equal(run.workflowRunId, null);
  assert.equal(run.nodeKey, null);
  assert.deepEqual(
    migrated.resources.executionLeases.find(({ runId }) => runId === created.run.runId),
    before.resources.executionLeases.find(({ runId }) => runId === created.run.runId),
  );
  assert.deepEqual(
    migrated.resources.attempts.filter(({ runId }) => runId === created.run.runId),
    before.resources.attempts.filter(({ runId }) => runId === created.run.runId),
  );
  assert.equal(leased.executionLease.attempt, 1);
  assertions.push("saved V1 replay, pending Run, live lease, Attempt history, and standalone compatibility fields survive FINAL migration");
}

function workflowPayload(nodes) {
  return {
    nodes: nodes.map(({ nodeKey, dependsOn = [] }, index) => ({
      nodeKey,
      jobDefinitionId: ids.definition,
      jobVersion: 1,
      queueId: ids.queue,
      priority: 50 - index,
      input: { value: nodeKey },
      dependsOn,
    })),
  };
}

async function createWorkflow(ctx, baseUrl, key, nodes) {
  const response = await ctx.mutate(baseUrl, "/api/v1/workflow-runs", key, workflowPayload(nodes));
  assert.equal(response.status, 201, response.text);
  return workflowOf(response.json);
}

async function workflowDagBehavior(ctx, assertions) {
  const api = await setup(ctx);
  const workflow = await createWorkflow(ctx, api.baseUrl, "h10-workflow", [
    { nodeKey: "root" },
    { nodeKey: "left", dependsOn: ["root"] },
    { nodeKey: "right", dependsOn: ["root"] },
    { nodeKey: "join", dependsOn: ["left", "right"] },
  ]);

  const roots = await claim(ctx, api.baseUrl, "h10-root-claim", "h10-root");
  assert.deepEqual(roots.map(({ run }) => run.nodeKey), ["root"]);
  await finish(ctx, api.baseUrl, "h10-root-result", roots[0]);
  const branches = await claim(ctx, api.baseUrl, "h10-branch-claim", "h10-branches");
  assert.deepEqual(branches.map(({ run }) => run.nodeKey).sort(), ["left", "right"]);
  await Promise.all(branches.map((item, index) => finish(ctx, api.baseUrl, `h10-branch-result-${index}`, item)));
  const join = await claim(ctx, api.baseUrl, "h10-join-claim", "h10-join");
  assert.deepEqual(join.map(({ run }) => run.nodeKey), ["join"]);
  await finish(ctx, api.baseUrl, "h10-join-result", join[0]);

  const read = await ctx.request(api.baseUrl, `/api/v1/workflow-runs/${workflow.workflowRunId}`);
  assert.equal(read.status, 200, read.text);
  assert.equal(workflowOf(read.json).state, "SUCCEEDED");
  assert.deepEqual(workflowOf(read.json).nodes.map(({ nodeKey }) => nodeKey), ["join", "left", "right", "root"]);
  assert.equal(workflowOf(read.json).nodes.every(({ state }) => state === "SUCCEEDED"), true);
  assertions.push("diamond DAG exposes only eligible roots, unlocks fan-out concurrently, gates fan-in, and reaches one SUCCEEDED Workflow Run");
}

async function workflowFailureAndRetry(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const invalidGraphs = [
    [{ nodeKey: "a", dependsOn: ["b"] }, { nodeKey: "b", dependsOn: ["a"] }],
    [{ nodeKey: "a", dependsOn: ["missing"] }],
    [{ nodeKey: "a" }, { nodeKey: "a" }],
    [{ nodeKey: "a", dependsOn: ["a"] }],
  ];
  const before = await ctx.snapshot(apiA.baseUrl);
  for (const [index, nodes] of invalidGraphs.entries()) {
    const rejected = await ctx.mutate(apiA.baseUrl, "/api/v1/workflow-runs", `h11-invalid-${index}`, workflowPayload(nodes));
    assert.equal(rejected.status, 400, rejected.text);
    assert.equal(rejected.json?.error?.code, "WORKFLOW_GRAPH_CYCLE");
  }
  assert.deepEqual(stable(await ctx.snapshot(apiA.baseUrl)), stable(before));

  const workflow = await createWorkflow(ctx, apiA.baseUrl, "h11-workflow", [
    { nodeKey: "root" },
    { nodeKey: "left", dependsOn: ["root"] },
    { nodeKey: "right", dependsOn: ["root"] },
    { nodeKey: "join", dependsOn: ["left", "right"] },
  ]);
  const [root] = await claim(ctx, apiA.baseUrl, "h11-root-claim", "h11-root");
  await finish(ctx, apiA.baseUrl, "h11-root-result", root);
  const branches = await claim(ctx, apiB.baseUrl, "h11-branch-claim", "h11-branches");
  const left = branches.find(({ run }) => run.nodeKey === "left");
  const right = branches.find(({ run }) => run.nodeKey === "right");
  assert.ok(left && right);
  await Promise.all([
    finish(ctx, apiA.baseUrl, "h11-left-fail", left, "PERMANENT_FAILURE"),
    finish(ctx, apiB.baseUrl, "h11-right-success", right),
  ]);

  let snapshot = await ctx.snapshot(apiA.baseUrl);
  assert.equal(snapshot.resources.runs.find(({ runId }) => runId === left.run.runId).state, "FAILED");
  const joinRun = snapshot.resources.runs.find(({ workflowRunId, nodeKey }) => workflowRunId === workflow.workflowRunId && nodeKey === "join");
  assert.equal(joinRun.state, "BLOCKED");
  assert.equal(joinRun.attemptCount, 0);
  assert.equal(snapshot.resources.executionLeases.some(({ runId }) => runId === joinRun.runId), false);

  const retries = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/workflow-runs/${workflow.workflowRunId}/nodes/left/retry`,
    "h11-shared-retry",
    {},
  ));
  assert.equal(new Set(retries.map(({ status, text }) => `${status}:${text}`)).size, 1);
  assert.equal(retries[0].status, 200, retries[0].text);
  snapshot = await ctx.snapshot(apiB.baseUrl);
  assert.equal(snapshot.resources.runs.find(({ runId }) => runId === left.run.runId).state, "QUEUED");
  assert.equal(snapshot.resources.runs.find(({ runId }) => runId === joinRun.runId).state, "QUEUED");
  assert.equal(snapshot.resources.runs.find(({ runId }) => runId === joinRun.runId).attemptCount, 0);

  const [retriedLeft] = await claim(ctx, apiA.baseUrl, "h11-retry-claim", "h11-retry");
  assert.equal(retriedLeft.run.nodeKey, "left");
  await finish(ctx, apiA.baseUrl, "h11-retry-result", retriedLeft);
  const [unblockedJoin] = await claim(ctx, apiB.baseUrl, "h11-unblocked-claim", "h11-unblocked");
  assert.equal(unblockedJoin.run.nodeKey, "join");
  await finish(ctx, apiB.baseUrl, "h11-unblocked-result", unblockedJoin);
  const final = await ctx.request(apiA.baseUrl, `/api/v1/workflow-runs/${workflow.workflowRunId}`);
  assert.equal(workflowOf(final.json).state, "SUCCEEDED");
  assertions.push("invalid graphs roll back atomically; failure blocks transitive descendants without Attempts, and one replay-safe retry selectively unlocks the DAG");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function perfSeed() {
  const queues = Array.from({ length: 100 }, (_, index) => ({
    queueId: uuid("b1000000", index),
    name: `Queue ${index}`,
    capacity: 100,
  }));
  const jobDefinitions = Array.from({ length: 1_000 }, (_, index) => definition(uuid("b2000000", index), 1, 2));
  const runs = [];
  const attempts = [];
  const executionLeases = [];
  for (let index = 0; index < 27_000; index += 1) {
    const succeeded = index < 20_000;
    const queued = index >= 20_000 && index < 25_000;
    const runId = uuid("b3000000", index);
    const jobDefinitionId = jobDefinitions[index % jobDefinitions.length].jobDefinitionId;
    const queueIndex = queued ? 20 + (index % 80) : index % 20;
    const input = { value: `value-${String(index).padStart(5, "0")}` };
    runs.push({
      runId,
      jobDefinitionId,
      jobVersion: 1,
      queueId: queues[queueIndex].queueId,
      priority: 50,
      notBefore: timestamp,
      input,
      state: succeeded ? "SUCCEEDED" : queued ? "QUEUED" : "RUNNING",
      attemptCount: queued ? 0 : 1,
      output: succeeded ? input : null,
      errorCode: null,
      createdAt: timestamp,
      startedAt: queued ? null : timestamp,
      terminalAt: succeeded ? timestamp : null,
      sequence: succeeded ? 3 : queued ? 1 : 2,
    });
    if (!queued) {
      attempts.push({
        runId,
        attempt: 1,
        workerId: `seed-worker-${index % 20}`,
        startedAt: timestamp,
        finishedAt: succeeded ? timestamp : null,
        outcome: succeeded ? "SUCCEEDED" : null,
        outputDigest: succeeded ? sha256(input) : null,
      });
    }
    if (!succeeded && !queued) {
      executionLeases.push({
        runId,
        attempt: 1,
        workerId: `expired-worker-${index % 20}`,
        leaseToken: `expired-token-${index}`,
        leasedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:03.000Z",
      });
    }
  }
  return { schemaVersion: 1, seedVersion: "perf-v1", queues, jobDefinitions, runs, attempts, executionLeases };
}

async function preparePerformance(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(perfSeed());
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

async function runPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  let { apiA, apiB } = await preparePerformance(ctx);
  const perfQueues = Array.from({ length: 100 }, (_, index) => uuid("b1000000", index));
  const perfDefinitions = Array.from({ length: 1_000 }, (_, index) => uuid("b2000000", index));
  let ordinal = 0;
  const enqueues = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async ({ measured }) => {
      const index = ordinal++;
      const response = await ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/runs", `perf-enqueue-${measured ? "measure" : "warmup"}-${index}`, {
        jobDefinitionId: perfDefinitions[index % perfDefinitions.length],
        jobVersion: 1,
        queueId: perfQueues[20 + (index % 80)],
        priority: 50,
        notBefore: timestamp,
        input: { value: String(index).padStart(64, "0").slice(-64) },
      });
      assert.equal(response.status, 202, response.text);
      assert.equal(runOf(response.json).jobVersion, 1);
      return response;
    },
  });
  assert.ok(enqueues.throughput >= 300, `run-enqueue throughput ${enqueues.throughput}/s`);
  assert.ok(enqueues.p95 <= 250, `run-enqueue p95 ${enqueues.p95}ms`);
  assert.equal(Object.keys(enqueues.statuses).some((status) => Number(status) >= 500), false);
  const enqueueSnapshot = await ctx.snapshot(apiA.baseUrl);
  assert.equal(new Set(enqueueSnapshot.resources.runs.map(({ runId }) => runId)).size, enqueueSnapshot.resources.runs.length);
  metrics.push({ scenarioId: "run-enqueue", ...enqueues });
  assertions.push(`run-enqueue: ${enqueues.throughput.toFixed(1)}/s at p95 ${enqueues.p95.toFixed(1)}ms with unique Runs`);

  await ctx.resetDatabase();
  ({ apiA, apiB } = await preparePerformance(ctx));
  const eligibleQueues = perfQueues.slice(20);
  const activeByQueue = new Map();
  const latencies = [];
  let completed = 0;
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: 4 }, async (_, workerIndex) => {
    let claimBatch = 0;
    while (completed < 5_000 && Date.now() - startedAt < 60_000) {
      const claimStarted = globalThis.performance.now();
      const items = await claim(ctx, workerIndex % 2 ? apiA.baseUrl : apiB.baseUrl, `perf-short-claim-${workerIndex}-${claimBatch++}`, `perf-worker-${workerIndex}`, eligibleQueues, 25);
      if (items.length === 0) continue;
      for (const item of items) {
        const queueId = item.run.queueId;
        activeByQueue.set(queueId, (activeByQueue.get(queueId) ?? 0) + 1);
        assert.ok(activeByQueue.get(queueId) <= 100, `Queue ${queueId} exceeded capacity`);
      }
      await Promise.all(items.map(async (item, itemIndex) => {
        await finish(ctx, workerIndex % 2 ? apiA.baseUrl : apiB.baseUrl, `perf-short-result-${item.run.runId}-${itemIndex}`, item);
        activeByQueue.set(item.run.queueId, activeByQueue.get(item.run.queueId) - 1);
      }));
      completed += items.length;
      latencies.push(globalThis.performance.now() - claimStarted);
    }
  }));
  const executionMs = Date.now() - startedAt;
  assert.equal(completed, 5_000);
  assert.ok(executionMs <= 60_000, `short-run-execution took ${executionMs}ms`);
  const executionSnapshot = await ctx.snapshot(apiA.baseUrl);
  const selectedRuns = executionSnapshot.resources.runs.filter(({ queueId }) => eligibleQueues.includes(queueId));
  assert.equal(selectedRuns.filter(({ state }) => state === "SUCCEEDED").length, 5_000);
  assert.equal(selectedRuns.some(({ state }) => state === "QUEUED" || state === "RUNNING"), false);
  const orderedLatencies = latencies.sort((left, right) => left - right);
  metrics.push({
    scenarioId: "short-run-execution",
    completed,
    durationMs: executionMs,
    p50: percentile(orderedLatencies, 0.5),
    p95: percentile(orderedLatencies, 0.95),
    p99: percentile(orderedLatencies, 0.99),
    workers: 4,
  });
  assertions.push(`short-run-execution: 5,000 Runs completed in ${executionMs}ms with Queue capacity preserved`);

  await ctx.resetDatabase();
  ({ apiA } = await preparePerformance(ctx));
  const recoveryStartedAt = Date.now();
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const targetIds = new Set(Array.from({ length: 2_000 }, (_, index) => uuid("b3000000", 25_000 + index)));
  const recovered = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const targets = snapshot.resources.runs.filter(({ runId }) => targetIds.has(runId));
    return targets.length === 2_000 && targets.every(({ state }) => state === "SUCCEEDED" || state === "FAILED")
      ? snapshot
      : undefined;
  }, { timeoutMs: 45_000, label: "2,000 expired Execution Leases to recover", children: workers });
  const recoveryMs = Date.now() - recoveryStartedAt;
  const targetAttempts = recovered.resources.attempts.filter(({ runId }) => targetIds.has(runId));
  assert.equal(targetAttempts.length, 4_000);
  assert.equal(new Set(targetAttempts.map(({ runId, attempt }) => `${runId}:${attempt}`)).size, 4_000);
  assert.equal(recovered.resources.executionLeases.some(({ runId }) => targetIds.has(runId)), false);
  assert.equal(recovered.work.filter(({ aggregateId, terminal }) => targetIds.has(aggregateId) && !terminal).length, 0);
  metrics.push({ scenarioId: "expired-lease-recovery", completed: 2_000, durationMs: recoveryMs, workers: 4 });
  assertions.push(`expired-lease-recovery: 2,000 expired leases recovered in ${recoveryMs}ms with one new Attempt each`);
  return { metrics, fixtureSummary: { queues: 100, jobDefinitions: 1_000, runs: 27_000, attempts: 22_000, executionLeases: 2_000 } };
}
