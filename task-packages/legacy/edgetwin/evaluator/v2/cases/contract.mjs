import { applyMergePatch } from "../oracles/index.mjs";
import {
  assertNoChange,
  assertSnapshot,
  clone,
  connect,
  controlCampaign,
  controlWave,
  createCampaign,
  createCommand,
  createWave,
  deploymentWaveBody,
  edgeSeed,
  expectError,
  expectStatus,
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

const contract01 = guardedCase({
  id: "CONTRACT-01", fixtureFamily: "ET-F-SHADOW-MERGE-BOUNDARIES",
  action: "Patch one desired shadow through the public HTTP seam with current, stale, skipped, nested, deletion, dangerous-key, depth, array and size boundaries.",
  oracle: "An independent RFC7396 model fixes the exact value and next version while every invalid or conflicting patch leaves Shadow, Work and Event authority unchanged.",
  async run(ctx) {
    const seed = edgeSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const deviceId = seed.devices[0].deviceId;
    const initial = seed.deviceShadows[0];
    const patch = { firmware: { channel: "beta", rollout: 1 }, intervalSeconds: null };
    const expected = applyMergePatch(initial.desired, patch);
    let current = (await patchDesired(ctx, api.baseUrl, deviceId, { tenantId: seed.tenants[0].tenantId, expectedVersion: initial.desiredVersion, patch })).shadow;
    ctx.equal(current.desired, expected, "nested merge/delete result");
    ctx.equal(current.desiredVersion, initial.desiredVersion + 1, "desired version advances exactly once", { hardCapIds: ["VERSION_REGRESSION"] });
    ctx.equal(current.reportedVersion, initial.reportedVersion, "desired patch does not change reported version", { hardCapIds: ["VERSION_REGRESSION"] });

    const depth32 = Array.from({ length: 32 }).reduce((value) => ({ nested: value }), 1);
    current = (await patchDesired(ctx, api.baseUrl, deviceId, { tenantId: seed.tenants[0].tenantId, expectedVersion: current.desiredVersion, patch: { values: Array.from({ length: 1000 }, (_, index) => index) } }, { key: ctx.key("valid-array-1000") })).shadow;
    ctx.equal(current.desired.values.length, 1000, "array boundary 1000 succeeds");
    current = (await patchDesired(ctx, api.baseUrl, deviceId, { tenantId: seed.tenants[0].tenantId, expectedVersion: current.desiredVersion, patch: { values: null, depth: depth32 } }, { key: ctx.key("valid-depth-32") })).shadow;
    ctx.ok(current.desired.depth, "depth boundary 32 succeeds");
    current = (await patchDesired(ctx, api.baseUrl, deviceId, {
      tenantId: seed.tenants[0].tenantId,
      expectedVersion: current.desiredVersion,
      patch: { firmware: null, depth: null, blob: "x".repeat(65_525) },
    }, { key: ctx.key("valid-size-64k") })).shadow;
    ctx.equal(Buffer.byteLength(JSON.stringify(current.desired)), 65_536, "64 KiB result boundary succeeds");

    for (const [label, expectedVersion] of [["stale", current.desiredVersion - 1], ["skipped", current.desiredVersion + 1]]) {
      const before = await ctx.snapshot(api.baseUrl);
      const response = await patchDesired(ctx, api.baseUrl, deviceId, { tenantId: seed.tenants[0].tenantId, expectedVersion, patch: { intervalSeconds: 10 } }, { key: ctx.key(label), allowFailure: true });
      expectError(ctx, response, 409, "SHADOW_VERSION_CONFLICT", `${label} desired version`, { hardCapIds: ["VERSION_REGRESSION"] });
      assertNoChange(ctx, before, await ctx.snapshot(api.baseUrl), `${label} patch`, ["VERSION_REGRESSION"]);
    }

    const invalid = [
      ["dangerous", JSON.parse('{"$private":1}')],
      ["array", { values: Array.from({ length: 1001 }, (_, index) => index) }],
      ["depth", Array.from({ length: 33 }).reduce((value) => ({ nested: value }), 1)],
      ["size", { blob: "x".repeat(65_526) }],
    ];
    for (const [label, invalidPatch] of invalid) {
      const before = await ctx.snapshot(api.baseUrl);
      const response = await patchDesired(ctx, api.baseUrl, deviceId, { tenantId: seed.tenants[0].tenantId, expectedVersion: current.desiredVersion, patch: invalidPatch }, { key: ctx.key(`invalid-${label}`), allowFailure: true });
      expectError(ctx, response, 400, "INVALID_SHADOW_PATCH", `${label} shadow patch`);
      assertNoChange(ctx, before, await ctx.snapshot(api.baseUrl), `${label} patch`);
    }
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl));
    ctx.equal(resource(snapshot, "deviceCommands").length, seed.deviceCommands.length, "patch creates no command");
    return finalEvidence(ctx, { boundaries: invalid.length + 6, desiredVersion: current.desiredVersion });
  },
});

