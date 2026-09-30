import assert from "node:assert/strict";

import { seedFixture, waitlistWorkedExample } from "../lib/fixtures.mjs";
import {
  assertHold,
  assertLedger,
  assertOrder,
  assertWaitlistEntry,
  canonical,
  waitlistComparator,
} from "../lib/oracle.mjs";
import {
  assertEventEnvelope,
  assertHoldEnvelope,
  assertPublicError,
  assertReplay,
  assertWaitlistEnvelope,
  correctnessCap,
  getEvent,
  getHistory,
  getHold,
  result,
  seedAndStart,
  waitForHold,
  waitForWaitlist,
} from "./helpers.mjs";

async function b01(ctx) {
  const capacity = 53;
  const event = ctx.event("hot-capacity", { capacity });
  const customers = Array.from({ length: 200 }, (_, index) => ctx.customer(`hot-${index}`));
  await ctx.seed(seedFixture([event], customers));
  const apis = [await ctx.startApi({ ttl: 3_600 }), await ctx.startApi({ ttl: 3_600 })];
  const attempts = customers.map((customer, index) => ({ customer, quantity: (index % 4) + 1 }));
  const responses = await ctx.concurrent(attempts, 100, (attempt, index) => ctx.createHold(
    apis[index % 2].baseUrl,
    { eventId: event.id, customerId: attempt.customer.id, quantity: attempt.quantity },
    ctx.key(`hot-${index}`),
  ));
  const accepted = [];
  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index];
    if (response.status === 201) {
      ctx.assert(`accepted hold ${index} has the attempted quantity`, () => assertHold(response.json.hold, {
        eventId: event.id,
        customerId: attempts[index].customer.id,
        quantity: attempts[index].quantity,
        status: "PENDING",
      }));
      accepted.push(response.json.hold);
    } else {
      assertPublicError(ctx, `rejected hold ${index} is sold-out only`, response, 409, "INSUFFICIENT_CAPACITY");
    }
  }
  const reserved = accepted.reduce((sum, hold) => sum + hold.quantity, 0);
  ctx.ok("successful quantities do not oversubscribe capacity", reserved <= capacity, `reserved=${reserved}`, correctnessCap);
  const state = await getEvent(ctx, apis[0].baseUrl, event.id);
  ctx.assert("two-process success responses exactly match the event ledger", () => assertLedger(state, { capacity, pending: reserved }), correctnessCap);
  ctx.equal("all successful holds have distinct IDs", new Set(accepted.map(({ id }) => id)).size, accepted.length, correctnessCap);
  const histories = await ctx.concurrent(customers, 50, (customer, index) => getHistory(ctx, apis[index % 2].baseUrl, customer.id, "holds"));
  ctx.equal("public histories expose exactly the successful effects", histories.reduce((sum, page) => sum + page.items.length, 0), accepted.length, correctnessCap);
  return result(["200 distinct writes were distributed over two production processes and audited by public histories"]);
}

