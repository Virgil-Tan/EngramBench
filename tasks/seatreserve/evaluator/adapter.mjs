import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const venueId = id(2);
const eventId = id(3);
const zoneId = id(4);
const priceVersionId = id(5);
const hash = (value) => createHash("sha256").update(value).digest("hex");
let migrationExpected;

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

const seatId = (index) => id(10_000 + index);

function seed(seedVersion = "hidden-seatreserve", seatCount = 2_000) {
  const seats = Array.from({ length: seatCount }, (_, index) => ({
    seatId: seatId(index), eventId, zoneId, row: `R${Math.floor(index / 100) + 1}`, number: (index % 100) + 1,
    accessible: index % 50 === 0, createdAt: "2026-01-01T00:00:00.000Z",
  }));
  return {
    schemaVersion: 1, seedVersion, importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Tenant" }],
    venues: [{ venueId, tenantId, name: "Hidden Hall" }],
    events: [{ eventId, tenantId, venueId, name: "Hidden Show", startsAt: "2030-01-01T20:00:00.000Z", state: "ON_SALE" }],
    zones: [{ zoneId, eventId, name: "Main", currency: "USD", activePriceVersionId: priceVersionId }],
    seats,
    priceVersions: [{ priceVersionId, zoneId, version: 1, state: "ACTIVE", unitAmountMinor: 5_000, feeMinor: 500, currency: "USD", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, createdAt: "2026-01-01T00:00:00.000Z" }],
    holds: [], holdSeats: [], orders: [], orderSeats: [], paymentIntents: [], providerReceipts: [],
  };
}

function holdPayload(index, overrides = {}) {
  return {
    tenantId, eventId, customerRef: `customer-${index}`, seatIds: [seatId(index * 2), seatId(index * 2 + 1)],
    ttlSeconds: 300, ...overrides,
  };
}

async function createHold(ctx, baseUrl, index, overrides = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/holds", `hold-${index}`, holdPayload(index, overrides));
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return response;
}

async function checkout(ctx, baseUrl, holdId, index, providerScenario = "SUCCEEDED") {
  const response = await ctx.mutate(baseUrl, `/api/v1/holds/${holdId}/checkout`, `checkout-${index}`, { providerScenario });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return response;
}

export async function startProviderDouble(ctx) {
  if (ctx.seatReserveProvider) return ctx.seatReserveProvider;
  const charges = new Map();
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { body = undefined; }
    const send = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && request.url === "/charges") {
      const exactKeys = body && Object.keys(body).sort().join(",") === "amountMinor,currency,providerRequestId,scenario";
      if (!exactKeys || typeof body.providerRequestId !== "string" || body.providerRequestId.length === 0
        || !Number.isSafeInteger(body.amountMinor) || body.amountMinor < 0 || !/^[A-Z]{3}$/u.test(body.currency)
        || !["SUCCEEDED", "FAILED", "TIMEOUT", "CONNECTION_RESET"].includes(body.scenario)) {
        send(400, { error: { code: "INVALID_REQUEST", message: "invalid charge request", details: {} } });
        return;
      }
      const canonical = JSON.stringify({
        providerRequestId: body.providerRequestId,
        amountMinor: body.amountMinor,
        currency: body.currency,
        scenario: body.scenario,
      });
      const existing = charges.get(body.providerRequestId);
      if (existing && existing.canonical !== canonical) {
        send(409, { error: { code: "PROVIDER_REQUEST_CONFLICT", message: "provider request changed", details: {} } });
        return;
      }
      const record = existing ?? {
        canonical,
        scenario: body.scenario,
        outcome: body.scenario === "FAILED" ? "FAILED"
          : body.scenario === "SUCCEEDED" ? "SUCCEEDED"
            : Number.parseInt(hash(body.providerRequestId).at(-1), 16) % 2 ? "SUCCEEDED" : "FAILED",
        providerTransactionId: null,
      };
      if (record.outcome === "SUCCEEDED") record.providerTransactionId = `txn-${hash(body.providerRequestId).slice(0, 24)}`;
      charges.set(body.providerRequestId, record);
      if (record.scenario === "CONNECTION_RESET") {
        response.destroy();
        return;
      }
      if (record.scenario === "TIMEOUT") {
        send(504, { error: { code: "PROVIDER_TIMEOUT", message: "provider outcome is unknown", details: {} } });
        return;
      }
      send(200, { outcome: record.outcome, providerTransactionId: record.providerTransactionId });
      return;
    }
    const matched = request.method === "GET" && request.url?.match(/^\/charges\/([^/?]+)$/u);
    if (matched) {
      const record = charges.get(decodeURIComponent(matched[1]));
      if (!record) {
        send(404, { error: { code: "NOT_FOUND", message: "unknown provider request", details: {} } });
        return;
      }
      send(200, { outcome: record.outcome, providerTransactionId: record.providerTransactionId });
      return;
    }
    send(404, { error: { code: "NOT_FOUND", message: "unknown provider path", details: {} } });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const provider = { server, sockets, charges, baseUrl: `http://127.0.0.1:${address.port}` };
  ctx.servers.push(provider);
  const startWorker = ctx.startWorker.bind(ctx);
  ctx.startWorker = (extraEnv = {}, workspace) => startWorker({ PROVIDER_BASE_URL: provider.baseUrl, ...extraEnv }, workspace);
  ctx.seatReserveProvider = provider;
  return provider;
}

