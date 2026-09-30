import { createHash } from "node:crypto";

function digest(seed, ...parts) {
  const hash = createHash("sha256").update(String(seed));
  for (const part of parts) hash.update("\0").update(String(part));
  return hash.digest();
}

function offsetMs(offset = {}) {
  if (typeof offset === "number") return offset;
  return (offset.days ?? 0) * 86_400_000
    + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000
    + (offset.seconds ?? 0) * 1_000
    + (offset.milliseconds ?? 0);
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId, and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    uuid(label) {
      const bytes = digest(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    key(label) {
      return `ag-${String(label).toLowerCase().replace(/[^a-z0-9]+/gu, "-").slice(0, 40)}-${digest(namespace, "key", label).toString("hex").slice(0, 24)}`;
    },
    at(offset = {}) {
      return new Date(epoch + offsetMs(offset)).toISOString();
    },
  });
}

export function bidderFixture(fixtures, label) {
  return { bidderId: fixtures.uuid(`bidder-${label}`), displayName: `Bidder ${label}` };
}

export function lotFixture(fixtures, label) {
  return { lotId: fixtures.uuid(`lot-${label}`), title: `Lot ${label}`, description: `AuctionGuard fixture ${label}` };
}

export function auctionFixture(fixtures, label, lotId, overrides = {}) {
  return {
    auctionId: overrides.auctionId ?? fixtures.uuid(`auction-${label}`),
    lotId,
    currency: overrides.currency ?? "USD",
    reservePriceMinor: overrides.reservePriceMinor ?? 100,
    minimumIncrementMinor: overrides.minimumIncrementMinor ?? 10,
    startAt: overrides.startAt ?? fixtures.at({ hours: -1 }),
    effectiveEndAt: overrides.effectiveEndAt ?? fixtures.at({ hours: 1 }),
    state: overrides.state ?? "OPEN",
    leadingBidId: overrides.leadingBidId ?? null,
    winnerId: overrides.winnerId ?? null,
    winningAmountMinor: overrides.winningAmountMinor ?? null,
    sequence: overrides.sequence ?? 1,
    antiSnipingWindowSeconds: 120,
  };
}

export function v1Seed(fixtures, options = {}) {
  const bidderCount = options.bidderCount ?? 8;
  const lot = options.lot ?? lotFixture(fixtures, options.label ?? "seed");
  const auction = options.auction ?? auctionFixture(fixtures, options.label ?? "seed", lot.lotId, options.auctionOverrides);
  return {
    schemaVersion: 1,
    seedVersion: options.seedVersion ?? `ag-${options.label ?? "seed"}`,
    bidders: options.bidders ?? Array.from({ length: bidderCount }, (_, index) => bidderFixture(fixtures, `${options.label ?? "seed"}-${index}`)),
    lots: options.lots ?? [lot],
    auctions: options.auctions ?? [auction],
    bids: options.bids ?? [],
  };
}

export function uniformPriceWorkedExample(fixtures) {
  const bidders = ["low", "middle", "high"].map((label) => bidderFixture(fixtures, label));
  return {
    unitCount: 7,
    bidders,
    bids: [
      { bidId: fixtures.uuid("bid-low"), bidderId: bidders[0].bidderId, amountMinor: 80, quantity: 5, committedSequence: 1 },
      { bidId: fixtures.uuid("bid-middle"), bidderId: bidders[1].bidderId, amountMinor: 90, quantity: 3, committedSequence: 2 },
      { bidId: fixtures.uuid("bid-high"), bidderId: bidders[2].bidderId, amountMinor: 100, quantity: 3, committedSequence: 3 },
    ],
  };
}

export function performanceContract() {
  return Object.freeze({
    seed: { bidders: 100_000, lots: 2_020, auctions: 2_020, bids: 50_000 },
    hotBids: { auctions: 20, concurrency: 20, warmupSeconds: 10, measureSeconds: 60, minimumRate: 250, maximumP95Ms: 300 },
    liveReads: { auctions: 20, concurrency: 64, warmupSeconds: 10, measureSeconds: 60, minimumRate: 400, maximumP95Ms: 100 },
    closeRecovery: { dueAuctions: 2_000, workers: 2, maximumSeconds: 45 },
  });
}

function performanceUuid(prefix, ordinal) {
  return `${prefix}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

export function performanceSeed() {
  const bidders = Array.from({ length: 100_000 }, (_, index) => ({
    bidderId: performanceUuid("a1000000", index),
    displayName: `Performance Bidder ${index}`,
  }));
  const lots = Array.from({ length: 2_020 }, (_, index) => ({
    lotId: performanceUuid("a2000000", index),
    title: `Performance Lot ${index}`,
    description: "AuctionGuard fixed performance lot",
  }));
  const auctions = [];
  const bids = [];
  for (let auctionIndex = 0; auctionIndex < 20; auctionIndex += 1) {
    const auctionId = performanceUuid("a3000000", auctionIndex);
    for (let sequence = 1; sequence <= 2_500; sequence += 1) {
      const index = auctionIndex * 2_500 + sequence - 1;
      bids.push({
        bidId: performanceUuid("a4000000", index),
        auctionId,
        bidderId: bidders[index].bidderId,
        amountMinor: 90 + sequence * 10,
        committedSequence: sequence,
        state: sequence === 2_500 ? "WINNING" : "OUTBID",
        acceptedAt: new Date(Date.UTC(2025, 5, 1) + index).toISOString(),
        effectiveEndAtAfter: "2035-01-01T00:00:00.000Z",
      });
    }
    auctions.push({
      auctionId,
      lotId: lots[auctionIndex].lotId,
      currency: "USD",
      reservePriceMinor: 100,
      minimumIncrementMinor: 10,
      startAt: "2025-01-01T00:00:00.000Z",
      effectiveEndAt: "2035-01-01T00:00:00.000Z",
      state: "OPEN",
      leadingBidId: performanceUuid("a4000000", auctionIndex * 2_500 + 2_499),
      winnerId: null,
      winningAmountMinor: null,
      sequence: 2_501,
      antiSnipingWindowSeconds: 120,
    });
  }
  for (let index = 20; index < 2_020; index += 1) {
    auctions.push({
      auctionId: performanceUuid("a3000000", index),
      lotId: lots[index].lotId,
      currency: "USD",
      reservePriceMinor: 100,
      minimumIncrementMinor: 10,
      startAt: "2019-01-01T00:00:00.000Z",
      effectiveEndAt: "2020-01-01T00:00:00.000Z",
      state: "CLOSING",
      leadingBidId: null,
      winnerId: null,
      winningAmountMinor: null,
      sequence: 2,
      antiSnipingWindowSeconds: 120,
    });
  }
  return {
    schemaVersion: 1,
    seedVersion: "perf-v1",
    bidders,
    lots,
    auctions,
    bids,
  };
}

export const performanceId = performanceUuid;
