import { seedFixture, waitlistWorkedExample } from "../lib/fixtures.mjs";
import { assertHold, assertLedger, canonical } from "../lib/oracle.mjs";
import {
  assertHoldEnvelope,
  assertPublicError,
  correctnessCap,
  getEvent,
  getHistory,
  getHold,
  result,
  waitForHold,
  waitForWaitlist,
} from "./helpers.mjs";

async function c01(ctx) {
  const event = ctx.event("response-crash-hold", { capacity: 5 });
  const customer = ctx.customer("response-crash-hold");
  await ctx.seed(seedFixture([event], [customer]));
  const creator = await ctx.startApi({ ttl: 3_600 });
  const observer = await ctx.startApi({ ttl: 3_600 });
  const shield = await ctx.startResponseShield(creator.baseUrl);
  const key = ctx.key("crash-create");
  const body = { eventId: event.id, customerId: customer.id, quantity: 3 };
  shield.dropNextMutation();
  await ctx.createHold(shield.baseUrl, body, key).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label: "completed create response at shield" });
  const captured = shield.captures[0];
  ctx.equal("upstream completed hold creation before disconnect", captured.status, 201);
  ctx.assert("captured response is an exact pending hold", () => assertHold(captured.json.hold, {
    eventId: event.id, customerId: customer.id, quantity: 3, status: "PENDING",
  }));
  await ctx.stop(creator, "SIGKILL");

  const visible = await getHold(ctx, observer.baseUrl, captured.json.hold.id);
  ctx.equal("other process immediately sees the committed hold", canonical(visible), canonical(captured.json.hold));
  const state = await getEvent(ctx, observer.baseUrl, event.id);
  ctx.assert("response-side disconnect retained one reservation", () => assertLedger(state, { capacity: 5, pending: 3 }), correctnessCap);
  const history = await getHistory(ctx, observer.baseUrl, customer.id, "holds");
  ctx.equal("response-side disconnect retained one history row", history.items.filter(({ id }) => id === captured.json.hold.id).length, 1, correctnessCap);
  const replay = await ctx.createHold(observer.baseUrl, body, key);
  ctx.equal("cross-process replay retains status", replay.status, captured.status);
  ctx.equal("cross-process replay retains body", canonical(replay.json), canonical(captured.json), correctnessCap);
  return result(["a fully captured 201 survived downstream disconnect, SIGKILL, public read, and replay"]);
}

async function c02(ctx) {
  const event = ctx.event("expiry-replacement", { capacity: 4 });
  const customer = ctx.customer("expiry-replacement");
  await ctx.seed(seedFixture([event], [customer]));
  const creator = await ctx.startApi({ ttl: 4 });
  const pending = assertHoldEnvelope(ctx, "replacement expiry source", await ctx.createHold(creator.baseUrl, {
    eventId: event.id, customerId: customer.id, quantity: 3,
  }), { status: "PENDING" });
  await ctx.stop(creator, "SIGKILL");
  await ctx.sleep(Math.max(0, Date.parse(pending.expiresAt) - Date.now() - 2_000));
  const replacementStartedAt = Date.now();
  const replacement = await ctx.startApi({ ttl: 4 });
  await ctx.sleep(Math.max(0, Date.parse(pending.expiresAt) - Date.now() + 250));
  const expired = await waitForHold(ctx, replacement.baseUrl, pending.id, (hold) => hold.status === "EXPIRED", {
    timeoutMs: Math.max(100, Date.parse(pending.expiresAt) + 2_000 - Date.now()),
    label: "replacement passive expiry",
  });
  ctx.equal("replacement preserves the original expiresAt", expired.json.hold.expiresAt, pending.expiresAt);
  ctx.ok("replacement exposes expiry within the public window", Date.now() <= Date.parse(pending.expiresAt) + 2_000, `replacement started ${replacementStartedAt}`);
  const state = await getEvent(ctx, replacement.baseUrl, event.id);
  ctx.assert("replacement restores capacity exactly once", () => assertLedger(state, { capacity: 4 }), correctnessCap);
  const holds = await getHistory(ctx, replacement.baseUrl, customer.id, "holds");
  const orders = await getHistory(ctx, replacement.baseUrl, customer.id, "orders");
  ctx.equal("replacement retains one expired history row", holds.items.filter(({ id }) => id === pending.id).length, 1, correctnessCap);
  ctx.equal("replacement expiry creates no order", orders.items.filter(({ holdId }) => holdId === pending.id).length, 0, correctnessCap);
  return result(["creator exited before the deadline; replacement retained deadline, expired, and restored once"]);
}

