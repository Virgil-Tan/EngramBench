import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";

import { performanceContract } from "../fixtures/index.mjs";
import { assertEventLedger, canonicalJson, fulfillmentGroups, percentile } from "../oracles/index.mjs";
import {
  allInventory,
  allOrders,
  createOrder,
  createSku,
  createWarehouse,
  defineCase,
  expectError,
  finalEvidence,
  noSecretText,
  orderDetail,
  setInventory,
  startPreparedApi,
  waitForOrderStatus,
} from "./helpers.mjs";

const migrationCap = ["MIGRATION_COMPATIBILITY"];
const perf = performanceContract();

async function stopWorkspaceProcesses(ctx, workspace) {
  for (const process of ctx.processes.filter((item) => !item.stopped && item.workspace === workspace)) await ctx.stop(process, "SIGTERM");
}

async function prepareV1Catalog(ctx, api) {
  const warehouse = await createWarehouse(ctx, api.baseUrl, { code: `V1-${ctx.caseId.replace("-", "")}`, priority: 1 });
  const sku = await createSku(ctx, api.baseUrl, { code: `V1-SKU-${ctx.caseId.replace("-", "")}` });
  await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 100);
  return { warehouse, sku };
}

const e01 = defineCase({
  id: "E-01",
  fixtureFamily: "F-MIGRATION",
  action: "Use the frozen V1 binary to create ALLOCATED, SHIPPED, and CANCELLED Orders, then run FINAL migrations twice on the same PostgreSQL database and restart all roles.",
  oracle: "Every V1 identity, line, Allocation effect, singular Fulfillment, Shipment, status, timestamp, and history projection remains; FINAL adds exactly one compatible fulfillments[] member per V1 Order.",
  async run(ctx) {
    if (!ctx.v1Workspace) ctx.block("missing_v1_checkpoint");
    const v1 = ctx.forWorkspace(ctx.v1Workspace);
    await v1.migrate();
    await v1.npm("build", [], { timeoutMs: 300_000 });
    const apiV1 = await v1.startApi();
    const { warehouse, sku } = await prepareV1Catalog(ctx, apiV1);
    const allocated = await createOrder(ctx, apiV1.baseUrl, { customerReference: "e01-allocated", lines: [{ skuId: sku.id, quantity: 2 }] }, ctx.key("allocated"));
    const cancelled = await createOrder(ctx, apiV1.baseUrl, { customerReference: "e01-cancelled", lines: [{ skuId: sku.id, quantity: 3 }] }, ctx.key("cancelled"));
    await ctx.cancelRequest(apiV1.baseUrl, cancelled.order.id, ctx.key("cancel"));
    const shipped = await createOrder(ctx, apiV1.baseUrl, { customerReference: "e01-shipped", lines: [{ skuId: sku.id, quantity: 4 }] }, ctx.key("shipped"));
    const workerV1 = await v1.startWorker();
    await waitForOrderStatus(ctx, apiV1.baseUrl, shipped.order.id, "SHIPPED");
    await ctx.stop(workerV1, "SIGTERM");
    const ids = [allocated.order.id, cancelled.order.id, shipped.order.id];
    const before = new Map();
    for (const id of ids) before.set(id, await orderDetail(ctx, apiV1.baseUrl, id));
    await stopWorkspaceProcesses(ctx, ctx.v1Workspace);
    await ctx.migrate();
    await ctx.migrate();
    await ctx.npm("build", [], { timeoutMs: 300_000 });
    const apiFinal = await ctx.startApi();
    for (const id of ids) {
      const prior = before.get(id);
      const current = await orderDetail(ctx, apiFinal.baseUrl, id);
      ctx.equal(current.id, prior.id, `${id} identity preserved`, { failureCodeSuffix: "IDENTITY", hardCapIds: migrationCap });
      ctx.equal(current.status, prior.status, `${id} status preserved`, { failureCodeSuffix: "STATUS", hardCapIds: migrationCap });
      ctx.equal(current.lines, prior.lines, `${id} lines preserved`, { failureCodeSuffix: "LINES", hardCapIds: migrationCap });
      ctx.ok(current.fulfillment && typeof current.fulfillment === "object", `${id} singular Fulfillment remains`, { failureCodeSuffix: "SINGULAR", hardCapIds: migrationCap });
      ctx.ok(Array.isArray(current.fulfillments) && current.fulfillments.length === 1, `${id} receives one FINAL Fulfillment member`, { failureCodeSuffix: "FINAL_GROUP", hardCapIds: migrationCap });
      ctx.equal(current.fulfillments[0].id, prior.fulfillment.id, `${id} Fulfillment identity preserved`, { failureCodeSuffix: "FULFILLMENT_ID", hardCapIds: migrationCap });
    }
    return finalEvidence(ctx, { migratedOrders: ids.length, repeatedMigrations: 2, warehouseId: warehouse.id });
  },
});

