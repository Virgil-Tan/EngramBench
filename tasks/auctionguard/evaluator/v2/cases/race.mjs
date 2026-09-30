import assert from "node:assert/strict";

import { canonical } from "../lib/oracle.mjs";
import { v1Seed } from "../lib/fixtures.mjs";
import {
  assertBidMutation,
  assertError,
  correctnessCap,
  getAuction,
  getBidHistory,
  result,
  seedAndStart,
  waitForClosed,
} from "./helpers.mjs";

function auctionPayload(lotId, seconds = 3, unitCount) {
  return {
    lotId,
    currency: "USD",
    reservePriceMinor: 100,
    minimumIncrementMinor: 10,
    startAt: new Date(Date.now() - 60_000).toISOString(),
    endAt: new Date(Date.now() + seconds * 1_000).toISOString(),
    ...(unitCount === undefined ? {} : { unitCount }),
  };
}

async function race01(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "unknown-response", bidderCount: 8 });
  const api1 = await seedAndStart(ctx, seed);
  const api2 = await ctx.startApi();
  const shield = await ctx.startResponseShield(api1.baseUrl);
  const bidKey = ctx.key("unknown-bid");
  shield.dropNextMutation();
  await assert.rejects(
    ctx.placeBid(shield.baseUrl, seed.auctions[0].auctionId, { bidderId: seed.bidders[0].bidderId, amountMinor: 100 }, bidKey),
    /fetch|socket|other side|terminated/iu,
  );
  const capturedBid = await ctx.waitFor(() => shield.captures.find(({ dropped, request }) => dropped && request.path.endsWith("/bids")), {
    label: "committed Bid response capture",
  });
  const bidReplays = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.placeBid(
    (index % 2 ? api2 : api1).baseUrl,
    seed.auctions[0].auctionId,
    { bidderId: seed.bidders[0].bidderId, amountMinor: 100 },
    bidKey,
  )));
  for (const replay of bidReplays) {
    ctx.equal("unknown Bid status replays", replay.status, capturedBid.response.status, correctnessCap);
    ctx.equal("unknown Bid semantic body replays", canonical(replay.json), canonical(capturedBid.json), correctnessCap);
  }
  const bidConflict = await ctx.placeBid(api1.baseUrl, seed.auctions[0].auctionId, { bidderId: seed.bidders[1].bidderId, amountMinor: 110 }, bidKey);
  ctx.assert("unknown Bid key with different semantics conflicts", () => assertError(bidConflict, 409, "IDEMPOTENCY_CONFLICT"));
  ctx.equal("unknown Bid created one immutable row", (await getBidHistory(ctx, api2.baseUrl, seed.auctions[0].auctionId)).length, 1, correctnessCap);

  const second = await ctx.createAuction(api1.baseUrl, auctionPayload(seed.lots[0].lotId, 600));
  ctx.equal("cancel target create status", second.status, 201);
  const cancelKey = ctx.key("unknown-cancel");
  shield.dropNextMutation();
  await assert.rejects(ctx.cancelAuction(shield.baseUrl, second.json.auctionId, "seller withdrew", cancelKey), /fetch|socket|other side|terminated/iu);
  const capturedCancel = await ctx.waitFor(() => shield.captures.find(({ dropped, request }) => dropped && request.path.endsWith("/cancel")), {
    label: "committed cancel response capture",
  });
  const cancelReplays = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.cancelAuction(
    (index % 2 ? api2 : api1).baseUrl,
    second.json.auctionId,
    "seller withdrew",
    cancelKey,
  )));
  for (const replay of cancelReplays) {
    ctx.equal("unknown cancel status replays", replay.status, capturedCancel.response.status, correctnessCap);
    ctx.equal("unknown cancel semantic body replays", canonical(replay.json), canonical(capturedCancel.json), correctnessCap);
  }
  const cancelConflict = await ctx.cancelAuction(api2.baseUrl, second.json.auctionId, "different reason", cancelKey);
  ctx.assert("unknown cancel key with different semantics conflicts", () => assertError(cancelConflict, 409, "IDEMPOTENCY_CONFLICT"));
  const cancelled = await getAuction(ctx, api1.baseUrl, second.json.auctionId);
  ctx.equal("unknown cancel has one terminal effect", cancelled.state, "CANCELLED", correctnessCap);
  return result(["two dropped committed responses converged across two APIs and forty replays"]);
}

