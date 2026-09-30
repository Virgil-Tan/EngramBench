import assert from "node:assert/strict";
import { baseBundle, campaignRequest } from "../fixtures/index.mjs";
import { canonicalJson, canonicalVersion } from "../oracles/index.mjs";
import {
  assertSnapshot,
  byId,
  completeForwardFlow,
  createCampaign,
  guardedCase,
  plan,
  prepare,
  result,
  submitCommand,
  waitCommand,
  waitSnapshot,
} from "./helpers.mjs";

const barrierEnv = (barrier) => ({
  TEST_BARRIER_URL: barrier.url,
  TEST_BARRIER_TOKEN: barrier.token,
  WORK_LEASE_SECONDS: 1,
});

async function deliveryCrash(ctx, point, ordinal) {
  if (ordinal) await ctx.resetDatabase();
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 }),
    api = await prepare(ctx, bundle),
    device = bundle.seed.devices[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === device.modelId &&
        canonicalVersion(image.version) === "2",
    );
  await createCampaign(
    ctx,
    api,
    `c01-${ordinal}`,
    campaignRequest(
      target.firmwareImageId,
      { modelId: device.modelId },
      { maxParallel: 1 },
    ),
  );
  let held = false;
  const barrier = await ctx.barrier({
      hold: ({ point: candidate }) =>
        candidate === point && !held && (held = true),
    }),
    doomed = await ctx.startWorker({ env: barrierEnv(barrier) }),
    entry = await barrier.waitFor(({ json }) => json.point === point, {
      timeoutMs: 30_000,
      processes: [doomed],
    });
  const workId = entry.json.workId;
  await ctx.kill(doomed);
  barrier.release(entry);
  const replacement = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } }),
    command = await waitCommand(
      ctx,
      api,
      device.deviceId,
      0,
      `c01-recovered-${ordinal}`,
      { timeoutMs: 45_000, processes: [replacement] },
    ),
    replay = (
      await ctx.mutate(
        api.baseUrl,
        `/api/v1/devices/${device.deviceId}/commands/poll`,
        ctx.key(`c01-poll-${ordinal}`),
        { lastCommandSequence: 0 },
      )
    ).json;
  assert.equal(replay.command.commandId, command.commandId);
  assert.equal(replay.command.commandToken, command.commandToken);
  const final = assertSnapshot(await ctx.snapshot(api.baseUrl));
  assert.equal(
    final.resources.deviceCommands.filter(
      ({ deviceUpdateId, sequence }) =>
        deviceUpdateId === command.deviceUpdateId &&
        sequence === command.sequence,
    ).length,
    1,
  );
  const work = byId(final.work, "workId", workId);
  assert.ok(work.attempt >= 2);
  await ctx.stop(replacement);
  return {
    point,
    workId,
    commandId: command.commandId,
    sequence: command.sequence,
  };
}
async function c01(ctx) {
  const evidence = [];
  for (const [ordinal, point] of [
    "worker.claimed",
    "worker.before-commit",
  ].entries())
    evidence.push(await deliveryCrash(ctx, point, ordinal));
  return result(...evidence);
}

