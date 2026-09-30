import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";

import { beneficiaryRequest, fundedRequest, makeEmptySeed, makeEscrowFixture } from "../fixtures/index.mjs";
import { assertReleasePayouts, assertSnapshot, canonicalJson } from "../oracles/index.mjs";
import {
  acceptMilestone,
  createEscrow,
  defineCase,
  finalEvidence,
  getDetail,
  openDispute,
  prepare,
  resources,
  resolveDispute,
  semanticError,
  stableSnapshot,
  submitViaBrowser,
  successful,
  waitForEscrow,
  waitForWorkDrain,
} from "./helpers.mjs";

function options(ctx) { return { evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime }; }
function eventCount(snapshot, aggregateId, type) { return snapshot.events.filter((event) => event.aggregateId === aggregateId && event.type === type).length; }
function workState(snapshot, aggregateId) { return canonicalJson(snapshot.work.filter((work) => work.aggregateId === aggregateId)); }
function withParties(fixture, label = "empty") {
  const seed = makeEmptySeed(fixture.fixtures, fixture.fixtures.seedVersion(label));
  seed.parties.push(...fixture.parties);
  return seed;
}
function publishedConflict(response, codes, label) {
  assert.equal(response.status, 409, `${label} status`);
  assert.ok(codes.includes(response.json?.error?.code), `${label} published code`);
  semanticError(response, 409, response.json.error.code, label);
}

export function assertUniquePublishedWinner(responses, codes, label) {
  assert.ok(Array.isArray(responses) && responses.length > 1, `${label} has competing responses`);
  const winnerIndexes = responses.flatMap((response, index) => response?.status === 200 ? [index] : []);
  assert.equal(winnerIndexes.length, 1, `${label} has exactly one HTTP 200`);
  for (const [index, response] of responses.entries()) {
    if (index === winnerIndexes[0]) continue;
    publishedConflict(response, codes, `${label} loser ${index}`);
  }
  return winnerIndexes[0];
}

