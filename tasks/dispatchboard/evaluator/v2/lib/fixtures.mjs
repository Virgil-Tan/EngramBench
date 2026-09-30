import { createHash } from "node:crypto";

export const PERF_COUNTS = Object.freeze({
  zones: 100,
  zoneDistances: 10_000,
  couriers: 10_000,
  customers: 100_000,
  deliveries: 5_200,
  offers: 30_000,
  assignments: 0,
  hotOffers: 1_000,
  dueOffers: 5_000,
});

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 30) || "value";
}

function milliseconds(offset = {}) {
  if (typeof offset === "number") return offset;
  return (offset.days ?? 0) * 86_400_000 + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1_000 + (offset.milliseconds ?? 0);
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId, and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + milliseconds(offset)).toISOString(); },
    key(label) { return `db-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 24)}`; },
    seedVersion(label = "seed") {
      return `db-${slug(caseId)}-${slug(label)}-${hash(namespace, "seed", label).toString("hex").slice(0, 12)}`.slice(0, 64);
    },
  });
}

export function emptySeed(fixtures, label = "empty") {
  return {
    schemaVersion: 1,
    seedVersion: fixtures.seedVersion(label),
    zones: [],
    zoneDistances: [],
    couriers: [],
    customers: [],
    deliveries: [],
    offers: [],
    offerNotifications: [],
    assignments: [],
  };
}

export function zone(label, overrides = {}) {
  return { zoneId: String(label), name: `Zone ${label}`, ...overrides };
}

export function completeZoneDistances(zones, distance = (left, right) => (left === right ? 0 : 1)) {
  return zones.flatMap((from, fromIndex) => zones.map((to, toIndex) => ({
    fromZone: from.zoneId,
    toZone: to.zoneId,
    distanceBucket: distance(fromIndex, toIndex, from, to),
  })));
}

export function courier(fixtures, label, overrides = {}) {
  return {
    courierId: fixtures.uuid(`courier-${label}`),
    homeZone: "NORTH",
    capacityUnits: 100,
    activeLoadUnits: 0,
    eligibleZones: ["NORTH", "SOUTH", "EAST"],
    deliveryUrl: "http://127.0.0.1:4011/offers",
    state: "AVAILABLE",
    ...overrides,
  };
}

export function customer(fixtures, label, overrides = {}) {
  return { customerId: fixtures.uuid(`customer-${label}`), name: `Customer ${label}`, ...overrides };
}

export function delivery(fixtures, label, targetCustomer, overrides = {}) {
  return {
    deliveryId: fixtures.uuid(`delivery-${label}`),
    customerId: targetCustomer.customerId,
    pickupZone: "NORTH",
    dropoffZone: "SOUTH",
    readyAt: fixtures.at({ minutes: 10 }),
    deliverBy: fixtures.at({ minutes: 70 }),
    loadUnits: 5,
    state: "REQUESTED",
    assignmentId: null,
    currentRound: 0,
    createdAt: fixtures.at({ minutes: -1 }),
    terminalAt: null,
    sequence: 1,
    ...overrides,
  };
}

export function offer(fixtures, label, targetDelivery, targetCourier, overrides = {}) {
  const offerId = overrides.offerId ?? fixtures.uuid(`offer-${label}`);
  const notificationId = overrides.notificationId ?? fixtures.uuid(`notification-${label}`);
  return {
    offerId,
    deliveryId: targetDelivery.deliveryId,
    round: 1,
    courierId: targetCourier.courierId,
    rank: 1,
    state: "OPEN",
    createdAt: fixtures.at({ minutes: -1 }),
    expiresAt: fixtures.at({ seconds: 29 }),
    notificationId,
    ...overrides,
  };
}

export function notification(fixtures, label, targetOffer, targetCourier, overrides = {}) {
  const roleIndex = overrides.roleIndex ?? null;
  const role = overrides.role ?? null;
  return {
    notificationId: targetOffer.notificationId,
    offerId: targetOffer.offerId,
    courierId: targetCourier.courierId,
    deliveryUrl: targetCourier.deliveryUrl,
    body: {
      notificationId: targetOffer.notificationId,
      offerId: targetOffer.offerId,
      deliveryId: targetOffer.deliveryId,
      round: targetOffer.round,
      roleIndex,
      role,
      courierId: targetCourier.courierId,
      expiresAt: targetOffer.expiresAt,
    },
    state: "PENDING",
    attemptCount: 0,
    nextAttemptAt: targetOffer.createdAt,
    successfulDeliveryAt: null,
    ...overrides,
  };
}

