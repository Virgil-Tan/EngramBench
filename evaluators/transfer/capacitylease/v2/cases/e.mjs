import { candidateAssert as assert } from "../lib/execution.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { makePerformanceFixture } from "../lib/fixtures.mjs";
import { assertCapacityConserved, assertCapacitySlices, buildCapacitySlices } from "../lib/oracle.mjs";
import { CaseExcluded } from "../lib/execution.mjs";
import {
  assertFinalSnapshot,
  collection,
  emptySeed,
  leaseRequest,
  requireStatus,
  stableSnapshot,
} from "./helpers.mjs";

const REQUIRED_SCRIPTS = [
  "db:migrate", "db:seed", "dev", "build", "start:api", "start:worker", "start:dispatcher",
  "test:unit", "test:integration", "test:e2e", "test:concurrency", "test:recovery", "test:all", "test:perf",
];

function requireV1(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
}

function withCaps(error, hardCapIds) {
  error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
  return error;
}

async function installBuildMigrate(ctx, workspace) {
  const view = ctx.forWorkspace(workspace);
  await view.command("npm", ["ci", "--no-audit", "--no-fund"], { timeoutMs: 600_000 });
  await view.npm("build", [], { timeoutMs: 600_000 });
  await view.migrate({ timeoutMs: 300_000 });
  return view;
}

function performanceFixture(ctx) {
  return makePerformanceFixture({
    evaluationSeed: ctx.evaluationSeed,
    caseId: ctx.caseId,
    baseTime: ctx.fixtures.baseTime,
  });
}

function migrationFixture(ctx) {
  const { ids, seed } = emptySeed(ctx, "migration", { poolCount: 3, capacityUnits: 100 });
  const lease = (label, state, startOffset, endOffset, overrides = {}) => ({
    leaseId: ctx.uuid(`migration-${label}`),
    poolId: ids.poolIds[0],
    ownerId: ids.ownerId,
    startAt: ctx.at(startOffset),
    endAt: ctx.at(endOffset),
    units: 10,
    priority: 0,
    state,
    holdExpiresAt: state === "HELD" ? ctx.at({ minutes: 30 }) : null,
    revision: state === "RELEASED" || state === "EXPIRED" ? 2 : 1,
    createdAt: ctx.at({ days: -10 }),
    terminalAt: state === "RELEASED" || state === "EXPIRED" ? ctx.at({ days: -1 }) : null,
    sequence: 1,
    ...overrides,
  });
  const leases = [
    lease("held", "HELD", { hours: 2 }, { hours: 3 }),
    lease("confirmed", "CONFIRMED", { hours: 4 }, { hours: 5 }),
    lease("active", "ACTIVE", { hours: -1 }, { hours: 1 }),
    lease("released", "RELEASED", { days: -3 }, { days: -3, hours: 1 }),
    lease("expired", "EXPIRED", { days: -2 }, { days: -2, hours: 1 }),
  ];
  const admissions = [
    {
      admissionEntryId: ctx.uuid("migration-waiting"),
      poolId: ids.poolIds[0], ownerId: ids.ownerId,
      startAt: leases[0].startAt, endAt: leases[0].endAt,
      units: 100, priority: 5, state: "WAITING", promotedLeaseId: null,
      requestedAt: ctx.at({ days: -1, minutes: 1 }), terminalAt: null,
    },
    {
      admissionEntryId: ctx.uuid("migration-cancelled"),
      poolId: ids.poolIds[1], ownerId: ids.ownerId,
      startAt: ctx.at({ hours: 6 }), endAt: ctx.at({ hours: 7 }),
      units: 1, priority: 1, state: "CANCELLED", promotedLeaseId: null,
      requestedAt: ctx.at({ days: -1, minutes: 2 }), terminalAt: ctx.at({ days: -1, minutes: 3 }),
    },
    {
      admissionEntryId: ctx.uuid("migration-promoted"),
      poolId: leases[1].poolId, ownerId: leases[1].ownerId,
      startAt: leases[1].startAt, endAt: leases[1].endAt,
      units: leases[1].units, priority: leases[1].priority, state: "PROMOTED",
      promotedLeaseId: leases[1].leaseId,
      requestedAt: ctx.at({ days: -1, minutes: 4 }), terminalAt: ctx.at({ days: -1, minutes: 5 }),
    },
  ];
  return {
    ids,
    seed: {
      ...seed,
      seedVersion: "migration-v1",
      capacityLeases: leases,
      admissionEntries: admissions,
      capacitySlices: buildCapacitySlices({ pools: seed.capacityPools, leases }),
    },
  };
}