async function race02(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "bid-close", bidderCount: 4, auctions: [] });
  const api = await seedAndStart(ctx, seed);
  const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" });
  const created = await ctx.createAuction(api.baseUrl, auctionPayload(seed.lots[0].lotId, 3));
  ctx.equal("race Auction create status", created.status, 201);
  ctx.equal("race Auction open status", (await ctx.openAuction(api.baseUrl, created.json.auctionId)).status, 200);
  const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const bid = assertBidMutation(await ctx.placeBid(api.baseUrl, created.json.auctionId, {
    bidderId: seed.bidders[0].bidderId,
    amountMinor: 100,
  }));
  ctx.ok("accepted Bid extended the deadline away from the claimed original deadline", Date.parse(bid.effectiveEndAtAfter) >= Date.parse(bid.acceptedAt) + 120_000);
  const claim = await barrier.waitFor(({ json }) => json.point === "worker.claimed" && json.aggregateId === created.json.auctionId, {
    timeoutMs: 15_000,
    processes: [worker],
  });
  const held = await getAuction(ctx, api.baseUrl, created.json.auctionId);
  ctx.equal("claimed Close Task has not lost the legal Bid", held.leadingBidId, bid.bidId, correctnessCap);
  ctx.ok("claimed Close Task sees the extended effective deadline", Date.parse(held.effectiveEndAt) > Date.now());
  const snapshot = await ctx.snapshot(api.baseUrl);
  ctx.equal("point-in-time snapshot has no premature outcome", snapshot.resources.auctionOutcomes.filter(({ auctionId }) => auctionId === created.json.auctionId).length, 0, correctnessCap);
  await ctx.withPage(api, { width: 1280, height: 800 }, async (page) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();
    ctx.ok("production UI exposes live Auction state", /auction/iu.test(body) && /bid|leading/iu.test(body));
  });
  barrier.release(claim);
  await ctx.sleep(500);
  ctx.ok("stale claimed schedule did not close the extended Auction", (await ctx.getAuction(api.baseUrl, created.json.auctionId)).json.state !== "CLOSED", undefined, correctnessCap);
  const closed = await waitForClosed(ctx, api.baseUrl, created.json.auctionId, [worker]);
  ctx.equal("eventual canonical outcome includes the pre-deadline Bid", closed.leadingBidId, bid.bidId, correctnessCap);
  ctx.equal("eventual one-unit winner is the accepted Bidder", closed.winnerId, seed.bidders[0].bidderId, correctnessCap);
  return result(["worker.claimed barrier, live UI, timeline and snapshots proved Bid-close linearization"]);
}

async function exerciseWorkerCrash(ctx, point, ordinal) {
  if (ordinal > 0) {
    await ctx.resetDatabase();
    await ctx.migrate();
  }
  const seed = v1Seed(ctx.fixtures, { label: `close-crash-${ordinal}`, bidderCount: 2, auctions: [] });
  await ctx.seed(seed);
  const api = await ctx.startApi();
  const created = await ctx.createAuction(api.baseUrl, auctionPayload(seed.lots[0].lotId, 2, 3));
  ctx.equal(`${point} Auction open status`, (await ctx.openAuction(api.baseUrl, created.json.auctionId)).status, 200);
  const barrier = await ctx.barrier({ hold: ({ point: observed }) => observed === point });
  const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: 3 } });
  const held = await barrier.waitFor(({ json }) => json.point === point && json.aggregateId === created.json.auctionId, {
    timeoutMs: 15_000,
    processes: [worker],
  });
  const staleHash = held.json.leaseTokenHash;
  await ctx.kill(worker);
  barrier.releaseAll();
  await ctx.sleep(3_250);
  const replacement = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 3 } });
  const closed = await waitForClosed(ctx, api.baseUrl, created.json.auctionId, [replacement], 30_000);
  const snapshot = await ctx.snapshot(api.baseUrl);
  const outcomes = snapshot.resources.auctionOutcomes.filter(({ auctionId }) => auctionId === created.json.auctionId);
  const awards = snapshot.resources.awards.filter(({ auctionId }) => auctionId === created.json.auctionId);
  ctx.equal(`${point} crash leaves one outcome`, outcomes.length, 1, correctnessCap);
  ctx.equal(`${point} crash with no Bids leaves no Awards`, awards.length, 0, correctnessCap);
  ctx.equal(`${point} replacement drains Close Work`, snapshot.work.filter(({ aggregateId, terminal }) => aggregateId === created.json.auctionId && !terminal).length, 0, correctnessCap);
  ctx.ok(`${point} exposed a one-way lease-token hash`, /^[0-9a-f]{64}$/u.test(staleHash));
  ctx.equal(`${point} final Auction is CLOSED`, closed.state, "CLOSED", correctnessCap);
}

