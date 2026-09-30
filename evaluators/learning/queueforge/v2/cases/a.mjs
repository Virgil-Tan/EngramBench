import assert from "node:assert/strict";

import { jobDefinition, queue, run } from "../lib/fixtures.mjs";
import { compareClaimOrder, operationResult, retryDelayMs, workflowOracle } from "../lib/oracle.mjs";
import {
  assertExactError, assertSnapshotClosure, claim, createWorkflow, enqueue, eventFor, finishClaim,
  createDefinition, getRun, getWorkflow, guarded, prepare, requireStatus, result, seedOf, stableSnapshot, waitForRun,
} from "./helpers.mjs";

function workflowNode(nodeKey, definition, targetQueue, dependsOn = [], input = { value: nodeKey }, overrides = {}) {
  return {
    nodeKey, jobDefinitionId: definition.jobDefinitionId, jobVersion: definition.version,
    queueId: targetQueue.queueId, priority: 0, input, dependsOn, ...overrides,
  };
}

async function pollClaim(ctx, api, workerId, queueId, prefix, timeoutMs = 5_000) {
  let ordinal = 0;
  return ctx.waitFor(async () => {
    const items = await claim(ctx, api, workerId, [queueId], 1, `${prefix}-${ordinal += 1}`);
    return items[0];
  }, { timeoutMs, intervalMs: 20, label: `${prefix} eligible claim` });
}

const A01 = {
  id: "A-01",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "operations", { capacity: 10 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "operations", { queues: [targetQueue] }));
      const definitions = {
        ECHO: await createDefinition(ctx, api, "echo", { operation: "ECHO" }),
        SHA256: await createDefinition(ctx, api, "sha", { operation: "SHA256" }),
        SUM_INTEGERS: await createDefinition(ctx, api, "sum", { operation: "SUM_INTEGERS" }),
      };
      const inputs = {
        ECHO: { z: [true, null, { b: 2, a: 1 }], a: "canonical" },
        SHA256: { b: 2, a: [3, 1] },
        SUM_INTEGERS: { values: [Number.MAX_SAFE_INTEGER - 20, -7, 13] },
      };
      const expected = new Map();
      for (const operation of Object.keys(definitions)) {
        const created = await enqueue(ctx, api, operation.toLowerCase(), definitions[operation], targetQueue, { input: inputs[operation] });
        expected.set(created.run.runId, operationResult(operation, inputs[operation]));
      }
      const worker = await ctx.startWorker();
      for (const [runId, output] of expected) {
        const terminal = await waitForRun(ctx, api, runId, ["SUCCEEDED"], { processes: [worker] });
        assert.deepEqual(terminal.output, output);
      }

      const overflow = await enqueue(ctx, api, "sum-overflow", definitions.SUM_INTEGERS, targetQueue, {
        input: { values: [Number.MAX_SAFE_INTEGER, 1] },
      });
      const overflowTerminal = await waitForRun(ctx, api, overflow.run.runId, ["FAILED"], { processes: [worker] });
      assert.equal(overflowTerminal.output, null);
      assert.equal(typeof overflowTerminal.errorCode, "string");
      const overflowAttempts = requireStatus(await ctx.request(api.baseUrl, `/api/v1/runs/${overflow.run.runId}/attempts`), 200, "overflow attempts").items;
      assert.deepEqual(overflowAttempts.map(({ outcome }) => outcome), ["PERMANENT_FAILURE"]);
      assert.equal(overflowAttempts[0].outputDigest, null);

      const before = await ctx.snapshot(api.baseUrl);
      const invalids = [
        { values: [] }, { values: [1.5] },
        { values: Array.from({ length: 10_001 }, () => 1) }, { values: [1], extra: true },
      ];
      for (const [index, input] of invalids.entries()) {
        const response = await ctx.mutate(api.baseUrl, "/api/v1/runs", ctx.key(`invalid-sum-${index}`), {
          jobDefinitionId: definitions.SUM_INTEGERS.jobDefinitionId, jobVersion: 1, queueId: targetQueue.queueId,
          priority: 0, notBefore: new Date(Date.now() - 1_000).toISOString(), input,
        });
        assertExactError(response, 400, "INVALID_JOB_INPUT");
      }
      const after = await ctx.snapshot(api.baseUrl);
      assert.deepEqual(stableSnapshot(after), stableSnapshot(before));
      assertSnapshotClosure(after);
      return result({ runIds: [...expected.keys()], outputs: [...expected.values()], overflowRunId: overflow.run.runId, invalidCount: invalids.length });
    });
  },
};