function withoutMembers(lease) {
  const { members: _members, ...legacy } = lease;
  return legacy;
}

function responseJson(capture) {
  return JSON.parse(capture.response.body);
}

export function percentile(samples, quantile) {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  const ordered = [...samples].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(quantile * ordered.length));
  return ordered[Math.min(rank - 1, ordered.length - 1)];
}

/** Exact closed-loop clients: warm-up is discarded before the measured phase. */
export async function runClosedLoop({ concurrency, warmupMs, measureMs, operation }) {
  let ordinal = 0;
  const runPhase = async (phase, durationMs) => {
    const metrics = {
      attempts: 0,
      successes: 0,
      totalSuccesses: 0,
      unexpected5xx: 0,
      expectedConflicts: 0,
      mismatches: 0,
      waiting: 0,
      latencies: [],
    };
    const deadline = performance.now() + durationMs;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (performance.now() < deadline) {
        const current = ordinal;
        ordinal += 1;
        metrics.attempts += 1;
        const startedAt = performance.now();
        try {
          const outcome = await operation({ phase, ordinal: current });
          const latencyMs = outcome?.latencyMs ?? performance.now() - startedAt;
          const completedWithinWindow = performance.now() <= deadline;
          if (outcome?.success) metrics.totalSuccesses += 1;
          if (outcome?.success && completedWithinWindow) {
            metrics.successes += 1;
            metrics.latencies.push(latencyMs);
          }
          if ((outcome?.status ?? 0) >= 500) metrics.unexpected5xx += 1;
          if (outcome?.expectedConflict) metrics.expectedConflicts += 1;
          if (outcome?.mismatch) metrics.mismatches += 1;
          if (outcome?.waiting) metrics.waiting += 1;
        } catch {
          // A network/protocol failure is an unsuccessful measured operation.
        }
      }
    }));
    return metrics;
  };
  return {
    warmup: await runPhase("warmup", warmupMs),
    measured: await runPhase("measured", measureMs),
  };
}

async function populatedMigration(ctx) {
  requireV1(ctx);
  try {
    const fixture = migrationFixture(ctx);
    const v1 = await installBuildMigrate(ctx, ctx.v1Workspace);
    await v1.seed(fixture.seed, { timeoutMs: 600_000 });
    const v1Api = await v1.startApi();
    const before = await ctx.snapshot(v1Api.baseUrl);
    await ctx.stop(v1Api);

    const final = await installBuildMigrate(ctx, ctx.workspace);
    let finalApi = await final.startApi();
    const after = await ctx.snapshot(finalApi.baseUrl);

    for (const key of ["owners", "capacityPools", "admissionEntries", "capacitySlices"]) {
      assert.deepEqual(after.resources[key], before.resources[key], `${key} changed during migration`);
    }
    assert.deepEqual(after.work, before.work, "Work identity or lease data changed during migration");
    assert.deepEqual(after.events, before.events, "event identity or body changed during migration");
    assert.equal(after.resources.capacityLeases.length, before.resources.capacityLeases.length);
    assert.equal(after.resources.gangLeaseMembers.length, before.resources.capacityLeases.length);
    for (const legacy of before.resources.capacityLeases) {
      const migrated = after.resources.capacityLeases.find(({ leaseId }) => leaseId === legacy.leaseId);
      assert.deepEqual(withoutMembers(migrated), legacy, `legacy Lease ${legacy.leaseId} changed`);
      const members = after.resources.gangLeaseMembers.filter(({ leaseId }) => leaseId === legacy.leaseId);
      assert.equal(members.length, 1, `legacy Lease ${legacy.leaseId} was not backfilled exactly once`);
      assert.equal(Number.isSafeInteger(members[0].ordinal), true, "backfilled Member ordinal is not a safe integer");
      assert.equal(members[0].poolId, legacy.poolId);
      assert.equal(members[0].units, legacy.units);
    }

    await ctx.stop(finalApi);
    await final.migrate({ timeoutMs: 300_000 });
    finalApi = await final.startApi();
    const replayed = await ctx.snapshot(finalApi.baseUrl);
    assert.deepEqual(stableSnapshot(replayed), stableSnapshot(after), "migration replay changed identities or state");

    const legacyRequest = leaseRequest(ctx, fixture.ids, "migration-old-client", {
      startAt: ctx.at({ days: 4 }), endAt: ctx.at({ days: 4, hours: 1 }), units: 3,
    });
    const created = await ctx.mutate(finalApi.baseUrl, "/api/v1/capacity-leases", ctx.key("migration-old-client"), legacyRequest);
    requireStatus(created, 201, "legacy create after migration");
    assert.equal(created.json.poolId, legacyRequest.poolId);
    assert.equal(created.json.units, legacyRequest.units);
    const listed = await ctx.request(finalApi.baseUrl, `/api/v1/capacity-leases/${created.json.leaseId}/members`);
    requireStatus(listed, 200, "legacy member read");
    assert.equal(collection(listed).length, 1);

    return { evidence: ["populated V1 resources preserved", "one Member per legacy Lease", "repeatable migration", "old client remains valid"] };
  } catch (error) {
    throw withCaps(error, ["MIGRATION_COMPATIBILITY"]);
  }
}

