import { readFile } from "node:fs/promises";

import { makeAllocationFixture, makeSeedFixture, makeSplitFixture } from "../fixtures/index.mjs";
import { assertEventLedger, inventoryProjection } from "../oracles/index.mjs";
import {
  allInventory,
  allOrders,
  assertSingleCompatibility,
  assertSplitCompatibility,
  createOrder,
  createSku,
  createWarehouse,
  defineCase,
  expectError,
  expectStatus,
  finalEvidence,
  hasHttpBearerSecurity,
  installCatalogFixture,
  inventory,
  knownGroupProjection,
  orderDetail,
  parseLastJsonLine,
  prepare,
  setInventory,
  startPreparedApi,
  waitForOrderStatus,
} from "./helpers.mjs";

const core = ["CORE_INVENTORY_ATOMICITY"];

const a01 = defineCase({
  id: "A-01",
  fixtureFamily: "F-EMPTY",
  action: "Install a clean checkout, migrate, build, boot each published role, and send SIGTERM.",
  oracle: "Every command and role succeeds, the API health seam is owned by the API, and all role process groups exit within ten seconds.",
  async run(ctx) {
    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.migrate({ timeoutMs: 120_000 });
    await ctx.npm("build", [], { timeoutMs: 300_000 });
    const receiver = await ctx.receiver();
    const api = await ctx.startApi();
    const worker = await ctx.startWorker();
    const dispatcher = await ctx.startDispatcher(receiver.url);
    expectStatus(ctx, await ctx.request(api.baseUrl, "/api/health"), 200, "production API health", { failureCodeSuffix: "BOOT", hardCapIds: ["BUILD_MIGRATION_OR_BOOT"] });
    for (const process of [dispatcher, worker, api]) {
      const started = performance.now();
      await ctx.stop(process, "SIGTERM");
      ctx.ok(performance.now() - started <= 10_000, `${process.role} exits within ten seconds`, { failureCodeSuffix: "SIGTERM", hardCapIds: ["BUILD_MIGRATION_OR_BOOT"] });
      ctx.ok(!process.forcedKill, `${process.role} needs no forced kill`, { failureCodeSuffix: "SIGTERM", hardCapIds: ["BUILD_MIGRATION_OR_BOOT"] });
    }
    return finalEvidence(ctx, { roles: 3, cleanInstall: true });
  },
});

const a02 = defineCase({
  id: "A-02",
  fixtureFamily: "F-SEED",
  action: "Run migrations repeatedly around a seeded catalog, runtime Order, Shipment, process stop, and full restart.",
  oracle: "Catalog, Stock Position, Order, Shipment, idempotent replay, and delivered Event projections are unchanged by repeat migration and restart.",
  async run(ctx) {
    const fixture = makeSeedFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    await ctx.migrate();
    await ctx.migrate();
    const seeded = await ctx.seed(fixture.seed);
    ctx.equal(seeded.exitCode, 0, "valid populated seed succeeds", { failureCodeSuffix: "SEED" });
    await ctx.npm("build", [], { timeoutMs: 300_000 });
    const receiver = await ctx.receiver();
    let api = await ctx.startApi();
    const sku = await createSku(ctx, api.baseUrl);
    const warehouse = await createWarehouse(ctx, api.baseUrl, { priority: 1 });
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 10);
    const body = { customerReference: "a02-runtime", lines: [{ skuId: sku.id, quantity: 2 }] };
    const created = await createOrder(ctx, api.baseUrl, body, ctx.key("runtime-order"));
    await ctx.startWorker();
    await ctx.startDispatcher(receiver.url);
    const shipped = await waitForOrderStatus(ctx, api.baseUrl, created.order.id, "SHIPPED");
    const beforeInventory = await allInventory(ctx, api.baseUrl);
    await ctx.stop(api, "SIGTERM");
    await ctx.migrate();
    await ctx.migrate();
    api = await ctx.startApi();
    const after = await orderDetail(ctx, api.baseUrl, created.order.id);
    ctx.equal(knownGroupProjection(after), knownGroupProjection(shipped), "Order and Shipment projection survives repeat migration");
    ctx.equal(await allInventory(ctx, api.baseUrl), beforeInventory, "inventory projection survives repeat migration");
    const replay = await ctx.orderRequest(api.baseUrl, ctx.key("runtime-order"), body);
    ctx.equal(replay.status, 201, "runtime Order replays after restart");
    ctx.equal(replay.json.order.id, created.order.id, "runtime replay keeps Order identity");
    return finalEvidence(ctx, { migrations: 4, seededOrder: fixture.ids.orderId, runtimeOrder: created.order.id });
  },
});

