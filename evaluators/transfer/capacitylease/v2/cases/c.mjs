import { candidateAssert as assert } from "../lib/execution.mjs";

import {
  assertFinalSnapshot,
  canonical,
  createLease,
  cancelAdmission,
  emptySeed,
  leaseIdentity,
  leaseRequest,
  prepare,
  requireStatus,
  result,
  stableSnapshot,
  waitForSnapshot,
} from "./helpers.mjs";

const WORK_KEYS = [
  "aggregateId", "attempt", "kind", "leaseExpiresAt", "leaseOwner", "state", "terminal", "workId",
];
const TERMINAL_WORK = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

async function guarded(capIds, operation) {
  try {
    return await operation();
  } catch (error) {
    error.failureCodeSuffix ??= "PUBLIC_CONTRACT_FAILED";
    error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...capIds])];
    throw error;
  }
}

async function setup(ctx, label, options = {}) {
  const fixture = emptySeed(ctx, label, {
    poolCount: options.poolCount ?? 3,
    capacityUnits: options.capacityUnits ?? 10,
  });
  const api = await prepare(ctx, { seed: fixture.seed, install: false });
  return { ...fixture, api };
}

async function createHold(ctx, api, ids, label, overrides = {}) {
  const response = await createLease(ctx, api, label, leaseRequest(ctx, ids, label, {
    units: 10,
    holdSeconds: 1,
    ...overrides,
  }), 201);
  return { response, leaseId: leaseIdentity(response.json), body: response.json };
}

function aggregateWork(snapshot, aggregateId) {
  return snapshot.work.filter((item) => item.aggregateId === aggregateId);
}

function assertWorkShape(work) {
  assert.deepEqual(Object.keys(work).sort(), WORK_KEYS);
  assert.ok(["LEASE_EXPIRY", "ADMISSION_PROMOTION"].includes(work.kind));
  assert.ok(Number.isSafeInteger(work.attempt) && work.attempt >= 0);
  assert.equal(work.terminal, TERMINAL_WORK.has(work.state));
  assert.equal(work.state === "LEASED", work.leaseOwner !== null && work.leaseExpiresAt !== null);
  if (work.state !== "LEASED") {
    assert.equal(work.leaseOwner, null);
    assert.equal(work.leaseExpiresAt, null);
  }
}

async function waitForExpired(ctx, api, leaseId, options = {}) {
  return waitForSnapshot(ctx, api, (snapshot) => {
    const lease = snapshot.resources.capacityLeases.find((item) => item.leaseId === leaseId);
    const work = aggregateWork(snapshot, leaseId);
    return lease?.state === "EXPIRED" && work.some((item) => item.terminal);
  }, `Lease ${leaseId} expiry`, { timeoutMs: options.timeoutMs ?? 30_000 });
}

async function recoveryAt(ctx, point) {
  return guarded(["RECOVERY_OR_FENCING"], async () => {
    const { api, ids } = await setup(ctx, `c-${point}`);
    const hold = await createHold(ctx, api, ids, `c-${point}-hold`);
    let captured = false;
    const barrier = await ctx.barrier({
      hold: (payload) => payload.point === point && payload.aggregateId === hold.leaseId && !captured && (captured = true),
    });
    const first = await ctx.startWorker({
      env: {
        TEST_BARRIER_URL: barrier.url,
        TEST_BARRIER_TOKEN: barrier.token,
        WORK_LEASE_SECONDS: "1",
      },
    });
    const held = await barrier.waitFor(
      (entry) => entry.json?.point === point && entry.json?.aggregateId === hold.leaseId,
      { timeoutMs: 30_000 },
    );
    assert.equal(held.released, false);
    assert.equal(held.json.processRole, "worker");
    await ctx.kill(first);

    const replacement = await ctx.startWorker({
      env: {
        TEST_BARRIER_URL: barrier.url,
        TEST_BARRIER_TOKEN: barrier.token,
        WORK_LEASE_SECONDS: "1",
      },
    });
    const snapshot = await waitForExpired(ctx, api, hold.leaseId);
    assertFinalSnapshot(snapshot);
    const works = aggregateWork(snapshot, hold.leaseId);
    assert.ok(works.some((work) => work.terminal && work.attempt >= 2));
    assert.equal(
      snapshot.events.filter((event) => event.aggregateId === hold.leaseId && event.type === "lease.expired").length,
      1,
    );
    await ctx.stop(replacement);
    return result([{ kind: "worker-recovery", point, attempt: Math.max(...works.map((work) => work.attempt)) }]);
  });
}

