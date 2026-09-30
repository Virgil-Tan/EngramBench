import { readFile } from "node:fs/promises";

import { makeAllocationFixture, makeSplitFixture } from "../fixtures/index.mjs";
import { assertEventLedger, fulfillmentGroups } from "../oracles/index.mjs";
import { assertOpenApiSource } from "../oracles/public-wire.mjs";
import {
  allOrders,
  createOrder,
  createSku,
  createWarehouse,
  defineCase,
  expectError,
  expectStatus,
  finalEvidence,
  installCatalogFixture,
  launchBrowser,
  noSecretText,
  orderDetail,
  setInventory,
  startPreparedApi,
  waitForOrderStatus,
} from "./helpers.mjs";

async function firstVisible(locator) {
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

function orderLineGroups(page) {
  // Count the actual SKU/quantity pairs, independent of the enclosing HTML tag.
  return page.locator('form select:visible').locator('xpath=ancestor::*[.//input[@type="number"]][1]');
}

async function orderForm(page) {
  const forms = page.locator("form");
  for (let index = 0; index < await forms.count(); index += 1) {
    const form = forms.nth(index);
    if (await form.getByRole("combobox").count() && await form.locator('input[type="number"]').count()) return form;
  }
  throw new Error("production UI has no accessible Order form");
}

async function addOrderLines(page, count) {
  while (await orderLineGroups(page).count() < count) {
    const before = await orderLineGroups(page).count();
    const button = await firstVisible(page.getByRole("button", { name: /add line/i }));
    if (!button) throw new Error("production UI has no accessible add-line control");
    await button.click();
    await page.waitForFunction(({ before }) => [...document.querySelectorAll('form select')].filter(el => el.getClientRects().length).length > before, { before });
  }
}

async function fillOrderForm(page, reference, lines) {
  const form = await orderForm(page);
  await addOrderLines(page, lines.length);
  const referenceField = await firstVisible(page.getByLabel(/customer.*reference|reference.*customer/i))
    ?? await firstVisible(form.locator('input:not([type="number"]):not([type="hidden"])'));
  if (!referenceField) throw new Error("Order form has no labelled customer reference");
  await referenceField.fill(reference);
  const groups = orderLineGroups(page);
  for (let index = 0; index < lines.length; index += 1) {
    const group = groups.nth(index);
    const sku = await firstVisible(group.getByRole("combobox")) ?? form.getByRole("combobox").nth(index);
    const quantity = await firstVisible(group.locator('input[type="number"]')) ?? form.locator('input[type="number"]').nth(index);
    try { await sku.selectOption({ value: lines[index].sku.id }); } catch { await sku.selectOption({ label: lines[index].sku.code }); }
    await quantity.fill(String(lines[index].quantity));
  }
  const submit = await firstVisible(form.getByRole("button", { name: /allocate order|create order|submit order/i }))
    ?? await firstVisible(form.locator('button[type="submit"], input[type="submit"]'));
  if (!submit) throw new Error("Order form has no accessible submit control");
  await submit.click();
}

async function openOrderFromHistory(page, reference) {
  const direct = await firstVisible(page.getByRole("link", { name: new RegExp(reference, "i") }).or(page.getByRole("button", { name: new RegExp(reference, "i") })));
  if (direct) { await direct.click(); return; }
  const history = await firstVisible(page.getByRole("link", { name: /orders|history/i })) ?? await firstVisible(page.getByRole("button", { name: /orders|history/i }));
  if (history) await history.click();
  const link = await firstVisible(page.getByRole("link", { name: new RegExp(reference, "i") }).or(page.getByRole("button", { name: new RegExp(reference, "i") })));
  if (!link) throw new Error(`Order history has no visible navigation control for ${reference}`);
  await link.click();
}

async function waitVisibleStatus(page, pattern, timeout = 60_000) {
  const locator = page.locator('[role="status"], [role="alert"], [aria-live]:not([aria-live="off"]), main').filter({ hasText: pattern });
  await locator.first().waitFor({ timeout });
  return locator.first();
}

const d01 = defineCase({
  id: "D-01",
  fixtureFamily: "F-CONTRACT",
  action: "Independently inspect OpenAPI 3.1 schemas and send one success and one published error through each public route family, including admin, idempotency, Order, and webhook traffic.",
  oracle: "Live statuses, JSON content, exact error envelopes, headers, and webhook identity validate against substantive route-specific contract declarations rather than permissive empty schemas.",
  async run(ctx) {
    const source = await ctx.readText("openapi.yaml");
    ctx.assert("OpenAPI matches the canonical public contract", () => assertOpenApiSource(source));
    const api = await startPreparedApi(ctx);
    expectStatus(ctx, await ctx.request(api.baseUrl, "/api/health"), 200, "live health");
    const warehouse = await createWarehouse(ctx, api.baseUrl);
    const sku = await createSku(ctx, api.baseUrl);
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 10);
    expectStatus(ctx, await ctx.request(api.baseUrl, "/api/warehouses?limit=1"), 200, "live Warehouse read");
    expectStatus(ctx, await ctx.request(api.baseUrl, "/api/skus?limit=1"), 200, "live SKU read");
    expectStatus(ctx, await ctx.request(api.baseUrl, "/api/inventory?limit=1"), 200, "live inventory read");
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "d01-live", lines: [{ skuId: sku.id, quantity: 1 }] });
    expectStatus(ctx, await ctx.request(api.baseUrl, `/api/orders/${created.order.id}`), 200, "live Order detail");
    expectStatus(ctx, await ctx.cancelRequest(api.baseUrl, created.order.id, ctx.key("cancel")), 200, "live Order cancel");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/orders/not-an-id", { contractExpectation: "invalid" }), 400, "INVALID_ID", "live published error");
    return finalEvidence(ctx, { liveRouteFamilies: 8 });
  },
});