const A02 = {
  id: "A-02",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "ordered", { capacity: 20 });
      const definition = jobDefinition(ctx.fixtures, "ordered", { operation: "ECHO" });
      const epoch = Date.now() - 60_000;
      const timestamp = (offset) => new Date(epoch + offset).toISOString();
      const specifications = [
        ["high-early", 90, -2_000, -4_000], ["high-later", 90, -1_000, -5_000],
        ["middle-a", 50, -2_000, -3_000], ["middle-b", 50, -2_000, -3_000],
        ["low", -20, -5_000, -6_000], ["future", 100, 3_600_000, -10_000],
      ];
      const runs = specifications.map(([label, priority, notBefore, createdAt]) => run(ctx.fixtures, label, definition, targetQueue, {
        priority, notBefore: timestamp(notBefore), createdAt: timestamp(createdAt), input: { value: label },
      }));
      const expected = runs.filter(({ input }) => input.value !== "future").toSorted(compareClaimOrder);
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "ordering", { queues: [targetQueue], jobDefinitions: [definition], runs }));
      const claimed = await claim(ctx, api, "ordering-worker", [targetQueue.queueId], 20, "ordering");
      assert.deepEqual(claimed.map(({ run: item }) => item.runId), expected.map(({ runId }) => runId));
      assert.equal(claimed.some(({ run: item }) => item.input.value === "future"), false);
      for (const [index, item] of claimed.entries()) await finishClaim(ctx, api, item, `ordered-${index}`);
      const empty = await claim(ctx, api, "ordering-worker", [targetQueue.queueId], 20, "future-excluded");
      assert.deepEqual(empty, []);
      const future = await getRun(ctx, api, runs.at(-1).runId);
      assert.equal(future.state, "QUEUED");
      return result({ expectedOrder: expected.map(({ runId }) => runId), futureRunId: future.runId });
    });
  },
};

const A03 = {
  id: "A-03",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY", "RECOVERY_OR_FENCING"], async () => {
      const targetQueue = queue(ctx.fixtures, "capacity", { capacity: 1 });
      const definition = jobDefinition(ctx.fixtures, "retry", { maxAttempts: 3 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "capacity-retry", { queues: [targetQueue], jobDefinitions: [definition] }));
      const first = await enqueue(ctx, api, "retry-target", definition, targetQueue);
      const second = await enqueue(ctx, api, "capacity-waiter", definition, targetQueue);
      const lease1 = (await claim(ctx, api, "capacity-worker", [targetQueue.queueId], 1, "capacity-first"))[0];
      const beforeExhausted = await ctx.snapshot(api.baseUrl);
      const exhausted = await ctx.mutate(api.baseUrl, "/api/v1/workers/other-worker/claim", ctx.key("capacity-exhausted"), { queueIds: [targetQueue.queueId], maxRuns: 1 });
      assertExactError(exhausted, 409, "QUEUE_CAPACITY_EXHAUSTED");
      const afterExhausted = await ctx.snapshot(api.baseUrl);
      assert.deepEqual(stableSnapshot(afterExhausted), stableSnapshot(beforeExhausted));
      const cancelled = await ctx.mutate(api.baseUrl, `/api/v1/runs/${second.run.runId}/cancel`, ctx.key("cancel-waiter"), { reason: "isolate retry schedule" });
      assert.equal(requireStatus(cancelled, 200, "cancel queued waiter").state, "CANCELLED");

      const failed1 = await finishClaim(ctx, api, lease1, "retryable-1", { outcome: "RETRYABLE_FAILURE", errorCode: "TEMPORARY_A" });
      assert.equal(failed1.run.state, "QUEUED");
      assert.equal(Date.parse(failed1.run.notBefore) - Date.parse(failed1.attempt.finishedAt), retryDelayMs(1));
      const lease2 = await pollClaim(ctx, api, "capacity-worker", targetQueue.queueId, "retry-attempt-2");
      assert.equal(lease2.executionLease.attempt, 2);
      const failed2 = await finishClaim(ctx, api, lease2, "retryable-2", { outcome: "RETRYABLE_FAILURE", errorCode: "TEMPORARY_B" });
      assert.equal(Date.parse(failed2.run.notBefore) - Date.parse(failed2.attempt.finishedAt), retryDelayMs(2));
      const lease3 = await pollClaim(ctx, api, "capacity-worker", targetQueue.queueId, "retry-attempt-3");
      assert.equal(lease3.executionLease.attempt, 3);
      const final = await finishClaim(ctx, api, lease3, "exhausted-3", { outcome: "RETRYABLE_FAILURE", errorCode: "TEMPORARY_EXHAUSTED" });
      assert.equal(final.run.state, "FAILED");
      assert.equal(final.run.attemptCount, 3);
      const noReentry = await claim(ctx, api, "capacity-worker", [targetQueue.queueId], 1, "no-terminal-reentry");
      assert.deepEqual(noReentry, []);
      const attempts = requireStatus(await ctx.request(api.baseUrl, `/api/v1/runs/${first.run.runId}/attempts`), 200, "attempt history");
      assert.deepEqual(attempts.items.map(({ attempt: number }) => number), [1, 2, 3]);
      return result({ runId: first.run.runId, retryNotBefore: [failed1.run.notBefore, failed2.run.notBefore], outcomes: attempts.items.map(({ outcome }) => outcome) });
    });
  },
};

