import assert from "node:assert/strict";

import { courier, dispatchSeed, seedFromSnapshot } from "../lib/fixtures.mjs";
import { canonical, expectedNotificationDelaySeconds } from "../lib/oracle.mjs";
import {
  acceptOffer, assertExactError, assertSnapshotClosure, cancelDelivery, createDelivery, getDelivery, getOffers, guarded,
  prepare, recoveryEnvironment, result, waitForDelivery, waitForOffers, waitUntilTimestamp,
} from "./helpers.mjs";

const C01 = {
  id: "C-01",
  async run(ctx) {
    return guarded(["WORK_FENCING_OR_RECOVERY", "DURABLE_IDEMPOTENCY"], async () => {
      const completionByAttempt = new Map();
      const receiver = await ctx.receiver({
        path: "/offers",
        behavior: async (entry) => {
          entry.receivedAt = Date.now();
          const attempt = entry.attempt;
          if (attempt === 2) {
            entry.completedAt = Date.now();
            completionByAttempt.set(attempt, entry.completedAt);
            return { disconnect: true };
          }
          if (attempt === 4) await new Promise((resolveWait) => setTimeout(resolveWait, 6_000));
          entry.completedAt = Date.now();
          completionByAttempt.set(attempt, entry.completedAt);
          return attempt >= 6 ? { status: 204 } : { status: 500 };
        },
      });
      const changedReceiver = await ctx.receiver({ path: "/offers", behavior: () => ({ status: 204 }) });
      const targetCourier = courier(ctx.fixtures, "notification", {
        capacityUnits: 10,
        eligibleZones: ["NORTH", "SOUTH", "EAST"],
        deliveryUrl: receiver.url,
      });
      const fixture = dispatchSeed(ctx.fixtures, "notification", { couriers: [targetCourier] });
      const { api, workers: [worker] } = await prepare(ctx, fixture.seed, { workers: 1 });
      const created = await createDelivery(ctx, api, fixture, "notification", { loadUnits: 1 });
      const offers = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => items.length === 1, { processes: [worker] });
      const targetOffer = offers[0];
      const first = await ctx.waitFor(() => receiver.ledger.find(({ json }) => json?.notificationId === targetOffer.notificationId), { label: "first OfferNotification attempt", processes: [worker] });
      const capturedSnapshot = await ctx.snapshot(api.baseUrl);
      const captured = capturedSnapshot.resources.offerNotifications.find(({ notificationId }) => notificationId === targetOffer.notificationId);
      assert.equal(first.path, "/offers");
      assert.equal(first.headers["content-type"]?.split(";")[0], "application/json");
      assert.equal(first.raw, canonical(captured.body), "OfferNotification body is not RFC 8785 canonical JSON");

      const replacementSeed = seedFromSnapshot(ctx.fixtures, "notification-url-change", capturedSnapshot, {
        couriers: capturedSnapshot.resources.couriers.map((item) => item.courierId === targetCourier.courierId ? { ...item, deliveryUrl: changedReceiver.url } : item),
      });
      const changed = await ctx.seed(replacementSeed, { timeoutMs: 120_000 });
      assert.equal(changed.exitCode, 0, changed.stderr || changed.stdout);
      const delivered = await ctx.waitFor(async () => {
        const snapshot = await ctx.snapshot(api.baseUrl);
        const item = snapshot.resources.offerNotifications.find(({ notificationId }) => notificationId === targetOffer.notificationId);
        return item?.state === "DELIVERED" ? item : undefined;
      }, { timeoutMs: 45_000, intervalMs: 100, label: "OfferNotification delivered after failures", processes: [worker] });
      const attempts = receiver.ledger.filter(({ json }) => json?.notificationId === targetOffer.notificationId);
      assert.equal(attempts.length, 6);
      assert.equal(changedReceiver.ledger.some(({ json }) => json?.notificationId === targetOffer.notificationId), false, "retry used the changed Courier URL");
      assert.ok(attempts.every((entry) => entry.raw === first.raw && canonical(entry.json) === canonical(first.json)));
      assert.ok(attempts.every((entry) => entry.json.notificationId === targetOffer.notificationId));
      for (const attempt of [1, 2, 3, 5]) {
        const completedAt = completionByAttempt.get(attempt);
        const nextReceivedAt = attempts[attempt].receivedAt;
        const expectedMs = expectedNotificationDelaySeconds(attempt) * 1_000;
        assert.ok(nextReceivedAt - completedAt >= expectedMs - 250, `notification attempt ${attempt} retried too early`);
        assert.ok(nextReceivedAt - completedAt <= expectedMs + 1_500, `notification attempt ${attempt} backoff drifted`);
      }
      assert.equal(delivered.attemptCount, 6);
      assert.equal(delivered.nextAttemptAt, null);
      assert.match(delivered.successfulDeliveryAt, /^\d{4}-\d{2}-\d{2}T/u);
      const finalSnapshot = assertSnapshotClosure(await ctx.snapshot(api.baseUrl));
      assert.equal(finalSnapshot.resources.offers.filter(({ offerId }) => offerId === targetOffer.offerId).length, 1);
      assert.equal(finalSnapshot.resources.offerNotifications.filter(({ notificationId }) => notificationId === targetOffer.notificationId).length, 1);
      await waitUntilTimestamp(ctx, targetOffer.expiresAt, 1_000, { processes: [worker] });
      const countAtExpiry = receiver.ledger.length;
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      assert.equal(receiver.ledger.length, countAtExpiry, "notification retried after success or Offer expiry");
      return result({ notificationId: targetOffer.notificationId, attempts: attempts.length, capturedUrl: receiver.url, changedUrl: changedReceiver.url });
    });
  },
};