async function replayMigration(ctx) {
  requireV1(ctx);
  try {
    const fixture = emptySeed(ctx, "migration-replay", { poolCount: 1, capacityUnits: 10 });
    const v1 = await installBuildMigrate(ctx, ctx.v1Workspace);
    await v1.seed(fixture.seed, { timeoutMs: 600_000 });
    const v1Api = await v1.startApi();
    const shield = await ctx.responseShield(v1Api.baseUrl);
    const request = leaseRequest(ctx, fixture.ids, "migration-replay", { units: 2 });
    const key = ctx.key("migration-unknown-response");
    shield.dropNextMutation();
    await assert.rejects(ctx.mutate(shield.baseUrl, "/api/v1/capacity-leases", key, request));
    await ctx.waitFor(() => shield.captures.length === 1, { label: "saved unknown response" });
    const captured = shield.captures[0];
    assert.equal(captured.response.status, 201);
    const original = responseJson(captured);
    const retryBefore = await ctx.mutate(v1Api.baseUrl, "/api/v1/capacity-leases", key, request);
    assert.equal(retryBefore.status, captured.response.status);
    assert.deepEqual(retryBefore.json, original);
    const conflictBefore = await ctx.mutate(v1Api.baseUrl, "/api/v1/capacity-leases", key, { ...request, units: 3 });
    requireStatus(conflictBefore, 409, "V1 replay conflict");
    assert.equal(conflictBefore.json?.error?.code, "IDEMPOTENCY_CONFLICT");
    const before = await ctx.snapshot(v1Api.baseUrl);
    const beforeEvents = before.events.filter(({ aggregateId }) => aggregateId === original.leaseId);
    assert.ok(beforeEvents.length > 0, "V1 success has no committed event");
    await ctx.stop(v1Api);

    const final = await installBuildMigrate(ctx, ctx.workspace);
    const finalApi = await final.startApi();
    const retryAfter = await ctx.mutate(finalApi.baseUrl, "/api/v1/capacity-leases", key, request);
    assert.equal(retryAfter.status, captured.response.status);
    assert.deepEqual(retryAfter.json, original, "saved V1 response was rewritten during migration");
    assert.equal(Object.hasOwn(retryAfter.json, "members"), false, "new members field leaked into saved V1 replay body");
    const conflictAfter = await ctx.mutate(finalApi.baseUrl, "/api/v1/capacity-leases", key, { ...request, units: 3 });
    requireStatus(conflictAfter, 409, "FINAL replay conflict");
    assert.equal(conflictAfter.json?.error?.code, "IDEMPOTENCY_CONFLICT");
    const after = await ctx.snapshot(finalApi.baseUrl);
    assert.deepEqual(after.events.filter(({ aggregateId }) => aggregateId === original.leaseId), beforeEvents);

    return { evidence: ["unknown-response replay preserved", "conflict fingerprint preserved", "event identity and body preserved"] };
  } catch (error) {
    throw withCaps(error, ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY", "EVENT_ATOMICITY_OR_IDENTITY"]);
  }
}

async function recoveryMigration(ctx) {
  requireV1(ctx);
  try {
    const fixture = emptySeed(ctx, "migration-recovery", { poolCount: 1, capacityUnits: 1 });
    const v1 = await installBuildMigrate(ctx, ctx.v1Workspace);
    await v1.seed(fixture.seed, { timeoutMs: 600_000 });
    const v1Api = await v1.startApi();
    const interval = { startAt: ctx.at({ hours: 6 }), endAt: ctx.at({ hours: 7 }) };
    const held = await ctx.mutate(v1Api.baseUrl, "/api/v1/capacity-leases", ctx.key("migration-due"), {
      ...leaseRequest(ctx, fixture.ids, "migration-due"), ...interval, units: 1, holdSeconds: 1,
    });
    requireStatus(held, 201, "V1 due Hold");
    const waiting = await ctx.mutate(v1Api.baseUrl, "/api/v1/capacity-leases", ctx.key("migration-waiting"), {
      ...leaseRequest(ctx, fixture.ids, "migration-waiting"), ...interval, units: 1, allowWait: true,
    });
    requireStatus(waiting, 202, "V1 waiting Entry");

    let acceptDelivery = false;
    const receiver = await ctx.receiver({ behavior: () => ({ status: acceptDelivery ? 204 : 500 }) });
    const v1Dispatcher = await v1.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => receiver.ledger.length >= 2, { label: "V1 event retries", processes: [v1Dispatcher] });

    const holdExpiresAt = Date.parse(held.json.holdExpiresAt);
    assert.ok(Number.isFinite(holdExpiresAt), "V1 Hold returned an invalid holdExpiresAt");
    await ctx.waitFor(() => Date.now() > holdExpiresAt, { label: "observed V1 Hold expiry", intervalMs: 10 });
    const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" });
    const workerEnvironment = {
      TEST_BARRIER_URL: barrier.url,
      TEST_BARRIER_TOKEN: barrier.token,
      WORK_LEASE_SECONDS: "1",
    };
    // One held worker makes the other scheduled Work deterministically remain PENDING.
    const v1Workers = [await v1.startWorker({ env: workerEnvironment })];
    await barrier.waitFor(({ json }) => json?.point === "worker.claimed", { timeoutMs: 30_000 });
    const before = await ctx.snapshot(v1Api.baseUrl);
    assert.ok(before.work.some(({ state }) => state === "LEASED"), "no leased V1 Work was captured");
    assert.ok(before.work.some(({ state }) => state === "PENDING"), "no pending V1 Work was captured");
    await Promise.all(v1Workers.map((record) => ctx.kill(record)));
    barrier.releaseAll();
    await ctx.kill(v1Dispatcher);
    await ctx.stop(v1Api);

    const final = await installBuildMigrate(ctx, ctx.workspace);
    const finalApi = await final.startApi();
    const migrated = await ctx.snapshot(finalApi.baseUrl);
    const migratedWork = new Map(migrated.work.map((item) => [item.workId, item]));
    for (const item of before.work) {
      assert.deepEqual(migratedWork.get(item.workId), item, `Work ${item.workId} was lost or changed during migration`);
    }
    assert.deepEqual(migrated.events, before.events, "undelivered event state changed during migration");

    acceptDelivery = true;
    const leasedDeadlines = migrated.work
      .filter(({ state, leaseExpiresAt }) => state === "LEASED" && leaseExpiresAt !== null)
      .map(({ leaseExpiresAt }) => Date.parse(leaseExpiresAt));
    assert.ok(leasedDeadlines.length > 0 && leasedDeadlines.every(Number.isFinite), "migrated LEASED Work has no observable expiry");
    const reclaimAfter = Math.max(...leasedDeadlines);
    await ctx.waitFor(() => Date.now() > reclaimAfter, { label: "observed migrated Work lease expiry", intervalMs: 10 });
    const replacements = await Promise.all([final.startWorker(), final.startWorker()]);
    const finalDispatcher = await final.startDispatcher({ webhookUrl: receiver.url });
    const completed = await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(finalApi.baseUrl);
      const lease = snapshot.resources.capacityLeases.find(({ leaseId }) => leaseId === held.json.leaseId);
      const admission = snapshot.resources.admissionEntries.find(({ admissionEntryId }) => admissionEntryId === waiting.json.admissionEntryId);
      const pending = snapshot.work.filter(({ kind, terminal }) => ["LEASE_EXPIRY", "ADMISSION_PROMOTION"].includes(kind) && !terminal);
      return lease?.state === "EXPIRED" && admission?.state === "PROMOTED" && pending.length === 0 ? snapshot : undefined;
    }, { timeoutMs: 60_000, intervalMs: 250, label: "FINAL replacement recovery", processes: [...replacements, finalDispatcher] });
    assertCapacityConserved({
      pools: completed.resources.capacityPools,
      leases: completed.resources.capacityLeases,
      members: completed.resources.gangLeaseMembers,
    });
    const successful = receiver.ledger.filter(({ responseStatus }) => responseStatus === 204);
    assert.ok(successful.length > 0, "replacement dispatcher did not deliver events");
    const bodies = new Map();
    for (const entry of receiver.ledger) {
      const eventId = entry.headers["x-capacitylease-event-id"];
      if (!eventId) continue;
      if (bodies.has(eventId)) assert.equal(entry.raw, bodies.get(eventId), `event ${eventId} changed across retry`);
      else bodies.set(eventId, entry.raw);
    }

    return { evidence: ["leased and pending Work preserved", "stale workers fenced", "replacement recovery completed", "delivery identity preserved"] };
  } catch (error) {
    throw withCaps(error, ["MIGRATION_COMPATIBILITY", "RECOVERY_OR_FENCING", "EVENT_ATOMICITY_OR_IDENTITY"]);
  }
}

