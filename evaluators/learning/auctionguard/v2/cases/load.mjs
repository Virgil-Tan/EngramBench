import assert from "node:assert/strict";

import { canonical } from "../lib/oracle.mjs";
import { performanceContract, performanceId, performanceSeed } from "../lib/fixtures.mjs";
import { assertAuctionDetail, correctnessCap, result } from "./helpers.mjs";

function percentile(values, fraction) {
  if (!values.length) return Infinity;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

async function preparePerformance(ctx) {
  const seed = performanceSeed();
  await ctx.seed(seed, { timeoutMs: 900_000 });
  return { seed, apis: [await ctx.startApi(), await ctx.startApi()] };
}

async function bidPhase(ctx, apis, state, seconds, bidderStart) {
  const startedAt = performance.now();
  const deadline = startedAt + seconds * 1_000;
  const latencies = [];
  let accepted = 0;
  let expectedConflicts = 0;
  let unexpected5xx = 0;
  let invalid = 0;
  await Promise.all(Array.from({ length: 20 }, async (_, producer) => {
    let iteration = 0;
    const auctionId = performanceId("a3000000", producer);
    while (performance.now() < deadline) {
      const bidderIndex = bidderStart + ((producer * 1_251 + iteration) % 25_000);
      const amountMinor = state.amounts[producer] + 10;
      const response = await ctx.placeBid(apis[producer % apis.length].baseUrl, auctionId, {
        bidderId: performanceId("a1000000", bidderIndex),
        amountMinor,
      });
      latencies.push(response.durationMs);
      if (response.status === 201) {
        accepted += 1;
        state.amounts[producer] = amountMinor;
      } else if (response.status === 409) {
        expectedConflicts += 1;
      } else {
        invalid += 1;
        if (response.status >= 500) unexpected5xx += 1;
      }
      iteration += 1;
    }
  }));
  return { seconds, accepted, expectedConflicts, unexpected5xx, invalid, latencies, elapsedSeconds: (performance.now() - startedAt) / 1_000 };
}

function assertHotSnapshot(ctx, snapshot, state) {
  for (let auctionIndex = 0; auctionIndex < 20; auctionIndex += 1) {
    const auctionId = performanceId("a3000000", auctionIndex);
    const bids = snapshot.resources.bids.filter(({ auctionId: id }) => id === auctionId);
    for (const [index, bid] of bids.entries()) {
      ctx.equal(`hot Auction ${auctionIndex} committed sequence ${index + 1}`, bid.committedSequence, index + 1, correctnessCap);
      if (index > 0) ctx.ok(`hot Auction ${auctionIndex} amount ${index + 1} is strictly increasing`, bid.amountMinor > bids[index - 1].amountMinor, undefined, correctnessCap);
    }
    const auction = snapshot.resources.auctions.find(({ auctionId: id }) => id === auctionId);
    ctx.equal(`hot Auction ${auctionIndex} leader is the last committed Bid`, auction.leadingBidId, bids.at(-1).bidId, correctnessCap);
    ctx.equal(`hot Auction ${auctionIndex} amount reached the producer state`, bids.at(-1).amountMinor, state.amounts[auctionIndex], correctnessCap);
  }
}

async function runHotBidScenario(ctx) {
  const contract = performanceContract().hotBids;
  const { apis } = await preparePerformance(ctx);
  const state = { amounts: Array(20).fill(25_090) };
  await bidPhase(ctx, apis, state, contract.warmupSeconds, 50_000);
  const measured = await bidPhase(ctx, apis, state, contract.measureSeconds, 75_000);
  const throughput = measured.accepted / contract.measureSeconds;
  const p95 = percentile(measured.latencies, 0.95);
  ctx.metric("hotBidThroughput", throughput);
  ctx.metric("hotBidP95Ms", p95);
  ctx.metric("hotBidAccepted", measured.accepted);
  ctx.metric("hotBidExpectedConflicts", measured.expectedConflicts);
  ctx.metric("hotBidUnexpected5xx", measured.unexpected5xx);
  ctx.ok("hot-auction-bids reaches 250 accepted Bids/s", throughput >= contract.minimumRate, `observed ${throughput.toFixed(2)}`);
  ctx.ok("hot-auction-bids p95 is at most 300 ms", p95 <= contract.maximumP95Ms, `observed ${p95.toFixed(2)} ms`);
  ctx.equal("hot-auction-bids has no unexpected status", measured.invalid, 0);
  ctx.equal("hot-auction-bids has no unexpected 5xx", measured.unexpected5xx, 0);
  const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 60_000 });
  assertHotSnapshot(ctx, snapshot, state);
  return { apis, snapshot, state, measured };
}

