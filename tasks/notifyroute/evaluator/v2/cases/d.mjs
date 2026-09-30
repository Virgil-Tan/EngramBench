import { webhookSignature } from "../oracles/index.mjs";
import {
  NOTIFICATION_KEYS,
  assertInvariants,
  assertNoChange,
  blockedCase,
  clickControl,
  coreNotification,
  createNotification,
  exactKeys,
  expectError,
  finalEvidence,
  guardedCase,
  launchBrowser,
  prepare,
  providerReceiver,
  receipt,
  resource,
  scriptedSeed,
  setField,
  waitDelivery,
} from "./helpers.mjs";

const d01 = guardedCase({
  id: "D-01", fixtureFamily: "NR-F-V1-HTTP-CONTRACT",
  action: "Exercise runtime Notification create/read/list, unknown input, malformed cursor and cross-tenant references through two public API processes while parsing canonical OpenAPI.",
  oracle: "Closed V1 shapes, exact error envelopes, stable cursor ordering and tenant ownership must match runtime and every rejected read or mutation has zero durable effects.",
  async run(ctx) {
    const provider = await providerReceiver(ctx, () => ({ status: 204 }));
    const { seed } = scriptedSeed(ctx, provider);
    const otherTenant = { tenantId: ctx.uuid("other-tenant"), name: "Other Tenant", createdAt: ctx.at({ days: -2 }) };
    seed.tenants.push(otherTenant);
    seed.recipients[1] = { ...seed.recipients[1], tenantId: otherTenant.tenantId };
    const target = await prepare(ctx, { seed });
    const apis = [await target.startApi(), await target.startApi()];
    const openapi = await ctx.request(apis[0].baseUrl, "/openapi.json");
    ctx.equal(openapi.status, 200, "canonical OpenAPI status");
    for (const path of ["/api/v1/notifications", "/api/v1/notifications/{notificationId}", "/api/v1/recipients/{recipientId}/unsubscribe", "/api/v1/provider/receipts"]) ctx.ok(openapi.json?.paths?.[path], `OpenAPI path ${path}`);
    const created = (await createNotification(ctx, apis[0].baseUrl, coreNotification(ctx, seed))).notification;
    exactKeys(created, NOTIFICATION_KEYS, "runtime Notification");
    const read = await ctx.request(apis[1].baseUrl, `/api/v1/notifications/${created.notificationId}`);
    ctx.equal({ status: read.status, json: read.json }, { status: 200, json: created }, "cross-process exact Notification read");

    const before = await ctx.snapshot(apis[0].baseUrl);
    const unknown = await createNotification(ctx, apis[1].baseUrl, { ...coreNotification(ctx, seed, { dedupeKey: ctx.key("unknown-field") }), unexpected: true }, { allowFailure: true });
    ctx.equal(unknown.status, 400, "unknown Notification field status");
    exactKeys(unknown.json, ["error"], "unknown field error envelope");
    const crossTenant = await createNotification(ctx, apis[1].baseUrl, { ...coreNotification(ctx, seed, { recipientId: seed.recipients[1].recipientId, dedupeKey: ctx.key("cross-tenant") }), tenantId: seed.tenants[0].tenantId }, { allowFailure: true });
    expectError(ctx, crossTenant, 400, "INVALID_REQUEST", "cross-tenant Notification");
    assertNoChange(ctx, before, await ctx.snapshot(apis[0].baseUrl), "invalid HTTP mutations");

    const page1 = await ctx.request(apis[0].baseUrl, "/api/v1/notifications?limit=1");
    ctx.equal(page1.status, 200, "Notification collection status");
    exactKeys(page1.json, ["items", "nextCursor"], "Notification page");
    ctx.equal(page1.json.items, [created], "stable first Notification page");
    const malformed = await ctx.request(apis[0].baseUrl, "/api/v1/notifications?limit=1&cursor=not-opaque");
    expectError(ctx, malformed, 400, "INVALID_REQUEST", "malformed cursor");
    assertInvariants(ctx, await ctx.snapshot(apis[0].baseUrl));
    return finalEvidence(ctx, { openapiPaths: 4, apiProcesses: 2, pages: 1, rejectedMutations: 2 });
  },
});