async function preparePerformance(ctx) {
  const fixture = performanceFixture(ctx);
  await ctx.command("npm", ["ci", "--no-audit", "--no-fund"], { timeoutMs: 600_000 });
  await ctx.npm("build", [], { timeoutMs: 600_000 });
  await ctx.migrate({ timeoutMs: 300_000 });
  await ctx.seed(fixture.seed, { timeoutMs: 1_200_000 });
  const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
  return { fixture, api };
}

async function timelinePerformance(ctx) {
  const { fixture, api } = await preparePerformance(ctx);
  const pools = fixture.seed.capacityPools;
  const expectedByPool = new Map(pools.map(({ poolId }) => {
    const interval = fixture.timelineIntervals.get(poolId);
    const expected = fixture.seed.capacitySlices.filter((slice) => (
      slice.poolId === poolId && slice.startAt >= interval.from && slice.endAt <= interval.to
    ));
    return [poolId, { interval, expected }];
  }));
  let selector = 0;
  const metrics = await runClosedLoop({
    concurrency: 64,
    warmupMs: 10_000,
    measureMs: 60_000,
    operation: async () => {
      const pool = pools[selector % pools.length];
      selector += 1;
      const { interval, expected } = expectedByPool.get(pool.poolId);
      const response = await ctx.request(api.baseUrl,
        `/api/v1/capacity-pools/${pool.poolId}/timeline?from=${encodeURIComponent(interval.from)}&to=${encodeURIComponent(interval.to)}`,
        { timeoutMs: 5_000 });
      let mismatch = false;
      if (response.status === 200) {
        try { assert.deepEqual(collection(response), expected); } catch { mismatch = true; }
      }
      return { status: response.status, latencyMs: response.durationMs, success: response.status === 200 && !mismatch, mismatch };
    },
  });
  const throughput = metrics.measured.successes / 60;
  const p95 = percentile(metrics.measured.latencies, 0.95);
  assert.equal(metrics.measured.unexpected5xx, 0, "timeline workload returned unexpected 5xx");
  assert.equal(metrics.measured.mismatches, 0, "timeline workload returned mixed or invalid Slices");
  assert.ok(throughput >= 400, `timeline throughput ${throughput.toFixed(2)}/s is below 400/s`);
  assert.ok(p95 <= 120, `timeline p95 ${p95.toFixed(2)}ms exceeds 120ms`);
  try {
    assertFinalSnapshot(await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 }));
  } catch (error) {
    throw withCaps(error, ["CORE_CAPACITY_OR_ATOMICITY"]);
  }
  return { evidence: [{ scenarioId: "pool-timeline-read", throughput, p95, attempts: metrics.measured.attempts }] };
}

