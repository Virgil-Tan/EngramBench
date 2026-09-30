import assert from "node:assert/strict";

import { canonical } from "../lib/oracle.mjs";
import { uniformPriceWorkedExample, v1Seed } from "../lib/fixtures.mjs";
import {
  assertAuctionDetail,
  assertBidMutation,
  correctnessCap,
  getAuction,
  result,
  stableSnapshot,
  waitForClosed,
} from "./helpers.mjs";

function createPayload(lotId, overrides = {}) {
  return {
    lotId,
    currency: "USD",
    reservePriceMinor: overrides.reservePriceMinor ?? 80,
    minimumIncrementMinor: 10,
    startAt: new Date(Date.now() - 60_000).toISOString(),
    endAt: overrides.endAt ?? new Date(Date.now() + 123_000).toISOString(),
    ...(Object.hasOwn(overrides, "unitCount") ? { unitCount: overrides.unitCount } : {}),
  };
}

async function prepareV1(ctx) {
  const view = ctx.forWorkspace(ctx.v1Workspace);
  await view.command("npm", ["ci", "--no-audit", "--no-fund"], { timeoutMs: 600_000 });
  await view.npm("build", [], { timeoutMs: 600_000 });
  await view.migrate({ timeoutMs: 300_000 });
  return view;
}

function migrationSeed(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "binary-migration", bidderCount: 4, auctions: [] });
  const winnerBid = {
    bidId: ctx.uuid("migration-winner-bid"),
    auctionId: ctx.uuid("migration-winner-auction"),
    bidderId: seed.bidders[0].bidderId,
    amountMinor: 100,
    committedSequence: 1,
    state: "WINNING",
    acceptedAt: ctx.at({ days: -3 }),
    effectiveEndAtAfter: ctx.at({ days: -2 }),
  };
  const base = (label, state, overrides = {}) => ({
    auctionId: ctx.uuid(`migration-${label}-auction`),
    lotId: seed.lots[0].lotId,
    currency: "USD",
    reservePriceMinor: 100,
    minimumIncrementMinor: 10,
    startAt: ctx.at({ days: -4 }),
    effectiveEndAt: ctx.at({ days: -2 }),
    state,
    leadingBidId: null,
    winnerId: null,
    winningAmountMinor: null,
    sequence: 1,
    antiSnipingWindowSeconds: 120,
    ...overrides,
  });
  seed.auctions = [
    base("winner", "CLOSED", {
      auctionId: winnerBid.auctionId,
      leadingBidId: winnerBid.bidId,
      winnerId: winnerBid.bidderId,
      winningAmountMinor: winnerBid.amountMinor,
      sequence: 3,
    }),
    base("no-sale", "CLOSED", { sequence: 2 }),
    base("open", "OPEN", { effectiveEndAt: ctx.at({ days: 2 }) }),
    base("closing", "CLOSING"),
  ];
  seed.bids = [winnerBid];
  return { seed, winnerBid };
}

async function migrate01(ctx) {
  if (!ctx.v1Workspace) {
    ctx.blocked("frozen-v1-winner-checkpoint", "SPEC-GAP-AG-05");
    return result(["binary migration requires the externally frozen populated V1 checkpoint"]);
  }
  const v1 = await prepareV1(ctx);
  const fixture = migrationSeed(ctx);
  await v1.seed(fixture.seed);
  const v1Api = await v1.startApi();
  const before = await ctx.snapshot(v1Api.baseUrl);
  await ctx.stop(v1Api);
  await ctx.migrate({ timeoutMs: 300_000 });
  await ctx.migrate({ timeoutMs: 300_000 });
  const finalApi = await ctx.startApi();
  const after = await ctx.snapshot(finalApi.baseUrl);
  for (const auction of fixture.seed.auctions) {
    const migrated = await getAuction(ctx, finalApi.baseUrl, auction.auctionId);
    ctx.equal(`${auction.state} V1 Auction maps to unitCount one`, migrated.unitCount, 1, correctnessCap);
  }
  const winnerAwards = after.resources.awards.filter(({ auctionId }) => auctionId === fixture.winnerBid.auctionId);
  ctx.equal("V1 winner maps to exactly one Award", winnerAwards.length, 1, correctnessCap);
  ctx.equal("V1 Award preserves Bidder", winnerAwards[0].bidderId, fixture.winnerBid.bidderId, correctnessCap);
  ctx.equal("V1 Award preserves winning Bid", winnerAwards[0].bidId, fixture.winnerBid.bidId, correctnessCap);
  ctx.equal("V1 Award uses quantity one", winnerAwards[0].allocatedQuantity, 1, correctnessCap);
  ctx.equal("V1 Award preserves winning amount", winnerAwards[0].totalAmountMinor, fixture.winnerBid.amountMinor, correctnessCap);
  for (const auction of fixture.seed.auctions.filter(({ winnerId }) => winnerId === null)) {
    ctx.equal(`${auction.state} V1 Auction receives no synthetic Award`, after.resources.awards.filter(({ auctionId }) => auctionId === auction.auctionId).length, 0, correctnessCap);
  }
  ctx.equal("migration preserves Bid history", canonical(after.resources.bids), canonical(before.resources.bids), correctnessCap);
  ctx.equal("migration preserves event history", canonical(after.events), canonical(before.events), correctnessCap);
  return result(["populated V1 winner, no-sale, OPEN and CLOSING Auctions migrated twice without history rewrite"]);
}