export async function startArrivalReleaseGate(ctx, upstreamBaseUrls) {
  assert.ok(Array.isArray(upstreamBaseUrls) && upstreamBaseUrls.length > 0, "arrival gate upstreams");
  const arrivals = [];
  const servers = [];
  const sockets = new Set();
  let releaseOrdinal = 0;
  let closed = false;

  const listen = (server) => new Promise((resolve, reject) => {
    const failed = (error) => { server.off("listening", ready); reject(error); };
    const ready = () => { server.off("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", ready);
    server.listen(0, "127.0.0.1");
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const entry of arrivals) if (!entry.released && !entry.outgoing.destroyed) entry.outgoing.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  };

  for (const upstreamBaseUrl of upstreamBaseUrls) {
    const server = createServer(async (incoming, outgoing) => {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const target = new URL(incoming.url ?? "/", upstreamBaseUrl);
      const entry = {
        arrivalOrdinal: arrivals.length + 1,
        body,
        incoming,
        outgoing,
        released: false,
        release() {
          if (entry.released || outgoing.destroyed) return;
          entry.released = true;
          entry.releaseOrdinal = releaseOrdinal += 1;
          const proxy = httpRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (upstream) => {
            const responseChunks = [];
            upstream.on("data", (chunk) => responseChunks.push(Buffer.from(chunk)));
            upstream.on("end", () => {
              if (outgoing.destroyed) return;
              outgoing.writeHead(upstream.statusCode ?? 502, upstream.headers);
              outgoing.end(Buffer.concat(responseChunks));
            });
          });
          proxy.on("error", () => { if (!outgoing.destroyed) outgoing.destroy(); });
          proxy.end(body);
        },
      };
      arrivals.push(entry);
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await listen(server);
    servers.push(server);
  }
  ctx.defer(close);
  return {
    arrivals,
    baseUrls: servers.map((server) => {
      const address = server.address();
      assert.ok(address && typeof address !== "string", "arrival gate address");
      return `http://127.0.0.1:${address.port}`;
    }),
    close,
    releaseAll() { for (const entry of [...arrivals].sort((left, right) => left.arrivalOrdinal - right.arrivalOrdinal)) entry.release(); },
  };
}

async function releaseAfterArrivals(ctx, gate, count, label) {
  await ctx.waitFor(() => gate.arrivals.length === count ? gate.arrivals : undefined, { timeoutMs: 10_000, intervalMs: 10, label: `${label} full HTTP arrivals` });
  ctx.equal(gate.arrivals.map(({ arrivalOrdinal }) => arrivalOrdinal), Array.from({ length: count }, (_, index) => index + 1), `${label} arrival order owned by evaluator`);
  gate.releaseAll();
  ctx.equal(gate.arrivals.map(({ releaseOrdinal }) => releaseOrdinal), Array.from({ length: count }, (_, index) => index + 1), `${label} release order owned by evaluator`);
}

export async function releaseHttpAndWorkerTogether(ctx, gate, barrier, heldEntry, count, label, { workerFirst = false } = {}) {
  await ctx.waitFor(() => gate.arrivals.length === count ? gate.arrivals : undefined, { timeoutMs: 10_000, intervalMs: 10, label: `${label} full HTTP arrivals` });
  ctx.equal(gate.arrivals.map(({ arrivalOrdinal }) => arrivalOrdinal), Array.from({ length: count }, (_, index) => index + 1), `${label} arrival order owned by evaluator`);
  const releaseHttp = () => gate.releaseAll();
  const releaseWorker = () => barrier.release(heldEntry);
  if (workerFirst) { releaseWorker(); releaseHttp(); }
  else { releaseHttp(); releaseWorker(); }
  ctx.equal(gate.arrivals.map(({ releaseOrdinal }) => releaseOrdinal), Array.from({ length: count }, (_, index) => index + 1), `${label} HTTP release order owned by evaluator`);
  ctx.ok(heldEntry.released, `${label} Worker barrier released in the same evaluator scheduling turn`);
  return { httpRequests: count, workerFirst };
}
async function stopProcesses(ctx, records) { await Promise.all(records.map((record) => ctx.stop(record))); }

async function unknownResponseReplay(ctx, { target, api, path, key, body, status, admin = false, label }) {
  const shield = await ctx.responseShield(api.baseUrl);
  shield.dropNextMutation();
  await assert.rejects(ctx.mutate(shield.baseUrl, path, key, body, { admin }), `${label} client observes unknown outcome`);
  ctx.equal(shield.captures.length, 1, `${label} captures one complete upstream response`);
  const original = shield.captures[0].response;
  ctx.equal(original.status, status, `${label} upstream committed status`);
  await ctx.stop(api);
  const restarted = await target.startApi();
  const replay = successful(await ctx.mutate(restarted.baseUrl, path, key, body, { admin }), `${label} durable replay`, status);
  ctx.equal(replay.json, JSON.parse(original.body), `${label} exact semantic response survives restart`);
  return { original, replay, restarted };
}

const B01 = defineCase({
  id: "B-01",
  fixtureFamily: "EG-F-BOUNDARY",
  action: "Create one, two and twenty-Milestone Escrows at integer boundaries, then execute a real partial Release, Dispute REFUND and rejected unsafe mutations through public seams.",
  oracle: "After every commit total equals available plus released plus refunded with nonnegative safe integers; each Milestone amount is consumed once and every failed mutation leaves a semantic snapshot diff of zero.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx), { amounts: [30, 20, 50], states: ["SUBMITTED", "PENDING", "PENDING"], label: "conservation-flow" });
    const { api } = await prepare(ctx, { seed: fixture.seed });
    const maximum = await createEscrow(ctx, api.baseUrl, fundedRequest(fixture, [Number.MAX_SAFE_INTEGER]), { key: ctx.key("maximum") });
    ctx.equal(maximum.totalMinor, Number.MAX_SAFE_INTEGER, "MAX_SAFE_INTEGER accepted exactly");
    for (const amounts of [[1], [1, 1], Array(20).fill(1)]) await createEscrow(ctx, api.baseUrl, fundedRequest(fixture, amounts), { key: ctx.key(`bounds-${amounts.length}`) });
    assertSnapshot(await ctx.snapshot(api.baseUrl));

    await acceptMilestone(ctx, api.baseUrl, fixture.escrowId, fixture.milestones[0].milestoneId, { key: ctx.key("partial-release") });
    const afterRelease = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const released = resources(afterRelease).escrows.find(({ escrowId }) => escrowId === fixture.escrowId);
    ctx.equal({ available: released.availableMinor, released: released.releasedMinor, refunded: released.refundedMinor }, { available: 70, released: 30, refunded: 0 }, "partial Release conservation");

    await submitViaBrowser(ctx, api.baseUrl, fixture.escrowId);
    const submitted = await getDetail(ctx, api.baseUrl, fixture.escrowId);
    const dispute = await openDispute(ctx, api.baseUrl, fixture.escrowId, submitted.milestones[1].milestoneId, "BUYER", "refund remainder", { key: ctx.key("refund-dispute") });
    await resolveDispute(ctx, api.baseUrl, dispute.disputeId, "REFUND", "refund current and later", { key: ctx.key("refund-resolution") });
    const afterRefund = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const refunded = resources(afterRefund).escrows.find(({ escrowId }) => escrowId === fixture.escrowId);
    const flowMilestones = resources(afterRefund).milestones.filter(({ escrowId }) => escrowId === fixture.escrowId);
    ctx.equal({ available: refunded.availableMinor, released: refunded.releasedMinor, refunded: refunded.refundedMinor }, { available: 0, released: 30, refunded: 70 }, "REFUND conservation");
    ctx.equal(flowMilestones.map(({ state }) => state), ["RELEASED", "REFUNDED", "REFUNDED"], "each flow amount consumed exactly once");

    const beforeFailure = stableSnapshot(afterRefund);
    for (const totalMinor of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) semanticError(await createEscrow(ctx, api.baseUrl, fundedRequest(fixture, [1], { totalMinor }), { key: ctx.key(`invalid-${totalMinor}`), allowFailure: true }), 400, "INVALID_ESCROW_TOTAL");
    ctx.equal(stableSnapshot(assertSnapshot(await ctx.snapshot(api.baseUrl))), beforeFailure, "boundary failures zero side effect");
    return finalEvidence(ctx, { legalBoundaryEscrows: 4, releasedMinor: 30, refundedMinor: 70, rejected: 4 });
  },
});

const B02 = defineCase({
  id: "B-02",
  fixtureFamily: "EG-F-RACES",
  action: "Queue accept and Dispute requests for current and later ordinals behind an evaluator-owned arrival gate, then release them in one fixed order through two independent APIs.",
  oracle: "Exactly one current request returns HTTP 200; every other request returns an exact closed published 409, later ordinals never bypass current, and losers add no Work or Event.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], label: "ordinal-race" });
    const { apis } = await prepare(ctx, { seed: fixture.seed, apiCount: 2 });
    const before = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const current = fixture.milestones[0];
    const later = fixture.milestones[1];
    const gate = await startArrivalReleaseGate(ctx, apis.map(({ baseUrl }) => baseUrl));
    const operations = Array.from({ length: 64 }, (_, index) => {
      const api = gate.baseUrls[index % 2];
      switch (index % 4) {
        case 0: return { current: true, response: acceptMilestone(ctx, api, fixture.escrowId, current.milestoneId, { key: ctx.key(`current-accept-${index}`), allowFailure: true }) };
        case 1: return { current: true, response: openDispute(ctx, api, fixture.escrowId, current.milestoneId, "BUYER", "current race", { key: ctx.key(`current-dispute-${index}`), allowFailure: true }) };
        case 2: return { current: false, response: acceptMilestone(ctx, api, fixture.escrowId, later.milestoneId, { key: ctx.key(`later-accept-${index}`), allowFailure: true }) };
        default: return { current: false, response: openDispute(ctx, api, fixture.escrowId, later.milestoneId, "SELLER", "later race", { key: ctx.key(`later-dispute-${index}`), allowFailure: true }) };
      }
    });
    const responsePromise = Promise.all(operations.map(({ response }) => response));
    await releaseAfterArrivals(ctx, gate, operations.length, "B-02 contention");
    const responses = await responsePromise;
    const winnerIndex = assertUniquePublishedWinner(responses, ["MILESTONE_NOT_CURRENT", "MILESTONE_NOT_SUBMITTED", "ESCROW_DISPUTED"], "B-02 contention");
    ctx.ok(operations[winnerIndex].current, "B-02 winner targets the current ordinal");

    const after = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const data = resources(after);
    const releases = data.releases.filter(({ escrowId }) => escrowId === fixture.escrowId);
    const disputes = data.disputes.filter(({ escrowId, state }) => escrowId === fixture.escrowId && state === "OPEN");
    ctx.equal(releases.length + disputes.length, 1, "exactly one Release or OPEN Dispute history");
    ctx.equal(after.events.filter(({ aggregateId }) => aggregateId === fixture.escrowId).length, before.events.filter(({ aggregateId }) => aggregateId === fixture.escrowId).length + 1, "losers append no Event");
    ctx.equal(workState(after, fixture.escrowId), workState(before, fixture.escrowId), "losers do not mutate Work");
    return finalEvidence(ctx, { requests: responses.length, winners: 1, transition: releases.length === 1 ? "RELEASE" : "DISPUTE" });
  },
});

