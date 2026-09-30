import assert from "node:assert/strict";

import {
  assignment, courier, delivery as seededDelivery, dispatchSeed, notification, offer,
} from "../lib/fixtures.mjs";
import { assertDeadlineOutcome, canonical } from "../lib/oracle.mjs";
import {
  acceptOffer, assertAssignment, assertDelivery, assertExactError, assertOffer, assertRoleAssignment,
  cancelDelivery, completeDelivery, createDelivery, deliveryRequest, getDelivery, getOffers, guarded,
  pickupDelivery, prepare, readyAssignment, requireStatus, result, stableSnapshot, waitForDelivery,
  waitForOffers, waitUntilTimestamp,
} from "./helpers.mjs";

const A01 = {
  id: "A-01",
  async run(ctx) {
    return guarded(["ASSIGNMENT_OR_CAPACITY", "DURABLE_IDEMPOTENCY"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "contract");
      const { api } = await prepare(ctx, fixture.seed);
      const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
      const valid = deliveryRequest(fixture);
      const invalid = [
        [await ctx.mutate(api.baseUrl, "/api/v1/deliveries", ctx.key("bad-window"), { ...valid, readyAt: valid.deliverBy }), 400, "INVALID_REQUEST"],
        [await ctx.mutate(api.baseUrl, "/api/v1/deliveries", ctx.key("load-zero"), { ...valid, loadUnits: 0 }), 400, "INVALID_REQUEST"],
        [await ctx.mutate(api.baseUrl, "/api/v1/deliveries", ctx.key("load-high"), { ...valid, loadUnits: 101 }), 400, "INVALID_REQUEST"],
        [await ctx.mutate(api.baseUrl, "/api/v1/deliveries", ctx.key("missing-customer"), { ...valid, customerId: ctx.uuid("missing-customer") }), 400, "INVALID_REQUEST"],
        [await ctx.mutate(api.baseUrl, "/api/v1/deliveries", ctx.key("unknown-field"), { ...valid, surprise: true }), 400, "UNKNOWN_FIELD"],
        [await ctx.request(api.baseUrl, "/api/v1/deliveries", {
          method: "POST", headers: { "idempotency-key": ctx.key("wrong-media"), "content-type": "text/plain" }, raw: JSON.stringify(valid),
        }), 415, "UNSUPPORTED_MEDIA_TYPE"],
        [await ctx.request(api.baseUrl, "/api/v1/deliveries", {
          method: "POST", headers: { "idempotency-key": ctx.key("malformed"), "content-type": "application/json" }, raw: "{",
        }), 400, "MALFORMED_JSON"],
        [await ctx.mutate(api.baseUrl, "/api/v1/deliveries", ctx.key("no-capacity"), { ...valid, loadUnits: 100 }), 409, "NO_ELIGIBLE_COURIER"],
      ];
      for (const [response, status, code] of invalid) assertExactError(response, status, code);
      assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), before, "rejected creates changed durable state");

      const created = await createDelivery(ctx, api, fixture, "valid", { loadUnits: 1 });
      assert.deepEqual(Object.keys(created.delivery).sort(), [
        "assignmentId", "createdAt", "currentRound", "customerId", "deliverBy", "deliveryId", "dropoffZone",
        "loadUnits", "pickupZone", "readyAt", "sequence", "state", "terminalAt",
      ]);
      const detail = await getDelivery(ctx, api, created.delivery.deliveryId);
      assert.deepEqual(detail, created.delivery);
      const firstPage = requireStatus(await ctx.request(api.baseUrl, "/api/v1/deliveries?limit=1"), 200, "Delivery list page one");
      assert.deepEqual(Object.keys(firstPage).sort(), ["items", "nextCursor"]);
      assert.equal(firstPage.items.length, 1);
      firstPage.items.forEach((item) => assertDelivery(item));
      if (firstPage.nextCursor !== null) {
        const secondPage = requireStatus(await ctx.request(api.baseUrl, `/api/v1/deliveries?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`), 200, "Delivery list page two");
        assert.deepEqual(Object.keys(secondPage).sort(), ["items", "nextCursor"]);
      }
      assertExactError(await ctx.request(api.baseUrl, "/api/v1/deliveries?cursor=not-a-cursor"), 400, "INVALID_CURSOR");
      assertExactError(await ctx.request(api.baseUrl, `/api/v1/deliveries/${ctx.uuid("absent-delivery")}`), 404, "NOT_FOUND");
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.equal(snapshot.resources.deliveries.filter(({ deliveryId }) => deliveryId === created.delivery.deliveryId).length, 1);
      assert.equal(snapshot.work.filter(({ aggregateId, kind, terminal }) => aggregateId === created.delivery.deliveryId && kind === "OFFER_ISSUANCE" && !terminal).length, 1);
      assert.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === created.delivery.deliveryId && type === "delivery.requested").length, 1);
      return result({ deliveryId: created.delivery.deliveryId, rejectedRequests: invalid.length, initialWorkId: snapshot.work.find(({ aggregateId }) => aggregateId === created.delivery.deliveryId).workId });
    });
  },
};