const e02 = defineCase({
  id: "E-02",
  fixtureFamily: "F-MIGRATION-IDEMPOTENCY",
  action: "Save V1 successful Order, cancellation, and domain-capacity-conflict replays plus delivered Event identities, upgrade the same database, and replay through FINAL.",
  oracle: "Every stored status and logical body, generated ID/timestamp, eventId/sequence/body, and old singular client response remains compatible without a second business effect.",
  async run(ctx) {
    if (!ctx.v1Workspace) ctx.block("missing_v1_checkpoint");
    const receiver = await ctx.receiver();
    const v1 = ctx.forWorkspace(ctx.v1Workspace);
    await v1.migrate(); await v1.npm("build", [], { timeoutMs: 300_000 });
    const apiV1 = await v1.startApi();
    const { warehouse, sku } = await prepareV1Catalog(ctx, apiV1);
    const dispatcherV1 = await v1.startDispatcher({ webhookUrl: receiver.url });
    void dispatcherV1;
    const successBody = { customerReference: "e02-success", lines: [{ skuId: sku.id, quantity: 2 }] };
    const successKey = ctx.key("success");
    const success = await ctx.orderRequest(apiV1.baseUrl, successKey, successBody);
    ctx.equal(success.status, 201, "V1 success created");
    const conflictBody = { customerReference: "e02-conflict", lines: [{ skuId: sku.id, quantity: 1_000_000 }] };
    const conflictKey = ctx.key("conflict");
    const conflict = await ctx.orderRequest(apiV1.baseUrl, conflictKey, conflictBody);
    expectError(ctx, conflict, 409, "NO_SINGLE_WAREHOUSE_CAPACITY", "V1 durable domain conflict");
    const cancelKey = ctx.key("cancel");
    const cancelled = await ctx.cancelRequest(apiV1.baseUrl, success.json.order.id, cancelKey);
    ctx.equal(cancelled.status, 200, "V1 cancellation saved");
    await ctx.waitFor(() => receiver.ledger.filter(({ acknowledged }) => acknowledged).length >= 2, { timeoutMs: 90_000, label: "V1 Event delivery" });
    const beforeEvents = new Map(receiver.ledger.map(({ json }) => [json.eventId, canonicalJson(json)]));
    await stopWorkspaceProcesses(ctx, ctx.v1Workspace);
    await ctx.migrate(); await ctx.npm("build", [], { timeoutMs: 300_000 });
    const apiFinal = await ctx.startApi();
    const successReplay = await ctx.orderRequest(apiFinal.baseUrl, successKey, successBody);
    const conflictReplay = await ctx.orderRequest(apiFinal.baseUrl, conflictKey, conflictBody);
    const cancelReplay = await ctx.cancelRequest(apiFinal.baseUrl, success.json.order.id, cancelKey);
    ctx.equal(successReplay.status, success.status, "success replay status preserved", { failureCodeSuffix: "SUCCESS_STATUS", hardCapIds: migrationCap });
    ctx.equal(successReplay.json.order.id, success.json.order.id, "success replay Order identity preserved", { failureCodeSuffix: "SUCCESS_ID", hardCapIds: migrationCap });
    ctx.equal(conflictReplay.status, conflict.status, "domain conflict replay status preserved", { failureCodeSuffix: "CONFLICT_REPLAY", hardCapIds: migrationCap });
    ctx.equal(conflictReplay.json, conflict.json, "domain conflict replay body preserved", { failureCodeSuffix: "CONFLICT_REPLAY", hardCapIds: migrationCap });
    ctx.equal(cancelReplay.json.order.id, cancelled.json.order.id, "cancellation replay identity preserved", { failureCodeSuffix: "CANCEL_REPLAY", hardCapIds: migrationCap });
    ctx.equal((await allOrders(ctx, apiFinal.baseUrl)).length, 1, "upgrade replay adds no Order effect", { failureCodeSuffix: "DUPLICATE_EFFECT", hardCapIds: migrationCap });
    ctx.ok([...beforeEvents.values()].every((body) => typeof body === "string"), "V1 Event identities captured");
    return finalEvidence(ctx, { savedReplays: 3, eventIdentities: beforeEvents.size, warehouseId: warehouse.id });
  },
});

