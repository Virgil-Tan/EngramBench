import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `31000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const backendIds = [id(10), id(11)];
const routeId = id(20);
const routeRevisionId = id(21);
const rateLimitPolicyId = id(30);
const circuitPolicyId = id(31);
const activeReleaseId = id(40);
const createdAt = "2026-01-01T00:00:00.000Z";

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function stable(snapshot) {
  const { asOf: _asOf, ...value } = snapshot;
  return value;
}

function seed(receiverUrl, { version = "hidden-routepilot", rateLimit = 1_000_000 } = {}) {
  return {
    schemaVersion: 1, seedVersion: version, importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Gateway Tenant" }],
    backends: backendIds.map((backendId, index) => ({
      backendId, tenantId, name: `orders-v${index + 1}`, origin: receiverUrl, state: "ACTIVE",
    })),
    routeDefinitions: [{ routeId, tenantId, name: "Orders", priority: 100 }],
    routeRevisions: [{
      routeRevisionId, routeId, revision: 1, pathPattern: "/orders/:orderId", methods: ["POST"],
      headerMatches: [], backends: [
        { backendId: backendIds[0], version: "v1", weight: 8000 },
        { backendId: backendIds[1], version: "v2", weight: 2000 },
      ], rateLimitPolicyId, circuitPolicyId, createdAt,
    }],
    rateLimitPolicies: [{ rateLimitPolicyId, tenantId, revision: 1, windowSeconds: 3600, limit: rateLimit }],
    circuitPolicies: [{ circuitPolicyId, tenantId, revision: 1, sampleSize: 20, failureThresholdPercent: 50, openSeconds: 3, halfOpenMax: 2 }],
    configReleases: [{ configReleaseId: activeReleaseId, tenantId, version: 1, state: "ACTIVE", routeRevisionIds: [routeRevisionId], priorReleaseId: null, createdAt, activatedAt: createdAt }],
    gatewayRequests: [], upstreamAttempts: [], rateWindows: [], circuitWindows: [],
  };
}

function routeScaleSeed(receiverUrl) {
  const scaledBackendIds = Array.from({ length: 20 }, (_, index) => id(300_000 + index));
  const routeDefinitions = Array.from({ length: 250 }, (_, index) => ({
    routeId: id(100_000 + index), tenantId, name: `Resource ${index}`, priority: 100,
  }));
  const routeRevisions = routeDefinitions.map(({ routeId: currentRouteId }, index) => ({
    routeRevisionId: id(200_000 + index), routeId: currentRouteId, revision: 1,
    pathPattern: `/resource-${index}/:itemId`, methods: ["POST"], headerMatches: [],
    backends: scaledBackendIds.map((backendId, version) => ({ backendId, version: `v${version + 1}`, weight: 500 })),
    rateLimitPolicyId, circuitPolicyId, createdAt,
  }));
  return {
    ...seed(receiverUrl, { version: "perf-route-steady" }),
    backends: scaledBackendIds.map((backendId, index) => ({ backendId, tenantId, name: `resource-v${index + 1}`, origin: receiverUrl, state: "ACTIVE" })),
    routeDefinitions,
    routeRevisions,
    configReleases: [{
      configReleaseId: activeReleaseId, tenantId, version: 1, state: "ACTIVE",
      routeRevisionIds: routeRevisions.map(({ routeRevisionId: value }) => value),
      priorReleaseId: null, createdAt, activatedAt: createdAt,
    }],
  };
}

function release() {
  return { tenantId, version: 2, routeRevisionIds: [routeRevisionId], expectedActiveVersion: 1 };
}

function gatewayRequest(index) {
  return {
    tenantId, method: "POST", path: `/orders/${index}`, headers: { "x-route-affinity": `customer-${index}` },
    body: { orderId: index }, requestKey: `gateway-${index}`,
  };
}

function scaledGatewayRequest(index) {
  return { ...gatewayRequest(index), path: `/resource-${index % 250}/${index}` };
}

function expectedCanary(index) {
  const currentRouteRevisionId = id(200_000 + (index % 250));
  const input = `${tenantId}\n${currentRouteRevisionId}\ncustomer-${index}`;
  const bucket = Number.parseInt(createHash("sha256").update(input).digest("hex").slice(0, 8), 16) % 10_000;
  return { routeRevisionId: currentRouteRevisionId, backendVersion: `v${Math.floor(bucket / 500) + 1}` };
}

async function fixedLoad(ctx, { count, concurrency, request }) {
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const response = await request(index);
    latencies.push(response.durationMs);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);
  const at = (fraction) => latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)];
  return { completed: count, durationMs, throughput: count / (durationMs / 1000), p50: at(0.5), p95: at(0.95), p99: at(0.99), statuses: Object.fromEntries(statuses) };
}

function assertIdsPreserved(before, after, resource, key) {
  const current = new Set(after.resources[resource].map((entry) => entry[key]));
  assert.ok(before.resources[resource].every((entry) => current.has(entry[key])), `${resource} identity changed during migration`);
}

function assertEventSequence(events, aggregateId) {
  const sequence = events
    .filter((entry) => entry.aggregateId === aggregateId)
    .map(({ sequence: value }) => value)
    .sort((a, b) => a - b);
  assert.ok(sequence.length > 0, `aggregate ${aggregateId} emitted no events`);
  assert.deepEqual(sequence, Array.from({ length: sequence.length }, (_, index) => index + 1));
}

async function routePilotMigration(ctx, assertions) {
  const v1 = await ctx.copyV1Workspace();
  await ctx.prepare(v1);
  const receiver = await ctx.receiver();
  assert.equal((await ctx.seed(seed(receiver.url, { version: "h09-routepilot" }), v1)).exitCode, 0);
  const v1Api = await ctx.startApi(v1);
  const v1Worker = await ctx.startWorker({}, v1);
  const activated = await ctx.mutate(v1Api.baseUrl, "/api/v1/config-releases", "h09-activate-release", release());
  assert.ok([200, 201, 202].includes(activated.status), activated.text);
  const activatedId = find(activated.json, "configReleaseId");
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(v1Api.baseUrl);
    return snapshot.resources.configReleases.some(({ configReleaseId, state }) => configReleaseId === activatedId && state === "ACTIVE");
  }, { label: "V1 release activation", children: [v1Worker] });
  const rollback = await ctx.mutate(v1Api.baseUrl, `/api/v1/config-releases/${activatedId}/rollback`, "h09-rollback", { expectedActiveVersion: 2 });
  assert.ok([200, 201, 202].includes(rollback.status), rollback.text);
  const rollbackId = find(rollback.json, "configReleaseId");
  const rolledBack = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(v1Api.baseUrl);
    const current = snapshot.resources.configReleases.find(({ configReleaseId }) => configReleaseId === rollbackId);
    const prior = snapshot.resources.configReleases.find(({ configReleaseId }) => configReleaseId === activatedId);
    return current?.state === "ACTIVE" && prior?.state === "ROLLED_BACK" ? snapshot : undefined;
  }, { label: "V1 rollback activation", children: [v1Worker] });
  const activeVersion = rolledBack.resources.configReleases.find(({ configReleaseId }) => configReleaseId === rollbackId).version;
  const dispatched = await ctx.mutate(v1Api.baseUrl, "/api/v1/gateway/dispatch", "h09-saved-dispatch", gatewayRequest(909));
  assert.ok([200, 201].includes(dispatched.status), dispatched.text);
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(v1Api.baseUrl);
    return snapshot.resources.rateWindows.length > 0
      && snapshot.resources.circuitWindows.length > 0
      && snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { label: "V1 windows and work drain", children: [v1Worker] });
  await ctx.stop(v1Worker);

  const pendingPayload = { tenantId, version: activeVersion + 1, routeRevisionIds: [routeRevisionId], expectedActiveVersion: activeVersion };
  const created = await ctx.mutate(v1Api.baseUrl, "/api/v1/config-releases", "h09-saved-release", pendingPayload);
  assert.ok([200, 201, 202].includes(created.status), created.text);
  const pendingReleaseId = find(created.json, "configReleaseId");
  let releaseLease;
  const held = new Promise((resolve) => { releaseLease = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingReleaseId ? held : { status: 204 });
  const oldWorker = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "routepilot-h09" }, v1);
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingReleaseId), {
    label: "V1 release lease", children: [oldWorker],
  });
  const before = await ctx.snapshot(v1Api.baseUrl);
  const oldLease = before.work.find(({ aggregateId, kind }) => aggregateId === pendingReleaseId && kind === "CONFIG_ACTIVATE");
  assert.ok(oldLease && oldLease.state === "LEASED" && !oldLease.terminal, "V1 pending release has no preserved lease");
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/config-releases", "h09-saved-release", pendingPayload);
  assert.equal(replay.status, created.status);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(created.json));
  const dispatchReplay = await ctx.mutate(finalApi.baseUrl, "/api/v1/gateway/dispatch", "h09-saved-dispatch", gatewayRequest(909));
  assert.equal(dispatchReplay.status, dispatched.status);
  assert.equal(ctx.canonical(dispatchReplay.json), ctx.canonical(dispatched.json));
  const after = await ctx.snapshot(finalApi.baseUrl);
  for (const [resource, key] of [["routeRevisions", "routeRevisionId"], ["configReleases", "configReleaseId"], ["gatewayRequests", "gatewayRequestId"], ["upstreamAttempts", "gatewayRequestId"]]) {
    assertIdsPreserved(before, after, resource, key);
  }
  assert.equal(ctx.canonical(after.resources.rateWindows), ctx.canonical(before.resources.rateWindows));
  assert.equal(ctx.canonical(after.resources.circuitWindows), ctx.canonical(before.resources.circuitWindows));
  const eventIds = new Set(after.events.map(({ eventId }) => eventId));
  const workIds = new Set(after.work.map(({ workId }) => workId));
  assert.ok(before.events.every(({ eventId }) => eventIds.has(eventId)));
  assert.ok(before.work.every(({ workId }) => workIds.has(workId)));
  const migratedLease = after.work.find(({ workId }) => workId === oldLease.workId);
  assert.ok(migratedLease, "V1 leased Work identity disappeared during migration");
  assert.deepEqual(
    [migratedLease.state, migratedLease.attempt, migratedLease.leaseOwner, migratedLease.leaseExpiresAt, migratedLease.terminal],
    [oldLease.state, oldLease.attempt, oldLease.leaseOwner, oldLease.leaseExpiresAt, oldLease.terminal],
  );
  const legacyRollouts = after.resources.regionalRollouts.filter(({ tenantId: value, requestRef }) => value === tenantId && requestRef === "legacy-global");
  const global = after.resources.regionalStages.filter(({ regionalRolloutId }) => regionalRolloutId === legacyRollouts[0]?.regionalRolloutId);
  assert.equal(legacyRollouts.length, 1);
  assert.equal(legacyRollouts[0].state, "COMPLETED");
  assert.equal(legacyRollouts[0].targetConfigReleaseId, rollbackId);
  assert.equal(global.length, 1);
  assert.deepEqual(
    [global[0].region, global[0].ordinal, global[0].state, global[0].priorConfigReleaseId, global[0].targetConfigReleaseId],
    ["GLOBAL", 0, "SUCCEEDED", rollbackId, rollbackId],
  );
  assert.ok(after.resources.configReleases.some(({ configReleaseId, state }) => configReleaseId === activatedId && state === "ROLLED_BACK"));

  releaseLease({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 750));
  const afterOldWorker = await ctx.snapshot(finalApi.baseUrl);
  assert.ok(afterOldWorker.resources.configReleases.some(({ configReleaseId, state }) => configReleaseId === pendingReleaseId && state !== "ACTIVE"));
  assert.equal(afterOldWorker.resources.regionalStages.find(({ region }) => region === "GLOBAL").targetConfigReleaseId, rollbackId);
  await ctx.stop(oldWorker, "SIGKILL");

  const legacyIdentity = [legacyRollouts[0].regionalRolloutId, global[0].regionalStageId];
  await ctx.stop(finalApi);
  await ctx.prepare();
  const repeatedApi = await ctx.startApi();
  const repeated = await ctx.snapshot(repeatedApi.baseUrl);
  const repeatedRollout = repeated.resources.regionalRollouts.find(({ requestRef }) => requestRef === "legacy-global");
  const repeatedStage = repeated.resources.regionalStages.find(({ regionalRolloutId, region }) => regionalRolloutId === repeatedRollout?.regionalRolloutId && region === "GLOBAL");
  assert.deepEqual([repeatedRollout?.regionalRolloutId, repeatedStage?.regionalStageId], legacyIdentity);
  assertions.push("V1 rollback, windows, gateway replay, leased Work, and deterministic GLOBAL authority survive repeat migration; a stale V1 Worker cannot activate the pending release");
}

const spec = {
  label: "RoutePilot ConfigRelease creation",
  performanceScenarioIds: ["route-match-steady", "hot-tenant-limit", "breaker-reload-recovery"],
  seed: async (_ctx, receiverUrl) => seed(receiverUrl),
  path: "/api/v1/config-releases",
  payload: (index) => release(index),
  conflictPayload: () => ({ ...release(0), routeRevisionIds: [] }),
  resource: "configReleases",
  identity: (json) => find(json, "configReleaseId"),
  resourceIdentity: ({ configReleaseId }) => configReleaseId,
  workIdentity: (json) => find(json, "configReleaseId"),
  async verify(ctx, baseUrl, response) {
    const releaseId = find(response.json, "configReleaseId");
    const worker = await ctx.startWorker();
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(baseUrl);
      return snapshot.resources.configReleases.some(({ configReleaseId, state }) => configReleaseId === releaseId && state === "ACTIVE") ? snapshot : undefined;
    }, { label: "ConfigRelease activation", children: [worker] });
    const dispatched = await ctx.mutate(baseUrl, "/api/v1/gateway/dispatch", "h03-dispatch", gatewayRequest(3));
    assert.ok([200, 201].includes(dispatched.status), dispatched.text);
    assert.equal(find(dispatched.json, "routeRevisionId"), routeRevisionId);
    assert.ok(["v1", "v2"].includes(find(dispatched.json, "backendVersion")));
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, "/api/v1/route-revisions", "h04-weights", {
      routeId, revision: 2, pathPattern: "/orders/:orderId", methods: ["POST"], headerMatches: [],
      backends: [{ backendId: backendIds[0], version: "v1", weight: 9999 }], rateLimitPolicyId, circuitPolicyId,
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(before));
  },
  async contention(ctx, baseUrls) {
    const results = await ctx.concurrent(Array.from({ length: 160 }), 64, (_, index) => ctx.mutate(
      baseUrls[index % 2], "/api/v1/gateway/dispatch", `h06-gateway-${index}`, gatewayRequest(10_000 + index),
    ));
    assert.ok(results.every(({ status }) => [200, 201, 429, 503, 504].includes(status)));
    const snapshot = await ctx.snapshot(baseUrls[0]);
    assert.ok(snapshot.resources.rateWindows.every(({ consumed }) => consumed <= 1_000_000));
    const requests = snapshot.resources.gatewayRequests;
    assert.equal(new Set(requests.map(({ gatewayRequestId }) => gatewayRequestId)).size, requests.length);
  },
  manager: {
    path: "/api/v1/regional-rollouts",
    payload: () => ({ tenantId, targetConfigReleaseId: "prepared", stages: [] }),
    async prepare(ctx, baseUrl) {
      const target = await ctx.mutate(baseUrl, "/api/v1/config-releases", "manager-target-release", release());
      const targetConfigReleaseId = find(target.json, "configReleaseId");
      return { payload: (index) => ({
      tenantId, targetConfigReleaseId,
      stages: [
        { region: "us-east", minimumObservationSeconds: 3, failureThresholdPercent: 10 },
        { region: "eu-west", minimumObservationSeconds: 3, failureThresholdPercent: 10 },
        { region: "us-east", minimumObservationSeconds: 3, failureThresholdPercent: 10 },
      ], requestRef: `rollout-${index}`,
      }) };
    },
    async verify(ctx, baseUrl, response) {
      const rolloutId = find(response.json, "regionalRolloutId");
      const read = await ctx.request(baseUrl, `/api/v1/regional-rollouts/${rolloutId}`);
      assert.equal(read.status, 200, read.text);
      assert.equal(ctx.canonical(read.json), ctx.canonical(response.json));
      assert.deepEqual(Object.keys(response.json).sort(), ["regionalRollout", "stages"]);
      assert.equal(response.json.stages.length, 2);
      assert.deepEqual(response.json.stages.map(({ region, ordinal }) => ({ region, ordinal })), [
        { region: "us-east", ordinal: 0 },
        { region: "eu-west", ordinal: 1 },
      ]);
      const before = await ctx.snapshot(baseUrl);
      const frozen = before.resources.regionalStages
        .filter((entry) => entry.regionalRolloutId === rolloutId)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map(({ ordinal, region, minimumObservationSeconds, failureThresholdPercent, priorConfigReleaseId, targetConfigReleaseId }) => ({
          ordinal, region, minimumObservationSeconds, failureThresholdPercent, priorConfigReleaseId, targetConfigReleaseId,
        }));
      assert.deepEqual(frozen, [
        { ordinal: 0, region: "us-east", minimumObservationSeconds: 3, failureThresholdPercent: 10, priorConfigReleaseId: activeReleaseId, targetConfigReleaseId: find(response.json, "targetConfigReleaseId") },
        { ordinal: 1, region: "eu-west", minimumObservationSeconds: 3, failureThresholdPercent: 10, priorConfigReleaseId: activeReleaseId, targetConfigReleaseId: find(response.json, "targetConfigReleaseId") },
      ]);
      assert.ok(before.work.some(({ kind, aggregateId }) => kind === "REGIONAL_ROLLOUT_ADVANCE" && aggregateId === rolloutId));
      const worker = await ctx.startWorker();
      let snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const rollout = value.resources.regionalRollouts.find((entry) => entry.regionalRolloutId === rolloutId);
        const stages = value.resources.regionalStages.filter((entry) => entry.regionalRolloutId === rolloutId).sort((a, b) => a.ordinal - b.ordinal);
        return rollout?.state === "RUNNING" && stages[0]?.state === "ACTIVE" && stages[1]?.state === "PENDING" ? value : undefined;
      }, { timeoutMs: 60_000, label: "first Regional stage activation", children: [worker] });
      const paused = await ctx.mutate(baseUrl, `/api/v1/regional-rollouts/${rolloutId}/pause`, "h10-pause", {});
      assert.ok([200, 201, 202].includes(paused.status), paused.text);
      assert.equal(find(paused.json, "state"), "PAUSED");
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      snapshot = await ctx.snapshot(baseUrl);
      assert.equal(snapshot.resources.regionalRollouts.find((entry) => entry.regionalRolloutId === rolloutId).state, "PAUSED");
      assert.equal(snapshot.resources.regionalStages.find((entry) => entry.regionalRolloutId === rolloutId && entry.ordinal === 1).state, "PENDING");
      const resumed = await ctx.mutate(baseUrl, `/api/v1/regional-rollouts/${rolloutId}/resume`, "h10-resume", {});
      assert.ok([200, 201, 202].includes(resumed.status), resumed.text);
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.regionalRollouts.find((entry) => entry.regionalRolloutId === rolloutId)?.state === "COMPLETED" ? value : undefined;
      }, { timeoutMs: 60_000, label: "Regional rollout completion", children: [worker] });
      const stages = snapshot.resources.regionalStages.filter((entry) => entry.regionalRolloutId === rolloutId).sort((a, b) => a.ordinal - b.ordinal);
      assert.ok(stages.every(({ state }) => state === "SUCCEEDED"));
      assert.ok(stages.every(({ activatedAt, completedAt, minimumObservationSeconds }) => Date.parse(completedAt) - Date.parse(activatedAt) >= minimumObservationSeconds * 1_000));
      assert.ok(Date.parse(stages[1].activatedAt) >= Date.parse(stages[0].completedAt));
      assert.deepEqual(stages.map(({ ordinal, region, minimumObservationSeconds, failureThresholdPercent, priorConfigReleaseId, targetConfigReleaseId }) => ({
        ordinal, region, minimumObservationSeconds, failureThresholdPercent, priorConfigReleaseId, targetConfigReleaseId,
      })), frozen);
      const active = snapshot.resources.configReleases.filter(({ state }) => state === "ACTIVE");
      assert.equal(active.length, 1);
      assert.equal(active[0].configReleaseId, find(response.json, "targetConfigReleaseId"));
      assert.ok(snapshot.work.filter(({ kind, aggregateId }) => kind === "REGIONAL_ROLLOUT_ADVANCE" && aggregateId === rolloutId).every(({ terminal }) => terminal));
      assertEventSequence(snapshot.events, rolloutId);
    },
    async concurrentVerify(ctx, baseUrls, response, operation) {
      const rolloutId = find(response.json, "regionalRolloutId");
      let worker = await ctx.startWorker();
      let snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const stages = value.resources.regionalStages.filter((entry) => entry.regionalRolloutId === rolloutId).sort((a, b) => a.ordinal - b.ordinal);
        return stages[0]?.state === "SUCCEEDED" && stages[1]?.state === "ACTIVE" ? value : undefined;
      }, { timeoutMs: 60_000, label: "Regional rollback point", children: [worker] });
      const paused = await ctx.mutate(baseUrls[0], `/api/v1/regional-rollouts/${rolloutId}/pause`, "h11-rollback-pause", {});
      assert.ok([200, 201, 202].includes(paused.status), paused.text);
      await ctx.stop(worker);
      const rollbacks = await Promise.all(Array.from({ length: 16 }, (_, index) => ctx.mutate(
        baseUrls[index % 2], `/api/v1/regional-rollouts/${rolloutId}/rollback`, "h11-rollback", {},
      )));
      assert.ok(rollbacks.every(({ status }) => [200, 201, 202].includes(status)));
      assert.equal(new Set(rollbacks.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
      let releaseBarrier;
      const held = new Promise((resolve) => { releaseBarrier = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === rolloutId ? held : { status: 204 });
      const killed = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "routepilot-h11" });
      await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === rolloutId), { label: "regional rollback claim", children: [killed] });
      await ctx.stop(killed, "SIGKILL");
      releaseBarrier({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3200));
      worker = await ctx.startWorker();
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const work = value.work.filter(({ aggregateId }) => aggregateId === rolloutId);
        const rollout = value.resources.regionalRollouts.find((entry) => entry.regionalRolloutId === rolloutId);
        return rollout?.state === "ROLLED_BACK" && work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
      }, { timeoutMs: 60_000, label: "regional rollback recovery", children: [worker] });
      const rolledBackStages = snapshot.resources.regionalStages.filter((entry) => entry.regionalRolloutId === rolloutId);
      assert.ok(rolledBackStages.every(({ state, activatedAt }) => activatedAt === null || state === "ROLLED_BACK"));
      assert.ok(rolledBackStages.filter(({ activatedAt }) => activatedAt !== null).every(({ priorConfigReleaseId, targetConfigReleaseId }) => priorConfigReleaseId === activeReleaseId && targetConfigReleaseId === find(response.json, "targetConfigReleaseId")));
      const restored = snapshot.resources.configReleases.filter(({ state }) => state === "ACTIVE");
      assert.equal(restored.length, 1);
      assert.equal(restored[0].configReleaseId, activeReleaseId);
      assertEventSequence(snapshot.events, rolloutId);
      await ctx.stop(worker);

      const currentVersion = restored[0].version;
      const nextVersion = Math.max(...snapshot.resources.configReleases.map(({ version }) => version)) + 1;
      const nextTarget = await ctx.mutate(baseUrls[0], "/api/v1/config-releases", "h11-cancel-target", {
        tenantId, version: nextVersion, routeRevisionIds: [routeRevisionId], expectedActiveVersion: currentVersion,
      });
      assert.ok([200, 201, 202].includes(nextTarget.status), nextTarget.text);
      const nextTargetId = find(nextTarget.json, "configReleaseId");
      const cancelCreated = await ctx.mutate(baseUrls[1], operation.path, "h11-cancel-rollout", {
        ...operation.payload(3), targetConfigReleaseId: nextTargetId, requestRef: "rollout-cancel",
      });
      assert.ok([200, 201, 202].includes(cancelCreated.status), cancelCreated.text);
      const cancelRolloutId = find(cancelCreated.json, "regionalRolloutId");
      let cancelRelease;
      const cancelHeld = new Promise((resolve) => { cancelRelease = resolve; });
      const cancelBarrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === cancelRolloutId ? cancelHeld : { status: 204 });
      const stale = await ctx.startWorker({ TEST_BARRIER_URL: cancelBarrier.url, TEST_BARRIER_TOKEN: "routepilot-h11-cancel" });
      await ctx.waitFor(() => cancelBarrier.ledger.some((entry) => entry.json?.aggregateId === cancelRolloutId), { label: "regional cancel claim", children: [stale] });
      await ctx.stop(stale, "SIGKILL");
      cancelRelease({ status: 204 });
      const controls = await Promise.all([
        ctx.mutate(baseUrls[0], `/api/v1/regional-rollouts/${cancelRolloutId}/pause`, "h11-pause", {}),
        ctx.mutate(baseUrls[1], `/api/v1/regional-rollouts/${cancelRolloutId}/resume`, "h11-resume", {}),
        ctx.mutate(baseUrls[0], `/api/v1/regional-rollouts/${cancelRolloutId}/cancel`, "h11-cancel", {}),
        ctx.mutate(baseUrls[1], `/api/v1/regional-rollouts/${cancelRolloutId}/rollback`, "h11-cancel-rollback", {}),
      ]);
      assert.ok([200, 201, 202].includes(controls[2].status), controls[2].text);
      assert.ok([controls[0], controls[1], controls[3]].every(({ status }) => [200, 201, 202, 409].includes(status)));
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const replacement = await ctx.startWorker();
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const work = value.work.filter(({ aggregateId }) => aggregateId === cancelRolloutId);
        return value.resources.regionalRollouts.find((entry) => entry.regionalRolloutId === cancelRolloutId)?.state === "CANCELLED"
          && work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
      }, { timeoutMs: 60_000, label: "regional cancel recovery", children: [replacement] });
      const cancelledStages = snapshot.resources.regionalStages.filter((entry) => entry.regionalRolloutId === cancelRolloutId);
      assert.ok(cancelledStages.every(({ state, activatedAt }) => state === "PENDING" && activatedAt === null));
      assertEventSequence(snapshot.events, cancelRolloutId);
    },
  },
  cases: { "H-09": routePilotMigration },
  performance: routePilotPerformance,
};

async function routePilotPerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  let receiver = await ctx.receiver();
  assert.equal((await ctx.seed(routeScaleSeed(receiver.url))).exitCode, 0);
  let api = await ctx.startApi();
  const routeCount = Math.max(100, Math.ceil(100_000 * scale));
  const route = await fixedLoad(ctx, { count: routeCount, concurrency: 64, request: async (index) => {
    const requestIndex = 100_000 + index;
    const response = await ctx.mutate(api.baseUrl, "/api/v1/gateway/dispatch", `perf-route-${index}`, scaledGatewayRequest(requestIndex));
    if (response.status >= 200 && response.status < 300) {
      const expected = expectedCanary(requestIndex);
      assert.equal(find(response.json, "routeRevisionId"), expected.routeRevisionId);
      assert.equal(find(response.json, "backendVersion"), expected.backendVersion);
    }
    return response;
  } });
  assert.ok(route.throughput >= 700 && route.p95 <= 180, `route-match-steady ${route.throughput}/s p95=${route.p95}`);
  assert.equal(Object.entries(route.statuses).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((n, [, count]) => n + count, 0), 0);
  assertions.push(`route-match-steady ${route.throughput.toFixed(1)}/s p95 ${route.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  receiver = await ctx.receiver();
  assert.equal((await ctx.seed(seed(receiver.url, { version: "perf-route-limit", rateLimit: 1000 }))).exitCode, 0);
  api = await ctx.startApi();
  const apiB = await ctx.startApi();
  const limitCount = Math.max(100, Math.ceil(50_000 * scale));
  const limit = await fixedLoad(ctx, { count: limitCount, concurrency: 64, request: (index) => ctx.mutate(index % 2 ? api.baseUrl : apiB.baseUrl, "/api/v1/gateway/dispatch", `perf-limit-${index}`, gatewayRequest(200_000 + index)) });
  assert.ok(limit.throughput >= 500 && limit.p95 <= 250, `hot-tenant-limit ${limit.throughput}/s p95=${limit.p95}`);
  const accepted = Object.entries(limit.statuses).filter(([status]) => Number(status) >= 200 && Number(status) < 300).reduce((n, [, count]) => n + count, 0);
  assert.equal(accepted, Math.min(limitCount, 1000));
  assert.equal(limit.statuses[429] ?? 0, Math.max(0, limitCount - 1000));
  assert.equal(receiver.ledger.length, accepted, `rate window/upstream mismatch: ${receiver.ledger.length}/${accepted}`);
  const limitSnapshot = await ctx.snapshot(api.baseUrl);
  assert.ok(limitSnapshot.resources.rateWindows.every(({ consumed }) => consumed <= 1000));
  const limitUpstreamCalls = receiver.ledger.length;
  assertions.push(`hot-tenant-limit ${limit.throughput.toFixed(1)}/s p95 ${limit.p95.toFixed(1)}ms, upstream ${receiver.ledger.length}/1000`);

  await ctx.resetDatabase();
  let forceUpstreamFailure = false;
  receiver = await ctx.receiver((entry) => forceUpstreamFailure || entry.attempt % 2 === 0 ? { status: 500 } : { status: 204 });
  assert.equal((await ctx.seed(seed(receiver.url, { version: "perf-route-recovery" }))).exitCode, 0);
  api = await ctx.startApi();
  const recoveryApiB = await ctx.startApi();
  const recoveryCount = Math.max(100, Math.ceil(20_000 * scale));
  const hotWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  let activeVersion = 1;
  const releaseCount = Math.max(3, Math.ceil(100 * scale));
  const [recovery] = await Promise.all([
    fixedLoad(ctx, { count: recoveryCount, concurrency: 64, request: (index) => ctx.mutate(index % 2 ? api.baseUrl : recoveryApiB.baseUrl, "/api/v1/gateway/dispatch", `perf-breaker-${index}`, gatewayRequest(300_000 + index)) }),
    (async () => {
      for (let index = 0; index < releaseCount; index += 1) {
        const created = await ctx.mutate(index % 2 ? api.baseUrl : recoveryApiB.baseUrl, "/api/v1/config-releases", `perf-release-${index}`, {
          tenantId, version: activeVersion + 1, routeRevisionIds: [routeRevisionId], expectedActiveVersion: activeVersion,
        });
        assert.ok([200, 201, 202].includes(created.status), created.text);
        const configReleaseId = find(created.json, "configReleaseId");
        const activated = await ctx.waitFor(async () => {
          const snapshot = await ctx.snapshot(api.baseUrl);
          return snapshot.resources.configReleases.find((entry) => entry.configReleaseId === configReleaseId && entry.state === "ACTIVE");
        }, { timeoutMs: 60_000, label: `hot release ${index}`, children: hotWorkers });
        activeVersion = activated.version;
      }
    })(),
  ]);
  assert.ok(Object.keys(recovery.statuses).every((status) => (Number(status) >= 200 && Number(status) < 300) || [502, 503, 504].includes(Number(status))));
  assert.ok((recovery.statuses[503] ?? 0) > 0, "breaker never rejected an OPEN request");
  assert.ok(receiver.ledger.length < recoveryCount, "OPEN circuit did not suppress upstream calls");
  forceUpstreamFailure = true;
  let openingRequests = 0;
  let opened = false;
  while (openingRequests < 40 && !opened) {
    const response = await ctx.mutate(openingRequests % 2 ? api.baseUrl : recoveryApiB.baseUrl, "/api/v1/gateway/dispatch", `perf-open-${openingRequests}`, gatewayRequest(400_000 + openingRequests));
    openingRequests += 1;
    assert.ok((response.status >= 200 && response.status < 300) || [502, 503, 504].includes(response.status), response.text);
    opened = response.status === 503;
  }
  assert.ok(opened, "forced failures did not open the circuit");
  const openSnapshot = await ctx.snapshot(api.baseUrl);
  const openWindow = openSnapshot.resources.circuitWindows
    .filter(({ state }) => state === "OPEN")
    .sort((a, b) => Date.parse(b.openUntil) - Date.parse(a.openUntil))[0];
  assert.ok(openWindow && Number.isFinite(Date.parse(openWindow.openUntil)), "OPEN circuit has no finite openUntil");
  const untilHalfOpen = Date.parse(openWindow.openUntil) - Date.now() + 50;
  if (untilHalfOpen > 0) await new Promise((resolve) => setTimeout(resolve, untilHalfOpen));
  const callsBeforeProbe = receiver.ledger.length;
  const probeCount = 64;
  const probes = await fixedLoad(ctx, { count: probeCount, concurrency: 64, request: (index) => ctx.mutate(
    index % 2 ? api.baseUrl : recoveryApiB.baseUrl,
    "/api/v1/gateway/dispatch",
    `perf-half-open-${index}`,
    gatewayRequest(500_000 + index),
  ) });
  const halfOpenProbeCalls = receiver.ledger.length - callsBeforeProbe;
  assert.ok(halfOpenProbeCalls > 0 && halfOpenProbeCalls <= 2, `HALF_OPEN admitted ${halfOpenProbeCalls} upstream probes; maximum is 2`);
  assert.ok(Object.keys(probes.statuses).every((status) => (Number(status) >= 200 && Number(status) < 300) || [502, 503, 504].includes(Number(status))));
  assertions.push(`HALF_OPEN admitted ${halfOpenProbeCalls}/${probeCount} globally contended probes`);
  await Promise.all(hotWorkers.map((worker) => ctx.stop(worker)));
  const pending = await ctx.mutate(api.baseUrl, "/api/v1/config-releases", "perf-recovery-release", {
    tenantId, version: activeVersion + 1, routeRevisionIds: [routeRevisionId], expectedActiveVersion: activeVersion,
  });
  assert.ok([200, 201, 202].includes(pending.status), pending.text);
  const pendingReleaseId = find(pending.json, "configReleaseId");
  let releaseBarrier;
  const held = new Promise((resolve) => { releaseBarrier = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingReleaseId ? held : { status: 204 });
  const first = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "routepilot-perf" })));
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingReleaseId).length >= 2, { label: "two fenced release claims", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseBarrier({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  let final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.configReleases.some((entry) => entry.configReleaseId === pendingReleaseId && entry.state === "ACTIVE") && snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "release recovery drain", children: replacements });
  const durationMs = Date.now() - startedAt;
  const rollback = await ctx.mutate(api.baseUrl, `/api/v1/config-releases/${pendingReleaseId}/rollback`, "perf-rollback", { expectedActiveVersion: activeVersion + 1 });
  const rollbackId = find(rollback.json, "configReleaseId");
  final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.configReleases.some((entry) => entry.configReleaseId === rollbackId && entry.state === "ACTIVE") ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "rollback activation", children: replacements });
  assert.equal(final.resources.configReleases.filter(({ state }) => state === "ACTIVE").length, 1);
  assert.equal(new Set(final.resources.configReleases.map(({ version }) => version)).size, final.resources.configReleases.length);
  assert.equal(final.resources.gatewayRequests.length, recoveryCount + openingRequests + probeCount);
  assert.equal(new Set(final.resources.gatewayRequests.map(({ gatewayRequestId }) => gatewayRequestId)).size, final.resources.gatewayRequests.length);
  assert.equal(new Set(final.resources.upstreamAttempts.map(({ gatewayRequestId, attempt }) => `${gatewayRequestId}:${attempt}`)).size, final.resources.upstreamAttempts.length);
  assert.ok(final.resources.circuitWindows.every(({ sampleCount, failureCount }) => Number.isInteger(sampleCount) && Number.isInteger(failureCount) && failureCount >= 0 && failureCount <= sampleCount));
  assert.ok(final.resources.circuitWindows.every(({ state }) => ["CLOSED", "OPEN", "HALF_OPEN"].includes(state)));
  assert.equal(new Set(final.events.map(({ eventId }) => eventId)).size, final.events.length);
  assert.equal(new Set(final.work.map(({ workId }) => workId)).size, final.work.length);
  assert.ok(final.work.every(({ terminal }) => terminal));
  const rssBytes = (await Promise.all([api, recoveryApiB, ...replacements].map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  assertions.push(`breaker-reload-recovery ${recoveryCount} requests, ${releaseCount} hot releases and rollback, drained in ${durationMs}ms after two SIGKILLs`);
  return {
    metrics: [
      { scenarioId: "route-match-steady", ...route },
      { scenarioId: "hot-tenant-limit", ...limit, upstreamCalls: limitUpstreamCalls },
      { scenarioId: "breaker-reload-recovery", ...recovery, recoveryMs: durationMs, upstreamCalls: receiver.ledger.length, halfOpenProbeCalls, killedWorkers: 2, replacementWorkers: 4 },
    ],
    topology: { apiProcesses: 2, workers: 4 },
    rssBytes,
  };
}

export default standardAdapter(spec);
