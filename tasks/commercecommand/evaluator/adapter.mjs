import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standardAdapter } from "../framework/standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantA = id(1);
const buyerA = id(2);
const physicalProduct = id(3);
const physicalOffer = id(4);
const poolA = id(5);
const poolB = id(6);
const digitalProduct = id(7);
const digitalOffer = id(8);
const tenantB = id(9);
const buyerB = id(10);
const foreignProduct = id(11);
const foreignOffer = id(12);
const foreignPool = id(13);
const sellerA = id(20);
const sellerB = id(21);

const PERFORMANCE_SCENARIOS = [
  "quote-read-mix",
  "checkout-contention",
  "inventory-hotspot",
  "payment-unknown-reconcile",
  "fulfillment-drain",
  "notification-unknown-ack",
  "entitlement-revocation-storm",
  "seller-settlement-close",
  "refund-dispute-race",
  "full-catastrophe-recovery",
];

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = find(child, key);
    if (found !== undefined) return found;
  }
}

function finalSeed(seedVersion = "hidden-commercecommand", { manager = true } = {}) {
  const value = {
    schemaVersion: 1,
    seedVersion,
    tenants: [
      { tenantId: tenantA, name: "Hidden Commerce North" },
      { tenantId: tenantB, name: "Hidden Commerce South" },
    ],
    buyers: [
      { buyerId: buyerA, tenantId: tenantA, displayName: "North Buyer" },
      { buyerId: buyerB, tenantId: tenantB, displayName: "South Buyer" },
    ],
    products: [
      { productId: physicalProduct, tenantId: tenantA, sku: "NORTH-PHYSICAL", name: "Physical Kit", kind: "PHYSICAL" },
      { productId: digitalProduct, tenantId: tenantA, sku: "NORTH-DIGITAL", name: "Digital License", kind: "DIGITAL" },
      { productId: foreignProduct, tenantId: tenantB, sku: "SOUTH-PHYSICAL", name: "Foreign Kit", kind: "PHYSICAL" },
    ],
    offerVersions: [
      offer(physicalOffer, tenantA, physicalProduct, 1, 1_200, 120, "PHYSICAL"),
      offer(digitalOffer, tenantA, digitalProduct, 1, 700, 70, "DIGITAL"),
      offer(foreignOffer, tenantB, foreignProduct, 1, 900, 90, "PHYSICAL"),
    ],
    inventoryPools: [
      { inventoryPoolId: poolA, tenantId: tenantA, productId: physicalProduct, priority: 1, onHand: 20_000, reserved: 0 },
      { inventoryPoolId: poolB, tenantId: tenantA, productId: physicalProduct, priority: 2, onHand: 20_000, reserved: 0 },
      { inventoryPoolId: foreignPool, tenantId: tenantB, productId: foreignProduct, priority: 1, onHand: 20_000, reserved: 0 },
    ],
    orders: [],
    orderLines: [],
    inventoryHolds: [],
    paymentAttempts: [],
    fulfillmentPlans: [],
    entitlementGrants: [],
    ledgerEntries: [],
    notificationDeliveries: [],
  };
  if (manager) {
    Object.assign(value, {
      sellerAllocations: [],
      sellerSettlements: [],
      commerceDisputes: [],
      settlementAdjustments: [],
    });
  }
  return value;
}

function offer(offerVersionId, tenantId, productId, version, unitPriceMinor, taxMinor, fulfillmentKind) {
  return {
    offerVersionId,
    tenantId,
    productId,
    version,
    currency: "USD",
    unitPriceMinor,
    taxMinor,
    fulfillmentKind,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: "2030-01-01T00:00:00.000Z",
    state: "ACTIVE",
  };
}

function quotePayload(index, { tenantId = tenantA, buyerId = buyerA, productId = physicalProduct, quantity = 1, mixed = false } = {}) {
  return {
    tenantId,
    buyerId,
    channel: ["WEB", "STORE", "PARTNER"][index % 3],
    lines: mixed
      ? [{ productId: physicalProduct, quantity }, { productId: digitalProduct, quantity: 1 }]
      : [{ productId, quantity }],
    holdTtlSeconds: 900,
  };
}

function assertOk(response, allowed = [200, 201, 202]) {
  assert.ok(allowed.includes(response.status), `${response.status}: ${response.text}`);
  return response;
}

function resource(snapshot, key) {
  const value = snapshot.resources?.[key];
  assert.ok(Array.isArray(value), `snapshot is missing ${key}`);
  return value;
}

async function prepare(ctx, seedVersion = "hidden-commercecommand") {
  await ctx.prepare();
  const imported = await ctx.seed(finalSeed(seedVersion));
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return ctx.startApi();
}

async function createQuote(ctx, baseUrl, index, options = {}) {
  const payload = quotePayload(index, options);
  const response = await ctx.mutate(baseUrl, "/api/v1/orders/quotes", `quote-${index}`, payload);
  assertOk(response, options.allowed ?? [200, 201]);
  return {
    quoteResponse: response,
    payload,
    orderId: find(response.json, "orderId"),
    orderTotalMinor: find(response.json, "orderTotalMinor"),
  };
}

async function checkout(ctx, baseUrl, orderId, index) {
  const providerRequestId = `provider-${index}`;
  const response = await ctx.mutate(baseUrl, `/api/v1/orders/${orderId}/checkout`, `checkout-${index}`, {
    provider: "SANDBOX",
    providerRequestId,
  });
  assertOk(response);
  return { checkoutResponse: response, providerRequestId, paymentAttemptId: find(response.json, "paymentAttemptId") };
}

async function captureOrder(ctx, baseUrl, index, options = {}) {
  const quoted = await createQuote(ctx, baseUrl, index, options);
  const checked = await checkout(ctx, baseUrl, quoted.orderId, index);
  const callback = await ctx.mutate(baseUrl, "/api/v1/payment-provider/callbacks", `callback-${index}`, {
    providerEventId: `provider-event-${index}`,
    providerRequestId: checked.providerRequestId,
    outcome: "CAPTURED",
    capturedMinor: quoted.orderTotalMinor,
  });
  assertOk(callback);
  return { ...quoted, ...checked, callback };
}

function journalBalances(entries) {
  const totals = new Map();
  for (const entry of entries) {
    assert.ok(["DEBIT", "CREDIT"].includes(entry.direction), `invalid ledger direction ${entry.direction}`);
    assert.ok(Number.isSafeInteger(entry.amountMinor) && entry.amountMinor > 0, "ledger amount must be a positive safe integer");
    const key = `${entry.tenantId}:${entry.journalId}:${entry.currency}`;
    const value = totals.get(key) ?? { debit: 0, credit: 0 };
    value[entry.direction.toLowerCase()] += entry.amountMinor;
    totals.set(key, value);
  }
  return totals;
}

function assertCoreInvariants(snapshot) {
  const holds = resource(snapshot, "inventoryHolds");
  const lines = resource(snapshot, "orderLines");
  const orders = resource(snapshot, "orders");
  for (const pool of resource(snapshot, "inventoryPools")) {
    const held = holds.filter((item) => item.inventoryPoolId === pool.inventoryPoolId && item.state === "HELD")
      .reduce((sum, item) => sum + item.quantity, 0);
    assert.equal(pool.reserved, held, `pool ${pool.inventoryPoolId} reserved drift`);
    assert.ok(pool.reserved >= 0 && pool.reserved <= pool.onHand, `pool ${pool.inventoryPoolId} violates capacity`);
  }
  for (const line of lines) {
    assert.equal(line.lineTotalMinor, line.quantity * (line.unitPriceMinor + line.taxMinor), `line ${line.orderLineId} total drift`);
  }
  for (const order of orders) {
    const total = lines.filter((line) => line.orderId === order.orderId).reduce((sum, line) => sum + line.lineTotalMinor, 0);
    assert.equal(order.orderTotalMinor, total, `order ${order.orderId} total drift`);
    assert.ok(order.refundedMinor >= 0 && order.capturedMinor >= order.refundedMinor, `order ${order.orderId} refund bound`);
    assert.ok(order.capturedMinor <= order.orderTotalMinor, `order ${order.orderId} capture bound`);
    assert.ok(resource(snapshot, "paymentAttempts").filter((attempt) => attempt.orderId === order.orderId && itemCaptured(attempt)).length <= 1,
      `order ${order.orderId} has duplicate captures`);
  }
  for (const [key, value] of journalBalances(resource(snapshot, "ledgerEntries"))) {
    assert.equal(value.debit, value.credit, `journal ${key} is unbalanced`);
  }
  const byAggregate = new Map();
  for (const event of snapshot.events ?? []) {
    const key = `${event.tenantId}:${event.aggregateId}`;
    const sequences = byAggregate.get(key) ?? [];
    sequences.push(event.aggregateSequence ?? event.sequence);
    byAggregate.set(key, sequences);
  }
  for (const [key, sequences] of byAggregate) {
    assert.equal(new Set(sequences).size, sequences.length, `duplicate event sequence for ${key}`);
    const ordered = [...sequences].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      assert.equal(ordered[index], ordered[index - 1] + 1, `event sequence gap for ${key}`);
    }
  }
  const notifications = resource(snapshot, "notificationDeliveries");
  assert.equal(new Set(notifications.map(({ notificationDeliveryId }) => notificationDeliveryId)).size, notifications.length,
    "duplicate NotificationDelivery identity");
  for (const values of Map.groupBy(notifications, ({ orderId }) => orderId).values()) {
    const sequences = values.map(({ aggregateSequence }) => aggregateSequence);
    assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right), "notification sequence is not deterministic");
  }
  const work = snapshot.work ?? [];
  assert.equal(new Set(work.map(({ workId }) => workId)).size, work.length, "duplicate Work identity");
  const allocations = resource(snapshot, "sellerAllocations");
  for (const allocation of allocations) {
    const line = lines.find(({ orderLineId }) => orderLineId === allocation.orderLineId);
    assert.ok(line && line.tenantId === allocation.tenantId, "seller allocation crossed tenant or line boundary");
  }
  for (const [orderLineId, values] of Map.groupBy(allocations, ({ orderLineId }) => orderLineId)) {
    const line = lines.find((item) => item.orderLineId === orderLineId);
    assert.equal(values.reduce((sum, item) => sum + item.quantity, 0), line.quantity, `allocation quantity drift for ${orderLineId}`);
    assert.equal(values.reduce((sum, item) => sum + item.amountMinor, 0), line.lineTotalMinor, `allocation amount drift for ${orderLineId}`);
  }
  for (const order of orders) {
    const reserved = resource(snapshot, "commerceDisputes")
      .filter((dispute) => dispute.paymentAttemptId
        && resource(snapshot, "paymentAttempts").some((attempt) => attempt.paymentAttemptId === dispute.paymentAttemptId && attempt.orderId === order.orderId)
        && !["WON", "CANCELLED"].includes(dispute.state))
      .reduce((sum, dispute) => sum + dispute.amountMinor, 0);
    assert.ok(order.refundedMinor + reserved <= order.capturedMinor, `order ${order.orderId} refund and dispute reserve exceed capture`);
  }
}

