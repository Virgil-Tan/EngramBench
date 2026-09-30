import { candidateAssert as assert } from "../lib/execution.mjs";
import { assertPublishedOpenApi } from '../lib/public-wire.mjs';

import { assertNoPrivatePaths } from "../lib/public-material.mjs";

export const PARTY_KEYS = Object.freeze(["partyId", "displayName"]);
export const ESCROW_KEYS = Object.freeze(["escrowId", "buyerId", "sellerId", "currency", "totalMinor", "availableMinor", "releasedMinor", "refundedMinor", "state", "expiresAt", "createdAt", "terminalAt", "sequence"]);
export const MILESTONE_KEYS = Object.freeze(["milestoneId", "escrowId", "ordinal", "title", "amountMinor", "state", "submittedAt", "decidedAt", "releasedAt"]);
export const DISPUTE_KEYS = Object.freeze(["disputeId", "escrowId", "milestoneId", "openedBy", "reason", "state", "openedAt", "resolvedAt", "resolutionNote"]);
export const RELEASE_KEYS = Object.freeze(["releaseId", "escrowId", "milestoneId", "sellerId", "amountMinor", "createdAt"]);
export const SHARE_KEYS = Object.freeze(["beneficiaryShareId", "milestoneId", "ordinal", "beneficiaryId", "amountMinor"]);
export const PAYOUT_KEYS = Object.freeze(["payoutId", "releaseId", "beneficiaryShareId", "beneficiaryId", "amountMinor", "createdAt"]);
export const WORK_KEYS = Object.freeze(["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"]);
export const EVENT_KEYS = Object.freeze(["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"]);
export const V1_RESOURCE_KEYS = Object.freeze(["parties", "escrows", "milestones", "disputes", "releases"]);
export const FINAL_RESOURCE_KEYS = Object.freeze([...V1_RESOURCE_KEYS, "beneficiaryShares", "beneficiaryPayouts"]);
export const EVENT_TYPES = Object.freeze(["escrow.funded", "milestone.submitted", "milestone.released", "dispute.opened", "dispute.resolved", "escrow.refunded"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ESCROW_STATES = Object.freeze(["FUNDED", "ACTIVE", "DISPUTED", "RELEASED", "REFUNDED"]);
const MILESTONE_STATES = Object.freeze(["PENDING", "SUBMITTED", "ACCEPTED", "DISPUTED", "RELEASED", "REFUNDED"]);
const DISPUTE_STATES = Object.freeze(["OPEN", "RESOLVED_RELEASE", "RESOLVED_REFUND"]);
const WORK_STATES = Object.freeze(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"]);

function compareText(left, right) { return Buffer.from(String(left)).compare(Buffer.from(String(right))); }

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("EscrowGuard canonical quantities must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("unsupported canonical JSON value");
  return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} exact fields`);
  return value;
}
function uuid(value, label) { assert.match(value, UUID, `${label} lowercase UUID`); }
function timestamp(value, label) { assert.match(value, TIMESTAMP, `${label} UTC millisecond timestamp`); assert.equal(new Date(value).toISOString(), value, `${label} valid timestamp`); }
function text(value, label) { assert.equal(typeof value, "string", `${label} string`); }
function safeInteger(value, label, { positive = false, nonnegative = false } = {}) { assert.ok(Number.isSafeInteger(value), `${label} safe integer`); if (positive) assert.ok(value > 0, `${label} positive`); if (nonnegative) assert.ok(value >= 0, `${label} nonnegative`); }
function nullableTimestamp(value, label) { if (value !== null) timestamp(value, label); }

export function assertParty(value) {
  exactKeys(value, PARTY_KEYS, "Party"); uuid(value.partyId, "Party.partyId"); text(value.displayName, "Party.displayName"); return value;
}
export function assertEscrow(value) {
  exactKeys(value, ESCROW_KEYS, "Escrow");
  for (const field of ["escrowId", "buyerId", "sellerId"]) uuid(value[field], `Escrow.${field}`);
  assert.match(value.currency, /^[A-Z]{3}$/u, "Escrow.currency");
  for (const field of ["totalMinor", "availableMinor", "releasedMinor", "refundedMinor"]) safeInteger(value[field], `Escrow.${field}`, { nonnegative: true });
  assert.ok(value.totalMinor > 0, "Escrow.totalMinor positive");
  assert.equal(value.totalMinor, value.availableMinor + value.releasedMinor + value.refundedMinor, "Escrow Fund Position conservation");
  assert.ok(ESCROW_STATES.includes(value.state), "Escrow published state");
  timestamp(value.expiresAt, "Escrow.expiresAt"); timestamp(value.createdAt, "Escrow.createdAt"); nullableTimestamp(value.terminalAt, "Escrow.terminalAt");
  safeInteger(value.sequence, "Escrow.sequence", { nonnegative: true });
  return value;
}
export function assertMilestone(value) {
  exactKeys(value, MILESTONE_KEYS, "Milestone"); uuid(value.milestoneId, "Milestone.milestoneId"); uuid(value.escrowId, "Milestone.escrowId"); safeInteger(value.ordinal, "Milestone.ordinal", { positive: true }); text(value.title, "Milestone.title"); safeInteger(value.amountMinor, "Milestone.amountMinor", { positive: true }); assert.ok(MILESTONE_STATES.includes(value.state), "Milestone published state"); for (const field of ["submittedAt", "decidedAt", "releasedAt"]) nullableTimestamp(value[field], `Milestone.${field}`); return value;
}
export function assertDispute(value) {
  exactKeys(value, DISPUTE_KEYS, "Dispute"); for (const field of ["disputeId", "escrowId", "milestoneId"]) uuid(value[field], `Dispute.${field}`); assert.ok(["BUYER", "SELLER"].includes(value.openedBy), "Dispute.openedBy"); text(value.reason, "Dispute.reason"); assert.ok(DISPUTE_STATES.includes(value.state), "Dispute published state"); timestamp(value.openedAt, "Dispute.openedAt"); nullableTimestamp(value.resolvedAt, "Dispute.resolvedAt"); if (value.resolutionNote !== null) text(value.resolutionNote, "Dispute.resolutionNote"); return value;
}
export function assertRelease(value, { response = false } = {}) {
  const keys = Object.hasOwn(value ?? {}, "payouts") ? [...RELEASE_KEYS, "payouts"] : RELEASE_KEYS;
  exactKeys(value, keys, response ? "Release response" : "Release"); for (const field of ["releaseId", "escrowId", "milestoneId", "sellerId"]) uuid(value[field], `Release.${field}`); safeInteger(value.amountMinor, "Release.amountMinor", { positive: true }); timestamp(value.createdAt, "Release.createdAt"); if (Object.hasOwn(value, "payouts")) { assert.ok(Array.isArray(value.payouts), "Release.payouts array"); value.payouts.forEach(assertPayout); } return value;
}
export function assertShare(value) { exactKeys(value, SHARE_KEYS, "BeneficiaryShare"); for (const field of ["beneficiaryShareId", "milestoneId", "beneficiaryId"]) uuid(value[field], `BeneficiaryShare.${field}`); safeInteger(value.ordinal, "BeneficiaryShare.ordinal", { positive: true }); safeInteger(value.amountMinor, "BeneficiaryShare.amountMinor", { positive: true }); return value; }
export function assertPayout(value) { exactKeys(value, PAYOUT_KEYS, "BeneficiaryPayout"); for (const field of ["payoutId", "releaseId", "beneficiaryShareId", "beneficiaryId"]) uuid(value[field], `BeneficiaryPayout.${field}`); safeInteger(value.amountMinor, "BeneficiaryPayout.amountMinor", { positive: true }); timestamp(value.createdAt, "BeneficiaryPayout.createdAt"); return value; }

function scalarCompare(left, right) { if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1; if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right); if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right; return compareText(left, right); }
function readPath(value, path) { return path.split(".").reduce((current, key) => current?.[key], value); }
export function assertSorted(items, paths, label) {
  const sorted = [...items].sort((left, right) => { for (const path of paths) { const order = scalarCompare(readPath(left, path), readPath(right, path)); if (order) return order; } return compareText(canonicalJson(left), canonicalJson(right)); });
  assert.deepEqual(items, sorted, `${label} stable sort`);
}

export function assertWork(items) {
  for (const item of items) {
    exactKeys(item, WORK_KEYS, "Work"); uuid(item.workId, "Work.workId"); uuid(item.aggregateId, "Work.aggregateId"); assert.equal(item.kind, "ESCROW_EXPIRY", "Work.kind"); assert.ok(WORK_STATES.includes(item.state), "Work.state"); assert.equal(item.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state), "Work.terminal"); safeInteger(item.attempt, "Work.attempt", { nonnegative: true }); if (item.state === "LEASED") { text(item.leaseOwner, "Work.leaseOwner"); timestamp(item.leaseExpiresAt, "Work.leaseExpiresAt"); } else { assert.equal(item.leaseOwner, null, "non-LEASED Work leaseOwner null"); assert.equal(item.leaseExpiresAt, null, "non-LEASED Work leaseExpiresAt null"); }
  }
  assertSorted(items, ["workId"], "Work");
}

export function assertEventSequence(items) {
  const grouped = new Map();
  for (const event of items) { const values = grouped.get(event.aggregateId) ?? []; values.push(event); grouped.set(event.aggregateId, values); }
  for (const values of grouped.values()) { values.sort((left, right) => left.sequence - right.sequence); assert.deepEqual(values.map(({ sequence }) => sequence), values.map((_, index) => index + 1), "per-Escrow Event sequence"); }
}

export function assertEvents(items) {
  for (const item of items) {
    exactKeys(item, EVENT_KEYS, "DomainEvent"); uuid(item.eventId, "DomainEvent.eventId"); uuid(item.aggregateId, "DomainEvent.aggregateId"); safeInteger(item.sequence, "DomainEvent.sequence", { positive: true }); assert.ok(EVENT_TYPES.includes(item.type), `published DomainEvent type ${item.type}`); timestamp(item.occurredAt, "DomainEvent.occurredAt"); assert.equal(item.schemaVersion, 1, "DomainEvent.schemaVersion"); assert.equal(canonicalJson(item.payload), "{}", "DomainEvent payload exact empty object");
  }
  assertSorted(items, ["aggregateId", "sequence", "eventId"], "DomainEvent"); assertEventSequence(items);
}

export function fundPositionFor(escrow) {
  return { totalMinor: escrow.totalMinor, availableMinor: escrow.availableMinor, releasedMinor: escrow.releasedMinor, refundedMinor: escrow.refundedMinor };
}

function assertAggregateHistory(escrow, milestones, disputes, releases, label) {
  const releaseByMilestone = new Map(releases.map((release) => [release.milestoneId, release]));
  const openDisputes = disputes.filter(({ state }) => state === "OPEN");
  assert.ok(openDisputes.length <= 1, `${label} has at most one open Dispute`);
  for (const dispute of disputes) {
    const milestone = milestones.find(({ milestoneId }) => milestoneId === dispute.milestoneId);
    assert.ok(milestone, `${label} Dispute Milestone exists`);
    if (dispute.state === "OPEN") {
      assert.equal(milestone.state, "DISPUTED", `${label} open Dispute freezes Milestone`);
      assert.equal(escrow.state, "DISPUTED", `${label} open Dispute freezes Escrow`);
      assert.equal(releaseByMilestone.has(milestone.milestoneId), false, `${label} open Dispute has no Release`);
    } else if (dispute.state === "RESOLVED_RELEASE") {
      assert.equal(milestone.state, "RELEASED", `${label} RELEASE resolution releases Milestone`);
      assert.ok(releaseByMilestone.has(milestone.milestoneId), `${label} RELEASE resolution has Release`);
    } else {
      assert.equal(milestone.state, "REFUNDED", `${label} REFUND resolution refunds disputed Milestone`);
      assert.equal(releaseByMilestone.has(milestone.milestoneId), false, `${label} REFUND resolution has no Release`);
      for (const later of milestones.filter(({ ordinal }) => ordinal >= milestone.ordinal)) assert.equal(later.state, "REFUNDED", `${label} REFUND resolution refunds current and later Milestones`);
    }
  }

  const hasRefund = milestones.some(({ state }) => state === "REFUNDED");
  const hasProgress = milestones.some(({ state }) => state !== "PENDING");
  let expectedState;
  if (openDisputes.length) expectedState = "DISPUTED";
  else if (hasRefund) expectedState = "REFUNDED";
  else if (escrow.availableMinor === 0) expectedState = "RELEASED";
  else if (hasProgress) expectedState = "ACTIVE";
  else expectedState = "FUNDED";
  assert.equal(escrow.state, expectedState, `${label} Escrow state reconciles with history`);
  if (expectedState === "REFUNDED") assert.equal(escrow.availableMinor, 0, `${label} refund is terminal and consumes all available value`);
}

export function assertAggregateGraph(resources, { final = true } = {}) {
  const parties = new Set(resources.parties.map(({ partyId }) => partyId));
  const escrows = new Map(resources.escrows.map((item) => [item.escrowId, item]));
  const milestonesByEscrow = new Map();
  const milestoneById = new Map();
  for (const milestone of resources.milestones) { assert.ok(escrows.has(milestone.escrowId), "Milestone Escrow exists"); const values = milestonesByEscrow.get(milestone.escrowId) ?? []; values.push(milestone); milestonesByEscrow.set(milestone.escrowId, values); milestoneById.set(milestone.milestoneId, milestone); }
  const releaseById = new Map(resources.releases.map((item) => [item.releaseId, item]));
  for (const escrow of resources.escrows) {
    assert.ok(parties.has(escrow.buyerId) && parties.has(escrow.sellerId), "Escrow parties exist");
    const milestones = (milestonesByEscrow.get(escrow.escrowId) ?? []).sort((left, right) => left.ordinal - right.ordinal);
    assert.ok(milestones.length >= 1 && milestones.length <= 20, "Escrow has one through twenty Milestones");
    assert.deepEqual(milestones.map(({ ordinal }) => ordinal), milestones.map((_, index) => index + 1), "Milestone ordinals contiguous");
    assert.equal(milestones.reduce((sum, item) => sum + item.amountMinor, 0), escrow.totalMinor, "Milestone amount total");
    assert.ok(milestones.filter(({ state }) => ["SUBMITTED", "DISPUTED"].includes(state)).length <= 1, "at most one submitted or disputed Milestone");
    let blocked = false;
    for (const milestone of milestones) { if (blocked) assert.ok(["PENDING", "REFUNDED"].includes(milestone.state), "later Milestone cannot advance"); if (milestone.state !== "RELEASED") blocked = true; }
    const releases = resources.releases.filter((release) => release.escrowId === escrow.escrowId);
    const releasedMilestones = milestones.filter(({ state }) => state === "RELEASED");
    assert.equal(releases.length, releasedMilestones.length, "one Release per released Milestone");
    assert.equal(new Set(releases.map(({ milestoneId }) => milestoneId)).size, releases.length, "Release Milestone identities unique");
    assert.equal(releases.reduce((sum, release) => sum + release.amountMinor, 0), escrow.releasedMinor, "Release sum equals released Fund Position");
    assert.equal(milestones.filter(({ state }) => state === "REFUNDED").reduce((sum, item) => sum + item.amountMinor, 0), escrow.refundedMinor, "refunded Milestones equal Fund Position");
    assertAggregateHistory(escrow, milestones, resources.disputes.filter((dispute) => dispute.escrowId === escrow.escrowId), releases, "snapshot aggregate");
  }
  for (const dispute of resources.disputes) { const escrow = escrows.get(dispute.escrowId); const milestone = milestoneById.get(dispute.milestoneId); assert.ok(escrow && milestone?.escrowId === escrow.escrowId, "Dispute references same Escrow Milestone"); }
  for (const release of resources.releases) { const escrow = escrows.get(release.escrowId); const milestone = milestoneById.get(release.milestoneId); assert.ok(escrow && milestone?.state === "RELEASED", "Release references released Milestone"); assert.equal(release.sellerId, escrow.sellerId, "Release seller"); assert.equal(release.amountMinor, milestone.amountMinor, "Release exact Milestone amount"); }
  if (final) {
    const sharesByMilestone = new Map(); for (const share of resources.beneficiaryShares) { assert.ok(milestoneById.has(share.milestoneId), "Share Milestone exists"); const values = sharesByMilestone.get(share.milestoneId) ?? []; values.push(share); sharesByMilestone.set(share.milestoneId, values); assert.ok(parties.has(share.beneficiaryId), "Share beneficiary Party exists"); }
    for (const milestone of resources.milestones) { const shares = (sharesByMilestone.get(milestone.milestoneId) ?? []).sort((left, right) => left.ordinal - right.ordinal); assert.ok(shares.length >= 1 && shares.length <= 20, "every FINAL Milestone has one through twenty Shares"); assert.deepEqual(shares.map(({ ordinal }) => ordinal), shares.map((_, index) => index + 1), "Share ordinals contiguous"); assert.equal(shares.reduce((sum, share) => sum + share.amountMinor, 0), milestone.amountMinor, "Share amount conservation"); assert.equal(new Set(shares.map(({ beneficiaryId }) => beneficiaryId)).size, shares.length, "Share beneficiaries unique within Milestone"); }
    const payoutIds = new Set();
    const payoutsByRelease = new Map();
    for (const payout of resources.beneficiaryPayouts) {
      assert.ok(!payoutIds.has(payout.payoutId), "BeneficiaryPayout identity unique");
      payoutIds.add(payout.payoutId);
      const values = payoutsByRelease.get(payout.releaseId) ?? [];
      values.push(payout);
      payoutsByRelease.set(payout.releaseId, values);
    }
    for (const release of resources.releases) {
      const shares = (sharesByMilestone.get(release.milestoneId) ?? []).sort((left, right) => left.ordinal - right.ordinal);
      const payouts = payoutsByRelease.get(release.releaseId) ?? [];
      const payoutByShare = new Map(payouts.map((payout) => [payout.beneficiaryShareId, payout]));
      assert.equal(payouts.length, payoutByShare.size, "one Payout row per captured Share");
      assert.equal(payoutByShare.size, shares.length, "complete Payout set for Release");
      for (const share of shares) { const payout = payoutByShare.get(share.beneficiaryShareId); assert.ok(payout, "Payout matches captured Share"); assert.equal(payout.beneficiaryId, share.beneficiaryId, "Payout beneficiary immutable"); assert.equal(payout.amountMinor, share.amountMinor, "Payout amount immutable"); }
    }
    for (const payout of resources.beneficiaryPayouts) assert.ok(releaseById.has(payout.releaseId), "Payout Release exists");
  }
  return { parties, escrows, milestoneById, releaseById };
}

export function assertSnapshot(snapshot, { final = true } = {}) {
  exactKeys(snapshot, ["asOf", "resources", "work", "events"], "verification snapshot"); timestamp(snapshot.asOf, "snapshot.asOf");
  const resources = snapshot.resources; exactKeys(resources, final ? FINAL_RESOURCE_KEYS : V1_RESOURCE_KEYS, "snapshot.resources");
  resources.parties.forEach(assertParty); resources.escrows.forEach(assertEscrow); resources.milestones.forEach(assertMilestone); resources.disputes.forEach(assertDispute); resources.releases.forEach(assertRelease); if (final) { resources.beneficiaryShares.forEach(assertShare); resources.beneficiaryPayouts.forEach(assertPayout); }
  const identities = [[resources.parties, "partyId", "Party"], [resources.escrows, "escrowId", "Escrow"], [resources.milestones, "milestoneId", "Milestone"], [resources.disputes, "disputeId", "Dispute"], [resources.releases, "releaseId", "Release"], ...(final ? [[resources.beneficiaryShares, "beneficiaryShareId", "BeneficiaryShare"], [resources.beneficiaryPayouts, "payoutId", "BeneficiaryPayout"]] : [])];
  for (const [items, key, label] of identities) assert.equal(new Set(items.map((item) => item[key])).size, items.length, `${label} identities unique`);
  const sorts = { parties: ["partyId"], escrows: ["escrowId"], milestones: ["escrowId", "ordinal", "milestoneId"], disputes: ["escrowId", "openedAt", "disputeId"], releases: ["escrowId", "createdAt", "releaseId"], beneficiaryShares: ["milestoneId", "ordinal", "beneficiaryShareId"], beneficiaryPayouts: ["releaseId", "beneficiaryShareId", "payoutId"] };
  for (const [name, paths] of Object.entries(sorts)) if (resources[name]) assertSorted(resources[name], paths, name);
  assertWork(snapshot.work); assertEvents(snapshot.events); assert.equal(new Set(snapshot.work.map(({ workId }) => workId)).size, snapshot.work.length, "Work identities unique"); assert.equal(new Set(snapshot.work.map(({ aggregateId }) => aggregateId)).size, snapshot.work.length, "at most one expiry Work per Escrow"); assert.equal(new Set(snapshot.events.map(({ eventId }) => eventId)).size, snapshot.events.length, "DomainEvent identities unique"); const graph = assertAggregateGraph(resources, { final });
  for (const value of [...snapshot.work, ...snapshot.events]) assert.ok(graph.escrows.has(value.aggregateId), "Work/Event aggregate Escrow exists");
  assert.equal(snapshot.work.length, graph.escrows.size, "every Escrow retains exactly one expiry Work");
  const maxSequence = new Map(); for (const event of snapshot.events) maxSequence.set(event.aggregateId, Math.max(maxSequence.get(event.aggregateId) ?? 0, event.sequence)); for (const escrow of resources.escrows) assert.equal(maxSequence.get(escrow.escrowId) ?? 0, escrow.sequence, "Escrow.sequence matches committed Events");
  const serialized = canonicalJson(snapshot); assert.equal(/"[^"]*Token"\s*:/u.test(serialized), false, "snapshot recursively omits *Token"); assertNoPrivatePaths(serialized, "snapshot"); return snapshot;
}

export function assertDetail(value, { final = true } = {}) {
  // The V2 wire is a top-level Escrow. Extract a fixed domain view for the
  // existing conservation oracle; a wrapped submission is rejected, not adapted.
  const detailKeys = ["milestones", "dispute", "releases", "fundPosition", "beneficiaryShares", "beneficiaryPayouts"];
  exactKeys(value, [...ESCROW_KEYS, ...detailKeys], "published Escrow detail");
  value = { escrow: Object.fromEntries(ESCROW_KEYS.map(key => [key, value[key]])), ...Object.fromEntries(detailKeys.filter(key => final || !["beneficiaryShares", "beneficiaryPayouts"].includes(key)).map(key => [key, value[key]])) };
  const keys = ["escrow", "milestones", "dispute", "releases", "fundPosition", ...(final ? ["beneficiaryShares", "beneficiaryPayouts"] : [])];
  exactKeys(value, keys, "Escrow detail"); assertEscrow(value.escrow); assert.ok(Array.isArray(value.milestones), "detail Milestones"); value.milestones.forEach(assertMilestone); assert.deepEqual(value.milestones.map(({ ordinal }) => ordinal), value.milestones.map((_, index) => index + 1), "detail Milestones ordered"); if (value.dispute !== null) assertDispute(value.dispute); value.releases.forEach(assertRelease); exactKeys(value.fundPosition, ["totalMinor", "availableMinor", "releasedMinor", "refundedMinor"], "Fund Position"); assert.deepEqual(value.fundPosition, fundPositionFor(value.escrow), "detail Fund Position equals Escrow"); if (final) { value.beneficiaryShares.forEach(assertShare); value.beneficiaryPayouts.forEach(assertPayout); }
  assert.ok(value.milestones.length >= 1 && value.milestones.length <= 20, "detail has one through twenty Milestones");
  assert.ok(value.milestones.every(({ escrowId }) => escrowId === value.escrow.escrowId), "detail Milestones belong to Escrow");
  assert.equal(value.milestones.reduce((sum, milestone) => sum + milestone.amountMinor, 0), value.escrow.totalMinor, "detail Milestone amount conservation");
  assert.ok(value.milestones.filter(({ state }) => ["SUBMITTED", "DISPUTED"].includes(state)).length <= 1, "detail has at most one in-flight Milestone");
  let blocked = false;
  for (const milestone of value.milestones) {
    if (blocked) assert.ok(["PENDING", "REFUNDED"].includes(milestone.state), "detail later Milestone cannot advance");
    if (milestone.state !== "RELEASED") blocked = true;
  }
  if (value.dispute !== null) {
    const milestone = value.milestones.find(({ milestoneId }) => milestoneId === value.dispute.milestoneId);
    assert.ok(milestone && value.dispute.escrowId === value.escrow.escrowId, "detail Dispute references this Escrow and Milestone");
  }
  const milestoneById = new Map(value.milestones.map((milestone) => [milestone.milestoneId, milestone]));
  assert.equal(milestoneById.size, value.milestones.length, "detail Milestone identities unique");
  const releasedMilestones = value.milestones.filter(({ state }) => state === "RELEASED");
  assert.equal(value.releases.length, releasedMilestones.length, "detail has one Release per released Milestone");
  assert.equal(new Set(value.releases.map(({ releaseId }) => releaseId)).size, value.releases.length, "detail Release identities unique");
  assert.equal(new Set(value.releases.map(({ milestoneId }) => milestoneId)).size, value.releases.length, "detail has at most one Release per Milestone");
  for (const release of value.releases) {
    const milestone = milestoneById.get(release.milestoneId);
    assert.ok(milestone?.state === "RELEASED" && release.escrowId === value.escrow.escrowId, "detail Release references this released Milestone");
    assert.equal(release.amountMinor, milestone.amountMinor, "detail Release amount equals Milestone");
    assert.equal(release.sellerId, value.escrow.sellerId, "detail Release seller identity");
  }
  assert.equal(value.releases.reduce((sum, release) => sum + release.amountMinor, 0), value.escrow.releasedMinor, "detail Release conservation");
  assert.equal(value.milestones.filter(({ state }) => state === "REFUNDED").reduce((sum, milestone) => sum + milestone.amountMinor, 0), value.escrow.refundedMinor, "detail refunded Milestones conserve Fund Position");
  assertAggregateHistory(value.escrow, value.milestones, value.dispute === null ? [] : [value.dispute], value.releases, "detail aggregate");
  if (final) {
    assert.equal(new Set(value.beneficiaryShares.map(({ beneficiaryShareId }) => beneficiaryShareId)).size, value.beneficiaryShares.length, "detail Share identities unique");
    assert.equal(new Set(value.beneficiaryPayouts.map(({ payoutId }) => payoutId)).size, value.beneficiaryPayouts.length, "detail Payout identities unique");
    const sharesByMilestone = new Map();
    for (const share of value.beneficiaryShares) {
      assert.ok(milestoneById.has(share.milestoneId), "detail Share references a Milestone");
      const shares = sharesByMilestone.get(share.milestoneId) ?? [];
      shares.push(share);
      sharesByMilestone.set(share.milestoneId, shares);
    }
    for (const milestone of value.milestones) {
      const shares = (sharesByMilestone.get(milestone.milestoneId) ?? []).sort((left, right) => left.ordinal - right.ordinal);
      assert.ok(shares.length >= 1 && shares.length <= 20, "detail Milestone has one through twenty Shares");
      assert.deepEqual(shares.map(({ ordinal }) => ordinal), shares.map((_, index) => index + 1), "detail Share ordinals contiguous");
      assert.equal(shares.reduce((sum, share) => sum + share.amountMinor, 0), milestone.amountMinor, "detail Share amount conservation");
      assert.equal(new Set(shares.map(({ beneficiaryId }) => beneficiaryId)).size, shares.length, "detail Share beneficiaries unique within Milestone");
    }
    const releaseById = new Map(value.releases.map((release) => [release.releaseId, release]));
    const payoutsByRelease = new Map();
    for (const payout of value.beneficiaryPayouts) {
      assert.ok(releaseById.has(payout.releaseId), "detail Payout references a Release");
      const payouts = payoutsByRelease.get(payout.releaseId) ?? [];
      payouts.push(payout);
      payoutsByRelease.set(payout.releaseId, payouts);
    }
    for (const release of value.releases) {
      const shares = (sharesByMilestone.get(release.milestoneId) ?? []).sort((left, right) => left.ordinal - right.ordinal);
      const payouts = payoutsByRelease.get(release.releaseId) ?? [];
      const payoutByShare = new Map(payouts.map((payout) => [payout.beneficiaryShareId, payout]));
      assert.equal(payouts.length, payoutByShare.size, "detail has at most one Payout per Share");
      assert.equal(payoutByShare.size, shares.length, "detail Release has a complete Payout set");
      for (const share of shares) {
        const payout = payoutByShare.get(share.beneficiaryShareId);
        assert.ok(payout, "detail Payout matches captured Share");
        assert.equal(payout.beneficiaryId, share.beneficiaryId, "detail Payout beneficiary immutable");
        assert.equal(payout.amountMinor, share.amountMinor, "detail Payout amount immutable");
      }
    }
  }
  return value;
}

export function assertReleasePayouts(releaseResponse, shares) {
  assertRelease(releaseResponse, { response: true });
  assert.ok(Array.isArray(releaseResponse.payouts), "FINAL Release.payouts required for beneficiary flow");
  const ordered = [...shares].sort((left, right) => left.ordinal - right.ordinal);
  assert.equal(releaseResponse.payouts.length, ordered.length, "all captured Shares paid");
  assert.equal(new Set(releaseResponse.payouts.map(({ payoutId }) => payoutId)).size, releaseResponse.payouts.length, "Payout identities unique");
  assert.equal(new Set(releaseResponse.payouts.map(({ beneficiaryShareId }) => beneficiaryShareId)).size, releaseResponse.payouts.length, "one Payout response per Share");
  for (let index = 0; index < ordered.length; index += 1) {
    const payout = releaseResponse.payouts[index];
    const share = ordered[index];
    assert.equal(payout.releaseId, releaseResponse.releaseId, "Payout Release identity");
    assert.equal(payout.beneficiaryShareId, share.beneficiaryShareId, "Payout Share identity and order");
    assert.equal(payout.beneficiaryId, share.beneficiaryId, "Payout beneficiary");
    assert.equal(payout.amountMinor, share.amountMinor, "Payout amount");
  }
  assert.equal(releaseResponse.payouts.reduce((sum, item) => sum + item.amountMinor, 0), releaseResponse.amountMinor, "Payout amount sum");
  return releaseResponse;
}

export function percentile(values, quantile) { if (!Array.isArray(values) || values.length === 0) return 0; const sorted = [...values].sort((left, right) => left - right); return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]; }

const ROUTES = Object.freeze({
  "/api/v1/escrows": Object.freeze({ get: ["200", "400"], post: ["201", "400", "409", "415"] }),
  "/api/v1/escrows/{escrowId}": Object.freeze({ get: ["200", "404"] }),
  "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/submit": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/admin/disputes/{disputeId}/resolve": Object.freeze({ post: ["200", "400", "401", "404", "409", "415"] }),
  "/api/v1/domain-events": Object.freeze({ get: ["200", "400"] }),
  "/api/v1/verification-snapshot": Object.freeze({ get: ["200", "401"] })
});
const COMPONENTS = Object.freeze({ Party: PARTY_KEYS, Escrow: ESCROW_KEYS, Milestone: MILESTONE_KEYS, Dispute: DISPUTE_KEYS, Release: RELEASE_KEYS, FundPosition: ["totalMinor", "availableMinor", "releasedMinor", "refundedMinor"], Work: WORK_KEYS, DomainEvent: EVENT_KEYS, BeneficiaryShare: SHARE_KEYS, BeneficiaryPayout: PAYOUT_KEYS });
const FIELD_CONTRACTS = Object.freeze({
  Party: Object.freeze({ partyId: "uuid", displayName: "string" }),
  Escrow: Object.freeze({ escrowId: "uuid", buyerId: "uuid", sellerId: "uuid", currency: "currency", totalMinor: "positiveInteger", availableMinor: "nonnegativeInteger", releasedMinor: "nonnegativeInteger", refundedMinor: "nonnegativeInteger", state: ["FUNDED", "ACTIVE", "DISPUTED", "RELEASED", "REFUNDED"], expiresAt: "timestamp", createdAt: "timestamp", terminalAt: "nullableTimestamp", sequence: "positiveInteger" }),
  Milestone: Object.freeze({ milestoneId: "uuid", escrowId: "uuid", ordinal: "positiveInteger", title: "string", amountMinor: "positiveInteger", state: ["PENDING", "SUBMITTED", "ACCEPTED", "DISPUTED", "RELEASED", "REFUNDED"], submittedAt: "nullableTimestamp", decidedAt: "nullableTimestamp", releasedAt: "nullableTimestamp" }),
  Dispute: Object.freeze({ disputeId: "uuid", escrowId: "uuid", milestoneId: "uuid", openedBy: ["BUYER", "SELLER"], reason: "string", state: ["OPEN", "RESOLVED_RELEASE", "RESOLVED_REFUND"], openedAt: "timestamp", resolvedAt: "nullableTimestamp", resolutionNote: "nullableString" }),
  Release: Object.freeze({ releaseId: "uuid", escrowId: "uuid", milestoneId: "uuid", sellerId: "uuid", amountMinor: "positiveInteger", createdAt: "timestamp" }),
  FundPosition: Object.freeze({ totalMinor: "positiveInteger", availableMinor: "nonnegativeInteger", releasedMinor: "nonnegativeInteger", refundedMinor: "nonnegativeInteger" }),
  Work: Object.freeze({ workId: "uuid", kind: ["ESCROW_EXPIRY"], aggregateId: "uuid", state: ["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"], terminal: "boolean", attempt: "nonnegativeInteger", leaseOwner: "nullableString", leaseExpiresAt: "nullableTimestamp" }),
  DomainEvent: Object.freeze({ eventId: "uuid", aggregateId: "uuid", sequence: "positiveInteger", type: EVENT_TYPES, occurredAt: "timestamp", schemaVersion: "one", payload: "emptyObject" }),
  BeneficiaryShare: Object.freeze({ beneficiaryShareId: "uuid", milestoneId: "uuid", ordinal: "positiveInteger", beneficiaryId: "uuid", amountMinor: "positiveInteger" }),
  BeneficiaryPayout: Object.freeze({ payoutId: "uuid", releaseId: "uuid", beneficiaryShareId: "uuid", beneficiaryId: "uuid", amountMinor: "positiveInteger", createdAt: "timestamp" }),
});
const OPERATION_PARAMETERS = Object.freeze({
  "GET /api/v1/escrows": Object.freeze([["query", "limit", false, "boundedLimit"], ["query", "cursor", false, "string"]]),
  "POST /api/v1/escrows": Object.freeze([["header", "idempotency-key", true, "idempotencyKey"]]),
  "GET /api/v1/escrows/{escrowId}": Object.freeze([["path", "escrowId", true, "uuid"]]),
  "POST /api/v1/escrows/{escrowId}/milestones/{milestoneId}/submit": Object.freeze([["path", "escrowId", true, "uuid"], ["path", "milestoneId", true, "uuid"], ["header", "idempotency-key", true, "idempotencyKey"]]),
  "POST /api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept": Object.freeze([["path", "escrowId", true, "uuid"], ["path", "milestoneId", true, "uuid"], ["header", "idempotency-key", true, "idempotencyKey"]]),
  "POST /api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes": Object.freeze([["path", "escrowId", true, "uuid"], ["path", "milestoneId", true, "uuid"], ["header", "idempotency-key", true, "idempotencyKey"]]),
  "POST /api/v1/admin/disputes/{disputeId}/resolve": Object.freeze([["path", "disputeId", true, "uuid"], ["header", "idempotency-key", true, "idempotencyKey"]]),
  "GET /api/v1/domain-events": Object.freeze([["query", "aggregateId", false, "uuid"], ["query", "afterSequence", false, "nonnegativeInteger"], ["query", "limit", false, "boundedLimit"]]),
  "GET /api/v1/verification-snapshot": Object.freeze([]),
});

function resolveSchema(document, schema, seen = new Set()) { assert.ok(schema && typeof schema === "object", "OpenAPI schema required"); if (!schema.$ref) return schema; assert.match(schema.$ref, /^#\/components\/schemas\/[^/]+$/u, "local schema reference"); assert.ok(!seen.has(schema.$ref), `cyclic schema ${schema.$ref}`); const value = document.components?.schemas?.[schema.$ref.split("/").at(-1)]; assert.ok(value, `missing schema ${schema.$ref}`); return resolveSchema(document, value, new Set([...seen, schema.$ref])); }
function resolveResponse(document, response) { if (!response?.$ref) return response; assert.match(response.$ref, /^#\/components\/responses\/[^/]+$/u); const value = document.components?.responses?.[response.$ref.split("/").at(-1)]; assert.ok(value, "missing response ref"); return value; }
function resolveParameter(document, parameter) { if (!parameter?.$ref) return parameter; assert.match(parameter.$ref, /^#\/components\/parameters\/[^/]+$/u); const value = document.components?.parameters?.[parameter.$ref.split("/").at(-1)]; assert.ok(value, "missing parameter ref"); return value; }
function closedWithRequired(document, schema, fields, required, label) { const value = resolveSchema(document, schema); assert.equal(value.type, "object", `${label} object`); assert.equal(value.additionalProperties, false, `${label} closed`); assert.deepEqual(Object.keys(value.properties ?? {}).sort(), [...fields].sort(), `${label} properties`); assert.deepEqual([...(value.required ?? [])].sort(), [...required].sort(), `${label} required`); return value; }
function closed(document, schema, fields, label) { return closedWithRequired(document, schema, fields, fields, label); }
function jsonSchema(document, response, label) { const content = resolveResponse(document, response)?.content; assert.deepEqual(Object.keys(content ?? {}), ["application/json"], `${label} JSON-only content`); const schema = content?.["application/json"]?.schema; assert.ok(schema, `${label} JSON schema`); return schema; }

function schemaAlternatives(document, schema) {
  const value = resolveSchema(document, schema);
  if (value.oneOf || value.anyOf) return [...(value.oneOf ?? value.anyOf)].map((item) => resolveSchema(document, item));
  if (Array.isArray(value.type)) return value.type.map((type) => ({ ...value, type }));
  if (value.nullable === true) return [{ ...value, nullable: undefined }, { type: "null" }];
  return [value];
}
function scalarSchema(document, schema, { nullable = false } = {}, label) {
  const alternatives = schemaAlternatives(document, schema);
  const nulls = alternatives.filter(({ type }) => type === "null");
  assert.equal(nulls.length, nullable ? 1 : 0, `${label} exact nullability`);
  const values = alternatives.filter(({ type }) => type !== "null");
  assert.equal(values.length, 1, `${label} single non-null schema`);
  return values[0];
}
function assertIntegerBounds(schema, { positive = false, limit = false } = {}, label) {
  assert.equal(schema.type, "integer", `${label} integer`);
  const lower = schema.minimum ?? (schema.exclusiveMinimum === 0 ? 1 : -Infinity);
  assert.ok(lower >= (positive ? 1 : 0), `${label} lower bound`);
  assert.ok((schema.maximum ?? Infinity) <= (limit ? 100 : Number.MAX_SAFE_INTEGER), `${label} upper bound`);
  if (limit) assert.ok((schema.maximum ?? 0) >= 100, `${label} permits published limit 100`);
}
function assertSchemaKind(document, rawSchema, kind, label) {
  if (Array.isArray(kind)) { const schema = scalarSchema(document, rawSchema, {}, label); assert.equal(schema.type, "string", `${label} string enum`); assert.deepEqual([...(schema.enum ?? [])], [...kind], `${label} exact enum`); return; }
  const nullable = kind.startsWith("nullable"); const schema = scalarSchema(document, rawSchema, { nullable }, label); const baseKind = nullable ? `${kind[8].toLowerCase()}${kind.slice(9)}` : kind;
  if (baseKind === "uuid") { assert.equal(schema.type, "string", `${label} string`); assert.equal(schema.format, "uuid", `${label} UUID format`); }
  else if (baseKind === "timestamp") { assert.equal(schema.type, "string", `${label} string`); assert.equal(schema.format, "date-time", `${label} timestamp format`); }
  else if (baseKind === "currency") { assert.equal(schema.type, "string", `${label} string`); assert.ok(schema.pattern, `${label} currency pattern`); const pattern = new RegExp(schema.pattern, "u"); assert.ok(pattern.test("USD") && !pattern.test("usd") && !pattern.test("USDD"), `${label} exact uppercase currency semantics`); }
  else if (baseKind === "positiveInteger") assertIntegerBounds(schema, { positive: true }, label);
  else if (baseKind === "nonnegativeInteger") assertIntegerBounds(schema, {}, label);
  else if (baseKind === "boundedLimit") assertIntegerBounds(schema, { positive: true, limit: true }, label);
  else if (baseKind === "boolean") assert.equal(schema.type, "boolean", `${label} boolean`);
  else if (baseKind === "string") assert.equal(schema.type, "string", `${label} string`);
  else if (baseKind === "one") { assert.equal(schema.type, "integer", `${label} integer`); assert.ok(schema.const === 1 || JSON.stringify(schema.enum) === "[1]", `${label} constant one`); }
  else if (baseKind === "emptyObject") { closed(document, schema, [], label); }
  else if (baseKind === "idempotencyKey") { assert.equal(schema.type, "string", `${label} string`); assert.equal(schema.minLength, 1, `${label} minimum length`); assert.equal(schema.maxLength, 128, `${label} maximum length`); assert.ok(schema.pattern, `${label} visible ASCII pattern`); const pattern = new RegExp(schema.pattern, "u"); assert.ok(pattern.test("visible-key") && !pattern.test("bad\nkey") && !pattern.test("\u001f"), `${label} visible ASCII semantics`); }
  else throw new TypeError(`unknown OpenAPI schema kind ${baseKind}`);
}
function assertResourceSchema(document, rawSchema, name, label = name) {
  const fields = COMPONENTS[name]; const contracts = FIELD_CONTRACTS[name]; const value = closed(document, rawSchema, fields, label);
  for (const [field, kind] of Object.entries(contracts)) assertSchemaKind(document, value.properties[field], kind, `${label}.${field}`);
  return value;
}
function assertArraySchema(document, rawSchema, label, itemAssertion, { minItems, maxItems } = {}) {
  const schema = scalarSchema(document, rawSchema, {}, label); assert.equal(schema.type, "array", `${label} array`); assert.ok(schema.items, `${label} item schema`); if (minItems !== undefined) assert.equal(schema.minItems, minItems, `${label} minItems`); if (maxItems !== undefined) assert.equal(schema.maxItems, maxItems, `${label} maxItems`); itemAssertion(schema.items); return schema;
}
function assertNullableResource(document, rawSchema, name, label) { const schema = scalarSchema(document, rawSchema, { nullable: true }, label); return assertResourceSchema(document, schema, name, label); }
function errorContract(document, response, label) { const envelope = closed(document, jsonSchema(document, response, label), ["error"], `${label} envelope`); const error = closed(document, envelope.properties.error, ["code", "message", "details"], `${label} error`); assertSchemaKind(document, error.properties.code, "string", `${label} error.code`); assertSchemaKind(document, error.properties.message, "string", `${label} error.message`); assertSchemaKind(document, error.properties.details, "emptyObject", `${label} error.details`); }

function operationParameters(document, pathItem, operation, label) {
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((item) => resolveParameter(document, item));
  const expected = OPERATION_PARAMETERS[label] ?? [];
  assert.deepEqual(parameters.map(({ in: location, name }) => [location, location === "header" ? name.toLowerCase() : name]).sort(), expected.map(([location, name]) => [location, name]).sort(), `${label} exact parameters`);
  for (const [location, name, required, kind] of expected) { const parameter = parameters.find((item) => item.in === location && (location === "header" ? item.name.toLowerCase() : item.name) === name); assert.equal(parameter.required === true, required, `${label} ${name} required`); assertSchemaKind(document, parameter.schema, kind, `${label} ${name}`); }
}
function requestBodySchema(document, operation, label) { const request = operation.requestBody?.$ref ? document.components?.requestBodies?.[operation.requestBody.$ref.split("/").at(-1)] : operation.requestBody; assert.ok(request?.required, `${label} request body required`); assert.deepEqual(Object.keys(request.content ?? {}), ["application/json"], `${label} request JSON-only`); const schema = request.content["application/json"].schema; assert.ok(schema, `${label} request schema`); return schema; }
function assertCreateRequest(document, rawSchema, { final }, label) {
  const request = closed(document, rawSchema, ["buyerId", "sellerId", "currency", "totalMinor", "expiresAt", "milestones"], label);
  for (const [field, kind] of [["buyerId", "uuid"], ["sellerId", "uuid"], ["currency", "currency"], ["totalMinor", "positiveInteger"], ["expiresAt", "timestamp"]]) assertSchemaKind(document, request.properties[field], kind, `${label}.${field}`);
  assertArraySchema(document, request.properties.milestones, `${label}.milestones`, (itemSchema) => {
    const alternatives = resolveSchema(document, itemSchema).oneOf?.map((item) => resolveSchema(document, item)) ?? [resolveSchema(document, itemSchema)];
    const legacy = alternatives.find((item) => JSON.stringify(Object.keys(item.properties ?? {}).sort()) === JSON.stringify(["amountMinor", "title"]));
    const beneficiary = alternatives.find((item) => Object.hasOwn(item.properties ?? {}, "beneficiaries")) ?? (alternatives.length === 1 ? alternatives[0] : undefined);
    assert.ok(legacy || (final && beneficiary), `${label} legacy Milestone form`);
    if (legacy) { const value = closed(document, legacy, ["title", "amountMinor"], `${label}.legacyMilestone`); assertSchemaKind(document, value.properties.title, "string", `${label}.legacyMilestone.title`); assertSchemaKind(document, value.properties.amountMinor, "positiveInteger", `${label}.legacyMilestone.amountMinor`); }
    if (final) {
      assert.ok(beneficiary, `${label} beneficiary Milestone form`); const fields = ["title", "amountMinor", "beneficiaries"]; const required = alternatives.length === 1 ? ["title", "amountMinor"] : fields; const value = closedWithRequired(document, beneficiary, fields, required, `${label}.beneficiaryMilestone`); assertSchemaKind(document, value.properties.title, "string", `${label}.beneficiaryMilestone.title`); assertSchemaKind(document, value.properties.amountMinor, "positiveInteger", `${label}.beneficiaryMilestone.amountMinor`); assertArraySchema(document, value.properties.beneficiaries, `${label}.beneficiaries`, (entry) => { const item = closed(document, entry, ["beneficiaryId", "amountMinor"], `${label}.beneficiary`); assertSchemaKind(document, item.properties.beneficiaryId, "uuid", `${label}.beneficiaryId`); assertSchemaKind(document, item.properties.amountMinor, "positiveInteger", `${label}.beneficiaryAmount`); }, { minItems: 1, maxItems: 20 });
    }
  }, { minItems: 1, maxItems: 20 });
}
function assertRequestContract(document, path, operation, { final }) {
  const label = `POST ${path}`; const schema = requestBodySchema(document, operation, label);
  if (path === "/api/v1/escrows") assertCreateRequest(document, schema, { final }, label);
  else if (path.endsWith("/submit")) { const value = closed(document, schema, ["evidence"], label); assert.ok(value.properties.evidence && typeof value.properties.evidence === "object", `${label}.evidence published opaque JSON`); }
  else if (path.endsWith("/accept")) closed(document, schema, [], label);
  else if (path.endsWith("/disputes")) { const value = closed(document, schema, ["openedBy", "reason"], label); assertSchemaKind(document, value.properties.openedBy, ["BUYER", "SELLER"], `${label}.openedBy`); assertSchemaKind(document, value.properties.reason, "string", `${label}.reason`); }
  else { const value = closed(document, schema, ["decision", "note"], label); assertSchemaKind(document, value.properties.decision, ["RELEASE", "REFUND"], `${label}.decision`); assertSchemaKind(document, value.properties.note, "string", `${label}.note`); }
}

function assertPageSchema(document, schema, itemName, label) { const page = closed(document, schema, ["items", "nextCursor"], label); assertArraySchema(document, page.properties.items, `${label}.items`, (item) => assertResourceSchema(document, item, itemName, `${label}.item`)); assertSchemaKind(document, page.properties.nextCursor, "nullableString", `${label}.nextCursor`); }
function assertDetailSchema(document, schema, { final }, label) { const fields = ["escrow", "milestones", "dispute", "releases", "fundPosition", ...(final ? ["beneficiaryShares", "beneficiaryPayouts"] : [])]; const detail = closed(document, schema, fields, label); assertResourceSchema(document, detail.properties.escrow, "Escrow", `${label}.escrow`); assertArraySchema(document, detail.properties.milestones, `${label}.milestones`, (item) => assertResourceSchema(document, item, "Milestone", `${label}.milestone`)); assertNullableResource(document, detail.properties.dispute, "Dispute", `${label}.dispute`); assertArraySchema(document, detail.properties.releases, `${label}.releases`, (item) => assertResourceSchema(document, item, "Release", `${label}.release`)); assertResourceSchema(document, detail.properties.fundPosition, "FundPosition", `${label}.fundPosition`); if (final) { assertArraySchema(document, detail.properties.beneficiaryShares, `${label}.beneficiaryShares`, (item) => assertResourceSchema(document, item, "BeneficiaryShare", `${label}.share`)); assertArraySchema(document, detail.properties.beneficiaryPayouts, `${label}.beneficiaryPayouts`, (item) => assertResourceSchema(document, item, "BeneficiaryPayout", `${label}.payout`)); } }
function assertSnapshotSchema(document, schema, { final }, label) { const snapshot = closed(document, schema, ["asOf", "resources", "work", "events"], label); assertSchemaKind(document, snapshot.properties.asOf, "timestamp", `${label}.asOf`); const resourceNames = final ? FINAL_RESOURCE_KEYS : V1_RESOURCE_KEYS; const resourceSchema = closed(document, snapshot.properties.resources, resourceNames, `${label}.resources`); const itemNames = { parties: "Party", escrows: "Escrow", milestones: "Milestone", disputes: "Dispute", releases: "Release", beneficiaryShares: "BeneficiaryShare", beneficiaryPayouts: "BeneficiaryPayout" }; for (const name of resourceNames) assertArraySchema(document, resourceSchema.properties[name], `${label}.resources.${name}`, (item) => assertResourceSchema(document, item, itemNames[name], `${label}.${itemNames[name]}`)); assertArraySchema(document, snapshot.properties.work, `${label}.work`, (item) => assertResourceSchema(document, item, "Work", `${label}.Work`)); assertArraySchema(document, snapshot.properties.events, `${label}.events`, (item) => assertResourceSchema(document, item, "DomainEvent", `${label}.DomainEvent`)); }
function assertAcceptResponse(document, rawSchema, { final }) {
  const alternatives = final && (resolveSchema(document, rawSchema).oneOf || resolveSchema(document, rawSchema).anyOf) ? schemaAlternatives(document, rawSchema) : [resolveSchema(document, rawSchema)];
  assert.ok(alternatives.length >= 1 && alternatives.length <= (final ? 2 : 1), "accept response exact compatibility variants");
  let legacy = 0; let current = 0;
  for (const schema of alternatives) {
    const fields = Object.keys(schema.properties ?? {}).sort(); const isCurrent = final && fields.includes("payouts"); const expected = [...RELEASE_KEYS, ...(isCurrent ? ["payouts"] : [])]; const value = closed(document, schema, expected, isCurrent ? "FINAL accept response" : "legacy accept response");
    for (const [field, kind] of Object.entries(FIELD_CONTRACTS.Release)) assertSchemaKind(document, value.properties[field], kind, `accept response.${field}`);
    if (isCurrent) { current += 1; assertArraySchema(document, value.properties.payouts, "accept response.payouts", (item) => assertResourceSchema(document, item, "BeneficiaryPayout", "accept response.payout")); } else legacy += 1;
  }
  if (final) assert.equal(current, 1, "FINAL accept response publishes Payouts"); else assert.equal(legacy, 1, "V1 accept response is Release");
}
function assertSuccessContract(document, path, status, response, { final }) { const schema = jsonSchema(document, response, `${path} ${status}`); if (path === "/api/v1/escrows" && status === "200") assertPageSchema(document, schema, "Escrow", "Escrow page"); else if (path === "/api/v1/escrows" && status === "201") assertResourceSchema(document, schema, "Escrow", "create response"); else if (path === "/api/v1/escrows/{escrowId}") assertDetailSchema(document, schema, { final }, "detail response"); else if (path.endsWith("/submit")) { const value = closed(document, schema, ["escrow", "milestone"], "submit response"); assertResourceSchema(document, value.properties.escrow, "Escrow", "submit Escrow"); assertResourceSchema(document, value.properties.milestone, "Milestone", "submit Milestone"); } else if (path.endsWith("/accept")) assertAcceptResponse(document, schema, { final }); else if (path.endsWith("/disputes") || path.endsWith("/resolve")) assertResourceSchema(document, schema, "Dispute", "Dispute response"); else if (path === "/api/v1/domain-events") assertPageSchema(document, schema, "DomainEvent", "Event page"); else assertSnapshotSchema(document, schema, { final }, "snapshot response"); }

function assertBearerSecurity(document, operation, label) {
  const requirements = operation.security;
  assert.ok(Array.isArray(requirements) && requirements.length > 0, `${label} requires security`);
  for (const [index, requirement] of requirements.entries()) {
    assert.ok(requirement && typeof requirement === "object" && !Array.isArray(requirement), `${label} security requirement ${index + 1}`);
    const names = Object.keys(requirement);
    assert.equal(names.length, 1, `${label} uses only one Bearer security scheme per alternative`);
    const scheme = document.components?.securitySchemes?.[names[0]];
    assert.ok(scheme, `${label} references an existing security scheme`);
    assert.equal(scheme.type, "http", `${label} security scheme type`);
    assert.equal(String(scheme.scheme ?? "").toLowerCase(), "bearer", `${label} security scheme is Bearer`);
    assert.deepEqual(requirement[names[0]], [], `${label} Bearer security has no OAuth scopes`);
  }
}

export function escrowGuardOpenApiRoutes() { return structuredClone(ROUTES); }
export function assertEscrowGuardOpenApi(document, { final = true, author } = {}) {
  if (assertPublishedOpenApi(document, author)) return true;
  assert.match(document?.openapi ?? "", /^3\.1(?:\.\d+)?$/u, "OpenAPI 3.1"); assert.ok(document.paths && typeof document.paths === "object", "OpenAPI paths"); assert.deepEqual(Object.keys(document.paths).filter((path) => path.startsWith("/api/v1/")).sort(), Object.keys(ROUTES).sort(), "exact public API paths");
  assert.ok(document.security === undefined || (Array.isArray(document.security) && document.security.length === 0), "OpenAPI root does not impose authentication on public routes");
  for (const [path, methods] of Object.entries(ROUTES)) {
    const pathItem = document.paths[path]; assert.ok(pathItem, `missing ${path}`);
    assert.deepEqual(Object.keys(pathItem).filter((key) => ["get", "post", "put", "patch", "delete"].includes(key)).sort(), Object.keys(methods).sort(), `${path} exact methods`);
    for (const [method, statuses] of Object.entries(methods)) {
      const label = `${method.toUpperCase()} ${path}`; const operation = pathItem[method]; assert.ok(operation, `missing ${label}`); assert.deepEqual(Object.keys(operation.responses ?? {}).sort(), [...statuses].sort(), `${label} statuses`); operationParameters(document, pathItem, operation, label);
      const secured = path === "/api/v1/verification-snapshot" || path === "/api/v1/admin/disputes/{disputeId}/resolve";
      if (!secured) assert.ok(operation.security === undefined || (Array.isArray(operation.security) && operation.security.length === 0), `${label} remains anonymously public`);
      for (const status of statuses) { const response = operation.responses[status]; if (Number(status) >= 400) errorContract(document, response, `${method} ${path} ${status}`); else assertSuccessContract(document, path, status, response, { final }); }
      if (method === "post") assertRequestContract(document, path, operation, { final });
    }
  }
  assertBearerSecurity(document, document.paths["/api/v1/verification-snapshot"].get, "snapshot");
  assertBearerSecurity(document, document.paths["/api/v1/admin/disputes/{disputeId}/resolve"].post, "admin resolve");
  return true;
}