async function holdPerformance(ctx) {
  const { fixture, api } = await preparePerformance(ctx);
  const pools = fixture.seed.capacityPools;
  const owners = [...fixture.seed.owners].sort((left, right) => Buffer.from(left.ownerId).compare(Buffer.from(right.ownerId)));
  const createdIds = new Set();
  const startEpoch = Date.parse(fixture.freshHoldStart);
  const metrics = await runClosedLoop({
    concurrency: 64,
    warmupMs: 10_000,
    measureMs: 60_000,
    operation: async ({ ordinal }) => {
      const pool = pools[ordinal % pools.length];
      const round = Math.floor(ordinal / pools.length);
      const owner = owners[round % owners.length];
      const startAt = new Date(startEpoch + round * 60_000).toISOString();
      const endAt = new Date(startEpoch + (round + 1) * 60_000).toISOString();
      const response = await ctx.mutate(api.baseUrl, "/api/v1/capacity-leases", ctx.key(`perf-hold-${ordinal}`), {
        poolId: pool.poolId,
        ownerId: owner.ownerId,
        startAt,
        endAt,
        units: 1,
        priority: 0,
        allowWait: false,
      }, { timeoutMs: 5_000 });
      const success = response.status === 201 && response.json?.state === "HELD" && typeof response.json?.leaseId === "string";
      if (success) createdIds.add(response.json.leaseId);
      return {
        status: response.status,
        latencyMs: response.durationMs,
        success,
        waiting: response.status === 202,
        expectedConflict: response.status === 409,
      };
    },
  });
  const throughput = metrics.measured.successes / 60;
  const p95 = percentile(metrics.measured.latencies, 0.95);
  assert.equal(metrics.measured.unexpected5xx, 0, "hold workload returned unexpected 5xx");
  assert.equal(metrics.measured.waiting, 0, "independent Holds unexpectedly entered Admission");
  assert.equal(metrics.measured.expectedConflicts, 0, "disjoint independent Holds unexpectedly conflicted");
  assert.ok(throughput >= 120, `hold throughput ${throughput.toFixed(2)}/s is below 120/s`);
  assert.ok(p95 <= 350, `hold p95 ${p95.toFixed(2)}ms exceeds 350ms`);

  const snapshot = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
  try {
    assertFinalSnapshot(snapshot);
    assert.equal(createdIds.size, metrics.warmup.totalSuccesses + metrics.measured.totalSuccesses,
      "successful responses did not have unique effects");
    assert.equal(snapshot.resources.capacityLeases.length, 40_000 + createdIds.size, "post-load Lease effects do not match successful responses");
  } catch (error) {
    throw withCaps(error, ["CORE_CAPACITY_OR_ATOMICITY", "DURABLE_IDEMPOTENCY"]);
  }
  return { evidence: [{ scenarioId: "independent-hold-create", throughput, p95, successfulMutations: metrics.measured.successes }] };
}

