import assert from "node:assert/strict";

import { standardAdapter } from "../standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../performance-runtime.mjs";

const uuid = (namespace, value) => `${namespace}-0000-4000-8000-${String(value).padStart(12, "0")}`;
const now = () => new Date().toISOString();
const soon = () => new Date(Date.now() + 1_000).toISOString();
const later = () => new Date(Date.now() + 86_400_000).toISOString();

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (typeof value[key] === "string") return value[key];
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = find(child, key);
    if (found) return found;
  }
  return undefined;
}

function stable(snapshot) {
  const { asOf: _asOf, ...value } = snapshot;
  return value;
}

function base(seedVersion, members) {
  return { schemaVersion: 1, seedVersion, ...members };
}

const escrowIds = {
  buyer: uuid("e1000000", 1),
  seller: uuid("e1000000", 2),
  beneficiary: uuid("e1000000", 3),
};

function escrowSeed(seedVersion = "hidden-escrow") {
  return base(seedVersion, {
    parties: [
      { partyId: escrowIds.buyer, displayName: "Buyer" },
      { partyId: escrowIds.seller, displayName: "Seller" },
      { partyId: escrowIds.beneficiary, displayName: "Beneficiary" },
    ],
    escrows: [], milestones: [], disputes: [], releases: [],
  });
}

function escrowPayload(index, manager = false) {
  const milestones = [
    { title: `Design ${index}`, amountMinor: 40 },
    { title: `Delivery ${index}`, amountMinor: 60 },
  ];
  if (manager) milestones[0].beneficiaries = [
    { beneficiaryId: escrowIds.seller, amountMinor: 25 },
    { beneficiaryId: escrowIds.beneficiary, amountMinor: 15 },
  ];
  return {
    buyerId: escrowIds.buyer,
    sellerId: escrowIds.seller,
    currency: "USD",
    totalMinor: 100,
    expiresAt: later(),
    milestones,
  };
}

