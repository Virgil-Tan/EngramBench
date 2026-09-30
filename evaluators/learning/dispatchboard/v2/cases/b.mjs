import assert from "node:assert/strict";

import {
  assignment, courier, delivery as seededDelivery, dispatchSeed, notification, offer,
} from "../lib/fixtures.mjs";
import { assertCapacityClosure, assertOfferRound, rankEligibleCouriers } from "../lib/oracle.mjs";
import {
  acceptOffer, assertAssignment, assertDelivery, assertExactError, assertRoleAssignment, cancelDelivery,
  completeDelivery, createDelivery, getDelivery, getOffers, guarded, lostMutation, pickupDelivery,
  prepare, readyAssignment, requireStatus, result, waitForDelivery, waitForOffers, waitUntilTimestamp,
} from "./helpers.mjs";

function preload(ctx, fixture, targetCourier, index, loadUnits) {
  const targetDelivery = seededDelivery(ctx.fixtures, `preload-${index}`, fixture.customers[index], {
    loadUnits, state: "ASSIGNED", currentRound: 1, sequence: 3,
  });
  const targetOffer = offer(ctx.fixtures, `preload-${index}`, targetDelivery, targetCourier, { state: "ACCEPTED" });
  const targetNotification = notification(ctx.fixtures, `preload-${index}`, targetOffer, targetCourier, { state: "SUPERSEDED", nextAttemptAt: null });
  const targetAssignment = assignment(ctx.fixtures, `preload-${index}`, targetDelivery, targetOffer, targetCourier);
  targetDelivery.assignmentId = targetAssignment.assignmentId;
  return { delivery: targetDelivery, offer: targetOffer, notification: targetNotification, assignment: targetAssignment };
}

function rankingFixture(ctx) {
  const ranked = Array.from({ length: 12 }, (_, index) => courier(ctx.fixtures, `rank-${String(index).padStart(2, "0")}`, {
    homeZone: index < 7 ? "NORTH" : "SOUTH",
    capacityUnits: 10,
    activeLoadUnits: 0,
    eligibleZones: ["NORTH", "SOUTH", "EAST"],
  }));
  ranked[1].activeLoadUnits = 1;
  ranked[2].activeLoadUnits = 2;
  ranked[9].state = "PAUSED";
  ranked[10].eligibleZones = ["NORTH"];
  ranked[11].capacityUnits = 1;
  ranked[11].activeLoadUnits = 1;
  const fixture = dispatchSeed(ctx.fixtures, "ranking", { couriers: ranked });
  const preloads = [preload(ctx, fixture, ranked[1], 0, 1), preload(ctx, fixture, ranked[2], 1, 2), preload(ctx, fixture, ranked[11], 2, 1)];
  fixture.seed.deliveries.push(...preloads.map((item) => item.delivery));
  fixture.seed.offers.push(...preloads.map((item) => item.offer));
  fixture.seed.offerNotifications.push(...preloads.map((item) => item.notification));
  fixture.seed.assignments.push(...preloads.map((item) => item.assignment));
  return fixture;
}

const B01 = {
  id: "B-01",
  async run(ctx) {
    return guarded(["ASSIGNMENT_OR_CAPACITY", "TEAM_AGGREGATE_CLOSURE"], async () => {
      const fixture = rankingFixture(ctx);
      const { api, workers: [worker] } = await prepare(ctx, fixture.seed, { workers: 1 });
      const created = await createDelivery(ctx, api, fixture, "ranked", { loadUnits: 1 });
      const firstRound = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => items.filter(({ round }) => round === 1).length === 5, { processes: [worker] });
      const expected = rankEligibleCouriers({
        couriers: fixture.couriers,
        zoneDistances: fixture.zoneDistances,
        pickupZone: created.request.pickupZone,
        dropoffZone: created.request.dropoffZone,
        loadUnits: created.request.loadUnits,
      });
      assertOfferRound({ offers: firstRound, expectedCouriers: expected, round: 1 });
      const frozenIds = firstRound.map(({ offerId }) => offerId);
      assert.ok(firstRound.every(({ state }) => state === "OPEN"));
      assert.equal(fixture.couriers.every((item) => item.activeLoadUnits === (item.courierId === fixture.couriers[1].courierId ? 1 : item.courierId === fixture.couriers[2].courierId ? 2 : item.courierId === fixture.couriers[11].courierId ? 1 : 0)), true);
      const expiry = firstRound[0].expiresAt;
      await waitUntilTimestamp(ctx, expiry, 5_000, { processes: [worker] });
      const twoRounds = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => items.some(({ round }) => round === 2), { timeoutMs: 30_000, processes: [worker] });
      assert.deepEqual(twoRounds.filter(({ round }) => round === 1).map(({ offerId }) => offerId), frozenIds);
      const previousCouriers = firstRound.map(({ courierId }) => courierId);
      const secondExpected = rankEligibleCouriers({
        couriers: fixture.couriers,
        zoneDistances: fixture.zoneDistances,
        pickupZone: created.request.pickupZone,
        dropoffZone: created.request.dropoffZone,
        loadUnits: created.request.loadUnits,
        previouslyOffered: previousCouriers,
      });
      assertOfferRound({ offers: twoRounds, expectedCouriers: secondExpected, round: 2 });
      assert.equal(new Set(twoRounds.filter(({ round }) => round === 2).map(({ courierId }) => courierId)).intersection(new Set(previousCouriers)).size, 0);
      const snapshot = await ctx.snapshot(api.baseUrl);
      assertCapacityClosure(snapshot.resources);
      return result({ deliveryId: created.delivery.deliveryId, firstRoundOfferIds: frozenIds, secondRoundOfferIds: twoRounds.filter(({ round }) => round === 2).map(({ offerId }) => offerId) });
    });
  },
};

