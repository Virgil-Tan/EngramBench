// Policy revision: learning-final-system-2026-09-08.1. One FINAL submission; current public operations, persistence and restart recovery, not a historical binary upgrade.
import { performanceSeed, performanceContract, invalidSeedFixtures } from "../fixtures/index.mjs";
import { applyMergePatch, percentile } from "../oracles/index.mjs";
import {
  addCaps,
  assertNoChange,
  assertSnapshot,
  connect,
  createCampaign,
  createCommand,
  edgeSeed,
  expectError,
  finalEvidence,
  guardedCase,
  patchDesired,
  poll,
  resource,
  stableSnapshot,
  startWorkers,
  submitReceipt,
  waitSnapshot,
} from "./helpers.mjs";

async function installBuildMigrate(ctx, workspace) {
  const target = ctx.forWorkspace(workspace);
  await target.command("npm", ["ci", "--no-audit", "--no-fund"], { timeoutMs: 600_000 });
  await target.npm("build", [], { timeoutMs: 600_000 });
  await target.migrate({ timeoutMs: 300_000 });
  return target;
}

async function runExactOperations(ctx, operations, concurrency) {
  const latencies = [];
  let unexpected5xx = 0;
  let failures = 0;
  const startedAt = performance.now();
  const results = await ctx.concurrent(operations, concurrency, async (operation) => {
    const started = performance.now();
    try {
      const response = await operation();
      latencies.push(performance.now() - started);
      if (response.status >= 500) unexpected5xx += 1;
      if (response.status < 200 || response.status >= 300) failures += 1;
      return response;
    } catch (error) {
      failures += 1;
      return { status: 0, error };
    }
  });
  const durationMs = performance.now() - startedAt;
  return {
    results,
    durationMs,
    throughput: operations.length / (durationMs / 1_000),
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    unexpected5xx,
    failures,
  };
}

