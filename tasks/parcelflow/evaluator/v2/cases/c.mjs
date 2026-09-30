import { makeSplitFixture } from "../fixtures/index.mjs";
import { assertEventLedger, assertOrderTerminal, fulfillmentGroups } from "../oracles/index.mjs";
import {
  allInventory,
  createOrder,
  createSku,
  createWarehouse,
  defineCase,
  finalEvidence,
  installCatalogFixture,
  inventory,
  knownGroupProjection,
  orderDetail,
  setInventory,
  startPreparedApi,
  waitForOrderStatus,
} from "./helpers.mjs";

const recoveryCap = ["RECOVERY_OR_SETTLEMENT"];
const eventCap = ["EVENT_ATOMICITY_OR_IDENTITY"];

async function createBacklog(ctx, baseUrl, count, prefix) {
  const warehouse = await createWarehouse(ctx, baseUrl);
  const skuA = await createSku(ctx, baseUrl);
  const skuB = await createSku(ctx, baseUrl);
  await setInventory(ctx, baseUrl, warehouse.id, skuA.id, count * 2);
  await setInventory(ctx, baseUrl, warehouse.id, skuB.id, count * 2);
  const requests = Array.from({ length: count }, (_, index) => ({
    customerReference: `${prefix}-${String(index).padStart(4, "0")}`,
    lines: [{ skuId: skuA.id, quantity: 1 }, { skuId: skuB.id, quantity: 1 }],
  }));
  const responses = await ctx.concurrent(requests, 32, (body, index) => ctx.orderRequest(baseUrl, ctx.key(`${prefix}-${index}`), body));
  ctx.ok(responses.every(({ status }) => status === 201), `${prefix} backlog allocation succeeds`, { failureCodeSuffix: "BACKLOG_CREATE", hardCapIds: recoveryCap });
  return { warehouse, skus: [skuA, skuB], orders: responses.map(({ json }) => json.order) };
}

async function waitBacklogTerminal(ctx, baseUrl, orders, timeoutMs = 180_000) {
  return ctx.waitFor(async () => {
    const details = await ctx.concurrent(orders, 32, async ({ id }) => {
      const response = await ctx.request(baseUrl, `/api/orders/${id}`);
      return response.status === 200 ? response.json.order : undefined;
    });
    return details.every(({ status }) => status === "SHIPPED" || status === "CANCELLED") ? details : false;
  }, { timeoutMs, intervalMs: 75, label: `${orders.length} Order backlog terminal convergence` });
}

const c01 = defineCase({
  id: "C-01",
  fixtureFamily: "F-WORK-BACKLOG",
  action: "Allocate two hundred Orders with Workers stopped, start four real Workers, restart the API during progress, and poll only public Order state.",
  oracle: "All public ALLOCATED backlog converges to SHIPPED, every Fulfillment has one Shipment and one settlement, and API restart does not reset or strand progress.",
  async run(ctx) {
    let api = await startPreparedApi(ctx);
    const backlog = await createBacklog(ctx, api.baseUrl, 200, "c01");
    for (let index = 0; index < 4; index += 1) await ctx.startWorker();
    await ctx.waitFor(async () => {
      const response = await ctx.request(api.baseUrl, `/api/orders/${backlog.orders[0].id}`);
      return response.json?.order?.status === "SHIPPED";
    }, { timeoutMs: 60_000, label: "first backlog Shipment" });
    await ctx.kill(api);
    api = await ctx.startApi();
    const terminals = await waitBacklogTerminal(ctx, api.baseUrl, backlog.orders);
    for (const order of terminals) {
      ctx.equal(order.status, "SHIPPED", `backlog Order ${order.id} ships`);
      const groups = fulfillmentGroups(order);
      ctx.equal(groups.length, 1, `backlog Order ${order.id} one Fulfillment`);
      ctx.ok(typeof groups[0].shipment?.id === "string", `backlog Order ${order.id} one Shipment`, { failureCodeSuffix: "DUPLICATE_OR_MISSING_SHIPMENT", hardCapIds: recoveryCap });
    }
    await allInventory(ctx, api.baseUrl);
    return finalEvidence(ctx, { orders: terminals.length, workers: 4 });
  },
});

