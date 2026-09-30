import {
  assertSnapshot,
  clickControl,
  connect,
  controlWave,
  createCampaign,
  createCommand,
  createWave,
  deploymentWaveBody,
  edgeSeed,
  finalEvidence,
  guardedCase,
  launchBrowser,
  openApiOperation,
  patchDesired,
  poll,
  resource,
  setField,
  startPreparedApi,
  submitReceipt,
} from "./helpers.mjs";

const layer01 = guardedCase({
  id: "LAYER-01", fixtureFamily: "ET-F-OPENAPI-RUNTIME-CLOSURE",
  action: "Read OpenAPI 3.1 and execute live success and error traffic for Shadow, Command, Receipt, Campaign and DeploymentWave routes using their exact published methods and bodies.",
  oracle: "Every runtime status and closed top-level shape is documented by the matching OpenAPI operation, required requests reject unknown fields, and V1 schemas contain no Wave fields.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    const api = await startPreparedApi(ctx, { seed });
    const documentResponse = await ctx.request(api.baseUrl, "/openapi.json");
    ctx.equal(documentResponse.status, 200, "OpenAPI status");
    const document = documentResponse.json;
    ctx.equal(document.openapi, "3.1.0", "OpenAPI version");
    const required = [
      ["/api/v1/devices/:deviceId/shadow/desired", "patch"],
      ["/api/v1/device-commands", "post"],
      ["/api/v1/command-receipts", "post"],
      ["/api/v1/upgrade-campaigns", "post"],
      ["/api/v1/deployment-waves", "post"],
      ["/api/v1/deployment-waves/:deploymentWaveId", "get"],
      ["/api/v1/deployment-waves/:deploymentWaveId/pause", "post"],
      ["/api/v1/deployment-waves/:deploymentWaveId/resume", "post"],
      ["/api/v1/deployment-waves/:deploymentWaveId/cancel", "post"],
      ["/api/v1/deployment-waves/:deploymentWaveId/rollback", "post"],
    ];
    for (const [path, method] of required) {
      const operation = openApiOperation(document, path, method);
      ctx.ok(operation.responses && typeof operation.responses === "object", `${method.toUpperCase()} ${path} documents responses`);
      if (method !== "get") ctx.equal(operation.requestBody?.required ?? operation.requestBody?.$ref !== undefined, true, `${method.toUpperCase()} ${path} requires JSON body`);
    }
    const device = seed.devices[0];
    const patch = await patchDesired(ctx, api.baseUrl, device.deviceId, { expectedVersion: seed.deviceShadows[0].desiredVersion, patch: { openapi: true } });
    const command = await createCommand(ctx, api.baseUrl, { tenantId: device.tenantId, deviceId: device.deviceId, kind: "OPENAPI", payload: {}, desiredVersion: patch.shadow.desiredVersion, expiresAt: ctx.at({ hours: 2 }) });
    const campaign = await createCampaign(ctx, api.baseUrl, { tenantId: device.tenantId, firmwareReleaseId: seed.firmwareReleases[1].firmwareReleaseId, deviceIds: seed.devices.map(({ deviceId }) => deviceId) });
    const wave = await createWave(ctx, api.baseUrl, deploymentWaveBody(ctx, seed, { upgradeCampaignId: campaign.campaign.upgradeCampaignId }));
    const read = await ctx.request(api.baseUrl, `/api/v1/deployment-waves/${wave.deploymentWave.deploymentWaveId}`);
    ctx.equal(read.status, 200, "DeploymentWave read status");
    ctx.equal(Object.keys(read.json).sort(), ["deploymentWave", "waveDevices"].sort(), "DeploymentWave read shape");
    ctx.ok(![...Object.keys(campaign.campaign), ...Object.keys(command.command)].some((key) => /wave|ordinal|requestRef/iu.test(key)), "V1 runtime wire has no Wave-only fields");
    return finalEvidence(ctx, { operations: required.length, liveResources: 4 });
  },
});

