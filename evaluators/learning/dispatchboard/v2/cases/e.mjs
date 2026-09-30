import assert from "node:assert/strict";

import { dispatchSeed, performanceSeed } from "../lib/fixtures.mjs";
import { percentile } from "../lib/oracle.mjs";
import {
  acceptOffer, assertAssignment, assertExactError, assertSnapshotClosure, createDelivery, guarded, prepare, recoveryEnvironment, requireStatus, result,
  waitForOffers, waitUntilTimestamp,
} from "./helpers.mjs";

function perfRequest(seed, ordinal, phase, setupTime) {
  const customerOffset = phase === "warmup" ? 10_000 : 50_000;
  const customer = seed.customers[customerOffset + (ordinal % 30_000)];
  const pair = seed.zoneDistances[ordinal % seed.zoneDistances.length];
  return {
    customerId: customer.customerId,
    pickupZone: pair.fromZone,
    dropoffZone: pair.toZone,
    readyAt: new Date(setupTime + 600_000).toISOString(),
    deliverBy: new Date(setupTime + 4_200_000).toISOString(),
    loadUnits: 1,
  };
}

async function createWindow(ctx, apis, seed, durationMs, phase, setupTime, ordinalState) {
  const startedAt = performance.now();
  const deadline = startedAt + durationMs;
  const latencies = [];
  const deliveryIds = [];
  let successful = 0;
  let unexpected5xx = 0;
  await Promise.all(Array.from({ length: 64 }, async (_, clientIndex) => {
    while (performance.now() < deadline) {
      const ordinal = ordinalState.value;
      ordinalState.value += 1;
      const response = await ctx.mutate(
        apis[clientIndex % apis.length].baseUrl,
        "/api/v1/deliveries",
        ctx.key(`${phase}-${ordinal}`),
        perfRequest(seed, ordinal, phase, setupTime),
        { timeoutMs: 10_000 },
      );
      if (response.status >= 500) unexpected5xx += 1;
      if (response.status === 202 && performance.now() <= deadline) {
        successful += 1;
        deliveryIds.push(response.json.deliveryId);
        if (phase === "measure") latencies.push(response.durationMs);
        assert.equal(response.json.state, "REQUESTED");
        assert.equal(response.json.currentRound, 0);
        assert.equal(response.json.assignmentId, null);
      }
    }
  }));
  return { successful, unexpected5xx, latencies, deliveryIds, elapsedMs: performance.now() - startedAt };
}

const E01 = {
  id: "E-01",
  async run(ctx) {
    return guarded(["ASSIGNMENT_OR_CAPACITY", "DURABLE_IDEMPOTENCY"], async () => {
      const seed = performanceSeed(ctx.fixtures, { now: Date.now() });
      const { apis } = await prepare(ctx, seed, { apis: 2 });
      const setupTime = Date.now();
      const ordinalState = { value: 0 };
      const warmup = await createWindow(ctx, apis, seed, 10_000, "warmup", setupTime, ordinalState);
      const measured = await createWindow(ctx, apis, seed, 60_000, "measure", setupTime, ordinalState);
      assert.equal(warmup.unexpected5xx + measured.unexpected5xx, 0);
      const throughput = measured.successful / 60;
      const p50 = percentile(measured.latencies, 0.5);
      const p95 = percentile(measured.latencies, 0.95);
      const p99 = percentile(measured.latencies, 0.99);
      assert.ok(throughput >= 100, `delivery-create throughput ${throughput.toFixed(2)}/s is below 100/s`);
      assert.ok(p95 <= 300, `delivery-create p95 ${p95.toFixed(2)}ms exceeds 300ms`);
      assert.equal(new Set(warmup.deliveryIds).intersection(new Set(measured.deliveryIds)).size, 0);
      assert.equal(new Set(measured.deliveryIds).size, measured.successful);
      const snapshot = assertSnapshotClosure(await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 120_000 }));
      const measuredIds = new Set(measured.deliveryIds);
      const measuredDeliveries = snapshot.resources.deliveries.filter(({ deliveryId }) => measuredIds.has(deliveryId));
      assert.equal(measuredDeliveries.length, measured.successful);
      assert.ok(measuredDeliveries.every(({ state, currentRound }) => state === "REQUESTED" && currentRound === 0));
      const workCounts = new Map();
      for (const item of snapshot.work.filter(({ aggregateId, kind }) => measuredIds.has(aggregateId) && kind === "OFFER_ISSUANCE")) workCounts.set(item.aggregateId, (workCounts.get(item.aggregateId) ?? 0) + 1);
      assert.ok(measured.deliveryIds.every((deliveryId) => workCounts.get(deliveryId) === 1));
      const eventGroups = Map.groupBy(snapshot.events.filter(({ aggregateId }) => measuredIds.has(aggregateId)), ({ aggregateId }) => aggregateId);
      assert.ok(measured.deliveryIds.every((deliveryId) => eventGroups.get(deliveryId)?.length === 1 && eventGroups.get(deliveryId)[0].type === "delivery.requested"));
      return result({ throughput, p50, p95, p99, successes: measured.successful, warmupSuccesses: warmup.successful, unexpected5xx: 0, concurrency: 64, warmupSeconds: 10, measureSeconds: 60 });
    });
  },
};

