import assert from "node:assert/strict";

import { jobDefinition, queue } from "../lib/fixtures.mjs";
import {
  assertExactError, assertFinalSnapshot, assertRun, assertSnapshotClosure, claim, createWorkflow,
  enqueue, finishClaim, getRun, getWorkflow, guarded, launchBrowser, prepare, requireStatus, result,
  seedOf, stableSnapshot, visibleButton,
} from "./helpers.mjs";

function workflowNode(nodeKey, definition, targetQueue, dependsOn = []) {
  return {
    nodeKey, jobDefinitionId: definition.jobDefinitionId, jobVersion: definition.version,
    queueId: targetQueue.queueId, priority: 0, input: { value: nodeKey }, dependsOn,
  };
}

async function fillControl(page, pattern, value) {
  const control = page.getByLabel(pattern).first();
  await control.waitFor({ state: "visible" });
  const tag = await control.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "select") {
    const options = await control.locator("option").evaluateAll((items) => items.map((item) => ({ label: item.textContent ?? "", value: item.value })));
    const selected = options.find((option) => option.value === String(value) || option.label.includes(String(value))) ?? options.find((option) => option.value);
    assert.ok(selected, `no option for ${pattern}`);
    await control.selectOption(selected.value);
  } else {
    await control.fill(String(value));
  }
}

async function navigate(page, pattern) {
  const link = page.getByRole("link", { name: pattern }).first();
  if (await link.count()) await link.click();
  else await (await visibleButton(page, pattern)).click();
}

async function selectFirstValue(control) {
  const options = await control.locator("option").evaluateAll((items) => items.map((item) => ({ value: item.value, disabled: item.disabled })));
  const selected = options.find(({ value, disabled }) => value && !disabled);
  assert.ok(selected, "visible selector has no selectable value");
  await control.selectOption(selected.value);
}

async function enqueueVisibleRun(page, { input, priority = 0, notBefore } = {}) {
  await navigate(page, /new run|enqueue|create run/i);
  const definition = page.getByLabel(/job definition/i).first();
  await definition.waitFor({ state: "visible" });
  if (await definition.evaluate((element) => element.tagName.toLowerCase()) === "select") await selectFirstValue(definition);
  const queueControl = page.getByLabel(/^queue|execution queue/i).first();
  if (await queueControl.evaluate((element) => element.tagName.toLowerCase()) === "select") await selectFirstValue(queueControl);
  await fillControl(page, /priority/i, priority);
  const time = page.getByLabel(/not before|schedule/i).first();
  if (await time.count()) await time.fill(notBefore ?? new Date(Date.now() - 1_000).toISOString());
  await fillControl(page, /input|payload/i, JSON.stringify(input ?? { value: "visible-run" }));
  await (await visibleButton(page, /enqueue|create run|submit/i)).click();
  await page.getByText(/queued/i).first().waitFor({ state: "visible" });
}

async function createVisibleWorkflow(page, nodes) {
  await navigate(page, /new workflow|create workflow/i);
  const graphField = page.getByLabel(/nodes|graph|workflow definition/i).first();
  if (await graphField.count()) {
    await graphField.fill(JSON.stringify({ nodes }));
  } else {
    for (const [index, node] of nodes.entries()) {
      if (index > 0) await (await visibleButton(page, /add node/i)).click();
      const nodeSections = page.getByRole("group", { name: /node/i });
      const section = nodeSections.nth(index);
      await section.getByLabel(/node key|key/i).fill(node.nodeKey);
      const definition = section.getByLabel(/job definition/i);
      if (await definition.evaluate((element) => element.tagName.toLowerCase()) === "select") await selectFirstValue(definition);
      const queueControl = section.getByLabel(/^queue|execution queue/i);
      if (await queueControl.evaluate((element) => element.tagName.toLowerCase()) === "select") await selectFirstValue(queueControl);
      await section.getByLabel(/priority/i).fill(String(node.priority));
      await section.getByLabel(/input|payload/i).fill(JSON.stringify(node.input));
      const dependencies = section.getByLabel(/depends on|dependencies/i);
      if (await dependencies.count()) await dependencies.fill(node.dependsOn.join(","));
    }
  }
  await (await visibleButton(page, /create workflow|submit workflow/i)).click();
  await page.getByText(/queued/i).first().waitFor({ state: "visible" });
}