export function assertRecoveryPromotions(completed, fixture) {
  const expectedAdmissions = new Map(fixture.seed.admissionEntries.map((entry) => [entry.admissionEntryId, entry]));
  assert.equal(completed.resources.admissionEntries.length, expectedAdmissions.size, "recovery changed the Admission Entry count");
  assert.equal(completed.resources.capacityLeases.length, fixture.seed.capacityLeases.length + expectedAdmissions.size,
    "recovery did not create exactly one promoted Lease per Admission Entry");
  const leases = new Map(completed.resources.capacityLeases.map((lease) => [lease.leaseId, lease]));
  assert.equal(leases.size, completed.resources.capacityLeases.length, "recovery produced duplicate Lease identities");
  const promotedLeaseIds = new Set();
  for (const actual of completed.resources.admissionEntries) {
    const expected = expectedAdmissions.get(actual.admissionEntryId);
    assert.ok(expected, `unexpected Admission Entry ${actual.admissionEntryId}`);
    assert.equal(actual.state, "PROMOTED", `Admission Entry ${actual.admissionEntryId} did not promote`);
    assert.equal(typeof actual.promotedLeaseId, "string", `Admission Entry ${actual.admissionEntryId} has no promoted Lease`);
    assert.equal(promotedLeaseIds.has(actual.promotedLeaseId), false, "two Admission Entries reference the same promoted Lease");
    promotedLeaseIds.add(actual.promotedLeaseId);
    const lease = leases.get(actual.promotedLeaseId);
    assert.ok(lease, `promoted Lease ${actual.promotedLeaseId} is missing`);
    assert.equal(lease.state, "HELD");
    for (const field of ["poolId", "ownerId", "startAt", "endAt", "units", "priority"]) {
      assert.equal(lease[field], expected[field], `promoted Lease ${actual.promotedLeaseId} changed ${field}`);
    }
  }
  assert.equal(promotedLeaseIds.size, expectedAdmissions.size);
}

