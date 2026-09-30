import assert from "node:assert/strict";
import { assertCoreInvariants, assertNoSecrets, resource } from "../oracles/index.mjs";
import { assertSettlement, settlementProjection } from '../oracles/economic-policy.mjs';
import { recoveryGateController, assertVisibleMinor } from './verification.mjs';
import { assertPublishedOpenApi, assertLiveSchema, assertSnapshotSchema } from "../oracles/openapi.mjs";
import { clickTestId, defineCase, guardedCase, launchBrowser, prepare, providerCallback, selectTestId, successful, waitSnapshot } from "./helpers.mjs";

const D01 = defineCase('D-01', async ctx => {
  const fixture = ctx.fixtures.main(), { api } = await prepare(ctx, fixture);
  const document = successful(await ctx.openApi(api.baseUrl)).json;
  assertPublishedOpenApi(document);
  const created = successful(await ctx.mutate(api.baseUrl, '/api/v1/orders/quotes', ctx.key('wire-quote'), ctx.fixtures.quoteBody(fixture)));
  assertLiveSchema(document, '/api/v1/orders/quotes', 'POST', created.status, created.json);
  const cancelled = successful(await ctx.mutate(api.baseUrl, `/api/v1/orders/${created.json.orderId}/cancel`, ctx.key('wire-cancel'), {}));
  assertLiveSchema(document, '/api/v1/orders/{orderId}/cancel', 'POST', cancelled.status, cancelled.json);
  const detail = successful(await ctx.request(api.baseUrl, `/api/v1/orders/${created.json.orderId}`));
  assertLiveSchema(document, '/api/v1/orders/{orderId}', 'GET', detail.status, detail.json);
  assert.equal(detail.json.state, 'CANCELLED');
  assertSnapshotSchema(await ctx.snapshot(api.baseUrl));
  return ctx.pass();
});

async function browserQuote(ctx, fixture, page) {
  await selectTestId(page, "tenant-select", fixture.tenant.tenantId);
  await selectTestId(page, "buyer-select", fixture.buyer.buyerId);
  await clickTestId(page, `product-${fixture.physical.productId}-add`);
  await clickTestId(page, `product-${fixture.digital.productId}-add`);
  await clickTestId(page, "create-quote");
  const orderIdLocator = page.getByTestId("order-id");
  await orderIdLocator.waitFor({ state: "visible" });
  await expectText(orderIdLocator, /^[0-9a-f-]{36}$/iu);
  const orderId = (await orderIdLocator.textContent()).trim();
  return orderId;
}

