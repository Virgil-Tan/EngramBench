import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function canonicalJson(value) { if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value); if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number"); return Object.is(value, -0) ? "0" : JSON.stringify(value); } if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; throw new TypeError("value is not canonical JSON"); }

function scalar(left, right) { if (left === right) return 0; if (left === null) return -1; if (right === null) return 1; if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right; return Buffer.from(String(left)).compare(Buffer.from(String(right))); }
export function compareBy(paths) { return (left, right) => { for (const path of paths) { const result = scalar(left[path], right[path]); if (result) return result; } return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right))); }; }
export function assertSorted(values, paths) { assert.deepEqual(values, [...values].sort(compareBy(paths)), `${paths.join(",")} canonical order`); return true; }

export function liveSeatOwners(snapshot) {
  const owners = new Map(); const holds = new Map(snapshot.resources.holds.map((item) => [item.holdId, item])); const orders = new Map(snapshot.resources.orders.map((item) => [item.orderId, item]));
  const add = (seatId, kind, ownerId) => { const values = owners.get(seatId) ?? []; values.push({ kind, ownerId }); owners.set(seatId, values); };
  for (const item of snapshot.resources.holdSeats) if (["HELD", "CHECKOUT"].includes(holds.get(item.holdId)?.state)) add(item.seatId, "hold", item.holdId);
  for (const item of snapshot.resources.orderSeats) if (["PAYMENT_UNKNOWN", "CONFIRMED"].includes(orders.get(item.orderId)?.state)) add(item.seatId, "order", item.orderId);
  for (const offer of snapshot.resources.seatOffers ?? []) if (offer.state === "ACTIVE") for (const item of offer.items) add(item.seatId, "offer", offer.seatOfferId);
  return owners;
}

export function assertSeatConservation(snapshot) {
  for (const [seatId, owners] of liveSeatOwners(snapshot)) assert.ok(owners.length <= 1, `${seatId} has ${owners.length} live owners`);
  return true;
}

export function assertFrozenTotals(snapshot) {
  const priceById = new Map(snapshot.resources.priceVersions.map((item) => [item.priceVersionId, item]));
  for (const hold of snapshot.resources.holds) { const items = snapshot.resources.holdSeats.filter(({ holdId }) => holdId === hold.holdId); assert.equal(items.reduce((sum, item) => sum + item.unitAmountMinor + item.feeMinor, 0), hold.totalMinor, `${hold.holdId} total`); for (const item of items) assert.ok(priceById.has(item.priceVersionId), `${item.priceVersionId} frozen reference`); }
  for (const order of snapshot.resources.orders) { const items = snapshot.resources.orderSeats.filter(({ orderId }) => orderId === order.orderId); assert.equal(items.reduce((sum, item) => sum + item.unitAmountMinor + item.feeMinor, 0), order.totalMinor, `${order.orderId} total`); for (const item of items) assert.ok(priceById.has(item.priceVersionId), `${item.priceVersionId} order frozen reference`); }
  for (const offer of snapshot.resources.seatOffers ?? []) { assert.equal(offer.items.reduce((sum, item) => sum + item.unitAmountMinor + item.feeMinor, 0), offer.totalMinor, `${offer.seatOfferId} total`); for (const item of offer.items) assert.ok(priceById.has(item.priceVersionId), `${item.priceVersionId} offer frozen reference`); }
  return true;
}

export function contiguousCandidates(seats, seatCount, allowedZoneIds) {
  const allowed = new Set(allowedZoneIds); const grouped = new Map();
  for (const seat of seats.filter(({ zoneId }) => allowed.has(zoneId))) { const key = `${seat.zoneId}\0${seat.row}`; const values = grouped.get(key) ?? []; values.push(seat); grouped.set(key, values); }
  const candidates = [];
  for (const values of grouped.values()) { values.sort((a, b) => a.number - b.number || a.seatId.localeCompare(b.seatId)); for (let index = 0; index <= values.length - seatCount; index += 1) { const selected = values.slice(index, index + seatCount); if (selected.every((item, offset) => item.number === selected[0].number + offset)) candidates.push(selected); } }
  return candidates.sort((left, right) => left[0].zoneId.localeCompare(right[0].zoneId) || left[0].row.localeCompare(right[0].row) || left[0].number - right[0].number);
}

export function selectWaitlistSeats({ seats, activePriceByZone, liveOwnerSeatIds = new Set(), seatCount, allowedZoneIds, maxUnitTotalMinor }) {
  const free = seats.filter(({ seatId }) => !liveOwnerSeatIds.has(seatId));
  return contiguousCandidates(free, seatCount, allowedZoneIds).find((candidate) => candidate.every(({ zoneId }) => { const price = activePriceByZone.get(zoneId); return price && price.unitAmountMinor + price.feeMinor <= maxUnitTotalMinor; })) ?? null;
}

export function assertOfferSelection(snapshot, entry, expectedSeats) {
  const offers = snapshot.resources.seatOffers.filter(({ waitlistEntryId, state }) => waitlistEntryId === entry.waitlistEntryId && state === "ACTIVE"); assert.equal(offers.length, 1, `${entry.waitlistEntryId} active Offer count`); const offer = offers[0]; assert.deepEqual(offer.items.map(({ seatId }) => seatId).sort(), expectedSeats.map(({ seatId }) => seatId).sort(), "deterministic Offer selection"); assert.equal(Date.parse(offer.expiresAt) - Date.parse(offer.createdAt), 120_000, "Offer exact lifetime"); assert.equal(offer.items.length, entry.seatCount, "Offer seat count"); return offer;
}

export function assertPaymentIdentity(snapshot, providerLedger) {
  const identities = new Set(); const transactions = new Set();
  for (const intent of snapshot.resources.paymentIntents) { assert.ok(!identities.has(intent.providerRequestId), `${intent.providerRequestId} duplicate provider identity`); identities.add(intent.providerRequestId); if (intent.providerTransactionId !== null) { assert.ok(!transactions.has(intent.providerTransactionId), `${intent.providerTransactionId} duplicate transaction`); transactions.add(intent.providerTransactionId); } const provider = providerLedger?.get(intent.providerRequestId); if (provider && intent.state === "SUCCEEDED") assert.equal(intent.providerTransactionId, provider.providerTransactionId, `${intent.paymentIntentId} provider transaction`); }
  return true;
}

export function assertEventSequence(events) { const next = new Map(); for (const event of events) { const expected = (next.get(event.aggregateId) ?? 0) + 1; assert.equal(event.sequence, expected, `${event.aggregateId} event sequence`); next.set(event.aggregateId, event.sequence); } return true; }
export function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }
