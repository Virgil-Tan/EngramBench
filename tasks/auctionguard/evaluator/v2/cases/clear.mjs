import assert from "node:assert/strict";

import { allocateUniformPrice, assertSafeProduct, canonical } from "../lib/oracle.mjs";
import { uniformPriceWorkedExample, v1Seed } from "../lib/fixtures.mjs";
import {
  assertAuctionDetail,
  assertBidMutation,
  assertCanonicalAwards,
  assertError,
  assertReplay,
  correctnessCap,
  getAuction,
  result,
  seedAndStart,
  waitForClosed,
} from "./helpers.mjs";

function createPayload(lotId, overrides = {}) {
  return {
    lotId,
    currency: "USD",
    reservePriceMinor: overrides.reservePriceMinor ?? 80,
    minimumIncrementMinor: overrides.minimumIncrementMinor ?? 10,
    startAt: overrides.startAt ?? new Date(Date.now() - 60_000).toISOString(),
    endAt: overrides.endAt ?? new Date(Date.now() + 123_000).toISOString(),
    ...(Object.hasOwn(overrides, "unitCount") ? { unitCount: overrides.unitCount } : {}),
  };
}

async function createMultiFixture(ctx, label, options = {}) {
  const worked = uniformPriceWorkedExample(ctx.fixtures);
  const seed = v1Seed(ctx.fixtures, { label, bidders: worked.bidders, auctions: [] });
  const api = await seedAndStart(ctx, seed);
  const response = await ctx.createAuction(api.baseUrl, createPayload(seed.lots[0].lotId, {
    unitCount: options.unitCount ?? worked.unitCount,
    reservePriceMinor: options.reservePriceMinor ?? 80,
    endAt: options.endAt,
  }));
  ctx.equal(`${label} Auction create status`, response.status, 201);
  ctx.equal(`${label} Auction open status`, (await ctx.openAuction(api.baseUrl, response.json.auctionId)).status, 200);
  return { api, seed, worked, auction: response.json };
}

async function submitWorkedBids(ctx, baseUrl, auctionId, worked) {
  const accepted = [];
  for (const bid of worked.bids) {
    accepted.push(assertBidMutation(await ctx.placeBid(baseUrl, auctionId, {
      bidderId: bid.bidderId,
      amountMinor: bid.amountMinor,
      quantity: bid.quantity,
    }), { auctionId, bidderId: bid.bidderId, amountMinor: bid.amountMinor, quantity: bid.quantity }, { multiUnit: true }));
  }
  return accepted;
}

async function clear01(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "multi-input", bidderCount: 12, auctions: [] });
  const api = await seedAndStart(ctx, seed);
  const lotId = seed.lots[0].lotId;
  const legacy = await ctx.createAuction(api.baseUrl, createPayload(lotId));
  ctx.equal("omitted unitCount creates a legacy one-unit Auction", legacy.status, 201);
  ctx.equal("legacy Auction unitCount defaults to one", (await getAuction(ctx, api.baseUrl, legacy.json.auctionId)).unitCount, 1);
  for (const unitCount of [2, 100]) {
    const response = await ctx.createAuction(api.baseUrl, createPayload(lotId, { unitCount }));
    ctx.equal(`unitCount ${unitCount} is accepted`, response.status, 201);
    ctx.equal(`unitCount ${unitCount} is preserved`, (await getAuction(ctx, api.baseUrl, response.json.auctionId)).unitCount, unitCount);
  }
  for (const unitCount of [0, 1, 101, 2.5, "2"]) {
    const response = await ctx.createAuction(api.baseUrl, createPayload(lotId, { unitCount }));
    ctx.assert(`unitCount ${String(unitCount)} is rejected exactly`, () => assertError(response, 400, "INVALID_AUCTION_UNIT_COUNT"));
  }

  const multi = await ctx.createAuction(api.baseUrl, createPayload(lotId, { unitCount: 100 }));
  const auctionId = multi.json.auctionId;
  ctx.equal("quantity target Auction opens", (await ctx.openAuction(api.baseUrl, auctionId)).status, 200);
  for (const [index, quantity] of [undefined, 0, 21, 1.5, "2"].entries()) {
    const payload = { bidderId: seed.bidders[index].bidderId, amountMinor: 100 };
    if (quantity !== undefined) payload.quantity = quantity;
    const response = await ctx.placeBid(api.baseUrl, auctionId, payload);
    ctx.assert(`quantity ${String(quantity)} is rejected exactly`, () => assertError(response, 400, "INVALID_BID_QUANTITY"));
  }
  const overflowAmount = 450_359_962_737_050;
  const overflow = await ctx.placeBid(api.baseUrl, auctionId, { bidderId: seed.bidders[5].bidderId, amountMinor: overflowAmount, quantity: 20 });
  ctx.assert("safe-total overflow is rejected exactly", () => assertError(overflow, 400, "BID_TOTAL_OVERFLOW"));
  const boundaryAmount = 450_359_962_737_049;
  const boundary = assertBidMutation(await ctx.placeBid(api.baseUrl, auctionId, {
    bidderId: seed.bidders[6].bidderId,
    amountMinor: boundaryAmount,
    quantity: 20,
  }), { amountMinor: boundaryAmount, quantity: 20 }, { multiUnit: true });
  ctx.equal("published safe product remains exact", assertSafeProduct(boundary.amountMinor, boundary.quantity), 9_007_199_254_740_980);
  const snapshot = await ctx.snapshot(api.baseUrl);
  ctx.equal("invalid requests created no Bid rows", snapshot.resources.bids.filter(({ auctionId: id }) => id === auctionId).length, 1, correctnessCap);
  return result(["unitCount, quantity and BigInt product boundaries were exercised through public mutations"]);
}

