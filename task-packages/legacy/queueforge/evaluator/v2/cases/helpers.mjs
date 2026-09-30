import assert from "node:assert/strict";

import { canonical, compareClaimOrder, operationResult, outputDigest } from "../lib/oracle.mjs";
import { emptySeed } from "../lib/fixtures.mjs";

export const QUEUE_KEYS = ["capacity", "name", "queueId"];
export const JOB_DEFINITION_KEYS = ["createdAt", "jobDefinitionId", "maxAttempts", "operation", "timeoutSeconds", "version"];
export const RUN_KEYS = [
  "attemptCount", "createdAt", "errorCode", "input", "jobDefinitionId", "jobVersion", "nodeKey",
  "notBefore", "output", "priority", "queueId", "runId", "sequence", "startedAt", "state",
  "terminalAt", "workflowRunId",
];
export const ATTEMPT_KEYS = ["attempt", "finishedAt", "outcome", "outputDigest", "runId", "startedAt", "workerId"];
export const LEASE_KEYS = ["attempt", "expiresAt", "leasedAt", "leaseToken", "runId", "workerId"];
export const SNAPSHOT_LEASE_KEYS = ["attempt", "expiresAt", "leasedAt", "runId", "workerId"];
export const WORKFLOW_NODE_KEYS = ["dependsOn", "nodeKey", "runId", "state"];
export const WORKFLOW_KEYS = ["createdAt", "nodes", "sequence", "state", "terminalAt", "workflowRunId"];
export const WORK_KEYS = ["aggregateId", "attempt", "kind", "leaseExpiresAt", "leaseOwner", "state", "terminal", "workId"];
export const EVENT_KEYS = ["aggregateId", "eventId", "occurredAt", "payload", "schemaVersion", "sequence", "type"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export function result(evidence, extra = {}) { return { evidence, ...extra }; }

export function guarded(hardCapIds, operation) {
  return Promise.resolve().then(operation).catch((error) => {
    error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
    throw error;
  });
}

export function requireStatus(response, expected, label = "request") {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `${label}: expected ${statuses.join("/")}, got ${response.status}: ${response.text}`);
  assert.notEqual(response.json, undefined, `${label}: response is not JSON`);
  return response.json;
}