function deadlineGraph(ctx) {
  const now = Date.now();
  const targetCourier = courier(ctx.fixtures, "deadline", { capacityUnits: 10, activeLoadUnits: 0 });
  const fixture = dispatchSeed(ctx.fixtures, "deadline", { couriers: [targetCourier] });
  const specifications = [
    { label: "both-past", deliverBy: new Date(now - 10_000).toISOString(), expiresAt: new Date(now - 20_000).toISOString(), expected: "DELIVERY_STATE_CONFLICT" },
    { label: "offer-past", deliverBy: new Date(now + 60_000).toISOString(), expiresAt: new Date(now - 10_000).toISOString(), expected: "OFFER_EXPIRED" },
    { label: "future", deliverBy: new Date(now + 60_000).toISOString(), expiresAt: new Date(now + 30_000).toISOString(), expected: "ASSIGNED" },
  ];
  const graphs = specifications.map((specification, index) => {
    const target = seededDelivery(ctx.fixtures, specification.label, fixture.customers[index], {
      readyAt: new Date(now - 120_000).toISOString(), deliverBy: specification.deliverBy,
      state: "OFFERING", currentRound: 1, sequence: 2, createdAt: new Date(now - 180_000).toISOString(),
    });
    const targetOffer = offer(ctx.fixtures, specification.label, target, targetCourier, {
      createdAt: new Date(now - 60_000).toISOString(), expiresAt: specification.expiresAt,
    });
    const targetNotification = notification(ctx.fixtures, specification.label, targetOffer, targetCourier, { nextAttemptAt: targetOffer.createdAt });
    return { ...specification, delivery: target, offer: targetOffer, notification: targetNotification };
  });
  fixture.seed.deliveries = graphs.map((item) => item.delivery);
  fixture.seed.offers = graphs.map((item) => item.offer);
  fixture.seed.offerNotifications = graphs.map((item) => item.notification);
  return { fixture, graphs, courier: targetCourier };
}

const A02 = {
  id: "A-02",
  async run(ctx) {
    return guarded(["DEADLINE_PRECEDENCE", "ASSIGNMENT_OR_CAPACITY"], async () => {
      const { fixture, graphs, courier: targetCourier } = deadlineGraph(ctx);
      const { api } = await prepare(ctx, fixture.seed);
      const outcomes = [];
      for (const graph of graphs) {
        assert.equal(assertDeadlineOutcome({ now: new Date().toISOString(), deliverBy: graph.deliverBy, expiresAt: graph.expiresAt }), graph.expected);
        const response = (await acceptOffer(ctx, api, graph.offer, graph.label)).response;
        if (graph.expected === "ASSIGNED") {
          const accepted = assertAssignment(requireStatus(response, 200, "valid Offer acceptance"));
          assert.equal(accepted.offerId, graph.offer.offerId);
          assert.equal(accepted.courierId, targetCourier.courierId);
        } else {
          assertExactError(response, 409, graph.expected);
        }
        outcomes.push([graph.label, response.status]);
      }
      const snapshot = await ctx.snapshot(api.baseUrl);
      const bothPast = snapshot.resources.deliveries.find(({ deliveryId }) => deliveryId === graphs[0].delivery.deliveryId);
      assert.equal(bothPast.state, "EXPIRED");
      assert.equal(snapshot.resources.offers.find(({ offerId }) => offerId === graphs[0].offer.offerId).state, "EXPIRED");
      const offerPast = snapshot.resources.deliveries.find(({ deliveryId }) => deliveryId === graphs[1].delivery.deliveryId);
      assert.equal(offerPast.state, "OFFERING");
      assert.equal(snapshot.resources.assignments.some(({ deliveryId }) => deliveryId === offerPast.deliveryId), false);
      const assigned = snapshot.resources.deliveries.find(({ deliveryId }) => deliveryId === graphs[2].delivery.deliveryId);
      assert.equal(assigned.state, "ASSIGNED");
      assert.equal(snapshot.resources.assignments.filter(({ deliveryId }) => deliveryId === assigned.deliveryId).length, 1);
      assert.equal(snapshot.resources.couriers.find(({ courierId }) => courierId === targetCourier.courierId).activeLoadUnits, assigned.loadUnits);
      return result({ outcomes, assignedDeliveryId: assigned.deliveryId });
    });
  },
};

