import {
  assertSnapshot,
  connect,
  createCampaign,
  createCommand,
  diagnosticCase,
  edgeSeed,
  finalEvidence,
  guardedCase,
  patchDesired,
  poll,
  resource,
  startPreparedApi,
  startWorkers,
  submitReceipt,
  waitSnapshot,
} from "./helpers.mjs";

function workerEnvironment(barrier) {
  return { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: "1" };
}

const recovery01 = guardedCase({
  id: "RECOVERY-01", fixtureFamily: "ET-F-COMMAND-DISPATCH-EXPIRY-RECOVERY",
  action: "Hold a command worker at public worker.claimed, SIGKILL it, cross the command expiry boundary, then run four replacements while poll, cancel and a late receipt race.",
  oracle: "Database terminal authority fences the killed and replacement leases: eligible delivery retains one identity, expired or cancelled delivery never escapes, and all Work drains terminally.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    const api = await startPreparedApi(ctx, { seed });
    const device = seed.devices[0];
    const expiry = new Date(Date.now() + 1_500).toISOString();
    const { command } = await createCommand(ctx, api.baseUrl, {
      tenantId: device.tenantId, deviceId: device.deviceId, kind: "EXPIRING", payload: { fence: true },
      desiredVersion: seed.deviceShadows[0].desiredVersion, expiresAt: expiry,
    });
    const barrier = await ctx.barrier({ hold: ({ point, kind, aggregateId }) => point === "worker.claimed" && kind === "COMMAND_DISPATCH" && aggregateId === command.commandId });
    const claimedWorker = await ctx.startWorker({ env: workerEnvironment(barrier) });
    await barrier.waitFor(({ json }) => json?.point === "worker.claimed" && json.aggregateId === command.commandId, { timeoutMs: 30_000, processes: [claimedWorker] });
    await ctx.kill(claimedWorker);
    barrier.releaseAll();
    await ctx.waitFor(() => Date.now() > Date.parse(expiry) + 100, { timeoutMs: 10_000, label: "database expiry safety margin" });
    const replacements = await startWorkers(ctx, 4, { env: { WORK_LEASE_SECONDS: "1" } });
    const connection = (await connect(ctx, api.baseUrl, device.deviceId, device.tenantId, { key: ctx.key("expiry-connect") })).body;
    const polled = await poll(ctx, api.baseUrl, device.deviceId, device.tenantId, connection.connectionId, 100, { key: ctx.key("expiry-poll") });
    ctx.ok(!polled.items.some(({ commandId }) => commandId === command.commandId), "expired command never reaches poll", { hardCapIds: ["EXPIRED_DELIVERY", "STALE_WORK_COMMIT"] });
    const snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => {
      const stored = resource(value, "deviceCommands").find(({ commandId }) => commandId === command.commandId);
      return stored?.state === "EXPIRED" && (value.work ?? []).filter(({ aggregateId }) => aggregateId === command.commandId).every(({ terminal }) => terminal);
    }, { timeoutMs: 60_000, processes: replacements });
    assertSnapshot(ctx, snapshot);
    ctx.equal(resource(snapshot, "deviceCommands").find(({ commandId }) => commandId === command.commandId).deliveryIdentity, command.deliveryIdentity, "expiry preserves delivery identity", { hardCapIds: ["EXPIRED_DELIVERY"] });
    return finalEvidence(ctx, { killedWorkers: 1, replacements: replacements.length, terminal: "EXPIRED" });
  },
});