const operate01 = guardedCase({
  id: "OPERATE-01", fixtureFamily: "ET-F-PERF-100K-SHADOW-PATCHES",
  action: "Materialize exactly 100000 devices, run complete desired and reported update operations from 64 closed-loop clients through two production APIs, then fetch the full snapshot.",
  oracle: "Measured throughput is at least 500 patches per second, p95 is at most 300 ms and 5xx is zero; every version and stored value equals independent deterministic replay.",
  async run(ctx) {
    const contract = performanceContract().shadow;
    const seed = performanceSeed(ctx.fixtures, { scenario: "shadow" });
    seed.deviceCommands = seed.devices.map((device, index) => ({
      commandId: ctx.uuid(`shadow-perf-command-${index}`), tenantId: device.tenantId, deviceId: device.deviceId,
      kind: "REPORT", payload: {}, desiredVersion: 2, deliveryIdentity: ctx.uuid(`shadow-perf-delivery-${index}`),
      state: "DELIVERED", expiresAt: ctx.at({ days: 1 }), createdAt: ctx.at({ minutes: -5, milliseconds: index % 1000 }),
    }));
    const target = ctx.forWorkspace(ctx.workspace);
    await target.npm("build", [], { timeoutMs: 600_000 });
    await target.migrate({ timeoutMs: 300_000 });
    await target.seed(seed, { timeoutMs: 1_800_000 });
    const apis = [await target.startApi(), await target.startApi()];
    const operations = [];
    for (let index = 0; index < contract.devices; index += 1) {
      const device = seed.devices[index];
      const shadow = seed.deviceShadows[index];
      const command = seed.deviceCommands[index];
      operations.push(() => ctx.mutate(apis[index % 2].baseUrl, `/api/v1/devices/${device.deviceId}/shadow/desired`, ctx.key(`perf-desired-${index}`), {
        tenantId: device.tenantId, expectedVersion: shadow.desiredVersion, patch: { loadOrdinal: index },
      }, { method: "PATCH", timeoutMs: 30_000 }));
      operations.push(() => ctx.mutate(apis[(index + 1) % 2].baseUrl, "/api/v1/command-receipts", ctx.key(`perf-reported-${index}`), {
        tenantId: device.tenantId, deviceId: device.deviceId, commandId: command.commandId, deliveryIdentity: command.deliveryIdentity,
        receiptId: ctx.uuid(`shadow-perf-receipt-${index}`), deviceSequence: 1, outcome: "ACKNOWLEDGED",
        reportedBaseVersion: shadow.reportedVersion, reportedPatch: { observedOrdinal: index }, observedAt: ctx.at({ minutes: 1, milliseconds: index % 1000 }),
      }, { timeoutMs: 30_000 }));
    }
    const metrics = await runExactOperations(ctx, operations, contract.clients);
    ctx.equal(metrics.failures, 0, "all shadow load operations succeed");
    ctx.equal(metrics.unexpected5xx, 0, "shadow load has no unexpected 5xx");
    ctx.ok(metrics.throughput >= contract.minimumThroughput, "shadow throughput meets contract");
    ctx.ok(metrics.p95 <= contract.maximumP95Ms, "shadow p95 meets contract");
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 300_000 }));
    ctx.equal(resource(snapshot, "deviceShadows").length, contract.devices, "full shadow cardinality");
    for (const [index, shadow] of resource(snapshot, "deviceShadows").entries()) {
      const source = seed.deviceShadows[index];
      ctx.equal(shadow.desiredVersion, source.desiredVersion + 1, "desired version is contiguous", { hardCapIds: ["VERSION_REGRESSION"] });
      ctx.equal(shadow.reportedVersion, source.reportedVersion + 1, "reported version is contiguous", { hardCapIds: ["VERSION_REGRESSION"] });
      ctx.equal(shadow.desired, applyMergePatch(source.desired, { loadOrdinal: index }), "desired value matches independent replay");
      ctx.equal(shadow.reported, applyMergePatch(source.reported, { observedOrdinal: index }), "reported value matches independent replay");
    }
    return finalEvidence(ctx, { operations: operations.length, clients: contract.clients, ...metrics, results: undefined });
  },
});