async function browserQuoteCheckout(ctx, fixture, page, api) {
  const orderId = await browserQuote(ctx, fixture, page);
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
  const [reloadResponse] = await Promise.all([
    page.waitForResponse(async response => response.request().method() === 'GET'
      && response.status() === 200 && Boolean(await orderFromBrowserRead(response, flow.orderId))),
    page.reload({ waitUntil: "networkidle" }),
  ]);
  const reloadedOrder = await orderFromBrowserRead(reloadResponse, flow.orderId);
  assert.equal(reloadedOrder.orderId, flow.orderId, "reload response retains server Order identity");
  assert.ok(['PAID', 'FULFILLING', 'FULFILLED'].includes(reloadedOrder.state), "reload observes captured Order state");
  const state = page.getByTestId("order-state");
  await waitForText(state, /PAID|FULFILLING|FULFILLED/iu);
  assert.equal((await page.getByTestId("order-id").textContent()).trim(), flow.orderId, "deep-link reload retains server Order identity");
  // The Worker may advance after this GET; compare the UI with the response it
  // actually rendered, then independently check the later snapshot invariants.
  const observedState = new RegExp(`^${reloadedOrder.state}$`, 'iu');
  const displayedState = await waitForText(state, observedState, undefined, async () => (await state.textContent()).trim());
  assert.match(displayedState, observedState, "browser state matches its reload response");
  const snapshot = await ctx.snapshot(api.baseUrl);
  const order = resource(snapshot, "orders").find(({ orderId }) => orderId === flow.orderId);
  assert.ok(order && ['PAID', 'FULFILLING', 'FULFILLED'].includes(order.state), "snapshot retains captured Order state");
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

const D04 = guardedCase('D-04', ['TRANSACTIONAL_EVIDENCE', 'COMMERCE_CONSERVATION'], async ctx => {
  const fixture = ctx.fixtures.marketplace();
  const { api, page } = await launchBrowser(ctx, fixture, { workers: 0 });
  const orderId = await browserQuote(ctx, fixture, page);
  const quoted = await ctx.snapshot(api.baseUrl);
  const order = resource(quoted, 'orders').find(row => row.orderId === orderId);
  const lines = resource(quoted, 'orderLines').filter(row => row.orderId === orderId);
  assert.equal(lines.length, 2, 'browser created mixed physical/digital lines');
  for (const [index, line] of lines.entries()) {
    await clickTestId(page, 'allocation-add-row');
    await selectTestId(page, `allocation-line-${index}`, line.orderLineId);
    await selectTestId(page, `allocation-seller-${index}`, fixture.sellers[index].sellerId);
    await page.getByTestId(`allocation-quantity-${index}`).fill(String(line.quantity));
    await page.getByTestId(`allocation-amount-minor-${index}`).fill(String(line.lineTotalMinor));
  }
  await clickTestId(page, 'seller-allocations-submit');
  const allocated = await waitSnapshot(ctx, api.baseUrl, snapshot => resource(snapshot, 'sellerAllocations').filter(row => row.orderId === orderId).length === lines.length);
  const allocations = resource(allocated, 'sellerAllocations').filter(row => row.orderId === orderId);
  for (const [index, line] of lines.entries()) {
    const allocation = allocations.find(row => row.orderLineId === line.orderLineId);
    assert.ok(allocation, 'UI allocation persisted for the selected line');
    assert.equal(allocation.sellerId, fixture.sellers[index].sellerId);
    assert.equal(allocation.quantity, line.quantity);
    assert.equal(allocation.amountMinor, line.lineTotalMinor);
    assert.equal(await page.getByTestId(`seller-allocation-${allocation.sellerAllocationId}`).isVisible(), true);
  }
  await clickTestId(page, 'checkout');
  const checked = await waitSnapshot(ctx, api.baseUrl, snapshot => resource(snapshot, 'paymentAttempts').some(row => row.orderId === orderId));
  const attempt = resource(checked, 'paymentAttempts').find(row => row.orderId === orderId);
  // External provider observation is a precondition; all marketplace mutations use visible controls.
  await providerCallback(ctx, api.baseUrl, attempt.providerRequestId, 'marketplace-browser-capture', 'CAPTURED', order.orderTotalMinor);
  await page.reload({ waitUntil: 'networkidle' });
  await waitForText(page.getByTestId('payment-state'), /CAPTURED/u);
  const seller = fixture.sellers[0];
  await selectTestId(page, 'settlement-seller', seller.sellerId);
  await page.getByTestId('settlement-period-start').fill(ctx.at({ days: 1 }));
  await page.getByTestId('settlement-period-end').fill(ctx.at({ days: 2 }));
  const currency = page.getByTestId('settlement-currency');
  if (await currency.evaluate(node => node.tagName === 'SELECT')) await currency.selectOption('USD');
  else await currency.fill('USD');
  await clickTestId(page, 'settlement-create');
  await waitForText(page.getByTestId('settlement-id'), /^[0-9a-f-]{36}$/iu);
  const settlementId = (await page.getByTestId('settlement-id').textContent()).trim();
  const beforeClose = await ctx.snapshot(api.baseUrl);
  const proposal = resource(beforeClose, 'sellerSettlements').find(row => row.sellerSettlementId === settlementId);
  assert.ok(proposal && proposal.sellerId === seller.sellerId, 'UI created a persisted selected-seller proposal');
  const expected = settlementProjection(beforeClose, proposal);
  await clickTestId(page, 'settlement-close');
  await waitForText(page.getByTestId('settlement-state'), /\bCLOSED\b/u);
  const closed = await ctx.snapshot(api.baseUrl);
  assertSettlement(resource(closed, 'sellerSettlements').find(row => row.sellerSettlementId === settlementId), expected);
  const verifyVisible = async () => {
    assert.equal((await page.getByTestId('settlement-id').textContent()).trim(), settlementId);
    for (const [field, testId] of Object.entries({ grossMinor: 'settlement-gross-minor', feeMinor: 'settlement-fee-minor', refundReserveMinor: 'settlement-refund-reserve-minor', disputeReserveMinor: 'settlement-dispute-reserve-minor', netMinor: 'settlement-net-minor' })) await assertVisibleMinor(page, testId, expected[field]);
    for (const id of expected.allocationIds) assert.equal(await page.getByTestId(`settlement-allocation-${id}`).isVisible(), true, 'frozen allocation is visible');
  };
  await verifyVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await waitForText(page.getByTestId('settlement-state'), /\bCLOSED\b/u);
  await verifyVisible();
  assertCoreInvariants(await ctx.snapshot(api.baseUrl));
  return ctx.pass({ evidence: [{ orderId, allocationIds: allocations.map(row => row.sellerAllocationId), settlementId, frozen: expected, reloaded: true, mutations: 'visible production controls' }] });
});

const D05 = defineCase("D-05", async (ctx) => {
  const fixture = ctx.fixtures.browser();
  const { api, page } = await launchBrowser(ctx, fixture, { workers: 0, viewport: { width: 390, height: 844 } });
  await selectTestId(page, 'tenant-select', fixture.tenant.tenantId);
  await page.getByTestId(`product-${fixture.physical.productId}-add`).waitFor({ state: 'visible' });
  const testIds = ["tenant-select", "buyer-select", `product-${fixture.physical.productId}-add`, "create-quote"];
  for (const testId of testIds) {
    const control = page.getByTestId(testId);
    assert.equal(await control.count(), 1, `mobile control ${testId}`);
    const named = control.and(page.getByLabel(/\S/u).or(page.getByRole('button', { name: /\S/u })));
    assert.ok(await named.count(), `${testId} has an accessible name`);
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

const D06 = guardedCase('D-06', ['TRANSACTIONAL_EVIDENCE', 'COMMERCE_CONSERVATION'], async ctx => {
  const fixture = ctx.fixtures.browser(), { api, page } = await launchBrowser(ctx, fixture, { workers: 0 });
  const flow = await browserQuoteCheckout(ctx, fixture, page, api);
  await providerCallback(ctx, api.baseUrl, flow.attempt.providerRequestId, 'cross-layer-capture', 'CAPTURED', flow.order.orderTotalMinor);
  await page.reload({ waitUntil: 'networkidle' });
  await waitForText(page.getByTestId('payment-state'), /CAPTURED/u);
  const second = await ctx.startApi();
  const compareLayers = async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const order = resource(snapshot, 'orders').find(row => row.orderId === flow.orderId);
    const detail = successful(await ctx.request(second.baseUrl, `/api/v1/orders/${flow.orderId}`));
    assert.deepEqual(detail.json, order, 'independent API Order exactly matches the persisted snapshot');
    assert.equal((await page.getByTestId('order-id').textContent()).trim(), order.orderId);
    await waitForText(page.getByTestId('order-state'), new RegExp(`\\b${order.state}\\b`, 'u'));
    for (const [field, testId] of Object.entries({ orderTotalMinor: 'order-total-minor', capturedMinor: 'order-captured-minor', refundedMinor: 'order-refunded-minor' })) await assertVisibleMinor(page, testId, order[field]);
    for (const [path, rows, id] of [['/api/v1/ledger', resource(snapshot, 'ledgerEntries'), 'ledgerEntryId'], ['/api/v1/events', snapshot.events, 'eventId'], ['/api/v1/notifications', resource(snapshot, 'notificationDeliveries'), 'notificationDeliveryId']]) {
      const response = successful(await ctx.request(second.baseUrl, `${path}?tenantId=${fixture.tenant.tenantId}`));
      assert(Array.isArray(response.json), `${path} returns the published resource array`);
      const byId = (a, b) => a[id] < b[id] ? -1 : a[id] > b[id] ? 1 : 0;
      assert.equal(new Set(response.json.map(row => row[id])).size, response.json.length, `${path} has no duplicate identities`);
      assert.deepEqual([...response.json].sort(byId), rows.filter(row => row.tenantId === fixture.tenant.tenantId).sort(byId), `${path} agrees with independently observed persistent state`);
    }
    assertCoreInvariants(snapshot);
    return order;
  };
  await compareLayers();
  await page.getByTestId('refund-amount').fill(String(flow.order.orderTotalMinor));
  await clickTestId(page, 'refund-submit');
  await waitForText(page.getByTestId('order-state'), /\bREFUNDED\b/u);
  await compareLayers();
  await page.reload({ waitUntil: 'networkidle' });
  await waitForText(page.getByTestId('order-state'), /\bREFUNDED\b/u);
  const final = await compareLayers();
  assert.equal(final.refundedMinor, final.capturedMinor);
  return ctx.pass({ evidence: [{ orderId: flow.orderId, state: final.state, capturedMinor: final.capturedMinor, refundedMinor: final.refundedMinor, apiCount: 2, reloaded: true }] });
});

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
  const rejectedController = await recoveryGateController(ctx, { reject: true });
  const recoverySensitivity = await ctx.npm('test:recovery', [], { allowFailure: true, timeoutMs: 180_000, env: rejectedController.env });
  assert(rejectedController.ledger.length > 0, 'recovery sensitivity actually reaches the rejecting public controller');
  assert.notEqual(recoverySensitivity.exitCode, 0, 'recovery gate detects a rejected barrier instead of silently bypassing it');
  return ctx.pass({ evidence: [...outputs, { rejectedRecoveryBarriers: rejectedController.ledger, rejectedBarrierObserved: true, rejectedBarrierExitCode: recoverySensitivity.exitCode }] });
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

async function orderFromBrowserRead(response, orderId) {
  const path = new URL(response.url()).pathname;
  if (![ `/api/v1/orders/${orderId}`, '/api/v1/orders', '/api/v1/verification-snapshot' ].includes(path)) return undefined;
  const body = await response.json();
  const rows = path === '/api/v1/orders' ? body : path === '/api/v1/verification-snapshot' ? body.resources?.orders : [body];
  return Array.isArray(rows) ? rows.find(row => row.orderId === orderId) : undefined;
}

async function waitForText(locator, pattern, timeoutMs = 30_000, readText = () => locator.textContent().catch(() => "")) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = (await readText()) ?? "";
    if (pattern.test(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`visible text did not match ${pattern}`);
}

async function expectText(locator, pattern) {
  const value = await waitForText(locator, pattern, undefined, async () => (await locator.textContent())?.trim() ?? "");
  assert.match(value, pattern);
}

export const D_CASES = Object.freeze([D01, D02, D03, D04, D05, D06, D07, D08]);