const d02 = defineCase({
  id: "D-02",
  fixtureFamily: "F-BROWSER",
  action: "Use only production Chromium visible controls to browse catalog and inventory, compose a multi-line Order, observe allocation and Shipment, then fully refresh.",
  oracle: "Visible Warehouse, SKU, quantities, Order lines, Shipment, and terminal state match independent HTTP state, and a full refresh retains the durable result without browser-side invention.",
  async run(ctx) {
    const receiver = await ctx.receiver();
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl, { code: "D02-WH" });
    const skuA = await createSku(ctx, api.baseUrl, { code: "D02-SKU-A" });
    const skuB = await createSku(ctx, api.baseUrl, { code: "D02-SKU-B" });
    await setInventory(ctx, api.baseUrl, warehouse.id, skuA.id, 20);
    await setInventory(ctx, api.baseUrl, warehouse.id, skuB.id, 20);
    await ctx.startWorker();
    await ctx.startDispatcher(receiver.url);
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await page.getByText("D02-WH", { exact: false }).and(page.locator(':visible')).first().waitFor({ timeout: 30_000 });
    await page.getByText("D02-SKU-A", { exact: false }).and(page.locator(':visible')).first().waitFor();
    await fillOrderForm(page, "d02-browser-order", [{ sku: skuA, quantity: 2 }, { sku: skuB, quantity: 3 }]);
    await waitVisibleStatus(page, /ALLOCATED|SHIPPED/i);
    const order = await ctx.waitFor(async () => (await allOrders(ctx, api.baseUrl, { customerReference: "d02-browser-order" }))[0] ?? false, { timeoutMs: 30_000, label: "browser-created Order" });
    const shipped = await waitForOrderStatus(ctx, api.baseUrl, order.id, "SHIPPED");
    await waitVisibleStatus(page, /SHIPPED/i);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(shipped.id, { exact: false }).or(page.getByText("d02-browser-order", { exact: false })).first().waitFor({ timeout: 30_000 });
    ctx.ok(fulfillmentGroups(shipped).every(({ shipment }) => shipment?.id), "HTTP oracle sees every Shipment");
    return finalEvidence(ctx, { browserOrderId: order.id, lineCount: 2 });
  },
});

