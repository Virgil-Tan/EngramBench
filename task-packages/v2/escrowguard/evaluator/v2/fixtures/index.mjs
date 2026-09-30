import { createHash } from "node:crypto";
import { registerEscrowGuardHistoryFixture } from "./public-history.mjs";

export const V1_SEED_KEYS = Object.freeze(["schemaVersion", "seedVersion", "parties", "escrows", "milestones", "disputes", "releases"]);

function digest(seed, ...parts) {
  const hash = createHash("sha256").update(String(seed));
  for (const part of parts) hash.update("\0").update(String(part));
  return hash.digest();
}

function safeLabel(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 30) || "value";
}

function offsetMilliseconds(offset = {}) {
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
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO-8601 timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = digest(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMilliseconds(offset)).toISOString(); },
    key(label) { return `eg-${safeLabel(label)}-${digest(namespace, "key", label).toString("hex").slice(0, 24)}`; },
    seedVersion(label = "seed") { return `eg-${safeLabel(caseId)}-${safeLabel(label)}-${digest(namespace, "seed", label).toString("hex").slice(0, 12)}`.slice(0, 64); },
    hex(label) { return digest(namespace, "hex", label).toString("hex"); },
  });
}

export function makeEmptySeed(fixtures, seedVersion = fixtures.seedVersion("empty")) {
  return {
    schemaVersion: 1,
    seedVersion,
    parties: [],
    escrows: [],
    milestones: [],
    disputes: [],
    releases: [],
  };
}

export function makeParties(fixtures, count = 24) {
  return Array.from({ length: count }, (_, index) => ({
    partyId: fixtures.uuid(`party-${index}`),
    displayName: `Hidden Party ${String(index + 1).padStart(2, "0")}`,
  }));
}

function transitionCount(states, dispute) {
  let count = 1;
  for (const state of states) {
    if (["SUBMITTED", "ACCEPTED", "RELEASED", "DISPUTED"].includes(state)) count += 1;
    if (state === "RELEASED") count += 1;
  }
  if (dispute) count += dispute.state === "OPEN" ? 1 : 2;
  if (states.some((state) => state === "REFUNDED")) count += 1;
  return count;
}

function defaultAmounts(states) {
  const count = states.length;
  if (count === 0) return [];
  if (count <= 3) {
    const prefix = [30, 20, 50].slice(0, count - 1);
    return [...prefix, 100 - prefix.reduce((sum, amount) => sum + amount, 0)];
  }
  const amount = Math.floor(100 / count);
  return Array.from({ length: count }, (_, i) => i === count - 1 ? 100 - amount * (count - 1) : amount);
}

export function makeEscrowFixture(options, {
  states,
  amounts = Array.isArray(states) ? defaultAmounts(states) : [30, 20, 50],
  expiresAt,
  dispute,
  label = "main",
  totalMinor = amounts.reduce((sum, amount) => sum + amount, 0),
} = {}) {
  const fixtures = createFixtureFactory(options);
  const parties = makeParties(fixtures);
  const buyerId = parties[0].partyId;
  const sellerId = parties[1].partyId;
  const escrowId = fixtures.uuid(`escrow-${label}`);
  const effectiveStates = states ?? amounts.map(() => "PENDING");
  if (effectiveStates.length !== amounts.length) throw new TypeError("states and amounts must have equal length");
  const createdAt = fixtures.at({ hours: -2 });
  const effectiveExpiry = expiresAt ?? fixtures.at({ hours: 1 });
  const milestones = amounts.map((amountMinor, index) => {
    const state = effectiveStates[index];
    const submitted = ["SUBMITTED", "ACCEPTED", "DISPUTED", "RELEASED"].includes(state)
      || (state === "REFUNDED" && dispute && index === (dispute.milestoneIndex ?? effectiveStates.findIndex((value) => value === "DISPUTED")));
    const decided = ["ACCEPTED", "RELEASED", "REFUNDED"].includes(state);
    return {
      milestoneId: fixtures.uuid(`${label}-milestone-${index + 1}`),
      escrowId,
      ordinal: index + 1,
      title: `Milestone ${index + 1}`,
      amountMinor,
      state,
      submittedAt: submitted ? fixtures.at({ minutes: -90 + index * 5 }) : null,
      decidedAt: decided ? fixtures.at({ minutes: -80 + index * 5 }) : null,
      releasedAt: state === "RELEASED" ? fixtures.at({ minutes: -79 + index * 5 }) : null,
    };
  });
  const releases = milestones.filter(({ state }) => state === "RELEASED").map((milestone, index) => ({
    releaseId: fixtures.uuid(`${label}-release-${index + 1}`),
    escrowId,
    milestoneId: milestone.milestoneId,
    sellerId,
    amountMinor: milestone.amountMinor,
    createdAt: milestone.releasedAt,
  }));
  const releasedMinor = releases.reduce((sum, release) => sum + release.amountMinor, 0);
  const refundedMinor = milestones.filter(({ state }) => state === "REFUNDED").reduce((sum, milestone) => sum + milestone.amountMinor, 0);
  const availableMinor = totalMinor - releasedMinor - refundedMinor;
  const disputeRecord = dispute ? {
    disputeId: fixtures.uuid(`${label}-dispute`),
    escrowId,
    milestoneId: milestones[dispute.milestoneIndex ?? effectiveStates.findIndex((state) => state === "DISPUTED")].milestoneId,
    openedBy: dispute.openedBy ?? "BUYER",
    reason: dispute.reason ?? "Hidden deterministic dispute",
    state: dispute.state ?? "OPEN",
    openedAt: fixtures.at({ minutes: -60 }),
    resolvedAt: dispute.state && dispute.state !== "OPEN" ? fixtures.at({ minutes: -50 }) : null,
    resolutionNote: dispute.state && dispute.state !== "OPEN" ? "Hidden deterministic resolution" : null,
  } : undefined;
  const terminal = availableMinor === 0;
  const escrowState = disputeRecord?.state === "OPEN"
    ? "DISPUTED"
    : terminal
      ? (refundedMinor > 0 ? "REFUNDED" : "RELEASED")
      : releasedMinor > 0 || effectiveStates.some((state) => state !== "PENDING") ? "ACTIVE" : "FUNDED";
  const escrow = {
    escrowId,
    buyerId,
    sellerId,
    currency: "USD",
    totalMinor,
    availableMinor,
    releasedMinor,
    refundedMinor,
    state: escrowState,
    expiresAt: effectiveExpiry,
    createdAt,
    terminalAt: terminal ? fixtures.at({ minutes: -40 }) : null,
    sequence: transitionCount(effectiveStates, disputeRecord),
  };
  const seed = {
    ...makeEmptySeed(fixtures, fixtures.seedVersion(label)),
    parties,
    escrows: [escrow],
    milestones,
    disputes: disputeRecord ? [disputeRecord] : [],
    releases,
  };
  return registerEscrowGuardHistoryFixture({ fixtures, seed, parties, buyerId, sellerId, escrow, escrowId, milestones, dispute: disputeRecord, releases });
}

