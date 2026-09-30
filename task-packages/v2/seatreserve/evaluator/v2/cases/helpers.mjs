import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { assertEventSequence, assertFrozenTotals, assertOfferSelection, assertPaymentIdentity, assertSeatConservation, assertSorted, canonicalJson, liveSeatOwners, percentile, selectWaitlistSeats } from "../oracles/index.mjs";

export { assertFrozenTotals, assertOfferSelection, assertPaymentIdentity, assertSeatConservation, liveSeatOwners, selectWaitlistSeats } from "../oracles/index.mjs";

const builds = new Map();
export const HOLD_KEYS = Object.freeze(["holdId", "tenantId", "eventId", "customerRef", "state", "expiresAt", "paymentGraceExpiresAt", "totalMinor", "currency", "createdAt", "terminalAt", "sequence"]);
export const ORDER_KEYS = Object.freeze(["orderId", "holdId", "tenantId", "eventId", "customerRef", "state", "totalMinor", "currency", "paymentIntentId", "createdAt", "confirmedAt", "sequence"]);
export const PAYMENT_KEYS = Object.freeze(["paymentIntentId", "orderId", "amountMinor", "currency", "state", "providerRequestId", "providerTransactionId", "createdAt", "resolvedAt", "sequence"]);
export const WAITLIST_KEYS = Object.freeze(["waitlistEntryId", "tenantId", "eventId", "customerRef", "seatCount", "allowedZoneIds", "maxUnitTotalMinor", "expiresAt", "state", "createdAt", "cancelledAt"]);
export const OFFER_KEYS = Object.freeze(["seatOfferId", "waitlistEntryId", "eventId", "state", "items", "totalMinor", "currency", "expiresAt", "createdAt", "holdId", "terminalAt"]);
export const OFFER_ITEM_KEYS = Object.freeze(["seatId", "priceVersionId", "unitAmountMinor", "feeMinor"]);
export const V1_RESOURCE_KEYS = Object.freeze(["tenants", "venues", "events", "zones", "seats", "priceVersions", "holds", "holdSeats", "orders", "orderSeats", "paymentIntents", "providerReceipts"]);
export const FINAL_RESOURCE_KEYS = Object.freeze([...V1_RESOURCE_KEYS, "waitlistEntries", "seatOffers"]);
export const WORK_KINDS = Object.freeze(["HOLD_EXPIRY", "PAYMENT_CAPTURE", "PAYMENT_RECONCILE", "WAITLIST_MATCH", "OFFER_EXPIRY"]);