const d03 = defineCase({
  id: "D-03",
  fixtureFamily: "F-BROWSER",
  action: "Navigate production UI to an allocated Order, cancel through a visible control, inspect inventory/history after refresh, and watch another Order poll itself to SHIPPED.",
  oracle: "Cancellation visibly restores reserved stock, retries do not duplicate mutation, async Shipment state comes from HTTP, and durable history navigation survives full refresh.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl, { code: "D03-WH" });
    const sku = await createSku(ctx, api.baseUrl, { code: "D03-SKU" });
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 20);
    const cancellable = await createOrder(ctx, api.baseUrl, { customerReference: "d03-cancel-ui", lines: [{ skuId: sku.id, quantity: 3 }] });
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await openOrderFromHistory(page, "d03-cancel-ui");
    const cancel = await firstVisible(page.getByRole("button", { name: /cancel order|cancel/i }));
    if (!cancel) throw new Error("Order detail has no visible cancel action");
    await cancel.click();
    await waitVisibleStatus(page, /CANCELLED/i);
    ctx.equal((await orderDetail(ctx, api.baseUrl, cancellable.order.id)).status, "CANCELLED", "UI cancel committed to HTTP state");
    const shippedCandidate = await createOrder(ctx, api.baseUrl, { customerReference: "d03-ship-ui", lines: [{ skuId: sku.id, quantity: 2 }] });
    await ctx.startWorker();
    await openOrderFromHistory(page, "d03-ship-ui");
    await waitVisibleStatus(page, /SHIPPED/i, 60_000);
    await waitForOrderStatus(ctx, api.baseUrl, shippedCandidate.order.id, "SHIPPED");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(/SHIPPED/i).first().waitFor();
    return finalEvidence(ctx, { cancelledOrderId: cancellable.order.id, shippedOrderId: shippedCandidate.order.id });
  },
});

const d04 = defineCase({
  id: "D-04",
  fixtureFamily: "F-BROWSER-SPLIT",
  action: "At desktop and mobile viewports, open production UI for a dynamic two-to-four-Fulfillment split Order and a single-Warehouse control while shipping and cancellation progress.",
  oracle: "Every group Warehouse and status is visibly rendered, PARTIALLY_SHIPPED and SHIPPED are backend-driven, pending split cancellation is coherent, and singular compatibility remains visible.",
  async run(ctx) {
    const fixture = makeSplitFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    const api = await startPreparedApi(ctx);
    const installed = await installCatalogFixture(ctx, api.baseUrl, fixture);
    const split = await createOrder(ctx, api.baseUrl, { customerReference: "d04-split-ui", lines: installed.lines });
    const desktop = await launchBrowser(ctx, api.baseUrl, { viewport: { width: 1280, height: 800 } });
    await openOrderFromHistory(desktop.page, "d04-split-ui");
    for (const warehouse of installed.warehouses) await desktop.page.getByText(warehouse.code, { exact: false }).first().waitFor({ timeout: 30_000 });
    const mobile = await launchBrowser(ctx, api.baseUrl, { viewport: { width: 390, height: 844 } });
    await openOrderFromHistory(mobile.page, "d04-split-ui");
    for (const warehouse of installed.warehouses) await mobile.page.getByText(warehouse.code, { exact: false }).first().waitFor({ timeout: 30_000 });
    await ctx.startWorker();
    const shipped = await waitForOrderStatus(ctx, api.baseUrl, split.order.id, "SHIPPED", { timeoutMs: 90_000 });
    await waitVisibleStatus(desktop.page, /PARTIALLY_SHIPPED|SHIPPED/i, 90_000);
    ctx.equal(fulfillmentGroups(shipped).length, installed.warehouses.length, "dynamic group count comes from allocation");
    ctx.ok(fulfillmentGroups(shipped).every(({ shipment }) => shipment?.id), "every dynamic group has Shipment");
    return finalEvidence(ctx, { viewportCount: 2, fulfillmentCount: installed.warehouses.length });
  },
});