async function ordinaryReady(ctx, api, worker, fixture, label) {
  const created = await createDelivery(ctx, api, fixture, label, { loadUnits: 1 });
  const offers = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => items.filter(({ state }) => state === "OPEN").length === 5, { processes: [worker] });
  return { ...created, offers };
}

async function raceClaims(ctx, apis, offers, label) {
  return Promise.all(offers.map((item, index) => acceptOffer(ctx, apis[index % apis.length], item, `${label}-${index}`).then(({ response }) => response)));
}

const B02 = {
  id: "B-02",
  async run(ctx) {
    return guarded(["ASSIGNMENT_OR_CAPACITY", "DURABLE_IDEMPOTENCY"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "ordinary-races", {
        couriers: Array.from({ length: 8 }, (_, index) => courier(ctx.fixtures, `ordinary-race-${index}`, { capacityUnits: 10, eligibleZones: ["NORTH", "SOUTH", "EAST"] })),
      });
      const { apis, workers } = await prepare(ctx, fixture.seed, { apis: 2, workers: 2 });
      const first = await ordinaryReady(ctx, apis[0], workers[0], fixture, "claim-race");
      const claimResponses = await raceClaims(ctx, apis, first.offers, "claim-race");
      assert.equal(claimResponses.filter(({ status }) => status === 200).length, 1);
      for (const response of claimResponses.filter(({ status }) => status !== 200)) assertExactError(response, 409, "OFFER_LOST");
      const winner = assertAssignment(claimResponses.find(({ status }) => status === 200).json);
      const snapshotAfterClaim = await ctx.snapshot(apis[0].baseUrl);
      const ownOffers = snapshotAfterClaim.resources.offers.filter(({ deliveryId }) => deliveryId === first.delivery.deliveryId);
      assert.equal(ownOffers.filter(({ state }) => state === "ACCEPTED").length, 1);
      assert.equal(ownOffers.filter(({ state }) => state === "LOST").length, 4);
      assert.equal(snapshotAfterClaim.resources.assignments.filter(({ deliveryId }) => deliveryId === first.delivery.deliveryId).length, 1);
      assertCapacityClosure(snapshotAfterClaim.resources);

      const pickupCancel = await ordinaryReady(ctx, apis[0], workers[0], fixture, "pickup-cancel");
      const pickupAssignment = assertAssignment(requireStatus((await acceptOffer(ctx, apis[0], pickupCancel.offers[0], "pickup-cancel")).response, 200, "pickup-cancel accept"));
      const pickupCancelResponses = await Promise.all([
        pickupDelivery(ctx, apis[0], pickupAssignment.deliveryId, pickupAssignment.courierId, "pickup-race"),
        cancelDelivery(ctx, apis[1], pickupAssignment.deliveryId, "cancel-race"),
      ]);
      assert.equal(pickupCancelResponses.filter(({ status }) => status === 200).length, 1);
      assert.ok(pickupCancelResponses.filter(({ status }) => status !== 200).every(({ json }) => json?.error?.code === "DELIVERY_STATE_CONFLICT"));
      const pickupCancelFinal = await getDelivery(ctx, apis[0], pickupAssignment.deliveryId);
      assert.ok(["PICKED_UP", "CANCELLED"].includes(pickupCancelFinal.state));

      const completeCancel = await ordinaryReady(ctx, apis[0], workers[0], fixture, "complete-cancel");
      const terminalAssignment = assertAssignment(requireStatus((await acceptOffer(ctx, apis[0], completeCancel.offers[0], "complete-cancel")).response, 200, "complete-cancel accept"));
      requireStatus(await pickupDelivery(ctx, apis[0], terminalAssignment.deliveryId, terminalAssignment.courierId, "before-complete-race"), 200, "before terminal race pickup");
      const terminalResponses = await Promise.all([
        completeDelivery(ctx, apis[0], terminalAssignment.deliveryId, terminalAssignment.courierId, "complete-race"),
        cancelDelivery(ctx, apis[1], terminalAssignment.deliveryId, "late-cancel-race"),
      ]);
      assert.equal(terminalResponses.filter(({ status }) => status === 200).length, 1);
      assert.equal((await getDelivery(ctx, apis[0], terminalAssignment.deliveryId)).state, "DELIVERED");
      const finalSnapshot = await ctx.snapshot(apis[0].baseUrl);
      assertCapacityClosure(finalSnapshot.resources);
      assert.ok(finalSnapshot.resources.couriers.every(({ activeLoadUnits, capacityUnits }) => activeLoadUnits <= capacityUnits));
      return result({ winnerAssignmentId: winner.assignmentId, pickupCancelState: pickupCancelFinal.state, terminalDeliveryId: terminalAssignment.deliveryId });
    });
  },
};

