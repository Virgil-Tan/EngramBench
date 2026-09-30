import assert from "node:assert/strict";

import { assertPerformanceScenarioIds } from "./performance-runtime.mjs";

export function standardAdapter(spec) {
  assert.equal(typeof spec.performance, "function", `${spec.label ?? "standard adapter"}.performance must be a function`);
  const performanceScenarioIds = assertPerformanceScenarioIds(
    spec.performanceScenarioIds,
    `${spec.label ?? "standard adapter"}.performanceScenarioIds`,
  );
  return {
    performanceScenarioIds,
    taskSpecificCaseIds: [...new Set([
      ...Object.keys(spec.cases ?? {}),
      spec.verify && "H-03",
      spec.atomic && "H-04",
      spec.contention && "H-06",
      spec.migrationVerify && "H-09",
      spec.manager?.verify && "H-10",
      spec.manager?.concurrentVerify && "H-11",
      "H-12",
    ].filter(Boolean))].sort(),
    cases: {
      "H-03": (ctx, out) => mainFlow(ctx, out, spec),
      "H-04": (ctx, out) => atomicRejection(ctx, out, spec),
      "H-05": (ctx, out) => durableIdempotency(ctx, out, spec),
      "H-06": (ctx, out) => contention(ctx, out, spec),
      "H-07": (ctx, out) => workerRecovery(ctx, out, spec),
      "H-08": (ctx, out) => outboxRecovery(ctx, out, spec),
      "H-09": (ctx, out) => migration(ctx, out, spec),
      "H-10": (ctx, out) => managerBehavior(ctx, out, spec),
      "H-11": (ctx, out) => managerContention(ctx, out, spec),
      "H-12": spec.performance,
      ...spec.cases,
    },
  };
}

async function prepared(ctx, spec, workspace = ctx.workspace) {
  await ctx.prepare(workspace);
  const receiver = await ctx.receiver();
  const imported = await ctx.seed(await spec.seed(ctx, receiver.url), workspace);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const api = await ctx.startApi(workspace);
  await spec.afterPrepare?.(ctx, api, receiver, workspace);
  return { api, receiver };
}

function pathOf(spec) {
  return typeof spec.path === "function" ? spec.path() : spec.path;
}

async function mutate(ctx, baseUrl, spec, key, payload = spec.payload(0)) {
  const path = pathOf(spec);
  const response = await ctx.mutate(baseUrl, path, key, payload, spec.method ?? "POST");
  assert.ok((spec.statuses ?? [200, 201, 202]).includes(response.status), `${path}: ${response.status} ${response.text}`);
  return response;
}

function stable(snapshot) {
  const { asOf: _asOf, ...value } = snapshot;
  return value;
}

function count(snapshot, resource) {
  const values = snapshot.resources?.[resource];
  assert.ok(Array.isArray(values), `snapshot is missing ${resource}`);
  return values.length;
}

function responseIdentity(spec, response) {
  const value = spec.identity(response.json);
  assert.equal(typeof value, "string", "successful response has no stable identity");
  return value;
}

async function mainFlow(ctx, out, spec) {
  const { api } = await prepared(ctx, spec);
  const before = await ctx.snapshot(api.baseUrl);
  const response = await mutate(ctx, api.baseUrl, spec, "h03-main");
  const identity = responseIdentity(spec, response);
  const workIdentity = spec.workIdentity?.(response.json) ?? identity;
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(count(after, spec.resource), count(before, spec.resource) + 1);
  assert.ok(after.events.length > before.events.length, "successful mutation emitted no Domain Event");
  assert.ok(after.work.some(({ aggregateId }) => aggregateId === workIdentity) || spec.noWork === true, "successful mutation scheduled no durable work");
  await spec.verify?.(ctx, api.baseUrl, response, after);
  out.push(`${spec.label} succeeds through the public API and agrees with snapshot, work, and events`);
}