export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has wrong keys`);
}

export function assertExactError(response, status, code) {
  requireStatus(response, status, code);
  exactKeys(response.json, ["error"], "error response");
  exactKeys(response.json.error, ["code", "details", "message"], "error");
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details));
}

export function assertRun(value, { final = true } = {}) {
  const expected = final ? RUN_KEYS : RUN_KEYS.filter((key) => key !== "workflowRunId" && key !== "nodeKey");
  exactKeys(value, expected, "Run");
  assert.match(value.runId, UUID);
  assert.match(value.jobDefinitionId, UUID);
  assert.match(value.queueId, UUID);
  assert.match(value.notBefore, TIMESTAMP);
  assert.match(value.createdAt, TIMESTAMP);
  if (value.startedAt !== null) assert.match(value.startedAt, TIMESTAMP);
  if (value.terminalAt !== null) assert.match(value.terminalAt, TIMESTAMP);
  assert.ok(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(value.state));
  assert.ok(Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0);
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
  if (final) {
    assert.equal(value.workflowRunId === null, value.nodeKey === null);
    if (value.workflowRunId !== null) assert.match(value.workflowRunId, UUID);
  }
  return value;
}

export function assertWorkflow(value) {
  exactKeys(value, WORKFLOW_KEYS, "WorkflowRun");
  assert.match(value.workflowRunId, UUID);
  assert.match(value.createdAt, TIMESTAMP);
  if (value.terminalAt !== null) assert.match(value.terminalAt, TIMESTAMP);
  assert.ok(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state));
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
  assert.ok(Array.isArray(value.nodes) && value.nodes.length >= 1 && value.nodes.length <= 50);
  for (const node of value.nodes) {
    exactKeys(node, WORKFLOW_NODE_KEYS, "WorkflowNode");
    assert.match(node.runId, UUID);
    assert.ok(Array.isArray(node.dependsOn));
  }
  assert.deepEqual(value.nodes.map(({ nodeKey }) => nodeKey), [...value.nodes].map(({ nodeKey }) => nodeKey).sort(bytewise));
  return value;
}

export function seedOf(fixtures, label, members = {}) {
  return { ...emptySeed(fixtures, label), ...members, seedVersion: fixtures.seedVersion(label) };
}

export async function prepare(ctx, seed, { build = true, workers = 0, apis = 1, dispatcherUrl } = {}) {
  if (build) {
    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
  }
  await ctx.migrate();
  if (seed) {
    const imported = await ctx.seed(seed, { timeoutMs: 600_000 });
    assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  }
  const apiProcesses = [];
  for (let index = 0; index < apis; index += 1) apiProcesses.push(await ctx.startApi());
  const workerProcesses = [];
  for (let index = 0; index < workers; index += 1) workerProcesses.push(await ctx.startWorker());
  const dispatcher = dispatcherUrl ? await ctx.startDispatcher({ webhookUrl: dispatcherUrl }) : undefined;
  return { api: apiProcesses[0], apis: apiProcesses, workers: workerProcesses, dispatcher };
}

export async function createDefinition(ctx, api, label, overrides = {}) {
  const request = { operation: "ECHO", maxAttempts: 3, timeoutSeconds: 30, ...overrides };
  const response = await ctx.mutate(api.baseUrl, "/api/v1/job-definitions", ctx.key(`${label}-definition`), request);
  const definition = requireStatus(response, 201, `${label} definition`);
  exactKeys(definition, JOB_DEFINITION_KEYS, "JobDefinition");
  return definition;
}

export async function enqueue(ctx, api, label, definition, targetQueue, overrides = {}, options = {}) {
  const request = {
    jobDefinitionId: definition.jobDefinitionId, jobVersion: definition.version, queueId: targetQueue.queueId,
    priority: 0, notBefore: new Date(Date.now() - 2_000).toISOString(), input: { value: label }, ...overrides,
  };
  const response = await ctx.mutate(api.baseUrl, "/api/v1/runs", options.key ?? ctx.key(`${label}-enqueue`), request);
  const created = requireStatus(response, 202, `${label} enqueue`);
  assertRun(created);
  assert.equal(created.state, "QUEUED");
  assert.deepEqual(created.input, request.input);
  return { run: created, request, response };
}

export async function claim(ctx, api, workerId, queueIds, maxRuns = 20, keyLabel = workerId) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/workers/${encodeURIComponent(workerId)}/claim`, ctx.key(`claim-${keyLabel}`), { queueIds, maxRuns });
  const body = requireStatus(response, 200, `claim ${workerId}`);
  exactKeys(body, ["items"], "WorkerClaimResponse");
  assert.ok(Array.isArray(body.items));
  assert.ok(body.items.length <= maxRuns);
  for (const item of body.items) {
    exactKeys(item, ["executionLease", "run"], "claim item");
    assertRun(item.run);
    exactKeys(item.executionLease, LEASE_KEYS, "ExecutionLease");
    assert.match(item.executionLease.leaseToken, /\S/u);
    assert.equal(item.run.runId, item.executionLease.runId);
    assert.equal(item.run.attemptCount, item.executionLease.attempt);
    assert.equal(item.run.state, "RUNNING");
  }
  assert.deepEqual(body.items.map(({ run }) => run.runId), body.items.map(({ run }) => run).toSorted(compareClaimOrder).map(({ runId }) => runId));
  return body.items;
}

export async function finishClaim(ctx, api, item, label, { outcome = "SUCCEEDED", output, errorCode } = {}) {
  const operationOutput = output ?? (outcome === "SUCCEEDED" ? item.run.input : null);
  const request = {
    attempt: item.executionLease.attempt,
    leaseToken: item.executionLease.leaseToken,
    outcome,
    output: operationOutput,
    errorCode: outcome === "SUCCEEDED" ? null : (errorCode ?? "QF_TEST_FAILURE"),
  };
  const response = await ctx.mutate(api.baseUrl, `/api/v1/runs/${item.run.runId}/attempt-result`, ctx.key(`result-${label}`), request);
  const body = requireStatus(response, 200, `${label} attempt result`);
  exactKeys(body, ["attempt", "run"], "AttemptResult");
  assertRun(body.run);
  exactKeys(body.attempt, ATTEMPT_KEYS, "Attempt");
  assert.equal(body.attempt.runId, item.run.runId);
  assert.equal(body.attempt.attempt, item.executionLease.attempt);
  if (outcome === "SUCCEEDED") {
    assert.equal(body.run.state, "SUCCEEDED");
    assert.deepEqual(body.run.output, operationOutput);
    assert.equal(body.attempt.outputDigest, outputDigest(operationOutput));
  } else {
    assert.equal(body.run.output, null);
    assert.equal(body.attempt.outputDigest, null);
  }
  return body;
}

