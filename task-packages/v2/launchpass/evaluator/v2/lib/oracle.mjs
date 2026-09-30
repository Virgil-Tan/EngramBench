import assert from "node:assert/strict";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function assertExactKeys(value, keys, label = "object") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} must have an exact closed shape`);
}

export function assertUtc(value, label = "timestamp") {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(Number.isFinite(Date.parse(value)), `${label} must parse`);
  assert.match(value, /Z$/u, `${label} must be UTC`);
}

export function assertError(response, status, code) {
  assert.equal(response.status, status);
  assertExactKeys(response.json, ["error"], "error envelope");
  assertExactKeys(response.json.error, ["code", "message", "details"], "error");
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(Array.isArray(response.json.error.details));
  assert.doesNotMatch(response.text, /postgres(?:ql)?:\/\/|select\s|insert\s|\/Users\/|\/workspace\/|admin[_-]?token/iu);
}

export function assertEvent(value, expected = {}) {
  assertExactKeys(value, ["id", "slug", "title", "startsAt", "capacity", "availableCapacity", "createdAt"], "event");
  assert.match(value.id, UUID);
  assertUtc(value.startsAt, "event.startsAt");
  assertUtc(value.createdAt, "event.createdAt");
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `event.${key}`);
  assert.ok(Number.isInteger(value.capacity) && Number.isInteger(value.availableCapacity));
  assert.ok(value.availableCapacity >= 0 && value.availableCapacity <= value.capacity);
}

export function assertHold(value, expected = {}) {
  assertExactKeys(value, ["id", "eventId", "customerId", "quantity", "status", "expiresAt", "createdAt"], "hold");
  assert.match(value.id, UUID);
  assert.match(value.eventId, UUID);
  assert.match(value.customerId, UUID);
  assertUtc(value.expiresAt, "hold.expiresAt");
  assertUtc(value.createdAt, "hold.createdAt");
  assert.ok(["PENDING", "CONFIRMED", "RELEASED", "EXPIRED"].includes(value.status));
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `hold.${key}`);
}

export function assertOrder(value, expected = {}) {
  assertExactKeys(value, ["id", "eventId", "customerId", "holdId", "quantity", "confirmedAt"], "order");
  assert.match(value.id, UUID);
  assertUtc(value.confirmedAt, "order.confirmedAt");
  if (value.holdId !== null) assert.match(value.holdId, UUID);
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `order.${key}`);
}

export function assertWaitlistEntry(value, expected = {}) {
  assertExactKeys(value, ["id", "eventId", "customerId", "quantity", "status", "position", "joinedAt", "holdId"], "waitlistEntry");
  assert.match(value.id, UUID);
  assertUtc(value.joinedAt, "waitlistEntry.joinedAt");
  assert.ok(["WAITING", "WITHDRAWN", "PROMOTED"].includes(value.status));
  if (value.status === "WAITING") {
    assert.ok(Number.isInteger(value.position) && value.position >= 1);
    assert.equal(value.holdId, null);
  } else {
    assert.equal(value.position, null);
    if (value.status === "PROMOTED") assert.match(value.holdId, UUID);
  }
  for (const [key, expectedValue] of Object.entries(expected)) assert.deepEqual(value[key], expectedValue, `waitlistEntry.${key}`);
}

export function assertPage(response, itemAssertion = () => {}) {
  assert.equal(response.status, 200);
  assertExactKeys(response.json, ["items", "nextCursor"], "page");
  assert.ok(Array.isArray(response.json.items));
  assert.ok(response.json.nextCursor === null || (typeof response.json.nextCursor === "string" && response.json.nextCursor.length > 0));
  response.json.items.forEach(itemAssertion);
}

export function eventComparator(left, right) {
  return left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id);
}

export function descendingComparator(timeField) {
  return (left, right) => right[timeField].localeCompare(left[timeField]) || right.id.localeCompare(left.id);
}

export function waitlistComparator(left, right) {
  return left.joinedAt.localeCompare(right.joinedAt) || left.id.localeCompare(right.id);
}

export function assertLedger(event, { capacity = event.capacity, pending = 0, confirmed = 0 }) {
  assertEvent(event, { capacity, availableCapacity: capacity - pending - confirmed });
  assert.ok(capacity - pending - confirmed >= 0, "capacity ledger must not be negative");
  assert.equal(capacity, event.availableCapacity + pending + confirmed);
}

export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}