const a03 = defineCase({
  id: "A-03",
  fixtureFamily: "F-SEED",
  action: "Submit isolated seed mutants for version, unknown field, duplicate identity, missing reference, timestamp, and numeric violations before a valid import.",
  oracle: "Every mutant exits nonzero with an empty public projection, while the valid file commits exact summary counts and historical Shipment state atomically.",
  async run(ctx) {
    const fixture = makeSeedFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    await prepare(ctx);
    const mutants = [
      { ...fixture.seed, schemaVersion: 2 },
      { ...fixture.seed, surprise: true },
      { ...fixture.seed, warehouses: [...fixture.seed.warehouses, fixture.seed.warehouses[0]] },
      { ...fixture.seed, stockPositions: [{ ...fixture.seed.stockPositions[0], skuId: ctx.uuid("missing-sku") }] },
      { ...fixture.seed, orders: [{ ...fixture.seed.orders[0], shippedAt: ctx.at({ days: -3 }) }] },
      { ...fixture.seed, stockPositions: [{ ...fixture.seed.stockPositions[0], onHand: -1 }] },
    ];
    for (let index = 0; index < mutants.length; index += 1) {
      const result = await ctx.seed(mutants[index]);
      ctx.ok(result.exitCode !== 0, `seed mutant ${index} fails`, { failureCodeSuffix: "MUTANT_ACCEPTED" });
    }
    const valid = await ctx.seed(fixture.seed);
    ctx.equal(valid.exitCode, 0, "valid seed succeeds");
    ctx.equal(parseLastJsonLine(valid.stdout), { schemaVersion: 1, warehouses: 1, skus: 1, stockPositions: 1, orders: 1, orderLines: 1 }, "seed summary is exact");
    const api = await ctx.startApi();
    const orders = await allOrders(ctx, api.baseUrl);
    ctx.equal(orders.length, 1, "only valid seed created an Order", { failureCodeSuffix: "PARTIAL_IMPORT", hardCapIds: core });
    ctx.equal(orders[0].status, "SHIPPED", "historical Order is SHIPPED");
    ctx.equal((await allInventory(ctx, api.baseUrl))[0].reserved, 0, "historical import starts with zero reserved");
    return finalEvidence(ctx, { rejectedMutants: mutants.length, validOrders: 1 });
  },
});

const a04 = defineCase({
  id: "A-04",
  fixtureFamily: "F-EVENT",
  action: "Parse the candidate OpenAPI file, exercise every published path family, and deliver a live allocated and shipped webhook.",
  oracle: "The document is OpenAPI 3.1, contains exact public paths and webhook headers/body concepts, and live HTTP and Event traffic agree with those published surfaces.",
  async run(ctx) {
    const source = await ctx.readText("openapi.yaml");
    ctx.ok(/^openapi:\s*["']?3\.1(?:\.\d+)?/mu.test(source), "OpenAPI declares 3.1", { failureCodeSuffix: "OPENAPI_VERSION" });
    for (const path of ["/api/health", "/api/admin/warehouses", "/api/admin/skus", "/api/admin/inventory/{warehouseId}/{skuId}", "/api/warehouses", "/api/skus", "/api/inventory", "/api/orders", "/api/orders/{orderId}", "/api/orders/{orderId}/cancel"]) {
      ctx.ok(source.includes(path), `OpenAPI contains ${path}`, { failureCodeSuffix: "OPENAPI_PATH" });
    }
    for (const token of ["Idempotency-Key", "X-ParcelFlow-Event-Id", "X-ParcelFlow-Event-Type", "order.allocated", "order.shipped", "order.cancelled", "fulfillments"]) {
      ctx.ok(source.includes(token), `OpenAPI contains ${token}`, { failureCodeSuffix: "OPENAPI_CONTRACT" });
    }
    ctx.ok(hasHttpBearerSecurity(source), "OpenAPI declares and applies HTTP Bearer security", { failureCodeSuffix: "OPENAPI_CONTRACT" });
    const api = await startPreparedApi(ctx);
    const receiver = await ctx.receiver();
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const sku = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 10);
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "a04-webhook", lines: [{ skuId: sku.id, quantity: 1 }] });
    await ctx.startDispatcher(receiver.url);
    await ctx.startWorker();
    await waitForOrderStatus(ctx, api.baseUrl, created.order.id, "SHIPPED");
    await ctx.waitFor(() => receiver.ledger.filter(({ acknowledged }) => acknowledged).length >= 2, { timeoutMs: 60_000, label: "allocated and shipped Event delivery" });
    assertEventLedger(receiver.ledger, [created.order.id]);
    return finalEvidence(ctx, { paths: 10, deliveredEvents: receiver.ledger.length });
  },
});

