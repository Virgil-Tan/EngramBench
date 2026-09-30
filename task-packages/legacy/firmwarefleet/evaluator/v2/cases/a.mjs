import assert from "node:assert/strict";
import {
  baseBundle,
  campaignRequest,
  imageAsset,
  publicImageRequest,
} from "../fixtures/index.mjs";
import {
  canonicalVersion,
  pathDigest,
  selectUpgradePath,
  selectedDevices,
  targetDigest,
} from "../oracles/index.mjs";
import {
  CAMPAIGN_KEYS,
  COMMAND_KEYS,
  IMAGE_KEYS,
  PLAN_KEYS,
  assertError,
  byId,
  completeForwardFlow,
  createCampaign,
  defineCase,
  exactKeys,
  plan,
  poll,
  prepare,
  registerImage,
  result,
  retry,
  stableSnapshot,
  submitCommand,
  waitCommand,
  waitSnapshot,
} from "./helpers.mjs";

async function a01(ctx) {
  const bundle = baseBundle(ctx.fixtures);
  bundle.seed.firmwareImages = [];
  bundle.assets = [];
  const api = await prepare(ctx, bundle),
    modelId = bundle.seed.deviceModels[0].modelId;
  const valid = [
    imageAsset(ctx.fixtures, "a01-zero", "0", modelId, ["1"], { size: 1 }),
    imageAsset(
      ctx.fixtures,
      "a01-eight",
      "1.2.3.4.5.6.7.8",
      modelId,
      ["0", "1"],
      { size: 256 },
    ),
    imageAsset(ctx.fixtures, "a01-max-size", "9", modelId, ["1"], { size: 4 }),
  ];
  valid[2].image.size = 2_147_483_648;
  for (const [index, entry] of valid.entries()) {
    const response = await registerImage(
      ctx,
      api,
      `a01-valid-${index}`,
      publicImageRequest(entry.image),
    );
    exactKeys(response.json, IMAGE_KEYS, "FirmwareImage");
    assert.equal(response.json.sha256, entry.image.sha256);
  }
  const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
  const invalidBodies = [
    publicImageRequest(
      imageAsset(ctx.fixtures, "bad-leading", "01", modelId, ["1"]).image,
    ),
    publicImageRequest(
      imageAsset(ctx.fixtures, "bad-components", "1.2.3.4.5.6.7.8.9", modelId, [
        "1",
      ]).image,
    ),
    {
      ...publicImageRequest(
        imageAsset(ctx.fixtures, "bad-path", "10", modelId, ["1"]).image,
      ),
      downloadPath: "/firmware/a/../x",
    },
    {
      ...publicImageRequest(
        imageAsset(ctx.fixtures, "bad-empty", "11", modelId, ["1"]).image,
      ),
      downloadPath: "/firmware/a//x",
    },
    {
      ...publicImageRequest(
        imageAsset(ctx.fixtures, "bad-size", "12", modelId, ["1"]).image,
      ),
      size: 0,
    },
    {
      ...publicImageRequest(
        imageAsset(ctx.fixtures, "bad-digest", "13", modelId, ["1"]).image,
      ),
      sha256: "x".repeat(64),
    },
    {
      ...publicImageRequest(
        imageAsset(ctx.fixtures, "bad-compatible", "14", modelId, ["1"]).image,
      ),
      compatibleFromVersions: [],
    },
    {
      ...publicImageRequest(
        imageAsset(ctx.fixtures, "bad-duplicate-from", "15", modelId, ["1"])
          .image,
      ),
      compatibleFromVersions: ["1", "1.0"],
    },
  ];
  for (const [index, body] of invalidBodies.entries()) {
    const response = await ctx.mutate(
      api.baseUrl,
      "/api/v1/firmware-images",
      ctx.key(`a01-invalid-${index}`),
      body,
    );
    assert.ok([400, 409].includes(response.status));
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), before);
  }
  const canonical = imageAsset(ctx.fixtures, "canonical-two", "2.0", modelId, [
    "1",
  ]);
  await registerImage(
    ctx,
    api,
    "a01-canonical",
    publicImageRequest(canonical.image),
  );
  const equivalent = imageAsset(
    ctx.fixtures,
    "canonical-two-equivalent",
    "2.0.0",
    modelId,
    ["1"],
  );
  assertError(
    await ctx.mutate(
      api.baseUrl,
      "/api/v1/firmware-images",
      ctx.key("a01-equivalent"),
      publicImageRequest(equivalent.image),
    ),
    409,
    "FIRMWARE_VERSION_EXISTS",
  );
  assert.equal(canonicalVersion("2.0.0"), "2");
  return result(
    "boundary image bodies",
    "invalid images had zero effect",
    "canonical identity conflict",
  );
}