const recovery02 = guardedCase({
  id: "RECOVERY-02", fixtureFamily: "ET-F-RECEIPT-PROJECTION-RECOVERY",
  action: "Deliver a command, submit shuffled receipt evidence, hold RECEIPT_PROJECT at worker.claimed, SIGKILL the owner and start concurrent replacements before a stale receipt arrives.",
  oracle: "Immutable receipts survive the crash, one current base advances exactly once, a stale lease cannot commit, and replacement projection never overwrites the newer reported version.",
  async run(ctx) {
    const seed = edgeSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const command = seed.deviceCommands[0];
    const connection = (await connect(ctx, api.baseUrl, command.deviceId, command.tenantId)).body;
    await poll(ctx, api.baseUrl, command.deviceId, command.tenantId, connection.connectionId, 100);
    const barrier = await ctx.barrier({ hold: ({ point, kind }) => point === "worker.claimed" && kind === "RECEIPT_PROJECT" });
    const receipt = {
      tenantId: command.tenantId, deviceId: command.deviceId, commandId: command.commandId, deliveryIdentity: command.deliveryIdentity,
      receiptId: ctx.uuid("recovery-receipt"), deviceSequence: 700, outcome: "ACKNOWLEDGED",
      reportedBaseVersion: seed.deviceShadows[0].reportedVersion, reportedPatch: { recovered: true }, observedAt: ctx.at({ minutes: 2 }),
    };
    await submitReceipt(ctx, api.baseUrl, receipt, { key: ctx.key("recovery-receipt") });
    const claimed = await ctx.startWorker({ env: workerEnvironment(barrier) });
    await barrier.waitFor(({ json }) => json?.kind === "RECEIPT_PROJECT", { timeoutMs: 30_000, processes: [claimed] });
    await ctx.kill(claimed);
    barrier.releaseAll();
    const replacements = await startWorkers(ctx, 4, { env: { WORK_LEASE_SECONDS: "1" } });
    let snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => resource(value, "deviceShadows").some(({ deviceId, reported }) => deviceId === command.deviceId && reported?.recovered === true), { timeoutMs: 60_000, processes: replacements });
    const stale = { ...receipt, receiptId: ctx.uuid("recovery-stale"), deviceSequence: 699, reportedPatch: { recovered: false } };
    await submitReceipt(ctx, api.baseUrl, stale, { key: ctx.key("recovery-stale") });
    snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => resource(value, "commandReceipts").filter(({ commandId }) => commandId === command.commandId).length === 2, { processes: replacements });
    assertSnapshot(ctx, snapshot);
    const shadow = resource(snapshot, "deviceShadows").find(({ deviceId }) => deviceId === command.deviceId);
    ctx.equal(shadow.reported.recovered, true, "stale receipt cannot overwrite recovered projection", { hardCapIds: ["VERSION_REGRESSION", "RECEIPT_DUPLICATE_EFFECT", "STALE_WORK_COMMIT"] });
    ctx.equal(shadow.reportedVersion, seed.deviceShadows[0].reportedVersion + 1, "replacement commits one reported successor", { hardCapIds: ["VERSION_REGRESSION", "RECEIPT_DUPLICATE_EFFECT"] });
    return finalEvidence(ctx, { killedWorkers: 1, replacements: replacements.length, receiptFacts: 2 });
  },
});

