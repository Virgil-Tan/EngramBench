import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory, makeEscrowFixture } from "../fixtures/index.mjs";
import { assertDetail, assertEscrow, assertReleasePayouts, assertSnapshot, canonicalJson } from "../oracles/index.mjs";
import { assertNoPrivatePaths } from "../cases/helpers.mjs";

const options = { evaluationSeed: "test-seed", caseId: "A-01", baseTime: "2035-06-01T12:00:00.000Z" };

function fundedSnapshot(fixture) {
  const shares = fixture.milestones.map((milestone, index) => ({
    beneficiaryShareId: fixture.fixtures.uuid(`owned-share-${index}`),
    milestoneId: milestone.milestoneId,
    ordinal: 1,
    beneficiaryId: fixture.sellerId,
    amountMinor: milestone.amountMinor,
  }));
  return {
    asOf: fixture.fixtures.at(),
    resources: {
      parties: [...fixture.parties].sort((left, right) => Buffer.from(left.partyId).compare(Buffer.from(right.partyId))),
      escrows: [fixture.escrow],
      milestones: fixture.milestones,
      disputes: [],
      releases: [],
      beneficiaryShares: shares,
      beneficiaryPayouts: [],
    },
    work: [{ workId: fixture.fixtures.uuid("owned-work"), kind: "ESCROW_EXPIRY", aggregateId: fixture.escrowId, state: "PENDING", terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null }],
    events: [{ eventId: fixture.fixtures.uuid("owned-event"), aggregateId: fixture.escrowId, sequence: 1, type: "escrow.funded", occurredAt: fixture.fixtures.at({ hours: -2 }), schemaVersion: 1, payload: {} }],
  };
}

test("fixture identities, keys, and times are deterministic and case-scoped", () => {
  const left = createFixtureFactory(options), right = createFixtureFactory(options), other = createFixtureFactory({ ...options, caseId: "A-02" });
  assert.equal(left.uuid("x"), right.uuid("x")); assert.equal(left.key("x"), right.key("x")); assert.equal(left.at({ minutes: 1 }), "2035-06-01T12:01:00.000Z"); assert.notEqual(left.uuid("x"), other.uuid("x"));
});

test("task-local snapshot oracle closes fund, Share, Work, and Event identity", () => {
  const fixture = makeEscrowFixture(options, { amounts: [30, 70] });
  const beneficiaryShares = fixture.milestones.map((milestone, index) => ({ beneficiaryShareId: fixture.fixtures.uuid(`share-${index}`), milestoneId: milestone.milestoneId, ordinal: 1, beneficiaryId: fixture.sellerId, amountMinor: milestone.amountMinor }));
  const snapshot = { asOf: fixture.fixtures.at(), resources: { parties: [...fixture.parties].sort((a, b) => Buffer.from(a.partyId).compare(Buffer.from(b.partyId))), escrows: [fixture.escrow], milestones: fixture.milestones, disputes: [], releases: [], beneficiaryShares: [...beneficiaryShares].sort((a, b) => Buffer.from(a.milestoneId).compare(Buffer.from(b.milestoneId))), beneficiaryPayouts: [] }, work: [{ workId: fixture.fixtures.uuid("work"), kind: "ESCROW_EXPIRY", aggregateId: fixture.escrowId, state: "PENDING", terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null }], events: [{ eventId: fixture.fixtures.uuid("event"), aggregateId: fixture.escrowId, sequence: 1, type: "escrow.funded", occurredAt: fixture.fixtures.at({ hours: -2 }), schemaVersion: 1, payload: {} }] };
  assert.equal(assertSnapshot(snapshot), snapshot); assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.throws(() => assertEscrow({ ...fixture.escrow, availableMinor: fixture.escrow.availableMinor + 1 }), /conservation/u);
});