const c02 = defineCase({
  id: "C-02",
  fixtureFamily: "F-WORK-BACKLOG",
  action: "Start Worker A on two hundred ALLOCATED Orders, wait until public progress proves it active while backlog remains, SIGKILL it, and immediately start Worker B.",
  oracle: "After the public lease deadline every committed Order ships exactly once with no stranded reservation, duplicate Shipment, settlement, or terminal Event.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const backlog = await createBacklog(ctx, api.baseUrl, 200, "c02");
    const workerA = await ctx.startWorker();
    await ctx.waitFor(async () => {
      const sample = await ctx.concurrent(backlog.orders.slice(0, 20), 20, async ({ id }) => (await ctx.request(api.baseUrl, `/api/orders/${id}`)).json?.order?.status);
      return sample.includes("SHIPPED") && sample.includes("ALLOCATED");
    }, { timeoutMs: 60_000, label: "active Worker with remaining backlog" });
    await ctx.kill(workerA);
    await ctx.startWorker();
    const terminals = await waitBacklogTerminal(ctx, api.baseUrl, backlog.orders, 240_000);
    for (const order of terminals) {
      ctx.equal(order.status, "SHIPPED", `recovered Order ${order.id} ships`, { failureCodeSuffix: "STRANDED_ORDER", hardCapIds: recoveryCap });
      ctx.equal(new Set(fulfillmentGroups(order).map(({ shipment }) => shipment?.id)).size, fulfillmentGroups(order).length, `recovered Order ${order.id} Shipment identity unique`, { failureCodeSuffix: "DUPLICATE_SHIPMENT", hardCapIds: recoveryCap });
    }
    return finalEvidence(ctx, { killedWorkers: 1, recoveredOrders: terminals.length });
  },
});

const c03 = defineCase({
  id: "C-03",
  fixtureFamily: "F-WORK-BACKLOG",
  action: "Begin a nonempty backlog with two Workers, SIGKILL every Worker while ALLOCATED Orders remain, wait past the published recovery timeout, then start a fresh process.",
  oracle: "Committed Order ownership survives the complete outage and every pending Fulfillment becomes one Shipment without duplicate settlement after restart.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const backlog = await createBacklog(ctx, api.baseUrl, 200, "c03");
    const workerA = await ctx.startWorker();
    const workerB = await ctx.startWorker();
    await ctx.waitFor(async () => (await orderDetail(ctx, api.baseUrl, backlog.orders[0].id)).status === "SHIPPED", { timeoutMs: 60_000, label: "initial Worker progress" });
    await ctx.kill(workerA);
    await ctx.kill(workerB);
    const pendingBefore = await ctx.concurrent(backlog.orders, 32, async ({ id }) => (await ctx.request(api.baseUrl, `/api/orders/${id}`)).json?.order?.status);
    ctx.ok(pendingBefore.includes("ALLOCATED"), "complete outage occurs with pending backlog");
    await new Promise((done) => setTimeout(done, 1_100));
    await ctx.startWorker();
    const terminals = await waitBacklogTerminal(ctx, api.baseUrl, backlog.orders, 240_000);
    ctx.ok(terminals.every(({ status }) => status === "SHIPPED"), "fresh Worker drains outage backlog", { failureCodeSuffix: "OUTAGE_RECOVERY", hardCapIds: recoveryCap });
    return finalEvidence(ctx, { outageWorkers: 2, recoveredOrders: terminals.length });
  },
});

const c04 = defineCase({
  id: "C-04",
  fixtureFamily: "F-WORK-BACKLOG",
  action: "Release four Workers onto one hot Fulfillment plus a two-hundred-Order backlog and restart two Workers while completion is observable.",
  oracle: "The hot Fulfillment has one Shipment and settlement, remaining backlog converges, and no restart exposes a mixed Order projection or duplicate result.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const backlog = await createBacklog(ctx, api.baseUrl, 201, "c04");
    const workers = [];
    for (let index = 0; index < 4; index += 1) workers.push(await ctx.startWorker());
    await ctx.waitFor(async () => (await orderDetail(ctx, api.baseUrl, backlog.orders[0].id)).status === "SHIPPED", { timeoutMs: 60_000, label: "hot Fulfillment completion" });
    await ctx.kill(workers[0]);
    await ctx.kill(workers[1]);
    await ctx.startWorker();
    await ctx.startWorker();
    const terminals = await waitBacklogTerminal(ctx, api.baseUrl, backlog.orders, 240_000);
    const hot = terminals.find(({ id }) => id === backlog.orders[0].id);
    ctx.equal(fulfillmentGroups(hot).length, 1, "hot Order retains one Fulfillment");
    ctx.equal(new Set(fulfillmentGroups(hot).map(({ shipment }) => shipment.id)).size, 1, "hot Fulfillment has one Shipment", { failureCodeSuffix: "HOT_DUPLICATE", hardCapIds: recoveryCap });
    ctx.ok(terminals.every(({ status }) => status === "SHIPPED"), "concurrent Worker backlog converges");
    return finalEvidence(ctx, { workersStarted: 6, orders: terminals.length });
  },
});