function assertRecordsPreserved(ctx, actual, expected) {
  const records = new Set(actual.map((item) => ctx.canonical(item)));
  for (const item of expected) assert.ok(records.has(ctx.canonical(item)), "V1 record changed during FINAL migration");
}

async function prepareMigrationState(ctx, api, workspace) {
  await startProviderDouble(ctx);
  const confirmedHold = await createHold(ctx, api.baseUrl, 700);
  const confirmedHoldId = find(confirmedHold.json, "holdId");
  const confirmedCheckout = await checkout(ctx, api.baseUrl, confirmedHoldId, 700, "SUCCEEDED");
  const confirmedPaymentIntentId = find(confirmedCheckout.json, "paymentIntentId");
  const worker = await ctx.startWorker({}, workspace);
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.resources.paymentIntents.some(({ paymentIntentId, state }) => paymentIntentId === confirmedPaymentIntentId && state === "SUCCEEDED");
  }, { label: "V1 confirmed payment", children: [worker] });
  await ctx.stop(worker);
  const pendingHold = await createHold(ctx, api.baseUrl, 701);
  const pendingHoldId = find(pendingHold.json, "holdId");
  const pendingCheckout = await checkout(ctx, api.baseUrl, pendingHoldId, 701, "TIMEOUT");
  const pendingPaymentIntentId = find(pendingCheckout.json, "paymentIntentId");
  const snapshot = await ctx.snapshot(api.baseUrl);
  const holdIds = new Set([confirmedHoldId, pendingHoldId]);
  const orderIds = new Set(snapshot.resources.orders.filter(({ holdId }) => holdIds.has(holdId)).map(({ orderId }) => orderId));
  const paymentIntentIds = new Set([confirmedPaymentIntentId, pendingPaymentIntentId]);
  const ownedSeatIds = new Set(snapshot.resources.holdSeats.filter((item) => holdIds.has(item.holdId)).map(({ seatId: value }) => value));
  migrationExpected = {
    pendingPaymentIntentId,
    confirmedPaymentIntentId,
    resources: {
      events: snapshot.resources.events,
      zones: snapshot.resources.zones,
      seats: snapshot.resources.seats.filter((item) => ownedSeatIds.has(item.seatId)),
      priceVersions: snapshot.resources.priceVersions,
      holds: snapshot.resources.holds.filter((item) => holdIds.has(item.holdId)),
      holdSeats: snapshot.resources.holdSeats.filter((item) => holdIds.has(item.holdId)),
      orders: snapshot.resources.orders.filter((item) => orderIds.has(item.orderId)),
      orderSeats: snapshot.resources.orderSeats.filter((item) => orderIds.has(item.orderId)),
      paymentIntents: snapshot.resources.paymentIntents.filter((item) => paymentIntentIds.has(item.paymentIntentId)),
      providerReceipts: snapshot.resources.providerReceipts,
    },
    work: snapshot.work,
    outboxEvents: snapshot.events,
  };
}

