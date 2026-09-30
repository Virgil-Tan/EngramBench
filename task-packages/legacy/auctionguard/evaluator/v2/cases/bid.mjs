import { v1Seed } from "../lib/fixtures.mjs";
import {
  assertBidMutation,
  assertError,
  correctnessCap,
  getAuction,
  getBidHistory,
  result,
  seedAndStart,
} from "./helpers.mjs";

async function bid01(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "value", bidderCount: 8 });
  const auction = seed.auctions[0];
  const api = await seedAndStart(ctx, seed);

  const belowReserve = await ctx.placeBid(api.baseUrl, auction.auctionId, { bidderId: seed.bidders[0].bidderId, amountMinor: 99 });
  ctx.assert("below-reserve Bid is rejected exactly", () => assertError(belowReserve, 409, "BID_TOO_LOW"));
  const reserve = assertBidMutation(await ctx.placeBid(api.baseUrl, auction.auctionId, {
    bidderId: seed.bidders[1].bidderId,
    amountMinor: 100,
  }), { amountMinor: 100, committedSequence: 1, state: "WINNING" });
  const belowIncrement = await ctx.placeBid(api.baseUrl, auction.auctionId, { bidderId: seed.bidders[2].bidderId, amountMinor: 109 });
  ctx.assert("increment-minus-one Bid is rejected exactly", () => assertError(belowIncrement, 409, "BID_TOO_LOW"));
  const increment = assertBidMutation(await ctx.placeBid(api.baseUrl, auction.auctionId, {
    bidderId: seed.bidders[3].bidderId,
    amountMinor: 110,
  }), { amountMinor: 110, committedSequence: 2, state: "WINNING" });
  for (const [index, amountMinor] of [0, -1, 1.5, 9_007_199_254_740_992].entries()) {
    const response = await ctx.placeBid(api.baseUrl, auction.auctionId, { bidderId: seed.bidders[index + 4].bidderId, amountMinor });
    ctx.assert(`invalid money ${String(amountMinor)} is rejected`, () => assertError(response, 400, "INVALID_BID_AMOUNT"));
  }
  const history = await getBidHistory(ctx, api.baseUrl, auction.auctionId);
  ctx.equal("only two legal Bids persisted", history.map(({ bidId }) => bidId), [reserve.bidId, increment.bidId], correctnessCap);
  const detail = await getAuction(ctx, api.baseUrl, auction.auctionId);
  ctx.equal("latest legal Bid is the sole leader", detail.leadingBidId, increment.bidId, correctnessCap);
  return result(["reserve, increment, safe-integer rejection, history and leader were observed through public HTTP"]);
}

async function bid02(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "commit-order", bidderCount: 24 });
  const auction = seed.auctions[0];
  const first = await seedAndStart(ctx, seed);
  const second = await ctx.startApi();
  const accepted = [];
  for (let index = 0; index < 20; index += 1) {
    const response = await ctx.placeBid((index % 2 ? second : first).baseUrl, auction.auctionId, {
      bidderId: seed.bidders[index].bidderId,
      amountMinor: 100 + index * 10,
    });
    accepted.push(assertBidMutation(response, { committedSequence: index + 1, amountMinor: 100 + index * 10, state: "WINNING" }));
  }
  const history = await getBidHistory(ctx, second.baseUrl, auction.auctionId);
  ctx.equal("two processes expose one gapless commit order", history.map(({ committedSequence }) => committedSequence), Array.from({ length: 20 }, (_, index) => index + 1), correctnessCap);
  const detail = await getAuction(ctx, first.baseUrl, auction.auctionId);
  ctx.equal("committed sequence chooses exactly one leader", detail.leadingBidId, accepted.at(-1).bidId, correctnessCap);
  ctx.equal("only the final Bid remains WINNING", history.filter(({ state }) => state === "WINNING").map(({ bidId }) => bidId), [accepted.at(-1).bidId], correctnessCap);
  return result(["twenty legal Bids alternated across two production API processes"]);
}