async function c02(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 }),
    api = await prepare(ctx, bundle),
    device = bundle.seed.devices[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === device.modelId &&
        canonicalVersion(image.version) === "2",
    );
  await createCampaign(
    ctx,
    api,
    "c02",
    campaignRequest(
      target.firmwareImageId,
      { modelId: device.modelId },
      { maxParallel: 1, reportTimeoutSeconds: 1 },
    ),
  );
  const issuer = await ctx.startWorker(),
    download = await waitCommand(ctx, api, device.deviceId, 0, "c02-download", {
      processes: [issuer],
    });
  await ctx.stop(issuer);
  let held = false;
  const timeoutBarrier = await ctx.barrier({
      hold: ({ point, aggregateId }) =>
        point === "worker.effect-complete" &&
        aggregateId === download.deviceUpdateId &&
        !held &&
        (held = true),
    }),
    timeoutWorker = await ctx.startWorker({ env: barrierEnv(timeoutBarrier) }),
    timeoutEntry = await timeoutBarrier.waitFor(
      ({ json }) =>
        json.point === "worker.effect-complete" &&
        json.aggregateId === download.deviceUpdateId,
      { timeoutMs: 30_000, processes: [timeoutWorker] },
    );
  await ctx.kill(timeoutWorker);
  timeoutBarrier.release(timeoutEntry);
  const replacement = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } }),
    rollback = await waitCommand(
      ctx,
      api,
      device.deviceId,
      download.sequence,
      "c02-rollback",
      { timeoutMs: 45_000, processes: [replacement] },
    );
  assert.equal(rollback.type, "ROLLBACK");
  const late = await submitCommand(
    ctx,
    api,
    device.deviceId,
    download,
    "c02-late",
  ).catch((error) => error);
  assert.ok(late instanceof Error || late.status === 409);
  await submitCommand(ctx, api, device.deviceId, rollback, "c02-rollback");
  const final = await waitSnapshot(
    ctx,
    api,
    (snapshot) =>
      byId(
        snapshot.resources.deviceUpdates,
        "deviceUpdateId",
        download.deviceUpdateId,
      ).state === "ROLLED_BACK",
    "timeout rollback recovery",
    { timeoutMs: 45_000, processes: [replacement] },
  );
  assert.equal(
    byId(final.resources.devices, "deviceId", device.deviceId).installedVersion,
    "1",
  );
  assert.equal(
    final.resources.deviceCommands.filter(
      ({ deviceUpdateId, type }) =>
        deviceUpdateId === download.deviceUpdateId && type === "ROLLBACK",
    ).length,
    1,
  );
  await ctx.stop(replacement);
  await ctx.stop(api);
  await ctx.resetDatabase();

  const rollbackBundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 }),
    rollbackApi = await prepare(ctx, rollbackBundle),
    rollbackDevice = rollbackBundle.seed.devices[0],
    rollbackTarget = rollbackBundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === rollbackDevice.modelId &&
        canonicalVersion(image.version) === "2",
    );
  await createCampaign(
    ctx,
    rollbackApi,
    "c02-rollback-subcase",
    campaignRequest(
      rollbackTarget.firmwareImageId,
      { modelId: rollbackDevice.modelId },
      { maxParallel: 1, reportTimeoutSeconds: 20 },
    ),
  );
  const rollbackIssuer = await ctx.startWorker(),
    failedCommand = await waitCommand(
      ctx,
      rollbackApi,
      rollbackDevice.deviceId,
      0,
      "c02-explicit-failure",
      { processes: [rollbackIssuer] },
    );
  await ctx.stop(rollbackIssuer);
  await submitCommand(
    ctx,
    rollbackApi,
    rollbackDevice.deviceId,
    failedCommand,
    "c02-explicit-failure",
    { outcome: "FAILED" },
  );
  let rollbackHeld = false;
  const rollbackBarrier = await ctx.barrier({
      hold: ({ point, aggregateId }) =>
        point === "worker.effect-complete" &&
        aggregateId === failedCommand.deviceUpdateId &&
        !rollbackHeld &&
        (rollbackHeld = true),
    }),
    rollbackDoomed = await ctx.startWorker({
      env: barrierEnv(rollbackBarrier),
    }),
    rollbackEntry = await rollbackBarrier.waitFor(
      ({ json }) =>
        json.point === "worker.effect-complete" &&
        json.aggregateId === failedCommand.deviceUpdateId,
      { timeoutMs: 30_000, processes: [rollbackDoomed] },
    );
  await ctx.kill(rollbackDoomed);
  rollbackBarrier.release(rollbackEntry);
  const rollbackReplacement = await ctx.startWorker({
      env: { WORK_LEASE_SECONDS: 1 },
    }),
    recoveredRollback = await waitCommand(
      ctx,
      rollbackApi,
      rollbackDevice.deviceId,
      failedCommand.sequence,
      "c02-recovered-rollback",
      { timeoutMs: 45_000, processes: [rollbackReplacement] },
    );
  assert.equal(recoveredRollback.type, "ROLLBACK");
  await submitCommand(
    ctx,
    rollbackApi,
    rollbackDevice.deviceId,
    recoveredRollback,
    "c02-recovered-rollback",
  );
  const rollbackFinal = await waitSnapshot(
    ctx,
    rollbackApi,
    (snapshot) =>
      byId(
        snapshot.resources.deviceUpdates,
        "deviceUpdateId",
        failedCommand.deviceUpdateId,
      ).state === "ROLLED_BACK",
    "rollback effect recovery",
    { processes: [rollbackReplacement] },
  );
  assert.equal(
    rollbackFinal.resources.deviceCommands.filter(
      ({ deviceUpdateId, type }) =>
        deviceUpdateId === failedCommand.deviceUpdateId && type === "ROLLBACK",
    ).length,
    1,
  );
  await ctx.stop(rollbackReplacement);
  return result(
    "REPORT_TIMEOUT effect-complete owner killed",
    "late report fenced; ROLLBACK effect-complete owner separately killed",
    "both replacements restored captured prior once",
  );
}