async function a02(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 8 }),
    api = await prepare(ctx, bundle),
    model = bundle.seed.deviceModels[0];
  const target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === model.modelId &&
        canonicalVersion(image.version) === "2",
    ),
    selector = { modelId: model.modelId, labels: { environment: "prod" } },
    targets = selectedDevices(bundle.seed.devices, selector);
  const created = (
    await createCampaign(
      ctx,
      api,
      "a02-campaign",
      campaignRequest(target.firmwareImageId, selector, {
        maxParallel: 2,
        reportTimeoutSeconds: 20,
      }),
    )
  ).json;
  exactKeys(created, CAMPAIGN_KEYS, "FirmwareCampaign");
  assert.equal(created.targetCount, targets.length);
  assert.equal(created.targetDigest, targetDigest(targets));
  const frozen = {
      targetCount: created.targetCount,
      targetDigest: created.targetDigest,
      firmwareImageId: created.firmwareImageId,
    },
    worker = await ctx.startWorker();
  let snapshot = await waitSnapshot(
    ctx,
    api,
    (value) =>
      value.resources.deviceUpdates.filter(
        ({ campaignId, state }) =>
          campaignId === created.campaignId &&
          ![
            "WAITING",
            "SUCCEEDED",
            "FAILED",
            "ROLLED_BACK",
            "CANCELLED",
          ].includes(state),
      ).length === 2,
    "maxParallel start",
    { processes: [worker] },
  );
  const active = snapshot.resources.deviceUpdates.filter(
    ({ campaignId, state }) =>
      campaignId === created.campaignId &&
      !["WAITING", "SUCCEEDED", "FAILED", "ROLLED_BACK", "CANCELLED"].includes(
        state,
      ),
  );
  assert.ok(active.length <= 2);
  await completeForwardFlow(ctx, api, active[0].deviceId, "a02-device", {
    worker,
  });
  snapshot = await waitSnapshot(
    ctx,
    api,
    (value) =>
      byId(
        value.resources.deviceUpdates,
        "deviceUpdateId",
        active[0].deviceUpdateId,
      ).state === "SUCCEEDED",
    "first Device success",
    { processes: [worker] },
  );
  const current = byId(
    snapshot.resources.firmwareCampaigns,
    "campaignId",
    created.campaignId,
  );
  assert.deepEqual(
    {
      targetCount: current.targetCount,
      targetDigest: current.targetDigest,
      firmwareImageId: current.firmwareImageId,
    },
    frozen,
  );
  assert.ok(
    snapshot.resources.deviceUpdates.filter(
      ({ campaignId, state }) =>
        campaignId === created.campaignId &&
        ![
          "WAITING",
          "SUCCEEDED",
          "FAILED",
          "ROLLED_BACK",
          "CANCELLED",
        ].includes(state),
    ).length <= 2,
  );
  await ctx.stop(worker);
  return result(
    "frozen selector digest",
    "device-level maxParallel",
    "immutable Campaign target",
  );
}