const D01 = {
  id: "D-01",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "wire", { capacity: 10 });
      const definition = jobDefinition(ctx.fixtures, "wire");
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "wire", { queues: [targetQueue], jobDefinitions: [definition] }));
      const openApiResponse = await ctx.request(api.baseUrl, "/openapi.json");
      const openapi = requireStatus(openApiResponse, 200, "OpenAPI");
      assert.match(openapi.openapi, /^3\.1(?:\.|$)/u);
      const requiredOperations = [
        ["/api/v1/runs", "post"], ["/api/v1/runs", "get"], ["/api/v1/runs/{runId}", "get"],
        ["/api/v1/runs/{runId}/cancel", "post"], ["/api/v1/runs/{runId}/attempt-result", "post"],
        ["/api/v1/workers/{workerId}/claim", "post"], ["/api/v1/workflow-runs", "post"],
        ["/api/v1/workflow-runs/{workflowRunId}", "get"], ["/api/v1/workflow-runs/{workflowRunId}/cancel", "post"],
        ["/api/v1/workflow-runs/{workflowRunId}/nodes/{nodeKey}/retry", "post"],
        ["/api/v1/verification-snapshot", "get"], ["/api/v1/domain-events", "get"],
      ];
      for (const [path, method] of requiredOperations) assert.ok(openapi.paths?.[path]?.[method], `OpenAPI misses ${method.toUpperCase()} ${path}`);
      for (const name of ["Run", "Attempt", "ExecutionLease", "WorkerClaimResponse", "WorkflowNode", "WorkflowRun"]) {
        assert.ok(openapi.components?.schemas?.[name], `OpenAPI misses ${name}`);
        assert.equal(openapi.components.schemas[name].additionalProperties, false, `${name} must be closed`);
      }

      const malformed = await ctx.request(api.baseUrl, "/api/v1/runs", {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("malformed") }, raw: "{not-json",
      });
      assertExactError(malformed, 400, "MALFORMED_JSON");
      const media = await ctx.request(api.baseUrl, "/api/v1/runs", {
        method: "POST", headers: { "content-type": "text/plain", "idempotency-key": ctx.key("media") }, raw: "{}",
      });
      assertExactError(media, 415, "UNSUPPORTED_MEDIA_TYPE");
      const unknown = await ctx.mutate(api.baseUrl, "/api/v1/runs", ctx.key("unknown-field"), {
        jobDefinitionId: definition.jobDefinitionId, jobVersion: 1, queueId: targetQueue.queueId,
        priority: 0, notBefore: new Date(Date.now() - 1_000).toISOString(), input: {}, surprise: true,
      });
      assertExactError(unknown, 400, "UNKNOWN_FIELD");
      assertExactError(await ctx.request(api.baseUrl, "/api/v1/runs?cursor=not-an-opaque-cursor"), 400, "INVALID_CURSOR");
      assertExactError(await ctx.request(api.baseUrl, `/api/v1/runs/${ctx.uuid("missing-run")}`), 404, "NOT_FOUND");
      assertExactError(await ctx.request(api.baseUrl, "/api/v1/verification-snapshot"), 401, "ADMIN_AUTH_REQUIRED");
      assertExactError(await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { headers: { authorization: "Bearer wrong" } }), 401, "ADMIN_AUTH_REQUIRED");

      const created = [];
      for (let index = 0; index < 3; index += 1) created.push((await enqueue(ctx, api, `page-${index}`, definition, targetQueue)).run);
      const firstPage = requireStatus(await ctx.request(api.baseUrl, "/api/v1/runs?limit=1"), 200, "first Run page");
      assert.deepEqual(Object.keys(firstPage).sort(), ["items", "nextCursor"]);
      assert.equal(firstPage.items.length, 1);
      assert.equal(typeof firstPage.nextCursor, "string");
      assertRun(firstPage.items[0]);
      const repeatedPage = requireStatus(await ctx.request(api.baseUrl, "/api/v1/runs?limit=1"), 200, "stable first page");
      assert.deepEqual(repeatedPage, firstPage);
      const secondPage = requireStatus(await ctx.request(api.baseUrl, `/api/v1/runs?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`), 200, "second Run page");
      assert.notEqual(secondPage.items[0].runId, firstPage.items[0].runId);
      const workflow = (await createWorkflow(ctx, api, "wire", [workflowNode("only", definition, targetQueue)])).workflow;
      assert.deepEqual(await getWorkflow(ctx, api, workflow.workflowRunId), workflow);
      const beforeReads = await ctx.snapshot(api.baseUrl);
      await Promise.all(created.map(({ runId }) => getRun(ctx, api, runId)));
      await getWorkflow(ctx, api, workflow.workflowRunId);
      const afterReads = await ctx.snapshot(api.baseUrl);
      assert.deepEqual(stableSnapshot(afterReads), stableSnapshot(beforeReads));
      return result({ openApiVersion: openapi.openapi, firstPage, secondPageRunId: secondPage.items[0].runId, workflowRunId: workflow.workflowRunId });
    });
  },
};