async function clear02(ctx) {
  const fixture = uniformPriceWorkedExample(ctx.fixtures);
  const oracle = allocateUniformPrice(fixture.unitCount, fixture.bids);
  ctx.equal("independent price/sequence/bidId oracle has stable ranking", oracle.awards.map(({ bidId }) => bidId), [fixture.bids[2].bidId, fixture.bids[1].bidId, fixture.bids[0].bidId]);
  ctx.blocked("equal-price-public-fixture", "SPEC-GAP-AG-04");
  return result(["the public contract forbids manufacturing equal-price accepted Bids; the full Case remains fail-closed"]);
}

async function clear03(ctx) {
  const { api, worked, auction } = await createMultiFixture(ctx, "uniform-price");
  const accepted = await submitWorkedBids(ctx, api.baseUrl, auction.auctionId, worked);
  const worker = await ctx.startWorker();
  const closed = await waitForClosed(ctx, api.baseUrl, auction.auctionId, [worker]);
  ctx.assert("closed response has exact AuctionDetail shape", () => assertAuctionDetail(closed, { state: "CLOSED", unitCount: 7, winnerId: null, winningAmountMinor: null, leadingBidId: accepted.at(-1).bidId }));
  const expected = allocateUniformPrice(worked.unitCount, accepted.map((bid) => ({ ...bid, quantity: bid.quantity })));
  assertCanonicalAwards(ctx, closed.awards, worked.unitCount, expected);
  ctx.equal("detail and outcome expose the identical Award set", canonical(closed.awards), canonical(closed.outcome.awards), correctnessCap);
  ctx.equal("common clearing price is the lowest winning price", closed.outcome.clearingUnitPriceMinor, 80, correctnessCap);
  ctx.equal("allocation includes a final partial Award", closed.awards.map(({ allocatedQuantity }) => allocatedQuantity), [3, 3, 1], correctnessCap);
  return result(["the 7-Unit 5@80, 3@90, 3@100 worked example closed through a production worker"]);
}

