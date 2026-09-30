import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCapacityClosure, assertDeadlineOutcome, canonical, rankEligibleCouriers,
} from "../lib/oracle.mjs";

test("Courier ranking independently applies eligibility distance load and UUID order", () => {
  const distances = [
    { fromZone: "A", toZone: "A", distanceBucket: 0 },
    { fromZone: "A", toZone: "B", distanceBucket: 2 },
    { fromZone: "B", toZone: "A", distanceBucket: 2 },
    { fromZone: "B", toZone: "B", distanceBucket: 0 },
  ];
  const couriers = [
    { courierId: "00000000-0000-4000-8000-000000000003", homeZone: "B", capacityUnits: 5, activeLoadUnits: 1, eligibleZones: ["A", "B"], state: "AVAILABLE" },
    { courierId: "00000000-0000-4000-8000-000000000002", homeZone: "A", capacityUnits: 5, activeLoadUnits: 2, eligibleZones: ["A", "B"], state: "AVAILABLE" },
    { courierId: "00000000-0000-4000-8000-000000000001", homeZone: "A", capacityUnits: 5, activeLoadUnits: 2, eligibleZones: ["A", "B"], state: "AVAILABLE" },
    { courierId: "00000000-0000-4000-8000-000000000004", homeZone: "A", capacityUnits: 2, activeLoadUnits: 2, eligibleZones: ["A", "B"], state: "AVAILABLE" },
    { courierId: "00000000-0000-4000-8000-000000000005", homeZone: "A", capacityUnits: 9, activeLoadUnits: 0, eligibleZones: ["A"], state: "AVAILABLE" },
  ];
  assert.deepEqual(rankEligibleCouriers({ couriers, zoneDistances: distances, pickupZone: "A", dropoffZone: "B", loadUnits: 1 }).map(({ courierId }) => courierId), [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ]);
});

test("deadline and capacity oracles reject the two critical invariant mutants", () => {
  assert.equal(assertDeadlineOutcome({ now: "2035-01-01T00:00:00.000Z", deliverBy: "2035-01-01T00:00:00.000Z", expiresAt: "2034-12-31T23:59:59.000Z" }), "DELIVERY_STATE_CONFLICT");
  assert.equal(assertDeadlineOutcome({ now: "2035-01-01T00:00:00.000Z", deliverBy: "2035-01-01T00:01:00.000Z", expiresAt: "2035-01-01T00:00:00.000Z" }), "OFFER_EXPIRED");
  assert.doesNotThrow(() => assertCapacityClosure({
    couriers: [{ courierId: "c", capacityUnits: 5, activeLoadUnits: 3 }],
    deliveries: [{ deliveryId: "d", loadUnits: 3, state: "ASSIGNED" }],
    assignments: [{ assignmentId: "a", deliveryId: "d", courierId: "c", loadUnits: 3 }],
    teamAssignments: [],
  }));
  assert.throws(() => assertCapacityClosure({
    couriers: [{ courierId: "c", capacityUnits: 2, activeLoadUnits: 3 }],
    deliveries: [{ deliveryId: "d", loadUnits: 3, state: "ASSIGNED" }],
    assignments: [{ assignmentId: "a", deliveryId: "d", courierId: "c", loadUnits: 3 }],
    teamAssignments: [],
  }), /capacity/iu);
  assert.equal(canonical({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