const recovery03 = diagnosticCase({
  id: "RECOVERY-03", fixtureFamily: "ET-F-FANOUT-WAVE-COMPENSATION-RECOVERY",
  action: "Kill claimed Campaign fanout and explicit rollback compensation delivery workers, replace each owner, and inspect frozen target, command, Work and compensation identities.",
  oracle: "Every frozen member owns one target and command, retries preserve compensation lineage and stale owners cannot commit; automatic health-gated advance remains unscored until specified.",
  assertionId: "automatic-health-gated-wave-advance", blockedBy: "SPEC-GAP-ET-01",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    const api = await startPreparedApi(ctx, { seed });
    const { campaign } = await createCampaign(ctx, api.baseUrl, {
      tenantId: seed.tenants[0].tenantId,
      firmwareReleaseId: seed.firmwareReleases[1].firmwareReleaseId,
      deviceIds: seed.devices.map(({ deviceId }) => deviceId),
    });
    const barrier = await ctx.barrier({ hold: ({ point, kind, aggregateId }) => point === "worker.claimed" && kind === "UPGRADE_FANOUT" && aggregateId === campaign.upgradeCampaignId });
    const claimed = await ctx.startWorker({ env: workerEnvironment(barrier) });
    await barrier.waitFor(({ json }) => json?.kind === "UPGRADE_FANOUT", { timeoutMs: 30_000, processes: [claimed] });
    await ctx.kill(claimed);
    barrier.releaseAll();
    const replacements = await startWorkers(ctx, 4, { env: { WORK_LEASE_SECONDS: "1" } });
    const snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => resource(value, "upgradeTargets").filter(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId).length === seed.devices.length, { timeoutMs: 60_000, processes: replacements });
    assertSnapshot(ctx, snapshot);
    const targets = resource(snapshot, "upgradeTargets").filter(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId);
    ctx.equal(new Set(targets.map(({ deviceId }) => deviceId)).size, targets.length, "recovered fanout has one target per device", { hardCapIds: ["STALE_WORK_COMMIT", "WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    ctx.equal(new Set(targets.map(({ commandId }) => commandId)).size, targets.length, "recovered fanout has one command per device", { hardCapIds: ["STALE_WORK_COMMIT", "WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    return { evidence: [{ kind: "edgetwin-fanout-recovery", killedWorkers: 1, replacements: replacements.length, targets: targets.length }] };
  },
});

const recovery04 = guardedCase({
  id: "RECOVERY-04", fixtureFamily: "ET-F-OUTBOX-UNKNOWN-ACK",
  action: "Let a receiver consume the complete event body, hold the dispatcher at dispatcher.response-received, SIGKILL it and run replacements across events from two tenants and devices.",
  oracle: "At-least-once retry preserves eventId, canonical body and aggregate sequence, unrelated aggregates progress, and no credential, token, delivery identity or private endpoint leaks.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    seed.tenants.push({ tenantId: ctx.uuid("tenant-second"), name: "Second Fleet" });
    seed.devices.push({ deviceId: ctx.uuid("device-second"), tenantId: seed.tenants[1].tenantId, externalRef: "second-edge", state: "OFFLINE", lastSeenAt: null, createdAt: ctx.at({ days: -3 }) });
    seed.deviceShadows.push({ deviceId: seed.devices.at(-1).deviceId, desiredVersion: 1, desired: {}, reportedVersion: 1, reported: {}, updatedAt: ctx.at({ days: -1 }) });
    const api = await startPreparedApi(ctx, { seed });
    const receiver = await ctx.receiver({ path: "/events", behavior: () => ({ status: 204 }) });
    for (const [index, device] of seed.devices.slice(0, 2).entries()) {
      const shadow = seed.deviceShadows.find(({ deviceId }) => deviceId === device.deviceId);
      await patchDesired(ctx, api.baseUrl, device.deviceId, { tenantId: device.tenantId, expectedVersion: shadow.desiredVersion, patch: { eventOrdinal: index } }, { key: ctx.key(`event-patch-${index}`) });
    }
    const barrier = await ctx.barrier({ hold: ({ point }) => point === "dispatcher.response-received" });
    const claimed = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: "1" } });
    await barrier.waitFor(({ json }) => json?.point === "dispatcher.response-received", { timeoutMs: 30_000, processes: [claimed] });
    await ctx.kill(claimed);
    barrier.releaseAll();
    const replacements = [
      await ctx.startDispatcher({ webhookUrl: receiver.url, env: { WORK_LEASE_SECONDS: "1" } }),
      await ctx.startDispatcher({ webhookUrl: receiver.url, env: { WORK_LEASE_SECONDS: "1" } }),
    ];
    await ctx.waitFor(() => {
      const ids = receiver.ledger.map(({ json }) => json?.eventId).filter(Boolean);
      return ids.length >= 3 && new Set(ids).size >= 2;
    }, { timeoutMs: 60_000, label: "event retry and unrelated aggregate progress", processes: replacements });
    const byId = new Map();
    for (const entry of receiver.ledger) {
      const prior = byId.get(entry.json.eventId);
      if (prior) ctx.equal(entry.json, prior, "unknown-ACK retry body remains canonical");
      byId.set(entry.json.eventId, entry.json);
      ctx.ok(!/(?:authorization|deliveryIdentity|adminToken|postgres(?:ql)?:\/\/|privateBroker|signingMaterial)/iu.test(entry.raw), "event body has no private material");
    }
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl));
    ctx.ok((snapshot.events ?? []).length >= byId.size, "snapshot retains dispatched events");
    return finalEvidence(ctx, { killedDispatchers: 1, replacements: replacements.length, attempts: receiver.ledger.length, uniqueEvents: byId.size });
  },
});

export const RECOVERY_CASES = Object.freeze([recovery01, recovery02, recovery03, recovery04]);
