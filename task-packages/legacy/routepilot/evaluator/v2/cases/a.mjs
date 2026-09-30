import assert from "node:assert/strict";
import { canaryBucket, chooseBackend, chooseRoute } from "../oracles/index.mjs";
import {
  assertRolloutDetail,
  createRelease,
  createRollout,
  defineCase,
  dispatch,
  gatewayPayload,
  getRollout,
  guardedCase,
  prepare,
  resources,
  semanticError,
  startUpstream,
  successful,
  waitRelease,
} from "./helpers.mjs";

function publicRoutes(fixture) {
  return fixture.definitions.map(({ routeId, priority, revision }) => ({ routeId, priority, ...revision }));
}

const A01 = guardedCase("A-01", ["ROUTE_AUTHORITY"], async (ctx) => {
  const upstream = await startUpstream(ctx, (entry) => ({ status: 200, json: { path: entry.path, method: entry.method } }));
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const samples = [
    { method: "POST", path: "/orders/special", affinity: "literal" },
    { method: "POST", path: "/orders/123", affinity: "parameter" },
    { method: "POST", path: "/orders/123/items/9", affinity: "wildcard" },
    { method: "GET", path: "/orders/123/items/9", affinity: "priority-wildcard" },
  ];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const payload = gatewayPayload(fixture, index, { method: sample.method, path: sample.path, headers: { "x-route-affinity": sample.affinity }, requestKey: `a01-${index}` });
    const expected = chooseRoute(publicRoutes(fixture), payload);
    assert.ok(expected, `route oracle for ${sample.path}`);
    const response = successful(await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`a01-${index}`), payload), "route dispatch");
    assert.equal(response.json.routeRevisionId, expected.routeRevisionId, `route selection ${sample.path}`);
    assert.equal(response.json.body.path, sample.path, "upstream observes original path");
  }
  assert.equal(upstream.ledger.length, samples.length, "one upstream call per selected request");
  for (const badPath of ["/orders//1", "/orders/%2Fsecret", "/orders/%ZZ", "/orders/../admin"]) {
    const rejected = await dispatch(ctx, apis[0].baseUrl, fixture, `bad-${badPath}`, { path: badPath, requestKey: `bad-${Buffer.from(badPath).toString("hex")}` }, { expectSuccess: false });
    semanticError(rejected.response, 400, "INVALID_REQUEST");
  }
  const other = await dispatch(ctx, apis[1].baseUrl, fixture, 99, { tenantId: fixture.otherTenant.tenantId, requestKey: "a01-other" }, { expectSuccess: false });
  semanticError(other.response, 404, "NO_ACTIVE_RELEASE");
  assert.equal(upstream.ledger.length, samples.length, "invalid and cross-tenant requests never call upstream");
  ctx.mark("route.precedence.closed", { sampleCount: samples.length });
  return ctx.pass();
});

const A02 = guardedCase("A-02", ["ROUTE_AUTHORITY", "RELEASE_ATOMICITY"], async (ctx) => {
  const upstream = await startUpstream(ctx, () => ({ status: 200, json: { selected: true } }));
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 100;
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const routeRevision = fixture.seed.routeRevisions.find((item) => item.pathPattern === "/orders/:orderId");
  const affinities = new Map();
  for (let index = 0; affinities.size < 2 && index < 1_000_000; index += 1) {
    const affinity = `bucket-${index}`, bucket = canaryBucket(fixture.tenant.tenantId, routeRevision.routeRevisionId, affinity);
    if (bucket < 8_000 && !affinities.has("v1")) affinities.set("v1", { affinity, bucket });
    if (bucket >= 8_000 && !affinities.has("v2")) affinities.set("v2", { affinity, bucket });
  }
  assert.equal(affinities.size, 2, "fixture finds both weighted intervals");
  const beforeIds = [];
  for (const [version, sample] of affinities) {
    const payload = gatewayPayload(fixture, version, { path: "/orders/42", headers: { "x-route-affinity": sample.affinity }, requestKey: `a02-${version}` });
    const expected = chooseBackend(routeRevision.backends, sample.bucket);
    const response = successful(await ctx.mutate(apis[version === "v1" ? 0 : 1].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`a02-${version}`), payload), "canary dispatch");
    assert.equal(response.json.backendVersion, expected.version, `canary ${version}`);
    assert.equal(response.json.routeRevisionId, routeRevision.routeRevisionId, "frozen RouteRevision");
    beforeIds.push(response.json.gatewayRequestId);
    const replay = successful(await ctx.mutate(apis[1].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`a02-${version}`), payload), "cross-process canary replay");
    assert.deepEqual(replay.json, response.json, "canary replay response stable");
  }
  const release = await createRelease(ctx, apis[0].baseUrl, fixture, "a02");
  const worker = await ctx.startWorker();
  await waitRelease(ctx, apis[0].baseUrl, release.configReleaseId, { processes: [worker] });
  const afterPayload = gatewayPayload(fixture, 200, { path: "/orders/42", headers: { "x-route-affinity": affinities.get("v2").affinity }, requestKey: "a02-after-release" });
  const after = successful(await ctx.mutate(apis[0].baseUrl, "/api/v1/gateway/dispatch", ctx.key("a02-after-release"), afterPayload), "post-release dispatch");
  assert.equal(after.json.backendVersion, "v2", "same hash survives release activation");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  for (const gatewayRequestId of beforeIds) {
    const request = resources(snapshot).gatewayRequests.find((item) => item.gatewayRequestId === gatewayRequestId);
    assert.equal(request.configReleaseId, fixture.release.configReleaseId, "pre-release request remains frozen to old release");
  }
  ctx.mark("canary.identity.closed", { affinities: Object.fromEntries(affinities) });
  return ctx.pass();
});

