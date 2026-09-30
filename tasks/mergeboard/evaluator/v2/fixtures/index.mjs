import { createHash } from "node:crypto";

function digest(value) { return createHash("sha256").update(String(value)).digest(); }
function uuidFrom(value) {
  const bytes = digest(value).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `mergeboard\0${evaluationSeed}\0${caseId}`;
  const base = Date.parse(baseTime);
  if (!Number.isFinite(base)) throw new TypeError("baseTime must be an ISO timestamp");
  const sha = (label) => createHash("sha256").update(`${namespace}\0${label}`).digest("hex");
  const uuid = (label) => uuidFrom(`${namespace}\0${label}`);
  const at = ({ seconds = 0, minutes = 0, hours = 0 } = {}) => new Date(base + ((hours * 60 + minutes) * 60 + seconds) * 1_000).toISOString();
  const key = (label) => `mb-${sha(`key:${label}`).slice(0, 40)}`;
  const block = (label, text = label) => ({ blockId: uuid(`block:${label}`), text });
  const documentSeed = (label, initialBlocks = [block(`${label}:a`, "alpha"), block(`${label}:b`, "beta")]) => ({
    documentId: uuid(`document:${label}`),
    title: `MergeBoard ${label}`,
    initialBlocks: structuredClone(initialBlocks),
    createdAt: at({ minutes: -30 }),
  });
  const v1Seed = (label, options = {}) => ({
    schemaVersion: 1,
    seedVersion: `mb-${label}-${sha(`seed:${label}`).slice(0, 12)}`,
    documents: structuredClone(options.documents ?? [documentSeed(label)]),
    changes: structuredClone(options.changes ?? []),
    snapshots: structuredClone(options.snapshots ?? []),
  });
  return Object.freeze({
    evaluationSeed, caseId, baseTime, sha, uuid, at, key, block, documentSeed, v1Seed,
    reviewerIds: Object.freeze(Array.from({ length: 10 }, (_, index) => uuid(`reviewer:${index + 1}`))),
    clientIds: Object.freeze(Array.from({ length: 64 }, (_, index) => uuid(`client:${index + 1}`))),
  });
}

export function workedMergeFixture(fixtures) {
  const documentId = fixtures.uuid("worked:document");
  const a = fixtures.block("worked:a", "a");
  const b = fixtures.block("worked:b", "b");
  const x = fixtures.block("worked:x", "x");
  const baseBlocks = [a, b];
  const sourceOperations = [
    { op: "INSERT_AFTER", afterBlockId: a.blockId, block: x },
    { op: "REPLACE", blockId: b.blockId, expectedText: "b", newText: "b2" },
  ];
  return Object.freeze({
    documentId,
    baseBlocks: structuredClone(baseBlocks),
    sourceOperations: structuredClone(sourceOperations),
    expectedBlocks: [structuredClone(a), structuredClone(x), { ...structuredClone(b), text: "b2" }],
  });
}

export function performanceShape(fixtures) {
  return Object.freeze({
    seedVersion: "perf-v1",
    documents: 10_000,
    changesPerDocument: 100,
    operations: 1_000_000,
    workers: 2,
    changeClients: 64,
    revisionClients: 64,
    sampleDocumentIds: Object.freeze(Array.from({ length: 8 }, (_, index) => fixtures.uuid(`perf:document:${index}`))),
  });
}