const operate02 = guardedCase({
  id: "OPERATE-02", fixtureFamily: "ET-F-PERF-50K-COMMAND-EXPIRY",
  action: "Create exactly 50000 commands across online and offline devices through two APIs, hold poll at the published expiry barrier, cross database expiry and complete all eligible polls.",
  oracle: "Mutation throughput reaches 350 per second with p95 at most 450 ms, no expired command is delivered, every eligible command has one stable logical identity and post-load Work closes.",
  async run(ctx) {
    const contract = performanceContract().commands;
    const seed = performanceSeed(ctx.fixtures, { scenario: "commands" });
    seed.deviceCommands = [];
    seed.devices = seed.devices.map((device, index) => ({ ...device, state: index % 2 === 0 ? "ONLINE" : "OFFLINE", lastSeenAt: index % 2 === 0 ? ctx.at({ minutes: -1 }) : null }));
    let heldPolls = 0;
    const barrier = await ctx.barrier({
      hold: ({ point, commandId }) => point === "poll.before-delivery" && typeof commandId === "string" && heldPolls++ < 64,
    });
    const target = ctx.forWorkspace(ctx.workspace);
    await target.npm("build", [], { timeoutMs: 600_000 });
    await target.migrate({ timeoutMs: 300_000 });
    await target.seed(seed, { timeoutMs: 1_800_000 });
    const apis = [
      await target.startApi({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }),
      await target.startApi({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }),
    ];
    const expiresSoon = new Date(Date.now() + 4_000).toISOString();
    const expiresLater = new Date(Date.now() + 3_600_000).toISOString();
    const operations = seed.devices.map((device, index) => () => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/device-commands", ctx.key(`perf-command-${index}`), {
      tenantId: device.tenantId, deviceId: device.deviceId, kind: "LOAD", payload: { ordinal: index }, desiredVersion: seed.deviceShadows[index].desiredVersion,
      expiresAt: index % 2 === 0 ? expiresLater : expiresSoon,
    }, { timeoutMs: 30_000 }));
    const metrics = await runExactOperations(ctx, operations, 64);
    ctx.equal(metrics.failures, 0, "all command mutations succeed");
    ctx.equal(metrics.unexpected5xx, 0, "command load has no unexpected 5xx");
    ctx.ok(metrics.throughput >= contract.minimumThroughput, "command throughput meets contract");
    ctx.ok(metrics.p95 <= contract.maximumP95Ms, "command p95 meets contract");
    const workers = await startWorkers(ctx, 4, { env: { WORK_LEASE_SECONDS: "1" } });
    const connectionMetrics = await runExactOperations(ctx, seed.devices.map((device, index) => () => ctx.mutate(
      apis[index % 2].baseUrl,
      `/api/v1/devices/${device.deviceId}/connect`,
      ctx.key(`perf-connect-${index}`),
      { tenantId: device.tenantId },
      { timeoutMs: 30_000 },
    )), 64);
    ctx.equal(connectionMetrics.failures, 0, "all load devices connect");
    const connections = connectionMetrics.results.map(({ json }) => json.connectionId);
    ctx.ok(connections.every((value) => typeof value === "string"), "every connect returns a connectionId");
    const pollPromise = runExactOperations(ctx, seed.devices.map((device, index) => () => ctx.mutate(
      apis[index % 2].baseUrl,
      `/api/v1/devices/${device.deviceId}/poll`,
      ctx.key(`perf-poll-${index}`),
      { tenantId: device.tenantId, connectionId: connections[index], limit: 1 },
      { timeoutMs: 60_000 },
    )), 64);
    await ctx.waitFor(() => barrier.ledger.length >= 64, { timeoutMs: 60_000, label: "published poll expiry barriers" });
    await ctx.waitFor(() => Date.now() > Date.parse(expiresSoon) + 100, { timeoutMs: 30_000, label: "expiry boundary" });
    barrier.releaseAll();
    const pollMetrics = await pollPromise;
    ctx.equal(pollMetrics.failures, 0, "all load polls complete");
    const deliveredIds = pollMetrics.results.flatMap(({ json }) => (Array.isArray(json) ? json : json?.items ?? [])).map(({ commandId }) => commandId);
    ctx.equal(new Set(deliveredIds).size, deliveredIds.length, "eligible commands are delivered at most once logically");
    const snapshot = await waitSnapshot(ctx, apis[0].baseUrl, (value) => resource(value, "deviceCommands").length === contract.commands && (value.work ?? []).every(({ terminal }) => terminal), { timeoutMs: 120_000, processes: workers });
    assertSnapshot(ctx, snapshot);
    const expired = resource(snapshot, "deviceCommands").filter(({ expiresAt }) => expiresAt === expiresSoon);
    ctx.ok(expired.every(({ state }) => state === "EXPIRED"), "all short-lived commands expire", { hardCapIds: ["EXPIRED_DELIVERY"] });
    const expiredIds = new Set(expired.map(({ commandId }) => commandId));
    ctx.ok(deliveredIds.every((commandId) => !expiredIds.has(commandId)), "no expired command delivered", { hardCapIds: ["EXPIRED_DELIVERY"] });
    ctx.equal(new Set(resource(snapshot, "deviceCommands").map(({ deliveryIdentity }) => deliveryIdentity)).size, contract.commands, "stable unique delivery identity per command");
    return finalEvidence(ctx, { operations: operations.length, polls: pollMetrics.results.length, apiProcesses: apis.length, workers: workers.length, throughput: metrics.throughput, p95: metrics.p95 });
  },
});