const d02 = guardedCase({
  id: "D-02", fixtureFamily: "NR-F-WEBHOOK-HMAC-REPLAY",
  action: "Send one Delivery to a controlled Webhook with a fixed fixture secret, verify raw-body HMAC and stable identity headers, then submit duplicate Provider receipts.",
  oracle: "Only the exact raw bytes authenticate, a one-byte change fails independently, and receipt replay collapses to one ProviderReceipt without leaking the secret or raw body.",
  async run(ctx) {
    const receiver = await providerReceiver(ctx, () => ({ status: 204 }));
    const setup = scriptedSeed(ctx, receiver, { signingSecret: true });
    const api = await (await prepare(ctx, { seed: setup.seed })).startApi();
    const { notification } = await createNotification(ctx, api.baseUrl, coreNotification(ctx, setup.seed));
    const worker = await ctx.startWorker();
    let snapshot = await waitDelivery(ctx, api.baseUrl, notification.notificationId, ["ACCEPTED", "DELIVERED"], { timeoutMs: 60_000, processes: [worker] });
    await ctx.waitFor(() => receiver.ledger.length === 1, { timeoutMs: 60_000, label: "signed Webhook request", processes: [worker] });
    const call = receiver.ledger[0];
    const expected = webhookSignature(setup.script.signingSecret, call.raw);
    ctx.ok(Object.values(call.headers).includes(expected), "Webhook carries HMAC-SHA256 of exact raw body");
    ctx.ok(!Object.values(call.headers).includes(webhookSignature(setup.script.signingSecret, `${call.raw} `)), "one-byte raw body change has a different signature");
    const delivery = resource(snapshot, "deliveries").find(({ notificationId }) => notificationId === notification.notificationId);
    ctx.equal(call.headers["x-notifyroute-delivery-id"], delivery.deliveryId, "published Delivery identity header");
    ctx.ok(typeof call.headers["idempotency-key"] === "string" && call.headers["idempotency-key"].length > 0, "published stable Webhook idempotency header");
    const body = { channel: "WEBHOOK", providerEventId: setup.script.providerEventId, providerMessageId: setup.script.providerMessageId, deliveryId: delivery.deliveryId, outcome: "DELIVERED", occurredAt: ctx.at({ seconds: 20 }) };
    const first = await receipt(ctx, api.baseUrl, body, { allowFailure: true, key: ctx.key("signed-receipt-first") });
    const second = await receipt(ctx, api.baseUrl, body, { allowFailure: true, key: ctx.key("signed-receipt-second") });
    ctx.ok([200, 409].includes(first.status) && [200, 409].includes(second.status), "duplicate receipt has published result semantics");
    snapshot = await ctx.snapshot(api.baseUrl);
    ctx.ok(resource(snapshot, "providerReceipts").filter(({ providerEventId }) => providerEventId === body.providerEventId).length <= 1, "duplicate receipt collapses to one fact");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { signedCalls: 1, duplicateReceipts: 2, rawBodyBytes: Buffer.byteLength(call.raw) });
  },
});

const d03 = guardedCase({
  id: "D-03", fixtureFamily: "NR-F-PRODUCTION-BROWSER-FLOW",
  action: "Use visible desktop and mobile production controls to create a Notification, observe Provider UNKNOWN, unsubscribe, inspect terminal state and refresh against real HTTP data.",
  oracle: "Browser text and controls must reflect the same Notification, Delivery, suppression and receiver ledger as the public snapshot with keyboard focus and no client-only recovery.",
  async run(ctx) {
    const receiver = await providerReceiver(ctx, () => ({ disconnect: true }));
    const { seed } = scriptedSeed(ctx, receiver);
    const api = await (await prepare(ctx, { seed })).startApi();
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await clickControl(page, [/new notification/i, /create notification/i, /notifications/i]);
    await setField(page, /tenant/i, seed.tenants[0].tenantId);
    await setField(page, /recipient/i, seed.recipients[0].recipientId);
    await setField(page, /category/i, "OPERATIONS");
    await setField(page, /dedupe/i, ctx.key("browser-notification"));
    await setField(page, /template/i, seed.templateVersions[0].templateVersionId);
    await setField(page, /route policy/i, seed.routePolicies[0].routePolicyId);
    await setField(page, /data/i, JSON.stringify({ name: "Ada", code: "042" }));
    await clickControl(page, [/send notification/i, /create/i, /submit/i]);
    const notification = await ctx.waitFor(async () => resource(await ctx.snapshot(api.baseUrl), "notifications").find(({ dedupeKey }) => dedupeKey === ctx.key("browser-notification")), { timeoutMs: 30_000, label: "browser-created Notification" });
    const worker = await ctx.startWorker();
    let snapshot = await waitDelivery(ctx, api.baseUrl, notification.notificationId, "UNKNOWN", { timeoutMs: 60_000, processes: [worker] });
    ctx.ok(await page.getByText(/unknown/i).first().isVisible(), "desktop UI exposes Provider UNKNOWN");
    await clickControl(page, [/unsubscribe/i, /preferences/i]);
    await setField(page, /channel/i, "WEBHOOK");
    await setField(page, /category/i, notification.category);
    await setField(page, /reason/i, "browser consent fence");
    await clickControl(page, [/confirm unsubscribe/i, /unsubscribe/i, /save/i]);
    await ctx.waitFor(async () => resource(await ctx.snapshot(api.baseUrl), "suppressions").some(({ recipientId, state }) => recipientId === notification.recipientId && state === "ACTIVE"), { timeoutMs: 30_000, label: "browser suppression" });
    await page.reload({ waitUntil: "domcontentloaded" });
    ctx.ok(await page.getByText(notification.notificationId, { exact: false }).first().isVisible(), "Notification identity survives refresh");
    await page.setViewportSize({ width: 390, height: 844 });
    ctx.ok(await page.getByText(notification.notificationId, { exact: false }).first().isVisible(), "mobile viewport retains real Notification state");
    await page.keyboard.press("Tab");
    ctx.ok(await page.evaluate(() => document.activeElement?.tagName !== "BODY"), "keyboard focus enters a visible control");
    snapshot = await ctx.snapshot(api.baseUrl);
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { desktopViewport: true, mobileViewport: true, providerCalls: receiver.ledger.length, refresh: true });
  },
});

const d04 = blockedCase({
  id: "D-04", fixtureFamily: "NR-F-CAMPAIGN-BROWSER-CONTRACT",
  action: "Use Campaign create, progress, pause, resume and cancel controls only after their HTTP and resource shapes, reads and stable errors are published.",
  oracle: "Visible frozen audience progress must reconcile with an independent member ledger, but the evaluator will not invent a client or server state model.",
  assertionId: "campaign-browser-wire", blockedBy: "SPEC-GAP-NR-01",
});

export const D_CASES = Object.freeze([d01, d02, d03, d04]);