const escrowguard = {
  label: "EscrowGuard funded milestone escrow",
  performanceScenarioIds: ["escrow-detail-read", "funded-escrow-create", "escrow-expiry-recovery"],
  seed: async () => escrowSeed(),
  path: "/api/v1/escrows",
  payload: (index) => ({ ...escrowPayload(index), ...(index === 3 ? { expiresAt: soon() } : {}) }),
  conflictPayload: (index) => ({ ...escrowPayload(index), totalMinor: 101 }),
  resource: "escrows",
  identity: (json) => find(json, "escrowId"),
  async verify(ctx, baseUrl, response) {
    const escrowId = find(response.json, "escrowId");
    const snapshot = await ctx.snapshot(baseUrl);
    const milestone = snapshot.resources.milestones.find((item) => item.escrowId === escrowId && item.ordinal === 1);
    const submitted = await ctx.mutate(baseUrl, `/api/v1/escrows/${escrowId}/milestones/${milestone.milestoneId}/submit`, "h03-submit", { evidence: "complete" });
    assert.equal(submitted.status, 200);
    const accepted = await ctx.mutate(baseUrl, `/api/v1/escrows/${escrowId}/milestones/${milestone.milestoneId}/accept`, "h03-accept", {});
    assert.equal(accepted.status, 200);
    const after = await ctx.snapshot(baseUrl);
    const escrow = after.resources.escrows.find((item) => item.escrowId === escrowId);
    assert.equal(escrow.totalMinor, escrow.availableMinor + escrow.releasedMinor + escrow.refundedMinor);
    assert.equal(after.resources.releases.filter((item) => item.escrowId === escrowId).length, 1);
  },
  async atomic(ctx, baseUrl, before) {
    const invalid = await ctx.mutate(baseUrl, "/api/v1/escrows", "h04-invalid-total", { ...escrowPayload(4), totalMinor: 99 });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json?.error?.code, "INVALID_ESCROW_TOTAL");
    assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(before));
  },
  async contention(ctx, baseUrls) {
    const snapshot = await ctx.snapshot(baseUrls[0]);
    const escrow = snapshot.resources.escrows.at(-1);
    const milestone = snapshot.resources.milestones.find((item) => item.escrowId === escrow.escrowId && item.ordinal === 1);
    await ctx.mutate(baseUrls[0], `/api/v1/escrows/${escrow.escrowId}/milestones/${milestone.milestoneId}/submit`, "h06-submit", { evidence: "done" });
    const attempts = await ctx.concurrent(Array.from({ length: 24 }), 24, (_, index) => ctx.mutate(
      baseUrls[index % 2], `/api/v1/escrows/${escrow.escrowId}/milestones/${milestone.milestoneId}/accept`, `h06-accept-${index}`, {},
    ));
    assert.equal(attempts.filter(({ status }) => status === 200).length, 1);
    assert.equal((await ctx.snapshot(baseUrls[1])).resources.releases.filter((item) => item.escrowId === escrow.escrowId).length, 1);
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const escrowId = find(created.json, "escrowId");
    assert.ok(snapshot.resources.escrows.some((item) => item.escrowId === escrowId));
    const shares = snapshot.resources.beneficiaryShares.filter((item) => snapshot.resources.milestones.some((milestone) => milestone.escrowId === escrowId && milestone.milestoneId === item.milestoneId));
    assert.equal(shares.length, 2);
    assert.equal(snapshot.resources.beneficiaryPayouts.length, 0);
  },
  performance: simplePerformance({
    ids: ["escrow-detail-read", "funded-escrow-create", "escrow-expiry-recovery"],
    seed: escrowSeed,
    readPath: async (ctx, api) => {
      const created = await ctx.mutate(api.baseUrl, "/api/v1/escrows", "perf-read-escrow", escrowPayload(99));
      return `/api/v1/escrows/${find(created.json, "escrowId")}`;
    },
    mutation: (ctx, api, ordinal) => ctx.mutate(api.baseUrl, "/api/v1/escrows", `perf-escrow-${ordinal}`, escrowPayload(ordinal)),
    thresholds: { readRate: 300, readP95: 140, mutationRate: 80, mutationP95: 500 },
    workerKind: "ESCROW_EXPIRY",
  }),
  manager: {
    path: "/api/v1/escrows",
    payload: (index) => escrowPayload(index, true),
    async verify(ctx, baseUrl, response) {
      const escrowId = find(response.json, "escrowId");
      const snapshot = await ctx.snapshot(baseUrl);
      const milestones = snapshot.resources.milestones.filter((item) => item.escrowId === escrowId);
      const shares = snapshot.resources.beneficiaryShares.filter((item) => milestones.some((milestone) => milestone.milestoneId === item.milestoneId));
      assert.equal(shares.length, 3);
      assert.equal(shares.filter((item) => item.milestoneId === milestones[0].milestoneId).reduce((sum, item) => sum + item.amountMinor, 0), 40);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const escrowId = find(response.json, "escrowId");
      const snapshot = await ctx.snapshot(baseUrls[1]);
      const milestones = snapshot.resources.milestones.filter((item) => item.escrowId === escrowId);
      const shares = snapshot.resources.beneficiaryShares.filter((item) => milestones.some((milestone) => milestone.milestoneId === item.milestoneId));
      assert.equal(new Set(shares.map((item) => item.beneficiaryShareId)).size, shares.length);
    },
  },
};

const permitIds = {
  applicant: uuid("a1000000", 1),
  reviewerA: uuid("a2000000", 1),
  reviewerB: uuid("a2000000", 2),
};

function reviewPolicy() {
  return {
    roles: [{ role: "SAFETY", eligibleReviewerIds: [permitIds.reviewerA, permitIds.reviewerB], requiredApprovals: 1, veto: true }],
    requiredTotalApprovals: 1,
  };
}

