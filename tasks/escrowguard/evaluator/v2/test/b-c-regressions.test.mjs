import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { assertUniquePublishedWinner, startArrivalReleaseGate } from "../cases/b.mjs";
import { assertAtomicRefundObservationTrace, assertDeliveryBindings, assertRefundStateEventBoundary } from "../cases/c.mjs";

function context() {
  return {
    equal(actual, expected, label) { assert.deepEqual(actual, expected, label); },
    ok(value, label) { assert.ok(value, label); },
  };
}

const event = Object.freeze({
  eventId: "4c8363af-65e2-4d46-8ee3-22a98119036d",
  aggregateId: "136c36b3-733a-4f37-b477-931ce3ed0316",
  sequence: 3,
  type: "milestone.released",
  occurredAt: "2026-09-02T00:00:00.000Z",
  schemaVersion: 1,
  payload: {},
});

function delivery(overrides = {}) {
  const value = structuredClone(event);
  return {
    headers: {
      "x-escrowguard-event-id": value.eventId,
      "x-escrowguard-event-type": value.type,
      ...(overrides.headers ?? {}),
    },
    json: overrides.json ?? value,
    raw: JSON.stringify(overrides.json ?? value),
    acknowledged: true,
    responseStatus: 204,
  };
}

test("dispatcher evidence is bound to the exact persisted Event, not only a sequence", () => {
  assert.doesNotThrow(() => assertDeliveryBindings(context(), [delivery(), delivery()], [event], "valid retry"));
  assert.throws(() => assertDeliveryBindings(context(), [delivery({ headers: { "x-escrowguard-event-type": "dispute.opened" } })], [event]), /type binds/u);
  assert.throws(() => assertDeliveryBindings(context(), [delivery({ json: { ...event, payload: { invented: true } } })], [event]), /body binds/u);
  assert.throws(() => assertDeliveryBindings(context(), [delivery({ headers: { "x-escrowguard-event-id": "b7767c80-bfe3-48bb-9a88-b005856bf512" } })], [event]), /persisted eventId/u);
});

test("delivery binding fails closed for vacuous receiver or Event evidence", () => {
  assert.throws(() => assertDeliveryBindings(context(), [], [event]), /nonempty receiver/u);
  assert.throws(() => assertDeliveryBindings(context(), [delivery()], []), /nonempty persisted/u);
});

function conflict(code = "MILESTONE_NOT_CURRENT", overrides = {}) {
  return {
    status: 409,
    json: { error: { code, message: "published conflict", details: {} } },
    text: "published conflict",
    ...overrides,
  };
}

test("terminal contention rejects status and error-envelope mutants", () => {
  const winner = { status: 200, json: { releaseId: "winner" }, text: "winner" };
  const codes = ["MILESTONE_NOT_CURRENT", "ESCROW_DISPUTED"];
  assert.equal(assertUniquePublishedWinner([conflict(), winner, conflict("ESCROW_DISPUTED")], codes, "valid contention"), 1);
  assert.throws(() => assertUniquePublishedWinner([winner, winner, conflict()], codes, "double winner"), /exactly one HTTP 200/u);
  assert.throws(() => assertUniquePublishedWinner([winner, { status: 201, json: {} }], codes, "wrong success"), /status/u);
  assert.throws(() => assertUniquePublishedWinner([winner, { status: 500, json: {} }], codes, "server error loser"), /status/u);
  assert.throws(() => assertUniquePublishedWinner([winner, conflict("INVENTED_CONFLICT")], codes, "invented code"), /published code/u);
  assert.throws(() => assertUniquePublishedWinner([winner, conflict("MILESTONE_NOT_CURRENT", { json: { error: { code: "MILESTONE_NOT_CURRENT" } } })], codes, "open envelope"), /exact fields/u);
});