const D02 = {
  id: "D-02",
  async run(ctx) {
    const targetQueue = queue(ctx.fixtures, "browser-run", { capacity: 2 });
    const definition = jobDefinition(ctx.fixtures, "browser-run");
    const { api } = await prepare(ctx, seedOf(ctx.fixtures, "browser-run", { queues: [targetQueue], jobDefinitions: [definition] }));
    const page = await launchBrowser(ctx, api);
    await page.getByRole("heading", { name: /queueforge/i }).first().waitFor({ state: "visible" });
    const before = await ctx.snapshot(api.baseUrl);
    await enqueueVisibleRun(page, { input: { value: "browser-success" } });
    const afterEnqueue = await ctx.snapshot(api.baseUrl);
    const successfulRun = afterEnqueue.resources.runs.find(({ input }) => input?.value === "browser-success");
    assert.ok(successfulRun, "visible enqueue did not persist a Run");
    const worker = await ctx.startWorker();
    await ctx.waitFor(async () => (await getRun(ctx, api, successfulRun.runId)).state === "SUCCEEDED", { label: "browser Run success", processes: [worker] });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText(successfulRun.runId, { exact: false }).first().waitFor({ state: "visible" });
    await page.getByText(/succeeded/i).first().waitFor({ state: "visible" });
    await navigate(page, /runs/i);
    await page.getByText(successfulRun.runId, { exact: false }).first().click();
    await page.getByText(/attempt/i).first().waitFor({ state: "visible" });
    await page.getByText(/run\.started|started/i).first().waitFor({ state: "visible" });

    await enqueueVisibleRun(page, { input: { value: "browser-cancel" }, notBefore: new Date(Date.now() + 3_600_000).toISOString() });
    const queuedSnapshot = await ctx.snapshot(api.baseUrl);
    const cancelledRun = queuedSnapshot.resources.runs.find(({ input }) => input?.value === "browser-cancel");
    assert.ok(cancelledRun);
    await navigate(page, /runs/i);
    await page.getByText(cancelledRun.runId, { exact: false }).first().click();
    await (await visibleButton(page, /cancel run|cancel/i)).click();
    const reason = page.getByLabel(/reason/i).first();
    if (await reason.count()) await reason.fill("visible cancellation");
    const confirm = page.getByRole("button", { name: /confirm|cancel run/i }).last();
    if (await confirm.count()) await confirm.click();
    await page.getByText(/cancelled/i).first().waitFor({ state: "visible" });
    assert.equal((await getRun(ctx, api, cancelledRun.runId)).state, "CANCELLED");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "networkidle" });
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement !== document.body), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
    return result({ createdSinceStart: (await ctx.snapshot(api.baseUrl)).resources.runs.length - before.resources.runs.length, successfulRunId: successfulRun.runId, cancelledRunId: cancelledRun.runId });
  },
};