const operate03 = guardedCase({
  id: "OPERATE-03", fixtureFamily: "ET-F-PERF-10K-UPGRADE-RECOVERY",
  action: "Freeze exactly 10000 devices, kill two workers at public worker.claimed, start four replacements, inject all shuffled duplicate firmware receipts and recompute every target and aggregate within 60 seconds.",
  oracle: "Each device owns one target and command, only matching firmware acknowledgement succeeds, killed leases never commit, Campaign and Event authority close and all eligible Work drains.",
  async run(ctx) {
    const contract = performanceContract().upgrade;
    const seed = performanceSeed(ctx.fixtures, { scenario: "upgrade" });
    seed.devices = seed.devices.map((device) => ({ ...device, state: "ONLINE", lastSeenAt: ctx.at({ minutes: -1 }) }));
    const target = ctx.forWorkspace(ctx.workspace);
    await target.npm("build", [], { timeoutMs: 600_000 });
    await target.migrate({ timeoutMs: 300_000 });
    await target.seed(seed, { timeoutMs: 1_800_000 });
    const api = await target.startApi();
    const { campaign } = await createCampaign(ctx, api.baseUrl, {
      tenantId: seed.tenants[0].tenantId,
      firmwareReleaseId: seed.firmwareReleases[1].firmwareReleaseId,
      deviceIds: seed.devices.map(({ deviceId }) => deviceId),
    });
    const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" });
    const claimed = [];
    for (let index = 0; index < contract.killedWorkers; index += 1) {
      const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: "1" } });
      claimed.push(worker);
      await ctx.waitFor(() => barrier.ledger.filter(({ json }) => json?.point === "worker.claimed").length >= index + 1, { timeoutMs: 60_000, label: `claimed worker ${index + 1}`, processes: [worker] });
      await ctx.kill(worker);
      barrier.releaseAll();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    const recoveryStarted = performance.now();
    const replacements = await startWorkers(ctx, contract.replacementWorkers, { env: { WORK_LEASE_SECONDS: "1" } });
    let snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => {
      const selected = resource(value, "upgradeTargets").filter(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId);
      return selected.length === contract.devices && selected.every(({ commandId }) => commandId);
    }, { timeoutMs: 60_000, processes: replacements });
    const targets = resource(snapshot, "upgradeTargets").filter(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId);
    const commands = new Map(resource(snapshot, "deviceCommands").map((command) => [command.commandId, command]));
    const shadows = new Map(resource(snapshot, "deviceShadows").map((shadow) => [shadow.deviceId, shadow]));
    const connectionMetrics = await runExactOperations(ctx, targets.map((upgradeTarget, index) => () => {
      const command = commands.get(upgradeTarget.commandId);
      return ctx.mutate(api.baseUrl, `/api/v1/devices/${command.deviceId}/connect`, ctx.key(`upgrade-connect-${index}`), { tenantId: command.tenantId }, { timeoutMs: 30_000 });
    }), 64);
    ctx.equal(connectionMetrics.failures, 0, "all upgrade devices connect");
    const pollMetrics = await runExactOperations(ctx, targets.map((upgradeTarget, index) => () => {
      const command = commands.get(upgradeTarget.commandId);
      return ctx.mutate(api.baseUrl, `/api/v1/devices/${command.deviceId}/poll`, ctx.key(`upgrade-poll-${index}`), {
        tenantId: command.tenantId, connectionId: connectionMetrics.results[index].json.connectionId, limit: 1,
      }, { timeoutMs: 30_000 });
    }), 64);
    ctx.equal(pollMetrics.failures, 0, "all upgrade commands are polled");
    const receipts = targets.map((upgradeTarget, index) => {
      const command = commands.get(upgradeTarget.commandId);
      return {
        tenantId: command.tenantId, deviceId: command.deviceId, commandId: command.commandId, deliveryIdentity: command.deliveryIdentity,
        receiptId: ctx.uuid(`perf-upgrade-receipt-${index}`), deviceSequence: index + 1, outcome: "ACKNOWLEDGED",
        reportedBaseVersion: shadows.get(command.deviceId).reportedVersion,
        reportedPatch: { firmwareDigest: seed.firmwareReleases[1].digest }, observedAt: ctx.at({ minutes: 2, milliseconds: index % 1000 }),
      };
    });
    const shuffled = [...receipts].sort((left, right) => right.deviceSequence - left.deviceSequence);
    const submissions = [...shuffled, ...shuffled];
    const responses = await ctx.concurrent(submissions, 64, (body, index) => ctx.mutate(api.baseUrl, "/api/v1/command-receipts", ctx.key(`perf-upgrade-${index % contract.devices}`), body, { timeoutMs: 30_000 }));
    ctx.ok(responses.every(({ status }) => status === 200), "shuffled duplicate receipts replay");
    snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => {
      const selected = resource(value, "upgradeTargets").filter(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId);
      return selected.length === contract.devices && selected.every(({ state }) => state === "SUCCEEDED") && (value.work ?? []).every(({ terminal }) => terminal);
    }, { timeoutMs: 60_000, processes: replacements });
    const recoverySeconds = (performance.now() - recoveryStarted) / 1_000;
    ctx.ok(recoverySeconds <= contract.maximumRecoverySeconds, "upgrade recovery meets 60 second deadline");
    assertSnapshot(ctx, snapshot);
    const finalTargets = resource(snapshot, "upgradeTargets").filter(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId);
    ctx.equal(new Set(finalTargets.map(({ deviceId }) => deviceId)).size, contract.devices, "one target per device", { hardCapIds: ["FALSE_FIRMWARE_SUCCESS", "STALE_WORK_COMMIT"] });
    ctx.equal(new Set(finalTargets.map(({ commandId }) => commandId)).size, contract.devices, "one command per device", { hardCapIds: ["FALSE_FIRMWARE_SUCCESS", "STALE_WORK_COMMIT"] });
    return finalEvidence(ctx, { devices: contract.devices, killedWorkers: claimed.length, replacementWorkers: replacements.length, polls: pollMetrics.results.length, receiptSubmissions: submissions.length, recoverySeconds });
  },
});