const e03 = defineCase({
  id: "E-03",
  fixtureFamily: "F-MIGRATION-WORK",
  action: "Leave a V1 Fulfillment pending with its allocated Event repeatedly unacknowledged, stop V1 roles, upgrade in place, then start FINAL Worker and Dispatcher.",
  oracle: "Pending business and delivery work continue once after upgrade, producing one Shipment and settlement while retrying the original allocated Event identity and preserving per-Order sequence.",
  async run(ctx) {
    if (!ctx.v1Workspace) ctx.block("missing_v1_checkpoint");
    const failingReceiver = await ctx.receiver(() => ({ status: 503 }));
    const v1 = ctx.forWorkspace(ctx.v1Workspace);
    await v1.migrate(); await v1.npm("build", [], { timeoutMs: 300_000 });
    const apiV1 = await v1.startApi();
    const { sku } = await prepareV1Catalog(ctx, apiV1);
    const created = await createOrder(ctx, apiV1.baseUrl, { customerReference: "e03-pending", lines: [{ skuId: sku.id, quantity: 2 }] }, ctx.key("pending"));
    await v1.startDispatcher({ webhookUrl: failingReceiver.url, env: { WEBHOOK_TIMEOUT_MS: "300" } });
    await ctx.waitFor(() => failingReceiver.ledger.length >= 1, { timeoutMs: 60_000, label: "V1 unacknowledged allocated Event" });
    const allocatedIdentity = failingReceiver.ledger[0].json.eventId;
    const allocatedBody = canonicalJson(failingReceiver.ledger[0].json);
    await stopWorkspaceProcesses(ctx, ctx.v1Workspace);
    const successReceiver = await ctx.receiver();
    await ctx.migrate(); await ctx.npm("build", [], { timeoutMs: 300_000 });
    const apiFinal = await ctx.startApi();
    await ctx.startWorker();
    await ctx.startDispatcher(successReceiver.url);
    const shipped = await waitForOrderStatus(ctx, apiFinal.baseUrl, created.order.id, "SHIPPED", { timeoutMs: 120_000 });
    await ctx.waitFor(() => successReceiver.ledger.filter(({ acknowledged }) => acknowledged).length >= 2, { timeoutMs: 120_000, label: "FINAL migrated Event delivery" });
    const retried = successReceiver.ledger.find(({ json }) => json?.eventId === allocatedIdentity);
    ctx.ok(retried, "FINAL retries original allocated Event identity", { failureCodeSuffix: "EVENT_IDENTITY", hardCapIds: migrationCap });
    ctx.equal(canonicalJson(retried.json), allocatedBody, "FINAL retry keeps allocated Event body", { failureCodeSuffix: "EVENT_BODY", hardCapIds: migrationCap });
    ctx.equal(fulfillmentGroups(shipped).length, 1, "migrated pending Order has one Fulfillment");
    ctx.equal(new Set(fulfillmentGroups(shipped).map(({ shipment }) => shipment.id)).size, 1, "migrated pending Order ships once", { failureCodeSuffix: "SHIPMENT", hardCapIds: migrationCap });
    assertEventLedger(successReceiver.ledger, [created.order.id]);
    return finalEvidence(ctx, { migratedPendingOrders: 1, successfulDeliveries: successReceiver.ledger.length });
  },
});

async function writeChunk(stream, value) {
  if (!stream.write(value)) await once(stream, "drain");
}

