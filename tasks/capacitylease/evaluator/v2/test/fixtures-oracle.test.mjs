import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixtureFactory,
  makeCapacityBoundaryFixture,
  makeEmptySeed,
  makePerformanceFixture,
} from "../lib/fixtures.mjs";
import {
  assertCapacityConserved,
  assertCapacitySlices,
  buildCapacitySlices,
  canAdmitCapacity,
} from "../lib/oracle.mjs";

test("fixture factory reproduces UUIDs, keys, and UTC times from frozen inputs", () => {
  const options = {
    evaluationSeed: "evaluation-17",
    caseId: "B-04",
    baseTime: "2035-06-01T12:00:00.000Z",
  };
  const first = createFixtureFactory(options);
  const second = createFixtureFactory(options);

  assert.equal(first.uuid("owner-1"), second.uuid("owner-1"));
  assert.match(first.uuid("owner-1"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(first.uuid("owner-1"), first.uuid("owner-2"));
  assert.equal(first.key("create"), second.key("create"));
  assert.equal(first.at({ minutes: 10 }), "2035-06-01T12:10:00.000Z");
  assert.equal(first.at({ days: -1 }), "2035-05-31T12:00:00.000Z");

  assert.deepEqual(makeEmptySeed(first), {
    schemaVersion: 1,
    seedVersion: first.seedVersion("empty"),
    owners: [],
    capacityPools: [],
    capacityLeases: [],
    admissionEntries: [],
    capacitySlices: [],
  });
});

test("capacity oracle uses peak overlap rather than summing disjoint leases", () => {
  const fixture = makeCapacityBoundaryFixture({
    evaluationSeed: "oracle-worked-example",
    caseId: "A-08",
    baseTime: "2035-06-01T12:00:00.000Z",
  });
  const model = {
    pools: fixture.seed.capacityPools,
    leases: fixture.seed.capacityLeases,
  };

  const slices = buildCapacitySlices(model);
  assert.deepEqual(slices.map(({ confirmedUnits, availableUnits }) => ({ confirmedUnits, availableUnits })), [
    { confirmedUnits: 6, availableUnits: 4 },
    { confirmedUnits: 6, availableUnits: 4 },
  ]);
  assert.equal(canAdmitCapacity(model, fixture.candidate), true);
  assert.equal(canAdmitCapacity(model, { ...fixture.candidate, units: 5 }), false);
  assert.doesNotThrow(() => assertCapacityConserved(model));
  assert.doesNotThrow(() => assertCapacitySlices({ ...model, slices }));
});

test("capacity oracle projects gang members independently and rejects oversubscription", () => {
  const fixtures = createFixtureFactory({
    evaluationSeed: "gang",
    caseId: "B-10",
    baseTime: "2035-06-01T12:00:00.000Z",
  });
  const poolA = fixtures.uuid("pool-a");
  const poolB = fixtures.uuid("pool-b");
  const leaseId = fixtures.uuid("lease");
  const model = {
    pools: [
      { poolId: poolA, capacityUnits: 5 },
      { poolId: poolB, capacityUnits: 3 },
    ],
    leases: [{
      leaseId,
      startAt: fixtures.at(),
      endAt: fixtures.at({ minutes: 30 }),
      state: "HELD",
    }],
    members: [
      { memberId: fixtures.uuid("member-a"), leaseId, poolId: poolA, units: 5 },
      { memberId: fixtures.uuid("member-b"), leaseId, poolId: poolB, units: 4 },
    ],
  };

  assert.throws(() => assertCapacityConserved(model), /exceeds capacity/u);
});

test("slice comparison also rejects a matching but oversubscribed model", () => {
  const fixtures = createFixtureFactory({
    evaluationSeed: "oversubscribed-slices",
    caseId: "E-05",
    baseTime: "2035-06-01T12:00:00.000Z",
  });
  const model = {
    pools: [{ poolId: fixtures.uuid("pool"), capacityUnits: 2 }],
    leases: [{
      leaseId: fixtures.uuid("lease"),
      poolId: fixtures.uuid("pool"),
      units: 3,
      state: "HELD",
      startAt: fixtures.at(),
      endAt: fixtures.at({ minutes: 1 }),
    }],
  };

  assert.throws(
    () => assertCapacitySlices({ ...model, slices: buildCapacitySlices(model) }),
    /exceeds capacity/u,
  );
});

test("perf-v1 fixture freezes the exact published cardinalities", () => {
  const fixture = makePerformanceFixture({
    evaluationSeed: "performance-cardinality",
    caseId: "E-04",
    baseTime: "2035-06-01T12:00:00.000Z",
  });

  assert.equal(fixture.seed.seedVersion, "perf-v1");
  assert.equal(fixture.seed.owners.length, 1_000);
  assert.equal(fixture.seed.capacityPools.length, 200);
  assert.equal(fixture.seed.capacityLeases.length, 40_000);
  assert.equal(fixture.seed.admissionEntries.length, 10_000);
  assert.equal(fixture.seed.capacitySlices.length, 60_000);
  assert.equal(fixture.dueLeaseIds.length, 10_000);
  assert.equal(fixture.waitingEntryIds.length, 10_000);
  assert.equal(fixture.timelineIntervals.size, 200);
});
