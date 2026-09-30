import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CaseExcluded } from "../lib/execution.mjs";
import {
  baseBundle,
  campaignRequest,
  performanceBundle,
  performanceContract,
} from "../fixtures/index.mjs";
import {
  canonicalJson,
  canonicalVersion,
  percentile,
} from "../oracles/index.mjs";
import {
  V1_KEYS,
  assertSnapshot,
  byId,
  closedLoop,
  completeForwardFlow,
  createCampaign,
  guardedCase,
  importBundle,
  poll,
  prepare,
  result,
  stableSnapshot,
  submitCommand,
  waitCommand,
  waitSnapshot,
} from "./helpers.mjs";

async function e01(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 2 }),
    v1 = ctx.forWorkspace(ctx.v1Workspace);
  await v1.command("npm", ["ci", "--no-audit", "--no-fund"], {
    timeoutMs: 600_000,
  });
  await v1.npm("build", [], { timeoutMs: 600_000 });
  await v1.migrate({ timeoutMs: 300_000 });
  assert.equal(
    (
      await importBundle(ctx, bundle, {
        workspace: ctx.v1Workspace,
        label: "v1",
      })
    ).exitCode,
    0,
  );
  const api = await v1.startApi(),
    model = bundle.seed.deviceModels[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === model.modelId &&
        canonicalVersion(image.version) === "2",
    ),
    canary = bundle.seed.devices.find(
      (device) =>
        device.modelId === model.modelId &&
        device.labels.environment === "canary",
    ),
    prod = bundle.seed.devices.find(
      (device) =>
        device.modelId === model.modelId &&
        device.labels.environment === "prod",
    );
  const completed = (
      await createCampaign(
        ctx,
        api,
        "e01-completed",
        campaignRequest(
          target.firmwareImageId,
          { modelId: model.modelId, labels: { environment: "canary" } },
          { maxParallel: 1 },
        ),
      )
    ).json,
    worker = await v1.startWorker();
  await completeForwardFlow(ctx, api, canary.deviceId, "e01-complete", {
    worker,
  });
  await waitSnapshot(
    ctx,
    api,
    (snapshot) =>
      byId(
        snapshot.resources.firmwareCampaigns,
        "campaignId",
        completed.campaignId,
      ).state === "SUCCEEDED",
    "V1 completed",
    { processes: [worker] },
  );
  await ctx.stop(worker);
  const shield = await ctx.responseShield(api.baseUrl),
    savedKey = ctx.key("e01-saved"),
    savedBody = campaignRequest(
      target.firmwareImageId,
      { modelId: model.modelId, labels: { environment: "prod" } },
      { maxParallel: 1 },
    );
  shield.dropNextMutation();
  await ctx
    .mutate(shield.baseUrl, "/api/v1/firmware-campaigns", savedKey, savedBody)
    .catch(() => undefined);
  const captured = await ctx.waitFor(
      () => shield.captures.find(({ dropped }) => dropped),
      { label: "V1 saved Campaign response" },
    ),
    saved = {
      status: captured.response.status,
      json: JSON.parse(captured.response.body),
    };
  const heldBarrier = await ctx.barrier({
      hold: ({ point }) => point === "worker.claimed",
    }),
    leased = await v1.startWorker({
      env: {
        TEST_BARRIER_URL: heldBarrier.url,
        TEST_BARRIER_TOKEN: heldBarrier.token,
        WORK_LEASE_SECONDS: 30,
      },
    }),
    leaseEntry = await heldBarrier.waitFor(
      ({ json }) => json.point === "worker.claimed",
      { timeoutMs: 30_000, processes: [leased] },
    );
  const before = await ctx.snapshot(api.baseUrl);
  assert.equal(before.resources.upgradePlans, undefined);
  assert.ok(before.work.some(({ state }) => state === "LEASED"));
  await ctx.kill(leased);
  heldBarrier.release(leaseEntry);
  await ctx.stop(api);
  const final = ctx.forWorkspace(ctx.workspace);
  await final.command("npm", ["ci", "--no-audit", "--no-fund"], {
    timeoutMs: 600_000,
  });
  await final.npm("build", [], { timeoutMs: 600_000 });
  await final.migrate({ timeoutMs: 300_000 });
  await final.migrate({ timeoutMs: 300_000 });
  const finalApi = await final.startApi(),
    after = assertSnapshot(await ctx.snapshot(finalApi.baseUrl));
  for (const key of V1_KEYS)
    assert.deepEqual(
      after.resources[key],
      before.resources[key],
      `migration changed V1 ${key}`,
    );
  assert.deepEqual(after.events, before.events);
  for (const update of before.resources.deviceUpdates) {
    const upgrade = byId(
      after.resources.upgradePlans,
      "deviceUpdateId",
      update.deviceUpdateId,
    );
    assert.equal(upgrade.hops.length, 1);
    assert.equal(
      upgrade.hops[0].firstCommandSequence ??
        upgrade.hops[0].attempts[0].firstCommandSequence,
      1,
    );
  }
  const replay = await ctx.mutate(
    finalApi.baseUrl,
    "/api/v1/firmware-campaigns",
    savedKey,
    savedBody,
  );
  assert.equal(replay.status, saved.status);
  assert.equal(canonicalJson(replay.json), canonicalJson(saved.json));
  const completedCommands = after.resources.deviceCommands.filter(
    ({ deviceUpdateId }) =>
      before.resources.deviceUpdates.some(
        (update) =>
          update.campaignId === completed.campaignId &&
          update.deviceUpdateId === deviceUpdateId,
      ),
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    (await ctx.snapshot(finalApi.baseUrl)).resources.deviceCommands.filter(
      ({ deviceUpdateId }) =>
        before.resources.deviceUpdates.some(
          (update) =>
            update.campaignId === completed.campaignId &&
            update.deviceUpdateId === deviceUpdateId,
        ),
    ).length,
    completedCommands,
  );
  const current = before.resources.deviceCommands.find(({ deviceUpdateId }) =>
    before.resources.deviceUpdates.some(
      (update) =>
        update.deviceId === prod.deviceId &&
        update.deviceUpdateId === deviceUpdateId,
    ),
  );
  if (current) {
    const polled = await poll(
      ctx,
      finalApi,
      "e01-old-poll",
      prod.deviceId,
      current.sequence - 1,
    );
    assert.equal(polled.json.command.commandId, current.commandId);
    assert.equal(polled.json.command.commandToken, current.commandToken);
  }
  return result(
    "V1 arrays events and replay preserved",
    "one-hop Plans backfilled",
    "completed/in-flight command identity retained",
  );
}

async function e02(ctx) {
  const contract = performanceContract().poll,
    bundle = performanceBundle(ctx.fixtures),
    api = await prepare(ctx, bundle),
    snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)),
    entries = snapshot.resources.deviceUpdates
      .map((update) => ({
        device: byId(snapshot.resources.devices, "deviceId", update.deviceId),
        command: byId(
          snapshot.resources.deviceCommands,
          "deviceUpdateId",
          update.deviceUpdateId,
        ),
      }))
      .sort((left, right) =>
        Buffer.from(left.device.deviceId).compare(
          Buffer.from(right.device.deviceId),
        ),
      ),
    commandEntries = entries.filter((_, index) => index % 2 === 0),
    noChangeEntries = entries.filter((_, index) => index % 2 === 1);
  let ordinal = 0;
  const metrics = await closedLoop({
    clients: contract.clients,
    warmupMs: contract.warmupSeconds * 1000,
    measureMs: contract.measureSeconds * 1000,
    operation: async ({ collect }) => {
      const index = ordinal++,
        isCommand = index % 2 === 0,
        list = isCommand ? commandEntries : noChangeEntries,
        entry = list[Math.floor(index / 2) % list.length],
        response = await poll(
          ctx,
          api,
          `e02-${index}`,
          entry.device.deviceId,
          isCommand ? entry.command.sequence - 1 : entry.command.sequence,
        );
      if (collect) {
        assert.equal(response.json.status, isCommand ? "COMMAND" : "NO_CHANGE");
        if (isCommand) {
          assert.equal(
            response.json.command.commandId,
            entry.command.commandId,
          );
          assert.equal(
            response.json.command.commandToken,
            entry.command.commandToken,
          );
        } else assert.equal(response.json.command, null);
      }
      return response;
    },
  });
  assert.ok(
    metrics.throughput >= contract.minimumThroughput,
    `${metrics.throughput}/s`,
  );
  assert.ok(metrics.p95 <= contract.maximumP95Ms, `${metrics.p95}ms`);
  assert.equal(metrics.unexpected5xx, 0);
  assert.equal(ordinal % 2, 0);
  const after = assertSnapshot(await ctx.snapshot(api.baseUrl));
  for (const campaign of after.resources.firmwareCampaigns)
    assert.ok(
      after.resources.deviceUpdates.filter(
        ({ campaignId, state }) =>
          campaignId === campaign.campaignId &&
          ![
            "WAITING",
            "SUCCEEDED",
            "FAILED",
            "ROLLED_BACK",
            "CANCELLED",
          ].includes(state),
      ).length <= campaign.maxParallel,
    );
  return result(
    `poll ${metrics.throughput.toFixed(2)}/s`,
    `p95 ${metrics.p95.toFixed(2)}ms`,
    "alternating exact COMMAND/NO_CHANGE with zero 5xx",
  );
}