const A03 = guardedCase("A-03", ["RATE_CIRCUIT_CONSERVATION", "IDEMPOTENCY_CORRECTNESS"], async (ctx) => {
  const upstream = await startUpstream(ctx, () => ({ status: 200, json: { ok: true } }));
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 3;
  fixture.rate.windowSeconds = 1;
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const responses = [];
  for (let index = 0; index < 5; index += 1) responses.push((await dispatch(ctx, apis[index % 2].baseUrl, fixture, 300 + index, { path: "/orders/42", requestKey: `a03-${index}` }, { expectSuccess: false })).response);
  assert.equal(responses.filter((item) => item.status === 200).length, 3, "exact window allowance");
  assert.equal(responses.filter((item) => item.status === 429 && item.json?.error?.code === "RATE_LIMITED").length, 2, "exact window throttle");
  assert.equal(upstream.ledger.length, 3, "throttles never call upstream");
  const firstPayload = gatewayPayload(fixture, 300, { path: "/orders/42", requestKey: "a03-0" });
  const replay = successful(await ctx.mutate(apis[1].baseUrl, "/api/v1/gateway/dispatch", ctx.key("dispatch:a03-0"), firstPayload), "rate replay");
  assert.equal(replay.json.gatewayRequestId, responses[0].json.gatewayRequestId, "replay identity stable");
  assert.equal(upstream.ledger.length, 3, "replay consumes no token or upstream call");
  const retryAfter = Number(responses.find((item) => item.status === 429).headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 0, "Retry-After published");
  await new Promise((resolveWait) => setTimeout(resolveWait, Math.max(1, retryAfter) * 1_000 + 50));
  const rolled = await dispatch(ctx, apis[0].baseUrl, fixture, 399, { path: "/orders/42", requestKey: "a03-next-window" });
  assert.equal(rolled.response.status, 200, "next database-time window accepts");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  assert.ok(resources(snapshot).rateWindows.every((item) => item.tenantId !== fixture.tenant.tenantId || item.consumed <= 3), "every RateWindow conserves limit");
  assert.equal(resources(snapshot).rateWindows.filter((item) => item.tenantId === fixture.otherTenant.tenantId).length, 0, "tenant windows isolated");
  ctx.mark("rate.window.closed", { allowed: 4, throttled: 2 });
  return ctx.pass();
});