async function readPhase(ctx, apis, seconds) {
  const startedAt = performance.now();
  const deadline = startedAt + seconds * 1_000;
  const latencies = [];
  let valid = 0;
  let invalid = 0;
  let unexpected5xx = 0;
  let cursor = 0;
  await Promise.all(Array.from({ length: 64 }, async (_, client) => {
    while (performance.now() < deadline) {
      const index = cursor % 20;
      cursor += 1;
      const auctionId = performanceId("a3000000", index);
      const response = await ctx.getAuction(apis[client % apis.length].baseUrl, auctionId);
      latencies.push(response.durationMs);
      try {
        assert.equal(response.status, 200);
        assertAuctionDetail(response.json, {
          auctionId,
          state: "OPEN",
          leadingBidId: performanceId("a4000000", index * 2_500 + 2_499),
          winnerId: null,
          winningAmountMinor: null,
          unitCount: 1,
        });
        valid += 1;
      } catch {
        invalid += 1;
        if (response.status >= 500) unexpected5xx += 1;
      }
    }
  }));
  return { seconds, valid, invalid, unexpected5xx, latencies, elapsedSeconds: (performance.now() - startedAt) / 1_000 };
}

async function runLiveReadScenario(ctx) {
  const contract = performanceContract().liveReads;
  const { apis } = await preparePerformance(ctx);
  await readPhase(ctx, apis, contract.warmupSeconds);
  const measured = await readPhase(ctx, apis, contract.measureSeconds);
  const throughput = measured.valid / contract.measureSeconds;
  const p95 = percentile(measured.latencies, 0.95);
  ctx.metric("liveReadThroughput", throughput);
  ctx.metric("liveReadP95Ms", p95);
  ctx.metric("liveReadValid", measured.valid);
  ctx.metric("liveReadUnexpected5xx", measured.unexpected5xx);
  ctx.ok("live-auction-read reaches 400 valid reads/s", throughput >= contract.minimumRate, `observed ${throughput.toFixed(2)}`);
  ctx.ok("live-auction-read p95 is at most 100 ms", p95 <= contract.maximumP95Ms, `observed ${p95.toFixed(2)} ms`);
  ctx.equal("live-auction-read has no mixed or malformed revision", measured.invalid, 0, correctnessCap);
  ctx.equal("live-auction-read has no unexpected 5xx", measured.unexpected5xx, 0);
  const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 60_000 });
  ctx.equal("read-only load creates no additional Bid", snapshot.resources.bids.length, 50_000, correctnessCap);
  return { apis, snapshot, measured };
}

