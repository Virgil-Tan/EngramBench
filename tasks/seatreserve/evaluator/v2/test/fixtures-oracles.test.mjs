import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { assertFrozenTotals, assertSeatConservation, contiguousCandidates, selectWaitlistSeats } from "../oracles/index.mjs";

const fixtures = createFixtureFactory({ evaluationSeed: "seatreserve-test", caseId: "A-04", baseTime: "2035-06-01T12:00:00.000Z" });

test("fixtures are deterministic, task-local, and cover every SeatReserve family", () => {
  const again = createFixtureFactory({ evaluationSeed: "seatreserve-test", caseId: "A-04", baseTime: "2035-06-01T12:00:00.000Z" }); assert.equal(fixtures.uuid("seat"), again.uuid("seat")); assert.match(fixtures.key("hold"), /^sr-/u); assert.equal(fixtures.contract().seed.schemaVersion, 1); assert.deepEqual(fixtures.payment().scenarios, ["SUCCEEDED", "FAILED", "TIMEOUT", "CONNECTION_RESET"]); assert.deepEqual(fixtures.waitlist().workedExample, { available: [1, 2, 3, 5, 6], requested: 3, selected: [1, 2, 3] }); assert.deepEqual(fixtures.recovery().barriers, ["worker.claimed", "dispatcher.response-received"]); assert.equal(fixtures.browser().seed.holds.length, 0); assert.equal(fixtures.v1Final().seed.waitlistEntries, undefined); assert.deepEqual(fixtures.performance().scenarioIds, ["seat-hold-ingest", "hot-seat-contention", "payment-expiry-recovery"]);
});

test("contiguous selection oracle follows zone, row, first-number order and never bridges gaps", () => {
  const fixture = fixtures.waitlist(); const active = new Map([[fixture.zones.zoneA.zoneId, fixture.prices.priceA1], [fixture.zones.zoneB.zoneId, fixture.prices.priceB1]]); const candidates = contiguousCandidates(fixture.seats, 3, [fixture.zones.zoneA.zoneId]); assert.deepEqual(candidates[0].map(({ row, number }) => [row, number]), [["A", 1], ["A", 2], ["A", 3]]); assert.ok(!candidates.some((candidate) => candidate.map(({ number }) => number).join(",") === "5,6,8")); const selected = selectWaitlistSeats({ seats: fixture.seats, activePriceByZone: active, liveOwnerSeatIds: new Set(), seatCount: 3, allowedZoneIds: [fixture.zones.zoneA.zoneId], maxUnitTotalMinor: 6000 }); assert.deepEqual(selected.map(({ number }) => number), [1, 2, 3]); assert.equal(selectWaitlistSeats({ seats: fixture.seats, activePriceByZone: active, liveOwnerSeatIds: new Set(), seatCount: 3, allowedZoneIds: [fixture.zones.zoneA.zoneId], maxUnitTotalMinor: 100 }), null);
});

test("ownership and frozen-total oracles close Hold, Order, and Offer ledgers", () => {
  const fixture = fixtures.contract(); const seat = fixture.seats[0]; const holdId = fixtures.uuid("hold"); const snapshot = { resources: { seats: fixture.seed.seats, priceVersions: fixture.seed.priceVersions, holds: [{ holdId, state: "HELD", totalMinor: 5500 }], holdSeats: [{ holdId, seatId: seat.seatId, priceVersionId: fixture.prices.priceA1.priceVersionId, unitAmountMinor: 5000, feeMinor: 500 }], orders: [], orderSeats: [], paymentIntents: [], seatOffers: [] } }; assert.equal(assertSeatConservation(snapshot), true); assert.equal(assertFrozenTotals(snapshot), true); snapshot.resources.seatOffers.push({ seatOfferId: fixtures.uuid("offer"), state: "ACTIVE", totalMinor: 5500, items: [{ seatId: seat.seatId, priceVersionId: fixture.prices.priceA1.priceVersionId, unitAmountMinor: 5000, feeMinor: 500 }] }); assert.throws(() => assertSeatConservation(snapshot), /live owners/u);
});
