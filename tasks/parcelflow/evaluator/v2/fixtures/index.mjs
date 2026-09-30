import { createHash } from "node:crypto";

const SEED_KEYS = ["warehouses", "skus", "stockPositions", "orders"];

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function offsetMilliseconds(offset = {}) {
  if (typeof offset === "number") return offset;
  return (offset.days ?? 0) * 86_400_000
    + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000
    + (offset.seconds ?? 0) * 1_000
    + (offset.milliseconds ?? 0);
}

function safe(value, maximum = 32) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, maximum) || "value";
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId, and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMilliseconds(offset)).toISOString(); },
    key(label) { return `pf-${safe(caseId)}-${safe(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 18)}`.slice(0, 128); },
    code(label, maximum = 32) { return `${safe(label).replaceAll("-", "").toUpperCase()}-${hash(namespace, "code", label).toString("hex").slice(0, 8).toUpperCase()}`.slice(0, maximum); },
    integer(label, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) throw new TypeError("invalid integer range");
      return minimum + (hash(namespace, "integer", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

export function makeEmptySeed(fixtures) {
  return Object.fromEntries([["schemaVersion", 1], ...SEED_KEYS.map((key) => [key, []])]);
}

function stockPosition(warehouseId, skuId, onHand) {
  return { warehouseId, skuId, onHand };
}

/** Published worked example: early Warehouses can split, but a later Warehouse can satisfy the whole Order. */
export function makeAllocationFixture(options) {
  const fixtures = createFixtureFactory(options);
  const skuX = { id: fixtures.uuid("sku-x"), code: fixtures.code("sku-x", 64), name: "Hidden SKU X" };
  const skuY = { id: fixtures.uuid("sku-y"), code: fixtures.code("sku-y", 64), name: "Hidden SKU Y" };
  const warehouseA = { id: fixtures.uuid("warehouse-a"), code: fixtures.code("warehouse-a"), name: "Hidden Warehouse A", priority: 10 };
  const warehouseB = { id: fixtures.uuid("warehouse-b"), code: fixtures.code("warehouse-b"), name: "Hidden Warehouse B", priority: 20 };
  const warehouseC = { id: fixtures.uuid("warehouse-c"), code: fixtures.code("warehouse-c"), name: "Hidden Warehouse C", priority: 30 };
  const warehouses = [warehouseB, warehouseC, warehouseA];
  const lines = [{ skuId: skuY.id, quantity: 5 }, { skuId: skuX.id, quantity: 5 }];
  const stock = [
    stockPosition(warehouseA.id, skuX.id, 5), stockPosition(warehouseA.id, skuY.id, 0),
    stockPosition(warehouseB.id, skuX.id, 0), stockPosition(warehouseB.id, skuY.id, 5),
    stockPosition(warehouseC.id, skuX.id, 5), stockPosition(warehouseC.id, skuY.id, 5),
  ];
  return {
    fixtures,
    warehouses,
    skus: [skuX, skuY],
    stock,
    lines,
    completeWarehouseId: warehouseC.id,
    seed: {
      ...makeEmptySeed(fixtures),
      warehouses,
      skus: [skuX, skuY],
      stockPositions: stock,
    },
  };
}

/** FINAL fixture with enough aggregate capacity and no complete single Warehouse. */
export function makeSplitFixture(options) {
  const fixture = makeAllocationFixture(options);
  const completeId = fixture.completeWarehouseId;
  const stock = fixture.stock.filter(({ warehouseId }) => warehouseId !== completeId);
  const warehouses = fixture.warehouses.filter(({ id }) => id !== completeId);
  return {
    ...fixture,
    warehouses,
    stock,
    completeWarehouseId: null,
    seed: { ...fixture.seed, warehouses, stockPositions: stock },
  };
}

export function makeSeedFixture(options) {
  const fixtures = createFixtureFactory(options);
  const warehouse = { id: fixtures.uuid("seed-warehouse"), code: fixtures.code("seed-warehouse"), name: "Seed Warehouse", priority: 7 };
  const sku = { id: fixtures.uuid("seed-sku"), code: fixtures.code("seed-sku", 64), name: "Seed SKU" };
  const order = {
    id: fixtures.uuid("seed-order"),
    customerReference: "hidden-historical-order",
    warehouseId: warehouse.id,
    fulfillmentId: fixtures.uuid("seed-fulfillment"),
    shipmentId: fixtures.uuid("seed-shipment"),
    lines: [{ id: fixtures.uuid("seed-line"), skuId: sku.id, quantity: 2 }],
    createdAt: fixtures.at({ days: -2 }),
    shippedAt: fixtures.at({ days: -2, minutes: 5 }),
  };
  return {
    fixtures,
    ids: { warehouseId: warehouse.id, skuId: sku.id, orderId: order.id },
    seed: {
      schemaVersion: 1,
      warehouses: [warehouse],
      skus: [sku],
      stockPositions: [stockPosition(warehouse.id, sku.id, 50)],
      orders: [order],
    },
  };
}

export function makeHotStockFixture(options, { onHand = 40 } = {}) {
  const fixtures = createFixtureFactory(options);
  const warehouse = { id: fixtures.uuid("hot-warehouse"), code: fixtures.code("hot-warehouse"), name: "Hot Warehouse", priority: 1 };
  const skus = [0, 1].map((index) => ({ id: fixtures.uuid(`hot-sku-${index}`), code: fixtures.code(`hot-sku-${index}`, 64), name: `Hot SKU ${index}` }));
  return {
    fixtures,
    warehouse,
    skus,
    seed: {
      ...makeEmptySeed(fixtures),
      warehouses: [warehouse],
      skus,
      stockPositions: skus.map(({ id }) => stockPosition(warehouse.id, id, onHand)),
    },
  };
}

export function makeBacklogFixture(options, count = 200) {
  const fixture = makeHotStockFixture(options, { onHand: count * 4 });
  return {
    ...fixture,
    requests: Array.from({ length: count }, (_, index) => ({
      key: fixture.fixtures.key(`backlog-${index}`),
      body: {
        customerReference: `hidden-backlog-${String(index).padStart(4, "0")}`,
        lines: fixture.skus.map(({ id }) => ({ skuId: id, quantity: 1 })),
      },
    })),
  };
}

export function performanceContract() {
  return Object.freeze({
    dataset: { warehouses: 100, skus: 20_000, stockPositions: 1_000_000, historicalOrders: 200_000, historicalOrderLines: 1_000_000 },
    query: { clients: 64, warmupSeconds: 15, measureSeconds: 90, runs: 3, p95Ms: 250, throughput: 250 },
    mutation: { clients: 200, warehouses: 8, hotSkus: 32, p95Ms: 750, throughput: 120, successfulMutationsPerSecond: 60 },
    backlog: { orders: 5_000, deliveries: 5_000, firstWindowSeconds: 60, firstWindowPercent: 95, finalWindowSeconds: 120 },
  });
}