function permitSeed(seedVersion = "hidden-permit") {
  return base(seedVersion, {
    applicants: [{ applicantId: permitIds.applicant, name: "Applicant" }],
    reviewers: [
      { reviewerId: permitIds.reviewerA, name: "Reviewer A", roles: ["SAFETY"] },
      { reviewerId: permitIds.reviewerB, name: "Reviewer B", roles: ["SAFETY"] },
    ],
    permitApplications: [], applicationRevisions: [], reviewClaims: [], reviewDecisions: [], approvedPermits: [],
  });
}

function permitPayload(index, manager = false) {
  return {
    applicantId: permitIds.applicant,
    permitType: "EVENT",
    fields: { venue: `Hall ${index}`, attendees: 100 },
    deadlineAt: later(),
    ...(manager
      ? { stages: [{ name: "Safety", reviewPolicy: reviewPolicy() }, { name: "Final", reviewPolicy: reviewPolicy() }] }
      : { reviewPolicy: reviewPolicy() }),
  };
}

const permitforge = {
  label: "PermitForge revisioned permit review",
  performanceScenarioIds: ["application-current-read", "application-submit", "permit-deadline-recovery"],
  seed: async () => permitSeed(),
  path: "/api/v1/permit-applications",
  payload: (index) => ({ ...permitPayload(index), ...(index === 3 ? { deadlineAt: soon() } : {}) }),
  conflictPayload: (index) => ({ ...permitPayload(index), permitType: "CHANGED" }),
  resource: "permitApplications",
  identity: (json) => find(json, "applicationId"),
  async verify(ctx, baseUrl, response) {
    const applicationId = find(response.json, "applicationId");
    const claim = await ctx.mutate(baseUrl, `/api/v1/permit-applications/${applicationId}/review-claims`, "h03-claim", { reviewerId: permitIds.reviewerA, role: "SAFETY" });
    assert.equal(claim.status, 201);
    const decided = await ctx.mutate(baseUrl, `/api/v1/review-claims/${find(claim.json, "claimId")}/decisions`, "h03-decision", {
      claimToken: find(claim.json, "claimToken"), decision: "APPROVE", reason: "meets policy",
    });
    assert.equal(decided.status, 200);
    const snapshot = await ctx.snapshot(baseUrl);
    assert.equal(snapshot.resources.permitApplications.find((item) => item.applicationId === applicationId).state, "APPROVED");
    assert.equal(snapshot.resources.approvedPermits.filter((item) => item.applicationId === applicationId).length, 1);
  },
  async atomic(ctx, baseUrl, before) {
    const invalid = await ctx.mutate(baseUrl, "/api/v1/permit-applications", "h04-invalid-policy", {
      ...permitPayload(4), reviewPolicy: { roles: [], requiredTotalApprovals: 1 },
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json?.error?.code, "INVALID_REVIEW_POLICY");
    assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(before));
  },
  async contention(ctx, baseUrls) {
    const application = (await ctx.snapshot(baseUrls[0])).resources.permitApplications.at(-1);
    const claims = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
      baseUrls[index % 2], `/api/v1/permit-applications/${application.applicationId}/review-claims`, `h06-claim-${index}`,
      { reviewerId: permitIds.reviewerA, role: "SAFETY" },
    ));
    assert.equal(claims.filter(({ status }) => status === 201).length, 1);
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const applicationId = find(created.json, "applicationId");
    assert.equal(snapshot.resources.reviewStages.filter((item) => item.applicationId === applicationId).length, 1);
  },
  performance: simplePerformance({
    ids: ["application-current-read", "application-submit", "permit-deadline-recovery"],
    seed: permitSeed,
    readPath: async (ctx, api) => {
      const created = await ctx.mutate(api.baseUrl, "/api/v1/permit-applications", "perf-read-permit", permitPayload(99));
      return `/api/v1/permit-applications/${find(created.json, "applicationId")}`;
    },
    mutation: (ctx, api, ordinal) => ctx.mutate(api.baseUrl, "/api/v1/permit-applications", `perf-permit-${ordinal}`, permitPayload(ordinal)),
    thresholds: { readRate: 350, readP95: 120, mutationRate: 100, mutationP95: 350 },
    workerKind: "PERMIT_DEADLINE",
  }),
  manager: {
    path: "/api/v1/permit-applications",
    payload: (index) => permitPayload(index, true),
    async verify(ctx, baseUrl, response) {
      const applicationId = find(response.json, "applicationId");
      const stages = (await ctx.snapshot(baseUrl)).resources.reviewStages.filter((item) => item.applicationId === applicationId);
      assert.deepEqual(stages.map(({ ordinal, state }) => ({ ordinal, state })), [{ ordinal: 1, state: "ACTIVE" }, { ordinal: 2, state: "PENDING" }]);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const applicationId = find(response.json, "applicationId");
      const stages = (await ctx.snapshot(baseUrls[1])).resources.reviewStages.filter((item) => item.applicationId === applicationId);
      assert.equal(new Set(stages.map((item) => item.stageId)).size, 2);
    },
  },
};