async function buildOnce(ctx) {
  await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
  await ctx.npm("build", [], { timeoutMs: 600_000 });
}

const C02 = {
  id: "C-02",
  async run(ctx) {
    return guarded(["WORK_FENCING_OR_RECOVERY", "ASSIGNMENT_OR_CAPACITY"], async () => {
      await buildOnce(ctx);
      const points = ["worker.claimed", "worker.effect-complete", "worker.before-commit"];
      const evidence = [];
      for (const [index, point] of points.entries()) {
        if (index > 0) await ctx.resetDatabase();
        const fixture = dispatchSeed(ctx.fixtures, `issuance-${index}`);
        await ctx.migrate();
        const imported = await ctx.seed(fixture.seed);
        assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
        const api = await ctx.startApi();
        const created = await createDelivery(ctx, api, fixture, `issuance-${index}`, { loadUnits: 1 });
        const before = await ctx.snapshot(api.baseUrl);
        const work = before.work.find((item) => item.aggregateId === created.delivery.deliveryId && item.kind === "OFFER_ISSUANCE" && !item.terminal);
        assert.ok(work, "initial OFFER_ISSUANCE Work is missing");
        const barrier = await ctx.barrier({ hold: (payload) => payload.point === point && payload.workId === work.workId && payload.attempt === 1 });
        const worker = await ctx.startWorker({ env: recoveryEnvironment(ctx, barrier) });
        const held = await barrier.waitFor((entry) => entry.json?.point === point && entry.json?.workId === work.workId, { timeoutMs: 30_000, processes: [worker] });
        let cancelled = false;
        if (point === "worker.effect-complete") {
          const response = await cancelDelivery(ctx, api, created.delivery.deliveryId, `issuance-interleave-${index}`);
          assert.equal(response.status, 200, response.text);
          cancelled = true;
        }
        await ctx.kill(worker);
        assert.equal(held.disconnected, true);
        const replacement = await ctx.startWorker({ env: recoveryEnvironment(ctx, barrier) });
        let finalSnapshot;
        if (cancelled) {
          await waitForDelivery(ctx, api, created.delivery.deliveryId, ["CANCELLED"], { processes: [replacement] });
          finalSnapshot = await ctx.waitFor(async () => {
            const value = await ctx.snapshot(api.baseUrl);
            return value.work.find(({ workId }) => workId === work.workId)?.terminal ? value : undefined;
          }, { timeoutMs: 30_000, label: `${point} cancelled issuance terminal`, processes: [replacement] });
          assert.equal(finalSnapshot.resources.offers.some(({ deliveryId }) => deliveryId === created.delivery.deliveryId), false);
        } else {
          await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => items.filter(({ round }) => round === 1).length > 0, { timeoutMs: 30_000, processes: [replacement] });
          finalSnapshot = await ctx.waitFor(async () => {
            const value = await ctx.snapshot(api.baseUrl);
            return value.work.find(({ workId }) => workId === work.workId)?.terminal ? value : undefined;
          }, { timeoutMs: 30_000, label: `${point} issuance terminal`, processes: [replacement] });
          const offers = finalSnapshot.resources.offers.filter(({ deliveryId, round }) => deliveryId === created.delivery.deliveryId && round === 1);
          assert.equal(new Set(offers.map(({ offerId }) => offerId)).size, offers.length);
          assert.equal(new Set(offers.map(({ notificationId }) => notificationId)).size, offers.length);
          assert.equal(offers.length <= 5, true);
        }
        const finalWork = finalSnapshot.work.find(({ workId }) => workId === work.workId);
        assert.ok(finalWork.terminal);
        assert.ok(finalWork.attempt >= 2);
        assert.equal(finalSnapshot.work.filter(({ workId }) => workId === work.workId).length, 1);
        assertSnapshotClosure(finalSnapshot);
        evidence.push({ point, workId: work.workId, attempt: finalWork.attempt, cancelled });
      }
      return result(evidence);
    });
  },
};

