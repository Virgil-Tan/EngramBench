// Policy revision: learning-final-system-2026-09-08.1. One FINAL submission; current public operations, persistence and restart recovery, not a historical binary upgrade.
import assert from "node:assert/strict";
import { canaryBucket, canonicalJson, chooseBackend, chooseRoute, assertEventSequence, assertReleaseAuthority, assertRequestIdentity } from "../oracles/index.mjs";
import { CaseExcluded } from "../lib/execution.mjs";
import {
  assertLoad,
  createRelease,
  defineCase,
  fixedLoad,
  gatewayPayload,
  guardedCase,
  prepare,
  resources,
  rollbackRelease,
  startUpstream,
  successful,
  waitRelease,
} from "./helpers.mjs";

function recordSet(items) { return new Set(items.map((item) => canonicalJson(item))); }
function assertRecordsPreserved(actual, expected, label) {
  const records = recordSet(actual);
  for (const item of expected) assert.ok(records.has(canonicalJson(item)), `${label} record changed during migration`);
}

function publicRoutes(seed) {
  const definitions = new Map(seed.routeDefinitions.map((item) => [item.routeId, item]));
  return seed.routeRevisions.map((revision) => ({ ...definitions.get(revision.routeId), ...revision }));
}

function assertRoutePilotInvariants(snapshot, { tenantId, expectedLimit, requestPrefix } = {}) {
  const value = resources(snapshot);
  assertReleaseAuthority(value.configReleases);
  assertRequestIdentity(value.gatewayRequests, value.upstreamAttempts);
  assertEventSequence(snapshot.events);
  assert.equal(new Set(snapshot.work.map((item) => item.workId)).size, snapshot.work.length, "Work identities unique");
  assert.equal(new Set(snapshot.events.map((item) => item.eventId)).size, snapshot.events.length, "Event identities unique");
  assert.ok(value.circuitWindows.every((item) => Number.isInteger(item.sampleCount) && Number.isInteger(item.failureCount) && item.failureCount >= 0 && item.failureCount <= item.sampleCount), "circuit counters conserved");
  assert.ok(value.circuitWindows.every((item) => ["CLOSED", "OPEN", "HALF_OPEN"].includes(item.state)), "circuit states published");
  if (expectedLimit !== undefined) assert.ok(value.rateWindows.filter((item) => !tenantId || item.tenantId === tenantId).every((item) => item.consumed >= 0 && item.consumed <= expectedLimit), "rate windows conserve limit");
  if (requestPrefix) {
    const selected = value.gatewayRequests.filter((item) => item.requestKey.startsWith(requestPrefix));
    assert.equal(new Set(selected.map((item) => item.gatewayRequestId)).size, selected.length, "load GatewayRequest identities unique");
  }
}

