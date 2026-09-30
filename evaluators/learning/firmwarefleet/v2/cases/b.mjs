import assert from "node:assert/strict";
import { baseBundle, campaignRequest } from "../fixtures/index.mjs";
import { canonicalJson, canonicalVersion } from "../oracles/index.mjs";
import {
  assertError,
  assertSnapshot,
  byId,
  cancelCampaign,
  completeForwardFlow,
  createCampaign,
  guardedCase,
  plan,
  poll,
  prepare,
  report,
  result,
  retry,
  stableSnapshot,
  submitCommand,
  waitCommand,
  waitSnapshot,
} from "./helpers.mjs";

async function b01(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 4 }),
    api1 = await prepare(ctx, bundle),
    api2 = await ctx.startApi(),
    model = bundle.seed.deviceModels[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === model.modelId &&
        canonicalVersion(image.version) === "4",
    ),
    body = campaignRequest(
      target.firmwareImageId,
      { modelId: model.modelId },
      { maxParallel: 2 },
    ),
    key = ctx.key("b01-create");
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      ctx.mutate(
        (index % 2 ? api2 : api1).baseUrl,
        "/api/v1/firmware-campaigns",
        key,
        body,
      ),
    ),
  );
  const first = responses[0];
  assert.equal(first.status, 202);
  for (const response of responses) {
    assert.equal(response.status, first.status);
    assert.equal(canonicalJson(response.json), canonicalJson(first.json));
  }
  let snapshot = assertSnapshot(await ctx.snapshot(api1.baseUrl));
  assert.equal(
    snapshot.resources.firmwareCampaigns.filter(
      ({ campaignId }) => campaignId === first.json.campaignId,
    ).length,
    1,
  );
  assert.equal(
    snapshot.resources.deviceUpdates.filter(
      ({ campaignId }) => campaignId === first.json.campaignId,
    ).length,
    first.json.targetCount,
  );
  assert.equal(
    snapshot.resources.upgradePlans.filter(({ deviceUpdateId }) =>
      snapshot.resources.deviceUpdates.some(
        (update) =>
          update.campaignId === first.json.campaignId &&
          update.deviceUpdateId === deviceUpdateId,
      ),
    ).length,
    first.json.targetCount,
  );
  assertError(
    await ctx.mutate(api2.baseUrl, "/api/v1/firmware-campaigns", key, {
      ...body,
      maxParallel: 3,
    }),
    409,
    "IDEMPOTENCY_CONFLICT",
  );
  const shield = await ctx.responseShield(api1.baseUrl),
    unknownKey = ctx.key("b01-unknown");
  shield.dropNextMutation();
  await ctx
    .mutate(shield.baseUrl, "/api/v1/firmware-campaigns", unknownKey, {
      ...body,
      selector: { modelId: bundle.seed.deviceModels[1].modelId },
    })
    .catch(() => undefined);
  const captured = await ctx.waitFor(
    () => shield.captures.find(({ dropped }) => dropped),
    { label: "dropped Campaign response" },
  );
  await ctx.stop(api1);
  const restarted = await ctx.startApi(),
    replay = await ctx.mutate(
      restarted.baseUrl,
      "/api/v1/firmware-campaigns",
      unknownKey,
      { ...body, selector: { modelId: bundle.seed.deviceModels[1].modelId } },
    );
  assert.equal(replay.status, captured.response.status);
  assert.equal(
    canonicalJson(replay.json),
    canonicalJson(JSON.parse(captured.response.body)),
  );
  const noPathBundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 });
  noPathBundle.seed.devices[0].installedVersion = "99";
  await ctx.resetDatabase();
  const noPathApi = await prepare(ctx, noPathBundle),
    noPathModel = noPathBundle.seed.deviceModels[0],
    badTarget = noPathBundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === noPathModel.modelId &&
        canonicalVersion(image.version) === "4",
    );
  const badBefore = stableSnapshot(await ctx.snapshot(noPathApi.baseUrl));
  const rejected = await ctx.mutate(
    noPathApi.baseUrl,
    "/api/v1/firmware-campaigns",
    ctx.key("b01-unavailable"),
    campaignRequest(
      badTarget.firmwareImageId,
      { modelId: noPathModel.modelId },
      { maxParallel: 1 },
    ),
  );
  assertError(rejected, 409, "UPGRADE_PATH_UNAVAILABLE");
  const badAfter = stableSnapshot(await ctx.snapshot(noPathApi.baseUrl));
  for (const keyName of [
    "firmwareCampaigns",
    "deviceUpdates",
    "deviceCommands",
    "upgradePlans",
  ])
    assert.equal(
      badAfter.resources[keyName].length,
      badBefore.resources[keyName].length,
    );
  return result(
    "20-way durable Campaign replay",
    "unknown response replay after restart",
    "unavailable target created no aggregate graph",
  );
}

