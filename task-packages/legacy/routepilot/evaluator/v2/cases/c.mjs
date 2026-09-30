import assert from "node:assert/strict";
import { assertEventSequence, assertReleaseAuthority, assertRequestIdentity, canonicalJson } from "../oracles/index.mjs";
import {
  createRelease,
  createRollout,
  defineCase,
  dispatch,
  findField,
  gatewayPayload,
  getRollout,
  guardedCase,
  prepare,
  resources,
  semanticError,
  startUpstream,
  successful,
  waitRelease,
  waitWork,
} from "./helpers.mjs";

const C01 = guardedCase("C-01", ["IDEMPOTENCY_CORRECTNESS", "RATE_CIRCUIT_CONSERVATION"], async (ctx) => {
  const upstream = await startUpstream(ctx, () => ({ status: 200, headers: { "x-upstream-result": "stable" }, json: { accepted: true } }));
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 10;
  const { api } = await prepare(ctx, fixture);
  const shield = await ctx.responseShield(api.baseUrl);
  const payload = gatewayPayload(fixture, 501, { path: "/orders/42", requestKey: "c01-unknown" });
  const key = ctx.key("c01-unknown");
  shield.dropNextMutation();
  await assert.rejects(ctx.mutate(shield.baseUrl, "/api/v1/gateway/dispatch", key, payload), "gateway response lost after API commit");
  const committed = shield.captures.find((item) => item.dropped);
  assert.ok(committed && committed.response.status === 200, "gateway committed before client disconnect");
  await ctx.kill(api);
  const restarted = await ctx.startApi();
  const replay = successful(await ctx.mutate(restarted.baseUrl, "/api/v1/gateway/dispatch", key, payload), "gateway unknown-outcome replay");
  assert.equal(replay.status, committed.response.status, "saved response status exact");
  assert.equal(replay.text, committed.response.body, "saved response bytes exact");
  assert.equal(upstream.ledger.length, 1, "unknown replay causes one logical upstream call");
  const snapshot = await ctx.snapshot(restarted.baseUrl);
  const requests = resources(snapshot).gatewayRequests.filter((item) => item.tenantId === fixture.tenant.tenantId && item.requestKey === payload.requestKey);
  assert.equal(requests.length, 1, "one GatewayRequest effect");
  assert.equal(resources(snapshot).upstreamAttempts.filter((item) => item.gatewayRequestId === requests[0].gatewayRequestId).length, 1, "one UpstreamAttempt effect");
  const windows = resources(snapshot).rateWindows.filter((item) => item.tenantId === fixture.tenant.tenantId);
  assert.equal(windows.reduce((sum, item) => sum + item.consumed, 0), 1, "one rate token consumed");
  ctx.mark("gateway.unknown-outcome.closed", { gatewayRequestId: requests[0].gatewayRequestId });
  return ctx.pass();
});

const C02 = guardedCase("C-02", ["RELEASE_ATOMICITY", "STALE_WORK_OR_LOST_WORK"], async (ctx) => {
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 100;
  const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const release = await createRelease(ctx, apis[0].baseUrl, fixture, "c02");
  const barrier = await ctx.barrier({ hold: (value) => value.point === "worker.claimed" && value.aggregateId === release.configReleaseId });
  const victim = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === release.configReleaseId, { timeoutMs: 30_000, processes: [victim] });
  const leased = await waitWork(ctx, apis[0].baseUrl, (item) => item.kind === "CONFIG_ACTIVATE" && item.aggregateId === release.configReleaseId, { state: "LEASED", processes: [victim] });
  const beforeKill = await ctx.snapshot(apis[0].baseUrl);
  assertReleaseAuthority(resources(beforeKill).configReleases);
  await ctx.kill(victim);
  barrier.release(held);
  await ctx.kill(apis[0]);
  const restarted = await ctx.startApi();
  const during = await dispatch(ctx, restarted.baseUrl, fixture, 502, { path: "/orders/42", requestKey: "c02-during" });
  assert.ok(during.response.json.routeRevisionId, "gateway remains usable with complete old authority");
  const replacement = await ctx.startWorker();
  const active = await waitRelease(ctx, restarted.baseUrl, release.configReleaseId, { processes: [replacement], timeoutMs: 60_000 });
  assertReleaseAuthority(resources(active.snapshot).configReleases);
  const work = active.snapshot.work.find((item) => item.workId === leased.work.workId);
  assert.ok(work.terminal && work.attempt >= leased.work.attempt, "leased activation Work recovered once");
  const created = resources(active.snapshot).configReleases.find((item) => item.configReleaseId === release.configReleaseId);
  assert.deepEqual(created.routeRevisionIds, release.body.routeRevisionIds, "release route set remains complete");
  ctx.mark("release.crash-recovered", { configReleaseId: release.configReleaseId, attempt: work.attempt });
  return ctx.pass();
});