async function ordinaryWithOffer(ctx, api, worker, fixture, label) {
  const created = await createDelivery(ctx, api, fixture, label, { loadUnits: 1 });
  const offers = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => items.some(({ state }) => state === "OPEN"), { processes: [worker] });
  return { ...created, offers };
}

const A03 = {
  id: "A-03",
  async run(ctx) {
    return guarded(["ASSIGNMENT_OR_CAPACITY", "DURABLE_IDEMPOTENCY"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "ordinary-lifecycle");
      const { api, workers: [worker] } = await prepare(ctx, fixture.seed, { workers: 1 });

      const cancelledFixture = await ordinaryWithOffer(ctx, api, worker, fixture, "cancelled");
      const cancelled = assertDelivery(requireStatus(await cancelDelivery(ctx, api, cancelledFixture.delivery.deliveryId, "pre-pickup"), 200, "pre-pickup cancel"));
      assert.equal(cancelled.state, "CANCELLED");
      assert.ok((await getOffers(ctx, api, cancelled.deliveryId)).every(({ state }) => state === "LOST"));
      assertExactError(await pickupDelivery(ctx, api, cancelled.deliveryId, cancelledFixture.offers[0].courierId, "cancelled"), 409, "DELIVERY_STATE_CONFLICT");
      assertExactError(await completeDelivery(ctx, api, cancelled.deliveryId, cancelledFixture.offers[0].courierId, "cancelled"), 409, "DELIVERY_STATE_CONFLICT");

      const proof6Fixture = await ordinaryWithOffer(ctx, api, worker, fixture, "proof-six");
      const accepted = assertAssignment(requireStatus((await acceptOffer(ctx, api, proof6Fixture.offers[0], "proof-six")).response, 200, "ordinary accept"));
      assertExactError(await pickupDelivery(ctx, api, accepted.deliveryId, ctx.uuid("foreign-courier"), "foreign"), 409, "DELIVERY_STATE_CONFLICT");
      const picked = assertDelivery(requireStatus(await pickupDelivery(ctx, api, accepted.deliveryId, accepted.courierId, "proof-six"), 200, "ordinary pickup"));
      assert.equal(picked.state, "PICKED_UP");
      assertExactError(await completeDelivery(ctx, api, accepted.deliveryId, accepted.courierId, "short-proof", { proofCode: "12345" }), 400, "INVALID_REQUEST");
      assertExactError(await completeDelivery(ctx, api, accepted.deliveryId, accepted.courierId, "long-proof", { proofCode: "x".repeat(65) }), 400, "INVALID_REQUEST");
      assert.equal((await getDelivery(ctx, api, accepted.deliveryId)).state, "PICKED_UP");
      const completed6 = assertDelivery(requireStatus(await completeDelivery(ctx, api, accepted.deliveryId, accepted.courierId, "proof-six", { proofCode: "123456" }), 200, "proof length six completion"));
      assert.equal(completed6.state, "DELIVERED");
      assertExactError(await cancelDelivery(ctx, api, accepted.deliveryId, "post-terminal"), 409, "DELIVERY_STATE_CONFLICT");
      assertExactError(await pickupDelivery(ctx, api, accepted.deliveryId, accepted.courierId, "post-terminal"), 409, "DELIVERY_STATE_CONFLICT");

      const proof64Fixture = await ordinaryWithOffer(ctx, api, worker, fixture, "proof-sixty-four");
      const accepted64 = assertAssignment(requireStatus((await acceptOffer(ctx, api, proof64Fixture.offers[0], "proof-sixty-four")).response, 200, "second ordinary accept"));
      requireStatus(await pickupDelivery(ctx, api, accepted64.deliveryId, accepted64.courierId, "proof-sixty-four"), 200, "second ordinary pickup");
      const completed64 = assertDelivery(requireStatus(await completeDelivery(ctx, api, accepted64.deliveryId, accepted64.courierId, "proof-sixty-four", { proofCode: "p".repeat(64) }), 200, "proof length sixty-four completion"));
      assert.equal(completed64.state, "DELIVERED");
      const snapshot = await ctx.snapshot(api.baseUrl);
      for (const deliveryId of [cancelled.deliveryId, completed6.deliveryId, completed64.deliveryId]) {
        assert.equal(snapshot.resources.deliveries.filter((item) => item.deliveryId === deliveryId).length, 1);
      }
      assert.ok(snapshot.resources.couriers.every(({ activeLoadUnits }) => activeLoadUnits === 0));
      return result({ cancelledDeliveryId: cancelled.deliveryId, completedDeliveryIds: [completed6.deliveryId, completed64.deliveryId] });
    });
  },
};