const capacityIds = {
  owner: uuid("c1000000", 1),
  poolA: uuid("c2000000", 1),
  poolB: uuid("c2000000", 2),
};

function capacitySeed(seedVersion = "hidden-capacity") {
  return base(seedVersion, {
    owners: [{ ownerId: capacityIds.owner, name: "Owner" }],
    capacityPools: [
      { poolId: capacityIds.poolA, name: "Pool A", capacityUnits: 1000000, revision: 1 },
      { poolId: capacityIds.poolB, name: "Pool B", capacityUnits: 1000000, revision: 1 },
    ],
    capacityLeases: [], admissionEntries: [], capacitySlices: [],
  });
}

function capacityPayload(index, manager = false) {
  const startAt = new Date(Date.now() + 3_600_000 + index * 60_000).toISOString();
  const endAt = new Date(Date.parse(startAt) + 30_000).toISOString();
  return {
    ownerId: capacityIds.owner, startAt, endAt, priority: 0, allowWait: false, ...(index === 3 ? { holdSeconds: 1 } : {}),
    ...(manager ? { members: [{ poolId: capacityIds.poolA, units: 2 }, { poolId: capacityIds.poolB, units: 3 }] } : { poolId: capacityIds.poolA, units: 2 }),
  };
}

const capacitylease = {
  label: "CapacityLease interval hold",
  performanceScenarioIds: ["pool-timeline-read", "independent-hold-create", "expiry-promotion-recovery"],
  seed: async () => capacitySeed(),
  path: "/api/v1/capacity-leases",
  payload: (index) => capacityPayload(index),
  conflictPayload: (index) => ({ ...capacityPayload(index), units: 3 }),
  resource: "capacityLeases",
  identity: (json) => find(json, "leaseId"),
  async verify(ctx, baseUrl, response) {
    const leaseId = find(response.json, "leaseId");
    const confirmed = await ctx.mutate(baseUrl, `/api/v1/capacity-leases/${leaseId}/confirm`, "h03-confirm", {
      holdToken: find(response.json, "holdToken"), expectedRevision: 1,
    });
    assert.equal(confirmed.status, 200);
    const snapshot = await ctx.snapshot(baseUrl);
    for (const slice of snapshot.resources.capacitySlices) {
      assert.equal(slice.availableUnits, slice.capacityUnits - slice.heldUnits - slice.confirmedUnits - slice.activeUnits);
      assert.ok(slice.availableUnits >= 0);
    }
  },
  async atomic(ctx, baseUrl, before) {
    const invalid = await ctx.mutate(baseUrl, "/api/v1/capacity-leases", "h04-invalid-interval", {
      ...capacityPayload(4), endAt: capacityPayload(4).startAt,
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json?.error?.code, "INVALID_LEASE_INTERVAL");
    assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(before));
  },
  async contention(ctx, baseUrls) {
    const snapshot = await ctx.snapshot(baseUrls[0]);
    for (const slice of snapshot.resources.capacitySlices) assert.ok(slice.availableUnits >= 0);
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const leaseId = find(created.json, "leaseId");
    assert.equal(snapshot.resources.gangLeaseMembers.filter((item) => item.leaseId === leaseId).length, 1);
  },
  performance: simplePerformance({
    ids: ["pool-timeline-read", "independent-hold-create", "expiry-promotion-recovery"],
    seed: capacitySeed,
    readPath: async () => `/api/v1/capacity-pools/${capacityIds.poolA}/timeline?from=${encodeURIComponent(now())}&to=${encodeURIComponent(later())}`,
    mutation: (ctx, api, ordinal) => ctx.mutate(api.baseUrl, "/api/v1/capacity-leases", `perf-capacity-${ordinal}`, capacityPayload(ordinal)),
    thresholds: { readRate: 400, readP95: 120, mutationRate: 120, mutationP95: 350 },
    workerKind: "LEASE_EXPIRY",
  }),
  manager: {
    path: "/api/v1/capacity-leases",
    payload: (index) => capacityPayload(index, true),
    async verify(ctx, baseUrl, response) {
      const leaseId = find(response.json, "leaseId");
      const members = (await ctx.snapshot(baseUrl)).resources.gangLeaseMembers.filter((item) => item.leaseId === leaseId);
      assert.deepEqual(members.map(({ poolId, units }) => ({ poolId, units })), [
        { poolId: capacityIds.poolA, units: 2 }, { poolId: capacityIds.poolB, units: 3 },
      ]);
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const leaseId = find(response.json, "leaseId");
      const members = (await ctx.snapshot(baseUrls[1])).resources.gangLeaseMembers.filter((item) => item.leaseId === leaseId);
      assert.equal(new Set(members.map((item) => item.poolId)).size, 2);
    },
  },
};