async function reportPairs(ctx, api, entries, start, count, clients, collect) {
  let cursor = 0,
    completed = 0,
    unexpected5xx = 0;
  const latencies = [];
  const began = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async () => {
      while (true) {
        const offset = cursor++;
        if (offset >= count) break;
        const entry = entries[start + offset],
          body = {
            firstSequence: entry.command.sequence,
            reports: [
              {
                sequence: entry.command.sequence,
                commandId: entry.command.commandId,
                commandToken: entry.command.commandToken,
                outcome: offset % 10 === 9 ? "FAILED" : "SUCCEEDED",
                installedDigest: null,
              },
            ],
          };
        for (let replay = 0; replay < 2; replay += 1) {
          const before = performance.now(),
            response = await ctx.mutate(
              api.baseUrl,
              `/api/v1/devices/${entry.device.deviceId}/report-batches`,
              ctx.key(`e03-${start + offset}`),
              body,
            );
          assert.equal(response.status, 200, response.text);
          if (collect) {
            completed += 1;
            latencies.push(performance.now() - before);
            if (response.status >= 500) unexpected5xx += 1;
          }
        }
      }
    }),
  );
  return {
    completed,
    unexpected5xx,
    latencies,
    elapsedSeconds: (performance.now() - began) / 1000,
  };
}

async function e03(ctx) {
  const contract = performanceContract().report,
    bundle = performanceBundle(ctx.fixtures),
    api = await prepare(ctx, bundle),
    snapshot = await ctx.snapshot(api.baseUrl),
    entries = snapshot.resources.deviceUpdates
      .map((update) => ({
        device: byId(snapshot.resources.devices, "deviceId", update.deviceId),
        command: byId(
          snapshot.resources.deviceCommands,
          "deviceUpdateId",
          update.deviceUpdateId,
        ),
      }))
      .sort((left, right) =>
        Buffer.from(left.device.deviceId).compare(
          Buffer.from(right.device.deviceId),
        ),
      );
  assert.equal(entries.length, 100_000);
  const warmupStarted = performance.now();
  await reportPairs(
    ctx,
    api,
    entries,
    0,
    contract.warmupUnique,
    contract.clients,
    false,
  );
  const warmupRemaining =
    contract.warmupSeconds * 1000 - (performance.now() - warmupStarted);
  if (warmupRemaining > 0) await ctx.sleep(warmupRemaining);
  const measuredStarted = performance.now();
  const metrics = await reportPairs(
      ctx,
      api,
      entries,
      contract.warmupUnique,
      contract.measuredUnique,
      contract.clients,
      true,
    ),
    workSeconds = (performance.now() - measuredStarted) / 1000;
  const measuredRemaining =
    contract.measureSeconds * 1000 - (performance.now() - measuredStarted);
  if (measuredRemaining > 0) await ctx.sleep(measuredRemaining);
  const throughput =
      metrics.completed / Math.max(contract.measureSeconds, workSeconds),
    p95 = percentile(metrics.latencies, 0.95);
  assert.equal(metrics.completed, contract.measuredUnique * 2);
  assert.equal(metrics.completed / 2, contract.measuredUnique);
  assert.ok(
    workSeconds <= contract.measureSeconds,
    `fixed 60s window missed: ${workSeconds}s`,
  );
  assert.ok(throughput >= contract.minimumThroughput, `${throughput}/s`);
  assert.ok(p95 <= contract.maximumP95Ms, `${p95}ms`);
  assert.equal(metrics.unexpected5xx, 0);
  const after = assertSnapshot(await ctx.snapshot(api.baseUrl));
  const measuredCommands = new Set(
    entries
      .slice(
        contract.warmupUnique,
        contract.warmupUnique + contract.measuredUnique,
      )
      .map(({ command }) => command.commandId),
  );
  assert.equal(
    after.resources.deviceReports.filter(({ commandId }) =>
      measuredCommands.has(commandId),
    ).length,
    contract.measuredUnique,
  );
  return result(
    `exactly ${contract.measuredUnique} fresh + replay pairs`,
    `throughput ${throughput.toFixed(2)}/s p95 ${p95.toFixed(2)}ms`,
    "one stored report per command",
  );
}