const spec = {
  label: "SeatReserve atomic SeatHold",
  performanceScenarioIds: ["seat-hold-ingest", "hot-seat-contention", "payment-expiry-recovery"],
  seed: async () => seed(),
  path: "/api/v1/holds",
  payload: (index) => holdPayload(index),
  conflictPayload: (index) => holdPayload(index, { ttlSeconds: 600 }),
  resource: "holds",
  identity: (json) => find(json, "holdId"),
  resourceIdentity: ({ holdId }) => holdId,
  workIdentity: (json) => find(json, "paymentIntentId") ?? find(json, "holdId"),
  async afterPrepare(ctx, api, _receiver, workspace) {
    if (workspace !== ctx.workspace) await prepareMigrationState(ctx, api, workspace);
  },
  async migrationVerify(ctx, { created, snapshot }) {
    assert.ok(migrationExpected, "V1 migration fixture was not prepared");
    for (const [key, expected] of Object.entries(migrationExpected.resources)) {
      assertRecordsPreserved(ctx, snapshot.resources[key], expected);
    }
    assertRecordsPreserved(ctx, snapshot.work, migrationExpected.work);
    assertRecordsPreserved(ctx, snapshot.events, migrationExpected.outboxEvents);
    assert.ok(snapshot.work.some(({ aggregateId, terminal }) => aggregateId === migrationExpected.pendingPaymentIntentId && !terminal), "V1 pending Payment Work was not preserved");
    assert.equal(snapshot.resources.paymentIntents.find(({ paymentIntentId }) => paymentIntentId === migrationExpected.confirmedPaymentIntentId)?.state, "SUCCEEDED");
    const pendingHoldId = find(created.json, "holdId");
    assert.ok(snapshot.work.some(({ aggregateId, terminal }) => aggregateId === pendingHoldId && !terminal), "V1 pending Hold Work was not preserved");
    assert.equal(snapshot.resources.waitlistEntries.length, 0);
    assert.equal(snapshot.resources.seatOffers.length, 0);
    assertSeatOwners(snapshot);
  },
  async verify(ctx, baseUrl, response) {
    const holdId = find(response.json, "holdId");
    const snapshot = await ctx.snapshot(baseUrl);
    const hold = snapshot.resources.holds.find((item) => item.holdId === holdId);
    const seats = snapshot.resources.holdSeats.filter((item) => item.holdId === holdId);
    assert.equal(hold.state, "HELD");
    assert.equal(seats.length, 2);
    assert.equal(new Set(seats.map(({ seatId: value }) => value)).size, 2);
    assert.equal(hold.totalMinor, seats.reduce((sum, item) => sum + item.unitAmountMinor + item.feeMinor, 0));
    assert.ok(seats.every((item) => item.priceVersionId === priceVersionId));
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, "/api/v1/holds", "h04-duplicate-seat", {
      tenantId, eventId, customerRef: "invalid", seatIds: [seatId(100), seatId(100)], ttlSeconds: 300,
    });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.holds.length, before.resources.holds.length);
    assert.equal(after.resources.holdSeats.length, before.resources.holdSeats.length);
  },
  async contention(ctx, baseUrls) {
    const payload = { tenantId, eventId, customerRef: "hot-seat", seatIds: [seatId(100)], ttlSeconds: 300 };
    const responses = await Promise.all(Array.from({ length: 32 }, (_, index) =>
      ctx.mutate(baseUrls[index % 2], "/api/v1/holds", `hot-seat-${index}`, payload)));
    assert.equal(responses.filter(({ status }) => status >= 200 && status < 300).length, 1);
    assert.ok(responses.filter(({ status }) => status === 409).length >= 31);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    const owners = snapshot.resources.holdSeats.filter((item) => item.seatId === seatId(100));
    assert.equal(owners.length, 1);
  },
  async prepareWork(ctx, baseUrl) {
    await startProviderDouble(ctx);
    const held = await createHold(ctx, baseUrl, 500);
    return checkout(ctx, baseUrl, find(held.json, "holdId"), 500, "SUCCEEDED");
  },
  manager: {
    path: "/api/v1/waitlist-entries",
    payload: (index) => ({
      tenantId, eventId, customerRef: `waitlist-${index}`, seatCount: 2,
      allowedZoneIds: [zoneId], maxUnitTotalMinor: 6_000, expiresAt: "2030-01-01T00:00:00.000Z",
    }),
    async verify(ctx, baseUrl, response) {
      const waitlistEntryId = find(response.json, "waitlistEntryId");
      const worker = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const offer = value.resources.seatOffers.find((item) => item.waitlistEntryId === waitlistEntryId && item.state === "ACTIVE");
        return offer ? value : undefined;
      }, { timeoutMs: 60_000, label: "waitlist offer", children: [worker] });
      const offer = snapshot.resources.seatOffers.find((item) => item.waitlistEntryId === waitlistEntryId && item.state === "ACTIVE");
      assert.equal(offer.items.length, 2);
      const seatsById = new Map(snapshot.resources.seats.map((seat) => [seat.seatId, seat]));
      const offeredSeats = offer.items.map(({ seatId: value }) => seatsById.get(value));
      assert.ok(offeredSeats.every(Boolean));
      assert.equal(new Set(offeredSeats.map(({ row }) => row)).size, 1);
      assert.equal(new Set(offeredSeats.map(({ zoneId: value }) => value)).size, 1);
      const numbers = offeredSeats.map(({ number }) => number).sort((a, b) => a - b);
      assert.deepEqual(numbers, [numbers[0], numbers[0] + 1]);
      assert.ok(offer.items.every((item) => item.priceVersionId === priceVersionId && item.unitAmountMinor + item.feeMinor <= 6_000));
      assert.equal(offer.totalMinor, offer.items.reduce((sum, item) => sum + item.unitAmountMinor + item.feeMinor, 0));
      assert.equal(Date.parse(offer.expiresAt) - Date.parse(offer.createdAt), 120_000);
      const queried = await ctx.request(baseUrl, `/api/v1/seat-offers/${offer.seatOfferId}`);
      assert.equal(queried.status, 200, queried.text);
      assert.equal(find(queried.json, "seatOfferId"), offer.seatOfferId);
      const accepted = await ctx.mutate(baseUrl, `/api/v1/seat-offers/${offer.seatOfferId}/accept`, "h10-offer-accept", {});
      assert.ok(accepted.status >= 200 && accepted.status < 300, accepted.text);
      const final = await ctx.snapshot(baseUrl);
      assert.equal(final.resources.seatOffers.find((item) => item.seatOfferId === offer.seatOfferId)?.state, "ACCEPTED");
      const holdId = find(accepted.json, "holdId");
      const hold = final.resources.holds.find((item) => item.holdId === holdId);
      assert.equal(final.resources.waitlistEntries.find((item) => item.waitlistEntryId === waitlistEntryId)?.state, "FULFILLED");
      assert.equal(hold.state, "HELD");
      assert.equal(Date.parse(hold.expiresAt) - Date.parse(hold.createdAt), 300_000);
      const holdSeats = final.resources.holdSeats.filter((item) => item.holdId === holdId);
      assert.deepEqual(new Set(holdSeats.map(({ seatId: value }) => value)), new Set(offer.items.map(({ seatId: value }) => value)));
      assert.deepEqual(new Set(holdSeats.map(({ priceVersionId: value }) => value)), new Set(offer.items.map(({ priceVersionId: value }) => value)));
      assertSeatOwners(final);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const waitlistEntryId = find(response.json, "waitlistEntryId");
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === waitlistEntryId ? held : { status: 204 });
      const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "seatreserve-h11" });
      await ctx.waitFor(() => barrier.ledger.some((entry) =>
        entry.json?.point === "worker.claimed" && entry.json?.aggregateId === waitlistEntryId), {
        label: "waitlist claim before cancel",
        children: [first],
      });
      const cancellations = await Promise.all(baseUrls.map((baseUrl, index) =>
        ctx.mutate(baseUrl, `/api/v1/waitlist-entries/${waitlistEntryId}/cancel`, `h11-waitlist-cancel-${index}`, {})));
      assert.ok(cancellations.some(({ status }) => status >= 200 && status < 300));
      assert.ok(cancellations.every(({ status, json }) => (status >= 200 && status < 300)
        || (status === 409 && json?.error?.code === "WAITLIST_ENTRY_TERMINAL")));
      await ctx.stop(first, "SIGKILL");
      release({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const replacements = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const entry = value.resources.waitlistEntries.find((item) => item.waitlistEntryId === waitlistEntryId);
        const work = value.work.filter((item) => item.kind === "WAITLIST_MATCH" && item.aggregateId === waitlistEntryId);
        return entry?.state === "CANCELLED" && work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
      }, { timeoutMs: 60_000, label: "cancelled waitlist drain", children: replacements });
      assert.equal(snapshot.resources.waitlistEntries.filter((item) => item.waitlistEntryId === waitlistEntryId).length, 1);
      assert.equal(snapshot.resources.seatOffers.filter((item) => item.waitlistEntryId === waitlistEntryId && item.state === "ACTIVE").length, 0);
      const racedEntry = await ctx.mutate(baseUrls[0], "/api/v1/waitlist-entries", "h11-offer-race-entry", {
        tenantId, eventId, customerRef: "waitlist-race", seatCount: 2,
        allowedZoneIds: [zoneId], maxUnitTotalMinor: 6_000, expiresAt: "2030-01-01T00:00:00.000Z",
      });
      assert.ok(racedEntry.status >= 200 && racedEntry.status < 300, racedEntry.text);
      const racedEntryId = find(racedEntry.json, "waitlistEntryId");
      const racedOffer = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        return value.resources.seatOffers.find((item) => item.waitlistEntryId === racedEntryId && item.state === "ACTIVE");
      }, { timeoutMs: 60_000, label: "offer for accept-decline race", children: replacements });
      const outcomes = await Promise.all([
        ctx.mutate(baseUrls[0], `/api/v1/seat-offers/${racedOffer.seatOfferId}/accept`, "h11-offer-accept", {}),
        ctx.mutate(baseUrls[1], `/api/v1/seat-offers/${racedOffer.seatOfferId}/decline`, "h11-offer-decline", {}),
      ]);
      assert.equal(outcomes.filter(({ status }) => status >= 200 && status < 300).length, 1);
      assert.ok(outcomes.filter(({ status }) => status < 200 || status >= 300)
        .every(({ status, json }) => status === 409 && ["SEAT_OFFER_TERMINAL", "SEAT_OFFER_OWNERSHIP_CHANGED"].includes(json?.error?.code)));
      const final = await ctx.snapshot(baseUrls[0]);
      const terminalOffer = final.resources.seatOffers.find((item) => item.seatOfferId === racedOffer.seatOfferId);
      assert.ok(["ACCEPTED", "DECLINED"].includes(terminalOffer.state));
      assert.ok(final.resources.holds.filter((item) => item.holdId === terminalOffer.holdId).length <= 1);
      assertSeatOwners(final);
    },
  },
  performance: seatreservePerformance,
};