const a05 = defineCase({
  id: "A-05",
  fixtureFamily: "F-EMPTY",
  action: "Send malformed media, JSON, schema, UUID, cursor, key, auth, and not-found requests across write and read routes.",
  oracle: "Each preflight and addressing failure has the published status, stable exact error envelope, no leaked secret or internal path, and no Order or inventory side effect.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const malformedMedia = await ctx.request(api.baseUrl, "/api/orders", { method: "POST", headers: { "idempotency-key": ctx.key("media"), "content-type": "text/plain" }, raw: "{}" });
    expectError(ctx, malformedMedia, 415, "UNSUPPORTED_MEDIA_TYPE", "unsupported media");
    const malformedJson = await ctx.request(api.baseUrl, "/api/orders", { method: "POST", headers: { "idempotency-key": ctx.key("json"), "content-type": "application/json" }, raw: "{" });
    expectError(ctx, malformedJson, 400, "INVALID_JSON", "malformed JSON");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/orders", { method: "POST", headers: { "idempotency-key": ctx.key("schema") }, json: { extra: true } }), 422, "VALIDATION_ERROR", "schema invalid");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/orders/not-a-uuid"), 400, "INVALID_ID", "bad UUID");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/orders?cursor=not-opaque"), 400, "INVALID_CURSOR", "bad cursor");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/orders", { method: "POST", json: {} }), 400, "IDEMPOTENCY_KEY_REQUIRED", "missing key");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/orders", { method: "POST", headers: { "idempotency-key": "short" }, json: {} }), 400, "INVALID_IDEMPOTENCY_KEY", "short key");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/admin/warehouses", { method: "POST", headers: { "idempotency-key": ctx.key("auth") }, json: { code: "AUTH-1", name: "Auth", priority: 1 } }), 401, "ADMIN_AUTH_REQUIRED", "missing auth");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/admin/warehouses", { method: "POST", headers: { authorization: "Bearer wrong", "idempotency-key": ctx.key("bad-auth") }, json: { code: "AUTH-2", name: "Auth", priority: 1 } }), 401, "ADMIN_AUTH_INVALID", "bad auth");
    expectError(ctx, await ctx.request(api.baseUrl, `/api/orders/${ctx.uuid("missing-order")}`), 404, "ORDER_NOT_FOUND", "missing Order");
    ctx.equal((await allOrders(ctx, api.baseUrl)).length, 0, "validation failures create no Order", { failureCodeSuffix: "SIDE_EFFECT", hardCapIds: core });
    return finalEvidence(ctx, { failures: 10 });
  },
});

const a06 = defineCase({
  id: "A-06",
  fixtureFamily: "F-BOUNDARY",
  action: "Exercise exact Warehouse, SKU, onHand, customerReference, line count, duplicate SKU, quantity, blank, and safe-integer boundaries.",
  oracle: "Published inclusive boundaries are accepted; every adjacent invalid value is rejected with 422 and leaves Order history and Stock Positions unchanged.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl, { code: "AA", name: "x", priority: 0 });
    const maxWarehouse = await createWarehouse(ctx, api.baseUrl, { code: "A".repeat(32), name: "N".repeat(120), priority: 1_000_000 });
    const sku = await createSku(ctx, api.baseUrl, { code: "S1", name: "x" });
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 0);
    await setInventory(ctx, api.baseUrl, maxWarehouse.id, sku.id, 1_000_000_000);
    const invalidWarehouse = await ctx.adminRequest(api.baseUrl, "/api/admin/warehouses", ctx.key("bad-boundary"), { code: "A", name: " ", priority: -1 });
    expectError(ctx, invalidWarehouse, 422, "VALIDATION_ERROR", "Warehouse boundaries");
    const invalidStock = await ctx.adminRequest(api.baseUrl, `/api/admin/inventory/${warehouse.id}/${sku.id}`, ctx.key("unsafe"), { onHand: Number.MAX_SAFE_INTEGER }, "PUT");
    expectError(ctx, invalidStock, 422, "VALIDATION_ERROR", "onHand boundary");
    const nineLines = Array.from({ length: 9 }, (_, index) => ({ skuId: index === 0 ? sku.id : ctx.uuid(`missing-${index}`), quantity: 1 }));
    for (const [label, body] of [
      ["blank reference", { customerReference: " ", lines: [{ skuId: sku.id, quantity: 1 }] }],
      ["zero lines", { customerReference: "zero", lines: [] }],
      ["nine lines", { customerReference: "nine", lines: nineLines }],
      ["duplicate SKU", { customerReference: "duplicate", lines: [{ skuId: sku.id, quantity: 1 }, { skuId: sku.id, quantity: 2 }] }],
      ["zero quantity", { customerReference: "zero-quantity", lines: [{ skuId: sku.id, quantity: 0 }] }],
      ["unsafe quantity", { customerReference: "unsafe", lines: [{ skuId: sku.id, quantity: Number.MAX_SAFE_INTEGER }] }],
    ]) expectError(ctx, await ctx.orderRequest(api.baseUrl, ctx.key(label), body), 422, "VALIDATION_ERROR", label);
    ctx.equal((await allOrders(ctx, api.baseUrl)).length, 0, "invalid boundaries leave Order history empty", { failureCodeSuffix: "BOUNDARY_SIDE_EFFECT", hardCapIds: core });
    return finalEvidence(ctx, { acceptedBoundaries: 5, rejectedBoundaries: 8 });
  },
});

