import {
  assertInvariants,
  blockedCase,
  coreNotification,
  createNotification,
  expectError,
  finalEvidence,
  guardedCase,
  prepare,
  providerReceiver,
  receipt,
  reconcile,
  resource,
  scriptedSeed,
  unsubscribe,
  waitDelivery,
} from "./helpers.mjs";

async function dropCommitted(ctx, shield, path, key, body) {
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, path, key, body).catch(() => undefined);
  return ctx.waitFor(() => shield.captures.find(({ request, dropped }) => request.path === path && dropped), { timeoutMs: 30_000, label: `dropped committed response ${path}` });
}

async function replayTwenty(ctx, apis, path, key, body, expected) {
  const responses = await ctx.concurrent(Array.from({ length: 20 }, (_, index) => index), 20, (index) => ctx.mutate(apis[index % apis.length].baseUrl, path, key, body));
  for (const response of responses) ctx.equal({ status: response.status, json: response.json }, expected, `${path} durable replay`);
  return responses;
}

const b01 = guardedCase({
  id: "B-01", fixtureFamily: "NR-F-DURABLE-MUTATION-REPLAY",
  action: "Drop committed Notification create and cancel responses, restart one API, issue twenty concurrent cross-instance retries, and reuse each key with changed semantics.",
  oracle: "Captured status and semantic JSON are durable authority and every replay returns the original identity and sequence with one business, Work and Event effect.",
  async run(ctx) {
    const receiver = await providerReceiver(ctx, () => ({ status: 204 }));
    const { seed } = scriptedSeed(ctx, receiver);
    const target = await prepare(ctx, { seed });
    let api1 = await target.startApi();
    const api2 = await target.startApi();
    const body = coreNotification(ctx, seed);
    const createKey = ctx.key("dropped-notification-create");
    let shield = await ctx.responseShield(api1.baseUrl);
    const createdCapture = await dropCommitted(ctx, shield, "/api/v1/notifications", createKey, body);
    const created = { status: createdCapture.response.status, json: JSON.parse(createdCapture.response.body) };
    ctx.equal(created.status, 200, "dropped create committed with closed success status");
    await ctx.kill(api1);
    api1 = await target.startApi();
    await replayTwenty(ctx, [api1, api2], "/api/v1/notifications", createKey, body, created);
    const conflict = await ctx.mutate(api2.baseUrl, "/api/v1/notifications", createKey, { ...body, category: "DIFFERENT" });
    expectError(ctx, conflict, 409, "IDEMPOTENCY_CONFLICT", "changed create replay");

    const cancelPath = `/api/v1/notifications/${created.json.notificationId}/cancel`;
    const cancelBody = { reason: "operator request" };
    const cancelKey = ctx.key("dropped-notification-cancel");
    shield = await ctx.responseShield(api2.baseUrl);
    const cancelCapture = await dropCommitted(ctx, shield, cancelPath, cancelKey, cancelBody);
    const cancelled = { status: cancelCapture.response.status, json: JSON.parse(cancelCapture.response.body) };
    ctx.equal(cancelled.status, 200, "dropped cancel committed");
    await replayTwenty(ctx, [api1, api2], cancelPath, cancelKey, cancelBody, cancelled);
    const changedCancel = await ctx.mutate(api1.baseUrl, cancelPath, cancelKey, { reason: "different" });
    expectError(ctx, changedCancel, 409, "IDEMPOTENCY_CONFLICT", "changed cancel replay");
    const snapshot = await ctx.snapshot(api1.baseUrl);
    ctx.equal(resource(snapshot, "notifications").filter(({ notificationId }) => notificationId === created.json.notificationId).length, 1, "one replayed Notification", { hardCapIds: ["DURABLE_REPLAY_DUPLICATE"] });
    ctx.equal(resource(snapshot, "notifications").find(({ notificationId }) => notificationId === created.json.notificationId), cancelled.json, "saved cancel response matches durable state");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { droppedResponses: 2, replayRequests: 40, apiProcesses: 2 });
  },
});

