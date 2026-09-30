import assert from "node:assert/strict";

import { baseSeed, notificationFixture, providerScript } from "../fixtures/index.mjs";
import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { assertEventLedger, canonicalJson } from "../oracles/index.mjs";

const builds = new Map();
export const RECIPIENT_KEYS = Object.freeze(["recipientId", "tenantId", "externalRef", "locale", "timeZone", "preferenceRevision", "createdAt"]);
export const ENDPOINT_KEYS = Object.freeze(["endpointId", "tenantId", "recipientId", "channel", "address", "state", "revision", "createdAt", "terminalAt"]);
export const TEMPLATE_VERSION_KEYS = Object.freeze(["templateVersionId", "templateId", "version", "channel", "subject", "body", "contentDigest", "createdAt"]);
export const ROUTE_POLICY_KEYS = Object.freeze(["routePolicyId", "tenantId", "name", "revision", "steps", "createdAt"]);
export const RATE_POLICY_KEYS = Object.freeze(["rateLimitPolicyId", "tenantId", "channel", "revision", "windowSeconds", "tenantLimit", "recipientLimit", "effectiveFrom"]);
export const NOTIFICATION_KEYS = Object.freeze(["notificationId", "tenantId", "recipientId", "category", "dedupeKey", "templateVersionId", "routePolicyId", "routePolicyRevision", "state", "data", "acceptedAt", "terminalAt", "sequence"]);
export const DELIVERY_KEYS = Object.freeze(["deliveryId", "notificationId", "endpointId", "channel", "routeOrdinal", "state", "attemptCount", "providerMessageId", "suppressionRevision", "nextAttemptAt", "createdAt", "terminalAt", "sequence"]);
export const ATTEMPT_KEYS = Object.freeze(["attemptId", "deliveryId", "attemptNumber", "providerRequestId", "outcome", "startedAt", "finishedAt"]);
export const SUPPRESSION_KEYS = Object.freeze(["suppressionId", "tenantId", "recipientId", "channel", "category", "state", "revision", "reason", "createdAt", "releasedAt"]);
export const RECEIPT_KEYS = Object.freeze(["providerReceiptId", "channel", "providerEventId", "providerMessageId", "deliveryId", "outcome", "occurredAt", "receivedAt"]);
export const WORK_KEYS = Object.freeze(["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"]);
export const V1_RESOURCE_KEYS = Object.freeze(["tenants", "recipients", "channelEndpoints", "templates", "templateVersions", "routePolicies", "rateLimitPolicies", "notifications", "deliveries", "deliveryAttempts", "suppressions", "providerReceipts"]);
export const RESOURCE_KEYS = Object.freeze([...V1_RESOURCE_KEYS, "campaigns", "campaignRecipients"]);
export const EVENT_TYPES = Object.freeze(["notification.accepted", "notification.terminal", "delivery.suppressed", "delivery.accepted", "delivery.delivered", "delivery.failed", "delivery.unknown", "recipient.unsubscribed"]);

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !/^NR-F-/u.test(fixtureFamily ?? "") || action?.length < 24 || oracle?.length < 24 || typeof run !== "function") throw new TypeError("invalid NotifyRoute case definition");
  return Object.freeze({ taskId: "notifyroute", id, fixtureFamily, action, oracle, run });
}

export function blockedCase({ id, fixtureFamily, action, oracle, assertionId, blockedBy }) {
  return defineCase({ id, fixtureFamily, action, oracle, async run(ctx) {
    ctx.mark("contract-gap", { assertionId, blockedBy });
    return ctx.pass({ diagnostics: [ctx.diagnostic(assertionId, blockedBy)], evidence: [{ kind: "notifyroute-contract-gap", assertionId, blockedBy }] });
  } });
}

export function guardedCase(definition) {
  return defineCase({ ...definition, async run(ctx) { return definition.run(ctx); } });
}