async function teamReady(ctx, api, worker, fixture, label, roles = ["DRIVER", "LOADER", "ESCORT"]) {
  const created = await createDelivery(ctx, api, fixture, label, { roles, loadUnits: 1 });
  const offers = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => roles.every((role) => items.filter((item) => item.role === role && item.state === "OPEN").length === 5), { processes: [worker] });
  return { ...created, roles, offers };
}

const B03 = {
  id: "B-03",
  async run(ctx) {
    return guarded(["TEAM_AGGREGATE_CLOSURE", "ASSIGNMENT_OR_CAPACITY", "WORK_FENCING_OR_RECOVERY"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "role-local", {
        couriers: Array.from({ length: 12 }, (_, index) => courier(ctx.fixtures, `role-local-${index}`, { capacityUnits: 10, eligibleZones: ["NORTH", "SOUTH", "EAST"] })),
      });
      const { api, workers: [worker] } = await prepare(ctx, fixture.seed, { workers: 1 });
      const team = await teamReady(ctx, api, worker, fixture, "role-local");
      for (const [roleIndex, role] of team.roles.entries()) {
        const roleOffers = team.offers.filter((item) => item.role === role);
        assert.equal(roleOffers.length, 5);
        assert.deepEqual(roleOffers.map(({ roleIndex: index }) => index), Array(5).fill(roleIndex));
        assert.deepEqual(roleOffers.map(({ rank }) => rank), [1, 2, 3, 4, 5]);
      }
      const driver = team.offers.find(({ role }) => role === "DRIVER");
      const sameCourierOtherOffers = team.offers.filter((item) => item.courierId === driver.courierId && item.role !== "DRIVER");
      assert.ok(sameCourierOtherOffers.length >= 1);
      const driverClaim = assertRoleAssignment(requireStatus((await acceptOffer(ctx, api, driver, "driver-claim")).response, 200, "DRIVER role claim"));
      const afterDriver = await getOffers(ctx, api, team.delivery.deliveryId);
      assert.ok(sameCourierOtherOffers.every((item) => afterDriver.find(({ offerId }) => offerId === item.offerId).state === "LOST"));
      await new Promise((resolveWait) => setTimeout(resolveWait, 20_000));
      const loaderOffer = (await getOffers(ctx, api, team.delivery.deliveryId)).find((item) => item.role === "LOADER" && item.state === "OPEN" && item.courierId !== driver.courierId);
      const loaderClaim = assertRoleAssignment(requireStatus((await acceptOffer(ctx, api, loaderOffer, "loader-claim")).response, 200, "LOADER role claim"));
      await waitUntilTimestamp(ctx, driverClaim.claimExpiresAt, 5_000, { processes: [worker] });
      const detail = await ctx.waitFor(async () => {
        const current = await getDelivery(ctx, api, team.delivery.deliveryId);
        const released = current.assignments.find(({ assignmentId }) => assignmentId === driverClaim.assignmentId)?.state === "RELEASED";
        const reoffered = (await getOffers(ctx, api, team.delivery.deliveryId)).some((item) => item.role === "DRIVER" && item.round === 2);
        return released && reoffered ? current : undefined;
      }, { timeoutMs: 30_000, label: "role-local DRIVER re-offer", processes: [worker] });
      const releasedDriver = detail.assignments.find(({ assignmentId }) => assignmentId === driverClaim.assignmentId);
      const retainedLoader = detail.assignments.find(({ assignmentId }) => assignmentId === loaderClaim.assignmentId);
      assert.equal(releasedDriver.state, "RELEASED");
      assert.equal(retainedLoader.state, "RESERVED");
      assert.equal(retainedLoader.claimExpiresAt, loaderClaim.claimExpiresAt);
      const currentOffers = await getOffers(ctx, api, team.delivery.deliveryId);
      assert.ok(currentOffers.filter(({ round }) => round === 2).every(({ role }) => role === "DRIVER"));
      assert.equal(detail.currentRound, 2);
      const snapshot = await ctx.snapshot(api.baseUrl);
      assertCapacityClosure(snapshot.resources);
      assert.equal(snapshot.resources.teamAssignments.filter(({ deliveryId }) => deliveryId === team.delivery.deliveryId).length <= 1, true);
      return result({ deliveryId: team.delivery.deliveryId, releasedAssignmentId: driverClaim.assignmentId, retainedAssignmentId: loaderClaim.assignmentId });
    });
  },
};