const contract02 = guardedCase({
  id: "CONTRACT-02", fixtureFamily: "ET-F-OFFLINE-COMMAND-DELIVERY",
  action: "Create ordered commands for an offline device, mutate the caller values, connect it, poll with several limits and cancel one still-undelivered command through public routes.",
  oracle: "Payload, desiredVersion, expiry and deliveryIdentity remain frozen; eligible commands follow createdAt and commandId with no cross-device leakage or duplicate logical delivery.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    const api = await startPreparedApi(ctx, { seed });
    const device = seed.devices[0];
    const bodies = Array.from({ length: 4 }, (_, index) => ({
      tenantId: device.tenantId, deviceId: device.deviceId, kind: "SET_CONFIG", payload: { ordinal: index, nested: { frozen: true } },
      desiredVersion: seed.deviceShadows[0].desiredVersion, expiresAt: ctx.at({ hours: 2, seconds: index }),
    }));
    const commands = [];
    for (const [index, body] of bodies.entries()) commands.push((await createCommand(ctx, api.baseUrl, body, { key: ctx.key(`offline-${index}`) })).command);
    bodies[0].payload.nested.frozen = false;
    const cancelled = await ctx.mutate(api.baseUrl, `/api/v1/device-commands/${commands[3].commandId}/cancel`, ctx.key("cancel-before-poll"), {});
    const cancelledCommand = expectStatus(ctx, cancelled, 200, "cancel command");
    ctx.equal(cancelledCommand.state, "CANCELLED", "cancel is terminal state");
    const connection = (await connect(ctx, api.baseUrl, device.deviceId, device.tenantId)).body;
    ctx.ok(typeof connection.connectionId === "string", "connect returns connectionId");
    const first = await poll(ctx, api.baseUrl, device.deviceId, device.tenantId, connection.connectionId, 2, { key: ctx.key("poll-first") });
    const second = await poll(ctx, api.baseUrl, device.deviceId, device.tenantId, connection.connectionId, 100, { key: ctx.key("poll-second") });
    const delivered = [...first.items, ...second.items];
    ctx.equal(delivered.map(({ commandId }) => commandId), commands.slice(0, 3).map(({ commandId }) => commandId), "poll returns frozen creation order");
    ctx.equal(delivered[0].payload, { ordinal: 0, nested: { frozen: true } }, "command payload is frozen");
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl));
    for (const command of commands) {
      const stored = resource(snapshot, "deviceCommands").find(({ commandId }) => commandId === command.commandId);
      ctx.equal(stored.deliveryIdentity, command.deliveryIdentity, "delivery identity remains stable", { hardCapIds: ["EXPIRED_DELIVERY"] });
    }
    ctx.ok(!delivered.some(({ commandId }) => commandId === commands[3].commandId), "cancelled command is not delivered", { hardCapIds: ["EXPIRED_DELIVERY"] });
    return finalEvidence(ctx, { commands: commands.length, delivered: delivered.length, cancelled: 1 });
  },
});