async function migrate02(ctx) {
  if (!ctx.v1Workspace) {
    ctx.blocked("frozen-v1-work-checkpoint", "SPEC-GAP-AG-05");
    return result(["in-flight migration requires the externally frozen populated V1 checkpoint"]);
  }
  const v1 = await prepareV1(ctx);
  const seed = v1Seed(ctx.fixtures, { label: "inflight", bidderCount: 2, auctions: [] });
  await v1.seed(seed);
  const v1Api = await v1.startApi();
  const created = await ctx.createAuction(v1Api.baseUrl, createPayload(seed.lots[0].lotId, { endAt: new Date(Date.now() + 2_000).toISOString() }));
  ctx.equal("V1 in-flight Auction create status", created.status, 201);
  ctx.equal("V1 in-flight Auction open status", (await ctx.openAuction(v1Api.baseUrl, created.json.auctionId)).status, 200);
  const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" });
  const v1Worker = await v1.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: 3 } });
  const claim = await barrier.waitFor(({ json }) => json.point === "worker.claimed" && json.aggregateId === created.json.auctionId, { timeoutMs: 15_000, processes: [v1Worker] });
  const before = await ctx.snapshot(v1Api.baseUrl);
  const beforeWork = before.work.find(({ aggregateId }) => aggregateId === created.json.auctionId);
  const beforeAuction = before.resources.auctions.find(({ auctionId }) => auctionId === created.json.auctionId);
  await ctx.kill(v1Worker);
  barrier.release(claim);
  await ctx.stop(v1Api);
  await ctx.migrate({ timeoutMs: 300_000 });
  const finalApi = await ctx.startApi();
  const after = await ctx.snapshot(finalApi.baseUrl);
  const afterWork = after.work.find(({ aggregateId }) => aggregateId === created.json.auctionId);
  const afterAuction = after.resources.auctions.find(({ auctionId }) => auctionId === created.json.auctionId);
  ctx.equal("migration preserves in-flight Close workId", afterWork.workId, beforeWork.workId, correctnessCap);
  ctx.equal("migration preserves Close attempt", afterWork.attempt, beforeWork.attempt, correctnessCap);
  ctx.equal("migration preserves effective deadline", afterAuction.effectiveEndAt, beforeAuction.effectiveEndAt, correctnessCap);
  await ctx.sleep(Math.max(0, Date.parse(beforeWork.leaseExpiresAt) - Date.now() + 100));
  const replacement = await ctx.startWorker({ env: { WORK_LEASE_SECONDS: 3 } });
  const closed = await waitForClosed(ctx, finalApi.baseUrl, created.json.auctionId, [replacement], 30_000);
  ctx.equal("replacement closes the migrated Auction once", closed.state, "CLOSED", correctnessCap);
  const terminal = await ctx.snapshot(finalApi.baseUrl);
  ctx.equal("migrated Close Work drains", terminal.work.filter(({ aggregateId, terminal: done }) => aggregateId === created.json.auctionId && !done).length, 0, correctnessCap);
  return result(["a barrier-observed leased V1 Close Task preserved identity, attempt and effective deadline across FINAL migration"]);
}

async function migrate03(ctx) {
  const seed = v1Seed(ctx.fixtures, { label: "final-v1-seed", bidderCount: 4 });
  await ctx.seed(seed);
  const api = await ctx.startApi();
  const before = await ctx.snapshot(api.baseUrl);
  const replay = await ctx.seed(seed, { allowFailure: true });
  ctx.equal("same V1 seed version and digest replays", replay.exitCode, 0);
  const conflict = structuredClone(seed);
  conflict.bidders[0].displayName = "Changed";
  const conflictResult = await ctx.seed(conflict, { allowFailure: true });
  ctx.ok("same version with a different digest fails", conflictResult.exitCode !== 0);
  ctx.ok("seed conflict emits the stable public code", /SEED_VERSION_CONFLICT/u.test(`${conflictResult.stdout}${conflictResult.stderr}`));

  const invalidSeeds = [
    { label: "unknown-root", mutate: (value) => { value.unpublished = true; } },
    { label: "missing-lot", mutate: (value) => { value.auctions[0].lotId = ctx.uuid("missing-lot"); } },
    { label: "bad-money", mutate: (value) => { value.auctions[0].reservePriceMinor = -1; } },
    { label: "bad-time", mutate: (value) => { value.auctions[0].startAt = value.auctions[0].effectiveEndAt; } },
  ];
  for (const item of invalidSeeds) {
    const invalid = structuredClone(seed);
    invalid.seedVersion = `invalid-${item.label}`;
    item.mutate(invalid);
    const output = await ctx.seed(invalid, { allowFailure: true });
    ctx.ok(`${item.label} seed is rejected`, output.exitCode !== 0);
    const afterInvalid = await ctx.snapshot(api.baseUrl);
    ctx.equal(`${item.label} seed has zero business side effects`, canonical(stableSnapshot(afterInvalid)), canonical(stableSnapshot(before)), correctnessCap);
  }
  const after = await ctx.snapshot(api.baseUrl);
  ctx.equal("FINAL imports no unpublished Manager seed member", Object.hasOwn(seed, "awards"), false);
  ctx.equal("valid V1 resources remain exact", canonical(after.resources), canonical(before.resources), correctnessCap);
  return result(["valid, replay, conflict and four atomic invalid V1 seed paths ran against FINAL"]);
}