async function ordinaryExpiryRecovery(ctx, point, index) {
  const fixture = dispatchSeed(ctx.fixtures, `expiry-${index}`);
  await ctx.migrate();
  const imported = await ctx.seed(fixture.seed);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const api = await ctx.startApi();
  const issuer = await ctx.startWorker();
  const created = await createDelivery(ctx, api, fixture, `expiry-${index}`, { loadUnits: 1 });
  const firstRound = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => items.filter(({ round }) => round === 1).length > 0, { processes: [issuer] });
  await ctx.stop(issuer);
  const before = await ctx.snapshot(api.baseUrl);
  const work = before.work.find((item) => item.aggregateId === created.delivery.deliveryId && item.kind === "OFFER_EXPIRY" && !item.terminal);
  assert.ok(work, "OFFER_EXPIRY Work is missing");
  const barrier = await ctx.barrier({ hold: (payload) => payload.point === point && payload.workId === work.workId && payload.attempt === 1 });
  await waitUntilTimestamp(ctx, firstRound[0].expiresAt, 5_000);
  const worker = await ctx.startWorker({ env: recoveryEnvironment(ctx, barrier) });
  const held = await barrier.waitFor((entry) => entry.json?.point === point && entry.json?.workId === work.workId, { timeoutMs: 30_000, processes: [worker] });
  let cancelled = false;
  if (point === "worker.effect-complete") {
    const response = await cancelDelivery(ctx, api, created.delivery.deliveryId, `expiry-cancel-${index}`);
    assert.equal(response.status, 200, response.text);
    cancelled = true;
  } else {
    assertExactError((await acceptOffer(ctx, api, firstRound[0], `late-accept-${index}`)).response, 409, "OFFER_EXPIRED");
  }
  await ctx.kill(worker);
  assert.equal(held.disconnected, true);
  const replacement = await ctx.startWorker({ env: recoveryEnvironment(ctx, barrier) });
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const targetWork = value.work.find(({ workId }) => workId === work.workId);
    const hasNext = value.resources.offers.some(({ deliveryId, round }) => deliveryId === created.delivery.deliveryId && round === 2);
    return targetWork?.terminal && (cancelled || hasNext) ? value : undefined;
  }, { timeoutMs: 45_000, intervalMs: 100, label: `${point} expiry takeover`, processes: [replacement] });
  const originalOffers = snapshot.resources.offers.filter(({ deliveryId, round }) => deliveryId === created.delivery.deliveryId && round === 1);
  assert.ok(originalOffers.every(({ state }) => cancelled ? ["LOST", "EXPIRED"].includes(state) : state === "EXPIRED"));
  const next = snapshot.resources.offers.filter(({ deliveryId, round }) => deliveryId === created.delivery.deliveryId && round === 2);
  if (cancelled) assert.equal(next.length, 0);
  else {
    assert.ok(next.length >= 1 && next.length <= 5);
    assert.equal(new Set(next.map(({ courierId }) => courierId)).intersection(new Set(originalOffers.map(({ courierId }) => courierId))).size, 0);
  }
  assertSnapshotClosure(snapshot);
  return { point, workId: work.workId, attempt: snapshot.work.find(({ workId }) => workId === work.workId).attempt, cancelled };
}