const B03 = defineCase({
  id: "B-03",
  fixtureFamily: "EG-F-RACES",
  action: "Hold due expiry Work at worker.claimed, fully queue acceptance through another API behind an evaluator HTTP gate, then release both independent processes in the same scheduling turn and observe convergence.",
  oracle: "Acceptance and expiry serialize without releasing and refunding the same amount; accepted value remains released, only later eligible value refunds, Work is terminal, and Events explain the order exactly once.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], amounts: [40, 60], expiresAt: ctx.at({ days: -2 }), label: "accept-expiry" });
    const { target, apis } = await prepare(ctx, { seed: fixture.seed, apiCount: 2 });
    const before = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const work = before.work.find(({ aggregateId, terminal }) => aggregateId === fixture.escrowId && !terminal);
    ctx.ok(work, "due expiry Work exists");
    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.workId === work.workId });
    const worker = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.workId === work.workId, { timeoutMs: 60_000, processes: [worker] });
    const gate = await startArrivalReleaseGate(ctx, [apis[1].baseUrl]);
    const acceptPath = `/api/v1/escrows/${fixture.escrowId}/milestones/${fixture.milestones[0].milestoneId}/accept`;
    const acceptedPromise = ctx.mutate(gate.baseUrls[0], acceptPath, ctx.key("accept-winner"), {});
    await releaseHttpAndWorkerTogether(ctx, gate, barrier, held, 1, "B-03 accept-versus-expiry");
    const [acceptedResponse, completed] = await Promise.all([acceptedPromise, waitForEscrow(ctx, apis[0].baseUrl, fixture.escrowId, "REFUNDED", [worker])]);
    const accepted = successful(acceptedResponse, "B-03 accepting request", 200).json;
    const { snapshot } = completed;
    const after = assertSnapshot(snapshot);
    const data = resources(after);
    const escrow = data.escrows.find(({ escrowId }) => escrowId === fixture.escrowId);
    const milestones = data.milestones.filter(({ escrowId }) => escrowId === fixture.escrowId);
    const finalWork = after.work.find(({ workId }) => workId === work.workId);
    ctx.equal(escrow.releasedMinor, accepted.amountMinor, "accepted amount remains released");
    ctx.equal(escrow.refundedMinor, 60, "only later amount refunded");
    ctx.equal(milestones.map(({ state }) => state), ["RELEASED", "REFUNDED"], "same amount never released and refunded");
    ctx.ok(finalWork?.terminal, "expiry Work safely terminal");
    ctx.equal(eventCount(after, fixture.escrowId, "milestone.released"), eventCount(before, fixture.escrowId, "milestone.released") + 1, "one release Event");
    ctx.equal(eventCount(after, fixture.escrowId, "escrow.refunded"), eventCount(before, fixture.escrowId, "escrow.refunded") + 1, "one refund Event");
    return finalEvidence(ctx, { releasedMinor: escrow.releasedMinor, refundedMinor: escrow.refundedMinor, workState: finalWork.state });
  },
});

const B04 = defineCase({
  id: "B-04",
  fixtureFamily: "EG-F-RACES",
  action: "Hold thirty-two distinct-key accept and open-Dispute requests at an evaluator-owned HTTP arrival gate, then release the complete set through two APIs in fixed order.",
  oracle: "Exactly one request returns HTTP 200 and establishes RELEASED or DISPUTED; all thirty-one losers are exact closed published 409 responses with no Work, Event, Release or Dispute effect.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], label: "accept-dispute" });
    const { apis } = await prepare(ctx, { seed: fixture.seed, apiCount: 2 });
    const before = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const gate = await startArrivalReleaseGate(ctx, apis.map(({ baseUrl }) => baseUrl));
    const responsePromise = Promise.all(Array.from({ length: 32 }, (_, index) => index % 2 === 0
      ? ctx.mutate(gate.baseUrls[0], `/api/v1/escrows/${fixture.escrowId}/milestones/${fixture.milestones[0].milestoneId}/accept`, ctx.key(`accept-${index}`), {})
      : ctx.mutate(gate.baseUrls[1], `/api/v1/escrows/${fixture.escrowId}/milestones/${fixture.milestones[0].milestoneId}/disputes`, ctx.key(`dispute-${index}`), { openedBy: index % 4 ? "BUYER" : "SELLER", reason: "deterministic race" })));
    await releaseAfterArrivals(ctx, gate, 32, "B-04 contention");
    const responses = await responsePromise;
    assertUniquePublishedWinner(responses, ["MILESTONE_NOT_CURRENT", "MILESTONE_NOT_SUBMITTED", "ESCROW_DISPUTED"], "B-04 contention");

    const after = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const data = resources(after);
    const releases = data.releases.filter(({ escrowId }) => escrowId === fixture.escrowId);
    const disputes = data.disputes.filter(({ escrowId }) => escrowId === fixture.escrowId);
    ctx.ok((releases.length === 1 && disputes.length === 0) || (releases.length === 0 && disputes.length === 1 && disputes[0].state === "OPEN"), "exclusive Release or Dispute history");
    ctx.equal(after.events.filter(({ aggregateId }) => aggregateId === fixture.escrowId).length, before.events.filter(({ aggregateId }) => aggregateId === fixture.escrowId).length + 1, "losers append no Event");
    ctx.equal(workState(after, fixture.escrowId), workState(before, fixture.escrowId), "losers mutate no Work");
    return finalEvidence(ctx, { transition: releases.length ? "RELEASE" : "DISPUTE", losers: responses.length - 1 });
  },
});

