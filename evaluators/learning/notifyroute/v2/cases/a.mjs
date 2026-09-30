import { campaignFreezeScenario } from "./current-system.mjs";
import { consumeRate, nextWindow, projectRoute, renderTemplate } from "../oracles/index.mjs";
import {
  assertInvariants,
  assertNoChange,
  coreNotification,
  createNotification,
  expectError,
  finalEvidence,
  guardedCase,
  providerReceiver,
  prepare,
  readNotification,
  receipt,
  reconcile,
  resource,
  scriptedSeed,
  startPreparedApi,
  unsubscribe,
  waitDelivery,
  waitSnapshot,
} from "./helpers.mjs";

const a01 = guardedCase({
  id: "A-01", fixtureFamily: "NR-F-FROZEN-NOTIFICATION",
  action: "Create valid and invalid Notifications through public HTTP, publish later Template and RoutePolicy revisions, drive the real Worker, and read the frozen aggregate.",
  oracle: "Evaluator rendering and ordered-route models require the accepted TemplateVersion, canonical data and policy revision to remain exact with zero invalid-request effects.",
  async run(ctx) {
    const receiver = await providerReceiver(ctx, () => ({ status: 204 }));
    const { seed } = scriptedSeed(ctx, receiver);
    const api = await startPreparedApi(ctx, { seed });
    const request = coreNotification(ctx, seed);
    const template = seed.templateVersions[0];
    ctx.equal(renderTemplate(template, request.data), { subject: "Hello Ada", body: "Code 042" }, "independent frozen render");
    const beforeInvalid = await ctx.snapshot(api.baseUrl);
    const invalid = await createNotification(ctx, api.baseUrl, { ...request, data: { name: "Ada" }, dedupeKey: ctx.key("unknown-render-variable") }, { allowFailure: true });
    expectError(ctx, invalid, 400, "TEMPLATE_RENDER_INVALID", "unknown variable for literal template");
    assertNoChange(ctx, beforeInvalid, await ctx.snapshot(api.baseUrl), "invalid rendering rejection");
    const { notification } = await createNotification(ctx, api.baseUrl, request);
    ctx.equal({ templateVersionId: notification.templateVersionId, routePolicyId: notification.routePolicyId, routePolicyRevision: notification.routePolicyRevision, data: notification.data }, {
      templateVersionId: template.templateVersionId, routePolicyId: seed.routePolicies[0].routePolicyId, routePolicyRevision: 1, data: request.data,
    }, "accepted frozen inputs");
    const laterTemplate = await ctx.mutate(api.baseUrl, "/api/v1/template-versions", ctx.key("later-template-version"), { templateId: template.templateId, version: 3, channel: "WEBHOOK", subject: "Later Ada", body: "Later 042" });
    ctx.equal(laterTemplate.status, 200, "later TemplateVersion is published through HTTP");
    const laterPolicy = await ctx.mutate(api.baseUrl, "/api/v1/route-policies", ctx.key("later-route-policy"), { tenantId: seed.tenants[0].tenantId, name: "Later policy", revision: 2, steps: [{ ordinal: 1, channel: "WEBHOOK", delaySeconds: 5, maxAttempts: 1, baseRetrySeconds: 2 }] });
    ctx.equal(laterPolicy.status, 200, "later RoutePolicy is published through HTTP");
    ctx.equal(await readNotification(ctx, api.baseUrl, notification.notificationId), notification, "later revisions cannot rewrite accepted Notification");
    const worker = await ctx.startWorker();
    await ctx.waitFor(() => receiver.ledger.length > 0, { timeoutMs: 60_000, label: "frozen rendered Provider call", processes: [worker] });
    ctx.ok(receiver.ledger[0].raw.includes("Hello Ada") && receiver.ledger[0].raw.includes("Code 042"), "Provider body uses frozen rendering");
    ctx.ok(!receiver.ledger[0].raw.includes("Later"), "later content never drains into accepted Notification");
    const snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => resource(value, "notifications").find(({ notificationId }) => notificationId === notification.notificationId)?.terminalAt !== null, { timeoutMs: 60_000, processes: [worker] });
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { invalidRequests: 1, frozenTemplateVersion: template.version, providerCalls: receiver.ledger.length, scope: "literal template strict data rejection and frozen rendering" });
  },
});