function percentile(values, fraction) { return values[Math.max(0, Math.ceil(values.length * fraction) - 1)]; }
async function fixedLoad(ctx, { count, concurrency, request }) {
  const latencies = [], statuses = new Map(), startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const started = performance.now(), response = await request(index);
    latencies.push(performance.now() - started); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((a,b)=>a-b);
  return { completed:count,durationMs,throughput:count/(durationMs/1_000),p50:percentile(latencies,.5),p95:percentile(latencies,.95),p99:percentile(latencies,.99),statuses:Object.fromEntries(statuses) };
}

function statusCount(load, predicate) {
  return Object.entries(load.statuses).filter(([status]) => predicate(Number(status))).reduce((sum, [, count]) => sum + count, 0);
}

function assertSuccessful(load, expected) {
  assert.equal(statusCount(load, (status) => status >= 200 && status < 300), expected);
  assert.equal(statusCount(load, (status) => status >= 500), 0);
}

function assertSeatOwners(snapshot) {
  const owners = new Map();
  const holds = new Map(snapshot.resources.holds.map((hold) => [hold.holdId, hold]));
  const orders = new Map(snapshot.resources.orders.map((order) => [order.orderId, order]));
  for (const item of snapshot.resources.holdSeats) {
    const hold = holds.get(item.holdId);
    if (["HELD","CHECKOUT"].includes(hold?.state)) owners.set(item.seatId, (owners.get(item.seatId) ?? 0) + 1);
  }
  for (const item of snapshot.resources.orderSeats) {
    const order = orders.get(item.orderId);
    if (["PAYMENT_UNKNOWN","CONFIRMED"].includes(order?.state)) owners.set(item.seatId, (owners.get(item.seatId) ?? 0) + 1);
  }
  for (const offer of snapshot.resources.seatOffers ?? []) {
    if (offer.state === "ACTIVE") {
      for (const item of offer.items) owners.set(item.seatId, (owners.get(item.seatId) ?? 0) + 1);
    }
  }
  assert.ok([...owners.values()].every((count) => count === 1), "a seat has multiple live owners");
  return owners;
}