async function b02(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 6 }),
    api1 = await prepare(ctx, bundle),
    api2 = await ctx.startApi(),
    model = bundle.seed.deviceModels[0],
    images = bundle.seed.firmwareImages.filter(
      (image) => image.modelId === model.modelId,
    ),
    two = images.find((image) => canonicalVersion(image.version) === "2"),
    three = images.find((image) => canonicalVersion(image.version) === "3"),
    selector = { modelId: model.modelId, labels: { environment: "prod" } };
  const responses = await Promise.all([
    ctx.mutate(
      api1.baseUrl,
      "/api/v1/firmware-campaigns",
      ctx.key("b02-two"),
      campaignRequest(two.firmwareImageId, selector, { maxParallel: 1 }),
    ),
    ctx.mutate(
      api2.baseUrl,
      "/api/v1/firmware-campaigns",
      ctx.key("b02-three"),
      campaignRequest(three.firmwareImageId, selector, { maxParallel: 1 }),
    ),
  ]);
  assert.equal(responses.filter(({ status }) => status === 202).length, 1);
  assert.ok(
    responses
      .filter(({ status }) => status !== 202)
      .every(({ json }) => json?.error?.code === "DEVICE_UPDATE_ACTIVE"),
  );
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const snapshot = await waitSnapshot(
    ctx,
    { baseUrl: api1.baseUrl },
    (value) => value.resources.deviceCommands.length > 0,
    "first active command",
    { processes: workers },
  );
  const activeStates = new Set(["DOWNLOADING", "INSTALLING", "VERIFYING"]);
  for (const device of bundle.seed.devices.filter(
    (value) => value.modelId === model.modelId,
  )) {
    const active = snapshot.resources.deviceUpdates.filter(
      (update) =>
        update.deviceId === device.deviceId && activeStates.has(update.state),
    );
    assert.ok(active.length <= 1);
    if (active.length)
      assert.ok(
        snapshot.resources.deviceCommands.filter(
          (command) =>
            command.deviceUpdateId === active[0].deviceUpdateId &&
            command.sequence === active[0].currentCommandSequence,
        ).length <= 1,
      );
  }
  for (const campaign of snapshot.resources.firmwareCampaigns) {
    assert.ok(
      snapshot.resources.deviceUpdates.filter(
        (update) =>
          update.campaignId === campaign.campaignId &&
          activeStates.has(update.state),
      ).length <= campaign.maxParallel,
    );
  }
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  return result(
    "one Device active authority under two Campaigns",
    "one current Command identity",
    "device-level maxParallel hotspot fence",
  );
}