const b02 = guardedCase({
  id: "B-02", fixtureFamily: "NR-F-MULTIPROCESS-SEND-CONTENTION",
  action: "Run two Delivery Workers and two Event dispatchers against one database while one controlled Webhook receiver records the Provider request and another records events.",
  oracle: "Concurrent claims linearize to one external Delivery request with one stable providerRequestId while at-least-once event deliveries retain identity and semantic body.",
  async run(ctx) {
    const provider = await providerReceiver(ctx, () => ({ status: 204 }));
    const events = await ctx.receiver({ path: "/events", behavior: () => ({ status: 204 }) });
    const { seed } = scriptedSeed(ctx, provider);
    const target = await prepare(ctx, { seed });
    const api = await target.startApi();
    const { notification } = await createNotification(ctx, api.baseUrl, coreNotification(ctx, seed));
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const dispatchers = [await ctx.startDispatcher({ webhookUrl: events.url }), await ctx.startDispatcher({ webhookUrl: events.url })];
    const snapshot = await waitDelivery(ctx, api.baseUrl, notification.notificationId, ["ACCEPTED", "DELIVERED"], { timeoutMs: 60_000, processes: [...workers, ...dispatchers] });
    await ctx.waitFor(() => events.ledger.length > 0, { timeoutMs: 60_000, label: "event dispatcher delivery", processes: dispatchers });
    const delivery = resource(snapshot, "deliveries").find(({ notificationId }) => notificationId === notification.notificationId);
    const calls = provider.ledger.filter(({ headers }) => headers["x-notifyroute-delivery-id"] === delivery.deliveryId);
    ctx.equal(calls.length, 1, "two Workers produce one Provider call", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
    const attempts = resource(snapshot, "deliveryAttempts").filter(({ deliveryId }) => deliveryId === delivery.deliveryId);
    ctx.equal(new Set(attempts.map(({ providerRequestId }) => providerRequestId)).size, 1, "one providerRequestId under contention");
    const eventBodies = new Map();
    for (const entry of events.ledger) {
      const prior = eventBodies.get(entry.json.eventId);
      if (prior) ctx.equal(entry.json, prior, "duplicate dispatcher delivery body");
      eventBodies.set(entry.json.eventId, entry.json);
    }
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { workers: 2, dispatchers: 2, providerCalls: calls.length, deliveredEvents: eventBodies.size });
  },
});

const b03 = guardedCase({
  id: "B-03", fixtureFamily: "NR-F-SUPPRESSION-SEND-LINEARIZATION",
  action: "Exercise unsubscribe committed before Worker start and unsubscribe committed after a controlled receiver observes the external call, using two API processes and durable snapshots.",
  oracle: "Only two serial outcomes are legal: an earlier suppression yields zero calls and SUPPRESSED, while an earlier external call records Provider reality without later fallback or retry.",
  async run(ctx) {
    let receiver = await providerReceiver(ctx, () => ({ status: 204 }));
    let setup = scriptedSeed(ctx, receiver);
    let target = await prepare(ctx, { seed: setup.seed });
    let apis = [await target.startApi(), await target.startApi()];
    let notification = (await createNotification(ctx, apis[0].baseUrl, coreNotification(ctx, setup.seed))).notification;
    await unsubscribe(ctx, apis[1].baseUrl, setup.seed.recipients[0].recipientId, { channel: "WEBHOOK", category: notification.category, reason: "pre-send fence" });
    let worker = await ctx.startWorker();
    let snapshot = await waitDelivery(ctx, apis[0].baseUrl, notification.notificationId, "SUPPRESSED", { timeoutMs: 60_000, processes: [worker] });
    ctx.equal(receiver.ledger.length, 0, "suppression-before-send produces zero external calls", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
    assertInvariants(ctx, snapshot);

    await ctx.resetDatabase();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    receiver = await providerReceiver(ctx, async () => { await gate; return { status: 204 }; });
    setup = scriptedSeed(ctx, receiver);
    target = await prepare(ctx, { seed: setup.seed });
    apis = [await target.startApi(), await target.startApi()];
    notification = (await createNotification(ctx, apis[0].baseUrl, coreNotification(ctx, setup.seed, { dedupeKey: ctx.key("send-first-race") }))).notification;
    worker = await ctx.startWorker();
    await ctx.waitFor(() => receiver.ledger.length === 1, { timeoutMs: 60_000, label: "external send start", processes: [worker] });
    await unsubscribe(ctx, apis[1].baseUrl, setup.seed.recipients[0].recipientId, { channel: "WEBHOOK", category: notification.category, reason: "post-send fence" }, { key: ctx.key("post-send-unsubscribe") });
    release();
    snapshot = await waitDelivery(ctx, apis[0].baseUrl, notification.notificationId, ["ACCEPTED", "DELIVERED"], { timeoutMs: 60_000, processes: [worker] });
    ctx.equal(receiver.ledger.length, 1, "accepted Provider fact prevents retry or fallback after suppression");
    ctx.ok(resource(snapshot, "deliveries").find(({ notificationId }) => notificationId === notification.notificationId)?.state !== "SUPPRESSED", "Provider reality is not rewritten as unsent");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { serialOutcomes: ["suppression-first", "send-first"], providerCalls: 1, apiProcesses: 2 });
  },
});

