import { makeAllocationFixture, makeHotStockFixture, makeSplitFixture } from "../fixtures/index.mjs";
import { allocationPlan, assertOrderTerminal, canonicalJson, fulfillmentGroups } from "../oracles/index.mjs";
import {
  allInventory,
  allOrders,
  assertSingleCompatibility,
  assertSplitCompatibility,
  captureReplay,
  createOrder,
  createSku,
  createWarehouse,
  defineCase,
  expectError,
  expectStatus,
  finalEvidence,
  installCatalogFixture,
  inventory,
  orderDetail,
  setInventory,
  startPreparedApi,
  waitForOrderStatus,
} from "./helpers.mjs";

const inventoryCap = ["CORE_INVENTORY_ATOMICITY"];
const splitCap = ["SPLIT_ATOMICITY"];

async function outcome(operation) {
  try { return { response: await operation() }; } catch (error) { return { error }; }
}

const b01 = defineCase({
  id: "B-01",
  fixtureFamily: "F-SINGLE-FIRST",
  action: "Run the published A/B/C worked example with shuffled Warehouse creation and reversed Order lines against FINAL.",
  oracle: "The independent allocation model selects the later complete Warehouse and never splits across the earlier complementary Warehouses, regardless of input array order.",
  async run(ctx) {
    const fixture = makeAllocationFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    const oracle = allocationPlan(fixture.warehouses, fixture.lines, fixture.stock, { allowSplit: true });
    ctx.equal(oracle.kind, "single", "independent worked-example oracle kind");
    const api = await startPreparedApi(ctx);
    const installed = await installCatalogFixture(ctx, api.baseUrl, fixture);
    const expected = installed.warehouseMap.get(fixture.completeWarehouseId);
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "b01-worked-example", lines: [...installed.lines].reverse() });
    assertSingleCompatibility(ctx, created.order, expected.id);
    ctx.equal(created.order.fulfillment?.warehouseId, expected.id, "single Warehouse wins before split", { failureCodeSuffix: "SINGLE_FIRST", hardCapIds: splitCap });
    for (const warehouse of installed.warehouses.filter(({ id }) => id !== expected.id)) {
      for (const sku of installed.skus) ctx.equal((await inventory(ctx, api.baseUrl, warehouse.id, sku.id)).reserved, 0, `nonselected ${warehouse.id}/${sku.id} unchanged`);
    }
    return finalEvidence(ctx, { selectedWarehouseId: expected.id });
  },
});

const b02 = defineCase({
  id: "B-02",
  fixtureFamily: "F-HOT-STOCK",
  action: "Release a two-line Order create and an onHand reduction concurrently against one hot Stock Position set.",
  oracle: "Whichever mutation serializes first, the Order is complete or absent, reserved equals unsettled Allocation demand, available is exact, and no invalid partial state exists.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const skuA = await createSku(ctx, api.baseUrl);
    const skuB = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, skuA.id, 5);
    await setInventory(ctx, api.baseUrl, warehouse.id, skuB.id, 5);
    const body = { customerReference: "b02-atomic-race", lines: [{ skuId: skuA.id, quantity: 5 }, { skuId: skuB.id, quantity: 5 }] };
    const [createResult, updateResult] = await Promise.all([
      ctx.orderRequest(api.baseUrl, ctx.key("order"), body),
      ctx.adminRequest(api.baseUrl, `/api/admin/inventory/${warehouse.id}/${skuB.id}`, ctx.key("lower-stock"), { onHand: 4 }, "PUT"),
    ]);
    ctx.ok([201, 409].includes(createResult.status), "Order race has documented result", { failureCodeSuffix: "RACE_STATUS", hardCapIds: inventoryCap });
    ctx.ok([200, 409].includes(updateResult.status), "inventory race has documented result", { failureCodeSuffix: "RACE_STATUS", hardCapIds: inventoryCap });
    const orders = await allOrders(ctx, api.baseUrl);
    ctx.equal(orders.length, createResult.status === 201 ? 1 : 0, "Order commits all or none", { failureCodeSuffix: "ORDER_ATOMICITY", hardCapIds: inventoryCap });
    const positionA = await inventory(ctx, api.baseUrl, warehouse.id, skuA.id);
    const positionB = await inventory(ctx, api.baseUrl, warehouse.id, skuB.id);
    ctx.equal(positionA.reserved, createResult.status === 201 ? 5 : 0, "SKU A reservation conservation", { failureCodeSuffix: "CONSERVATION", hardCapIds: inventoryCap });
    ctx.equal(positionB.reserved, createResult.status === 201 ? 5 : 0, "SKU B reservation conservation", { failureCodeSuffix: "CONSERVATION", hardCapIds: inventoryCap });
    ctx.equal(positionB.available, positionB.onHand - positionB.reserved, "SKU B available conservation");
    return finalEvidence(ctx, { createStatus: createResult.status, updateStatus: updateResult.status });
  },
});