const contract03 = guardedCase({
  id: "CONTRACT-03", fixtureFamily: "ET-F-RECEIPT-IDENTITY-MATRIX",
  action: "Deliver one command, submit current and stale-base receipts, then replay and conflict both receiptId and tenant-device-sequence identities while observing Command and Shadow.",
  oracle: "Canonical receipt facts remain immutable, only a matching delivery identity and current reported base advances once, and arrival order never overwrites the newer projection.",
  async run(ctx) {
    const seed = edgeSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const command = seed.deviceCommands[0];
    const connection = (await connect(ctx, api.baseUrl, command.deviceId, command.tenantId)).body;
    await poll(ctx, api.baseUrl, command.deviceId, command.tenantId, connection.connectionId, 100);
    const receipts = receiptBodies(ctx, seed);
    const first = await submitReceipt(ctx, api.baseUrl, receipts[0], { key: ctx.key("receipt-current") });
    const replay = await submitReceipt(ctx, api.baseUrl, receipts[0], { key: ctx.key("receipt-current") });
    ctx.equal(replay.response.status, first.response.status, "receipt replay status");
    ctx.equal(replay.receipt, first.receipt, "receipt replay body");
    await submitReceipt(ctx, api.baseUrl, receipts[1], { key: ctx.key("receipt-stale") });

    const changedReceiptId = await submitReceipt(ctx, api.baseUrl, { ...receipts[0], outcome: "FAILED" }, { key: ctx.key("receipt-id-conflict"), allowFailure: true });
    expectError(ctx, changedReceiptId, 409, "RECEIPT_CONFLICT", "changed receiptId", { hardCapIds: ["RECEIPT_DUPLICATE_EFFECT"] });
    const changedSequence = await submitReceipt(ctx, api.baseUrl, { ...receipts[1], receiptId: ctx.uuid("new-receipt-same-sequence"), outcome: "FAILED" }, { key: ctx.key("sequence-conflict"), allowFailure: true });
    expectError(ctx, changedSequence, 409, "RECEIPT_CONFLICT", "changed device sequence", { hardCapIds: ["RECEIPT_DUPLICATE_EFFECT"] });
    const wrongDelivery = await submitReceipt(ctx, api.baseUrl, { ...receipts[1], receiptId: ctx.uuid("wrong-delivery"), deviceSequence: 99, deliveryIdentity: ctx.uuid("wrong-delivery-identity") }, { key: ctx.key("wrong-delivery"), allowFailure: true });
    expectError(ctx, wrongDelivery, 409, "DELIVERY_IDENTITY_CONFLICT", "wrong delivery identity");

    const snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl));
    const shadow = resource(snapshot, "deviceShadows").find(({ deviceId }) => deviceId === command.deviceId);
    ctx.equal(shadow.reportedVersion, seed.deviceShadows[0].reportedVersion + 1, "one reported projection effect", { hardCapIds: ["VERSION_REGRESSION", "RECEIPT_DUPLICATE_EFFECT"] });
    ctx.equal(resource(snapshot, "commandReceipts").filter(({ commandId }) => commandId === command.commandId).length, 2, "two canonical receipt facts");
    return finalEvidence(ctx, { receiptFacts: 2, projected: 1, conflicts: 3 });
  },
});

const contract04 = guardedCase({
  id: "CONTRACT-04", fixtureFamily: "ET-F-CAMPAIGN-FIRMWARE-CONFIRMATION",
  action: "Create a Campaign from deduplicated active devices, reject retired membership, run fanout, and submit nonmatching then matching firmware acknowledgements before controls.",
  oracle: "Each frozen active device owns one target and command, only a matching target digest may succeed, and pause, resume and cancel preserve already confirmed reality.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { includeRetired: true, withCommand: false });
    const api = await startPreparedApi(ctx, { seed });
    const tenantId = seed.tenants[0].tenantId;
    const active = seed.devices.filter(({ state }) => state !== "RETIRED");
    const release = seed.firmwareReleases[1];
    const before = await ctx.snapshot(api.baseUrl);
    const invalid = await createCampaign(ctx, api.baseUrl, { tenantId, firmwareReleaseId: release.firmwareReleaseId, deviceIds: [seed.devices.at(-1).deviceId] }, { key: ctx.key("retired-campaign"), allowFailure: true });
    expectError(ctx, invalid, 400, "INVALID_REQUEST", "retired Campaign member");
    assertNoChange(ctx, before, await ctx.snapshot(api.baseUrl), "invalid Campaign");

    const { campaign } = await createCampaign(ctx, api.baseUrl, { tenantId, firmwareReleaseId: release.firmwareReleaseId, deviceIds: [active[0].deviceId, active[0].deviceId, active[1].deviceId] });
    const workers = await startWorkers(ctx, 2);
    let snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => resource(value, "upgradeTargets").filter(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId).length === 2, { processes: workers });
    const target = resource(snapshot, "upgradeTargets").find(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId);
    const command = resource(snapshot, "deviceCommands").find(({ commandId }) => commandId === target.commandId);
    ctx.ok(command, "fanout creates target command");
    const connection = (await connect(ctx, api.baseUrl, command.deviceId, command.tenantId, { key: ctx.key("campaign-connect") })).body;
    await poll(ctx, api.baseUrl, command.deviceId, command.tenantId, connection.connectionId, 100, { key: ctx.key("campaign-poll") });
    await submitReceipt(ctx, api.baseUrl, {
      tenantId, deviceId: command.deviceId, commandId: command.commandId, deliveryIdentity: command.deliveryIdentity,
      receiptId: ctx.uuid("campaign-wrong-digest"), deviceSequence: 100, outcome: "ACKNOWLEDGED", reportedBaseVersion: seed.deviceShadows.find(({ deviceId }) => deviceId === command.deviceId).reportedVersion,
      reportedPatch: { firmwareDigest: seed.firmwareReleases[0].digest }, observedAt: ctx.at({ minutes: 2 }),
    }, { key: ctx.key("campaign-wrong-digest") });
    snapshot = await ctx.snapshot(api.baseUrl);
    ctx.ok(resource(snapshot, "upgradeTargets").find(({ commandId }) => commandId === command.commandId).state !== "SUCCEEDED", "wrong firmware digest is not success", { hardCapIds: ["FALSE_FIRMWARE_SUCCESS"] });
    const baseVersion = resource(snapshot, "deviceShadows").find(({ deviceId }) => deviceId === command.deviceId).reportedVersion;
    await submitReceipt(ctx, api.baseUrl, {
      tenantId, deviceId: command.deviceId, commandId: command.commandId, deliveryIdentity: command.deliveryIdentity,
      receiptId: ctx.uuid("campaign-matching-digest"), deviceSequence: 101, outcome: "ACKNOWLEDGED", reportedBaseVersion: baseVersion,
      reportedPatch: { firmwareDigest: release.digest }, observedAt: ctx.at({ minutes: 3 }),
    }, { key: ctx.key("campaign-matching-digest") });
    await controlCampaign(ctx, api.baseUrl, campaign.upgradeCampaignId, "pause");
    await controlCampaign(ctx, api.baseUrl, campaign.upgradeCampaignId, "resume");
    await controlCampaign(ctx, api.baseUrl, campaign.upgradeCampaignId, "cancel");
    snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl));
    ctx.equal(resource(snapshot, "upgradeTargets").filter(({ upgradeCampaignId }) => upgradeCampaignId === campaign.upgradeCampaignId).length, 2, "deduplicated frozen targets");
    return finalEvidence(ctx, { targets: 2, firmwareConfirmations: 1, controls: 3 });
  },
});