async function atomicRejection(ctx, out, spec) {
  const { api } = await prepared(ctx, spec);
  await mutate(ctx, api.baseUrl, spec, "h04-base");
  const before = await ctx.snapshot(api.baseUrl);
  const rejected = await ctx.mutate(api.baseUrl, pathOf(spec), "h04-base", spec.conflictPayload(0), spec.method ?? "POST");
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal(rejected.json?.error?.code, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(before));
  const malformed = await ctx.request(api.baseUrl, pathOf(spec), {
    method: spec.method ?? "POST",
    headers: { "content-type": "application/json", "idempotency-key": "h04-malformed" },
    raw: "{",
  });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.json?.error?.code, "MALFORMED_JSON");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(before));
  await spec.atomic?.(ctx, api.baseUrl, before);
  out.push(`${spec.label} rejects semantic replay conflicts and malformed JSON without partial state`);
}

async function durableIdempotency(ctx, out, spec) {
  const { api } = await prepared(ctx, spec);
  const initialCount = count(await ctx.snapshot(api.baseUrl), spec.resource);
  const shield = await ctx.responseShield(api.baseUrl);
  const payload = spec.payload(1);
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, pathOf(spec), "h05-key", payload, spec.method ?? "POST").catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label: "committed upstream response" });
  assert.ok((spec.statuses ?? [200, 201, 202]).includes(shield.captures[0].status));
  const replay = await ctx.mutate(api.baseUrl, pathOf(spec), "h05-key", payload, spec.method ?? "POST");
  assert.equal(ctx.canonical(replay.json), ctx.canonical(JSON.parse(shield.captures[0].body)));
  const concurrent = await ctx.concurrent(Array.from({ length: 20 }), 20, () => ctx.mutate(api.baseUrl, pathOf(spec), "h05-key", payload, spec.method ?? "POST"));
  assert.equal(new Set(concurrent.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
  await ctx.stop(api);
  const restarted = await ctx.startApi();
  const afterRestart = await ctx.mutate(restarted.baseUrl, pathOf(spec), "h05-key", payload, spec.method ?? "POST");
  assert.equal(ctx.canonical(afterRestart.json), ctx.canonical(replay.json));
  assert.equal(count(await ctx.snapshot(restarted.baseUrl), spec.resource), initialCount + 1);
  out.push(`${spec.label} survives unknown response, 20-way replay, and API restart with one effect`);
}

async function contention(ctx, out, spec) {
  const { api: apiA } = await prepared(ctx, spec);
  const initialCount = count(await ctx.snapshot(apiA.baseUrl), spec.resource);
  const apiB = await ctx.startApi();
  const payload = spec.payload(2);
  const results = await ctx.concurrent(Array.from({ length: 64 }), 64, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    pathOf(spec),
    "h06-shared",
    payload,
    spec.method ?? "POST",
  ));
  assert.equal(new Set(results.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
  assert.equal(count(await ctx.snapshot(apiB.baseUrl), spec.resource), initialCount + 1);
  await spec.contention?.(ctx, [apiA.baseUrl, apiB.baseUrl]);
  out.push(`${spec.label} converges across 64 requests and two API processes`);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function workerRecovery(ctx, out, spec) {
  const { api } = await prepared(ctx, spec);
  const response = await spec.prepareWork?.(ctx, api.baseUrl) ?? await mutate(ctx, api.baseUrl, spec, "h07-create", spec.payload(3));
  const aggregateId = spec.workIdentity?.(response.json) ?? responseIdentity(spec, response);
  const held = deferred();
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held.promise : { status: 204 });
  const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h07-token" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === aggregateId), {
    label: "worker.claimed barrier",
    children: [first],
  });
  await ctx.stop(first, "SIGKILL");
  held.resolve({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacement = await ctx.startWorker();
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const work = snapshot.work.filter((item) => item.aggregateId === aggregateId);
    return work.length > 0 && work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "replacement worker to drain aggregate", children: [replacement] });
  out.push(`${spec.label} reclaims a killed claimed lease and drains work with a replacement`);
}