const E01 = guardedCase("E-01", ["MIGRATION_COMPATIBILITY", "STALE_WORK_OR_LOST_WORK"], async (ctx) => {
const upstream = await startUpstream(ctx, () => ({ status: 200, json: { retained: true } }));
  const fixture = ctx.fixtures.v1Final([upstream.baseUrl, upstream.baseUrl]);
  fixture.seed.tenants = [fixture.tenant];
  const initialRuntime = ctx;
  await initialRuntime.migrate(); await initialRuntime.seed(fixture.seed);
  const initialApi = await initialRuntime.startApi();
  const initialWorker = await initialRuntime.startWorker();
  const activated = await createRelease(ctx, initialApi.baseUrl, fixture, "e01-activate");
  await waitRelease(ctx, initialApi.baseUrl, activated.configReleaseId, { processes: [initialWorker] });
  const rolled = await rollbackRelease(ctx, initialApi.baseUrl, activated.configReleaseId, 2, "e01-rollback");
  const rollbackActive = await waitRelease(ctx, initialApi.baseUrl, rolled.configReleaseId, { processes: [initialWorker] });
  const activeVersion = rollbackActive.release.version;
  const dispatchPayload = gatewayPayload(fixture, 901, { requestKey: "e01-saved-dispatch" });
  const dispatchKey = ctx.key("e01-saved-dispatch");
  const savedDispatch = successful(await ctx.mutate(initialApi.baseUrl, "/api/v1/gateway/dispatch", dispatchKey, dispatchPayload), "base-system saved gateway response");
  await ctx.kill(initialWorker);
  const pendingBody = { tenantId: fixture.tenant.tenantId, version: activeVersion + 1, routeRevisionIds: fixture.seed.routeRevisions.map((item) => item.routeRevisionId), expectedActiveVersion: activeVersion };
  const pendingKey = ctx.key("e01-pending-release");
  const pending = successful(await ctx.mutate(initialApi.baseUrl, "/api/v1/config-releases", pendingKey, pendingBody), "base-system pending ConfigRelease");
  const pendingId = pending.json.configReleaseId;
  const barrier = await ctx.barrier({ hold: (value) => value.point === "worker.claimed" && value.aggregateId === pendingId });
  const staleWorker = await initialRuntime.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingId, { timeoutMs: 30_000, processes: [staleWorker] });
  const before = await ctx.snapshot(initialApi.baseUrl);
  const leased = before.work.find((item) => item.kind === "CONFIG_ACTIVATE" && item.aggregateId === pendingId);
  assert.equal(leased?.state, "LEASED", "base-system restart boundary contains leased activation Work");
  const beforeResources = Object.fromEntries(Object.entries(resources(before)).map(([key, items]) => [key, [...items]]));
  const beforeWork = [...before.work], beforeEvents = [...before.events];
  await ctx.kill(initialApi);

  await ctx.migrate();
  const apiFinal = await ctx.startApi();
  const after = await ctx.snapshot(apiFinal.baseUrl);
  for (const [key, expected] of Object.entries(beforeResources)) assertRecordsPreserved(resources(after)[key] ?? [], expected, key);
  assertRecordsPreserved(after.work, beforeWork, "Work");
  assertRecordsPreserved(after.events, beforeEvents, "Event");
  const replayRelease = successful(await ctx.mutate(apiFinal.baseUrl, "/api/v1/config-releases", pendingKey, pendingBody), "FINAL release replay");
  assert.equal(replayRelease.status, pending.status, "release replay status preserved");
  assert.equal(replayRelease.text, pending.text, "release replay bytes preserved");
  const replayDispatch = successful(await ctx.mutate(apiFinal.baseUrl, "/api/v1/gateway/dispatch", dispatchKey, dispatchPayload), "FINAL gateway replay");
  assert.equal(replayDispatch.status, savedDispatch.status, "gateway replay status preserved");
  assert.equal(replayDispatch.text, savedDispatch.text, "gateway replay bytes preserved");
  assert.equal(upstream.ledger.length, 1, "reinitialization replay makes no second upstream call");
  assert.deepEqual(resources(after).regionalRollouts, beforeResources.regionalRollouts, "current Rollouts survive restart");
  assert.deepEqual(resources(after).regionalStages, beforeResources.regionalStages, "current Stages survive restart");

  await new Promise((resolveWait) => setTimeout(resolveWait, 3_200));
  const replacement = await ctx.startWorker();
  const recovered = await waitRelease(ctx, apiFinal.baseUrl, pendingId, { processes: [replacement], timeoutMs: 60_000 });
  const recoveredWork = recovered.snapshot.work.find((item) => item.workId === leased.workId);
  assert.ok(recoveredWork?.terminal && recoveredWork.attempt >= leased.attempt, "replacement recovers preserved Work and stale owner is fenced");
  const eventsBeforeStale = recovered.snapshot.events.length;
  barrier.release(held);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  const afterStale = await ctx.snapshot(apiFinal.baseUrl);
  assert.equal(afterStale.events.length, eventsBeforeStale, "expired base-system lease emits no duplicate Event");
  assert.deepEqual(resources(afterStale).configReleases.find((item) => item.configReleaseId === pendingId), resources(recovered.snapshot).configReleases.find((item) => item.configReleaseId === pendingId), "expired base-system owner cannot rewrite active release");
  await ctx.kill(staleWorker);
  await ctx.stop(apiFinal); await ctx.stop(replacement);
  await ctx.migrate();
  const repeatedApi = await ctx.startApi();
  const repeated = await ctx.snapshot(repeatedApi.baseUrl);
  assert.deepEqual(resources(repeated).regionalRollouts, resources(afterStale).regionalRollouts, "repeat initialization preserves current Rollout identities");
  assert.deepEqual(resources(repeated).regionalStages, resources(afterStale).regionalStages, "repeat initialization preserves current Stage identities");
  ctx.mark("final-system.restart.closed", { pendingId, preservedRegionalRollouts: beforeResources.regionalRollouts.length });
  return ctx.pass();
});