async function c03(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 }),
    api = await prepare(ctx, bundle),
    device = bundle.seed.devices[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === device.modelId &&
        canonicalVersion(image.version) === "4",
    );
  const campaign = (
      await createCampaign(
        ctx,
        api,
        "c03",
        campaignRequest(
          target.firmwareImageId,
          { modelId: device.modelId },
          { maxParallel: 1, reportTimeoutSeconds: 20 },
        ),
      )
    ).json,
    update = byId(
      (await ctx.snapshot(api.baseUrl)).resources.deviceUpdates,
      "campaignId",
      campaign.campaignId,
    ),
    issuer = await ctx.startWorker();
  const first = [];
  const download = await waitCommand(
    ctx,
    api,
    device.deviceId,
    0,
    "c03-hop-one-download",
    { processes: [issuer] },
  );
  first.push(download);
  await submitCommand(
    ctx,
    api,
    device.deviceId,
    download,
    "c03-hop-one-download",
  );
  const install = await waitCommand(
    ctx,
    api,
    device.deviceId,
    download.sequence,
    "c03-hop-one-install",
    { processes: [issuer] },
  );
  first.push(install);
  await submitCommand(
    ctx,
    api,
    device.deviceId,
    install,
    "c03-hop-one-install",
  );
  const verify = await waitCommand(
    ctx,
    api,
    device.deviceId,
    install.sequence,
    "c03-hop-one-verify",
    { processes: [issuer] },
  );
  first.push(verify);
  await ctx.stop(issuer);
  await submitCommand(ctx, api, device.deviceId, verify, "c03-hop-one-verify");
  assert.deepEqual(
    first.map(({ sequence }) => sequence),
    [1, 2, 3],
  );
  assert.equal(
    (await plan(ctx, api, update.deviceUpdateId)).hops[0].state,
    "SUCCEEDED",
  );
  let held = false;
  const barrier = await ctx.barrier({
      hold: ({ point, aggregateId }) =>
        point === "worker.before-commit" &&
        aggregateId === update.deviceUpdateId &&
        !held &&
        (held = true),
    }),
    doomed = await ctx.startWorker({ env: barrierEnv(barrier) }),
    entry = await barrier.waitFor(
      ({ json }) =>
        json.point === "worker.before-commit" &&
        json.aggregateId === update.deviceUpdateId,
      { timeoutMs: 30_000, processes: [doomed] },
    );
  await ctx.kill(doomed);
  barrier.release(entry);
  const replacement = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } }),
    next = await waitCommand(ctx, api, device.deviceId, 3, "c03-hop-two", {
      timeoutMs: 45_000,
      processes: [replacement],
    });
  assert.equal(next.sequence, 4);
  assert.equal(next.type, "DOWNLOAD");
  await submitCommand(ctx, api, device.deviceId, next, "c03-hop-two-download");
  const nextInstall = await waitCommand(
    ctx,
    api,
    device.deviceId,
    4,
    "c03-hop-two-install",
    { processes: [replacement] },
  );
  assert.equal(nextInstall.sequence, 5);
  const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
  const sequences = snapshot.resources.deviceCommands
    .filter(({ deviceUpdateId }) => deviceUpdateId === update.deviceUpdateId)
    .map(({ sequence }) => sequence);
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1),
  );
  assert.equal(
    snapshot.resources.deviceCommands.filter(
      ({ deviceUpdateId, sequence }) =>
        deviceUpdateId === update.deviceUpdateId && sequence === 4,
    ).length,
    1,
  );
  await ctx.stop(replacement);
  return result(
    "committed first-hop VERIFY not repeated",
    "next-hop publication recovered once",
    "global Command sequence remained contiguous",
  );
}

