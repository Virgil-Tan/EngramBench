import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function offsetMs(offset = {}) {
  return (offset.days ?? 0) * 86_400_000 + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1_000 + (offset.milliseconds ?? 0);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32) || "value";
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be a timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMs(offset)).toISOString(); },
    key(label) { return `et-${slug(caseId)}-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 18)}`.slice(0, 128); },
    integer(label, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) throw new TypeError("invalid integer range");
      return minimum + (hash(namespace, "integer", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

export function digest(label) {
  return createHash("sha256").update(String(label)).digest("hex");
}

export function baseSeed(fixtures, options = {}) {
  const tenantId = fixtures.uuid(options.tenantLabel ?? "tenant");
  const deviceCount = options.deviceCount ?? 4;
  const devices = Array.from({ length: deviceCount }, (_, index) => ({
    deviceId: fixtures.uuid(`device-${index}`),
    tenantId,
    externalRef: `edge-${index}`,
    state: index === deviceCount - 1 && options.includeRetired ? "RETIRED" : options.online ? "ONLINE" : "OFFLINE",
    lastSeenAt: options.online ? fixtures.at({ minutes: -10, seconds: index }) : null,
    createdAt: fixtures.at({ days: -3, seconds: index }),
  }));
  const deviceShadows = devices.map((device, index) => ({
    deviceId: device.deviceId,
    desiredVersion: 2,
    desired: { firmware: { channel: "stable" }, intervalSeconds: 60 + index },
    reportedVersion: 3,
    reported: { firmwareDigest: digest(`prior-${index}`), temperature: 20 + index },
    updatedAt: fixtures.at({ days: -1, seconds: index }),
  }));
  const oldRelease = {
    firmwareReleaseId: fixtures.uuid("firmware-prior"), tenantId, version: "1.0.0", digest: digest("firmware-prior"),
    sizeBytes: 1_048_576, state: "READY", createdAt: fixtures.at({ days: -30 }),
  };
  const targetRelease = {
    firmwareReleaseId: fixtures.uuid("firmware-target"), tenantId, version: "2.0.0", digest: digest("firmware-target"),
    sizeBytes: 2_097_152, state: "READY", createdAt: fixtures.at({ days: -2 }),
  };
  const command = {
    commandId: fixtures.uuid("command-0"), tenantId, deviceId: devices[0].deviceId, kind: "SET_CONFIG",
    payload: { intervalSeconds: 30 }, desiredVersion: 2, deliveryIdentity: fixtures.uuid("delivery-0"),
    state: "QUEUED", expiresAt: fixtures.at({ hours: 2 }), createdAt: fixtures.at({ minutes: -10 }),
  };
  return {
    schemaVersion: 1,
    seedVersion: `et-${slug(fixtures.caseId)}-${hash(fixtures.evaluationSeed, fixtures.caseId, "seed").toString("hex").slice(0, 12)}`,
    importedAt: fixtures.at({ days: -1 }),
    tenants: [{ tenantId, name: "EdgeTwin Hidden Fleet" }],
    devices,
    deviceShadows,
    deviceCommands: options.withCommand === false ? [] : [command],
    commandReceipts: [],
    firmwareReleases: [oldRelease, targetRelease],
    upgradeCampaigns: [],
    upgradeTargets: [],
  };
}

export function receiptPermutation(fixtures, seed = baseSeed(fixtures)) {
  const command = seed.deviceCommands[0];
  const shadow = seed.deviceShadows.find(({ deviceId }) => deviceId === command.deviceId);
  const common = {
    tenantId: command.tenantId,
    deviceId: command.deviceId,
    commandId: command.commandId,
    deliveryIdentity: command.deliveryIdentity,
    outcome: "ACKNOWLEDGED",
    reportedBaseVersion: shadow.reportedVersion,
    observedAt: fixtures.at({ seconds: 10 }),
  };
  return [
    { ...common, receiptId: fixtures.uuid("receipt-sequence-8"), deviceSequence: 8, reportedPatch: { temperature: 22 } },
    { ...common, receiptId: fixtures.uuid("receipt-sequence-7"), deviceSequence: 7, reportedPatch: { temperature: 21 } },
  ];
}

export function waveRequest(fixtures, seed = baseSeed(fixtures), options = {}) {
  const devices = seed.devices.filter(({ state }) => state !== "RETIRED");
  return {
    tenantId: seed.tenants[0].tenantId,
    upgradeCampaignId: options.upgradeCampaignId ?? fixtures.uuid("campaign-request"),
    requestRef: options.requestRef ?? `rollout-${slug(fixtures.caseId)}`,
    waves: options.waves ?? [
      { name: "canary", deviceIds: devices.slice(0, 1).map(({ deviceId }) => deviceId), minimumObservationSeconds: 1, maximumFailurePercent: 0 },
      { name: "fleet", deviceIds: devices.slice(1).map(({ deviceId }) => deviceId), minimumObservationSeconds: 60, maximumFailurePercent: 10 },
    ],
  };
}

export function performanceContract() {
  return Object.freeze({
    shadow: { devices: 100_000, clients: 64, minimumThroughput: 500, maximumP95Ms: 300 },
    commands: { commands: 50_000, minimumThroughput: 350, maximumP95Ms: 450, apiProcesses: 2 },
    upgrade: { devices: 10_000, killedWorkers: 2, replacementWorkers: 4, maximumRecoverySeconds: 60 },
  });
}

export function performanceSeed(fixtures, options = {}) {
  const contract = performanceContract();
  if (options.materialize === false) {
    return { cardinalities: { shadowDevices: contract.shadow.devices, commands: contract.commands.commands, upgradeDevices: contract.upgrade.devices } };
  }
  const scenario = options.scenario ?? "shadow";
  const count = scenario === "upgrade" ? contract.upgrade.devices : scenario === "commands" ? contract.commands.commands : contract.shadow.devices;
  const seed = baseSeed(fixtures, { deviceCount: count, withCommand: false });
  if (scenario === "commands") {
    seed.deviceCommands = seed.devices.map((device, index) => ({
      commandId: fixtures.uuid(`perf-command-${index}`), tenantId: device.tenantId, deviceId: device.deviceId,
      kind: "SYNC", payload: { ordinal: index }, desiredVersion: 2, deliveryIdentity: fixtures.uuid(`perf-delivery-${index}`),
      state: "QUEUED", expiresAt: fixtures.at({ seconds: index % 2 === 0 ? 20 : 120 }), createdAt: fixtures.at({ seconds: index % 17 }),
    }));
  }
  return seed;
}

export function invalidSeedFixtures(fixtures) {
  const valid = baseSeed(fixtures);
  return [
    { label: "dangling-command", value: { ...structuredClone(valid), seedVersion: `${valid.seedVersion}-dangling`, deviceCommands: [{ ...valid.deviceCommands[0], deviceId: fixtures.uuid("missing-device") }] } },
    { label: "duplicate-external-ref", value: { ...structuredClone(valid), seedVersion: `${valid.seedVersion}-duplicate`, devices: valid.devices.map((device) => ({ ...device, externalRef: "duplicate" })) } },
    { label: "receipt-sequence-conflict", value: { ...structuredClone(valid), seedVersion: `${valid.seedVersion}-receipt`, commandReceipts: [
      { receiptId: fixtures.uuid("bad-r1"), tenantId: valid.tenants[0].tenantId, deviceId: valid.devices[0].deviceId, commandId: valid.deviceCommands[0].commandId, deviceSequence: 1, outcome: "ACKNOWLEDGED", reportedPatch: {}, observedAt: fixtures.at(), receivedAt: fixtures.at() },
      { receiptId: fixtures.uuid("bad-r2"), tenantId: valid.tenants[0].tenantId, deviceId: valid.devices[0].deviceId, commandId: valid.deviceCommands[0].commandId, deviceSequence: 1, outcome: "FAILED", reportedPatch: {}, observedAt: fixtures.at(), receivedAt: fixtures.at() },
    ] } },
  ];
}