function routeScaleFixture(ctx, origin) {
  const fixture = ctx.fixtures.operate([origin, origin]);
  const backends = Array.from({ length: 20 }, (_, index) => ({ backendId: ctx.uuid(`e02-backend-${index}`), tenantId: fixture.tenant.tenantId, name: `route-scale-v${index + 1}`, origin, state: "ACTIVE" }));
  const weighted = backends.map((item, index) => ({ backendId: item.backendId, version: `v${index + 1}`, weight: 500 }));
  const routeDefinitions = Array.from({ length: 250 }, (_, index) => ({ routeId: ctx.uuid(`e02-route-${index}`), tenantId: fixture.tenant.tenantId, name: `resource-${index}`, priority: 100 }));
  const routeRevisions = routeDefinitions.map((item, index) => ({ routeRevisionId: ctx.uuid(`e02-revision-${index}`), routeId: item.routeId, revision: 1, pathPattern: `/resource-${index}/:itemId`, methods: ["POST"], headerMatches: {}, backends: weighted, rateLimitPolicyId: fixture.rate.rateLimitPolicyId, circuitPolicyId: fixture.circuit.circuitPolicyId, createdAt: ctx.at() }));
  fixture.rate.limit = 200_000; fixture.rate.windowSeconds = 3_600;
  fixture.circuit.sampleSize = 200_000; fixture.circuit.failureThresholdPercent = 100;
  fixture.seed.backends = backends; fixture.seed.routeDefinitions = routeDefinitions; fixture.seed.routeRevisions = routeRevisions;
  fixture.seed.rateLimitPolicies = [fixture.rate]; fixture.seed.circuitPolicies = [fixture.circuit];
  fixture.seed.configReleases = [{ ...fixture.release, routeRevisionIds: routeRevisions.map((item) => item.routeRevisionId) }];
  return { ...fixture, backends, routeDefinitions, routeRevisions, weighted };
}

const E02 = guardedCase("E-02", ["ROUTE_AUTHORITY", "RATE_CIRCUIT_CONSERVATION"], async (ctx) => {
  const upstream = await startUpstream(ctx, (entry) => ({ status: 200, json: { path: entry.path } }));
  const fixture = routeScaleFixture(ctx, upstream.baseUrl);
  const { apis } = await prepare(ctx, fixture, { apiCount: 2, workerCount: 4 });
  for (let index = 0; index < 1_000; index += 1) {
    const routeIndex = index % 250;
    successful(await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`e02-warm-${index}`), { tenantId: fixture.tenant.tenantId, method: "POST", path: `/resource-${routeIndex}/${index}`, headers: { "x-route-affinity": `warm-${index}` }, body: { index }, requestKey: `e02-warm-${index}` }), "route warmup");
  }
  const count = 100_000;
  const routes = publicRoutes(fixture.seed);
  const expectedRoutes = Array.from({ length: 250 }, (_, routeIndex) => {
    const route = chooseRoute(routes, { method: "POST", path: `/resource-${routeIndex}/sample`, headers: {} });
    assert.ok(route, `route-match-steady oracle route ${routeIndex}`);
    return route;
  });
  const load = await fixedLoad(ctx, {
    count, concurrency: 64,
    request: async (index) => {
      const routeIndex = index % 250, affinity = `steady-${index}`;
      const payload = { tenantId: fixture.tenant.tenantId, method: "POST", path: `/resource-${routeIndex}/${index}`, headers: { "x-route-affinity": affinity }, body: { index }, requestKey: `e02-steady-${index}` };
      const expectedRoute = expectedRoutes[routeIndex];
      const expectedBackend = chooseBackend(expectedRoute.backends, canaryBucket(fixture.tenant.tenantId, expectedRoute.routeRevisionId, affinity));
      const response = await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`e02-steady-${index}`), payload);
      assert.equal(response.status, 200, `route-match-steady status ${index}`);
      assert.equal(response.json.routeRevisionId, expectedRoute.routeRevisionId, `route-match-steady route ${index}`);
      assert.equal(response.json.backendVersion, expectedBackend.version, `route-match-steady bucket ${index}`);
      return response;
    },
  });
  assertLoad(load, { count, minimumThroughput: 700, maximumP95: 180 });
  const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
  const measured = resources(snapshot).gatewayRequests.filter((item) => item.requestKey.startsWith("e02-steady-"));
  assert.equal(measured.length, count, "all 100000 measured decisions durable");
  assert.equal(upstream.ledger.length, count + 1_000, "every measured and warm request reached upstream once");
  assertRoutePilotInvariants(snapshot, { tenantId: fixture.tenant.tenantId, expectedLimit: fixture.rate.limit, requestPrefix: "e02-steady-" });
  ctx.mark("perf.route-match-steady", { count, routes: 250, backendVersions: 20, concurrency: 64, throughput: load.throughput, p95: load.p95 });
  return ctx.pass();
});

