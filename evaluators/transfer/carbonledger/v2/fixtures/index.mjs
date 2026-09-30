import { createHash } from "node:crypto";

const V1_SEED_KEYS = Object.freeze([
  "projects",
  "beneficiaries",
  "creditLots",
  "retirements",
  "certificates",
]);

function digest(seed, ...parts) {
  const hash = createHash("sha256").update(String(seed));
  for (const part of parts) hash.update("\0").update(String(part));
  return hash.digest();
}

function safeLabel(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 30) || "value";
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
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO-8601 timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = digest(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMilliseconds(offset)).toISOString(); },
    key(label) { return `cl-${safeLabel(label)}-${digest(namespace, "key", label).toString("hex").slice(0, 24)}`; },
    seedVersion(label = "seed") { return `cl-${safeLabel(caseId)}-${safeLabel(label)}-${digest(namespace, "seed", label).toString("hex").slice(0, 12)}`.slice(0, 64); },
    hex(label) { return digest(namespace, "hex", label).toString("hex"); },
  });
}

export function makeEmptySeed(fixtures, seedVersion = fixtures.seedVersion("empty")) {
  return Object.fromEntries([
    ["schemaVersion", 1],
    ["seedVersion", seedVersion],
    ...V1_SEED_KEYS.map((key) => [key, []]),
  ]);
}

export function makeLotFixture(options, { lotCount = 24, capacities, priorityTies = true } = {}) {
  const fixtures = createFixtureFactory(options);
  const projectIds = [fixtures.uuid("project-a"), fixtures.uuid("project-b")];
  const beneficiaryId = fixtures.uuid("beneficiary-a");
  const effectiveCapacities = capacities ?? Array.from({ length: lotCount }, (_, index) => (index % 5) + 1);
  if (effectiveCapacities.length !== lotCount) throw new TypeError("capacities length must equal lotCount");
  const projects = projectIds.map((projectId, index) => ({ projectId, name: `Hidden Project ${index + 1}` }));
  const beneficiaries = [{ beneficiaryId, name: "Hidden Beneficiary" }];
  const creditLots = Array.from({ length: lotCount }, (_, index) => {
    const issuedGrams = effectiveCapacities[index];
    return {
      creditLotId: fixtures.uuid(`lot-${index}`),
      projectId: projectIds[index % projectIds.length],
      vintage: 2028 + (index % 3),
      methodology: index % 2 === 0 ? "FOREST" : "DIRECT_AIR_CAPTURE",
      priority: priorityTies ? 100 - Math.floor(index / 4) : 100 - index,
      issuedGrams,
      availableGrams: issuedGrams,
      reservedGrams: 0,
      retiredGrams: 0,
      provenanceDigest: fixtures.hex(`provenance-${index}`),
    };
  });
  const seed = {
    ...makeEmptySeed(fixtures, fixtures.seedVersion("lots")),
    projects,
    beneficiaries,
    creditLots,
  };
  return { fixtures, seed, projects, beneficiaries, creditLots, beneficiaryId, projectIds };
}

export function makeSingleLotFirstFixture(options) {
  const fixture = makeLotFixture(options, { lotCount: 5, capacities: [2, 3, 5, 1, 8], priorityTies: false });
  return { ...fixture, quantityGrams: 5 };
}

export function makeSplitFixture(options, lotCount = 20) {
  const capacities = Array.from({ length: lotCount }, () => 2);
  const fixture = makeLotFixture(options, { lotCount, capacities, priorityTies: true });
  const quantityGrams = capacities.slice(0, Math.min(lotCount, 4)).reduce((sum, value) => sum + value, 0) - 1;
  return { ...fixture, quantityGrams };
}

export { V1_SEED_KEYS };