const A04 = guardedCase("A-04", ["RATE_CIRCUIT_CONSERVATION", "ROUTE_AUTHORITY"], async (ctx) => {
  let upstreamAttempt = 0;
  const upstream = await startUpstream(ctx, () => {
    upstreamAttempt += 1;
    return upstreamAttempt <= 2 ? { status: 500, json: { failed: upstreamAttempt } } : { status: 200, json: { ok: upstreamAttempt } };
  });
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 100;
  fixture.circuit.openSeconds = 1;
  for (const revision of fixture.seed.routeRevisions) revision.backends = [{ ...revision.backends[0], weight: 10_000 }];
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  for (let index = 0; index < 4; index += 1) {
    const response = (await dispatch(ctx, apis[index % 2].baseUrl, fixture, 400 + index, { path: "/orders/42", requestKey: `a04-${index}` }, { expectSuccess: false })).response;
    assert.equal(response.status, 200, "upstream result is a committed gateway response");
    assert.equal(response.json.responseStatus, index < 2 ? 500 : 200, "upstream status recorded");
  }
  const open = (await dispatch(ctx, apis[0].baseUrl, fixture, 405, { path: "/orders/42", requestKey: "a04-open" }, { expectSuccess: false })).response;
  semanticError(open, 503, "CIRCUIT_OPEN");
  assert.equal(upstream.ledger.length, 4, "OPEN circuit performs no upstream call");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_050));
  const probes = await Promise.all([0, 1].map((index) => dispatch(ctx, apis[index].baseUrl, fixture, 410 + index, { path: "/orders/42", requestKey: `a04-probe-${index}` }, { expectSuccess: false })));
  assert.ok(probes.every(({ response }) => response.status === 200), "bounded successful HALF_OPEN probes");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  const windows = resources(snapshot).circuitWindows.filter((item) => item.tenantId === fixture.tenant.tenantId);
  assert.ok(windows.length > 0 && windows.some((item) => item.state === "CLOSED"), "successful probe set closes circuit");
  assert.ok(windows.every((item) => item.sampleCount >= 0 && item.failureCount >= 0), "circuit counters non-negative");
  ctx.mark("circuit.state.closed", { upstreamCalls: upstream.ledger.length });
  return ctx.pass();
});

const A05 = guardedCase("A-05", ["RELEASE_ATOMICITY", "STALE_WORK_OR_LOST_WORK"], async (ctx) => {
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.rollout([upstream.baseUrl, upstream.baseUrl]);
  const { api } = await prepare(ctx, fixture);
  const created = await createRollout(ctx, api.baseUrl, fixture, "a05");
  assert.equal(created.response.status, 200, "RegionalRollout create default status");
  const detail = await getRollout(ctx, api.baseUrl, created.regionalRolloutId);
  assertRolloutDetail(detail, fixture);
  assert.deepEqual(detail.stages.map(({ region, minimumObservationSeconds, failureThresholdPercent }) => ({ region, minimumObservationSeconds, failureThresholdPercent })), [
    { region: "us-east", minimumObservationSeconds: 10, failureThresholdPercent: 5 },
    { region: "eu-west", minimumObservationSeconds: 20, failureThresholdPercent: 10 },
    { region: "ap-south", minimumObservationSeconds: 30, failureThresholdPercent: 15 },
  ], "duplicate region keeps first parameters");
  assert.ok(detail.stages.filter((item) => item.state === "ACTIVE").length <= 1, "at most current stage ACTIVE");
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.work.filter((item) => item.kind === "REGIONAL_ROLLOUT_ADVANCE" && item.aggregateId === created.regionalRolloutId).length, 1, "one rollout advance Work");
  const beforeInvalid = await ctx.snapshot(api.baseUrl);
  const invalid = await ctx.mutate(api.baseUrl, "/api/v1/regional-rollouts", ctx.key("rollout:a05-invalid"), {
    tenantId: fixture.tenant.tenantId,
    targetConfigReleaseId: fixture.target.configReleaseId,
    stages: [{ region: "invalid", minimumObservationSeconds: 0, failureThresholdPercent: 101 }],
    requestRef: "invalid-range",
  });
  semanticError(invalid, 400, "INVALID_REQUEST");
  const afterInvalid = await ctx.snapshot(api.baseUrl);
  assert.equal(resources(afterInvalid).regionalRollouts.length, resources(beforeInvalid).regionalRollouts.length, "invalid request leaves no Rollout");
  assert.equal(resources(afterInvalid).regionalStages.length, resources(beforeInvalid).regionalStages.length, "invalid request leaves no Stage");
  assert.equal(afterInvalid.work.length, beforeInvalid.work.length, "invalid request leaves no Work");
  assert.equal(afterInvalid.events.length, beforeInvalid.events.length, "invalid request leaves no Event");
  ctx.mark("rollout.freeze.closed", { regionalRolloutId: created.regionalRolloutId, stageCount: detail.stages.length });
  return ctx.pass({ blockedAssertions: [ctx.diagnostic("RP-A05-AUTO-ADVANCE", "SPEC-GAP-RP-01")] });
});

export const A_CASES = [A01, A02, A03, A04, A05];
