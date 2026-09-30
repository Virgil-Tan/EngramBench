import assert from "node:assert/strict";

import { jobDefinition, queue, run } from "../lib/fixtures.mjs";
import { compareClaimOrder, workflowOracle } from "../lib/oracle.mjs";
import {
  assertExactError, assertSnapshotClosure, claim, createWorkflow, enqueue, eventFor, finishClaim,
  getRun, getWorkflow, guarded, prepare, requireStatus, result, seedOf,
} from "./helpers.mjs";

function workflowNode(nodeKey, definition, targetQueue, dependsOn = []) {
  return {
    nodeKey, jobDefinitionId: definition.jobDefinitionId, jobVersion: definition.version,
    queueId: targetQueue.queueId, priority: 0, input: { value: nodeKey }, dependsOn,
  };
}

const B01 = {
  id: "B-01",
  async run(ctx) {
    return guarded(["DURABLE_IDEMPOTENCY"], async () => {
      const targetQueue = queue(ctx.fixtures, "idempotency", { capacity: 100 });
      const definition = jobDefinition(ctx.fixtures, "idempotency");
      const { apis } = await prepare(ctx, seedOf(ctx.fixtures, "idempotency", { queues: [targetQueue], jobDefinitions: [definition] }), { apis: 2 });
      const [api1, api2] = apis;
      const body = {
        jobDefinitionId: definition.jobDefinitionId, jobVersion: 1, queueId: targetQueue.queueId,
        priority: 17, notBefore: new Date(Date.now() - 1_000).toISOString(), input: { value: "unknown-response" },
      };
      const key = ctx.key("unknown-response-enqueue");
      const shield = await ctx.responseShield(api1.baseUrl);
      shield.dropNextMutation();
      await assert.rejects(ctx.mutate(shield.baseUrl, "/api/v1/runs", key, body));
      const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "dropped committed enqueue response" });
      assert.equal(capture.response.status, 202);
      const original = JSON.parse(capture.response.body);
      await ctx.stop(api1);
      const replay = await ctx.mutate(api2.baseUrl, "/api/v1/runs", key, body);
      assert.equal(replay.status, 202);
      assert.deepEqual(replay.json, original);

      const concurrentBody = { ...body, input: { value: "twenty-way" }, priority: 18 };
      const concurrentKey = ctx.key("twenty-way-enqueue");
      const restarted = await ctx.startApi();
      const activeApis = [restarted, api2];
      const replies = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(
        activeApis[index % 2].baseUrl, "/api/v1/runs", concurrentKey, concurrentBody,
      )));
      assert.ok(replies.every(({ status }) => status === 202));
      assert.ok(replies.every(({ json }) => JSON.stringify(json) === JSON.stringify(replies[0].json)));
      const conflict = await ctx.mutate(api2.baseUrl, "/api/v1/runs", concurrentKey, { ...concurrentBody, input: { value: "conflict" } });
      assertExactError(conflict, 409, "IDEMPOTENCY_CONFLICT");
      const snapshot = await ctx.snapshot(api2.baseUrl);
      const selected = snapshot.resources.runs.filter(({ input }) => ["unknown-response", "twenty-way", "conflict"].includes(input?.value));
      assert.equal(selected.length, 2);
      for (const created of selected) {
        assert.equal(snapshot.work.filter(({ aggregateId }) => aggregateId === created.runId).length, 1);
        assert.equal(eventFor(snapshot, created.runId, "run.queued").length, 1);
      }
      assertSnapshotClosure(snapshot);
      return result({ replayRunId: replay.json.runId, concurrentRunId: replies[0].json.runId, responseDigest: capture.response.body });
    });
  },
};