const b03 = defineCase({
  id: "B-03",
  fixtureFamily: "F-SPLIT",
  action: "Create equivalent FINAL split Orders from reversed line arrays across priority and UUID ties, then reconstruct reservations through public inventory.",
  oracle: "Independent skuId-then-Warehouse greedy plans are identical, each participating Warehouse appears once, every line is fully reserved, and repeated fixture order cannot change grouping.",
  async run(ctx) {
    const fixture = makeSplitFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    const forward = allocationPlan(fixture.warehouses, fixture.lines, fixture.stock, { allowSplit: true });
    const reverse = allocationPlan(fixture.warehouses, [...fixture.lines].reverse(), fixture.stock, { allowSplit: true });
    ctx.equal(forward, reverse, "independent split plan ignores line input order");
    const api = await startPreparedApi(ctx);
    const installed = await installCatalogFixture(ctx, api.baseUrl, fixture);
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "b03-stable-split", lines: [...installed.lines].reverse() });
    const expectedWarehouseIds = forward.fulfillments.map(({ warehouseId }) => installed.warehouseMap.get(warehouseId).id);
    assertSplitCompatibility(ctx, created.order, expectedWarehouseIds);
    for (const group of forward.fulfillments) {
      const warehouseId = installed.warehouseMap.get(group.warehouseId).id;
      for (const allocation of group.allocations) {
        const skuId = installed.skuMap.get(allocation.skuId).id;
        ctx.equal((await inventory(ctx, api.baseUrl, warehouseId, skuId)).reserved, allocation.quantity, `greedy reservation ${warehouseId}/${skuId}`, { failureCodeSuffix: "GREEDY", hardCapIds: splitCap });
      }
    }
    return finalEvidence(ctx, { fulfillmentCount: expectedWarehouseIds.length });
  },
});

