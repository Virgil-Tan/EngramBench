import {
  V1_RESOURCE_KEYS,
  assertInvariants,
  blockedCase,
  coreNotification,
  finalEvidence,
  guardedCase,
  prepare,
  providerReceiver,
  receipt,
  requireV1,
  resource,
  scriptedSeed,
  unsubscribe,
  waitDelivery,
} from "./helpers.mjs";

const e01 = guardedCase({
  id: "E-01", fixtureFamily: "NR-F-POPULATED-V1-MIGRATION",
  action: "Create a populated V1 Notification, Delivery, Attempt, Suppression, RateLimit, Event, Work and saved replay, stop processes, run FINAL migration and replay it.",
  oracle: "Every V1 public resource, identity, response body, sequence, Work deadline and Event body remains exact and no historical Notification is implicitly assigned to Campaign.",
  async run(ctx) {
    const v1Workspace = requireV1(ctx);
    await prepare(ctx, { migrate: false });
    const provider = await providerReceiver(ctx, () => ({ status: 204 }));
    const setup = scriptedSeed(ctx, provider);
    const v1 = await prepare(ctx, { workspace: v1Workspace, seed: setup.seed });
    const api = await v1.startApi();
    const body = coreNotification(ctx, setup.seed);
    const key = ctx.key("saved-v1-notification");
    const saved = await ctx.mutate(api.baseUrl, "/api/v1/notifications", key, body);
    ctx.equal(saved.status, 200, "saved V1 response status");
    const worker = await v1.startWorker();
    let before = await waitDelivery(ctx, api.baseUrl, saved.json.notificationId, ["ACCEPTED", "DELIVERED"], { timeoutMs: 60_000, processes: [worker] });
    const delivery = resource(before, "deliveries").find(({ notificationId }) => notificationId === saved.json.notificationId);
    await receipt(ctx, api.baseUrl, {
      channel: delivery.channel, providerEventId: "migration-provider-event", providerMessageId: delivery.providerMessageId ?? "migration-provider-message",
      deliveryId: delivery.deliveryId, outcome: "DELIVERED", occurredAt: ctx.at({ seconds: 30 }),
    }, { key: ctx.key("v1-provider-receipt") });
    await unsubscribe(ctx, api.baseUrl, setup.seed.recipients[0].recipientId, { channel: "SMS", category: null, reason: "migration fixture" }, { key: ctx.key("v1-suppression") });
    before = await ctx.snapshot(api.baseUrl);
    await ctx.stop(worker);
    await ctx.stop(api);

    await ctx.migrate({ timeoutMs: 300_000 });
    const finalApi = await ctx.startApi();
    const after = await ctx.snapshot(finalApi.baseUrl);
    for (const keyName of V1_RESOURCE_KEYS) ctx.equal(resource(after, keyName), resource(before, keyName), `migration preserves V1 ${keyName}`, { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
    ctx.equal(after.work, before.work, "migration preserves V1 Work identity and deadline", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
    ctx.equal(after.events, before.events, "migration preserves V1 Event identity, body and sequence", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
    ctx.equal(resource(after, "campaigns"), [], "V1 Notifications are not implicitly assigned to Campaign");
    ctx.equal(resource(after, "campaignRecipients"), [], "migration creates no Campaign recipient membership");
    const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/notifications", key, body);
    ctx.equal({ status: replay.status, json: replay.json }, { status: saved.status, json: saved.json }, "saved V1 response replays exactly", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
    assertInvariants(ctx, after);
    return finalEvidence(ctx, { migratedNotifications: resource(before, "notifications").length, migratedWork: before.work.length, migratedEvents: before.events.length, savedReplay: true });
  },
});

const e02 = blockedCase({
  id: "E-02", fixtureFamily: "NR-F-INGEST-WORKLOAD-CONTRACT",
  action: "Run a sustained Notification ingest workload only after dataset, selector, concurrency, warm-up, duration, latency, throughput and error thresholds are public.",
  oracle: "Performance and full Notification, Delivery, Work and Event invariants must pass together without importing or scaling an earlier private workload.",
  assertionId: "notification-ingest-workload", blockedBy: "SPEC-GAP-NR-03",
});

const e03 = blockedCase({
  id: "E-03", fixtureFamily: "NR-F-QUOTA-WORKLOAD-CONTRACT",
  action: "Run hot-recipient quota contention only after recipient distribution, epoch windows, selector, timing, concurrency and thresholds are public.",
  oracle: "An independent two-level window ledger and post-load conservation remain required while expected throttles cannot be reclassified or guessed.",
  assertionId: "hot-recipient-workload", blockedBy: "SPEC-GAP-NR-03",
});

const e04 = blockedCase({
  id: "E-04", fixtureFamily: "NR-F-RECOVERY-WORKLOAD-CONTRACT",
  action: "Run a fixed Delivery crash and recovery load only after barrier boundary, dataset scale, killed and replacement counts, timer and completion threshold are public.",
  oracle: "Recovery time and Provider, Delivery, Work and Event identities must close together without random sleeps or a private historical scale.",
  assertionId: "delivery-recovery-workload", blockedBy: "SPEC-GAP-NR-03",
});

export const E_CASES = Object.freeze([e01, e02, e03, e04]);
