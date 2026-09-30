import assert from "node:assert/strict";

import { CaseFailure } from "../lib/execution.mjs";
import { assertInventoryInvariant, canonicalJson, fulfillmentGroups } from "../oracles/index.mjs";

const fixtureOrdinals = new WeakMap();

function nextFixtureOrdinal(ctx, kind) {
  const counts = fixtureOrdinals.get(ctx) ?? new Map();
  fixtureOrdinals.set(ctx, counts);
  const ordinal = counts.get(kind) ?? 0;
  counts.set(kind, ordinal + 1);
  return ordinal;
}

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !fixtureFamily || !action || !oracle || typeof run !== "function") {
    throw new TypeError("invalid ParcelFlow case definition");
  }
  return Object.freeze({ id, fixtureFamily, action, oracle, run });
}

export function candidateFailure(message, failureCodeSuffix, hardCapIds = []) {
  throw new CaseFailure(message, { failureCodeSuffix, hardCapIds });
}

export function hasHttpBearerSecurity(source) {
  const value = String(source);
  const match = value.match(/securitySchemes:\s*\n\s{4}([A-Za-z][A-Za-z0-9_-]*):\s*\n\s{6}type:\s*http\s*\n\s{6}scheme:\s*bearer\b/iu);
  if (!match) return false;
  return new RegExp(`security:\\s*\\n\\s*-\\s*${match[1]}:`, "u").test(value);
}

export async function prepare(ctx, { build = true, migrate = true, workspace } = {}) {
  const target = workspace ? ctx.forWorkspace(workspace) : ctx;
  if (migrate) await target.migrate({ timeoutMs: 120_000 });
  if (build) await target.npm("build", [], { timeoutMs: 300_000 });
  ctx.mark("candidate-prepared", { build, migrate, version: workspace ? "V1" : "FINAL" });
  return target;
}

export async function startPreparedApi(ctx, options = {}) {
  await prepare(ctx, options);
  return options.workspace ? ctx.forWorkspace(options.workspace).startApi(options) : ctx.startApi(options);
}

export function expectStatus(ctx, response, status, label, options = {}) {
  ctx.equal(response.status, status, `${label} HTTP status`, options);
  return response.json;
}

export function expectError(ctx, response, status, code, label, options = {}) {
  ctx.equal(response.status, status, `${label} HTTP status`, options);
  ctx.equal(response.json?.error?.code, code, `${label} error code`, options);
  ctx.ok(typeof response.json?.error?.message === "string" && response.json.error.message.length > 0, `${label} error message`, options);
  ctx.ok(Array.isArray(response.json?.error?.details), `${label} error details`, options);
  ctx.equal(Object.keys(response.json ?? {}).sort(), ["error"], `${label} exact error envelope`, options);
  return response.json.error;
}

export async function createWarehouse(ctx, baseUrl, fields = {}) {
  const code = fields.code ?? ctx.fixtures.code(`warehouse-${nextFixtureOrdinal(ctx, "warehouse")}`);
  const response = await ctx.adminRequest(baseUrl, "/api/admin/warehouses", fields.key ?? ctx.key(`warehouse-${code}`), {
    code,
    name: fields.name ?? `Warehouse ${code}`,
    priority: fields.priority ?? 1,
  });
  expectStatus(ctx, response, 201, `create Warehouse ${code}`);
  return response.json.warehouse;
}

export async function createSku(ctx, baseUrl, fields = {}) {
  const code = fields.code ?? ctx.fixtures.code(`sku-${nextFixtureOrdinal(ctx, "sku")}`, 64);
  const response = await ctx.adminRequest(baseUrl, "/api/admin/skus", fields.key ?? ctx.key(`sku-${code}`), {
    code,
    name: fields.name ?? `SKU ${code}`,
  });
  expectStatus(ctx, response, 201, `create SKU ${code}`);
  return response.json.sku;
}

export async function setInventory(ctx, baseUrl, warehouseId, skuId, onHand, key = ctx.key(`inventory-${warehouseId}-${skuId}-${onHand}`)) {
  const response = await ctx.adminRequest(baseUrl, `/api/admin/inventory/${warehouseId}/${skuId}`, key, { onHand }, "PUT");
  expectStatus(ctx, response, 200, `set Stock Position ${warehouseId}/${skuId}`);
  return response.json.stockPosition;
}

export async function installCatalogFixture(ctx, baseUrl, fixture) {
  const warehouseMap = new Map();
  const skuMap = new Map();
  for (const source of [...fixture.warehouses].sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))) {
    const created = await createWarehouse(ctx, baseUrl, { code: source.code, name: source.name, priority: source.priority, key: ctx.key(`create-${source.id}`) });
    warehouseMap.set(source.id, created);
  }
  for (const source of fixture.skus) {
    const created = await createSku(ctx, baseUrl, { code: source.code, name: source.name, key: ctx.key(`create-${source.id}`) });
    skuMap.set(source.id, created);
  }
  for (const position of fixture.stock) {
    await setInventory(ctx, baseUrl, warehouseMap.get(position.warehouseId).id, skuMap.get(position.skuId).id, position.onHand);
  }
  return {
    warehouses: fixture.warehouses.map((item) => warehouseMap.get(item.id)),
    skus: fixture.skus.map((item) => skuMap.get(item.id)),
    warehouseMap,
    skuMap,
    lines: fixture.lines.map((line) => ({ skuId: skuMap.get(line.skuId).id, quantity: line.quantity })),
  };
}

