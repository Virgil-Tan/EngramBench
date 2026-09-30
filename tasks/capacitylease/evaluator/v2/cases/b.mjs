import assert from "node:assert/strict";

import {
  assertExactError,
  assertFinalSnapshot,
  byId,
  canonical,
  createLease,
  emptySeed,
  gangRequest,
  leaseRequest,
  parseCapturedResponse,
  prepare,
  requireStatus,
  result,
  seededLease,
  sliceFor,
  stableSnapshot,
  waitForSnapshot,
} from "./helpers.mjs";

const CREATE = "/api/v1/capacity-leases";

async function guarded(hardCapIds, operation) {
  try {
    return await operation();
  } catch (error) {
    error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
    throw error;
  }
}

function eventTypes(snapshot, aggregateId) {
  return snapshot.events.filter((event) => event.aggregateId === aggregateId).map(({ type }) => type);
}

function assertConflictEnvelope(response, label) {
  requireStatus(response, 409, label);
  assert.deepEqual(Object.keys(response.json).sort(), ["error"]);
  assert.deepEqual(Object.keys(response.json.error).sort(), ["code", "details", "message"]);
}

async function b01(ctx) {
  const fixture = emptySeed(ctx, "b01", { capacityUnits: 10 });
  const pool = fixture.seed.capacityPools[0];
  const startAt = ctx.at({ hours: 2 });
  const middleAt = ctx.at({ hours: 2, minutes: 10 });
  const endAt = ctx.at({ hours: 2, minutes: 20 });
  const first = seededLease(ctx, fixture.ids, "b01-first", { startAt, endAt: middleAt, units: 6 });
  const second = seededLease(ctx, fixture.ids, "b01-second", { startAt: middleAt, endAt, units: 6 });
  fixture.seed.capacityLeases.push(first, second);
  fixture.seed.capacitySlices.push(sliceFor(pool, first), sliceFor(pool, second));
  const api = await prepare(ctx, { seed: fixture.seed });

  const accepted = await createLease(ctx, api, "b01-peak", leaseRequest(ctx, fixture.ids, "b01", {
    startAt, endAt, units: 4,
  }), 201);
  assert.equal(accepted.json.state, "HELD");
  assertExactError(await ctx.mutate(api.baseUrl, CREATE, ctx.key("b01-real-overlap"), leaseRequest(ctx, fixture.ids, "b01-overlap", {
    startAt, endAt, units: 1,
  })), 409, "CAPACITY_UNAVAILABLE");

  const snapshot = await ctx.snapshot(api.baseUrl);
  assertFinalSnapshot(snapshot);
  const slices = snapshot.resources.capacitySlices.filter((slice) => slice.poolId === pool.poolId);
  assert.deepEqual(slices.map(({ startAt: start, endAt: end, confirmedUnits, heldUnits, availableUnits }) => (
    { startAt: start, endAt: end, confirmedUnits, heldUnits, availableUnits }
  )), [
    { startAt, endAt: middleAt, confirmedUnits: 6, heldUnits: 4, availableUnits: 0 },
    { startAt: middleAt, endAt, confirmedUnits: 6, heldUnits: 4, availableUnits: 0 },
  ]);
  return result(["interval admission uses per-segment peak rather than summing disjoint overlapping aggregates"]);
}