export function assignment(fixtures, label, targetDelivery, targetOffer, targetCourier, overrides = {}) {
  return {
    assignmentId: fixtures.uuid(`assignment-${label}`),
    deliveryId: targetDelivery.deliveryId,
    courierId: targetCourier.courierId,
    offerId: targetOffer.offerId,
    loadUnits: targetDelivery.loadUnits,
    assignedAt: fixtures.at({ minutes: -1 }),
    pickedUpAt: null,
    completedAt: null,
    ...overrides,
  };
}

export function dispatchSeed(fixtures, label = "dispatch", options = {}) {
  const zones = options.zones ?? [zone("NORTH"), zone("SOUTH"), zone("EAST")];
  const zoneDistances = options.zoneDistances ?? completeZoneDistances(zones, (left, right) => Math.abs(left - right));
  const couriers = options.couriers ?? Array.from({ length: 8 }, (_, index) => courier(fixtures, `${label}-${index}`, {
    homeZone: zones[index % zones.length].zoneId,
    capacityUnits: 20 + index,
    eligibleZones: zones.map(({ zoneId }) => zoneId),
  }));
  const customers = options.customers ?? Array.from({ length: 4 }, (_, index) => customer(fixtures, `${label}-${index}`));
  const seed = {
    ...emptySeed(fixtures, label),
    zones,
    zoneDistances,
    couriers,
    customers,
    deliveries: options.deliveries ?? [],
    offers: options.offers ?? [],
    offerNotifications: options.offerNotifications ?? [],
    assignments: options.assignments ?? [],
  };
  return { seed, zones, zoneDistances, couriers, customers };
}

export function seedFromSnapshot(fixtures, label, snapshot, overrides = {}) {
  const resources = snapshot.resources;
  return {
    ...emptySeed(fixtures, label),
    zones: structuredClone(resources.zones),
    zoneDistances: structuredClone(resources.zoneDistances),
    couriers: structuredClone(resources.couriers),
    customers: structuredClone(resources.customers),
    deliveries: structuredClone(resources.deliveries.filter((item) => !Object.hasOwn(item, "requiredRoles"))),
    offers: structuredClone(resources.offers),
    offerNotifications: structuredClone(resources.offerNotifications),
    assignments: structuredClone(resources.assignments),
    ...overrides,
  };
}

function timestamp(epoch, offsetMs) { return new Date(epoch + offsetMs).toISOString(); }

function perfOffer(fixtures, epoch, targetDelivery, targetCourier, label, { round, rank, state, expiresAt }) {
  const item = offer(fixtures, label, targetDelivery, targetCourier, {
    round,
    rank,
    state,
    createdAt: timestamp(epoch, -120_000),
    expiresAt,
  });
  const itemNotification = notification(fixtures, label, item, targetCourier, {
    state: state === "OPEN" ? "PENDING" : "SUPERSEDED",
    nextAttemptAt: state === "OPEN" ? item.createdAt : null,
  });
  return [item, itemNotification];
}

