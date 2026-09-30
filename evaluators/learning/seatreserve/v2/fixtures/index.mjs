import { createHash } from "node:crypto";

function digest(...parts) { return createHash("sha256").update(parts.join("\0")).digest(); }
function uuidFrom(buffer) { const bytes = Buffer.from(buffer.subarray(0, 16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `seatreserve\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `sr-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({ seconds = 0, minutes = 0, hours = 0, days = 0 } = {}) => new Date(Date.parse(baseTime) + (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000).toISOString();

  const tenant = { tenantId: uuid("tenant-a"), name: "SeatReserve Tenant A" };
  const otherTenant = { tenantId: uuid("tenant-b"), name: "SeatReserve Tenant B" };
  const venue = { venueId: uuid("venue-a"), tenantId: tenant.tenantId, name: "Deterministic Hall" };
  const otherVenue = { venueId: uuid("venue-b"), tenantId: otherTenant.tenantId, name: "Isolated Hall" };
  const event = { eventId: uuid("event-a"), tenantId: tenant.tenantId, venueId: venue.venueId, name: "Main Event", startsAt: at({ days: 20 }), state: "ON_SALE", createdAt: at({ days: -1 }) };
  const otherEvent = { eventId: uuid("event-b"), tenantId: otherTenant.tenantId, venueId: otherVenue.venueId, name: "Other Event", startsAt: at({ days: 21 }), state: "ON_SALE", createdAt: at({ days: -1 }) };
  const zoneA = { zoneId: uuid("zone-a"), eventId: event.eventId, name: "A Zone" };
  const zoneB = { zoneId: uuid("zone-b"), eventId: event.eventId, name: "B Zone" };
  const otherZone = { zoneId: uuid("zone-other"), eventId: otherEvent.eventId, name: "Other Zone" };
  const priceA1 = { priceVersionId: uuid("price-a-v1"), zoneId: zoneA.zoneId, version: 1, state: "ACTIVE", unitAmountMinor: 5000, feeMinor: 500, currency: "USD", effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null, createdAt: "2019-12-31T00:00:00.000Z" };
  const priceA2 = { priceVersionId: uuid("price-a-v2"), zoneId: zoneA.zoneId, version: 2, state: "DRAFT", unitAmountMinor: 6500, feeMinor: 650, currency: "USD", effectiveFrom: "2021-01-01T00:00:00.000Z", effectiveTo: null, createdAt: "2020-12-31T00:00:00.000Z" };
  const priceB1 = { priceVersionId: uuid("price-b-v1"), zoneId: zoneB.zoneId, version: 1, state: "ACTIVE", unitAmountMinor: 9000, feeMinor: 900, currency: "USD", effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null, createdAt: "2019-12-31T00:00:00.000Z" };
  const priceOther = { priceVersionId: uuid("price-other-v1"), zoneId: otherZone.zoneId, version: 1, state: "ACTIVE", unitAmountMinor: 4000, feeMinor: 400, currency: "USD", effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null, createdAt: "2019-12-31T00:00:00.000Z" };

  const seat = (zone, row, number, options = {}) => ({ seatId: uuid(`seat:${zone.zoneId}:${row}:${number}`), eventId: zone.eventId, zoneId: zone.zoneId, row, number, accessible: options.accessible ?? false, createdAt: "2019-01-01T00:00:00.000Z" });
  const mainSeats = [
    ...[1, 2, 3, 5, 6, 8, 9, 10, 11, 12].map((number) => seat(zoneA, "A", number, { accessible: number === 1 })),
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((number) => seat(zoneA, "B", number)),
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((number) => seat(zoneB, "A", number)),
  ];
  const isolatedSeats = [1, 2, 3, 4].map((number) => seat(otherZone, "A", number));
  const byPosition = new Map(mainSeats.map((item) => [`${item.zoneId}:${item.row}:${item.number}`, item]));

  function emptySeed(seedVersion, seats = mainSeats) {
    return {
      schemaVersion: 1,
      seedVersion,
      importedAt: "2025-01-01T00:00:00.000Z",
      tenants: [tenant, otherTenant],
      venues: [venue, otherVenue],
      events: [event, otherEvent],
      zones: [zoneA, zoneB, otherZone],
      seats: [...seats, ...isolatedSeats],
      priceVersions: [priceA1, priceA2, priceB1, priceOther],
      holds: [], holdSeats: [], orders: [], orderSeats: [], paymentIntents: [], providerReceipts: [],
    };
  }
  const holdPayload = (label, seats, overrides = {}) => ({ tenantId: tenant.tenantId, eventId: event.eventId, customerRef: `customer-${label}`, seatIds: seats.map((value) => typeof value === "string" ? value : value.seatId).sort(), ttlSeconds: 300, ...overrides });
  const waitlistPayload = (label, overrides = {}) => ({ tenantId: tenant.tenantId, eventId: event.eventId, customerRef: `wait-${label}`, seatCount: 3, allowedZoneIds: [zoneA.zoneId], maxUnitTotalMinor: 6000, expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), ...overrides });

  function contract() { return { fixtureFamily: "SR-F-CONTRACT", tenant, otherTenant, event, otherEvent, zones: { zoneA, zoneB, otherZone }, prices: { priceA1, priceA2, priceB1, priceOther }, seats: mainSeats, byPosition, holdPayload, seed: emptySeed(`${caseId.toLowerCase()}-contract`) }; }
  function payment() { return { ...contract(), fixtureFamily: "SR-F-PAYMENT", seed: emptySeed(`${caseId.toLowerCase()}-payment`), scenarios: ["SUCCEEDED", "FAILED", "TIMEOUT", "CONNECTION_RESET"] }; }
  function waitlist() { return { ...contract(), fixtureFamily: "SR-F-WAITLIST", waitlistPayload, workedExample: { available: [1, 2, 3, 5, 6], requested: 3, selected: [1, 2, 3] }, seed: emptySeed(`${caseId.toLowerCase()}-waitlist`) }; }
  function recovery() { return { ...payment(), fixtureFamily: "SR-F-RECOVERY", waitlistPayload, barriers: ["worker.claimed", "dispatcher.response-received"], seed: emptySeed(`${caseId.toLowerCase()}-recovery`) }; }
  function browser() { return { ...waitlist(), fixtureFamily: "SR-F-BROWSER", seed: emptySeed(`${caseId.toLowerCase()}-browser`) }; }
  function v1Final() { return { ...payment(), fixtureFamily: "SR-F-V1-FINAL", savedReplayKey: key("v1-saved-replay"), seed: emptySeed(`${caseId.toLowerCase()}-v1-final`) }; }
  function performance() { return { ...payment(), fixtureFamily: "SR-F-PERFORMANCE", scenarioIds: ["seat-hold-ingest", "hot-seat-contention", "payment-expiry-recovery"] }; }

  return Object.freeze({ uuid, key, at, contract, payment, waitlist, recovery, browser, v1Final, performance });
}