const A04 = {
  id: "A-04",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "workflow", { capacity: 100 });
      const definition = jobDefinition(ctx.fixtures, "workflow", { maxAttempts: 4 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "workflow-graphs", { queues: [targetQueue], jobDefinitions: [definition] }));
      const one = await createWorkflow(ctx, api, "single", [workflowNode("single", definition, targetQueue)]);
      assert.deepEqual(one.workflow.nodes.map(({ nodeKey }) => nodeKey), ["single"]);
      const fiftyNodes = Array.from({ length: 50 }, (_, index) => {
        const key = `node-${String(index).padStart(2, "0")}`;
        return workflowNode(key, definition, targetQueue, index === 0 ? [] : [`node-${String(index - 1).padStart(2, "0")}`]);
      });
      const oracle = workflowOracle(fiftyNodes);
      const fifty = await createWorkflow(ctx, api, "fifty", fiftyNodes);
      assert.deepEqual(fifty.workflow.nodes.map(({ nodeKey, dependsOn }) => ({ nodeKey, dependsOn })), oracle.nodes);
      assert.deepEqual(await getWorkflow(ctx, api, fifty.workflow.workflowRunId), fifty.workflow);

      const invalidGraphs = [
        [], Array.from({ length: 51 }, (_, index) => workflowNode(`too-many-${index}`, definition, targetQueue)),
        [workflowNode("dup", definition, targetQueue), workflowNode("dup", definition, targetQueue)],
        [workflowNode("self", definition, targetQueue, ["self"])],
        [workflowNode("missing", definition, targetQueue, ["absent"])],
        [workflowNode("x", definition, targetQueue, ["y"]), workflowNode("y", definition, targetQueue, ["x"])],
      ];
      for (const [index, nodes] of invalidGraphs.entries()) {
        const before = await ctx.snapshot(api.baseUrl);
        const response = await ctx.mutate(api.baseUrl, "/api/v1/workflow-runs", ctx.key(`invalid-graph-${index}`), { nodes }, { contractExpectation: index < 2 ? "invalid" : undefined });
        assertExactError(response, 400, index < 2 ? "INVALID_REQUEST" : "WORKFLOW_GRAPH_CYCLE");
        const after = await ctx.snapshot(api.baseUrl);
        assert.deepEqual(stableSnapshot(after), stableSnapshot(before));
      }
      return result({ single: one.workflow.workflowRunId, fifty: fifty.workflow.workflowRunId, rejectedGraphCount: invalidGraphs.length });
    });
  },
};

