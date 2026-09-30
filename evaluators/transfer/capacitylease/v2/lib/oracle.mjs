import assert from "node:assert/strict";

const CONSUMING_STATES = new Set(["HELD", "CONFIRMED", "ACTIVE"]);
const STATE_FIELD = {
  HELD: "heldUnits",
  CONFIRMED: "confirmedUnits",
  ACTIVE: "activeUnits",
};

export class CapacityOracleError extends Error {
  constructor(message, details = {}, origin) {
    super(message);
    this.name = "CapacityOracleError";
    this.details = details;
    if (origin) this.origin = origin;
  }
}

function compareText(left, right) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function parseInstant(value, label) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new CapacityOracleError(`${label} is not a timestamp`, { value });
  return milliseconds;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new CapacityOracleError(`${label} must be a positive safe integer`, { value });
  return value;
}

function* projections({ leases = [], members = [] }) {
  const externalMembers = new Map();
  for (const member of members) {
    const values = externalMembers.get(member.leaseId) ?? [];
    values.push(member);
    externalMembers.set(member.leaseId, values);
  }

  for (const lease of leases) {
    const start = parseInstant(lease.startAt, `Lease ${lease.leaseId} startAt`);
    const end = parseInstant(lease.endAt, `Lease ${lease.leaseId} endAt`);
    if (start >= end) throw new CapacityOracleError(`Lease ${lease.leaseId} interval is empty or reversed`);
    const leaseMembers = Array.isArray(lease.members) && lease.members.length > 0
      ? lease.members
      : externalMembers.get(lease.leaseId) ?? [];
    const capacityMembers = leaseMembers.length > 0
      ? leaseMembers
      : [{ poolId: lease.poolId, units: lease.units }];

    for (const member of capacityMembers) {
      yield {
        leaseId: lease.leaseId,
        poolId: member.poolId,
        units: positiveInteger(member.units, `Lease ${lease.leaseId} units`),
        state: lease.state,
        start,
        end,
      };
    }
  }
}

/**
 * Independent half-open interval model. It consumes only public Pool, Lease,
 * and GangLeaseMember shapes and never imports Candidate code or storage.
 */
function* capacitySlices({ pools = [], leases = [], members = [] }) {
  const poolMap = new Map();
  for (const pool of pools) {
    if (poolMap.has(pool.poolId)) throw new CapacityOracleError(`duplicate Pool ${pool.poolId}`);
    poolMap.set(pool.poolId, positiveInteger(pool.capacityUnits, `Pool ${pool.poolId} capacityUnits`));
  }
  const grouped = new Map([...poolMap.keys()].map((poolId) => [poolId, []]));
  for (const item of projections({ leases, members })) {
    if (!poolMap.has(item.poolId)) throw new CapacityOracleError(`Lease ${item.leaseId} references unknown Pool ${item.poolId}`);
    grouped.get(item.poolId).push(item);
  }

  for (const [poolId, capacityUnits] of [...poolMap].sort(([left], [right]) => compareText(left, right))) {
    const changes = new Map();
    const at = (instant) => {
      const existing = changes.get(instant);
      if (existing) return existing;
      const created = { heldUnits: 0, confirmedUnits: 0, activeUnits: 0 };
      changes.set(instant, created);
      return created;
    };
    for (const lease of grouped.get(poolId)) {
      const start = at(lease.start);
      const end = at(lease.end);
      if (CONSUMING_STATES.has(lease.state)) {
        start[STATE_FIELD[lease.state]] += lease.units;
        end[STATE_FIELD[lease.state]] -= lease.units;
      }
    }
    const boundaries = [...changes.keys()].sort((left, right) => left - right);
    const units = { heldUnits: 0, confirmedUnits: 0, activeUnits: 0 };
    for (let index = 0; index + 1 < boundaries.length; index += 1) {
      const start = boundaries[index];
      const end = boundaries[index + 1];
      const delta = changes.get(start);
      for (const field of Object.values(STATE_FIELD)) {
        units[field] += delta[field];
      }
      const usedUnits = units.heldUnits + units.confirmedUnits + units.activeUnits;
      yield {
        poolId,
        startAt: new Date(start).toISOString(),
        endAt: new Date(end).toISOString(),
        capacityUnits,
        ...units,
        availableUnits: capacityUnits - usedUnits,
      };
    }
  }
}

export function buildCapacitySlices(model) {
  return [...capacitySlices(model)];
}

function assertSliceConserved(slice) {
  const used = slice.heldUnits + slice.confirmedUnits + slice.activeUnits;
  if (used < 0 || used > slice.capacityUnits || slice.availableUnits !== slice.capacityUnits - used) {
    throw new CapacityOracleError(
      `Pool ${slice.poolId} exceeds capacity in [${slice.startAt}, ${slice.endAt}): ${used}/${slice.capacityUnits}`,
      { slice },
    );
  }
}

export function assertCapacityConserved(model) {
  for (const slice of capacitySlices(model)) assertSliceConserved(slice);
}

export function assertCapacitySlices({ pools = [], leases = [], members = [], slices }) {
  if (!Array.isArray(slices)) throw new CapacityOracleError("published Capacity Slices are not an array", {}, 'candidate');
  let index = 0;
  for (const expected of capacitySlices({ pools, leases, members })) {
    assertSliceConserved(expected);
    const actual = slices[index];
    try {
      assert.deepEqual(actual, expected);
    } catch (cause) {
      throw new CapacityOracleError(
        `published Capacity Slice ${index} does not match the independent interval model`,
        { index, expected, actual, cause }, 'candidate',
      );
    }
    index += 1;
  }
  if (index !== slices.length) {
    throw new CapacityOracleError(
      "published Capacity Slices do not match the independent interval model",
      { expectedLength: index, actualLength: slices.length }, 'candidate',
    );
  }
}

export function canAdmitCapacity(model, request) {
  try {
    const synthetic = {
      leaseId: "oracle-request",
      startAt: request.startAt,
      endAt: request.endAt,
      state: "HELD",
      ...(Array.isArray(request.members)
        ? { members: request.members }
        : { poolId: request.poolId, units: request.units }),
    };
    assertCapacityConserved({ ...model, leases: [...(model.leases ?? []), synthetic] });
    return true;
  } catch (error) {
    if (error instanceof CapacityOracleError) return false;
    throw error;
  }
}

export { CONSUMING_STATES };