const B05 = defineCase({
  id: "B-05",
  fixtureFamily: "EG-F-RACES",
  action: "Prove OPEN Dispute blocks expiry, then fully queue RELEASE and REFUND resolutions behind an evaluator arrival gate while due Work is held and release the API processes and Worker together.",
  oracle: "Exactly one resolution returns HTTP 200, every other resolution is an exact closed published 409, expiry never bypasses unresolved Dispute, and final Fund Position, Work and Events agree.",
  async run(ctx) {
    const blockedFixture = makeEscrowFixture(options(ctx), { states: ["DISPUTED", "PENDING"], amounts: [30, 70], dispute: { state: "OPEN", milestoneIndex: 0 }, expiresAt: ctx.at({ days: -2 }), label: "open-dispute-block" });
    let prepared = await prepare(ctx, { seed: blockedFixture.seed });
    const blockedBefore = assertSnapshot(await ctx.snapshot(prepared.api.baseUrl));
    const blockedWork = blockedBefore.work.find(({ aggregateId, terminal }) => aggregateId === blockedFixture.escrowId && !terminal);
    ctx.ok(blockedWork, "OPEN Dispute retains due Work");
    let heldCommit = false;
    const blocker = await ctx.barrier({ hold: (payload) => payload.point === "worker.before-commit" && payload.workId === blockedWork.workId && !heldCommit && (heldCommit = true) });
    const blockerWorker = await prepared.target.startWorker({ env: { TEST_BARRIER_URL: blocker.url, TEST_BARRIER_TOKEN: blocker.token } });
    const blockedAtCommit = await blocker.waitFor((entry) => entry.json?.point === "worker.before-commit" && entry.json.workId === blockedWork.workId, { timeoutMs: 60_000, processes: [blockerWorker] });
    blocker.release(blockedAtCommit);
    const blockedAfter = assertSnapshot(await ctx.waitFor(async () => {
      const candidate = assertSnapshot(await ctx.snapshot(prepared.api.baseUrl));
      const currentWork = candidate.work.find(({ workId }) => workId === blockedWork.workId);
      const reclaimed = blocker.ledger.some(({ json }) => json?.point === "worker.claimed" && json.workId === blockedWork.workId && json.attempt > blockedAtCommit.json.attempt);
      return currentWork?.terminal || currentWork?.state === "PENDING" || currentWork?.attempt > blockedAtCommit.json.attempt || reclaimed ? candidate : undefined;
    }, { timeoutMs: 15_000, intervalMs: 50, label: "OPEN Dispute expiry attempt finishes safely", processes: [blockerWorker] }));
    const blockedResources = resources(blockedAfter);
    const stillDisputed = blockedResources.escrows.find(({ escrowId }) => escrowId === blockedFixture.escrowId);
    ctx.equal({ state: stillDisputed.state, available: stillDisputed.availableMinor, released: stillDisputed.releasedMinor, refunded: stillDisputed.refundedMinor }, { state: "DISPUTED", available: 100, released: 0, refunded: 0 }, "expiry cannot bypass an unresolved Dispute");
    ctx.equal(blockedResources.disputes.find(({ disputeId }) => disputeId === blockedFixture.dispute.disputeId).state, "OPEN", "Worker cannot resolve the Dispute");
    ctx.equal(blockedResources.releases.filter(({ escrowId }) => escrowId === blockedFixture.escrowId).length, 0, "blocked expiry creates no Release");
    ctx.equal(blockedAfter.events.filter(({ aggregateId }) => aggregateId === blockedFixture.escrowId).map(({ eventId }) => eventId), blockedBefore.events.filter(({ aggregateId }) => aggregateId === blockedFixture.escrowId).map(({ eventId }) => eventId), "blocked expiry appends no Event");
    await ctx.kill(blockerWorker);

    await ctx.resetDatabase();
    const fixture = makeEscrowFixture(options(ctx), { states: ["DISPUTED", "PENDING"], amounts: [30, 70], dispute: { state: "OPEN", milestoneIndex: 0 }, expiresAt: ctx.at({ days: -2 }), label: "resolution-race" });
    prepared = await prepare(ctx, { seed: fixture.seed, apiCount: 2, build: false });
    const { target, apis } = prepared;
    const before = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const work = before.work.find(({ aggregateId, terminal }) => aggregateId === fixture.escrowId && !terminal);
    ctx.ok(work, "due disputed Work exists");
    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.workId === work.workId });
    const worker = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.workId === work.workId, { timeoutMs: 60_000, processes: [worker] });
    const gate = await startArrivalReleaseGate(ctx, apis.map(({ baseUrl }) => baseUrl));
    const responsePromise = Promise.all(Array.from({ length: 32 }, (_, index) => resolveDispute(ctx, gate.baseUrls[index % 2], fixture.dispute.disputeId, index % 2 === 0 ? "RELEASE" : "REFUND", `decision-${index}`, { key: ctx.key(`resolve-${index}`), allowFailure: true })));
    await releaseHttpAndWorkerTogether(ctx, gate, barrier, held, 32, "B-05 resolution-versus-expiry", { workerFirst: true });
    const [responses] = await Promise.all([responsePromise, waitForWorkDrain(ctx, apis[0].baseUrl, ({ workId }) => workId === work.workId, [worker])]);
    assertUniquePublishedWinner(responses, ["MILESTONE_NOT_CURRENT", "ESCROW_DISPUTED", "ESCROW_TERMINAL"], "B-05 resolution contention");
    const after = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    const data = resources(after);
    const escrow = data.escrows.find(({ escrowId }) => escrowId === fixture.escrowId);
    const dispute = data.disputes.find(({ disputeId }) => disputeId === fixture.dispute.disputeId);
    ctx.ok(["RESOLVED_RELEASE", "RESOLVED_REFUND"].includes(dispute.state), "Dispute terminal");
    if (dispute.state === "RESOLVED_RELEASE") ctx.equal({ released: escrow.releasedMinor, refunded: escrow.refundedMinor }, { released: 30, refunded: 70 }, "release then expiry result");
    else ctx.equal({ released: escrow.releasedMinor, refunded: escrow.refundedMinor }, { released: 0, refunded: 100 }, "refund resolution result");
    ctx.equal(escrow.totalMinor, escrow.availableMinor + escrow.releasedMinor + escrow.refundedMinor, "terminal race conservation");
    ctx.equal(eventCount(after, fixture.escrowId, "dispute.resolved"), eventCount(before, fixture.escrowId, "dispute.resolved") + 1, "one resolution Event");
    ctx.equal(eventCount(after, fixture.escrowId, "escrow.refunded"), eventCount(before, fixture.escrowId, "escrow.refunded") + 1, "one refund Event");
    ctx.equal(eventCount(after, fixture.escrowId, "milestone.released"), eventCount(before, fixture.escrowId, "milestone.released") + (dispute.state === "RESOLVED_RELEASE" ? 1 : 0), "release resolution has its exact terminal Event");
    ctx.equal(after.events.filter(({ aggregateId }) => aggregateId === fixture.escrowId).length - before.events.filter(({ aggregateId }) => aggregateId === fixture.escrowId).length, dispute.state === "RESOLVED_RELEASE" ? 3 : 2, "no duplicate or unexplained terminal Event");
    ctx.ok(after.work.find(({ workId }) => workId === work.workId)?.terminal, "competing Work terminal");
    return finalEvidence(ctx, { decision: dispute.state, loserCount: responses.length - 1 });
  },
});

