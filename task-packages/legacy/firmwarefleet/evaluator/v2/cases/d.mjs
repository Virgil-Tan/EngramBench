import assert from "node:assert/strict";
import { baseBundle, campaignRequest } from "../fixtures/index.mjs";
import { canonicalVersion } from "../oracles/index.mjs";
import {
  FINAL_KEYS,
  PLAN_KEYS,
  assertSnapshot,
  byId,
  clickVisible,
  completeForwardFlow,
  createCampaign,
  defineCase,
  exactKeys,
  fillVisible,
  plan,
  prepare,
  result,
  retry,
  submitCommand,
  visibleUi,
  waitCommand,
  waitSnapshot,
} from "./helpers.mjs";

async function d01(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 2 });
  bundle.seed.firmwareImages = [];
  bundle.assets = [];
  const api = await prepare(ctx, bundle),
    model = bundle.seed.deviceModels[0],
    device = bundle.seed.devices.find(
      (value) => value.modelId === model.modelId,
    ),
    digest = "a".repeat(64);
  await visibleUi(ctx, api, async (page) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await clickVisible(page, [/firmware.*image/i, /images/i]);
    await fillVisible(page, /model/i, model.modelId);
    await fillVisible(page, /version/i, "2");
    await fillVisible(page, /sha.?256|digest/i, digest);
    await fillVisible(page, /size/i, "128");
    await fillVisible(page, /download.*path|path/i, "/firmware/ui-v2.bin");
    await fillVisible(page, /compatible/i, JSON.stringify(["1"]));
    await clickVisible(page, [/register|create|save/i]);
    await page.getByText(/2/).first().waitFor();
    await clickVisible(page, [/campaign/i]);
    await fillVisible(
      page,
      /firmware.*image|image.*id/i,
      (await ctx.snapshot(api.baseUrl)).resources.firmwareImages[0]
        .firmwareImageId,
    );
    await fillVisible(
      page,
      /selector/i,
      JSON.stringify({ modelId: model.modelId }),
    );
    await fillVisible(page, /max.*parallel/i, "1");
    await fillVisible(page, /report.*timeout/i, "10");
    await clickVisible(page, [/create|start/i]);
    await page
      .getByText(/PENDING|RUNNING/i)
      .first()
      .waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await page.getByText(new RegExp(device.deviceId, "i")).first().waitFor();
    await page.keyboard.press("Tab");
  });
  const worker = await ctx.startWorker(),
    command = await waitCommand(ctx, api, device.deviceId, 0, "d01", {
      processes: [worker],
    });
  await visibleUi(ctx, api, async (page) => {
    await clickVisible(page, [/device.*update|commands/i]);
    await page.getByText(new RegExp(command.commandId, "i")).first().waitFor();
    await clickVisible(page, [/report/i]);
    await fillVisible(page, /device/i, device.deviceId);
    await fillVisible(page, /first.*sequence/i, String(command.sequence));
    await fillVisible(
      page,
      /reports|batch/i,
      JSON.stringify([
        {
          sequence: command.sequence,
          commandId: command.commandId,
          commandToken: command.commandToken,
          outcome: "FAILED",
          installedDigest: null,
        },
      ]),
    );
    await clickVisible(page, [/submit|send/i]);
    await page
      .getByText(/FAILED|ROLLBACK/i)
      .first()
      .waitFor();
  });
  const rollback = await waitCommand(
    ctx,
    api,
    device.deviceId,
    command.sequence,
    "d01-rollback",
    { processes: [worker] },
  );
  await submitCommand(ctx, api, device.deviceId, rollback, "d01-rollback");
  const snapshot = await waitSnapshot(
    ctx,
    api,
    (value) =>
      byId(value.resources.deviceUpdates, "deviceId", device.deviceId).state ===
      "ROLLED_BACK",
    "visible rollback terminal",
    { processes: [worker] },
  );
  assert.equal(
    snapshot.resources.deviceCommands.filter(
      ({ deviceUpdateId, type }) =>
        deviceUpdateId === rollback.deviceUpdateId && type === "ROLLBACK",
    ).length,
    1,
  );
  await ctx.stop(worker);
  assert.doesNotMatch(JSON.stringify(snapshot), /commandToken/iu);
  return result(
    "mobile Chromium registered Image and created Campaign",
    "visible report drove rollback",
    "refresh and keyboard-visible state matched snapshot",
  );
}