const C03 = {
  id: "C-03",
  async run(ctx) {
    return guarded(["WORK_FENCING_OR_RECOVERY", "TEAM_AGGREGATE_CLOSURE", "ASSIGNMENT_OR_CAPACITY"], async () => {
      await buildOnce(ctx);
      const points = ["worker.claimed", "worker.effect-complete", "worker.before-commit"];
      const evidence = [];
      for (const [index, point] of points.entries()) {
        if (index > 0) await ctx.resetDatabase();
        evidence.push(await ordinaryExpiryRecovery(ctx, point, index));
      }

      await ctx.resetDatabase();
      const fixture = dispatchSeed(ctx.fixtures, "team-expiry", {
        couriers: Array.from({ length: 8 }, (_, index) => courier(ctx.fixtures, `team-expiry-${index}`, { capacityUnits: 10, eligibleZones: ["NORTH", "SOUTH", "EAST"] })),
      });
      await ctx.migrate();
      assert.equal((await ctx.seed(fixture.seed)).exitCode, 0);
      const api = await ctx.startApi();
      const issuer = await ctx.startWorker();
      const created = await createDelivery(ctx, api, fixture, "team-expiry", { roles: ["DRIVER", "LOADER"], loadUnits: 1 });
      const offers = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => items.some(({ role }) => role === "DRIVER") && items.some(({ role }) => role === "LOADER"), { processes: [issuer] });
      await ctx.stop(issuer);
      const driverOffer = offers.find(({ role }) => role === "DRIVER");
      const driver = (await acceptOffer(ctx, api, driverOffer, "team-expiry-driver")).response.json;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20_000));
      const loaderOffer = offers.find((item) => item.role === "LOADER" && item.courierId !== driver.courierId);
      const loader = (await acceptOffer(ctx, api, loaderOffer, "team-expiry-loader")).response.json;
      const workSnapshot = await ctx.snapshot(api.baseUrl);
      const work = workSnapshot.work.find((item) => item.aggregateId === created.delivery.deliveryId && item.kind === "OFFER_EXPIRY" && !item.terminal);
      assert.ok(work);
      const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.before-commit" && payload.aggregateId === created.delivery.deliveryId && payload.attempt === 1 });
      await waitUntilTimestamp(ctx, driver.claimExpiresAt, 5_000);
      const doomed = await ctx.startWorker({ env: recoveryEnvironment(ctx, barrier) });
      const held = await barrier.waitFor((entry) => entry.json?.aggregateId === created.delivery.deliveryId, { timeoutMs: 30_000, processes: [doomed] });
      await ctx.kill(doomed);
      assert.equal(held.disconnected, true);
      const replacement = await ctx.startWorker({ env: recoveryEnvironment(ctx, barrier) });
      const teamDetail = await ctx.waitFor(async () => {
        const current = await getDelivery(ctx, api, created.delivery.deliveryId);
        return current.assignments.find(({ assignmentId }) => assignmentId === driver.assignmentId)?.state === "RELEASED"
          && (await getOffers(ctx, api, created.delivery.deliveryId)).some((item) => item.role === "DRIVER" && item.round === 2)
          ? current : undefined;
      }, { timeoutMs: 45_000, label: "team role-local expiry recovery", processes: [replacement] });
      assert.equal(teamDetail.assignments.find(({ assignmentId }) => assignmentId === loader.assignmentId).state, "RESERVED");
      assert.equal(teamDetail.assignments.find(({ assignmentId }) => assignmentId === loader.assignmentId).claimExpiresAt, loader.claimExpiresAt);
      const currentOffers = await getOffers(ctx, api, created.delivery.deliveryId);
      assert.ok(currentOffers.filter(({ round }) => round === 2).every(({ role }) => role === "DRIVER"));
      assertSnapshotClosure(await ctx.snapshot(api.baseUrl));
      evidence.push({ point: "worker.before-commit", workId: work.workId, role: "DRIVER", retainedAssignmentId: loader.assignmentId });
      return result(evidence);
    });
  },
};