function stableSnapshot(snapshot) {
  const { asOf: _asOf, databaseBytes: _databaseBytes, ...stable } = snapshot;
  return stable;
}

function assertMetric(metric, { throughput, p95, statuses = [200, 201, 202, 409] }) {
  assert.ok(metric.throughput >= throughput, `throughput ${metric.throughput} < ${throughput}`);
  assert.ok(metric.p95 <= p95, `p95 ${metric.p95} > ${p95}`);
  const unexpected = Object.keys(metric.statuses).filter((status) => !statuses.includes(Number(status)));
  assert.deepEqual(unexpected, [], `unexpected statuses: ${unexpected.join(",")}`);
  const successes = Object.entries(metric.statuses)
    .filter(([status]) => Number(status) >= 200 && Number(status) < 300)
    .reduce((sum, [, count]) => sum + count, 0);
  assert.ok(successes > 0, "performance scenario completed no successful business operation");
}

function metric(scenarioId, value, durationMs) {
  return { scenarioId, ...value, durationMs };
}

const spec = {
  label: "CommerceCommand frozen quote creation",
  performanceScenarioIds: PERFORMANCE_SCENARIOS,
  seed: async () => finalSeed(),
  path: "/api/v1/orders/quotes",
  payload: (index) => quotePayload(index),
  conflictPayload: () => quotePayload(0, { quantity: 2 }),
  resource: "orders",
  identity: (json) => find(json, "orderId"),
  resourceIdentity: ({ orderId }) => orderId,
  workIdentity: (json) => find(json, "orderId"),
  async verify(ctx, baseUrl, response) {
    const orderId = find(response.json, "orderId");
    const snapshot = await ctx.snapshot(baseUrl);
    assert.equal(resource(snapshot, "orders").filter((item) => item.orderId === orderId).length, 1);
    assert.ok(resource(snapshot, "orderLines").some((item) => item.orderId === orderId && item.offerVersionId === physicalOffer));
    assertCoreInvariants(snapshot);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, "/api/v1/orders/quotes", "h04-cross-tenant", quotePayload(90, {
      tenantId: tenantA,
      buyerId: buyerA,
      productId: foreignProduct,
    }));
    assert.equal(rejected.status, 404, rejected.text);
    assert.equal(rejected.json?.error?.code, "RESOURCE_NOT_FOUND");
    const after = await ctx.snapshot(baseUrl);
    assert.equal(resource(after, "orders").length, resource(before, "orders").length);
    assert.equal(resource(after, "inventoryHolds").length, resource(before, "inventoryHolds").length);
  },
  async contention(ctx, baseUrls) {
    const before = await ctx.snapshot(baseUrls[0]);
    const available = resource(before, "inventoryPools").filter(({ productId }) => productId === physicalProduct)
      .reduce((sum, item) => sum + item.onHand - item.reserved, 0);
    const attempts = await ctx.concurrent(Array.from({ length: 80 }), 80, (_, index) => ctx.mutate(
      baseUrls[index % 2],
      "/api/v1/orders/quotes",
      `h06-stock-${index}`,
      quotePayload(100 + index, { quantity: Math.ceil(available / 40) }),
    ));
    assert.ok(attempts.some(({ status }) => status === 409), "hot inventory never rejected an oversubscribed quote");
    assertCoreInvariants(await ctx.snapshot(baseUrls[0]));
  },
  manager: {
    path: "/api/v1/orders/unprepared/seller-allocations",
    payload: () => ({ allocations: [] }),
    async prepare(ctx, baseUrl) {
      const captured = await captureOrder(ctx, baseUrl, 700, { quantity: 2 });
      const snapshot = await ctx.snapshot(baseUrl);
      const line = resource(snapshot, "orderLines").find(({ orderId }) => orderId === captured.orderId);
      return {
        path: `/api/v1/orders/${captured.orderId}/seller-allocations`,
        payload: () => ({ allocations: [
          { orderLineId: line.orderLineId, sellerId: sellerA, quantity: 1, amountMinor: line.lineTotalMinor / 2 },
          { orderLineId: line.orderLineId, sellerId: sellerB, quantity: 1, amountMinor: line.lineTotalMinor / 2 },
        ] }),
        captured,
      };
    },
    async verify(ctx, baseUrl, response) {
      const snapshot = await ctx.snapshot(baseUrl);
      const allocationIds = find(response.json, "sellerAllocationIds") ?? [];
      assert.ok(resource(snapshot, "sellerAllocations").length >= 2);
      if (allocationIds.length > 0) assert.equal(new Set(allocationIds).size, allocationIds.length);
      assertCoreInvariants(snapshot);
    },
    async concurrentVerify(ctx, baseUrls) {
      const snapshot = await ctx.snapshot(baseUrls[0]);
      assertCoreInvariants(snapshot);
      const groups = Map.groupBy(resource(snapshot, "sellerAllocations"), ({ orderLineId }) => orderLineId);
      for (const [orderLineId, allocations] of groups) {
        const line = resource(snapshot, "orderLines").find((item) => item.orderLineId === orderLineId);
        assert.equal(allocations.reduce((sum, item) => sum + item.quantity, 0), line.quantity);
        assert.equal(allocations.reduce((sum, item) => sum + item.amountMinor, 0), line.lineTotalMinor);
      }
    },
  },
  cases: {
    "H-07": workerLeaseRecovery,
    "H-09": compatibleMigration,
    "H-14": inventoryConservation,
    "H-15": tenantIsolation,
    "H-16": paymentConvergence,
    "H-17": fulfillmentCompetition,
    "H-18": entitlementRevocationRace,
    "H-19": notificationOrdering,
    "H-20": browserJourney,
    "H-21": refundCompensation,
    "H-22": ledgerAndEventDeterminism,
    "H-23": multiProcessRecovery,
    "H-24": sellerAllocationConservation,
    "H-25": settlementClose,
    "H-26": refundDisputeRace,
    "H-27": settlementAdjustment,
    "H-28": blueGreenReplay,
    "H-29": sustainedInvariantSoak,
    "H-30": fullCatastropheDrill,
  },
  performance: commercePerformance,
};

async function workerLeaseRecovery(ctx, out) {
  const api = await prepare(ctx, "h07-commercecommand");
  const captured = await captureOrder(ctx, api.baseUrl, 707);
  const snapshot = await ctx.snapshot(api.baseUrl);
  const plan = resource(snapshot, "fulfillmentPlans").find(({ orderId }) => orderId === captured.orderId);
  assert.ok(plan, "captured physical order created no FulfillmentPlan");

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h07-commerce" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.claimed"
    && [captured.orderId, plan.fulfillmentPlanId].includes(entry.json?.aggregateId)), {
    label: "Commerce fulfillment lease claim",
    children: [first],
  });
  await ctx.stop(first, "SIGKILL");
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacement = await ctx.startWorker();
  const final = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const current = resource(value, "fulfillmentPlans").find(({ fulfillmentPlanId }) => fulfillmentPlanId === plan.fulfillmentPlanId);
    return current?.state === "COMPLETED" ? value : undefined;
  }, { timeoutMs: 90_000, label: "replacement fulfillment completion", children: [replacement] });
  assert.equal(resource(final, "fulfillmentPlans").filter(({ fulfillmentPlanId }) => fulfillmentPlanId === plan.fulfillmentPlanId).length, 1);
  assertCoreInvariants(final);
  out.push("a killed fulfillment lease is fenced and reclaimed by one replacement Worker");
}

async function compatibleMigration(ctx, out) {
  const v1 = await ctx.copyV1Workspace();
  await ctx.prepare(v1);
  const imported = await ctx.seed(finalSeed("h09-commerce-v1", { manager: false }), v1);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const v1Api = await ctx.startApi(v1);
  const payload = quotePayload(909, { mixed: true });
  const created = await ctx.mutate(v1Api.baseUrl, "/api/v1/orders/quotes", "h09-saved-quote", payload);
  assertOk(created, [200, 201]);
  const orderId = find(created.json, "orderId");
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/orders/quotes", "h09-saved-quote", payload);
  assert.equal(replay.status, created.status);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(created.json));
  const snapshot = await ctx.snapshot(finalApi.baseUrl);
  assert.equal(resource(snapshot, "orders").filter((item) => item.orderId === orderId).length, 1);
  for (const key of ["sellerAllocations", "sellerSettlements", "commerceDisputes", "settlementAdjustments"]) resource(snapshot, key);
  assertCoreInvariants(snapshot);
  out.push("V1 data and saved quote replay survive the marketplace-compatible migration unchanged");
}

async function inventoryConservation(ctx, out) {
  const apiA = await prepare(ctx, "h14-commercecommand");
  const apiB = await ctx.startApi();
  const attempts = await ctx.concurrent(Array.from({ length: 160 }), 80, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/orders/quotes",
    `h14-${index}`,
    quotePayload(1_400 + index, { quantity: 1_000 }),
  ));
  assert.ok(attempts.some(({ status }) => status < 300));
  assert.ok(attempts.some(({ status }) => status === 409));
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  assertCoreInvariants(snapshot);
  for (const order of resource(snapshot, "orders").filter(({ state }) => state === "QUOTED")) {
    const line = resource(snapshot, "orderLines").find(({ orderId }) => orderId === order.orderId);
    const allocations = resource(snapshot, "inventoryHolds").filter(({ orderLineId }) => orderLineId === line.orderLineId);
    assert.equal(allocations.reduce((sum, item) => sum + item.quantity, 0), line.quantity);
    assert.deepEqual([...allocations].sort((a, b) => a.inventoryPoolId.localeCompare(b.inventoryPoolId)), allocations,
      "pool allocation is not deterministic");
  }
  out.push("two APIs cannot oversubscribe split InventoryPools and every accepted line is fully allocated");
}

