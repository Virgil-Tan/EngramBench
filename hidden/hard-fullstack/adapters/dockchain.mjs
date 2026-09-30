import assert from "node:assert/strict";

import { measuredLoad, performanceScale } from "../performance-runtime.mjs";
import { standardAdapter } from "../standard-adapter.mjs";

const interval = {
  startAt: "2026-08-20T00:00:00.000Z",
  endAt: "2026-08-20T02:00:00.000Z",
};
const ids = {
  berth: uuid("c1000000", 0),
  tugPool: uuid("c2000000", 0),
  yardWindow: uuid("c3000000", 0),
  vessels: Array.from({ length: 40 }, (_, index) => uuid("c4000000", index)),
};

const spec = {
  label: "DockChain Port Call",
  performanceScenarioIds: ["feasible-window-read", "port-call-create", "clearance-recovery"],
  seed: async () => seed(),
  path: "/api/v1/port-calls",
  payload: (index) => legacyPayload(index),
  conflictPayload: (index) => ({ ...legacyPayload(index), requiredTugs: 2 }),
  resource: "portCalls",
  identity: (value) => portCallOf(value)?.portCallId,
  workIdentity: (value) => portCallOf(value)?.portCallId,
  resourceIdentity: ({ portCallId }) => portCallId,
  prepareWork,
  cases: {
    "H-03": mainFlow,
    "H-04": atomicRejection,
    "H-06": resourceContention,
    "H-09": v1Migration,
    "H-10": linkedMovementBehavior,
    "H-11": linkedMovementRecovery,
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
    seedVersion: "hidden-dockchain-v1",
    berths: [{
      berthId: ids.berth,
      name: "Hidden Berth",
      priority: 1,
      maxLengthMeters: 400,
      availability: [{ startAt: "2026-08-19T00:00:00.000Z", endAt: "2026-08-30T00:00:00.000Z" }],
    }],
    tugPools: [{
      tugPoolId: ids.tugPool,
      name: "Hidden Tug Pool",
      priority: 1,
      capacity: 1,
      availability: [{ startAt: "2026-08-19T00:00:00.000Z", endAt: "2026-08-30T00:00:00.000Z" }],
    }],
    yardWindows: [{
      yardWindowId: ids.yardWindow,
      priority: 1,
      capacityUnits: 1,
      startAt: "2026-08-19T00:00:00.000Z",
      endAt: "2026-08-30T00:00:00.000Z",
    }],
    vessels: ids.vessels.map((vesselId, index) => ({ vesselId, name: `Vessel ${index}`, lengthMeters: 200 })),
    portCalls: [],
    standbyEntries: [],
  };
}

function legacyPayload(index = 0, selected = interval) {
  return {
    vesselId: ids.vessels[index % ids.vessels.length],
    arrivalAt: selected.startAt,
    departureAt: selected.endAt,
    requiredTugs: 1,
    containerUnits: 1,
  };
}

function linkedPayload(index = 0) {
  return {
    vesselId: ids.vessels[index % ids.vessels.length],
    arrival: {
      startAt: "2026-08-21T00:00:00.000Z",
      endAt: "2026-08-21T02:00:00.000Z",
      requiredTugs: 1,
      containerUnits: 1,
    },
    departure: {
      startAt: "2026-08-21T04:00:00.000Z",
      endAt: "2026-08-21T06:00:00.000Z",
      requiredTugs: 1,
      containerUnits: 1,
    },
  };
}

function portCallOf(value) {
  return value?.portCall ?? value;
}

function movementOf(value) {
  return value?.movement ?? value;
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

async function createCall(ctx, baseUrl, key, payload = legacyPayload()) {
  const response = await ctx.mutate(baseUrl, "/api/v1/port-calls", key, payload);
  assert.equal(response.status, 201, response.text);
  const portCall = portCallOf(response.json);
  assert.equal(portCall.state, "HELD");
  return { response, portCall, payload };
}

async function waitForCall(ctx, baseUrl, portCallId, state, children = []) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return snapshot.resources.portCalls.find((call) => call.portCallId === portCallId)?.state === state
      ? snapshot
      : undefined;
  }, { timeoutMs: 60_000, label: `Port Call ${portCallId} to become ${state}`, children });
}

async function prepareWork(ctx, baseUrl) {
  const { portCall } = await createCall(ctx, baseUrl, "h07-create", legacyPayload(7));
  const confirmed = await ctx.mutate(baseUrl, `/api/v1/port-calls/${portCall.portCallId}/confirm`, "h07-confirm", {});
  assert.equal(confirmed.status, 200, confirmed.text);
  return confirmed;
}

