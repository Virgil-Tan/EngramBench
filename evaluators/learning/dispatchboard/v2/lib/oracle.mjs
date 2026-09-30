import { createHash } from "node:crypto";

function invariant(condition, message) { if (!condition) throw new Error(message); }
function bytewise(left, right) { return Buffer.from(String(left)).compare(Buffer.from(String(right))); }

export function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    invariant(Number.isFinite(value), "canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  invariant(value && typeof value === "object", "canonical JSON rejects unsupported values");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function digest(value) { return createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex"); }

export function rankEligibleCouriers({ couriers, zoneDistances, pickupZone, dropoffZone, loadUnits, previouslyOffered = [] }) {
  invariant(Number.isSafeInteger(loadUnits) && loadUnits > 0, "loadUnits must be a positive integer");
  const offered = new Set(previouslyOffered);
  const distanceByPair = new Map(zoneDistances.map((item) => [`${item.fromZone}\0${item.toZone}`, item.distanceBucket]));
  return couriers.filter((item) => item.state === "AVAILABLE"
    && item.eligibleZones.includes(pickupZone)
    && item.eligibleZones.includes(dropoffZone)
    && item.capacityUnits - item.activeLoadUnits >= loadUnits
    && !offered.has(item.courierId))
    .map((item) => ({ ...item, distanceBucket: distanceByPair.get(`${item.homeZone}\0${pickupZone}`) }))
    .filter(({ distanceBucket }) => Number.isSafeInteger(distanceBucket))
    .sort((left, right) => left.distanceBucket - right.distanceBucket
      || left.activeLoadUnits - right.activeLoadUnits
      || bytewise(left.courierId, right.courierId));
}

export function assertDeadlineOutcome({ now, deliverBy, expiresAt }) {
  const instant = Date.parse(now);
  const deliveryDeadline = Date.parse(deliverBy);
  const offerDeadline = Date.parse(expiresAt);
  invariant([instant, deliveryDeadline, offerDeadline].every(Number.isFinite), "deadline timestamp is invalid");
  if (instant >= deliveryDeadline) return "DELIVERY_STATE_CONFLICT";
  if (instant >= offerDeadline) return "OFFER_EXPIRED";
  return "ASSIGNED";
}

export function assertOfferRound({ offers, expectedCouriers, round, roleIndex }) {
  const selected = offers.filter((item) => item.round === round && (roleIndex === undefined || item.roleIndex === roleIndex));
  invariant(selected.length <= 5, "Offer Round contains more than five Offers");
  invariant(new Set(selected.map(({ offerId }) => offerId)).size === selected.length, "Offer identity is duplicated");
  invariant(new Set(selected.map(({ notificationId }) => notificationId)).size === selected.length, "notification identity is duplicated");
  invariant(new Set(selected.map(({ courierId }) => courierId)).size === selected.length, "Courier appears twice in one role round");
  invariant(canonical(selected.map(({ rank }) => rank)) === canonical(Array.from({ length: selected.length }, (_, index) => index + 1)), "Offer ranks are not gapless");
  invariant(canonical(selected.map(({ courierId }) => courierId)) === canonical(expectedCouriers.slice(0, 5).map(({ courierId }) => courierId)), "Offer Round does not match independent Courier ranking");
  return true;
}

const LIVE_DELIVERY_STATES = new Set(["ASSIGNED", "PICKED_UP"]);
const LIVE_ROLE_STATES = new Set(["RESERVED", "READY", "PICKED_UP"]);

export function assertCapacityClosure({ couriers, deliveries, assignments, teamAssignments = [] }) {
  const deliveryById = new Map(deliveries.map((item) => [item.deliveryId, item]));
  const expected = new Map(couriers.map((item) => [item.courierId, 0]));
  for (const item of assignments) {
    const target = deliveryById.get(item.deliveryId);
    invariant(target, "Assignment references a missing Delivery");
    if (LIVE_DELIVERY_STATES.has(target.state)) expected.set(item.courierId, (expected.get(item.courierId) ?? 0) + item.loadUnits);
  }
  for (const team of teamAssignments) for (const item of team.assignments) if (LIVE_ROLE_STATES.has(item.state)) {
    const target = deliveryById.get(item.deliveryId);
    invariant(target, "RoleAssignment references a missing Delivery");
    expected.set(item.courierId, (expected.get(item.courierId) ?? 0) + target.loadUnits);
  }
  for (const item of couriers) {
    const load = expected.get(item.courierId) ?? 0;
    invariant(Number.isSafeInteger(load) && load >= 0, "Courier load is not a safe non-negative integer");
    invariant(load <= item.capacityUnits, `Courier ${item.courierId} exceeds capacity`);
    invariant(item.activeLoadUnits === load, `Courier ${item.courierId} active load does not reconcile`);
  }
  return true;
}

export function assertEventSequences(events) {
  const byAggregate = Map.groupBy(events, ({ aggregateId }) => aggregateId);
  for (const own of byAggregate.values()) {
    const ordered = own.toSorted((left, right) => left.sequence - right.sequence || bytewise(left.eventId, right.eventId));
    invariant(canonical(ordered.map(({ sequence }) => sequence)) === canonical(Array.from({ length: ordered.length }, (_, index) => index + 1)), "Domain Event sequence is not contiguous");
    invariant(new Set(ordered.map(({ eventId }) => eventId)).size === ordered.length, "Domain Event identity is duplicated");
  }
  return true;
}

export function expectedNotificationDelaySeconds(attempt) {
  invariant(Number.isSafeInteger(attempt) && attempt > 0, "notification attempt must be positive");
  return Math.min(2 ** (attempt - 1), 8);
}

export function percentile(values, fraction) {
  invariant(Array.isArray(values) && values.length > 0, "percentile requires observations");
  invariant(fraction >= 0 && fraction <= 1, "percentile fraction is invalid");
  const ordered = values.toSorted((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}
