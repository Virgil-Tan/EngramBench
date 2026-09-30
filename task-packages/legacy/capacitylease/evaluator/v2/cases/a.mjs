import assert from "node:assert/strict";

import {
  EVENT_KEYS,
  LEASE_KEYS,
  MEMBER_KEYS,
  admissionIdentity,
  assertExactError,
  assertExactKeys,
  assertFinalSnapshot,
  assertNoSecretFields,
  assertUtcMillisecondTimestamp,
  byId,
  canonical,
  clone,
  collection,
  createLease,
  emptySeed,
  gangRequest,
  leaseIdentity,
  leaseRequest,
  prepare,
  requireStatus,
  result,
  seededLease,
  sliceFor,
  stableSnapshot,
  waitForSnapshot,
} from "./helpers.mjs";

const CREATE = "/api/v1/capacity-leases";
const LIST = "/api/v1/capacityLeases";

async function guarded(hardCapIds, operation) {
  try {
    return await operation();
  } catch (error) {
    error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
    throw error;
  }
}

async function a01(ctx) {
  await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
  const scriptResult = await ctx.command("npm", ["pkg", "get", "scripts"]);
  const scripts = JSON.parse(scriptResult.stdout);
  for (const name of [
    "db:migrate", "db:seed", "dev", "build", "start:api", "start:worker", "start:dispatcher",
    "test:unit", "test:integration", "test:e2e", "test:concurrency", "test:recovery", "test:all", "test:perf",
  ]) assert.equal(typeof scripts[name], "string", `package.json is missing required script ${name}`);
  await ctx.migrate();
  await ctx.migrate();
  await ctx.npm("build", [], { timeoutMs: 600_000 });
  const receiver = await ctx.receiver({ path: "/events" });
  const api = await ctx.startApi();
  const worker = await ctx.startWorker();
  const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
  assert.equal(new Set([api.pid, worker.pid, dispatcher.pid]).size, 3);
  assert.equal(new URL(api.baseUrl).hostname, "127.0.0.1");
  assert.equal((await ctx.request(api.baseUrl, "/healthz")).status, 200);
  assert.equal((await ctx.request(api.baseUrl, "/openapi.json")).status, 200);
  await Promise.all([ctx.stop(dispatcher), ctx.stop(worker), ctx.stop(api)]);
  await Promise.all([dispatcher.exited, worker.exited, api.exited]);
  for (const process of [api, worker, dispatcher]) {
    assert.ok(process.child.exitCode !== null || process.child.signalCode !== null, `${process.role} did not terminate`);
  }
  const dev = await ctx.startDev();
  assert.equal(new URL(dev.baseUrl).hostname, "127.0.0.1");
  assert.equal((await ctx.request(dev.baseUrl, "/healthz")).status, 200);
  await ctx.stop(dev);
  await dev.exited;
  assert.ok(dev.child.exitCode !== null || dev.child.signalCode !== null, "dev process did not terminate");
  return result(["all required scripts exist; clean npm ci/build and repeatable migration succeed", "dev, API/UI, Worker, and Dispatcher boot through published commands and terminate"]);
}

async function a02(ctx) {
  await ctx.migrate();
  await ctx.migrate();
  const fixture = emptySeed(ctx, "a02");
  await ctx.seed(fixture.seed);
  const api = await ctx.startApi();
  const request = leaseRequest(ctx, fixture.ids, "a02");
  const created = await createLease(ctx, api, "a02-create", request, 201);
  const before = await ctx.snapshot(api.baseUrl);
  await ctx.migrate();
  await ctx.migrate();
  const replay = await ctx.mutate(api.baseUrl, CREATE, ctx.key("a02-create"), request);
  assert.equal(replay.status, created.status);
  assert.equal(canonical(replay.json), canonical(created.json));
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before));
  return result(["populated migrations are repeatable and preserve resources, Work, events, and saved replay"]);
}

async function a03(ctx) {
  await ctx.migrate();
  const fixture = emptySeed(ctx, "a03");
  assert.equal((await ctx.seed(fixture.seed)).exitCode, 0);
  const api = await ctx.startApi();
  const baseline = stableSnapshot(await ctx.snapshot(api.baseUrl));
  assert.equal((await ctx.seed(fixture.seed)).exitCode, 0);
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), baseline);

  const conflict = clone(fixture.seed);
  conflict.owners[0].name = "different canonical content";
  const conflictResult = await ctx.seed(conflict, { allowFailure: true });
  assert.notEqual(conflictResult.exitCode, 0);
  assert.match(`${conflictResult.stdout}\n${conflictResult.stderr}`, /SEED_VERSION_CONFLICT/u);

  const pool = fixture.seed.capacityPools[0];
  const missingOwner = seededLease(ctx, fixture.ids, "a03-missing", { ownerId: ctx.uuid("missing-owner") });
  const invalidState = seededLease(ctx, fixture.ids, "a03-state", { state: "UNKNOWN" });
  const badTime = seededLease(ctx, fixture.ids, "a03-time", { startAt: "not-a-time" });
  const brokenCapacity = seededLease(ctx, fixture.ids, "a03-capacity", { units: pool.capacityUnits + 1 });
  const variants = [
    { ...clone(fixture.seed), unknown: [] },
    { ...clone(fixture.seed), owners: [fixture.seed.owners[0], fixture.seed.owners[0]] },
    { ...clone(fixture.seed), capacityLeases: [missingOwner] },
    { ...clone(fixture.seed), capacityLeases: [invalidState] },
    { ...clone(fixture.seed), capacityLeases: [brokenCapacity], capacitySlices: [sliceFor(pool, brokenCapacity)] },
    { ...clone(fixture.seed), capacityLeases: [badTime] },
    { ...clone(fixture.seed), capacityPools: [{ ...pool, capacityUnits: Number.MAX_SAFE_INTEGER + 1 }] },
  ];
  for (const [index, value] of variants.entries()) {
    value.seedVersion = `a03-invalid-${index}`;
    const rejected = await ctx.seed(value, { allowFailure: true });
    assert.notEqual(rejected.exitCode, 0, `invalid seed ${index} was accepted`);
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), baseline, `invalid seed ${index} changed state`);
  }
  return result(["seed replay and conflict are deterministic", "seven invalid seed families reject atomically"]);
}