test("snapshot oracle rejects missing retained Work and orphan aggregate resources", () => {
  const fixture = makeEscrowFixture(options, { amounts: [20], label: "ownership" });
  const snapshot = fundedSnapshot(fixture);
  assert.equal(assertSnapshot(snapshot), snapshot);

  const missingWork = structuredClone(snapshot);
  missingWork.work = [];
  assert.throws(() => assertSnapshot(missingWork), /every Escrow retains exactly one expiry Work/u);

  const orphanMilestone = structuredClone(snapshot);
  orphanMilestone.resources.milestones.push({
    ...orphanMilestone.resources.milestones[0],
    milestoneId: fixture.fixtures.uuid("orphan-milestone"),
    escrowId: fixture.fixtures.uuid("orphan-escrow"),
  });
  orphanMilestone.resources.milestones.sort((left, right) => Buffer.from(`${left.escrowId}\0${left.ordinal}\0${left.milestoneId}`).compare(Buffer.from(`${right.escrowId}\0${right.ordinal}\0${right.milestoneId}`)));
  assert.throws(() => assertSnapshot(orphanMilestone), /Milestone Escrow exists/u);

  const orphanShare = structuredClone(snapshot);
  orphanShare.resources.beneficiaryShares.push({
    ...orphanShare.resources.beneficiaryShares[0],
    beneficiaryShareId: fixture.fixtures.uuid("orphan-share"),
    milestoneId: fixture.fixtures.uuid("missing-share-milestone"),
  });
  orphanShare.resources.beneficiaryShares.sort((left, right) => Buffer.from(`${left.milestoneId}\0${left.ordinal}\0${left.beneficiaryShareId}`).compare(Buffer.from(`${right.milestoneId}\0${right.ordinal}\0${right.beneficiaryShareId}`)));
  assert.throws(() => assertSnapshot(orphanShare), /Share Milestone exists/u);
});

test("snapshot oracle rejects private absolute paths without confusing JSON pointers or relative/public paths", () => {
  const fixture = makeEscrowFixture(options, { amounts: [20], label: "path-redaction" });
  const safe = fundedSnapshot(fixture);
  safe.resources.parties[0].displayName = "public /api/v1 path, JSON pointer /data, and relative workspace/data";
  assert.equal(assertSnapshot(safe), safe);
  for (const leaked of ["/workspace", "/workspace/submission/secret", "/data/postgres/private", "/tmp", "/Users", "/Users/person/project", "/home/person/project", "/etc/passwd", "C:\\Users", "C:\\Users\\person\\project"]) {
    const mutant = structuredClone(safe);
    mutant.resources.parties[0].displayName = leaked;
    assert.throws(() => assertSnapshot(mutant), /absolute filesystem paths/u);
  }
});

test("published nullable timestamps are type-checked without inventing state correlations", () => {
  const fixture = makeEscrowFixture(options, { amounts: [20], label: "timestamp-contract" });
  const snapshot = fundedSnapshot(fixture);
  snapshot.resources.escrows[0].terminalAt = fixture.fixtures.at({ minutes: 1 });
  snapshot.resources.milestones[0].submittedAt = fixture.fixtures.at({ minutes: 2 });
  assert.equal(assertSnapshot(snapshot), snapshot);
});

test("private-path scan catches absolute evaluator roots without rejecting relative/public paths", () => {
  assert.doesNotThrow(() => assertNoPrivatePaths("GET /api/v1/escrows, JSON pointer /data, and relative workspace/data"));
  for (const value of ["/workspace", "/workspace/submission", "/data/postgres", "/tmp", "/tmp/evaluator", "/private/var/db", "/etc/passwd", "/var", "/var/log/service", "C:\\Users", "C:\\Users\\person\\project", "postgresql://secret@db/private"]) assert.throws(() => assertNoPrivatePaths(value), /absolute filesystem paths/u);
});

test("beneficiary payout oracle rejects duplicate payout and Share identities", () => {
  const fixture = makeEscrowFixture(options, { amounts: [20] });
  const releaseId = fixture.fixtures.uuid("release-response");
  const shares = [0, 1].map((index) => ({
    beneficiaryShareId: fixture.fixtures.uuid(`share-${index}`),
    milestoneId: fixture.milestones[0].milestoneId,
    ordinal: index + 1,
    beneficiaryId: fixture.parties[index + 2].partyId,
    amountMinor: 10,
  }));
  const payoutId = fixture.fixtures.uuid("duplicate-payout");
  const payouts = shares.map((share) => ({
    payoutId,
    releaseId,
    beneficiaryShareId: share.beneficiaryShareId,
    beneficiaryId: share.beneficiaryId,
    amountMinor: share.amountMinor,
    createdAt: fixture.fixtures.at(),
  }));
  const response = {
    releaseId,
    escrowId: fixture.escrowId,
    milestoneId: fixture.milestones[0].milestoneId,
    sellerId: fixture.sellerId,
    amountMinor: 20,
    createdAt: fixture.fixtures.at(),
    payouts,
  };
  assert.throws(() => assertReleasePayouts(response, shares), /identities unique/u);
  payouts[1] = { ...payouts[1], payoutId: fixture.fixtures.uuid("second-payout"), beneficiaryShareId: shares[0].beneficiaryShareId };
  assert.throws(() => assertReleasePayouts(response, shares), /one Payout response per Share/u);
});