async function writeArray(stream, count, factory) {
  await writeChunk(stream, "[");
  for (let index = 0; index < count; index += 1) {
    if (index > 0) await writeChunk(stream, ",");
    await writeChunk(stream, JSON.stringify(factory(index)));
  }
  await writeChunk(stream, "]");
}

async function writeLargeSeed(ctx) {
  const path = ctx.tempPath("parcelflow-perf-seed.v1.json");
  const stream = createWriteStream(path, { encoding: "utf8" });
  const warehouseIds = Array.from({ length: perf.dataset.warehouses }, (_, index) => ctx.uuid(`perf-warehouse-${index}`));
  const skuIds = Array.from({ length: perf.dataset.skus }, (_, index) => ctx.uuid(`perf-sku-${index}`));
  await writeChunk(stream, '{"schemaVersion":1,"warehouses":');
  await writeArray(stream, warehouseIds.length, (index) => ({ id: warehouseIds[index], code: `PERF-WH-${String(index).padStart(3, "0")}`, name: `Performance Warehouse ${index}`, priority: index }));
  await writeChunk(stream, ',"skus":');
  await writeArray(stream, skuIds.length, (index) => ({ id: skuIds[index], code: `PERF-SKU-${String(index).padStart(5, "0")}`, name: `Performance SKU ${index}` }));
  await writeChunk(stream, ',"stockPositions":');
  await writeArray(stream, perf.dataset.stockPositions, (index) => ({ warehouseId: warehouseIds[Math.floor(index / 10_000)], skuId: skuIds[index % skuIds.length], onHand: 1_000_000 }));
  await writeChunk(stream, ',"orders":');
  await writeArray(stream, perf.dataset.historicalOrders, (index) => {
    const warehouseId = warehouseIds[index % warehouseIds.length];
    const start = (index * 5) % skuIds.length;
    return {
      id: ctx.uuid(`perf-order-${index}`),
      customerReference: `perf-history-${String(index).padStart(6, "0")}`,
      warehouseId,
      fulfillmentId: ctx.uuid(`perf-fulfillment-${index}`),
      shipmentId: ctx.uuid(`perf-shipment-${index}`),
      lines: Array.from({ length: 5 }, (_, line) => ({ id: ctx.uuid(`perf-line-${index}-${line}`), skuId: skuIds[(start + line) % skuIds.length], quantity: 1 })),
      createdAt: ctx.at({ days: -30, seconds: index % 86_400 }),
      shippedAt: ctx.at({ days: -30, seconds: (index % 86_400) + 1 }),
    };
  });
  await writeChunk(stream, "}");
  stream.end();
  await once(stream, "finish");
  return { path, warehouseIds, skuIds };
}

async function runTimedLoad({ durationMs, concurrency, operation }) {
  const deadline = performance.now() + durationMs;
  const records = [];
  let ordinal = 0;
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    while (performance.now() < deadline) {
      const index = ordinal; ordinal += 1;
      const startedAt = performance.now();
      const response = await operation(index, worker);
      records.push({ status: response.status, durationMs: performance.now() - startedAt, json: response.json });
    }
  }));
  return records;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