async function a03(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 3 }),
    api = await prepare(ctx, bundle),
    model = bundle.seed.deviceModels[0],
    devices = bundle.seed.devices.filter(
      (value) => value.modelId === model.modelId,
    ),
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === model.modelId &&
        canonicalVersion(image.version) === "2",
    );
  await createCampaign(
    ctx,
    api,
    "a03-campaign",
    campaignRequest(
      target.firmwareImageId,
      { modelId: model.modelId },
      { maxParallel: 1, reportTimeoutSeconds: 2 },
    ),
  );
  const worker = await ctx.startWorker(),
    device = devices[0],
    download = await waitCommand(ctx, api, device.deviceId, 0, "a03-download", {
      processes: [worker],
    });
  exactKeys(download, COMMAND_KEYS, "DeviceCommand");
  assert.deepEqual(
    (await poll(ctx, api, "a03-no-change", device.deviceId, download.sequence))
      .json,
    { status: "NO_CHANGE", command: null },
  );
  assertError(
    await ctx.mutate(
      api.baseUrl,
      `/api/v1/devices/${device.deviceId}/report-batches`,
      ctx.key("a03-gap"),
      {
        firstSequence: download.sequence + 1,
        reports: [
          {
            sequence: download.sequence + 1,
            commandId: download.commandId,
            commandToken: download.commandToken,
            outcome: "SUCCEEDED",
            installedDigest: null,
          },
        ],
      },
    ),
    409,
    "DEVICE_REPORT_SEQUENCE_GAP",
  );
  assertError(
    await ctx.mutate(
      api.baseUrl,
      `/api/v1/devices/${device.deviceId}/report-batches`,
      ctx.key("a03-token"),
      {
        firstSequence: download.sequence,
        reports: [
          {
            sequence: download.sequence,
            commandId: download.commandId,
            commandToken: "foreign-token",
            outcome: "SUCCEEDED",
            installedDigest: null,
          },
        ],
      },
    ),
    409,
    "STALE_COMMAND_TOKEN",
  );
  const stored = await submitCommand(
    ctx,
    api,
    device.deviceId,
    download,
    "a03-download",
  );
  assert.deepEqual(
    (await submitCommand(ctx, api, device.deviceId, download, "a03-download"))
      .json,
    stored.json,
  );
  const install = await waitCommand(
    ctx,
    api,
    device.deviceId,
    download.sequence,
    "a03-install",
    { processes: [worker] },
  );
  await submitCommand(ctx, api, device.deviceId, install, "a03-install");
  const verify = await waitCommand(
    ctx,
    api,
    device.deviceId,
    install.sequence,
    "a03-verify",
    { processes: [worker] },
  );
  assertError(
    await ctx.mutate(
      api.baseUrl,
      `/api/v1/devices/${device.deviceId}/report-batches`,
      ctx.key("a03-wrong-digest"),
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
  assert.equal(
    byId(
      (await ctx.snapshot(api.baseUrl)).resources.devices,
      "deviceId",
      device.deviceId,
    ).installedVersion,
    "1",
  );
  await submitCommand(ctx, api, device.deviceId, verify, "a03-verify");
  await waitSnapshot(
    ctx,
    api,
    (value) =>
      byId(value.resources.devices, "deviceId", device.deviceId)
        .installedVersion === canonicalVersion(target.version),
    "verified install",
    { processes: [worker] },
  );
  const failed = await waitCommand(
    ctx,
    api,
    devices[1].deviceId,
    0,
    "a03-failed",
    { processes: [worker] },
  );
  await submitCommand(ctx, api, devices[1].deviceId, failed, "a03-failed", {
    outcome: "FAILED",
  });
  const rollback = await waitCommand(
    ctx,
    api,
    devices[1].deviceId,
    failed.sequence,
    "a03-rollback",
    { processes: [worker] },
  );
  assert.equal(rollback.type, "ROLLBACK");
  await submitCommand(ctx, api, devices[1].deviceId, rollback, "a03-rollback");
  const snapshot = await waitSnapshot(
    ctx,
    api,
    (value) =>
      byId(value.resources.deviceUpdates, "deviceId", devices[1].deviceId)
        .state === "ROLLED_BACK",
    "rollback terminal",
    { processes: [worker] },
  );
  const failedUpdate = byId(
    snapshot.resources.deviceUpdates,
    "deviceId",
    devices[1].deviceId,
  );
  assert.equal(
    snapshot.resources.deviceCommands.filter(
      ({ deviceUpdateId, type }) =>
        deviceUpdateId === failedUpdate.deviceUpdateId && type === "ROLLBACK",
    ).length,
    1,
  );
  const timedOut = await waitCommand(
    ctx,
    api,
    devices[2].deviceId,
    0,
    "a03-timeout",
    { processes: [worker] },
  );
  const timeoutRollback = await waitCommand(
    ctx,
    api,
    devices[2].deviceId,
    timedOut.sequence,
    "a03-timeout-rollback",
    { timeoutMs: 10_000, processes: [worker] },
  );
  assert.equal(timeoutRollback.type, "ROLLBACK");
  await submitCommand(
    ctx,
    api,
    devices[2].deviceId,
    timeoutRollback,
    "a03-timeout-rollback",
  );
  const timeoutSnapshot = await waitSnapshot(
    ctx,
    api,
    (value) =>
      byId(value.resources.deviceUpdates, "deviceId", devices[2].deviceId)
        .state === "ROLLED_BACK",
    "timeout rollback terminal",
    { processes: [worker] },
  );
  const timeoutUpdate = byId(
    timeoutSnapshot.resources.deviceUpdates,
    "deviceId",
    devices[2].deviceId,
  );
  assert.equal(
    timeoutSnapshot.resources.deviceCommands.filter(
      ({ deviceUpdateId, type }) =>
        deviceUpdateId === timeoutUpdate.deviceUpdateId && type === "ROLLBACK",
    ).length,
    1,
  );
  await ctx.stop(worker);
  return result(
    "ordered poll/report",
    "verify digest fence",
    "explicit failure and database timeout each produced one rollback",
  );
}

async function a04(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 2 }),
    api = await prepare(ctx, bundle),
    [model, otherModel] = bundle.seed.deviceModels,
    devices = bundle.seed.devices.filter(
      (value) => value.modelId === model.modelId,
    ),
    images = bundle.seed.firmwareImages.filter(
      (image) => image.modelId === model.modelId,
    ),
    directTarget = images.find(
      (image) => canonicalVersion(image.version) === "2",
    ),
    multiTarget = images.find(
      (image) => canonicalVersion(image.version) === "4",
    );
  const tooLong = [];
  let from = "4";
  for (let version = 5; version <= 10; version += 1) {
    const entry = imageAsset(
      ctx.fixtures,
      `a04-${version}`,
      String(version),
      otherModel.modelId,
      [from],
    );
    await registerImage(
      ctx,
      api,
      `a04-image-${version}`,
      publicImageRequest(entry.image),
    );
    tooLong.push(entry.image);
    from = String(version);
  }
  const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
  assertError(
    await ctx.mutate(
      api.baseUrl,
      "/api/v1/firmware-campaigns",
      ctx.key("a04-too-long"),
      campaignRequest(
        tooLong.at(-1).firmwareImageId,
        { modelId: otherModel.modelId },
        { maxParallel: 1 },
      ),
    ),
    409,
    "UPGRADE_PATH_UNAVAILABLE",
  );
  const after = stableSnapshot(await ctx.snapshot(api.baseUrl));
  assert.equal(
    after.resources.firmwareCampaigns.length,
    before.resources.firmwareCampaigns.length,
  );
  assert.equal(
    after.resources.deviceUpdates.length,
    before.resources.deviceUpdates.length,
  );
  const direct = (
      await createCampaign(
        ctx,
        api,
        "a04-direct",
        campaignRequest(
          directTarget.firmwareImageId,
          {
            modelId: model.modelId,
            labels: { environment: devices[0].labels.environment },
          },
          { maxParallel: 1 },
        ),
      )
    ).json,
    directUpdate = byId(
      (await ctx.snapshot(api.baseUrl)).resources.deviceUpdates,
      "campaignId",
      direct.campaignId,
    );
  assert.equal(
    (await plan(ctx, api, directUpdate.deviceUpdateId)).hops.length,
    1,
  );
  const multi = (
      await createCampaign(
        ctx,
        api,
        "a04-multi",
        campaignRequest(
          multiTarget.firmwareImageId,
          {
            modelId: model.modelId,
            labels: { environment: devices[1].labels.environment },
          },
          { maxParallel: 1 },
        ),
      )
    ).json,
    multiUpdate = byId(
      (await ctx.snapshot(api.baseUrl)).resources.deviceUpdates,
      "campaignId",
      multi.campaignId,
    ),
    selected = selectUpgradePath(
      devices[1].installedVersion,
      multiTarget,
      images,
    ),
    multiPlan = await plan(ctx, api, multiUpdate.deviceUpdateId);
  assert.deepEqual(
    selected.map(({ version }) => canonicalVersion(version)),
    ["2", "4"],
  );
  exactKeys(multiPlan, PLAN_KEYS, "UpgradePlan");
  assert.equal(
    multiPlan.pathDigest,
    pathDigest(devices[1].deviceId, "1", "4", selected),
  );
  assert.deepEqual(
    multiPlan.hops.map(({ firmwareImageId }) => firmwareImageId),
    selected.map(({ firmwareImageId }) => firmwareImageId),
  );
  return result(
    "one-hop plan",
    "deterministic multi-hop path",
    "all-or-none unavailable path",
  );
}