export async function executeClaims(ctx, api, queueIds, expectedByRun = new Map(), options = {}) {
  const completed = [];
  let ordinal = 0;
  while (true) {
    const items = await claim(ctx, api, options.workerId ?? "harness-worker", queueIds, options.maxRuns ?? 20, `${options.keyPrefix ?? "drain"}-${ordinal}`);
    if (items.length === 0) break;
    for (const item of items) {
      const output = expectedByRun.get(item.run.runId) ?? item.run.input;
      completed.push(await finishClaim(ctx, api, item, `${options.keyPrefix ?? "drain"}-${ordinal += 1}`, { output }));
    }
  }
  return completed;
}

export async function createWorkflow(ctx, api, label, nodes, key = ctx.key(`${label}-workflow`)) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/workflow-runs", key, { nodes });
  const workflow = requireStatus(response, 200, `${label} workflow`);
  assertWorkflow(workflow);
  return { workflow, response };
}

export async function getWorkflow(ctx, api, workflowRunId) {
  const response = await ctx.request(api.baseUrl, `/api/v1/workflow-runs/${workflowRunId}`);
  return assertWorkflow(requireStatus(response, 200, "workflow read"));
}

export async function getRun(ctx, api, runId) {
  const response = await ctx.request(api.baseUrl, `/api/v1/runs/${runId}`);
  return assertRun(requireStatus(response, 200, "run read"));
}

export async function waitForRun(ctx, api, runId, states = ["SUCCEEDED", "FAILED", "CANCELLED"], options = {}) {
  return ctx.waitFor(async () => {
    const run = await getRun(ctx, api, runId);
    return states.includes(run.state) ? run : undefined;
  }, { timeoutMs: options.timeoutMs ?? 30_000, label: `${runId} terminal`, processes: options.processes });
}

export async function waitForWorkflow(ctx, api, workflowRunId, states = ["SUCCEEDED", "FAILED", "CANCELLED"], options = {}) {
  return ctx.waitFor(async () => {
    const workflow = await getWorkflow(ctx, api, workflowRunId);
    return states.includes(workflow.state) ? workflow : undefined;
  }, { timeoutMs: options.timeoutMs ?? 60_000, label: `${workflowRunId} terminal`, processes: options.processes });
}

export function eventFor(snapshot, aggregateId, type) {
  return snapshot.events.filter((event) => event.aggregateId === aggregateId && event.type === type);
}

export function stableSnapshot(value) {
  const { asOf: _asOf, ...stable } = value;
  return stable;
}

export function assertNoPrivateFields(value, path = "snapshot") {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoPrivateFields(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(key, /Token$/u, `${path}.${key} exposes a token`);
    assert.doesNotMatch(key, /^(?:idempotencyKey|rawWebhook|privatePath|secret)$/iu, `${path}.${key} exposes private data`);
    assertNoPrivateFields(entry, `${path}.${key}`);
  }
}

function bytewise(left, right) { return Buffer.from(left).compare(Buffer.from(right)); }

export function assertFinalSnapshot(snapshot) {
  exactKeys(snapshot, ["asOf", "events", "resources", "work"], "snapshot");
  exactKeys(snapshot.resources, ["attempts", "executionLeases", "jobDefinitions", "queues", "runs", "workflowRuns"], "snapshot resources");
  assert.match(snapshot.asOf, TIMESTAMP);
  assertNoPrivateFields(snapshot);
  for (const item of snapshot.resources.queues) exactKeys(item, QUEUE_KEYS, "Queue");
  for (const item of snapshot.resources.jobDefinitions) exactKeys(item, JOB_DEFINITION_KEYS, "JobDefinition");
  for (const item of snapshot.resources.runs) assertRun(item);
  for (const item of snapshot.resources.attempts) {
    exactKeys(item, ATTEMPT_KEYS, "Attempt");
    if (item.outputDigest !== null) assert.match(item.outputDigest, SHA256);
  }
  for (const item of snapshot.resources.executionLeases) exactKeys(item, SNAPSHOT_LEASE_KEYS, "redacted ExecutionLease");
  for (const item of snapshot.resources.workflowRuns) assertWorkflow(item);
  for (const item of snapshot.work) {
    exactKeys(item, WORK_KEYS, "Work");
    assert.equal(item.kind, "RUN_EXECUTION");
    assert.equal(item.terminal, TERMINAL.has(item.state));
    assert.equal(item.leaseOwner !== null, item.state === "LEASED");
    assert.equal(item.leaseExpiresAt !== null, item.state === "LEASED");
  }
  for (const item of snapshot.events) {
    exactKeys(item, EVENT_KEYS, "DomainEvent");
    assert.equal(item.schemaVersion, 1);
    assert.deepEqual(item.payload, {});
    assert.ok(["run.queued", "run.started", "run.retry-scheduled", "run.succeeded", "run.failed", "run.cancelled"].includes(item.type));
  }
  return snapshot;
}