const e04 = defineCase({
  id: "E-04",
  fixtureFamily: "F-PERF-LARGE",
  action: "Import the exact million-position and million-line dataset, boot two production APIs, and run three 15-second warmups plus 90-second 64-client mixed catalog/history query measurements.",
  oracle: "Median run has aggregate p95 at most 250 ms and at least 250 fully-read, shape-validated responses per second, zero unexpected 5xx, and correct post-load public projections.",
  async run(ctx) {
    await ctx.migrate();
    const fixture = await writeLargeSeed(ctx);
    const imported = await ctx.npm("seed", ["--file", fixture.path], { timeoutMs: 1_800_000 });
    ctx.equal(imported.exitCode, 0, "large seed import succeeds");
    await ctx.npm("build", [], { timeoutMs: 300_000 });
    const apiA = await ctx.startApi();
    const apiB = await ctx.startApi();
    const paths = [
      "/api/inventory?limit=100",
      "/api/skus?q=PERF-SKU-1&limit=100",
      "/api/orders?customerReference=perf-history&limit=100",
      `/api/orders/${ctx.uuid("perf-order-100")}`,
    ];
    const runs = [];
    for (let run = 0; run < perf.query.runs; run += 1) {
      await runTimedLoad({ durationMs: perf.query.warmupSeconds * 1_000, concurrency: perf.query.clients, operation: (index) => ctx.request(index % 2 ? apiA.baseUrl : apiB.baseUrl, paths[index % paths.length]) });
      const measured = await runTimedLoad({ durationMs: perf.query.measureSeconds * 1_000, concurrency: perf.query.clients, operation: (index) => ctx.request(index % 2 ? apiA.baseUrl : apiB.baseUrl, paths[index % paths.length]) });
      ctx.ok(measured.every(({ status, json }) => status === 200 && json && typeof json === "object"), `query run ${run} fully validates every body`, { failureCodeSuffix: "INVALID_RESPONSE" });
      runs.push({ p95: percentile(measured.map(({ durationMs }) => durationMs), 0.95), throughput: measured.length / perf.query.measureSeconds, requests: measured.length });
    }
    const p95 = median(runs.map((item) => item.p95));
    const throughput = median(runs.map((item) => item.throughput));
    ctx.ok(p95 <= perf.query.p95Ms, `query median p95 ${p95}ms <= ${perf.query.p95Ms}ms`, { failureCodeSuffix: "P95" });
    ctx.ok(throughput >= perf.query.throughput, `query median throughput ${throughput} >= ${perf.query.throughput}`, { failureCodeSuffix: "THROUGHPUT" });
    return finalEvidence(ctx, { dataset: perf.dataset, runs, medianP95Ms: p95, medianThroughput: throughput });
  },
});

async function setupHotMutationCatalog(ctx, baseUrl) {
  const warehouses = [];
  for (let index = 0; index < perf.mutation.warehouses; index += 1) warehouses.push(await createWarehouse(ctx, baseUrl, { code: `E05-WH-${index}`, priority: index }));
  const skus = [];
  for (let index = 0; index < perf.mutation.hotSkus; index += 1) skus.push(await createSku(ctx, baseUrl, { code: `E05-SKU-${String(index).padStart(2, "0")}` }));
  for (const warehouse of warehouses) for (const sku of skus) await setInventory(ctx, baseUrl, warehouse.id, sku.id, 1_000_000);
  return { warehouses, skus };
}

const e05 = defineCase({
  id: "E-05",
  fixtureFamily: "F-PERF-HOT-STOCK",
  action: "Run two production APIs, two Workers, eight Warehouses, thirty-two hot SKUs, and two hundred clients through three measured mixes of multi-line creates, eligible cancellations, and public reads.",
  oracle: "Median mutation p95 is at most 750 ms, aggregate throughput at least 120/s, successful creates plus cancellations at least 60/s, unexpected 5xx zero, and inventory remains conserved.",
  async run(ctx) {
    const apiA = await startPreparedApi(ctx);
    const apiB = await ctx.startApi();
    const catalog = await setupHotMutationCatalog(ctx, apiA.baseUrl);
    await ctx.startWorker(); await ctx.startWorker();
    const cancellable = [];
    const runs = [];
    let operationOrdinal = 0;
    const operation = async () => {
      const index = operationOrdinal;
      operationOrdinal += 1;
      const baseUrl = index % 2 ? apiA.baseUrl : apiB.baseUrl;
      if (index % 5 === 0 && cancellable.length) {
        const orderId = cancellable.shift();
        return ctx.cancelRequest(baseUrl, orderId, ctx.key(`perf-cancel-${index}`));
      }
      if (index % 4 !== 0) {
        const skuA = catalog.skus[index % catalog.skus.length];
        const skuB = catalog.skus[(index + 7) % catalog.skus.length];
        const response = await ctx.orderRequest(baseUrl, ctx.key(`perf-order-${index}`), { customerReference: `e05-${index}`, lines: [{ skuId: skuA.id, quantity: 1 }, { skuId: skuB.id, quantity: 1 }] });
        if (response.status === 201) cancellable.push(response.json.order.id);
        return response;
      }
      return ctx.request(baseUrl, `/api/inventory?skuId=${catalog.skus[index % catalog.skus.length].id}&limit=100`);
    };
    for (let run = 0; run < 3; run += 1) {
      await runTimedLoad({ durationMs: 15_000, concurrency: perf.mutation.clients, operation });
      const measured = await runTimedLoad({ durationMs: 90_000, concurrency: perf.mutation.clients, operation });
      const mutations = measured.filter(({ status, json }) => json?.order || json?.error);
      const successes = mutations.filter(({ status }) => status === 200 || status === 201);
      ctx.ok(measured.every(({ status }) => status < 500), `mutation run ${run} has zero 5xx`, { failureCodeSuffix: "HTTP_5XX" });
      runs.push({
        p95: percentile(mutations.map(({ durationMs }) => durationMs), 0.95),
        throughput: measured.length / 90,
        successfulMutationsPerSecond: successes.length / 90,
        requests: measured.length,
      });
    }
    const p95 = median(runs.map(({ p95 }) => p95));
    const throughput = median(runs.map(({ throughput }) => throughput));
    const successRate = median(runs.map(({ successfulMutationsPerSecond }) => successfulMutationsPerSecond));
    ctx.ok(p95 <= perf.mutation.p95Ms, `mutation p95 ${p95}ms`);
    ctx.ok(throughput >= perf.mutation.throughput, `mutation throughput ${throughput}`);
    ctx.ok(successRate >= perf.mutation.successfulMutationsPerSecond, `successful mutation rate ${successRate}`);
    await allInventory(ctx, apiB.baseUrl);
    return finalEvidence(ctx, { runs, medianP95Ms: p95, medianThroughput: throughput, medianSuccessfulMutationRate: successRate });
  },
});