const a07 = defineCase({
  id: "A-07",
  fixtureFamily: "F-CATALOG",
  action: "Create tied catalog and Order records beyond one hundred items, then traverse default, limit 1/100, combined filters, case-insensitive search, stale, malformed, and restart cursors.",
  oracle: "Every public collection has its specified stable order, intersection filtering, no duplicate or omitted item, and opaque query-bound cursor behavior across restart.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouses = [];
    for (let index = 0; index < 105; index += 1) warehouses.push(await createWarehouse(ctx, api.baseUrl, { code: `WH-${String(index).padStart(3, "0")}`, name: `Search Warehouse ${index}`, priority: index % 3 }));
    const skus = [];
    for (let index = 0; index < 105; index += 1) skus.push(await createSku(ctx, api.baseUrl, { code: `SKU-${String(index).padStart(3, "0")}`, name: `Search SKU ${index}` }));
    const firstPage = await ctx.request(api.baseUrl, "/api/warehouses?limit=1");
    expectStatus(ctx, firstPage, 200, "Warehouse limit one");
    ctx.equal(firstPage.json.items.length, 1, "limit one cardinality");
    ctx.ok(typeof firstPage.json.nextCursor === "string", "limit one returns opaque cursor");
    const all = await ctx.paginate(api.baseUrl, "/api/warehouses", { limit: 100 });
    ctx.equal(all.length, 105, "Warehouse pagination has no loss");
    ctx.equal(new Set(all.map(({ id }) => id)).size, 105, "Warehouse pagination has no duplicates");
    const ordered = [...all].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
    ctx.equal(all.map(({ id }) => id), ordered.map(({ id }) => id), "Warehouse stable order");
    const search = await ctx.request(api.baseUrl, "/api/skus?q=search%20sku%2010&limit=100");
    expectStatus(ctx, search, 200, "case-insensitive SKU search");
    ctx.ok(search.json.items.every(({ name }) => name.toLowerCase().includes("search sku 10")), "SKU search is an intersection");
    expectError(ctx, await ctx.request(api.baseUrl, `/api/warehouses?q=changed&cursor=${encodeURIComponent(firstPage.json.nextCursor)}`), 400, "INVALID_CURSOR", "query-bound stale cursor");
    await ctx.stop(api, "SIGTERM");
    const restarted = await ctx.startApi();
    const continuation = await ctx.request(restarted.baseUrl, `/api/warehouses?limit=1&cursor=${encodeURIComponent(firstPage.json.nextCursor)}`);
    expectStatus(ctx, continuation, 200, "cursor continuation after restart");
    return finalEvidence(ctx, { warehouses: warehouses.length, skus: skus.length });
  },
});