async function b03(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 }),
    api1 = await prepare(ctx, bundle),
    api2 = await ctx.startApi(),
    device = bundle.seed.devices[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === device.modelId &&
        canonicalVersion(image.version) === "2",
    );
  await createCampaign(
    ctx,
    api1,
    "b03",
    campaignRequest(
      target.firmwareImageId,
      { modelId: device.modelId },
      { maxParallel: 1 },
    ),
  );
  const worker = await ctx.startWorker(),
    command = await waitCommand(ctx, api1, device.deviceId, 0, "b03", {
      processes: [worker],
    });
  const body = {
    firstSequence: command.sequence,
    reports: [
      {
        sequence: command.sequence,
        commandId: command.commandId,
        commandToken: command.commandToken,
        outcome: "SUCCEEDED",
        installedDigest: null,
      },
    ],
  };
  const duplicates = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      report(
        ctx,
        index % 2 ? api2 : api1,
        "b03-identical",
        device.deviceId,
        body,
      ),
    ),
  );
  duplicates.forEach((response) =>
    assert.equal(
      canonicalJson(response.json),
      canonicalJson(duplicates[0].json),
    ),
  );
  let snapshot = await ctx.snapshot(api1.baseUrl);
  assert.equal(
    snapshot.resources.deviceReports.filter(
      ({ commandId }) => commandId === command.commandId,
    ).length,
    1,
  );
  assertError(
    await ctx.mutate(
      api1.baseUrl,
      `/api/v1/devices/${device.deviceId}/report-batches`,
      ctx.key("b03-rewrite"),
      { ...body, reports: [{ ...body.reports[0], outcome: "FAILED" }] },
    ),
    409,
    "IDEMPOTENCY_CONFLICT",
  );
  const current = await waitCommand(
    ctx,
    api1,
    device.deviceId,
    command.sequence,
    "b03-current",
    { processes: [worker] },
  );
  const invalid = [
    {
      code: "DEVICE_REPORT_SEQUENCE_GAP",
      body: {
        firstSequence: current.sequence + 1,
        reports: [
          {
            ...body.reports[0],
            sequence: current.sequence + 1,
            commandId: current.commandId,
            commandToken: current.commandToken,
          },
        ],
      },
    },
    {
      code: "STALE_COMMAND_TOKEN",
      body: {
        firstSequence: current.sequence,
        reports: [
          {
            ...body.reports[0],
            sequence: current.sequence,
            commandId: current.commandId,
            commandToken: command.commandToken,
          },
        ],
      },
    },
  ];
  for (const [index, item] of invalid.entries())
    assertError(
      await ctx.mutate(
        (index % 2 ? api2 : api1).baseUrl,
        `/api/v1/devices/${device.deviceId}/report-batches`,
        ctx.key(`b03-invalid-${index}`),
        item.body,
      ),
      409,
      item.code,
    );
  await submitCommand(ctx, api1, device.deviceId, current, "b03-install");
  const verify = await waitCommand(
    ctx,
    api1,
    device.deviceId,
    current.sequence,
    "b03-verify",
    { processes: [worker] },
  );
  assert.equal(verify.type, "VERIFY");
  assertError(
    await ctx.mutate(
      api2.baseUrl,
      `/api/v1/devices/${device.deviceId}/report-batches`,
      ctx.key("b03-wrong-digest"),
      {
        firstSequence: verify.sequence,
        reports: [
          {
            sequence: verify.sequence,
            commandId: verify.commandId,
            commandToken: verify.commandToken,
            outcome: "SUCCEEDED",
            installedDigest: "0".repeat(64),
          },
        ],
      },
    ),
    409,
    "INSTALLED_DIGEST_MISMATCH",
  );
  snapshot = await ctx.snapshot(api1.baseUrl);
  assert.equal(
    snapshot.resources.deviceReports.filter(
      ({ commandId }) => commandId === command.commandId,
    ).length,
    1,
  );
  await ctx.stop(worker);
  return result(
    "20 identical reports one effect",
    "rewritten replay rejected",
    "gap token and digest precedence retained authority",
  );
}