async function outboxRecovery(ctx, out, spec) {
  const { api } = await prepared(ctx, spec);
  await mutate(ctx, api.baseUrl, spec, "h08-create", spec.payload(4));
  const webhook = await ctx.receiver();
  const held = deferred();
  const barrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? held.promise : { status: 204 });
  const first = await ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h08-token" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
    label: "dispatcher response barrier",
    children: [first],
  });
  await ctx.stop(first, "SIGKILL");
  held.resolve({ status: 204 });
  const replacement = await ctx.startDispatcher(webhook.url);
  await ctx.waitFor(() => webhook.ledger.length >= 2, { timeoutMs: 60_000, label: "outbox retry", children: [replacement] });
  const [one, two] = webhook.ledger;
  assert.equal(one.raw, two.raw);
  const eventHeader = Object.keys(one.headers).find((name) => name.endsWith("-event-id"));
  assert.ok(eventHeader, "dispatcher did not publish a domain event ID header");
  assert.equal(one.headers[eventHeader], two.headers[eventHeader]);
  out.push(`${spec.label} retries the same outbox identity and body after unknown webhook ACK`);
}

async function migration(ctx, out, spec) {
  const v1 = await ctx.copyV1Workspace();
  const { api: v1Api } = await prepared(ctx, spec, v1);
  const initialCount = count(await ctx.snapshot(v1Api.baseUrl), spec.resource);
  const payload = spec.payload(5);
  const created = await mutate(ctx, v1Api.baseUrl, spec, "h09-saved", payload);
  await ctx.stop(v1Api);
  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, pathOf(spec), "h09-saved", payload, spec.method ?? "POST");
  assert.equal(replay.status, created.status);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(created.json));
  const snapshot = await ctx.snapshot(finalApi.baseUrl);
  assert.equal(count(snapshot, spec.resource), initialCount + 1);
  assert.deepEqual(Object.keys(snapshot.resources).sort(), [...ctx.contract.snapshot.resources, ...ctx.contract.snapshot.managerResources].map(({ key }) => key).sort());
  await spec.migrationVerify?.(ctx, { created, replay, snapshot, initialCount });
  out.push(`${spec.label} populated V1 state and saved replay survive FINAL migration`);
}

async function managerBehavior(ctx, out, spec) {
  assert.ok(spec.manager, `${spec.label} has no Manager Harness scenario`);
  const { api } = await prepared(ctx, spec);
  const preparedOperation = await spec.manager.prepare?.(ctx, api.baseUrl);
  const operation = preparedOperation ? { ...spec.manager, ...preparedOperation } : spec.manager;
  const response = await ctx.mutate(api.baseUrl, operation.path, "h10-manager", operation.payload(0), operation.method ?? "POST");
  assert.ok((operation.statuses ?? [200, 201, 202]).includes(response.status), response.text);
  await operation.verify?.(ctx, api.baseUrl, response, operation);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.ok(ctx.contract.snapshot.managerResources.some(({ key }) => snapshot.resources[key].length > 0));
  out.push(`${spec.label} Manager mutation produces its published durable resource`);
}

async function managerContention(ctx, out, spec) {
  assert.ok(spec.manager, `${spec.label} has no Manager Harness scenario`);
  const { api } = await prepared(ctx, spec);
  const apiB = await ctx.startApi();
  const preparedOperation = await spec.manager.prepare?.(ctx, api.baseUrl);
  const operation = preparedOperation ? { ...spec.manager, ...preparedOperation } : spec.manager;
  const payload = operation.payload(1);
  const results = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => ctx.mutate(
    index % 2 ? api.baseUrl : apiB.baseUrl,
    operation.path,
    "h11-manager-shared",
    payload,
    operation.method ?? "POST",
  ));
  assert.equal(new Set(results.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
  await operation.concurrentVerify?.(ctx, [api.baseUrl, apiB.baseUrl], results[0], operation);
  const html = await ctx.request(api.baseUrl, "/");
  assert.equal(html.status, 200);
  assert.match(html.text, /<html|<!doctype/iu);
  out.push(`${spec.label} Manager replay converges across two APIs and the published production UI remains available`);
}