async function d02(ctx) {
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
        "d02",
        campaignRequest(
          target.firmwareImageId,
          { modelId: device.modelId },
          { maxParallel: 1 },
        ),
      )
    ).json,
    update = byId(
      (await ctx.snapshot(api.baseUrl)).resources.deviceUpdates,
      "campaignId",
      campaign.campaignId,
    ),
    worker = await ctx.startWorker();
  await completeForwardFlow(ctx, api, device.deviceId, "d02-first", { worker });
  const failed = await waitCommand(ctx, api, device.deviceId, 3, "d02-second", {
    processes: [worker],
  });
  await submitCommand(ctx, api, device.deviceId, failed, "d02-failed", {
    outcome: "FAILED",
  });
  const rollback = await waitCommand(
    ctx,
    api,
    device.deviceId,
    failed.sequence,
    "d02-rollback",
    { processes: [worker] },
  );
  await submitCommand(ctx, api, device.deviceId, rollback, "d02-rollback");
  await waitSnapshot(
    ctx,
    api,
    (snapshot) =>
      byId(
        snapshot.resources.deviceUpdates,
        "deviceUpdateId",
        update.deviceUpdateId,
      ).state === "ROLLED_BACK",
    "UI retry eligibility",
    { processes: [worker] },
  );
  await visibleUi(ctx, api, async (page) => {
    await clickVisible(page, [/upgrade.*plan|device.*update|campaign/i]);
    await page
      .getByText(new RegExp(update.deviceUpdateId, "i"))
      .first()
      .click();
    await page
      .getByText(/path.*digest|hop/i)
      .first()
      .waitFor();
    await page
      .getByText(/ROLLED_BACK/i)
      .first()
      .waitFor();
    await clickVisible(page, [/retry/i]);
    await fillVisible(page, /hop.*index/i, "1");
    await fillVisible(page, /attempt/i, "1");
    await clickVisible(page, [/confirm|retry/i]);
    await page
      .getByText(/DOWNLOADING|attempt.*2/i)
      .first()
      .waitFor();
    await page.reload({ waitUntil: "networkidle" });
    await page
      .getByText(/attempt.*2|DOWNLOADING/i)
      .first()
      .waitFor();
  });
  const current = await plan(ctx, api, update.deviceUpdateId);
  assert.equal(current.hops[0].state, "SUCCEEDED");
  assert.equal(current.hops[1].attempts.length, 2);
  assert.ok(
    current.hops[1].attempts[1].firstCommandSequence > rollback.sequence,
  );
  await ctx.stop(worker);
  return result(
    "Chromium explained immutable path and attempts",
    "visible retry preserved prior Hop success",
    "fresh attempt sequence matched public UpgradePlan",
  );
}