export function assertSnapshotClosure(snapshot) {
  assertFinalSnapshot(snapshot);
  const { queues, jobDefinitions, runs, attempts, executionLeases, workflowRuns } = snapshot.resources;
  assert.deepEqual(queues, queues.toSorted((a, b) => bytewise(a.queueId, b.queueId)));
  assert.deepEqual(jobDefinitions, jobDefinitions.toSorted((a, b) => bytewise(a.jobDefinitionId, b.jobDefinitionId) || a.version - b.version));
  assert.deepEqual(runs, runs.toSorted((a, b) => bytewise(a.runId, b.runId)));
  assert.deepEqual(attempts, attempts.toSorted((a, b) => bytewise(a.runId, b.runId) || a.attempt - b.attempt));
  assert.deepEqual(executionLeases, executionLeases.toSorted((a, b) => bytewise(a.runId, b.runId) || a.attempt - b.attempt));
  assert.deepEqual(workflowRuns, workflowRuns.toSorted((a, b) => bytewise(a.workflowRunId, b.workflowRunId)));
  assert.deepEqual(snapshot.work, snapshot.work.toSorted((a, b) => bytewise(a.workId, b.workId)));
  assert.deepEqual(snapshot.events, snapshot.events.toSorted((a, b) => bytewise(a.aggregateId, b.aggregateId) || a.sequence - b.sequence || bytewise(a.eventId, b.eventId)));
  const runById = new Map(runs.map((item) => [item.runId, item]));
  const definitionPins = new Set(jobDefinitions.map((item) => `${item.jobDefinitionId}\0${item.version}`));
  const attemptsByRun = Map.groupBy(attempts, ({ runId }) => runId);
  const workCountByRun = new Map();
  for (const item of snapshot.work) workCountByRun.set(item.aggregateId, (workCountByRun.get(item.aggregateId) ?? 0) + 1);
  for (const item of runs) assert.ok(definitionPins.has(`${item.jobDefinitionId}\0${item.jobVersion}`), "Run references a missing JobDefinition version");
  for (const item of attempts) assert.ok(runById.has(item.runId), "Attempt references a missing Run");
  for (const item of executionLeases) {
    assert.equal(runById.get(item.runId)?.state, "RUNNING");
    assert.ok((attemptsByRun.get(item.runId) ?? []).some((attempt) => attempt.attempt === item.attempt));
  }
  for (const workflow of workflowRuns) for (const node of workflow.nodes) {
    const member = runById.get(node.runId);
    assert.equal(member?.workflowRunId, workflow.workflowRunId);
    assert.equal(member?.nodeKey, node.nodeKey);
    assert.equal(member?.state, node.state);
  }
  for (const run of runs) {
    const ownAttempts = attemptsByRun.get(run.runId) ?? [];
    assert.equal(ownAttempts.length === 0, run.attemptCount === 0);
    const numbers = ownAttempts.map(({ attempt }) => attempt).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: run.attemptCount }, (_, index) => index + 1));
    assert.equal(workCountByRun.get(run.runId), 1);
  }
  const eventsByRun = Map.groupBy(snapshot.events, ({ aggregateId }) => aggregateId);
  for (const events of eventsByRun.values()) assert.deepEqual(events.map(({ sequence }) => sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  return true;
}

export function expectedOutput(definition, input) { return operationResult(definition.operation, input); }

export async function launchBrowser(ctx, api, options = {}) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium" });
  ctx.defer(() => browser.close());
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 1280, height: 800 } });
  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  return page;
}

export async function visibleField(page, pattern) {
  const field = page.getByLabel(pattern).first();
  await field.waitFor({ state: "visible" });
  return field;
}

export async function visibleButton(page, pattern) {
  const button = page.getByRole("button", { name: pattern }).first();
  await button.waitFor({ state: "visible" });
  return button;
}

export function canonicalBody(value) { return canonical(value); }
