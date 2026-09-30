import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}
function slug(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "")
      .slice(0, 28) || "value"
  );
}
function offsetMs(offset = {}) {
  return (
    (offset.days ?? 0) * 86_400_000 +
    (offset.hours ?? 0) * 3_600_000 +
    (offset.minutes ?? 0) * 60_000 +
    (offset.seconds ?? 0) * 1_000 +
    (offset.milliseconds ?? 0)
  );
}
export function digestBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime)
    throw new TypeError("evaluationSeed, caseId and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch))
    throw new TypeError("baseTime must be a timestamp");
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
    at(offset = {}) {
      return new Date(epoch + offsetMs(offset)).toISOString();
    },
    key(label) {
      return `ff-${slug(caseId)}-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 16)}`.slice(
        0,
        128,
      );
    },
    bytes(label, size = 128) {
      if (!Number.isSafeInteger(size) || size < 1)
        throw new TypeError("size must be positive");
      const chunks = [];
      for (let index = 0, total = 0; total < size; index += 1) {
        const chunk = hash(namespace, "bytes", label, index);
        chunks.push(chunk);
        total += chunk.length;
      }
      return Buffer.concat(chunks).subarray(0, size);
    },
  });
}

export function imageAsset(
  fixtures,
  label,
  version,
  modelId,
  compatibleFromVersions,
  options = {},
) {
  const bytes = fixtures.bytes(`${label}-bytes`, options.size ?? 128);
  const assetPath = `assets/${slug(label)}.bin`;
  return {
    bytes,
    assetPath,
    image: {
      firmwareImageId: fixtures.uuid(`${label}-image`),
      modelId,
      version,
      sha256: digestBytes(bytes),
      size: bytes.length,
      downloadPath: `/firmware/${slug(label)}.bin`,
      compatibleFromVersions,
      createdAt: fixtures.at({ minutes: options.minute ?? 1 }),
      assetPath,
    },
  };
}

export function baseBundle(fixtures, options = {}) {
  const modelCount = options.modelCount ?? 2;
  const devicesPerModel = options.devicesPerModel ?? 4;
  const deviceModels = Array.from({ length: modelCount }, (_, index) => ({
    modelId: fixtures.uuid(`model-${index}`),
    name: `Model ${index + 1}`,
  }));
  const priorBytes = fixtures.bytes("prior-firmware", 64);
  const priorDigest = digestBytes(priorBytes);
  const devices = deviceModels.flatMap((model, modelIndex) =>
    Array.from({ length: devicesPerModel }, (_, index) => ({
      deviceId: fixtures.uuid(`device-${modelIndex}-${index}`),
      modelId: model.modelId,
      labels: {
        environment: index % 2 ? "prod" : "canary",
        region: index % 3 ? "west" : "east",
      },
      installedVersion: "1",
      installedDigest: priorDigest,
      lastReportSequence: 0,
    })),
  );
  const assets = [];
  const firmwareImages = [];
  for (const [modelIndex, model] of deviceModels.entries()) {
    const two = imageAsset(
      fixtures,
      `model-${modelIndex}-v2`,
      `2`,
      model.modelId,
      ["1"],
    );
    const three = imageAsset(
      fixtures,
      `model-${modelIndex}-v3`,
      `3`,
      model.modelId,
      ["1"],
    );
    const four = imageAsset(
      fixtures,
      `model-${modelIndex}-v4`,
      `4`,
      model.modelId,
      ["2", "3"],
    );
    for (const entry of [two, three, four]) {
      firmwareImages.push(entry.image);
      assets.push({ path: entry.assetPath, bytes: entry.bytes });
    }
  }
  return {
    seed: {
      schemaVersion: 1,
      seedVersion: `ff-${slug(fixtures.caseId)}-${hash(fixtures.evaluationSeed, fixtures.caseId, "seed").toString("hex").slice(0, 12)}`,
      deviceModels,
      devices,
      firmwareImages,
      campaigns: options.campaigns ?? [],
      deviceUpdates: options.deviceUpdates ?? [],
      commands: options.commands ?? [],
      reports: options.reports ?? [],
    },
    assets,
  };
}

export function publicImageRequest(image) {
  const {
    firmwareImageId: _id,
    createdAt: _created,
    assetPath: _asset,
    ...request
  } = image;
  return request;
}
export function campaignRequest(imageId, selector, options = {}) {
  return {
    firmwareImageId: imageId,
    selector,
    maxParallel: options.maxParallel ?? 2,
    reportTimeoutSeconds: options.reportTimeoutSeconds ?? 5,
  };
}
export function pollRequest(lastCommandSequence) {
  return { lastCommandSequence };
}
export function reportRequest(command, options = {}) {
  return {
    firstSequence: options.sequence ?? command.sequence,
    reports: [
      {
        sequence: options.sequence ?? command.sequence,
        commandId: options.commandId ?? command.commandId,
        commandToken: options.commandToken ?? command.commandToken,
        outcome: options.outcome ?? "SUCCEEDED",
        installedDigest: Object.hasOwn(options, "installedDigest")
          ? options.installedDigest
          : command.type === "VERIFY"
            ? command.imageDigest
            : null,
      },
    ],
  };
}

