import { createHash } from "node:crypto";

import { buildCapacitySlices } from "./oracle.mjs";

const V1_SEED_KEYS = [
  "owners",
  "capacityPools",
  "capacityLeases",
  "admissionEntries",
  "capacitySlices",
];

function hash(seed, ...parts) {
  const digest = createHash("sha256");
  digest.update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function safeLabel(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32) || "value";
}

function offsetMilliseconds(offset = {}) {
  if (typeof offset === "number") return offset;
  return (offset.days ?? 0) * 86_400_000
    + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000
    + (offset.seconds ?? 0) * 1_000
    + (offset.milliseconds ?? 0);
}

/**
 * Creates deterministic hidden inputs. Exact replay requires the runner to
 * freeze all three inputs, including baseTime (normally an observed safe
 * future instant recorded in private evaluation metadata).
 */
export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) {
    throw new TypeError("evaluationSeed, caseId, and baseTime are required");
  }
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO-8601 timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;

  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    at(offset = {}) {
      return new Date(epoch + offsetMilliseconds(offset)).toISOString();
    },
    key(label) {
      return `cl-${safeLabel(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 24)}`;
    },
    seedVersion(label = "seed") {
      return `cl-${safeLabel(caseId)}-${safeLabel(label)}-${hash(namespace, "seed", label).toString("hex").slice(0, 12)}`.slice(0, 64);
    },
  });
}

export function makeEmptySeed(fixtures, seedVersion = fixtures.seedVersion("empty")) {
  return Object.fromEntries([
    ["schemaVersion", 1],
    ["seedVersion", seedVersion],
    ...V1_SEED_KEYS.map((key) => [key, []]),
  ]);
}

/** README worked example: two disjoint 6-unit Leases leave a 4-unit peak margin. */
export function makeCapacityBoundaryFixture(options) {
  const fixtures = createFixtureFactory(options);
  const ownerId = fixtures.uuid("owner");
  const poolId = fixtures.uuid("pool");
  const firstLeaseId = fixtures.uuid("lease-a");
  const secondLeaseId = fixtures.uuid("lease-b");
  const startAt = fixtures.at();
  const middleAt = fixtures.at({ minutes: 10 });
  const endAt = fixtures.at({ minutes: 20 });
  const createdAt = fixtures.at({ hours: -2 });
  const lease = (leaseId, start, end, sequence) => ({
    leaseId,
    poolId,
    ownerId,
    startAt: start,
    endAt: end,
    units: 6,
    priority: 1,
    state: "CONFIRMED",
    holdExpiresAt: null,
    revision: 1,
    createdAt,
    terminalAt: null,
    sequence,
  });
  const seed = {
    ...makeEmptySeed(fixtures, fixtures.seedVersion("capacity-boundaries")),
    owners: [{ ownerId, name: "Hidden Owner" }],
    capacityPools: [{ poolId, name: "Hidden Pool", capacityUnits: 10, revision: 1 }],
    capacityLeases: [
      lease(firstLeaseId, startAt, middleAt, 1),
      lease(secondLeaseId, middleAt, endAt, 1),
    ],
    capacitySlices: [
      {
        poolId, startAt, endAt: middleAt, capacityUnits: 10,
        heldUnits: 0, confirmedUnits: 6, activeUnits: 0, availableUnits: 4,
      },
      {
        poolId, startAt: middleAt, endAt, capacityUnits: 10,
        heldUnits: 0, confirmedUnits: 6, activeUnits: 0, availableUnits: 4,
      },
    ],
  };
  return {
    fixtures,
    ids: { ownerId, poolId, firstLeaseId, secondLeaseId },
    times: { startAt, middleAt, endAt },
    seed,
    candidate: { poolId, startAt, endAt, units: 4 },
  };
}