test("evaluator arrival gate receives every request before deterministic release", async (t) => {
  let upstreamRequests = 0;
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) {}
    upstreamRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ upstreamRequests }));
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const deferred = [];
  const gate = await startArrivalReleaseGate({ defer(disposer) { deferred.push(disposer); } }, [`http://127.0.0.1:${address.port}`]);
  t.after(async () => {
    await Promise.allSettled(deferred.map((disposer) => disposer()));
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });

  const pending = Array.from({ length: 8 }, (_, index) => fetch(`${gate.baseUrls[0]}/race/${index}`, { method: "POST", body: JSON.stringify({ index }) }));
  const deadline = Date.now() + 2_000;
  while (gate.arrivals.length < pending.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(gate.arrivals.length, pending.length);
  assert.equal(upstreamRequests, 0, "gate does not leak early arrivals to Candidate APIs");
  gate.releaseAll();
  const responses = await Promise.all(pending);
  assert.ok(responses.every(({ status }) => status === 200));
  assert.deepEqual(gate.arrivals.map(({ arrivalOrdinal }) => arrivalOrdinal), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(gate.arrivals.map(({ releaseOrdinal }) => releaseOrdinal), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(upstreamRequests, pending.length);
});

const aggregateId = "136c36b3-733a-4f37-b477-931ce3ed0316";
function refundBoundarySnapshot({ state = "FUNDED", eventCommitted = false, partial = false } = {}) {
  const refunded = state === "REFUNDED";
  return {
    asOf: "2026-09-02T00:00:00.000Z",
    resources: {
      escrows: [{ escrowId: aggregateId, totalMinor: 100, availableMinor: refunded ? 0 : 100, releasedMinor: 0, refundedMinor: refunded ? 100 : 0, state }],
      milestones: [
        { escrowId: aggregateId, milestoneId: "m-1", state: refunded ? "REFUNDED" : "PENDING" },
        { escrowId: aggregateId, milestoneId: "m-2", state: refunded && !partial ? "REFUNDED" : "PENDING" },
      ],
      disputes: [],
      releases: [],
      beneficiaryShares: [],
      beneficiaryPayouts: [],
    },
    work: [],
    events: [
      { eventId: "funded-event", aggregateId, sequence: 1, type: "escrow.funded" },
      ...(eventCommitted ? [{ eventId: "refund-event", aggregateId, sequence: 2, type: "escrow.refunded" }] : []),
    ],
  };
}

test("commit-barrier oracle kills state-only and Event-only transaction mutants", () => {
  const before = refundBoundarySnapshot();
  const committed = refundBoundarySnapshot({ state: "REFUNDED", eventCommitted: true });
  assert.doesNotThrow(() => assertRefundStateEventBoundary(context(), before, structuredClone(before), aggregateId, false, "held"));
  assert.doesNotThrow(() => assertRefundStateEventBoundary(context(), before, committed, aggregateId, true, "committed"));
  assert.throws(() => assertRefundStateEventBoundary(context(), before, refundBoundarySnapshot({ state: "REFUNDED" }), aggregateId, true, "state-only mutant"), /exact refund Event/u);
  assert.throws(() => assertRefundStateEventBoundary(context(), before, refundBoundarySnapshot({ eventCommitted: true }), aggregateId, true, "Event-only mutant"), /complete refund state/u);
  assert.throws(() => assertRefundStateEventBoundary(context(), before, refundBoundarySnapshot({ state: "REFUNDED", eventCommitted: true, partial: true }), aggregateId, true, "partial state mutant"), /complete Milestone state/u);
  assert.throws(() => assertRefundStateEventBoundary(context(), before, refundBoundarySnapshot({ state: "REFUNDED" }), aggregateId, false, "pre-commit state mutant"), /business state absent/u);
});

test("C-08 sampled commit trace rejects a business-state/Event split in either order", () => {
  const before = refundBoundarySnapshot();
  const committed = refundBoundarySnapshot({ state: "REFUNDED", eventCommitted: true });
  assert.deepEqual(assertAtomicRefundObservationTrace(context(), before, [structuredClone(before), committed], aggregateId), { observations: 2, committedSeen: true });
  assert.throws(() => assertAtomicRefundObservationTrace(context(), before, [structuredClone(before), refundBoundarySnapshot({ state: "REFUNDED" }), committed], aggregateId), /different commits/u);
  assert.throws(() => assertAtomicRefundObservationTrace(context(), before, [structuredClone(before), refundBoundarySnapshot({ eventCommitted: true }), committed], aggregateId), /different commits/u);
  assert.throws(() => assertAtomicRefundObservationTrace(context(), before, [structuredClone(before)], aggregateId), /observes the committed boundary/u);
});