function dereference(document, schema) {
  if (!schema?.$ref) return schema;
  return schema.$ref.slice(2).split("/").reduce((value, key) => value?.[key], document);
}

function expandSchema(document, schema, seen = new Set()) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) {
    if (seen.has(schema.$ref)) return { $ref: schema.$ref };
    return expandSchema(document, dereference(document, schema), new Set([...seen, schema.$ref]));
  }
  if (Array.isArray(schema)) return schema.map((value) => expandSchema(document, value, seen));
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, expandSchema(document, value, seen)]));
}

async function a04(ctx) {
  const fixture = emptySeed(ctx, "a04");
  const api = await prepare(ctx, { seed: fixture.seed });
  const response = await ctx.request(api.baseUrl, "/openapi.json");
  requireStatus(response, 200, "OpenAPI");
  const document = response.json;
  assert.match(document.openapi, /^3\.1(?:\.|$)/u);
  const routes = {
    "/api/v1/capacityLeases": ["get"],
    "/api/v1/capacityLeases/{capacityLeaseId}": ["get"],
    "/api/v1/capacity-leases": ["post"],
    "/api/v1/capacity-leases/{leaseId}/confirm": ["post"],
    "/api/v1/capacity-leases/{leaseId}/renew": ["post"],
    "/api/v1/capacity-leases/{leaseId}/release": ["post"],
    "/api/v1/admission-entries/{admissionEntryId}": ["delete"],
    "/api/v1/capacity-pools/{poolId}/timeline": ["get"],
    "/api/v1/capacity-leases/{leaseId}": ["get"],
    "/api/v1/capacity-leases/{leaseId}/members": ["get"],
    "/api/v1/domain-events": ["get"],
    "/api/v1/verification-snapshot": ["get"],
  };
  for (const [path, methods] of Object.entries(routes)) {
    assert.ok(document.paths?.[path], `OpenAPI is missing ${path}`);
    for (const method of methods) assert.ok(document.paths[path][method], `OpenAPI is missing ${method.toUpperCase()} ${path}`);
  }
  const create = document.paths[CREATE].post;
  const bodySchema = expandSchema(document, create.requestBody?.content?.["application/json"]?.schema);
  const bodySource = canonical(bodySchema);
  assert.match(bodySource, /"poolId"/u);
  assert.match(bodySource, /"units"/u);
  assert.match(bodySource, /"members"/u);
  const objectSchemas = [];
  const visitSchema = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.properties && (value.properties.poolId || value.properties.members)) objectSchemas.push(value);
    for (const nested of Object.values(value)) visitSchema(nested);
  };
  visitSchema(bodySchema);
  assert.ok(objectSchemas.length > 0, "create schema has no legacy/Gang object variants");
  assert.ok(objectSchemas.every(({ additionalProperties }) => additionalProperties === false), "create object variants must reject unlisted fields");
  assert.ok(create.responses?.["201"] && create.responses?.["202"] && create.responses?.["400"] && create.responses?.["409"]);
  const source = canonical(document);
  for (const code of ["INVALID_GANG_MEMBERS", "GANG_CAPACITY_UNAVAILABLE", "GANG_STATE_CONFLICT", "IDEMPOTENCY_CONFLICT"]) {
    assert.match(source, new RegExp(code, "u"));
  }
  return result(["OpenAPI 3.1 publishes every V1/FINAL route", "create and error schemas cover legacy and Gang contracts"]);
}

async function a05(ctx) {
  const fixture = emptySeed(ctx, "a05");
  const api = await prepare(ctx, { seed: fixture.seed });
  const valid = leaseRequest(ctx, fixture.ids, "a05");
  assertExactError(await ctx.request(api.baseUrl, CREATE, {
    method: "POST", headers: { "content-type": "text/plain", "idempotency-key": ctx.key("a05-media") }, raw: "x",
  }), 415, "UNSUPPORTED_MEDIA_TYPE");
  assertExactError(await ctx.request(api.baseUrl, CREATE, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("a05-json") }, raw: "{",
  }), 400, "MALFORMED_JSON");
  assertExactError(await ctx.mutate(api.baseUrl, CREATE, ctx.key("a05-field"), { ...valid, unknown: true }), 400, "UNKNOWN_FIELD");
  assertExactError(await ctx.mutate(api.baseUrl, CREATE, ctx.key("a05-shape"), { ...valid, ownerId: 3 }), 400, "INVALID_REQUEST");
  for (const authorization of [undefined, "Basic bad", "Bearer wrong"]) {
    const headers = authorization ? { authorization } : {};
    assertExactError(await ctx.request(api.baseUrl, "/api/v1/verification-snapshot", { headers }), 401, "ADMIN_AUTH_REQUIRED");
  }
  assertExactError(await ctx.request(api.baseUrl, `/api/v1/capacity-leases/${ctx.uuid("a05-missing")}`), 404, "NOT_FOUND");
  return result(["common media, JSON, field, shape, auth, and missing-resource failures use exact envelopes"]);
}

