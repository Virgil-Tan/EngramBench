import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new TypeError("safe integer required");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  throw new TypeError("outside canonical JSON domain");
}
export function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseVersion(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 64)
    throw new Error("INVALID_VERSION");
  const parts = value.split(".");
  if (
    parts.length < 1 ||
    parts.length > 8 ||
    parts.some(
      (part) =>
        !/^(?:0|[1-9][0-9]*)$/u.test(part) ||
        !Number.isSafeInteger(Number(part)),
    )
  )
    throw new Error("INVALID_VERSION");
  return parts.map(Number);
}
export function canonicalVersion(value) {
  const parts = parseVersion(value);
  while (parts.length > 1 && parts.at(-1) === 0) parts.pop();
  return parts.join(".");
}
export function compareVersions(left, right) {
  const a = parseVersion(left),
    b = parseVersion(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const compared = (a[i] ?? 0) - (b[i] ?? 0);
    if (compared) return Math.sign(compared);
  }
  return 0;
}
export function matchesSelector(device, selector) {
  if (selector?.modelId !== undefined && device.modelId !== selector.modelId)
    return false;
  const labels = selector?.labels ?? {};
  return Object.entries(labels).every(
    ([key, value]) => device.labels?.[key] === value,
  );
}
export function selectedDevices(devices, selector) {
  return devices
    .filter((device) => matchesSelector(device, selector))
    .sort((a, b) => Buffer.from(a.deviceId).compare(Buffer.from(b.deviceId)));
}
export function targetDigest(devices) {
  return createHash("sha256")
    .update(
      devices
        .map(({ deviceId }) => deviceId)
        .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)))
        .join("\n"),
    )
    .digest("hex");
}

function pathCompare(left, right) {
  if (left.length !== right.length) return left.length - right.length;
  const leftVersions = left.map(({ version }) => canonicalVersion(version));
  const rightVersions = right.map(({ version }) => canonicalVersion(version));
  for (let i = 0; i < leftVersions.length; i += 1) {
    const compared = Buffer.from(leftVersions[i]).compare(
      Buffer.from(rightVersions[i]),
    );
    if (compared) return compared;
  }
  for (let i = 0; i < left.length; i += 1) {
    const compared = Buffer.from(left[i].firmwareImageId).compare(
      Buffer.from(right[i].firmwareImageId),
    );
    if (compared) return compared;
  }
  return 0;
}
export function selectUpgradePath(
  sourceVersion,
  targetImage,
  images,
  maxHops = 5,
) {
  const modelImages = images.filter(
    ({ modelId }) => modelId === targetImage.modelId,
  );
  const queue = [{ version: canonicalVersion(sourceVersion), path: [] }];
  const candidates = [];
  while (queue.length) {
    const current = queue.shift();
    if (current.path.length >= maxHops) continue;
    for (const image of modelImages) {
      if (
        !image.compatibleFromVersions.some(
          (version) => compareVersions(version, current.version) === 0,
        )
      )
        continue;
      if (
        current.path.some(
          ({ firmwareImageId }) => firmwareImageId === image.firmwareImageId,
        )
      )
        continue;
      const path = [...current.path, image];
      if (image.firmwareImageId === targetImage.firmwareImageId)
        candidates.push(path);
      else queue.push({ version: canonicalVersion(image.version), path });
    }
  }
  if (!candidates.length) return null;
  return candidates.sort(pathCompare)[0];
}
export function pathDigest(deviceId, sourceVersion, targetVersion, path) {
  return digest({
    deviceId,
    sourceVersion: canonicalVersion(sourceVersion),
    targetVersion: canonicalVersion(targetVersion),
    imageIds: path.map(({ firmwareImageId }) => firmwareImageId),
  });
}
export function assertPlan(plan, device, path) {
  if (plan.deviceUpdateId !== device.deviceUpdateId)
    throw new Error("plan/update mismatch");
  if (
    plan.pathDigest !==
    pathDigest(device.deviceId, plan.sourceVersion, plan.targetVersion, path)
  )
    throw new Error("pathDigest mismatch");
  if (plan.hops.length !== path.length) throw new Error("hop count mismatch");
  for (const [index, hop] of plan.hops.entries()) {
    if (
      hop.hopIndex !== index ||
      hop.firmwareImageId !== path[index].firmwareImageId ||
      compareVersions(hop.toVersion, path[index].version) !== 0
    )
      throw new Error("hop identity mismatch");
  }
  return true;
}
export function assertFleetInvariants(snapshot) {
  const resources = snapshot?.resources ?? snapshot;
  for (const key of [
    "deviceModels",
    "devices",
    "firmwareImages",
    "firmwareCampaigns",
    "deviceUpdates",
    "deviceCommands",
    "deviceReports",
  ])
    if (!Array.isArray(resources?.[key])) throw new Error(`missing ${key}`);
  const active = resources.deviceUpdates.filter(
    ({ state }) =>
      !["SUCCEEDED", "FAILED", "ROLLED_BACK", "CANCELLED"].includes(state),
  );
  const devices = new Set();
  for (const update of active) {
    if (devices.has(update.deviceId))
      throw new Error("double active Device Update");
    devices.add(update.deviceId);
  }
  const commandKeys = new Set();
  for (const command of resources.deviceCommands) {
    const key = `${command.deviceUpdateId}:${command.sequence}`;
    if (commandKeys.has(key)) throw new Error("duplicate Command sequence");
    commandKeys.add(key);
  }
  const reportKeys = new Set();
  for (const report of resources.deviceReports) {
    const key = `${report.deviceId}:${report.sequence}`;
    if (reportKeys.has(key)) throw new Error("duplicate Device Report");
    reportKeys.add(key);
  }
  for (const device of resources.devices) {
    const reports = resources.deviceReports
      .filter(({ deviceId }) => deviceId === device.deviceId)
      .sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < reports.length; i += 1)
      if (reports[i].sequence !== i + 1) throw new Error("report sequence gap");
    if (reports.length && device.lastReportSequence !== reports.at(-1).sequence)
      throw new Error("lastReportSequence mismatch");
  }
  return true;
}
export function assertNoSecrets(value, path = "snapshot") {
  if (Array.isArray(value))
    return value.forEach((entry, index) =>
      assertNoSecrets(entry, `${path}[${index}]`),
    );
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (
      /Token$/u.test(key) ||
      /^(?:idempotencyKey|rawWebhook|privatePath|secret)$/iu.test(key)
    )
      throw new Error(`${path}.${key} leaks secret`);
    assertNoSecrets(entry, `${path}.${key}`);
  }
}
export function percentile(samples, quantile) {
  if (!samples.length) return Infinity;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[
    Math.min(
      ordered.length - 1,
      Math.max(0, Math.ceil(quantile * ordered.length) - 1),
    )
  ];
}