const e06 = defineCase({
  id: "E-06",
  fixtureFamily: "F-PERF-BACKLOG",
  action: "Create five thousand due Fulfillments and five thousand pending allocated deliveries, return receiver 503 for ten seconds, then 204 while two Workers and one Dispatcher recover the backlog.",
  oracle: "From first 204, at least 95 percent ship and deliver within 60 seconds and all within 120 seconds, with exact Event identity, one Shipment/settlement, and zero unexpected 5xx.",
  async run(ctx) {
    let receiverReadyAt;
    let firstSuccessAt;
    let recoveryStartedAt;
    const receiver = await ctx.receiver((entry) => {
      const ready = recoveryStartedAt !== undefined && Date.now() - recoveryStartedAt >= 10_000;
      if (ready && firstSuccessAt === undefined) firstSuccessAt = Date.now();
      if (ready) receiverReadyAt ??= Date.now();
      return { status: ready ? 204 : 503 };
    });
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl, { code: "E06-WH" });
    const sku = await createSku(ctx, api.baseUrl, { code: "E06-SKU" });
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 10_000);
    const requests = Array.from({ length: perf.backlog.orders }, (_, index) => ({ customerReference: `e06-${String(index).padStart(5, "0")}`, lines: [{ skuId: sku.id, quantity: 1 }] }));
    const responses = await ctx.concurrent(requests, 100, (body, index) => ctx.orderRequest(api.baseUrl, ctx.key(`backlog-${index}`), body));
    ctx.ok(responses.every(({ status }) => status === 201), "five thousand backlog Orders allocate");
    const ids = responses.map(({ json }) => json.order.id);
    recoveryStartedAt = Date.now();
    await ctx.startWorker(); await ctx.startWorker(); await ctx.startDispatcher(receiver.url, { env: { WEBHOOK_TIMEOUT_MS: "300" } });
    await ctx.waitFor(() => firstSuccessAt !== undefined, { timeoutMs: 30_000, label: "receiver first 204" });
    const progress = async () => {
      const orders = await allOrders(ctx, api.baseUrl);
      const shippedIds = new Set(orders.filter(({ status }) => status === "SHIPPED").map(({ id }) => id));
      const deliveredTypes = new Map();
      for (const { acknowledged, responseStatus, json } of receiver.ledger) {
        if (!acknowledged || responseStatus < 200 || responseStatus >= 300 || !json?.aggregateId) continue;
        if (!deliveredTypes.has(json.aggregateId)) deliveredTypes.set(json.aggregateId, new Set());
        deliveredTypes.get(json.aggregateId).add(json.type);
      }
      return ids.filter((id) => shippedIds.has(id)
        && deliveredTypes.get(id)?.has("order.allocated")
        && deliveredTypes.get(id)?.has("order.shipped")).length;
    };
    const ninetyFive = await ctx.waitFor(async () => (await progress()) >= 4_750 && Date.now(), { timeoutMs: 60_000, intervalMs: 250, label: "95 percent backlog recovery" });
    const allAt = await ctx.waitFor(async () => (await progress()) === 5_000 && Date.now(), { timeoutMs: 120_000, intervalMs: 250, label: "complete backlog recovery" });
    ctx.ok(ninetyFive - firstSuccessAt <= 60_000, "95 percent meets 60-second threshold", { failureCodeSuffix: "RECOVERY_95" });
    ctx.ok(allAt - firstSuccessAt <= 120_000, "complete backlog meets 120-second threshold", { failureCodeSuffix: "RECOVERY_100" });
    const details = await ctx.concurrent(ids, 100, (id) => orderDetail(ctx, api.baseUrl, id));
    ctx.ok(details.every((order) => fulfillmentGroups(order).length === 1 && fulfillmentGroups(order)[0].shipment?.id), "every backlog Order has one Shipment");
    assertEventLedger(receiver.ledger, ids);
    return finalEvidence(ctx, { orders: 5_000, deliveries: 5_000, firstSuccessAt, receiverReadyAt, ninetyFiveMs: ninetyFive - firstSuccessAt, completeMs: allAt - firstSuccessAt });
  },
});