const c05 = defineCase({
  id: "C-05",
  fixtureFamily: "F-SPLIT",
  action: "Cancel one single-Warehouse and one split Order with Workers stopped, then repeatedly start Workers across two recovery deadlines.",
  oracle: "Committed cancellation permanently fences every pending Fulfillment: no Shipment, onHand deduction, duplicate terminal Event, or later mixed group state can appear.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const singleWarehouse = await createWarehouse(ctx, api.baseUrl, { priority: 0 });
    const singleSku = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, singleWarehouse.id, singleSku.id, 10);
    const single = await createOrder(ctx, api.baseUrl, { customerReference: "c05-single", lines: [{ skuId: singleSku.id, quantity: 2 }] });
    await ctx.cancelRequest(api.baseUrl, single.order.id, ctx.key("cancel-single"));
    const splitFixture = makeSplitFixture({ evaluationSeed: ctx.evaluationSeed, caseId: `${ctx.caseId}-split`, baseTime: ctx.fixtures.baseTime });
    const installed = await installCatalogFixture(ctx, api.baseUrl, splitFixture);
    const split = await createOrder(ctx, api.baseUrl, { customerReference: "c05-split", lines: installed.lines });
    await ctx.cancelRequest(api.baseUrl, split.order.id, ctx.key("cancel-split"));
    const beforeSingle = await inventory(ctx, api.baseUrl, singleWarehouse.id, singleSku.id);
    let worker = await ctx.startWorker();
    await new Promise((done) => setTimeout(done, 2_200));
    await ctx.kill(worker);
    worker = await ctx.startWorker();
    await new Promise((done) => setTimeout(done, 2_200));
    void worker;
    for (const orderId of [single.order.id, split.order.id]) {
      const order = await orderDetail(ctx, api.baseUrl, orderId);
      ctx.equal(order.status, "CANCELLED", `cancelled Order ${orderId} stays cancelled`, { failureCodeSuffix: "CANCEL_FENCE", hardCapIds: recoveryCap });
      ctx.ok(fulfillmentGroups(order).every(({ status, shipment }) => status === "CANCELLED" && shipment === null), `cancelled Order ${orderId} never ships`, { failureCodeSuffix: "CANCEL_FENCE", hardCapIds: recoveryCap });
    }
    ctx.equal(await inventory(ctx, api.baseUrl, singleWarehouse.id, singleSku.id), beforeSingle, "cancelled Stock Position unchanged by Workers");
    return finalEvidence(ctx, { fencedOrders: 2, workerRestarts: 1 });
  },
});

const c06 = defineCase({
  id: "C-06",
  fixtureFamily: "F-WORK-BACKLOG",
  action: "Commit Orders, preserve one pending Shipment and unacknowledged webhook, SIGKILL every API/Worker/Dispatcher process, then cold-start all roles on the same database.",
  oracle: "Reads and idempotent replay remain identical, pending Shipment and delivery complete, Event sequence and identity stay stable, and no process-local authority is required.",
  async run(ctx) {
    const receiver = await ctx.receiver(() => ({ status: 503 }));
    let api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const sku = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 20);
    const body = { customerReference: "c06-cold-restart", lines: [{ skuId: sku.id, quantity: 2 }] };
    const key = ctx.key("order");
    const created = await createOrder(ctx, api.baseUrl, body, key);
    let worker = await ctx.startWorker();
    let dispatcher = await ctx.startDispatcher(receiver.url);
    await ctx.waitFor(() => receiver.ledger.length >= 1, { timeoutMs: 60_000, label: "pending webhook delivery" });
    await ctx.kill(api); await ctx.kill(worker); await ctx.kill(dispatcher);
    let allowSuccess = false;
    const successReceiver = await ctx.receiver(() => ({ status: allowSuccess ? 204 : 503 }));
    allowSuccess = true;
    api = await ctx.startApi();
    worker = await ctx.startWorker();
    dispatcher = await ctx.startDispatcher(successReceiver.url);
    void worker; void dispatcher;
    const terminal = await waitForOrderStatus(ctx, api.baseUrl, created.order.id, "SHIPPED", { timeoutMs: 90_000 });
    const replay = await ctx.orderRequest(api.baseUrl, key, body);
    ctx.equal(replay.json.order.id, created.order.id, "cold restart keeps Order replay identity", { failureCodeSuffix: "REPLAY_LOST", hardCapIds: recoveryCap });
    await ctx.waitFor(() => successReceiver.ledger.some(({ acknowledged }) => acknowledged), { timeoutMs: 90_000, label: "cold-restart webhook success" });
    ctx.equal(terminal.status, "SHIPPED", "cold restart completes pending Shipment");
    return finalEvidence(ctx, { killedRoles: 3, restartedRoles: 3 });
  },
});

