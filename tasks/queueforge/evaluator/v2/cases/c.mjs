import assert from "node:assert/strict";

import { jobDefinition, queue } from "../lib/fixtures.mjs";
import { operationResult } from "../lib/oracle.mjs";
import {
  assertExactError, assertSnapshotClosure, claim, createWorkflow, enqueue, eventFor, finishClaim,
  getRun, guarded, prepare, requireStatus, result, seedOf, waitForRun, waitForWorkflow,
} from "./helpers.mjs";

function workflowNode(nodeKey, definition, targetQueue, dependsOn = []) {
  return {
    nodeKey, jobDefinitionId: definition.jobDefinitionId, jobVersion: definition.version,
    queueId: targetQueue.queueId, priority: 0, input: { value: nodeKey }, dependsOn,
  };
}

const C01 = {
  id: "C-01",
  async run(ctx) {
    return guarded(["RECOVERY_OR_FENCING", "EVENT_ATOMICITY_OR_IDENTITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "lease-recovery", { capacity: 2 });
      const definition = jobDefinition(ctx.fixtures, "lease-recovery", { maxAttempts: 4 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "lease-recovery", { queues: [targetQueue], jobDefinitions: [definition] }));
      const staleTarget = await enqueue(ctx, api, "stale-token", definition, targetQueue);
      const killedTarget = await enqueue(ctx, api, "killed-owner", definition, targetQueue);
      const staleLease = (await claim(ctx, api, "manual-stale-owner", [targetQueue.queueId], 1, "manual-stale"))[0];
      assert.equal(staleLease.run.runId, staleTarget.run.runId);
      const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.claimed" && aggregateId === killedTarget.run.runId });
      const firstWorker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
      const held = await barrier.waitFor(({ json }) => json?.point === "worker.claimed" && json.aggregateId === killedTarget.run.runId, { timeoutMs: 10_000, processes: [firstWorker] });
      await ctx.kill(firstWorker);
      await ctx.waitFor(() => held.disconnected, { timeoutMs: 2_000, label: "killed worker barrier disconnect" });
      const replacement = await ctx.startWorker();
      const [recoveredStale, recoveredKilled] = await Promise.all([
        waitForRun(ctx, api, staleTarget.run.runId, ["SUCCEEDED"], { timeoutMs: 20_000, processes: [replacement] }),
        waitForRun(ctx, api, killedTarget.run.runId, ["SUCCEEDED"], { timeoutMs: 20_000, processes: [replacement] }),
      ]);
      assert.equal(recoveredStale.attemptCount, 2);
      assert.equal(recoveredKilled.attemptCount, 2);
      const staleCommit = await ctx.mutate(api.baseUrl, `/api/v1/runs/${staleTarget.run.runId}/attempt-result`, ctx.key("stale-token-result"), {
        attempt: staleLease.executionLease.attempt, leaseToken: staleLease.executionLease.leaseToken,
        outcome: "SUCCEEDED", output: staleLease.run.input, errorCode: null,
      });
      assertExactError(staleCommit, 409, "STALE_EXECUTION_LEASE");
      for (const target of [staleTarget.run, killedTarget.run]) {
        const attempts = requireStatus(await ctx.request(api.baseUrl, `/api/v1/runs/${target.runId}/attempts`), 200, "recovery attempts").items;
        assert.deepEqual(attempts.map(({ attempt }) => attempt), [1, 2]);
        assert.deepEqual(attempts.map(({ outcome }) => outcome), ["TIMED_OUT", "SUCCEEDED"]);
      }
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.ok(snapshot.resources.executionLeases.every(({ runId }) => ![staleTarget.run.runId, killedTarget.run.runId].includes(runId)));
      return result({ recovered: [recoveredStale.runId, recoveredKilled.runId], killedBarrier: held.json, staleStatus: staleCommit.status });
    });
  },
};

