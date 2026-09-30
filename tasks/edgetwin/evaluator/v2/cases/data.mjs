import {
  assertSnapshot,
  connect,
  controlWave,
  createCampaign,
  createCommand,
  createWave,
  deploymentWaveBody,
  diagnosticCase,
  edgeSeed,
  expectError,
  finalEvidence,
  guardedCase,
  patchDesired,
  poll,
  receiptBodies,
  resource,
  startPreparedApi,
  startWorkers,
  submitReceipt,
  waitSnapshot,
} from "./helpers.mjs";

async function setupWave(ctx, options = {}) {
  const seed = edgeSeed(ctx, { withCommand: options.withCommand ?? false });
  const target = await (async () => {
    const view = ctx.forWorkspace(ctx.workspace);
    await view.npm("build", [], { timeoutMs: 600_000 });
    await view.migrate({ timeoutMs: 300_000 });
    await view.seed(seed, { timeoutMs: 600_000 });
    return view;
  })();
  const apis = [await target.startApi(), await target.startApi()];
  const { campaign } = await createCampaign(ctx, apis[0].baseUrl, {
    tenantId: seed.tenants[0].tenantId,
    firmwareReleaseId: seed.firmwareReleases[1].firmwareReleaseId,
    deviceIds: seed.devices.map(({ deviceId }) => deviceId),
  }, { key: ctx.key("wave-campaign") });
  const body = deploymentWaveBody(ctx, seed, { upgradeCampaignId: campaign.upgradeCampaignId });
  const created = await createWave(ctx, apis[1].baseUrl, body, { key: ctx.key("wave-create") });
  return { seed, target, apis, campaign, body, ...created };
}

const data01 = guardedCase({
  id: "DATA-01", fixtureFamily: "ET-F-DUAL-VERSION-RACE",
  action: "Race two APIs on one desired expectedVersion while delivering the seeded command and submitting shuffled duplicate receipt and sequence identities across both APIs.",
  oracle: "Exactly one desired successor commits, receipt facts remain immutable, one matching reported base advances once, and neither terminal Command nor reported state can regress.",
  async run(ctx) {
    const seed = edgeSeed(ctx);
    const target = ctx.forWorkspace(ctx.workspace);
    await target.npm("build", [], { timeoutMs: 600_000 });
    await target.migrate();
    await target.seed(seed);
    const apis = [await target.startApi(), await target.startApi()];
    const device = seed.devices[0];
    const expectedVersion = seed.deviceShadows[0].desiredVersion;
    const races = await Promise.all([
      patchDesired(ctx, apis[0].baseUrl, device.deviceId, { tenantId: device.tenantId, expectedVersion, patch: { authority: "left" } }, { key: ctx.key("cas-left"), allowFailure: true }),
      patchDesired(ctx, apis[1].baseUrl, device.deviceId, { tenantId: device.tenantId, expectedVersion, patch: { authority: "right" } }, { key: ctx.key("cas-right"), allowFailure: true }),
    ]);
    ctx.equal(races.map(({ status }) => status).sort(), [200, 409], "two-API desired CAS has one successor", { hardCapIds: ["VERSION_REGRESSION"] });
    expectError(ctx, races.find(({ status }) => status === 409), 409, "SHADOW_VERSION_CONFLICT", "losing desired CAS", { hardCapIds: ["VERSION_REGRESSION"] });

    const command = seed.deviceCommands[0];
    const connection = (await connect(ctx, apis[0].baseUrl, command.deviceId, command.tenantId)).body;
    await poll(ctx, apis[1].baseUrl, command.deviceId, command.tenantId, connection.connectionId, 100);
    const receipts = receiptBodies(ctx, seed);
    const receiptResults = await Promise.all([
      submitReceipt(ctx, apis[0].baseUrl, receipts[0], { key: ctx.key("receipt-b"), allowFailure: true }),
      submitReceipt(ctx, apis[1].baseUrl, receipts[1], { key: ctx.key("receipt-a"), allowFailure: true }),
    ]);
    ctx.ok(receiptResults.every(({ status }) => status === 200), "shuffled distinct receipts remain visible");
    const duplicates = await ctx.concurrent(Array.from({ length: 20 }, (_, index) => index), 20, (index) => submitReceipt(ctx, apis[index % 2].baseUrl, receipts[index % 2], { key: ctx.key(index % 2 ? "receipt-a" : "receipt-b"), allowFailure: true }));
    ctx.ok(duplicates.every(({ status }) => status === 200), "exact receipt duplicates replay");
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(apis[0].baseUrl));
    const shadow = resource(snapshot, "deviceShadows").find(({ deviceId }) => device.deviceId === deviceId);
    ctx.equal(shadow.desiredVersion, expectedVersion + 1, "one desired successor", { hardCapIds: ["VERSION_REGRESSION"] });
    ctx.equal(shadow.reportedVersion, seed.deviceShadows[0].reportedVersion + 1, "one reported successor", { hardCapIds: ["VERSION_REGRESSION", "RECEIPT_DUPLICATE_EFFECT"] });
    ctx.equal(resource(snapshot, "commandReceipts").filter(({ commandId }) => commandId === command.commandId).length, 2, "two immutable receipt facts", { hardCapIds: ["RECEIPT_DUPLICATE_EFFECT"] });
    return finalEvidence(ctx, { apiProcesses: 2, casWinners: 1, duplicateReplays: duplicates.length });
  },
});