async function b02(ctx) {
  const event = ctx.event("idempotency", { capacity: 20 });
  const sold = ctx.event("idempotency-waitlist", { capacity: 1 });
  const customers = Array.from({ length: 6 }, (_, index) => ctx.customer(`idempotency-${index}`));
  await ctx.seed(seedFixture([event, sold], customers));
  let apis = [await ctx.startApi({ ttl: 3_600 }), await ctx.startApi({ ttl: 3_600 })];

  const body = { eventId: event.id, customerId: customers[0].id, quantity: 2 };
  const key = ctx.key("64-way-create");
  const responses = await ctx.concurrent(Array.from({ length: 64 }), 64, (_, index) => ctx.createHold(apis[index % 2].baseUrl, body, key));
  ctx.ok("all concurrent same-key creates replay 201", responses.every(({ status }) => status === 201));
  ctx.equal("all concurrent same-key creates replay one body", new Set(responses.map(({ json }) => canonical(json))).size, 1, correctnessCap);
  const original = responses[0];
  const holdId = original.json.hold.id;
  ctx.equal("same-key contention creates one hold", (await getHistory(ctx, apis[0].baseUrl, customers[0].id, "holds")).items.length, 1, correctnessCap);
  const conflict = await ctx.createHold(apis[1].baseUrl, { ...body, quantity: 3 }, key);
  assertPublicError(ctx, "same scoped key with different semantics conflicts", conflict, 409, "IDEMPOTENCY_CONFLICT");

  const confirmKey = key;
  const confirmed = await ctx.confirm(apis[1].baseUrl, holdId, confirmKey);
  ctx.equal("same key is valid in a different operation/resource scope", confirmed.status, 200);
  const confirmReplay = await ctx.confirm(apis[0].baseUrl, holdId, confirmKey);
  assertReplay(ctx, "confirm", confirmReplay, confirmed);

  const source = assertHoldEnvelope(ctx, "sold-out source", await ctx.createHold(apis[0].baseUrl, {
    eventId: sold.id, customerId: customers[1].id, quantity: 1,
  }));
  const waitKey = ctx.key("waitlist-replay");
  const joined = await ctx.joinWaitlist(apis[0].baseUrl, sold.id, customers[2].id, 1, waitKey);
  ctx.equal("waitlist mutation succeeds", joined.status, 201);
  assertReplay(ctx, "waitlist join", await ctx.joinWaitlist(apis[1].baseUrl, sold.id, customers[2].id, 1, waitKey), joined);

  const releaseKey = ctx.key("release-replay");
  const released = await ctx.release(apis[0].baseUrl, source.id, releaseKey);
  ctx.equal("release mutation succeeds", released.status, 200);
  assertReplay(ctx, "release", await ctx.release(apis[1].baseUrl, source.id, releaseKey), released);

  const createdEvent = ctx.event("admin-idempotency", { capacity: 7 });
  const eventKey = ctx.key("event-replay");
  const eventResponse = await ctx.createEvent(apis[0].baseUrl, createdEvent, eventKey);
  assertEventEnvelope(ctx, "idempotent event create", eventResponse, { slug: createdEvent.slug, capacity: 7 });
  assertReplay(ctx, "event create", await ctx.createEvent(apis[1].baseUrl, createdEvent, eventKey), eventResponse);

  const shieldEvent = ctx.event("unknown-response", { capacity: 4 });
  const shieldEventResponse = await ctx.createEvent(apis[0].baseUrl, shieldEvent);
  assertEventEnvelope(ctx, "unknown-response event", shieldEventResponse);
  const shield = await ctx.startResponseShield(apis[0].baseUrl);
  const unknownKey = ctx.key("unknown-response-create");
  shield.dropNextMutation();
  await ctx.createHold(shield.baseUrl, { eventId: shieldEventResponse.json.event.id, customerId: customers[3].id, quantity: 2 }, unknownKey).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label: "complete upstream response capture" });
  ctx.equal("shield observed a completed upstream create", shield.captures[0].status, 201);

  await Promise.all(apis.map((api) => ctx.stop(api, "SIGKILL")));
  apis = [await ctx.startApi({ ttl: 3_600 })];
  assertReplay(ctx, "create after restart", await ctx.createHold(apis[0].baseUrl, body, key), original);
  const unknownReplay = await ctx.createHold(apis[0].baseUrl, {
    eventId: shieldEventResponse.json.event.id, customerId: customers[3].id, quantity: 2,
  }, unknownKey);
  ctx.equal("unknown response replays captured status", unknownReplay.status, shield.captures[0].status);
  ctx.equal("unknown response replays captured semantic body", canonical(unknownReplay.json), canonical(shield.captures[0].json), correctnessCap);
  const durableEvent = await getEventValue(ctx, apis[0].baseUrl, event.id);
  ctx.assert("idempotent effects remain conserved after restart", () => assertLedger(durableEvent, { capacity: 20, confirmed: 2 }), correctnessCap);
  return result(["same-key contention, scope, response disconnect, and restart replay covered all mutation families"]);
}

