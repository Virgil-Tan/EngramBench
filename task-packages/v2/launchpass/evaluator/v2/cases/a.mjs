import assert from "node:assert/strict";

import { eventPageFixture, seedFixture, waitlistWorkedExample } from "../lib/fixtures.mjs";
import {
  assertEvent,
  assertHold,
  assertLedger,
  assertOrder,
  assertPage,
  assertWaitlistEntry,
  canonical,
  descendingComparator,
  eventComparator,
} from "../lib/oracle.mjs";
import {
  assertEventEnvelope,
  assertHoldEnvelope,
  assertPublicError,
  assertReplay,
  assertSafeError,
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

async function a01(ctx) {
  const api = await ctx.startApi();
  const events = eventPageFixture(ctx.fixtures, 105);

  const missingToken = await ctx.request(api.baseUrl, "/api/admin/events", {
    method: "POST",
    contractExpectation: "invalid",
    headers: { "idempotency-key": ctx.key("missing-token") },
    json: { slug: events[0].slug, title: events[0].title, startsAt: events[0].startsAt, capacity: events[0].capacity },
  });
  assertSafeError(ctx, "missing administrator token is rejected safely", missingToken, [401, 403]);
  const wrongToken = await ctx.request(api.baseUrl, "/api/admin/events", {
    method: "POST",
    headers: { authorization: "Bearer incorrect", "idempotency-key": ctx.key("wrong-token") },
    json: { slug: events[0].slug, title: events[0].title, startsAt: events[0].startsAt, capacity: events[0].capacity },
  });
  assertSafeError(ctx, "wrong administrator token is rejected safely", wrongToken, [401, 403]);

  const created = [];
  for (const event of events) {
    const response = await ctx.createEvent(api.baseUrl, event);
    created.push(assertEventEnvelope(ctx, `create ${event.slug}`, response, {
      slug: event.slug,
      title: event.title,
      startsAt: new Date(event.startsAt).toISOString(),
      capacity: event.capacity,
      availableCapacity: event.capacity,
    }));
  }

  const duplicate = await ctx.createEvent(api.baseUrl, events[0], ctx.key("duplicate-slug"));
  assertSafeError(ctx, "duplicate slug is rejected", duplicate, [409]);
  const invalidSlug = `invalid-${ctx.uuid("invalid-event").slice(0, 8)}`;
  const invalid = await ctx.request(api.baseUrl, "/api/admin/events", {
    method: "POST",
    headers: { authorization: `Bearer ${ctx.adminToken}`, "idempotency-key": ctx.key("invalid-event") },
    json: { slug: invalidSlug, title: " ", startsAt: "not-a-time", capacity: 0, unexpected: true },
    contractExpectation: "invalid",
  });
  assertPublicError(ctx, "invalid event is rejected with the published validation error", invalid, 422, "VALIDATION_ERROR");
  const invalidSearch = await ctx.request(api.baseUrl, `/api/events?q=${invalidSlug}`);
  ctx.assert("invalid event created no record", () => assertPage(invalidSearch));
  ctx.equal("invalid event search is empty", invalidSearch.json.items.length, 0);

  const all = [];
  let cursor = null;
  do {
    const page = await ctx.request(api.baseUrl, `/api/events?limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    ctx.assert("event cursor page has exact public shape", () => assertPage(page, assertEvent));
    all.push(...page.json.items);
    cursor = page.json.nextCursor;
  } while (cursor !== null);
  ctx.equal("cursor pages contain every event once", all.length, created.length);
  ctx.equal("cursor pages contain no duplicates", new Set(all.map(({ id }) => id)).size, created.length);
  ctx.equal("event order is startsAt then id", all.map(({ id }) => id), [...created].sort(eventComparator).map(({ id }) => id));

  const search = await ctx.request(api.baseUrl, "/api/events?q=mIxEd&limit=100");
  ctx.assert("event search uses public page shape", () => assertPage(search, assertEvent));
  ctx.equal("event search is case-insensitive over titles", search.json.items.map(({ id }) => id), created.filter(({ title }) => /mixed/iu.test(title)).sort(eventComparator).map(({ id }) => id));
  const malformed = await ctx.request(api.baseUrl, "/api/events?cursor=definitely-not-a-cursor");
  assertPublicError(ctx, "malformed cursor has the published error", malformed, 400, "INVALID_CURSOR");
  ctx.ok("administrator token is absent from responses and process logs", !`${missingToken.text}${wrongToken.text}${api.logs}`.includes(ctx.adminToken));
  return result(["105 created events were searched and cursor-paged through public HTTP"]);
}

async function a02(ctx) {
  const event = ctx.event("reservation", { capacity: 5 });
  const customers = Array.from({ length: 7 }, (_, index) => ctx.customer(`reservation-${index}`));
  const api = await seedAndStart(ctx, seedFixture([event], customers), { api: { ttl: 3_600 } });

  const one = assertHoldEnvelope(ctx, "quantity-one hold", await ctx.createHold(api.baseUrl, {
    eventId: event.id, customerId: customers[0].id, quantity: 1,
  }), { eventId: event.id, customerId: customers[0].id, quantity: 1, status: "PENDING" });
  const four = assertHoldEnvelope(ctx, "quantity-four hold", await ctx.createHold(api.baseUrl, {
    eventId: event.id, customerId: customers[1].id, quantity: 4,
  }), { eventId: event.id, customerId: customers[1].id, quantity: 4, status: "PENDING" });
  ctx.ok("hold TTL is derived from configured lifetime", Math.abs((Date.parse(one.expiresAt) - Date.parse(one.createdAt)) - 3_600_000) <= 1_000);
  const reservedEvent = await getEvent(ctx, api.baseUrl, event.id);
  ctx.assert("successful reservation conserves capacity", () => assertLedger(reservedEvent, { capacity: 5, pending: 5 }), correctnessCap);

  const insufficient = await ctx.createHold(api.baseUrl, { eventId: event.id, customerId: customers[2].id, quantity: 1 });
  assertPublicError(ctx, "insufficient capacity is atomic", insufficient, 409, "INSUFFICIENT_CAPACITY");
  for (const [index, quantity] of [0, 5, 1.5, "1"].entries()) {
    const response = await ctx.createHold(api.baseUrl, { eventId: event.id, customerId: customers[index + 3].id, quantity }, undefined, { contractExpectation: "invalid" });
    assertPublicError(ctx, `invalid quantity ${String(quantity)} is rejected`, response, 422, "VALIDATION_ERROR");
  }
  const unknownEvent = await ctx.createHold(api.baseUrl, { eventId: ctx.uuid("unknown-event"), customerId: customers[2].id, quantity: 1 });
  assertSafeError(ctx, "unknown event is a stable not-found error", unknownEvent, [404]);
  const unknownCustomer = await ctx.createHold(api.baseUrl, { eventId: event.id, customerId: ctx.uuid("unknown-customer"), quantity: 1 });
  assertSafeError(ctx, "unknown customer is a stable not-found error", unknownCustomer, [404]);
  const finalEvent = await getEvent(ctx, api.baseUrl, event.id);
  ctx.assert("failed hold attempts did not change the ledger", () => assertLedger(finalEvent, { capacity: 5, pending: 5 }), correctnessCap);
  const firstHistory = await getHistory(ctx, api.baseUrl, customers[0].id, "holds");
  const secondHistory = await getHistory(ctx, api.baseUrl, customers[1].id, "holds");
  ctx.equal("only successful hold one exists", firstHistory.items.map(({ id }) => id), [one.id]);
  ctx.equal("only successful hold four exists", secondHistory.items.map(({ id }) => id), [four.id]);
  return result(["quantity boundaries, reservation ledger, and rejected attempts were observed through HTTP"]);
}

async function a03(ctx) {
  const event = ctx.event("terminal-history", { capacity: 10 });
  const customer = ctx.customer("terminal-history");
  const seededOrder = {
    id: ctx.uuid("seeded-order"), eventId: event.id, customerId: customer.id, quantity: 1,
    confirmedAt: ctx.fixtures.at({ days: -1 }),
  };
  let api = await seedAndStart(ctx, seedFixture([event], [customer], [seededOrder]), { api: { ttl: 3_600 } });
  const confirmedSource = assertHoldEnvelope(ctx, "confirm source", await ctx.createHold(api.baseUrl, {
    eventId: event.id, customerId: customer.id, quantity: 2,
  }));
  const confirmed = await ctx.confirm(api.baseUrl, confirmedSource.id);
  ctx.equal("confirm status", confirmed.status, 200);
  ctx.assert("confirm returns exactly hold and order", () => {
    assert.deepEqual(Object.keys(confirmed.json).sort(), ["hold", "order"]);
    assertHold(confirmed.json.hold, { id: confirmedSource.id, status: "CONFIRMED" });
    assertOrder(confirmed.json.order, { eventId: event.id, customerId: customer.id, holdId: confirmedSource.id, quantity: 2 });
  });
  const reconfirmed = await ctx.confirm(api.baseUrl, confirmedSource.id, ctx.key("reconfirm"));
  ctx.equal("already-confirmed hold returns 200", reconfirmed.status, 200);
  ctx.equal("already-confirmed hold reuses one logical order", reconfirmed.json.order.id, confirmed.json.order.id, correctnessCap);

  const releasedSource = assertHoldEnvelope(ctx, "release source", await ctx.createHold(api.baseUrl, {
    eventId: event.id, customerId: customer.id, quantity: 3,
  }));
  const released = await ctx.release(api.baseUrl, releasedSource.id);
  ctx.equal("release status", released.status, 200);
  ctx.assert("release returns exact final hold", () => {
    assert.deepEqual(Object.keys(released.json), ["hold"]);
    assertHold(released.json.hold, { id: releasedSource.id, status: "RELEASED" });
  });
  const rereleased = await ctx.release(api.baseUrl, releasedSource.id, ctx.key("rerelease"));
  ctx.equal("already-released hold returns 200", rereleased.status, 200);
  ctx.equal("already-released hold is stable", canonical(rereleased.json), canonical(released.json), correctnessCap);
  assertPublicError(ctx, "confirmed hold cannot be released", await ctx.release(api.baseUrl, confirmedSource.id), 409, "HOLD_NOT_RELEASABLE");
  assertPublicError(ctx, "released hold cannot be confirmed", await ctx.confirm(api.baseUrl, releasedSource.id), 409, "HOLD_NOT_CONFIRMABLE");

  await ctx.stop(api, "SIGKILL");
  api = await ctx.startApi({ ttl: 3_600 });
  const holds = await getHistory(ctx, api.baseUrl, customer.id, "holds");
  const orders = await getHistory(ctx, api.baseUrl, customer.id, "orders");
  ctx.equal("hold history survives restart and sorts descending", holds.items.map(({ id }) => id), [...holds.items].sort(descendingComparator("createdAt")).map(({ id }) => id));
  ctx.equal("order history survives restart and sorts descending", orders.items.map(({ id }) => id), [...orders.items].sort(descendingComparator("confirmedAt")).map(({ id }) => id));
  ctx.equal("history contains one runtime order and one seeded order", orders.items.length, 2);
  ctx.equal("seeded order exposes null holdId", orders.items.find(({ id }) => id === seededOrder.id).holdId, null);
  ctx.equal("runtime order exposes its hold UUID", orders.items.find(({ id }) => id === confirmed.json.order.id).holdId, confirmedSource.id);
  const terminalEvent = await getEvent(ctx, api.baseUrl, event.id);
  ctx.assert("terminal lifecycle preserves the ledger", () => assertLedger(terminalEvent, { capacity: 10, confirmed: 3 }), correctnessCap);
  return result(["confirm/release replays, cross-terminal conflicts, order identity, and restart history were observed"]);
}

async function a04(ctx) {
  const event = ctx.event("passive-expiry", { capacity: 4 });
  const confirmedEvent = ctx.event("deadline-confirm", { capacity: 2 });
  const customer = ctx.customer("passive-expiry");
  const api = await seedAndStart(ctx, seedFixture([event, confirmedEvent], [customer]), { api: { ttl: 2 } });
  const pending = assertHoldEnvelope(ctx, "short pending hold", await ctx.createHold(api.baseUrl, {
    eventId: event.id, customerId: customer.id, quantity: 2,
  }), { status: "PENDING" });
  ctx.equal("hold is pending before deadline", (await getHold(ctx, api.baseUrl, pending.id)).status, "PENDING");
  const reservedEvent = await getEvent(ctx, api.baseUrl, event.id);
  ctx.assert("capacity remains reserved before deadline", () => assertLedger(reservedEvent, { capacity: 4, pending: 2 }), correctnessCap);
  await ctx.sleep(Math.max(0, Date.parse(pending.expiresAt) - Date.now() + 250));
  const expiredResponse = await waitForHold(ctx, api.baseUrl, pending.id, (hold) => hold.status === "EXPIRED", {
    timeoutMs: Math.max(100, Date.parse(pending.expiresAt) + 2_000 - Date.now()),
    label: "passive expiration within two seconds",
  });
  ctx.equal("passive expiration is observable within the two-second window", expiredResponse.json.hold.status, "EXPIRED");
  const restoredEvent = await getEvent(ctx, api.baseUrl, event.id);
  ctx.assert("expiration restores capacity exactly once", () => assertLedger(restoredEvent, { capacity: 4 }), correctnessCap);
  assertPublicError(ctx, "expired hold cannot be confirmed", await ctx.confirm(api.baseUrl, pending.id), 409, "HOLD_NOT_CONFIRMABLE");
  assertPublicError(ctx, "expired hold cannot be released", await ctx.release(api.baseUrl, pending.id), 409, "HOLD_NOT_RELEASABLE");
  const history = await getHistory(ctx, api.baseUrl, customer.id, "holds");
  ctx.equal("expiration creates no duplicate history row", history.items.filter(({ id }) => id === pending.id).length, 1, correctnessCap);

  const beforeDeadline = assertHoldEnvelope(ctx, "deadline confirm source", await ctx.createHold(api.baseUrl, {
    eventId: confirmedEvent.id, customerId: customer.id, quantity: 1,
  }));
  const confirmed = await ctx.confirm(api.baseUrl, beforeDeadline.id);
  ctx.equal("confirm before deadline wins", confirmed.status, 200);
  await ctx.sleep(Math.max(0, Date.parse(beforeDeadline.expiresAt) - Date.now() + 2_100));
  ctx.equal("confirmed hold remains confirmed after original deadline", (await getHold(ctx, api.baseUrl, beforeDeadline.id)).status, "CONFIRMED", correctnessCap);
  const stillConfirmedEvent = await getEvent(ctx, api.baseUrl, confirmedEvent.id);
  ctx.assert("confirmed capacity is not restored by expiry", () => assertLedger(stillConfirmedEvent, { capacity: 2, confirmed: 1 }), correctnessCap);
  return result(["short TTL hold expired passively while a pre-deadline confirmation remained terminal"]);
}

async function a05(ctx) {
  const fixture = waitlistWorkedExample(ctx.fixtures);
  const extra = ctx.customer("tail-after-withdraw");
  const availableEvent = ctx.event("capacity-available", { capacity: 4 });
  const tinyEvent = ctx.event("quantity-exceeds-event", { capacity: 2 });
  const customers = [...fixture.owners, ...fixture.waiters, extra];
  const api = await seedAndStart(ctx, seedFixture([fixture.event, availableEvent, tinyEvent], customers), { api: { ttl: 3_600, waitlistTtl: 10 } });
  const sources = [];
  for (let index = 0; index < fixture.owners.length; index += 1) {
    sources.push(assertHoldEnvelope(ctx, `capacity source ${index}`, await ctx.createHold(api.baseUrl, {
      eventId: fixture.event.id, customerId: fixture.owners[index].id, quantity: 2,
    })));
  }
  const head = assertWaitlistEnvelope(ctx, "head joins waitlist", await ctx.joinWaitlist(api.baseUrl, fixture.event.id, fixture.waiters[0].id, 3), {
    eventId: fixture.event.id, customerId: fixture.waiters[0].id, quantity: 3, status: "WAITING", position: 1, holdId: null,
  });
  const tail = assertWaitlistEnvelope(ctx, "tail joins waitlist", await ctx.joinWaitlist(api.baseUrl, fixture.event.id, fixture.waiters[1].id, 1), {
    eventId: fixture.event.id, customerId: fixture.waiters[1].id, quantity: 1, status: "WAITING", position: 2, holdId: null,
  });
  const getHead = await ctx.getWaitlist(api.baseUrl, fixture.event.id, fixture.waiters[0].id);
  ctx.ok("waitlist GET returns a successful response", getHead.status >= 200 && getHead.status < 300);
  ctx.assert("waitlist GET returns the exact Manager envelope", () => {
    assert.deepEqual(Object.keys(getHead.json), ["waitlistEntry"]);
    assertWaitlistEntry(getHead.json.waitlistEntry, { id: head.id, position: 1 });
  });
  ctx.equal("published waitlist GET success status", getHead.status, 200);
  assertPublicError(ctx, "duplicate WAITING entry is rejected", await ctx.joinWaitlist(api.baseUrl, fixture.event.id, fixture.waiters[0].id, 3), 409, "WAITLIST_ENTRY_EXISTS");
  assertPublicError(ctx, "capacity-available waitlist join is rejected", await ctx.joinWaitlist(api.baseUrl, availableEvent.id, fixture.waiters[0].id, 1), 409, "CAPACITY_AVAILABLE");
  const tooLarge = await ctx.joinWaitlist(api.baseUrl, fixture.event.id, extra.id, 5, undefined, { contractExpectation: "invalid" });
  ctx.ok("waitlist quantity above the published maximum is rejected", tooLarge.status >= 400 && tooLarge.status < 500);
  const exceedsEvent = await ctx.joinWaitlist(api.baseUrl, tinyEvent.id, extra.id, 3);
  ctx.ok("waitlist quantity above total event capacity is rejected", exceedsEvent.status >= 400 && exceedsEvent.status < 500);

  const withdrawKey = ctx.key("withdraw-tail");
  const withdrawn = await ctx.withdrawWaitlist(api.baseUrl, fixture.event.id, fixture.waiters[1].id, withdrawKey);
  ctx.ok("waitlist DELETE returns a successful response", withdrawn.status >= 200 && withdrawn.status < 300);
  ctx.assert("waitlist DELETE returns the exact withdrawn envelope", () => {
    assert.deepEqual(Object.keys(withdrawn.json), ["waitlistEntry"]);
    assertWaitlistEntry(withdrawn.json.waitlistEntry, { id: tail.id, status: "WITHDRAWN", position: null, holdId: null });
  });
  ctx.equal("published waitlist DELETE success status", withdrawn.status, 200);
  assertReplay(ctx, "withdraw idempotency", await ctx.withdrawWaitlist(api.baseUrl, fixture.event.id, fixture.waiters[1].id, withdrawKey), withdrawn);
  const replacement = assertWaitlistEnvelope(ctx, "replacement tail joins", await ctx.joinWaitlist(api.baseUrl, fixture.event.id, extra.id, 1), {
    status: "WAITING", position: 2,
  });

  ctx.equal("first release succeeds", (await ctx.release(api.baseUrl, sources[0].id)).status, 200);
  const blockedHead = await ctx.getWaitlist(api.baseUrl, fixture.event.id, fixture.waiters[0].id);
  const blockedTail = await ctx.getWaitlist(api.baseUrl, fixture.event.id, extra.id);
  ctx.equal("head remains WAITING when only two places are available", blockedHead.json.waitlistEntry.status, "WAITING");
  ctx.equal("smaller tail is not bypass-promoted", blockedTail.json.waitlistEntry.status, "WAITING");
  ctx.equal("withdrawn entry remains withdrawn", (await ctx.getWaitlist(api.baseUrl, fixture.event.id, fixture.waiters[1].id)).json.waitlistEntry.status, "WITHDRAWN");
  ctx.equal("second release succeeds", (await ctx.release(api.baseUrl, sources[1].id)).status, 200);
  const promotedHead = await waitForWaitlist(ctx, api.baseUrl, fixture.event.id, fixture.waiters[0].id, (entry) => entry.status === "PROMOTED");
  const promotedTail = await waitForWaitlist(ctx, api.baseUrl, fixture.event.id, extra.id, (entry) => entry.status === "PROMOTED");
  ctx.assert("head promotion envelope is exact", () => assertWaitlistEntry(promotedHead.json.waitlistEntry, { id: head.id, status: "PROMOTED", position: null }));
  ctx.assert("tail promotion envelope is exact", () => assertWaitlistEntry(promotedTail.json.waitlistEntry, { id: replacement.id, status: "PROMOTED", position: null }));
  const promotedHold = await getHold(ctx, api.baseUrl, promotedHead.json.waitlistEntry.holdId);
  ctx.equal("promotion creates an ordinary pending hold", promotedHold.status, "PENDING");
  ctx.ok("promotion uses WAITLIST_HOLD_TTL_SECONDS", Math.abs((Date.parse(promotedHold.expiresAt) - Date.parse(promotedHold.createdAt)) - 10_000) <= 1_000);
  const promotedEvent = await getEvent(ctx, api.baseUrl, fixture.event.id);
  ctx.assert("continuous promotion consumes exactly the available prefix", () => assertLedger(promotedEvent, { capacity: 4, pending: 4 }), correctnessCap);
  return result(["Manager waitlist envelopes, no-bypass FIFO, withdraw, and two automatic promotions were observed"]);
}

export const A_CASES = [
  { id: "A-01", run: a01 },
  { id: "A-02", run: a02 },
  { id: "A-03", run: a03 },
  { id: "A-04", run: a04 },
  { id: "A-05", run: a05 },
];