const A04 = {
  id: "A-04",
  async run(ctx) {
    return guarded(["TEAM_AGGREGATE_CLOSURE", "ASSIGNMENT_OR_CAPACITY"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "team-wire");
      const { api, workers: [worker] } = await prepare(ctx, fixture.seed, { workers: 1 });
      const ordinary = await createDelivery(ctx, api, fixture, "ordinary-omitted");
      assert.equal(Object.hasOwn(ordinary.delivery, "requiredRoles"), false);
      const beforeInvalid = stableSnapshot(await ctx.snapshot(api.baseUrl));
      const invalidRoleSets = [["DRIVER"], ["DRIVER", ""], ["DRIVER", "DRIVER"], ["A", "B", "C", "D", "E"]];
      for (const [index, roles] of invalidRoleSets.entries()) {
        const response = await ctx.mutate(api.baseUrl, "/api/v1/deliveries", ctx.key(`bad-roles-${index}`), { ...deliveryRequest(fixture), roles });
        assertExactError(response, 400, "INVALID_TEAM_ROLES");
      }
      assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), beforeInvalid, "invalid team roles left durable effects");

      const createdTeams = [];
      for (const [label, roles] of [["two", ["DRIVER", "LOADER"]], ["four", ["DRIVER", "LOADER", "ESCORT", "NAVIGATOR"]]]) {
        const created = await createDelivery(ctx, api, fixture, `team-${label}`, { roles });
        assert.equal(created.delivery.assignmentId, null);
        assert.deepEqual(created.delivery.requiredRoles, roles);
        const items = await waitForOffers(ctx, api, created.delivery.deliveryId, (offers) => roles.every((role) => offers.some((item) => item.role === role)), { processes: [worker] });
        assert.ok(items.every((item) => Object.hasOwn(item, "roleIndex")));
        for (const item of items) {
          assertOffer(item, { team: true });
          assert.equal(item.role, roles[item.roleIndex]);
        }
        assert.deepEqual(items, items.toSorted((left, right) => left.round - right.round || left.roleIndex - right.roleIndex || left.rank - right.rank || Buffer.from(left.offerId).compare(Buffer.from(right.offerId))));
        const detail = await getDelivery(ctx, api, created.delivery.deliveryId);
        assert.deepEqual(detail.requiredRoles, roles);
        createdTeams.push({ created, roles, items });
      }
      const snapshot = await ctx.snapshot(api.baseUrl);
      for (const { created, roles, items } of createdTeams) for (const item of items) {
        const captured = snapshot.resources.offerNotifications.find(({ notificationId }) => notificationId === item.notificationId);
        assert.equal(captured.body.roleIndex, item.roleIndex);
        assert.equal(captured.body.role, roles[item.roleIndex]);
        assert.equal(captured.body.offerId, item.offerId);
        assert.equal(canonical(captured.body), canonical({
          notificationId: item.notificationId, offerId: item.offerId, deliveryId: created.delivery.deliveryId,
          round: item.round, roleIndex: item.roleIndex, role: item.role, courierId: item.courierId, expiresAt: item.expiresAt,
        }));
      }
      return result({ ordinaryDeliveryId: ordinary.delivery.deliveryId, teamDeliveryIds: createdTeams.map(({ created }) => created.delivery.deliveryId), roleCounts: createdTeams.map(({ roles }) => roles.length) });
    });
  },
};

async function createTeamFixture(ctx, api, worker, fixture, label, roles = ["DRIVER", "LOADER"]) {
  const created = await createDelivery(ctx, api, fixture, label, { roles });
  const offers = await waitForOffers(ctx, api, created.delivery.deliveryId, (items) => roles.every((role) => items.some((item) => item.role === role && item.state === "OPEN")), { processes: [worker] });
  return { ...created, offers, roles };
}

async function fillTeam(ctx, api, target, label) {
  const used = new Set();
  for (const role of target.roles) {
    const selected = target.offers.find((item) => item.role === role && !used.has(item.courierId));
    assert.ok(selected, `no distinct Courier Offer for ${role}`);
    const response = (await acceptOffer(ctx, api, selected, `${label}-${role}`)).response;
    assertRoleAssignment(requireStatus(response, 200, `${role} acceptance`));
    used.add(selected.courierId);
  }
  return getDelivery(ctx, api, target.delivery.deliveryId);
}