export async function createOrder(ctx, baseUrl, body, key = ctx.key(`order-${body.customerReference}`), expectedStatus = 201) {
  const response = await ctx.orderRequest(baseUrl, key, body);
  expectStatus(ctx, response, expectedStatus, `create Order ${body.customerReference}`);
  return { response, order: response.json?.order, key };
}

export async function orderDetail(ctx, baseUrl, orderId) {
  const response = await ctx.request(baseUrl, `/api/orders/${orderId}`);
  expectStatus(ctx, response, 200, `read Order ${orderId}`);
  return response.json.order;
}

export async function waitForOrderStatus(ctx, baseUrl, orderId, statuses, options = {}) {
  const accepted = new Set(Array.isArray(statuses) ? statuses : [statuses]);
  return ctx.waitFor(async () => {
    const response = await ctx.request(baseUrl, `/api/orders/${orderId}`);
    if (response.status !== 200 || !accepted.has(response.json?.order?.status)) return false;
    return response.json.order;
  }, { timeoutMs: options.timeoutMs ?? 60_000, intervalMs: options.intervalMs ?? 20, label: options.label ?? `Order ${orderId} status ${[...accepted].join("/")}` });
}

export async function inventory(ctx, baseUrl, warehouseId, skuId) {
  const query = new URLSearchParams({ warehouseId, skuId, limit: "100" });
  const response = await ctx.request(baseUrl, `/api/inventory?${query}`);
  expectStatus(ctx, response, 200, `read Stock Position ${warehouseId}/${skuId}`);
  ctx.equal(response.json?.items?.length, 1, "exact Stock Position cardinality");
  return response.json.items[0];
}

export async function allInventory(ctx, baseUrl) {
  const positions = await ctx.paginate(baseUrl, "/api/inventory", { limit: 100 });
  try { assertInventoryInvariant(positions); }
  catch (error) { candidateFailure(error.message, "INVENTORY_INVARIANT", ["CORE_INVENTORY_ATOMICITY"]); }
  return positions;
}

export async function allOrders(ctx, baseUrl, filters = {}) {
  return ctx.paginate(baseUrl, "/api/orders", { ...filters, limit: filters.limit ?? 100 });
}

export function knownGroupProjection(order) {
  return fulfillmentGroups(order).map((group) => ({
    id: group.id,
    warehouseId: group.warehouseId,
    status: group.status,
    shipmentId: group.shipment?.id ?? null,
  })).sort((left, right) => left.warehouseId.localeCompare(right.warehouseId));
}

export function assertSingleCompatibility(ctx, order, expectedWarehouseId) {
  const groups = fulfillmentGroups(order);
  ctx.equal(groups.length, 1, "single Order has one Fulfillment");
  ctx.equal(groups[0].warehouseId, expectedWarehouseId, "single Order Warehouse");
  ctx.ok(order.fulfillment && typeof order.fulfillment === "object", "single Order retains singular fulfillment");
  if (Array.isArray(order.fulfillments)) ctx.equal(order.fulfillments.length, 1, "single Order fulfillments[] compatibility");
}

export function assertSplitCompatibility(ctx, order, expectedWarehouseIds) {
  ctx.equal(order.fulfillment, null, "split Order singular fulfillment is null");
  ctx.ok(Array.isArray(order.fulfillments), "split Order exposes fulfillments[]");
  ctx.equal(new Set(order.fulfillments.map(({ warehouseId }) => warehouseId)), new Set(expectedWarehouseIds), "split Order Warehouse groups");
}

export async function captureReplay(ctx, operation, replay) {
  const shield = await ctx.responseShield(operation.baseUrl);
  shield.dropNextMutation();
  let disconnected = false;
  try { await operation.send(shield.baseUrl); } catch { disconnected = true; }
  ctx.ok(disconnected, `${operation.label} client observes unknown outcome`);
  const capture = shield.captures.find(({ dropped }) => dropped);
  ctx.ok(capture, `${operation.label} shield captured committed response`);
  const replayResponse = await replay();
  ctx.equal(replayResponse.status, capture.response.status, `${operation.label} replay status`);
  ctx.equal(canonicalJson(replayResponse.json), canonicalJson(JSON.parse(capture.response.body)), `${operation.label} replay body`);
  return replayResponse;
}

export function finalEvidence(ctx, values = {}) {
  return ctx.pass({ evidence: [{ kind: "case-summary", ...values }] });
}

export async function launchBrowser(ctx, baseUrl, options = {}) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  ctx.disposers.push(() => browser.close());
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  return { browser, context, page };
}

export async function clickByName(page, pattern) {
  const candidates = [page.getByRole("button", { name: pattern }), page.getByRole("link", { name: pattern })];
  for (const locator of candidates) if (await locator.count()) { await locator.first().click(); return; }
  throw new Error(`no visible control matching ${pattern}`);
}

export async function fillLabel(page, pattern, value) {
  const locator = page.getByLabel(pattern);
  if (!(await locator.count())) throw new Error(`no labelled input matching ${pattern}`);
  await locator.first().fill(String(value));
}

export function parseLastJsonLine(output) {
  const lines = String(output).trim().split(/\r?\n/u).reverse();
  for (const line of lines) { try { return JSON.parse(line); } catch {} }
  return undefined;
}

export function noSecretText(value) {
  const text = String(value);
  return !/postgres(?:ql)?:\/\/|authorization:\s*bearer|admin_token|(?:pf|parcelflow)-admin-[0-9a-f]{8}/iu.test(text);
}