const C03 = guardedCase("C-03", ["STALE_WORK_OR_LOST_WORK", "RELEASE_ATOMICITY"], async (ctx) => {
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.rollout([upstream.baseUrl, upstream.baseUrl]);
  const { api } = await prepare(ctx, fixture);
  const created = await createRollout(ctx, api.baseUrl, fixture, "c03");
  const barrier = await ctx.barrier({ hold: (value) => value.point === "worker.claimed" && value.aggregateId === created.regionalRolloutId });
  const victim = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const held = await barrier.waitFor((entry) => entry.json?.aggregateId === created.regionalRolloutId, { timeoutMs: 30_000, processes: [victim] });
  const leased = await waitWork(ctx, api.baseUrl, (item) => item.kind === "REGIONAL_ROLLOUT_ADVANCE" && item.aggregateId === created.regionalRolloutId, { state: "LEASED", processes: [victim] });
  await ctx.kill(victim); barrier.release(held);
  const replacement = await ctx.startWorker();
  const progressed = await ctx.waitFor(async () => {
    const detail = await getRollout(ctx, api.baseUrl, created.regionalRolloutId);
    return detail.stages.some((item) => item.state === "ACTIVE") ? detail : undefined;
  }, { timeoutMs: 60_000, label: "first regional stage recovery", processes: [replacement] });
  assert.equal(progressed.stages.filter((item) => item.state === "ACTIVE").length, 1, "one current RegionalStage ACTIVE");
  assert.equal(progressed.stages.find((item) => item.state === "ACTIVE").ordinal, 0, "regional recovery starts at ordinal zero");
  assert.equal(new Set(progressed.stages.map((item) => item.region)).size, progressed.stages.length, "one Stage per region");
  const snapshot = await ctx.snapshot(api.baseUrl);
  const work = snapshot.work.find((item) => item.workId === leased.work.workId);
  assert.ok(work.attempt >= leased.work.attempt, "replacement claim does not regress attempt");
  ctx.mark("rollout.lease-reclaimed", { regionalRolloutId: created.regionalRolloutId, currentStageOrdinal: progressed.regionalRollout.currentStageOrdinal });
  return ctx.pass({ blockedAssertions: [ctx.diagnostic("RP-C03-READINESS", "SPEC-GAP-RP-01")] });
});

const C04 = guardedCase("C-04", ["STALE_WORK_OR_LOST_WORK", "RELEASE_ATOMICITY"], async (ctx) => {
  let targetEventId;
  let targetAggregateId;
  let targetAttempt = 0;
  const receiver = await ctx.receiver({ behavior(entry) {
    const eventId = entry.headers["x-routepilot-event-id"];
    targetEventId ??= eventId;
    targetAggregateId ??= findField(entry.json, "aggregateId");
    if (eventId !== targetEventId) return { status: 204 };
    targetAttempt += 1;
    if (targetAttempt === 1) return { status: 500 };
    return { status: 204 };
  } });
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.rollout([upstream.baseUrl, upstream.baseUrl]);
  const { api } = await prepare(ctx, fixture);
  const before = await ctx.snapshot(api.baseUrl);
  const release = await createRelease(ctx, api.baseUrl, fixture, "c04");
  const worker = await ctx.startWorker();
  await waitRelease(ctx, api.baseUrl, release.configReleaseId, { processes: [worker] });
  const barrier = await ctx.barrier({ hold: (value) => value.point === "dispatcher.response-received" && value.aggregateId === targetAggregateId });
  const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const second = await ctx.waitFor(() => {
    const matching = receiver.ledger.filter((entry) => entry.headers["x-routepilot-event-id"] === targetEventId);
    return matching.length >= 2 ? matching[1] : undefined;
  }, { timeoutMs: 30_000, label: "Event unknown ACK", processes: [dispatcher] });
  assert.equal(typeof targetEventId, "string", "Event header identity published");
  const held = await barrier.waitFor((entry) => entry.json?.point === "dispatcher.response-received" && entry.json?.aggregateId === targetAggregateId, { timeoutMs: 30_000, processes: [dispatcher] });
  await ctx.kill(dispatcher);
  barrier.release(held);
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
  const third = await ctx.waitFor(() => {
    const matching = receiver.ledger.filter((entry) => entry.headers["x-routepilot-event-id"] === targetEventId);
    return matching.length >= 3 ? matching[2] : undefined;
  }, { timeoutMs: 60_000, label: "Event retry after Dispatcher kill", processes: [replacement] });
  const first = receiver.ledger.find((entry) => entry.headers["x-routepilot-event-id"] === targetEventId);
  assert.equal(second.raw, first.raw, "unknown ACK Event body stable");
  assert.equal(third.raw, first.raw, "replacement Event body stable");
  const after = await ctx.snapshot(api.baseUrl);
  assertEventSequence(after.events);
  assert.equal(new Set(after.events.map((item) => item.eventId)).size, after.events.length, "durable Event identities unique");
  const invalid = await ctx.mutate(api.baseUrl, "/api/v1/config-releases", ctx.key("c04-invalid"), { tenantId: fixture.tenant.tenantId, version: 999, routeRevisionIds: [], expectedActiveVersion: 2 });
  assert.ok(invalid.status >= 400, "invalid release rejected");
  const afterInvalid = await ctx.snapshot(api.baseUrl);
  assert.equal(afterInvalid.events.length, after.events.length, "failed mutation emits no Event");
  assert.equal(resources(afterInvalid).configReleases.length, resources(after).configReleases.length, "failed mutation creates no release");
  ctx.mark("outbox.unknown-ack.closed", { eventId: targetEventId, attempts: 3 });
  return ctx.pass();
});

export const C_CASES = [C01, C02, C03, C04];