async function tenantIsolation(ctx, out) {
  const api = await prepare(ctx, "h15-commercecommand");
  const foreign = await createQuote(ctx, api.baseUrl, 1_499, {
    tenantId: tenantB,
    buyerId: buyerB,
    productId: foreignProduct,
  });
  const before = await ctx.snapshot(api.baseUrl);
  const crossProduct = await ctx.mutate(api.baseUrl, "/api/v1/orders/quotes", "h15-cross-product", quotePayload(1_500, {
    tenantId: tenantA,
    buyerId: buyerA,
    productId: foreignProduct,
  }));
  assert.equal(crossProduct.status, 404, crossProduct.text);
  assert.equal(crossProduct.json?.error?.code, "RESOURCE_NOT_FOUND");
  const crossBuyer = await ctx.mutate(api.baseUrl, "/api/v1/orders/quotes", "h15-cross-buyer", quotePayload(1_501, {
    tenantId: tenantA,
    buyerId: buyerB,
    productId: physicalProduct,
  }));
  assert.equal(crossBuyer.status, 404, crossBuyer.text);
  assert.equal(crossBuyer.json?.error?.code, "RESOURCE_NOT_FOUND");
  const foreignRead = await ctx.request(api.baseUrl, `/api/v1/orders/${foreign.orderId}?tenantId=${tenantA}`);
  assert.equal(foreignRead.status, 404);
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(after, "orders").length, resource(before, "orders").length);
  assert.equal(resource(after, "inventoryHolds").length, resource(before, "inventoryHolds").length);
  assert.equal((after.events ?? []).length, (before.events ?? []).length);
  out.push("cross-tenant buyer, product, and opaque resource probes disclose no data and create no partial state");
}

async function paymentConvergence(ctx, out) {
  const apiA = await prepare(ctx, "h16-commercecommand");
  const apiB = await ctx.startApi();
  const quoted = await createQuote(ctx, apiA.baseUrl, 1_600, { mixed: true });
  const checked = await checkout(ctx, apiA.baseUrl, quoted.orderId, 1_600);
  const callbacks = [
    { providerEventId: "h16-decline", outcome: "DECLINED", capturedMinor: 0 },
    { providerEventId: "h16-unknown", outcome: "UNKNOWN", capturedMinor: 0 },
    { providerEventId: "h16-capture", outcome: "CAPTURED", capturedMinor: quoted.orderTotalMinor },
  ];
  const results = await ctx.concurrent(callbacks, 3, (payload, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/payment-provider/callbacks",
    `h16-callback-${index}`,
    { ...payload, providerRequestId: checked.providerRequestId },
  ));
  assert.ok(results.every(({ status }) => [200, 201, 202, 409].includes(status)));
  const replay = await ctx.mutate(apiB.baseUrl, "/api/v1/payment-provider/callbacks", "h16-callback-2", {
    ...callbacks[2], providerRequestId: checked.providerRequestId,
  });
  assert.equal(ctx.canonical(replay.json), ctx.canonical(results[2].json));
  const conflict = await ctx.mutate(apiB.baseUrl, "/api/v1/payment-provider/callbacks", "h16-provider-conflict", {
    providerEventId: "h16-capture",
    providerRequestId: checked.providerRequestId,
    outcome: "DECLINED",
    capturedMinor: 0,
  });
  assert.equal(conflict.status, 409);
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  const order = resource(snapshot, "orders").find(({ orderId }) => orderId === quoted.orderId);
  assert.ok(["PAID", "FULFILLING", "FULFILLED"].includes(order.state));
  assert.equal(resource(snapshot, "paymentAttempts").filter((item) => item.orderId === quoted.orderId && itemCaptured(item)).length, 1);
  assertCoreInvariants(snapshot);
  out.push("duplicate and out-of-order provider outcomes converge to one capture without duplicate financial effects");
}

function itemCaptured(item) {
  return item.state === "CAPTURED" || item.outcome === "CAPTURED";
}

async function fulfillmentCompetition(ctx, out) {
  const api = await prepare(ctx, "h17-commercecommand");
  const captured = await ctx.concurrent(Array.from({ length: 24 }), 8, (_, index) => captureOrder(ctx, api.baseUrl, 1_700 + index));
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  await ctx.stop(workers[0], "SIGKILL");
  const replacement = await ctx.startWorker();
  const orderIds = new Set(captured.map(({ orderId }) => orderId));
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const plans = resource(value, "fulfillmentPlans").filter(({ orderId }) => orderIds.has(orderId));
    return plans.length === orderIds.size && plans.every(({ state }) => state === "COMPLETED") ? value : undefined;
  }, { timeoutMs: 180_000, label: "multi-worker fulfillment drain", children: [...workers.slice(1), replacement] });
  const plans = resource(snapshot, "fulfillmentPlans").filter(({ orderId }) => orderIds.has(orderId));
  assert.equal(new Set(plans.map(({ fulfillmentPlanId }) => fulfillmentPlanId)).size, plans.length);
  assertCoreInvariants(snapshot);
  out.push("four competing Workers plus SIGKILL complete each physical plan once under fencing");
}

async function entitlementRevocationRace(ctx, out) {
  const apiA = await prepare(ctx, "h18-commercecommand");
  const apiB = await ctx.startApi();
  const captured = await captureOrder(ctx, apiA.baseUrl, 1_800, { productId: digitalProduct });
  const worker = await ctx.startWorker();
  const active = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const grant = resource(value, "entitlementGrants").find(({ orderId }) => orderId === captured.orderId);
    return grant?.state === "ACTIVE" ? { value, grant } : undefined;
  }, { timeoutMs: 60_000, label: "digital entitlement grant", children: [worker] });
  const amountMinor = captured.orderTotalMinor;
  const [refund, revoke] = await Promise.all([
    ctx.mutate(apiA.baseUrl, `/api/v1/orders/${captured.orderId}/refunds`, "h18-refund", { amountMinor, reason: "full digital refund", restockLines: [] }),
    ctx.mutate(apiB.baseUrl, `/api/v1/entitlement-grants/${active.grant.entitlementGrantId}/revoke`, "h18-revoke", {}),
  ]);
  assert.ok([refund, revoke].every(({ status }) => [200, 201, 202, 409].includes(status)));
  const final = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const grant = resource(value, "entitlementGrants").find(({ entitlementGrantId }) => entitlementGrantId === active.grant.entitlementGrantId);
    return grant?.state === "REVOKED" ? value : undefined;
  }, { timeoutMs: 60_000, label: "refunded entitlement revocation", children: [worker] });
  assert.equal(resource(final, "entitlementGrants").filter(({ entitlementGrantId }) => entitlementGrantId === active.grant.entitlementGrantId).length, 1);
  assertCoreInvariants(final);
  out.push("full refund racing explicit revoke leaves one terminal revoked entitlement and balanced money");
}

async function notificationOrdering(ctx, out) {
  const api = await prepare(ctx, "h19-commercecommand");
  const captured = await captureOrder(ctx, api.baseUrl, 1_900, { mixed: true });
  await ctx.mutate(api.baseUrl, `/api/v1/orders/${captured.orderId}/refunds`, "h19-refund", {
    amountMinor: captured.orderTotalMinor,
    reason: "notification ordering",
    restockLines: [],
  });
  const receiver = await ctx.receiver();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? held : { status: 204 });
  const first = await ctx.startDispatcher(receiver.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h19-commerce" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
    label: "notification response barrier",
    children: [first],
  });
  await ctx.stop(first, "SIGKILL");
  release({ status: 204 });
  const second = await ctx.startDispatcher(receiver.url);
  await ctx.waitFor(() => receiver.ledger.length >= 2, { timeoutMs: 90_000, label: "unknown ACK retry", children: [second] });
  const duplicateGroups = Map.groupBy(receiver.ledger, (entry) => {
    const header = Object.keys(entry.headers).find((name) => name.endsWith("-event-id"));
    return header ? entry.headers[header] : "missing";
  });
  assert.ok([...duplicateGroups.values()].some((entries) => entries.length >= 2 && new Set(entries.map(({ raw }) => raw)).size === 1));
  const snapshot = await ctx.snapshot(api.baseUrl);
  const orderNotifications = resource(snapshot, "notificationDeliveries").filter(({ orderId }) => orderId === captured.orderId);
  assert.deepEqual(orderNotifications.map(({ aggregateSequence }) => aggregateSequence),
    [...orderNotifications].map(({ aggregateSequence }) => aggregateSequence).sort((a, b) => a - b));
  assertCoreInvariants(snapshot);
  out.push("unknown notification ACK retries byte-identically while per-Order aggregate order remains monotonic");
}

async function browserJourney(ctx, out) {
  const api = await prepare(ctx, "h20-commercecommand");
  const browser = await openBrowser(`${api.baseUrl}/`);
  try {
    await browser.waitFor("document.querySelector('[data-testid=\"tenant-select\"]')");
    await browser.setValue("tenant-select", tenantA);
    await browser.setValue("buyer-select", buyerA);
    await browser.click(`product-${physicalProduct}-add`);
    await browser.click(`product-${digitalProduct}-add`);
    await browser.click("create-quote");
    await browser.waitFor("document.querySelector('[data-testid=\"order-id\"]')?.textContent?.trim().length > 0");
    const orderId = await browser.text("order-id");
    assert.match(orderId, /^[0-9a-f-]{36}$/iu);
    await browser.click("checkout");
    await browser.waitFor("/PAYMENT_PENDING|UNKNOWN/.test(document.querySelector('[data-testid=\"payment-state\"]')?.textContent || '')");

    const pending = await ctx.snapshot(api.baseUrl);
    const order = resource(pending, "orders").find((item) => item.orderId === orderId);
    const attempt = resource(pending, "paymentAttempts").find((item) => item.orderId === orderId);
    assert.ok(order && attempt, "browser checkout created no durable Order and PaymentAttempt");
    assertOk(await ctx.mutate(api.baseUrl, "/api/v1/payment-provider/callbacks", "h20-provider-capture", {
      providerEventId: "h20-provider-event",
      providerRequestId: attempt.providerRequestId,
      outcome: "CAPTURED",
      capturedMinor: order.orderTotalMinor,
    }));
    await browser.reload();
    await browser.waitFor("/PAID|FULFILLING|FULFILLED/.test(document.querySelector('[data-testid=\"order-state\"]')?.textContent || '')");
    await browser.setValue("refund-amount", String(order.orderTotalMinor));
    await browser.click("refund-submit");
    await browser.waitFor("/REFUNDED/.test(document.querySelector('[data-testid=\"order-state\"]')?.textContent || '')");
    await browser.reload();
    assert.match(await browser.text("order-state"), /REFUNDED/u);
    assert.equal(await browser.text("order-id"), orderId);
    assertCoreInvariants(await ctx.snapshot(api.baseUrl));
  } finally {
    await browser.close();
  }
  out.push("production Chromium creates a mixed quote, checks out, observes capture, refunds through visible controls, and survives reload");
}

async function openBrowser(url) {
  assert.equal(typeof WebSocket, "function", "Node WebSocket support is required for Chromium CDP");
  const profile = await mkdtemp(join(tmpdir(), "commercecommand-chromium-"));
  const child = spawn("chromium", [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Chromium DevTools timeout: ${stderr}`)), 30_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/u);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium exited before DevTools was ready (${code}): ${stderr}`));
    });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data));
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const target = await send("Target.createTarget", { url: "about:blank" });
  const attached = await send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Page.navigate", { url }, sessionId);

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "browser evaluation failed");
    return result.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for browser condition: ${expression}`);
  };
  await waitFor("document.readyState === 'complete'");
  return {
    waitFor,
    async setValue(testId, value) {
      const encodedId = JSON.stringify(testId);
      const encodedValue = JSON.stringify(value);
      const changed = await evaluate(`(() => { const element = document.querySelector('[data-testid="' + ${encodedId} + '"]'); if (!element) return false; element.value = ${encodedValue}; element.dispatchEvent(new Event('input', {bubbles:true})); element.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`);
      assert.equal(changed, true, `missing visible control ${testId}`);
    },
    async click(testId) {
      const clicked = await evaluate(`(() => { const element = document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]'); if (!element || element.disabled) return false; element.click(); return true; })()`);
      assert.equal(clicked, true, `missing or disabled visible control ${testId}`);
    },
    text: (testId) => evaluate(`document.querySelector('[data-testid="' + ${JSON.stringify(testId)} + '"]')?.textContent?.trim() ?? ''`),
    async reload() {
      await send("Page.reload", { ignoreCache: true }, sessionId);
      await waitFor("document.readyState === 'complete'");
    },
    async close() {
      for (const entry of pending.values()) entry.reject(new Error("browser closed"));
      pending.clear();
      socket.close();
      child.kill("SIGTERM");
      await rm(profile, { recursive: true, force: true });
    },
  };
}

async function refundCompensation(ctx, out) {
  const apiA = await prepare(ctx, "h21-commercecommand");
  const apiB = await ctx.startApi();
  const captured = await captureOrder(ctx, apiA.baseUrl, 2_100, { quantity: 4 });
  const before = await ctx.snapshot(apiA.baseUrl);
  const line = resource(before, "orderLines").find(({ orderId }) => orderId === captured.orderId);
  const amountMinor = Math.floor(captured.orderTotalMinor / 2);
  const refunds = await Promise.all(Array.from({ length: 12 }, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/orders/${captured.orderId}/refunds`,
    `h21-refund-${index}`,
    { amountMinor, reason: "concurrent return", restockLines: [{ orderLineId: line.orderLineId, quantity: 4 }] },
  )));
  assert.equal(refunds.filter(({ status }) => status < 300).length, 1);
  assert.equal(refunds.filter(({ status }) => status === 409).length, 11);
  const after = await ctx.snapshot(apiA.baseUrl);
  const order = resource(after, "orders").find(({ orderId }) => orderId === captured.orderId);
  assert.ok(order.refundedMinor <= order.capturedMinor);
  const beforeStock = resource(before, "inventoryPools").filter(({ productId }) => productId === physicalProduct).reduce((sum, item) => sum + item.onHand, 0);
  const afterStock = resource(after, "inventoryPools").filter(({ productId }) => productId === physicalProduct).reduce((sum, item) => sum + item.onHand, 0);
  assert.equal(afterStock - beforeStock, 4);
  assertCoreInvariants(after);
  out.push("concurrent refund and restock attempts cannot over-refund or return the same physical units twice");
}

async function ledgerAndEventDeterminism(ctx, out) {
  const api = await prepare(ctx, "h22-commercecommand");
  const captured = await captureOrder(ctx, api.baseUrl, 2_200, { mixed: true });
  const amountMinor = Math.floor(captured.orderTotalMinor / 2);
  const refund = await ctx.mutate(api.baseUrl, `/api/v1/orders/${captured.orderId}/refunds`, "h22-refund", {
    amountMinor,
    reason: "ledger determinism",
    restockLines: [],
  });
  assertOk(refund);
  const first = await ctx.snapshot(api.baseUrl);
  const replay = await ctx.mutate(api.baseUrl, `/api/v1/orders/${captured.orderId}/refunds`, "h22-refund", {
    amountMinor,
    reason: "ledger determinism",
    restockLines: [],
  });
  assert.equal(ctx.canonical(replay.json), ctx.canonical(refund.json));
  const second = await ctx.snapshot(api.baseUrl);
  assert.equal(ctx.canonical(stableSnapshot(first)), ctx.canonical(stableSnapshot(second)));
  assertCoreInvariants(second);
  const events = (second.events ?? []).filter(({ aggregateId }) => aggregateId === captured.orderId);
  const sorted = [...events].sort((a, b) => (a.aggregateSequence ?? a.sequence) - (b.aggregateSequence ?? b.sequence));
  assert.deepEqual(events, sorted);
  out.push("capture and refund journals balance, event order is deterministic, and replay adds no rows");
}

async function multiProcessRecovery(ctx, out) {
  const apiA = await prepare(ctx, "h23-commercecommand");
  const apiB = await ctx.startApi();
  await ctx.concurrent(Array.from({ length: 18 }), 6, (_, index) => captureOrder(ctx, index % 2 ? apiA.baseUrl : apiB.baseUrl, 2_300 + index, { mixed: index % 2 === 0 }));
  let releaseWorker;
  const workerHeld = new Promise((resolve) => { releaseWorker = resolve; });
  const workerBarrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? workerHeld : { status: 204 });
  const workerA = await ctx.startWorker({ TEST_BARRIER_URL: workerBarrier.url, TEST_BARRIER_TOKEN: "h23-worker" });
  await ctx.waitFor(() => workerBarrier.ledger.some((entry) => entry.json?.point === "worker.claimed"), {
    label: "multi-role worker claim barrier",
    children: [workerA],
  });
  const receiver = await ctx.receiver();
  let releaseDispatcher;
  const dispatcherHeld = new Promise((resolve) => { releaseDispatcher = resolve; });
  const dispatcherBarrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? dispatcherHeld : { status: 204 });
  const dispatcherA = await ctx.startDispatcher(receiver.url, {
    TEST_BARRIER_URL: dispatcherBarrier.url,
    TEST_BARRIER_TOKEN: "h23-dispatcher",
  });
  await ctx.waitFor(() => dispatcherBarrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
    label: "multi-role dispatcher response barrier",
    children: [dispatcherA],
  });
  await ctx.stop(apiA, "SIGKILL");
  await ctx.stop(workerA, "SIGKILL");
  await ctx.stop(dispatcherA, "SIGKILL");
  releaseWorker({ status: 204 });
  releaseDispatcher({ status: 204 });
  const apiC = await ctx.startApi();
  const workerB = await ctx.startWorker();
  const workerC = await ctx.startWorker();
  const dispatcherB = await ctx.startDispatcher(receiver.url);
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiC.baseUrl);
    const pending = (value.work ?? []).filter(({ terminal }) => !terminal);
    const undelivered = resource(value, "notificationDeliveries").filter(({ state }) => state !== "DELIVERED");
    return pending.length === 0 && undelivered.length === 0 ? value : undefined;
  }, { timeoutMs: 180_000, label: "multi-role recovery drain", children: [workerB, workerC, dispatcherB] });
  assertCoreInvariants(snapshot);
  out.push("replacement API, Worker, and dispatcher drain durable state after three independent SIGKILLs");
}

async function allocateCapturedOrder(ctx, baseUrl, index, { quantity = 2, sellerIds = [sellerA, sellerB] } = {}) {
  const captured = await captureOrder(ctx, baseUrl, index, { quantity });
  const snapshot = await ctx.snapshot(baseUrl);
  const line = resource(snapshot, "orderLines").find(({ orderId }) => orderId === captured.orderId);
  assert.ok(line, "captured order line is missing");
  const firstQuantity = Math.floor(quantity / 2);
  const firstAmount = Math.floor(line.lineTotalMinor / 2);
  const allocations = [
    { orderLineId: line.orderLineId, sellerId: sellerIds[0], quantity: firstQuantity, amountMinor: firstAmount },
    { orderLineId: line.orderLineId, sellerId: sellerIds[1], quantity: quantity - firstQuantity, amountMinor: line.lineTotalMinor - firstAmount },
  ];
  const response = await ctx.mutate(baseUrl, `/api/v1/orders/${captured.orderId}/seller-allocations`, `allocation-${index}`, { allocations });
  assertOk(response);
  return { ...captured, line, allocations, allocationResponse: response };
}

async function sellerAllocationConservation(ctx, out) {
  const apiA = await prepare(ctx, "h24-commercecommand");
  const apiB = await ctx.startApi();
  const captured = await captureOrder(ctx, apiA.baseUrl, 2_400, { quantity: 5 });
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  const line = resource(snapshot, "orderLines").find(({ orderId }) => orderId === captured.orderId);
  const invalid = await ctx.mutate(apiA.baseUrl, `/api/v1/orders/${captured.orderId}/seller-allocations`, "h24-invalid", {
    allocations: [{ orderLineId: line.orderLineId, sellerId: sellerA, quantity: 5, amountMinor: line.lineTotalMinor - 1 }],
  });
  assert.equal(invalid.status, 409, invalid.text);
  assert.equal(invalid.json?.error?.code, "ALLOCATION_NOT_CONSERVED");
  const split = [
    { orderLineId: line.orderLineId, sellerId: sellerA, quantity: 2, amountMinor: Math.floor(line.lineTotalMinor * 0.4) },
    { orderLineId: line.orderLineId, sellerId: sellerB, quantity: 3, amountMinor: line.lineTotalMinor - Math.floor(line.lineTotalMinor * 0.4) },
  ];
  const alternate = [
    { orderLineId: line.orderLineId, sellerId: sellerA, quantity: 1, amountMinor: Math.floor(line.lineTotalMinor * 0.2) },
    { orderLineId: line.orderLineId, sellerId: sellerB, quantity: 4, amountMinor: line.lineTotalMinor - Math.floor(line.lineTotalMinor * 0.2) },
  ];
  const attempts = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/orders/${captured.orderId}/seller-allocations`,
    `h24-authority-${index}`,
    { allocations: index % 2 ? split : alternate },
  ));
  assert.equal(attempts.filter(({ status }) => status >= 200 && status < 300).length, 1);
  assert.ok(attempts.filter(({ status }) => status === 409).length >= 31);
  const final = await ctx.snapshot(apiA.baseUrl);
  const stored = resource(final, "sellerAllocations").filter(({ orderLineId }) => orderLineId === line.orderLineId);
  assert.equal(stored.reduce((sum, item) => sum + item.quantity, 0), line.quantity);
  assert.equal(stored.reduce((sum, item) => sum + item.amountMinor, 0), line.lineTotalMinor);
  assertCoreInvariants(final);
  out.push("invalid marketplace splits roll back and a 32-way valid split commits one immutable conserved allocation set");
}