async function mainFlow(ctx, assertions) {
  const api = await setup(ctx);
  const { portCall } = await createCall(ctx, api.baseUrl, "h03-create", legacyPayload(1));
  const held = await ctx.snapshot(api.baseUrl);
  const allocations = held.resources.resourceAllocations.filter(({ portCallId }) => portCallId === portCall.portCallId);
  assert.deepEqual(allocations.map(({ resourceType }) => resourceType).sort(), ["BERTH", "TUG_POOL", "YARD_WINDOW"]);
  assert.equal(allocations.every(({ startAt, endAt }) => startAt === interval.startAt && endAt === interval.endAt), true);

  const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${portCall.portCallId}/confirm`, "h03-confirm", {});
  assert.equal(confirmed.status, 200, confirmed.text);
  const worker = await ctx.startWorker();
  await waitForCall(ctx, api.baseUrl, portCall.portCallId, "CLEARED", [worker]);
  const started = await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${portCall.portCallId}/start-service`, "h03-start", {});
  assert.equal(started.status, 200, started.text);
  assert.equal(portCallOf(started.json).state, "IN_SERVICE");
  const completed = await ctx.mutate(api.baseUrl, `/api/v1/port-calls/${portCall.portCallId}/complete`, "h03-complete", {});
  assert.equal(completed.status, 200, completed.text);
  assert.equal(portCallOf(completed.json).state, "COMPLETED");

  const final = await ctx.snapshot(api.baseUrl);
  assert.deepEqual(
    final.events.filter(({ aggregateId }) => aggregateId === portCall.portCallId).map(({ type }) => type),
    ["port-call.held", "port-call.cleared", "port-call.started", "port-call.completed"],
  );
  assert.equal(final.resources.clearances.filter(({ portCallId, state }) => portCallId === portCall.portCallId && state === "PASSED").length, 1);
  assertions.push("Port Call holds one complete berth/tug/yard bundle, clears durably, starts once, completes once, and emits ordered events");
}

async function atomicRejection(ctx, assertions) {
  const api = await setup(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const invalid = await ctx.mutate(api.baseUrl, "/api/v1/port-calls", "h04-invalid", {
    ...legacyPayload(2),
    arrivalAt: "2026-08-20T00:07:00.000Z",
  });
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(invalid.json?.error?.code, "INVALID_PORT_CALL_INTERVAL");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(before));

  await createCall(ctx, api.baseUrl, "h04-base", legacyPayload(3));
  const occupied = await ctx.snapshot(api.baseUrl);
  const unavailable = await ctx.mutate(api.baseUrl, "/api/v1/port-calls", "h04-unavailable", legacyPayload(4));
  assert.equal(unavailable.status, 409, unavailable.text);
  assert.equal(unavailable.json?.error?.code, "WINDOW_UNAVAILABLE");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(occupied));
  assertions.push("misaligned and unavailable calls leave no partial berth, tug, yard, Work, or Event state");
}

async function resourceContention(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const results = await ctx.concurrent(Array.from({ length: 40 }), 40, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/port-calls",
    `h06-call-${index}`,
    legacyPayload(index),
  ));
  assert.equal(results.filter(({ status }) => status === 201).length, 1);
  assert.equal(results.filter(({ status, json }) => status === 409 && json?.error?.code === "WINDOW_UNAVAILABLE").length, 39);
  const snapshot = await ctx.snapshot(apiB.baseUrl);
  assert.equal(snapshot.resources.portCalls.length, 1);
  assert.equal(snapshot.resources.resourceAllocations.length, 3);
  assert.deepEqual(snapshot.resources.resourceAllocations.map(({ quantity }) => quantity), [1, 1, 1]);
  assertions.push("40 requests across two APIs elect one complete Port Call without berth overlap or tug/yard over-capacity");
}