const C02 = {
  id: "C-02",
  async run(ctx) {
    return guarded(["RECOVERY_OR_FENCING", "EVENT_ATOMICITY_OR_IDENTITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "effect", { capacity: 1 });
      const definition = jobDefinition(ctx.fixtures, "effect", { operation: "SHA256", maxAttempts: 3 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "effect-recovery", { queues: [targetQueue], jobDefinitions: [definition] }));
      const input = { z: [3, 2, 1], a: { beta: false, alpha: true } };
      const created = await enqueue(ctx, api, "effect", definition, targetQueue, { input });
      const expected = operationResult("SHA256", input);
      const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.effect-complete" && aggregateId === created.run.runId });
      const firstWorker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
      const held = await barrier.waitFor(({ json }) => json?.point === "worker.effect-complete" && json.aggregateId === created.run.runId, { processes: [firstWorker] });
      await ctx.kill(firstWorker);
      const replacement = await ctx.startWorker();
      const terminal = await waitForRun(ctx, api, created.run.runId, ["SUCCEEDED"], { timeoutMs: 20_000, processes: [replacement] });
      assert.deepEqual(terminal.output, expected);
      assert.equal(terminal.attemptCount, 2);
      const attempts = requireStatus(await ctx.request(api.baseUrl, `/api/v1/runs/${created.run.runId}/attempts`), 200, "effect attempts").items;
      assert.deepEqual(attempts.map(({ outcome }) => outcome), ["TIMED_OUT", "SUCCEEDED"]);
      assert.equal(attempts.filter(({ outputDigest }) => outputDigest !== null).length, 1);
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.equal(eventFor(snapshot, created.run.runId, "run.succeeded").length, 1);
      assert.equal(snapshot.work.filter(({ aggregateId, state }) => aggregateId === created.run.runId && state === "SUCCEEDED").length, 1);
      return result({ runId: terminal.runId, output: terminal.output, attempts: attempts.map(({ outcome }) => outcome), barrier: held.json });
    });
  },
};

const C03 = {
  id: "C-03",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY", "RECOVERY_OR_FENCING"], async () => {
      const targetQueue = queue(ctx.fixtures, "workflow-recovery", { capacity: 50 });
      const definition = jobDefinition(ctx.fixtures, "workflow-recovery", { maxAttempts: 4 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "workflow-recovery", { queues: [targetQueue], jobDefinitions: [definition] }));
      const nodes = Array.from({ length: 50 }, (_, index) => {
        const key = `n-${String(index).padStart(2, "0")}`;
        const dependsOn = index === 0 ? [] : [`n-${String(Math.floor((index - 1) / 3)).padStart(2, "0")}`];
        return workflowNode(key, definition, targetQueue, dependsOn);
      });
      const { workflow } = await createWorkflow(ctx, api, "recovering-dag", nodes);
      const rootRunId = workflow.nodes.find(({ nodeKey }) => nodeKey === "n-00").runId;
      const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.claimed" && aggregateId === rootRunId });
      const killedAttempts = [];
      for (let ordinal = 0; ordinal < 2; ordinal += 1) {
        const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
        const held = await barrier.waitFor(({ json }) => json?.point === "worker.claimed" && json.aggregateId === rootRunId && json.attempt === ordinal + 1, { timeoutMs: 15_000, processes: [worker] });
        killedAttempts.push(held.json);
        await ctx.kill(worker);
      }
      const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
      const terminal = await waitForWorkflow(ctx, api, workflow.workflowRunId, ["SUCCEEDED"], { timeoutMs: 60_000, processes: workers });
      assert.equal(terminal.nodes.length, 50);
      assert.ok(terminal.nodes.every(({ state }) => state === "SUCCEEDED"));
      assert.equal((await getRun(ctx, api, rootRunId)).attemptCount, 3);
      const snapshot = await ctx.snapshot(api.baseUrl);
      const members = new Set(workflow.nodes.map(({ runId }) => runId));
      assert.equal(snapshot.resources.runs.filter(({ runId, state }) => members.has(runId) && state === "SUCCEEDED").length, 50);
      assert.equal(snapshot.resources.runs.filter(({ runId }) => members.has(runId)).reduce((sum, item) => sum + item.attemptCount, 0), 52);
      assertSnapshotClosure(snapshot);
      return result({ workflowRunId: workflow.workflowRunId, killedAttempts, terminalNodes: terminal.nodes.length });
    });
  },
};

