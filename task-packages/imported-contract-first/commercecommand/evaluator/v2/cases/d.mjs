import assert from "node:assert/strict";
import { assertCoreInvariants, assertNoSecrets, resource } from "../oracles/index.mjs";
import { assertPublishedOpenApi } from "../oracles/openapi.mjs";
import { blockedCase, clickTestId, defineCase, diagnostic, guardedCase, launchBrowser, prepare, providerCallback, selectTestId, successful } from "./helpers.mjs";

const D01 = blockedCase("D-01", [["CC-D01-MANAGER-WIRE", "CC-GAP-02"], ["CC-D01-V1-WIRE", "CC-GAP-07"]]);

async function browserQuoteCheckout(ctx, fixture, page, api) {
  await selectTestId(page, "tenant-select", fixture.tenant.tenantId);
  await selectTestId(page, "buyer-select", fixture.buyer.buyerId);
  await clickTestId(page, `product-${fixture.physical.productId}-add`);
  await clickTestId(page, `product-${fixture.digital.productId}-add`);
  await clickTestId(page, "create-quote");
  const orderIdLocator = page.getByTestId("order-id");
  await orderIdLocator.waitFor({ state: "visible" });
  await expectText(orderIdLocator, /^[0-9a-f-]{36}$/iu);
  const orderId = (await orderIdLocator.textContent()).trim();
  await clickTestId(page, "checkout");
  const payment = page.getByTestId("payment-state");
  await payment.waitFor({ state: "visible" });
  await waitForText(payment, /UNKNOWN|PENDING/iu);
  const snapshot = await ctx.snapshot(api.baseUrl);
  const order = resource(snapshot, "orders").find((item) => item.orderId === orderId);
  const attempt = resource(snapshot, "paymentAttempts").find((item) => item.orderId === orderId);
  assert.ok(order && attempt, "browser checkout persisted Order and PaymentAttempt");
  return { orderId, order, attempt };
}

const D02 = guardedCase("D-02", ["TRANSACTIONAL_EVIDENCE", "COMMERCE_CONSERVATION"], async (ctx) => {
  const fixture = ctx.fixtures.browser();
  const { api, page } = await launchBrowser(ctx, fixture, { workers: 1 });
  const flow = await browserQuoteCheckout(ctx, fixture, page, api);
  await providerCallback(ctx, api.baseUrl, flow.attempt.providerRequestId, "browser-capture", "CAPTURED", flow.order.orderTotalMinor);
  await page.reload({ waitUntil: "networkidle" });
  const state = page.getByTestId("order-state");
  await waitForText(state, /PAID|FULFILLING|FULFILLED/iu);
  assert.equal((await page.getByTestId("order-id").textContent()).trim(), flow.orderId, "deep-link reload retains server Order identity");
  const snapshot = await ctx.snapshot(api.baseUrl);
  const order = resource(snapshot, "orders").find(({ orderId }) => orderId === flow.orderId);
  assert.match((await state.textContent()).trim(), new RegExp(order.state, "iu"), "browser state matches server state");
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ orderId: flow.orderId, state: order.state, reloaded: true }] });
});

const D03 = guardedCase("D-03", ["TRANSACTIONAL_EVIDENCE", "COMMERCE_CONSERVATION"], async (ctx) => {
  const fixture = ctx.fixtures.browser();
  const { api, page } = await launchBrowser(ctx, fixture, { workers: 2 });
  const flow = await browserQuoteCheckout(ctx, fixture, page, api);
  await providerCallback(ctx, api.baseUrl, flow.attempt.providerRequestId, "browser-refund-capture", "CAPTURED", flow.order.orderTotalMinor);
  await page.reload({ waitUntil: "networkidle" });
  await waitForText(page.getByTestId("order-state"), /PAID|FULFILLING|FULFILLED/iu);
  const refundAmount = page.getByTestId("refund-amount");
  await refundAmount.fill(String(flow.order.orderTotalMinor));
  await clickTestId(page, "refund-submit");
  await waitForText(page.getByTestId("order-state"), /REFUNDED/iu);
  await page.reload({ waitUntil: "networkidle" });
  await waitForText(page.getByTestId("order-state"), /REFUNDED/iu);
  const snapshot = await ctx.snapshot(api.baseUrl);
  const order = resource(snapshot, "orders").find(({ orderId }) => orderId === flow.orderId);
  assert.equal(order.state, "REFUNDED", "UI full refund reaches server terminal state");
  assert.equal(order.refundedMinor, order.capturedMinor, "UI refund amount matches capture");
  assert.ok(resource(snapshot, "ledgerEntries").filter(({ orderId }) => orderId === flow.orderId).length >= 4, "capture and refund balanced journals visible");
  assert.ok(snapshot.events.filter(({ aggregateId }) => aggregateId === flow.orderId).length >= 3, "quote capture refund Events visible");
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ orderId: flow.orderId, refundedMinor: order.refundedMinor, reloaded: true }] });
});

const D04 = blockedCase("D-04", [["CC-D04-MANAGER-WIRE", "CC-GAP-02"], ["CC-D04-SETTLEMENT-FORMULA", "CC-GAP-10"]]);