function assertOpenApi(document) {
  const routes = {
    "/api/v1/firmware-images": ["post"],
    "/api/v1/firmware-campaigns": ["get", "post"],
    "/api/v1/firmware-campaigns/{campaignId}": ["get"],
    "/api/v1/firmware-campaigns/{campaignId}/cancel": ["post"],
    "/api/v1/devices/{deviceId}/commands/poll": ["post"],
    "/api/v1/devices/{deviceId}/report-batches": ["post"],
    "/api/v1/devices/{deviceId}/updates": ["get"],
    "/api/v1/firmware-campaigns/{campaignId}/updates": ["get"],
    "/api/v1/device-updates/{deviceUpdateId}/upgrade-plan": ["get"],
    "/api/v1/device-updates/{deviceUpdateId}/retry": ["post"],
    "/api/v1/domain-events": ["get"],
    "/api/v1/verification-snapshot": ["get"],
  };
  for (const [path, methods] of Object.entries(routes)) {
    assert.ok(document.paths?.[path], `OpenAPI missing ${path}`);
    for (const method of methods)
      assert.ok(
        document.paths[path][method],
        `OpenAPI missing ${method} ${path}`,
      );
  }
  const source = JSON.stringify(document);
  for (const name of [
    "UpgradePlan",
    "UpgradeHop",
    "UpgradeHopAttempt",
    "UPGRADE_PATH_UNAVAILABLE",
    "UPGRADE_HOP_NOT_CURRENT",
    "DEVICE_UPDATE_NOT_RETRYABLE",
  ])
    assert.match(source, new RegExp(name, "u"));
  const closed = {
    UpgradePlan: [
      "deviceUpdateId",
      "sourceVersion",
      "targetVersion",
      "pathDigest",
      "currentHopIndex",
      "hops",
      "createdAt",
    ],
    UpgradeHop: [
      "hopIndex",
      "firmwareImageId",
      "fromVersion",
      "toVersion",
      "imageDigest",
      "state",
      "attempts",
    ],
    UpgradeHopAttempt: [
      "attempt",
      "state",
      "firstCommandSequence",
      "lastCommandSequence",
      "startedAt",
      "completedAt",
    ],
  };
  for (const [name, fields] of Object.entries(closed)) {
    const schema = document.components?.schemas?.[name];
    assert.ok(schema, `OpenAPI missing ${name}`);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}).sort(),
      [...fields].sort(),
    );
    assert.deepEqual([...(schema.required ?? [])].sort(), [...fields].sort());
    assert.equal(schema.additionalProperties, false);
  }
  assert.ok(document.paths["/api/v1/firmware-images"].post.responses["201"]);
  assert.ok(document.paths["/api/v1/firmware-campaigns"].post.responses["202"]);
  assert.ok(
    document.paths["/api/v1/device-updates/{deviceUpdateId}/upgrade-plan"].get
      .responses["200"],
  );
  assert.ok(
    document.paths["/api/v1/device-updates/{deviceUpdateId}/retry"].post
      .responses["200"],
  );
}

async function d03(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 1 }),
    api = await prepare(ctx, bundle),
    openapi = await ctx.request(api.baseUrl, "/openapi.json");
  assert.equal(openapi.status, 200);
  assert.match(openapi.json.openapi, /^3\.1(?:\.|$)/u);
  assertOpenApi(openapi.json);
  const device = bundle.seed.devices[0],
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === device.modelId &&
        canonicalVersion(image.version) === "4",
    ),
    campaign = (
      await createCampaign(
        ctx,
        api,
        "d03",
        campaignRequest(
          target.firmwareImageId,
          { modelId: device.modelId },
          { maxParallel: 1 },
        ),
      )
    ).json,
    snapshot = assertSnapshot(await ctx.snapshot(api.baseUrl));
  assert.deepEqual(Object.keys(snapshot.resources).sort(), FINAL_KEYS);
  const update = byId(
      snapshot.resources.deviceUpdates,
      "campaignId",
      campaign.campaignId,
    ),
    upgrade = byId(
      snapshot.resources.upgradePlans,
      "deviceUpdateId",
      update.deviceUpdateId,
    );
  exactKeys(upgrade, PLAN_KEYS, "UpgradePlan");
  for (const hop of upgrade.hops) {
    exactKeys(
      hop,
      [
        "hopIndex",
        "firmwareImageId",
        "fromVersion",
        "toVersion",
        "imageDigest",
        "state",
        "attempts",
      ],
      "UpgradeHop",
    );
    for (const attempt of hop.attempts)
      exactKeys(
        attempt,
        [
          "attempt",
          "state",
          "firstCommandSequence",
          "lastCommandSequence",
          "startedAt",
          "completedAt",
        ],
        "UpgradeHopAttempt",
      );
  }
  for (const work of snapshot.work)
    assert.ok(
      ["COMMAND_DELIVERY", "REPORT_TIMEOUT", "ROLLBACK"].includes(work.kind),
    );
  ctx.mark("spec-gap.blocked", {
    assertionId: "device-update-manager-extension-shape",
    blockedBy: "FF-GAP-01",
    policy: "fail-closed-diagnostic",
  });
  return {
    evidence: [
      "OpenAPI routes/errors and live UpgradePlan agree",
      "FINAL snapshot exact union and Work enum",
    ],
    diagnostics: [
      ctx.diagnostic("device-update-manager-extension-shape", "FF-GAP-01"),
    ],
  };
}