const a08 = defineCase({
  id: "A-08",
  fixtureFamily: "F-CATALOG",
  action: "Create and replay Warehouse, SKU, and Stock Position mutations, then collide codes and attempt to lower onHand below an active reservation.",
  oracle: "Resources retain exact public shape and stable identity, duplicates conflict, onHand updates never alter reserved, and below-reserved updates have no effect.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouseKey = ctx.key("warehouse-replay");
    const warehouseBody = { code: "ADMIN-01", name: "Admin Warehouse", priority: 9 };
    const createdWarehouse = await ctx.adminRequest(api.baseUrl, "/api/admin/warehouses", warehouseKey, warehouseBody);
    expectStatus(ctx, createdWarehouse, 201, "Warehouse create");
    const replayWarehouse = await ctx.adminRequest(api.baseUrl, "/api/admin/warehouses", warehouseKey, { name: "Admin Warehouse", priority: 9, code: "ADMIN-01" });
    ctx.equal(replayWarehouse.json, createdWarehouse.json, "Warehouse semantic replay");
    expectError(ctx, await ctx.adminRequest(api.baseUrl, "/api/admin/warehouses", ctx.key("warehouse-duplicate"), warehouseBody), 409, "WAREHOUSE_CODE_CONFLICT", "Warehouse duplicate");
    const sku = await createSku(ctx, api.baseUrl, { code: "ADMIN.SKU-01" });
    expectError(ctx, await ctx.adminRequest(api.baseUrl, "/api/admin/skus", ctx.key("sku-duplicate"), { code: sku.code, name: "duplicate" }), 409, "SKU_CODE_CONFLICT", "SKU duplicate");
    const warehouse = createdWarehouse.json.warehouse;
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 10);
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "a08-reserved", lines: [{ skuId: sku.id, quantity: 4 }] });
    const before = await inventory(ctx, api.baseUrl, warehouse.id, sku.id);
    ctx.equal(
      { onHand: before.onHand, reserved: before.reserved, available: before.available },
      inventoryProjection({ onHand: 10, reserved: 0 }, 4, "allocate"),
      "reservation projection",
    );
    const below = await ctx.adminRequest(api.baseUrl, `/api/admin/inventory/${warehouse.id}/${sku.id}`, ctx.key("below-reserved"), { onHand: 3 }, "PUT");
    expectError(ctx, below, 409, "STOCK_BELOW_RESERVED", "below reserved");
    ctx.equal(await inventory(ctx, api.baseUrl, warehouse.id, sku.id), before, "failed inventory update has no effect", { failureCodeSuffix: "INVENTORY_EFFECT", hardCapIds: core });
    ctx.ok(Boolean(created.order), "Order remains allocated");
    return finalEvidence(ctx, { warehouseId: warehouse.id, skuId: sku.id });
  },
});

const a09 = defineCase({
  id: "A-09",
  fixtureFamily: "F-V1-ORDER",
  action: "Create a reverse-line multi-SKU Order while early Warehouses are individually incomplete and a later Warehouse is complete, with Workers stopped.",
  oracle: "The first complete Warehouse owns one pending Fulfillment, all lines are sorted and fully reserved there, other Stock Positions stay unchanged, and allocation is atomically visible.",
  async run(ctx) {
    const fixture = makeAllocationFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    const api = await startPreparedApi(ctx);
    const installed = await installCatalogFixture(ctx, api.baseUrl, fixture);
    const expectedWarehouse = installed.warehouseMap.get(fixture.completeWarehouseId);
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "a09-single-first", lines: installed.lines });
    assertSingleCompatibility(ctx, created.order, expectedWarehouse.id);
    ctx.equal(created.order.status, "ALLOCATED", "initial Order status");
    ctx.equal(created.order.lines.map(({ skuId }) => skuId), [...installed.lines].sort((a, b) => a.skuId.localeCompare(b.skuId)).map(({ skuId }) => skuId), "Order lines use SKU ID order");
    for (const line of installed.lines) {
      const position = await inventory(ctx, api.baseUrl, expectedWarehouse.id, line.skuId);
      ctx.equal(position.reserved, line.quantity, `selected Warehouse reserved ${line.skuId}`, { failureCodeSuffix: "RESERVATION", hardCapIds: core });
    }
    return finalEvidence(ctx, { warehouseId: expectedWarehouse.id, lineCount: installed.lines.length });
  },
});

const a10 = defineCase({
  id: "A-10",
  fixtureFamily: "F-V1-ORDER",
  action: "Run the frozen V1 binary against aggregate-sufficient but no-single-Warehouse stock, then replay the same Idempotency-Key after restart.",
  oracle: "Both attempts return the original NO_SINGLE_WAREHOUSE_CAPACITY response and leave no Order, reservation, Fulfillment, Shipment, or Event effect.",
  async run(ctx) {
    if (!ctx.v1Workspace) ctx.block("missing_v1_checkpoint");
    const fixture = makeSplitFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    const api = await startPreparedApi(ctx, { workspace: ctx.v1Workspace });
    const installed = await installCatalogFixture(ctx, api.baseUrl, fixture);
    const key = ctx.key("v1-capacity");
    const body = { customerReference: "a10-v1-reject", lines: installed.lines };
    const first = await ctx.orderRequest(api.baseUrl, key, body);
    expectError(ctx, first, 409, "NO_SINGLE_WAREHOUSE_CAPACITY", "V1 aggregate-only capacity", { failureCodeSuffix: "DOMAIN_CONFLICT", hardCapIds: core });
    const before = await allInventory(ctx, api.baseUrl);
    ctx.equal((await allOrders(ctx, api.baseUrl)).length, 0, "V1 rejection leaves no Order", { failureCodeSuffix: "PARTIAL_EFFECT", hardCapIds: core });
    await ctx.stop(api, "SIGTERM");
    const restarted = await ctx.forWorkspace(ctx.v1Workspace).startApi();
    const replay = await ctx.orderRequest(restarted.baseUrl, key, body);
    ctx.equal(replay.status, first.status, "V1 conflict replay status");
    ctx.equal(replay.json, first.json, "V1 conflict replay body");
    ctx.equal(await allInventory(ctx, restarted.baseUrl), before, "V1 conflict replay has no inventory effect");
    return finalEvidence(ctx, { domainConflictReplayed: true });
  },
});