async function race03(ctx) {
  for (const [ordinal, point] of ["worker.claimed", "worker.effect-complete", "worker.before-commit"].entries()) {
    await exerciseWorkerCrash(ctx, point, ordinal);
  }
  return result(["claimed, effect-complete and before-commit SIGKILL each recovered after lease expiry"]);
}

async function race04(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "outbox", bidderCount: 4 });
  const api = await seedAndStart(ctx, seed);
  const receiver = await ctx.receiver();
  const barrier = await ctx.barrier({ hold: ({ point }) => point === "dispatcher.response-received" });
  const dispatcher = await ctx.startDispatcher({
    webhookUrl: receiver.url,
    env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token },
  });
  assertBidMutation(await ctx.placeBid(api.baseUrl, seed.auctions[0].auctionId, { bidderId: seed.bidders[0].bidderId, amountMinor: 100 }));
  assertBidMutation(await ctx.placeBid(api.baseUrl, seed.auctions[0].auctionId, { bidderId: seed.bidders[1].bidderId, amountMinor: 110 }));
  const held = await barrier.waitFor(({ json }) => json.point === "dispatcher.response-received", { timeoutMs: 15_000, processes: [dispatcher] });
  const firstDelivery = receiver.ledger[0];
  ctx.ok("receiver got a complete event before dispatcher commit", firstDelivery?.json && firstDelivery.acknowledged);
  await ctx.kill(dispatcher);
  barrier.release(held);
  const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
  await ctx.waitFor(() => {
    const firstId = firstDelivery.headers["x-auctionguard-event-id"];
    return receiver.ledger.filter(({ headers }) => headers["x-auctionguard-event-id"] === firstId).length >= 2;
  }, { timeoutMs: 30_000, label: "same outbox event redelivery", processes: [replacement] });
  const firstId = firstDelivery.headers["x-auctionguard-event-id"];
  const replays = receiver.ledger.filter(({ headers }) => headers["x-auctionguard-event-id"] === firstId);
  ctx.equal("unknown ACK preserves one event identity", new Set(replays.map(({ headers }) => headers["x-auctionguard-event-id"])).size, 1, correctnessCap);
  ctx.equal("unknown ACK preserves semantic body", new Set(replays.map(({ json }) => canonical(json))).size, 1, correctnessCap);
  const events = await ctx.getEvents(api.baseUrl, seed.auctions[0].auctionId);
  ctx.equal("public event timeline status", events.status, 200);
  ctx.equal("aggregate event sequence is contiguous", events.json.items.map(({ sequence }) => sequence), Array.from({ length: events.json.items.length }, (_, index) => index + 1), correctnessCap);
  ctx.ok("receiver headers expose no token", receiver.ledger.every(({ raw, headers }) => !`${raw}${canonical(headers)}`.includes(ctx.barrierToken)));
  return result(["dispatcher.response-received SIGKILL preserved outbox identity, body and aggregate order"]);
}

export const RACE_CASES = Object.freeze([
  { id: "RACE-01", taskId: "auctionguard", run: race01 },
  { id: "RACE-02", taskId: "auctionguard", run: race02 },
  { id: "RACE-03", taskId: "auctionguard", run: race03 },
  { id: "RACE-04", taskId: "auctionguard", run: race04 },
]);
