import { candidateAssert as assert } from "../lib/execution.mjs";

import { assertCapacitySlices } from "../lib/oracle.mjs";

export const FINAL_RESOURCE_KEYS = [
  "admissionEntries",
  "capacityLeases",
  "capacityPools",
  "capacitySlices",
  "gangLeaseMembers",
  "owners",
];

export const LEASE_KEYS = [
  "createdAt", "endAt", "holdExpiresAt", "leaseId", "members", "ownerId", "poolId",
  "priority", "revision", "sequence", "startAt", "state", "terminalAt", "units",
];

export const MEMBER_KEYS = ["leaseId", "memberId", "ordinal", "poolId", "units"];
export const EVENT_KEYS = ["aggregateId", "eventId", "occurredAt", "payload", "schemaVersion", "sequence", "type"];

export function emptySeed(ctx, label, { poolCount = 3, capacityUnits = 10 } = {}) {
  const ownerId = ctx.uuid(`${label}-owner`);
  const pools = Array.from({ length: poolCount }, (_, index) => ({
    poolId: ctx.uuid(`${label}-pool-${index}`),
    name: `${label} Pool ${index + 1}`,
    capacityUnits,
    revision: 1,
  })).sort((left, right) => Buffer.from(left.poolId).compare(Buffer.from(right.poolId)));
  return {
    ids: { ownerId, poolIds: pools.map(({ poolId }) => poolId) },
    seed: {
      schemaVersion: 1,
      seedVersion: `${label}-${ctx.key(label)}`.slice(0, 64),
      owners: [{ ownerId, name: `${label} Owner` }],
      capacityPools: pools,
      capacityLeases: [],
      admissionEntries: [],
      capacitySlices: [],
    },
  };
}

export function leaseRequest(ctx, ids, label, overrides = {}) {
  return {
    poolId: ids.poolIds[0],
    ownerId: ids.ownerId,
    startAt: ctx.at({ hours: 2 }),
    endAt: ctx.at({ hours: 3 }),
    units: 2,
    priority: 0,
    allowWait: false,
    ...overrides,
  };
}

export function gangRequest(ctx, ids, label, count = 2, overrides = {}) {
  return {
    ownerId: ids.ownerId,
    startAt: ctx.at({ hours: 2 }),
    endAt: ctx.at({ hours: 3 }),
    priority: 0,
    allowWait: false,
    members: ids.poolIds.slice(0, count).map((poolId, index) => ({ poolId, units: index + 1 })),
    ...overrides,
  };
}

export function seededLease(ctx, ids, label, overrides = {}) {
  return {
    leaseId: ctx.uuid(`${label}-lease`),
    poolId: ids.poolIds[0],
    ownerId: ids.ownerId,
    startAt: ctx.at({ hours: 2 }),
    endAt: ctx.at({ hours: 3 }),
    units: 2,
    priority: 0,
    state: "CONFIRMED",
    holdExpiresAt: null,
    revision: 1,
    createdAt: ctx.at({ hours: -1 }),
    terminalAt: null,
    sequence: 1,
    ...overrides,
  };
}

export function sliceFor(pool, lease, overrides = {}) {
  const units = { heldUnits: 0, confirmedUnits: 0, activeUnits: 0 };
  if (lease.state === "HELD") units.heldUnits = lease.units;
  if (lease.state === "CONFIRMED") units.confirmedUnits = lease.units;
  if (lease.state === "ACTIVE") units.activeUnits = lease.units;
  const used = units.heldUnits + units.confirmedUnits + units.activeUnits;
  return {
    poolId: pool.poolId,
    startAt: lease.startAt,
    endAt: lease.endAt,
    capacityUnits: pool.capacityUnits,
    ...units,
    availableUnits: pool.capacityUnits - used,
    ...overrides,
  };
}

export async function prepare(ctx, { seed, install = false } = {}) {
  if (install) {
    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
  }
  await ctx.migrate();
  if (seed) {
    const imported = await ctx.seed(seed);
    assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  }
  const api = await ctx.startApi();
  return api;
}