async function bid03(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "anti-snipe", bidderCount: 6 });
  const api = await seedAndStart(ctx, seed);
  const lotId = seed.lots[0].lotId;
  const now = Date.now();
  const create = async (label, seconds) => {
    const response = await ctx.createAuction(api.baseUrl, {
      lotId,
      currency: "USD",
      reservePriceMinor: 100,
      minimumIncrementMinor: 10,
      startAt: new Date(now - 60_000).toISOString(),
      endAt: new Date(now + seconds * 1_000).toISOString(),
    }, ctx.key(label));
    ctx.equal(`${label} create status`, response.status, 201);
    ctx.equal(`${label} open status`, (await ctx.openAuction(api.baseUrl, response.json.auctionId)).status, 200);
    return response.json;
  };
  const outside = await create("outside-window", 125);
  const outsideBid = assertBidMutation(await ctx.placeBid(api.baseUrl, outside.auctionId, { bidderId: seed.bidders[0].bidderId, amountMinor: 100 }));
  ctx.equal("Bid with at least two seconds safety outside window keeps deadline", outsideBid.effectiveEndAtAfter, outside.effectiveEndAt);

  const inside = await create("inside-window", 115);
  const first = assertBidMutation(await ctx.placeBid(api.baseUrl, inside.auctionId, { bidderId: seed.bidders[1].bidderId, amountMinor: 100 }));
  const expected = Date.parse(first.acceptedAt) + 120_000;
  ctx.ok("inside-window Bid extends to acceptedAt plus 120 seconds", Math.abs(Date.parse(first.effectiveEndAtAfter) - expected) <= 1);
  const second = assertBidMutation(await ctx.placeBid(api.baseUrl, inside.auctionId, { bidderId: seed.bidders[2].bidderId, amountMinor: 110 }));
  ctx.ok("next qualifying Bid applies one new deterministic extension", Math.abs(Date.parse(second.effectiveEndAtAfter) - (Date.parse(second.acceptedAt) + 120_000)) <= 1);
  ctx.ok("deadline never shortens", Date.parse(second.effectiveEndAtAfter) >= Date.parse(first.effectiveEndAtAfter));
  ctx.blocked("exact-anti-sniping-equality", "SPEC-GAP-AG-03");
  return result(["outside-window and inside-window deadlines were derived from returned database timestamps"]);
}

async function bid04(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "deadline", bidderCount: 8 });
  const api = await seedAndStart(ctx, seed);
  const lotId = seed.lots[0].lotId;
  const endAt = new Date(Date.now() + 3_000).toISOString();
  const created = await ctx.createAuction(api.baseUrl, {
    lotId,
    currency: "USD",
    reservePriceMinor: 100,
    minimumIncrementMinor: 10,
    startAt: new Date(Date.now() - 60_000).toISOString(),
    endAt,
  });
  ctx.equal("short Auction create status", created.status, 201);
  ctx.equal("short Auction open status", (await ctx.openAuction(api.baseUrl, created.json.auctionId)).status, 200);
  assertBidMutation(await ctx.placeBid(api.baseUrl, created.json.auctionId, { bidderId: seed.bidders[0].bidderId, amountMinor: 100 }));
  await ctx.sleep(Math.max(0, Date.parse(endAt) - Date.now() + 150));
  const afterDeadline = await ctx.placeBid(api.baseUrl, created.json.auctionId, { bidderId: seed.bidders[1].bidderId, amountMinor: 110 });
  ctx.assert("post-deadline Bid is rejected", () => assertError(afterDeadline, 409, "AUCTION_NOT_OPEN"));

  const scheduledLot = ctx.lot("scheduled-state");
  await ctx.resetDatabase();
  const scheduledSeed = v1Seed(ctx.fixtures, {
    label: "scheduled-state",
    lots: [scheduledLot],
    bidderCount: 2,
    auction: ctx.auction("scheduled-state", scheduledLot.lotId, {
      state: "SCHEDULED",
      startAt: ctx.at({ hours: 1 }),
      effectiveEndAt: ctx.at({ hours: 2 }),
    }),
  });
  await ctx.migrate();
  await ctx.seed(scheduledSeed);
  const scheduledApi = await ctx.startApi();
  const scheduledBid = await ctx.placeBid(scheduledApi.baseUrl, scheduledSeed.auctions[0].auctionId, { bidderId: scheduledSeed.bidders[0].bidderId, amountMinor: 100 });
  ctx.assert("SCHEDULED Auction rejects a Bid", () => assertError(scheduledBid, 409, "AUCTION_NOT_OPEN"));
  const cancelled = await ctx.cancelAuction(scheduledApi.baseUrl, scheduledSeed.auctions[0].auctionId, "withdrawn");
  ctx.equal("SCHEDULED Auction can be cancelled", cancelled.status, 200);
  const cancelledBid = await ctx.placeBid(scheduledApi.baseUrl, scheduledSeed.auctions[0].auctionId, { bidderId: scheduledSeed.bidders[1].bidderId, amountMinor: 100 });
  ctx.assert("CANCELLED Auction rejects a Bid", () => assertError(cancelledBid, 409, "AUCTION_NOT_OPEN"));
  ctx.blocked("exact-effective-end-equality", "SPEC-GAP-AG-03");
  return result(["OPEN deadline, SCHEDULED state and CANCELLED state were tested independently"]);
}