const B06 = defineCase({
  id: "B-06",
  fixtureFamily: "EG-F-IDEMPOTENCY",
  action: "Drop complete upstream responses for funded-create, Dispute-open and beneficiary Release mutations, restarting the API before each identical replay.",
  oracle: "Every replay returns its original status and semantic JSON, while Escrow, Release, Payout, Dispute, Work and Event effects each remain exactly once.",
  async run(ctx) {
    const createFixture = makeEscrowFixture(options(ctx));
    let prepared = await prepare(ctx, { seed: withParties(createFixture, "unknown-create") });
    const createBody = fundedRequest(createFixture, [30, 70]);
    let replayed = await unknownResponseReplay(ctx, { target: prepared.target, api: prepared.api, path: "/api/v1/escrows", key: ctx.key("unknown-create"), body: createBody, status: 201, label: "funded create" });
    let snapshot = assertSnapshot(await ctx.snapshot(replayed.restarted.baseUrl));
    const matching = resources(snapshot).escrows.filter(({ buyerId, sellerId, totalMinor }) => buyerId === createBody.buyerId && sellerId === createBody.sellerId && totalMinor === createBody.totalMinor);
    ctx.equal(matching.length, 1, "one unknown-outcome Escrow");
    const createdId = matching[0].escrowId;
    ctx.equal(resources(snapshot).milestones.filter(({ escrowId }) => escrowId === createdId).length, 2, "one Milestone set");
    ctx.equal(snapshot.work.filter(({ aggregateId }) => aggregateId === createdId).length, 1, "one expiry Work");
    ctx.equal(snapshot.events.filter(({ aggregateId, type }) => aggregateId === createdId && type === "escrow.funded").length, 1, "one funded Event");

    await ctx.resetDatabase();
    const disputeFixture = makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], label: "unknown-dispute" });
    prepared = await prepare(ctx, { seed: disputeFixture.seed, build: false });
    const beforeDispute = assertSnapshot(await ctx.snapshot(prepared.api.baseUrl));
    const disputePath = `/api/v1/escrows/${disputeFixture.escrowId}/milestones/${disputeFixture.milestones[0].milestoneId}/disputes`;
    replayed = await unknownResponseReplay(ctx, { target: prepared.target, api: prepared.api, path: disputePath, key: ctx.key("unknown-dispute"), body: { openedBy: "BUYER", reason: "unknown response dispute" }, status: 200, label: "Dispute open" });
    snapshot = assertSnapshot(await ctx.snapshot(replayed.restarted.baseUrl));
    const disputes = resources(snapshot).disputes.filter(({ escrowId }) => escrowId === disputeFixture.escrowId);
    ctx.equal(disputes.length, 1, "one durable Dispute effect");
    ctx.equal(disputes[0].state, "OPEN", "unknown-response Dispute remains OPEN");
    ctx.equal(eventCount(snapshot, disputeFixture.escrowId, "dispute.opened"), eventCount(beforeDispute, disputeFixture.escrowId, "dispute.opened") + 1, "one dispute Event");
    ctx.equal(workState(snapshot, disputeFixture.escrowId), workState(beforeDispute, disputeFixture.escrowId), "Dispute replay does not duplicate Work");

    await ctx.resetDatabase();
    const payoutFixture = makeEscrowFixture(options(ctx));
    prepared = await prepare(ctx, { seed: withParties(payoutFixture, "unknown-payout"), build: false });
    const payoutEscrow = await createEscrow(ctx, prepared.api.baseUrl, beneficiaryRequest(payoutFixture, [20, 2]), { key: ctx.key("unknown-payout-create") });
    await submitViaBrowser(ctx, prepared.api.baseUrl, payoutEscrow.escrowId);
    const payoutDetail = await getDetail(ctx, prepared.api.baseUrl, payoutEscrow.escrowId);
    const payoutMilestone = payoutDetail.milestones[0];
    const capturedShares = payoutDetail.beneficiaryShares.filter(({ milestoneId }) => milestoneId === payoutMilestone.milestoneId);
    const beforePayout = assertSnapshot(await ctx.snapshot(prepared.api.baseUrl));
    const payoutPath = `/api/v1/escrows/${payoutEscrow.escrowId}/milestones/${payoutMilestone.milestoneId}/accept`;
    replayed = await unknownResponseReplay(ctx, { target: prepared.target, api: prepared.api, path: payoutPath, key: ctx.key("unknown-payout-release"), body: {}, status: 200, label: "beneficiary Release" });
    assertReleasePayouts(replayed.replay.json, capturedShares);
    snapshot = assertSnapshot(await ctx.snapshot(replayed.restarted.baseUrl));
    const payoutData = resources(snapshot);
    const releases = payoutData.releases.filter(({ escrowId }) => escrowId === payoutEscrow.escrowId);
    ctx.equal(releases.length, 1, "one durable Release effect");
    const payouts = payoutData.beneficiaryPayouts.filter(({ releaseId }) => releaseId === releases[0].releaseId);
    ctx.equal(payouts.length, capturedShares.length, "one complete durable Payout set");
    ctx.equal(new Set(payouts.map(({ beneficiaryShareId }) => beneficiaryShareId)), new Set(capturedShares.map(({ beneficiaryShareId }) => beneficiaryShareId)), "Payout identities bind exactly to captured Shares");
    ctx.equal(eventCount(snapshot, payoutEscrow.escrowId, "milestone.released"), eventCount(beforePayout, payoutEscrow.escrowId, "milestone.released") + 1, "one beneficiary release Event");
    ctx.equal(workState(snapshot, payoutEscrow.escrowId), workState(beforePayout, payoutEscrow.escrowId), "Release replay does not duplicate Work");
    return finalEvidence(ctx, { scenarios: ["funded-create", "dispute-open", "beneficiary-release"], escrowId: createdId, payouts: payouts.length });
  },
});