async function a06(ctx) {
  const fixture = emptySeed(ctx, "a06", { capacityUnits: 100 });
  const api = await prepare(ctx, { seed: fixture.seed });
  for (const seconds of [1, 120]) {
    const requestStartedAt = Date.now();
    const response = await createLease(ctx, api, `a06-valid-${seconds}`, leaseRequest(ctx, fixture.ids, "a06", {
      startAt: ctx.at({ hours: 5 + seconds }), endAt: ctx.at({ hours: 6 + seconds }), units: 1, holdSeconds: seconds,
    }), 201);
    const responseCompletedAt = Date.now();
    assertUtcMillisecondTimestamp(response.json.createdAt, "createdAt");
    assertUtcMillisecondTimestamp(response.json.holdExpiresAt, "holdExpiresAt");
    const holdExpiresAt = Date.parse(response.json.holdExpiresAt);
    assert.ok(holdExpiresAt >= requestStartedAt + seconds * 1_000, "holdExpiresAt precedes transaction time + holdSeconds");
    assert.ok(holdExpiresAt <= responseCompletedAt + seconds * 1_000, "holdExpiresAt follows transaction time + holdSeconds");
    assert.ok(Date.parse(response.json.holdExpiresAt) < Date.parse(response.json.startAt));
  }
  const base = leaseRequest(ctx, fixture.ids, "a06");
  const invalid = [
    [{ ...base, units: 0 }, "INVALID_LEASE_INTERVAL"],
    [{ ...base, startAt: base.endAt }, "INVALID_LEASE_INTERVAL"],
    [{ ...base, endAt: ctx.at({ days: 31, hours: 2 }) }, "INVALID_LEASE_INTERVAL"],
    [{ ...base, holdSeconds: 0 }, "INVALID_REQUEST"],
    [{ ...base, holdSeconds: 121 }, "INVALID_REQUEST"],
    [{ ...base, priority: 0.5 }, "INVALID_LEASE_INTERVAL"],
    [{ ...base, units: Number.MAX_SAFE_INTEGER + 1 }, "INVALID_LEASE_INTERVAL"],
    [{ ...base, startAt: "2035-01-01T00:00:00Z" }, "INVALID_REQUEST"],
    [{ ...base, endAt: "2035-01-02T00:00:00.000+00:00" }, "INVALID_REQUEST"],
  ];
  for (const [index, [body, code]] of invalid.entries()) {
    assertExactError(await ctx.mutate(api.baseUrl, CREATE, ctx.key(`a06-invalid-${index}`), body), 400, code);
  }
  return result(["safe-integer, interval, timestamp, duration, and hold boundaries are enforced"]);
}

function paginationSeed(ctx) {
  const fixture = emptySeed(ctx, "a07", { capacityUnits: 10 });
  const pool = fixture.seed.capacityPools[0];
  for (let index = 0; index < 55; index += 1) {
    const lease = seededLease(ctx, fixture.ids, `a07-${index}`, {
      startAt: ctx.at({ hours: 2, minutes: index * 2 }),
      endAt: ctx.at({ hours: 2, minutes: index * 2 + 1 }),
      units: 1,
      sequence: 1,
    });
    fixture.seed.capacityLeases.push(lease);
    fixture.seed.capacitySlices.push(sliceFor(pool, lease));
  }
  return fixture;
}

