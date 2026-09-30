import { ingestScenario } from "./current-system.mjs";
import {
  BASE_RESOURCE_KEYS,
  assertInvariants,
  coreNotification,
  finalEvidence,
  guardedCase,
  prepare,
  providerReceiver,
  receipt,
  resource,
  scriptedSeed,
  unsubscribe,
  waitDelivery,
} from "./helpers.mjs";

const e01 = guardedCase({
  id: "E-01", fixtureFamily: "NR-F-POPULATED-FINAL-SYSTEM-RESTART",
  action: "Create a populated current-system Notification, Delivery, Attempt, Suppression, RateLimit, Event, Work and saved replay, stop processes, run FINAL restart and replay it.",
  oracle: "Every current-system public resource, identity, response body, sequence, Work deadline and Event body remains exact and no historical Notification is implicitly assigned to Campaign.",
  async run(ctx) {
    await prepare(ctx, { migrate: false });
    const provider = await providerReceiver(ctx, () => ({ status: 204 }));
    const setup = scriptedSeed(ctx, provider);
    const current = await prepare(ctx, { seed: setup.seed });
    const api = await current.startApi();
    const body = coreNotification(ctx, setup.seed);
    const key = ctx.key("saved-current-notification");
    const saved = await ctx.mutate(api.baseUrl, "/api/v1/notifications", key, body);
    ctx.equal(saved.status, 200, "saved current-system response status");
    const worker = await current.startWorker();
    let before = await waitDelivery(ctx, api.baseUrl, saved.json.notificationId, ["ACCEPTED", "DELIVERED"], { timeoutMs: 60_000, processes: [worker] });
    const delivery = resource(before, "deliveries").find(({ notificationId }) => notificationId === saved.json.notificationId);
    await receipt(ctx, api.baseUrl, {
      channel: delivery.channel, providerEventId: "restart-provider-event", providerMessageId: delivery.providerMessageId ?? "restart-provider-message",
      deliveryId: delivery.deliveryId, outcome: "DELIVERED", occurredAt: ctx.at({ seconds: 30 }),
    }, { key: ctx.key("current-provider-receipt") });
    await unsubscribe(ctx, api.baseUrl, setup.seed.recipients[0].recipientId, { channel: "SMS", category: null, reason: "restart fixture", expectedPreferenceRevision: setup.seed.recipients[0].preferenceRevision }, { key: ctx.key("current-suppression") });
    before = await ctx.snapshot(api.baseUrl);
    await ctx.stop(worker);
    await ctx.stop(api);

    await ctx.migrate({ timeoutMs: 300_000 });
    const finalApi = await ctx.startApi();
    const after = await ctx.snapshot(finalApi.baseUrl);
    for (const keyName of BASE_RESOURCE_KEYS) ctx.equal(resource(after, keyName), resource(before, keyName), `restart preserves current-system ${keyName}`, { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
    ctx.equal(after.work, before.work, "restart preserves current-system Work identity and deadline", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
    ctx.equal(after.events, before.events, "restart preserves current-system Event identity, body and sequence", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
    ctx.equal(resource(after, "campaigns"), [], "current-system Notifications are not implicitly assigned to Campaign");
    ctx.equal(resource(after, "campaignRecipients"), [], "restart creates no Campaign recipient membership");
    const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/notifications", key, body);
    ctx.equal({ status: replay.status, json: replay.json }, { status: saved.status, json: saved.json }, "saved current-system response replays exactly", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
    assertInvariants(ctx, after);
    return finalEvidence(ctx, { migratedNotifications: resource(before, "notifications").length, migratedWork: before.work.length, migratedEvents: before.events.length, savedReplay: true });
  },
});

const e02 = guardedCase({
  id: "E-02", fixtureFamily: "NR-F-INGEST-WORKLOAD-CONTRACT",
  action: "Issue concurrent duplicate Notification creates through two APIs and drain the bounded workload with two workers.",
  oracle: "Exact replay conserves one Notification and one successful provider call for each logical request without a private performance threshold.",
  run: ctx => ingestScenario(ctx),
});

const e03 = guardedCase({
  id: "E-03", fixtureFamily: "NR-F-QUOTA-WORKLOAD-CONTRACT",
  action: "Run concurrent hot-recipient Notification requests and two workers against published fixed-window quotas.",
  oracle: "Every observed epoch window stays within recipient capacity and limited work records the exact next boundary.",
  run: ctx => ingestScenario(ctx, { quota: true }),
});

const e04 = guardedCase({
  id: "E-04", fixtureFamily: "NR-F-RECOVERY-WORKLOAD-CONTRACT",
  action: "Commit a bounded Notification workload, replace the API, then drain durable work with concurrent workers.",
  oracle: "Restart preserves accepted identities and every logical Notification completes once without a private recovery-time score.",
  run: ctx => ingestScenario(ctx, { restart: true }),
});

export const E_CASES = Object.freeze([e01, e02, e03, e04]);