async function makeUnknown(ctx, api, seed, suffix) {
  const notification = (await createNotification(ctx, api.baseUrl, coreNotification(ctx, seed, { dedupeKey: ctx.key(`commute-${suffix}`) }))).notification;
  const worker = await ctx.startWorker();
  const snapshot = await waitDelivery(ctx, api.baseUrl, notification.notificationId, "UNKNOWN", { timeoutMs: 60_000, processes: [worker] });
  await ctx.kill(worker);
  const delivery = resource(snapshot, "deliveries").find(({ notificationId }) => notificationId === notification.notificationId);
  const attempt = resource(snapshot, "deliveryAttempts").find(({ deliveryId }) => deliveryId === delivery.deliveryId);
  return { notification, delivery, attempt };
}

const b04 = guardedCase({
  id: "B-04", fixtureFamily: "NR-F-RECEIPT-RECONCILE-COMMUTATIVITY",
  action: "Create two UNKNOWN Deliveries, apply duplicate receipts and reconcile concurrently for one and in reverse serial order for the other across two API instances.",
  oracle: "Every arrival permutation converges to one terminal Delivery and Notification with stable Provider identities, one receipt fact and no second send or terminal event regression.",
  async run(ctx) {
    const receiver = await providerReceiver(ctx, () => ({ disconnect: true }));
    const { seed } = scriptedSeed(ctx, receiver);
    const target = await prepare(ctx, { seed });
    const apis = [await target.startApi(), await target.startApi()];
    const first = await makeUnknown(ctx, apis[0], seed, "parallel");
    const firstMessage = "provider-parallel";
    const firstReceipt = { channel: "WEBHOOK", providerEventId: "event-parallel", providerMessageId: firstMessage, deliveryId: first.delivery.deliveryId, outcome: "DELIVERED", occurredAt: ctx.at({ seconds: 20 }) };
    const operations = Array.from({ length: 20 }, (_, index) => index % 2 === 0
      ? receipt(ctx, apis[index % 2].baseUrl, firstReceipt, { allowFailure: true, key: ctx.key(`duplicate-receipt-${index}`) })
      : reconcile(ctx, apis[index % 2].baseUrl, first.delivery.deliveryId, { providerRequestId: first.attempt.providerRequestId, providerMessageId: firstMessage, outcome: "DELIVERED" }, { allowFailure: true, key: ctx.key(`duplicate-reconcile-${index}`) }));
    const results = await Promise.all(operations);
    ctx.ok(results.every(({ status }) => [200, 409].includes(status)), "duplicates have only published convergence outcomes");
    let snapshot = await waitDelivery(ctx, apis[0].baseUrl, first.notification.notificationId, "DELIVERED");
    ctx.equal(resource(snapshot, "providerReceipts").filter(({ providerEventId }) => providerEventId === firstReceipt.providerEventId).length, 1, "duplicate receipt collapses to one fact");

    const second = await makeUnknown(ctx, apis[1], seed, "reverse");
    const secondMessage = "provider-reverse";
    await reconcile(ctx, apis[0].baseUrl, second.delivery.deliveryId, { providerRequestId: second.attempt.providerRequestId, providerMessageId: secondMessage, outcome: "DELIVERED" }, { allowFailure: true });
    await receipt(ctx, apis[1].baseUrl, { channel: "WEBHOOK", providerEventId: "event-reverse", providerMessageId: secondMessage, deliveryId: second.delivery.deliveryId, outcome: "DELIVERED", occurredAt: ctx.at({ seconds: 21 }) }, { allowFailure: true });
    snapshot = await waitDelivery(ctx, apis[0].baseUrl, second.notification.notificationId, "DELIVERED");
    ctx.equal(resource(snapshot, "deliveries").filter(({ deliveryId }) => [first.delivery.deliveryId, second.delivery.deliveryId].includes(deliveryId)).map(({ state }) => state), ["DELIVERED", "DELIVERED"], "parallel and reverse orders converge");
    ctx.equal(receiver.ledger.length, 2, "UNKNOWN Deliveries are never sent twice");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { duplicateOperations: 20, orderings: 2, providerCalls: receiver.ledger.length });
  },
});

const b05 = blockedCase({
  id: "B-05", fixtureFamily: "NR-F-CAMPAIGN-CONTROL-CONTRACT",
  action: "Race Campaign pause, resume and cancel with fan-out only after the Manager publishes closed control mutations, reads, errors and member state shapes.",
  oracle: "The frozen serializability and Provider-reality rules remain mandatory while the evaluator refuses to infer a control or observation seam.",
  assertionId: "campaign-control-wire", blockedBy: "SPEC-GAP-NR-01",
});

export const B_CASES = Object.freeze([b01, b02, b03, b04, b05]);