const E03 = guardedCase("E-03", ["RATE_CIRCUIT_CONSERVATION", "IDEMPOTENCY_CORRECTNESS"], async (ctx) => {
  const upstream = await startUpstream(ctx, () => ({ status: 200, json: { accepted: true } }));
  const fixture = ctx.fixtures.operate([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 1_000; fixture.rate.windowSeconds = 3_600;
  fixture.circuit.sampleSize = 100_000; fixture.circuit.failureThresholdPercent = 100;
  const { apis } = await prepare(ctx, fixture, { apiCount: 2, workerCount: 4 });
  const count = 50_000;
  let allowed = 0, throttled = 0;
  const load = await fixedLoad(ctx, {
    count, concurrency: 64,
    request: async (index) => {
      const response = await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`e03-hot-${index}`), gatewayPayload(fixture, index, { requestKey: `e03-hot-${index}` }));
      if (response.status === 200) allowed += 1;
      else if (response.status === 429 && response.json?.error?.code === "RATE_LIMITED") throttled += 1;
      else assert.fail(`unexpected hot-tenant response ${response.status}: ${response.text}`);
      return response;
    },
  });
  assertLoad(load, { count, minimumThroughput: 500, maximumP95: 250, acceptedStatuses: [200, 429] });
  assert.equal(allowed, 1_000, "exact shared token allowance");
  assert.equal(throttled, 49_000, "exact shared throttles");
  assert.equal(upstream.ledger.length, 1_000, "throttles make no upstream call");
  const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
  const windows = resources(snapshot).rateWindows.filter((item) => item.tenantId === fixture.tenant.tenantId && item.rateLimitPolicyId === fixture.rate.rateLimitPolicyId);
  assert.equal(windows.length, 1, "one shared fixed RateWindow");
  assert.equal(windows[0].consumed, 1_000, "RateWindow exact final consumption");
  assertRoutePilotInvariants(snapshot, { tenantId: fixture.tenant.tenantId, expectedLimit: 1_000, requestPrefix: "e03-hot-" });
  ctx.mark("perf.hot-tenant-limit", { count, tokens: 1_000, concurrency: 64, allowed, throttled, throughput: load.throughput, p95: load.p95 });
  return ctx.pass();
});