async function v1Migration(ctx, assertions) {
  const v1Workspace = await ctx.copyV1Workspace();
  const v1Api = await setup(ctx, v1Workspace);
  const created = await createCall(ctx, v1Api.baseUrl, "h09-saved", legacyPayload(9));
  const confirmed = await ctx.mutate(v1Api.baseUrl, `/api/v1/port-calls/${created.portCall.portCallId}/confirm`, "h09-confirm", {});
  assert.equal(confirmed.status, 200, confirmed.text);
  const before = await ctx.snapshot(v1Api.baseUrl);
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/port-calls", "h09-saved", created.payload);
  assert.equal(replay.status, created.response.status);
  assert.equal(replay.text, created.response.text);
  const migrated = await ctx.snapshot(finalApi.baseUrl);
  const call = migrated.resources.portCalls.find(({ portCallId }) => portCallId === created.portCall.portCallId);
  assert.equal(call.movements.length, 1);
  assert.equal(call.movements[0].type, "ARRIVAL");
  assert.equal(call.movements[0].state, created.portCall.state);
  for (const field of ["arrivalAt", "departureAt", "requiredTugs", "containerUnits", "berthId", "tugPoolId", "yardWindowId", "expiresAt"]) {
    assert.deepEqual(call[field], created.portCall[field], field);
  }
  assert.deepEqual(
    migrated.work.filter(({ aggregateId }) => aggregateId === call.portCallId),
    before.work.filter(({ aggregateId }) => aggregateId === call.portCallId),
  );
  assert.deepEqual(
    migrated.events.filter(({ aggregateId }) => aggregateId === call.portCallId),
    before.events.filter(({ aggregateId }) => aggregateId === call.portCallId),
  );
  assertions.push("V1 replay bytes, singular fields, one ARRIVAL movement, pending Clearance Work, and event history survive migration");
}

async function createLinkedCall(ctx, baseUrl, key, payload = linkedPayload()) {
  const created = await createCall(ctx, baseUrl, key, payload);
  assert.equal(created.portCall.arrivalAt, null);
  assert.equal(created.portCall.departureAt, null);
  assert.deepEqual(created.portCall.movements.map(({ type }) => type), ["ARRIVAL", "DEPARTURE"]);
  return created;
}

async function movementAction(ctx, baseUrl, portCallId, movementId, action, key, body = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/port-calls/${portCallId}/movements/${movementId}/${action}`, key, body);
  assert.equal(response.status, 200, response.text);
  return movementOf(response.json);
}

async function waitForMovements(ctx, baseUrl, portCallId, state, children = []) {
  return ctx.waitFor(async () => {
    const response = await ctx.request(baseUrl, `/api/v1/port-calls/${portCallId}`);
    if (response.status !== 200) return undefined;
    const call = portCallOf(response.json);
    return call.movements.every((movement) => movement.state === state) ? call : undefined;
  }, { timeoutMs: 60_000, label: `all movements to become ${state}`, children });
}

async function linkedMovementBehavior(ctx, assertions) {
  const api = await setup(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const badGap = linkedPayload(10);
  badGap.departure = { ...badGap.departure, startAt: "2026-08-21T03:45:00.000Z" };
  const rejected = await ctx.mutate(api.baseUrl, "/api/v1/port-calls", "h10-gap", badGap);
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal(rejected.json?.error?.code, "TURNAROUND_GAP_TOO_SHORT");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(before));

  const { portCall } = await createLinkedCall(ctx, api.baseUrl, "h10-linked", linkedPayload(11));
  const [arrival, departure] = portCall.movements;
  await Promise.all([
    movementAction(ctx, api.baseUrl, portCall.portCallId, arrival.movementId, "confirm", "h10-confirm-arrival"),
    movementAction(ctx, api.baseUrl, portCall.portCallId, departure.movementId, "confirm", "h10-confirm-departure"),
  ]);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const cleared = await waitForMovements(ctx, api.baseUrl, portCall.portCallId, "CLEARED", workers);
  assert.equal(new Set(cleared.movements.map(({ clearanceTaskId }) => clearanceTaskId)).size, 2);

  await movementAction(ctx, api.baseUrl, portCall.portCallId, arrival.movementId, "start-service", "h10-start-arrival");
  await movementAction(ctx, api.baseUrl, portCall.portCallId, arrival.movementId, "complete", "h10-complete-arrival");
  let read = await ctx.request(api.baseUrl, `/api/v1/port-calls/${portCall.portCallId}`);
  assert.equal(portCallOf(read.json).state, "ARRIVED");
  await movementAction(ctx, api.baseUrl, portCall.portCallId, departure.movementId, "cancel", "h10-cancel-departure", { reason: "Harness departure cancellation" });
  read = await ctx.request(api.baseUrl, `/api/v1/port-calls/${portCall.portCallId}`);
  const final = portCallOf(read.json);
  assert.equal(final.state, "ARRIVED");
  assert.equal(final.movements.find(({ type }) => type === "ARRIVAL").state, "COMPLETED");
  assert.equal(final.movements.find(({ type }) => type === "DEPARTURE").state, "CANCELLED");
  assertions.push("linked movements allocate atomically, clear independently, reach ARRIVED after arrival completion, and cancel only departure resources");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function linkedMovementRecovery(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const { portCall } = await createLinkedCall(ctx, apiA.baseUrl, "h11-linked", linkedPayload(12));
  const [arrival, departure] = portCall.movements;
  const confirms = await Promise.all([
    movementAction(ctx, apiA.baseUrl, portCall.portCallId, arrival.movementId, "confirm", "h11-confirm-arrival"),
    movementAction(ctx, apiB.baseUrl, portCall.portCallId, departure.movementId, "confirm", "h11-confirm-departure"),
  ]);
  assert.equal(new Set(confirms.map(({ clearanceTaskId }) => clearanceTaskId)).size, 2);

  const held = deferred();
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.before-commit" ? held.promise : { status: 204 });
  const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h11-dockchain" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.before-commit"), {
    timeoutMs: 30_000,
    label: "movement clearance before-commit barrier",
    children: [first],
  });
  await ctx.stop(first, "SIGKILL");
  held.resolve({ status: 204 });
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const cleared = await waitForMovements(ctx, apiB.baseUrl, portCall.portCallId, "CLEARED", replacements);
  assert.deepEqual(cleared.movements.map(({ clearanceTaskId }) => clearanceTaskId), confirms.map(({ clearanceTaskId }) => clearanceTaskId));

  const starts = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/port-calls/${portCall.portCallId}/movements/${arrival.movementId}/start-service`,
    "h11-shared-start",
    {},
  ));
  assert.equal(new Set(starts.map(({ status, text }) => `${status}:${text}`)).size, 1);
  assert.equal(starts[0].status, 200, starts[0].text);
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  assert.equal(snapshot.work.filter(({ aggregateId, terminal }) => aggregateId === portCall.portCallId && !terminal).length, 0);
  assert.equal(snapshot.resources.clearances.filter(({ portCallId, state }) => portCallId === portCall.portCallId && state === "PASSED").length, 2);
  assertions.push("independent movement clearance survives before-commit SIGKILL with stable task identity and replay-safe single service start");
}