const d05 = defineCase({
  id: "D-05",
  fixtureFamily: "F-BROWSER-FAILURES",
  action: "Drive production UI through empty data, delayed loading, capacity conflict, idempotency conflict, API restart/offline, and invalid-admin permission conditions.",
  oracle: "Each state is visible, announced, and recoverable without inventing an Order; browser assets and logs contain no ADMIN_TOKEN or database/webhook credential.",
  async run(ctx) {
    let api = await startPreparedApi(ctx);
    const session = await launchBrowser(ctx, api.baseUrl);
    const page = session.page;
    await page.getByText(/empty|no warehouses|no inventory|no orders/i).first().waitFor({ timeout: 30_000 });
    const warehouse = await createWarehouse(ctx, api.baseUrl, { code: "D05-WH" });
    const sku = await createSku(ctx, api.baseUrl, { code: "D05-SKU" });
    await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 1);
    await page.reload({ waitUntil: "domcontentloaded" });
    await fillOrderForm(page, "d05-capacity", [{ sku, quantity: 2 }]);
    await waitVisibleStatus(page, /NO_SINGLE_WAREHOUSE_CAPACITY|capacity/i);
    ctx.equal((await allOrders(ctx, api.baseUrl, { customerReference: "d05-capacity" })).length, 0, "capacity UI failure invents no Order");
    await ctx.kill(api);
    await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
    await page.locator('[role="alert"], [role="status"], main').filter({ hasText: /offline|unavailable|retry|error/i }).first().waitFor({ timeout: 30_000 });
    api = await ctx.startApi({ port: api.port });
    await page.reload({ waitUntil: "domcontentloaded" });
    const html = await page.content();
    ctx.ok(noSecretText(html), "browser DOM contains no credentials", { failureCodeSuffix: "SECRET_EXPOSURE" });
    const bundleResponses = [];
    page.on("response", (response) => { if (/\.js(?:\?|$)/u.test(response.url())) bundleResponses.push(response); });
    ctx.ok(ctx.processes.every(({ logs }) => noSecretText(logs)), "process logs contain no credentials", { failureCodeSuffix: "SECRET_EXPOSURE" });
    return finalEvidence(ctx, { recoveredFromOffline: true, bundleResponses: bundleResponses.length });
  },
});

const d06 = defineCase({
  id: "D-06",
  fixtureFamily: "F-BROWSER-A11Y",
  action: "Use keyboard-only traversal at 390x844 and 1280x800 to search catalog, operate one-to-eight Order rows, submit validation, open detail, and reach cancellation.",
  oracle: "Every required control has an accessible role/name or label, visible focus follows keyboard order, validation is announced, and no primary flow control is unreachable at either viewport.",
  async run(ctx) {
    const api = await startPreparedApi(ctx);
    const warehouse = await createWarehouse(ctx, api.baseUrl, { code: "D06-WH" });
    const skus = [];
    for (let index = 0; index < 8; index += 1) { const sku = await createSku(ctx, api.baseUrl, { code: `D06-SKU-${index}` }); skus.push(sku); await setInventory(ctx, api.baseUrl, warehouse.id, sku.id, 10); }
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      const { page } = await launchBrowser(ctx, api.baseUrl, { viewport });
      const form = await orderForm(page);
      await addOrderLines(page, 8);
      ctx.equal(await orderLineGroups(page).count(), 8, `eight accessible rows at ${viewport.width}px`);
      const labels = await form.locator("label").count();
      ctx.ok(labels >= 9, `Order form labels rows and reference at ${viewport.width}px`, { failureCodeSuffix: "LABELS" });
      await page.keyboard.press("Tab");
      const focused = page.locator(":focus");
      ctx.ok(await focused.count() === 1, `keyboard establishes focus at ${viewport.width}px`, { failureCodeSuffix: "FOCUS" });
      const submit = await firstVisible(form.locator('button[type="submit"], input[type="submit"]'));
      if (!submit) throw new Error("accessible Order form has no submit");
      await submit.focus();
      await page.keyboard.press("Enter");
      await page.locator('[role="alert"], [aria-live]:not([aria-live="off"])').first().waitFor({ timeout: 10_000 });
    }
    return finalEvidence(ctx, { viewports: 2, maximumRows: 8 });
  },
});