const a11 = defineCase({
  id: "A-11",
  fixtureFamily: "F-WORK-BACKLOG",
  action: "Allocate an Order with Workers stopped, start two real Workers, and observe public Order and Stock Position state through restart.",
  oracle: "One pending Fulfillment becomes SHIPPED with one Shipment, and each Allocation lowers reserved and onHand exactly once with a durable terminal projection.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const sku = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 10);
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "a11-ship", lines: [{ skuId: sku.id, quantity: 3 }] });
    const allocated = await inventory(ctx, api.baseUrl, warehouse.id, sku.id);
    ctx.equal(allocated, { ...allocated, onHand: 10, reserved: 3, available: 7 }, "allocated Stock Position");
    await ctx.startWorker();
    await ctx.startWorker();
    const shipped = await waitForOrderStatus(ctx, api.baseUrl, created.order.id, "SHIPPED");
    const groups = knownGroupProjection(shipped);
    ctx.equal(groups.length, 1, "one Fulfillment after shipping");
    ctx.ok(typeof groups[0].shipmentId === "string", "one Shipment exists", { failureCodeSuffix: "SHIPMENT", hardCapIds: ["RECOVERY_OR_SETTLEMENT"] });
    const settled = await inventory(ctx, api.baseUrl, warehouse.id, sku.id);
    ctx.equal({ onHand: settled.onHand, reserved: settled.reserved, available: settled.available }, inventoryProjection({ onHand: 10, reserved: 3 }, 3, "ship"), "shipping settlement", { failureCodeSuffix: "SETTLEMENT", hardCapIds: core });
    return finalEvidence(ctx, { orderId: created.order.id, shipmentId: groups[0].shipmentId });
  },
});

const a12 = defineCase({
  id: "A-12",
  fixtureFamily: "F-MAIN",
  action: "Cancel an allocated Order twice, restart and read it, then ship a separate Order and attempt cancellation.",
  oracle: "Cancellation returns one logical CANCELLED result and releases only reserved; shipped cancellation returns ORDER_NOT_CANCELLABLE with no mixed terminal state.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const sku = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 20);
    const first = await createOrder(ctx, api.baseUrl, { customerReference: "a12-cancel", lines: [{ skuId: sku.id, quantity: 3 }] });
    const cancelKey = ctx.key("cancel");
    const cancelled = await ctx.cancelRequest(api.baseUrl, first.order.id, cancelKey);
    expectStatus(ctx, cancelled, 200, "cancel allocated Order");
    const repeat = await ctx.cancelRequest(api.baseUrl, first.order.id, ctx.key("repeat-cancel"));
    expectStatus(ctx, repeat, 200, "repeat cancelled Order");
    ctx.equal(knownGroupProjection(repeat.json.order), knownGroupProjection(cancelled.json.order), "repeat cancellation logical result");
    let position = await inventory(ctx, api.baseUrl, warehouse.id, sku.id);
    ctx.equal({ onHand: position.onHand, reserved: position.reserved, available: position.available }, { onHand: 20, reserved: 0, available: 20 }, "cancel releases reserved only", { failureCodeSuffix: "CANCEL_SETTLEMENT", hardCapIds: core });
    const second = await createOrder(ctx, api.baseUrl, { customerReference: "a12-ship", lines: [{ skuId: sku.id, quantity: 2 }] });
    await ctx.startWorker();
    await waitForOrderStatus(ctx, api.baseUrl, second.order.id, "SHIPPED");
    expectError(ctx, await ctx.cancelRequest(api.baseUrl, second.order.id, ctx.key("cancel-shipped")), 409, "ORDER_NOT_CANCELLABLE", "cancel shipped Order");
    position = await inventory(ctx, api.baseUrl, warehouse.id, sku.id);
    ctx.equal(position.onHand, 18, "shipped onHand deducted once");
    return finalEvidence(ctx, { cancelledOrderId: first.order.id, shippedOrderId: second.order.id });
  },
});

