import assert from "node:assert/strict";
import { standardAdapter } from "../framework/standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const recipientIds = [id(2), id(3), id(4), id(5)];
const endpointIds = [id(12), id(13), id(14), id(15)];
const templateId = id(20);
const templateVersionId = id(21);
const routePolicyId = id(30);
const rateLimitPolicyId = id(31);
const createdAt = "2026-01-01T00:00:00.000Z";

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function seed(seedVersion = "hidden-notifyroute", receiverUrl, recipientLimit = 1_000_000, windowSeconds = 60) {
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Tenant" }],
    recipients: recipientIds.map((recipientId, index) => ({
      recipientId, tenantId, externalRef: `hidden-recipient-${index}`, locale: "en-US", timeZone: "UTC",
      preferenceRevision: 0, createdAt,
    })),
    channelEndpoints: recipientIds.map((recipientId, index) => ({
      endpointId: endpointIds[index], tenantId, recipientId, channel: "WEBHOOK", address: receiverUrl,
      state: "ACTIVE", revision: 1, createdAt, terminalAt: null,
    })),
    templates: [{ templateId, tenantId, name: "Hidden transactional template" }],
    templateVersions: [{
      templateVersionId, templateId, version: 1, channel: "WEBHOOK", subject: null,
      body: "{\"recipient\":\"{{name}}\",\"sequence\":{{sequence}}}",
      contentDigest: "3300b8b0971ea68fad8e8ac15bd4102e8957f181407ef8f7e431d9af48343467", createdAt,
    }],
    routePolicies: [{
      routePolicyId, tenantId, name: "Hidden webhook route", revision: 1, createdAt,
      steps: [{ ordinal: 1, channel: "WEBHOOK", delaySeconds: 0, maxAttempts: 3, baseRetrySeconds: 1 }],
    }],
    rateLimitPolicies: [{
      rateLimitPolicyId, tenantId, channel: "WEBHOOK", revision: 1, windowSeconds,
      tenantLimit: 1_000_000, recipientLimit, effectiveFrom: createdAt,
    }],
    notifications: [], deliveries: [], deliveryAttempts: [], suppressions: [], providerReceipts: [],
  };
}

function notification(index, recipientId = recipientIds[index % recipientIds.length]) {
  return {
    tenantId, recipientId, category: "transactional", dedupeKey: `hidden-notification-${index}`,
    templateVersionId, routePolicyId, data: { name: `Hidden ${index}`, sequence: index },
  };
}