async function getEventValue(ctx, baseUrl, eventId) {
  return getEvent(ctx, baseUrl, eventId);
}

async function b03(ctx) {
  const customer = ctx.customer("terminal-races");
  const events = Array.from({ length: 3 }, (_, index) => ctx.event(`terminal-race-${index}`, { capacity: 2 }));
  await ctx.seed(seedFixture(events, [customer]));
  const apis = [await ctx.startApi({ ttl: 2 }), await ctx.startApi({ ttl: 2 })];

  for (let round = 0; round < 3; round += 1) {
    const source = assertHoldEnvelope(ctx, `race ${round} source`, await ctx.createHold(apis[0].baseUrl, {
      eventId: events[round].id, customerId: customer.id, quantity: 2,
    }));
    if (round === 1) await ctx.sleep(Math.max(0, Date.parse(source.expiresAt) - Date.now() - 20));
    if (round === 2) await ctx.sleep(Math.max(0, Date.parse(source.expiresAt) - Date.now() + 50));
    const [confirm, release] = await Promise.all([
      ctx.confirm(apis[round % 2].baseUrl, source.id, ctx.key(`race-confirm-${round}`)),
      ctx.release(apis[(round + 1) % 2].baseUrl, source.id, ctx.key(`race-release-${round}`)),
    ]);
    ctx.ok(`race ${round} returns only success or stable conflict`, [confirm, release].every(({ status }) => status === 200 || status === 409));
    const finalResponse = await waitForHold(ctx, apis[0].baseUrl, source.id, (hold) => hold.status !== "PENDING", { timeoutMs: 5_000 });
    const final = finalResponse.json.hold;
    ctx.ok(`race ${round} has one legal terminal state`, ["CONFIRMED", "RELEASED", "EXPIRED"].includes(final.status), undefined, correctnessCap);
    const orders = await getHistory(ctx, apis[1].baseUrl, customer.id, "orders");
    const matchingOrders = orders.items.filter(({ holdId }) => holdId === source.id);
    ctx.equal(`race ${round} creates the expected number of orders`, matchingOrders.length, final.status === "CONFIRMED" ? 1 : 0, correctnessCap);
    if (matchingOrders[0]) ctx.assert(`race ${round} order matches the winning hold`, () => assertOrder(matchingOrders[0], { holdId: source.id, quantity: 2 }));
    const eventState = await getEvent(ctx, apis[0].baseUrl, events[round].id);
    ctx.assert(`race ${round} restores capacity according to one winner`, () => assertLedger(eventState, {
      capacity: 2,
      confirmed: final.status === "CONFIRMED" ? 2 : 0,
    }), correctnessCap);
  }
  return result(["three deadline interleavings produced one terminal state, at most one order, and one ledger effect"]);
}

