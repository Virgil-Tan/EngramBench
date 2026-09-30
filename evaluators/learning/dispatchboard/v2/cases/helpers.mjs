import assert from "node:assert/strict";

import { emptySeed } from "../lib/fixtures.mjs";
import { assertCapacityClosure, assertEventSequences, canonical } from "../lib/oracle.mjs";
import { EvaluationInfrastructureError } from "../lib/runtime.mjs";

export const DELIVERY_KEYS = [
  "assignmentId", "createdAt", "currentRound", "customerId", "deliverBy", "deliveryId", "dropoffZone",
  "loadUnits", "pickupZone", "readyAt", "sequence", "state", "terminalAt",
];
export const TEAM_DELIVERY_KEYS = [...DELIVERY_KEYS, "assignments", "requiredRoles", "teamAssignmentId"];
export const OFFER_KEYS = ["courierId", "createdAt", "deliveryId", "expiresAt", "notificationId", "offerId", "rank", "round", "state"];
export const TEAM_OFFER_KEYS = [...OFFER_KEYS, "role", "roleIndex"];
export const NOTIFICATION_KEYS = [
  "attemptCount", "body", "courierId", "deliveryUrl", "nextAttemptAt", "notificationId", "offerId",
  "state", "successfulDeliveryAt",
];
export const NOTIFICATION_BODY_KEYS = ["courierId", "deliveryId", "expiresAt", "notificationId", "offerId", "role", "roleIndex", "round"];
export const ASSIGNMENT_KEYS = ["assignedAt", "assignmentId", "completedAt", "courierId", "deliveryId", "loadUnits", "offerId", "pickedUpAt"];
export const ROLE_ASSIGNMENT_KEYS = [
  "assignmentId", "claimedAt", "claimExpiresAt", "courierId", "deliveryId", "offerId", "readyAt", "releasedAt", "role", "state",
];
export const TEAM_ASSIGNMENT_KEYS = [
  "activatedAt", "assignments", "completedAt", "deliveryId", "pickedUpAt", "requiredRoles", "revision", "state", "teamAssignmentId",
];
export const COURIER_KEYS = ["activeLoadUnits", "capacityUnits", "courierId", "deliveryUrl", "eligibleZones", "homeZone", "state"];
export const WORK_KEYS = ["aggregateId", "attempt", "kind", "leaseExpiresAt", "leaseOwner", "state", "terminal", "workId"];
export const EVENT_KEYS = ["aggregateId", "eventId", "occurredAt", "payload", "schemaVersion", "sequence", "type"];
export const FINAL_RESOURCE_KEYS = [
  "assignments", "couriers", "customers", "deliveries", "offerNotifications", "offers",
  "teamAssignments", "teamOffers", "zoneDistances", "zones",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const URL = /^https?:\/\/[^\s/@]+(?::\d+)?(?:\/[^#]*)?$/u;
const TERMINAL_WORK = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const EVENT_TYPES = new Set([
  "delivery.requested", "offer.round-opened", "delivery.assigned", "delivery.picked-up",
  "delivery.completed", "delivery.cancelled", "delivery.expired",
]);

function bytewise(left, right) { return Buffer.from(String(left)).compare(Buffer.from(String(right))); }
function scalar(value) {
  if (value === null) return [0, ""];
  if (value === false) return [1, ""];
  if (value === true) return [2, ""];
  if (Number.isSafeInteger(value)) return [3, value];
  return [4, String(value)];
}
function compareScalar(left, right) {
  const a = scalar(left);
  const b = scalar(right);
  return a[0] - b[0] || (typeof a[1] === "number" ? a[1] - b[1] : bytewise(a[1], b[1]));
}
function comparePaths(paths) {
  return (left, right) => {
    for (const path of paths) {
      const value = compareScalar(left[path], right[path]);
      if (value !== 0) return value;
    }
    return bytewise(canonical(left), canonical(right));
  };
}

export function result(evidence, extra = {}) { return { evidence, ...extra }; }
export function diagnostics(items) { return { evidence: [], diagnostics: items }; }
export function guarded(hardCapIds, operation) {
  return Promise.resolve().then(operation).catch((error) => {
    error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
    throw error;
  });
}

export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is not an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has wrong keys`);
}

export function requireStatus(response, expected, label = "request") {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `${label}: expected ${statuses.join("/")}, got ${response.status}: ${response.text}`);
  assert.notEqual(response.json, undefined, `${label}: response is not JSON`);
  return response.json;
}

export function assertExactError(response, status, code) {
  requireStatus(response, status, code);
  exactKeys(response.json, ["error"], "error response");
  exactKeys(response.json.error, ["code", "details", "message"], "error");
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details));
  return response.json.error;
}

function assertNullableTimestamp(value, label) { if (value !== null) assert.match(value, TIMESTAMP, `${label} is not a timestamp or null`); }

export function assertDelivery(value, { team } = {}) {
  const isTeam = team ?? Object.hasOwn(value ?? {}, "requiredRoles");
  exactKeys(value, isTeam ? TEAM_DELIVERY_KEYS : DELIVERY_KEYS, isTeam ? "team Delivery" : "Delivery");
  assert.match(value.deliveryId, UUID);
  assert.match(value.customerId, UUID);
  assert.match(value.readyAt, TIMESTAMP);
  assert.match(value.deliverBy, TIMESTAMP);
  assert.match(value.createdAt, TIMESTAMP);
  assertNullableTimestamp(value.terminalAt, "Delivery terminalAt");
  assert.ok(Number.isSafeInteger(value.loadUnits) && value.loadUnits >= 1 && value.loadUnits <= 100);
  assert.ok(Number.isSafeInteger(value.currentRound) && value.currentRound >= 0);
  assert.ok(Number.isSafeInteger(value.sequence) && value.sequence > 0);
  assert.ok(["REQUESTED", "OFFERING", "ASSIGNED", "PICKED_UP", "DELIVERED", "CANCELLED", "EXPIRED"].includes(value.state));
  if (isTeam) {
    assert.equal(value.assignmentId, null);
    assert.ok(Array.isArray(value.requiredRoles) && value.requiredRoles.length >= 2 && value.requiredRoles.length <= 4);
    assert.ok(Array.isArray(value.assignments));
    value.assignments.forEach(assertRoleAssignment);
    const roleOrder = new Map(value.requiredRoles.map((role, index) => [role, index]));
    assert.deepEqual(value.assignments, value.assignments.toSorted((a, b) => roleOrder.get(a.role) - roleOrder.get(b.role)));
    if (value.teamAssignmentId !== null) assert.match(value.teamAssignmentId, UUID);
  } else if (value.assignmentId !== null) assert.match(value.assignmentId, UUID);
  return value;
}

export function assertOffer(value, { team } = {}) {
  const isTeam = team ?? Object.hasOwn(value ?? {}, "roleIndex");
  exactKeys(value, isTeam ? TEAM_OFFER_KEYS : OFFER_KEYS, isTeam ? "TeamOffer" : "Offer");
  assert.match(value.offerId, UUID);
  assert.match(value.deliveryId, UUID);
  assert.match(value.courierId, UUID);
  assert.match(value.notificationId, UUID);
  assert.match(value.createdAt, TIMESTAMP);
  assert.match(value.expiresAt, TIMESTAMP);
  assert.ok(Number.isSafeInteger(value.round) && value.round > 0);
  assert.ok(Number.isSafeInteger(value.rank) && value.rank > 0 && value.rank <= 5);
  assert.ok(["OPEN", "ACCEPTED", "LOST", "EXPIRED"].includes(value.state));
  if (isTeam) {
    assert.ok(Number.isSafeInteger(value.roleIndex) && value.roleIndex >= 0);
    assert.equal(typeof value.role, "string");
  }
  return value;
}

export function assertNotification(value) {
  exactKeys(value, NOTIFICATION_KEYS, "OfferNotification");
  exactKeys(value.body, NOTIFICATION_BODY_KEYS, "OfferNotification body");
  assert.match(value.notificationId, UUID);
  assert.match(value.offerId, UUID);
  assert.match(value.courierId, UUID);
  assert.match(value.deliveryUrl, URL);
  assert.equal(value.body.notificationId, value.notificationId);
  assert.equal(value.body.offerId, value.offerId);
  assert.equal(value.body.courierId, value.courierId);
  assert.ok(["PENDING", "DELIVERED", "SUPERSEDED"].includes(value.state));
  assert.ok(Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0);
  assertNullableTimestamp(value.nextAttemptAt, "OfferNotification nextAttemptAt");
  assertNullableTimestamp(value.successfulDeliveryAt, "OfferNotification successfulDeliveryAt");
  return value;
}

export function assertAssignment(value) {
  exactKeys(value, ASSIGNMENT_KEYS, "Assignment");
  for (const key of ["assignmentId", "deliveryId", "courierId", "offerId"]) assert.match(value[key], UUID);
  assert.match(value.assignedAt, TIMESTAMP);
  assertNullableTimestamp(value.pickedUpAt, "Assignment pickedUpAt");
  assertNullableTimestamp(value.completedAt, "Assignment completedAt");
  assert.ok(Number.isSafeInteger(value.loadUnits) && value.loadUnits > 0);
  return value;
}

export function assertRoleAssignment(value) {
  exactKeys(value, ROLE_ASSIGNMENT_KEYS, "RoleAssignment");
  for (const key of ["assignmentId", "deliveryId", "courierId", "offerId"]) assert.match(value[key], UUID);
  assert.ok(["RESERVED", "READY", "RELEASED", "PICKED_UP", "COMPLETED"].includes(value.state));
  assert.match(value.claimedAt, TIMESTAMP);
  assert.match(value.claimExpiresAt, TIMESTAMP);
  assertNullableTimestamp(value.readyAt, "RoleAssignment readyAt");
  assertNullableTimestamp(value.releasedAt, "RoleAssignment releasedAt");
  return value;
}

export function assertTeamAssignment(value) {
  exactKeys(value, TEAM_ASSIGNMENT_KEYS, "TeamAssignment");
  assert.match(value.teamAssignmentId, UUID);
  assert.match(value.deliveryId, UUID);
  assert.ok(["FORMING", "ACTIVE", "READY", "PICKED_UP", "COMPLETED", "CANCELLED"].includes(value.state));
  assert.ok(Array.isArray(value.requiredRoles));
  assert.ok(Array.isArray(value.assignments));
  value.assignments.forEach(assertRoleAssignment);
  const roleOrder = new Map(value.requiredRoles.map((role, index) => [role, index]));
  assert.deepEqual(value.assignments, value.assignments.toSorted((left, right) => roleOrder.get(left.role) - roleOrder.get(right.role)), "TeamAssignment members are not in required role order");
  assertNullableTimestamp(value.activatedAt, "TeamAssignment activatedAt");
  assertNullableTimestamp(value.pickedUpAt, "TeamAssignment pickedUpAt");
  assertNullableTimestamp(value.completedAt, "TeamAssignment completedAt");
  assert.ok(Number.isSafeInteger(value.revision) && value.revision >= 0);
  return value;
}

export function assertCourier(value) {
  exactKeys(value, COURIER_KEYS, "Courier");
  assert.match(value.courierId, UUID);
  assert.ok(Number.isSafeInteger(value.capacityUnits) && value.capacityUnits > 0);
  assert.ok(Number.isSafeInteger(value.activeLoadUnits) && value.activeLoadUnits >= 0 && value.activeLoadUnits <= value.capacityUnits);
  assert.ok(Array.isArray(value.eligibleZones));
  assert.match(value.deliveryUrl, URL);
  assert.ok(["AVAILABLE", "PAUSED"].includes(value.state));
  return value;
}

export function assertNoPrivateFields(value, path = "snapshot") {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoPrivateFields(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(key, /Token$/u, `${path}.${key} exposes a token`);
    assert.doesNotMatch(key, /^(?:idempotencyKey|rawWebhook|privatePath|secret)$/iu, `${path}.${key} exposes private data`);
    if (typeof entry === "string") assert.doesNotMatch(entry, /^\/(?:home|Users|private|tmp)\//u, `${path}.${key} exposes a private absolute path`);
    assertNoPrivateFields(entry, `${path}.${key}`);
  }
}

function assertSorted(items, comparator, label) {
  assert.deepEqual(items, items.toSorted(comparator), `${label} is not in canonical order`);
}

export function assertSnapshotClosure(snapshot) {
  exactKeys(snapshot, ["asOf", "events", "resources", "work"], "verification snapshot");
  assert.match(snapshot.asOf, TIMESTAMP);
  exactKeys(snapshot.resources, FINAL_RESOURCE_KEYS, "FINAL snapshot resources");
  assertNoPrivateFields(snapshot);
  snapshot.resources.deliveries.forEach((item) => assertDelivery(item));
  snapshot.resources.offers.forEach((item) => assertOffer(item, { team: false }));
  snapshot.resources.teamOffers.forEach((item) => assertOffer(item, { team: true }));
  snapshot.resources.offerNotifications.forEach(assertNotification);
  snapshot.resources.assignments.forEach(assertAssignment);
  snapshot.resources.teamAssignments.forEach(assertTeamAssignment);
  snapshot.resources.couriers.forEach(assertCourier);
  for (const item of snapshot.work) {
    exactKeys(item, WORK_KEYS, "Work");
    assert.match(item.workId, UUID);
    assert.match(item.aggregateId, UUID);
    assert.ok(["OFFER_ISSUANCE", "OFFER_EXPIRY"].includes(item.kind));
    assert.ok(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state));
    assert.equal(item.terminal, TERMINAL_WORK.has(item.state));
    assert.equal(item.leaseOwner !== null, item.state === "LEASED");
    assert.equal(item.leaseExpiresAt !== null, item.state === "LEASED");
    assert.ok(Number.isSafeInteger(item.attempt) && item.attempt >= 0);
  }
  for (const item of snapshot.events) {
    exactKeys(item, EVENT_KEYS, "DomainEvent");
    assert.match(item.eventId, UUID);
    assert.match(item.aggregateId, UUID);
    assert.match(item.occurredAt, TIMESTAMP);
    assert.equal(item.schemaVersion, 1);
    assert.ok(EVENT_TYPES.has(item.type), `unpublished Domain Event type ${item.type}`);
    assert.deepEqual(item.payload, {});
  }
  assertSorted(snapshot.resources.zones, comparePaths(["zoneId"]), "zones");
  assertSorted(snapshot.resources.zoneDistances, comparePaths(["fromZone", "toZone"]), "zoneDistances");
  assertSorted(snapshot.resources.couriers, comparePaths(["courierId"]), "couriers");
  assertSorted(snapshot.resources.customers, comparePaths(["customerId"]), "customers");
  assertSorted(snapshot.resources.deliveries, comparePaths(["deliveryId"]), "deliveries");
  assertSorted(snapshot.resources.offers, comparePaths(["deliveryId", "round", "rank", "offerId"]), "offers");
  assertSorted(snapshot.resources.teamOffers, comparePaths(["deliveryId", "round", "roleIndex", "rank", "offerId"]), "teamOffers");
  assertSorted(snapshot.resources.offerNotifications, comparePaths(["offerId", "notificationId"]), "offerNotifications");
  assertSorted(snapshot.resources.assignments, comparePaths(["assignmentId"]), "assignments");
  assertSorted(snapshot.resources.teamAssignments, comparePaths(["teamAssignmentId"]), "teamAssignments");
  assertSorted(snapshot.work, comparePaths(["workId"]), "work");
  assertSorted(snapshot.events, comparePaths(["aggregateId", "sequence", "eventId"]), "events");
  assertCapacityClosure(snapshot.resources);
  assertEventSequences(snapshot.events);
  const deliveryById = new Map(snapshot.resources.deliveries.map((item) => [item.deliveryId, item]));
  const courierById = new Map(snapshot.resources.couriers.map((item) => [item.courierId, item]));
  const allOffers = [...snapshot.resources.offers, ...snapshot.resources.teamOffers];
  const offerById = new Map(allOffers.map((item) => [item.offerId, item]));
  const notificationById = new Map(snapshot.resources.offerNotifications.map((item) => [item.notificationId, item]));
  assert.equal(offerById.size, allOffers.length, "Offer identity is duplicated across ordinary and team resources");
  assert.equal(notificationById.size, snapshot.resources.offerNotifications.length, "OfferNotification identity is duplicated");
  for (const item of allOffers) {
    const targetDelivery = deliveryById.get(item.deliveryId);
    const targetNotification = notificationById.get(item.notificationId);
    assert.ok(targetDelivery, "Offer references a missing Delivery");
    assert.ok(courierById.has(item.courierId), "Offer references a missing Courier");
    assert.ok(targetNotification, "Offer references a missing OfferNotification");
    assert.equal(targetNotification.offerId, item.offerId);
    assert.equal(targetNotification.courierId, item.courierId);
    assert.equal(targetNotification.body.deliveryId, item.deliveryId);
    assert.equal(targetNotification.body.round, item.round);
    assert.equal(targetNotification.body.expiresAt, item.expiresAt);
    if (Object.hasOwn(item, "roleIndex")) {
      assert.ok(Object.hasOwn(targetDelivery, "requiredRoles"), "TeamOffer belongs to an ordinary Delivery");
      assert.equal(item.role, targetDelivery.requiredRoles[item.roleIndex]);
      assert.equal(targetNotification.body.roleIndex, item.roleIndex);
      assert.equal(targetNotification.body.role, item.role);
    } else {
      assert.equal(targetNotification.body.roleIndex, null);
      assert.equal(targetNotification.body.role, null);
    }
  }
  for (const item of snapshot.resources.assignments) {
    assert.ok(deliveryById.has(item.deliveryId), "Assignment Delivery is missing");
    assert.ok(offerById.has(item.offerId), "Assignment Offer is missing");
    assert.ok(courierById.has(item.courierId), "Assignment Courier is missing");
    assert.equal(offerById.get(item.offerId).deliveryId, item.deliveryId);
    assert.equal(offerById.get(item.offerId).courierId, item.courierId);
  }
  const assignmentsByDelivery = Map.groupBy(snapshot.resources.assignments, ({ deliveryId }) => deliveryId);
  for (const [deliveryId, items] of assignmentsByDelivery) assert.equal(items.length, 1, `ordinary Delivery ${deliveryId} has multiple Assignments`);
  for (const item of snapshot.resources.deliveries.filter((entry) => !Object.hasOwn(entry, "requiredRoles"))) {
    const own = assignmentsByDelivery.get(item.deliveryId) ?? [];
    assert.equal(item.assignmentId === null, own.length === 0, "ordinary Delivery assignmentId does not match Assignment presence");
    if (own.length === 1) assert.equal(item.assignmentId, own[0].assignmentId);
  }
  for (const team of snapshot.resources.teamAssignments) {
    const target = deliveryById.get(team.deliveryId);
    assert.ok(target && Object.hasOwn(target, "requiredRoles"), "TeamAssignment Delivery is missing or ordinary");
    assert.deepEqual(team.requiredRoles, target.requiredRoles);
    assert.equal(team.teamAssignmentId, target.teamAssignmentId);
    const live = team.assignments.filter(({ state }) => state !== "RELEASED");
    assert.equal(new Set(live.map(({ role }) => role)).size, live.length, "TeamAssignment has multiple live members for one role");
    assert.equal(new Set(live.map(({ courierId }) => courierId)).size, live.length, "Courier holds multiple live roles on one Delivery");
    if (["ACTIVE", "READY", "PICKED_UP", "COMPLETED"].includes(team.state)) assert.deepEqual(live.map(({ role }) => role), team.requiredRoles, "active TeamAssignment is missing a required role");
    if (["READY", "PICKED_UP", "COMPLETED"].includes(team.state)) assert.ok(live.every(({ state }) => ["READY", "PICKED_UP", "COMPLETED"].includes(state)), "ready TeamAssignment contains an unready member");
    if (team.state === "COMPLETED") assert.ok(live.every(({ state }) => state === "COMPLETED"), "completed TeamAssignment has a non-completed member");
  }
  return snapshot;
}

export function stableSnapshot(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}

export function seedOf(fixtures, label, members = {}) {
  return { ...emptySeed(fixtures, label), ...members, seedVersion: fixtures.seedVersion(label) };
}

export async function prepare(ctx, seed, { build = true, apis = 1, workers = 0, dispatcherUrl } = {}) {
  if (build) {
    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
  }
  await ctx.migrate({ timeoutMs: 120_000 });
  if (seed) {
    const imported = await ctx.seed(seed, { timeoutMs: 600_000 });
    assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  }
  const apiProcesses = [];
  for (let index = 0; index < apis; index += 1) apiProcesses.push(await ctx.startApi());
  const workerProcesses = [];
  for (let index = 0; index < workers; index += 1) workerProcesses.push(await ctx.startWorker());
  const dispatcher = dispatcherUrl ? await ctx.startDispatcher({ webhookUrl: dispatcherUrl }) : undefined;
  return { api: apiProcesses[0], apis: apiProcesses, workers: workerProcesses, dispatcher };
}

export function deliveryRequest(fixture, overrides = {}) {
  const now = Date.now();
  return {
    customerId: fixture.customers[0].customerId,
    pickupZone: fixture.zones[0].zoneId,
    dropoffZone: fixture.zones[1].zoneId,
    readyAt: new Date(now + 600_000).toISOString(),
    deliverBy: new Date(now + 4_200_000).toISOString(),
    loadUnits: 1,
    ...overrides,
  };
}

export async function createDelivery(ctx, api, fixture, label, overrides = {}, options = {}) {
  const request = deliveryRequest(fixture, overrides);
  const response = await ctx.mutate(api.baseUrl, "/api/v1/deliveries", options.key ?? ctx.key(`${label}-create`), request, options.mutation);
  const created = assertDelivery(requireStatus(response, 202, `${label} Delivery create`), { team: Array.isArray(request.roles) });
  assert.equal(created.state, "REQUESTED");
  assert.equal(created.customerId, request.customerId);
  if (request.roles) assert.deepEqual(created.requiredRoles, request.roles);
  return { delivery: created, request, response };
}

export async function getDelivery(ctx, api, deliveryId) {
  return assertDelivery(requireStatus(await ctx.request(api.baseUrl, `/api/v1/deliveries/${deliveryId}`), 200, "Delivery read"));
}

export async function getOffers(ctx, api, deliveryId) {
  const response = await ctx.request(api.baseUrl, `/api/v1/deliveries/${deliveryId}/offers`);
  const body = requireStatus(response, 200, "Delivery Offers read");
  exactKeys(body, ["items"], "Delivery Offers response");
  assert.ok(Array.isArray(body.items));
  body.items.forEach((item) => assertOffer(item));
  return body.items;
}

export async function waitForOffers(ctx, api, deliveryId, predicate = (items) => items.length > 0, options = {}) {
  return ctx.waitFor(async () => {
    const items = await getOffers(ctx, api, deliveryId);
    return predicate(items) ? items : undefined;
  }, { timeoutMs: options.timeoutMs ?? 45_000, intervalMs: options.intervalMs ?? 100, label: `${deliveryId} Offers`, processes: options.processes });
}

export async function acceptOffer(ctx, api, offer, label, options = {}) {
  const request = { courierId: offer.courierId, ...(options.body ?? {}) };
  const response = await ctx.mutate(api.baseUrl, `/api/v1/offers/${offer.offerId}/accept`, options.key ?? ctx.key(`${label}-accept`), request);
  return { response, request };
}

export async function readyAssignment(ctx, api, deliveryId, item, label, options = {}) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/deliveries/${deliveryId}/assignments/${item.assignmentId}/ready`, options.key ?? ctx.key(`${label}-ready`), { courierId: options.courierId ?? item.courierId });
  return response;
}

export async function pickupDelivery(ctx, api, deliveryId, courierId, label, options = {}) {
  return ctx.mutate(api.baseUrl, `/api/v1/deliveries/${deliveryId}/pickup`, options.key ?? ctx.key(`${label}-pickup`), { courierId });
}

export async function completeDelivery(ctx, api, deliveryId, courierId, label, options = {}) {
  return ctx.mutate(api.baseUrl, `/api/v1/deliveries/${deliveryId}/complete`, options.key ?? ctx.key(`${label}-complete`), { courierId, proofCode: options.proofCode ?? "proof-123456" }, { contractExpectation: options.contractExpectation });
}

export async function cancelDelivery(ctx, api, deliveryId, label, options = {}) {
  return ctx.mutate(api.baseUrl, `/api/v1/deliveries/${deliveryId}/cancel`, options.key ?? ctx.key(`${label}-cancel`), { reason: options.reason ?? "customer request" });
}

export async function waitForDelivery(ctx, api, deliveryId, states, options = {}) {
  return ctx.waitFor(async () => {
    const item = await getDelivery(ctx, api, deliveryId);
    return states.includes(item.state) ? item : undefined;
  }, { timeoutMs: options.timeoutMs ?? 45_000, intervalMs: options.intervalMs ?? 100, label: `${deliveryId} state ${states.join("/")}`, processes: options.processes });
}

export async function waitUntilTimestamp(ctx, timestamp, marginMs = 0, options = {}) {
  const target = Date.parse(timestamp) + marginMs;
  assert.ok(Number.isFinite(target));
  return ctx.waitFor(() => Date.now() >= target ? true : undefined, {
    timeoutMs: options.timeoutMs ?? Math.max(5_000, target - Date.now() + 5_000),
    intervalMs: options.intervalMs ?? 100,
    label: `database-time safety point ${new Date(target).toISOString()}`,
    processes: options.processes,
  });
}

export async function lostMutation(ctx, shield, replayApi, path, key, body) {
  const before = shield.captures.length;
  shield.dropNextMutation();
  await assert.rejects(ctx.mutate(shield.baseUrl, path, key, body));
  const capture = await ctx.waitFor(() => shield.captures.slice(before).find(({ dropped }) => dropped), { label: `dropped ${path} response` });
  const replay = await ctx.mutate(replayApi.baseUrl, path, key, body);
  assert.equal(replay.status, capture.response.status);
  assert.deepEqual(replay.json, JSON.parse(capture.response.body));
  return { capture, replay };
}

export function recoveryEnvironment(ctx, barrier) {
  return { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: "3" };
}

export async function launchBrowser(ctx, api, options = {}) {
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch (cause) { throw new EvaluationInfrastructureError("EVALUATOR_PLAYWRIGHT_UNAVAILABLE", "playwright-core is unavailable", { cause }); }
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (cause) {
    throw new EvaluationInfrastructureError("EVALUATOR_CHROMIUM_LAUNCH_FAILED", "failed to launch harness Chromium", { cause });
  }
  ctx.defer(() => browser.close());
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 1280, height: 800 } });
  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  return page;
}

export async function visibleControl(page, patterns, kind = "label") {
  const candidates = Array.isArray(patterns) ? patterns : [patterns];
  for (const pattern of candidates) {
    const locator = kind === "button" ? page.getByRole("button", { name: pattern }) : page.getByLabel(pattern);
    const first = locator.first();
    if (await first.count() && await first.isVisible()) return first;
  }
  assert.fail(`no visible ${kind} matched ${candidates.join(", ")}`);
}

export async function fillControl(control, value) {
  const tag = await control.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "select") {
    const options = await control.locator("option").evaluateAll((items) => items.map((item) => ({ value: item.value, text: item.textContent ?? "", disabled: item.disabled })));
    const selected = options.find((item) => !item.disabled && (item.value === String(value) || item.text.includes(String(value))))
      ?? options.find((item) => !item.disabled && item.value);
    assert.ok(selected, "select has no usable option");
    await control.selectOption(selected.value);
  } else {
    await control.fill(String(value));
  }
}

export async function clickForResponse(page, button, predicate) {
  const [response] = await Promise.all([
    page.waitForResponse((item) => predicate(item), { timeout: 30_000 }),
    button.click(),
  ]);
  const json = await response.json();
  return { status: response.status(), json, url: response.url(), method: response.request().method() };
}