const C04 = {
  id: "C-04",
  async run(ctx) {
    return guarded(["EVENT_ATOMICITY_OR_IDENTITY", "DURABLE_IDEMPOTENCY"], async () => {
      const targetQueue = queue(ctx.fixtures, "events", { capacity: 5 });
      const definition = jobDefinition(ctx.fixtures, "events");
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "events", { queues: [targetQueue], jobDefinitions: [definition] }));
      const created = await enqueue(ctx, api, "event-source", definition, targetQueue);
      const item = (await claim(ctx, api, "event-worker", [targetQueue.queueId], 1, "event-start"))[0];
      await finishClaim(ctx, api, item, "event-success");
      const beforeInvalid = await ctx.snapshot(api.baseUrl);
      const invalid = await ctx.mutate(api.baseUrl, "/api/v1/runs", ctx.key("invalid-event-source"), {
        jobDefinitionId: definition.jobDefinitionId, jobVersion: 1, queueId: targetQueue.queueId,
        priority: 0, notBefore: new Date(Date.now() - 1_000).toISOString(), input: { values: [] }, unexpected: true,
      });
      assertExactError(invalid, 400, "UNKNOWN_FIELD");
      const afterInvalid = await ctx.snapshot(api.baseUrl);
      assert.deepEqual(afterInvalid.events, beforeInvalid.events);

      const deliveries = new Map();
      const receiver = await ctx.receiver({ behavior: (entry) => {
        const id = entry.headers["x-queueforge-event-id"];
        const count = (deliveries.get(id) ?? 0) + 1;
        deliveries.set(id, count);
        if (count === 1) return { status: 500 };
        if (count === 2) return { disconnect: true };
        return { status: 204 };
      } });
      const barrier = await ctx.barrier({ hold: ({ point }) => point === "dispatcher.response-received" });
      const firstDispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
      const held = await barrier.waitFor(({ json }) => json?.point === "dispatcher.response-received", { timeoutMs: 10_000, processes: [firstDispatcher] });
      await ctx.kill(firstDispatcher);
      const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
      const events = afterInvalid.events.filter(({ aggregateId }) => aggregateId === created.run.runId);
      await ctx.waitFor(() => events.every(({ eventId }) => receiver.ledger.some((entry) => entry.headers["x-queueforge-event-id"] === eventId && entry.acknowledged && entry.responseStatus === 204)), {
        timeoutMs: 20_000, label: "all Run events acknowledged", processes: [replacement],
      });
      for (const event of events) {
        const attempts = receiver.ledger.filter((entry) => entry.headers["x-queueforge-event-id"] === event.eventId);
        assert.ok(attempts.length >= 3);
        assert.ok(attempts.every((entry) => entry.headers["x-queueforge-event-type"] === event.type));
        assert.ok(attempts.every((entry) => entry.raw === attempts[0].raw));
        assert.deepEqual(attempts[0].json, event);
      }
      const firstSuccessful = receiver.ledger.filter(({ acknowledged, responseStatus }) => acknowledged && responseStatus === 204)
        .map(({ json }) => json).filter(({ aggregateId }) => aggregateId === created.run.runId);
      assert.deepEqual(firstSuccessful.map(({ sequence }) => sequence), [...firstSuccessful].map(({ sequence }) => sequence).sort((a, b) => a - b));
      return result({ runId: created.run.runId, eventIds: events.map(({ eventId }) => eventId), heldBarrier: held.json, deliveryAttempts: receiver.ledger.length });
    });
  },
};

export const C_CASES = Object.freeze([C01, C02, C03, C04]);