/** Exact README perf-v1 dataset; generated in memory and imported only via db:seed. */
export function makePerformanceFixture(options) {
  const fixtures = createFixtureFactory(options);
  const owners = Array.from({ length: 1_000 }, (_, index) => ({
    ownerId: fixtures.uuid(`perf-owner-${index}`),
    name: `Performance Owner ${String(index + 1).padStart(4, "0")}`,
  }));
  const capacityPools = Array.from({ length: 200 }, (_, index) => ({
    poolId: fixtures.uuid(`perf-pool-${index}`),
    name: `Performance Pool ${String(index + 1).padStart(3, "0")}`,
    capacityUnits: 1,
    revision: 1,
  })).sort((left, right) => Buffer.from(left.poolId).compare(Buffer.from(right.poolId)));
  const capacityLeases = [];
  const admissionEntries = [];
  const timelineIntervals = new Map();
  const dueLeaseIds = [];
  const waitingEntryIds = [];
  const old = "2000-01-01T00:00:00.000Z";
  const older = "1999-01-01T00:00:00.000Z";

  for (let poolIndex = 0; poolIndex < capacityPools.length; poolIndex += 1) {
    const pool = capacityPools[poolIndex];
    const owner = (ordinal) => owners[(poolIndex * 5 + ordinal) % owners.length].ownerId;
    const stableStart = fixtures.at({ days: 10 });
    const stableEnd = fixtures.at({ days: 10, minutes: 100 });
    timelineIntervals.set(pool.poolId, { from: stableStart, to: stableEnd });

    for (let index = 0; index < 100; index += 1) {
      capacityLeases.push({
        leaseId: fixtures.uuid(`perf-stable-${poolIndex}-${index}`),
        poolId: pool.poolId,
        ownerId: owner(index),
        startAt: fixtures.at({ days: 10, minutes: index }),
        endAt: fixtures.at({ days: 10, minutes: index + 1 }),
        units: 1,
        priority: 0,
        state: "CONFIRMED",
        holdExpiresAt: null,
        revision: 1,
        createdAt: fixtures.at({ days: 9 }),
        terminalAt: null,
        sequence: 1,
      });
    }
    for (let index = 0; index < 50; index += 1) {
      const startAt = fixtures.at({ days: 20, minutes: index * 2 });
      const endAt = fixtures.at({ days: 20, minutes: index * 2 + 1 });
      const leaseId = fixtures.uuid(`perf-due-${poolIndex}-${index}`);
      const admissionEntryId = fixtures.uuid(`perf-waiting-${poolIndex}-${index}`);
      capacityLeases.push({
        leaseId,
        poolId: pool.poolId,
        ownerId: owner(100 + index),
        startAt,
        endAt,
        units: 1,
        priority: 0,
        state: "HELD",
        holdExpiresAt: old,
        revision: 1,
        createdAt: older,
        terminalAt: null,
        sequence: 1,
      });
      admissionEntries.push({
        admissionEntryId,
        poolId: pool.poolId,
        ownerId: owner(150 + index),
        startAt,
        endAt,
        units: 1,
        priority: 0,
        state: "WAITING",
        promotedLeaseId: null,
        requestedAt: new Date(Date.parse(older) + (poolIndex * 50 + index) * 1_000).toISOString(),
        terminalAt: null,
      });
      dueLeaseIds.push(leaseId);
      waitingEntryIds.push(admissionEntryId);
    }
    for (let index = 0; index < 50; index += 1) {
      const startAt = fixtures.at({ days: -20, minutes: index * 2 });
      const endAt = fixtures.at({ days: -20, minutes: index * 2 + 1 });
      capacityLeases.push({
        leaseId: fixtures.uuid(`perf-released-${poolIndex}-${index}`),
        poolId: pool.poolId,
        ownerId: owner(200 + index),
        startAt,
        endAt,
        units: 1,
        priority: 0,
        state: "RELEASED",
        holdExpiresAt: null,
        revision: 2,
        createdAt: fixtures.at({ days: -21 }),
        terminalAt: fixtures.at({ days: -20, minutes: index * 2 + 2 }),
        sequence: 1,
      });
    }
  }
  const capacitySlices = buildCapacitySlices({ pools: capacityPools, leases: capacityLeases });
  if (capacityLeases.length !== 40_000 || admissionEntries.length !== 10_000 || capacitySlices.length !== 60_000) {
    throw new Error("perf-v1 generator count drift");
  }
  return {
    fixtures,
    seed: {
      schemaVersion: 1,
      seedVersion: "perf-v1",
      owners,
      capacityPools,
      capacityLeases,
      admissionEntries,
      capacitySlices,
    },
    timelineIntervals,
    dueLeaseIds,
    waitingEntryIds,
    freshHoldStart: fixtures.at({ days: 30 }),
  };
}

export { V1_SEED_KEYS };