const B07 = defineCase({
  id: "B-07",
  fixtureFamily: "EG-F-IDEMPOTENCY",
  action: "Issue sixty-four simultaneous identical funded-create requests through two APIs, then reuse the key with a different but independently valid body and replay through a restarted third API.",
  oracle: "Identical callers converge on one response, a valid semantic change returns IDEMPOTENCY_CONFLICT, durable replay survives process restart, and only one aggregate effect exists.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx));
    const { target, apis } = await prepare(ctx, { seed: withParties(fixture, "same-key"), apiCount: 2 });
    const key = ctx.key("shared");
    const body = fundedRequest(fixture, [50, 50]);
    const responses = await Promise.all(Array.from({ length: 64 }, (_, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/escrows", key, body)));
    ctx.equal(responses.length, 64, "all callers returned");
    ctx.ok(responses.every(({ status }) => status === 201), "all identical responses 201");
    ctx.equal(new Set(responses.map(({ json }) => canonicalJson(json))).size, 1, "one semantic response");
    const changed = { ...body, sellerId: fixture.parties[2].partyId };
    semanticError(await ctx.mutate(apis[0].baseUrl, "/api/v1/escrows", key, changed), 409, "IDEMPOTENCY_CONFLICT");
    await stopProcesses(ctx, apis);
    const third = await target.startApi();
    const replay = successful(await ctx.mutate(third.baseUrl, "/api/v1/escrows", key, body), "third API replay", 201);
    ctx.equal(replay.json, responses[0].json, "third API durable replay");
    const snapshot = assertSnapshot(await ctx.snapshot(third.baseUrl));
    const escrows = resources(snapshot).escrows;
    ctx.equal(escrows.length, 1, "one Escrow effect");
    ctx.equal(resources(snapshot).milestones.filter(({ escrowId }) => escrowId === escrows[0].escrowId).length, 2, "one Milestone set");
    ctx.equal(snapshot.work.filter(({ aggregateId }) => aggregateId === escrows[0].escrowId).length, 1, "one expiry Work");
    ctx.equal(snapshot.events.filter(({ aggregateId }) => aggregateId === escrows[0].escrowId).length, 1, "one funded Event");
    return finalEvidence(ctx, { callers: responses.length, escrowId: escrows[0].escrowId });
  },
});

const B08 = defineCase({
  id: "B-08",
  fixtureFamily: "EG-F-RACES",
  action: "For fixed accept, RELEASE and REFUND schedules, fully queue distinct-key primary and stale requests while two Workers contend for held Work, then release HTTP and Work in the same evaluator turn with alternating release order.",
  oracle: "Each schedule has exactly one HTTP 200 and every other request is an exact closed published 409; the winner replays exactly, expiry converges atomically, and processes stop between schedules.",
  async run(ctx) {
    const outcomes = [];
    for (let schedule = 0; schedule < 3; schedule += 1) {
      if (schedule > 0) await ctx.resetDatabase();
      const fixture = schedule === 0
        ? makeEscrowFixture(options(ctx), { states: ["SUBMITTED", "PENDING"], amounts: [40, 60], expiresAt: ctx.at({ days: -2 }), label: "distinct-accept" })
        : makeEscrowFixture(options(ctx), { states: ["DISPUTED", "PENDING"], amounts: [40, 60], dispute: { state: "OPEN", milestoneIndex: 0 }, expiresAt: ctx.at({ days: -2 }), label: `distinct-resolve-${schedule}` });
      const { target, apis } = await prepare(ctx, { seed: fixture.seed, apiCount: 2, build: schedule === 0 });
      const before = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
      const work = before.work.find(({ aggregateId, terminal }) => aggregateId === fixture.escrowId && !terminal);
      ctx.ok(work, `schedule ${schedule} due Work`);
      let holdClaims = true;
      const barrier = await ctx.barrier({ hold: (payload) => holdClaims && payload.point === "worker.claimed" && payload.workId === work.workId });
      const workers = await Promise.all([target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }), target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } })]);
      const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.workId === work.workId, { timeoutMs: 60_000, processes: workers });
      const gate = await startArrivalReleaseGate(ctx, apis.map(({ baseUrl }) => baseUrl));
      const requests = Array.from({ length: 24 }, (_, index) => {
        const key = ctx.key(`schedule-${schedule}-primary-${index}`);
        if (schedule === 0) {
          const path = `/api/v1/escrows/${fixture.escrowId}/milestones/${fixture.milestones[0].milestoneId}/accept`;
          return { key, path, body: {}, admin: false, response: ctx.mutate(gate.baseUrls[index % 2], path, key, {}) };
        }
        const decision = schedule === 1 ? "RELEASE" : "REFUND";
        const body = { decision, note: `schedule-${schedule}-${index}` };
        const path = `/api/v1/admin/disputes/${fixture.dispute.disputeId}/resolve`;
        return { key, path, body, admin: true, decision, response: ctx.mutate(gate.baseUrls[index % 2], path, key, body, { admin: true }) };
      });
      const stale = Array.from({ length: 8 }, (_, index) => {
        const milestone = schedule === 0 ? fixture.milestones[1] : fixture.milestones[0];
        const key = ctx.key(`schedule-${schedule}-stale-${index}`);
        const path = `/api/v1/escrows/${fixture.escrowId}/milestones/${milestone.milestoneId}/accept`;
        return { key, path, body: {}, admin: false, response: ctx.mutate(gate.baseUrls[index % 2], path, key, {}) };
      });
      const responsePromise = Promise.all(requests.map(({ response }) => response));
      const stalePromise = Promise.all(stale.map(({ response }) => response));
      await releaseHttpAndWorkerTogether(ctx, gate, barrier, held, requests.length + stale.length, `B-08 schedule ${schedule}`, { workerFirst: schedule % 2 === 1 });
      const completionPromise = waitForWorkDrain(ctx, apis[0].baseUrl, ({ workId }) => workId === work.workId, workers);
      const [responses, staleResponses] = await Promise.all([responsePromise, stalePromise, completionPromise]);
      const winnerIndex = assertUniquePublishedWinner([...responses, ...staleResponses], ["MILESTONE_NOT_CURRENT", "MILESTONE_NOT_SUBMITTED", "ESCROW_DISPUTED", "ESCROW_TERMINAL"], `B-08 schedule ${schedule}`);
      ctx.ok(winnerIndex < responses.length, `schedule ${schedule} winner is a primary transition`);
      holdClaims = false;
      barrier.releaseAll();
      const winner = requests[winnerIndex];
      const after = assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
      const escrow = resources(after).escrows.find(({ escrowId }) => escrowId === fixture.escrowId);
      const replay = await ctx.mutate(apis[(winnerIndex + 1) % 2].baseUrl, winner.path, winner.key, winner.body, { admin: winner.admin });
      ctx.equal({ status: replay.status, json: replay.json }, { status: responses[winnerIndex].status, json: responses[winnerIndex].json }, `schedule ${schedule} committed winner exact saved replay`);
      if (schedule === 0) {
        const releases = resources(after).releases.filter(({ escrowId }) => escrowId === fixture.escrowId);
        ctx.equal(releases.length, 1, "accept schedule has one Release");
        ctx.equal(responses[winnerIndex].json.releaseId, releases[0].releaseId, "accept winner response binds to final Release");
        ctx.equal(eventCount(after, fixture.escrowId, "milestone.released"), eventCount(before, fixture.escrowId, "milestone.released") + 1, "accept schedule has one release Event");
        ctx.equal(eventCount(after, fixture.escrowId, "escrow.refunded"), eventCount(before, fixture.escrowId, "escrow.refunded") + 1, "accept schedule expiry has one refund Event");
        ctx.equal({ released: escrow.releasedMinor, refunded: escrow.refundedMinor }, { released: 40, refunded: 60 }, "accept versus expiry consumes each amount once");
      } else {
        const dispute = resources(after).disputes.find(({ disputeId }) => disputeId === fixture.dispute.disputeId);
        ctx.equal(dispute.state, winner.decision === "RELEASE" ? "RESOLVED_RELEASE" : "RESOLVED_REFUND", `schedule ${schedule} response explains history`);
        ctx.equal(eventCount(after, fixture.escrowId, "dispute.resolved"), eventCount(before, fixture.escrowId, "dispute.resolved") + 1, `schedule ${schedule} one resolution Event`);
        ctx.equal(eventCount(after, fixture.escrowId, "milestone.released"), eventCount(before, fixture.escrowId, "milestone.released") + (winner.decision === "RELEASE" ? 1 : 0), `schedule ${schedule} exact release Event`);
        ctx.equal(eventCount(after, fixture.escrowId, "escrow.refunded"), eventCount(before, fixture.escrowId, "escrow.refunded") + 1, `schedule ${schedule} exact refund Event`);
        ctx.equal({ released: escrow.releasedMinor, refunded: escrow.refundedMinor }, winner.decision === "RELEASE" ? { released: 40, refunded: 60 } : { released: 0, refunded: 100 }, `schedule ${schedule} terminal amounts explain winner`);
      }
      ctx.equal(escrow.totalMinor, escrow.availableMinor + escrow.releasedMinor + escrow.refundedMinor, `schedule ${schedule} conservation`);
      ctx.ok(after.work.find(({ workId }) => workId === work.workId)?.terminal, `schedule ${schedule} terminal Work`);
      outcomes.push({ transition: schedule === 0 ? "ACCEPT" : winner.decision, releasedMinor: escrow.releasedMinor, refundedMinor: escrow.refundedMinor, replayedCommittedKeys: 1 });
      await gate.close();
      await stopProcesses(ctx, [...workers, ...apis]);
    }
    return finalEvidence(ctx, { schedules: outcomes });
  },
});