const b04 = defineCase({
  id: "B-04",
  fixtureFamily: "F-IDEMPOTENCY",
  action: "Drop completed upstream responses for Warehouse, SKU, Stock Position, Order, and cancellation mutations and replay each through another API after restart.",
  oracle: "Every route replays its original status, body, generated identity, and timestamp with one business effect; a domain capacity conflict is likewise durable.",
  async run(ctx) {
    const apiA = await startPreparedApi(ctx);
    const apiB = await ctx.startApi();
    const warehouseBody = { code: "B04-WH", name: "B04 Warehouse", priority: 1 };
    const warehouseKey = ctx.key("warehouse");
    const warehouseReplay = await captureReplay(ctx, {
      label: "Warehouse", baseUrl: apiA.baseUrl,
      send: (baseUrl) => ctx.request(baseUrl, "/api/admin/warehouses", { method: "POST", headers: { authorization: `Bearer ${ctx.adminToken}`, "idempotency-key": warehouseKey }, json: warehouseBody }),
    }, () => ctx.adminRequest(apiB.baseUrl, "/api/admin/warehouses", warehouseKey, warehouseBody));
    const warehouse = warehouseReplay.json.warehouse;
    const skuBody = { code: "B04-SKU", name: "B04 SKU" };
    const skuKey = ctx.key("sku");
    const skuReplay = await captureReplay(ctx, {
      label: "SKU", baseUrl: apiA.baseUrl,
      send: (baseUrl) => ctx.request(baseUrl, "/api/admin/skus", { method: "POST", headers: { authorization: `Bearer ${ctx.adminToken}`, "idempotency-key": skuKey }, json: skuBody }),
    }, () => ctx.adminRequest(apiB.baseUrl, "/api/admin/skus", skuKey, skuBody));
    const sku = skuReplay.json.sku;
    const inventoryKey = ctx.key("inventory");
    await captureReplay(ctx, {
      label: "Inventory", baseUrl: apiA.baseUrl,
      send: (baseUrl) => ctx.request(baseUrl, `/api/admin/inventory/${warehouse.id}/${sku.id}`, { method: "PUT", headers: { authorization: `Bearer ${ctx.adminToken}`, "idempotency-key": inventoryKey }, json: { onHand: 10 } }),
    }, () => ctx.adminRequest(apiB.baseUrl, `/api/admin/inventory/${warehouse.id}/${sku.id}`, inventoryKey, { onHand: 10 }, "PUT"));
    const orderBody = { customerReference: "b04-order", lines: [{ skuId: sku.id, quantity: 2 }] };
    const orderKey = ctx.key("order");
    const orderReplay = await captureReplay(ctx, { label: "Order", baseUrl: apiA.baseUrl, send: (baseUrl) => ctx.orderRequest(baseUrl, orderKey, orderBody) }, () => ctx.orderRequest(apiB.baseUrl, orderKey, orderBody));
    const cancelKey = ctx.key("cancel");
    await captureReplay(ctx, { label: "Cancel", baseUrl: apiA.baseUrl, send: (baseUrl) => ctx.cancelRequest(baseUrl, orderReplay.json.order.id, cancelKey) }, () => ctx.cancelRequest(apiB.baseUrl, orderReplay.json.order.id, cancelKey));
    await ctx.stop(apiA, "SIGKILL");
    const apiC = await ctx.startApi();
    const restartReplay = await ctx.orderRequest(apiC.baseUrl, orderKey, orderBody);
    ctx.equal(restartReplay.json.order.id, orderReplay.json.order.id, "Order replay survives API death", { failureCodeSuffix: "RESTART_REPLAY", hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    ctx.equal((await allOrders(ctx, apiC.baseUrl)).length, 1, "five unknown outcomes create one Order effect", { failureCodeSuffix: "DUPLICATE_EFFECT", hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    return finalEvidence(ctx, { unknownOutcomeRoutes: 5 });
  },
});

const b05 = defineCase({
  id: "B-05",
  fixtureFamily: "F-IDEMPOTENCY",
  action: "Reuse keys across object property order, whitespace, Order-line reorder, semantic mismatch, concrete resources, and operation scopes.",
  oracle: "Equivalent validated meaning replays; same-scope changed input returns IDEMPOTENCY_CONFLICT; the same key text in another operation or resource remains independent.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const skuA = await createSku(ctx, api.baseUrl);
    const skuB = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, skuA.id, 20, "same-scope-key");
    await setInventory(ctx, api.baseUrl, warehouse.id, skuB.id, 20, "same-scope-key");
    const key = "semantic-order-key";
    const firstBody = { customerReference: "b05-order", lines: [{ skuId: skuB.id, quantity: 2 }, { skuId: skuA.id, quantity: 1 }] };
    const first = await ctx.orderRequest(api.baseUrl, key, firstBody);
    expectStatus(ctx, first, 201, "first semantic Order");
    const reordered = await ctx.request(api.baseUrl, "/api/orders", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, raw: JSON.stringify({ lines: [{ quantity: 1, skuId: skuA.id }, { quantity: 2, skuId: skuB.id }], customerReference: "b05-order" }, null, 4) });
    ctx.equal(canonicalJson(reordered.json), canonicalJson(first.json), "property, whitespace, and line reorder replay", { failureCodeSuffix: "CANONICAL_REPLAY", hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    expectError(ctx, await ctx.orderRequest(api.baseUrl, key, { ...firstBody, customerReference: "changed" }), 409, "IDEMPOTENCY_CONFLICT", "same-scope semantic mismatch");
    const cancel = await ctx.cancelRequest(api.baseUrl, first.json.order.id, key);
    expectStatus(ctx, cancel, 200, "same key across operation scope");
    return finalEvidence(ctx, { semanticReplay: true, crossScope: true });
  },
});

const b06 = defineCase({
  id: "B-06",
  fixtureFamily: "F-IDEMPOTENCY",
  action: "Release one hundred identical same-key multi-line Order creates across two API processes, kill one API, replay through a third, and restart-read state.",
  oracle: "All completed logical responses are the same 201 body and exactly one Order, Fulfillment set, reservation set, and allocated Event effect exists durably.",
  async run(ctx) {
    const apiA = await startPreparedApi(ctx);
    const apiB = await ctx.startApi();
    const fixture = makeHotStockFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime }, { onHand: 100 });
    const warehouse = await createWarehouse(ctx, apiA.baseUrl, { code: fixture.warehouse.code });
    const skus = [];
    for (const source of fixture.skus) { const sku = await createSku(ctx, apiA.baseUrl, { code: source.code }); skus.push(sku); await setInventory(ctx, apiA.baseUrl, warehouse.id, sku.id, 100); }
    const key = ctx.key("same-key-storm");
    const body = { customerReference: "b06-one-logical-order", lines: skus.map(({ id }) => ({ skuId: id, quantity: 2 })) };
    const responses = await ctx.concurrent(Array.from({ length: 100 }), 100, (_, index) => ctx.orderRequest(index % 2 ? apiA.baseUrl : apiB.baseUrl, key, body));
    ctx.ok(responses.every(({ status }) => status === 201), "same-key storm returns only 201", { failureCodeSuffix: "STORM_STATUS", hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    const canonical = canonicalJson(responses[0].json);
    ctx.ok(responses.every(({ json }) => canonicalJson(json) === canonical), "same-key storm returns one body", { failureCodeSuffix: "STORM_RESULT", hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    await ctx.kill(apiA);
    const apiC = await ctx.startApi();
    ctx.equal(canonicalJson((await ctx.orderRequest(apiC.baseUrl, key, body)).json), canonical, "third API restart replay");
    ctx.equal((await allOrders(ctx, apiC.baseUrl)).length, 1, "same-key storm creates one durable Order", { failureCodeSuffix: "DUPLICATE_ORDER", hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    for (const sku of skus) ctx.equal((await inventory(ctx, apiC.baseUrl, warehouse.id, sku.id)).reserved, 2, `SKU ${sku.id} reserved once`);
    return finalEvidence(ctx, { requests: 100, orders: 1 });
  },
});

const b07 = defineCase({
  id: "B-07",
  fixtureFamily: "F-HOT-STOCK",
  action: "For each of three deterministic release seeds, send sixty-four distinct-key two-SKU Orders through two APIs against forty units per SKU.",
  oracle: "Each seed has exactly twenty successes and forty-four published capacity conflicts, zero 5xx or deadlock, and final reserved forty with no oversell.",
  async run(ctx) {
    const apiA = await startPreparedApi(ctx);
    const apiB = await ctx.startApi();
    for (let seed = 0; seed < 3; seed += 1) {
      const warehouse = await createWarehouse(ctx, apiA.baseUrl, { code: `B07-WH-${seed}` });
      const skuA = await createSku(ctx, apiA.baseUrl, { code: `B07-A-${seed}` });
      const skuB = await createSku(ctx, apiA.baseUrl, { code: `B07-B-${seed}` });
      await setInventory(ctx, apiA.baseUrl, warehouse.id, skuA.id, 40);
      await setInventory(ctx, apiA.baseUrl, warehouse.id, skuB.id, 40);
      const requests = Array.from({ length: 64 }, (_, index) => ({
        key: ctx.key(`hot-${seed}-${index}`),
        body: { customerReference: `b07-hot-${seed}-${index}`, lines: (index + seed) % 2 ? [{ skuId: skuB.id, quantity: 2 }, { skuId: skuA.id, quantity: 2 }] : [{ skuId: skuA.id, quantity: 2 }, { skuId: skuB.id, quantity: 2 }] },
      }));
      const responses = await ctx.concurrent(requests, 64, (request, index) => ctx.orderRequest((index + seed) % 2 ? apiA.baseUrl : apiB.baseUrl, request.key, request.body));
      const successes = responses.filter(({ status }) => status === 201);
      const conflicts = responses.filter(({ status }) => status === 409);
      ctx.equal(successes.length, 20, `release seed ${seed} exact success count`, { failureCodeSuffix: "SUCCESS_COUNT", hardCapIds: inventoryCap });
      ctx.equal(conflicts.length, 44, `release seed ${seed} exact conflict count`, { failureCodeSuffix: "CONFLICT_COUNT", hardCapIds: inventoryCap });
      ctx.ok(conflicts.every(({ json }) => json?.error?.code === "NO_SINGLE_WAREHOUSE_CAPACITY"), `release seed ${seed} failures use capacity code`);
      ctx.equal((await inventory(ctx, apiB.baseUrl, warehouse.id, skuA.id)).reserved, 40, `release seed ${seed} SKU A not oversold`, { failureCodeSuffix: "OVERSELL", hardCapIds: inventoryCap });
      ctx.equal((await inventory(ctx, apiB.baseUrl, warehouse.id, skuB.id)).reserved, 40, `release seed ${seed} SKU B not oversold`, { failureCodeSuffix: "OVERSELL", hardCapIds: inventoryCap });
    }
    return finalEvidence(ctx, { requests: 192, successes: 60, conflicts: 132, releaseSeeds: 3 });
  },
});

const b08 = defineCase({
  id: "B-08",
  fixtureFamily: "F-CONTENTION",
  action: "Create twenty isolated ALLOCATED Orders, start two Workers, and concurrently release one cancellation request for every Order through two APIs.",
  oracle: "Every Order converges only to CANCELLED without Shipment/onHand deduction or SHIPPED with one Shipment/one deduction; no mixed or permanently pending state exists.",
  async run(ctx) {
    const apiA = await startPreparedApi(ctx);
    const apiB = await ctx.startApi();
    const warehouse = await createWarehouse(ctx, apiA.baseUrl);
    const sku = await createSku(ctx, apiA.baseUrl);
    await setInventory(ctx, apiA.baseUrl, warehouse.id, sku.id, 100);
    const orders = [];
    for (let index = 0; index < 20; index += 1) orders.push((await createOrder(ctx, apiA.baseUrl, { customerReference: `b08-${index}`, lines: [{ skuId: sku.id, quantity: 2 }] })).order);
    await ctx.startWorker();
    await ctx.startWorker();
    const cancels = await ctx.concurrent(orders, 20, (order, index) => ctx.cancelRequest(index % 2 ? apiA.baseUrl : apiB.baseUrl, order.id, ctx.key(`cancel-${index}`)));
    ctx.ok(cancels.every((response) => response.status === 200 || (response.status === 409 && response.json?.error?.code === "ORDER_NOT_CANCELLABLE")), "race cancellations have documented results");
    const terminals = [];
    for (const order of orders) terminals.push(await waitForOrderStatus(ctx, apiB.baseUrl, order.id, ["CANCELLED", "SHIPPED"]));
    for (const order of terminals) {
      try { assertOrderTerminal(order); } catch (error) { ctx.fail(error.message, "MIXED_TERMINAL", inventoryCap); }
    }
    const shipped = terminals.filter(({ status }) => status === "SHIPPED").length;
    const position = await inventory(ctx, apiB.baseUrl, warehouse.id, sku.id);
    ctx.equal(position.reserved, 0, "all terminal Orders have zero reservation");
    ctx.equal(position.onHand, 100 - shipped * 2, "onHand deducted only for Shipment winners", { failureCodeSuffix: "RACE_SETTLEMENT", hardCapIds: inventoryCap });
    return finalEvidence(ctx, { orders: 20, shipped, cancelled: 20 - shipped });
  },
});

const b09 = defineCase({
  id: "B-09",
  fixtureFamily: "F-SPLIT-CONTENTION",
  action: "Send competing distinct-key reversed-line split Orders through two APIs against four hot Warehouse/SKU positions, then restart one API and replay successes and failures.",
  oracle: "Each success has every required Fulfillment and reservation, each failure has none, all Stock Positions conserve capacity, and no request deadlocks or returns 5xx.",
  async run(ctx) {
    const apiA = await startPreparedApi(ctx);
    const apiB = await ctx.startApi();
    const warehouseA = await createWarehouse(ctx, apiA.baseUrl, { priority: 1 });
    const warehouseB = await createWarehouse(ctx, apiA.baseUrl, { priority: 2 });
    const skuA = await createSku(ctx, apiA.baseUrl);
    const skuB = await createSku(ctx, apiA.baseUrl);
    await setInventory(ctx, apiA.baseUrl, warehouseA.id, skuA.id, 20);
    await setInventory(ctx, apiA.baseUrl, warehouseA.id, skuB.id, 0);
    await setInventory(ctx, apiA.baseUrl, warehouseB.id, skuA.id, 0);
    await setInventory(ctx, apiA.baseUrl, warehouseB.id, skuB.id, 20);
    const requests = Array.from({ length: 24 }, (_, index) => ({ key: ctx.key(`split-${index}`), body: { customerReference: `b09-${index}`, lines: index % 2 ? [{ skuId: skuB.id, quantity: 2 }, { skuId: skuA.id, quantity: 2 }] : [{ skuId: skuA.id, quantity: 2 }, { skuId: skuB.id, quantity: 2 }] } }));
    const responses = await ctx.concurrent(requests, 24, (request, index) => ctx.orderRequest(index % 2 ? apiA.baseUrl : apiB.baseUrl, request.key, request.body));
    const successes = responses.filter(({ status }) => status === 201);
    const conflicts = responses.filter(({ status }) => status === 409);
    ctx.equal(successes.length, 10, "split contention exact success count", { failureCodeSuffix: "SPLIT_COUNT", hardCapIds: splitCap });
    ctx.equal(conflicts.length, 14, "split contention exact rejection count", { failureCodeSuffix: "SPLIT_COUNT", hardCapIds: splitCap });
    for (const response of successes) assertSplitCompatibility(ctx, response.json.order, [warehouseA.id, warehouseB.id]);
    await ctx.kill(apiA);
    const apiC = await ctx.startApi();
    const replayIndex = responses.findIndex(({ status }) => status === 201);
    ctx.equal((await ctx.orderRequest(apiC.baseUrl, requests[replayIndex].key, requests[replayIndex].body)).json.order.id, responses[replayIndex].json.order.id, "split replay survives API kill");
    await allInventory(ctx, apiC.baseUrl);
    return finalEvidence(ctx, { requests: 24, successes: 10, conflicts: 14 });
  },
});

const b10 = defineCase({
  id: "B-10",
  fixtureFamily: "F-SPLIT-CONTENTION",
  action: "Create twenty two-Fulfillment Orders, run two Workers, and concurrently cancel through a second API while groups are independently eligible.",
  oracle: "Cancellation wins only before every group ships and then all groups are CANCELLED; otherwise cancellation is 409 and every group converges SHIPPED with unique Shipment and exact settlement.",
  async run(ctx) {
    const apiA = await startPreparedApi(ctx);
    const apiB = await ctx.startApi();
    const warehouseA = await createWarehouse(ctx, apiA.baseUrl, { priority: 1 });
    const warehouseB = await createWarehouse(ctx, apiA.baseUrl, { priority: 2 });
    const skuA = await createSku(ctx, apiA.baseUrl);
    const skuB = await createSku(ctx, apiA.baseUrl);
    await setInventory(ctx, apiA.baseUrl, warehouseA.id, skuA.id, 100);
    await setInventory(ctx, apiA.baseUrl, warehouseA.id, skuB.id, 0);
    await setInventory(ctx, apiA.baseUrl, warehouseB.id, skuA.id, 0);
    await setInventory(ctx, apiA.baseUrl, warehouseB.id, skuB.id, 100);
    const orders = [];
    for (let index = 0; index < 20; index += 1) orders.push((await createOrder(ctx, apiA.baseUrl, { customerReference: `b10-${index}`, lines: [{ skuId: skuA.id, quantity: 2 }, { skuId: skuB.id, quantity: 2 }] })).order);
    await ctx.startWorker();
    await ctx.startWorker();
    const cancels = await ctx.concurrent(orders, 20, (order, index) => ctx.cancelRequest(index % 2 ? apiA.baseUrl : apiB.baseUrl, order.id, ctx.key(`cancel-${index}`)));
    ctx.ok(cancels.every((response) => response.status === 200 || (response.status === 409 && response.json?.error?.code === "ORDER_NOT_CANCELLABLE")), "split terminal races return only documented outcomes");
    const terminals = [];
    for (const order of orders) terminals.push(await waitForOrderStatus(ctx, apiB.baseUrl, order.id, ["CANCELLED", "SHIPPED"], { timeoutMs: 90_000 }));
    for (const order of terminals) {
      const groups = fulfillmentGroups(order);
      ctx.equal(groups.length, 2, `split Order ${order.id} retains two groups`);
      if (order.status === "CANCELLED") ctx.ok(groups.every(({ status, shipment }) => status === "CANCELLED" && shipment === null), `split Order ${order.id} cancels all groups`, { failureCodeSuffix: "MIXED_GROUPS", hardCapIds: splitCap });
      else ctx.ok(groups.every(({ status, shipment }) => status === "SHIPPED" && shipment?.id), `split Order ${order.id} ships all groups`, { failureCodeSuffix: "MIXED_GROUPS", hardCapIds: splitCap });
    }
    await allInventory(ctx, apiB.baseUrl);
    return finalEvidence(ctx, { orders: 20, shipped: terminals.filter(({ status }) => status === "SHIPPED").length });
  },
});

export const B_CASES = [b01, b02, b03, b04, b05, b06, b07, b08, b09, b10];