async function d04(ctx) {
  const bundle = baseBundle(ctx.fixtures, { devicesPerModel: 2 }),
    api = await prepare(ctx, bundle),
    model = bundle.seed.deviceModels[0],
    devices = bundle.seed.devices.filter(
      (value) => value.modelId === model.modelId,
    ),
    target = bundle.seed.firmwareImages.find(
      (image) =>
        image.modelId === model.modelId &&
        canonicalVersion(image.version) === "4",
    ),
    campaign = (
      await createCampaign(
        ctx,
        api,
        "d04",
        campaignRequest(
          target.firmwareImageId,
          { modelId: model.modelId },
          { maxParallel: 2 },
        ),
      )
    ).json,
    worker = await ctx.startWorker();
  const commandChains = [];
  for (const device of devices)
    commandChains.push(
      await completeForwardFlow(
        ctx,
        api,
        device.deviceId,
        `d04-hop1-${device.deviceId}`,
        { worker },
      ),
    );
  for (const device of devices)
    commandChains.push(
      await completeForwardFlow(
        ctx,
        api,
        device.deviceId,
        `d04-hop2-${device.deviceId}`,
        { worker },
      ),
    );
  const snapshot = await waitSnapshot(
    ctx,
    api,
    (value) =>
      byId(value.resources.firmwareCampaigns, "campaignId", campaign.campaignId)
        .state === "SUCCEEDED",
    "lineage Campaign success",
    { timeoutMs: 60_000, processes: [worker] },
  );
  await ctx.stop(worker);
  const image = byId(
      snapshot.resources.firmwareImages,
      "firmwareImageId",
      target.firmwareImageId,
    ),
    updates = snapshot.resources.deviceUpdates.filter(
      ({ campaignId }) => campaignId === campaign.campaignId,
    );
  assert.equal(image.sha256, target.sha256);
  for (const update of updates) {
    const upgrade = byId(
        snapshot.resources.upgradePlans,
        "deviceUpdateId",
        update.deviceUpdateId,
      ),
      device = byId(snapshot.resources.devices, "deviceId", update.deviceId),
      commands = snapshot.resources.deviceCommands.filter(
        ({ deviceUpdateId }) => deviceUpdateId === update.deviceUpdateId,
      ),
      reports = snapshot.resources.deviceReports.filter(
        ({ deviceUpdateId }) => deviceUpdateId === update.deviceUpdateId,
      );
    assert.equal(device.installedDigest, target.sha256);
    assert.equal(upgrade.hops.at(-1).imageDigest, target.sha256);
    assert.deepEqual(
      commands.map(({ sequence }) => sequence),
      Array.from({ length: commands.length }, (_, index) => index + 1),
    );
    assert.deepEqual(
      reports.map(({ commandId }) => commandId),
      commands.map(({ commandId }) => commandId),
    );
  }
  assert.ok(
    snapshot.events.some(
      ({ aggregateId, type }) =>
        aggregateId === campaign.campaignId && type === "campaign.completed",
    ),
  );
  assert.doesNotMatch(JSON.stringify(snapshot), /commandToken/iu);
  return result(
    "Image digest closed through Plan Commands Reports and Device",
    "all sequences and identities joined without orphan",
    "Campaign completion Event matched terminal aggregate",
  );
}

export const D_CASES = Object.freeze([
  defineCase("D-01", d01),
  defineCase("D-02", d02),
  defineCase("D-03", d03),
  defineCase("D-04", d04),
]);