test("snapshot oracle rejects an extra durable Payout row hidden by Share-key deduplication", () => {
  const fixture = makeEscrowFixture(options, { amounts: [20], states: ["RELEASED"], label: "released-payout" });
  const release = fixture.releases[0];
  const shares = [0, 1].map((index) => ({
    beneficiaryShareId: fixture.fixtures.uuid(`durable-share-${index}`),
    milestoneId: fixture.milestones[0].milestoneId,
    ordinal: index + 1,
    beneficiaryId: fixture.parties[index + 2].partyId,
    amountMinor: 10,
  }));
  const payouts = shares.map((share, index) => ({
    payoutId: fixture.fixtures.uuid(`durable-payout-${index}`),
    releaseId: release.releaseId,
    beneficiaryShareId: share.beneficiaryShareId,
    beneficiaryId: share.beneficiaryId,
    amountMinor: share.amountMinor,
    createdAt: release.createdAt,
  }));
  payouts.push({ ...payouts[0], payoutId: fixture.fixtures.uuid("extra-durable-payout") });
  payouts.sort((left, right) => Buffer.from(`${left.releaseId}\0${left.beneficiaryShareId}\0${left.payoutId}`).compare(Buffer.from(`${right.releaseId}\0${right.beneficiaryShareId}\0${right.payoutId}`)));
  const snapshot = {
    asOf: fixture.fixtures.at(),
    resources: {
      parties: [...fixture.parties].sort((left, right) => Buffer.from(left.partyId).compare(Buffer.from(right.partyId))),
      escrows: [fixture.escrow],
      milestones: fixture.milestones,
      disputes: [],
      releases: fixture.releases,
      beneficiaryShares: shares,
      beneficiaryPayouts: payouts,
    },
    work: [{ workId: fixture.fixtures.uuid("released-work"), kind: "ESCROW_EXPIRY", aggregateId: fixture.escrowId, state: "CANCELLED", terminal: true, attempt: 0, leaseOwner: null, leaseExpiresAt: null }],
    events: [
      { eventId: fixture.fixtures.uuid("released-event-1"), aggregateId: fixture.escrowId, sequence: 1, type: "escrow.funded", occurredAt: fixture.fixtures.at({ hours: -2 }), schemaVersion: 1, payload: {} },
      { eventId: fixture.fixtures.uuid("released-event-2"), aggregateId: fixture.escrowId, sequence: 2, type: "milestone.submitted", occurredAt: fixture.fixtures.at({ minutes: -90 }), schemaVersion: 1, payload: {} },
      { eventId: fixture.fixtures.uuid("released-event-3"), aggregateId: fixture.escrowId, sequence: 3, type: "milestone.released", occurredAt: fixture.fixtures.at({ minutes: -79 }), schemaVersion: 1, payload: {} },
    ],
  };
  assert.throws(() => assertSnapshot(snapshot), /one Payout row per captured Share/u);
});

test("detail oracle validates the complete Milestone, Release, Share and Payout graph", () => {
  const fixture = makeEscrowFixture(options, { amounts: [20], states: ["RELEASED"], label: "detail-graph" });
  const release = fixture.releases[0];
  const shares = [0, 1].map((index) => ({
    beneficiaryShareId: fixture.fixtures.uuid(`detail-share-${index}`),
    milestoneId: fixture.milestones[0].milestoneId,
    ordinal: index + 1,
    beneficiaryId: fixture.parties[index + 2].partyId,
    amountMinor: 10,
  }));
  const payouts = shares.map((share, index) => ({
    payoutId: fixture.fixtures.uuid(`detail-payout-${index}`),
    releaseId: release.releaseId,
    beneficiaryShareId: share.beneficiaryShareId,
    beneficiaryId: share.beneficiaryId,
    amountMinor: share.amountMinor,
    createdAt: release.createdAt,
  }));
  const detail = {
    escrow: fixture.escrow,
    milestones: fixture.milestones,
    dispute: null,
    releases: fixture.releases,
    fundPosition: { totalMinor: 20, availableMinor: 0, releasedMinor: 20, refundedMinor: 0 },
    beneficiaryShares: shares,
    beneficiaryPayouts: payouts,
  };
  assert.equal(assertDetail(detail), detail);
  assert.throws(() => assertDetail({ ...detail, beneficiaryPayouts: payouts.slice(0, 1) }), /complete Payout set/u);
});