async function seatreservePerformance(ctx, assertions) {
  const scale = performanceScale();
  const ingestCount = Math.max(1_000, Math.ceil(50_000 * scale));
  const hotSeatCount = Math.max(100, Math.ceil(1_000 * scale));
  const paymentCount = Math.max(250, Math.ceil(5_000 * scale));
  const seatCount = ingestCount + hotSeatCount + paymentCount + 10_000;
  await ctx.prepare();
  assert.equal((await ctx.seed(seed("perf-seatreserve", seatCount))).exitCode, 0);
  const provider = await startProviderDouble(ctx);
  const apis = await Promise.all(Array.from({ length: 4 }, () => ctx.startApi()));
  let workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));

  const ingest = await fixedLoad(ctx, { count: ingestCount, concurrency: 96, request: (index) =>
    ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/holds", `perf-hold-${index}`, {
      tenantId, eventId, customerRef: `perf-${index}`, seatIds: [seatId(index)], ttlSeconds: 900,
    }) });
  assert.ok(ingest.throughput >= 250 && ingest.p95 <= 400, `seat-hold-ingest ${ingest.throughput}/s p95=${ingest.p95}`);
  assertSuccessful(ingest, ingestCount);
  const ingestSnapshot = await ctx.snapshot(apis[0].baseUrl);
  const ingestSeatIds = new Set(Array.from({ length: ingestCount }, (_, index) => seatId(index)));
  const ingestHolds = ingestSnapshot.resources.holds.filter(({ customerRef }) => customerRef.startsWith("perf-"));
  const ingestHoldIds = new Set(ingestHolds.map(({ holdId }) => holdId));
  const ingestHoldSeats = ingestSnapshot.resources.holdSeats.filter(({ holdId }) => ingestHoldIds.has(holdId));
  assert.equal(ingestHolds.length, ingestCount);
  assert.equal(ingestHoldSeats.length, ingestCount);
  assert.equal(new Set(ingestHoldSeats.map(({ seatId: value }) => value)).size, ingestCount);
  assert.ok(ingestHoldSeats.every((item) => ingestSeatIds.has(item.seatId) && item.priceVersionId === priceVersionId));
  assert.ok(ingestHolds.every(({ totalMinor }) => totalMinor === 5_500));
  const ingestOwners = assertSeatOwners(ingestSnapshot);
  assert.ok([...ingestSeatIds].every((value) => ingestOwners.get(value) === 1));
  assertions.push(`seat-hold-ingest ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  const hotAttempts = Math.max(2_000, Math.ceil(20_000 * scale));
  const hotBase = ingestCount;
  const hot = await fixedLoad(ctx, { count: hotAttempts, concurrency: 128, request: (index) =>
    ctx.mutate(apis[index % apis.length].baseUrl, "/api/v1/holds", `perf-hot-${index}`, {
      tenantId, eventId, customerRef: `hot-${index}`, seatIds: [seatId(hotBase + (index % hotSeatCount))], ttlSeconds: 900,
    }) });
  assert.ok(hot.throughput >= 300 && hot.p95 <= 500, `hot-seat-contention ${hot.throughput}/s p95=${hot.p95}`);
  assert.equal(statusCount(hot, (status) => status >= 200 && status < 300), hotSeatCount);
  assert.equal(statusCount(hot, (status) => status === 409), hotAttempts - hotSeatCount);
  assert.equal(statusCount(hot, (status) => status >= 500), 0);
  const afterHot = await ctx.snapshot(apis[0].baseUrl);
  const hotSeatIds = new Set(Array.from({ length: hotSeatCount }, (_, index) => seatId(hotBase + index)));
  const hotOwners = assertSeatOwners(afterHot);
  assert.ok([...hotSeatIds].every((value) => hotOwners.get(value) === 1));
  assertions.push(`hot-seat-contention ${hot.throughput.toFixed(1)}/s p95 ${hot.p95.toFixed(1)}ms`);

  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const paymentBase = hotBase + hotSeatCount;
  const holds = await ctx.concurrent(Array.from({length:paymentCount}),64,(_,index)=>
    ctx.mutate(apis[index%apis.length].baseUrl,"/api/v1/holds",`payment-hold-${index}`,{
      tenantId,eventId,customerRef:`payment-${index}`,seatIds:[seatId(paymentBase+index)],ttlSeconds:30}));
  assert.ok(holds.every(({ status }) => status >= 200 && status < 300));
  const checkouts = await ctx.concurrent(holds,64,(held,index)=>checkout(ctx,apis[index%apis.length].baseUrl,find(held.json,"holdId"),10_000+index,"TIMEOUT"));
  const holdIds = holds.map(({ json }) => find(json, "holdId"));
  const holdIdSet = new Set(holdIds);
  const paymentIntentIds = checkouts.map(({ json }) => find(json, "paymentIntentId"));
  const paymentIntentIdSet = new Set(paymentIntentIds);
  let release;
  const heldBarrier=new Promise((resolve)=>{release=resolve;});
  const barrier=await ctx.receiver((entry)=>entry.json?.point==="worker.claimed"&&paymentIntentIdSet.has(entry.json?.aggregateId)?heldBarrier:{status:204});
  const first=await Promise.all(Array.from({length:2},()=>ctx.startWorker({TEST_BARRIER_URL:barrier.url,TEST_BARRIER_TOKEN:"seatreserve-perf"})));
  await ctx.waitFor(()=>barrier.ledger.filter((entry)=>entry.json?.point==="worker.claimed"&&paymentIntentIdSet.has(entry.json?.aggregateId)).length>=2,{label:"two payment claims",children:first});
  await Promise.all(first.map((worker)=>ctx.stop(worker,"SIGKILL")));
  release({status:204});
  await new Promise((resolve)=>setTimeout(resolve,3_200));
  const startedAt=Date.now();
  const replacements=await Promise.all(Array.from({length:4},()=>ctx.startWorker()));
  let paymentSnapshot = await ctx.waitFor(async()=>{
    const snapshot=await ctx.snapshot(apis[0].baseUrl);
    const intents=snapshot.resources.paymentIntents.filter(({paymentIntentId})=>paymentIntentIdSet.has(paymentIntentId));
    return intents.length===paymentCount&&intents.every(({state})=>["UNKNOWN","SUCCEEDED","FAILED"].includes(state))?snapshot:undefined;
  },{timeoutMs:60_000,label:"unknown payment outcomes",children:replacements});
  const unresolved = paymentSnapshot.resources.paymentIntents.filter(({paymentIntentId,state})=>paymentIntentIdSet.has(paymentIntentId)&&state==="UNKNOWN");
  const reconciles = await ctx.concurrent(unresolved,64,(intent,index)=>ctx.mutate(
    apis[index%apis.length].baseUrl,
    `/api/v1/payment-intents/${intent.paymentIntentId}/reconcile`,
    `perf-reconcile-${index}`,
    {},
  ));
  assert.ok(reconciles.every(({status})=>status>=200&&status<300));
  const final=await ctx.waitFor(async()=>{
    const snapshot=await ctx.snapshot(apis[0].baseUrl);
    const intents=snapshot.resources.paymentIntents.filter(({paymentIntentId})=>paymentIntentIdSet.has(paymentIntentId));
    const orders=snapshot.resources.orders.filter(({paymentIntentId})=>paymentIntentIdSet.has(paymentIntentId));
    const targetHolds=snapshot.resources.holds.filter(({holdId})=>holdIdSet.has(holdId));
    const pending=snapshot.work.some(({kind,aggregateId,terminal})=>
      ((["PAYMENT_CAPTURE","PAYMENT_RECONCILE"].includes(kind)&&paymentIntentIdSet.has(aggregateId))
        ||(kind==="HOLD_EXPIRY"&&holdIdSet.has(aggregateId)))&&!terminal);
    return intents.length===paymentCount
      &&intents.every(({state})=>["SUCCEEDED","FAILED"].includes(state))
      &&orders.length===paymentCount
      &&orders.every(({state})=>["CONFIRMED","CANCELLED"].includes(state))
      &&targetHolds.length===paymentCount
      &&targetHolds.every(({state})=>["CONVERTED","CANCELLED"].includes(state))
      &&!pending? snapshot:undefined;
  },{timeoutMs:90_000,label:"payment and expiry drain",children:replacements});
  const durationMs=Date.now()-startedAt;
  const intents=final.resources.paymentIntents.filter(({paymentIntentId})=>paymentIntentIdSet.has(paymentIntentId));
  const ordersById=new Map(final.resources.orders.filter(({paymentIntentId})=>paymentIntentIdSet.has(paymentIntentId)).map((order)=>[order.orderId,order]));
  const holdsById=new Map(final.resources.holds.filter(({holdId})=>holdIdSet.has(holdId)).map((hold)=>[hold.holdId,hold]));
  assertSeatOwners(final);
  assert.equal(new Set(intents.map(({providerRequestId})=>providerRequestId)).size,paymentCount);
  assert.equal(provider.charges.size,paymentCount);
  assert.ok(intents.some(({state})=>state==="SUCCEEDED"));
  assert.ok(intents.some(({state})=>state==="FAILED"));
  for(const intent of intents){
    const order=ordersById.get(intent.orderId);
    const hold=holdsById.get(order.holdId);
    assert.equal(order.state,intent.state==="SUCCEEDED"?"CONFIRMED":"CANCELLED");
    assert.equal(hold.state,intent.state==="SUCCEEDED"?"CONVERTED":"CANCELLED");
  }
  const transactionIds=intents.filter(({state})=>state==="SUCCEEDED").map(({providerTransactionId})=>providerTransactionId);
  assert.ok(transactionIds.every((value)=>typeof value==="string"));
  assert.equal(new Set(transactionIds).size,transactionIds.length);
  assert.ok(durationMs<=90_000);
  assertions.push(`payment-expiry-recovery ${paymentCount} orders in ${durationMs}ms after two SIGKILLs`);
  return {metrics:[{scenarioId:"seat-hold-ingest",...ingest},{scenarioId:"hot-seat-contention",...hot},{scenarioId:"payment-expiry-recovery",completed:paymentCount,durationMs,killedWorkers:2,replacementWorkers:4}]};
}

export default standardAdapter(spec);