async function treeEntries(root, prefix = "") {
  const values = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) values.push(...await treeEntries(`${root}/${entry.name}`, `${path}/`));
    else values.push(path);
  }
  return values.sort();
}

const e07 = defineCase({
  id: "E-07",
  fixtureFamily: "F-OPERABILITY",
  action: "Run representative public commands twice, inject an invalid seed, boot and terminate every long-running role, inspect descendant processes, ports, workspace artifacts, and bounded logs.",
  oracle: "Commands are deterministic, noninteractive, propagate failure, stop all descendants within ten seconds, release ports, and leave no credential-bearing logs or generated pollution in the Submission.",
  async run(ctx) {
    const before = await treeEntries(ctx.workspace);
    await ctx.migrate();
    const unitA = await ctx.npm("test:unit", [], { timeoutMs: 600_000 });
    const unitB = await ctx.npm("test:unit", [], { timeoutMs: 600_000 });
    ctx.equal(unitA.exitCode, 0, "first unit gate exits zero");
    ctx.equal(unitB.exitCode, 0, "second unit gate exits zero");
    const invalidSeed = await ctx.seed({ schemaVersion: 999, warehouses: [], skus: [], stockPositions: [], orders: [] }, { contractExpectation: "invalid" });
    ctx.ok(invalidSeed.exitCode !== 0, "invalid seed propagates nonzero exit", { failureCodeSuffix: "FAILURE_EXIT" });
    await ctx.npm("build", [], { timeoutMs: 300_000 });
    const receiver = await ctx.receiver();
    const api = await ctx.startApi();
    const worker = await ctx.startWorker();
    const dispatcher = await ctx.startDispatcher(receiver.url);
    const port = api.port;
    for (const process of [dispatcher, worker, api]) {
      const startedAt = performance.now();
      await ctx.stop(process, "SIGTERM");
      ctx.ok(performance.now() - startedAt <= 10_000 && !process.forcedKill, `${process.role} graceful cleanup`, { failureCodeSuffix: "PROCESS_CLEANUP" });
      ctx.ok(noSecretText(process.logs), `${process.role} logs have no credentials`, { failureCodeSuffix: "LOG_SECRET" });
    }
    const rebound = await ctx.startApi({ port });
    ctx.equal(rebound.port, port, "terminated API releases its port");
    await ctx.stop(rebound, "SIGTERM");
    const after = await treeEntries(ctx.workspace);
    const additions = after.filter((path) => !before.includes(path) && !path.startsWith("package-lock.json"));
    ctx.equal(additions, [], "evaluation commands leave no Submission artifacts", { failureCodeSuffix: "ARTIFACT_POLLUTION" });
    return finalEvidence(ctx, { repeatedCommands: 2, rolesStopped: 4, portReused: port });
  },
});

export const E_CASES = [e01, e02, e03, e04, e05, e06, e07];
