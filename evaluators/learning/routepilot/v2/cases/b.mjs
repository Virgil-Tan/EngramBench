import assert from "node:assert/strict";
import { canaryBucket } from "../oracles/index.mjs";
import {
  controlRollout,
  createRelease,
  createRollout,
  dispatch,
  findField,
  fixedLoad,
  gatewayPayload,
  getRollout,
  guardedCase,
  prepare,
  resources,
  rollbackRelease,
  semanticError,
  startUpstream,
  successful,
  waitRelease,
  waitWork,
} from "./helpers.mjs";

export function assertPublicationRequestRoutes(requests, releases, attempts) {
  const revisionSets = new Map(releases.map((item) => [item.configReleaseId, new Set(item.routeRevisionIds)]));
  for (const request of requests) {
    assert.ok(revisionSets.has(request.configReleaseId), "request retains one known frozen release");
    if (request.routeRevisionId !== null) {
      assert.ok(revisionSets.get(request.configReleaseId).has(request.routeRevisionId), "request revision belongs to one complete frozen release");
    } else {
      assert.equal(request.status, "REJECTED", "a request without a route is rejected");
      assert.equal(request.responseStatus, 404, "publication traffic without a route records ROUTE_NOT_FOUND");
      assert.equal(attempts.some((item) => item.gatewayRequestId === request.gatewayRequestId), false, "a request without a route makes no upstream attempt");
    }
  }
}

const B01 = guardedCase("B-01", ["RELEASE_ATOMICITY", "ROUTE_AUTHORITY"], async (ctx) => {
  const upstream = await startUpstream(ctx, () => ({ status: 200, json: { ok: true } }));
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 1_000;
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const onlyParam = fixture.seed.routeRevisions.find((item) => item.pathPattern === "/orders/:orderId");
  const release = await createRelease(ctx, apis[0].baseUrl, fixture, "b01", { routeRevisionIds: [onlyParam.routeRevisionId] });
  const traffic = ctx.concurrent(Array.from({ length: 80 }), 16, async (_, index) => {
    const payload = gatewayPayload(fixture, index, { path: index % 2 ? "/orders/42" : "/orders/42/items/9", requestKey: `b01-${index}` });
    return ctx.mutate(apis[index % 2].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`b01-${index}`), payload);
  });
  const worker = await ctx.startWorker();
  await waitRelease(ctx, apis[0].baseUrl, release.configReleaseId, { processes: [worker] });
  const results = await traffic;
  assert.ok(results.every((item) => item.status === 200 || (item.status === 404 && item.json?.error?.code === "ROUTE_NOT_FOUND")), "traffic sees complete old or new release");
  const afterActivation = await ctx.snapshot(apis[0].baseUrl);
  assertPublicationRequestRoutes(resources(afterActivation).gatewayRequests.filter((item) => item.requestKey.startsWith("b01-")), resources(afterActivation).configReleases, resources(afterActivation).upstreamAttempts);
  const rolled = await rollbackRelease(ctx, apis[1].baseUrl, release.configReleaseId, 2, "b01");
  await waitRelease(ctx, apis[0].baseUrl, rolled.configReleaseId, { processes: [worker] });
  const final = await ctx.snapshot(apis[0].baseUrl);
  const active = resources(final).configReleases.filter((item) => item.tenantId === fixture.tenant.tenantId && item.state === "ACTIVE");
  assert.equal(active.length, 1, "one ACTIVE release after rollback");
  assert.deepEqual(new Set(active[0].routeRevisionIds), new Set(fixture.release.routeRevisionIds), "rollback copies prior immutable revision set");
  assert.ok(resources(final).configReleases.find((item) => item.configReleaseId === release.configReleaseId).state !== "ACTIVE", "superseded release history retained");
  ctx.mark("release.atomic-publication", { activated: release.configReleaseId, rollback: rolled.configReleaseId });
  return ctx.pass();
});

const B02 = guardedCase("B-02", ["IDEMPOTENCY_CORRECTNESS", "RELEASE_ATOMICITY"], async (ctx) => {
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const body = {
    tenantId: fixture.tenant.tenantId,
    version: 2,
    routeRevisionIds: fixture.seed.routeRevisions.map((item) => item.routeRevisionId),
    expectedActiveVersion: 1,
  };
  const key = ctx.key("b02-release");
  const shield = await ctx.responseShield(apis[0].baseUrl);
  shield.dropNextMutation();
  await assert.rejects(ctx.mutate(shield.baseUrl, "/api/v1/config-releases", key, body), "release response is lost after commit");
  const committed = shield.captures.find((item) => item.dropped);
  assert.ok(committed && committed.response.status >= 200 && committed.response.status < 300, "upstream committed release before loss");
  const replay = successful(await ctx.mutate(apis[1].baseUrl, "/api/v1/config-releases", key, body), "lost release replay");
  assert.equal(replay.status, committed.response.status, "release replay status exact");
  assert.equal(replay.text, committed.response.body, "release replay body exact");
  const conflict = await ctx.mutate(apis[0].baseUrl, "/api/v1/config-releases", key, { ...body, routeRevisionIds: body.routeRevisionIds.slice(0, 1) });
  semanticError(conflict, 409, "IDEMPOTENCY_CONFLICT");
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/config-releases", key, body)));
  assert.ok(concurrent.every((item) => item.status === replay.status && item.text === replay.text), "concurrent release replay exact");
  await ctx.stop(apis[0]);
  const restarted = await ctx.startApi();
  const restartReplay = successful(await ctx.mutate(restarted.baseUrl, "/api/v1/config-releases", key, body), "restart release replay");
  assert.equal(restartReplay.text, replay.text, "restart replay exact");
  const configReleaseId = findField(replay.json, "configReleaseId");
  const snapshot = await ctx.snapshot(restarted.baseUrl);
  assert.equal(resources(snapshot).configReleases.filter((item) => item.configReleaseId === configReleaseId).length, 1, "one release resource");
  assert.equal(snapshot.work.filter((item) => item.kind === "CONFIG_ACTIVATE" && item.aggregateId === configReleaseId).length, 1, "one activation Work");
  ctx.mark("release.replay.closed", { configReleaseId });
  return ctx.pass();
});