async function recoveryPerformance(ctx) {
  const { fixture, api } = await preparePerformance(ctx);
  const dueLeaseIds = new Set(fixture.dueLeaseIds);
  const waitingEntryIds = new Set(fixture.waitingEntryIds);
  const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" });
  const workerEnvironment = {
    TEST_BARRIER_URL: barrier.url,
    TEST_BARRIER_TOKEN: barrier.token,
    WORK_LEASE_SECONDS: "1",
  };
  const victims = await Promise.all([
    ctx.startWorker({ env: workerEnvironment }),
    ctx.startWorker({ env: workerEnvironment }),
  ]);
  await ctx.waitFor(() => {
    const claimed = barrier.ledger.filter(({ json }) => json?.point === "worker.claimed");
    return new Set(claimed.map(({ json }) => json.workId)).size >= 2;
  }, { timeoutMs: 30_000, label: "two claimed Work barriers", processes: victims });
  const claimedWorkIds = new Set(barrier.ledger
    .filter(({ json }) => json?.point === "worker.claimed")
    .map(({ json }) => json.workId));
  const leasedWork = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const claimed = snapshot.work.filter(({ workId, state, leaseExpiresAt }) => (
      claimedWorkIds.has(workId) && state === "LEASED" && leaseExpiresAt !== null
    ));
    return claimed.length >= 2 ? claimed : undefined;
  }, { label: "claimed performance Work leases", processes: victims });
  const reclaimAfter = Math.max(...leasedWork.map(({ leaseExpiresAt }) => Date.parse(leaseExpiresAt)));
  assert.ok(Number.isFinite(reclaimAfter), "claimed performance Work has no observable lease expiry");
  await Promise.all(victims.map((record) => ctx.kill(record)));
  barrier.releaseAll();
  await ctx.waitFor(() => Date.now() > reclaimAfter, { label: "observed performance Work lease expiry", intervalMs: 10 });

  const replacements = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
  const startedAt = Math.max(...replacements.map(({ spawnedAt }) => spawnedAt));
  let completed;
  try {
    completed = await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
      const dueStates = new Map(snapshot.resources.capacityLeases
        .filter(({ leaseId }) => dueLeaseIds.has(leaseId))
        .map(({ leaseId, state }) => [leaseId, state]));
      const waitingStates = new Map(snapshot.resources.admissionEntries
        .filter(({ admissionEntryId }) => waitingEntryIds.has(admissionEntryId))
        .map((entry) => [entry.admissionEntryId, entry]));
      const nonterminal = snapshot.work.filter(({ kind, terminal }) => (
        ["LEASE_EXPIRY", "ADMISSION_PROMOTION"].includes(kind) && !terminal
      ));
      const failed = snapshot.work.filter(({ kind, state }) => (
        ["LEASE_EXPIRY", "ADMISSION_PROMOTION"].includes(kind) && state === "FAILED"
      ));
      return dueStates.size === 10_000
        && [...dueStates.values()].every((state) => state === "EXPIRED")
        && waitingStates.size === 10_000
        && [...waitingStates.values()].every(({ state, promotedLeaseId }) => (
          state === "PROMOTED" && typeof promotedLeaseId === "string"
        ))
        && nonterminal.length === 0
        && failed.length === 0
        ? snapshot
        : undefined;
    }, { timeoutMs: 90_000, intervalMs: 1_000, label: "20,000 recovery transitions", processes: replacements });
  } catch (error) {
    throw withCaps(error, ["RECOVERY_OR_FENCING"]);
  }
  const drainMs = performance.now() - startedAt;
  try {
    assert.ok(drainMs <= 90_000, `recovery drain took ${drainMs.toFixed(0)}ms`);
    assertFinalSnapshot(completed);
    assertRecoveryPromotions(completed, fixture);
  } catch (error) {
    throw withCaps(error, ["CORE_CAPACITY_OR_ATOMICITY", "RECOVERY_OR_FENCING"]);
  }
  return { evidence: [{ scenarioId: "expiry-promotion-recovery", drainMs, expired: 10_000, promoted: 10_000 }] };
}