export function performanceContract() {
  return Object.freeze({
    poll: {
      clients: 64,
      warmupSeconds: 10,
      measureSeconds: 60,
      minimumThroughput: 3000,
      maximumP95Ms: 80,
    },
    report: {
      clients: 64,
      warmupSeconds: 10,
      measureSeconds: 60,
      minimumThroughput: 2000,
      maximumP95Ms: 200,
      warmupUnique: 10_000,
      measuredUnique: 60_000,
    },
    recovery: {
      items: 100_000,
      killedWorkers: 2,
      replacementWorkers: 2,
      maximumSeconds: 180,
    },
  });
}

export function performanceBundle(fixtures, options = {}) {
  if (options.materialize === false)
    return {
      models: 100,
      devices: 100_000,
      images: 500,
      campaigns: 100,
      updates: 100_000,
      commands: 100_000,
      reports: 0,
    };
  const deviceModels = Array.from({ length: 100 }, (_, i) => ({
    modelId: fixtures.uuid(`perf-model-${i}`),
    name: `Perf Model ${i}`,
  }));
  const priorDigest = digestBytes(fixtures.bytes("perf-prior", 64));
  const assets = [];
  const firmwareImages = [];
  for (let model = 0; model < 100; model += 1)
    for (let version = 2; version <= 6; version += 1) {
      const entry = imageAsset(
        fixtures,
        `perf-${model}-${version}`,
        String(version),
        deviceModels[model].modelId,
        [String(version - 1)],
        { size: 64 },
      );
      firmwareImages.push(entry.image);
      assets.push({ path: entry.assetPath, bytes: entry.bytes });
    }
  const devices = Array.from({ length: 100_000 }, (_, index) => ({
    deviceId: fixtures.uuid(`perf-device-${index}`),
    modelId: deviceModels[Math.floor(index / 1000)].modelId,
    labels: { cohort: `c${index % 10}` },
    installedVersion: "1",
    installedDigest: priorDigest,
    lastReportSequence: 0,
  }));
  const campaigns = Array.from({ length: 100 }, (_, index) => {
    const targets = devices
      .slice(index * 1000, (index + 1) * 1000)
      .map(({ deviceId }) => deviceId)
      .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    return {
      campaignId: fixtures.uuid(`perf-campaign-${index}`),
      firmwareImageId: firmwareImages[index * 5].firmwareImageId,
      targetCount: 1000,
      targetDigest: createHash("sha256")
        .update(targets.join("\n"))
        .digest("hex"),
      maxParallel: 1000,
      reportTimeoutSeconds: 60,
      state: "RUNNING",
      createdAt: fixtures.at({ days: -1, seconds: index }),
      completedAt: null,
      sequence: 1,
    };
  });
  const deviceUpdates = devices.map((device, index) => ({
    deviceUpdateId: fixtures.uuid(`perf-update-${index}`),
    campaignId: campaigns[Math.floor(index / 1000)].campaignId,
    deviceId: device.deviceId,
    priorVersion: "1",
    targetVersion: "2",
    state: "DOWNLOADING",
    currentCommandSequence: 1,
    installedDigest: null,
  }));
  const commands = deviceUpdates.map((update, index) => ({
    commandId: fixtures.uuid(`perf-command-${index}`),
    deviceUpdateId: update.deviceUpdateId,
    sequence: 1,
    type: "DOWNLOAD",
    imageDigest: firmwareImages[Math.floor(index / 1000) * 5].sha256,
    commandToken: `token-${hash(fixtures.evaluationSeed, fixtures.caseId, "perf-token", index).toString("hex")}`,
    createdAt: fixtures.at({ hours: -1, milliseconds: index % 1000 }),
    expiresAt: fixtures.at({ hours: 1, milliseconds: index % 1000 }),
  }));
  return {
    seed: {
      schemaVersion: 1,
      seedVersion: "perf-v1",
      deviceModels,
      devices,
      firmwareImages,
      campaigns,
      deviceUpdates,
      commands,
      reports: [],
    },
    assets,
  };
}

export function invalidBundles(fixtures) {
  const base = baseBundle(fixtures);
  const duplicate = structuredClone(base.seed);
  duplicate.seedVersion += "-duplicate";
  duplicate.devices = [duplicate.devices[0], duplicate.devices[0]];
  const missing = structuredClone(base.seed);
  missing.seedVersion += "-missing";
  missing.devices[0].modelId = fixtures.uuid("missing-model");
  const bad = structuredClone(base.seed);
  bad.seedVersion += "-bad-version";
  bad.devices[0].installedVersion = "01";
  return [
    { label: "duplicate-device", seed: duplicate, assets: base.assets },
    { label: "missing-model", seed: missing, assets: base.assets },
    { label: "bad-version", seed: bad, assets: base.assets },
  ];
}