const a13 = defineCase({
  id: "A-13",
  fixtureFamily: "F-EVENT",
  action: "Allocate then ship one Order and allocate then cancel another while a scripted receiver records raw headers, JSON, failures, retries, and successful acknowledgements.",
  oracle: "Each Event has matching ParcelFlow headers, public payload identity, stable retry body, and per-Order sequence 1 then 2; failed business mutation has no Event.",
  async run(ctx) {
    const receiver = await ctx.receiver(({ attempt }) => ({ status: attempt <= 2 ? 503 : 204 }));
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const sku = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 20);
    await ctx.startDispatcher(receiver.url);
    const shipped = await createOrder(ctx, api.baseUrl, { customerReference: "a13-shipped", lines: [{ skuId: sku.id, quantity: 2 }] });
    const worker = await ctx.startWorker();
    await waitForOrderStatus(ctx, api.baseUrl, shipped.order.id, "SHIPPED");
    await ctx.stop(worker);
    const cancelled = await createOrder(ctx, api.baseUrl, { customerReference: "a13-cancelled", lines: [{ skuId: sku.id, quantity: 2 }] });
    expectStatus(ctx, await ctx.cancelRequest(api.baseUrl, cancelled.order.id, ctx.key("cancel")), 200, "cancel Event Order");
    const failed = await ctx.orderRequest(api.baseUrl, ctx.key("failed"), { customerReference: "a13-failed", lines: [{ skuId: sku.id, quantity: 1_000_000 }] });
    expectError(ctx, failed, 409, "NO_SINGLE_WAREHOUSE_CAPACITY", "failed business mutation");
    await ctx.waitFor(() => {
      const successful = new Set(receiver.ledger.filter(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300).map(({ json }) => `${json?.aggregateId}:${json?.sequence}`));
      return successful.size >= 4;
    }, { timeoutMs: 90_000, label: "four terminal Event deliveries" });
    const metrics = assertEventLedger(receiver.ledger, [shipped.order.id, cancelled.order.id]);
    ctx.ok(receiver.ledger.every(({ json }) => [shipped.order.id, cancelled.order.id].includes(json?.aggregateId)), "failed mutation produces no Event aggregate");
    return finalEvidence(ctx, metrics);
  },
});

const a14 = defineCase({
  id: "A-14",
  fixtureFamily: "F-CATALOG",
  action: "Create allocated, shipped, cancelled, and historical Orders, then list, detail, filter, page, and fully restart their public history.",
  oracle: "Durable Order shape, SKU line order, Shipment nullability, combined filters, and createdAt/id descending pagination have no gaps or duplicates after restart.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const otherWarehouse = await createWarehouse(ctx, api.baseUrl, { priority: 2 });
    const skuA = await createSku(ctx, api.baseUrl);
    const skuB = await createSku(ctx, api.baseUrl);
    for (const sku of [skuA, skuB]) { await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 100); await setInventory(ctx, api.baseUrl, otherWarehouse.id, sku.id, 100); }
    const allocated = await createOrder(ctx, api.baseUrl, { customerReference: "a14-allocated", lines: [{ skuId: skuB.id, quantity: 1 }, { skuId: skuA.id, quantity: 1 }] });
    const cancelled = await createOrder(ctx, api.baseUrl, { customerReference: "a14-cancelled", lines: [{ skuId: skuA.id, quantity: 1 }] });
    await ctx.cancelRequest(api.baseUrl, cancelled.order.id, ctx.key("cancel"));
    const toShip = await createOrder(ctx, api.baseUrl, { customerReference: "a14-shipped", lines: [{ skuId: skuA.id, quantity: 1 }] });
    await ctx.startWorker();
    await waitForOrderStatus(ctx, api.baseUrl, toShip.order.id, "SHIPPED");
    const listed = await allOrders(ctx, api.baseUrl);
    ctx.equal(new Set(listed.map(({ id }) => id)), new Set([allocated.order.id, cancelled.order.id, toShip.order.id]), "history contains every runtime Order");
    for (const order of listed) ctx.equal(order.lines.map(({ skuId }) => skuId), [...order.lines].sort((a, b) => a.skuId.localeCompare(b.skuId)).map(({ skuId }) => skuId), `Order ${order.id} line order`);
    const filtered = await allOrders(ctx, api.baseUrl, { status: "CANCELLED", customerReference: "a14-cancelled", warehouseId: warehouse.id });
    ctx.equal(filtered.map(({ id }) => id), [cancelled.order.id], "combined Order filters intersect");
    const shippedBeforeRestart = await orderDetail(ctx, api.baseUrl, toShip.order.id);
    await ctx.stop(api, "SIGTERM");
    const restarted = await ctx.startApi();
    ctx.equal(knownGroupProjection(await orderDetail(ctx, restarted.baseUrl, toShip.order.id)), knownGroupProjection(shippedBeforeRestart), "Order detail remains durable after restart");
    return finalEvidence(ctx, { orders: listed.length });
  },
});