const CASE_HARD_CAPS = Object.freeze({
  "A-01": ["SEAT_OWNERSHIP_ATOMICITY"], "A-02": ["PAYMENT_IDENTITY_CONSERVATION"], "A-03": ["SEAT_OWNERSHIP_ATOMICITY"], "A-04": ["SEAT_OWNERSHIP_ATOMICITY"], "A-05": ["SEAT_OWNERSHIP_ATOMICITY"],
  "B-01": ["DURABLE_IDEMPOTENCY", "SEAT_OWNERSHIP_ATOMICITY", "PAYMENT_IDENTITY_CONSERVATION"], "B-02": ["SEAT_OWNERSHIP_ATOMICITY"], "B-03": ["PAYMENT_IDENTITY_CONSERVATION", "SEAT_OWNERSHIP_ATOMICITY"], "B-04": ["SEAT_OWNERSHIP_ATOMICITY"], "B-05": ["SEAT_OWNERSHIP_ATOMICITY"],
  "C-01": ["STALE_WORK_OR_LOST_WORK", "SEAT_OWNERSHIP_ATOMICITY"], "C-02": ["STALE_WORK_OR_LOST_WORK", "PAYMENT_IDENTITY_CONSERVATION"], "C-03": ["STALE_WORK_OR_LOST_WORK", "SEAT_OWNERSHIP_ATOMICITY"], "C-04": ["STALE_WORK_OR_LOST_WORK"],
  "D-02": ["SEAT_OWNERSHIP_ATOMICITY", "PAYMENT_IDENTITY_CONSERVATION"], "D-03": ["SEAT_OWNERSHIP_ATOMICITY"], "D-04": ["SEAT_OWNERSHIP_ATOMICITY", "PAYMENT_IDENTITY_CONSERVATION"],
  "E-01": ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"], "E-02": ["SEAT_OWNERSHIP_ATOMICITY"], "E-03": ["SEAT_OWNERSHIP_ATOMICITY"], "E-04": ["STALE_WORK_OR_LOST_WORK", "SEAT_OWNERSHIP_ATOMICITY", "PAYMENT_IDENTITY_CONSERVATION"],
});

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !/^SR-F-/u.test(fixtureFamily ?? "") || typeof action !== "string" || action.length < 24 || typeof oracle !== "string" || oracle.length < 24 || typeof run !== "function" || run.length < 1) throw new TypeError("invalid SeatReserve case definition");
  const hardCaps = CASE_HARD_CAPS[id] ?? [];
  return Object.freeze({ taskId: "seatreserve", id, fixtureFamily, action, oracle, async run(ctx) { try { return await run(ctx); } catch (error) { if (error && typeof error === "object") error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCaps])]; throw error; } } });
}
export function exactKeys(value, keys, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`); return value; }
export function expectStatus(ctx, response, status, label, options = {}) { ctx.equal(response.status, status, `${label} status`, options); return response.json; }
export function expectSuccess(ctx, response, label, status = 200, options = {}) { const value = expectStatus(ctx, response, status, label, options); ctx.ok(value && typeof value === "object", `${label} JSON`, options); return value; }
export function expectError(ctx, response, status, code, label, options = {}) { expectStatus(ctx, response, status, label, options); exactKeys(response.json, ["error"], `${label} envelope`); exactKeys(response.json.error, ["code", "message", "details"], `${label} error`); ctx.equal(response.json.error.code, code, `${label} code`, options); return response.json.error; }
export function assertHold(value) { exactKeys(value, HOLD_KEYS, "SeatHold"); assert.match(value.holdId, /^[0-9a-f-]{36}$/u); assert.ok(["HELD", "CHECKOUT", "CONVERTED", "EXPIRED", "CANCELLED"].includes(value.state)); assert.ok(Number.isSafeInteger(value.totalMinor) && value.totalMinor >= 0); assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0); return value; }
export function assertOrder(value) { exactKeys(value, ORDER_KEYS, "Order"); assert.ok(["PENDING_PAYMENT", "PAYMENT_UNKNOWN", "CONFIRMED", "CANCELLED"].includes(value.state)); assert.ok(Number.isSafeInteger(value.totalMinor) && value.totalMinor >= 0); return value; }
export function assertPayment(value) { exactKeys(value, PAYMENT_KEYS, "PaymentIntent"); assert.ok(["CREATED", "PROCESSING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(value.state)); assert.ok(Number.isSafeInteger(value.amountMinor) && value.amountMinor >= 0); return value; }
export function assertWaitlist(value) { exactKeys(value, WAITLIST_KEYS, "WaitlistEntry"); assert.ok(["WAITING", "OFFERED", "FULFILLED", "DECLINED", "CANCELLED", "EXPIRED"].includes(value.state)); assert.ok(Number.isSafeInteger(value.seatCount) && value.seatCount >= 1 && value.seatCount <= 8); return value; }
export function assertOffer(value) { exactKeys(value, OFFER_KEYS, "SeatOffer"); assert.ok(["ACTIVE", "ACCEPTED", "DECLINED", "EXPIRED"].includes(value.state)); assert.ok(Array.isArray(value.items)); value.items.forEach((item) => exactKeys(item, OFFER_ITEM_KEYS, "SeatOffer item")); assert.ok(Number.isSafeInteger(value.totalMinor) && value.totalMinor >= 0); return value; }

async function build(ctx, workspace) { const target = ctx.forWorkspace(workspace); if (!builds.has(target.workspace)) builds.set(target.workspace, target.npm("build")); await builds.get(target.workspace); }
export async function prepare(ctx, options = {}) { const workspace = options.workspace ?? ctx.workspace; const target = ctx.forWorkspace(workspace); if (options.build !== false) await build(ctx, workspace); if (options.migrate !== false) await target.migrate(); if (options.seed) await target.seed(options.seed); ctx.mark("candidate-prepared", { workspace: target.workspace, seeded: Boolean(options.seed) }); return target; }
export async function startPreparedApi(ctx, options = {}) { const target = await prepare(ctx, options); const api = await target.startApi({ env: options.env }); return { target, api }; }

export async function createHold(ctx, baseUrl, body, options = {}) { const response = await ctx.mutate(baseUrl, "/api/v1/holds", options.key ?? ctx.key(`hold:${body.customerRef}`), body, options); if (options.allowFailure) return response; return assertHold(expectSuccess(ctx, response, options.label ?? "create Hold")); }
export async function getHold(ctx, baseUrl, holdId) { return assertHold(expectSuccess(ctx, await ctx.request(baseUrl, `/api/v1/holds/${holdId}`), "get Hold")); }
export async function cancelHold(ctx, baseUrl, holdId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/holds/${holdId}/cancel`, options.key ?? ctx.key(`cancel:${holdId}`), {}); if (options.allowFailure) return response; return assertHold(expectSuccess(ctx, response, options.label ?? "cancel Hold")); }
export async function checkoutHold(ctx, baseUrl, holdId, providerScenario, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/holds/${holdId}/checkout`, options.key ?? ctx.key(`checkout:${holdId}`), { providerScenario }, options);
  if (options.allowFailure) return response;
  const order = assertOrder(expectSuccess(ctx, response, options.label ?? "checkout Hold"));
  const snapshot = await ctx.snapshot(baseUrl);
  const paymentIntent = snapshot.resources.paymentIntents.find((item) => item.paymentIntentId === order.paymentIntentId);
  assertPayment(paymentIntent);
  ctx.equal(paymentIntent.orderId, order.orderId, "checkout PaymentIntent belongs to returned Order");
  return { order, paymentIntent };
}
export async function getOrder(ctx, baseUrl, orderId) { return assertOrder(expectSuccess(ctx, await ctx.request(baseUrl, `/api/v1/orders/${orderId}`), "get Order")); }
export async function reconcilePayment(ctx, baseUrl, paymentIntentId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/payment-intents/${paymentIntentId}/reconcile`, options.key ?? ctx.key(`reconcile:${paymentIntentId}`), {}); if (options.allowFailure) return response; return assertPayment(expectSuccess(ctx, response, options.label ?? "reconcile PaymentIntent")); }
export async function providerReceipt(ctx, baseUrl, body, options = {}) { const response = await ctx.mutate(baseUrl, "/api/v1/provider/receipts", options.key ?? ctx.key(`receipt:${body.providerEventId}`), body, options); if (options.allowFailure) return response; return expectSuccess(ctx, response, options.label ?? "record ProviderReceipt"); }
export async function createWaitlist(ctx, baseUrl, body, options = {}) { const response = await ctx.mutate(baseUrl, "/api/v1/waitlist-entries", options.key ?? ctx.key(`waitlist:${body.customerRef}`), body, options); if (options.allowFailure) return response; return assertWaitlist(expectSuccess(ctx, response, options.label ?? "create WaitlistEntry", 201)); }
export async function cancelWaitlist(ctx, baseUrl, entryId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/waitlist-entries/${entryId}/cancel`, options.key ?? ctx.key(`waitlist-cancel:${entryId}`), {}); if (options.allowFailure) return response; return assertWaitlist(expectSuccess(ctx, response, options.label ?? "cancel WaitlistEntry")); }
export async function getOffer(ctx, baseUrl, offerId) { return assertOffer(expectSuccess(ctx, await ctx.request(baseUrl, `/api/v1/seat-offers/${offerId}`), "get SeatOffer")); }
export async function acceptOffer(ctx, baseUrl, offerId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/seat-offers/${offerId}/accept`, options.key ?? ctx.key(`offer-accept:${offerId}`), {}); if (options.allowFailure) return response; const value = expectSuccess(ctx, response, options.label ?? "accept SeatOffer", 201); exactKeys(value, ["offer", "hold"], "accept response"); assertOffer(value.offer); assertHold(value.hold); return value; }
export async function declineOffer(ctx, baseUrl, offerId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/seat-offers/${offerId}/decline`, options.key ?? ctx.key(`offer-decline:${offerId}`), {}); if (options.allowFailure) return response; return assertOffer(expectSuccess(ctx, response, options.label ?? "decline SeatOffer")); }

export async function waitForSnapshot(ctx, baseUrl, predicate, options = {}) { return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); return predicate(snapshot) ? snapshot : false; }, { timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 100, label: options.label ?? "SeatReserve snapshot condition", processes: options.processes ?? [] }); }
export async function waitForOffer(ctx, baseUrl, entryId, processes = []) { const snapshot = await waitForSnapshot(ctx, baseUrl, (value) => value.resources.seatOffers.some(({ waitlistEntryId, state }) => waitlistEntryId === entryId && state === "ACTIVE"), { label: `ACTIVE Offer for ${entryId}`, processes }); return { snapshot, offer: snapshot.resources.seatOffers.find(({ waitlistEntryId, state }) => waitlistEntryId === entryId && state === "ACTIVE") }; }
export async function waitForPayment(ctx, baseUrl, paymentIntentId, states, processes = [], timeoutMs = 120_000) { const allowed = new Set(Array.isArray(states) ? states : [states]); const snapshot = await waitForSnapshot(ctx, baseUrl, (value) => allowed.has(value.resources.paymentIntents.find((item) => item.paymentIntentId === paymentIntentId)?.state), { timeoutMs, label: `PaymentIntent ${paymentIntentId} ${[...allowed].join("/")}`, processes }); return { snapshot, payment: snapshot.resources.paymentIntents.find((item) => item.paymentIntentId === paymentIntentId) }; }
export async function waitForWorkDrain(ctx, baseUrl, predicate, processes = [], timeoutMs = 120_000) { return waitForSnapshot(ctx, baseUrl, (snapshot) => snapshot.work.filter(predicate).length > 0 && snapshot.work.filter(predicate).every(({ terminal }) => terminal), { timeoutMs, label: "target Work drain", processes }); }

export async function startProviderDouble(ctx) {
  if (ctx.seatReserveProvider) return ctx.seatReserveProvider;
  const charges = new Map(); const sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); let body; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch {}
    const send = (status, json) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(json)); };
    if (request.method === "POST" && request.url === "/charges") {
      const valid = body && Object.keys(body).sort().join(",") === "amountMinor,currency,providerRequestId,scenario" && typeof body.providerRequestId === "string" && body.providerRequestId.length > 0 && Number.isSafeInteger(body.amountMinor) && body.amountMinor >= 0 && /^[A-Z]{3}$/u.test(body.currency) && ["SUCCEEDED", "FAILED", "TIMEOUT", "CONNECTION_RESET"].includes(body.scenario);
      if (!valid) { send(400, { error: { code: "INVALID_REQUEST", message: "invalid charge request", details: {} } }); return; }
      const canonical = canonicalJson(body); const existing = charges.get(body.providerRequestId);
      if (existing && existing.canonical !== canonical) { send(409, { error: { code: "PROVIDER_REQUEST_CONFLICT", message: "provider request changed", details: {} } }); return; }
      const choice = Number.parseInt(createHash("sha256").update(body.providerRequestId).digest("hex").at(-1), 16) % 2 ? "SUCCEEDED" : "FAILED";
      const record = existing ?? { canonical, scenario: body.scenario, outcome: body.scenario === "SUCCEEDED" ? "SUCCEEDED" : body.scenario === "FAILED" ? "FAILED" : choice, providerTransactionId: null, postCount: 0, getCount: 0 };
      record.postCount += 1; if (record.outcome === "SUCCEEDED") record.providerTransactionId = `txn-${createHash("sha256").update(body.providerRequestId).digest("hex").slice(0, 24)}`; charges.set(body.providerRequestId, record);
      if (record.scenario === "CONNECTION_RESET") { response.destroy(); return; }
      if (record.scenario === "TIMEOUT") { send(504, { error: { code: "PROVIDER_TIMEOUT", message: "provider outcome is unknown", details: {} } }); return; }
      send(200, { outcome: record.outcome, providerTransactionId: record.providerTransactionId }); return;
    }
    const matched = request.method === "GET" && request.url?.match(/^\/charges\/([^/?]+)$/u);
    if (matched) { const record = charges.get(decodeURIComponent(matched[1])); if (!record) { send(404, { error: { code: "NOT_FOUND", message: "unknown provider request", details: {} } }); return; } record.getCount += 1; send(200, { outcome: record.outcome, providerTransactionId: record.providerTransactionId }); return; }
    send(404, { error: { code: "NOT_FOUND", message: "unknown provider path", details: {} } });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address();
  const provider = { baseUrl: `http://127.0.0.1:${address.port}`, charges };
  ctx.defer(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise((resolve) => server.close(resolve)); });
  ctx.seatReserveProvider = provider; return provider;
}
export function startSeatWorker(ctx, provider, options = {}) { return ctx.startWorker({ ...options, env: { PROVIDER_BASE_URL: provider.baseUrl, ...(options.env ?? {}) } }); }
export function startSeatWorkerFor(target, provider, options = {}) { return target.startWorker({ ...options, env: { PROVIDER_BASE_URL: provider.baseUrl, ...(options.env ?? {}) } }); }

