import { createHash } from "node:crypto";

function digest(seed, ...parts) {
  const hash = createHash("sha256").update(String(seed));
  for (const part of parts) hash.update("\0").update(String(part));
  return hash.digest();
}

function offsetMilliseconds(offset = {}) {
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
      const bytes = digest(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    key(label) {
      const safe = String(label).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40);
      return `iw-${safe}-${digest(namespace, "key", label).toString("hex").slice(0, 24)}`;
    },
    at(offset = {}) {
      return new Date(epoch + offsetMilliseconds(offset)).toISOString();
    },
    int(label, minimum, maximum) {
      if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum < minimum) throw new RangeError("invalid integer range");
      return minimum + (digest(namespace, "int", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

export function tenantSchemaFixture(fixtures, options = {}) {
  const label = options.label ?? "primary";
  const tenantId = options.tenantId ?? fixtures.uuid(`tenant-${label}`);
  const schemaId = options.schemaId ?? fixtures.uuid(`schema-${label}`);
  const datasetKey = options.datasetKey ?? `customers-${label}`;
  const revision = options.revision ?? 1;
  return {
    tenant: { tenantId, name: options.tenantName ?? `Tenant ${label}` },
    schema: { schemaId, tenantId, datasetKey, name: options.schemaName ?? `Customers ${label}` },
    revision: schemaFixture(fixtures, { schemaId, revision, ...options.schemaOverrides }),
  };
}

export function schemaFixture(fixtures, options = {}) {
  return {
    schemaId: options.schemaId ?? fixtures.uuid("schema-primary"),
    revision: options.revision ?? 1,
    externalIdField: options.externalIdField ?? "externalId",
    additionalProperties: options.additionalProperties ?? false,
    fields: options.fields ?? [
      { name: "externalId", type: "string", required: true, maxLength: 64 },
      { name: "email", type: "string", required: true, maxLength: 254 },
      { name: "age", type: "integer", required: false, minimum: 0, maximum: 130 },
    ],
  };
}

export function emptySeed(seedVersion) {
  return {
    schemaVersion: 1,
    seedVersion,
    tenants: [],
    schemas: [],
    schemaRevisions: [],
    imports: [],
    uploadChunks: [],
    validationFindings: [],
    committedRecords: [],
    errorReports: [],
    importBundles: [],
    bundleMembers: [],
  };
}

export function importSeed(fixtures, seedVersion, options = {}) {
  const catalog = options.catalog ?? tenantSchemaFixture(fixtures, options);
  return {
    ...emptySeed(seedVersion),
    tenants: options.tenants ?? [catalog.tenant],
    schemas: options.schemas ?? [catalog.schema],
    schemaRevisions: options.schemaRevisions ?? [catalog.revision],
    imports: options.imports ?? [],
    uploadChunks: options.uploadChunks ?? [],
    validationFindings: options.validationFindings ?? [],
    committedRecords: options.committedRecords ?? [],
    errorReports: options.errorReports ?? [],
    importBundles: options.importBundles ?? [],
    bundleMembers: options.bundleMembers ?? [],
  };
}

export function rowFixture(index, overrides = {}) {
  return {
    externalId: overrides.externalId ?? `customer-${index}`,
    email: overrides.email ?? `customer-${index}@example.test`,
    age: overrides.age ?? 20 + (index % 60),
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !["externalId", "email", "age"].includes(key))),
  };
}

export function ndjsonBytes(rows, options = {}) {
  const separator = options.separator ?? "\n";
  const suffix = options.trailingNewline === false ? "" : separator;
  return Buffer.from(rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join(separator) + suffix);
}

export function validationWorkedExample() {
  const rows = [
    rowFixture(1, { externalId: "X", age: 21 }),
    rowFixture(2, { externalId: "Y", age: "wrong" }),
    rowFixture(3, { externalId: "X", age: 23 }),
  ];
  return { rows, bytes: ndjsonBytes(rows) };
}

export function uploadWorkedExample() {
  const bytes = Buffer.from("abcdefghijkl");
  const ranges = [[8, 12], [0, 4], [4, 8]];
  return {
    bytes,
    pieces: ranges.map(([start, endExclusive], index) => ({
      chunkNumber: index,
      start,
      endExclusive,
      endInclusive: endExclusive - 1,
      body: bytes.subarray(start, endExclusive),
    })),
  };
}

export function splitBytes(bytes, count = 4, order) {
  if (!Buffer.isBuffer(bytes) || !Number.isSafeInteger(count) || count < 1) throw new TypeError("bytes and a positive chunk count are required");
  const width = Math.ceil(bytes.length / count);
  const natural = [];
  for (let start = 0, chunkNumber = 0; start < bytes.length; start += width, chunkNumber += 1) {
    const endExclusive = Math.min(start + width, bytes.length);
    natural.push({ chunkNumber, start, endExclusive, endInclusive: endExclusive - 1, body: bytes.subarray(start, endExclusive) });
  }
  return (order ?? natural.map((_, index) => index)).map((index) => natural[index]);
}

export function importPayload(catalog, bytes, options = {}) {
  return {
    tenantId: catalog.tenant.tenantId,
    datasetKey: catalog.schema.datasetKey,
    schemaRevision: options.schemaRevision ?? catalog.revision.revision,
    commitMode: options.commitMode ?? "VALID_ROWS",
    expectedBytes: bytes.length,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function rowsFixture(count, options = {}) {
  return Array.from({ length: count }, (_, index) => {
    const externalId = `${options.prefix ?? "customer"}-${index}`;
    if (options.invalidEvery && index % options.invalidEvery === 0) return rowFixture(index, { externalId, email: 42 });
    return rowFixture(index, { externalId });
  });
}