async function c04(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 }),
    api = await prepare(ctx, bundle),
    device = bundle.seed.devices[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === device.modelId &&
        canonicalVersion(image.version) === "2",
    );
  await createCampaign(
    ctx,
    api,
    "c04",
    campaignRequest(
      target.firmwareImageId,
      { modelId: device.modelId },
      { maxParallel: 1 },
    ),
  );
  let attempts = 0;
  const receiver = await ctx.receiver({
      path: "/events",
      behavior: () => {
        attempts += 1;
        if (attempts === 1) return { status: 500 };
        if (attempts === 2) return { disconnect: true };
        return { status: 204 };
      },
    }),
    barrier = await ctx.barrier({
      hold: ({ processRole, point }) =>
        processRole === "dispatcher" &&
        point === "dispatcher.response-received",
    }),
    dispatcher = await ctx.startDispatcher({
      webhookUrl: receiver.url,
      env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
    }),
    entry = await barrier.waitFor(
      ({ json }) => json.point === "dispatcher.response-received",
      { timeoutMs: 45_000, processes: [dispatcher] },
    );
  await ctx.waitFor(() => receiver.ledger.length >= 3, {
    label: "500 disconnect and 204 delivery",
    processes: [dispatcher],
  });
  const acknowledged = receiver.ledger.at(-1),
    eventId = acknowledged.headers["x-firmwarefleet-event-id"];
  await ctx.kill(dispatcher);
  barrier.release(entry);
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
  const replay = await ctx.waitFor(
    () =>
      receiver.ledger.find(
        (candidate, index) =>
          index >= 3 &&
          candidate.headers["x-firmwarefleet-event-id"] === eventId,
      ),
    {
      timeoutMs: 45_000,
      label: "unknown ACK event replay",
      processes: [replacement],
    },
  );
  assert.equal(
    replay.headers["x-firmwarefleet-event-type"],
    acknowledged.headers["x-firmwarefleet-event-type"],
  );
  assert.equal(canonicalJson(replay.json), canonicalJson(acknowledged.json));
  const snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl)),
    allowed = new Set([
      "campaign.created",
      "device-update.started",
      "firmware.installed",
      "device-update.failed",
      "device-update.rolled-back",
      "campaign.completed",
    ]);
  assert.ok(snapshot.events.every(({ type }) => allowed.has(type)));
  const aggregateSequences = new Map();
  for (const event of snapshot.events) {
    const list = aggregateSequences.get(event.aggregateId) ?? [];
    list.push(event.sequence);
    aggregateSequences.set(event.aggregateId, list);
  }
  for (const list of aggregateSequences.values())
    assert.deepEqual(
      list,
      Array.from({ length: list.length }, (_, index) => index + 1),
    );
  assert.doesNotMatch(
    JSON.stringify(receiver.ledger),
    /commandToken|idempotency|privatePath|barrierToken/iu,
  );
  await ctx.stop(replacement);
  return result(
    "receiver 500 and disconnect retried",
    "response-received SIGKILL preserved event identity/body",
    "aggregate event order contiguous with no invented Manager event",
  );
}

export const C_CASES = Object.freeze([
  guardedCase("C-01", ["WORK_RECOVERY", "ACTIVE_AUTHORITY"], c01),
  guardedCase(
    "C-02",
    ["WORK_RECOVERY", "ROLLBACK_FENCE", "INSTALL_FENCE"],
    c02,
  ),
  guardedCase("C-03", ["WORK_RECOVERY", "REPORT_REPLAY"], c03),
  guardedCase("C-04", ["CAMPAIGN_ATOMICITY"], c04),
]);