async function b04(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 4 }),
    api = await prepare(ctx, bundle),
    model = bundle.seed.deviceModels[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === model.modelId &&
        canonicalVersion(image.version) === "2",
    ),
    campaign = (
      await createCampaign(
        ctx,
        api,
        "b04",
        campaignRequest(
          target.firmwareImageId,
          { modelId: model.modelId },
          { maxParallel: 2, reportTimeoutSeconds: 1 },
        ),
      )
    ).json;
  const issuers = [await ctx.startWorker(), await ctx.startWorker()];
  const issuedSnapshot = await waitSnapshot(
    ctx,
    api,
    (value) =>
      value.resources.deviceCommands.filter(({ deviceUpdateId }) =>
        value.resources.deviceUpdates.some(
          (update) =>
            update.campaignId === campaign.campaignId &&
            update.deviceUpdateId === deviceUpdateId,
        ),
      ).length === 2,
    "two current Commands before terminal race",
    { processes: issuers },
  );
  await Promise.all(issuers.map((worker) => ctx.stop(worker)));
  const timeoutDueAt =
    Math.min(
      ...issuedSnapshot.resources.deviceCommands
        .filter(({ deviceUpdateId }) =>
          issuedSnapshot.resources.deviceUpdates.some(
            (update) =>
              update.campaignId === campaign.campaignId &&
              update.deviceUpdateId === deviceUpdateId,
          ),
        )
        .map(({ expiresAt }) => Date.parse(expiresAt)),
    ) + 50;
  await ctx.waitFor(() => (Date.now() >= timeoutDueAt ? true : undefined), {
    timeoutMs: 3_000,
    intervalMs: 50,
    label: "report timeout due",
  });
  let held = false;
  const barrier = await ctx.barrier({
      hold: ({ point }) =>
        point === "worker.before-commit" && !held && (held = true),
    }),
    env = {
      TEST_BARRIER_URL: barrier.url,
      TEST_BARRIER_TOKEN: barrier.token,
      WORK_LEASE_SECONDS: 1,
    },
    doomed = await ctx.startWorker({ env });
  const entry = await barrier.waitFor(
    ({ json }) => json.point === "worker.before-commit",
    { timeoutMs: 30_000, processes: [doomed] },
  );
  const survivor = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } });
  const snapshot = await ctx.snapshot(api.baseUrl),
    update = snapshot.resources.deviceUpdates.find(
      ({ campaignId, state }) =>
        campaignId === campaign.campaignId && state !== "WAITING",
    ),
    command = byId(
      snapshot.resources.deviceCommands,
      "deviceUpdateId",
      update.deviceUpdateId,
    );
  const races = await Promise.allSettled([
    submitCommand(ctx, api, update.deviceId, command, "b04-fail", {
      outcome: "FAILED",
    }),
    cancelCampaign(ctx, api, "b04-cancel", campaign.campaignId),
  ]);
  assert.equal(races.length, 2);
  await ctx.kill(doomed);
  barrier.release(entry);
  const replacement = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 1 } });
  const final = await waitSnapshot(
    ctx,
    api,
    (value) =>
      value.resources.deviceUpdates
        .filter(({ campaignId }) => campaignId === campaign.campaignId)
        .every(({ state }) => ["ROLLED_BACK", "CANCELLED"].includes(state)),
    "rollback terminal race",
    { timeoutMs: 45_000, processes: [survivor, replacement] },
  );
  for (const item of final.resources.deviceUpdates.filter(
    ({ campaignId }) => campaignId === campaign.campaignId,
  )) {
    assert.ok(
      final.resources.deviceCommands.filter(
        ({ deviceUpdateId, type }) =>
          deviceUpdateId === item.deviceUpdateId && type === "ROLLBACK",
      ).length <= 1,
    );
  }
  assert.equal(
    byId(final.resources.firmwareCampaigns, "campaignId", campaign.campaignId)
      .state,
    "CANCELLED",
  );
  await ctx.stop(survivor);
  await ctx.stop(replacement);
  return result(
    "failure timeout cancel fixed barrier race",
    "one rollback per active Device",
    "WAITING members atomically cancelled",
  );
}