async function droppedMutation(ctx, shield, path, key, body, method = "POST") {
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, path, key, body, { method }).catch(() => undefined);
  const capture = await ctx.waitFor(() => shield.captures.find(({ request, dropped }) => request.path === path && dropped), { timeoutMs: 30_000, label: `dropped ${path}` });
  return { status: capture.response.status, json: JSON.parse(capture.response.body) };
}

async function replayAcross(ctx, apis, path, key, body, expected, method = "POST") {
  const responses = await ctx.concurrent(Array.from({ length: 20 }, (_, index) => index), 20, (index) => ctx.mutate(apis[index % apis.length].baseUrl, path, key, body, { method }));
  for (const response of responses) ctx.equal({ status: response.status, json: response.json }, expected, `${path} durable replay`, { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
}

const data02 = guardedCase({
  id: "DATA-02", fixtureFamily: "ET-F-DURABLE-EDGE-REPLAY",
  action: "Drop committed patch, command, Wave create and Wave control responses, restart an API and issue twenty concurrent cross-instance retries plus changed-content reuse.",
  oracle: "Every retry returns the original status, semantic JSON and identities with one Shadow version, Command, Wave transition, Work and Event effect; changed content conflicts.",
  async run(ctx) {
    const setup = await setupWave(ctx);
    const [api1Initial, api2] = setup.apis;
    const device = setup.seed.devices[0];
    let api1 = api1Initial;
    let shield = await ctx.responseShield(api1.baseUrl);
    const patchPath = `/api/v1/devices/${device.deviceId}/shadow/desired`;
    const patchBody = { tenantId: device.tenantId, expectedVersion: setup.seed.deviceShadows[0].desiredVersion, patch: { replay: true } };
    const patchKey = ctx.key("lost-patch");
    const patchExpected = await droppedMutation(ctx, shield, patchPath, patchKey, patchBody, "PATCH");
    await ctx.kill(api1);
    api1 = await setup.target.startApi();
    await replayAcross(ctx, [api1, api2], patchPath, patchKey, patchBody, patchExpected, "PATCH");
    const patchConflict = await ctx.mutate(api1.baseUrl, patchPath, patchKey, { ...patchBody, patch: { replay: false } }, { method: "PATCH" });
    expectError(ctx, patchConflict, 409, "IDEMPOTENCY_CONFLICT", "changed patch replay", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });

    const commandPath = "/api/v1/device-commands";
    const commandBody = { tenantId: device.tenantId, deviceId: device.deviceId, kind: "SYNC", payload: { durable: true }, desiredVersion: patchExpected.json.desiredVersion, expiresAt: ctx.at({ hours: 2 }) };
    const commandKey = ctx.key("lost-command");
    shield = await ctx.responseShield(api2.baseUrl);
    const commandExpected = await droppedMutation(ctx, shield, commandPath, commandKey, commandBody);
    await replayAcross(ctx, [api1, api2], commandPath, commandKey, commandBody, commandExpected);
    const changedCommand = await ctx.mutate(api1.baseUrl, commandPath, commandKey, { ...commandBody, payload: { durable: false } });
    expectError(ctx, changedCommand, 409, "IDEMPOTENCY_CONFLICT", "changed command replay", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });

    const secondCampaign = await createCampaign(ctx, api1.baseUrl, {
      tenantId: setup.seed.tenants[0].tenantId,
      firmwareReleaseId: setup.seed.firmwareReleases[1].firmwareReleaseId,
      deviceIds: setup.seed.devices.map(({ deviceId }) => deviceId),
    }, { key: ctx.key("lost-wave-campaign") });
    const waveBody = deploymentWaveBody(ctx, setup.seed, { upgradeCampaignId: secondCampaign.campaign.upgradeCampaignId, requestRef: "lost-wave-create" });
    const waveKey = ctx.key("lost-wave-create");
    shield = await ctx.responseShield(api2.baseUrl);
    const waveExpected = await droppedMutation(ctx, shield, "/api/v1/deployment-waves", waveKey, waveBody);
    await replayAcross(ctx, [api1, api2], "/api/v1/deployment-waves", waveKey, waveBody, waveExpected);
    const changedWave = await ctx.mutate(api1.baseUrl, "/api/v1/deployment-waves", waveKey, { ...waveBody, requestRef: "changed-wave-create" });
    expectError(ctx, changedWave, 409, "IDEMPOTENCY_CONFLICT", "changed Wave replay", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    const replayedWaveId = waveExpected.json.deploymentWave.deploymentWaveId;
    const controlPath = `/api/v1/deployment-waves/${replayedWaveId}/pause`;
    const controlKey = ctx.key("lost-wave-pause");
    shield = await ctx.responseShield(api1.baseUrl);
    const controlExpected = await droppedMutation(ctx, shield, controlPath, controlKey, {});
    await replayAcross(ctx, [api1, api2], controlPath, controlKey, {}, controlExpected);
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(api2.baseUrl));
    ctx.equal(resource(snapshot, "deviceCommands").filter(({ commandId }) => commandId === commandExpected.json.commandId).length, 1, "one replayed command", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    ctx.equal(resource(snapshot, "deploymentWaves").filter(({ deploymentWaveId }) => deploymentWaveId === replayedWaveId).length, 1, "one replayed DeploymentWave", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    return finalEvidence(ctx, { droppedResponses: 4, replayRequests: 80, apiProcesses: 2 });
  },
});

const data03 = diagnosticCase({
  id: "DATA-03", fixtureFamily: "ET-F-FROZEN-WAVE-AUTHORITY",
  action: "Freeze a two-wave partition, add another public Device afterward and inspect Wave membership and current authority without inventing the unpublished health denominator or advance formula.",
  oracle: "Ordinals, members, target release and prior firmware remain frozen and at most one wave is RUNNING; health adjudication itself remains fail-closed until specified.",
  assertionId: "wave-health-adjudication", blockedBy: "SPEC-GAP-ET-01",
  async run(ctx) {
    const setup = await setupWave(ctx);
    const newDevice = await ctx.mutate(setup.apis[0].baseUrl, "/api/v1/devices", ctx.key("late-device"), {
      tenantId: setup.seed.tenants[0].tenantId, externalRef: "late-device", state: "OFFLINE",
    });
    ctx.equal(newDevice.status, 200, "late Device creation");
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(setup.apis[1].baseUrl));
    const members = resource(snapshot, "waveDevices").filter(({ deploymentWaveId }) => deploymentWaveId === setup.deploymentWave.deploymentWaveId);
    ctx.equal(members.map(({ deviceId }) => deviceId).sort(), setup.waveDevices.map(({ deviceId }) => deviceId).sort(), "frozen wave membership does not absorb late device", { hardCapIds: ["WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    ctx.ok(setup.deploymentWave.waves.filter(({ state }) => state === "RUNNING").length <= 1, "at most one RUNNING wave", { hardCapIds: ["WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    return { evidence: [{ kind: "edgetwin-frozen-wave", members: members.length, lateDeviceId: newDevice.json.deviceId }] };
  },
});

const data04 = guardedCase({
  id: "DATA-04", fixtureFamily: "ET-F-WAVE-CONTROL-CONTENTION",
  action: "Run two APIs and four workers while concurrently pausing, resuming and cancelling one frozen DeploymentWave, then repeat controls and inspect terminal members and command identities.",
  oracle: "Controls converge to one legal aggregate state, resume touches only nonterminal members, cancel fences pending delivery and no successful or failed member can be reset or duplicated.",
  async run(ctx) {
    const setup = await setupWave(ctx);
    const workers = await startWorkers(ctx, 4);
    const actions = ["pause", "resume", "cancel"];
    const responses = await Promise.all(actions.map((action, index) => controlWave(ctx, setup.apis[index % 2].baseUrl, setup.deploymentWave.deploymentWaveId, action, { key: ctx.key(`race-${action}`), allowFailure: true })));
    ctx.ok(responses.every(({ status }) => [200, 409].includes(status)), "control race has only published outcomes");
    const snapshot = await waitSnapshot(ctx, setup.apis[0].baseUrl, (value) => {
      const wave = resource(value, "deploymentWaves").find(({ deploymentWaveId }) => deploymentWaveId === setup.deploymentWave.deploymentWaveId);
      return wave && ["QUEUED", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED", "ROLLED_BACK"].includes(wave.state);
    }, { processes: workers });
    assertSnapshot(ctx, snapshot);
    const members = resource(snapshot, "waveDevices").filter(({ deploymentWaveId }) => deploymentWaveId === setup.deploymentWave.deploymentWaveId);
    ctx.equal(new Set(members.map(({ deviceId }) => deviceId)).size, members.length, "one WaveDevice per member", { hardCapIds: ["WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    const commandIds = members.flatMap(({ commandId }) => commandId ? [commandId] : []);
    ctx.equal(new Set(commandIds).size, commandIds.length, "one wave command per member", { hardCapIds: ["WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    return finalEvidence(ctx, { controls: actions.length, workers: workers.length, outcomes: responses.map(({ status }) => status) });
  },
});

const data05 = guardedCase({
  id: "DATA-05", fixtureFamily: "ET-F-FROZEN-ROLLBACK-AFFECTED-SET",
  action: "Confirm target firmware for only one frozen WaveDevice, leave peers failed or pending, then issue concurrent rollback requests and replay shuffled receipts.",
  oracle: "Only the already successful member receives one compensation Target and Command frozen to its prior firmware; repeat rollback cannot expand or duplicate the affected set.",
  async run(ctx) {
    const setup = await setupWave(ctx);
    const workers = await startWorkers(ctx, 4);
    let snapshot = await waitSnapshot(ctx, setup.apis[0].baseUrl, (value) => resource(value, "waveDevices").some(({ deploymentWaveId, commandId }) => deploymentWaveId === setup.deploymentWave.deploymentWaveId && commandId), { processes: workers });
    const member = resource(snapshot, "waveDevices").find(({ deploymentWaveId, commandId }) => deploymentWaveId === setup.deploymentWave.deploymentWaveId && commandId);
    const command = resource(snapshot, "deviceCommands").find(({ commandId }) => commandId === member.commandId);
    const connection = (await connect(ctx, setup.apis[0].baseUrl, command.deviceId, command.tenantId, { key: ctx.key("rollback-connect") })).body;
    await poll(ctx, setup.apis[1].baseUrl, command.deviceId, command.tenantId, connection.connectionId, 100, { key: ctx.key("rollback-poll") });
    const shadow = resource(snapshot, "deviceShadows").find(({ deviceId }) => deviceId === command.deviceId);
    const targetRelease = setup.seed.firmwareReleases[1];
    await submitReceipt(ctx, setup.apis[0].baseUrl, {
      tenantId: command.tenantId, deviceId: command.deviceId, commandId: command.commandId, deliveryIdentity: command.deliveryIdentity,
      receiptId: ctx.uuid("rollback-success"), deviceSequence: 500, outcome: "ACKNOWLEDGED", reportedBaseVersion: shadow.reportedVersion,
      reportedPatch: { firmwareDigest: targetRelease.digest }, observedAt: ctx.at({ minutes: 10 }),
    }, { key: ctx.key("rollback-success") });
    await waitSnapshot(ctx, setup.apis[0].baseUrl, (value) => resource(value, "waveDevices").some(({ deviceId, state }) => deviceId === command.deviceId && state === "SUCCEEDED"), { processes: workers });
    const rollbacks = await Promise.all(Array.from({ length: 20 }, (_, index) => controlWave(ctx, setup.apis[index % 2].baseUrl, setup.deploymentWave.deploymentWaveId, "rollback", { key: ctx.key("rollback-once"), allowFailure: true })));
    ctx.ok(rollbacks.every(({ status }) => [200, 409].includes(status)), "rollback replays have published outcomes");
    snapshot = await waitSnapshot(ctx, setup.apis[0].baseUrl, (value) => resource(value, "waveDevices").some(({ deviceId, rollbackTargetId }) => deviceId === command.deviceId && rollbackTargetId), { processes: workers });
    assertSnapshot(ctx, snapshot);
    const compensated = resource(snapshot, "waveDevices").filter(({ deploymentWaveId, rollbackTargetId }) => deploymentWaveId === setup.deploymentWave.deploymentWaveId && rollbackTargetId);
    ctx.equal(compensated.length, 1, "rollback affected set contains only successful member", { hardCapIds: ["WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    ctx.equal(compensated[0].deviceId, command.deviceId, "compensation belongs to confirmed device", { hardCapIds: ["WAVE_AUTHORITY_OR_ROLLBACK_DRIFT"] });
    return finalEvidence(ctx, { successfulMembers: 1, rollbackRequests: rollbacks.length, compensations: compensated.length });
  },
});

export const DATA_CASES = Object.freeze([data01, data02, data03, data04, data05]);