const B09 = defineCase({
  id: "B-09",
  fixtureFamily: "EG-F-FINAL-SHARES",
  action: "First release a gated set of distinct-key accepts through two APIs to contend on real business locks, then reset and independently drop and replay one same-key twenty-Share acceptance.",
  oracle: "Distinct keys yield one HTTP 200 and only published 409 losers without deadlock; the separate unknown response replays exactly, and both paths persist one all-or-none Release and Payout set.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx));
    let prepared = await prepare(ctx, { seed: withParties(fixture, "payout-distinct-keys"), apiCount: 2 });
    const { apis } = prepared;
    const escrow = await createEscrow(ctx, apis[0].baseUrl, beneficiaryRequest(fixture, [20, 2]), { key: ctx.key("beneficiary-create") });
    await submitViaBrowser(ctx, apis[0].baseUrl, escrow.escrowId);
    const detail = await getDetail(ctx, apis[0].baseUrl, escrow.escrowId);
    const current = detail.milestones[0];
    const currentShares = detail.beneficiaryShares.filter(({ milestoneId }) => milestoneId === current.milestoneId);
    const laterShares = detail.beneficiaryShares.filter(({ milestoneId }) => milestoneId === detail.milestones[1].milestoneId);
    ctx.ok(laterShares.some(({ beneficiaryId }) => currentShares.some((share) => share.beneficiaryId === beneficiaryId)), "beneficiary repeats only across Milestones");
    const gate = await startArrivalReleaseGate(ctx, apis.map(({ baseUrl }) => baseUrl));
    const path = `/api/v1/escrows/${escrow.escrowId}/milestones/${current.milestoneId}/accept`;
    const distinctPromise = Promise.all(Array.from({ length: 32 }, (_, index) => ctx.mutate(gate.baseUrls[index % 2], path, ctx.key(`payout-distinct-${index}`), {})));
    await releaseAfterArrivals(ctx, gate, 32, "B-09 distinct-key payout contention");
    const distinctResponses = await distinctPromise;
    const winnerIndex = assertUniquePublishedWinner(distinctResponses, ["MILESTONE_NOT_CURRENT", "MILESTONE_NOT_SUBMITTED", "ESCROW_TERMINAL"], "B-09 distinct-key payout contention");
    assertReleasePayouts(distinctResponses[winnerIndex].json, currentShares);
    const afterDistinct = await getDetail(ctx, apis[0].baseUrl, escrow.escrowId);
    ctx.equal(afterDistinct.releases.length, 1, "distinct-key contention creates one Release");
    ctx.equal(afterDistinct.beneficiaryPayouts.length, currentShares.length, "distinct-key contention creates a complete Payout set");
    ctx.equal(new Set(afterDistinct.beneficiaryPayouts.map(({ payoutId }) => payoutId)).size, currentShares.length, "distinct-key Payout identities unique");
    ctx.ok(afterDistinct.beneficiaryPayouts.every(({ beneficiaryShareId }) => currentShares.some((share) => share.beneficiaryShareId === beneficiaryShareId)), "later Shares remain unpaid after distinct-key contention");
    assertSnapshot(await ctx.snapshot(apis[0].baseUrl));
    await gate.close();

    await ctx.resetDatabase();
    const replayFixture = makeEscrowFixture(options(ctx), { label: "payout-same-key-replay" });
    prepared = await prepare(ctx, { seed: withParties(replayFixture, "payout-same-key-replay"), build: false });
    const replayEscrow = await createEscrow(ctx, prepared.api.baseUrl, beneficiaryRequest(replayFixture, [20, 2]), { key: ctx.key("replay-beneficiary-create") });
    await submitViaBrowser(ctx, prepared.api.baseUrl, replayEscrow.escrowId);
    const replayBefore = await getDetail(ctx, prepared.api.baseUrl, replayEscrow.escrowId);
    const replayMilestone = replayBefore.milestones[0];
    const replayShares = replayBefore.beneficiaryShares.filter(({ milestoneId }) => milestoneId === replayMilestone.milestoneId);
    const replayPath = `/api/v1/escrows/${replayEscrow.escrowId}/milestones/${replayMilestone.milestoneId}/accept`;
    const replayed = await unknownResponseReplay(ctx, { target: prepared.target, api: prepared.api, path: replayPath, key: ctx.key("payout-same-key"), body: {}, status: 200, label: "same-key beneficiary Release" });
    const replayRelease = assertReleasePayouts(replayed.replay.json, replayShares);
    ctx.equal(replayed.replay.json, JSON.parse(replayed.original.body), "same-key replay preserves the hidden response exactly");
    const afterReplay = await getDetail(ctx, replayed.restarted.baseUrl, replayEscrow.escrowId);
    ctx.equal(afterReplay.releases.length, 1, "same-key replay creates one Release");
    ctx.equal(afterReplay.releases[0].releaseId, replayRelease.releaseId, "same-key replay retains Release identity");
    ctx.equal(afterReplay.beneficiaryPayouts.length, replayShares.length, "same-key replay creates one complete Payout set");
    ctx.equal(new Set(afterReplay.beneficiaryPayouts.map(({ beneficiaryShareId }) => beneficiaryShareId)), new Set(replayShares.map(({ beneficiaryShareId }) => beneficiaryShareId)), "same-key replay Payouts bind exactly to Shares");
    assertSnapshot(await ctx.snapshot(replayed.restarted.baseUrl));
    return finalEvidence(ctx, { distinctKeys: distinctResponses.length, distinctWinnerStatus: 200, replayStatus: replayed.replay.status, currentShares: currentShares.length, laterShares: laterShares.length, replayPayouts: afterReplay.beneficiaryPayouts.length });
  },
});