function perfTimestamp(slot, offset = 0) {
  return new Date(Date.UTC(2027, 0, 1) + (slot * 120 + offset) * 60_000).toISOString();
}

function perfSeed() {
  const availability = [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2030-01-01T00:00:00.000Z" }];
  const berths = Array.from({ length: 1_000 }, (_, index) => ({
    berthId: uuid("d1000000", index), name: `Berth ${index}`, priority: index + 1, maxLengthMeters: 400, availability,
  }));
  const tugPools = Array.from({ length: 20 }, (_, index) => ({
    tugPoolId: uuid("d2000000", index), name: `Tug Pool ${index}`, priority: index + 1, capacity: 1_000, availability,
  }));
  const yardWindows = Array.from({ length: 20 }, (_, index) => ({
    yardWindowId: uuid("d3000000", index), priority: index + 1, capacityUnits: 100_000,
    startAt: availability[0].startAt, endAt: availability[0].endAt,
  }));
  const vessels = Array.from({ length: 100_000 }, (_, index) => ({
    vesselId: uuid("d4000000", index), name: `Vessel ${index}`, lengthMeters: 200,
  }));
  const portCalls = Array.from({ length: 51_500 }, (_, index) => {
    const historical = index < 50_000;
    const berthIndex = index % berths.length;
    const localSlot = Math.floor(index / berths.length) + (historical ? 0 : 100);
    const arrivalAt = perfTimestamp(localSlot);
    const departureAt = perfTimestamp(localSlot + 1);
    return {
      portCallId: uuid("d5000000", index),
      vesselId: vessels[index].vesselId,
      arrivalAt,
      departureAt,
      requiredTugs: 1,
      containerUnits: 1,
      berthId: berths[berthIndex].berthId,
      tugPoolId: tugPools[index % tugPools.length].tugPoolId,
      yardWindowId: yardWindows[index % yardWindows.length].yardWindowId,
      state: historical ? "COMPLETED" : "HELD",
      expiresAt: historical ? "2026-01-01T00:03:00.000Z" : "2030-01-01T00:00:00.000Z",
      startedAt: historical ? arrivalAt : null,
      completedAt: historical ? departureAt : null,
      sequence: historical ? 4 : 1,
    };
  });
  return { schemaVersion: 1, seedVersion: "perf-v1", berths, tugPools, yardWindows, vessels, portCalls, standbyEntries: [] };
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
  let readOrdinal = 0;
  const reads = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async () => {
      const index = readOrdinal++ % 100_000;
      const response = await ctx.request(index % 2 ? apiA.baseUrl : apiB.baseUrl,
        `/api/v1/port-resources/feasible-windows?vesselId=${uuid("d4000000", index)}&arrivalFrom=2028-01-01T00%3A00%3A00.000Z&arrivalTo=2028-01-08T00%3A00%3A00.000Z&durationMinutes=120&requiredTugs=1&containerUnits=1&limit=100`);
      assert.equal(response.status, 200, response.text);
      assert.ok(Array.isArray(response.json?.items));
      return response;
    },
  });
  assert.ok(reads.throughput >= 120, `feasible-window-read throughput ${reads.throughput}/s`);
  assert.ok(reads.p95 <= 220, `feasible-window-read p95 ${reads.p95}ms`);
  metrics.push({ scenarioId: "feasible-window-read", ...reads });
  assertions.push(`feasible-window-read: ${reads.throughput.toFixed(1)}/s at p95 ${reads.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  ({ apiA, apiB } = await preparePerformance(ctx));
  let createOrdinal = 0;
  const creations = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async ({ measured }) => {
      const index = createOrdinal++;
      const slot = 5_000 + index;
      const response = await ctx.mutate(index % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/port-calls", `perf-create-${measured ? "measure" : "warmup"}-${index}`, {
        vesselId: uuid("d4000000", index % 100_000),
        arrivalAt: perfTimestamp(slot),
        departureAt: perfTimestamp(slot + 1),
        requiredTugs: 1,
        containerUnits: 1,
      });
      assert.equal(response.status, 201, response.text);
      const call = portCallOf(response.json);
      assert.ok(call.berthId && call.tugPoolId && call.yardWindowId);
      return response;
    },
  });
  assert.ok(creations.throughput >= 25, `port-call-create throughput ${creations.throughput}/s`);
  assert.ok(creations.p95 <= 700, `port-call-create p95 ${creations.p95}ms`);
  const createdSnapshot = await ctx.snapshot(apiA.baseUrl);
  assert.equal(createdSnapshot.resources.resourceAllocations.length, createdSnapshot.resources.portCalls.length * 3);
  metrics.push({ scenarioId: "port-call-create", ...creations });
  assertions.push(`port-call-create: ${creations.throughput.toFixed(1)}/s at p95 ${creations.p95.toFixed(1)}ms with complete allocations`);

  await ctx.resetDatabase();
  ({ apiA } = await preparePerformance(ctx));
  const held = deferred();
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held.promise : { status: 204 });
  const first = [
    await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-dockchain" }),
    await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-dockchain" }),
  ];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, {
    timeoutMs: 30_000,
    label: "two claimed Clearance Tasks",
    children: first,
  });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  held.resolve({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const recoveryStartedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const targetIds = new Set(Array.from({ length: 1_500 }, (_, index) => uuid("d5000000", 50_000 + index)));
  const recovered = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const targets = snapshot.resources.portCalls.filter(({ portCallId }) => targetIds.has(portCallId));
    return targets.length === 1_500 && targets.every(({ state }) => state === "CLEARED")
      && snapshot.work.filter(({ kind, terminal }) => kind === "CLEARANCE" && !terminal).length === 0
      ? snapshot
      : undefined;
  }, { timeoutMs: 60_000, label: "1,500 Clearance Tasks to recover", children: replacements });
  const recoveryMs = Date.now() - recoveryStartedAt;
  assert.equal(recovered.resources.clearances.filter(({ portCallId, state }) => targetIds.has(portCallId) && state === "PASSED").length, 1_500);
  assert.equal(recovered.resources.resourceAllocations.length, recovered.resources.portCalls.length * 3);
  metrics.push({ scenarioId: "clearance-recovery", completed: 1_500, durationMs: recoveryMs, killedWorkers: 2, replacementWorkers: 2 });
  assertions.push(`clearance-recovery: 1,500 tasks recovered in ${recoveryMs}ms with full capacity invariants`);
  return { metrics, fixtureSummary: { berths: 1_000, tugPools: 20, yardWindows: 20, vessels: 100_000, portCalls: 51_500 } };
}