test("detail and snapshot oracles reject state, Release, Fund Position, and Dispute contradictions", () => {
  const fixture = makeEscrowFixture(options, { amounts: [20], states: ["RELEASED"], label: "history-consistency" });
  const release = fixture.releases[0];
  const share = {
    beneficiaryShareId: fixture.fixtures.uuid("history-share"),
    milestoneId: fixture.milestones[0].milestoneId,
    ordinal: 1,
    beneficiaryId: fixture.sellerId,
    amountMinor: 20,
  };
  const payout = {
    payoutId: fixture.fixtures.uuid("history-payout"),
    releaseId: release.releaseId,
    beneficiaryShareId: share.beneficiaryShareId,
    beneficiaryId: share.beneficiaryId,
    amountMinor: 20,
    createdAt: release.createdAt,
  };
  const detail = {
    escrow: fixture.escrow,
    milestones: fixture.milestones,
    dispute: null,
    releases: fixture.releases,
    fundPosition: { totalMinor: 20, availableMinor: 0, releasedMinor: 20, refundedMinor: 0 },
    beneficiaryShares: [share],
    beneficiaryPayouts: [payout],
  };
  assert.equal(assertDetail(detail), detail);

  const wrongState = structuredClone(detail);
  wrongState.escrow.state = "REFUNDED";
  assert.throws(() => assertDetail(wrongState), /Escrow state reconciles with history/u);

  const missingRelease = structuredClone(detail);
  missingRelease.releases = [];
  missingRelease.beneficiaryPayouts = [];
  assert.throws(() => assertDetail(missingRelease), /one Release per released Milestone/u);

  const wrongFund = structuredClone(detail);
  wrongFund.escrow.availableMinor = 20;
  wrongFund.escrow.releasedMinor = 0;
  wrongFund.fundPosition = { totalMinor: 20, availableMinor: 20, releasedMinor: 0, refundedMinor: 0 };
  assert.throws(() => assertDetail(wrongFund), /Release conservation/u);

  const disputed = makeEscrowFixture(options, { amounts: [20], states: ["DISPUTED"], dispute: { state: "OPEN", milestoneIndex: 0 }, label: "open-dispute-consistency" });
  const disputedShare = { ...share, beneficiaryShareId: disputed.fixtures.uuid("disputed-share"), milestoneId: disputed.milestones[0].milestoneId, beneficiaryId: disputed.sellerId };
  const disputedDetail = { escrow: disputed.escrow, milestones: disputed.milestones, dispute: disputed.dispute, releases: [], fundPosition: { totalMinor: 20, availableMinor: 20, releasedMinor: 0, refundedMinor: 0 }, beneficiaryShares: [disputedShare], beneficiaryPayouts: [] };
  assert.equal(assertDetail(disputedDetail), disputedDetail);
  const unfrozen = structuredClone(disputedDetail);
  unfrozen.milestones[0].state = "SUBMITTED";
  assert.throws(() => assertDetail(unfrozen), /open Dispute freezes Milestone/u);

  const snapshot = {
    asOf: fixture.fixtures.at(),
    resources: { parties: [...fixture.parties].sort((left, right) => Buffer.from(left.partyId).compare(Buffer.from(right.partyId))), escrows: [wrongState.escrow], milestones: fixture.milestones, disputes: [], releases: fixture.releases, beneficiaryShares: [share], beneficiaryPayouts: [payout] },
    work: [{ workId: fixture.fixtures.uuid("history-work"), kind: "ESCROW_EXPIRY", aggregateId: fixture.escrowId, state: "CANCELLED", terminal: true, attempt: 0, leaseOwner: null, leaseExpiresAt: null }],
    events: Array.from({ length: fixture.escrow.sequence }, (_, index) => ({ eventId: fixture.fixtures.uuid(`history-event-${index}`), aggregateId: fixture.escrowId, sequence: index + 1, type: index === 0 ? "escrow.funded" : index === fixture.escrow.sequence - 1 ? "milestone.released" : "milestone.submitted", occurredAt: fixture.fixtures.at({ minutes: -100 + index }), schemaVersion: 1, payload: {} })),
  };
  assert.throws(() => assertSnapshot(snapshot), /Escrow state reconciles with history/u);
});