const B10 = defineCase({
  id: "B-10",
  fixtureFamily: "EG-F-FINAL-SHARES",
  action: "Create a near-expiry two-Milestone beneficiary Escrow, open a current Dispute, hold its due Worker claim, then concurrently release the Worker, resolve REFUND and attempt stale acceptance.",
  oracle: "REFUND and expiry preserve every captured Share but create no Payout, refund all unreleased value once, stale release cannot append a Payout, Work converges, and no unpublished conflict seam is manufactured.",
  async run(ctx) {
    const fixture = makeEscrowFixture(options(ctx));
    const { target, api } = await prepare(ctx, { seed: withParties(fixture, "refund-expiry") });
    const body = beneficiaryRequest(fixture, [2, 2]);
    body.expiresAt = new Date(Date.now() + 30_000).toISOString();
    const escrow = await createEscrow(ctx, api.baseUrl, body, { key: ctx.key("refunding-create") });
    await submitViaBrowser(ctx, api.baseUrl, escrow.escrowId);
    const submitted = await getDetail(ctx, api.baseUrl, escrow.escrowId);
    const current = submitted.milestones[0];
    const dispute = await openDispute(ctx, api.baseUrl, escrow.escrowId, current.milestoneId, "BUYER", "refund race", { key: ctx.key("refund-dispute") });
    const before = assertSnapshot(await ctx.snapshot(api.baseUrl));
    const work = before.work.find(({ aggregateId, terminal }) => aggregateId === escrow.escrowId && !terminal);
    ctx.ok(work, "near-expiry Work exists");
    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.workId === work.workId });
    const worker = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor((entry) => entry.json?.point === "worker.claimed" && entry.json.workId === work.workId, { timeoutMs: 120_000, processes: [worker] });
    const resolution = resolveDispute(ctx, api.baseUrl, dispute.disputeId, "REFUND", "refund all unreleased value", { key: ctx.key("refund-winner") });
    const stale = acceptMilestone(ctx, api.baseUrl, escrow.escrowId, current.milestoneId, { key: ctx.key("stale-release"), allowFailure: true });
    barrier.release(held);
    await resolution;
    publishedConflict(await stale, ["ESCROW_DISPUTED", "ESCROW_TERMINAL"], "stale release");
    const after = assertSnapshot(await waitForWorkDrain(ctx, api.baseUrl, ({ workId }) => workId === work.workId, [worker]));
    const detail = await getDetail(ctx, api.baseUrl, escrow.escrowId);
    ctx.equal(detail.escrow.state, "REFUNDED", "refund winner terminal");
    ctx.equal({ available: detail.escrow.availableMinor, released: detail.escrow.releasedMinor, refunded: detail.escrow.refundedMinor }, { available: 0, released: 0, refunded: 40 }, "complete unreleased value refunded once");
    ctx.equal(detail.beneficiaryShares.length, 4, "captured Share history retained");
    ctx.equal(detail.beneficiaryPayouts.length, 0, "refund and expiry create no Payout");
    ctx.equal(detail.releases.length, 0, "stale release creates no Release");
    ctx.equal(eventCount(after, escrow.escrowId, "dispute.resolved"), eventCount(before, escrow.escrowId, "dispute.resolved") + 1, "one resolution Event");
    ctx.equal(eventCount(after, escrow.escrowId, "escrow.refunded"), eventCount(before, escrow.escrowId, "escrow.refunded") + 1, "one refund Event");
    ctx.ok(after.work.find(({ workId }) => workId === work.workId)?.terminal, "expiry Work converges");
    return finalEvidence(ctx, { shares: detail.beneficiaryShares.length, payouts: 0, refundedMinor: detail.escrow.refundedMinor });
  },
});

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05, B06, B07, B08, B09, B10]);