export const C_CASES = [
  {
    id: "C-01",
    async run(ctx) {
      return guarded(["RECOVERY_OR_FENCING"], async () => {
        const { api, ids } = await setup(ctx, "c01");
        const hold = await createHold(ctx, api, ids, "c01-blocker");
        const waiting = await createLease(ctx, api, "c01-waiting", leaseRequest(ctx, ids, "c01-waiting", {
          units: 1,
          allowWait: true,
          holdSeconds: 120,
        }), 202);
        const admissionId = waiting.json.admissionEntryId;
        assert.equal(typeof admissionId, "string");

        const before = await ctx.snapshot(api.baseUrl);
        assertFinalSnapshot(before);
        const visible = before.work.filter((item) => [hold.leaseId, admissionId].includes(item.aggregateId));
        assert.ok(visible.some((item) => item.kind === "LEASE_EXPIRY"));
        assert.ok(visible.some((item) => item.kind === "ADMISSION_PROMOTION"));
        visible.forEach(assertWorkShape);

        const worker = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: "1" } });
        const after = await waitForSnapshot(ctx, api, (snapshot) => {
          const lease = snapshot.resources.capacityLeases.find((item) => item.leaseId === hold.leaseId);
          const admission = snapshot.resources.admissionEntries.find((item) => item.admissionEntryId === admissionId);
          return lease?.state === "EXPIRED" && admission?.state === "PROMOTED"
            && snapshot.work.filter((item) => [hold.leaseId, admissionId].includes(item.aggregateId)).every((item) => item.terminal);
        }, "expiry and Promotion Work to become terminal", { timeoutMs: 30_000 });
        assertFinalSnapshot(after);
        const retained = after.work.filter((item) => [hold.leaseId, admissionId].includes(item.aggregateId));
        assert.ok(retained.length >= visible.length);
        retained.forEach(assertWorkShape);
        await ctx.stop(worker);
        return result([{ kind: "work-lifecycle", retained: retained.length, terminal: retained.filter((item) => item.terminal).length }]);
      });
    },
  },
  { id: "C-02", run: (ctx) => recoveryAt(ctx, "worker.claimed") },
  { id: "C-03", run: (ctx) => recoveryAt(ctx, "worker.effect-complete") },
  { id: "C-04", run: (ctx) => recoveryAt(ctx, "worker.before-commit") },
  {
    id: "C-05",
    async run(ctx) {
      return guarded(["RECOVERY_OR_FENCING"], async () => {
        const { api, ids } = await setup(ctx, "c05");
        const hold = await createHold(ctx, api, ids, "c05-hold");
        let captured = false;
        const barrier = await ctx.barrier({
          hold: (payload) => payload.point === "worker.before-commit" && payload.aggregateId === hold.leaseId
            && !captured && (captured = true),
        });
        const stale = await ctx.startWorker({
          env: {
            TEST_BARRIER_URL: barrier.url,
            TEST_BARRIER_TOKEN: barrier.token,
            WORK_LEASE_SECONDS: "1",
          },
        });
        const held = await barrier.waitFor(
          (entry) => entry.json?.point === "worker.before-commit" && entry.json?.aggregateId === hold.leaseId,
        );
        const staleHash = held.json.leaseTokenHash;
        const leasedSnapshot = await waitForSnapshot(ctx, api, (snapshot) => aggregateWork(snapshot, hold.leaseId).find((work) => (
          work.state === "LEASED" && work.leaseExpiresAt !== null
        )), "stale Work lease to be publicly observable");
        const leased = aggregateWork(leasedSnapshot, hold.leaseId).find((work) => work.state === "LEASED");
        const leaseExpiresAt = Date.parse(leased.leaseExpiresAt);
        assert.ok(Number.isFinite(leaseExpiresAt), "leased Work has an invalid leaseExpiresAt");
        await ctx.waitFor(() => Date.now() > leaseExpiresAt, { label: "observed stale Work lease expiry", intervalMs: 10 });
        const winner = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: "1" } });
        const won = await waitForExpired(ctx, api, hold.leaseId);
        const beforeRelease = canonical(stableSnapshot(won));
        await ctx.stop(winner);

        // Leave one observable unit of follow-up work.  Once the formerly stale
        // Worker completes it, it has necessarily returned from the fenced
        // before-commit attempt; the comparison below can no longer pass early.
        const probe = await createHold(ctx, api, ids, "c05-progress-probe", {
          startAt: ctx.at({ hours: 4 }),
          endAt: ctx.at({ hours: 5 }),
        });

        barrier.release(held);
        await waitForExpired(ctx, api, probe.leaseId);
        const finalSnapshot = await ctx.snapshot(api.baseUrl);
        assertFinalSnapshot(finalSnapshot);
        const finalTarget = stableSnapshot(finalSnapshot);
        const targetProjection = (snapshot) => ({
          lease: snapshot.resources.capacityLeases.find((lease) => lease.leaseId === hold.leaseId),
          work: snapshot.work.filter((work) => work.aggregateId === hold.leaseId),
          events: snapshot.events.filter((event) => event.aggregateId === hold.leaseId),
        });
        assert.deepEqual(targetProjection(finalTarget), targetProjection(JSON.parse(beforeRelease)), "stale Worker changed the winning Lease, Work, or events");
        assert.equal(
          finalSnapshot.events.filter((event) => event.aggregateId === hold.leaseId && event.type === "lease.expired").length,
          1,
        );
        assert.match(staleHash, /^[0-9a-f]{64}$/u);
        await ctx.stop(stale);
        return result([{
          kind: "lease-fencing",
          staleTokenHashObserved: true,
          staleReachedCommitBoundary: true,
          winningAttempt: Math.max(...aggregateWork(finalSnapshot, hold.leaseId).map((work) => work.attempt)),
        }]);
      });
    },
  },
  {
    id: "C-06",
    async run(ctx) {
      return guarded(["RECOVERY_OR_FENCING"], async () => {
        const { api, ids } = await setup(ctx, "c06");
        const held = await createLease(ctx, api, "c06-manual", leaseRequest(ctx, ids, "c06-manual", {
          units: 2,
          holdSeconds: 120,
        }), 201);
        const leaseId = leaseIdentity(held.json);
        const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("c06-confirm"), {
          holdToken: held.json.holdToken,
          expectedRevision: held.json.revision,
        });
        requireStatus(confirmed, 200, "confirm");
        const released = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/release`, ctx.key("c06-release"), {
          expectedRevision: confirmed.json.revision,
          reason: "capacity no longer required",
        });
        requireStatus(released, 200, "release");

        const blocker = await createLease(ctx, api, "c06-blocker", leaseRequest(ctx, ids, "c06-blocker", {
          units: 10,
          startAt: ctx.at({ hours: 4 }),
          endAt: ctx.at({ hours: 5 }),
          holdSeconds: 120,
        }), 201);
        assert.equal(blocker.status, 201);
        const waiting = await createLease(ctx, api, "c06-waiting", leaseRequest(ctx, ids, "c06-waiting", {
          units: 1,
          startAt: ctx.at({ hours: 4 }),
          endAt: ctx.at({ hours: 5 }),
          allowWait: true,
        }), 202);
        const admissionId = waiting.json.admissionEntryId;
        const cancelled = await cancelAdmission(ctx, api.baseUrl, admissionId, ctx.key("c06-cancel"));
        assert.ok([200, 204].includes(cancelled.status), `cancel Admission Entry returned ${cancelled.status}`);
        if (cancelled.status === 200) assert.notEqual(cancelled.json, undefined);
        const worker = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: "1" } });
        const snapshot = await waitForSnapshot(ctx, api, (value) => {
          const target = value.work.filter((item) => [leaseId, admissionId].includes(item.aggregateId));
          return target.length > 0 && target.every((item) => item.terminal);
        }, "obsolete Work to close");
        assertFinalSnapshot(snapshot);
        assert.equal(snapshot.resources.capacityLeases.find((item) => item.leaseId === leaseId)?.state, "RELEASED");
        assert.equal(snapshot.resources.admissionEntries.find((item) => item.admissionEntryId === admissionId)?.state, "CANCELLED");
        await ctx.stop(worker);
        return result([{ kind: "obsolete-work-closure", aggregates: 2 }]);
      });
    },
  },
  {
    id: "C-07",
    async run(ctx) {
      return guarded(["EVENT_ATOMICITY_OR_IDENTITY"], async () => {
        const { api, ids } = await setup(ctx, "c07");
        const hold = await createLease(ctx, api, "c07-hold", leaseRequest(ctx, ids, "c07-hold", {
          holdSeconds: 120,
        }), 201);
        const leaseId = leaseIdentity(hold.json);
        const receiver = await ctx.receiver({
          behavior: (entry) => {
            if (entry.attempt === 1) return { status: 204, delayMs: 3_000 };
            if (entry.attempt === 2) return { status: 500 };
            if (entry.attempt === 3) return { disconnect: true };
            return { status: 204 };
          },
        });
        const first = await ctx.startDispatcher({ webhookUrl: receiver.url });
        await ctx.waitFor(() => receiver.ledger[0], { label: "first complete webhook request", processes: [first] });
        await ctx.kill(first);
        const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
        await ctx.waitFor(() => receiver.ledger.length >= 4 && receiver.ledger.at(-1).acknowledged, {
          label: "webhook delivery after 500 and disconnect",
          timeoutMs: 30_000,
          processes: [replacement],
        });
        const deliveries = receiver.ledger.slice(0, 4);
        const eventIds = deliveries.map((entry) => entry.headers["x-capacitylease-event-id"]);
        const eventTypes = deliveries.map((entry) => entry.headers["x-capacitylease-event-type"]);
        assert.equal(new Set(eventIds).size, 1);
        assert.equal(new Set(eventTypes).size, 1);
        assert.equal(new Set(deliveries.map((entry) => canonical(entry.json))).size, 1);
        assert.equal(deliveries[0].json.aggregateId, leaseId);
        await ctx.stop(replacement);
        return result([{ kind: "unknown-webhook-ack", attempts: deliveries.length, stableIdentity: true }]);
      });
    },
  },
  {
    id: "C-08",
    async run(ctx) {
      return guarded(["EVENT_ATOMICITY_OR_IDENTITY"], async () => {
        const { api, ids } = await setup(ctx, "c08");
        const receiver = await ctx.receiver({ behavior: () => ({ status: 204 }) });
        let heldOnce = false;
        const barrier = await ctx.barrier({
          hold: (payload) => payload.point === "dispatcher.response-received" && !heldOnce && (heldOnce = true),
        });
        const held = await createLease(ctx, api, "c08-held", leaseRequest(ctx, ids, "c08-held", { holdSeconds: 120 }), 201);
        const leaseId = leaseIdentity(held.json);
        const first = await ctx.startDispatcher({
          webhookUrl: receiver.url,
          env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
        });
        await barrier.waitFor((entry) => entry.json?.point === "dispatcher.response-received");
        await ctx.kill(first);
        const replacement = await ctx.startDispatcher({
          webhookUrl: receiver.url,
          env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
        });

        const confirmed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, ctx.key("c08-confirm"), {
          holdToken: held.json.holdToken,
          expectedRevision: held.json.revision,
        });
        requireStatus(confirmed, 200, "confirm");
        const renewed = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/renew`, ctx.key("c08-renew"), {
          expectedRevision: confirmed.json.revision,
          endAt: ctx.at({ hours: 4 }),
        });
        requireStatus(renewed, 200, "renew");
        const beforeRollback = await ctx.snapshot(api.baseUrl);
        const stale = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/renew`, ctx.key("c08-stale"), {
          expectedRevision: confirmed.json.revision,
          endAt: ctx.at({ hours: 5 }),
        });
        requireStatus(stale, 409, "stale renewal");
        const afterRollback = await ctx.snapshot(api.baseUrl);
        assert.deepEqual(afterRollback.events, beforeRollback.events, "rollback emitted a Domain Event");
        const released = await ctx.mutate(api.baseUrl, `/api/v1/capacity-leases/${leaseId}/release`, ctx.key("c08-release"), {
          expectedRevision: renewed.json.revision,
          reason: "completed",
        });
        requireStatus(released, 200, "release");

        const snapshot = await waitForSnapshot(ctx, api, (value) => (
          value.events.filter((event) => event.aggregateId === leaseId).length === 4
        ), "four committed Lease events");
        assertFinalSnapshot(snapshot);
        const events = snapshot.events.filter((event) => event.aggregateId === leaseId);
        assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
        assert.deepEqual(events.map((event) => event.type), [
          "lease.held", "lease.confirmed", "lease.renewed", "lease.released",
        ]);
        assert.ok(events.every((event) => canonical(event.payload) === "{}"));
        await ctx.waitFor(() => {
          const successful = receiver.ledger.filter((entry) => entry.acknowledged && entry.json?.aggregateId === leaseId);
          return successful.length >= 4 ? successful : undefined;
        }, { label: "ordered successful event delivery", timeoutMs: 30_000, processes: [replacement] });
        const delivered = receiver.ledger.filter((entry) => entry.acknowledged && entry.json?.aggregateId === leaseId);
        assert.deepEqual(delivered.slice(-4).map((entry) => entry.json.sequence), [1, 2, 3, 4]);
        const firstIdentity = receiver.ledger[0].headers["x-capacitylease-event-id"];
        assert.ok(receiver.ledger.filter((entry) => entry.json?.sequence === 1).every((entry) => entry.headers["x-capacitylease-event-id"] === firstIdentity));
        await ctx.stop(replacement);
        return result([{ kind: "event-transaction-and-recovery", committed: events.length, orderedDeliveries: 4 }]);
      });
    },
  },
];