export function assertSnapshot(ctx, snapshot, { final = true } = {}) {
  exactKeys(snapshot, ["asOf", "resources", "work", "events"], "verification snapshot");
  ctx.equal(Object.keys(snapshot.resources).sort(), [...(final ? FINAL_RESOURCE_KEYS : V1_RESOURCE_KEYS)].sort(), `${final ? "FINAL" : "V1"} resource union`);
  for (const hold of snapshot.resources.holds) assertHold(hold); for (const order of snapshot.resources.orders) assertOrder(order); for (const intent of snapshot.resources.paymentIntents) assertPayment(intent);
  if (final) { for (const entry of snapshot.resources.waitlistEntries) assertWaitlist(entry); for (const offer of snapshot.resources.seatOffers) assertOffer(offer); }
  const sorts = { tenants: ["tenantId"], venues: ["venueId"], events: ["eventId"], zones: ["zoneId"], seats: ["seatId"], priceVersions: ["zoneId", "version"], holds: ["holdId"], holdSeats: ["holdId", "seatId"], orders: ["orderId"], orderSeats: ["orderId", "seatId"], paymentIntents: ["paymentIntentId"], providerReceipts: ["providerReceiptId"], waitlistEntries: ["createdAt", "waitlistEntryId"], seatOffers: ["seatOfferId"] };
  for (const [name, paths] of Object.entries(sorts)) if (snapshot.resources[name]) assertSorted(snapshot.resources[name], paths);
  for (const work of snapshot.work) { exactKeys(work, ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"], "Work"); ctx.ok(WORK_KINDS.includes(work.kind), `published Work kind ${work.kind}`); ctx.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state), `${work.workId} terminal flag`); }
  assertSeatConservation(snapshot); assertFrozenTotals(snapshot);
  if (snapshot.events.every((event) => Number.isSafeInteger(event.sequence) && typeof event.aggregateId === "string")) { assertSorted(snapshot.events, ["aggregateId", "sequence", "eventId"]); assertEventSequence(snapshot.events); }
  ctx.ok(!/(?:adminToken|paymentToken|leaseToken|idempotencyKey|providerRawBody|postgres(?:ql)?:\/\/|\/(?:Users|home|tmp)\/)/iu.test(canonicalJson(snapshot)), "snapshot omits secrets, raw provider bodies, and private paths");
  return snapshot;
}

export async function crashClaimedWork(ctx, provider, predicate) { const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && predicate(payload) }); const worker = await startSeatWorker(ctx, provider, { env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); const entry = await barrier.waitFor(({ json }) => json?.point === "worker.claimed" && predicate(json), { timeoutMs: 120_000, processes: [worker] }); await ctx.kill(worker); return { barrier, entry, worker }; }

export async function launchBrowser(ctx, baseUrl, viewport = { width: 1280, height: 800 }) { const chromium = await ctx.loadChromium(); const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] }); ctx.defer(() => browser.close()); const browserContext = await browser.newContext({ viewport }); const page = await browserContext.newPage(); await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 }); return { browser, browserContext, page }; }
async function firstVisible(locator) { for (let index = 0; index < await locator.count(); index += 1) { const item = locator.nth(index); if (await item.isVisible().catch(() => false)) return item; } }
export async function visibleControl(page, roles, names) { for (const role of roles) for (const name of names) { const item = await firstVisible(page.getByRole(role, { name })); if (item) return item; } throw new Error(`missing visible ${roles.join("/")} control for ${names.join("/")}`); }
export async function visibleField(page, names) { for (const name of names) { const item = await firstVisible(page.getByLabel(name)); if (item) return item; } throw new Error(`missing visible field for ${names.join("/")}`); }