const A05 = {
  id: "A-05",
  async run(ctx) {
    return guarded(["TEAM_AGGREGATE_CLOSURE", "ASSIGNMENT_OR_CAPACITY", "DEADLINE_PRECEDENCE"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "team-mutations", {
        couriers: Array.from({ length: 8 }, (_, index) => courier(ctx.fixtures, `team-mutation-${index}`, { capacityUnits: 20, eligibleZones: ["NORTH", "SOUTH", "EAST"] })),
      });
      const { api, workers: [worker] } = await prepare(ctx, fixture.seed, { workers: 1 });
      const conflicts = await createTeamFixture(ctx, api, worker, fixture, "conflicts");
      const first = conflicts.offers.find(({ role }) => role === "DRIVER");
      assertRoleAssignment(requireStatus((await acceptOffer(ctx, api, first, "driver")).response, 200, "first role acceptance"));
      const filledCompetitor = conflicts.offers.find((item) => item.role === "DRIVER" && item.courierId !== first.courierId);
      assertExactError((await acceptOffer(ctx, api, filledCompetitor, "filled-role")).response, 409, "TEAM_ROLE_ALREADY_FILLED");
      const sameCourierOtherRole = conflicts.offers.find((item) => item.role === "LOADER" && item.courierId === first.courierId);
      assert.ok(sameCourierOtherRole, "fanout did not give one Courier another role Offer");
      assertExactError((await acceptOffer(ctx, api, sameCourierOtherRole, "same-courier")).response, 409, "COURIER_TEAM_ROLE_CONFLICT");
      const filled = await fillTeam(ctx, api, { ...conflicts, roles: ["LOADER"], offers: conflicts.offers.filter(({ role }) => role === "LOADER") }, "fill-conflict-team");
      assert.equal(filled.assignments.length, 2);
      assertExactError(await pickupDelivery(ctx, api, filled.deliveryId, filled.assignments[0].courierId, "not-ready"), 409, "TEAM_NOT_READY");
      for (const item of filled.assignments) assertRoleAssignment(requireStatus(await readyAssignment(ctx, api, filled.deliveryId, item, `ready-${item.role}`), 200, "team readiness"));
      assertExactError(await pickupDelivery(ctx, api, filled.deliveryId, ctx.uuid("foreign-team-courier"), "foreign-team"), 409, "TEAM_COURIER_NOT_ASSIGNED");
      const picked = assertDelivery(requireStatus(await pickupDelivery(ctx, api, filled.deliveryId, filled.assignments[0].courierId, "team-pickup"), 200, "team pickup"), { team: true });
      assert.equal(picked.state, "PICKED_UP");
      assertExactError(await cancelDelivery(ctx, api, filled.deliveryId, "after-team-pickup"), 409, "DELIVERY_STATE_CONFLICT");
      const completed = assertDelivery(requireStatus(await completeDelivery(ctx, api, filled.deliveryId, filled.assignments[1].courierId, "team-complete"), 200, "team complete"), { team: true });
      assert.equal(completed.state, "DELIVERED");

      const cancellable = await createTeamFixture(ctx, api, worker, fixture, "team-cancel");
      await acceptOffer(ctx, api, cancellable.offers[0], "team-cancel-reserve");
      const cancelled = assertDelivery(requireStatus(await cancelDelivery(ctx, api, cancellable.delivery.deliveryId, "team-pre-pickup"), 200, "team cancellation"), { team: true });
      assert.equal(cancelled.state, "CANCELLED");

      const expiring = await createTeamFixture(ctx, api, worker, fixture, "expired-claim");
      await ctx.stop(worker);
      const expiringOffer = expiring.offers.find(({ role }) => role === "DRIVER");
      const reserved = assertRoleAssignment(requireStatus((await acceptOffer(ctx, api, expiringOffer, "expiring")).response, 200, "expiring role claim"));
      await waitUntilTimestamp(ctx, reserved.claimExpiresAt, 5_000);
      assertExactError(await readyAssignment(ctx, api, expiring.delivery.deliveryId, reserved, "expired-ready"), 409, "TEAM_ROLE_CLAIM_EXPIRED");
      assertExactError(await pickupDelivery(ctx, api, expiring.delivery.deliveryId, reserved.courierId, "expired-pickup"), 409, "TEAM_ROLE_CLAIM_EXPIRED");
      const snapshot = await ctx.snapshot(api.baseUrl);
      assert.ok(snapshot.resources.couriers.every(({ activeLoadUnits, capacityUnits }) => activeLoadUnits <= capacityUnits));
      return result({ completedTeamId: completed.teamAssignmentId, cancelledDeliveryId: cancelled.deliveryId, expiredAssignmentId: reserved.assignmentId });
    });
  },
};

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05]);
