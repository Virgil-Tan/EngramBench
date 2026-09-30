import assert from "node:assert/strict";
import test from "node:test";

import {
  createFixtureFactory,
  eventPageFixture,
  largeSeedFixture,
  waitlistWorkedExample,
} from "../lib/fixtures.mjs";
import {
  assertLedger,
  eventComparator,
  percentile,
  waitlistComparator,
} from "../lib/oracle.mjs";

const options = {
  evaluationSeed: "private-evaluation-17",
  caseId: "B-04",
  baseTime: "2035-06-01T12:00:00.000Z",
};

test("LaunchPass fixture factory freezes UUIDs, keys, times, and integer choices", () => {
  const first = createFixtureFactory(options);
  const second = createFixtureFactory(options);
  assert.equal(first.uuid("event"), second.uuid("event"));
  assert.equal(first.key("mutation"), second.key("mutation"));
  assert.equal(first.at({ seconds: 10 }), "2035-06-01T12:00:10.000Z");
  assert.equal(first.int("quantity", 1, 4), second.int("quantity", 1, 4));
  assert.notEqual(first.uuid("event"), first.uuid("customer"));
});

test("event and waitlist fixtures encode the published ordering worked examples", () => {
  const fixtures = createFixtureFactory(options);
  const events = eventPageFixture(fixtures, 105);
  assert.equal(events.length, 105);
  assert.equal(new Set(events.map(({ id }) => id)).size, 105);
  assert.deepEqual([...events].sort(eventComparator).map(({ id }) => id), [...events].sort(eventComparator).map(({ id }) => id));

  const worked = waitlistWorkedExample(fixtures);
  assert.equal(worked.event.capacity, 4);
  assert.deepEqual(worked.waiters.map(({ displayName }) => displayName), ["Customer head-qty3", "Customer tail-qty1"]);
  const entries = [
    { id: fixtures.uuid("later-id"), joinedAt: fixtures.at() },
    { id: fixtures.uuid("earlier-id"), joinedAt: fixtures.at() },
  ];
  assert.deepEqual([...entries].sort(waitlistComparator).map(({ id }) => id), [...entries].map(({ id }) => id).sort());
});

test("large V1 fixture uses only the literal published seed schema", () => {
  const fixture = largeSeedFixture(createFixtureFactory(options), { eventCount: 10, customerCount: 12, orderCount: 100 });
  assert.deepEqual(Object.keys(fixture.seed), ["schemaVersion", "events", "customers", "orders"]);
  assert.equal(fixture.seed.schemaVersion, 1);
  assert.equal(fixture.events.length, 10);
  assert.equal(fixture.customers.length, 12);
  assert.equal(fixture.orders.length, 100);
  assert.ok(fixture.orders.every((order) => !Object.hasOwn(order, "holdId") && !Object.hasOwn(order, "waitlistEntry")));
});

test("capacity and latency oracles are independent literals", () => {
  assert.doesNotThrow(() => assertLedger({
    id: createFixtureFactory(options).uuid("event"),
    slug: "abc",
    title: "Event",
    startsAt: "2035-07-01T00:00:00.000Z",
    capacity: 4,
    availableCapacity: 1,
    createdAt: "2035-01-01T00:00:00.000Z",
  }, { capacity: 4, pending: 2, confirmed: 1 }));
  assert.throws(() => assertLedger({
    id: createFixtureFactory(options).uuid("event"),
    slug: "abc",
    title: "Event",
    startsAt: "2035-07-01T00:00:00.000Z",
    capacity: 4,
    availableCapacity: -1,
    createdAt: "2035-01-01T00:00:00.000Z",
  }, { capacity: 4, pending: 4, confirmed: 1 }));
  assert.equal(percentile([1, 2, 100, 3, 4], 0.95), 100);
});