async function clear04(ctx) {
  const { api, worked, auction } = await createMultiFixture(ctx, "atomic-close");
  const accepted = await submitWorkedBids(ctx, api.baseUrl, auction.auctionId, worked);
  const before = await ctx.snapshot(api.baseUrl);
  ctx.equal("pre-close point-in-time snapshot contains no Awards", before.resources.awards.filter(({ auctionId }) => auctionId === auction.auctionId).length, 0);
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const closed = await waitForClosed(ctx, api.baseUrl, auction.auctionId, workers);
  const expected = allocateUniformPrice(worked.unitCount, accepted);
  assertCanonicalAwards(ctx, closed.awards, worked.unitCount, expected);
  const after = await ctx.snapshot(api.baseUrl);
  const outcomes = after.resources.auctionOutcomes.filter(({ auctionId }) => auctionId === auction.auctionId);
  const awards = after.resources.awards.filter(({ auctionId }) => auctionId === auction.auctionId);
  ctx.equal("two workers create one immutable outcome", outcomes.length, 1, correctnessCap);
  ctx.equal("snapshot exposes the complete canonical Award set", canonical(awards), canonical(closed.awards), correctnessCap);
  ctx.equal("Close Work drains terminally", after.work.filter(({ aggregateId, terminal }) => aggregateId === auction.auctionId && !terminal).length, 0, correctnessCap);
  await ctx.stop(workers[0], "SIGKILL");
  const replacement = await ctx.startWorker();
  await ctx.sleep(500);
  const retried = await getAuction(ctx, api.baseUrl, auction.auctionId);
  ctx.equal("replacement cannot rewrite a terminal Award set", canonical(retried.awards), canonical(closed.awards), correctnessCap);
  await ctx.stop(replacement);
  return result(["pre/post point-in-time snapshots and competing workers excluded a partial or rewritten Award set"]);
}

async function clear05(ctx) {
  const { api, seed, worked, auction } = await createMultiFixture(ctx, "wire-variant");
  const legacy = await ctx.createAuction(api.baseUrl, createPayload(seed.lots[0].lotId));
  ctx.equal("legacy Auction create succeeds", legacy.status, 201);
  ctx.equal("legacy Auction opens", (await ctx.openAuction(api.baseUrl, legacy.json.auctionId)).status, 200);
  assertBidMutation(await ctx.placeBid(api.baseUrl, legacy.json.auctionId, { bidderId: seed.bidders[0].bidderId, amountMinor: 80 }));
  await submitWorkedBids(ctx, api.baseUrl, auction.auctionId, worked);
  const openApi = await ctx.getOpenApi(api.baseUrl);
  ctx.equal("canonical OpenAPI is served", openApi.status, 200);
  ctx.equal("OpenAPI declares version 3.1", openApi.json.openapi, "3.1.0");
  ctx.ok("OpenAPI publishes unitCount", canonical(openApi.json).includes("unitCount"));
  ctx.ok("OpenAPI publishes quantity", canonical(openApi.json).includes("quantity"));
  ctx.ok("OpenAPI publishes Award", canonical(openApi.json).includes("Award"));
  const worker = await ctx.startWorker();
  const one = await waitForClosed(ctx, api.baseUrl, legacy.json.auctionId, [worker]);
  const many = await waitForClosed(ctx, api.baseUrl, auction.auctionId, [worker]);
  ctx.assert("closed legacy detail keeps the exact FINAL shape", () => assertAuctionDetail(one, { unitCount: 1, state: "CLOSED" }));
  ctx.assert("closed multi-unit detail keeps the exact FINAL shape", () => assertAuctionDetail(many, { unitCount: 7, state: "CLOSED", winnerId: null, winningAmountMinor: null }));
  ctx.ok("one-unit close preserves winner fields", one.winnerId !== null && one.winningAmountMinor !== null);
  ctx.equal("one-unit outcome remains the V1 outcome variant", Object.hasOwn(one.outcome, "awards"), false);
  ctx.ok("multi-unit close exposes Awards", many.awards.length > 0);
  ctx.equal("multi-unit detail and outcome expose the same Awards", canonical(many.awards), canonical(many.outcome.awards));
  await ctx.withPage(api, { width: 1280, height: 800 }, async (page) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const text = await page.locator("body").innerText();
    ctx.ok("production UI visibly identifies Auctions", /auction/iu.test(text));
    ctx.ok("production UI visibly exposes bidding", /bid/iu.test(text));
    ctx.ok("production UI can distinguish allocation or Units", /unit|award|allocation/iu.test(text));
  });
  return result(["live legacy/multi-unit details, OpenAPI 3.1 and production Chromium exposed the wire variants"]);
}

export const CLEAR_CASES = Object.freeze([
  { id: "CLEAR-01", taskId: "auctionguard", run: clear01 },
  { id: "CLEAR-02", taskId: "auctionguard", run: clear02 },
  { id: "CLEAR-03", taskId: "auctionguard", run: clear03 },
  { id: "CLEAR-04", taskId: "auctionguard", run: clear04 },
  { id: "CLEAR-05", taskId: "auctionguard", run: clear05 },
]);