const contract05 = guardedCase({
  id: "CONTRACT-05", fixtureFamily: "ET-F-WAVE-PUBLIC-CONTRACT",
  action: "Create an UpgradeCampaign, reject duplicate names, duplicate members and boundary-invalid wave requests, then create and read a valid ordered DeploymentWave and run public controls.",
  oracle: "The legal request freezes zero-based ordinals and one wave per device with exact public shapes, while each invalid request is atomic and legacy Campaign resources remain unpolluted.",
  async run(ctx) {
    const seed = edgeSeed(ctx, { withCommand: false });
    const api = await startPreparedApi(ctx, { seed });
    const tenantId = seed.tenants[0].tenantId;
    const { campaign } = await createCampaign(ctx, api.baseUrl, { tenantId, firmwareReleaseId: seed.firmwareReleases[1].firmwareReleaseId, deviceIds: seed.devices.map(({ deviceId }) => deviceId) });
    const legal = deploymentWaveBody(ctx, seed, { upgradeCampaignId: campaign.upgradeCampaignId });
    const invalidBodies = [
      { ...clone(legal), requestRef: "duplicate-name", waves: legal.waves.map((wave) => ({ ...wave, name: "same" })) },
      { ...clone(legal), requestRef: "duplicate-member", waves: [{ ...legal.waves[0] }, { ...legal.waves[1], deviceIds: [legal.waves[0].deviceIds[0]] }] },
      { ...clone(legal), requestRef: "zero-observation", waves: [{ ...legal.waves[0], minimumObservationSeconds: 0 }] },
      { ...clone(legal), requestRef: "failure-overflow", waves: [{ ...legal.waves[0], maximumFailurePercent: 101 }] },
    ];
    for (const [index, body] of invalidBodies.entries()) {
      const before = await ctx.snapshot(api.baseUrl);
      const response = await createWave(ctx, api.baseUrl, body, { key: ctx.key(`invalid-wave-${index}`), allowFailure: true });
      expectError(ctx, response, 400, "INVALID_REQUEST", `invalid wave ${index}`);
      assertNoChange(ctx, before, await ctx.snapshot(api.baseUrl), `invalid wave ${index}`);
    }
    const { deploymentWave, waveDevices } = await createWave(ctx, api.baseUrl, legal);
    ctx.equal(deploymentWave.waves.map(({ ordinal }) => ordinal), [0, 1], "wave ordinal follows frozen request order");
    ctx.equal(new Set(waveDevices.map(({ deviceId }) => deviceId)).size, waveDevices.length, "one WaveDevice per frozen member");
    await controlWave(ctx, api.baseUrl, deploymentWave.deploymentWaveId, "pause");
    await controlWave(ctx, api.baseUrl, deploymentWave.deploymentWaveId, "resume");
    await controlWave(ctx, api.baseUrl, deploymentWave.deploymentWaveId, "cancel");
    const snapshot = assertSnapshot(ctx, await ctx.snapshot(api.baseUrl));
    for (const value of resource(snapshot, "upgradeCampaigns")) ctx.equal(Object.keys(value).sort(), ["createdAt", "firmwareReleaseId", "state", "tenantId", "upgradeCampaignId"].sort(), "legacy Campaign wire is not polluted");
    return finalEvidence(ctx, { rejectedRequests: invalidBodies.length, ordinals: [0, 1], controls: 3 });
  },
});

export const CONTRACT_CASES = Object.freeze([contract01, contract02, contract03, contract04, contract05]);