async function bid05(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "cancel", bidderCount: 8 });
  const baseAuction = seed.auctions[0];
  const api1 = await seedAndStart(ctx, seed);
  const api2 = await ctx.startApi();
  const cancelled = await ctx.cancelAuction(api1.baseUrl, baseAuction.auctionId, "seller withdrew");
  ctx.equal("no-Bid Auction cancels", cancelled.status, 200);
  const afterCancel = await ctx.placeBid(api2.baseUrl, baseAuction.auctionId, { bidderId: seed.bidders[0].bidderId, amountMinor: 100 });
  ctx.assert("cancelled Auction cannot accept a Bid", () => assertError(afterCancel, 409, "AUCTION_NOT_OPEN"));

  const lotId = seed.lots[0].lotId;
  const createPayload = () => ({
    lotId,
    currency: "USD",
    reservePriceMinor: 100,
    minimumIncrementMinor: 10,
    startAt: new Date(Date.now() - 60_000).toISOString(),
    endAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const withBid = await ctx.createAuction(api1.baseUrl, createPayload());
  ctx.equal("with-Bid Auction opens", (await ctx.openAuction(api1.baseUrl, withBid.json.auctionId)).status, 200);
  assertBidMutation(await ctx.placeBid(api1.baseUrl, withBid.json.auctionId, { bidderId: seed.bidders[1].bidderId, amountMinor: 100 }));
  const afterBidCancel = await ctx.cancelAuction(api2.baseUrl, withBid.json.auctionId, "too late");
  ctx.assert("Auction with an accepted Bid cannot cancel", () => assertError(afterBidCancel, 409, "AUCTION_NOT_CANCELLABLE"));

  const raced = await ctx.createAuction(api1.baseUrl, createPayload());
  ctx.equal("race Auction opens", (await ctx.openAuction(api1.baseUrl, raced.json.auctionId)).status, 200);
  const [bid, cancel] = await Promise.all([
    ctx.placeBid(api1.baseUrl, raced.json.auctionId, { bidderId: seed.bidders[2].bidderId, amountMinor: 100 }),
    ctx.cancelAuction(api2.baseUrl, raced.json.auctionId, "race"),
  ]);
  ctx.equal("race has exactly one successful mutation", [bid, cancel].filter(({ status }) => status >= 200 && status < 300).length, 1, correctnessCap);
  const detail = await getAuction(ctx, api1.baseUrl, raced.json.auctionId);
  const history = await getBidHistory(ctx, api2.baseUrl, raced.json.auctionId);
  ctx.ok("race converges to CANCELLED/no Bid or OPEN/one Bid", (detail.state === "CANCELLED" && history.length === 0) || (detail.state === "OPEN" && history.length === 1));
  return result(["cancel-before-Bid, cancel-after-Bid and a two-process first-Bid race were observed"]);
}

export const BID_CASES = Object.freeze([
  { id: "BID-01", taskId: "auctionguard", run: bid01 },
  { id: "BID-02", taskId: "auctionguard", run: bid02 },
  { id: "BID-03", taskId: "auctionguard", run: bid03 },
  { id: "BID-04", taskId: "auctionguard", run: bid04 },
  { id: "BID-05", taskId: "auctionguard", run: bid05 },
]);