export function exactKeys(value, keys, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`); return value; }
export function expectStatus(ctx, response, status, label, options = {}) { ctx.equal(response.status, status, `${label} status`, options); return response.json; }
export function expectSuccess(ctx, response, status, label) { expectStatus(ctx, response, status, label); ctx.ok(response.json && typeof response.json === "object", `${label} JSON`); return response.json; }
export function expectError(ctx, response, status, code, label, options = {}) {
  expectStatus(ctx, response, status, label, options);
  exactKeys(response.json, ["error"], `${label} envelope`);
  exactKeys(response.json.error, ["code", "message", "details"], `${label} error`);
  ctx.equal(response.json.error.code, code, `${label} code`, options);
  return response.json.error;
}

export function clone(value) { return structuredClone(value); }
export function resource(snapshot, key) { const value = snapshot?.resources?.[key]; assert.ok(Array.isArray(value), `snapshot resource ${key}`); return value; }
export function stableSnapshot(snapshot) { return { resources: clone(snapshot.resources), work: clone(snapshot.work), events: clone(snapshot.events) }; }
export function assertNoChange(ctx, before, after, label, hardCapIds = []) { ctx.equal(stableSnapshot(after), stableSnapshot(before), `${label} has zero durable effects`, { hardCapIds }); }

async function build(ctx, workspace) {
  const target = ctx.forWorkspace(workspace);
  if (!builds.has(target.workspace)) builds.set(target.workspace, target.npm("build", [], { timeoutMs: 600_000 }));
  await builds.get(target.workspace);
}

export async function prepare(ctx, options = {}) {
  const target = ctx.forWorkspace(options.workspace ?? ctx.workspace);
  if (options.build !== false) await build(ctx, target.workspace);
  if (options.migrate !== false) await target.migrate({ timeoutMs: options.migrateTimeoutMs ?? 300_000 });
  if (options.seed) await target.seed(options.seed, { timeoutMs: options.seedTimeoutMs ?? 600_000 });
  return target;
}

export async function startPreparedApi(ctx, options = {}) { return (await prepare(ctx, options)).startApi(options.api ?? {}); }
export function coreSeed(ctx, options = {}) { return baseSeed(ctx.fixtures, options); }
export function coreNotification(ctx, seed, options = {}) { return notificationFixture(ctx.fixtures, { recipientId: seed.recipients[0].recipientId, templateVersionId: seed.templateVersions[0].templateVersionId, routePolicyId: seed.routePolicies[0].routePolicyId, ...options }); }

export async function createNotification(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/notifications", options.key ?? ctx.key(`notification-${body.dedupeKey}`), body);
  if (options.allowFailure) return response;
  const notification = expectSuccess(ctx, response, options.status ?? 200, options.label ?? "create Notification");
  exactKeys(notification, NOTIFICATION_KEYS, "Notification");
  return { response, notification };
}

export async function readNotification(ctx, baseUrl, notificationId) {
  const response = await ctx.request(baseUrl, `/api/v1/notifications/${notificationId}`);
  const notification = expectSuccess(ctx, response, 200, "read Notification");
  exactKeys(notification, NOTIFICATION_KEYS, "Notification read");
  return notification;
}

export async function cancelNotification(ctx, baseUrl, notificationId, reason, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/notifications/${notificationId}/cancel`, options.key ?? ctx.key(`cancel-${notificationId}`), { reason });
  if (options.allowFailure) return response;
  const notification = expectSuccess(ctx, response, 200, "cancel Notification");
  exactKeys(notification, NOTIFICATION_KEYS, "cancelled Notification");
  return { response, notification };
}

export async function unsubscribe(ctx, baseUrl, recipientId, body, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/recipients/${recipientId}/unsubscribe`, options.key ?? ctx.key(`unsubscribe-${recipientId}-${body.channel}-${body.category ?? "all"}`), body);
  if (options.allowFailure) return response;
  const suppression = expectSuccess(ctx, response, 200, "unsubscribe Recipient");
  exactKeys(suppression, SUPPRESSION_KEYS, "Suppression");
  return { response, suppression };
}

export async function receipt(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/provider/receipts", options.key ?? ctx.key(`receipt-${body.providerEventId}`), body);
  if (options.allowFailure) return response;
  const value = expectSuccess(ctx, response, 200, "Provider receipt");
  exactKeys(value, RECEIPT_KEYS, "ProviderReceipt");
  return { response, receipt: value };
}

export async function reconcile(ctx, baseUrl, deliveryId, body, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/deliveries/${deliveryId}/reconcile`, options.key ?? ctx.key(`reconcile-${deliveryId}-${body.outcome}`), body);
  if (options.allowFailure) return response;
  const delivery = expectSuccess(ctx, response, 200, "reconcile Delivery");
  exactKeys(delivery, DELIVERY_KEYS, "reconciled Delivery");
  return { response, delivery };
}

export async function waitSnapshot(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); return predicate(snapshot) ? snapshot : false; }, { timeoutMs: options.timeoutMs ?? 90_000, intervalMs: options.intervalMs ?? 20, label: options.label ?? "NotifyRoute snapshot state", processes: options.processes });
}

export async function waitDelivery(ctx, baseUrl, notificationId, states, options = {}) {
  const allowed = new Set(Array.isArray(states) ? states : [states]);
  return waitSnapshot(ctx, baseUrl, (snapshot) => resource(snapshot, "deliveries").some(({ notificationId: id, state }) => id === notificationId && allowed.has(state)), options);
}