async function a05(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 }),
    api = await prepare(ctx, bundle),
    device = bundle.seed.devices[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === device.modelId &&
        canonicalVersion(image.version) === "4",
    ),
    campaign = (
      await createCampaign(
        ctx,
        api,
        "a05-campaign",
        campaignRequest(
          target.firmwareImageId,
          { modelId: device.modelId, labels: device.labels },
          { maxParallel: 1, reportTimeoutSeconds: 30 },
        ),
      )
    ).json,
    update = byId(
      (await ctx.snapshot(api.baseUrl)).resources.deviceUpdates,
      "campaignId",
      campaign.campaignId,
    ),
    worker = await ctx.startWorker();
  assert.deepEqual(
    (
      await completeForwardFlow(ctx, api, device.deviceId, "a05-first", {
        worker,
      })
    ).map(({ sequence }) => sequence),
    [1, 2, 3],
  );
  assert.equal(
    (await plan(ctx, api, update.deviceUpdateId)).hops[0].state,
    "SUCCEEDED",
  );
  const failed = await waitCommand(ctx, api, device.deviceId, 3, "a05-second", {
    processes: [worker],
  });
  assert.equal(failed.sequence, 4);
  await submitCommand(ctx, api, device.deviceId, failed, "a05-second", {
    outcome: "FAILED",
  });
  const rollback = await waitCommand(
    ctx,
    api,
    device.deviceId,
    failed.sequence,
    "a05-rollback",
    { processes: [worker] },
  );
  await submitCommand(ctx, api, device.deviceId, rollback, "a05-rollback");
  await ctx.waitFor(
    async () =>
      (await plan(ctx, api, update.deviceUpdateId)).hops[1].attempts[0]
        ?.state === "ROLLED_BACK" || undefined,
    { label: "rolled back second hop" },
  );
  assert.equal(
    byId(
      (await ctx.snapshot(api.baseUrl)).resources.devices,
      "deviceId",
      device.deviceId,
    ).installedVersion,
    "2",
  );
  assertError(
    await ctx.mutate(
      api.baseUrl,
      `/api/v1/device-updates/${update.deviceUpdateId}/retry`,
      ctx.key("a05-stale"),
      { expectedCurrentHopIndex: 0, expectedAttempt: 1 },
    ),
    409,
    "DEVICE_UPDATE_NOT_RETRYABLE",
  );
  await retry(ctx, api, "a05-retry", update.deviceUpdateId, {
    expectedCurrentHopIndex: 1,
    expectedAttempt: 1,
  });
  const retried = await waitCommand(
    ctx,
    api,
    device.deviceId,
    rollback.sequence,
    "a05-retry-download",
    { processes: [worker] },
  );
  assert.ok(retried.sequence > rollback.sequence);
  assert.notEqual(retried.commandToken, failed.commandToken);
  await completeForwardFlow(ctx, api, device.deviceId, "a05-retried", {
    worker,
  });
  const final = await plan(ctx, api, update.deviceUpdateId);
  assert.equal(final.hops[0].state, "SUCCEEDED");
  assert.equal(final.hops[1].attempts.length, 2);
  await ctx.stop(worker);
  return result(
    "hop gate",
    "local rollback",
    "fresh retry identity and sequence",
  );
}

export const A_CASES = Object.freeze([
  defineCase("A-01", a01),
  defineCase("A-02", a02),
  defineCase("A-03", a03),
  defineCase("A-04", a04),
  defineCase("A-05", a05),
]);