const B03 = guardedCase("B-03", ["RATE_CIRCUIT_CONSERVATION"], async (ctx) => {
  const upstream = await startUpstream(ctx, () => ({ status: 200, json: { ok: true } }));
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 100;
  fixture.rate.windowSeconds = 60;
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const load = await fixedLoad(ctx, {
    count: 160,
    concurrency: 64,
    collectResponses: true,
    request: (index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/gateway/dispatch", ctx.key(`b03-${index}`), gatewayPayload(fixture, index, { path: "/orders/42", requestKey: `b03-${index}` })),
  });
  assert.equal(load.responses.filter((item) => item.status === 200).length, 100, "global shared tokens exact");
  assert.equal(load.responses.filter((item) => item.status === 429 && item.json?.error?.code === "RATE_LIMITED").length, 60, "global throttles exact");
  assert.equal(upstream.ledger.length, 100, "throttles make no upstream calls");
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  const windows = resources(snapshot).rateWindows.filter((item) => item.tenantId === fixture.tenant.tenantId && item.rateLimitPolicyId === fixture.rate.rateLimitPolicyId);
  assert.equal(windows.length, 1, "one shared hot RateWindow");
  assert.equal(windows[0].consumed, 100, "shared RateWindow exact conservation");
  ctx.mark("rate.contention.closed", { allowed: 100, throttled: 60 });
  return ctx.pass();
});

const B04 = guardedCase("B-04", ["RATE_CIRCUIT_CONSERVATION", "ROUTE_AUTHORITY", "RELEASE_ATOMICITY"], async (ctx) => {
  let releaseHeld;
  const held = new Promise((resolve) => { releaseHeld = resolve; });
  let first = true;
  const upstream = await startUpstream(ctx, async () => {
    if (first) { first = false; await held; return { status: 500, json: { oldFailure: true } }; }
    return { status: 200, json: { current: true } };
  });
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 100;
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const oldRoute = fixture.seed.routeRevisions.find((item) => item.pathPattern === "/orders/:orderId");
  const oldAffinity = (() => { for (let index = 0; ; index += 1) { const value = `old-${index}`; if (canaryBucket(fixture.tenant.tenantId, oldRoute.routeRevisionId, value) < 8_000) return value; } })();
  const oldPayload = gatewayPayload(fixture, 1, { path: "/orders/42", headers: { "x-route-affinity": oldAffinity }, requestKey: "b04-old" });
  const oldRequest = ctx.mutate(apis[0].baseUrl, "/api/v1/gateway/dispatch", ctx.key("b04-old"), oldPayload);
  await ctx.waitFor(() => upstream.ledger.length === 1, { label: "old release upstream in flight" });
  const revisionResponse = successful(await ctx.mutate(apis[1].baseUrl, "/api/v1/route-revisions", ctx.key("b04-revision"), {
    routeId: oldRoute.routeId,
    revision: 2,
    pathPattern: oldRoute.pathPattern,
    methods: oldRoute.methods,
    headerMatches: oldRoute.headerMatches,
    backends: [{ ...oldRoute.backends[1], weight: 10_000 }],
    rateLimitPolicyId: oldRoute.rateLimitPolicyId,
    circuitPolicyId: oldRoute.circuitPolicyId,
  }));
  const newRevisionId = findField(revisionResponse.json, "routeRevisionId");
  const release = await createRelease(ctx, apis[1].baseUrl, fixture, "b04", { routeRevisionIds: [newRevisionId] });
  const worker = await ctx.startWorker();
  await waitRelease(ctx, apis[1].baseUrl, release.configReleaseId, { processes: [worker] });
  releaseHeld();
  const oldResponse = successful(await oldRequest, "old in-flight gateway result");
  assert.equal(oldResponse.json.responseStatus, 500, "late old failure committed to old request");
  const current = await ctx.mutate(apis[1].baseUrl, "/api/v1/gateway/dispatch", ctx.key("b04-new"), gatewayPayload(fixture, 2, { path: "/orders/42", requestKey: "b04-new" }));
  successful(current, "new release request");
  assert.equal(current.json.routeRevisionId, newRevisionId, "new request uses new RouteRevision");
  assert.equal(current.json.backendVersion, "v2", "new release uses its frozen backend");
  const snapshot = await ctx.snapshot(apis[1].baseUrl);
  const oldStored = resources(snapshot).gatewayRequests.find((item) => item.gatewayRequestId === oldResponse.json.gatewayRequestId);
  assert.equal(oldStored.configReleaseId, fixture.release.configReleaseId, "late result retains old release");
  assert.equal(oldStored.routeRevisionId, oldRoute.routeRevisionId, "late result retains old revision");
  const newBackendId = oldRoute.backends[1].backendId;
  assert.ok(resources(snapshot).circuitWindows.filter((item) => item.backendId === newBackendId).every((item) => item.state !== "OPEN"), "old failure does not open new backend circuit");
  ctx.mark("breaker.reload.isolated", { oldRevision: oldRoute.routeRevisionId, newRevision: newRevisionId });
  return ctx.pass();
});

const B05 = guardedCase("B-05", ["STALE_WORK_OR_LOST_WORK", "RELEASE_ATOMICITY"], async (ctx) => {
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.rollout([upstream.baseUrl, upstream.baseUrl]);
  fixture.stages = fixture.stages.map((item) => ({ ...item, minimumObservationSeconds: 1 }));
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const created = await createRollout(ctx, apis[0].baseUrl, fixture, "b05");
  const worker = await ctx.startWorker();
  await ctx.waitFor(async () => {
    const detail = await getRollout(ctx, apis[0].baseUrl, created.regionalRolloutId);
    return detail.regionalRollout.state === "RUNNING" && detail.stages[0].state === "ACTIVE" ? detail : undefined;
  }, { timeoutMs: 30_000, label: "first regional stage activation", processes: [worker] });
  successful(await controlRollout(ctx, apis[0].baseUrl, created.regionalRolloutId, "pause", "b05-pause"), "pause rollout");
  await ctx.stop(worker);
  successful(await controlRollout(ctx, apis[1].baseUrl, created.regionalRolloutId, "resume", "b05-resume-before-claim"), "resume rollout before claimed advance");
  const barrier = await ctx.barrier({ hold: (value) => value.point === "worker.claimed" && value.aggregateId === created.regionalRolloutId });
  const stale = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === created.regionalRolloutId, { timeoutMs: 30_000, processes: [stale] });
  const leased = (await ctx.snapshot(apis[0].baseUrl)).work.find((item) => item.aggregateId === created.regionalRolloutId && item.state === "LEASED");
  assert.ok(leased, "rollout advance Work is publicly leased before controls");
  const controls = await Promise.all([
    controlRollout(ctx, apis[0].baseUrl, created.regionalRolloutId, "pause", "b05-race-pause"),
    controlRollout(ctx, apis[1].baseUrl, created.regionalRolloutId, "rollback", "b05-rollback"),
    controlRollout(ctx, apis[0].baseUrl, created.regionalRolloutId, "rollback", "b05-rollback"),
  ]);
  assert.ok(controls.slice(1).some((item) => item.status === 200), "one rollback path succeeds");
  assert.ok(controls.every((item) => item.status === 200 || (item.status === 409 && ["EXPECTED_ROLLOUT_STATE_MISMATCH", "REGIONAL_ROLLOUT_TERMINAL"].includes(item.json?.error?.code))), "controls converge using published errors");
  await ctx.kill(stale); barrier.release(held);
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_200));
  const replacement = await ctx.startWorker();
  const final = await ctx.waitFor(async () => { const detail = await getRollout(ctx, apis[0].baseUrl, created.regionalRolloutId); return detail.regionalRollout.state === "ROLLED_BACK" ? detail : undefined; }, { timeoutMs: 60_000, label: "rollout rollback terminal", processes: [replacement] });
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  const active = resources(snapshot).configReleases.filter((item) => item.tenantId === fixture.tenant.tenantId && item.state === "ACTIVE");
  assert.equal(active.length, 1, "rollback restores one release");
  assert.equal(active[0].configReleaseId, fixture.release.configReleaseId, "rollback restores frozen prior release");
  assert.ok(final.stages.filter((item) => item.activatedAt !== null).every((item) => item.state === "ROLLED_BACK"), "activated stages rolled back atomically");
  const reclaimed = snapshot.work.find((item) => item.workId === leased.workId);
  assert.ok(reclaimed?.terminal && reclaimed.attempt >= leased.attempt, "claimed advance Work is fenced and closed");
  const terminalControl = await controlRollout(ctx, apis[1].baseUrl, created.regionalRolloutId, "cancel", "b05-terminal-cancel");
  semanticError(terminalControl, 409, "REGIONAL_ROLLOUT_TERMINAL");
  ctx.mark("rollout.controls.closed", { regionalRolloutId: created.regionalRolloutId, state: final.regionalRollout.state });
  return ctx.pass();
});

export const B_CASES = [B01, B02, B03, B04, B05];