const c07 = defineCase({
  id: "C-07",
  fixtureFamily: "F-EVENT",
  action: "Let receiver read an Event body while withholding ACK, SIGKILL Dispatcher A, then make Dispatcher B traverse timeout and 503 before 204.",
  oracle: "Duplicate arrival is allowed, but every attempt keeps eventId, type, aggregate, sequence, and semantic body; the Event is never lost or assigned a new identity.",
  async run(ctx) {
    let phase = "hold";
    const receiver = await ctx.receiver((entry) => {
      if (phase === "hold") return { status: 204, delayMs: 20_000 };
      if (entry.attempt <= 3) return entry.attempt % 2 ? { status: 503 } : { status: 204, delayMs: 1_000 };
      return { status: 204 };
    });
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const sku = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 10);
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "c07-unknown-ack", lines: [{ skuId: sku.id, quantity: 1 }] });
    const dispatcherA = await ctx.startDispatcher(receiver.url, { env: { WEBHOOK_TIMEOUT_MS: "30000" } });
    await ctx.waitFor(() => receiver.ledger.length >= 1, { timeoutMs: 60_000, label: "receiver read unknown-ACK Event" });
    await ctx.kill(dispatcherA);
    phase = "retry";
    await ctx.startDispatcher(receiver.url, { env: { WEBHOOK_TIMEOUT_MS: "300" } });
    await ctx.waitFor(() => receiver.ledger.some(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300), { timeoutMs: 90_000, label: "Event retry success" });
    const metrics = assertEventLedger(receiver.ledger, [created.order.id]);
    ctx.equal(metrics.uniqueEvents, 1, "unknown ACK keeps one Event identity", { failureCodeSuffix: "EVENT_IDENTITY", hardCapIds: eventCap });
    return finalEvidence(ctx, { attempts: receiver.ledger.length, ...metrics });
  },
});

const c08 = defineCase({
  id: "C-08",
  fixtureFamily: "F-EVENT",
  action: "Create fifty Orders with allocation and terminal Events, run two Dispatchers against scripted 503/timeout/204 responses, and kill one during an observable ACK window.",
  oracle: "Every Event eventually succeeds, no later sequence succeeds before the prior sequence for its Order, different Orders progress independently, and retries preserve semantic body.",
  async run(ctx) {
    const receiver = await ctx.receiver((entry) => entry.attempt % 7 === 0 ? { status: 503 } : entry.attempt % 11 === 0 ? { status: 204, delayMs: 1_000 } : { status: 204 });
    const api = await startPreparedApi(ctx);
    const backlog = await createBacklog(ctx, api.baseUrl, 50, "c08");
    await ctx.startWorker();
    await ctx.startWorker();
    const dispatcherA = await ctx.startDispatcher(receiver.url, { env: { WEBHOOK_TIMEOUT_MS: "300" } });
    await ctx.startDispatcher(receiver.url, { env: { WEBHOOK_TIMEOUT_MS: "300" } });
    await ctx.waitFor(() => receiver.ledger.length >= 10, { timeoutMs: 60_000, label: "dispatcher delivery activity" });
    await ctx.kill(dispatcherA);
    const terminals = await waitBacklogTerminal(ctx, api.baseUrl, backlog.orders, 180_000);
    await ctx.waitFor(() => {
      try { return assertEventLedger(receiver.ledger, terminals.map(({ id }) => id)).successfulOrders === 50; } catch { return false; }
    }, { timeoutMs: 180_000, label: "all Orders successful Event sequence" });
    const metrics = assertEventLedger(receiver.ledger, terminals.map(({ id }) => id));
    ctx.equal(metrics.successfulOrders, 50, "every Order delivered Events", { failureCodeSuffix: "EVENT_ORDER", hardCapIds: eventCap });
    return finalEvidence(ctx, { orders: 50, dispatchers: 2, ...metrics });
  },
});

export const C_CASES = [c01, c02, c03, c04, c05, c06, c07, c08];