export async function runFixedLoad({ count, concurrency, operation }) { const latencies = []; const statuses = new Map(); const started = performance.now(); await Promise.all(Array.from({ length: concurrency }, async (_, client) => { for (let index = client; index < count; index += concurrency) { const at = performance.now(); const response = await operation(index, client); latencies.push(performance.now() - at); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1); } })); const durationMs = performance.now() - started; return { count, durationMs, throughput: count / (durationMs / 1000), p95Ms: percentile(latencies, 0.95), statuses }; }
export function countStatuses(load, predicate) { return [...load.statuses].filter(([status]) => predicate(status)).reduce((sum, [, value]) => sum + value, 0); }

function integerUuid(kind, index) { return `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; }
export function formalSeed({ version, seatCount, historical = false }) {
  const tenantId = integerUuid(1, 1); const venueId = integerUuid(2, 1); const eventId = integerUuid(3, 1); const zoneId = integerUuid(4, 1); const priceVersionId = integerUuid(5, 1);
  const createdAt = historical ? "2019-01-01T00:00:00.000Z" : "2025-01-01T00:00:00.000Z";
  const seats = Array.from({ length: seatCount }, (_, index) => ({ seatId: integerUuid(10, index + 1), eventId, zoneId, row: `R${Math.floor(index / 1000) + 1}`, number: (index % 1000) + 1, accessible: index % 100 === 0, createdAt }));
  return { seed: { schemaVersion: 1, seedVersion: version, importedAt: createdAt, tenants: [{ tenantId, name: "Formal Tenant" }], venues: [{ venueId, tenantId, name: "Formal Venue" }], events: [{ eventId, tenantId, venueId, name: "Formal Event", startsAt: "2040-01-01T00:00:00.000Z", state: "ON_SALE", createdAt }], zones: [{ zoneId, eventId, name: "Formal Zone" }], seats, priceVersions: [{ priceVersionId, zoneId, version: 1, state: "ACTIVE", unitAmountMinor: 5000, feeMinor: 500, currency: "USD", effectiveFrom: createdAt, effectiveTo: null, createdAt }], holds: [], holdSeats: [], orders: [], orderSeats: [], paymentIntents: [], providerReceipts: [] }, tenantId, eventId, zoneId, priceVersionId, seatId: (index) => integerUuid(10, index + 1) };
}

export function finalEvidence(ctx, values = {}) { return ctx.pass({ evidence: [{ kind: "seatreserve-case-summary", ...values }] }); }
export function candidateFailure(message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) { throw new CaseFailure(message, { failureCodeSuffix, hardCapIds }); }