function selectDistinctOffers(offers, roles, unavailable = new Set()) {
  const selected = [];
  const used = new Set(unavailable);
  for (const role of roles) {
    const item = offers.find((offerItem) => offerItem.role === role && offerItem.state === "OPEN" && !used.has(offerItem.courierId));
    assert.ok(item, `no distinct Courier for ${role}`);
    selected.push(item);
    used.add(item.courierId);
  }
  return selected;
}

const B04 = {
  id: "B-04",
  async run(ctx) {
    return guarded(["TEAM_AGGREGATE_CLOSURE", "ASSIGNMENT_OR_CAPACITY"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "team-closure", {
        couriers: Array.from({ length: 12 }, (_, index) => courier(ctx.fixtures, `team-closure-${index}`, { capacityUnits: 10, eligibleZones: ["NORTH", "SOUTH", "EAST"] })),
      });
      const { apis, workers } = await prepare(ctx, fixture.seed, { apis: 2, workers: 2 });
      const roles = ["DRIVER", "LOADER", "ESCORT", "NAVIGATOR"];
      const team = await teamReady(ctx, apis[0], workers[0], fixture, "team-closure", roles);
      const selected = selectDistinctOffers(team.offers, roles);
      for (const item of selected.slice(0, 2)) assertRoleAssignment(requireStatus((await acceptOffer(ctx, apis[0], item, `initial-${item.role}`)).response, 200, "initial team role"));
      const finalResponses = await Promise.all(selected.slice(2).map((item, index) => acceptOffer(ctx, apis[index], item, `final-${item.role}`).then(({ response }) => response)));
      finalResponses.forEach((response) => assertRoleAssignment(requireStatus(response, 200, "concurrent final role claim")));
      const active = await getDelivery(ctx, apis[0], team.delivery.deliveryId);
      assert.equal(active.assignments.length, 4);
      assert.equal(new Set(active.assignments.map(({ courierId }) => courierId)).size, 4);
      assert.match(active.teamAssignmentId, /^[0-9a-f-]{36}$/u);
      const activeSnapshot = await ctx.snapshot(apis[0].baseUrl);
      const teamAssignment = activeSnapshot.resources.teamAssignments.find(({ teamAssignmentId }) => teamAssignmentId === active.teamAssignmentId);
      assert.equal(teamAssignment.state, "ACTIVE");
      assert.equal(activeSnapshot.resources.teamAssignments.filter(({ deliveryId }) => deliveryId === active.deliveryId).length, 1);
      for (const item of active.assignments.slice(0, -1)) {
        assertRoleAssignment(requireStatus(await readyAssignment(ctx, apis[0], active.deliveryId, item, `ready-${item.role}`), 200, "partial readiness"));
        const interim = (await ctx.snapshot(apis[0].baseUrl)).resources.teamAssignments.find(({ teamAssignmentId }) => teamAssignmentId === active.teamAssignmentId);
        assert.equal(interim.state, "ACTIVE");
      }
      assertRoleAssignment(requireStatus(await readyAssignment(ctx, apis[1], active.deliveryId, active.assignments.at(-1), "ready-final"), 200, "final readiness"));
      const ready = (await ctx.snapshot(apis[0].baseUrl)).resources.teamAssignments.find(({ teamAssignmentId }) => teamAssignmentId === active.teamAssignmentId);
      assert.equal(ready.state, "READY");
      const pickupResponses = await Promise.all(active.assignments.map((item, index) => pickupDelivery(ctx, apis[index % 2], active.deliveryId, item.courierId, `pickup-${index}`)));
      assert.equal(pickupResponses.filter(({ status }) => status === 200).length, 1);
      assert.ok(pickupResponses.filter(({ status }) => status !== 200).every(({ json }) => json?.error?.code === "DELIVERY_STATE_CONFLICT"));
      const terminalResponses = await Promise.all([
        completeDelivery(ctx, apis[0], active.deliveryId, active.assignments[0].courierId, "team-terminal"),
        cancelDelivery(ctx, apis[1], active.deliveryId, "team-terminal-race"),
      ]);
      assert.equal(terminalResponses[0].status, 200);
      assertExactError(terminalResponses[1], 409, "DELIVERY_STATE_CONFLICT");
      const final = await ctx.snapshot(apis[0].baseUrl);
      const closedTeam = final.resources.teamAssignments.find(({ teamAssignmentId }) => teamAssignmentId === active.teamAssignmentId);
      assert.equal(closedTeam.state, "COMPLETED");
      assert.ok(closedTeam.assignments.every(({ state }) => state === "COMPLETED"));
      assert.equal(final.resources.deliveries.find(({ deliveryId }) => deliveryId === active.deliveryId).state, "DELIVERED");
      assertCapacityClosure(final.resources);
      return result({ deliveryId: active.deliveryId, teamAssignmentId: active.teamAssignmentId, courierIds: active.assignments.map(({ courierId }) => courierId) });
    });
  },
};