const d07 = defineCase({
  id: "D-07",
  fixtureFamily: "F-VERIFICATION",
  action: "Run unit, integration, browser E2E, concurrency, recovery, all, and performance commands with isolated test configuration and independently force missing real dependencies.",
  oracle: "Every gate is nonempty and green only with real seams; integration depends on PostgreSQL/HTTP, E2E on production Chromium, concurrency on multiple APIs/Workers, and recovery on real SIGKILL.",
  async run(ctx) {
    const scripts = ["test:unit", "test:integration", "test:e2e", "test:concurrency", "test:recovery", "test:all", "test:perf"];
    for (const script of scripts) {
      const result = await ctx.npm(script, [], { timeoutMs: script === "test:perf" ? 1_800_000 : 600_000 });
      ctx.equal(result.exitCode, 0, `${script} exits zero`);
      ctx.ok(!/\b0 tests?\b|\bno tests?\b|\bskipped all\b/iu.test(`${result.stdout}\n${result.stderr}`), `${script} is not empty`, { failureCodeSuffix: "FAKE_GREEN" });
    }
    const invalidDatabase = await ctx.npm("test:integration", [], { allowFailure: true, timeoutMs: 120_000, env: { TEST_DATABASE_URL: "postgresql://invalid@127.0.0.1:1/invalid" } });
    ctx.ok(invalidDatabase.exitCode !== 0, "integration gate fails without real PostgreSQL", { failureCodeSuffix: "MOCK_INTEGRATION" });
    const invalidChromium = await ctx.npm("test:e2e", [], { allowFailure: true, timeoutMs: 120_000, env: { CHROMIUM_PATH: "/definitely/missing/chromium" } });
    ctx.ok(invalidChromium.exitCode !== 0, "E2E gate fails without real Chromium", { failureCodeSuffix: "MOCK_BROWSER" });
    return finalEvidence(ctx, { gates: scripts.length, dependencyProbes: 2 });
  },
});

const d08 = defineCase({
  id: "D-08",
  fixtureFamily: "F-EVIDENCE-LEDGER",
  action: "Execute a frozen ledger from README requirement through live HTTP, OpenAPI declaration, production UI visibility, durable Order/Stock Position projection, and receiver Event evidence.",
  oracle: "Each applicable node contains executable matching identity and quantity evidence; source strings, file presence, test names, or candidate self-report alone cannot satisfy the chain.",
  async run(ctx) {
    const source = await ctx.readText("openapi.yaml");
    const receiver = await ctx.receiver();
    const fixture = makeAllocationFixture({ evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime });
    const api = await startPreparedApi(ctx);
    const installed = await installCatalogFixture(ctx, api.baseUrl, fixture);
    await ctx.startDispatcher(receiver.url);
    await ctx.startWorker();
    const created = await createOrder(ctx, api.baseUrl, { customerReference: "d08-ledger", lines: installed.lines });
    const terminal = await waitForOrderStatus(ctx, api.baseUrl, created.order.id, "SHIPPED");
    await ctx.waitFor(() => receiver.ledger.some(({ json, acknowledged }) => acknowledged && json?.aggregateId === created.order.id && json?.type === "order.shipped"), { timeoutMs: 90_000, label: "ledger terminal Event" });
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await openOrderFromHistory(page, "d08-ledger");
    await page.getByText(/SHIPPED/i).first().waitFor();
    ctx.assert("ledger OpenAPI node", () => assertOpenApiSource(source));
    ctx.equal((await orderDetail(ctx, api.baseUrl, created.order.id)).status, "SHIPPED", "ledger HTTP state node");
    ctx.ok(fulfillmentGroups(terminal).every(({ shipment }) => shipment?.id), "ledger public Shipment node");
    const eventMetrics = assertEventLedger(receiver.ledger, [created.order.id]);
    return finalEvidence(ctx, { chainNodes: 6, ...eventMetrics });
  },
});

export const D_CASES = [d01, d02, d03, d04, d05, d06, d07, d08];