async function a07(ctx) {
  const fixture = paginationSeed(ctx);
  const api = await prepare(ctx, { seed: fixture.seed });
  const firstDefault = await ctx.request(api.baseUrl, LIST);
  requireStatus(firstDefault, 200, "default page");
  assert.equal(collection(firstDefault).length, 50);
  assert.equal(typeof firstDefault.json.nextCursor, "string");
  for (const limit of [1, 100]) requireStatus(await ctx.request(api.baseUrl, `${LIST}?limit=${limit}`), 200, `limit ${limit}`);
  for (const limit of [0, 101, "1.5"]) assertExactError(await ctx.request(api.baseUrl, `${LIST}?limit=${limit}`), 400, "INVALID_REQUEST");
  assertExactError(await ctx.request(api.baseUrl, `${LIST}?cursor=not-an-opaque-cursor`), 400, "INVALID_CURSOR");

  const seen = [];
  let cursor;
  do {
    const response = await ctx.request(api.baseUrl, `${LIST}?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    requireStatus(response, 200, "paged read");
    seen.push(...collection(response).map(({ leaseId }) => leaseId));
    cursor = response.json.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 55);
  assert.equal(new Set(seen).size, 55);
  const detail = await ctx.request(api.baseUrl, `/api/v1/capacityLeases/${seen[0]}`);
  requireStatus(detail, 200, "detail");
  assertExactKeys(detail.json, LEASE_KEYS, "CapacityLease detail");
  return result(["default and boundary limits, opaque cursors, complete pagination, and exact detail shape"]);
}

async function a08(ctx) {
  const fixture = emptySeed(ctx, "a08");
  const api = await prepare(ctx, { seed: fixture.seed });
  const request = leaseRequest(ctx, fixture.ids, "a08", { units: 2 });
  const response = await createLease(ctx, api, "a08-held", request, 201);
  assert.equal(response.json.state, "HELD");
  assert.equal(typeof response.json.holdToken, "string");
  const leaseId = leaseIdentity(response.json);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assertNoSecretFields(snapshot);
  assert.equal(snapshot.resources.capacityLeases.filter((item) => item.leaseId === leaseId).length, 1);
  assert.equal(snapshot.work.filter((item) => item.aggregateId === leaseId && item.kind === "LEASE_EXPIRY").length, 1);
  assert.equal(snapshot.events.filter((item) => item.aggregateId === leaseId && item.type === "lease.held").length, 1);
  const timeline = await ctx.request(api.baseUrl, `/api/v1/capacity-pools/${request.poolId}/timeline?from=${encodeURIComponent(request.startAt)}&to=${encodeURIComponent(request.endAt)}`);
  requireStatus(timeline, 200, "timeline");
  assert.ok(collection(timeline).some((slice) => slice.heldUnits === 2 && slice.availableUnits === 8));

  const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
  assertExactError(await ctx.mutate(api.baseUrl, CREATE, ctx.key("a08-full"), { ...request, units: 9 }), 409, "CAPACITY_UNAVAILABLE");
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), before);
  return result(["HELD creates one Lease, expiry Work, event, and conserved timeline", "insufficient no-wait request is atomic"]);
}

async function a09(ctx) {
  const fixture = emptySeed(ctx, "a09", { capacityUnits: 100 });
  const api = await prepare(ctx, { seed: fixture.seed });
  const created = await createLease(ctx, api, "a09-held", leaseRequest(ctx, fixture.ids, "a09", { units: 1 }), 201);
  const leaseId = leaseIdentity(created.json);
  const wrong = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("a09-wrong"), {
    holdToken: "wrong-token", expectedRevision: created.json.revision,
  });
  requireStatus(wrong, 409, "wrong hold token");
  assert.deepEqual(Object.keys(wrong.json).sort(), ["error"]);
  assert.deepEqual(Object.keys(wrong.json.error).sort(), ["code", "details", "message"]);
  assert.equal(typeof wrong.json.error.code, "string");
  assert.ok(wrong.json.error.code.length > 0);
  const body = { holdToken: created.json.holdToken, expectedRevision: created.json.revision };
  const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("a09-confirm"), body);
  requireStatus(confirmed, 200, "confirm");
  assert.equal(confirmed.json.state, "CONFIRMED");
  assert.equal(confirmed.json.revision, created.json.revision + 1);
  assert.equal(confirmed.json.sequence, created.json.sequence + 1);
  const replay = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("a09-confirm"), body);
  assert.equal(canonical(replay.json), canonical(confirmed.json));
  const stale = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("a09-stale"), body);
  assertExactError(stale, 409, "LEASE_REVISION_CHANGED");
  const events = (await ctx.snapshot(api.baseUrl)).events.filter((item) => item.aggregateId === leaseId);
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2]);
  assert.equal(events.filter(({ type }) => type === "lease.confirmed").length, 1);

  const expiring = await createLease(ctx, api, "a09-expiring", leaseRequest(ctx, fixture.ids, "a09-expiring", {
    startAt: ctx.at({ hours: 10 }), endAt: ctx.at({ hours: 11 }), holdSeconds: 1,
  }), 201);
  await ctx.waitFor(() => Date.now() > Date.parse(expiring.json.holdExpiresAt), { label: "published hold expiry" });
  assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${expiring.json.leaseId}/confirm`, ctx.key("a09-late"), {
    holdToken: expiring.json.holdToken, expectedRevision: expiring.json.revision,
  }), 409, "HOLD_EXPIRED");
  return result(["confirm enforces token, expiry, and revision and replays one transition/event"]);
}

async function a10(ctx) {
  const fixture = emptySeed(ctx, "a10", { capacityUnits: 10 });
  const pool = fixture.seed.capacityPools[0];
  const blocker = seededLease(ctx, fixture.ids, "a10-blocker", {
    startAt: ctx.at({ hours: 3, minutes: 30 }), endAt: ctx.at({ hours: 5 }), units: 9,
  });
  fixture.seed.capacityLeases.push(blocker);
  fixture.seed.capacitySlices.push(sliceFor(pool, blocker));
  const api = await prepare(ctx, { seed: fixture.seed });
  const created = await createLease(ctx, api, "a10-held", leaseRequest(ctx, fixture.ids, "a10", {
    startAt: ctx.at({ hours: 2 }), endAt: ctx.at({ hours: 3 }), units: 2,
  }), 201);
  const path = `/api/v1/capacity-leases/${created.json.leaseId}/renew`;
  const renewed = await ctx.mutate(api.baseUrl, path, ctx.key("a10-renew"), {
    expectedRevision: created.json.revision, endAt: ctx.at({ hours: 3, minutes: 30 }),
  });
  requireStatus(renewed, 200, "renew");
  assert.equal(renewed.json.endAt, ctx.at({ hours: 3, minutes: 30 }));
  const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
  const failures = [
    [{ expectedRevision: renewed.json.revision, endAt: ctx.at({ hours: 3 }) }, 400, "INVALID_LEASE_INTERVAL"],
    [{ expectedRevision: renewed.json.revision, endAt: ctx.at({ hours: 3, minutes: 31 }) }, 409, "CAPACITY_UNAVAILABLE"],
    [{ expectedRevision: renewed.json.revision, endAt: ctx.at({ days: 31 }) }, 400, "INVALID_LEASE_INTERVAL"],
    [{ expectedRevision: created.json.revision, endAt: ctx.at({ hours: 3, minutes: 30 }) }, 409, "LEASE_REVISION_CHANGED"],
  ];
  for (const [index, [body, status, code]] of failures.entries()) {
    assertExactError(await ctx.mutate(api.baseUrl, path, ctx.key(`a10-fail-${index}`), body), status, code);
    assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), before);
  }
  const events = (await ctx.snapshot(api.baseUrl)).events.filter((item) => item.aggregateId === created.json.leaseId && item.type === "lease.renewed");
  assert.equal(events.length, 1);
  return result(["renew extends only newly covered capacity and all failure modes are atomic"]);
}