export function performanceSeed(fixtures, { now = Date.now() } = {}) {
  const zones = Array.from({ length: PERF_COUNTS.zones }, (_, index) => zone(`Z${String(index).padStart(3, "0")}`));
  const zoneDistances = completeZoneDistances(zones, (left, right) => Math.abs(left - right));
  const eligibleZones = [zones[0].zoneId, zones[1].zoneId];
  const couriers = Array.from({ length: PERF_COUNTS.couriers }, (_, index) => courier(fixtures, `perf-${index}`, {
    homeZone: zones[index % zones.length].zoneId,
    capacityUnits: 1_000,
    activeLoadUnits: 0,
    eligibleZones,
    deliveryUrl: "http://127.0.0.1:4011/offers",
  }));
  const zoneIndex = new Map(zones.map((item, index) => [item.zoneId, index]));
  const rankedCouriers = couriers.toSorted((left, right) => Math.abs(zoneIndex.get(left.homeZone)) - Math.abs(zoneIndex.get(right.homeZone))
    || left.activeLoadUnits - right.activeLoadUnits
    || Buffer.from(left.courierId).compare(Buffer.from(right.courierId)));
  const customers = Array.from({ length: PERF_COUNTS.customers }, (_, index) => customer(fixtures, `perf-${index}`));
  const deliveries = [];
  const offers = [];
  const offerNotifications = [];
  const readyAt = timestamp(now, 600_000);
  const deliverBy = timestamp(now, 4_200_000);
  let offerOrdinal = 0;
  const appendOffer = (targetDelivery, targetCourier, round, rank, state, expiresAt) => {
    const label = `perf-${offerOrdinal}`;
    const [item, itemNotification] = perfOffer(fixtures, now, targetDelivery, targetCourier, label, { round, rank, state, expiresAt });
    offers.push(item);
    offerNotifications.push(itemNotification);
    offerOrdinal += 1;
  };
  for (let index = 0; index < 200; index += 1) {
    const item = delivery(fixtures, `perf-hot-${index}`, customers[index], {
      pickupZone: zones[0].zoneId, dropoffZone: zones[1].zoneId, readyAt, deliverBy,
      loadUnits: 1, state: "OFFERING", currentRound: 1, createdAt: timestamp(now, -180_000), sequence: 2,
    });
    deliveries.push(item);
    for (let rank = 1; rank <= 5; rank += 1) appendOffer(item, rankedCouriers[rank - 1], 1, rank, "OPEN", timestamp(now, 600_000));
  }
  for (let index = 0; index < 1_000; index += 1) {
    const customerIndex = 200 + index;
    const item = delivery(fixtures, `perf-due-${index}`, customers[customerIndex], {
      pickupZone: zones[0].zoneId, dropoffZone: zones[1].zoneId, readyAt, deliverBy,
      loadUnits: 1, state: "OFFERING", currentRound: 1, createdAt: timestamp(now, -180_000), sequence: 2,
    });
    deliveries.push(item);
    for (let rank = 1; rank <= 5; rank += 1) appendOffer(item, rankedCouriers[rank - 1], 1, rank, "OPEN", timestamp(now, -10_000));
  }
  for (let index = 0; index < 4_000; index += 1) {
    const customerIndex = 1_200 + index;
    const item = delivery(fixtures, `perf-history-${index}`, customers[customerIndex], {
      pickupZone: zones[0].zoneId, dropoffZone: zones[1].zoneId,
      readyAt: timestamp(now, -7_200_000), deliverBy: timestamp(now, -3_600_000),
      loadUnits: 1, state: "EXPIRED", currentRound: index < 3_200 ? 1 : 2, createdAt: timestamp(now, -10_800_000),
      terminalAt: timestamp(now, -3_600_000), sequence: 4,
    });
    deliveries.push(item);
    for (let rank = 1; rank <= 5; rank += 1) appendOffer(item, rankedCouriers[rank - 1], 1, rank, "EXPIRED", timestamp(now, -7_000_000));
    if (index >= 3_200) for (let rank = 1; rank <= 5; rank += 1) appendOffer(item, rankedCouriers[rank + 4], 2, rank, "EXPIRED", timestamp(now, -6_000_000));
  }
  if (zones.length !== PERF_COUNTS.zones || zoneDistances.length !== PERF_COUNTS.zoneDistances
    || couriers.length !== PERF_COUNTS.couriers || customers.length !== PERF_COUNTS.customers
    || deliveries.length !== PERF_COUNTS.deliveries || offers.length !== PERF_COUNTS.offers
    || offerNotifications.length !== PERF_COUNTS.offers) throw new Error("perf-v1 fixture cardinality drift");
  return {
    schemaVersion: 1,
    seedVersion: "perf-v1",
    zones,
    zoneDistances,
    couriers,
    customers,
    deliveries,
    offers,
    offerNotifications,
    assignments: [],
  };
}
