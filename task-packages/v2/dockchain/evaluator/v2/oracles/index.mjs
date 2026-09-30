import { assertPublishedOpenApi, contract } from './openapi.mjs';
import assert from "node:assert/strict";

export function canonicalJson(value) { if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value); if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number"); return Object.is(value, -0) ? "0" : JSON.stringify(value); } if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; throw new TypeError("value is not JSON"); }
function scalar(left, right) { if (left === right) return 0; if (left === null) return -1; if (right === null) return 1; if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right; return Buffer.from(String(left)).compare(Buffer.from(String(right))); }
export function compareBy(paths) { return (left, right) => { for (const path of paths) { const result = scalar(left[path], right[path]); if (result) return result; } return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right))); }; }
export function assertSorted(values, paths) { assert.deepEqual(values, [...values].sort(compareBy(paths)), `${paths.join(",")} canonical order`); return true; }
export function overlaps(left, right) { return Date.parse(left.startAt) < Date.parse(right.endAt) && Date.parse(right.startAt) < Date.parse(left.endAt); }
function covers(availability, interval) { return availability.some((value) => Date.parse(value.startAt) <= Date.parse(interval.startAt) && Date.parse(value.endAt) >= Date.parse(interval.endAt)); }

export function activeReservations(snapshot) {
  const movementsByCall = new Map(); for (const movement of snapshot.resources.portMovements ?? []) { const values = movementsByCall.get(movement.portCallId) ?? []; values.push(movement); movementsByCall.set(movement.portCallId, values); }
  const values = [];
  for (const call of snapshot.resources.portCalls ?? []) {
    const movements = movementsByCall.get(call.portCallId) ?? call.movements ?? [];
    if (movements.length) { for (const movement of movements) if (["HELD", "CLEARED", "IN_SERVICE"].includes(movement.state)) values.push({ ownerId: movement.movementId, ...movement }); continue; }
    if (["HELD", "CLEARED", "IN_SERVICE"].includes(call.state)) values.push({ ownerId: call.portCallId, startAt: call.arrivalAt, endAt: call.departureAt, requiredTugs: call.requiredTugs, containerUnits: call.containerUnits, berthId: call.berthId, tugPoolId: call.tugPoolId, yardWindowId: call.yardWindowId });
  }
  return values;
}

export function assertCapacityConservation(snapshot) {
  const active = activeReservations(snapshot); const berthById = new Map(snapshot.resources.berths.map((item) => [item.berthId, item])); const tugById = new Map(snapshot.resources.tugPools.map((item) => [item.tugPoolId, item])); const yardById = new Map(snapshot.resources.yardWindows.map((item) => [item.yardWindowId, item]));
  for (const reservation of active) { assert.ok(berthById.has(reservation.berthId), `${reservation.ownerId} Berth exists`); assert.ok(tugById.has(reservation.tugPoolId), `${reservation.ownerId} Tug Pool exists`); assert.ok(yardById.has(reservation.yardWindowId), `${reservation.ownerId} Yard Window exists`); assert.ok(Number.isSafeInteger(reservation.requiredTugs) && reservation.requiredTugs > 0, `${reservation.ownerId} Tug quantity`); assert.ok(Number.isSafeInteger(reservation.containerUnits) && reservation.containerUnits > 0, `${reservation.ownerId} Yard quantity`); }
  for (let left = 0; left < active.length; left += 1) for (let right = left + 1; right < active.length; right += 1) if (active[left].berthId === active[right].berthId) assert.ok(!overlaps(active[left], active[right]), `${active[left].berthId} is double-booked`);
  for (const [kind, idKey, quantityKey, resources, capacityKey] of [["Tug", "tugPoolId", "requiredTugs", tugById, "capacity"], ["Yard", "yardWindowId", "containerUnits", yardById, "capacityUnits"]]) {
    for (const [resourceId, resource] of resources) { const reservations = active.filter((item) => item[idKey] === resourceId); const instants = [...new Set(reservations.flatMap((item) => [Date.parse(item.startAt), Date.parse(item.endAt)]))].sort((a, b) => a - b); for (let index = 0; index < instants.length - 1; index += 1) { const instant = instants[index]; const used = reservations.filter((item) => Date.parse(item.startAt) <= instant && Date.parse(item.endAt) > instant).reduce((sum, item) => sum + item[quantityKey], 0); assert.ok(used >= 0 && used <= resource[capacityKey], `${kind} ${resourceId} capacity ${used}/${resource[capacityKey]}`); } }
  }
  return true;
}