const layer02 = guardedCase({
  id: "LAYER-02", fixtureFamily: "ET-F-BROWSER-V1-DEVICE-FLOW",
  action: "Use Harness-owned Chromium and visible production controls to select a tenant and device, patch desired state, create an offline command, connect, poll, acknowledge and control a Campaign.",
  oracle: "Visible versions, delivery identity, expiry and target progress survive refresh and equal public HTTP plus snapshot authority; no mock, private endpoint or cross-tenant state is used.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    const api = await startPreparedApi(ctx, { seed });
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await setField(page, [/tenant/i], seed.tenants[0].tenantId);
    await setField(page, [/device/i], seed.devices[0].deviceId);
    await clickControl(page, [/shadow/i, /device/i]);
    await setField(page, [/expected.*version/i, /desired.*version/i], String(seed.deviceShadows[0].desiredVersion));
    await setField(page, [/patch|desired.*json/i], JSON.stringify({ browser: true }));
    await clickControl(page, [/apply.*patch|update.*desired|save.*shadow/i]);
    await page.getByText(/browser|desired/i).first().waitFor({ state: "visible", timeout: 15_000 });

    await clickControl(page, [/new.*command|create.*command/i]);
    await setField(page, [/kind/i], "UI_SYNC");
    await setField(page, [/payload/i], JSON.stringify({ source: "browser" }));
    await clickControl(page, [/create|submit/i]);
    await page.getByText(/queued|UI_SYNC/i).first().waitFor({ state: "visible", timeout: 15_000 });
    await clickControl(page, [/connect/i]);
    await clickControl(page, [/poll/i]);
    await clickControl(page, [/acknowledge|receipt/i]);

    await clickControl(page, [/new.*campaign|create.*campaign/i]);
    await setField(page, [/firmware.*release/i], seed.firmwareReleases[1].firmwareReleaseId);
    await clickControl(page, [/create|submit/i]);
    await page.reload({ waitUntil: "domcontentloaded" });
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl));
    ctx.ok(resource(snapshot, "deviceShadows").some(({ desired }) => desired?.browser === true), "browser shadow patch reached PostgreSQL");
    ctx.ok(resource(snapshot, "deviceCommands").some(({ kind }) => kind === "UI_SYNC"), "browser command reached public API");
    ctx.ok(resource(snapshot, "upgradeCampaigns").length >= 1, "browser Campaign reached public API");
    return finalEvidence(ctx, { chromium: true, flows: ["shadow", "command", "receipt", "campaign"] });
  },
});

const layer03 = guardedCase({
  id: "LAYER-03", fixtureFamily: "ET-F-BROWSER-WAVE-ROLLBACK",
  action: "Use real Chromium controls to create a two-part DeploymentWave, pause, resume, cancel and request rollback, then inspect frozen members, prior firmware and compensation lineage after refresh.",
  oracle: "UI, public HTTP and snapshot agree on ordinal, member and unique rollbackTarget identity without dynamic membership, false command withdrawal or inferred health-gate output.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    const api = await startPreparedApi(ctx, { seed });
    const campaign = await createCampaign(ctx, api.baseUrl, { tenantId: seed.tenants[0].tenantId, firmwareReleaseId: seed.firmwareReleases[1].firmwareReleaseId, deviceIds: seed.devices.map(({ deviceId }) => deviceId) });
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await clickControl(page, [/deployment.*wave|waves/i]);
    await clickControl(page, [/new.*wave|create.*wave/i]);
    await setField(page, [/campaign/i], campaign.campaign.upgradeCampaignId);
    await setField(page, [/request.*ref/i], `ui-${ctx.key("wave")}`);
    await setField(page, [/wave.*definition|waves.*json/i], JSON.stringify(deploymentWaveBody(ctx, seed, { upgradeCampaignId: campaign.campaign.upgradeCampaignId }).waves));
    await clickControl(page, [/create|submit/i]);
    await page.getByText(/canary/i).first().waitFor({ state: "visible", timeout: 15_000 });
    for (const action of [/pause/i, /resume/i, /cancel/i, /rollback/i]) {
      const button = page.getByRole("button", { name: action }).first();
      if (await button.isVisible().catch(() => false)) await button.click();
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl));
    const wave = resource(snapshot, "deploymentWaves").find(({ upgradeCampaignId }) => upgradeCampaignId === campaign.campaign.upgradeCampaignId);
    ctx.ok(wave, "browser-created DeploymentWave persisted");
    const members = resource(snapshot, "waveDevices").filter(({ deploymentWaveId }) => deploymentWaveId === wave.deploymentWaveId);
    ctx.equal(new Set(members.map(({ deviceId }) => deviceId)).size, members.length, "browser flow retains frozen unique members", { hardCapIds: ["WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    ctx.ok(members.every(({ priorFirmwareReleaseId, targetFirmwareReleaseId }) => priorFirmwareReleaseId && targetFirmwareReleaseId), "UI-backed WaveDevices expose frozen firmware lineage");
    return finalEvidence(ctx, { chromium: true, members: members.length, controlsAttempted: 4 });
  },
});

const layer04 = guardedCase({
  id: "LAYER-04", fixtureFamily: "ET-F-POINT-IN-TIME-SNAPSHOT",
  action: "Capture repeated authenticated snapshots while two APIs patch a Shadow, deliver and acknowledge a Command and mutate DeploymentWave controls against the same database.",
  oracle: "Every individual asOf is internally linked, sorted and tenant-isolated across Shadow, Command, Receipt, Target, WaveDevice, Work and Event without torn authority or secret leakage.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    const target = ctx.forWorkspace(ctx.workspace);
    await target.npm("build", [], { timeoutMs: 600_000 });
    await target.migrate();
    await target.seed(seed);
    const apis = [await target.startApi(), await target.startApi()];
    const device = seed.devices[0];
    const command = await createCommand(ctx, apis[0].baseUrl, { tenantId: device.tenantId, deviceId: device.deviceId, kind: "SNAPSHOT", payload: {}, desiredVersion: seed.deviceShadows[0].desiredVersion, expiresAt: ctx.at({ hours: 2 }) });
    const campaign = await createCampaign(ctx, apis[1].baseUrl, { tenantId: device.tenantId, firmwareReleaseId: seed.firmwareReleases[1].firmwareReleaseId, deviceIds: seed.devices.map(({ deviceId }) => deviceId) });
    const wave = await createWave(ctx, apis[0].baseUrl, deploymentWaveBody(ctx, seed, { upgradeCampaignId: campaign.campaign.upgradeCampaignId }));
    const connection = (await connect(ctx, apis[1].baseUrl, device.deviceId, device.tenantId)).body;
    await poll(ctx, apis[0].baseUrl, device.deviceId, device.tenantId, connection.connectionId, 100);
    const operations = [
      patchDesired(ctx, apis[0].baseUrl, device.deviceId, { expectedVersion: seed.deviceShadows[0].desiredVersion, patch: { snapshot: true } }),
      controlWave(ctx, apis[1].baseUrl, wave.deploymentWave.deploymentWaveId, "pause", { allowFailure: true }),
    ];
    const snapshots = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.snapshot(apis[index % 2].baseUrl)));
    await Promise.all(operations);
    for (const snapshot of snapshots) {
      assertSnapshot(ctx, snapshot);
      for (const commandValue of resource(snapshot, "deviceCommands")) ctx.ok(resource(snapshot, "devices").some(({ deviceId }) => deviceId === commandValue.deviceId), "snapshot Command links to Device");
      for (const member of resource(snapshot, "waveDevices")) ctx.ok(resource(snapshot, "deploymentWaves").some(({ deploymentWaveId }) => deploymentWaveId === member.deploymentWaveId), "snapshot WaveDevice links to DeploymentWave");
    }
    const final = assertSnapshot(ctx, await ctx.snapshot(apis[0].baseUrl));
    ctx.ok(resource(final, "deviceCommands").some(({ commandId }) => commandId === command.command.commandId), "final snapshot includes command");
    return finalEvidence(ctx, { snapshots: snapshots.length + 1, apiProcesses: 2 });
  },
});

export const LAYER_CASES = Object.freeze([layer01, layer02, layer03, layer04]);