async function b04(ctx) {
  const worked = waitlistWorkedExample(ctx.fixtures);
  const tieEvent = ctx.event("same-time-order", { capacity: 4 });
  const tieOwners = Array.from({ length: 4 }, (_, index) => ctx.customer(`tie-owner-${index}`));
  const tieWaiters = Array.from({ length: 4 }, (_, index) => ctx.customer(`tie-waiter-${index}`));
  await ctx.seed(seedFixture([worked.event, tieEvent], [...worked.owners, ...worked.waiters, ...tieOwners, ...tieWaiters]));
  const api = await ctx.startApi({ ttl: 3_600, waitlistTtl: 60 });

  const workedSources = [];
  for (let index = 0; index < 2; index += 1) workedSources.push(assertHoldEnvelope(ctx, `worked source ${index}`, await ctx.createHold(api.baseUrl, {
    eventId: worked.event.id, customerId: worked.owners[index].id, quantity: 2,
  })));
  assertWaitlistEnvelope(ctx, "worked head", await ctx.joinWaitlist(api.baseUrl, worked.event.id, worked.waiters[0].id, 3), { position: 1 });
  assertWaitlistEnvelope(ctx, "worked tail", await ctx.joinWaitlist(api.baseUrl, worked.event.id, worked.waiters[1].id, 1), { position: 2 });
  await ctx.release(api.baseUrl, workedSources[0].id);
  ctx.equal("worked head blocks with two free", (await ctx.getWaitlist(api.baseUrl, worked.event.id, worked.waiters[0].id)).json.waitlistEntry.status, "WAITING");
  ctx.equal("worked tail is not bypassed", (await ctx.getWaitlist(api.baseUrl, worked.event.id, worked.waiters[1].id)).json.waitlistEntry.status, "WAITING", correctnessCap);
  await ctx.release(api.baseUrl, workedSources[1].id);
  const workedHead = await waitForWaitlist(ctx, api.baseUrl, worked.event.id, worked.waiters[0].id, (entry) => entry.status === "PROMOTED");
  const workedTail = await waitForWaitlist(ctx, api.baseUrl, worked.event.id, worked.waiters[1].id, (entry) => entry.status === "PROMOTED");
  const workedState = await getEventValue(ctx, api.baseUrl, worked.event.id);
  ctx.assert("worked example promotes the fitting prefix", () => assertLedger(workedState, { capacity: 4, pending: 4 }), correctnessCap);
  ctx.ok("worked example creates distinct promotion holds", workedHead.json.waitlistEntry.holdId !== workedTail.json.waitlistEntry.holdId, undefined, correctnessCap);

  const tieSources = [];
  for (let index = 0; index < 4; index += 1) tieSources.push(assertHoldEnvelope(ctx, `tie source ${index}`, await ctx.createHold(api.baseUrl, {
    eventId: tieEvent.id, customerId: tieOwners[index].id, quantity: 1,
  })));
  const joins = await ctx.concurrent(tieWaiters, 4, (customer, index) => ctx.joinWaitlist(api.baseUrl, tieEvent.id, customer.id, 1, ctx.key(`tie-join-${index}`)));
  const entries = joins.map((response, index) => assertWaitlistEnvelope(ctx, `tie join ${index}`, response));
  const expected = [...entries].sort(waitlistComparator);
  for (let index = 0; index < expected.length; index += 1) {
    const observed = await ctx.getWaitlist(api.baseUrl, tieEvent.id, expected[index].customerId);
    ctx.equal(`stable joinedAt/id position ${index + 1}`, observed.json.waitlistEntry.position, index + 1);
  }
  for (let index = 0; index < tieSources.length; index += 1) {
    await ctx.release(api.baseUrl, tieSources[index].id);
    await waitForWaitlist(ctx, api.baseUrl, tieEvent.id, expected[index].customerId, (entry) => entry.status === "PROMOTED");
    for (let later = index + 1; later < expected.length; later += 1) {
      const observed = await ctx.getWaitlist(api.baseUrl, tieEvent.id, expected[later].customerId);
      ctx.equal(`remaining FIFO position after release ${index + 1}`, observed.json.waitlistEntry.position, later - index);
    }
  }
  return result(["LP-W1 head blocking and observed joinedAt/id tie ordering were advanced one capacity unit at a time"]);
}