const E02 = {
  id: "E-02",
  async run(ctx) {
    return guarded(["ASSIGNMENT_OR_CAPACITY", "DURABLE_IDEMPOTENCY"], async () => {
      const now = Date.now();
      const seed = performanceSeed(ctx.fixtures, { now });
      const { apis } = await prepare(ctx, seed, { apis: 2 });
      const selected = seed.offers.filter(({ state, expiresAt }) => state === "OPEN" && Date.parse(expiresAt) > now + 300_000)
        .toSorted((left, right) => Buffer.from(left.deliveryId).compare(Buffer.from(right.deliveryId)) || left.round - right.round || left.rank - right.rank || Buffer.from(left.offerId).compare(Buffer.from(right.offerId)));
      assert.equal(selected.length, 1_000);
      assert.equal(new Set(selected.map(({ deliveryId }) => deliveryId)).size, 200);
      const startedAt = performance.now();
      const responses = await ctx.concurrent(selected, 64, async (item, index) => ctx.mutate(
        apis[index % apis.length].baseUrl,
        `/api/v1/offers/${item.offerId}/accept`,
        ctx.key(`hot-claim-${item.offerId}`),
        { courierId: item.courierId },
        { timeoutMs: 10_000 },
      ));
      const elapsedMs = performance.now() - startedAt;
      const winners = responses.filter(({ status }) => status === 200);
      const losses = responses.filter(({ status }) => status === 409);
      assert.ok(elapsedMs <= 5_000, `hot-offer-claims took ${elapsedMs.toFixed(0)}ms`);
      assert.equal(winners.length, 200);
      assert.equal(losses.length, 800);
      losses.forEach((response) => assertExactError(response, 409, "OFFER_LOST"));
      assert.equal(responses.filter(({ status }) => status >= 500).length, 0);
      const p50 = percentile(responses.map(({ durationMs }) => durationMs), 0.5);
      const p95 = percentile(responses.map(({ durationMs }) => durationMs), 0.95);
      const p99 = percentile(responses.map(({ durationMs }) => durationMs), 0.99);
      assert.ok(p95 <= 350, `hot-offer-claims p95 ${p95.toFixed(2)}ms exceeds 350ms`);
      const snapshot = assertSnapshotClosure(await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 120_000 }));
      const selectedOfferIds = new Set(selected.map(({ offerId }) => offerId));
      const selectedDeliveryIds = new Set(selected.map(({ deliveryId }) => deliveryId));
      const terminal = snapshot.resources.offers.filter(({ offerId }) => selectedOfferIds.has(offerId));
      assert.equal(terminal.filter(({ state }) => state === "ACCEPTED").length, 200);
      assert.equal(terminal.filter(({ state }) => state === "LOST").length, 800);
      assert.equal(snapshot.resources.assignments.filter(({ deliveryId }) => selectedDeliveryIds.has(deliveryId)).length, 200);
      assert.equal(snapshot.work.some(({ aggregateId, terminal: isTerminal }) => selectedDeliveryIds.has(aggregateId) && !isTerminal), false);
      return result({ elapsedMs, p50, p95, p99, winners: winners.length, losses: losses.length, unexpected5xx: 0, concurrency: 64 });
    });
  },
};