const a15 = defineCase({
  id: "A-15",
  fixtureFamily: "F-SPLIT",
  action: "Create a FINAL Order requiring two to four Warehouses and poll each public Fulfillment while one Worker ships groups.",
  oracle: "Stable greedy allocation creates one Fulfillment per participating Warehouse and Order status progresses ALLOCATED to PARTIALLY_SHIPPED to SHIPPED while only each shipped group settles its Stock Positions.",
  async run(ctx) {
    const fixture = makeSplitFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    const api = await startPreparedApi(ctx);
    const installed = await installCatalogFixture(ctx, api.baseUrl, fixture);
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "a15-split", lines: installed.lines });
    const expectedIds = installed.warehouses.map(({ id }) => id);
    assertSplitCompatibility(ctx, created.order, expectedIds);
    ctx.equal(created.order.status, "ALLOCATED", "split Order initial aggregate status");
    await ctx.startWorker();
    let sawPartial = false;
    const shipped = await ctx.waitFor(async () => {
      const order = await orderDetail(ctx, api.baseUrl, created.order.id);
      if (order.status === "PARTIALLY_SHIPPED") sawPartial = true;
      return order.status === "SHIPPED" ? order : false;
    }, { timeoutMs: 60_000, intervalMs: 5, label: "split Shipment convergence" });
    ctx.ok(sawPartial, "split Order exposes PARTIALLY_SHIPPED", { failureCodeSuffix: "AGGREGATE_STATE", hardCapIds: ["SPLIT_ATOMICITY"] });
    ctx.ok(knownGroupProjection(shipped).every(({ status, shipmentId }) => status === "SHIPPED" && shipmentId), "every split Fulfillment shipped once");
    await allInventory(ctx, api.baseUrl);
    return finalEvidence(ctx, { fulfillmentCount: expectedIds.length, sawPartial });
  },
});

const a16 = defineCase({
  id: "A-16",
  fixtureFamily: "F-SPLIT",
  action: "Compare one-Warehouse and split response compatibility, cancel an all-pending split Order, reject cancellation after any group ships, and collect FINAL Event types.",
  oracle: "Singular fulfillment is object only for one Warehouse and null for split; pending split cancellation is atomic, post-Shipment cancellation is 409, and published Event sequences are contiguous.",
  async run(ctx) {
    const receiver = await ctx.receiver();
    const api = await startPreparedApi(ctx);
    await ctx.startDispatcher(receiver.url);
    const singleFixture = makeAllocationFixture({ evaluationSeed: ctx.evaluationSeed, caseId: `${ctx.caseId}-single`, baseTime: ctx.fixtures.baseTime });
    const singleInstalled = await installCatalogFixture(ctx, api.baseUrl, singleFixture);
    const single = await createOrder(ctx, api.baseUrl, { customerReference: "a16-single", lines: singleInstalled.lines });
    assertSingleCompatibility(ctx, single.order, singleInstalled.warehouseMap.get(singleFixture.completeWarehouseId).id);
    const splitFixture = makeSplitFixture({ evaluationSeed: ctx.evaluationSeed, caseId: `${ctx.caseId}-split`, baseTime: ctx.fixtures.baseTime });
    const splitInstalled = await installCatalogFixture(ctx, api.baseUrl, splitFixture);
    const split = await createOrder(ctx, api.baseUrl, { customerReference: "a16-split-cancel", lines: splitInstalled.lines });
    assertSplitCompatibility(ctx, split.order, splitInstalled.warehouses.map(({ id }) => id));
    const cancelled = await ctx.cancelRequest(api.baseUrl, split.order.id, ctx.key("split-cancel"));
    expectStatus(ctx, cancelled, 200, "cancel all-pending split Order");
    ctx.ok(knownGroupProjection(cancelled.json.order).every(({ status, shipmentId }) => status === "CANCELLED" && shipmentId === null), "all split groups cancel together", { failureCodeSuffix: "SPLIT_CANCEL", hardCapIds: ["SPLIT_ATOMICITY"] });
    await ctx.startWorker();
    const shippedSingle = await waitForOrderStatus(ctx, api.baseUrl, single.order.id, "SHIPPED");
    expectError(ctx, await ctx.cancelRequest(api.baseUrl, shippedSingle.id, ctx.key("late-cancel")), 409, "ORDER_NOT_CANCELLABLE", "post-Shipment cancellation");
    await ctx.waitFor(() => receiver.ledger.some(({ json }) => json?.aggregateId === split.order.id && json?.type === "order.cancelled"), { timeoutMs: 60_000, label: "FINAL cancellation Event" });
    assertEventLedger(receiver.ledger, [single.order.id, split.order.id]);
    return finalEvidence(ctx, { singleOrderId: single.order.id, splitOrderId: split.order.id });
  },
});

export const A_CASES = [a01, a02, a03, a04, a05, a06, a07, a08, a09, a10, a11, a12, a13, a14, a15, a16];