async function b05(ctx) {
  const events = Array.from({ length: 3 }, (_, index) => ctx.event(`promotion-race-${index}`, { capacity: 2 }));
  const owners = Array.from({ length: 3 }, (_, index) => ctx.customer(`promotion-owner-${index}`));
  const heads = Array.from({ length: 3 }, (_, index) => ctx.customer(`promotion-head-${index}`));
  const tails = Array.from({ length: 3 }, (_, index) => ctx.customer(`promotion-tail-${index}`));
  await ctx.seed(seedFixture(events, [...owners, ...heads, ...tails]));
  const apis = [await ctx.startApi({ ttl: 2, waitlistTtl: 30 }), await ctx.startApi({ ttl: 2, waitlistTtl: 30 })];

  for (let round = 0; round < 3; round += 1) {
    const source = assertHoldEnvelope(ctx, `promotion race ${round} source`, await ctx.createHold(apis[0].baseUrl, {
      eventId: events[round].id, customerId: owners[round].id, quantity: 2,
    }));
    const head = assertWaitlistEnvelope(ctx, `promotion race ${round} head`, await ctx.joinWaitlist(apis[0].baseUrl, events[round].id, heads[round].id, 1), { position: 1 });
    const tail = assertWaitlistEnvelope(ctx, `promotion race ${round} tail`, await ctx.joinWaitlist(apis[1].baseUrl, events[round].id, tails[round].id, 1), { position: 2 });
    if (round === 1) await ctx.sleep(Math.max(0, Date.parse(source.expiresAt) - Date.now() - 20));
    const competitors = round === 0
      ? [ctx.release(apis[0].baseUrl, source.id), ctx.release(apis[1].baseUrl, source.id), ctx.withdrawWaitlist(apis[1].baseUrl, events[round].id, heads[round].id)]
      : round === 1
        ? [ctx.withdrawWaitlist(apis[0].baseUrl, events[round].id, heads[round].id), ctx.getWaitlist(apis[1].baseUrl, events[round].id, heads[round].id)]
        : [ctx.release(apis[0].baseUrl, source.id), ctx.withdrawWaitlist(apis[1].baseUrl, events[round].id, heads[round].id), ctx.getWaitlist(apis[0].baseUrl, events[round].id, tails[round].id)];
    await Promise.allSettled(competitors);
    const headFinal = await ctx.waitFor(async () => {
      const response = await ctx.getWaitlist(apis[0].baseUrl, events[round].id, heads[round].id);
      return ["PROMOTED", "WITHDRAWN"].includes(response.json?.waitlistEntry?.status) ? response.json.waitlistEntry : false;
    }, { timeoutMs: 8_000, label: `promotion race ${round} head terminal state` });
    const tailFinalResponse = await waitForWaitlist(ctx, apis[1].baseUrl, events[round].id, tails[round].id, (entry) => entry.status === "PROMOTED");
    const tailFinal = tailFinalResponse.json.waitlistEntry;
    ctx.assert(`promotion race ${round} head has a legal committed terminal`, () => assertWaitlistEntry(headFinal, { id: head.id }));
    ctx.assert(`promotion race ${round} tail promotes exactly once`, () => assertWaitlistEntry(tailFinal, { id: tail.id, status: "PROMOTED" }));
    const headHolds = await getHistory(ctx, apis[0].baseUrl, heads[round].id, "holds");
    const tailHolds = await getHistory(ctx, apis[1].baseUrl, tails[round].id, "holds");
    ctx.equal(`promotion race ${round} head has at most one hold`, headHolds.items.length, headFinal.status === "PROMOTED" ? 1 : 0, correctnessCap);
    ctx.equal(`promotion race ${round} tail has exactly one hold`, tailHolds.items.length, 1, correctnessCap);
    if (headFinal.status === "PROMOTED") ctx.equal(`promotion race ${round} head links its sole hold`, headHolds.items[0].id, headFinal.holdId, correctnessCap);
    ctx.equal(`promotion race ${round} tail links its sole hold`, tailHolds.items[0].id, tailFinal.holdId, correctnessCap);
    const pending = (headFinal.status === "PROMOTED" ? 1 : 0) + 1;
    const state = await getEvent(ctx, apis[0].baseUrl, events[round].id);
    ctx.assert(`promotion race ${round} conserves capacity`, () => assertLedger(state, { capacity: 2, pending }), correctnessCap);
  }
  return result(["release/expiry and withdrawal interleavings across two processes produced at most one hold per entry"]);
}

export const B_CASES = [
  { id: "B-01", run: b01 },
  { id: "B-02", run: b02 },
  { id: "B-03", run: b03 },
  { id: "B-04", run: b04 },
  { id: "B-05", run: b05 },
];