const E03 = {
  id: "E-03",
  async run(ctx) {
    return guarded(["WORK_FENCING_OR_RECOVERY", "ASSIGNMENT_OR_CAPACITY"], async () => {
      const now = Date.now();
      const seed = performanceSeed(ctx.fixtures, { now });
      const { api } = await prepare(ctx, seed);
      const due = seed.offers.filter(({ state, expiresAt }) => state === "OPEN" && Date.parse(expiresAt) <= now);
      assert.equal(due.length, 5_000);
      const dueIds = new Set(due.map(({ offerId }) => offerId));
      const affectedDeliveryIds = new Set(due.map(({ deliveryId }) => deliveryId));
      assert.equal(affectedDeliveryIds.size, 1_000);
      const claimedWorkIds = new Set();
      const barrier = await ctx.barrier({ hold: (payload) => {
        if (payload.processRole !== "worker" || payload.point !== "worker.claimed" || claimedWorkIds.has(payload.workId) || claimedWorkIds.size >= 2) return false;
        claimedWorkIds.add(payload.workId);
        return true;
      } });
      const doomed = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ env: recoveryEnvironment(ctx, barrier) })));
      await ctx.waitFor(() => barrier.ledger.filter(({ json }) => claimedWorkIds.has(json?.workId) && !json?.released).length >= 2 ? true : undefined, {
        timeoutMs: 30_000,
        label: "two claimed expiry workers",
        processes: doomed,
      });
      await Promise.all(doomed.map((worker) => ctx.kill(worker)));
      assert.equal(claimedWorkIds.size, 2);
      const killedSnapshot = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
      const killedWork = killedSnapshot.work.filter(({ workId }) => claimedWorkIds.has(workId));
      assert.equal(killedWork.length, 2);
      assert.ok(killedWork.every(({ state, leaseExpiresAt }) => state === "LEASED" && leaseExpiresAt !== null));
      const lastLeaseExpiry = killedWork.map(({ leaseExpiresAt }) => leaseExpiresAt).toSorted().at(-1);
      await waitUntilTimestamp(ctx, lastLeaseExpiry, 100);
      const startedAt = performance.now();
      const replacements = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
      const snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
        const dueTerminal = value.resources.offers.filter(({ offerId }) => dueIds.has(offerId)).every(({ state }) => state !== "OPEN");
        const drained = !value.work.some(({ aggregateId, terminal }) => affectedDeliveryIds.has(aggregateId) && !terminal);
        return dueTerminal && drained ? value : undefined;
      }, { timeoutMs: 60_000, intervalMs: 500, label: "5,000 due Offers and matching Work drained", processes: replacements });
      const elapsedMs = performance.now() - startedAt;
      assert.ok(elapsedMs <= 60_000, `offer-expiry-recovery took ${elapsedMs.toFixed(0)}ms`);
      assertSnapshotClosure(snapshot);
      const original = snapshot.resources.offers.filter(({ offerId }) => dueIds.has(offerId));
      assert.equal(original.length, 5_000);
      assert.ok(original.every(({ state }) => state === "EXPIRED"));
      for (const deliveryId of affectedDeliveryIds) {
        const current = snapshot.resources.deliveries.find((item) => item.deliveryId === deliveryId);
        const own = snapshot.resources.offers.filter((item) => item.deliveryId === deliveryId);
        const accepted = own.filter(({ state }) => state === "ACCEPTED");
        const nextRound = own.filter(({ round }) => round === 2);
        assert.ok(accepted.length === 1 || (accepted.length === 0 && nextRound.length >= 1 && nextRound.length <= 5), `Delivery ${deliveryId} has no coherent winner or next round`);
        assert.equal(new Set(own.map(({ offerId }) => offerId)).size, own.length);
        assert.equal(new Set(own.map(({ notificationId }) => notificationId)).size, own.length);
        assert.ok(current.currentRound >= 1);
      }
      for (const workId of claimedWorkIds) {
        const item = snapshot.work.find((work) => work.workId === workId);
        assert.ok(item?.terminal && item.attempt >= 2, `stale claimed Work ${workId} was not fenced and recovered`);
      }
      return result({ elapsedMs, dueOffers: due.length, affectedDeliveries: affectedDeliveryIds.size, killedWorkers: doomed.length, replacementWorkers: replacements.length, claimedWorkIds: [...claimedWorkIds], staleCommits: 0 });
    });
  },
};