const B02 = {
  id: "B-02",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY", "RECOVERY_OR_FENCING"], async () => {
      const targetQueue = queue(ctx.fixtures, "hot", { capacity: 100 });
      const definition = jobDefinition(ctx.fixtures, "hot");
      const epoch = Date.now() - 120_000;
      const runs = Array.from({ length: 80 }, (_, index) => run(ctx.fixtures, `hot-${index}`, definition, targetQueue, {
        priority: index % 4, notBefore: new Date(epoch + (index % 3) * 1_000).toISOString(),
        createdAt: new Date(epoch + Math.floor(index / 4) * 10).toISOString(), input: { value: index },
      }));
      const expected = runs.toSorted(compareClaimOrder).map(({ runId }) => runId);
      const { apis } = await prepare(ctx, seedOf(ctx.fixtures, "hot-queue", { queues: [targetQueue], jobDefinitions: [definition], runs }), { apis: 2 });
      const groups = await Promise.all(Array.from({ length: 4 }, (_, index) => claim(
        ctx, apis[index % 2], `hot-worker-${index}`, [targetQueue.queueId], 20, `hot-${index}`,
      )));
      assert.ok(groups.every((items) => items.length === 20));
      const actual = groups.flat().map(({ run: item }) => item.runId);
      assert.equal(new Set(actual).size, 80);
      assert.deepEqual(new Set(actual), new Set(expected));
      const expectedChunks = Array.from({ length: 4 }, (_, index) => expected.slice(index * 20, index * 20 + 20).join("\0")).sort();
      const actualChunks = groups.map((items) => items.map(({ run: item }) => item.runId).join("\0")).sort();
      assert.deepEqual(actualChunks, expectedChunks);
      await Promise.all(groups.flat().map((item, index) => finishClaim(ctx, apis[index % 2], item, `hot-finish-${index}`, { output: item.run.input })));
      const snapshot = await ctx.snapshot(apis[0].baseUrl);
      assert.equal(snapshot.resources.runs.filter(({ runId, state }) => expected.includes(runId) && state === "SUCCEEDED").length, 80);
      assert.ok(snapshot.resources.runs.filter(({ runId }) => expected.includes(runId)).every(({ attemptCount }) => attemptCount === 1));
      assertSnapshotClosure(snapshot);
      return result({ claimGroups: groups.map((items) => items.map(({ run: item }) => item.runId)), completed: actual.length });
    });
  },
};

const B03 = {
  id: "B-03",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY", "RECOVERY_OR_FENCING", "EVENT_ATOMICITY_OR_IDENTITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "terminal-race", { capacity: 1 });
      const definition = jobDefinition(ctx.fixtures, "terminal-race");
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "terminal-race", { queues: [targetQueue], jobDefinitions: [definition] }));
      const created = await enqueue(ctx, api, "terminal-race", definition, targetQueue, { input: { value: "winner" } });
      const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.before-commit" && aggregateId === created.run.runId });
      const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
      const held = await barrier.waitFor(({ json }) => json?.point === "worker.before-commit" && json.aggregateId === created.run.runId, { processes: [worker] });
      const cancelKey = ctx.key("race-cancel");
      const cancel = await ctx.mutate(api.baseUrl, `/api/v1/runs/${created.run.runId}/cancel`, cancelKey, { reason: "controlled race" });
      const cancelled = requireStatus(cancel, 200, "race cancellation");
      assert.equal(cancelled.state, "CANCELLED");
      barrier.release(held);
      const terminal = await getRun(ctx, api, created.run.runId);
      assert.equal(terminal.state, "CANCELLED");
      assert.equal(terminal.output, null);
      const replay = await ctx.mutate(api.baseUrl, `/api/v1/runs/${created.run.runId}/cancel`, cancelKey, { reason: "controlled race" });
      assert.deepEqual(replay.json, cancel.json);
      const again = await ctx.mutate(api.baseUrl, `/api/v1/runs/${created.run.runId}/cancel`, ctx.key("race-cancel-again"), { reason: "too late" });
      assertExactError(again, 409, "RUN_NOT_CANCELLABLE");
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.equal(eventFor(snapshot, created.run.runId, "run.cancelled").length, 1);
      assert.equal(eventFor(snapshot, created.run.runId, "run.succeeded").length, 0);
      assert.equal(snapshot.resources.executionLeases.some(({ runId }) => runId === created.run.runId), false);
      return result({ runId: terminal.runId, terminalState: terminal.state, barrier: held.json });
    });
  },
};

const B04 = {
  id: "B-04",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY", "DURABLE_IDEMPOTENCY"], async () => {
      const targetQueue = queue(ctx.fixtures, "fanout", { capacity: 100 });
      const definition = jobDefinition(ctx.fixtures, "fanout");
      const { apis } = await prepare(ctx, seedOf(ctx.fixtures, "fanout", { queues: [targetQueue], jobDefinitions: [definition] }), { apis: 2 });
      const leaves = Array.from({ length: 24 }, (_, index) => `leaf-${String(index).padStart(2, "0")}`);
      const nodes = [workflowNode("root", definition, targetQueue), ...leaves.map((key) => workflowNode(key, definition, targetQueue, ["root"])), workflowNode("join", definition, targetQueue, leaves)];
      const { workflow } = await createWorkflow(ctx, apis[0], "fanout", nodes);
      const premature = await Promise.all(Array.from({ length: 4 }, (_, index) => claim(ctx, apis[index % 2], `fanout-worker-${index}`, [targetQueue.queueId], 20, `premature-${index}`)));
      assert.deepEqual(premature.flat().map(({ run }) => run.nodeKey), ["root"]);
      await finishClaim(ctx, apis[0], premature.flat()[0], "fanout-root");
      const groups = await Promise.all(Array.from({ length: 4 }, (_, index) => claim(ctx, apis[index % 2], `fanout-worker-${index}`, [targetQueue.queueId], 20, `leaves-${index}`)));
      const claimedLeaves = groups.flat();
      assert.equal(claimedLeaves.length, leaves.length);
      assert.deepEqual(claimedLeaves.map(({ run }) => run.nodeKey).sort(), leaves);
      assert.equal(new Set(claimedLeaves.map(({ run }) => run.runId)).size, leaves.length);
      await Promise.all(claimedLeaves.map((item, index) => finishClaim(ctx, apis[index % 2], item, `leaf-result-${index}`)));
      const join = (await claim(ctx, apis[1], "fanout-join-worker", [targetQueue.queueId], 20, "join"));
      assert.deepEqual(join.map(({ run }) => run.nodeKey), ["join"]);
      await finishClaim(ctx, apis[1], join[0], "join-result");
      const closed = await getWorkflow(ctx, apis[0], workflow.workflowRunId);
      assert.equal(closed.state, "SUCCEEDED");
      assert.ok(closed.nodes.every(({ state }) => state === "SUCCEEDED"));
      return result({ workflowRunId: workflow.workflowRunId, fanoutWidth: leaves.length, claimedRunIds: claimedLeaves.map(({ run }) => run.runId) });
    });
  },
};