export function assertInvariants(ctx, snapshot) {
  ctx.equal(Object.keys(snapshot.resources).sort(), [...RESOURCE_KEYS].sort(), "exact V1 resource union");
  for (const value of resource(snapshot, "recipients")) exactKeys(value, RECIPIENT_KEYS, "Recipient");
  for (const value of resource(snapshot, "channelEndpoints")) exactKeys(value, ENDPOINT_KEYS, "ChannelEndpoint");
  for (const value of resource(snapshot, "templateVersions")) exactKeys(value, TEMPLATE_VERSION_KEYS, "TemplateVersion");
  for (const value of resource(snapshot, "routePolicies")) exactKeys(value, ROUTE_POLICY_KEYS, "RoutePolicy");
  for (const value of resource(snapshot, "rateLimitPolicies")) exactKeys(value, RATE_POLICY_KEYS, "RateLimitPolicy");
  for (const value of resource(snapshot, "notifications")) exactKeys(value, NOTIFICATION_KEYS, "Notification");
  for (const value of resource(snapshot, "deliveries")) exactKeys(value, DELIVERY_KEYS, "Delivery");
  for (const value of resource(snapshot, "deliveryAttempts")) exactKeys(value, ATTEMPT_KEYS, "DeliveryAttempt");
  for (const value of resource(snapshot, "suppressions")) exactKeys(value, SUPPRESSION_KEYS, "Suppression");
  for (const value of resource(snapshot, "providerReceipts")) exactKeys(value, RECEIPT_KEYS, "ProviderReceipt");
  const deliveryKeys = resource(snapshot, "deliveries").map(({ notificationId, endpointId, routeOrdinal }) => `${notificationId}\0${endpointId}\0${routeOrdinal}`);
  ctx.equal(new Set(deliveryKeys).size, deliveryKeys.length, "one Delivery per frozen route step and endpoint", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
  const providerIds = resource(snapshot, "deliveryAttempts").reduce((map, attempt) => {
    const values = map.get(attempt.deliveryId) ?? new Set(); values.add(attempt.providerRequestId); map.set(attempt.deliveryId, values); return map;
  }, new Map());
  ctx.ok([...providerIds.values()].every((values) => values.size === 1), "one providerRequestId per Delivery", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
  for (const work of snapshot.work ?? []) {
    exactKeys(work, WORK_KEYS, "Work");
    ctx.ok(["NOTIFICATION_ROUTE", "DELIVERY_SEND", "DELIVERY_RECONCILE", "CAMPAIGN_FANOUT"].includes(work.kind), "FINAL Work kind");
    ctx.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state), "Work terminal flag");
  }
  try { assertEventLedger(snapshot.events ?? []); }
  catch (error) { throw new CaseFailure(error.message, { failureCodeSuffix: "EVENT_LEDGER", hardCapIds: ["CORRECTNESS_INVARIANT"] }); }
  ctx.ok((snapshot.events ?? []).every(({ type }) => EVENT_TYPES.includes(type)), "no unpublished Domain Event name");
  ctx.ok(!/(?:signingSecret|authorization|idempotencyKey|providerCredential|postgres(?:ql)?:\/\/|\/Users\/|\/tmp\/)/iu.test(canonicalJson(snapshot)), "snapshot redacts credentials and private paths");
}

export async function providerReceiver(ctx, behavior) { return ctx.receiver({ path: "/events", behavior }); }
export function scriptedSeed(ctx, receiver, options = {}) {
  const script = providerScript(ctx.fixtures, options);
  const seed = coreSeed(ctx, { webhookUrl: receiver.url, templateChannel: "WEBHOOK", routeSteps: options.routeSteps ?? [{ ordinal: 1, channel: "WEBHOOK", delaySeconds: 0, maxAttempts: 2, baseRetrySeconds: 1 }], tenantLimit: options.tenantLimit, recipientLimit: options.recipientLimit });
  if (options.signingSecret) seed.channelEndpoints.find(({ channel }) => channel === "WEBHOOK").signingSecret = script.signingSecret;
  return { seed, script };
}

export async function launchBrowser(ctx, baseUrl, viewport = { width: 1280, height: 800 }) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  ctx.defer(() => browser.close());
  const browserContext = await browser.newContext({ viewport });
  const page = await browserContext.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return { browser, browserContext, page };
}

async function visible(locator) { for (let index = 0; index < await locator.count(); index += 1) { const item = locator.nth(index); if (await item.isVisible().catch(() => false)) return item; } }
export async function clickControl(page, names) { for (const role of ["button", "link"]) for (const name of names) { const item = await visible(page.getByRole(role, { name })); if (item) { await item.click(); return; } } throw new Error(`missing visible control ${String(names)}`); }
export async function setField(page, label, value, ordinal = 0) { const item = page.getByLabel(label).nth(ordinal); const tag = await item.evaluate((element) => element.tagName.toLowerCase()); if (tag === "select") await item.selectOption(String(value)); else await item.fill(String(value)); }

export function requireV1(ctx) { if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint"); return ctx.v1Workspace; }
export function finalEvidence(ctx, values = {}) { return ctx.pass({ evidence: [{ kind: "notifyroute-case-summary", ...values }] }); }