const a02 = guardedCase({
  id: "A-02", fixtureFamily: "NR-F-SUPPRESSION-BEFORE-SEND",
  action: "Accept a Webhook Notification, commit a channel and category unsubscribe through another API process, and only then start the real send Worker and receiver.",
  oracle: "A monotonic suppression revision makes the Delivery SUPPRESSED with zero receiver calls and forbids retry or fallback after the committed consent fence.",
  async run(ctx) {
    const receiver = await providerReceiver(ctx, () => ({ status: 204 }));
    const { seed } = scriptedSeed(ctx, receiver);
    const target = await prepare(ctx, { seed });
    const apis = [await target.startApi(), await target.startApi()];
    const { notification } = await createNotification(ctx, apis[0].baseUrl, coreNotification(ctx, seed));
    const { suppression } = await unsubscribe(ctx, apis[1].baseUrl, seed.recipients[0].recipientId, { channel: "WEBHOOK", category: notification.category, reason: "recipient request", expectedPreferenceRevision: seed.recipients[0].preferenceRevision });
    const worker = await ctx.startWorker();
    const snapshot = await waitDelivery(ctx, apis[0].baseUrl, notification.notificationId, "SUPPRESSED", { timeoutMs: 60_000, processes: [worker] });
    ctx.equal(receiver.ledger.length, 0, "suppression commits before every Provider call", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
    const delivery = resource(snapshot, "deliveries").find(({ notificationId }) => notificationId === notification.notificationId);
    ctx.equal(delivery.suppressionRevision, suppression.revision, "Delivery records current suppression revision");
    ctx.equal(resource(snapshot, "deliveries").filter(({ notificationId }) => notificationId === notification.notificationId).length, 1, "suppressed route never falls back");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { apiProcesses: 2, suppressionRevision: suppression.revision, providerCalls: 0 });
  },
});

const a03 = guardedCase({
  id: "A-03", fixtureFamily: "NR-F-RATE-WINDOW-FALLBACK",
  action: "Accept three Notifications for one recipient, run two Workers against one database and a controlled failing receiver, then inspect rate-limited Work and ordered fallback.",
  oracle: "An epoch-window token model permits one logical recipient notification, preserves tenant bounds and makes only a terminally failed frozen step eligible for the next ordinal.",
  async run(ctx) {
    const receiver = await providerReceiver(ctx, (entry) => ({ status: entry.attempt === 1 ? 500 : 204 }));
    const routeSteps = [
      { ordinal: 1, channel: "WEBHOOK", delaySeconds: 0, maxAttempts: 1, baseRetrySeconds: 1 },
      { ordinal: 2, channel: "WEBHOOK", delaySeconds: 0, maxAttempts: 1, baseRetrySeconds: 1 },
    ];
    const { seed } = scriptedSeed(ctx, receiver, { routeSteps, tenantLimit: 2, recipientLimit: 1 });
    const api = await startPreparedApi(ctx, { seed });
    const notifications = [];
    for (let index = 0; index < 3; index += 1) notifications.push((await createNotification(ctx, api.baseUrl, coreNotification(ctx, seed, { dedupeKey: ctx.key(`rate-${index}`) }))).notification);
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => resource(value, "deliveries").filter(({ state }) => state === "RATE_LIMITED").length >= 2 && receiver.ledger.length >= 2
      && resource(value, "deliveries").some(({ notificationId, state }) => notificationId === notifications[0].notificationId && ["ACCEPTED", "DELIVERED"].includes(state)), { timeoutMs: 60_000, processes: workers });
    assertFallbackOrder(ctx, routeSteps, resource(snapshot, "deliveries"), notifications[0].notificationId, receiver.ledger);
    const limited = resource(snapshot, "deliveries").filter(({ state }) => state === "RATE_LIMITED");
    ctx.ok(limited.every(({ nextAttemptAt }) => nextAttemptAt === nextWindow(new Date(Date.parse(nextAttemptAt) - 1).toISOString(), 60)), "rate limit uses exact UTC epoch boundary");
    const model = consumeRate(seed.rateLimitPolicies.find(({ channel }) => channel === "WEBHOOK"), [{ tenantId: seed.tenants[0].tenantId, recipientId: seed.recipients[0].recipientId, channel: "WEBHOOK", notificationId: notifications[0].notificationId, at: notifications[0].acceptedAt }], { tenantId: seed.tenants[0].tenantId, recipientId: seed.recipients[0].recipientId, channel: "WEBHOOK", notificationId: notifications[1].notificationId, at: notifications[1].acceptedAt });
    ctx.equal(model.allowed, false, "independent recipient quota denies second logical Notification");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { workers: 2, notifications: 3, providerCalls: receiver.ledger.length, rateLimited: limited.length });
  },
});