async function c03(ctx) {
  const confirmEvent = ctx.event("unknown-confirm", { capacity: 2 });
  const releaseEvent = ctx.event("unknown-release", { capacity: 2 });
  const customer = ctx.customer("unknown-terminal");
  await ctx.seed(seedFixture([confirmEvent, releaseEvent], [customer]));
  const origin = await ctx.startApi({ ttl: 3_600 });
  const recovery = await ctx.startApi({ ttl: 3_600 });
  const confirmSource = assertHoldEnvelope(ctx, "unknown confirm source", await ctx.createHold(origin.baseUrl, {
    eventId: confirmEvent.id, customerId: customer.id, quantity: 2,
  }));
  const releaseSource = assertHoldEnvelope(ctx, "unknown release source", await ctx.createHold(origin.baseUrl, {
    eventId: releaseEvent.id, customerId: customer.id, quantity: 2,
  }));
  const shield = await ctx.startResponseShield(origin.baseUrl);

  const confirmKey = ctx.key("unknown-confirm");
  shield.dropNextMutation();
  await ctx.confirm(shield.baseUrl, confirmSource.id, confirmKey).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label: "completed unknown confirm response" });
  const capturedConfirm = shield.captures[0];
  ctx.equal("unknown confirm completed upstream", capturedConfirm.status, 200);
  await ctx.stop(origin, "SIGKILL");
  const confirmReplay = await ctx.confirm(recovery.baseUrl, confirmSource.id, confirmKey);
  ctx.equal("unknown confirm replay status", confirmReplay.status, capturedConfirm.status);
  ctx.equal("unknown confirm replay body", canonical(confirmReplay.json), canonical(capturedConfirm.json), correctnessCap);
  assertPublicError(ctx, "release loses after durable confirm", await ctx.release(recovery.baseUrl, confirmSource.id), 409, "HOLD_NOT_RELEASABLE");

  const secondOrigin = await ctx.startApi({ ttl: 3_600 });
  const secondShield = await ctx.startResponseShield(secondOrigin.baseUrl);
  const releaseKey = ctx.key("unknown-release");
  secondShield.dropNextMutation();
  await ctx.release(secondShield.baseUrl, releaseSource.id, releaseKey).catch(() => undefined);
  await ctx.waitFor(() => secondShield.captures.length === 1, { label: "completed unknown release response" });
  const capturedRelease = secondShield.captures[0];
  ctx.equal("unknown release completed upstream", capturedRelease.status, 200);
  await ctx.stop(secondOrigin, "SIGKILL");
  const releaseReplay = await ctx.release(recovery.baseUrl, releaseSource.id, releaseKey);
  ctx.equal("unknown release replay status", releaseReplay.status, capturedRelease.status);
  ctx.equal("unknown release replay body", canonical(releaseReplay.json), canonical(capturedRelease.json), correctnessCap);
  assertPublicError(ctx, "confirm loses after durable release", await ctx.confirm(recovery.baseUrl, releaseSource.id), 409, "HOLD_NOT_CONFIRMABLE");

  const orders = await getHistory(ctx, recovery.baseUrl, customer.id, "orders");
  ctx.equal("unknown confirm creates one order", orders.items.filter(({ holdId }) => holdId === confirmSource.id).length, 1, correctnessCap);
  ctx.equal("unknown release creates no order", orders.items.filter(({ holdId }) => holdId === releaseSource.id).length, 0, correctnessCap);
  const confirmedState = await getEvent(ctx, recovery.baseUrl, confirmEvent.id);
  const releasedState = await getEvent(ctx, recovery.baseUrl, releaseEvent.id);
  ctx.assert("confirmed unknown outcome consumes capacity", () => assertLedger(confirmedState, { capacity: 2, confirmed: 2 }), correctnessCap);
  ctx.assert("released unknown outcome restores capacity", () => assertLedger(releasedState, { capacity: 2 }), correctnessCap);
  return result(["confirm and release response disconnects replayed after origin process death with atomic side effects"]);
}