const A05 = {
  id: "A-05",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "closure", { capacity: 10 });
      const definition = jobDefinition(ctx.fixtures, "closure", { maxAttempts: 3 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "workflow-closure", { queues: [targetQueue], jobDefinitions: [definition] }));
      const nodes = [
        workflowNode("A", definition, targetQueue), workflowNode("B", definition, targetQueue, ["A"]),
        workflowNode("C", definition, targetQueue, ["A"]), workflowNode("D", definition, targetQueue, ["B", "C"]),
        workflowNode("E", definition, targetQueue, ["D"]),
      ];
      const model = workflowOracle(nodes);
      const { workflow } = await createWorkflow(ctx, api, "worked-example", nodes);
      const byKey = new Map(workflow.nodes.map((node) => [node.nodeKey, node]));
      let claimed = await claim(ctx, api, "dag-worker", [targetQueue.queueId], 10, "root-only");
      assert.deepEqual(claimed.map(({ run }) => run.nodeKey), model.eligible(new Map()));
      await finishClaim(ctx, api, claimed[0], "A-success");
      claimed = await claim(ctx, api, "dag-worker", [targetQueue.queueId], 10, "branches");
      assert.deepEqual(claimed.map(({ run }) => run.nodeKey).sort(), ["B", "C"]);
      const B = claimed.find(({ run }) => run.nodeKey === "B");
      const C = claimed.find(({ run }) => run.nodeKey === "C");
      await finishClaim(ctx, api, B, "B-fails", { outcome: "PERMANENT_FAILURE", errorCode: "BRANCH_FAILURE" });
      await finishClaim(ctx, api, C, "C-success");
      let state = await getWorkflow(ctx, api, workflow.workflowRunId);
      assert.equal(state.state, "FAILED");
      assert.deepEqual(Object.fromEntries(state.nodes.map((node) => [node.nodeKey, node.state])), {
        A: "SUCCEEDED", B: "FAILED", C: "SUCCEEDED", D: "BLOCKED", E: "BLOCKED",
      });
      assert.deepEqual(model.blockedBy(new Map(state.nodes.map((node) => [node.nodeKey, node.state]))), ["D", "E"]);
      const noBlockedClaim = await claim(ctx, api, "dag-worker", [targetQueue.queueId], 10, "blocked-not-claimable");
      assert.deepEqual(noBlockedClaim, []);
      const retried = requireStatus(await ctx.mutate(
        api.baseUrl, `/api/v1/workflow-runs/${workflow.workflowRunId}/nodes/B/retry`, ctx.key("retry-B"), {},
      ), 200, "retry B");
      assert.equal(retried.state, "RUNNING");
      claimed = await claim(ctx, api, "dag-worker", [targetQueue.queueId], 10, "B-retry-claim");
      assert.deepEqual(claimed.map(({ run }) => run.nodeKey), ["B"]);
      await finishClaim(ctx, api, claimed[0], "B-retry-success");
      for (const key of ["D", "E"]) {
        claimed = await claim(ctx, api, "dag-worker", [targetQueue.queueId], 10, `${key}-claim`);
        assert.deepEqual(claimed.map(({ run }) => run.nodeKey), [key]);
        await finishClaim(ctx, api, claimed[0], `${key}-success`);
      }
      state = await getWorkflow(ctx, api, workflow.workflowRunId);
      assert.equal(state.state, "SUCCEEDED");
      assert.ok(state.nodes.every(({ state: nodeState }) => nodeState === "SUCCEEDED"));
      assert.equal((await getRun(ctx, api, byKey.get("B").runId)).attemptCount, 2);
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.equal(eventFor(snapshot, byKey.get("D").runId, "run.started").length, 1);
      assertSnapshotClosure(snapshot);
      return result({ workflowRunId: workflow.workflowRunId, nodeRunIds: Object.fromEntries(workflow.nodes.map(({ nodeKey, runId }) => [nodeKey, runId])) });
    });
  },
};

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05]);