async function a11(ctx) {
  const fixture = emptySeed(ctx, "a11", { capacityUnits: 20 });
  const activationLease = seededLease(ctx, fixture.ids, "a11-activation", {
    startAt: ctx.at({ days: -2 }), endAt: ctx.at({ hours: 6 }), units: 2,
  });
  fixture.seed.capacityLeases.push(activationLease);
  fixture.seed.capacitySlices.push(sliceFor(fixture.seed.capacityPools[0], activationLease));
  const api = await prepare(ctx, { seed: fixture.seed });
  const releasable = await createLease(ctx, api, "a11-release-create", leaseRequest(ctx, fixture.ids, "a11-release"), 201);
  const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${releasable.json.leaseId}/confirm`, ctx.key("a11-confirm"), {
    holdToken: releasable.json.holdToken, expectedRevision: releasable.json.revision,
  });
  requireStatus(confirmed, 200, "confirm before release");
  const released = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${releasable.json.leaseId}/release`, ctx.key("a11-release"), {
    expectedRevision: confirmed.json.revision, reason: "capacity no longer needed",
  });
  requireStatus(released, 200, "release");
  assert.equal(released.json.state, "RELEASED");
  assert.notEqual(released.json.terminalAt, null);
  assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${releasable.json.leaseId}/release`, ctx.key("a11-release-again"), {
    expectedRevision: released.json.revision, reason: "again",
  }), 409, "LEASE_NOT_RELEASABLE");

  const worker = await ctx.startWorker();
  const activatedSnapshot = await waitForSnapshot(ctx, api, (snapshot) => snapshot.resources.capacityLeases.some((lease) => (
    lease.leaseId === activationLease.leaseId && lease.state === "ACTIVE"
  )), "CONFIRMED activation", { processes: [worker] });
  const activated = byId(activatedSnapshot.resources.capacityLeases, "leaseId", activationLease.leaseId);
  const activeRelease = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${activationLease.leaseId}/release`, ctx.key("a11-active-release"), {
    expectedRevision: activated.revision, reason: "release active capacity",
  });
  requireStatus(activeRelease, 200, "ACTIVE release");
  assert.equal(activeRelease.json.state, "RELEASED");

  const expiring = await createLease(ctx, api, "a11-expire", leaseRequest(ctx, fixture.ids, "a11-expire", {
    startAt: ctx.at({ hours: 8 }), endAt: ctx.at({ hours: 9 }), holdSeconds: 1,
  }), 201);
  const final = await waitForSnapshot(ctx, api, (snapshot) => snapshot.resources.capacityLeases.some((lease) => lease.leaseId === expiring.json.leaseId && lease.state === "EXPIRED"), "HELD expiry", { processes: [worker] });
  const expired = byId(final.resources.capacityLeases, "leaseId", expiring.json.leaseId);
  assert.notEqual(expired.terminalAt, null);
  assert.equal(final.events.filter((event) => event.aggregateId === expiring.json.leaseId && event.type === "lease.expired").length, 1);
  assert.ok(final.work.some((work) => work.kind === "ADMISSION_PROMOTION"));
  return result([
    "due CONFIRMED activates through the public Worker seam and ACTIVE/future-CONFIRMED release are terminal",
    "HELD expiry releases capacity once and release/expiry drive durable Promotion work",
  ]);
}