async function b02(ctx) {
  const fixture = emptySeed(ctx, "b02", { capacityUnits: 10 });
  const api = await prepare(ctx, { seed: fixture.seed });
  const t0 = ctx.at({ hours: 1 });
  const tHalf = ctx.at({ hours: 1, minutes: 30 });
  const t1 = ctx.at({ hours: 2 });
  const t2 = ctx.at({ hours: 3 });
  const t3 = ctx.at({ hours: 4 });

  const source = await createLease(ctx, api, "b02-source", leaseRequest(ctx, fixture.ids, "b02-source", {
    startAt: t0, endAt: tHalf, units: 10,
  }), 201);
  await createLease(ctx, api, "b02-first", leaseRequest(ctx, fixture.ids, "b02-first", {
    startAt: t1, endAt: t2, units: 10,
  }), 201);
  await createLease(ctx, api, "b02-adjacent", leaseRequest(ctx, fixture.ids, "b02-adjacent", {
    startAt: t2, endAt: t3, units: 10,
  }), 201);
  const renewed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${source.json.leaseId}/renew`, ctx.key("b02-renew"), {
    expectedRevision: source.json.revision, endAt: t1,
  });
  requireStatus(renewed, 200, "adjacent-boundary renew");
  assert.equal(renewed.json.endAt, t1);

  assertExactError(await ctx.mutate(api.baseUrl, CREATE, ctx.key("b02-one-ms"), leaseRequest(ctx, fixture.ids, "b02-one-ms", {
    startAt: new Date(Date.parse(t2) - 1).toISOString(), endAt: t3, units: 1,
  })), 409, "CAPACITY_UNAVAILABLE");
  const snapshot = await ctx.snapshot(api.baseUrl);
  assertFinalSnapshot(snapshot);
  const boundaries = new Set(snapshot.resources.capacityLeases.flatMap((lease) => [lease.startAt, lease.endAt]));
  for (const slice of snapshot.resources.capacitySlices) {
    assert.ok(boundaries.has(slice.startAt));
    assert.ok(boundaries.has(slice.endAt));
  }
  return result(["half-open adjacent intervals and exact 1 ms overlap are distinguished; renew respects the adjacent boundary"]);
}

async function b03(ctx) {
  const fixture = emptySeed(ctx, "b03", { capacityUnits: 3 });
  const apiOne = await prepare(ctx, { seed: fixture.seed });
  const apiTwo = await ctx.startApi();
  const requests = Array.from({ length: 12 }, (_, priority) => leaseRequest(ctx, fixture.ids, `b03-${priority}`, {
    units: 1, priority, allowWait: true,
  }));
  const responses = await ctx.concurrent(requests, 12, (body, index) => ctx.mutate(
    index % 2 === 0 ? apiOne.baseUrl : apiTwo.baseUrl,
    CREATE,
    ctx.key(`b03-${index}`),
    body,
  ));
  assert.equal(responses.filter(({ status }) => status === 201).length, 3);
  assert.equal(responses.filter(({ status }) => status === 202).length, 9);
  assert.ok(responses.every(({ status }) => status === 201 || status === 202));

  const snapshot = await ctx.snapshot(apiOne.baseUrl);
  assertFinalSnapshot(snapshot);
  for (let index = 0; index < requests.length; index += 1) {
    const matchingLeases = snapshot.resources.capacityLeases.filter(({ priority }) => priority === index);
    const matchingEntries = snapshot.resources.admissionEntries.filter(({ priority }) => priority === index);
    assert.equal(matchingLeases.length + matchingEntries.length, 1, `logical request ${index} did not produce exactly one result`);
    const aggregateId = matchingLeases[0]?.leaseId ?? matchingEntries[0]?.admissionEntryId;
    assert.equal(snapshot.work.filter((work) => work.aggregateId === aggregateId).length, 1);
    assert.equal(snapshot.events.filter((event) => event.aggregateId === aggregateId).length, matchingLeases.length);
  }
  return result(["capacity-edge concurrency maps every logical request to exactly one Lease or WAITING Entry"]);
}

async function b04(ctx) {
  const fixture = emptySeed(ctx, "b04", { capacityUnits: 20 });
  let api = await prepare(ctx, { seed: fixture.seed });
  const port = api.port;
  const shield = await ctx.responseShield(api.baseUrl);

  async function unknown(path, keyLabel, body, options = {}) {
    const before = shield.captures.length;
    shield.dropNextMutation();
    await assert.rejects(() => ctx.mutate(shield.baseUrl, path, ctx.key(keyLabel), body, options));
    assert.equal(shield.captures.length, before + 1);
    const capture = shield.captures.at(-1);
    assert.equal(capture.dropped, true);
    const original = parseCapturedResponse(capture);
    assert.ok(original.status >= 200 && original.status < 300, `${keyLabel} upstream mutation failed: ${original.text}`);
    const replay = await ctx.mutate(api.baseUrl, path, ctx.key(keyLabel), body, options);
    assert.equal(replay.status, original.status);
    assert.equal(canonical(replay.json), canonical(original.json));
    await ctx.stop(api);
    await api.exited;
    api = await ctx.startApi({ port });
    const restartedReplay = await ctx.mutate(api.baseUrl, path, ctx.key(keyLabel), body, options);
    assert.equal(restartedReplay.status, original.status);
    assert.equal(canonical(restartedReplay.json), canonical(original.json));
    return original;
  }

  const created = await unknown(CREATE, "b04-create", leaseRequest(ctx, fixture.ids, "b04-main", { units: 2 }));
  const leaseId = created.json.leaseId;
  const confirmed = await unknown(`/api/v1/capacity-leases/${leaseId}/confirm`, "b04-confirm", {
    holdToken: created.json.holdToken, expectedRevision: created.json.revision,
  });
  const renewed = await unknown(`/api/v1/capacity-leases/${leaseId}/renew`, "b04-renew", {
    expectedRevision: confirmed.json.revision, endAt: ctx.at({ hours: 4 }),
  });
  await unknown(`/api/v1/capacity-leases/${leaseId}/release`, "b04-release", {
    expectedRevision: renewed.json.revision, reason: "unknown-response test",
  });

  await createLease(ctx, api, "b04-blocker", leaseRequest(ctx, fixture.ids, "b04-blocker", {
    startAt: ctx.at({ hours: 10 }), endAt: ctx.at({ hours: 11 }), units: 20,
  }), 201);
  const waiting = await createLease(ctx, api, "b04-waiting", leaseRequest(ctx, fixture.ids, "b04-waiting", {
    startAt: ctx.at({ hours: 10 }), endAt: ctx.at({ hours: 11 }), units: 1, allowWait: true,
  }), 202);
  await unknown(`/api/v1/admission-entries/${waiting.json.admissionEntryId}`, "b04-cancel", {}, { method: "DELETE" });

  const snapshot = await ctx.snapshot(api.baseUrl);
  assertFinalSnapshot(snapshot);
  assert.equal(snapshot.resources.capacityLeases.filter((lease) => lease.leaseId === leaseId).length, 1);
  assert.deepEqual(eventTypes(snapshot, leaseId), ["lease.held", "lease.confirmed", "lease.renewed", "lease.released"]);
  assert.equal(byId(snapshot.resources.admissionEntries, "admissionEntryId", waiting.json.admissionEntryId).state, "CANCELLED");
  return result(["Create, Confirm, Renew, Release, and Cancel survive post-commit response loss and API restart with one saved result/effect"]);
}

async function b05(ctx) {
  const fixture = emptySeed(ctx, "b05", { capacityUnits: 100 });
  const api = await prepare(ctx, { seed: fixture.seed });
  const body = leaseRequest(ctx, fixture.ids, "b05", { units: 1 });
  const key = ctx.key("b05-canonical");
  const original = await ctx.mutate(api.baseUrl, CREATE, key, body);
  requireStatus(original, 201, "canonical request");
  const reordered = Object.fromEntries(Object.entries(body).reverse());
  const replay = await ctx.mutate(api.baseUrl, CREATE, key, reordered);
  assert.equal(replay.status, original.status);
  assert.equal(canonical(replay.json), canonical(original.json));
  const beforeConflict = stableSnapshot(await ctx.snapshot(api.baseUrl));
  assertExactError(await ctx.mutate(api.baseUrl, CREATE, key, { ...body, units: 2 }), 409, "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), beforeConflict);

  const one = original;
  const two = await createLease(ctx, api, "b05-second", leaseRequest(ctx, fixture.ids, "b05-second", {
    startAt: ctx.at({ hours: 5 }), endAt: ctx.at({ hours: 6 }), units: 1,
  }), 201);
  const pathKey = ctx.key("b05-path-scope");
  const confirmOne = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${one.json.leaseId}/confirm`, pathKey, {
    holdToken: one.json.holdToken, expectedRevision: one.json.revision,
  });
  const confirmTwo = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${two.json.leaseId}/confirm`, pathKey, {
    holdToken: two.json.holdToken, expectedRevision: two.json.revision,
  });
  requireStatus(confirmOne, 200, "first canonical path");
  requireStatus(confirmTwo, 200, "second canonical path");

  await ctx.migrate();
  await ctx.migrate();
  const afterMigration = await ctx.mutate(api.baseUrl, CREATE, key, body);
  assert.equal(afterMigration.status, original.status);
  assert.equal(canonical(afterMigration.json), canonical(original.json));
  const final = await ctx.snapshot(api.baseUrl);
  assert.deepEqual(eventTypes(final, one.json.leaseId), ["lease.held", "lease.confirmed"]);
  return result(["idempotency fingerprint is canonical, conflicts are semantic, scope includes canonical aggregate path, and migration preserves replay"]);
}

async function b06(ctx) {
  const fixture = emptySeed(ctx, "b06", { capacityUnits: 100 });
  const apiOne = await prepare(ctx, { seed: fixture.seed });
  const apiTwo = await ctx.startApi();
  const key = ctx.key("b06-shared");
  const body = leaseRequest(ctx, fixture.ids, "b06", { units: 1 });
  const responses = await ctx.concurrent(Array.from({ length: 64 }), 64, (_, index) => ctx.mutate(
    index % 2 === 0 ? apiOne.baseUrl : apiTwo.baseUrl, CREATE, key, body,
  ));
  assert.ok(responses.every(({ status }) => status === 201));
  assert.equal(new Set(responses.map(({ json }) => canonical(json))).size, 1);
  const expected = responses[0];
  const snapshot = await ctx.snapshot(apiOne.baseUrl);
  assert.equal(snapshot.resources.capacityLeases.length, 1);
  assert.equal(snapshot.events.filter(({ type }) => type === "lease.held").length, 1);
  assert.equal(snapshot.work.filter(({ kind }) => kind === "LEASE_EXPIRY").length, 1);
  await Promise.all([ctx.stop(apiOne), ctx.stop(apiTwo)]);
  await Promise.all([apiOne.exited, apiTwo.exited]);
  const apiThree = await ctx.startApi();
  const replay = await ctx.mutate(apiThree.baseUrl, CREATE, key, body);
  assert.equal(replay.status, expected.status);
  assert.equal(canonical(replay.json), canonical(expected.json));
  return result(["64 same-key requests across two APIs converge on one durable response/effect and replay through a third API"]);
}

async function b07(ctx) {
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) await ctx.resetDatabase();
    const fixture = emptySeed(ctx, `b07-${round}`, { capacityUnits: 10 });
    await ctx.migrate();
    await ctx.seed(fixture.seed);
    const apiOne = await ctx.startApi();
    const apiTwo = await ctx.startApi();
    const requests = Array.from({ length: 20 }, (_, priority) => leaseRequest(ctx, fixture.ids, `b07-${round}-${priority}`, {
      units: 2, priority, allowWait: true,
    }));
    const responses = await ctx.concurrent(requests, 20, (body, index) => ctx.mutate(
      index % 2 === 0 ? apiOne.baseUrl : apiTwo.baseUrl,
      CREATE,
      ctx.key(`b07-${round}-${index}`),
      body,
    ));
    assert.equal(responses.filter(({ status }) => status === 201).length, 5);
    assert.equal(responses.filter(({ status }) => status === 202).length, 15);
    const snapshot = await ctx.snapshot(apiOne.baseUrl);
    assertFinalSnapshot(snapshot);
    assert.equal(snapshot.resources.capacityLeases.filter(({ state }) => state === "HELD").length, 5);
    assert.equal(snapshot.resources.admissionEntries.filter(({ state }) => state === "WAITING").length, 15);
    assert.equal(snapshot.work.length, 20);
    assert.equal(snapshot.events.filter(({ type }) => type === "lease.held").length, 5);
  }
  return result(["three isolated hot-capacity interleavings admit exactly oracle capacity and never oversubscribe"]);
}

async function b08(ctx) {
  let group = 0;
  async function isolated(seed) {
    if (group > 0) await ctx.resetDatabase();
    group += 1;
    await ctx.migrate();
    await ctx.seed(seed);
    return ctx.startApi();
  }

  // Confirm vs expiry: hold the claimed expiry Work, let Confirm observe the expired deadline, then release the Worker.
  let fixture = emptySeed(ctx, "b08-confirm-expiry", { capacityUnits: 10 });
  let api = await isolated(fixture.seed);
  const expiring = await createLease(ctx, api, "b08-expiring", leaseRequest(ctx, fixture.ids, "b08-expiring", { holdSeconds: 1 }), 201);
  let barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.aggregateId === expiring.json.leaseId });
  let worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const claimed = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.aggregateId === expiring.json.leaseId, { processes: [worker] });
  assertExactError(await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${expiring.json.leaseId}/confirm`, ctx.key("b08-late-confirm"), {
    holdToken: expiring.json.holdToken, expectedRevision: expiring.json.revision,
  }), 409, "HOLD_EXPIRED");
  barrier.release(claimed);
  let snapshot = await waitForSnapshot(ctx, api, (value) => byId(value.resources.capacityLeases, "leaseId", expiring.json.leaseId).state === "EXPIRED", "confirm-expiry winner", { processes: [worker] });
  assert.deepEqual(eventTypes(snapshot, expiring.json.leaseId), ["lease.held", "lease.expired"]);

  // Renew vs release: both use one current revision and exactly one transition wins.
  fixture = emptySeed(ctx, "b08-renew-release", { capacityUnits: 20 });
  api = await isolated(fixture.seed);
  const apiTwo = await ctx.startApi();
  const held = await createLease(ctx, api, "b08-race-held", leaseRequest(ctx, fixture.ids, "b08-race"), 201);
  const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${held.json.leaseId}/confirm`, ctx.key("b08-race-confirm"), {
    holdToken: held.json.holdToken, expectedRevision: held.json.revision,
  });
  requireStatus(confirmed, 200, "race setup confirm");
  const [renew, release] = await Promise.all([
    ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${held.json.leaseId}/renew`, ctx.key("b08-race-renew"), {
      expectedRevision: confirmed.json.revision, endAt: ctx.at({ hours: 4 }),
    }),
    ctx.mutate(apiTwo.baseUrl, `/api/v1/capacity-leases/${held.json.leaseId}/release`, ctx.key("b08-race-release"), {
      expectedRevision: confirmed.json.revision, reason: "terminal race",
    }),
  ]);
  assert.equal([renew, release].filter(({ status }) => status === 200).length, 1);
  assert.equal([renew, release].filter(({ status }) => status === 409).length, 1);
  assertConflictEnvelope([renew, release].find(({ status }) => status === 409), "renew-release loser");
  snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(eventTypes(snapshot, held.json.leaseId).length, 3);
  assert.deepEqual(snapshot.events.filter(({ aggregateId }) => aggregateId === held.json.leaseId).map(({ sequence }) => sequence), [1, 2, 3]);

  // A retained expiry task cannot overwrite a release after confirmation.
  fixture = emptySeed(ctx, "b08-release-expiry", { capacityUnits: 20 });
  api = await isolated(fixture.seed);
  const releaseHeld = await createLease(ctx, api, "b08-release-held", leaseRequest(ctx, fixture.ids, "b08-release", { holdSeconds: 1 }), 201);
  const releaseConfirmed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${releaseHeld.json.leaseId}/confirm`, ctx.key("b08-release-confirm"), {
    holdToken: releaseHeld.json.holdToken, expectedRevision: releaseHeld.json.revision,
  });
  const released = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${releaseHeld.json.leaseId}/release`, ctx.key("b08-release"), {
    expectedRevision: releaseConfirmed.json.revision, reason: "expiry must not restore",
  });
  requireStatus(released, 200, "release before stale expiry work");
  worker = await ctx.startWorker();
  snapshot = await waitForSnapshot(ctx, api, (value) => {
    const work = value.work.filter((workItem) => workItem.aggregateId === releaseHeld.json.leaseId);
    return work.length > 0 && work.every(({ terminal }) => terminal);
  }, "stale expiry convergence", { processes: [worker] });
  assert.equal(byId(snapshot.resources.capacityLeases, "leaseId", releaseHeld.json.leaseId).state, "RELEASED");
  assert.deepEqual(eventTypes(snapshot, releaseHeld.json.leaseId), ["lease.held", "lease.confirmed", "lease.released"]);

  // Cancel wins after Promotion Work is claimed but before its commit.
  fixture = emptySeed(ctx, "b08-cancel-promotion", { capacityUnits: 10 });
  let blocker = seededLease(ctx, fixture.ids, "b08-cancel-blocker", { units: 10 });
  fixture.seed.capacityLeases.push(blocker);
  fixture.seed.capacitySlices.push(sliceFor(fixture.seed.capacityPools[0], blocker));
  api = await isolated(fixture.seed);
  const waiting = await createLease(ctx, api, "b08-cancel-wait", leaseRequest(ctx, fixture.ids, "b08-cancel-wait", { units: 10, allowWait: true }), 202);
  await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${blocker.leaseId}/release`, ctx.key("b08-unblock"), {
    expectedRevision: blocker.revision, reason: "drive promotion",
  });
  barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.aggregateId === waiting.json.admissionEntryId });
  worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const promotionClaim = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.aggregateId === waiting.json.admissionEntryId, { processes: [worker] });
  requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/admission-entries/${waiting.json.admissionEntryId}`, ctx.key("b08-cancel"), {}, { method: "DELETE" }), 200, "cancel promotion race");
  barrier.release(promotionClaim);
  snapshot = await waitForSnapshot(ctx, api, (value) => byId(value.resources.admissionEntries, "admissionEntryId", waiting.json.admissionEntryId).state === "CANCELLED", "cancel-promotion winner", { processes: [worker] });
  assert.equal(snapshot.resources.capacityLeases.some(({ leaseId }) => leaseId === byId(snapshot.resources.admissionEntries, "admissionEntryId", waiting.json.admissionEntryId).promotedLeaseId), false);

  // Two Worker processes converge on one Promotion effect.
  fixture = emptySeed(ctx, "b08-double-promotion", { capacityUnits: 10 });
  blocker = seededLease(ctx, fixture.ids, "b08-double-blocker", { units: 10 });
  fixture.seed.capacityLeases.push(blocker);
  fixture.seed.capacitySlices.push(sliceFor(fixture.seed.capacityPools[0], blocker));
  api = await isolated(fixture.seed);
  const queued = await createLease(ctx, api, "b08-double-wait", leaseRequest(ctx, fixture.ids, "b08-double-wait", { units: 10, allowWait: true }), 202);
  await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${blocker.leaseId}/release`, ctx.key("b08-double-unblock"), {
    expectedRevision: blocker.revision, reason: "drive duplicate workers",
  });
  const workers = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
  snapshot = await waitForSnapshot(ctx, api, (value) => byId(value.resources.admissionEntries, "admissionEntryId", queued.json.admissionEntryId).state === "PROMOTED", "single Promotion winner", { processes: workers });
  const promoted = byId(snapshot.resources.admissionEntries, "admissionEntryId", queued.json.admissionEntryId);
  assert.equal(snapshot.resources.capacityLeases.filter(({ leaseId }) => leaseId === promoted.promotedLeaseId).length, 1);
  assert.equal(snapshot.events.filter(({ type }) => type === "admission.promoted").length, 1);
  assertFinalSnapshot(snapshot);
  return result(["revision, terminal, cancellation, expiry, and duplicate-Promotion races converge on one legal effect and contiguous events"]);
}

async function b09(ctx) {
  const fixture = emptySeed(ctx, "b09", { poolCount: 2, capacityUnits: 5 });
  const apiOne = await prepare(ctx, { seed: fixture.seed });
  const apiTwo = await ctx.startApi();
  const members = fixture.ids.poolIds.map((poolId) => ({ poolId, units: 5 }));
  const base = gangRequest(ctx, fixture.ids, "b09", 2, {
    members, allowWait: true,
  });
  const reverse = { ...base, members: [...members].reverse() };
  const [one, two] = await Promise.all([
    ctx.mutate(apiOne.baseUrl, CREATE, ctx.key("b09-one"), base),
    ctx.mutate(apiTwo.baseUrl, CREATE, ctx.key("b09-two"), reverse),
  ]);
  assert.equal([one, two].filter(({ status }) => status === 201).length, 1);
  assert.equal([one, two].filter(({ status }) => status === 202 || status === 409).length, 1);
  const snapshot = await ctx.snapshot(apiOne.baseUrl);
  assertFinalSnapshot(snapshot);
  assert.equal(snapshot.resources.capacityLeases.length, 1);
  const lease = snapshot.resources.capacityLeases[0];
  assert.equal(lease.members.length, 2);
  assert.equal(snapshot.resources.gangLeaseMembers.filter(({ leaseId }) => leaseId === lease.leaseId).length, 2);
  assert.equal(new Set(lease.members.map(({ poolId }) => poolId)).size, 2);
  assert.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === lease.leaseId && type === "lease.held").length, 1);
  return result(["reverse Pool input order is deadlock-free and yields one whole Gang plus one whole failure/WAITING result"]);
}

function entryForInterval(snapshot, startAt, endAt) {
  const entries = snapshot.resources.admissionEntries.filter((entry) => entry.startAt === startAt && entry.endAt === endAt);
  assert.equal(entries.length, 1, `expected one Admission Entry for [${startAt}, ${endAt})`);
  return entries[0];
}

function assertGangMembers(snapshot, leaseId, request) {
  const lease = byId(snapshot.resources.capacityLeases, "leaseId", leaseId);
  const expected = [...request.members].sort((left, right) => Buffer.from(left.poolId).compare(Buffer.from(right.poolId)));
  assert.deepEqual(lease.members.map(({ poolId, units }) => ({ poolId, units })), expected);
  const ordinals = lease.members.map(({ ordinal }) => ordinal);
  assert.ok(ordinals.every(Number.isSafeInteger));
  assert.ok(ordinals.every((ordinal, index) => index === 0 || ordinal > ordinals[index - 1]));
}

async function b10(ctx) {
  const fixture = emptySeed(ctx, "b10", { poolCount: 3, capacityUnits: 10 });
  const [poolA, poolB, poolC] = fixture.ids.poolIds;
  const earlyStart = ctx.at({ hours: 2 });
  const earlyEnd = ctx.at({ hours: 4 });
  const overlapEnd = ctx.at({ hours: 3 });
  const nonOverlapEnd = ctx.at({ hours: 5 });
  const blockers = [
    seededLease(ctx, fixture.ids, "b10-early-blocker", { poolId: poolA, startAt: earlyStart, endAt: earlyEnd, units: 10 }),
    seededLease(ctx, fixture.ids, "b10-overlap-blocker", { poolId: poolC, startAt: earlyStart, endAt: overlapEnd, units: 10 }),
    seededLease(ctx, fixture.ids, "b10-nonoverlap-blocker", { poolId: poolC, startAt: earlyEnd, endAt: nonOverlapEnd, units: 10 }),
  ];
  fixture.seed.capacityLeases.push(...blockers);
  for (const blockerLease of blockers) {
    const pool = byId(fixture.seed.capacityPools, "poolId", blockerLease.poolId);
    fixture.seed.capacitySlices.push(sliceFor(pool, blockerLease));
  }
  const api = await prepare(ctx, { seed: fixture.seed });
  const earlierRequest = gangRequest(ctx, fixture.ids, "b10-earlier", 2, {
    startAt: earlyStart, endAt: earlyEnd, priority: 10, allowWait: true,
    members: [{ poolId: poolA, units: 10 }, { poolId: poolB, units: 10 }],
  });
  const overlapRequest = gangRequest(ctx, fixture.ids, "b10-overlap", 2, {
    startAt: earlyStart, endAt: overlapEnd, priority: 1, allowWait: true,
    members: [{ poolId: poolB, units: 10 }, { poolId: poolC, units: 10 }],
  });
  const nonOverlapRequest = gangRequest(ctx, fixture.ids, "b10-nonoverlap", 2, {
    startAt: earlyEnd, endAt: nonOverlapEnd, priority: 1, allowWait: true,
    members: [{ poolId: poolB, units: 10 }, { poolId: poolC, units: 10 }],
  });
  for (const [label, request] of [["earlier", earlierRequest], ["overlap", overlapRequest], ["nonoverlap", nonOverlapRequest]]) {
    requireStatus(await ctx.mutate(api.baseUrl, CREATE, ctx.key(`b10-${label}`), request), 202, `${label} Gang WAITING`);
  }
  let snapshot = await ctx.snapshot(api.baseUrl);
  const earlierEntry = entryForInterval(snapshot, earlyStart, earlyEnd);
  const overlapEntry = entryForInterval(snapshot, earlyStart, overlapEnd);
  const nonOverlapEntry = entryForInterval(snapshot, earlyEnd, nonOverlapEnd);

  for (const blockerLease of blockers.slice(1)) {
    requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${blockerLease.leaseId}/release`, ctx.key(`b10-release-${blockerLease.leaseId}`), {
      expectedRevision: blockerLease.revision, reason: "promotion ordering fixture",
    }), 200, "release Pool C blocker");
  }
  const worker = await ctx.startWorker();
  snapshot = await waitForSnapshot(ctx, api, (value) => byId(value.resources.admissionEntries, "admissionEntryId", nonOverlapEntry.admissionEntryId).state === "PROMOTED", "non-overlap bypass", { processes: [worker] });
  assert.equal(byId(snapshot.resources.admissionEntries, "admissionEntryId", earlierEntry.admissionEntryId).state, "WAITING");
  assert.equal(byId(snapshot.resources.admissionEntries, "admissionEntryId", overlapEntry.admissionEntryId).state, "WAITING");
  assertGangMembers(snapshot, byId(snapshot.resources.admissionEntries, "admissionEntryId", nonOverlapEntry.admissionEntryId).promotedLeaseId, nonOverlapRequest);

  requireStatus(await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${blockers[0].leaseId}/release`, ctx.key("b10-release-early"), {
    expectedRevision: blockers[0].revision, reason: "allow earlier Gang",
  }), 200, "release earlier blocker");
  snapshot = await waitForSnapshot(ctx, api, (value) => byId(value.resources.admissionEntries, "admissionEntryId", earlierEntry.admissionEntryId).state === "PROMOTED", "earlier Gang Promotion", { processes: [worker] });
  const promotedEarlier = byId(snapshot.resources.admissionEntries, "admissionEntryId", earlierEntry.admissionEntryId);
  assert.equal(byId(snapshot.resources.admissionEntries, "admissionEntryId", overlapEntry.admissionEntryId).state, "WAITING");
  assertGangMembers(snapshot, promotedEarlier.promotedLeaseId, earlierRequest);
  assertFinalSnapshot(snapshot);
  return result(["Gang Promotion preserves all Members, permits only non-overlap bypass, and remains atomic across every Member Pool"]);
}

export const B_CASES = [
  ["B-01", b01, ["CORE_CAPACITY_OR_ATOMICITY"]], ["B-02", b02, ["CORE_CAPACITY_OR_ATOMICITY"]],
  ["B-03", b03, ["CORE_CAPACITY_OR_ATOMICITY"]], ["B-04", b04, ["DURABLE_IDEMPOTENCY"]],
  ["B-05", b05, ["DURABLE_IDEMPOTENCY"]], ["B-06", b06, ["DURABLE_IDEMPOTENCY"]],
  ["B-07", b07, ["CORE_CAPACITY_OR_ATOMICITY"]],
  ["B-08", b08, ["CORE_CAPACITY_OR_ATOMICITY", "EVENT_ATOMICITY_OR_IDENTITY"]],
  ["B-09", b09, ["GANG_ATOMICITY"]], ["B-10", b10, ["GANG_ATOMICITY"]],
].map(([id, run, hardCapIds]) => Object.freeze({ id, run: (ctx) => guarded(hardCapIds, () => run(ctx)) }));

export default B_CASES;