const D03 = {
  id: "D-03",
  async run(ctx) {
    return guarded(["QUEUE_DAG_OR_ATOMICITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "browser-workflow", { capacity: 10 });
      const definition = jobDefinition(ctx.fixtures, "browser-workflow", { maxAttempts: 3 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "browser-workflow", { queues: [targetQueue], jobDefinitions: [definition] }));
      const page = await launchBrowser(ctx, api);
      const nodes = [
        workflowNode("A", definition, targetQueue), workflowNode("B", definition, targetQueue, ["A"]),
        workflowNode("C", definition, targetQueue, ["A"]), workflowNode("D", definition, targetQueue, ["B", "C"]),
      ];
      const before = await ctx.snapshot(api.baseUrl);
      await createVisibleWorkflow(page, nodes);
      const after = await ctx.snapshot(api.baseUrl);
      const workflow = after.resources.workflowRuns.find(({ workflowRunId }) => !before.resources.workflowRuns.some((item) => item.workflowRunId === workflowRunId));
      assert.ok(workflow, "visible Workflow creation did not persist a WorkflowRun");
      let items = await claim(ctx, api, "browser-workflow-worker", [targetQueue.queueId], 10, "browser-root");
      assert.deepEqual(items.map(({ run }) => run.nodeKey), ["A"]);
      await finishClaim(ctx, api, items[0], "browser-A");
      items = await claim(ctx, api, "browser-workflow-worker", [targetQueue.queueId], 10, "browser-branches");
      await finishClaim(ctx, api, items.find(({ run }) => run.nodeKey === "B"), "browser-B-failure", { outcome: "PERMANENT_FAILURE", errorCode: "VISIBLE_FAILURE" });
      await finishClaim(ctx, api, items.find(({ run }) => run.nodeKey === "C"), "browser-C-success");
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText(workflow.workflowRunId, { exact: false }).first().click();
      await page.getByText(/blocked/i).first().waitFor({ state: "visible" });
      const bRow = page.getByRole("row").filter({ hasText: /\bB\b/ }).first();
      const retry = bRow.getByRole("button", { name: /retry/i });
      await retry.waitFor({ state: "visible" });
      await retry.click();
      items = await claim(ctx, api, "browser-workflow-worker", [targetQueue.queueId], 10, "browser-B-retry");
      assert.deepEqual(items.map(({ run }) => run.nodeKey), ["B"]);
      await finishClaim(ctx, api, items[0], "browser-B-success");
      items = await claim(ctx, api, "browser-workflow-worker", [targetQueue.queueId], 10, "browser-D");
      assert.deepEqual(items.map(({ run }) => run.nodeKey), ["D"]);
      await finishClaim(ctx, api, items[0], "browser-D-success");
      assert.equal((await getWorkflow(ctx, api, workflow.workflowRunId)).state, "SUCCEEDED");
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText(/succeeded/i).first().waitFor({ state: "visible" });

      await createVisibleWorkflow(page, [workflowNode("cancel-me", definition, targetQueue)]);
      const latest = (await ctx.snapshot(api.baseUrl)).resources.workflowRuns.find(({ workflowRunId }) => workflowRunId !== workflow.workflowRunId);
      await page.getByText(latest.workflowRunId, { exact: false }).first().click();
      await (await visibleButton(page, /cancel workflow|cancel/i)).click();
      const reason = page.getByLabel(/reason/i).first();
      if (await reason.count()) await reason.fill("visible workflow cancellation");
      const confirm = page.getByRole("button", { name: /confirm|cancel workflow/i }).last();
      if (await confirm.count()) await confirm.click();
      await page.getByText(/cancelled/i).first().waitFor({ state: "visible" });
      assert.equal((await getWorkflow(ctx, api, latest.workflowRunId)).state, "CANCELLED");
      return result({ workflowRunId: workflow.workflowRunId, cancelledWorkflowRunId: latest.workflowRunId, observedStates: ["FAILED", "BLOCKED", "SUCCEEDED", "CANCELLED"] });
    });
  },
};

