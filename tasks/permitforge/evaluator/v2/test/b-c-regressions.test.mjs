import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertExactClaimTupleHistory, createHeldRequestProxy, snapshotChangeRefs } from "../cases/b.mjs";
import {
  assertDeliveryMatchesEvent,
  assertExactDeadlineRecovery,
  assertSuccessfulDeliverySequence,
  createMutationCommitBarrier,
} from "../cases/c.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test("evaluator request proxy holds a complete first request until every peer arrived", async () => {
  const upstreamBodies = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    upstreamBodies.push(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: true }));
  });
  const upstreamBaseUrl = await listen(upstream);
  const disposers = [];
  const proxy = await createHeldRequestProxy({ defer: (dispose) => disposers.push(dispose) }, [upstreamBaseUrl, upstreamBaseUrl, upstreamBaseUrl]);
  try {
    const first = fetch(`${proxy.baseUrl}${proxy.pathFor(0, "/first")}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"request\":1}" });
    while (proxy.ledger.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(upstreamBodies.length, 0, "first complete request remains held at evaluator proxy");
    const second = fetch(`${proxy.baseUrl}${proxy.pathFor(1, "/second")}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"request\":2}" });
    while (proxy.ledger.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(upstreamBodies.length, 0, "two complete requests remain held until the third peer arrives");
    const third = fetch(`${proxy.baseUrl}${proxy.pathFor(2, "/third")}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"request\":3}" });
    const responses = await Promise.all([first, second, third]);
    assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200]);
    assert.deepEqual(upstreamBodies.sort(), ["{\"request\":1}", "{\"request\":2}", "{\"request\":3}"]);
    assert.equal(proxy.ledger.length, 3);
    assert.ok(proxy.ledger.every(({ arrivedAt, forwardedAt }) => arrivedAt <= proxy.releasedAt && forwardedAt >= proxy.releasedAt));
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("snapshot delta reports additions removals and in-place corruption across every authority collection", () => {
  const before = {
    asOf: "before",
    resources: {
      applicants: [{ applicantId: "applicant", name: "before" }],
      reviewers: [], permitApplications: [], applicationRevisions: [], reviewClaims: [], reviewDecisions: [], approvedPermits: [], reviewStages: [],
    },
    work: [{ workId: "work", aggregateId: "aggregate", attempt: 1 }],
    events: [],
  };
  const after = structuredClone(before);
  after.asOf = "after";
  after.resources.applicants[0].name = "corrupt";
  after.work = [];
  after.events.push({ eventId: "event", aggregateId: "aggregate" });
  assert.deepEqual(snapshotChangeRefs(before, after), {
    added: ["events:event"],
    changed: ["resources.applicants:applicant"],
    removed: ["work:work"],
  });
});

test("dispatcher delivery binding rejects aggregate-only matches and body drift", () => {
  const event = { eventId: "event-1", aggregateId: "aggregate-1", sequence: 1, type: "application.submitted", payload: {}, schemaVersion: 1, occurredAt: "2035-01-01T00:00:00.000Z" };
  const entry = { json: { workId: "independent-dispatch-work-1", aggregateId: event.aggregateId } };
  const delivery = { headers: { "x-permitforge-event-id": event.eventId, "x-permitforge-event-type": event.type }, json: event, raw: JSON.stringify(event) };
  assert.equal(assertDeliveryMatchesEvent(delivery, entry, event), true);
  assert.throws(() => assertDeliveryMatchesEvent({ ...delivery, headers: { ...delivery.headers, "x-permitforge-event-id": "other-event" } }, entry, event));
  assert.throws(() => assertDeliveryMatchesEvent({ ...delivery, json: { ...event, sequence: 2 } }, entry, event));
});

test("Claim contention oracle rejects an extra expired tuple history and wrong response authority", () => {
  const expected = { applicationId: "application", revision: 1, reviewerId: "reviewer", role: "security" };
  const authority = { ...expected, claimId: "claim-current", state: "LEASED" };
  assert.deepEqual(assertExactClaimTupleHistory([authority], expected, authority.claimId), authority);
  assert.throws(() => assertExactClaimTupleHistory([authority, { ...authority, claimId: "claim-old", state: "EXPIRED" }], expected, authority.claimId), /one complete Claim tuple history/u);
  assert.throws(() => assertExactClaimTupleHistory([authority], expected, "claim-other"), /response authority/u);
});

test("deadline recovery oracle rejects partial before-commit state, duplicate Work and attempt jumps", () => {
  const aggregateId = "application";
  const application = { applicationId: aggregateId, state: "SUBMITTED", sequence: 1 };
  const stage = { stageId: "stage", applicationId: aggregateId, state: "ACTIVE" };
  const event = { eventId: "submitted", aggregateId, sequence: 1, type: "application.submitted" };
  const pending = { workId: "work", aggregateId, attempt: 0, state: "PENDING", terminal: false, leaseOwner: null, leaseExpiresAt: null };
  const resources = { permitApplications: [application], applicationRevisions: [{ applicationId: aggregateId, revision: 1 }], reviewClaims: [], reviewDecisions: [], approvedPermits: [], reviewStages: [stage] };
  const initial = { resources, work: [pending], events: [event] };
  const held = structuredClone(initial);
  held.work[0] = { ...pending, attempt: 1, state: "LEASED", leaseOwner: "worker-a", leaseExpiresAt: "2035-01-01T00:00:03.000Z" };
  const final = structuredClone(initial);
  final.resources.permitApplications[0] = { ...application, state: "EXPIRED", sequence: 2 };
  final.resources.reviewStages[0] = { ...stage, state: "CANCELLED" };
  final.work[0] = { ...pending, attempt: 2, state: "SUCCEEDED", terminal: true };
  final.events.push({ eventId: "expired", aggregateId, sequence: 2, type: "application.expired" });
  const barrier = { json: { workId: "work", aggregateId, attempt: 1 } };
  assert.equal(assertExactDeadlineRecovery(initial, held, final, barrier).work.attempt, 2);
  const partial = structuredClone(held);
  partial.resources.permitApplications[0].state = "EXPIRED";
  assert.throws(() => assertExactDeadlineRecovery(initial, partial, final, barrier), /partial Application/u);
  const duplicate = structuredClone(final);
  duplicate.work.push({ ...duplicate.work[0], workId: "extra" });
  assert.throws(() => assertExactDeadlineRecovery(initial, held, duplicate, barrier), /retains one Work/u);
  const jumped = structuredClone(final);
  jumped.work[0].attempt = 3;
  assert.throws(() => assertExactDeadlineRecovery(initial, held, jumped, barrier), /exactly once/u);
});

test("all successful deliveries, including duplicate ACKs, remain monotonic per aggregate", () => {
  const events = [
    { eventId: "e1", aggregateId: "a", sequence: 1 },
    { eventId: "e2", aggregateId: "a", sequence: 2 },
    { eventId: "e3", aggregateId: "b", sequence: 1 },
  ];
  const delivery = (eventId) => ({ acknowledged: true, responseStatus: 204, headers: { "x-permitforge-event-id": eventId } });
  assert.deepEqual(assertSuccessfulDeliverySequence([delivery("e1"), delivery("e1"), delivery("e3"), delivery("e2")], events), { successful: 4, aggregates: 2 });
  assert.throws(() => assertSuccessfulDeliverySequence([delivery("e2"), delivery("e1")], events), /regressed/u);
  assert.throws(() => assertSuccessfulDeliverySequence([delivery("unknown")], events), /resolves a persisted Event/u);
});

test("mutation commit barrier holds a complete upstream response until evaluator acknowledgement or drop", async () => {
  const upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain */ }
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({ applicationId: "committed" }));
  });
  const upstreamBaseUrl = await listen(upstream);
  const disposers = [];
  const barrier = await createMutationCommitBarrier({ defer: (dispose) => disposers.push(dispose) }, upstreamBaseUrl);
  try {
    let settled = false;
    const pending = fetch(`${barrier.baseUrl}/api/v1/permit-applications`, { method: "POST", body: "{}" })
      .finally(() => { settled = true; });
    const capture = await barrier.waitForCommit();
    assert.equal(capture.response.status, 201);
    assert.equal(JSON.parse(capture.response.body.toString("utf8")).applicationId, "committed");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(settled, false, "client remains unacknowledged after upstream commit");
    barrier.drop();
    await assert.rejects(pending);
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("B/C source keeps exact closure and post-recovery evidence non-vacuous", async () => {
  const [b, c] = await Promise.all([
    readFile(new URL("../cases/b.mjs", import.meta.url), "utf8"),
    readFile(new URL("../cases/c.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(b, /newEvents\.length <= 1/u);
  assert.match(b, /requireStatus\(ctx, authority, 201, "five Stage first-use authority"/u);
  assert.match(b, /all Claim race responses are published outcomes/u);
  assert.match(b, /later Stage was never activated/u);
  assert.match(b, /revision cancels prior Work/u);
  assert.match(b, /prior Revision Work is cancelled/u);
  assert.match(c, /shape-only-no-published-failure-injection-seam/u);
  assert.match(c, /stale Work cannot overwrite committed replacement Revision authority/u);
  assert.match(c, /final snapshot equals pre-dispatch authority/u);
  assert.doesNotMatch(c, /find\(\(\{ json \}\) => json\?\.aggregateId === (?:entry|held)\.json\.aggregateId\)/u);
  assert.match(c, /stale old request replay changes no authority/u);
  assert.doesNotMatch(c, /committedEvents\.length >=/u);
  assert.match(c, /two successful submits commit exactly two Events/u);
});