async function b05(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 4 }),
    api1 = await prepare(ctx, bundle),
    api2 = await ctx.startApi(),
    model = bundle.seed.deviceModels[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === model.modelId &&
        canonicalVersion(image.version) === "4",
    ),
    campaign = (
      await createCampaign(
        ctx,
        api1,
        "b05",
        campaignRequest(
          target.firmwareImageId,
          { modelId: model.modelId },
          { maxParallel: 4, reportTimeoutSeconds: 20 },
        ),
      )
    ).json,
    workers = [await ctx.startWorker(), await ctx.startWorker()];
  const devices = bundle.seed.devices.filter(
      (device) => device.modelId === model.modelId,
    ),
    commands = await Promise.all(
      devices.map((device) =>
        waitCommand(ctx, api1, device.deviceId, 0, `b05-${device.deviceId}`, {
          processes: workers,
        }),
      ),
    );
  const mutations = [];
  for (let index = 0; index < 20; index += 1) {
    const device = devices[index % devices.length],
      command = commands[index % commands.length],
      targetApi = index % 2 ? api2 : api1;
    mutations.push(
      submitCommand(
        ctx,
        targetApi,
        device.deviceId,
        command,
        `b05-report-${index % devices.length}`,
        {
          outcome:
            device.deviceId === devices[0].deviceId ? "FAILED" : "SUCCEEDED",
        },
      ),
    );
  }
  await Promise.allSettled(mutations);
  const failedRollback = await waitCommand(
    ctx,
    api1,
    devices[0].deviceId,
    commands[0].sequence,
    "b05-rollback",
    { processes: workers },
  );
  assert.equal(failedRollback.type, "ROLLBACK");
  await submitCommand(
    ctx,
    api1,
    devices[0].deviceId,
    failedRollback,
    "b05-rollback",
  );
  const failedUpdate = byId(
    (await ctx.snapshot(api1.baseUrl)).resources.deviceUpdates,
    "deviceId",
    devices[0].deviceId,
  );
  const retryBody = { expectedCurrentHopIndex: 0, expectedAttempt: 1 };
  const retryResponses = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      ctx.mutate(
        (index % 2 ? api2 : api1).baseUrl,
        `/api/v1/device-updates/${failedUpdate.deviceUpdateId}/retry`,
        ctx.key("b05-retry"),
        retryBody,
      ),
    ),
  );
  assert.ok(retryResponses.every(({ status }) => status === 200));
  assert.ok(
    retryResponses.every(
      ({ json }) =>
        canonicalJson(json) === canonicalJson(retryResponses[0].json),
    ),
  );
  let snapshot = await ctx.snapshot(api1.baseUrl);
  assert.equal(
    byId(
      snapshot.resources.firmwareCampaigns,
      "campaignId",
      campaign.campaignId,
    ).completedAt,
    null,
  );
  for (const planValue of snapshot.resources.upgradePlans.filter(
    ({ deviceUpdateId }) =>
      snapshot.resources.deviceUpdates.some(
        (update) =>
          update.campaignId === campaign.campaignId &&
          update.deviceUpdateId === deviceUpdateId,
      ),
  )) {
    assert.ok(planValue.currentHopIndex >= 0);
    for (const hop of planValue.hops) {
      assert.equal(
        new Set(hop.attempts.map(({ attempt }) => attempt)).size,
        hop.attempts.length,
      );
    }
  }
  await completeForwardFlow(
    ctx,
    api1,
    devices[0].deviceId,
    `b05-retry-hop-${devices[0].deviceId}`,
    { worker: workers[0] },
  );
  await completeForwardFlow(
    ctx,
    api1,
    devices[0].deviceId,
    `b05-retry-close-${devices[0].deviceId}`,
    { worker: workers[0] },
  );
  for (const device of devices.slice(1)) {
    const install = await waitCommand(
      ctx,
      api1,
      device.deviceId,
      1,
      `b05-install-${device.deviceId}`,
      { processes: workers },
    );
    assert.equal(install.type, "INSTALL");
    await submitCommand(
      ctx,
      api1,
      device.deviceId,
      install,
      `b05-install-${device.deviceId}`,
    );
    const verify = await waitCommand(
      ctx,
      api1,
      device.deviceId,
      install.sequence,
      `b05-verify-${device.deviceId}`,
      { processes: workers },
    );
    assert.equal(verify.type, "VERIFY");
    await submitCommand(
      ctx,
      api1,
      device.deviceId,
      verify,
      `b05-verify-${device.deviceId}`,
    );
    await completeForwardFlow(
      ctx,
      api1,
      device.deviceId,
      `b05-close-${device.deviceId}`,
      { worker: workers[0] },
    );
  }
  snapshot = await waitSnapshot(
    ctx,
    api1,
    (value) =>
      ["SUCCEEDED", "FAILED", "CANCELLED"].includes(
        byId(
          value.resources.firmwareCampaigns,
          "campaignId",
          campaign.campaignId,
        ).state,
      ),
    "Campaign aggregate terminal",
    { timeoutMs: 60_000, processes: workers },
  );
  assert.ok(
    snapshot.resources.deviceUpdates
      .filter(({ campaignId }) => campaignId === campaign.campaignId)
      .every(({ state }) =>
        ["SUCCEEDED", "FAILED", "ROLLED_BACK", "CANCELLED"].includes(state),
      ),
  );
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  return result(
    "40 concurrent report/retry-shaped mutations",
    "monotonic hop attempts",
    "Campaign closed only after every Device terminal",
  );
}

export const B_CASES = Object.freeze([
  guardedCase("B-01", ["CAMPAIGN_ATOMICITY"], b01),
  guardedCase("B-02", ["ACTIVE_AUTHORITY"], b02),
  guardedCase("B-03", ["REPORT_REPLAY", "INSTALL_FENCE"], b03),
  guardedCase("B-04", ["ROLLBACK_FENCE", "WORK_RECOVERY"], b04),
  guardedCase("B-05", ["ACTIVE_AUTHORITY", "CAMPAIGN_ATOMICITY"], b05),
]);