export function requireStatus(response, expected, label = "request") {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `${label}: expected ${statuses.join("/")}, received ${response.status}: ${response.text}`);
  assert.notEqual(response.json, undefined, `${label}: response is not JSON`);
  return response.json;
}

export function assertExactError(response, status, code) {
  requireStatus(response, status, code);
  assert.deepEqual(Object.keys(response.json).sort(), ["error"]);
  assert.deepEqual(Object.keys(response.json.error).sort(), ["code", "details", "message"]);
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, "string");
  assert.ok(response.json.error.message.length > 0);
  assert.equal(response.json.error.details !== null && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details), true);
}

export function collection(response) {
  const body = response?.json ?? response;
  assert.ok(Array.isArray(body?.items), "response does not contain an items array");
  return body.items;
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function stableSnapshot(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}

export function assertNoSecretFields(value, path = "snapshot") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(key, /Token$/u, `${path}.${key} leaks a token field`);
    assert.doesNotMatch(key, /^(?:idempotencyKey|rawWebhook|privatePath|secret)$/iu, `${path}.${key} leaks private data`);
    assertNoSecretFields(entry, `${path}.${key}`);
  }
}

export function assertFinalSnapshot(snapshot) {
  assert.equal(typeof snapshot.asOf, "string");
  assert.deepEqual(Object.keys(snapshot).sort(), ["asOf", "events", "resources", "work"]);
  assert.deepEqual(Object.keys(snapshot.resources).sort(), FINAL_RESOURCE_KEYS);
  for (const key of FINAL_RESOURCE_KEYS) assert.ok(Array.isArray(snapshot.resources[key]), `snapshot.resources.${key} is not an array`);
  assert.ok(Array.isArray(snapshot.work));
  assert.ok(Array.isArray(snapshot.events));
  assertNoSecretFields(snapshot);
  assertCapacitySlices({
    pools: snapshot.resources.capacityPools,
    leases: snapshot.resources.capacityLeases,
    members: snapshot.resources.gangLeaseMembers,
    slices: snapshot.resources.capacitySlices,
  });
}

export function byId(items, key, id, label = key) {
  const result = items.find((item) => item[key] === id);
  assert.ok(result, `${label} ${id} is missing`);
  return result;
}

export function leaseIdentity(body) {
  assert.equal(typeof body?.leaseId, "string", "response has no leaseId");
  return body.leaseId;
}

export function admissionIdentity(body) {
  assert.equal(typeof body?.admissionEntryId, "string", "response has no admissionEntryId");
  return body.admissionEntryId;
}

export function cancelAdmission(ctx, baseUrl, admissionEntryId, key) {
  return ctx.request(baseUrl, `/api/v1/admission-entries/${admissionEntryId}`, { method: "DELETE", headers: { "idempotency-key": key } });
}

export async function createLease(ctx, api, key, request, expected = [201, 202]) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/capacity-leases", ctx.key(key), request);
  requireStatus(response, expected, key);
  return response;
}

export async function waitForSnapshot(ctx, api, predicate, label, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return predicate(snapshot) ? snapshot : undefined;
  }, { timeoutMs: 30_000, intervalMs: 50, label, ...options });
}

export function assertExactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has the wrong wire shape`);
}

export function assertUtcMillisecondTimestamp(value, label) {
  assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, `${label} is not a millisecond UTC timestamp`);
  assert.ok(Number.isFinite(Date.parse(value)), `${label} is not parseable`);
}

export function result(evidence, extra = {}) {
  return { evidence, ...extra };
}

export function parseCapturedResponse(capture) {
  const response = capture.response ?? capture;
  let json;
  try { json = JSON.parse(response.body ?? response.text ?? ""); } catch {}
  return { status: response.status, json, text: response.body ?? response.text };
}

export function clone(value) {
  return structuredClone(value);
}
