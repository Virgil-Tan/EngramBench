function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function validateJson(value, depth = 0) {
  if (depth > 32) throw new TypeError("JSON depth exceeds 32");
  if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(value))) throw new TypeError("JSON number must be a finite safe integer");
  if (Array.isArray(value)) {
    if (value.length > 1_000) throw new TypeError("JSON array exceeds 1000 entries");
    value.forEach((entry) => validateJson(entry, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    if (!plainObject(value)) throw new TypeError("dangerous object prototype");
    for (const [key, entry] of Object.entries(value)) {
      if (key.startsWith("$") || ["__proto__", "prototype", "constructor"].includes(key)) throw new TypeError("dangerous JSON key");
      validateJson(entry, depth + 1);
    }
  }
}

export function canonicalJson(value) {
  validateJson(value);
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "0" : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function applyMergePatch(target, patch) {
  validateJson(patch);
  if (!plainObject(patch)) return structuredClone(patch);
  const result = plainObject(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = plainObject(value) ? applyMergePatch(result[key], value) : structuredClone(value);
  }
  validateJson(result);
  if (Buffer.byteLength(canonicalJson(result)) > 65_536) throw new TypeError("merged shadow exceeds 64 KiB");
  return result;
}

export function projectReceipts({ shadow, command, receipts }) {
  const result = { shadow: structuredClone(shadow), command: structuredClone(command), receipts: [], applied: [], stale: [] };
  const receiptIds = new Map();
  const sequences = new Map();
  for (const receipt of receipts) {
    const canonical = canonicalJson(receipt);
    const sequenceKey = `${receipt.tenantId}\0${receipt.deviceId}\0${receipt.deviceSequence}`;
    if (receiptIds.has(receipt.receiptId) && receiptIds.get(receipt.receiptId) !== canonical) throw new Error("RECEIPT_CONFLICT");
    if (sequences.has(sequenceKey) && sequences.get(sequenceKey) !== canonical) throw new Error("RECEIPT_CONFLICT");
    if (receiptIds.has(receipt.receiptId) || sequences.has(sequenceKey)) continue;
    receiptIds.set(receipt.receiptId, canonical);
    sequences.set(sequenceKey, canonical);
    result.receipts.push(structuredClone(receipt));
    const matches = receipt.deliveryIdentity === command.deliveryIdentity && receipt.commandId === command.commandId;
    if (matches && receipt.reportedBaseVersion === result.shadow.reportedVersion) {
      result.shadow.reported = applyMergePatch(result.shadow.reported, receipt.reportedPatch ?? {});
      result.shadow.reportedVersion += 1;
      if (!["EXPIRED", "CANCELLED"].includes(result.command.state)) result.command.state = receipt.outcome;
      result.applied.push(receipt.receiptId);
    } else result.stale.push(receipt.receiptId);
  }
  return result;
}

export function partitionWaves(waves) {
  if (!Array.isArray(waves) || waves.length === 0) throw new TypeError("waves are required");
  const names = new Set();
  const devices = new Set();
  return waves.map((wave, ordinal) => {
    if (!wave?.name || names.has(wave.name)) throw new Error("wave names must be unique");
    names.add(wave.name);
    if (!Array.isArray(wave.deviceIds) || wave.deviceIds.length === 0) throw new Error("wave must contain a device");
    for (const deviceId of wave.deviceIds) {
      if (devices.has(deviceId)) throw new Error("device may belong to only one wave");
      devices.add(deviceId);
    }
    return Object.freeze({ ...structuredClone(wave), ordinal, deviceIds: Object.freeze([...wave.deviceIds]) });
  });
}

export function percentile(samples, quantile) {
  if (!Array.isArray(samples) || samples.length === 0) return Number.POSITIVE_INFINITY;
  const ordered = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(quantile * ordered.length));
  return ordered[Math.min(rank - 1, ordered.length - 1)];
}

function unique(items, key, label) {
  const values = new Set();
  for (const item of items) {
    const value = key(item);
    if (values.has(value)) throw new Error(`${label} is duplicated`);
    values.add(value);
  }
}

export function assertEdgeInvariants(snapshot) {
  const resources = snapshot?.resources ?? snapshot;
  for (const key of ["tenants", "devices", "deviceShadows", "deviceCommands", "commandReceipts", "firmwareReleases", "upgradeCampaigns", "upgradeTargets"]) {
    if (!Array.isArray(resources?.[key])) throw new Error(`missing EdgeTwin resource ${key}`);
  }
  unique(resources.devices, ({ tenantId, externalRef }) => `${tenantId}\0${externalRef}`, "device externalRef");
  unique(resources.deviceShadows, ({ deviceId }) => deviceId, "device shadow");
  unique(resources.deviceCommands, ({ commandId }) => commandId, "command identity");
  unique(resources.commandReceipts, ({ receiptId }) => receiptId, "receiptId");
  unique(resources.commandReceipts, ({ tenantId, deviceId, deviceSequence }) => `${tenantId}\0${deviceId}\0${deviceSequence}`, "device receipt sequence");
  unique(resources.upgradeTargets, ({ upgradeCampaignId, deviceId }) => `${upgradeCampaignId}\0${deviceId}`, "upgrade target");
  for (const shadow of resources.deviceShadows) {
    if (!Number.isSafeInteger(shadow.desiredVersion) || shadow.desiredVersion < 0 || !Number.isSafeInteger(shadow.reportedVersion) || shadow.reportedVersion < 0) throw new Error("shadow version is invalid");
  }
  const eventSequences = new Map();
  for (const event of snapshot?.events ?? []) {
    const values = eventSequences.get(event.aggregateId) ?? [];
    values.push(event.sequence);
    eventSequences.set(event.aggregateId, values);
  }
  for (const [aggregateId, values] of eventSequences) {
    const actual = [...new Set(values)].sort((a, b) => a - b);
    const expected = Array.from({ length: actual.at(-1) ?? 0 }, (_, index) => index + 1);
    if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`event sequence for ${aggregateId} is not contiguous`);
  }
  return true;
}
