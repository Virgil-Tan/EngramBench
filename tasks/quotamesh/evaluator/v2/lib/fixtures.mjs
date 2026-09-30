import { createHash } from "node:crypto";

function digest(seed, label) {
  return createHash("sha256").update(`${seed}\0${label}`).digest("hex");
}
function uuidFrom(hex) {
  const value = `${hex.slice(0, 12)}4${hex.slice(13, 16)}a${hex.slice(17, 20)}${hex.slice(20, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const seed = `${evaluationSeed}\0${caseId}`;
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch))
    throw new TypeError("baseTime must be ISO timestamp");
  return Object.freeze({
    uuid: (label) => uuidFrom(digest(seed, `uuid:${label}`)),
    key: (label) =>
      `qm-${String(label)
        .replace(/[^a-z0-9-]/giu, "-")
        .slice(0, 72)}-${digest(seed, `key:${label}`).slice(0, 24)}`,
    at: ({ milliseconds = 0, seconds = 0 } = {}) =>
      new Date(epoch + milliseconds + seconds * 1000).toISOString(),
    seed,
  });
}

export const DIMENSIONS = Object.freeze([
  { name: "cpuMillis", unit: "millisecond" },
  { name: "memoryMiB", unit: "MiB" },
  { name: "storageMiB", unit: "MiB" },
  { name: "requestsPerSecond", unit: "request/second" },
  { name: "gpuUnits", unit: "unit" },
]);
export function vector(value, dimensions = DIMENSIONS) {
  return Object.fromEntries(
    dimensions.map(({ name }) => [
      name,
      typeof value === "function" ? value(name) : value,
    ]),
  );
}
export function poolFixture(
  fixtures,
  label = "primary",
  capacity = 100,
  dimensions = DIMENSIONS.slice(0, 3),
) {
  return {
    poolId: fixtures.uuid(`pool:${label}`),
    tenantId: fixtures.uuid(`tenant:${label}`),
    name: `Pool ${label}`,
    capacity: vector(capacity, dimensions),
  };
}
export function quotaCatalog(fixtures, options = {}) {
  const dimensions = DIMENSIONS.slice(0, options.dimensionCount ?? 3);
  const pool = poolFixture(
    fixtures,
    "primary",
    options.capacity ?? 100,
    dimensions,
  );
  return Object.freeze({
    dimensions,
    pool,
    tenantId: pool.tenantId,
    ownerId: fixtures.uuid("owner:primary"),
    otherOwnerId: fixtures.uuid("owner:other"),
  });
}
export function reserveBody(catalog, quantities = 1, overrides = {}) {
  return {
    ownerId: catalog.ownerId,
    quantities:
      typeof quantities === "object"
        ? quantities
        : vector(quantities, catalog.dimensions),
    ttlSeconds: 300,
    ...overrides,
  };
}
export function v1Seed(fixtures, seedVersion = "quota-v1", options = {}) {
  const catalog = options.catalog ?? quotaCatalog(fixtures, options);
  return {
    schemaVersion: 1,
    seedVersion,
    dimensions: options.dimensions ?? catalog.dimensions,
    quotaPools: options.quotaPools ?? [catalog.pool],
    commitments: options.commitments ?? [],
    reservations: options.reservations ?? [],
    admissionQueue: options.admissionQueue ?? [],
  };
}
export function seededReservation(
  fixtures,
  catalog,
  label,
  state = "HELD",
  options = {},
) {
  return {
    reservationId: fixtures.uuid(`reservation:${label}`),
    poolId: options.poolId ?? catalog.pool.poolId,
    ownerId: options.ownerId ?? catalog.ownerId,
    quantities: options.quantities ?? vector(1, catalog.dimensions),
    state,
    expiresAt:
      options.expiresAt ??
      fixtures.at({ seconds: options.expiresSeconds ?? 3600 }),
    createdAt:
      options.createdAt ??
      fixtures.at({ seconds: options.createdSeconds ?? 0 }),
    terminalAt:
      options.terminalAt ??
      (state === "HELD"
        ? null
        : fixtures.at({ seconds: options.terminalSeconds ?? 1 })),
    sequence: options.sequence ?? (state === "HELD" ? 1 : 2),
  };
}
export function seededCommitment(
  fixtures,
  reservation,
  label = "primary",
  options = {},
) {
  return {
    commitmentId: fixtures.uuid(`commitment:${label}`),
    reservationId: reservation.reservationId,
    poolId: reservation.poolId,
    ownerId: reservation.ownerId,
    quantities: reservation.quantities,
    committedAt: options.committedAt ?? fixtures.at({ seconds: 1 }),
    releasedAt: null,
  };
}
export function seededAdmission(fixtures, catalog, label, options = {}) {
  return {
    admissionEntryId: fixtures.uuid(`admission:${label}`),
    poolId: catalog.pool.poolId,
    ownerId: options.ownerId ?? catalog.ownerId,
    quantities: options.quantities ?? vector(1, catalog.dimensions),
    priority: options.priority ?? 0,
    state: options.state ?? "WAITING",
    requestedAt: options.requestedAt ?? fixtures.at(),
    reservationId: options.reservationId ?? null,
  };
}
export function hierarchyWorkedExample(fixtures) {
  const dimensions = DIMENSIONS.slice(0, 2);
  return {
    dimensions,
    organizationBody: {
      tenantId: fixtures.uuid("tenant:org"),
      name: "Organization",
      capacity: { cpuMillis: 10, memoryMiB: 20 },
    },
    projectA: {
      name: "Project A",
      allocation: { cpuMillis: 6, memoryMiB: 12 },
    },
    projectB: { name: "Project B", allocation: { cpuMillis: 4, memoryMiB: 8 } },
    committed: { cpuMillis: 4, memoryMiB: 8 },
    rejected: { cpuMillis: 3, memoryMiB: 5 },
    released: { cpuMillis: 2, memoryMiB: 4 },
    accepted: { cpuMillis: 3, memoryMiB: 5 },
  };
}
export function performanceContract(scale = 1) {
  if (!(scale > 0 && scale <= 1)) throw new TypeError("scale must be in (0,1]");
  const duration = (value) => Math.max(1, Math.round(value * scale));
  return Object.freeze({
    read: {
      concurrency: 64,
      warmupSeconds: duration(10),
      measureSeconds: duration(60),
      targetPerSecond: 500,
      p95Ms: 100,
      poolCount: Math.max(10, Math.round(1000 * scale)),
    },
    race: {
      concurrency: 64,
      warmupSeconds: duration(10),
      measureSeconds: duration(60),
      targetPerSecond: 200,
      p95Ms: 400,
      spareRatio: 0.8,
    },
    recovery: {
      concurrency: 2,
      maximumSeconds: scale === 1 ? 60 : Math.max(5, Math.round(60 * scale)),
      dueCount: Math.max(20, Math.round(20000 * scale)),
      admissionCount: Math.max(20, Math.round(20000 * scale)),
    },
    seed: {
      seedVersion: "perf-v1",
      dimensionCount: 5,
      poolCount: Math.max(10, Math.round(1000 * scale)),
      commitmentCount: Math.max(10, Math.round(1000 * scale)),
      reservationCount: Math.max(100, Math.round(100000 * scale)),
      admissionCount: Math.max(20, Math.round(20000 * scale)),
      dueCount: Math.max(20, Math.round(20000 * scale)),
    },
  });
}

export function performanceSeed(fixtures, scale = 1) {
  const spec = performanceContract(scale).seed;
  const dimensions = DIMENSIONS;
  const pools = Array.from({ length: spec.poolCount }, (_, index) =>
    poolFixture(fixtures, `perf-${index}`, 21, dimensions),
  );
  const reservations = [];
  const commitments = [];
  const perPool = Math.floor(spec.reservationCount / spec.poolCount);
  let dueRemaining = spec.dueCount;
  let committedRemaining = spec.commitmentCount;
  for (let poolIndex = 0; poolIndex < pools.length; poolIndex += 1) {
    const catalog = {
      pool: pools[poolIndex],
      dimensions,
      ownerId: fixtures.uuid(`perf-owner:${poolIndex}`),
    };
    const count =
      poolIndex === pools.length - 1
        ? spec.reservationCount - reservations.length
        : perPool;
    const dueHere = Math.min(
      dueRemaining,
      Math.ceil(dueRemaining / (pools.length - poolIndex)),
    );
    const committedHere = Math.min(
      committedRemaining,
      Math.ceil(committedRemaining / (pools.length - poolIndex)),
    );
    for (let index = 0; index < count; index += 1) {
      let state = "RELEASED";
      if (index < dueHere) state = "HELD";
      else if (index < dueHere + committedHere) state = "COMMITTED";
      const reservation = seededReservation(
        fixtures,
        catalog,
        `perf-${poolIndex}-${index}`,
        state,
        {
          quantities: vector(1, dimensions),
          createdAt: fixtures.at({ milliseconds: poolIndex * 1000 + index }),
          expiresAt:
            state === "HELD"
              ? "2000-01-01T00:00:00.000Z"
              : fixtures.at({ seconds: 3600 }),
          terminalAt:
            state === "HELD"
              ? null
              : fixtures.at({ milliseconds: poolIndex * 1000 + index + 1 }),
        },
      );
      reservations.push(reservation);
      if (state === "COMMITTED")
        commitments.push(
          seededCommitment(fixtures, reservation, `perf-${poolIndex}-${index}`),
        );
    }
    dueRemaining -= dueHere;
    committedRemaining -= committedHere;
  }
  const admissionQueue = [];
  for (let index = 0; index < spec.admissionCount; index += 1) {
    const poolIndex = index % pools.length;
    const catalog = {
      pool: pools[poolIndex],
      dimensions,
      ownerId: fixtures.uuid(`perf-admission-owner:${index}`),
    };
    admissionQueue.push(
      seededAdmission(fixtures, catalog, `perf-${index}`, {
        priority: 0,
        requestedAt: fixtures.at({ milliseconds: index }),
        quantities: vector(1, dimensions),
      }),
    );
  }
  return {
    schemaVersion: 1,
    seedVersion: "perf-v1",
    dimensions,
    quotaPools: pools,
    commitments,
    reservations,
    admissionQueue,
  };
}
