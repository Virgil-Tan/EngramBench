import { seedFixture, largeSeedFixture } from "../lib/fixtures.mjs";
import { assertEvent, assertLedger, assertOrder, assertPage, canonical, eventComparator, percentile, waitlistComparator } from "../lib/oracle.mjs";
import {
  assertHoldEnvelope,
  assertPublicError,
  correctnessCap,
  getEvent,
  getHistory,
  result,
  waitForWaitlist,
} from "./helpers.mjs";

function parseSummaryLines(stdout) {
  return String(stdout).split(/\r?\n/u).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

async function e01(ctx) {
  const invalidEvent = ctx.event("late-invalid", { capacity: 200 });
  const invalidCustomer = ctx.customer("late-invalid");
  const invalidOrders = Array.from({ length: 200 }, (_, index) => ({
    id: ctx.uuid(`late-invalid-order-${index}`),
    eventId: invalidEvent.id,
    customerId: invalidCustomer.id,
    quantity: 1,
    confirmedAt: ctx.fixtures.at({ days: -1, milliseconds: index }),
  }));
  invalidOrders.at(-1).customerId = ctx.uuid("missing-late-customer");
  const invalidSeeds = [
    seedFixture([invalidEvent], [invalidCustomer], invalidOrders),
    { ...seedFixture([ctx.event("unknown-field", { capacity: 1 })], [ctx.customer("unknown-field")]), unexpected: true },
    seedFixture([
      ctx.event("duplicate-one", { id: ctx.uuid("duplicate-event"), capacity: 1 }),
      ctx.event("duplicate-two", { id: ctx.uuid("duplicate-event"), capacity: 1 }),
    ], [ctx.customer("duplicate")]),
    seedFixture([ctx.event("over-capacity", { capacity: 1 })], [ctx.customer("over-capacity")], [
      { id: ctx.uuid("over-capacity-order"), eventId: ctx.uuid("event-over-capacity"), customerId: ctx.uuid("customer-over-capacity"), quantity: 2, confirmedAt: ctx.fixtures.at({ days: -1 }) },
    ]),
  ];
  for (const [index, invalidSeed] of invalidSeeds.entries()) {
    const invalid = await ctx.seed(invalidSeed, { expectFailure: true });
    ctx.ok(`invalid seed ${index} prints a concise diagnostic`, invalid.stderr.trim().length > 0 && invalid.stderr.length < 64_000);
  }

  const large = largeSeedFixture(ctx.fixtures);
  large.events[0].slug = "abc";
  large.events[0].title = "X";
  large.events[0].capacity = 1_000_000;
  large.events.at(-1).slug = "z9z";
  large.events.at(-1).title = "Boundary Event";
  const imported = await ctx.seed(large.seed, { timeoutMs: 900_000 });
  const summaries = parseSummaryLines(imported.stdout);
  ctx.equal("seed emits one machine-readable JSON summary", summaries.length, 1);
  ctx.ok("seed summary reports the published cardinalities", JSON.stringify(summaries[0]).includes("10000") && JSON.stringify(summaries[0]).includes("100000"));
  const api = await ctx.startApi({ ttl: 120 });
  const first = await getEvent(ctx, api.baseUrl, large.events[0].id);
  const last = await getEvent(ctx, api.baseUrl, large.events.at(-1).id);
  ctx.equal("minimum slug and title survive seed exactly", first.slug, "abc");
  ctx.equal("last valid event survives seed exactly", last.slug, "z9z");
  const sampledCustomer = large.customers[0];
  const orders = await getHistory(ctx, api.baseUrl, sampledCustomer.id, "orders");
  ctx.ok("large seed makes historical orders publicly queryable", orders.items.length > 0);
  ctx.ok("every sampled seeded order has null holdId", orders.items.every(({ holdId }) => holdId === null));

  const nonempty = await ctx.seed(seedFixture([
    ctx.event("must-not-import", { capacity: 1 }),
  ], [ctx.customer("must-not-import")]), { expectFailure: true });
  ctx.ok("nonempty database rejection is diagnostic", nonempty.stderr.trim().length > 0);
  const after = await getEvent(ctx, api.baseUrl, large.events[0].id);
  ctx.equal("failed nonempty import leaves existing data unchanged", canonical(after), canonical(first), correctnessCap);
  const absent = await ctx.request(api.baseUrl, `/api/events?q=must-not-import-${ctx.uuid("must-not-import").slice(0, 8)}`);
  ctx.equal("failed nonempty import adds no event", absent.json.items.length, 0, correctnessCap);
  return result(["late-invalid rejection left an empty database, then literal V1 imported 10k/10k/100k and rejected nonempty replay"]);
}

async function warmReads(ctx, apis, events, milliseconds = 10_000) {
  const deadline = Date.now() + milliseconds;
  let sequence = 0;
  await Promise.all(Array.from({ length: 16 }, async (_, worker) => {
    while (Date.now() < deadline) {
      const event = events[(sequence + worker) % events.length];
      sequence += 1;
      await ctx.request(apis[sequence % apis.length].baseUrl, `/api/events/${event.id}`, { record: false });
    }
  }));
}

async function e02(ctx) {
  const large = largeSeedFixture(ctx.fixtures);
  await ctx.seed(large.seed, { timeoutMs: 900_000 });
  const apis = [await ctx.startApi({ ttl: 3_600 }), await ctx.startApi({ ttl: 3_600 })];
  await warmReads(ctx, apis, large.events);
  const requests = Array.from({ length: 3_000 }, (_, index) => index);
  const responses = await ctx.concurrent(requests, 80, async (index) => {
    const api = apis[index % 2];
    if (index % 3 === 0) {
      const event = large.events[index % large.events.length];
      return { kind: "detail", event, response: await ctx.request(api.baseUrl, `/api/events/${event.id}`) };
    }
    if (index % 3 === 1) {
      const event = large.events[index % large.events.length];
      return { kind: "search", event, response: await ctx.request(api.baseUrl, `/api/events?q=${event.slug.toUpperCase()}&limit=20`) };
    }
    return { kind: "page", response: await ctx.request(api.baseUrl, "/api/events?q=performance%20launch&limit=100") };
  });
  for (const item of responses) {
    if (item.kind === "detail") {
      ctx.equal("performance detail status", item.response.status, 200);
      ctx.assert("performance detail remains exact", () => assertEvent(item.response.json.event, {
        id: item.event.id,
        availableCapacity: item.event.capacity - 10,
      }));
    } else {
      ctx.assert("performance list remains a real exact page", () => assertPage(item.response, assertEvent));
      if (item.kind === "search") {
        ctx.equal("performance search returns its real event", item.response.json.items.map(({ id }) => id), [item.event.id]);
      } else {
        ctx.equal("performance page stays correctly sorted", item.response.json.items.map(({ id }) => id), [...item.response.json.items].sort(eventComparator).map(({ id }) => id));
      }
    }
  }
  const p95 = percentile(responses.map(({ response }) => response.durationMs), 0.95);
  ctx.metric("scenario", "event-search");
  ctx.metric("dataset", { events: 10_000, customers: 10_000, orders: 100_000 });
  ctx.metric("requests", responses.length);
  ctx.metric("p50Ms", percentile(responses.map(({ response }) => response.durationMs), 0.5));
  ctx.metric("p95Ms", p95);
  ctx.metric("p99Ms", percentile(responses.map(({ response }) => response.durationMs), 0.99));
  ctx.ok("event search/list p95 meets the published 250ms target", p95 <= 250, `p95=${p95}`);
  return result(["after a 10-second warm-up, 3,000 exact event reads ran against the published large dataset"]);
}

async function e03(ctx) {
  const capacity = 50;
  const event = ctx.event("hot-performance", { capacity });
  const customers = Array.from({ length: 100 }, (_, index) => ctx.customer(`hot-performance-${index}`));
  await ctx.seed(seedFixture([event], customers));
  const apis = [await ctx.startApi({ ttl: 3_600 }), await ctx.startApi({ ttl: 3_600 })];
  await warmReads(ctx, apis, [event]);
  const holds = await ctx.concurrent(customers, 100, (customer, index) => ctx.createHold(
    apis[index % 2].baseUrl,
    { eventId: event.id, customerId: customer.id, quantity: 1 },
    ctx.key(`perf-hold-${index}`),
  ));
  const accepted = [];
  for (const response of holds) {
    if (response.status === 201) accepted.push(response);
    else assertPublicError(ctx, "expected hot-event conflict", response, 409, "INSUFFICIENT_CAPACITY");
  }
  ctx.equal("hot-event accepts exactly capacity requests", accepted.length, capacity, correctnessCap);
  const confirmations = await ctx.concurrent(accepted, 100, (created, index) => ctx.confirm(
    apis[(index + 1) % 2].baseUrl,
    created.json.hold.id,
    ctx.key(`perf-confirm-${index}`),
  ));
  ctx.ok("all accepted hot-event holds confirm", confirmations.every(({ status }) => status === 200), undefined, correctnessCap);
  const holdP95 = percentile(holds.map(({ durationMs }) => durationMs), 0.95);
  const confirmP95 = percentile(confirmations.map(({ durationMs }) => durationMs), 0.95);
  ctx.ok("hot-event hold p95 meets the published 500ms target", holdP95 <= 500, `p95=${holdP95}`);
  ctx.ok("hot-event confirm p95 meets the published 500ms target", confirmP95 <= 500, `p95=${confirmP95}`);
  const orders = await ctx.concurrent(customers, 30, (customer, index) => getHistory(ctx, apis[index % 2].baseUrl, customer.id, "orders"));
  const orderItems = orders.flatMap(({ items }) => items);
  ctx.equal("hot-event creates one unique order per accepted hold", orderItems.length, capacity, correctnessCap);
  ctx.equal("hot-event order IDs are unique", new Set(orderItems.map(({ id }) => id)).size, capacity, correctnessCap);
  const state = await getEvent(ctx, apis[0].baseUrl, event.id);
  ctx.assert("hot-event post-load ledger is exact", () => assertLedger(state, { capacity, confirmed: capacity }), correctnessCap);
  ctx.metric("scenario", "hot-hold-confirm");
  ctx.metric("clients", 100);
  ctx.metric("statusCounts", Object.fromEntries([...new Set(holds.map(({ status }) => status))].map((status) => [status, holds.filter((item) => item.status === status).length])));
  ctx.metric("holdP95Ms", holdP95);
  ctx.metric("confirmP95Ms", confirmP95);
  return result(["100 concurrent clients contended through two processes; successes confirmed and the ledger audited"]);
}

async function timedMixedLoad(ctx, apis, events, customers, milliseconds) {
  const startedAt = performance.now();
  const deadline = Date.now() + milliseconds;
  const latencies = [];
  const statuses = {};
  const confirmedByEvent = new Map(events.map(({ id }) => [id, 0]));
  const replays = [];
  let sequence = 0;
  await Promise.all(Array.from({ length: 80 }, async (_, worker) => {
    while (Date.now() < deadline) {
      const index = sequence++;
      const api = apis[index % apis.length];
      const event = events[index % events.length];
      const customer = customers[index % customers.length];
      let responses;
      if (index % 5 === 0) responses = [await ctx.request(api.baseUrl, "/api/events?q=mixed&limit=100")];
      else if (index % 5 === 1) responses = [await ctx.request(api.baseUrl, `/api/events/${event.id}`)];
      else {
        const key = ctx.key(`mixed-create-${index}`);
        const created = await ctx.createHold(api.baseUrl, { eventId: event.id, customerId: customer.id, quantity: 1 }, key);
        responses = [created];
        if (created.status === 201) {
          if (replays.length < 20) replays.push({ api, key, body: { eventId: event.id, customerId: customer.id, quantity: 1 }, response: created });
          if (index % 2 === 0) {
            const confirmed = await ctx.confirm(apis[(index + 1) % apis.length].baseUrl, created.json.hold.id, ctx.key(`mixed-confirm-${index}`));
            responses.push(confirmed);
            if (confirmed.status === 200) confirmedByEvent.set(event.id, confirmedByEvent.get(event.id) + 1);
          } else {
            responses.push(await ctx.release(apis[(index + 1) % apis.length].baseUrl, created.json.hold.id, ctx.key(`mixed-release-${index}`)));
          }
        }
      }
      for (const response of responses) {
        latencies.push(response.durationMs);
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      }
    }
  }));
  const elapsedMs = performance.now() - startedAt;
  return {
    completed: latencies.length,
    elapsedMs,
    throughputRps: latencies.length / (elapsedMs / 1_000),
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    statuses,
    confirmedByEvent,
    replays,
  };
}

async function e04(ctx) {
  const events = Array.from({ length: 30 }, (_, index) => ctx.event(`mixed-${index}`, { capacity: 100_000 }));
  const customers = Array.from({ length: 2_000 }, (_, index) => ctx.customer(`mixed-${index}`));
  const waitEvent = ctx.event("mixed-waitlist", { capacity: 20 });
  const owners = Array.from({ length: 5 }, (_, index) => ctx.customer(`mixed-owner-${index}`));
  const waiters = Array.from({ length: 20 }, (_, index) => ctx.customer(`mixed-waiter-${index}`));
  await ctx.seed(seedFixture([...events, waitEvent], [...customers, ...owners, ...waiters]));
  const apis = [await ctx.startApi({ ttl: 3_600, waitlistTtl: 60 }), await ctx.startApi({ ttl: 3_600, waitlistTtl: 60 })];
  const sources = [];
  for (let index = 0; index < owners.length; index += 1) sources.push(assertHoldEnvelope(ctx, `mixed waitlist source ${index}`, await ctx.createHold(apis[index % 2].baseUrl, {
    eventId: waitEvent.id, customerId: owners[index].id, quantity: 4,
  })));
  const joined = await ctx.concurrent(waiters, 20, (customer, index) => ctx.joinWaitlist(apis[index % 2].baseUrl, waitEvent.id, customer.id, 1, ctx.key(`mixed-join-${index}`)));
  const entries = joined.map(({ json }) => json.waitlistEntry);
  const fifo = [...entries].sort(waitlistComparator);
  for (let index = 0; index < fifo.length; index += 1) ctx.equal(`mixed waitlist initial position ${index + 1}`, fifo[index].position, index + 1);

  await warmReads(ctx, apis, events);
  const loadPromise = timedMixedLoad(ctx, apis, events, customers, 10_000);
  await ctx.concurrent(sources, 5, (source, index) => ctx.release(apis[index % 2].baseUrl, source.id, ctx.key(`mixed-source-release-${index}`)));
  const load = await loadPromise;
  ctx.ok("mixed run sustains the published 150 completed requests/s", load.throughputRps >= 150, `throughput=${load.throughputRps}`);
  ctx.equal("mixed run has zero unexpected 5xx", Object.entries(load.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0), 0);

  for (const event of events) {
    const state = await getEvent(ctx, apis[0].baseUrl, event.id);
    ctx.assert(`mixed event ${event.id} ledger matches successful confirmations`, () => assertLedger(state, {
      capacity: event.capacity,
      confirmed: load.confirmedByEvent.get(event.id),
    }), correctnessCap);
  }
  for (const replay of load.replays) {
    const response = await ctx.createHold(replay.api.baseUrl, replay.body, replay.key);
    ctx.equal("mixed post-load idempotency status replay", response.status, replay.response.status);
    ctx.equal("mixed post-load idempotency body replay", canonical(response.json), canonical(replay.response.json), correctnessCap);
  }
  const promoted = await ctx.concurrent(fifo, 20, async (entry, index) => {
    const response = await waitForWaitlist(ctx, apis[index % 2].baseUrl, waitEvent.id, entry.customerId, (value) => value.status === "PROMOTED", { timeoutMs: 15_000 });
    return response.json.waitlistEntry;
  });
  ctx.equal("mixed waitlist promotes every capacity-fitting entry once", promoted.length, 20, correctnessCap);
  ctx.equal("mixed waitlist promotion holds are unique", new Set(promoted.map(({ holdId }) => holdId)).size, 20, correctnessCap);
  const waitState = await getEvent(ctx, apis[0].baseUrl, waitEvent.id);
  ctx.assert("mixed waitlist post-load ledger is exact", () => assertLedger(waitState, { capacity: 20, pending: 20 }), correctnessCap);
  ctx.metric("scenario", "mixed-public-run");
  ctx.metric("dataset", { events: 31, customers: 2_025, waitlistEntries: 20 });
  ctx.metric("durationMs", load.elapsedMs);
  ctx.metric("completed", load.completed);
  ctx.metric("throughputRps", load.throughputRps);
  ctx.metric("statusCounts", load.statuses);
  ctx.metric("p50Ms", load.p50Ms);
  ctx.metric("p95Ms", load.p95Ms);
  ctx.metric("p99Ms", load.p99Ms);
  return result(["10-second mixed public load met throughput and passed capacity, idempotency, FIFO, and promotion audits"]);
}

export const E_CASES = [
  { id: "E-01", run: e01 },
  { id: "E-02", run: e02 },
  { id: "E-03", run: e03 },
  { id: "E-04", run: e04 },
];
