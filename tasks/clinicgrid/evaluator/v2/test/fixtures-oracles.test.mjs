import assert from "node:assert/strict";
import test from "node:test";

import {
  appointmentRequest,
  baseSeed,
  createFixtureFactory,
  performanceContract,
  performanceSeed,
  planWorkedExample,
} from "../fixtures/index.mjs";
import {
  assertCalendarExclusivity,
  assertCompleteBundles,
  canonicalJson,
  interval,
  overlaps,
  percentile,
  planAggregate,
  selectResources,
  sortWaitlist,
  terminatePlan,
} from "../oracles/index.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "clinicgrid-fixtures", caseId: "SLOT-01", baseTime: "2035-06-01T12:00:00.000Z" });

test("fixtures freeze deterministic UUID, time, key and exact V1 seed members", () => {
  assert.equal(fixtures.uuid("patient"), fixtures.uuid("patient"));
  assert.notEqual(fixtures.uuid("patient"), fixtures.uuid("room"));
  assert.equal(fixtures.at({ minutes: 15 }), "2035-06-01T12:15:00.000Z");
  assert.match(fixtures.key("hold"), /^cg-slot-01-hold-[a-f0-9]{18}$/u);
  assert.deepEqual(Object.keys(baseSeed(fixtures)), ["schemaVersion", "seedVersion", "clinicians", "rooms", "equipmentUnits", "serviceTypes", "patients", "appointments", "waitlistEntries"]);
});

test("half-open interval oracle accepts adjacency and rejects overlap or misalignment", () => {
  const first = interval(fixtures.at(), 30);
  const adjacent = interval(first.endAt, 15);
  assert.equal(overlaps(first, adjacent), false);
  assert.equal(overlaps(first, { startAt: fixtures.at({ minutes: 15 }), endAt: fixtures.at({ minutes: 45 }) }), true);
  assert.throws(() => interval(fixtures.at({ milliseconds: 1 }), 30), /aligned/u);
  assert.throws(() => interval(fixtures.at(), 14), /invalid/u);
});

test("resource oracle selects requested Clinician and priority then identifier complete bundle", () => {
  const seed = baseSeed(fixtures);
  const request = appointmentRequest(seed, fixtures);
  const selected = selectResources({ seed, request });
  assert.equal(selected.clinicianId, request.clinicianId);
  assert.equal(selected.roomId, seed.rooms.find(({ priority }) => priority === 1).roomId);
  assert.deepEqual(selected.equipmentUnitIds, [
    seed.equipmentUnits.find(({ equipmentType, priority }) => equipmentType === "ECG" && priority === 1).equipmentUnitId,
    seed.equipmentUnits.find(({ equipmentType, priority }) => equipmentType === "MRI" && priority === 1).equipmentUnitId,
  ]);
  assert.equal(selectResources({ seed, request, activeAppointments: [{ ...selected, state: "HELD" }] }), null);
});

test("Care Plan oracle recomputes aggregate and termination fanout", () => {
  const worked = planWorkedExample(fixtures);
  assert.deepEqual(planAggregate(worked.visits), { state: "PARTIALLY_CONFIRMED", expiresAt: worked.visits[1].appointment.expiresAt });
  const terminalAt = fixtures.at({ minutes: 3 });
  const terminated = terminatePlan(worked.visits, terminalAt);
  assert.deepEqual(terminated.map(({ appointment }) => appointment.state), ["CONFIRMED", "CANCELLED", "CANCELLED"]);
  assert.equal(terminated[0].appointment.terminalAt, null);
  assert.equal(terminated[1].appointment.terminalAt, terminalAt);
  assert.deepEqual(planAggregate(terminated), { state: "TERMINATED", expiresAt: null });
});

test("Waitlist order and canonical evidence are evaluator-owned and deterministic", () => {
  const entries = [
    { waitlistEntryId: "b", priority: 10, joinedAt: fixtures.at({ seconds: 1 }) },
    { waitlistEntryId: "c", priority: 20, joinedAt: fixtures.at() },
    { waitlistEntryId: "a", priority: 10, joinedAt: fixtures.at({ seconds: 1 }) },
  ];
  assert.deepEqual(sortWaitlist(entries).map(({ waitlistEntryId }) => waitlistEntryId), ["c", "a", "b"]);
  assert.equal(canonicalJson({ z: 1, a: [0, -0] }), '{"a":[0,0],"z":1}');
  assert.throws(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1), /safe integers/u);
  assert.equal(percentile([10, 2, 7, 4], 0.95), 10);
});

test("formal fixture has exact cardinalities, valid priority domains, references and calendars", () => {
  const seed = performanceSeed(fixtures);
  const contract = performanceContract();
  assert.deepEqual({
    clinicians: seed.clinicians.length,
    rooms: seed.rooms.length,
    equipmentUnits: seed.equipmentUnits.length,
    serviceTypes: seed.serviceTypes.length,
    patients: seed.patients.length,
    appointments: seed.appointments.length,
    waitlistEntries: seed.waitlistEntries.length,
  }, contract.seed);
  assert.equal(seed.appointments.filter(({ state }) => state === "CONFIRMED").length, 50_000);
  assert.equal(seed.appointments.filter(({ state }) => state === "HELD").length, contract.recovery.dueAppointments);
  assert.equal(seed.waitlistEntries.filter(({ state }) => state === "WAITING").length, contract.recovery.waitingEntries);
  assert.equal(new Set(seed.rooms.map(({ priority }) => priority)).size, seed.rooms.length);
  for (const type of seed.serviceTypes.map((_, index) => `TYPE-${index}`)) {
    const priorities = seed.equipmentUnits.filter(({ equipmentType }) => equipmentType === type).map(({ priority }) => priority);
    assert.equal(new Set(priorities).size, priorities.length);
  }
  assert.doesNotThrow(() => assertCalendarExclusivity(seed.appointments));
  assert.doesNotThrow(() => assertCompleteBundles({ resources: seed }));
});