function addSecondTenantAuthority(ctx, fixture, origin) {
  const tenant = fixture.otherTenant;
  const backend = { backendId: ctx.uuid("e04-other-backend"), tenantId: tenant.tenantId, name: "other-v1", origin, state: "ACTIVE" };
  const rate = { ...fixture.rate, rateLimitPolicyId: ctx.uuid("e04-other-rate"), tenantId: tenant.tenantId };
  const circuit = { ...fixture.circuit, circuitPolicyId: ctx.uuid("e04-other-circuit"), tenantId: tenant.tenantId };
  const definition = { routeId: ctx.uuid("e04-other-route"), tenantId: tenant.tenantId, name: "other-orders", priority: 100 };
  const revision = { routeRevisionId: ctx.uuid("e04-other-revision"), routeId: definition.routeId, revision: 1, pathPattern: "/orders/:orderId", methods: ["POST"], headerMatches: {}, backends: [{ backendId: backend.backendId, version: "v1", weight: 10_000 }], rateLimitPolicyId: rate.rateLimitPolicyId, circuitPolicyId: circuit.circuitPolicyId, createdAt: ctx.at() };
  const release = { configReleaseId: ctx.uuid("e04-other-release"), tenantId: tenant.tenantId, version: 1, state: "ACTIVE", routeRevisionIds: [revision.routeRevisionId], priorReleaseId: null, createdAt: ctx.at(), activatedAt: ctx.at() };
  fixture.seed.backends.push(backend); fixture.seed.rateLimitPolicies.push(rate); fixture.seed.circuitPolicies.push(circuit); fixture.seed.routeDefinitions.push(definition); fixture.seed.routeRevisions.push(revision); fixture.seed.configReleases.push(release);
  return { tenant, revision, release };
}