const B05 = {
  id: "B-05",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "selective", { capacity: 10 });
      const definition = jobDefinition(ctx.fixtures, "selective", { maxAttempts: 3 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "selective-retry", { queues: [targetQueue], jobDefinitions: [definition] }));
      const nodes = [
        workflowNode("A", definition, targetQueue), workflowNode("B", definition, targetQueue),
        workflowNode("X", definition, targetQueue, ["A"]), workflowNode("Y", definition, targetQueue, ["A", "B"]),
      ];
      const model = workflowOracle(nodes);
      const { workflow } = await createWorkflow(ctx, api, "selective", nodes);
      let items = await claim(ctx, api, "selective-worker", [targetQueue.queueId], 10, "failed-roots");
      assert.deepEqual(items.map(({ run }) => run.nodeKey).sort(), ["A", "B"]);
      for (const item of items) await finishClaim(ctx, api, item, `${item.run.nodeKey}-failure`, { outcome: "PERMANENT_FAILURE", errorCode: `FAILED_${item.run.nodeKey}` });
      let state = await getWorkflow(ctx, api, workflow.workflowRunId);
      assert.deepEqual(Object.fromEntries(state.nodes.map((node) => [node.nodeKey, node.state])), { A: "FAILED", B: "FAILED", X: "BLOCKED", Y: "BLOCKED" });
      const stateMap = new Map(state.nodes.map((node) => [node.nodeKey, node.state]));
      assert.deepEqual(model.retryRelease(stateMap, "A"), ["X"]);
      requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/workflow-runs/${workflow.workflowRunId}/nodes/A/retry`, ctx.key("retry-A"), {}), 200, "retry A");
      state = await getWorkflow(ctx, api, workflow.workflowRunId);
      assert.deepEqual(Object.fromEntries(state.nodes.map((node) => [node.nodeKey, node.state])), { A: "QUEUED", B: "FAILED", X: "QUEUED", Y: "BLOCKED" });
      items = await claim(ctx, api, "selective-worker", [targetQueue.queueId], 10, "A-only");
      assert.deepEqual(items.map(({ run }) => run.nodeKey), ["A"]);
      await finishClaim(ctx, api, items[0], "A-retry-success");
      items = await claim(ctx, api, "selective-worker", [targetQueue.queueId], 10, "X-only");
      assert.deepEqual(items.map(({ run }) => run.nodeKey), ["X"]);
      await finishClaim(ctx, api, items[0], "X-success");
      state = await getWorkflow(ctx, api, workflow.workflowRunId);
      assert.equal(state.nodes.find(({ nodeKey }) => nodeKey === "Y").state, "BLOCKED");
      requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/workflow-runs/${workflow.workflowRunId}/nodes/B/retry`, ctx.key("retry-B"), {}), 200, "retry B");
      items = await claim(ctx, api, "selective-worker", [targetQueue.queueId], 10, "B-only");
      assert.deepEqual(items.map(({ run }) => run.nodeKey), ["B"]);
      await finishClaim(ctx, api, items[0], "B-retry-success");
      items = await claim(ctx, api, "selective-worker", [targetQueue.queueId], 10, "Y-finally");
      assert.deepEqual(items.map(({ run }) => run.nodeKey), ["Y"]);
      await finishClaim(ctx, api, items[0], "Y-success");
      state = await getWorkflow(ctx, api, workflow.workflowRunId);
      assert.equal(state.state, "SUCCEEDED");
      assert.equal((await getRun(ctx, api, state.nodes.find(({ nodeKey }) => nodeKey === "X").runId)).attemptCount, 1);
      return result({ workflowRunId: workflow.workflowRunId, releasedByA: ["X"], retainedByB: ["Y"] });
    });
  },
};

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05]);