const D05 = defineCase("D-05", async (ctx) => {
  const fixture = ctx.fixtures.browser();
  const { api, page } = await launchBrowser(ctx, fixture, { workers: 0, viewport: { width: 390, height: 844 } });
  const testIds = ["tenant-select", "buyer-select", `product-${fixture.physical.productId}-add`, "create-quote"];
  for (const testId of testIds) {
    const control = page.getByTestId(testId);
    assert.equal(await control.count(), 1, `mobile control ${testId}`);
    const accessibleName = await control.getAttribute("aria-label") ?? await control.textContent();
    assert.ok(accessibleName?.trim(), `${testId} has an accessible name`);
  }
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement !== document.body), true, "keyboard focus enters visible controls");
  const html = await page.content();
  assertNoSecrets(html, [ctx.adminToken]);
  const scripts = await page.locator("script[src]").evaluateAll((nodes) => nodes.map((node) => node.src));
  for (const url of scripts) {
    const asset = await ctx.request(api.baseUrl, new URL(url).pathname);
    assert.equal(asset.status, 200, "production bundle asset");
    assertNoSecrets(asset.text, [ctx.adminToken]);
  }
  await page.context().setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  const visibleState = await page.locator("body").innerText();
  assert.match(visibleState, /offline|retry|network|unavailable/iu, "offline state is visible");
  await page.context().setOffline(false);
  return ctx.pass({ evidence: [{ viewport: "390x844", keyboard: true, offlineState: true, bundleCount: scripts.length }] });
});

const D06 = blockedCase("D-06", [["CC-D06-MANAGER-WIRE", "CC-GAP-02"], ["CC-D06-FINAL-SEED", "CC-GAP-05"], ["CC-D06-V1-WIRE", "CC-GAP-07"], ["CC-D06-SETTLEMENT-FORMULA", "CC-GAP-10"]]);

const D07 = defineCase("D-07", async (ctx) => {
  const gates = ["test:unit", "test:integration", "test:e2e", "test:concurrency", "test:recovery", "test:perf", "test:all"];
  const outputs = [];
  for (const gate of gates) {
    const result = await ctx.npm(gate, [], { timeoutMs: gate === "test:perf" ? 3_600_000 : 900_000, env: gate === "test:perf" ? { BENCH_PERF_SCALE: 1 } : undefined });
    assert.equal(result.exitCode, 0, `${gate} succeeds`);
    assert.match(`${result.stdout}\n${result.stderr}`, /test|pass|scenario|operation|request|assert|chromium|postgres|worker|api/iu, `${gate} emits execution evidence`);
    outputs.push({ gate, durationMs: Math.round(result.durationMs) });
  }
  const sensitivity = await ctx.npm("test:integration", [], { allowFailure: true, timeoutMs: 180_000, env: { DATABASE_URL: "postgresql://127.0.0.1:1/definitely_unavailable" } });
  assert.notEqual(sensitivity.exitCode, 0, "integration gate detects a broken PostgreSQL seam");
  return ctx.pass({ diagnostics: [diagnostic("CC-D07-RECOVERY-BARRIER", "CC-GAP-04")], evidence: outputs });
});

const D08 = defineCase("D-08", async (ctx) => {
  const fixture = ctx.fixtures.main();
  const { api } = await prepare(ctx, fixture);
  const openapi = successful(await ctx.openApi(api.baseUrl), "OpenAPI", [200]);
  assertPublishedOpenApi(openapi.json, { exactBodies: true });
  const body = ctx.fixtures.mixedQuoteBody(fixture);
  const created = successful(await ctx.mutate(api.baseUrl, "/api/v1/orders/quotes", ctx.key("closure:quote"), body), "closure quote", [201]);
  const orderId = created.json.orderId;
  const checked = successful(await ctx.mutate(api.baseUrl, `/api/v1/orders/${orderId}/checkout`, ctx.key("closure:checkout"), { provider: "SANDBOX", providerRequestId: `provider-${ctx.key("closure")}` }), "closure checkout");
  const detail = successful(await ctx.request(api.baseUrl, `/api/v1/orders/${orderId}`), "Order detail", [200]);
  const snapshot = await ctx.snapshot(api.baseUrl);
  const order = resource(snapshot, "orders").find((item) => item.orderId === orderId);
  assert.ok(order, "snapshot Order");
  assert.ok(resource(snapshot, "orderLines").some((line) => line.orderId === orderId), "snapshot frozen lines");
  assert.ok(resource(snapshot, "inventoryHolds").some((hold) => resource(snapshot, "orderLines").some((line) => line.orderId === orderId && line.orderLineId === hold.orderLineId)), "snapshot physical hold");
  assert.ok(resource(snapshot, "paymentAttempts").some((attempt) => attempt.orderId === orderId), "snapshot PaymentAttempt");
  assert.ok(snapshot.events.some((event) => event.aggregateId === orderId), "snapshot Event");
  assert.ok(snapshot.work.some((work) => work.aggregateId === orderId || resource(snapshot, "paymentAttempts").some((attempt) => attempt.orderId === orderId && attempt.paymentAttemptId === work.aggregateId)), "snapshot Work");
  assert.ok(resource(snapshot, "notificationDeliveries").some((delivery) => delivery.orderId === orderId), "snapshot NotificationDelivery");
  assert.equal(detail.json.orderId, orderId, "detail and snapshot identity agree");
  assertCoreInvariants(snapshot);
  return ctx.pass({ evidence: [{ requirement: "mixed quote and checkout", httpStatus: [created.status, checked.status, detail.status], openapi: true, snapshot: true, orderId }] });
});

async function waitForText(locator, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = (await locator.textContent().catch(() => "")) ?? "";
    if (pattern.test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`visible text did not match ${pattern}`);
}

async function expectText(locator, pattern) {
  const value = (await locator.textContent())?.trim() ?? "";
  assert.match(value, pattern);
}

export const D_CASES = Object.freeze([D01, D02, D03, D04, D05, D06, D07, D08]);
