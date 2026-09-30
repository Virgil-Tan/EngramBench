import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function offsetMs(offset = {}) {
  if (typeof offset === "number") return offset;
  return (offset.days ?? 0) * 86_400_000
    + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000
    + (offset.seconds ?? 0) * 1_000
    + (offset.milliseconds ?? 0);
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId, and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    key(label) {
      return `md-${String(label).toLowerCase().replace(/[^a-z0-9]+/gu, "-").slice(0, 40)}-${hash(namespace, "key", label).toString("hex").slice(0, 24)}`;
    },
    bytes(label, size) {
      const chunks = [];
      let ordinal = 0;
      while (chunks.reduce((sum, chunk) => sum + chunk.length, 0) < size) chunks.push(hash(namespace, "bytes", label, ordinal++));
      return Buffer.concat(chunks).subarray(0, size);
    },
    at(offset = {}) { return new Date(epoch + offsetMs(offset)).toISOString(); },
  });
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function uploadFixture(fixtures, label, options = {}) {
  const bytes = options.bytes ?? fixtures.bytes(`upload-${label}`, options.size ?? 20_000);
  const partSize = options.partSize ?? 8_192;
  return Object.freeze({
    tenantId: options.tenantId ?? fixtures.uuid(`tenant-${label}`),
    fileName: options.fileName ?? `${label}.bin`,
    contentType: options.contentType ?? "application/octet-stream",
    bytes,
    expectedSize: bytes.length,
    expectedSha256: sha256(bytes),
    partSize,
  });
}

export function profileFixture(fixtures, label, operation = "COPY", prefix = Buffer.alloc(0), revision = 1) {
  return Object.freeze({
    profileId: fixtures.uuid(`profile-${label}`),
    tenantId: fixtures.uuid(`tenant-${label}`),
    name: `Profile ${label}`,
    revision,
    operation,
    prefixBase64: operation === "PREFIX" ? Buffer.from(prefix).toString("base64") : null,
    maxAttempts: 3,
    createdAt: fixtures.at({ minutes: -10 }),
  });
}

export function seedFixture(fixtures, label = "empty", overrides = {}) {
  return {
    schemaVersion: 1,
    seedVersion: `md-${label}`,
    importedAt: fixtures.at({ hours: -1 }),
    tenants: [], uploadSessions: [], uploadParts: [], blobObjects: [], mediaAssets: [], scanJobs: [], scanResults: [],
    transcodeProfiles: [], transcodeJobs: [], renditions: [], accessGrants: [], cleanupPolicies: [], cleanupRuns: [], cleanupEntries: [],
    mediaAliases: [], publicationRevisions: [],
    ...overrides,
  };
}

export function performanceBoundary(fixtures) {
  return uploadFixture(fixtures, "ten-thousand-parts", { size: 10_000, partSize: 8_192, bytes: fixtures.bytes("ten-thousand-parts", 10_000) });
}