async function a12(ctx) {
  const fixture = emptySeed(ctx, "a12", { capacityUnits: 10 });
  const api = await prepare(ctx, { seed: fixture.seed });
  const heldBlocker = await createLease(ctx, api, "a12-blocker", leaseRequest(ctx, fixture.ids, "a12", { units: 10 }), 201);
  const blocker = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${heldBlocker.json.leaseId}/confirm`, ctx.key("a12-blocker-confirm"), {
    holdToken: heldBlocker.json.holdToken, expectedRevision: heldBlocker.json.revision,
  });
  requireStatus(blocker, 200, "confirm blocker");
  const waitingRequest = leaseRequest(ctx, fixture.ids, "a12-wait", { units: 1, allowWait: true });
  const waiting = await createLease(ctx, api, "a12-wait", waitingRequest, 202);
  const admissionEntryId = admissionIdentity(waiting.json);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.resources.capacityLeases.filter((lease) => lease.startAt === waitingRequest.startAt && lease.units === 1).length, 0);
  const entry = byId(snapshot.resources.admissionEntries, "admissionEntryId", admissionEntryId);
  assert.equal(entry.state, "WAITING");
  for (const key of ["ownerId", "poolId", "startAt", "endAt", "units", "priority"]) assert.equal(entry[key], waitingRequest[key]);
  const cancelled = await ctx.mutate(api.baseUrl, `/api/v1/admission-entries/${admissionEntryId}`, ctx.key("a12-cancel"), {}, { method: "DELETE" });
  requireStatus(cancelled, 200, "cancel");
  const replay = await ctx.mutate(api.baseUrl, `/api/v1/admission-entries/${admissionEntryId}`, ctx.key("a12-cancel"), {}, { method: "DELETE" });
  assert.equal(canonical(replay.json), canonical(cancelled.json));
  requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${blocker.json.leaseId}/release`, ctx.key("a12-release"), {
    expectedRevision: blocker.json.revision, reason: "free capacity",
  }), 200, "release blocker");
  const worker = await ctx.startWorker();
  const final = await waitForSnapshot(ctx, api, (value) => value.work.every(({ terminal }) => terminal), "cancelled admission work drain", { processes: [worker] });
  const finalEntry = byId(final.resources.admissionEntries, "admissionEntryId", admissionEntryId);
  assert.equal(finalEntry.state, "CANCELLED");
  assert.equal(finalEntry.promotedLeaseId, null);
  assert.equal(final.resources.capacityLeases.filter((lease) => (
    lease.ownerId === waitingRequest.ownerId
    && lease.poolId === waitingRequest.poolId
    && lease.startAt === waitingRequest.startAt
    && lease.endAt === waitingRequest.endAt
    && lease.units === waitingRequest.units
    && lease.priority === waitingRequest.priority
  )).length, 0, "cancelled Admission Entry was promoted to an orphan Lease");
  return result(["unavailable request is exactly one WAITING Entry; cancellation replays and prevents Promotion"]);
}

function promotionSeed(ctx) {
  const fixture = emptySeed(ctx, "a13", { capacityUnits: 10 });
  const pool = fixture.seed.capacityPools[0];
  const intervals = [
    [ctx.at({ hours: 2 }), ctx.at({ hours: 3 })],
    [ctx.at({ hours: 3 }), ctx.at({ hours: 4 })],
    [ctx.at({ hours: 4 }), ctx.at({ hours: 5 })],
  ];
  fixture.seed.capacityLeases = intervals.map(([startAt, endAt], index) => seededLease(ctx, fixture.ids, `a13-blocker-${index}`, {
    startAt, endAt, units: 10,
  }));
  fixture.seed.capacitySlices = fixture.seed.capacityLeases.map((lease) => sliceFor(pool, lease));
  return { ...fixture, intervals };
}