const C04 = {
  id: "C-04",
  async run(ctx) {
    return guarded(["WORK_FENCING_OR_RECOVERY", "DURABLE_IDEMPOTENCY"], async () => {
      const receiver = await ctx.receiver({ path: "/events", behavior: () => ({ status: 204 }) });
      const fixture = dispatchSeed(ctx.fixtures, "event-outbox");
      const { api } = await prepare(ctx, fixture.seed);
      const first = await createDelivery(ctx, api, fixture, "event-one");
      const second = await createDelivery(ctx, api, fixture, "event-two", { customerId: fixture.customers[1].customerId });
      requireStatus(await cancelDelivery(ctx, api, first.delivery.deliveryId, "event-one-cancel"), 200, "first Delivery cancel");
      requireStatus(await cancelDelivery(ctx, api, second.delivery.deliveryId, "event-two-cancel"), 200, "second Delivery cancel");
      const source = await ctx.snapshot(api.baseUrl);
      const eventIds = new Set(source.events.map(({ eventId }) => eventId));
      assert.equal(eventIds.size, 4);
      let heldOnce = false;
      const barrier = await ctx.barrier({ hold: (payload) => {
        if (heldOnce || payload.processRole !== "dispatcher" || payload.point !== "dispatcher.response-received") return false;
        heldOnce = true;
        return true;
      } });
      const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url, env: recoveryEnvironment(ctx, barrier) });
      const held = await barrier.waitFor((entry) => entry.json?.point === "dispatcher.response-received", { timeoutMs: 30_000, processes: [dispatcher] });
      const firstDeliveredEvent = receiver.ledger[0].json;
      await ctx.kill(dispatcher);
      assert.equal(held.disconnected, true);
      const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url, env: recoveryEnvironment(ctx, barrier) });
      await ctx.waitFor(() => {
        const seen = new Set(receiver.ledger.filter(({ acknowledged }) => acknowledged).map(({ json }) => json?.eventId));
        const retriedFirst = receiver.ledger.filter(({ json }) => json?.eventId === firstDeliveredEvent.eventId).length >= 2;
        return retriedFirst && [...eventIds].every((eventId) => seen.has(eventId)) ? true : undefined;
      }, { timeoutMs: 45_000, intervalMs: 100, label: "dispatcher retry and drain", processes: [replacement] });
      const ledger = receiver.ledger.filter(({ json }) => eventIds.has(json?.eventId));
      assert.ok(ledger.filter(({ json }) => json.eventId === firstDeliveredEvent.eventId).every(({ json, raw }) => canonical(json) === canonical(firstDeliveredEvent) && raw === ledger[0].raw));
      for (const entry of ledger) {
        assert.equal(entry.method, "POST");
        assert.equal(entry.headers["x-dispatchboard-event-id"], entry.json.eventId);
        assert.equal(entry.headers["x-dispatchboard-event-type"], entry.json.type);
        assert.deepEqual(entry.json.payload, {});
      }
      for (const aggregateId of [first.delivery.deliveryId, second.delivery.deliveryId]) {
        const successful = ledger.filter(({ acknowledged, json }) => acknowledged && json.aggregateId === aggregateId);
        const firstById = [...new Map(successful.map((entry) => [entry.json.eventId, entry])).values()];
        assert.deepEqual(firstById.map(({ json }) => json.sequence), [1, 2]);
      }
      const final = await ctx.snapshot(api.baseUrl);
      assertSnapshotClosure(final);
      assert.deepEqual(final.events.map(({ eventId }) => eventId), source.events.map(({ eventId }) => eventId));
      assert.ok(final.events.every(({ type }) => ["delivery.requested", "delivery.cancelled"].includes(type)));
      return result({ eventIds: [...eventIds], retriedEventId: firstDeliveredEvent.eventId, receiverAttempts: ledger.length });
    });
  },
};

export const C_CASES = Object.freeze([C01, C02, C03, C04]);
