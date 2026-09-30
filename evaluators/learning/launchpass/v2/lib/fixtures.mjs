import { createHash } from "node:crypto";

function digest(seed, ...parts) {
  const hash = createHash("sha256").update(String(seed));
  for (const part of parts) hash.update("\0").update(String(part));
  return hash.digest();
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
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    uuid(label) {
      const bytes = digest(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    key(label) {
      return `lp-${String(label).toLowerCase().replace(/[^a-z0-9]+/gu, "-").slice(0, 40)}-${digest(namespace, "key", label).toString("hex").slice(0, 24)}`;
    },
    at(offset = {}) {
      return new Date(epoch + offsetMilliseconds(offset)).toISOString();
    },
    int(label, minimum, maximum) {
      if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum < minimum) throw new RangeError("invalid integer range");
      return minimum + (digest(namespace, "int", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

export function eventFixture(fixtures, label, overrides = {}) {
  const id = overrides.id ?? fixtures.uuid(`event-${label}`);
  const safe = String(label).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 42);
  return {
    id,
    slug: overrides.slug ?? `${safe}-${id.slice(0, 8)}`,
    title: overrides.title ?? `Launch ${label}`,
    startsAt: overrides.startsAt ?? fixtures.at({ days: 30 }),
    capacity: overrides.capacity ?? 4,
  };
}

export function customerFixture(fixtures, label) {
  return { id: fixtures.uuid(`customer-${label}`), displayName: `Customer ${label}` };
}

export function seedFixture(events = [], customers = [], orders = []) {
  return { schemaVersion: 1, events, customers, orders };
}

export function eventPageFixture(fixtures, count = 105) {
  return Array.from({ length: count }, (_, index) => eventFixture(fixtures, `page-${String(index).padStart(3, "0")}`, {
    title: index % 7 === 0 ? `MiXeD Launch ${index}` : `Public Event ${index}`,
    startsAt: fixtures.at({ days: 1 + Math.floor(index / 4) }),
    capacity: 1 + (index % 17),
  }));
}

export function waitlistWorkedExample(fixtures) {
  const event = eventFixture(fixtures, "fifo-worked-example", { capacity: 4 });
  return {
    event,
    owners: [customerFixture(fixtures, "owner-a"), customerFixture(fixtures, "owner-b")],
    waiters: [customerFixture(fixtures, "head-qty3"), customerFixture(fixtures, "tail-qty1")],
  };
}

export function largeSeedFixture(fixtures, options = {}) {
  const eventCount = options.eventCount ?? 10_000;
  const customerCount = options.customerCount ?? 10_000;
  const orderCount = options.orderCount ?? 100_000;
  const ordersPerEvent = Math.ceil(orderCount / eventCount);
  const events = Array.from({ length: eventCount }, (_, index) => ({
    id: fixtures.uuid(`large-event-${index}`),
    slug: `perf-launch-${String(index).padStart(5, "0")}`,
    title: `Performance Launch ${index}`,
    startsAt: fixtures.at({ days: 30 + (index % 365), milliseconds: index }),
    capacity: ordersPerEvent + 100,
  }));
  const customers = Array.from({ length: customerCount }, (_, index) => ({
    id: fixtures.uuid(`large-customer-${index}`),
    displayName: `Performance Customer ${index}`,
  }));
  const orders = Array.from({ length: orderCount }, (_, index) => ({
    id: fixtures.uuid(`large-order-${index}`),
    eventId: events[index % eventCount].id,
    customerId: customers[index % customerCount].id,
    quantity: 1,
    confirmedAt: fixtures.at({ days: -1, milliseconds: index }),
  }));
  return { seed: seedFixture(events, customers, orders), events, customers, orders };
}
