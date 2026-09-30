import assert from "node:assert/strict";
import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `33000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const firmwareReleaseIds = [id(20), id(21)];
const createdAt = "2026-01-01T00:00:00.000Z";
const digest = (char) => char.repeat(64);
const isoAfter = (milliseconds, now = Date.now()) => new Date(now + milliseconds).toISOString();

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function stable(snapshot) {
  const { asOf: _asOf, ...value } = snapshot;
  return value;
}

function deviceId(index) {
  return id(1000 + index);
}

function seed(version = "hidden-edgetwin", deviceCount = 20) {
  const devices = Array.from({ length: deviceCount }, (_, index) => ({
    deviceId: deviceId(index), tenantId, externalRef: `hidden-device-${index}`, state: "OFFLINE", lastSeenAt: null, createdAt,
  }));
  return {
    schemaVersion: 1, seedVersion: version, importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Fleet Tenant" }], devices,
    deviceShadows: devices.map(({ deviceId: currentDeviceId }) => ({ deviceId: currentDeviceId, desiredVersion: 0, desired: {}, reportedVersion: 0, reported: { firmwareDigest: digest("a") }, updatedAt: createdAt })),
    deviceCommands: [], commandReceipts: [],
    firmwareReleases: [
      { firmwareReleaseId: firmwareReleaseIds[0], tenantId, version: "1.0.0", digest: digest("a"), sizeBytes: 1024, state: "READY", createdAt },
      { firmwareReleaseId: firmwareReleaseIds[1], tenantId, version: "2.0.0", digest: digest("b"), sizeBytes: 2048, state: "READY", createdAt },
    ],
    upgradeCampaigns: [], upgradeTargets: [],
  };
}

function shadowPerformanceSeed(deviceCount) {
  const value = seed("perf-edgetwin-shadow", deviceCount);
  const expiresAt = isoAfter(60 * 60 * 1000);
  value.devices = value.devices.map((device) => ({ ...device, state: "ONLINE", lastSeenAt: createdAt }));
  value.deviceCommands = value.devices.map(({ deviceId: currentDeviceId }, index) => ({
    commandId: id(300_000 + index), tenantId, deviceId: currentDeviceId,
    kind: "SET_CONFIG", payload: { sampleRate: index % 100 }, desiredVersion: 0,
    deliveryIdentity: id(500_000 + index), state: "DELIVERED",
    expiresAt, createdAt,
  }));
  return value;
}

function command(index, currentDeviceId = deviceId(index % 20), expiresAt = isoAfter(60 * 60 * 1000)) {
  return { tenantId, deviceId: currentDeviceId, kind: "SET_CONFIG", payload: { sampleRate: index % 100 }, desiredVersion: 0, expiresAt };
}

async function fixedLoad(ctx, { count, concurrency, request }) {
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const response = await request(index);
    latencies.push(response.durationMs);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);
  const at = (fraction) => latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)];
  return { completed: count, durationMs, throughput: count / (durationMs / 1000), p50: at(0.5), p95: at(0.95), p99: at(0.99), statuses: Object.fromEntries(statuses) };
}

function assertIdsPreserved(before, after, resource, key) {
  const current = new Set(after.resources[resource].map((entry) => entry[key]));
  assert.ok(before.resources[resource].every((entry) => current.has(entry[key])), `${resource} identity changed during migration`);
}

function assertRecordsPreserved(ctx, actual, expected) {
  const records = new Set(actual.map((entry) => ctx.canonical(entry)));
  for (const entry of expected) assert.ok(records.has(ctx.canonical(entry)), "V1 record changed during FINAL migration");
}

async function pollCommand(ctx, baseUrl, currentDeviceId, commandId, key) {
  const connectionId = `${key}-connection`;
  const connected = await ctx.mutate(baseUrl, `/api/v1/devices/${currentDeviceId}/connect`, `${key}-connect`, { tenantId, connectionId });
  assert.ok(connected.status >= 200 && connected.status < 300, connected.text);
  const polled = await ctx.mutate(baseUrl, `/api/v1/devices/${currentDeviceId}/poll`, `${key}-poll`, { tenantId, connectionId, limit: 10 });
  assert.ok(polled.status >= 200 && polled.status < 300, polled.text);
  const commands = find(polled.json, "commands") ?? find(polled.json, "items") ?? [];
  const envelope = commands.find((entry) => entry.commandId === commandId);
  assert.ok(envelope, `${commandId} was not returned by device poll`);
  return envelope;
}

async function firmwareReceipt(ctx, baseUrl, { currentDeviceId, commandId, key, receiptIndex, sequence, firmwareDigest, outcome = "ACKNOWLEDGED", envelope: suppliedEnvelope }) {
  const envelope = suppliedEnvelope ?? await pollCommand(ctx, baseUrl, currentDeviceId, commandId, key);
  const response = await ctx.mutate(baseUrl, "/api/v1/command-receipts", `${key}-receipt`, {
    tenantId, deviceId: currentDeviceId, commandId, deliveryIdentity: envelope.deliveryIdentity,
    receiptId: id(800_000 + receiptIndex), deviceSequence: sequence, outcome,
    reportedBaseVersion: 0, reportedPatch: outcome === "ACKNOWLEDGED" ? { firmwareDigest } : {},
    observedAt: isoAfter(-1_000),
  });
  assert.ok(response.status >= 200 && response.status < 300, response.text);
  return response;
}

function assertSingleRunningWave(snapshot, upgradeCampaignId) {
  const running = snapshot.resources.deploymentWaves
    .filter((entry) => entry.upgradeCampaignId === upgradeCampaignId)
    .flatMap(({ waves }) => waves)
    .filter(({ state }) => state === "RUNNING");
  assert.ok(running.length <= 1, "a Campaign has more than one RUNNING wave");
}

async function edgeTwinMigration(ctx, assertions) {
  const v1 = await ctx.copyV1Workspace();
  await ctx.prepare(v1);
  assert.equal((await ctx.seed(seed("h09-edgetwin"), v1)).exitCode, 0);
  const v1Api = await ctx.startApi(v1);
  const migrationNow = Date.now();
  const campaignPayload = { tenantId, firmwareReleaseId: firmwareReleaseIds[1], deviceIds: [deviceId(0), deviceId(1), deviceId(2), deviceId(3)] };
  const campaign = await ctx.mutate(v1Api.baseUrl, "/api/v1/upgrade-campaigns", "h09-saved-campaign", campaignPayload);
  assert.ok([200, 201, 202].includes(campaign.status), campaign.text);

  const expiryAt = migrationNow + 5_000;
  const expiringCommand = await ctx.mutate(v1Api.baseUrl, "/api/v1/device-commands", "h09-expiring-command", command(908, deviceId(4), new Date(expiryAt).toISOString()));
  assert.ok([200, 201, 202].includes(expiringCommand.status), expiringCommand.text);
  const newerCommand = await ctx.mutate(v1Api.baseUrl, "/api/v1/device-commands", "h09-newer-command", command(910, deviceId(5)));
  const olderCommand = await ctx.mutate(v1Api.baseUrl, "/api/v1/device-commands", "h09-older-command", command(911, deviceId(5)));
  assert.ok([newerCommand, olderCommand].every(({ status }) => status >= 200 && status < 300));
  const newerCommandId = find(newerCommand.json, "commandId");
  const olderCommandId = find(olderCommand.json, "commandId");
  const connected = await ctx.mutate(v1Api.baseUrl, `/api/v1/devices/${deviceId(5)}/connect`, "h09-receipt-connect", { tenantId, connectionId: "h09-receipt-connection" });
  assert.ok(connected.status >= 200 && connected.status < 300, connected.text);
  const receiptPoll = await ctx.mutate(v1Api.baseUrl, `/api/v1/devices/${deviceId(5)}/poll`, "h09-receipt-poll", { tenantId, connectionId: "h09-receipt-connection", limit: 10 });
  assert.ok(receiptPoll.status >= 200 && receiptPoll.status < 300, receiptPoll.text);
  const receiptEnvelopes = find(receiptPoll.json, "commands") ?? find(receiptPoll.json, "items") ?? [];
  const newerEnvelope = receiptEnvelopes.find((entry) => entry.commandId === newerCommandId);
  const olderEnvelope = receiptEnvelopes.find((entry) => entry.commandId === olderCommandId);
  assert.ok(newerEnvelope && olderEnvelope, "both V1 commands must be delivered in canonical order");
  const receiptObservedAt = Date.now();

  const worker = await ctx.startWorker({}, v1);
  const newerReceipt = await ctx.mutate(v1Api.baseUrl, "/api/v1/command-receipts", "h09-newer-receipt", {
    tenantId, deviceId: deviceId(5), commandId: newerCommandId, deliveryIdentity: newerEnvelope.deliveryIdentity,
    receiptId: id(901), deviceSequence: 2, outcome: "ACKNOWLEDGED", reportedBaseVersion: 0,
    reportedPatch: { migrationOrder: "newer" }, observedAt: isoAfter(0, receiptObservedAt),
  });
  assert.ok(newerReceipt.status >= 200 && newerReceipt.status < 300, newerReceipt.text);
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(v1Api.baseUrl);
    const shadow = snapshot.resources.deviceShadows.find((entry) => entry.deviceId === deviceId(5));
    return shadow?.reportedVersion === 1 && shadow.reported?.migrationOrder === "newer";
  }, { label: "newer V1 receipt projection", children: [worker] });
  const olderReceipt = await ctx.mutate(v1Api.baseUrl, "/api/v1/command-receipts", "h09-older-receipt", {
    tenantId, deviceId: deviceId(5), commandId: olderCommandId, deliveryIdentity: olderEnvelope.deliveryIdentity,
    receiptId: id(902), deviceSequence: 1, outcome: "ACKNOWLEDGED", reportedBaseVersion: 0,
    reportedPatch: { migrationOrder: "older" }, observedAt: isoAfter(-1_000, receiptObservedAt),
  });
  assert.ok(olderReceipt.status >= 200 && olderReceipt.status < 300, olderReceipt.text);

  const campaignId = find(campaign.json, "upgradeCampaignId");
  const expiredCommandId = find(expiringCommand.json, "commandId");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiryAt - Date.now() + 100)));
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(v1Api.baseUrl);
    const currentCampaign = snapshot.resources.upgradeCampaigns.find((entry) => entry.upgradeCampaignId === campaignId);
    const commands = new Map(snapshot.resources.deviceCommands.map((entry) => [entry.commandId, entry]));
    const shadow = snapshot.resources.deviceShadows.find((entry) => entry.deviceId === deviceId(5));
    return currentCampaign?.state === "RUNNING"
      && commands.get(expiredCommandId)?.state === "EXPIRED"
      && commands.get(newerCommandId)?.state === "ACKNOWLEDGED"
      && commands.get(olderCommandId)?.state === "ACKNOWLEDGED"
      && shadow?.reportedVersion === 1
      && shadow.reported?.migrationOrder === "newer"
      ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "rich V1 migration state", children: [worker] });
  await ctx.stop(worker);

  const pendingCampaignPayload = { tenantId, firmwareReleaseId: firmwareReleaseIds[1], deviceIds: [deviceId(7), deviceId(8)] };
  const pendingCampaign = await ctx.mutate(v1Api.baseUrl, "/api/v1/upgrade-campaigns", "h09-pending-campaign", pendingCampaignPayload);
  assert.ok([200, 201, 202].includes(pendingCampaign.status), pendingCampaign.text);
  const pendingCampaignId = find(pendingCampaign.json, "upgradeCampaignId");
  let releaseLease;
  const held = new Promise((resolve) => { releaseLease = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingCampaignId ? held : { status: 204 });
  const oldWorker = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "edgetwin-h09" }, v1);
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingCampaignId), {
    label: "V1 UpgradeCampaign lease", children: [oldWorker],
  });
  const commandPayload = command(909, deviceId(6));
  const createdCommand = await ctx.mutate(v1Api.baseUrl, "/api/v1/device-commands", "h09-saved-command", commandPayload);
  assert.ok([200, 201, 202].includes(createdCommand.status), createdCommand.text);
  const before = await ctx.snapshot(v1Api.baseUrl);
  const oldLease = before.work.find(({ aggregateId, kind }) => aggregateId === pendingCampaignId && kind === "UPGRADE_FANOUT");
  assert.ok(oldLease && oldLease.state === "LEASED" && !oldLease.terminal, "V1 pending Campaign has no preserved fan-out lease");
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const campaignReplay = await ctx.mutate(finalApi.baseUrl, "/api/v1/upgrade-campaigns", "h09-saved-campaign", campaignPayload);
  const pendingCampaignReplay = await ctx.mutate(finalApi.baseUrl, "/api/v1/upgrade-campaigns", "h09-pending-campaign", pendingCampaignPayload);
  const commandReplay = await ctx.mutate(finalApi.baseUrl, "/api/v1/device-commands", "h09-saved-command", commandPayload);
  assert.equal(ctx.canonical(campaignReplay.json), ctx.canonical(campaign.json));
  assert.equal(ctx.canonical(pendingCampaignReplay.json), ctx.canonical(pendingCampaign.json));
  assert.equal(ctx.canonical(commandReplay.json), ctx.canonical(createdCommand.json));
  const after = await ctx.snapshot(finalApi.baseUrl);
  for (const [resource, key] of [["devices", "deviceId"], ["deviceCommands", "commandId"], ["upgradeCampaigns", "upgradeCampaignId"], ["upgradeTargets", "deviceId"]]) {
    assertIdsPreserved(before, after, resource, key);
  }
  for (const resource of ["tenants", "devices", "deviceShadows", "deviceCommands", "commandReceipts", "firmwareReleases", "upgradeCampaigns", "upgradeTargets"]) {
    assertRecordsPreserved(ctx, after.resources[resource], before.resources[resource]);
  }
  assertRecordsPreserved(ctx, after.events, before.events);
  assertRecordsPreserved(ctx, after.work, before.work);
  assert.ok(after.work.some(({ aggregateId, terminal }) => aggregateId === find(createdCommand.json, "commandId") && !terminal));
  const migratedLease = after.work.find(({ workId }) => workId === oldLease.workId);
  assert.deepEqual(
    [migratedLease?.state, migratedLease?.attempt, migratedLease?.leaseOwner, migratedLease?.leaseExpiresAt, migratedLease?.terminal],
    [oldLease.state, oldLease.attempt, oldLease.leaseOwner, oldLease.leaseExpiresAt, oldLease.terminal],
  );
  const migratedShadow = after.resources.deviceShadows.find((entry) => entry.deviceId === deviceId(5));
  assert.equal(migratedShadow.reportedVersion, 1);
  assert.equal(migratedShadow.reported.migrationOrder, "newer");
  assert.equal(after.resources.deviceCommands.find((entry) => entry.commandId === expiredCommandId).state, "EXPIRED");
  assert.ok([newerCommandId, olderCommandId].every((commandId) => after.resources.deviceCommands.find((entry) => entry.commandId === commandId)?.state === "ACKNOWLEDGED"));
  const legacy = after.resources.deploymentWaves.filter((entry) => entry.upgradeCampaignId === campaignId && entry.requestRef === `legacy:${campaignId}`);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].waves.length, 1);
  assert.equal(legacy[0].waves[0].ordinal, 0);
  assert.equal(legacy[0].waves[0].name, "legacy");
  const migratedMembers = after.resources.waveDevices.filter((entry) => entry.deploymentWaveId === legacy[0].deploymentWaveId);
  assert.deepEqual(migratedMembers.map(({ deviceId: value }) => value).sort(), before.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === campaignId).map(({ deviceId: value }) => value).sort());
  const pendingLegacy = after.resources.deploymentWaves.find((entry) => entry.upgradeCampaignId === pendingCampaignId && entry.requestRef === `legacy:${pendingCampaignId}`);
  assert.ok(pendingLegacy, "pending V1 Campaign has no deterministic legacy wave");
  assert.equal(after.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === pendingCampaignId).length, 0);

  releaseLease({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 750));
  const afterOldWorker = await ctx.snapshot(finalApi.baseUrl);
  assert.equal(afterOldWorker.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === pendingCampaignId).length, 0);
  assert.equal(afterOldWorker.resources.deviceCommands.filter((entry) => [deviceId(7), deviceId(8)].includes(entry.deviceId)).length, 0);
  assert.equal(afterOldWorker.resources.waveDevices.filter((entry) => entry.deploymentWaveId === pendingLegacy.deploymentWaveId).length, 0);
  await ctx.stop(oldWorker, "SIGKILL");

  const legacyIdentity = {
    waves: afterOldWorker.resources.deploymentWaves
      .filter(({ requestRef }) => requestRef.startsWith("legacy:"))
      .map(({ upgradeCampaignId, deploymentWaveId, requestRef }) => [upgradeCampaignId, deploymentWaveId, requestRef])
      .sort(([left], [right]) => left.localeCompare(right)),
    devices: afterOldWorker.resources.waveDevices
      .filter(({ deploymentWaveId }) => afterOldWorker.resources.deploymentWaves.some((entry) => entry.deploymentWaveId === deploymentWaveId && entry.requestRef.startsWith("legacy:")))
      .map(({ deploymentWaveId, waveOrdinal, deviceId: value }) => [deploymentWaveId, waveOrdinal, value])
      .sort((left, right) => ctx.canonical(left).localeCompare(ctx.canonical(right))),
  };
  await ctx.stop(finalApi);
  await ctx.prepare();
  const repeatedApi = await ctx.startApi();
  const repeated = await ctx.snapshot(repeatedApi.baseUrl);
  const repeatedIdentity = {
    waves: repeated.resources.deploymentWaves
      .filter(({ requestRef }) => requestRef.startsWith("legacy:"))
      .map(({ upgradeCampaignId, deploymentWaveId, requestRef }) => [upgradeCampaignId, deploymentWaveId, requestRef])
      .sort(([left], [right]) => left.localeCompare(right)),
    devices: repeated.resources.waveDevices
      .filter(({ deploymentWaveId }) => repeated.resources.deploymentWaves.some((entry) => entry.deploymentWaveId === deploymentWaveId && entry.requestRef.startsWith("legacy:")))
      .map(({ deploymentWaveId, waveOrdinal, deviceId: value }) => [deploymentWaveId, waveOrdinal, value])
      .sort((left, right) => ctx.canonical(left).localeCompare(ctx.canonical(right))),
  };
  assert.deepEqual(repeatedIdentity, legacyIdentity);
  assertions.push("rich V1 state, leased fan-out, stale Worker fence, replay, and deterministic legacy wave identities survive repeat migration");
}

const spec = {
  label: "EdgeTwin DeviceCommand creation",
  performanceScenarioIds: ["shadow-patch-ingest", "offline-command-expiry", "fleet-upgrade-recovery"],
  seed: async () => seed(),
  path: "/api/v1/device-commands",
  payload: (index) => command(index),
  conflictPayload: () => ({ ...command(0), payload: { sampleRate: 999 } }),
  resource: "deviceCommands",
  identity: (json) => find(json, "commandId"),
  resourceIdentity: ({ commandId }) => commandId,
  workIdentity: (json) => find(json, "commandId"),
  async verify(ctx, baseUrl, response) {
    const commandId = find(response.json, "commandId");
    const currentDeviceId = deviceId(0);
    await ctx.mutate(baseUrl, `/api/v1/devices/${currentDeviceId}/connect`, "h03-connect", { tenantId, connectionId: "hidden-connection" });
    const polled = await ctx.mutate(baseUrl, `/api/v1/devices/${currentDeviceId}/poll`, "h03-poll", { tenantId, connectionId: "hidden-connection", limit: 10 });
    const commands = find(polled.json, "commands") ?? find(polled.json, "items") ?? [];
    const envelope = commands.find((entry) => entry.commandId === commandId);
    assert.ok(envelope, "offline command was not returned after connect");
    const receipt = await ctx.mutate(baseUrl, "/api/v1/command-receipts", "h03-receipt", {
      tenantId, deviceId: currentDeviceId, commandId, deliveryIdentity: envelope.deliveryIdentity,
      receiptId: id(900), deviceSequence: 1, outcome: "ACKNOWLEDGED", reportedBaseVersion: 0,
      reportedPatch: { appliedSampleRate: 0 }, observedAt: isoAfter(-1_000),
    });
    assert.ok([200, 201, 202].includes(receipt.status), receipt.text);
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      const stored = value.resources.deviceCommands.find((entry) => entry.commandId === commandId);
      return stored?.state === "ACKNOWLEDGED" ? value : undefined;
    }, { timeoutMs: 60_000, label: "receipt projection", children: [worker] });
    assert.equal(snapshot.resources.commandReceipts.filter((entry) => entry.commandId === commandId).length, 1);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, `/api/v1/devices/${deviceId(0)}/shadow/desired`, "h04-shadow-version", {
      tenantId, expectedVersion: 9, patch: { mode: "unsafe" },
    }, "PATCH");
    assert.equal(rejected.status, 409);
    assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(before));
  },
  async contention(ctx, baseUrls) {
    const patches = await Promise.all(Array.from({ length: 32 }, (_, index) => ctx.mutate(
      baseUrls[index % 2], `/api/v1/devices/${deviceId(1)}/shadow/desired`, `h06-patch-${index}`,
      { tenantId, expectedVersion: 0, patch: { winner: index } }, "PATCH",
    )));
    assert.equal(patches.filter(({ status }) => status >= 200 && status < 300).length, 1);
    assert.equal(patches.filter(({ status }) => status === 409).length, 31);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    assert.equal(snapshot.resources.deviceShadows.find((entry) => entry.deviceId === deviceId(1)).desiredVersion, 1);
  },
  manager: {
    path: "/api/v1/deployment-waves",
    payload: () => ({ tenantId, upgradeCampaignId: "prepared", waves: [] }),
    async prepare(ctx, baseUrl) {
      const campaign = await ctx.mutate(baseUrl, "/api/v1/upgrade-campaigns", "h10-campaign", {
        tenantId, firmwareReleaseId: firmwareReleaseIds[1], deviceIds: [deviceId(0), deviceId(1), deviceId(2), deviceId(3)],
      });
      assert.ok(campaign.status >= 200 && campaign.status < 300, campaign.text);
      const upgradeCampaignId = find(campaign.json, "upgradeCampaignId");
      return {
        payload: (index) => ({
          tenantId, upgradeCampaignId, requestRef: `wave-${index}`,
          waves: [
            { name: "canary", deviceIds: [deviceId(0)], minimumObservationSeconds: 3, maximumFailurePercent: 0 },
            { name: "fleet", deviceIds: [deviceId(1), deviceId(2), deviceId(3)], minimumObservationSeconds: 3, maximumFailurePercent: 25 },
          ],
        }),
      };
    },
    async verify(ctx, baseUrl, response) {
      const deploymentWaveId = find(response.json, "deploymentWaveId");
      const upgradeCampaignId = find(response.json, "upgradeCampaignId");
      const rejectionCampaign = await ctx.mutate(baseUrl, "/api/v1/upgrade-campaigns", "h10-rejection-campaign", {
        tenantId, firmwareReleaseId: firmwareReleaseIds[1], deviceIds: [deviceId(10), deviceId(11), deviceId(12), deviceId(13)],
      });
      assert.ok(rejectionCampaign.status >= 200 && rejectionCampaign.status < 300, rejectionCampaign.text);
      const rejectionCampaignId = find(rejectionCampaign.json, "upgradeCampaignId");
      const beforeRejected = await ctx.snapshot(baseUrl);
      const duplicate = await ctx.mutate(baseUrl, "/api/v1/deployment-waves", "h10-duplicate-wave-device", {
        tenantId, upgradeCampaignId: rejectionCampaignId, requestRef: "duplicate-device",
        waves: [
          { name: "one", deviceIds: [deviceId(10)], minimumObservationSeconds: 1, maximumFailurePercent: 0 },
          { name: "two", deviceIds: [deviceId(10)], minimumObservationSeconds: 1, maximumFailurePercent: 0 },
        ],
      });
      assert.equal(duplicate.status, 409, duplicate.text);
      assert.equal(duplicate.json?.error?.code, "WAVE_DEVICE_CONFLICT");
      assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(beforeRejected));
      const invalid = await ctx.mutate(baseUrl, "/api/v1/deployment-waves", "h10-invalid-health", {
        tenantId, upgradeCampaignId: rejectionCampaignId, requestRef: "invalid-health",
        waves: [{ name: "invalid", deviceIds: [deviceId(10)], minimumObservationSeconds: 0, maximumFailurePercent: 101 }],
      });
      assert.equal(invalid.status, 400, invalid.text);
      assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(beforeRejected));

      const worker = await ctx.startWorker();
      const canary = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const deployment = snapshot.resources.deploymentWaves.find((entry) => entry.deploymentWaveId === deploymentWaveId);
        const devices = snapshot.resources.waveDevices.filter((entry) => entry.deploymentWaveId === deploymentWaveId);
        const member = devices.find((entry) => entry.deviceId === deviceId(0));
        return deployment?.waves?.[0]?.state === "RUNNING" && devices.length === 4 && typeof member?.commandId === "string"
          ? { snapshot, deployment, member } : undefined;
      }, { timeoutMs: 60_000, label: "canary wave command", children: [worker] });
      assert.equal(canary.snapshot.resources.deploymentWaves.filter((entry) => entry.deploymentWaveId === deploymentWaveId).length, 1);
      const members = canary.snapshot.resources.waveDevices.filter((entry) => entry.deploymentWaveId === deploymentWaveId);
      assert.equal(new Set(members.map(({ deviceId: value }) => value)).size, 4);
      assert.deepEqual(members.filter(({ waveOrdinal }) => waveOrdinal === 0).map(({ deviceId: value }) => value), [deviceId(0)]);
      assert.equal(members.filter(({ waveOrdinal }) => waveOrdinal === 1).length, 3);
      assert.ok(members.filter(({ waveOrdinal }) => waveOrdinal === 1).every(({ commandId }) => commandId === null));
      assertSingleRunningWave(canary.snapshot, upgradeCampaignId);

      await firmwareReceipt(ctx, baseUrl, {
        currentDeviceId: deviceId(0), commandId: canary.member.commandId, key: "h10-canary-match",
        receiptIndex: 1, sequence: 1, firmwareDigest: digest("b"),
      });
      const fleet = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const deployment = snapshot.resources.deploymentWaves.find((entry) => entry.deploymentWaveId === deploymentWaveId);
        const devices = snapshot.resources.waveDevices.filter((entry) => entry.deploymentWaveId === deploymentWaveId);
        return deployment?.currentWaveOrdinal === 1
          && deployment.waves?.[0]?.state === "SUCCEEDED"
          && deployment.waves?.[1]?.state === "RUNNING"
          && devices.filter(({ waveOrdinal, commandId }) => waveOrdinal === 1 && typeof commandId === "string").length === 3
          ? { snapshot, deployment, devices } : undefined;
      }, { timeoutMs: 60_000, label: "health-gated fleet wave", children: [worker] });
      assert.ok(Date.parse(fleet.deployment.updatedAt) - Date.parse(fleet.deployment.createdAt) >= 3_000, "canary advanced before its observation window");
      assertSingleRunningWave(fleet.snapshot, upgradeCampaignId);

      const fleetByDevice = new Map(fleet.devices.map((entry) => [entry.deviceId, entry]));
      const fleetEnvelopes = new Map(await Promise.all([deviceId(1), deviceId(2), deviceId(3)].map(async (currentDeviceId, index) => [
        currentDeviceId,
        await pollCommand(ctx, baseUrl, currentDeviceId, fleetByDevice.get(currentDeviceId).commandId, `h10-fleet-${index}`),
      ])));
      await firmwareReceipt(ctx, baseUrl, {
        currentDeviceId: deviceId(1), commandId: fleetByDevice.get(deviceId(1)).commandId, key: "h10-wrong-digest",
        receiptIndex: 2, sequence: 1, firmwareDigest: digest("a"), envelope: fleetEnvelopes.get(deviceId(1)),
      });
      const wrongDigest = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const commandId = fleetByDevice.get(deviceId(1)).commandId;
        const command = snapshot.resources.deviceCommands.find((entry) => entry.commandId === commandId);
        const member = snapshot.resources.waveDevices.find((entry) => entry.deploymentWaveId === deploymentWaveId && entry.deviceId === deviceId(1));
        return command?.state === "ACKNOWLEDGED" ? { snapshot, member } : undefined;
      }, { timeoutMs: 60_000, label: "wrong-digest receipt projection", children: [worker] });
      assert.notEqual(wrongDigest.member.state, "SUCCEEDED");

      await firmwareReceipt(ctx, baseUrl, {
        currentDeviceId: deviceId(2), commandId: fleetByDevice.get(deviceId(2)).commandId, key: "h10-failed-device",
        receiptIndex: 3, sequence: 1, firmwareDigest: digest("a"), outcome: "FAILED", envelope: fleetEnvelopes.get(deviceId(2)),
      });
      const paused = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const deployment = snapshot.resources.deploymentWaves.find((entry) => entry.deploymentWaveId === deploymentWaveId);
        return deployment?.state === "PAUSED" ? { snapshot, deployment } : undefined;
      }, { timeoutMs: 60_000, label: "durable health-gate pause", children: [worker] });
      assert.equal(paused.deployment.waves.filter(({ state }) => state === "RUNNING").length, 0);

      const rollback = await ctx.mutate(baseUrl, `/api/v1/deployment-waves/${deploymentWaveId}/rollback`, "h10-rollback", {});
      assert.ok(rollback.status >= 200 && rollback.status < 300, rollback.text);
      const rollbackReplay = await ctx.mutate(baseUrl, `/api/v1/deployment-waves/${deploymentWaveId}/rollback`, "h10-rollback", {});
      assert.equal(ctx.canonical(rollbackReplay.json), ctx.canonical(rollback.json));
      const compensated = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrl);
        const member = snapshot.resources.waveDevices.find((entry) => entry.deploymentWaveId === deploymentWaveId && entry.deviceId === deviceId(0));
        return typeof member?.rollbackTargetId === "string" ? { snapshot, member } : undefined;
      }, { timeoutMs: 60_000, label: "rollback compensation target", children: [worker] });
      const targetsBeforeRollback = paused.snapshot.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === upgradeCampaignId);
      const targetsAfterRollback = compensated.snapshot.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === upgradeCampaignId);
      assert.equal(targetsAfterRollback.length, targetsBeforeRollback.length + 1);
      assert.equal(compensated.snapshot.resources.waveDevices.filter((entry) => entry.deploymentWaveId === deploymentWaveId && entry.rollbackTargetId === compensated.member.rollbackTargetId).length, 1);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const deploymentWaveId = find(response.json, "deploymentWaveId");
      const upgradeCampaignId = find(response.json, "upgradeCampaignId");
      let releaseBarrier;
      const held = new Promise((resolve) => { releaseBarrier = resolve; });
      let holdClaims = false;
      const barrier = await ctx.receiver((entry) => {
        if (holdClaims && entry.json?.point === "worker.claimed" && entry.json?.aggregateId === deploymentWaveId) {
          entry.held = true;
          return held;
        }
        return { status: 204 };
      });
      const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "edgetwin-h11" });
      const canary = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrls[0]);
        const member = snapshot.resources.waveDevices.find((entry) => entry.deploymentWaveId === deploymentWaveId && entry.deviceId === deviceId(0));
        return typeof member?.commandId === "string" ? { snapshot, member } : undefined;
      }, { timeoutMs: 60_000, label: "H-11 canary command", children: [first] });
      assertSingleRunningWave(canary.snapshot, upgradeCampaignId);
      holdClaims = true;
      await firmwareReceipt(ctx, baseUrls[1], {
        currentDeviceId: deviceId(0), commandId: canary.member.commandId, key: "h11-canary-match",
        receiptIndex: 1, sequence: 1, firmwareDigest: digest("b"),
      });
      await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(baseUrls[0]);
        const member = snapshot.resources.waveDevices.find((entry) => entry.deploymentWaveId === deploymentWaveId && entry.deviceId === deviceId(0));
        return member?.state === "SUCCEEDED" ? snapshot : undefined;
      }, { timeoutMs: 60_000, label: "H-11 confirmed canary", children: [first] });
      await ctx.waitFor(() => barrier.ledger.some(({ held: value }) => value), { timeoutMs: 60_000, label: "wave claim", children: [first] });
      await ctx.stop(first, "SIGKILL");
      releaseBarrier({ status: 204 });
      const controls = await Promise.all([
        ctx.mutate(baseUrls[0], `/api/v1/deployment-waves/${deploymentWaveId}/pause`, "h11-pause", {}),
        ctx.mutate(baseUrls[1], `/api/v1/deployment-waves/${deploymentWaveId}/resume`, "h11-resume", {}),
        ctx.mutate(baseUrls[0], `/api/v1/deployment-waves/${deploymentWaveId}/cancel`, "h11-cancel", {}),
        ctx.mutate(baseUrls[1], `/api/v1/deployment-waves/${deploymentWaveId}/rollback`, "h11-rollback", {}),
      ]);
      assert.ok(controls.some(({ status }) => status >= 200 && status < 300));
      assert.ok(controls.every(({ status }) => (status >= 200 && status < 300) || status === 409));
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const replacement = await ctx.startWorker();
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const work = value.work.filter(({ aggregateId }) => aggregateId === deploymentWaveId);
        return work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
      }, { timeoutMs: 60_000, label: "wave recovery", children: [replacement] });
      const deployment = snapshot.resources.deploymentWaves.filter((entry) => entry.deploymentWaveId === deploymentWaveId);
      assert.equal(deployment.length, 1);
      assert.ok(["QUEUED", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED", "ROLLED_BACK"].includes(deployment[0].state));
      assertSingleRunningWave(snapshot, upgradeCampaignId);
      const confirmedCanary = snapshot.resources.waveDevices.find((entry) => entry.deploymentWaveId === deploymentWaveId && entry.deviceId === deviceId(0));
      assert.ok(["SUCCEEDED", "ROLLBACK_PENDING", "ROLLED_BACK"].includes(confirmedCanary.state), "cancel pretended to undo an acknowledged device");
      if (controls[3].status >= 200 && controls[3].status < 300) assert.equal(typeof confirmedCanary.rollbackTargetId, "string");
    },
  },
  cases: { "H-09": edgeTwinMigration },
  performance: edgeTwinPerformance,
};

async function edgeTwinPerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  const shadowCount = Math.max(100, Math.ceil(100_000 * scale));
  assert.equal((await ctx.seed(shadowPerformanceSeed(shadowCount))).exitCode, 0);
  let api = await ctx.startApi();
  const shadowApiB = await ctx.startApi();
  const shadow = await fixedLoad(ctx, { count: shadowCount, concurrency: 64, request: (index) => ctx.mutate(index % 2 ? api.baseUrl : shadowApiB.baseUrl, `/api/v1/devices/${deviceId(index)}/shadow/desired`, `perf-shadow-${index}`, { tenantId, expectedVersion: 0, patch: { sampleRate: index % 100 } }, "PATCH") });
  assert.ok(shadow.throughput >= 500 && shadow.p95 <= 300, `shadow-patch-ingest ${shadow.throughput}/s p95=${shadow.p95}`);
  assert.equal(Object.entries(shadow.statuses).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((n, [, count]) => n + count, 0), 0);
  const shadowWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const shadowObservedAt = isoAfter(-1_000);
  const reported = await fixedLoad(ctx, { count: shadowCount, concurrency: 64, request: (index) => ctx.mutate(index % 2 ? shadowApiB.baseUrl : api.baseUrl, "/api/v1/command-receipts", `perf-shadow-reported-${index}`, {
    tenantId, deviceId: deviceId(index), commandId: id(300_000 + index), deliveryIdentity: id(500_000 + index),
    receiptId: id(700_000 + index), deviceSequence: 1, outcome: "ACKNOWLEDGED",
    reportedBaseVersion: 0, reportedPatch: { sampleRate: index % 100, firmwareDigest: digest("a") },
    observedAt: shadowObservedAt,
  }) });
  assert.ok(reported.throughput >= 500 && reported.p95 <= 300, `shadow-reported-ingest ${reported.throughput}/s p95=${reported.p95}`);
  assert.equal(Object.entries(reported.statuses).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((n, [, count]) => n + count, 0), 0);
  const shadowSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "reported shadow projection drain", children: shadowWorkers });
  assert.equal(shadowSnapshot.resources.deviceShadows.length, shadowCount);
  assert.ok(shadowSnapshot.resources.deviceShadows.every((entry) => {
    const index = Number(entry.deviceId.slice(-12)) - 1000;
    return entry.desiredVersion === 1
      && entry.desired?.sampleRate === index % 100
      && entry.reportedVersion === 1
      && entry.reported?.sampleRate === index % 100
      && entry.reported?.firmwareDigest === digest("a");
  }));
  assert.equal(shadowSnapshot.resources.commandReceipts.length, shadowCount);
  assert.equal(new Set(shadowSnapshot.resources.commandReceipts.map(({ receiptId }) => receiptId)).size, shadowCount);
  assert.ok(shadowSnapshot.resources.deviceCommands.every(({ state }) => state === "ACKNOWLEDGED"));
  assert.equal(new Set(shadowSnapshot.events.map(({ eventId }) => eventId)).size, shadowSnapshot.events.length);
  const shadowRssBytes = (await Promise.all([api, shadowApiB, ...shadowWorkers].map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  assertions.push(`shadow-patch-ingest desired ${shadow.throughput.toFixed(1)}/s, reported ${reported.throughput.toFixed(1)}/s, p95 ${Math.max(shadow.p95, reported.p95).toFixed(1)}ms`);

  await ctx.resetDatabase();
  const commandCount = Math.max(100, Math.ceil(50_000 * scale));
  assert.equal((await ctx.seed(seed("perf-edgetwin-commands", commandCount))).exitCode, 0);
  api = await ctx.startApi();
  const apiB = await ctx.startApi();
  const onlineCount = Math.ceil(commandCount / 2);
  const connected = await ctx.concurrent(Array.from({ length: onlineCount }), 64, (_, index) => ctx.mutate(index % 2 ? api.baseUrl : apiB.baseUrl, `/api/v1/devices/${deviceId(index * 2)}/connect`, `perf-connect-${index}`, { tenantId, connectionId: `perf-online-${index}` }));
  assert.ok(connected.every(({ status }) => status >= 200 && status < 300));
  const offlineCommands = [];
  const onlineDeliveries = [];
  const expiryAt = Date.now() + Math.max(10_000, Math.ceil(commandCount / 350) * 1_000 + 15_000);
  const expiresAt = new Date(expiryAt).toISOString();
  const commands = await fixedLoad(ctx, { count: commandCount, concurrency: 64, request: async (index) => {
    const currentDeviceId = deviceId(index);
    const created = await ctx.mutate(index % 2 ? api.baseUrl : apiB.baseUrl, "/api/v1/device-commands", `perf-command-${index}`, command(index, currentDeviceId, expiresAt));
    if (index % 2 === 0) {
      const pollBaseUrl = (index / 2) % 2 ? api.baseUrl : apiB.baseUrl;
      const polled = await ctx.mutate(pollBaseUrl, `/api/v1/devices/${currentDeviceId}/poll`, `perf-poll-${index}`, { tenantId, connectionId: `perf-online-${index / 2}`, limit: 10 });
      assert.ok(polled.status >= 200 && polled.status < 300, polled.text);
      const envelopes = find(polled.json, "commands") ?? find(polled.json, "items") ?? [];
      const matching = envelopes.filter(({ commandId }) => commandId === find(created.json, "commandId"));
      assert.equal(matching.length, 1);
      onlineDeliveries.push({ commandId: find(created.json, "commandId"), deliveryIdentity: matching[0].deliveryIdentity });
    } else {
      offlineCommands.push({ commandId: find(created.json, "commandId"), deviceId: currentDeviceId, index });
    }
    return created;
  } });
  assert.ok(commands.throughput >= 350 && commands.p95 <= 450, `offline-command-expiry ${commands.throughput}/s p95=${commands.p95}`);
  assert.equal(Object.entries(commands.statuses).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((n, [, count]) => n + count, 0), 0);
  const expiredPollSample = offlineCommands.slice(0, Math.min(offlineCommands.length, Math.max(20, Math.ceil(1000 * scale))));
  const expiredConnections = await ctx.concurrent(expiredPollSample, 64, async ({ deviceId: currentDeviceId, index }, sampleIndex) => {
    const connectionId = `perf-expired-${index}`;
    const baseUrl = sampleIndex % 2 ? api.baseUrl : apiB.baseUrl;
    const connectedDevice = await ctx.mutate(baseUrl, `/api/v1/devices/${currentDeviceId}/connect`, `perf-expired-connect-${index}`, { tenantId, connectionId });
    assert.ok(connectedDevice.status >= 200 && connectedDevice.status < 300, connectedDevice.text);
    return { baseUrl, connectionId };
  });
  let releasePolls;
  const pollBarrier = new Promise((resolve) => { releasePolls = resolve; });
  const expiredPolls = ctx.concurrent(expiredPollSample, 64, async ({ commandId, deviceId: currentDeviceId, index }, sampleIndex) => {
    await pollBarrier;
    const { baseUrl, connectionId } = expiredConnections[sampleIndex];
    const polled = await ctx.mutate(baseUrl, `/api/v1/devices/${currentDeviceId}/poll`, `perf-expired-poll-${index}`, { tenantId, connectionId, limit: 10 });
    assert.ok(polled.status >= 200 && polled.status < 300, polled.text);
    const envelopes = find(polled.json, "commands") ?? find(polled.json, "items") ?? [];
    assert.equal(envelopes.some((entry) => entry.commandId === commandId), false);
  });
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiryAt - Date.now() + 100)));
  releasePolls();
  await expiredPolls;

  const expiryWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const commandSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "command expiry drain", children: expiryWorkers });
  assert.equal(new Set(commandSnapshot.resources.deviceCommands.map(({ commandId }) => commandId)).size, commandSnapshot.resources.deviceCommands.length);
  const offlineIds = new Set(offlineCommands.map(({ commandId }) => commandId));
  assert.ok(commandSnapshot.resources.deviceCommands.filter(({ commandId }) => offlineIds.has(commandId)).every(({ state }) => state === "EXPIRED"));
  assert.equal(new Set(onlineDeliveries.map(({ commandId }) => commandId)).size, onlineCount);
  assert.equal(new Set(onlineDeliveries.map(({ deliveryIdentity }) => deliveryIdentity)).size, onlineCount);
  const commandsById = new Map(commandSnapshot.resources.deviceCommands.map((entry) => [entry.commandId, entry]));
  assert.ok(onlineDeliveries.every(({ commandId, deliveryIdentity }) => commandsById.get(commandId)?.deliveryIdentity === deliveryIdentity));
  assert.equal(new Set(commandSnapshot.events.map(({ eventId }) => eventId)).size, commandSnapshot.events.length);
  assert.ok(commandSnapshot.work.every(({ terminal }) => terminal));
  const commandRssBytes = (await Promise.all([api, apiB, ...expiryWorkers].map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  assertions.push(`offline-command-expiry ${commands.throughput.toFixed(1)}/s p95 ${commands.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const fleetCount = Math.max(50, Math.ceil(10_000 * scale));
  assert.equal((await ctx.seed(seed("perf-edgetwin-false-success", fleetCount))).exitCode, 0);
  api = await ctx.startApi();
  const probeCampaign = await ctx.mutate(api.baseUrl, "/api/v1/upgrade-campaigns", "perf-false-success-campaign", {
    tenantId, firmwareReleaseId: firmwareReleaseIds[1], deviceIds: [deviceId(0)],
  });
  assert.ok([200, 201, 202].includes(probeCampaign.status), probeCampaign.text);
  const probeCampaignId = find(probeCampaign.json, "upgradeCampaignId");
  const probeWorker = await ctx.startWorker();
  const probeReady = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const target = snapshot.resources.upgradeTargets.find((entry) => entry.upgradeCampaignId === probeCampaignId && typeof entry.commandId === "string");
    return target ? { snapshot, target } : undefined;
  }, { timeoutMs: 60_000, label: "false-success probe command", children: [probeWorker] });
  const probeConnectionId = "perf-false-success";
  const probeConnect = await ctx.mutate(api.baseUrl, `/api/v1/devices/${deviceId(0)}/connect`, "perf-false-success-connect", { tenantId, connectionId: probeConnectionId });
  assert.ok(probeConnect.status >= 200 && probeConnect.status < 300, probeConnect.text);
  const probePoll = await ctx.mutate(api.baseUrl, `/api/v1/devices/${deviceId(0)}/poll`, "perf-false-success-poll", { tenantId, connectionId: probeConnectionId, limit: 10 });
  assert.ok(probePoll.status >= 200 && probePoll.status < 300, probePoll.text);
  const probeCommands = find(probePoll.json, "commands") ?? find(probePoll.json, "items") ?? [];
  const probeEnvelope = probeCommands.find(({ commandId }) => commandId === probeReady.target.commandId);
  assert.ok(probeEnvelope, "false-success probe command was not delivered");
  const wrongDigestReceipt = await ctx.mutate(api.baseUrl, "/api/v1/command-receipts", "perf-false-success-receipt", {
    tenantId, deviceId: deviceId(0), commandId: probeReady.target.commandId,
    deliveryIdentity: probeEnvelope.deliveryIdentity,
    receiptId: id(700_000), deviceSequence: 1, outcome: "ACKNOWLEDGED",
    reportedBaseVersion: 0, reportedPatch: { firmwareDigest: digest("a") }, observedAt: isoAfter(-1_000),
  });
  assert.ok(wrongDigestReceipt.status >= 200 && wrongDigestReceipt.status < 300, wrongDigestReceipt.text);
  const falseSuccessSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const command = snapshot.resources.deviceCommands.find((entry) => entry.commandId === probeReady.target.commandId);
    return command?.state === "ACKNOWLEDGED" && snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "wrong-digest receipt projection", children: [probeWorker] });
  assert.notEqual(falseSuccessSnapshot.resources.upgradeTargets.find((entry) => entry.upgradeCampaignId === probeCampaignId).state, "SUCCEEDED");

  await ctx.resetDatabase();
  assert.equal((await ctx.seed(seed("perf-edgetwin-fleet", fleetCount))).exitCode, 0);
  api = await ctx.startApi();
  const fleetApiB = await ctx.startApi();
  const campaign = await ctx.mutate(api.baseUrl, "/api/v1/upgrade-campaigns", "perf-campaign", { tenantId, firmwareReleaseId: firmwareReleaseIds[1], deviceIds: Array.from({ length: fleetCount }, (_, index) => deviceId(index)) });
  assert.ok([200, 201, 202].includes(campaign.status), campaign.text);
  let releaseBarrier;
  const held = new Promise((resolve) => { releaseBarrier = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const first = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "edgetwin-perf" })));
  await ctx.waitFor(() => barrier.ledger.length >= 2, { label: "two upgrade claims", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseBarrier({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const targets = snapshot.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === find(campaign.json, "upgradeCampaignId"));
    const fanout = snapshot.work.filter(({ kind }) => kind === "UPGRADE_FANOUT");
    return targets.length === fleetCount && targets.every(({ commandId }) => typeof commandId === "string")
      && fanout.length > 0 && fanout.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "fleet upgrade fan-out recovery", children: replacements });
  const durationMs = Date.now() - startedAt;
  const targets = final.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === find(campaign.json, "upgradeCampaignId"));
  assert.equal(new Set(targets.map(({ deviceId: value }) => value)).size, fleetCount);
  const fleetCommandsById = new Map(final.resources.deviceCommands.map((entry) => [entry.commandId, entry]));
  const deliveries = await ctx.concurrent(targets, 64, async (target, index) => {
    const connectionId = `perf-fleet-${index}`;
    const baseUrl = index % 2 ? api.baseUrl : fleetApiB.baseUrl;
    const connectedDevice = await ctx.mutate(baseUrl, `/api/v1/devices/${target.deviceId}/connect`, `perf-fleet-connect-${index}`, { tenantId, connectionId });
    assert.ok(connectedDevice.status >= 200 && connectedDevice.status < 300, connectedDevice.text);
    const polled = await ctx.mutate(baseUrl, `/api/v1/devices/${target.deviceId}/poll`, `perf-fleet-poll-${index}`, { tenantId, connectionId, limit: 10 });
    assert.ok(polled.status >= 200 && polled.status < 300, polled.text);
    const envelopes = find(polled.json, "commands") ?? find(polled.json, "items") ?? [];
    assert.equal(envelopes.filter(({ commandId }) => commandId === target.commandId).length, 1);
    return envelopes.find(({ commandId }) => commandId === target.commandId);
  });
  const receipts = targets.map((target, index) => ({
    tenantId, deviceId: target.deviceId, commandId: target.commandId,
    deliveryIdentity: deliveries[index].deliveryIdentity ?? fleetCommandsById.get(target.commandId).deliveryIdentity,
    receiptId: id(600_000 + index), deviceSequence: 1, outcome: "ACKNOWLEDGED",
    reportedBaseVersion: 0, reportedPatch: { firmwareDigest: digest("b") }, observedAt: isoAfter(-1_000),
  }));
  const shuffled = [...receipts].reverse();
  const receiptResults = await ctx.concurrent(shuffled, 64, async (payload, index) => Promise.all([
    ctx.mutate(index % 2 ? api.baseUrl : fleetApiB.baseUrl, "/api/v1/command-receipts", `perf-receipt-${index}`, payload),
    ctx.mutate(index % 2 ? fleetApiB.baseUrl : api.baseUrl, "/api/v1/command-receipts", `perf-receipt-duplicate-${index}`, payload),
  ]));
  assert.ok(receiptResults.flat().every(({ status }) => status >= 200 && status < 300));
  const completed = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const currentTargets = snapshot.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === find(campaign.json, "upgradeCampaignId"));
    const currentCampaign = snapshot.resources.upgradeCampaigns.find((entry) => entry.upgradeCampaignId === find(campaign.json, "upgradeCampaignId"));
    return currentTargets.length === fleetCount && currentTargets.every(({ state }) => state === "SUCCEEDED") && currentCampaign?.state === "COMPLETED" ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "fleet receipt convergence", children: replacements });
  assert.equal(completed.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === find(campaign.json, "upgradeCampaignId")).length, fleetCount);
  assert.equal(new Set(completed.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === find(campaign.json, "upgradeCampaignId")).map(({ deviceId: value }) => value)).size, fleetCount);
  assert.equal(new Set(completed.resources.upgradeTargets.filter((entry) => entry.upgradeCampaignId === find(campaign.json, "upgradeCampaignId")).map(({ commandId }) => commandId)).size, fleetCount);
  assert.equal(new Set(completed.resources.commandReceipts.map(({ receiptId }) => receiptId)).size, completed.resources.commandReceipts.length);
  assert.equal(completed.resources.commandReceipts.length, fleetCount);
  assert.ok(completed.resources.deviceShadows.every(({ reportedVersion, reported }) => reportedVersion === 1 && reported?.firmwareDigest === digest("b")));
  assert.equal(new Set(completed.events.map(({ eventId }) => eventId)).size, completed.events.length);
  assert.equal(new Set(completed.work.map(({ workId }) => workId)).size, completed.work.length);
  assert.ok(completed.work.every(({ terminal }) => terminal));
  const fleetRssBytes = (await Promise.all([api, fleetApiB, ...replacements].map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  assertions.push(`fleet-upgrade-recovery ${fleetCount} targets in ${durationMs}ms after two SIGKILLs`);
  return {
    metrics: [
      { scenarioId: "shadow-patch-ingest", ...shadow, reportedThroughput: reported.throughput, reportedP50: reported.p50, reportedP95: reported.p95, reportedP99: reported.p99, reportedStatuses: reported.statuses, rssBytes: shadowRssBytes },
      { scenarioId: "offline-command-expiry", ...commands, rssBytes: commandRssBytes },
      { scenarioId: "fleet-upgrade-recovery", completed: fleetCount, durationMs, killedWorkers: 2, replacementWorkers: 4, rssBytes: fleetRssBytes },
    ],
    topology: { apiProcesses: 2, workers: 4 },
    rssBytes: Math.max(shadowRssBytes, commandRssBytes, fleetRssBytes),
    databaseBytes: completed.metrics?.databaseBytes ?? null,
  };
}

export default standardAdapter(spec);