async function runCloseRecoveryScenario(ctx) {
  const contract = performanceContract().closeRecovery;
  const { apis } = await preparePerformance(ctx);
  const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" });
  const firstWorkers = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({
    env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, WORK_LEASE_SECONDS: 3 },
  })));
  const claims = await ctx.waitFor(() => {
    const entries = barrier.ledger.filter(({ json }) => json?.point === "worker.claimed");
    return new Set(entries.map(({ json }) => json.workId)).size >= 2 ? entries.slice(0, 2) : false;
  }, { timeoutMs: 30_000, label: "two distinct due Auction claims", processes: firstWorkers });
  for (const worker of firstWorkers) await ctx.kill(worker);
  barrier.releaseAll();
  await ctx.sleep(3_250);
  const startedAt = performance.now();
  const replacements = await Promise.all(Array.from({ length: contract.workers }, () => ctx.startWorker({ env: { WORK_LEASE_SECONDS: 3 } })));
  const dueIds = new Set(Array.from({ length: contract.dueAuctions }, (_, index) => performanceId("a3000000", index + 20)));
  const terminal = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 60_000 });
    const outcomes = snapshot.resources.auctionOutcomes.filter(({ auctionId }) => dueIds.has(auctionId));
    const pending = snapshot.work.filter(({ aggregateId, terminal: done }) => dueIds.has(aggregateId) && !done);
    return outcomes.length === contract.dueAuctions && pending.length === 0 ? snapshot : false;
  }, { timeoutMs: contract.maximumSeconds * 1_000, intervalMs: 250, label: "two thousand due Auction close drain", processes: replacements });
  const elapsedSeconds = (performance.now() - startedAt) / 1_000;
  ctx.metric("closeRecoverySeconds", elapsedSeconds);
  ctx.ok("auction-close-recovery drains within 45 seconds", elapsedSeconds <= contract.maximumSeconds, `observed ${elapsedSeconds.toFixed(2)} s`);
  const dueOutcomes = terminal.resources.auctionOutcomes.filter(({ auctionId }) => dueIds.has(auctionId));
  ctx.equal("every due Auction has exactly one outcome", dueOutcomes.length, contract.dueAuctions, correctnessCap);
  ctx.equal("every due Auction outcome identity is unique", new Set(dueOutcomes.map(({ auctionId }) => auctionId)).size, contract.dueAuctions, correctnessCap);
  ctx.equal("no due Auction has a nonterminal Close Work", terminal.work.filter(({ aggregateId, terminal: done }) => dueIds.has(aggregateId) && !done).length, 0, correctnessCap);
  ctx.equal("no-bid due Auctions create no Awards", terminal.resources.awards.filter(({ auctionId }) => dueIds.has(auctionId)).length, 0, correctnessCap);
  ctx.ok("controlled crash captured two distinct lease token hashes", new Set(claims.map(({ json }) => json.leaseTokenHash)).size === 2);
  return { apis, terminal, replacements, elapsedSeconds };
}

async function load01(ctx) {
  await runHotBidScenario(ctx);
  return result(["the evaluator ran the exact 20-producer 10s warm-up plus 60s measured Bid workload and reconciled every hot Auction"]);
}

async function load02(ctx) {
  await runLiveReadScenario(ctx);
  return result(["the evaluator ran the exact 64-client 10s warm-up plus 60s measured read workload and rejected mixed revisions"]);
}

async function load03(ctx) {
  await runCloseRecoveryScenario(ctx);
  return result(["two claimed workers were SIGKILLed and two replacements drained exactly 2,000 due Auctions"]);
}

async function load04(ctx) {
  const hot = await runHotBidScenario(ctx);
  ctx.equal("hot-load snapshot keeps all Work and Events serializable", typeof canonical({ work: hot.snapshot.work, events: hot.snapshot.events }), "string");
  await ctx.resetDatabase();
  await ctx.migrate();
  const reads = await runLiveReadScenario(ctx);
  ctx.equal("read-load snapshot retains the exact FINAL resource union", Object.keys(reads.snapshot.resources).sort(), ["auctionOutcomes", "auctions", "awards", "bidders", "bids", "lots"]);
  await ctx.resetDatabase();
  await ctx.migrate();
  const close = await runCloseRecoveryScenario(ctx);
  const sample = close.terminal.resources.auctions.find(({ auctionId }) => auctionId === performanceId("a3000000", 20));
  ctx.equal("post-close sample is terminal", sample.state, "CLOSED", correctnessCap);
  await ctx.withPage(close.apis[0], { width: 1280, height: 800 }, async (page) => {
    await page.goto("/", { waitUntil: "networkidle" });
    const body = await page.locator("body").innerText();
    ctx.ok("production UI remains usable after formal load", /auction/iu.test(body) && /closed|outcome|no.sale/iu.test(body));
  });
  return result(["all three fixed loads were independently rerun and reconciled through snapshot plus production Chromium"]);
}

export const LOAD_CASES = Object.freeze([
  { id: "LOAD-01", taskId: "auctionguard", run: load01 },
  { id: "LOAD-02", taskId: "auctionguard", run: load02 },
  { id: "LOAD-03", taskId: "auctionguard", run: load03 },
  { id: "LOAD-04", taskId: "auctionguard", run: load04 },
]);