function resourceFree(resourceId, idKey, quantityKey, capacity, interval, quantity, reservations) { const points = [...new Set(reservations.filter((item) => item[idKey] === resourceId && overlaps(item, interval)).flatMap((item) => [Date.parse(item.startAt), Date.parse(item.endAt), Date.parse(interval.startAt), Date.parse(interval.endAt)]))].sort((a, b) => a - b); if (!points.length) return quantity <= capacity; for (let index = 0; index < points.length - 1; index += 1) { const instant = points[index]; if (instant < Date.parse(interval.startAt) || instant >= Date.parse(interval.endAt)) continue; const used = reservations.filter((item) => item[idKey] === resourceId && Date.parse(item.startAt) <= instant && Date.parse(item.endAt) > instant).reduce((sum, item) => sum + item[quantityKey], 0); if (used + quantity > capacity) return false; } return true; }
export function selectBundle({ berths, tugPools, yardWindows, vessels, reservations = [] }, request) {
  const vessel = vessels.find(({ vesselId }) => vesselId === request.vesselId); if (!vessel) return null; const interval = { startAt: request.startAt ?? request.arrivalAt, endAt: request.endAt ?? request.departureAt };
  const berth = [...berths].sort(compareBy(["priority", "berthId"])).find((item) => vessel.lengthMeters <= item.maxLengthMeters && covers(item.availability, interval) && !reservations.some((value) => value.berthId === item.berthId && overlaps(value, interval)));
  const tug = [...tugPools].sort(compareBy(["priority", "tugPoolId"])).find((item) => covers(item.availability, interval) && resourceFree(item.tugPoolId, "tugPoolId", "requiredTugs", item.capacity, interval, request.requiredTugs, reservations));
  const yard = [...yardWindows].sort(compareBy(["priority", "yardWindowId"])).find((item) => Date.parse(item.startAt) <= Date.parse(interval.startAt) && Date.parse(item.endAt) >= Date.parse(interval.endAt) && resourceFree(item.yardWindowId, "yardWindowId", "containerUnits", item.capacityUnits, interval, request.containerUnits, reservations));
  return berth && tug && yard ? { berthId: berth.berthId, tugPoolId: tug.tugPoolId, yardWindowId: yard.yardWindowId } : null;
}

export function assertAggregateProjection(call) {
  if (!Array.isArray(call.movements) || call.movements.length !== 2) return true; const arrival = call.movements.find(({ type }) => type === "ARRIVAL"); const departure = call.movements.find(({ type }) => type === "DEPARTURE"); assert.ok(arrival && departure, "linked Call has ARRIVAL and DEPARTURE"); let expected = "HELD"; if (arrival.state === "CANCELLED") expected = "CANCELLED"; else if (arrival.state === "COMPLETED" && departure.state === "COMPLETED") expected = "COMPLETED"; else if (arrival.state === "COMPLETED") expected = "ARRIVED"; else if (arrival.state === "EXPIRED" || departure.state === "EXPIRED") expected = "EXPIRED"; assert.equal(call.state, expected, "published linked aggregate projection"); return true;
}

export function assertEventSequence(events) { const expected = new Map(); for (const event of events) { const next = (expected.get(event.aggregateId) ?? 0) + 1; assert.equal(event.sequence, next, `${event.aggregateId} event sequence`); expected.set(event.aggregateId, next); } return true; }
export function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }

export function dockChainOpenApiRoutes() {
 const result={};for(const operation of contract.operations.filter(item=>item.path.startsWith("/api/"))){const path=operation.path.replace(/\/:([^/]+)/g,"/{$1}");(result[path]??={})[operation.method.toLowerCase()]=[...(operation.successStatuses??[operation.status]),...Object.keys(operation.errors??{})].map(String);}return result;
}
export function assertDockChainOpenApi(document) { return assertPublishedOpenApi(document); }