const spec = {
  label: "NotifyRoute Notification acceptance",
  performanceScenarioIds: ["notification-ingest", "hot-recipient-quota", "delivery-recovery"],
  seed: async (_ctx, receiverUrl) => seed("hidden-notifyroute", receiverUrl),
  path: "/api/v1/notifications",
  payload: (index) => notification(index),
  conflictPayload: () => ({ ...notification(0), data: { name: "Changed", sequence: 999 } }),
  resource: "notifications",
  identity: (json) => find(json, "notificationId"),
  resourceIdentity: ({ notificationId }) => notificationId,
  workIdentity: (json) => find(json, "notificationId"),
  async verify(ctx, baseUrl, response) {
    const notificationId = find(response.json, "notificationId");
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      const item = value.resources.notifications.find((entry) => entry.notificationId === notificationId);
      return item && ["DELIVERED", "PARTIALLY_DELIVERED"].includes(item.state) ? value : undefined;
    }, { label: "Notification terminal delivery", children: [worker] });
    const deliveries = snapshot.resources.deliveries.filter((entry) => entry.notificationId === notificationId);
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].routeOrdinal, 1);
    assert.ok(["ACCEPTED", "DELIVERED"].includes(deliveries[0].state));
    assert.equal(new Set(snapshot.resources.deliveryAttempts.filter((entry) => entry.deliveryId === deliveries[0].deliveryId).map((entry) => entry.providerRequestId)).size, 1);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, "/api/v1/notifications", "h04-cross-tenant", {
      ...notification(90), recipientId: id(999),
    });
    assert.ok([400, 404, 409].includes(rejected.status), rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.notifications.length, before.resources.notifications.length);
    assert.equal(after.resources.deliveries.length, before.resources.deliveries.length);
  },
  async contention(ctx, baseUrls) {
    const created = await ctx.mutate(baseUrls[0], "/api/v1/notifications", "h06-before-unsubscribe", notification(60));
    const notificationId = find(created.json, "notificationId");
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
    const worker = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "notifyroute-h06" });
    await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === notificationId), {
      label: "Notification claimed before unsubscribe", children: [worker],
    });
    const unsubscribe = { channel: "ALL", category: null, reason: "hidden contention" };
    const results = await Promise.all(Array.from({ length: 32 }, (_, index) => ctx.mutate(
      baseUrls[index % 2], `/api/v1/recipients/${recipientIds[0]}/unsubscribe`, "h06-unsubscribe", unsubscribe,
    )));
    assert.equal(new Set(results.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
    release({ status: 204 });
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrls[0]);
      const item = value.resources.notifications.find((entry) => entry.notificationId === notificationId);
      return item?.state === "SUPPRESSED" ? value : undefined;
    }, { label: "Unsubscribe fence", children: [worker] });
    assert.equal(snapshot.resources.suppressions.filter((entry) => entry.recipientId === recipientIds[0] && entry.state === "ACTIVE").length, 1);
    assert.ok(snapshot.resources.deliveries.filter((entry) => entry.notificationId === notificationId).every((entry) => entry.state === "SUPPRESSED"));
  },
  manager: {
    path: "/api/v1/campaigns",
    payload: (index) => ({
      tenantId, name: `Hidden Campaign ${index}`, recipientIds: [...recipientIds, recipientIds[0]],
      category: "transactional", templateVersionId, routePolicyId,
      data: { name: "Campaign Recipient", sequence: index },
    }),
    async verify(ctx, baseUrl, response) {
      const campaignId = find(response.json, "campaignId");
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
      const worker = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "notifyroute-h10" });
      await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === campaignId), {
        label: "Campaign fan-out claim", children: [worker],
      });
      const paused = await ctx.mutate(baseUrl, `/api/v1/campaigns/${campaignId}/pause`, "h10-pause", {});
      assert.ok(paused.status >= 200 && paused.status < 300, paused.text);
      release({ status: 204 });
      await ctx.waitFor(async () => (await ctx.snapshot(baseUrl)).resources.campaigns.some(
        (entry) => entry.campaignId === campaignId && entry.state === "PAUSED",
      ), { label: "Campaign pause fence", children: [worker] });
      const resumed = await ctx.mutate(baseUrl, `/api/v1/campaigns/${campaignId}/resume`, "h10-resume", {});
      assert.ok(resumed.status >= 200 && resumed.status < 300, resumed.text);
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        return value.resources.campaigns.some((entry) => entry.campaignId === campaignId && entry.state === "COMPLETED") ? value : undefined;
      }, { timeoutMs: 60_000, children: [worker], label: "Campaign completion" });
      const audience = snapshot.resources.campaignRecipients.filter((entry) => entry.campaignId === campaignId);
      assert.equal(audience.length, recipientIds.length);
      assert.equal(new Set(audience.map((entry) => entry.recipientId)).size, recipientIds.length);
      assert.equal(new Set(audience.map((entry) => entry.notificationId)).size, recipientIds.length);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const campaignId = find(response.json, "campaignId");
      const results = await Promise.all(Array.from({ length: 16 }, (_, index) => ctx.mutate(
        baseUrls[index % 2], `/api/v1/campaigns/${campaignId}/cancel`, "h11-cancel", { reason: "hidden cancel" },
      )));
      assert.equal(new Set(results.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
      const worker = await ctx.startWorker();
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      const snapshot = await ctx.snapshot(baseUrls[0]);
      assert.equal(snapshot.resources.campaigns.filter((entry) => entry.campaignId === campaignId && entry.state === "CANCELLED").length, 1);
      assert.equal(snapshot.resources.campaignRecipients.filter((entry) => entry.campaignId === campaignId).length, 0);
      await ctx.stop(worker);
    },
  },
  performance: notifyRoutePerformance,
};

async function notifyRoutePerformance(ctx, assertions) {
  const scale = performanceScale();

  await ctx.prepare();
  let receiver = await ctx.receiver();
  assert.equal((await ctx.seed(seed("perf-notifyroute-ingest", receiver.url))).exitCode, 0);
  let api = await ctx.startApi();
  let sequence = 0;
  const ingest = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
    request: () => {
      const index = sequence++;
      return ctx.mutate(api.baseUrl, "/api/v1/notifications", `perf-ingest-${index}`, notification(10_000 + index));
    },
  });
  assert.ok(ingest.throughput >= 300 && ingest.p95 <= 450, `notification-ingest ${ingest.throughput}/s p95=${ingest.p95}`);
  assert.equal(Object.entries(ingest.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0), 0);
  assertions.push(`notification-ingest ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  receiver = await ctx.receiver();
  assert.equal((await ctx.seed(seed("perf-notifyroute-quota", receiver.url, 100, 3_600))).exitCode, 0);
  api = await ctx.startApi();
  const apiB = await ctx.startApi();
  sequence = 0;
  const quota = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: 2_000 * scale, measureMs: 20_000 * scale,
    request: ({ client }) => {
      const index = sequence++;
      const baseUrl = client % 2 ? api.baseUrl : apiB.baseUrl;
      return ctx.mutate(baseUrl, "/api/v1/notifications", `perf-quota-${index}`, notification(100_000 + index, recipientIds[0]));
    },
  });
  assert.ok(quota.throughput >= 250 && quota.p95 <= 600, `hot-recipient-quota ${quota.throughput}/s p95=${quota.p95}`);
  const quotaWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  await ctx.waitFor(() => receiver.ledger.length >= Math.min(100, quota.completed), { timeoutMs: 60_000, label: "Recipient quota consumption", children: quotaWorkers });
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.ok(receiver.ledger.length <= 100, `recipient window overspent: ${receiver.ledger.length}`);
  const quotaProviderCalls = receiver.ledger.length;
  const quotaSnapshot = await ctx.snapshot(api.baseUrl);
  assert.ok(quotaSnapshot.resources.deliveries.some((entry) => ["RATE_LIMITED", "PENDING"].includes(entry.state)), "quota pressure stranded no deferred Delivery");
  assertions.push(`hot-recipient-quota ${quota.throughput.toFixed(1)}/s p95 ${quota.p95.toFixed(1)}ms; provider calls ${receiver.ledger.length}/100`);

  await ctx.resetDatabase();
  receiver = await ctx.receiver();
  assert.equal((await ctx.seed(seed("perf-notifyroute-recovery", receiver.url))).exitCode, 0);
  api = await ctx.startApi();
  const recoveryCount = Math.max(100, Math.ceil(10_000 * scale));
  await ctx.concurrent(Array.from({ length: recoveryCount }), 64, (_, index) => ctx.mutate(
    api.baseUrl, "/api/v1/notifications", `perf-recovery-${index}`, notification(200_000 + index),
  ));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "notifyroute-perf" })));
  await ctx.waitFor(() => barrier.ledger.length >= 2, { label: "Two delivery claims", children: first });
  await Promise.all(first.map((process) => ctx.stop(process, "SIGKILL")));
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const pending = snapshot.work.some(({ kind, terminal }) => ["NOTIFICATION_ROUTE", "DELIVERY_SEND", "DELIVERY_RECONCILE"].includes(kind) && !terminal);
    return !pending && snapshot.resources.notifications.length === recoveryCount ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "Delivery recovery drain", children: replacements });
  const durationMs = Date.now() - startedAt;
  const deliveryIds = final.resources.deliveries.map(({ deliveryId }) => deliveryId);
  assert.equal(new Set(deliveryIds).size, deliveryIds.length);
  const providerRequestIds = final.resources.deliveryAttempts.map(({ providerRequestId }) => providerRequestId);
  assert.equal(new Set(providerRequestIds).size, final.resources.deliveries.length);
  assertions.push(`delivery-recovery ${recoveryCount} notifications in ${durationMs}ms after two SIGKILLs`);

  return {
    metrics: [
      { scenarioId: "notification-ingest", ...ingest },
      { scenarioId: "hot-recipient-quota", ...quota, providerCalls: quotaProviderCalls, limit: 100 },
      { scenarioId: "delivery-recovery", completed: recoveryCount, durationMs, killedWorkers: 2, replacementWorkers: 4 },
    ],
  };
}

export default standardAdapter(spec);