const operate04 = guardedCase({
  id: "OPERATE-04", fixtureFamily: "ET-F-base-system-reinitialization-SEED-COMPATIBILITY",
  action: "Populate a base-system restart boundary with Campaign, targets, command, receipt, leased Work and unknown-response replay, restart twice, then run exact seed replay, conflict and invalid-graph imports.",
  oracle: "Current Campaign, Wave, command, Event, Work and saved response identities survive restart; invalid seed writes remain fully atomic, without migration-only Wave creation.",
  async run(ctx) {
    try {
      const seed = edgeSeed(ctx, { withCommand: false });
      seed.upgradeCampaigns = [{
        upgradeCampaignId: ctx.uuid("legacy-campaign"), tenantId: seed.tenants[0].tenantId,
        firmwareReleaseId: seed.firmwareReleases[1].firmwareReleaseId, state: "RUNNING", createdAt: ctx.at({ days: -1 }),
      }];
      seed.upgradeTargets = seed.devices.slice(0, 2).map((device, index) => ({
        upgradeCampaignId: seed.upgradeCampaigns[0].upgradeCampaignId, deviceId: device.deviceId,
        priorFirmwareDigest: seed.firmwareReleases[0].digest, state: index === 0 ? "PENDING" : "FAILED", commandId: null,
      }));
      const initialRuntime = await installBuildMigrate(ctx, ctx.workspace);
      await initialRuntime.seed(seed, { timeoutMs: 600_000 });
      const initialApi = await initialRuntime.startApi();
      const body = {
        tenantId: seed.tenants[0].tenantId, deviceId: seed.devices[0].deviceId, kind: "reinitialization",
        payload: { preserve: true }, desiredVersion: seed.deviceShadows[0].desiredVersion, expiresAt: ctx.at({ days: 1 }),
      };
      const key = ctx.key("reinitialization-command-replay");
      const shield = await ctx.responseShield(initialApi.baseUrl);
      shield.dropNextMutation();
      await ctx.mutate(shield.baseUrl, "/api/v1/device-commands", key, body).catch(() => undefined);
      const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { timeoutMs: 30_000, label: "base-system saved response" });
      const saved = { status: capture.response.status, json: JSON.parse(capture.response.body) };
      const replayBefore = await ctx.mutate(initialApi.baseUrl, "/api/v1/device-commands", key, body);
      ctx.equal({ status: replayBefore.status, json: replayBefore.json }, saved, "base-system saved replay");
      const before = await ctx.snapshot(initialApi.baseUrl);
      await ctx.kill(initialApi);

      const final = await installBuildMigrate(ctx, ctx.workspace);
      let finalApi = await final.startApi();
      let after = await ctx.snapshot(finalApi.baseUrl);
      for (const keyName of ["tenants", "devices", "deviceShadows", "deviceCommands", "commandReceipts", "firmwareReleases", "upgradeCampaigns", "upgradeTargets"]) {
        ctx.equal(after.resources[keyName], before.resources[keyName], `${keyName} identity survives reinitialization`, { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
      }
      ctx.equal(after.work, before.work, "Work identity and lease survive reinitialization", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE", "STALE_WORK_COMMIT"] });
      ctx.equal(after.events, before.events, "Event identity and body survive reinitialization", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE"] });
      ctx.equal(resource(after, "deploymentWaves"), resource(before, "deploymentWaves"), "current DeploymentWave records survive restart");
      const replayAfter = await ctx.mutate(finalApi.baseUrl, "/api/v1/device-commands", key, body);
      ctx.equal({ status: replayAfter.status, json: replayAfter.json }, saved, "saved base-system replay survives reinitialization", { hardCapIds: ["MIGRATION_IDENTITY_REWRITE", "DURABLE_IDEMPOTENCY"] });
      await ctx.stop(finalApi);
      await final.migrate({ timeoutMs: 300_000 });
      finalApi = await final.startApi();
      const repeated = await ctx.snapshot(finalApi.baseUrl);
      ctx.equal(resource(repeated, "deploymentWaves"), resource(after, "deploymentWaves"), "repeated initialization preserves current Wave identities");

      await final.seed(seed, { timeoutMs: 600_000 });
      const changed = { ...structuredClone(seed), tenants: [{ ...seed.tenants[0], name: "changed" }] };
      const changedResult = await final.seed(changed, { timeoutMs: 600_000, allowFailure: true });
      ctx.ok(changedResult.exitCode !== 0 && /SEED_VERSION_CONFLICT/u.test(`${changedResult.stdout}\n${changedResult.stderr}`), "changed same-version seed conflicts");
      for (const invalid of invalidSeedFixtures(ctx.fixtures)) {
        const beforeInvalid = await ctx.snapshot(finalApi.baseUrl);
        const result = await final.seed(invalid.value, { timeoutMs: 600_000, allowFailure: true });
        ctx.ok(result.exitCode !== 0, `${invalid.label} seed is rejected`);
        assertNoChange(ctx, beforeInvalid, await ctx.snapshot(finalApi.baseUrl), `${invalid.label} seed`);
      }
      after = assertSnapshot(ctx, await ctx.snapshot(finalApi.baseUrl));
      return finalEvidence(ctx, { preservedWaves: resource(before, "deploymentWaves").length, initializations: 2, invalidSeeds: invalidSeedFixtures(ctx.fixtures).length, resources: Object.keys(after.resources).length });
    } catch (error) {
      throw addCaps(error, ["MIGRATION_IDENTITY_REWRITE", "DURABLE_IDEMPOTENCY", "STALE_WORK_COMMIT"]);
    }
  },
});

export const OPERATE_CASES = Object.freeze([operate01, operate02, operate03, operate04]);
