import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
export function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(String(a)), Buffer.from(String(b)));
}
export function assertExactKeys(value, keys, label = "object") {
  assert.ok(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be object`,
  );
  assert.deepEqual(
    Object.keys(value).sort(),
    [...keys].sort(),
    `${label} fields differ`,
  );
}
export function assertUuid(value, label = "uuid") {
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    `${label} invalid`,
  );
}
export function assertTimestamp(value, label = "timestamp") {
  assert.match(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    `${label} invalid`,
  );
}
export function assertVector(value, { positive = false, keys } = {}) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  const names = Object.keys(value);
  assert.ok(names.length >= 1 && names.length <= 20);
  if (keys) assert.deepEqual(names.sort(), [...keys].sort());
  for (const [name, quantity] of Object.entries(value)) {
    assert.match(name, /^[a-z][a-zA-Z0-9]{0,31}$/u);
    assert.ok(Number.isSafeInteger(quantity) && quantity >= (positive ? 1 : 0));
  }
}
export function zeroLike(vector) {
  return Object.fromEntries(Object.keys(vector).map((key) => [key, 0]));
}
export function addVectors(...vectors) {
  const keys = Object.keys(vectors[0] ?? {});
  return Object.fromEntries(
    keys.map((key) => [
      key,
      vectors.reduce((sum, item) => {
        const value = item[key] ?? 0;
        if (!Number.isSafeInteger(sum + value))
          throw new RangeError("unsafe vector sum");
        return sum + value;
      }, 0),
    ]),
  );
}
export function subtractVectors(left, right) {
  return Object.fromEntries(
    Object.keys(left).map((key) => [key, left[key] - (right[key] ?? 0)]),
  );
}
export function fits(used, capacity) {
  return Object.keys(capacity).every(
    (key) =>
      Number.isSafeInteger(used[key] ?? 0) &&
      (used[key] ?? 0) >= 0 &&
      (used[key] ?? 0) <= capacity[key],
  );
}
export function available(capacity, held, committed) {
  return subtractVectors(subtractVectors(capacity, held), committed);
}
export function assertPool(value, expected = {}) {
  assertExactKeys(
    value,
    ["poolId", "tenantId", "name", "capacity", "held", "committed", "revision"],
    "QuotaPool",
  );
  assertUuid(value.poolId);
  assertUuid(value.tenantId);
  assertVector(value.capacity);
  assertVector(value.held, { keys: Object.keys(value.capacity) });
  assertVector(value.committed, { keys: Object.keys(value.capacity) });
  assert.ok(fits(addVectors(value.held, value.committed), value.capacity));
  assert.ok(Number.isSafeInteger(value.revision));
  for (const [key, wanted] of Object.entries(expected))
    assert.deepEqual(value[key], wanted);
}
const RES_V1 = [
  "reservationId",
  "poolId",
  "ownerId",
  "quantities",
  "state",
  "expiresAt",
  "createdAt",
  "terminalAt",
  "sequence",
];
const COMMIT_V1 = [
  "commitmentId",
  "reservationId",
  "poolId",
  "ownerId",
  "quantities",
  "committedAt",
  "releasedAt",
];
const ADMIT_V1 = [
  "admissionEntryId",
  "poolId",
  "ownerId",
  "quantities",
  "priority",
  "state",
  "requestedAt",
  "reservationId",
  "position",
];
export function assertReservation(value, { final = true, expected = {} } = {}) {
  assertExactKeys(
    value,
    final ? [...RES_V1, "organizationId", "projectId"] : RES_V1,
    "Reservation",
  );
  assertUuid(value.reservationId);
  if (value.poolId !== null) assertUuid(value.poolId);
  if (final) {
    assertUuid(value.organizationId);
    assertUuid(value.projectId);
  }
  assertUuid(value.ownerId);
  assertVector(value.quantities, { positive: true });
  assert.ok(["HELD", "COMMITTED", "RELEASED", "EXPIRED"].includes(value.state));
  assertTimestamp(value.expiresAt);
  assertTimestamp(value.createdAt);
  if (value.terminalAt !== null) assertTimestamp(value.terminalAt);
  assert.ok(Number.isSafeInteger(value.sequence));
  assert.equal(value.state === "HELD", value.terminalAt === null);
  for (const [key, wanted] of Object.entries(expected))
    assert.deepEqual(value[key], wanted);
}
export function assertCommitment(value, { final = true } = {}) {
  assertExactKeys(
    value,
    final ? [...COMMIT_V1, "organizationId", "projectId"] : COMMIT_V1,
    "Commitment",
  );
  for (const key of ["commitmentId", "reservationId", "ownerId"])
    assertUuid(value[key]);
  if (value.poolId !== null) assertUuid(value.poolId);
  if (final) {
    assertUuid(value.organizationId);
    assertUuid(value.projectId);
  }
  assertVector(value.quantities, { positive: true });
  assertTimestamp(value.committedAt);
  if (value.releasedAt !== null) assertTimestamp(value.releasedAt);
}
export function assertAdmission(value, { final = true } = {}) {
  assertExactKeys(
    value,
    final ? [...ADMIT_V1, "organizationId", "projectId"] : ADMIT_V1,
    "AdmissionEntry",
  );
  assertUuid(value.admissionEntryId);
  if (value.poolId !== null) assertUuid(value.poolId);
  if (final) {
    assertUuid(value.organizationId);
    assertUuid(value.projectId);
  }
  assertUuid(value.ownerId);
  assertVector(value.quantities, { positive: true });
  assert.ok(Number.isSafeInteger(value.priority));
  assert.ok(["WAITING", "PROMOTED", "WITHDRAWN"].includes(value.state));
  assertTimestamp(value.requestedAt);
  if (value.reservationId !== null) assertUuid(value.reservationId);
  assert.ok(value.position === null || Number.isSafeInteger(value.position));
}
export function assertOrganization(value) {
  assertExactKeys(
    value,
    [
      "organizationId",
      "tenantId",
      "name",
      "capacity",
      "allocated",
      "held",
      "committed",
      "revision",
    ],
    "QuotaOrganization",
  );
  assertUuid(value.organizationId);
  assertUuid(value.tenantId);
  assertVector(value.capacity);
  for (const key of ["allocated", "held", "committed"])
    assertVector(value[key], { keys: Object.keys(value.capacity) });
  assert.ok(fits(value.allocated, value.capacity));
  assert.ok(fits(addVectors(value.held, value.committed), value.capacity));
  assert.ok(Number.isSafeInteger(value.revision));
}
export function assertProject(value) {
  assertExactKeys(
    value,
    [
      "projectId",
      "organizationId",
      "name",
      "allocation",
      "held",
      "committed",
      "revision",
    ],
    "QuotaProject",
  );
  assertUuid(value.projectId);
  assertUuid(value.organizationId);
  assertVector(value.allocation);
  assertVector(value.held, { keys: Object.keys(value.allocation) });
  assertVector(value.committed, { keys: Object.keys(value.allocation) });
  assert.ok(fits(addVectors(value.held, value.committed), value.allocation));
  assert.ok(Number.isSafeInteger(value.revision));
}
export function assertPublicError(response, status, code) {
  assert.equal(response.status, status);
  assertExactKeys(response.json, ["error"], "error response");
  assertExactKeys(response.json.error, ["code", "message", "details"], "error");
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(
    response.json.error.details &&
      typeof response.json.error.details === "object",
  );
}
export function assertEvent(value) {
  assertExactKeys(
    value,
    [
      "eventId",
      "aggregateId",
      "sequence",
      "type",
      "occurredAt",
      "schemaVersion",
      "payload",
    ],
    "DomainEvent",
  );
  assertUuid(value.eventId);
  assertUuid(value.aggregateId);
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
  assert.ok(
    [
      "reservation.held",
      "reservation.committed",
      "reservation.released",
      "reservation.expired",
      "admission.promoted",
    ].includes(value.type),
  );
  assertTimestamp(value.occurredAt);
  assert.equal(value.schemaVersion, 1);
  assert.deepEqual(value.payload, {});
}
export function assertWork(value) {
  assertExactKeys(
    value,
    [
      "workId",
      "kind",
      "aggregateId",
      "state",
      "terminal",
      "attempt",
      "leaseOwner",
      "leaseExpiresAt",
    ],
    "Work",
  );
  assertUuid(value.workId);
  assertUuid(value.aggregateId);
  assert.ok(["RESERVATION_EXPIRY", "ADMISSION_PROMOTION"].includes(value.kind));
  assert.ok(
    ["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(
      value.state,
    ),
  );
  assert.equal(
    value.terminal,
    ["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state),
  );
  assert.equal(
    value.state === "LEASED",
    value.leaseOwner !== null && value.leaseExpiresAt !== null,
  );
}
export function orderedAdmissions(entries) {
  return [...entries].sort(
    (a, b) =>
      b.priority - a.priority ||
      a.requestedAt.localeCompare(b.requestedAt) ||
      compareUtf8(a.admissionEntryId, b.admissionEntryId),
  );
}
export function percentile(values, fraction) {
  assert.ok(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

export class VectorLedger {
  constructor(pool, ids, now) {
    this.ids = ids;
    this.clock = Date.parse(now);
    this.pool = {
      ...pool,
      held: zeroLike(pool.capacity),
      committed: zeroLike(pool.capacity),
      revision: 0,
    };
    this.reservations = new Map();
    this.commitments = [];
    this.admissions = [];
    this.ordinal = 0;
  }
  id(label) {
    this.ordinal += 1;
    return this.ids(`${label}:${this.ordinal}`);
  }
  time() {
    this.clock += 1;
    return new Date(this.clock).toISOString();
  }
  reserve(ownerId, quantities, ttlSeconds = 300) {
    assertVector(quantities, {
      positive: true,
      keys: Object.keys(this.pool.capacity),
    });
    const next = addVectors(this.pool.held, this.pool.committed, quantities);
    assert.ok(fits(next, this.pool.capacity));
    this.pool.held = addVectors(this.pool.held, quantities);
    this.pool.revision += 1;
    const reservation = {
      reservationId: this.id("reservation"),
      poolId: this.pool.poolId,
      ownerId,
      quantities: { ...quantities },
      state: "HELD",
      expiresAt: new Date(this.clock + ttlSeconds * 1000).toISOString(),
      createdAt: this.time(),
      terminalAt: null,
      sequence: 1,
    };
    this.reservations.set(reservation.reservationId, reservation);
    return structuredClone(reservation);
  }
  terminal(reservationId, state) {
    const item = this.reservations.get(reservationId);
    assert.equal(item.state, "HELD");
    this.pool.held = subtractVectors(this.pool.held, item.quantities);
    if (state === "COMMITTED")
      this.pool.committed = addVectors(this.pool.committed, item.quantities);
    this.pool.revision += 1;
    item.state = state;
    item.terminalAt = this.time();
    item.sequence += 1;
    if (state === "COMMITTED") {
      const commitment = {
        commitmentId: this.id("commitment"),
        reservationId: item.reservationId,
        poolId: item.poolId,
        ownerId: item.ownerId,
        quantities: { ...item.quantities },
        committedAt: item.terminalAt,
        releasedAt: null,
      };
      this.commitments.push(commitment);
      return structuredClone(commitment);
    }
    return structuredClone(item);
  }
  enqueue(ownerId, quantities, priority) {
    const entry = {
      admissionEntryId: this.id("admission"),
      poolId: this.pool.poolId,
      ownerId,
      quantities: { ...quantities },
      priority,
      state: "WAITING",
      requestedAt: this.time(),
      reservationId: null,
      position: null,
    };
    this.admissions.push(entry);
    return structuredClone(entry);
  }
  promoteHead() {
    const waiting = orderedAdmissions(
      this.admissions.filter(({ state }) => state === "WAITING"),
    );
    const head = waiting[0];
    if (!head) return null;
    if (
      !fits(
        addVectors(this.pool.held, this.pool.committed, head.quantities),
        this.pool.capacity,
      )
    )
      return null;
    const reservation = this.reserve(head.ownerId, head.quantities, 300);
    head.state = "PROMOTED";
    head.reservationId = reservation.reservationId;
    return { entry: structuredClone(head), reservation };
  }
}

export class HierarchyLedger {
  constructor(org, projects) {
    this.organization = {
      ...org,
      allocated: projects.reduce(
        (sum, item) => addVectors(sum, item.allocation),
        zeroLike(org.capacity),
      ),
      held: zeroLike(org.capacity),
      committed: zeroLike(org.capacity),
      revision: 0,
    };
    this.projects = new Map(
      projects.map((item) => [
        item.projectId,
        {
          ...item,
          held: zeroLike(item.allocation),
          committed: zeroLike(item.allocation),
          revision: 0,
        },
      ]),
    );
  }
  reserve(projectId, quantities) {
    const project = this.projects.get(projectId);
    assert.ok(
      fits(
        addVectors(project.held, project.committed, quantities),
        project.allocation,
      ),
    );
    assert.ok(
      fits(
        addVectors(
          this.organization.held,
          this.organization.committed,
          quantities,
        ),
        this.organization.capacity,
      ),
    );
    project.held = addVectors(project.held, quantities);
    this.organization.held = addVectors(this.organization.held, quantities);
    project.revision += 1;
    this.organization.revision += 1;
  }
  updateOrganization(capacity, expectedRevision) {
    assert.equal(expectedRevision, this.organization.revision);
    assert.ok(fits(this.organization.allocated, capacity));
    assert.ok(
      fits(
        addVectors(this.organization.held, this.organization.committed),
        capacity,
      ),
    );
    this.organization.capacity = { ...capacity };
    this.organization.revision += 1;
  }
  updateProject(
    projectId,
    allocation,
    expectedOrganizationRevision,
    expectedProjectRevision,
  ) {
    const project = this.projects.get(projectId);
    assert.equal(expectedOrganizationRevision, this.organization.revision);
    assert.equal(expectedProjectRevision, project.revision);
    assert.ok(fits(addVectors(project.held, project.committed), allocation));
    const other = Object.fromEntries(
      Object.keys(allocation).map((key) => [
        key,
        this.organization.allocated[key] - project.allocation[key],
      ]),
    );
    assert.ok(fits(addVectors(other, allocation), this.organization.capacity));
    this.organization.allocated = addVectors(other, allocation);
    project.allocation = { ...allocation };
    this.organization.revision += 1;
    project.revision += 1;
  }
}

export function reconcileSnapshot(snapshot, { final = true } = {}) {
  assertExactKeys(
    snapshot,
    ["asOf", "resources", "work", "events"],
    "snapshot",
  );
  assertTimestamp(snapshot.asOf);
  const keys = final
    ? [
        "dimensions",
        "quotaPools",
        "reservations",
        "commitments",
        "admissionEntries",
        "quotaOrganizations",
        "quotaProjects",
      ]
    : [
        "dimensions",
        "quotaPools",
        "reservations",
        "commitments",
        "admissionEntries",
      ];
  assertExactKeys(snapshot.resources, keys, "resources");
  const dimensions = snapshot.resources.dimensions.map((item) => {
    assertExactKeys(item, ["name", "unit"], "Dimension");
    return item.name;
  });
  snapshot.resources.quotaPools.forEach(assertPool);
  snapshot.resources.reservations.forEach((value) =>
    assertReservation(value, { final }),
  );
  snapshot.resources.commitments.forEach((value) =>
    assertCommitment(value, { final }),
  );
  snapshot.resources.admissionEntries.forEach((value) =>
    assertAdmission(value, { final }),
  );
  snapshot.work.forEach(assertWork);
  snapshot.events.forEach(assertEvent);
  if (final) {
    snapshot.resources.quotaOrganizations.forEach(assertOrganization);
    snapshot.resources.quotaProjects.forEach(assertProject);
    for (const project of snapshot.resources.quotaProjects) {
      const held = snapshot.resources.reservations
        .filter(
          (item) =>
            item.projectId === project.projectId && item.state === "HELD",
        )
        .reduce(
          (sum, item) => addVectors(sum, item.quantities),
          zeroLike(project.allocation),
        );
      const committed = snapshot.resources.commitments
        .filter(
          (item) =>
            item.projectId === project.projectId && item.releasedAt === null,
        )
        .reduce(
          (sum, item) => addVectors(sum, item.quantities),
          zeroLike(project.allocation),
        );
      assert.deepEqual(
        project.held,
        held,
        `Project ${project.projectId} held mismatch`,
      );
      assert.deepEqual(
        project.committed,
        committed,
        `Project ${project.projectId} committed mismatch`,
      );
    }
    for (const org of snapshot.resources.quotaOrganizations) {
      const projects = snapshot.resources.quotaProjects.filter(
        ({ organizationId }) => organizationId === org.organizationId,
      );
      const allocated = projects.reduce(
        (sum, item) => addVectors(sum, item.allocation),
        zeroLike(org.capacity),
      );
      const held = projects.reduce(
        (sum, item) => addVectors(sum, item.held),
        zeroLike(org.capacity),
      );
      const committed = projects.reduce(
        (sum, item) => addVectors(sum, item.committed),
        zeroLike(org.capacity),
      );
      assert.deepEqual(
        org.allocated,
        allocated,
        `Organization ${org.organizationId} allocated mismatch`,
      );
      assert.deepEqual(
        org.held,
        held,
        `Organization ${org.organizationId} held mismatch`,
      );
      assert.deepEqual(
        org.committed,
        committed,
        `Organization ${org.organizationId} committed mismatch`,
      );
    }
  }
  for (const pool of snapshot.resources.quotaPools) {
    const held = snapshot.resources.reservations
      .filter((item) => item.poolId === pool.poolId && item.state === "HELD")
      .reduce(
        (sum, item) => addVectors(sum, item.quantities),
        zeroLike(pool.capacity),
      );
    const committed = snapshot.resources.commitments
      .filter((item) => item.poolId === pool.poolId && item.releasedAt === null)
      .reduce(
        (sum, item) => addVectors(sum, item.quantities),
        zeroLike(pool.capacity),
      );
    assert.deepEqual(pool.held, held);
    assert.deepEqual(pool.committed, committed);
  }
  assert.equal(/"[^"]*Token"\s*:/u.test(JSON.stringify(snapshot)), false);
  return {
    dimensionCount: dimensions.length,
    poolCount: snapshot.resources.quotaPools.length,
  };
}