export function fundedRequest(fixture, amounts = [30, 20, 50], options = {}) {
  return {
    buyerId: options.buyerId ?? fixture.buyerId,
    sellerId: options.sellerId ?? fixture.sellerId,
    currency: options.currency ?? "USD",
    totalMinor: options.totalMinor ?? amounts.reduce((sum, amount) => sum + amount, 0),
    expiresAt: options.expiresAt ?? fixture.fixtures.at({ hours: 2 }),
    milestones: amounts.map((amountMinor, index) => ({ title: `Funded Milestone ${index + 1}`, amountMinor })),
  };
}

export function beneficiaryRequest(fixture, shareCounts = [1, 2, 20]) {
  const milestones = shareCounts.map((count, milestoneIndex) => {
    const amountMinor = count * 10;
    const beneficiaries = Array.from({ length: count }, (_, index) => ({
      beneficiaryId: fixture.parties[2 + index].partyId,
      amountMinor: 10,
    }));
    return { title: `Beneficiary Milestone ${milestoneIndex + 1}`, amountMinor, beneficiaries };
  });
  return {
    buyerId: fixture.buyerId,
    sellerId: fixture.sellerId,
    currency: "USD",
    totalMinor: milestones.reduce((sum, milestone) => sum + milestone.amountMinor, 0),
    expiresAt: fixture.fixtures.at({ hours: 2 }),
    milestones,
  };
}

export function makeAllV1StatesFixture(options) {
  const fixtures = createFixtureFactory(options);
  const parties = makeParties(fixtures);
  const seed = makeEmptySeed(fixtures, fixtures.seedVersion("all-v1-states"));
  const variants = [
    { label: "funded", states: ["PENDING", "PENDING"] },
    { label: "active", states: ["RELEASED", "PENDING"] },
    { label: "submitted", states: ["SUBMITTED", "PENDING"] },
    { label: "disputed", states: ["DISPUTED", "PENDING"], dispute: { state: "OPEN", milestoneIndex: 0 } },
    { label: "released", states: ["RELEASED", "RELEASED"] },
    { label: "refunded", states: ["RELEASED", "REFUNDED"] },
  ];
  for (const variant of variants) {
    const fixture = makeEscrowFixture(options, { amounts: [30, 70], ...variant });
    for (const party of fixture.parties) if (!seed.parties.some(({ partyId }) => partyId === party.partyId)) seed.parties.push(party);
    seed.escrows.push(fixture.escrow);
    seed.milestones.push(...fixture.milestones);
    seed.disputes.push(...fixture.seed.disputes);
    seed.releases.push(...fixture.releases);
  }
  return { fixtures, seed, parties };
}