const E04 = guardedCase("E-04", ["STALE_WORK_OR_LOST_WORK", "RELEASE_ATOMICITY", "RATE_CIRCUIT_CONSERVATION"], async (ctx) => {
  const upstream = await startUpstream(ctx, (entry) => entry.ordinal % 2 === 0 ? { status: 500, json: { failed: entry.ordinal } } : { status: 200, json: { succeeded: entry.ordinal } });
  const fixture = ctx.fixtures.operate([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 30_000; fixture.rate.windowSeconds = 3_600;
  fixture.circuit.sampleSize = 100_000; fixture.circuit.failureThresholdPercent = 100;
  const other = addSecondTenantAuthority(ctx, fixture, upstream.baseUrl);
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const primaryRevisionIds = [fixture.definition.revision.routeRevisionId];
  const primaryPending = await createRelease(ctx, apis[0].baseUrl, fixture, "e04-primary-recovery", { routeRevisionIds: primaryRevisionIds });
  const otherPendingBody = { tenantId: other.tenant.tenantId, version: 2, routeRevisionIds: [other.revision.routeRevisionId], expectedActiveVersion: 1 };
  const otherPendingResponse = successful(await ctx.mutate(apis[1].baseUrl, "/api/v1/config-releases", ctx.key("e04-other-recovery"), otherPendingBody), "other tenant recovery release");
  const otherPendingId = otherPendingResponse.json.configReleaseId;
  const recoveryIds = new Set([primaryPending.configReleaseId, otherPendingId]);
  const barrier = await ctx.barrier({ hold: (value) => value.point === "worker.claimed" && recoveryIds.has(value.aggregateId) });
  const victims = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } })));
  await barrier.waitFor(() => {
    const claims = barrier.ledger.filter((item) => item.json?.point === "worker.claimed" && recoveryIds.has(item.json.aggregateId));
    return new Set(claims.map((item) => item.json.aggregateId)).size === 2;
  }, { timeoutMs: 30_000, processes: victims });
  const leasedSnapshot = await ctx.snapshot(apis[0].baseUrl);
  assert.equal(leasedSnapshot.work.filter((item) => recoveryIds.has(item.aggregateId) && item.state === "LEASED").length, 2, "two distinct release Work leases held");

  const trafficPromise = fixedLoad(ctx, {
    count: 20_000, concurrency: 64,
    request: async (index) => {
      const response = await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`e04-result-${index}`), gatewayPayload(fixture, index, { requestKey: `e04-result-${index}` }));
      assert.equal(response.status, 200, `mixed result wrapper ${index}`);
      assert.equal(response.json.routeRevisionId, fixture.definition.revision.routeRevisionId, `mixed result frozen revision ${index}`);
      assert.ok([200, 500].includes(response.json.responseStatus), `mixed result status ${index}`);
      return response;
    },
  });
  await Promise.all(victims.map((worker) => ctx.kill(worker)));
  barrier.releaseAll();
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_200));
  const recoveryStarted = performance.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const recovered = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
    const releases = resources(snapshot).configReleases;
    const bothActive = releases.some((item) => item.configReleaseId === primaryPending.configReleaseId && item.state === "ACTIVE") && releases.some((item) => item.configReleaseId === otherPendingId && item.state === "ACTIVE");
    const work = snapshot.work.filter((item) => recoveryIds.has(item.aggregateId));
    return bothActive && work.length === 2 && work.every((item) => item.terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, intervalMs: 50, label: "two killed release claims recovered", processes: replacements });
  const recoveryMs = performance.now() - recoveryStarted;
  assert.ok(recoveryMs <= 60_000, "recovery drain within 60 seconds");
  assert.equal(recovered.work.filter((item) => recoveryIds.has(item.aggregateId)).every((item) => item.attempt >= 2), true, "killed leases reclaimed with monotonic attempts");

  let activeReleaseId = primaryPending.configReleaseId;
  let activeVersion = 2;
  for (let index = 0; index < 49; index += 1) {
    const release = await createRelease(ctx, apis[index % 2].baseUrl, fixture, `e04-cycle-release-${index}`, { expectedActiveVersion: activeVersion, routeRevisionIds: primaryRevisionIds });
    const active = await waitRelease(ctx, apis[0].baseUrl, release.configReleaseId, { processes: replacements, timeoutMs: 60_000 });
    activeReleaseId = release.configReleaseId; activeVersion = active.release.version;
    const rollback = await rollbackRelease(ctx, apis[(index + 1) % 2].baseUrl, activeReleaseId, activeVersion, `e04-cycle-rollback-${index}`);
    const rolled = await waitRelease(ctx, apis[0].baseUrl, rollback.configReleaseId, { processes: replacements, timeoutMs: 60_000 });
    activeReleaseId = rollback.configReleaseId; activeVersion = rolled.release.version;
  }
  const load = await trafficPromise;
  assert.equal(Object.values(load.statuses).reduce((sum, value) => sum + value, 0), 20_000, "complete 20000-result workload");
  assert.equal(upstream.ledger.length, 20_000, "all mixed results reached upstream");
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 30_000 });
    return snapshot.work.every((item) => item.terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, intervalMs: 100, label: "all release and rollback Work terminal", processes: replacements });
  const createdTransitions = resources(final).configReleases.length - 2;
  assert.equal(createdTransitions, 100, "exact 100 atomic release/rollback transitions");
  assert.equal(resources(final).configReleases.filter((item) => item.state === "ACTIVE").length, 2, "one ACTIVE release per tenant");
  assert.equal(resources(final).configReleases.find((item) => item.configReleaseId === activeReleaseId)?.state, "ACTIVE", "last primary transition is authoritative");
  assertRoutePilotInvariants(final, { tenantId: fixture.tenant.tenantId, expectedLimit: fixture.rate.limit, requestPrefix: "e04-result-" });
  const resultRequestIds = new Set(resources(final).gatewayRequests.filter((request) => request.requestKey.startsWith("e04-result-")).map((request) => request.gatewayRequestId));
  const attempts = resources(final).upstreamAttempts.filter((item) => resultRequestIds.has(item.gatewayRequestId));
  assert.equal(attempts.length, 20_000, "one attempt per mixed result");
  assert.equal(attempts.filter((item) => item.outcome === "SUCCEEDED").length, 10_000, "mixed success result count");
  assert.equal(attempts.filter((item) => item.outcome === "FAILED").length, 10_000, "mixed failure result count");
  ctx.mark("perf.breaker-reload-recovery", { results: 20_000, releaseTransitions: 100, killedWorkers: 2, replacementWorkers: 4, recoveryMs });
  return ctx.pass();
});

export const E_CASES = [E01, E02, E03, E04];