function simplePerformance({ ids, seed, readPath, mutation, thresholds, workerKind }) {
  return async (ctx, assertions) => {
    const scale = performanceScale();
    const prepare = async () => {
      await ctx.prepare();
      const imported = await ctx.seed(seed("perf-v1"));
      assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
      return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
    };
    let { apiA, apiB } = await prepare();
    const path = await readPath(ctx, apiA);
    const reads = await measuredLoad(ctx, {
      concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
      request: ({ client }) => ctx.request(client % 2 ? apiA.baseUrl : apiB.baseUrl, path),
    });
    assert.ok(reads.throughput >= thresholds.readRate && reads.p95 <= thresholds.readP95, `${ids[0]} threshold failed`);
    assertions.push(`${ids[0]}: ${reads.throughput.toFixed(1)}/s p95 ${reads.p95.toFixed(1)}ms`);

    await ctx.resetDatabase();
    ({ apiA, apiB } = await prepare());
    let ordinal = 0;
    const mutations = await measuredLoad(ctx, {
      concurrency: 64, warmupMs: 10_000 * scale, measureMs: 60_000 * scale,
      request: ({ client }) => mutation(ctx, client % 2 ? apiA : apiB, ordinal++),
    });
    assert.ok(mutations.throughput >= thresholds.mutationRate && mutations.p95 <= thresholds.mutationP95, `${ids[1]} threshold failed`);
    assertions.push(`${ids[1]}: ${mutations.throughput.toFixed(1)}/s p95 ${mutations.p95.toFixed(1)}ms`);

    const recoveryStartedAt = Date.now();
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(apiA.baseUrl);
      return snapshot.work.filter(({ kind, terminal }) => kind === workerKind && !terminal).length === 0 ? snapshot : undefined;
    }, { timeoutMs: 120_000, label: `${workerKind} drain`, children: workers });
    const recoveryMs = Date.now() - recoveryStartedAt;
    assertions.push(`${ids[2]}: current ${workerKind} backlog drained in ${recoveryMs}ms`);
    return {
      metrics: [
        { scenarioId: ids[0], ...reads },
        { scenarioId: ids[1], ...mutations },
        { scenarioId: ids[2], completed: true, durationMs: recoveryMs, workers: 2 },
      ],
    };
  };
}

export const MID_TRANSFER_TASKS = Object.fromEntries(Object.entries({ escrowguard, permitforge, capacitylease })
  .map(([taskId, spec]) => [taskId, standardAdapter(spec)]));