const E04 = {
  id: "E-04",
  // Policy revision: learning-final-system-2026-09-08.1. No synthetic historical DRIVER lineage.
  async run(ctx) {
    return guarded(["ASSIGNMENT_OR_CAPACITY", "DURABLE_IDEMPOTENCY"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "final-restart");
      const { api } = await prepare(ctx, fixture.seed);
      const replayKey = ctx.key("ordinary-replay");
      const ordinary = await createDelivery(ctx, api, fixture, "ordinary", {}, { key: replayKey });
      const team = await createDelivery(ctx, api, fixture, "team", { roles: ["DRIVER", "LOADER"] });
      const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.claimed" && aggregateId === ordinary.delivery.deliveryId });
      const doomed = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
      const held = await barrier.waitFor(({ json }) => json?.point === "worker.claimed" && json.aggregateId === ordinary.delivery.deliveryId, { timeoutMs: 45_000, processes: [doomed] });
      await ctx.kill(doomed);
      const before = await ctx.snapshot(api.baseUrl);
      const claimed = before.work.find(({ workId }) => workId === held.json.workId);
      assert.equal(claimed?.state, "LEASED");
      await ctx.kill(api);
      await ctx.migrate(); await ctx.migrate();
      const restarted = await ctx.startApi();
      const after = await ctx.snapshot(restarted.baseUrl);
      assert.deepEqual(after.resources, before.resources, "current ordinary/team resources survive restart");
      assert.deepEqual(after.work, before.work, "current Work lease identity survives restart");
      assert.deepEqual(after.events, before.events, "committed Event identity survives restart");
      const replay = await ctx.mutate(restarted.baseUrl, "/api/v1/deliveries", replayKey, ordinary.request);
      assert.equal(replay.status, ordinary.response.status);
      assert.deepEqual(replay.json, ordinary.response.json, "saved create response survives restart");
      const replacement = await ctx.startWorker();
      const offers = await waitForOffers(ctx, restarted, ordinary.delivery.deliveryId, items => items.some(({ state }) => state === "OPEN"), { processes: [replacement] });
      await waitForOffers(ctx, restarted, team.delivery.deliveryId, items => ["DRIVER", "LOADER"].every(role => items.some(item => item.role === role && item.state === "OPEN")), { processes: [replacement] });
      const selected = offers.find(({ state }) => state === "OPEN");
      const accepted = assertAssignment(requireStatus((await acceptOffer(ctx, restarted, selected, "recovered")).response, 200, "recovered ordinary acceptance"));
      assert.equal(accepted.offerId, selected.offerId);
      const final = assertSnapshotClosure(await ctx.snapshot(restarted.baseUrl));
      const recovered = final.work.find(({ workId }) => workId === claimed.workId);
      assert.ok(recovered?.terminal && recovered.attempt > claimed.attempt, "killed issuance Work is reclaimed without identity replacement");
      assert.equal(final.resources.assignments.filter(({ deliveryId }) => deliveryId === ordinary.delivery.deliveryId).length, 1);
      return result({ policyRevision: "learning-final-system-2026-09-08.1", ordinaryDeliveryId: ordinary.delivery.deliveryId, teamDeliveryId: team.delivery.deliveryId, reclaimedWorkId: claimed.workId, killedProcesses: 2 });
    });
  },
};

export const E_CASES = Object.freeze([E01, E02, E03, E04]);