const D04 = {
  id: "D-04",
  async run(ctx) {
    return guarded(["EVENT_ATOMICITY_OR_IDENTITY", "RECOVERY_OR_FENCING", "QUEUE_DAG_OR_ATOMICITY"], async () => {
      const targetQueue = queue(ctx.fixtures, "snapshot", { capacity: 10 });
      const definition = jobDefinition(ctx.fixtures, "snapshot", { maxAttempts: 3 });
      const { api } = await prepare(ctx, seedOf(ctx.fixtures, "snapshot", { queues: [targetQueue], jobDefinitions: [definition] }));
      const queued = await enqueue(ctx, api, "snapshot-queued", definition, targetQueue, { notBefore: new Date(Date.now() + 3_600_000).toISOString() });
      const running = await enqueue(ctx, api, "snapshot-running", definition, targetQueue);
      const succeeded = await enqueue(ctx, api, "snapshot-succeeded", definition, targetQueue);
      const cancelled = await enqueue(ctx, api, "snapshot-cancelled", definition, targetQueue, { notBefore: new Date(Date.now() + 3_600_000).toISOString() });
      const leases = await claim(ctx, api, "snapshot-worker", [targetQueue.queueId], 2, "snapshot-claim");
      const successfulLease = leases.find(({ run }) => run.runId === succeeded.run.runId);
      const runningLease = leases.find(({ run }) => run.runId === running.run.runId);
      assert.ok(successfulLease && runningLease);
      await finishClaim(ctx, api, successfulLease, "snapshot-success");
      requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/runs/${cancelled.run.runId}/cancel`, ctx.key("snapshot-cancel"), { reason: "snapshot state" }), 200, "snapshot cancellation");
      const workflow = (await createWorkflow(ctx, api, "snapshot-workflow", [
        workflowNode("failed", definition, targetQueue), workflowNode("blocked", definition, targetQueue, ["failed"]),
      ])).workflow;
      const workflowLease = (await claim(ctx, api, "snapshot-worker", [targetQueue.queueId], 1, "snapshot-workflow-claim"))[0];
      assert.equal(workflowLease.run.nodeKey, "failed");
      await finishClaim(ctx, api, workflowLease, "snapshot-workflow-failure", { outcome: "PERMANENT_FAILURE", errorCode: "SNAPSHOT_FAILURE" });
      const snapshot = await ctx.snapshot(api.baseUrl);
      assertFinalSnapshot(snapshot);
      assertSnapshotClosure(snapshot);
      const selected = new Map(snapshot.resources.runs.filter(({ input }) => String(input?.value ?? "").startsWith("snapshot-")).map((item) => [item.input.value, item.state]));
      assert.deepEqual(selected, new Map([
        ["snapshot-queued", "QUEUED"], ["snapshot-running", "RUNNING"],
        ["snapshot-succeeded", "SUCCEEDED"], ["snapshot-cancelled", "CANCELLED"],
      ]));
      const workflowState = snapshot.resources.workflowRuns.find(({ workflowRunId }) => workflowRunId === workflow.workflowRunId);
      assert.equal(workflowState.state, "FAILED");
      assert.deepEqual(workflowState.nodes.map(({ state }) => state).sort(), ["BLOCKED", "FAILED"]);
      assert.equal(snapshot.resources.executionLeases.some(({ runId }) => runId === running.run.runId), true);
      assert.equal(JSON.stringify(snapshot).includes(runningLease.executionLease.leaseToken), false);
      assert.ok(snapshot.work.some(({ aggregateId, state, terminal }) => aggregateId === succeeded.run.runId && state === "SUCCEEDED" && terminal));
      assert.ok(snapshot.work.some(({ aggregateId, state, terminal }) => aggregateId === queued.run.runId && state === "PENDING" && !terminal));
      const asOf = Date.parse(snapshot.asOf);
      for (const item of snapshot.resources.runs) assert.ok(Date.parse(item.createdAt) <= asOf);
      return result({ asOf: snapshot.asOf, counts: Object.fromEntries(Object.entries(snapshot.resources).map(([key, values]) => [key, values.length])), workCount: snapshot.work.length, eventCount: snapshot.events.length });
    });
  },
};

export const D_CASES = Object.freeze([D01, D02, D03, D04]);