async function createSettlement(ctx, baseUrl, index, sellerId = sellerA) {
  const response = await ctx.mutate(baseUrl, "/api/v1/seller-settlements", `settlement-${index}`, {
    tenantId: tenantA,
    sellerId,
    periodStart: "2026-01-01T00:00:00.000Z",
    periodEnd: "2027-01-01T00:00:00.000Z",
    currency: "USD",
  });
  assertOk(response);
  return { response, sellerSettlementId: find(response.json, "sellerSettlementId") };
}

async function settlementClose(ctx, out) {
  const apiA = await prepare(ctx, "h25-commercecommand");
  const apiB = await ctx.startApi();
  await allocateCapturedOrder(ctx, apiA.baseUrl, 2_500);
  const settlement = await createSettlement(ctx, apiA.baseUrl, 2_500);
  const closes = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/seller-settlements/${settlement.sellerSettlementId}/close`,
    `h25-close-${index}`,
    {},
  ));
  assert.equal(closes.filter(({ status }) => status >= 200 && status < 300).length, 1);
  const rejected = closes.filter(({ status }) => status === 409);
  assert.ok(rejected.length >= 31);
  assert.ok(rejected.every(({ json }) => json?.error?.code === "SETTLEMENT_CLOSED"));
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  const stored = resource(snapshot, "sellerSettlements").filter(({ sellerSettlementId }) => sellerSettlementId === settlement.sellerSettlementId);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].state, "CLOSED");
  const allocated = resource(snapshot, "sellerAllocations").filter(({ sellerId }) => sellerId === sellerA);
  assert.ok(allocated.every((item) => item.sellerSettlementId === settlement.sellerSettlementId || item.settlementId === settlement.sellerSettlementId));
  assertCoreInvariants(snapshot);
  out.push("two APIs close one immutable SellerSettlement and each eligible allocation is captured at most once");
}

async function openDispute(ctx, baseUrl, captured, index, amountMinor) {
  const response = await ctx.mutate(baseUrl, "/api/v1/commerce-disputes", `dispute-${index}`, {
    tenantId: tenantA,
    paymentAttemptId: captured.paymentAttemptId,
    providerDisputeId: `provider-dispute-${index}`,
    amountMinor,
  });
  return { response, commerceDisputeId: find(response.json, "commerceDisputeId") };
}

async function refundDisputeRace(ctx, out) {
  const apiA = await prepare(ctx, "h26-commercecommand");
  const apiB = await ctx.startApi();
  const captured = await allocateCapturedOrder(ctx, apiA.baseUrl, 2_600, { quantity: 4 });
  const total = captured.orderTotalMinor;
  const amount = Math.ceil(total * 0.75);
  const [refund, dispute] = await Promise.all([
    ctx.mutate(apiA.baseUrl, `/api/v1/orders/${captured.orderId}/refunds`, "h26-refund", {
      amountMinor: amount,
      reason: "race with dispute",
      restockLines: [],
    }),
    openDispute(ctx, apiB.baseUrl, captured, 2_600, amount).then(({ response }) => response),
  ]);
  assert.equal([refund, dispute].filter(({ status }) => status < 300).length, 1);
  const rejected = [refund, dispute].filter(({ status }) => status === 409);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].json?.error?.code, "RESERVE_EXCEEDS_CAPTURE");
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  const order = resource(snapshot, "orders").find(({ orderId }) => orderId === captured.orderId);
  const reserved = resource(snapshot, "commerceDisputes").filter(({ paymentAttemptId, state }) => paymentAttemptId === captured.paymentAttemptId && !["WON", "CANCELLED"].includes(state))
    .reduce((sum, item) => sum + item.amountMinor, 0);
  assert.ok(order.refundedMinor + reserved <= order.capturedMinor);
  assertCoreInvariants(snapshot);
  out.push("refund and dispute reservation serialize on captured amount so only one oversubscribing mutation commits");
}

async function settlementAdjustment(ctx, out) {
  const api = await prepare(ctx, "h27-commercecommand");
  const captured = await allocateCapturedOrder(ctx, api.baseUrl, 2_700);
  const settlement = await createSettlement(ctx, api.baseUrl, 2_700);
  assertOk(await ctx.mutate(api.baseUrl, `/api/v1/seller-settlements/${settlement.sellerSettlementId}/close`, "h27-close", {}));
  const snapshot = await ctx.snapshot(api.baseUrl);
  const source = resource(snapshot, "sellerAllocations").find(({ sellerId }) => sellerId === sellerA);
  const body = {
    tenantId: tenantA,
    sellerId: sellerA,
    sourceSettlementId: settlement.sellerSettlementId,
    sourceAllocationId: source.sellerAllocationId,
    amountMinor: -100,
    reason: "post-close correction",
  };
  const created = await ctx.mutate(api.baseUrl, "/api/v1/settlement-adjustments", "h27-adjustment", body);
  assertOk(created);
  const replay = await ctx.mutate(api.baseUrl, "/api/v1/settlement-adjustments", "h27-adjustment", body);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(created.json));
  const final = await ctx.snapshot(api.baseUrl);
  const closed = resource(final, "sellerSettlements").find(({ sellerSettlementId }) => sellerSettlementId === settlement.sellerSettlementId);
  assert.equal(closed.state, "CLOSED");
  const adjustments = resource(final, "settlementAdjustments").filter(({ sourceSettlementId }) => sourceSettlementId === settlement.sellerSettlementId);
  assert.equal(adjustments.length, 1);
  assert.ok(Date.parse(adjustments[0].targetPeriodStart) >= Date.parse(closed.periodEnd));
  assert.ok(resource(final, "orders").some(({ orderId }) => orderId === captured.orderId));
  assertCoreInvariants(final);
  out.push("post-close correction appends one next-period SettlementAdjustment without rewriting the closed settlement");
}

async function blueGreenReplay(ctx, out) {
  const v1 = await ctx.copyV1Workspace();
  await ctx.prepare(v1);
  const imported = await ctx.seed(finalSeed("h28-commerce-v1", { manager: false }), v1);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const blue = await ctx.startApi(v1);
  const body = quotePayload(2_800, { mixed: true });
  const original = await ctx.mutate(blue.baseUrl, "/api/v1/orders/quotes", "h28-blue-green", body);
  assertOk(original, [200, 201]);
  await ctx.prepare();
  const green = await ctx.startApi();
  const [blueReplay, greenReplay] = await Promise.all([
    ctx.mutate(blue.baseUrl, "/api/v1/orders/quotes", "h28-blue-green", body),
    ctx.mutate(green.baseUrl, "/api/v1/orders/quotes", "h28-blue-green", body),
  ]);
  assert.equal(ctx.canonical(blueReplay.json), ctx.canonical(original.json));
  assert.equal(ctx.canonical(greenReplay.json), ctx.canonical(original.json));
  const newQuote = await ctx.mutate(blue.baseUrl, "/api/v1/orders/quotes", "h28-v1-client-new", quotePayload(2_801));
  assertOk(newQuote, [200, 201]);
  const snapshot = await ctx.snapshot(green.baseUrl);
  assertCoreInvariants(snapshot);
  out.push("old and new API binaries share migrated data, replay one V1 response, and keep accepting documented V1 requests");
}

async function sustainedInvariantSoak(ctx, out) {
  const apiA = await prepare(ctx, "h29-commercecommand");
  const apiB = await ctx.startApi();
  const scale = performanceScale();
  const durationMs = Math.max(2_000, 30_000 * scale);
  let index = 0;
  const load = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: Math.max(500, 5_000 * scale),
    measureMs: durationMs,
    request: async ({ client }) => {
      const current = index++;
      const baseUrl = client % 2 ? apiA.baseUrl : apiB.baseUrl;
      return ctx.mutate(baseUrl, "/api/v1/orders/quotes", `h29-${current}`, quotePayload(2_900 + current, {
        mixed: current % 5 === 0,
        productId: physicalProduct,
        quantity: 1 + current % 3,
      }));
    },
  });
  assert.ok(load.completed > 0);
  assert.ok(Object.entries(load.statuses).some(([status, count]) => Number(status) < 300 && count > 0));
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  assertCoreInvariants(snapshot);
  const stable = await ctx.snapshot(apiB.baseUrl);
  assert.equal(ctx.canonical(stableSnapshot(snapshot)), ctx.canonical(stableSnapshot(stable)));
  out.push(`sustained two-API quote load completed ${load.completed} operations and retained every invariant`);
}

async function fullCatastropheDrill(ctx, out) {
  const apiA = await prepare(ctx, "h30-commercecommand");
  const apiB = await ctx.startApi();
  const captured = await allocateCapturedOrder(ctx, apiA.baseUrl, 3_000, { quantity: 4 });
  const digital = await captureOrder(ctx, apiB.baseUrl, 3_001, { productId: digitalProduct });
  const receiver = await ctx.receiver();
  const dispute = await openDispute(ctx, apiA.baseUrl, captured, 3_000, Math.floor(captured.orderTotalMinor / 2));
  assertOk(dispute.response);
  let releaseWorker;
  const workerHeld = new Promise((resolve) => { releaseWorker = resolve; });
  const workerBarrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? workerHeld : { status: 204 });
  const workerA = await ctx.startWorker({ TEST_BARRIER_URL: workerBarrier.url, TEST_BARRIER_TOKEN: "h30-worker" });
  await ctx.waitFor(() => workerBarrier.ledger.some((entry) => entry.json?.point === "worker.claimed"), {
    label: "catastrophe worker claim barrier",
    children: [workerA],
  });
  let releaseDispatcher;
  const dispatcherHeld = new Promise((resolve) => { releaseDispatcher = resolve; });
  const dispatcherBarrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? dispatcherHeld : { status: 204 });
  const dispatcherA = await ctx.startDispatcher(receiver.url, {
    TEST_BARRIER_URL: dispatcherBarrier.url,
    TEST_BARRIER_TOKEN: "h30-dispatcher",
  });
  await ctx.waitFor(() => dispatcherBarrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
    label: "catastrophe dispatcher response barrier",
    children: [dispatcherA],
  });
  await ctx.stop(apiA, "SIGKILL");
  await ctx.stop(workerA, "SIGKILL");
  await ctx.stop(dispatcherA, "SIGKILL");
  releaseWorker({ status: 204 });
  releaseDispatcher({ status: 204 });
  const apiC = await ctx.startApi();
  const workerB = await ctx.startWorker();
  const workerC = await ctx.startWorker();
  const dispatcherB = await ctx.startDispatcher(receiver.url);
  const resolution = await ctx.mutate(apiC.baseUrl, `/api/v1/commerce-disputes/${dispute.commerceDisputeId}/resolve`, "h30-lost", {
    providerEventId: "h30-provider-resolution",
    outcome: "LOST",
  });
  assertOk(resolution);
  await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiC.baseUrl);
    const current = resource(value, "commerceDisputes").find(({ commerceDisputeId }) => commerceDisputeId === dispute.commerceDisputeId);
    const chargebacks = resource(value, "ledgerEntries").filter((entry) =>
      entry.commerceDisputeId === dispute.commerceDisputeId || (entry.orderId === captured.orderId && entry.journalKind === "CHARGEBACK"));
    return (current?.state ?? current?.outcome) === "LOST" && chargebacks.length >= 2 ? value : undefined;
  }, { timeoutMs: 120_000, label: "lost dispute chargeback", children: [workerB, workerC] });
  const settlement = await createSettlement(ctx, apiC.baseUrl, 3_000);
  assertOk(await ctx.mutate(apiC.baseUrl, `/api/v1/seller-settlements/${settlement.sellerSettlementId}/close`, "h30-close", {}));
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiC.baseUrl);
    const live = (value.work ?? []).filter(({ terminal }) => !terminal);
    const undelivered = resource(value, "notificationDeliveries").filter(({ state }) => state !== "DELIVERED");
    return live.length === 0 && undelivered.length === 0 ? value : undefined;
  }, { timeoutMs: 300_000, label: "full catastrophe recovery", children: [workerB, workerC, dispatcherB] });
  const lost = resource(snapshot, "commerceDisputes").find(({ commerceDisputeId }) => commerceDisputeId === dispute.commerceDisputeId);
  assert.equal(lost.state ?? lost.outcome, "LOST");
  const chargebacks = resource(snapshot, "ledgerEntries").filter((entry) => entry.commerceDisputeId === dispute.commerceDisputeId || entry.journalKind === "CHARGEBACK");
  assert.ok(chargebacks.length >= 2);
  assert.equal(new Set(chargebacks.map(({ journalId }) => journalId)).size, 1, "LOST dispute created more than one chargeback journal");
  assertCoreInvariants(snapshot);
  out.push("mixed V1 and marketplace state survives API, Worker, and dispatcher loss with one chargeback and full drain");
}

function scaledCount(total, scale, minimum = 1) {
  return Math.max(minimum, Math.ceil(total * scale));
}

function performanceSeed(scale) {
  const value = finalSeed("perf-commercecommand");
  const count = scaledCount(20_000, scale, 100);
  for (let index = 0; index < count; index += 1) {
    const productId = id(100_000 + index);
    const offerVersionId = id(200_000 + index);
    const inventoryPoolId = id(300_000 + index);
    value.products.push({ productId, tenantId: tenantA, sku: `PERF-${index}`, name: `Performance Product ${index}`, kind: "PHYSICAL" });
    value.offerVersions.push(offer(offerVersionId, tenantA, productId, 1, 100 + index % 50, 10, "PHYSICAL"));
    value.inventoryPools.push({ inventoryPoolId, tenantId: tenantA, productId, priority: 1, onHand: 10_000, reserved: 0 });
  }
  return value;
}

async function setupQuotes(ctx, baseUrls, start, count, options = {}) {
  return ctx.concurrent(Array.from({ length: count }), 64, async (_, index) => {
    const current = start + index;
    return createQuote(ctx, baseUrls[index % baseUrls.length], current, options);
  });
}

async function setupUnknownPayments(ctx, baseUrls, start, count, options = {}) {
  const quotes = await setupQuotes(ctx, baseUrls, start, count, options);
  return ctx.concurrent(quotes, 64, async (quote, index) => ({
    ...quote,
    ...await checkout(ctx, baseUrls[index % baseUrls.length], quote.orderId, start + index),
  }));
}

async function setupCaptures(ctx, baseUrls, start, count, options = {}) {
  return ctx.concurrent(Array.from({ length: count }), 64, (_, index) => captureOrder(
    ctx,
    baseUrls[index % baseUrls.length],
    start + index,
    options,
  ));
}

function requirePerformance(metricValue, requirements, scale) {
  if (scale === 1) assertMetric(metricValue, requirements);
}

async function commercePerformance(ctx, assertions) {
  const scale = performanceScale();
  const warmupMs = Math.max(1_000, 10_000 * scale);
  const measureMs = Math.max(2_000, 60_000 * scale);
  await ctx.prepare();
  const imported = await ctx.seed(performanceSeed(scale));
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const apiA = await ctx.startApi();
  const apiB = await ctx.startApi();
  const baseUrls = [apiA.baseUrl, apiB.baseUrl];
  const metrics = [];
  let operation = 0;

  const quoteRead = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs,
    measureMs,
    request: ({ client }) => {
      const current = operation++;
      if (current % 5 !== 0) return ctx.request(baseUrls[client % 2], `/api/v1/products?tenantId=${tenantA}`);
      const perfProduct = id(100_000 + current % scaledCount(20_000, scale, 100));
      return ctx.mutate(baseUrls[client % 2], "/api/v1/orders/quotes", `perf-mix-${current}`, quotePayload(current, { productId: perfProduct }));
    },
  });
  requirePerformance(quoteRead, { throughput: 250, p95: 300, statuses: [200, 201] }, scale);
  assertCoreInvariants(await ctx.snapshot(apiA.baseUrl));
  metrics.push(metric("quote-read-mix", quoteRead, measureMs));
  assertions.push(`quote-read-mix ${quoteRead.throughput.toFixed(1)}/s p95 ${quoteRead.p95.toFixed(1)}ms`);

  const checkoutQuotes = await setupQuotes(ctx, baseUrls, 400_000, scaledCount(2_000, scale, 40));
  operation = 0;
  const checkoutLoad = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs,
    measureMs,
    request: ({ client }) => {
      const current = operation++;
      const quote = checkoutQuotes[current % checkoutQuotes.length];
      return ctx.mutate(baseUrls[client % 2], `/api/v1/orders/${quote.orderId}/checkout`, current % 2 === 0 ? `perf-checkout-${quote.orderId}` : `perf-checkout-race-${current}`, {
        provider: "SANDBOX",
        providerRequestId: `perf-provider-${quote.orderId}`,
      });
    },
  });
  requirePerformance(checkoutLoad, { throughput: 120, p95: 500 }, scale);
  const checkoutSnapshot = await ctx.snapshot(apiA.baseUrl);
  for (const quote of checkoutQuotes) {
    assert.ok(resource(checkoutSnapshot, "paymentAttempts").filter(({ orderId }) => orderId === quote.orderId).length <= 1);
  }
  assertCoreInvariants(checkoutSnapshot);
  metrics.push(metric("checkout-contention", checkoutLoad, measureMs));
  assertions.push(`checkout-contention ${checkoutLoad.throughput.toFixed(1)}/s p95 ${checkoutLoad.p95.toFixed(1)}ms`);

  operation = 0;
  const hotInventory = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs,
    measureMs,
    request: ({ client }) => {
      const current = operation++;
      const hotspot = current % 10;
      return ctx.mutate(baseUrls[client % 2], "/api/v1/orders/quotes", `perf-hot-${current}`, quotePayload(500_000 + current, {
        productId: id(100_000 + hotspot),
        quantity: hotspot === 0 ? 1_000 : 1 + current % 5,
      }));
    },
  });
  requirePerformance(hotInventory, { throughput: 150, p95: 500 }, scale);
  assertCoreInvariants(await ctx.snapshot(apiA.baseUrl));
  metrics.push(metric("inventory-hotspot", hotInventory, measureMs));
  assertions.push(`inventory-hotspot ${hotInventory.throughput.toFixed(1)}/s p95 ${hotInventory.p95.toFixed(1)}ms`);

  const unknownPayments = await setupUnknownPayments(ctx, baseUrls, 600_000, scaledCount(5_000, scale, 50));
  operation = 0;
  const reconcile = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs,
    measureMs,
    request: ({ client }) => {
      const current = operation++;
      const payment = unknownPayments[Math.floor(current / 3) % unknownPayments.length];
      const phase = current % 3;
      if (phase < 2) {
        const outcome = phase === 0 ? "UNKNOWN" : "CAPTURED";
        return ctx.mutate(baseUrls[client % 2], "/api/v1/payment-provider/callbacks", `perf-callback-${outcome}-${payment.paymentAttemptId}`, {
          providerEventId: `perf-event-${outcome}-${payment.paymentAttemptId}`,
          providerRequestId: payment.providerRequestId,
          outcome,
          capturedMinor: outcome === "CAPTURED" ? payment.orderTotalMinor : 0,
        });
      }
      return ctx.mutate(baseUrls[client % 2], `/api/v1/payment-attempts/${payment.paymentAttemptId}/reconcile`, `perf-reconcile-${payment.paymentAttemptId}`, {
        providerQueryId: `query-${payment.paymentAttemptId}`,
        outcome: "CAPTURED",
        capturedMinor: payment.orderTotalMinor,
      });
    },
  });
  requirePerformance(reconcile, { throughput: 100, p95: 700 }, scale);
  const finalReconciliations = await ctx.concurrent(unknownPayments, 64, (payment, index) => ctx.mutate(
    baseUrls[index % 2],
    `/api/v1/payment-attempts/${payment.paymentAttemptId}/reconcile`,
    `perf-final-reconcile-${payment.paymentAttemptId}`,
    {
      providerQueryId: `final-query-${payment.paymentAttemptId}`,
      outcome: "CAPTURED",
      capturedMinor: payment.orderTotalMinor,
    },
  ));
  assert.ok(finalReconciliations.every(({ status }) => [200, 201, 202, 409].includes(status)));
  const paymentIds = new Set(unknownPayments.map(({ paymentAttemptId }) => paymentAttemptId));
  const reconciledSnapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const attempts = resource(value, "paymentAttempts").filter(({ paymentAttemptId }) => paymentIds.has(paymentAttemptId));
    return attempts.length === paymentIds.size && attempts.every(itemCaptured) ? value : undefined;
  }, { timeoutMs: 120_000, label: "payment reconciliation convergence" });
  assertCoreInvariants(reconciledSnapshot);
  metrics.push(metric("payment-unknown-reconcile", reconcile, measureMs));
  assertions.push(`payment-unknown-reconcile ${reconcile.throughput.toFixed(1)}/s p95 ${reconcile.p95.toFixed(1)}ms`);

  const fulfillmentOrders = await setupCaptures(ctx, baseUrls, 700_000, scaledCount(10_000, scale, 80));
  const fulfillmentStarted = performance.now();
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  await ctx.stop(workers[0], "SIGKILL");
  const replacement = await ctx.startWorker();
  const fulfillmentIds = new Set(fulfillmentOrders.map(({ orderId }) => orderId));
  const fulfilled = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const plans = resource(value, "fulfillmentPlans").filter(({ orderId }) => fulfillmentIds.has(orderId));
    return plans.length === fulfillmentIds.size && plans.every(({ state }) => state === "COMPLETED") ? value : undefined;
  }, { timeoutMs: 300_000, label: "performance fulfillment drain", children: [...workers.slice(1), replacement] });
  const fulfillmentDuration = performance.now() - fulfillmentStarted;
  const fulfillmentMetric = {
    completed: fulfillmentIds.size,
    throughput: fulfillmentIds.size / (fulfillmentDuration / 1_000),
    p50: 0,
    p95: 0,
    p99: 0,
    statuses: {},
  };
  if (scale === 1) assert.ok(fulfillmentMetric.throughput >= 50 && fulfillmentDuration <= 300_000);
  assertCoreInvariants(fulfilled);
  metrics.push(metric("fulfillment-drain", fulfillmentMetric, fulfillmentDuration));
  assertions.push(`fulfillment-drain ${fulfillmentMetric.throughput.toFixed(1)} plans/s in ${fulfillmentDuration.toFixed(0)}ms`);

  const receiver = await ctx.receiver((_entry, ledger) => ({ status: ledger.length % 10 === 0 ? 503 : 204 }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? held : { status: 204 });
  const dispatchStarted = performance.now();
  const [dispatcherA, dispatcherB] = await Promise.all([
    ctx.startDispatcher(receiver.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-dispatch-a" }),
    ctx.startDispatcher(receiver.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-dispatch-b" }),
  ]);
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
    label: "performance dispatcher barrier",
    children: [dispatcherA, dispatcherB],
  });
  await ctx.stop(dispatcherA, "SIGKILL");
  release({ status: 204 });
  const dispatcherC = await ctx.startDispatcher(receiver.url);
  const expectedNotifications = scaledCount(10_000, scale, 80);
  await ctx.waitFor(() => receiver.ledger.length >= expectedNotifications, {
    timeoutMs: 180_000,
    label: "performance notification drain",
    children: [dispatcherB, dispatcherC],
  });
  const dispatchDuration = performance.now() - dispatchStarted;
  const dispatchMetric = {
    completed: receiver.ledger.length,
    throughput: receiver.ledger.length / (dispatchDuration / 1_000),
    p50: 0,
    p95: 0,
    p99: 0,
    statuses: {},
  };
  if (scale === 1) assert.ok(dispatchMetric.throughput >= 100 && dispatchDuration <= 180_000);
  const notificationGroups = Map.groupBy(receiver.ledger, (entry) => {
    const name = Object.keys(entry.headers).find((header) => header.endsWith("-event-id"));
    return name ? entry.headers[name] : "missing";
  });
  assert.ok([...notificationGroups.values()].some((entries) => entries.length > 1
    && new Set(entries.map(({ raw }) => raw)).size === 1), "lost ACK produced no byte-identical retry");
  const notificationSnapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    return resource(value, "notificationDeliveries").every(({ state }) => state === "DELIVERED") ? value : undefined;
  }, { timeoutMs: 180_000, label: "performance notification outbox drain", children: [dispatcherB, dispatcherC] });
  assertCoreInvariants(notificationSnapshot);
  metrics.push(metric("notification-unknown-ack", dispatchMetric, dispatchDuration));
  assertions.push(`notification-unknown-ack ${dispatchMetric.throughput.toFixed(1)} deliveries/s in ${dispatchDuration.toFixed(0)}ms`);

  for (const worker of [...workers.slice(1), replacement]) await ctx.stop(worker);
  const digitalCount = scaledCount(20_000, scale, 80);
  const activeCount = Math.floor(digitalCount / 2);
  const activeDigitalOrders = await setupCaptures(ctx, baseUrls, 800_000, activeCount, { productId: digitalProduct });
  const grantWorker = await ctx.startWorker();
  const activeIds = new Set(activeDigitalOrders.map(({ orderId }) => orderId));
  const activeSnapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const grants = resource(value, "entitlementGrants").filter(({ orderId }) => activeIds.has(orderId));
    return grants.length === activeIds.size && grants.every(({ state }) => state === "ACTIVE") ? value : undefined;
  }, { timeoutMs: 300_000, label: "performance entitlement pre-grants", children: [grantWorker] });
  await ctx.stop(grantWorker);
  const pendingDigitalOrders = await setupCaptures(ctx, baseUrls, 800_000 + activeCount, digitalCount - activeCount, { productId: digitalProduct });
  const digitalOrders = [...activeDigitalOrders, ...pendingDigitalOrders];
  const digitalIds = new Set(digitalOrders.map(({ orderId }) => orderId));
  const grants = new Map(resource(activeSnapshot, "entitlementGrants")
    .filter(({ orderId }) => activeIds.has(orderId)).map((item) => [item.orderId, item]));
  const entitlementWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  operation = 0;
  const entitlementLoad = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs,
    measureMs,
    request: ({ client }) => {
      const current = operation++;
      const phase = current % 3;
      if (phase === 1) {
        const order = activeDigitalOrders[Math.floor(current / 3) % activeDigitalOrders.length];
        return ctx.mutate(baseUrls[client % 2], `/api/v1/entitlement-grants/${grants.get(order.orderId).entitlementGrantId}/revoke`, `perf-revoke-${order.orderId}`, {});
      }
      const orders = phase === 0 ? activeDigitalOrders : pendingDigitalOrders;
      const order = orders[Math.floor(current / 3) % orders.length];
      return ctx.mutate(baseUrls[client % 2], `/api/v1/orders/${order.orderId}/refunds`, `perf-digital-refund-${order.orderId}`, {
        amountMinor: order.orderTotalMinor,
        reason: "performance digital refund",
        restockLines: [],
      });
    },
  });
  requirePerformance(entitlementLoad, { throughput: 150, p95: 500 }, scale);
  const entitlementFinal = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const fullRefunds = resource(value, "orders").filter(({ orderId, capturedMinor, refundedMinor }) =>
      digitalIds.has(orderId) && capturedMinor > 0 && capturedMinor === refundedMinor);
    const allRevoked = fullRefunds.every((order) => resource(value, "entitlementGrants")
      .filter((grant) => grant.orderId === order.orderId)
      .every(({ state }) => state === "REVOKED"));
    return fullRefunds.length > 0 && allRevoked ? value : undefined;
  }, { timeoutMs: 300_000, label: "performance entitlement convergence", children: entitlementWorkers });
  const relevantGrants = resource(entitlementFinal, "entitlementGrants").filter(({ orderId }) => digitalIds.has(orderId));
  assert.equal(new Set(relevantGrants.map(({ orderLineId, grantRevision }) => `${orderLineId}:${grantRevision}`)).size, relevantGrants.length);
  assertCoreInvariants(entitlementFinal);
  metrics.push(metric("entitlement-revocation-storm", entitlementLoad, measureMs));
  assertions.push(`entitlement-revocation-storm ${entitlementLoad.throughput.toFixed(1)}/s p95 ${entitlementLoad.p95.toFixed(1)}ms`);

  const settlementIds = await preparePerformanceSettlements(ctx, baseUrls, scale);
  operation = 0;
  const settlementLoad = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs,
    measureMs,
    request: ({ client }) => {
      const current = operation++;
      const settlementId = settlementIds[current % settlementIds.length];
      return ctx.mutate(baseUrls[client % 2], `/api/v1/seller-settlements/${settlementId}/close`, `perf-close-${settlementId}`, {});
    },
  });
  requirePerformance(settlementLoad, { throughput: 80, p95: 750 }, scale);
  const settlementSnapshot = await ctx.snapshot(apiA.baseUrl);
  const settledAllocations = resource(settlementSnapshot, "sellerAllocations")
    .filter((allocation) => allocation.sellerSettlementId || allocation.settlementId);
  assert.equal(new Set(settledAllocations.map(({ sellerAllocationId }) => sellerAllocationId)).size, settledAllocations.length);
  assertCoreInvariants(settlementSnapshot);
  metrics.push(metric("seller-settlement-close", settlementLoad, measureMs));
  assertions.push(`seller-settlement-close ${settlementLoad.throughput.toFixed(1)}/s p95 ${settlementLoad.p95.toFixed(1)}ms`);

  const financialOrders = [...fulfillmentOrders, ...digitalOrders].slice(0, scaledCount(20_000, scale, 100));
  const resolutionOrders = fulfillmentOrders.slice(0, scaledCount(2_000, scale, 20));
  const resolutionTargets = await ctx.concurrent(resolutionOrders, 64, async (order, index) => ({
    order,
    ...await openDispute(ctx, baseUrls[index % 2], order, 1_100_000 + index, Math.floor(order.orderTotalMinor / 4)),
  }));
  assert.ok(resolutionTargets.every(({ response }) => response.status < 300));
  operation = 0;
  const disputeLoad = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs,
    measureMs,
    request: ({ client }) => {
      const current = operation++;
      const phase = current % 3;
      if (phase === 2) {
        const target = resolutionTargets[Math.floor(current / 3) % resolutionTargets.length];
        const outcome = Math.floor(current / 3) % 2 === 0 ? "LOST" : "WON";
        return ctx.mutate(baseUrls[client % 2], `/api/v1/commerce-disputes/${target.commerceDisputeId}/resolve`,
          `perf-resolve-${target.commerceDisputeId}`, {
            providerEventId: `perf-resolution-${target.commerceDisputeId}`,
            outcome,
          });
      }
      const order = financialOrders[Math.floor(current / 3) % financialOrders.length];
      if (phase === 0) {
        return ctx.mutate(baseUrls[client % 2], `/api/v1/orders/${order.orderId}/refunds`, `perf-race-refund-${order.orderId}`, {
          amountMinor: Math.floor(order.orderTotalMinor / 2),
          reason: "performance dispute race",
          restockLines: [],
        });
      }
      return ctx.mutate(baseUrls[client % 2], "/api/v1/commerce-disputes", `perf-race-dispute-${order.orderId}`, {
        tenantId: tenantA,
        paymentAttemptId: order.paymentAttemptId,
        providerDisputeId: `perf-dispute-${order.orderId}`,
        amountMinor: Math.floor(order.orderTotalMinor / 2),
      });
    },
  });
  requirePerformance(disputeLoad, { throughput: 100, p95: 750 }, scale);
  const disputeSnapshot = await ctx.snapshot(apiA.baseUrl);
  const terminalDisputes = resource(disputeSnapshot, "commerceDisputes")
    .filter(({ commerceDisputeId, state }) => resolutionTargets.some((item) => item.commerceDisputeId === commerceDisputeId)
      && ["LOST", "WON"].includes(state));
  assert.ok(terminalDisputes.length > 0, "provider dispute resolutions produced no terminal result");
  for (const dispute of terminalDisputes.filter(({ state }) => state === "LOST")) {
    const journals = resource(disputeSnapshot, "ledgerEntries")
      .filter((entry) => entry.commerceDisputeId === dispute.commerceDisputeId || (entry.journalKind === "CHARGEBACK" && entry.paymentAttemptId === dispute.paymentAttemptId));
    assert.equal(new Set(journals.map(({ journalId }) => journalId)).size, 1, "LOST dispute produced duplicate chargeback journals");
  }
  assertCoreInvariants(disputeSnapshot);
  metrics.push(metric("refund-dispute-race", disputeLoad, measureMs));
  assertions.push(`refund-dispute-race ${disputeLoad.throughput.toFixed(1)}/s p95 ${disputeLoad.p95.toFixed(1)}ms`);

  await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const due = (value.work ?? []).filter(({ availableAt, terminal }) => !terminal && (!availableAt || Date.parse(availableAt) <= Date.now()));
    const undelivered = resource(value, "notificationDeliveries").filter(({ state }) => state !== "DELIVERED");
    return due.length === 0 && undelivered.length === 0;
  }, {
    timeoutMs: 300_000,
    label: "pre-catastrophe durable drain",
    children: [...entitlementWorkers, dispatcherB, dispatcherC],
  });
  for (const worker of entitlementWorkers) await ctx.stop(worker);
  await ctx.stop(dispatcherB);
  await ctx.stop(dispatcherC);

  const catastropheCount = scaledCount(100, scale, 12);
  const catastropheQuotes = await setupQuotes(ctx, baseUrls, 1_200_000, catastropheCount, { mixed: true });
  const catastrophePayments = await setupUnknownPayments(ctx, baseUrls, 1_210_000, catastropheCount, { mixed: true });
  const catastropheMarketplace = await ctx.concurrent(Array.from({ length: catastropheCount }), 16, async (_, index) => {
    const firstSeller = id(900_000 + index * 2);
    const secondSeller = id(900_001 + index * 2);
    const captured = await allocateCapturedOrder(ctx, baseUrls[index % 2], 1_220_000 + index, {
      quantity: 2,
      sellerIds: [firstSeller, secondSeller],
    });
    const settlement = await createSettlement(ctx, baseUrls[index % 2], 1_220_000 + index, firstSeller);
    const dispute = await openDispute(ctx, baseUrls[index % 2], captured, 1_220_000 + index, Math.floor(captured.orderTotalMinor / 4));
    assertOk(dispute.response);
    return { captured, settlement, dispute, index };
  });
  let releaseWorker;
  const workerHeld = new Promise((resolve) => { releaseWorker = resolve; });
  const workerBarrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? workerHeld : { status: 204 });
  const catastropheWorker = await ctx.startWorker({ TEST_BARRIER_URL: workerBarrier.url, TEST_BARRIER_TOKEN: "perf-catastrophe-worker" });
  await ctx.waitFor(() => workerBarrier.ledger.some((entry) => entry.json?.point === "worker.claimed"), {
    label: "performance catastrophe worker barrier",
    children: [catastropheWorker],
  });
  let releaseDispatcher;
  const dispatcherHeld = new Promise((resolve) => { releaseDispatcher = resolve; });
  const dispatcherBarrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? dispatcherHeld : { status: 204 });
  const catastropheDispatcher = await ctx.startDispatcher(receiver.url, {
    TEST_BARRIER_URL: dispatcherBarrier.url,
    TEST_BARRIER_TOKEN: "perf-catastrophe-dispatcher",
  });
  await ctx.waitFor(() => dispatcherBarrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
    label: "performance catastrophe dispatcher barrier",
    children: [catastropheDispatcher],
  });
  let activeApis = [apiA.baseUrl, apiB.baseUrl];
  operation = 0;
  const catastrophePromise = measuredLoad(ctx, {
    concurrency: 64,
    warmupMs,
    measureMs,
    request: ({ client }) => {
      const current = operation++;
      const position = Math.floor(current / 6) % catastropheCount;
      const baseUrl = activeApis[client % activeApis.length];
      const startedAt = performance.now();
      let request;
      switch (current % 6) {
        case 0:
          request = ctx.mutate(baseUrl, "/api/v1/orders/quotes", `perf-catastrophe-quote-${current}`,
            quotePayload(1_230_000 + current, { productId: current % 4 === 0 ? digitalProduct : physicalProduct }));
          break;
        case 1: {
          const quote = catastropheQuotes[position];
          request = ctx.mutate(baseUrl, `/api/v1/orders/${quote.orderId}/checkout`, `perf-catastrophe-checkout-${quote.orderId}`, {
            provider: "SANDBOX",
            providerRequestId: `perf-catastrophe-provider-${quote.orderId}`,
          });
          break;
        }
        case 2: {
          const payment = catastrophePayments[position];
          request = ctx.mutate(baseUrl, `/api/v1/payment-attempts/${payment.paymentAttemptId}/reconcile`,
            `perf-catastrophe-reconcile-${payment.paymentAttemptId}`, {
              providerQueryId: `perf-catastrophe-query-${payment.paymentAttemptId}`,
              outcome: "CAPTURED",
              capturedMinor: payment.orderTotalMinor,
            });
          break;
        }
        case 3: {
          const { captured } = catastropheMarketplace[position];
          request = ctx.mutate(baseUrl, `/api/v1/orders/${captured.orderId}/refunds`, `perf-catastrophe-refund-${captured.orderId}`, {
            amountMinor: Math.floor(captured.orderTotalMinor / 4),
            reason: "catastrophe load",
            restockLines: [],
          });
          break;
        }
        case 4: {
          const { settlement } = catastropheMarketplace[position];
          request = ctx.mutate(baseUrl, `/api/v1/seller-settlements/${settlement.sellerSettlementId}/close`,
            `perf-catastrophe-close-${settlement.sellerSettlementId}`, {});
          break;
        }
        default: {
          const { dispute } = catastropheMarketplace[position];
          request = ctx.mutate(baseUrl, `/api/v1/commerce-disputes/${dispute.commerceDisputeId}/resolve`,
            `perf-catastrophe-resolve-${dispute.commerceDisputeId}`, {
              providerEventId: `perf-catastrophe-event-${dispute.commerceDisputeId}`,
              outcome: position % 2 === 0 ? "LOST" : "WON",
            });
        }
      }
      return request.catch(() => ({ status: 599, durationMs: performance.now() - startedAt }));
    },
  });
  await new Promise((resolve) => setTimeout(resolve, warmupMs + Math.max(500, measureMs / 3)));
  activeApis = [apiB.baseUrl];
  await ctx.stop(apiA, "SIGKILL");
  await ctx.stop(catastropheWorker, "SIGKILL");
  await ctx.stop(catastropheDispatcher, "SIGKILL");
  releaseWorker({ status: 204 });
  releaseDispatcher({ status: 204 });
  const apiC = await ctx.startApi();
  activeApis = [apiB.baseUrl, apiC.baseUrl];
  const replacementWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const replacementDispatchers = await Promise.all(Array.from({ length: 2 }, () => ctx.startDispatcher(receiver.url)));
  const catastropheLoad = await catastrophePromise;
  const recovered = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiC.baseUrl);
    const pending = (value.work ?? []).filter(({ availableAt, terminal }) => !terminal && (!availableAt || Date.parse(availableAt) <= Date.now()));
    const undelivered = resource(value, "notificationDeliveries").filter(({ state }) => state !== "DELIVERED");
    return pending.length === 0 && undelivered.length === 0 ? value : undefined;
  }, {
    timeoutMs: 300_000,
    label: "performance catastrophe drain",
    children: [...replacementWorkers, ...replacementDispatchers],
  });
  assert.ok(catastropheLoad.completed > 0, "catastrophe load completed no operation");
  assertCoreInvariants(recovered);
  metrics.push(metric("full-catastrophe-recovery", catastropheLoad, measureMs));
  assertions.push(`full-catastrophe-recovery ${catastropheLoad.throughput.toFixed(1)}/s and durable drain after three SIGKILLs`);

  return { metrics };
}

async function preparePerformanceSettlements(ctx, baseUrls, scale) {
  const orderCount = scaledCount(100, scale, 2);
  const productCount = Math.min(100, scaledCount(20_000, scale, 100));
  const sellerCount = scaledCount(1_000, scale, 10);
  const settlementSellerIds = Array.from({ length: sellerCount }, (_, index) => id(700_000 + index));
  for (let orderIndex = 0; orderIndex < orderCount; orderIndex += 1) {
    const index = 1_000_000 + orderIndex;
    const lines = Array.from({ length: productCount }, (_, productIndex) => ({ productId: id(100_000 + productIndex), quantity: 5 }));
    const quote = await ctx.mutate(baseUrls[orderIndex % 2], "/api/v1/orders/quotes", `perf-market-quote-${orderIndex}`, {
      tenantId: tenantA,
      buyerId: buyerA,
      channel: "PARTNER",
      lines,
      holdTtlSeconds: 3_600,
    });
    assertOk(quote, [200, 201]);
    const orderId = find(quote.json, "orderId");
    const checked = await checkout(ctx, baseUrls[orderIndex % 2], orderId, index);
    assertOk(await ctx.mutate(baseUrls[orderIndex % 2], "/api/v1/payment-provider/callbacks", `perf-market-callback-${orderIndex}`, {
      providerEventId: `perf-market-event-${orderIndex}`,
      providerRequestId: checked.providerRequestId,
      outcome: "CAPTURED",
      capturedMinor: find(quote.json, "orderTotalMinor"),
    }));
    const snapshot = await ctx.snapshot(baseUrls[orderIndex % 2]);
    const storedLines = resource(snapshot, "orderLines").filter((item) => item.orderId === orderId);
    const allocations = storedLines.flatMap((line, lineIndex) => Array.from({ length: 5 }, (_, split) => ({
      orderLineId: line.orderLineId,
      sellerId: settlementSellerIds[(orderIndex * productCount * 5 + lineIndex * 5 + split) % sellerCount],
      quantity: 1,
      amountMinor: split === 4
        ? line.lineTotalMinor - Math.floor(line.lineTotalMinor / 5) * 4
        : Math.floor(line.lineTotalMinor / 5),
    })));
    assertOk(await ctx.mutate(baseUrls[orderIndex % 2], `/api/v1/orders/${orderId}/seller-allocations`, `perf-market-allocation-${orderIndex}`, { allocations }));
  }
  return ctx.concurrent(settlementSellerIds, 64, async (sellerId, index) => {
    const response = await ctx.mutate(baseUrls[index % 2], "/api/v1/seller-settlements", `perf-settlement-${index}`, {
      tenantId: tenantA,
      sellerId,
      periodStart: "2026-01-01T00:00:00.000Z",
      periodEnd: "2027-01-01T00:00:00.000Z",
      currency: "USD",
    });
    assertOk(response);
    return find(response.json, "sellerSettlementId");
  });
}

export default standardAdapter(spec);