async function c04(ctx) {
  const fixture = waitlistWorkedExample(ctx.fixtures);
  await ctx.seed(seedFixture([fixture.event], [...fixture.owners, ...fixture.waiters]));
  const origin = await ctx.startApi({ ttl: 3_600, waitlistTtl: 12 });
  const recovery = await ctx.startApi({ ttl: 3_600, waitlistTtl: 12 });
  const sources = [];
  for (let index = 0; index < 2; index += 1) sources.push(assertHoldEnvelope(ctx, `recovery source ${index}`, await ctx.createHold(origin.baseUrl, {
    eventId: fixture.event.id, customerId: fixture.owners[index].id, quantity: 2,
  })));
  await ctx.joinWaitlist(origin.baseUrl, fixture.event.id, fixture.waiters[0].id, 3);
  await ctx.joinWaitlist(origin.baseUrl, fixture.event.id, fixture.waiters[1].id, 1);
  await ctx.release(origin.baseUrl, sources[0].id);
  ctx.equal("recovery fixture head remains blocked after first release", (await ctx.getWaitlist(recovery.baseUrl, fixture.event.id, fixture.waiters[0].id)).json.waitlistEntry.status, "WAITING");

  const shield = await ctx.startResponseShield(origin.baseUrl);
  shield.dropNextMutation();
  const releaseKey = ctx.key("promotion-crash-release");
  await ctx.release(shield.baseUrl, sources[1].id, releaseKey).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label: "completed promotion-triggering release response" });
  ctx.equal("promotion-triggering release committed before disconnect", shield.captures[0].status, 200);
  await ctx.stop(origin, "SIGKILL");

  const head = await waitForWaitlist(ctx, recovery.baseUrl, fixture.event.id, fixture.waiters[0].id, (entry) => entry.status === "PROMOTED", { timeoutMs: 10_000 });
  const tail = await waitForWaitlist(ctx, recovery.baseUrl, fixture.event.id, fixture.waiters[1].id, (entry) => entry.status === "PROMOTED", { timeoutMs: 10_000 });
  ctx.ok("recovered promotions use distinct holds", head.json.waitlistEntry.holdId !== tail.json.waitlistEntry.holdId, undefined, correctnessCap);
  const headHold = await getHold(ctx, recovery.baseUrl, head.json.waitlistEntry.holdId);
  const tailHold = await getHold(ctx, recovery.baseUrl, tail.json.waitlistEntry.holdId);
  ctx.equal("recovered head quantity follows FIFO request", headHold.quantity, 3);
  ctx.equal("recovered tail quantity follows FIFO request", tailHold.quantity, 1);
  for (const hold of [headHold, tailHold]) {
    ctx.ok("recovered promotion uses waitlist TTL", Math.abs((Date.parse(hold.expiresAt) - Date.parse(hold.createdAt)) - 12_000) <= 1_000);
  }
  const headHistory = await getHistory(ctx, recovery.baseUrl, fixture.waiters[0].id, "holds");
  const tailHistory = await getHistory(ctx, recovery.baseUrl, fixture.waiters[1].id, "holds");
  ctx.equal("recovered head has one promotion hold", headHistory.items.length, 1, correctnessCap);
  ctx.equal("recovered tail has one promotion hold", tailHistory.items.length, 1, correctnessCap);
  const state = await getEvent(ctx, recovery.baseUrl, fixture.event.id);
  ctx.assert("recovered FIFO prefix conserves capacity", () => assertLedger(state, { capacity: 4, pending: 4 }), correctnessCap);
  return result(["a completed release followed by origin SIGKILL converged to the LP-W1 FIFO prefix on another process"]);
}

export const C_CASES = [
  { id: "C-01", run: c01 },
  { id: "C-02", run: c02 },
  { id: "C-03", run: c03 },
  { id: "C-04", run: c04 },
];