const B05 = {
  id: "B-05",
  async run(ctx) {
    return guarded(["DURABLE_IDEMPOTENCY", "ASSIGNMENT_OR_CAPACITY", "TEAM_AGGREGATE_CLOSURE"], async () => {
      const hotCouriers = Array.from({ length: 10 }, (_, index) => courier(ctx.fixtures, `durable-${index}`, {
        capacityUnits: index < 2 ? 1 : 20,
        eligibleZones: ["NORTH", "SOUTH", "EAST"],
      }));
      const fixture = dispatchSeed(ctx.fixtures, "durable", { couriers: hotCouriers });
      const { apis, workers } = await prepare(ctx, fixture.seed, { apis: 2, workers: 2 });
      const shield = await ctx.responseShield(apis[0].baseUrl);
      const createBody = {
        customerId: fixture.customers[0].customerId,
        pickupZone: "NORTH", dropoffZone: "SOUTH",
        readyAt: new Date(Date.now() + 600_000).toISOString(), deliverBy: new Date(Date.now() + 4_200_000).toISOString(), loadUnits: 1,
      };
      const createdReplay = await lostMutation(ctx, shield, apis[1], "/api/v1/deliveries", ctx.key("lost-create"), createBody);
      assert.equal(createdReplay.replay.status, 202);
      const ordinaryId = createdReplay.replay.json.deliveryId;
      await ctx.stop(apis[0]);
      const restarted = await ctx.startApi();
      const restartedShield = await ctx.responseShield(restarted.baseUrl);
      const createReplays = await Promise.all(Array.from({ length: 12 }, (_, index) => ctx.mutate([apis[1], restarted][index % 2].baseUrl, "/api/v1/deliveries", ctx.key("lost-create"), createBody)));
      assert.ok(createReplays.every(({ status, json }) => status === 202 && JSON.stringify(json) === JSON.stringify(createdReplay.replay.json)));
      assertExactError(await ctx.mutate(apis[1].baseUrl, "/api/v1/deliveries", ctx.key("lost-create"), { ...createBody, loadUnits: 2 }), 409, "IDEMPOTENCY_CONFLICT");
      const ordinaryOffers = await waitForOffers(ctx, apis[1], ordinaryId, (items) => items.some(({ state }) => state === "OPEN"), { processes: workers });
      const selected = ordinaryOffers.find(({ state }) => state === "OPEN");
      const acceptBody = { courierId: selected.courierId };
      const acceptedReplay = await lostMutation(ctx, restartedShield, apis[1], `/api/v1/offers/${selected.offerId}/accept`, ctx.key("lost-accept"), acceptBody);
      assertAssignment(acceptedReplay.replay.json);
      const acceptReplays = await Promise.all(Array.from({ length: 12 }, (_, index) => ctx.mutate([apis[1], restarted][index % 2].baseUrl, `/api/v1/offers/${selected.offerId}/accept`, ctx.key("lost-accept"), acceptBody)));
      assert.ok(acceptReplays.every(({ status, json }) => status === acceptedReplay.replay.status && JSON.stringify(json) === JSON.stringify(acceptedReplay.replay.json)));
      requireStatus(await pickupDelivery(ctx, apis[1], ordinaryId, selected.courierId, "ordinary-release"), 200, "ordinary pickup before release");
      requireStatus(await completeDelivery(ctx, apis[1], ordinaryId, selected.courierId, "ordinary-release"), 200, "ordinary complete release");

      const team = await teamReady(ctx, apis[1], workers[0], fixture, "durable-team", ["DRIVER", "LOADER"]);
      const teamOffers = selectDistinctOffers(team.offers, team.roles);
      for (const item of teamOffers) assertRoleAssignment(requireStatus((await acceptOffer(ctx, apis[1], item, `durable-${item.role}`)).response, 200, "durable team claim"));
      let teamDetail = await getDelivery(ctx, apis[1], team.delivery.deliveryId);
      const firstReady = teamDetail.assignments[0];
      const readyReplay = await lostMutation(ctx, restartedShield, restarted, `/api/v1/deliveries/${teamDetail.deliveryId}/assignments/${firstReady.assignmentId}/ready`, ctx.key("lost-ready"), { courierId: firstReady.courierId });
      assertRoleAssignment(readyReplay.replay.json);
      requireStatus(await readyAssignment(ctx, apis[1], teamDetail.deliveryId, teamDetail.assignments[1], "other-ready"), 200, "second readiness");
      requireStatus(await pickupDelivery(ctx, apis[1], teamDetail.deliveryId, firstReady.courierId, "team-before-complete"), 200, "team pickup before lost completion");
      const completeBody = { courierId: firstReady.courierId, proofCode: "proof-123456" };
      const completedReplay = await lostMutation(ctx, restartedShield, restarted, `/api/v1/deliveries/${teamDetail.deliveryId}/complete`, ctx.key("lost-complete"), completeBody);
      assertDelivery(completedReplay.replay.json, { team: true });

      const contenders = [];
      for (let index = 0; index < 4; index += 1) contenders.push(await ordinaryReady(ctx, apis[index % 2 + 1] ?? apis[1], workers[index % workers.length], fixture, `capacity-${index}`));
      const contentionResponses = await Promise.all(contenders.map((target, index) => {
        const chosen = target.offers.find(({ courierId }) => courierId === hotCouriers[0].courierId) ?? target.offers[0];
        return acceptOffer(ctx, [apis[1], restarted][index % 2], chosen, `capacity-${index}`).then(({ response }) => response);
      }));
      assert.equal(contentionResponses.filter(({ status }) => status === 200).length, 1);
      assert.ok(contentionResponses.filter(({ status }) => status !== 200).every(({ json }) => ["COURIER_CAPACITY_CHANGED", "OFFER_LOST"].includes(json?.error?.code)));
      const snapshot = await ctx.snapshot(apis[1].baseUrl);
      assertCapacityClosure(snapshot.resources);
      assert.equal(snapshot.resources.deliveries.filter(({ deliveryId }) => deliveryId === ordinaryId).length, 1);
      assert.equal(snapshot.resources.assignments.filter(({ offerId }) => offerId === selected.offerId).length, 1);
      assert.equal(snapshot.resources.teamAssignments.filter(({ deliveryId }) => deliveryId === teamDetail.deliveryId).length, 1);
      return result({ ordinaryDeliveryId: ordinaryId, teamDeliveryId: teamDetail.deliveryId, replayCounts: { create: createReplays.length, accept: acceptReplays.length }, capacityWinners: contentionResponses.filter(({ status }) => status === 200).length });
    });
  },
};

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05]);