async function a13(ctx) {
  const fixture = promotionSeed(ctx);
  const api = await prepare(ctx, { seed: fixture.seed });
  const [one, two, three] = fixture.intervals;
  const earlier = await createLease(ctx, api, "a13-earlier", leaseRequest(ctx, fixture.ids, "a13", {
    startAt: one[0], endAt: two[1], units: 10, priority: 10, allowWait: true,
  }), 202);
  const overlap = await createLease(ctx, api, "a13-overlap", leaseRequest(ctx, fixture.ids, "a13", {
    startAt: one[0], endAt: one[1], units: 10, priority: 1, allowWait: true,
  }), 202);
  const nonOverlap = await createLease(ctx, api, "a13-non-overlap", leaseRequest(ctx, fixture.ids, "a13", {
    startAt: three[0], endAt: three[1], units: 10, priority: 1, allowWait: true,
  }), 202);
  const worker = await ctx.startWorker();
  const release = async (lease, key) => {
    const response = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${lease.leaseId}/release`, ctx.key(key), {
      expectedRevision: lease.revision, reason: "promotion test",
    });
    requireStatus(response, 200, key);
    return response;
  };
  await release(fixture.seed.capacityLeases[2], "a13-release-third");
  let snapshot = await waitForSnapshot(ctx, api, (value) => byId(value.resources.admissionEntries, "admissionEntryId", admissionIdentity(nonOverlap.json)).state === "PROMOTED", "non-overlap bypass", { processes: [worker] });
  assert.equal(byId(snapshot.resources.admissionEntries, "admissionEntryId", admissionIdentity(earlier.json)).state, "WAITING");
  await release(fixture.seed.capacityLeases[0], "a13-release-first");
  await release(fixture.seed.capacityLeases[1], "a13-release-second");
  snapshot = await waitForSnapshot(ctx, api, (value) => byId(value.resources.admissionEntries, "admissionEntryId", admissionIdentity(earlier.json)).state === "PROMOTED", "earlier Promotion", { processes: [worker] });
  assert.equal(byId(snapshot.resources.admissionEntries, "admissionEntryId", admissionIdentity(overlap.json)).state, "WAITING");
  const promotedEntry = byId(snapshot.resources.admissionEntries, "admissionEntryId", admissionIdentity(earlier.json));
  const promotedLease = byId(snapshot.resources.capacityLeases, "leaseId", promotedEntry.promotedLeaseId);
  assert.equal(promotedLease.startAt, one[0]);
  assert.equal(promotedLease.endAt, two[1]);
  assert.equal(snapshot.resources.capacityLeases.filter((lease) => lease.leaseId === promotedEntry.promotedLeaseId).length, 1);
  return result(["Promotion honors deterministic order and overlap-only bypass", "repeated Work yields one preserved Lease identity"]);
}

function bytewiseSorted(values, fields) {
  return [...values].sort((left, right) => {
    for (const field of fields) {
      const a = left[field];
      const b = right[field];
      if (a === b) continue;
      return Buffer.from(String(a)).compare(Buffer.from(String(b)));
    }
    return Buffer.from(canonical(left)).compare(Buffer.from(canonical(right)));
  });
}

async function a14(ctx) {
  const fixture = emptySeed(ctx, "a14", { poolCount: 3, capacityUnits: 20 });
  const api = await prepare(ctx, { seed: fixture.seed });
  await createLease(ctx, api, "a14-one", leaseRequest(ctx, fixture.ids, "a14", { poolId: fixture.ids.poolIds[1], units: 3 }), 201);
  await createLease(ctx, api, "a14-two", leaseRequest(ctx, fixture.ids, "a14", { poolId: fixture.ids.poolIds[0], units: 4, startAt: ctx.at({ hours: 3 }), endAt: ctx.at({ hours: 4 }) }), 201);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assertFinalSnapshot(snapshot);
  assertUtcMillisecondTimestamp(snapshot.asOf, "snapshot.asOf");
  const resourceShapes = {
    owners: ["name", "ownerId"],
    capacityPools: ["capacityUnits", "name", "poolId", "revision"],
    capacityLeases: LEASE_KEYS,
    admissionEntries: ["admissionEntryId", "endAt", "ownerId", "poolId", "priority", "promotedLeaseId", "requestedAt", "startAt", "state", "terminalAt", "units"],
    capacitySlices: ["activeUnits", "availableUnits", "capacityUnits", "confirmedUnits", "endAt", "heldUnits", "poolId", "startAt"],
    gangLeaseMembers: MEMBER_KEYS,
  };
  for (const [key, shape] of Object.entries(resourceShapes)) {
    snapshot.resources[key].forEach((value) => assertExactKeys(value, shape, key));
  }
  snapshot.work.forEach((value) => assertExactKeys(value, ["aggregateId", "attempt", "kind", "leaseExpiresAt", "leaseOwner", "state", "terminal", "workId"], "Work"));
  snapshot.events.forEach((value) => assertExactKeys(value, EVENT_KEYS, "DomainEvent"));
  const sorting = {
    owners: ["ownerId"], capacityPools: ["poolId"], capacityLeases: ["leaseId"],
    admissionEntries: ["poolId", "priority", "requestedAt", "admissionEntryId"],
    capacitySlices: ["poolId", "startAt", "endAt"], gangLeaseMembers: ["leaseId", "ordinal", "memberId"],
  };
  for (const [key, fields] of Object.entries(sorting)) {
    assert.deepEqual(snapshot.resources[key], bytewiseSorted(snapshot.resources[key], fields), `${key} is not canonically sorted`);
  }
  assert.deepEqual(snapshot.work, bytewiseSorted(snapshot.work, ["workId"]));
  assert.deepEqual(snapshot.events, bytewiseSorted(snapshot.events, ["aggregateId", "sequence", "eventId"]));
  return result(["timeline/snapshot match the independent Capacity oracle", "FINAL keys, exact sorting, point-in-time envelope, and secret omission hold"]);
}

async function a15(ctx) {
  const fixture = emptySeed(ctx, "a15", { capacityUnits: 100 });
  const api = await prepare(ctx, { seed: fixture.seed });
  const created = await createLease(ctx, api, "a15-create", leaseRequest(ctx, fixture.ids, "a15"), 201);
  const leaseId = leaseIdentity(created.json);
  const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("a15-confirm"), {
    holdToken: created.json.holdToken, expectedRevision: created.json.revision,
  });
  const renewed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/renew`, ctx.key("a15-renew"), {
    expectedRevision: confirmed.json.revision, endAt: ctx.at({ hours: 4 }),
  });
  await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/release`, ctx.key("a15-release"), {
    expectedRevision: renewed.json.revision, reason: "event query",
  });
  const beforeRollback = (await ctx.snapshot(api.baseUrl)).events.length;
  await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/renew`, ctx.key("a15-invalid"), {
    expectedRevision: renewed.json.revision, endAt: ctx.at({ hours: 5 }),
  });
  assert.equal((await ctx.snapshot(api.baseUrl)).events.length, beforeRollback);

  const first = await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${leaseId}&afterSequence=0&limit=2`);
  requireStatus(first, 200, "events page 1");
  const second = await ctx.request(api.baseUrl, `/api/v1/domain-events?aggregateId=${leaseId}&afterSequence=2&limit=100`);
  requireStatus(second, 200, "events page 2");
  const events = [...collection(first), ...collection(second)];
  assert.deepEqual(events.map(({ sequence }) => sequence), [1, 2, 3, 4]);
  assert.deepEqual(events.map(({ type }) => type), ["lease.held", "lease.confirmed", "lease.renewed", "lease.released"]);
  for (const event of events) {
    assertExactKeys(event, EVENT_KEYS, "DomainEvent");
    assert.deepEqual(event.payload, {});
  }
  return result(["Domain-event filtering, pagination, contiguous sequence, exact payload, and rollback atomicity"]);
}

async function a16(ctx) {
  const fixture = emptySeed(ctx, "a16", { poolCount: 11, capacityUnits: 10 });
  const api = await prepare(ctx, { seed: fixture.seed });
  const source = canonical((await ctx.request(api.baseUrl, "/openapi.json")).json);
  assert.match(source, /GANG_STATE_CONFLICT/u);
  for (const count of [2, 3, 10]) {
    const request = gangRequest(ctx, fixture.ids, `a16-${count}`, count, {
      startAt: ctx.at({ hours: count + 2 }), endAt: ctx.at({ hours: count + 3 }),
      members: fixture.ids.poolIds.slice(0, count).reverse().map((poolId) => ({ poolId, units: 1 })),
    });
    const response = await createLease(ctx, api, `a16-${count}`, request, 201);
    assert.equal(response.json.poolId, null);
    assert.equal(response.json.units, null);
    assert.equal(response.json.members.length, count);
    const expectedPools = [...request.members.map(({ poolId }) => poolId)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
    assert.deepEqual(response.json.members.map(({ poolId }) => poolId), expectedPools);
    const ordinals = response.json.members.map(({ ordinal }) => ordinal);
    assert.ok(ordinals.every(Number.isSafeInteger), "Gang ordinals must be safe integers");
    assert.ok(ordinals.every((ordinal, index) => index === 0 || ordinal > ordinals[index - 1]), "Gang ordinals must strictly increase in poolId byte order");
    const members = await ctx.request(api.baseUrl, `/api/v1/capacity-leases/${response.json.leaseId}/members`);
    requireStatus(members, 200, "members");
    assert.deepEqual(Object.keys(members.json), ["items"]);
    assert.deepEqual(members.json.items, response.json.members);
    members.json.items.forEach((member) => assertExactKeys(member, MEMBER_KEYS, "GangLeaseMember"));
  }
  const legacy = await createLease(ctx, api, "a16-legacy", leaseRequest(ctx, fixture.ids, "a16-legacy", {
    startAt: ctx.at({ hours: 20 }), endAt: ctx.at({ hours: 21 }), poolId: fixture.ids.poolIds[10], units: 2,
  }), 201);
  assert.equal(legacy.json.poolId, fixture.ids.poolIds[10]);
  assert.equal(legacy.json.units, 2);
  assert.equal(legacy.json.members.length, 1);

  const base = gangRequest(ctx, fixture.ids, "a16-invalid", 2, { startAt: ctx.at({ hours: 30 }), endAt: ctx.at({ hours: 31 }) });
  const invalid = [
    { ...base, members: base.members.slice(0, 1) },
    { ...base, members: Array.from({ length: 11 }, (_, index) => ({ poolId: fixture.ids.poolIds[index], units: 1 })) },
    { ...base, members: [base.members[0], base.members[0]] },
    { ...base, poolId: fixture.ids.poolIds[0], units: 1 },
    { ...base, members: [{ ...base.members[0], units: 0 }, base.members[1]] },
  ];
  for (const [index, body] of invalid.entries()) assertExactError(await ctx.mutate(api.baseUrl, CREATE, ctx.key(`a16-invalid-${index}`), body), 400, "INVALID_GANG_MEMBERS");

  const blocker = await createLease(ctx, api, "a16-blocker", leaseRequest(ctx, fixture.ids, "a16-blocker", {
    poolId: fixture.ids.poolIds[0], startAt: ctx.at({ hours: 40 }), endAt: ctx.at({ hours: 41 }), units: 10,
  }), 201);
  assert.ok(blocker.json.leaseId);
  const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
  assertExactError(await ctx.mutate(api.baseUrl, CREATE, ctx.key("a16-capacity"), gangRequest(ctx, fixture.ids, "a16-capacity", 2, {
    startAt: ctx.at({ hours: 40 }), endAt: ctx.at({ hours: 41 }), allowWait: false,
  })), 409, "GANG_CAPACITY_UNAVAILABLE");
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), before);
  const allowedTypes = new Set(["lease.held", "lease.confirmed", "lease.renewed", "lease.released", "lease.expired", "admission.promoted"]);
  for (const event of (await ctx.snapshot(api.baseUrl)).events) assert.ok(allowedTypes.has(event.type), `unpublished event type ${event.type}`);
  return result(["2/3/10-member Gang wire contract and immutable ordinal order", "invalid and unavailable Gangs are all-or-nothing; no invented events"]);
}

export const A_CASES = [
  ["A-01", a01, ["BUILD_MIGRATION_OR_BOOT"]], ["A-02", a02, ["BUILD_MIGRATION_OR_BOOT"]],
  ["A-03", a03, ["CORE_CAPACITY_OR_ATOMICITY"]], ["A-04", a04],
  ["A-05", a05], ["A-06", a06], ["A-07", a07],
  ["A-08", a08, ["CORE_CAPACITY_OR_ATOMICITY"]], ["A-09", a09, ["DURABLE_IDEMPOTENCY"]],
  ["A-10", a10, ["CORE_CAPACITY_OR_ATOMICITY"]], ["A-11", a11, ["CORE_CAPACITY_OR_ATOMICITY"]],
  ["A-12", a12, ["CORE_CAPACITY_OR_ATOMICITY"]], ["A-13", a13, ["CORE_CAPACITY_OR_ATOMICITY"]],
  ["A-14", a14, ["CORE_CAPACITY_OR_ATOMICITY"]], ["A-15", a15, ["EVENT_ATOMICITY_OR_IDENTITY"]],
  ["A-16", a16, ["GANG_ATOMICITY"]],
].map(([id, run, hardCapIds = []]) => Object.freeze({ id, run: (ctx) => guarded(hardCapIds, () => run(ctx)) }));

export default A_CASES;