async function e04(ctx) {
  const contract = performanceContract().recovery,
    bundle = performanceBundle(ctx.fixtures),
    api = await prepare(ctx, bundle);
  let holds = 0;
  const barrier = await ctx.barrier({
      hold: ({ point }) =>
        point === "worker.claimed" && holds++ < contract.killedWorkers,
    }),
    env = {
      TEST_BARRIER_URL: barrier.url,
      TEST_BARRIER_TOKEN: barrier.token,
      WORK_LEASE_SECONDS: 1,
    },
    doomed = await Promise.all(
      Array.from({ length: contract.killedWorkers }, () =>
        ctx.startWorker({ env }),
      ),
    ),
    entries = [];
  for (let index = 0; index < contract.killedWorkers; index += 1)
    entries.push(
      await barrier.waitFor(
        (entry) =>
          entry.json.point === "worker.claimed" && !entries.includes(entry),
        { timeoutMs: 30_000, processes: doomed },
      ),
    );
  assert.equal(
    new Set(entries.map(({ json }) => json.workId)).size,
    contract.killedWorkers,
  );
  await Promise.all(doomed.map((worker) => ctx.kill(worker)));
  entries.forEach((entry) => barrier.release(entry));
  const started = performance.now(),
    replacements = await Promise.all(
      Array.from({ length: contract.replacementWorkers }, () =>
        ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } }),
      ),
    ),
    final = await waitSnapshot(
      ctx,
      api,
      (snapshot) =>
        snapshot.work.filter(
          ({ kind, terminal }) => kind === "COMMAND_DELIVERY" && !terminal,
        ).length === 0,
      "100k Command Work drain",
      {
        timeoutMs: contract.maximumSeconds * 1000,
        intervalMs: 250,
        processes: replacements,
      },
    ),
    elapsed = (performance.now() - started) / 1000;
  assert.ok(elapsed <= contract.maximumSeconds);
  assert.equal(final.resources.deviceCommands.length, contract.items);
  assert.equal(
    new Set(final.resources.deviceCommands.map(({ commandId }) => commandId))
      .size,
    contract.items,
  );
  assert.equal(
    new Set(
      final.resources.deviceCommands.map(
        ({ deviceUpdateId, sequence }) => `${deviceUpdateId}:${sequence}`,
      ),
    ).size,
    contract.items,
  );
  const representative = final.resources.deviceUpdates
    .filter((_, index) => index % 1_000 === 0)
    .slice(0, 100);
  const polled = await Promise.all(
    representative.map((update, index) => {
      const device = byId(final.resources.devices, "deviceId", update.deviceId);
      const command = byId(
        final.resources.deviceCommands,
        "deviceUpdateId",
        update.deviceUpdateId,
      );
      return poll(
        ctx,
        api,
        `e04-representative-${index}`,
        device.deviceId,
        command.sequence - 1,
      );
    }),
  );
  for (const [index, response] of polled.entries()) {
    const expected = byId(
      final.resources.deviceCommands,
      "deviceUpdateId",
      representative[index].deviceUpdateId,
    );
    assert.equal(response.json.status, "COMMAND");
    assert.equal(response.json.command.commandId, expected.commandId);
    assert.equal(response.json.command.commandToken, expected.commandToken);
  }
  for (const campaign of final.resources.firmwareCampaigns)
    assert.ok(
      final.resources.deviceUpdates.filter(
        ({ campaignId, state }) =>
          campaignId === campaign.campaignId &&
          ![
            "WAITING",
            "SUCCEEDED",
            "FAILED",
            "ROLLED_BACK",
            "CANCELLED",
          ].includes(state),
      ).length <= campaign.maxParallel,
    );
  await Promise.all(replacements.map((worker) => ctx.stop(worker)));
  return result(
    `100000 Work drained in ${elapsed.toFixed(2)}s`,
    "two claimed owners SIGKILLed and replaced",
    "unique current Command authority and maxParallel closure",
  );
}

export const E_CASES = Object.freeze([
  guardedCase("E-01", ["MIGRATION_IDENTITY"], e01),
  guardedCase("E-02", ["ACTIVE_AUTHORITY"], e02),
  guardedCase("E-03", ["REPORT_REPLAY"], e03),
  guardedCase("E-04", ["WORK_RECOVERY", "ACTIVE_AUTHORITY"], e04),
]);