async function resolveUnknown(ctx, api, seed, receiver, suffix, order) {
  const { notification } = await createNotification(ctx, api.baseUrl, coreNotification(ctx, seed, { dedupeKey: ctx.key(`unknown-${suffix}`) }));
  const worker = await ctx.startWorker();
  let snapshot = await waitDelivery(ctx, api.baseUrl, notification.notificationId, "UNKNOWN", { timeoutMs: 60_000, processes: [worker] });
  await ctx.kill(worker);
  const delivery = resource(snapshot, "deliveries").find(({ notificationId }) => notificationId === notification.notificationId);
  const attempt = resource(snapshot, "deliveryAttempts").find(({ deliveryId }) => deliveryId === delivery.deliveryId);
  const messageId = `message-${suffix}`;
  const receiptBody = { channel: "WEBHOOK", providerEventId: `event-${suffix}`, providerMessageId: messageId, deliveryId: delivery.deliveryId, outcome: "DELIVERED", occurredAt: ctx.at({ seconds: 10 }) };
  const reconcileBody = {};
  for (const action of order) {
    const response = action === "receipt" ? await receipt(ctx, api.baseUrl, receiptBody, { allowFailure: true, key: ctx.key(`${suffix}-receipt`) }) : await reconcile(ctx, api.baseUrl, delivery.deliveryId, reconcileBody, { allowFailure: true, key: ctx.key(`${suffix}-reconcile`) });
    ctx.ok([200, 409].includes(response.status), `${action} has a published convergence outcome`);
  }
  snapshot = await waitDelivery(ctx, api.baseUrl, notification.notificationId, "DELIVERED");
  return { notification, delivery: resource(snapshot, "deliveries").find(({ deliveryId }) => deliveryId === delivery.deliveryId), attempt, snapshot, receiverCalls: receiver.ledger.filter(({ headers }) => headers["x-notifyroute-delivery-id"] === delivery.deliveryId).length };
}

const a04 = guardedCase({
  id: "A-04", fixtureFamily: "NR-F-UNKNOWN-COMMUTATIVE-RESOLUTION",
  action: "Drive two Webhook Deliveries to UNKNOWN through connection reset, then apply Provider receipt and public reconcile in opposite orders with duplicate-safe identities.",
  oracle: "Both orderings converge to one DELIVERED state using the original providerRequestId and Provider message identity without another logical Delivery or speculative success.",
  async run(ctx) {
    const receiver = await providerReceiver(ctx, () => ({ disconnect: true }));
    const { seed } = scriptedSeed(ctx, receiver);
    const api = await startPreparedApi(ctx, { seed });
    const first = await resolveUnknown(ctx, api, seed, receiver, "receipt-first", ["receipt", "reconcile"]);
    const second = await resolveUnknown(ctx, api, seed, receiver, "reconcile-first", ["reconcile", "receipt"]);
    ctx.equal([first.delivery.state, second.delivery.state], ["DELIVERED", "DELIVERED"], "receipt/reconcile order convergence");
    ctx.equal(first.receiverCalls, 1, "UNKNOWN first Delivery is not resent");
    ctx.equal(second.receiverCalls, 1, "UNKNOWN second Delivery is not resent");
    ctx.ok(first.attempt.providerRequestId !== second.attempt.providerRequestId, "distinct Deliveries own distinct provider identities");
    assertInvariants(ctx, second.snapshot);
    return finalEvidence(ctx, { orderings: 2, terminalState: "DELIVERED", providerCalls: first.receiverCalls + second.receiverCalls });
  },
});

const a05 = guardedCase({
  id: "A-05", fixtureFamily: "NR-F-CAMPAIGN-FREEZE-CONTRACT",
  action: "Create and replay Campaigns through the published API with duplicate audience inputs and later template publication.",
  oracle: "Frozen audience, preference revision, template and routing inputs remain exact across reads, snapshots and replay.",
  run: ctx => campaignFreezeScenario(ctx),
});

export const A_CASES = Object.freeze([a01, a02, a03, a04, a05]);

export function assertFallbackOrder(ctx, routeSteps, deliveries, notificationId, providerCalls) {
  const identities = deliveries.map(({ deliveryId }) => deliveryId);
  ctx.equal(identities, [...identities].sort(), "Delivery snapshot is sorted by public identity");
  const routed = deliveries.filter(item => item.notificationId === notificationId).sort((left, right) => left.routeOrdinal - right.routeOrdinal);
  const ordinals = [...routeSteps].sort((left, right) => left.ordinal - right.ordinal).map(({ ordinal }) => ordinal);
  ctx.equal(routed.map(({ routeOrdinal }) => routeOrdinal), ordinals, "fallback creates exactly the frozen route steps");
  ctx.equal(routed[0].state, "FAILED", "the first configured step fails before fallback");
  ctx.ok(["ACCEPTED", "DELIVERED"].includes(routed.at(-1).state), "the terminal configured step succeeds");
  ctx.equal(projectRoute(routeSteps, routed).eligibleOrdinals, [], "fallback stops after successful configured step");
  const byIdentity = new Map(routed.map(({ deliveryId, routeOrdinal }) => [deliveryId, routeOrdinal]));
  const sentOrdinals = providerCalls.map(({ headers }) => byIdentity.get(headers["x-notifyroute-delivery-id"])).filter(ordinal => ordinal !== undefined);
  ctx.equal(sentOrdinals, ordinals, "Provider calls follow frozen ordinal order with one attempt per configured step");
}