async function migrate04(ctx) {
  const worked = uniformPriceWorkedExample(ctx.fixtures);
  const seed = v1Seed(ctx.fixtures, { label: "cross-layer", bidders: worked.bidders, auctions: [] });
  await ctx.seed(seed);
  const api = await ctx.startApi();
  const legacy = await ctx.createAuction(api.baseUrl, createPayload(seed.lots[0].lotId));
  const multi = await ctx.createAuction(api.baseUrl, createPayload(seed.lots[0].lotId, { unitCount: 7 }));
  ctx.equal("legacy cross-layer Auction opens", (await ctx.openAuction(api.baseUrl, legacy.json.auctionId)).status, 200);
  ctx.equal("multi-unit cross-layer Auction opens", (await ctx.openAuction(api.baseUrl, multi.json.auctionId)).status, 200);
  assertBidMutation(await ctx.placeBid(api.baseUrl, legacy.json.auctionId, { bidderId: worked.bidders[0].bidderId, amountMinor: 80 }));
  for (const bid of worked.bids) {
    assertBidMutation(await ctx.placeBid(api.baseUrl, multi.json.auctionId, {
      bidderId: bid.bidderId,
      amountMinor: bid.amountMinor,
      quantity: bid.quantity,
    }), {}, { multiUnit: true });
  }
  const worker = await ctx.startWorker();
  const one = await waitForClosed(ctx, api.baseUrl, legacy.json.auctionId, [worker]);
  const many = await waitForClosed(ctx, api.baseUrl, multi.json.auctionId, [worker]);
  ctx.assert("legacy closed response has exact AuctionDetail", () => assertAuctionDetail(one, { unitCount: 1, state: "CLOSED" }));
  ctx.assert("multi closed response has exact AuctionDetail", () => assertAuctionDetail(many, { unitCount: 7, state: "CLOSED", winnerId: null, winningAmountMinor: null }));
  const snapshot = await ctx.snapshot(api.baseUrl);
  ctx.equal("FINAL snapshot resource keys are the exact V1 plus Awards union", Object.keys(snapshot.resources).sort(), ["auctionOutcomes", "auctions", "awards", "bidders", "bids", "lots"]);
  ctx.equal("snapshot Awards sort by Auction and allocation rank", snapshot.resources.awards.map(({ awardId }) => awardId), [...snapshot.resources.awards].sort((left, right) => left.auctionId.localeCompare(right.auctionId) || left.allocationRank - right.allocationRank || left.awardId.localeCompare(right.awardId)).map(({ awardId }) => awardId));
  ctx.equal("multi detail and snapshot Awards agree", canonical(many.awards), canonical(snapshot.resources.awards.filter(({ auctionId }) => auctionId === many.auctionId)));
  const openApi = await ctx.getOpenApi(api.baseUrl);
  ctx.equal("OpenAPI 3.1 is live", openApi.json.openapi, "3.1.0");
  for (const schema of ["AuctionDetail", "Award", "MultiUnitAuctionOutcome"]) ctx.ok(`OpenAPI publishes ${schema}`, canonical(openApi.json).includes(schema));
  await ctx.withPage(api, { width: 390, height: 844 }, async (page) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();
    ctx.ok("mobile production UI exposes Auction outcome", /auction/iu.test(body) && /winner|outcome|closed/iu.test(body));
    ctx.ok("mobile production UI exposes multi-unit allocation", /award|allocation|unit/iu.test(body));
  });
  return result(["closed one-unit and multi-unit Auctions reconciled through HTTP, OpenAPI, snapshot and mobile Chromium"]);
}

export const MIGRATE_CASES = Object.freeze([
  { id: "MIGRATE-01", taskId: "auctionguard", run: migrate01 },
  { id: "MIGRATE-02", taskId: "auctionguard", run: migrate02 },
  { id: "MIGRATE-03", taskId: "auctionguard", run: migrate03 },
  { id: "MIGRATE-04", taskId: "auctionguard", run: migrate04 },
]);