async function cleanupAndReproducibility(ctx) {
  const packageJson = JSON.parse(await readFile(join(ctx.workspace, "package.json"), "utf8"));
  for (const script of REQUIRED_SCRIPTS) assert.equal(typeof packageJson.scripts?.[script], "string", `missing npm script ${script}`);
  const sourceBefore = await ctx.command("git", ["status", "--porcelain", "--untracked-files=all"], { allowFailure: true });
  await ctx.migrate({ timeoutMs: 300_000 });
  const fixture = emptySeed(ctx, "operability", { poolCount: 1, capacityUnits: 10 });
  const rawSeed = JSON.stringify(fixture.seed);
  const seeded = await ctx.seed(fixture.seed, { timeoutMs: 600_000 });
  assert.equal(seeded.exitCode, 0);
  const firstApi = await ctx.startApi();
  const first = await ctx.snapshot(firstApi.baseUrl);

  const receiver = await ctx.receiver();
  const worker = await ctx.startWorker();
  const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(worker.child.exitCode, null, `worker exited early: ${worker.logs}`);
  assert.equal(dispatcher.child.exitCode, null, `dispatcher exited early: ${dispatcher.logs}`);
  const idempotencyKey = ctx.key("operability-create");
  const created = await ctx.mutate(firstApi.baseUrl, "/api/v1/capacity-leases", idempotencyKey,
    leaseRequest(ctx, fixture.ids, "operability-create"));
  requireStatus(created, 201, "operability create");
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const roleLogs = [firstApi, worker, dispatcher].map(({ logs }) => logs).join("\n");
  for (const secret of [ctx.adminToken, ctx.barrierToken, idempotencyKey, rawSeed]) {
    assert.equal(roleLogs.includes(secret), false, "Candidate process logs leaked a token, key, or raw seed");
  }
  assert.equal(roleLogs.includes(ctx.temporary), false, "Candidate process logs leaked a private absolute path");

  for (const record of [dispatcher, worker, firstApi]) {
    await ctx.stop(record);
    assert.equal(record.forcedKill, undefined, `${record.role} ignored normal termination`);
  }
  await assert.rejects(ctx.request(firstApi.baseUrl, "/healthz", { timeoutMs: 500 }));

  const invalid = await ctx.seed({ ...fixture.seed, hiddenUnknownMember: [] }, { allowFailure: true, contractExpectation: 'invalid', timeoutMs: 600_000 });
  assert.notEqual(invalid.exitCode, 0, "invalid seed command exited zero");

  await ctx.resetDatabase();
  await ctx.migrate({ timeoutMs: 300_000 });
  await ctx.seed(fixture.seed, { timeoutMs: 600_000 });
  const secondApi = await ctx.startApi();
  const second = await ctx.snapshot(secondApi.baseUrl);
  assert.deepEqual(stableSnapshot(second), stableSnapshot(first), "same seed did not reproduce public state");
  await ctx.stop(secondApi);

  const sourceAfter = await ctx.command("git", ["status", "--porcelain", "--untracked-files=all"], { allowFailure: true });
  if (sourceBefore.exitCode === 0 && sourceAfter.exitCode === 0) {
    assert.equal(sourceAfter.stdout, sourceBefore.stdout, "evaluation commands polluted Submission source state");
  }
  return { evidence: ["published scripts present", "normal process cleanup", "log hygiene", "deterministic replay", "no source pollution"] };
}

export const E_CASES = [
  { id: "E-01", async run(ctx) { return populatedMigration(ctx); } },
  { id: "E-02", async run(ctx) { return replayMigration(ctx); } },
  { id: "E-03", async run(ctx) { return recoveryMigration(ctx); } },
  { id: "E-04", async run(ctx) { return timelinePerformance(ctx); } },
  { id: "E-05", async run(ctx) { return holdPerformance(ctx); } },
  { id: "E-06", async run(ctx) { return recoveryPerformance(ctx); } },
  { id: "E-07", async run(ctx) { return cleanupAndReproducibility(ctx); } },
];

export default E_CASES;
