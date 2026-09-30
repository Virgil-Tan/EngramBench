import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const foreignTenantId = id(2);
const requesterId = id(10);
const reviewerAId = id(11);
const reviewerBId = id(12);
const reviewerCId = id(13);
const foreignPrincipalId = id(20);
const deviceId = id(100);
const foreignDeviceId = id(101);
const sessionId = id(200);
const foreignSessionId = id(201);
const policyBundleId = id(300);
const policyRevisionId = id(301);
const riskModelRevisionId = id(400);
const region = "us-east";
const alternateRegion = "us-west";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value) {
  const { digest: _digest, ...body } = value;
  return sha256(canonical(body));
}

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = find(child, key);
    if (found !== undefined) return found;
  }
}

const success = ({ status }) => status >= 200 && status < 300;
const code = (response) => find(response.json, "code");
const resource = (snapshot, key) => {
  assert.ok(Array.isArray(snapshot.resources?.[key]), `snapshot missing ${key}`);
  return snapshot.resources[key];
};

function stableSnapshot(snapshot) {
  const { asOf: _asOf, metrics = {}, ...stable } = snapshot;
  const { databaseBytes: _databaseBytes, ...stableMetrics } = metrics;
  return { ...stable, metrics: stableMetrics };
}

function iso(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function rules(version = 1) {
  return [{
    ruleId: `allow-deploy-${version}`,
    effect: "ALLOW",
    actions: ["deploy"],
    resourcePattern: "production/*",
    minAssurance: 2,
    regions: [region, alternateRegion],
  }];
}

function baseSeed(seedVersion = "hidden-accesssentinel", options = {}) {
  const observedAt = iso(-5 * 60_000);
  const policyRevision = {
    policyRevisionId, policyBundleId, tenantId, revision: 1, effectiveFrom: iso(-86_400_000),
    rules: rules(), createdAt: iso(-86_400_000),
  };
  policyRevision.digest = digest(policyRevision);
  const riskModel = {
    riskModelRevisionId, tenantId, revision: 1, effectiveFrom: iso(-86_400_000),
    lowMax: 20, reviewMax: 70, maxLocationAgeSeconds: 60, maxTravelKph: 900,
    weights: { oldSession: 20, staleLocation: 35, regionMismatch: 45, impossibleTravel: 80 },
    createdAt: iso(-86_400_000),
  };
  riskModel.digest = digest(riskModel);
  const observationId = id(500);
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: iso(),
    tenants: [
      { tenantId, name: "Hidden Access Tenant", revocationEpoch: 0, createdAt: iso(-172_800_000) },
      { tenantId: foreignTenantId, name: "Foreign Tenant", revocationEpoch: 0, createdAt: iso(-172_800_000) },
    ],
    principals: [
      { principalId: requesterId, tenantId, displayName: "Requester", state: "ACTIVE", revocationEpoch: 0, createdAt: iso(-172_800_000) },
      { principalId: reviewerAId, tenantId, displayName: "Reviewer A", state: "ACTIVE", revocationEpoch: 0, createdAt: iso(-172_800_000) },
      { principalId: reviewerBId, tenantId, displayName: "Reviewer B", state: "ACTIVE", revocationEpoch: 0, createdAt: iso(-172_800_000) },
      { principalId: reviewerCId, tenantId, displayName: "Reviewer C", state: "ACTIVE", revocationEpoch: 0, createdAt: iso(-172_800_000) },
      { principalId: foreignPrincipalId, tenantId: foreignTenantId, displayName: "Foreign User", state: "ACTIVE", revocationEpoch: 0, createdAt: iso(-172_800_000) },
    ],
    devices: [
      { deviceId, tenantId, principalId: requesterId, publicKeyFingerprint: sha256("device-100"), state: "ACTIVE", currentTrustRevision: 1, revocationEpoch: 0, createdAt: iso(-172_800_000) },
      { deviceId: foreignDeviceId, tenantId: foreignTenantId, principalId: foreignPrincipalId, publicKeyFingerprint: sha256("device-101"), state: "ACTIVE", currentTrustRevision: 1, revocationEpoch: 0, createdAt: iso(-172_800_000) },
    ],
    deviceTrustRevisions: [
      { deviceTrustRevisionId: id(110), deviceId, tenantId, revision: 1, state: "TRUSTED", assurance: 2, validFrom: iso(-86_400_000), validUntil: iso(3_600_000), evidenceDigest: sha256("trust-100"), createdAt: iso(-86_400_000) },
      { deviceTrustRevisionId: id(111), deviceId: foreignDeviceId, tenantId: foreignTenantId, revision: 1, state: "TRUSTED", assurance: 2, validFrom: iso(-86_400_000), validUntil: iso(3_600_000), evidenceDigest: sha256("trust-101"), createdAt: iso(-86_400_000) },
    ],
    sessions: [
      { sessionId, tenantId, principalId: requesterId, deviceId, deviceTrustRevisionId: id(110), familyId: id(210), generation: 1, refreshTokenDigest: sha256("seed-token-never-exposed"), state: "ACTIVE", expiresAt: iso(3_600_000), revocationEpoch: 0, createdAt: iso(-300_000), updatedAt: iso(-300_000) },
      { sessionId: foreignSessionId, tenantId: foreignTenantId, principalId: foreignPrincipalId, deviceId: foreignDeviceId, deviceTrustRevisionId: id(111), familyId: id(211), generation: 1, refreshTokenDigest: sha256("foreign-seed-token"), state: "ACTIVE", expiresAt: iso(3_600_000), revocationEpoch: 0, createdAt: iso(-300_000), updatedAt: iso(-300_000) },
    ],
    policyBundles: [
      { policyBundleId, tenantId, name: "Production Access", currentRevision: 1, currentPolicyRevisionId: policyRevisionId, createdAt: iso(-86_400_000) },
    ],
    policyRevisions: [policyRevision],
    riskModelRevisions: [riskModel],
    locationObservations: [{ observationId, tenantId, deviceId, deviceSequence: 1, observedAt, longitude: -73.9, latitude: 40.7, region, acceptedAt: observedAt }],
    deviceLocations: [{ deviceId, tenantId, lastSequence: 1, watermarkObservedAt: observedAt, longitude: -73.9, latitude: 40.7, region, riskFlags: [], revision: 1, updatedAt: observedAt }],
    accessRequests: options.accessRequests ?? [],
    riskDecisions: options.riskDecisions ?? [],
    accessReviews: options.accessReviews ?? [],
    accessGrants: options.accessGrants ?? [],
    revocations: options.revocations ?? [],
    auditEntries: options.auditEntries ?? [],
  };
}

function requestPayload(index = 0, overrides = {}) {
  return {
    tenantId, principalId: requesterId, deviceId, sessionId,
    action: "deploy", resource: `production/service-${index}`, region,
    requestedTtlSeconds: 300, justification: `hidden access request ${index}`,
    ...overrides,
  };
}

async function prepared(ctx, seedValue = baseSeed()) {
  await ctx.prepare();
  const imported = await ctx.seed(seedValue);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const api = await ctx.startApi();
  return api;
}

async function createRequest(ctx, baseUrl, index = 0, overrides = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/access-requests", `request-${index}`, requestPayload(index, overrides));
  assert.ok(success(response), response.text);
  assert.equal(typeof find(response.json, "accessRequestId"), "string");
  return response;
}

async function waitRisk(ctx, baseUrl, accessRequestId, workers) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return resource(snapshot, "riskDecisions").find((entry) => entry.accessRequestId === accessRequestId) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: `risk decision ${accessRequestId}`, children: workers });
}

async function approveAndGrant(ctx, baseUrl, accessRequestId, reviewerId = reviewerAId, key = "grant") {
  let snapshot = await ctx.snapshot(baseUrl);
  let request = resource(snapshot, "accessRequests").find((entry) => entry.accessRequestId === accessRequestId);
  if (request.state === "PENDING_REVIEW") {
    const review = await ctx.mutate(baseUrl, `/api/v1/access-requests/${accessRequestId}/reviews`, `${key}-review`, {
      reviewerId, decision: "APPROVE", comment: "independent hidden approval",
    });
    assert.ok(success(review), review.text);
  }
  snapshot = await ctx.snapshot(baseUrl);
  request = resource(snapshot, "accessRequests").find((entry) => entry.accessRequestId === accessRequestId);
  assert.ok(["APPROVED", "PENDING_REVIEW"].includes(request.state) || resource(snapshot, "riskDecisions").find((entry) => entry.accessRequestId === accessRequestId)?.level === "LOW");
  const grant = await ctx.mutate(baseUrl, `/api/v1/access-requests/${accessRequestId}/grant`, `${key}-issue`, { expectedState: request.state });
  assert.ok(success(grant), grant.text);
  return grant;
}

function assertSecretFree(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, /"(?:refreshToken|deviceNonce|privateKey|credential|authorization|adminToken)"\s*:/iu);
}

function assertValuesAbsentFromProcessLogs(ctx, values) {
  const logs = ctx.processes.map(({ logs }) => logs).join("\n");
  for (const value of values.filter(Boolean)) assert.ok(!logs.includes(value), "a raw secret appeared in process logs");
}

function assertAuditChain(snapshot) {
  const groups = new Map();
  for (const entry of resource(snapshot, "auditEntries")) {
    const values = groups.get(entry.tenantId) ?? [];
    values.push(entry);
    groups.set(entry.tenantId, values);
  }
  for (const entries of groups.values()) {
    entries.sort((a, b) => a.sequence - b.sequence);
    entries.forEach((entry, index) => {
      assert.equal(entry.sequence, index + 1);
      assert.equal(entry.previousDigest ?? "", index === 0 ? "" : entries[index - 1].digest);
      const { digest: actual, ...body } = entry;
      assert.equal(actual, sha256(`${entry.previousDigest ?? ""}${canonical(body)}`));
    });
  }
  assertSecretFree(snapshot);
}

function assertUnique(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

function assertEventOrder(snapshot) {
  assertUnique(snapshot.events.map(({ eventId }) => eventId), "event IDs");
  const groups = new Map();
  for (const event of snapshot.events) {
    const entries = groups.get(event.aggregateId) ?? [];
    entries.push(event);
    groups.set(event.aggregateId, entries);
  }
  for (const entries of groups.values()) {
    entries.sort((left, right) => left.sequence - right.sequence || left.eventId.localeCompare(right.eventId));
    const firstSequence = entries[0]?.sequence;
    assert.ok(Number.isInteger(firstSequence) && firstSequence > 0);
    entries.forEach((entry, index) => assert.equal(entry.sequence, firstSequence + index));
  }
}

async function publishPolicy(ctx, baseUrl, expectedRevision, version, key = `policy-${version}`) {
  const response = await ctx.mutate(baseUrl, `/api/v1/policy-bundles/${policyBundleId}/publish`, key, {
    expectedRevision, effectiveFrom: iso(version * 1_000), rules: rules(version),
  });
  assert.ok(success(response), response.text);
  return response;
}

async function createReviewGrant(ctx, baseUrl, index, workers, overrides = {}) {
  const response = await createRequest(ctx, baseUrl, index, overrides);
  const accessRequestId = find(response.json, "accessRequestId");
  await waitRisk(ctx, baseUrl, accessRequestId, workers);
  const grant = await approveAndGrant(ctx, baseUrl, accessRequestId, reviewerAId, `flow-${index}`);
  return { accessRequestId, grantId: find(grant.json, "grantId") };
}

function checkBreakGlass(ctx, baseUrl, breakGlassSessionId, payload) {
  return ctx.request(baseUrl, `/api/v1/break-glass-sessions/${breakGlassSessionId}/check`, {
    method: "POST",
    json: payload,
  });
}

let migrationRecord;

const spec = {
  label: "AccessSentinel privileged access request",
  performanceScenarioIds: [
    "session-refresh-storm", "access-decision-ingest", "policy-evaluation-hotset",
    "location-replay-convergence", "grant-revocation-fanout", "audit-chain-append",
    "outbox-ack-recovery", "revocation-fence-recovery",
  ],
  seed: async () => baseSeed(),
  path: "/api/v1/access-requests",
  payload: (index) => requestPayload(index),
  conflictPayload: (index) => requestPayload(index, { resource: `production/conflict-${index}` }),
  resource: "accessRequests",
  identity: (json) => find(json, "accessRequestId"),
  resourceIdentity: ({ accessRequestId }) => accessRequestId,
  workIdentity: (json) => find(json, "accessRequestId"),
  async afterPrepare(ctx, api, _receiver, workspace) {
    if (workspace === ctx.workspace) return;
    const created = await createRequest(ctx, api.baseUrl, 900);
    const accessRequestId = find(created.json, "accessRequestId");
    const worker = await ctx.startWorker({}, workspace);
    await waitRisk(ctx, api.baseUrl, accessRequestId, [worker]);
    await ctx.stop(worker);

    const pending = await createRequest(ctx, api.baseUrl, 901);
    const pendingId = find(pending.json, "accessRequestId");
    let releaseClaim;
    const heldClaim = new Promise((resolve) => { releaseClaim = resolve; });
    const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === pendingId ? heldClaim : { status: 204 });
    const claimant = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h09-migration" }, workspace);
    await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === pendingId), { label: "V1 pending lease", children: [claimant] });
    await ctx.stop(claimant, "SIGKILL");
    releaseClaim({ status: 204 });

    const snapshot = await ctx.snapshot(api.baseUrl);
    const pendingWork = snapshot.work.find((entry) => entry.aggregateId === pendingId && entry.state === "LEASED");
    assert.ok(pendingWork, "V1 fixture has no claimed lease to preserve");
    migrationRecord = {
      accessRequestId,
      riskDecisionId: resource(snapshot, "riskDecisions").find((entry) => entry.accessRequestId === accessRequestId).riskDecisionId,
      pendingWorkId: pendingWork.workId,
      events: structuredClone(snapshot.events),
      work: structuredClone(snapshot.work),
      auditEntries: structuredClone(resource(snapshot, "auditEntries")),
    };
  },
  async verify(ctx, baseUrl, response) {
    const accessRequestId = find(response.json, "accessRequestId");
    const worker = await ctx.startWorker();
    let snapshot = await waitRisk(ctx, baseUrl, accessRequestId, [worker]);
    const decision = resource(snapshot, "riskDecisions").find((entry) => entry.accessRequestId === accessRequestId);
    assert.equal(decision.level, "REVIEW");
    assert.deepEqual(decision.reasons, [...decision.reasons].sort());
    const grant = await approveAndGrant(ctx, baseUrl, accessRequestId, reviewerAId, "h03");
    const grantId = find(grant.json, "grantId");
    const checked = await ctx.request(baseUrl, `/api/v1/grants/${grantId}/check`);
    assert.equal(checked.status, 200, checked.text);
    assert.equal(checked.json?.active, true);
    const revoked = await ctx.mutate(baseUrl, `/api/v1/grants/${grantId}/revoke`, "h03-revoke", { reason: "hidden lifecycle complete" });
    assert.ok(success(revoked), revoked.text);
    snapshot = await ctx.snapshot(baseUrl);
    assert.equal(resource(snapshot, "accessGrants").find((entry) => entry.grantId === grantId)?.state, "REVOKED");
    assert.ok(resource(snapshot, "revocations").some((entry) => entry.subjectId === grantId));
    assertAuditChain(snapshot);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const invalidBatch = await ctx.mutate(baseUrl, "/api/v1/access-requests:batch", "h04-invalid-batch", {
      requests: [requestPayload(40), requestPayload(41, { requestedTtlSeconds: 901 })],
    });
    assert.equal(invalidBatch.status, 400, invalidBatch.text);
    assert.deepEqual(stableSnapshot(await ctx.snapshot(baseUrl)), stableSnapshot(before));
    const pendingId = resource(before, "accessRequests").at(-1).accessRequestId;
    const premature = await ctx.mutate(baseUrl, `/api/v1/access-requests/${pendingId}/grant`, "h04-premature", { expectedState: "PENDING_RISK" });
    assert.equal(premature.status, 409, premature.text);
    assert.deepEqual(stableSnapshot(await ctx.snapshot(baseUrl)), stableSnapshot(before));
  },
  async contention(ctx, baseUrls) {
    const attempts = await Promise.all([
      publishPolicy(ctx, baseUrls[0], 1, 2, "h06-policy-a"),
      ctx.mutate(baseUrls[1], `/api/v1/policy-bundles/${policyBundleId}/publish`, "h06-policy-b", {
        expectedRevision: 1, effectiveFrom: iso(2_000), rules: rules(3),
      }),
    ]);
    assert.equal(attempts.filter(success).length, 1);
    assert.equal(attempts.filter(({ status }) => status === 409).length, 1);
    const snapshot = await ctx.snapshot(baseUrls[0]);
    assert.deepEqual(resource(snapshot, "policyRevisions").filter(({ policyBundleId: value }) => value === policyBundleId).map(({ revision }) => revision), [1, 2]);
  },
  async prepareWork(ctx, baseUrl) {
    return createRequest(ctx, baseUrl, 70);
  },
  async migrationVerify(ctx, { created, snapshot }) {
    const accessRequestId = find(created.json, "accessRequestId");
    assert.ok(resource(snapshot, "accessRequests").some((entry) => entry.accessRequestId === accessRequestId));
    assert.ok(resource(snapshot, "accessRequests").some((entry) => entry.accessRequestId === migrationRecord.accessRequestId));
    assert.ok(resource(snapshot, "riskDecisions").some((entry) => entry.riskDecisionId === migrationRecord.riskDecisionId));
    for (const expected of migrationRecord.events) assert.deepEqual(snapshot.events.find(({ eventId }) => eventId === expected.eventId), expected);
    for (const expected of migrationRecord.work) assert.deepEqual(snapshot.work.find(({ workId }) => workId === expected.workId), expected);
    for (const expected of migrationRecord.auditEntries) assert.deepEqual(resource(snapshot, "auditEntries").find(({ auditEntryId }) => auditEntryId === expected.auditEntryId), expected);
    assert.equal(snapshot.work.find(({ workId }) => workId === migrationRecord.pendingWorkId)?.state, "LEASED");
    for (const key of ["breakGlassSessions","breakGlassApprovals","regionalQuarantines","retrospectiveReviews"]) assert.equal(resource(snapshot, key).length, 0);
    assertAuditChain(snapshot);
  },
  manager: {
    path: "/api/v1/break-glass-sessions",
    async prepare(ctx, baseUrl) {
      const quarantined = await ctx.mutate(baseUrl, `/api/v1/regions/${region}/quarantine`, "manager-quarantine", {
        tenantId, expectedRevision: 0, reason: "hidden regional incident", createdBy: reviewerAId,
      });
      assert.ok(success(quarantined), quarantined.text);
      return { quarantineRevision: find(quarantined.json, "revision") ?? 1 };
    },
    payload: (index) => ({
      tenantId, requesterId, sessionId, region, actions: ["deploy"], resourcePatterns: [`production/emergency-${index}/*`],
      reason: `hidden emergency ${index}`, requestedTtlSeconds: 300,
    }),
    async verify(ctx, baseUrl, response, operation) {
      const breakGlassSessionId = find(response.json, "breakGlassSessionId");
      for (const [index, approverId] of [reviewerAId, reviewerBId].entries()) {
        const approval = await ctx.mutate(baseUrl, `/api/v1/break-glass-sessions/${breakGlassSessionId}/approvals`, `h10-approval-${index}`, {
          approverId, decision: "APPROVE", comment: "independent emergency approval",
        });
        assert.ok(success(approval), approval.text);
      }
      const activated = await ctx.mutate(baseUrl, `/api/v1/break-glass-sessions/${breakGlassSessionId}/activate`, "h10-activate", { expectedState: "READY" });
      assert.ok(success(activated), activated.text);
      const authorized = await checkBreakGlass(ctx, baseUrl, breakGlassSessionId, {
        action: "deploy", resource: "production/emergency-0/api", region,
      });
      assert.equal(authorized.status, 200, authorized.text);
      assert.equal(authorized.json?.authorized, true);
      assert.equal(authorized.json?.policyRevisionId, policyRevisionId);
      assert.equal(authorized.json?.riskModelRevisionId, riskModelRevisionId);
      const outsideScope = await checkBreakGlass(ctx, baseUrl, breakGlassSessionId, {
        action: "delete", resource: "production/emergency-0/api", region,
      });
      assert.equal(outsideScope.status, 200, outsideScope.text);
      assert.equal(outsideScope.json?.authorized, false);
      const closed = await ctx.mutate(baseUrl, `/api/v1/break-glass-sessions/${breakGlassSessionId}/close`, "h10-close", { reason: "incident stabilized" });
      assert.ok(success(closed), closed.text);
      const afterClose = await checkBreakGlass(ctx, baseUrl, breakGlassSessionId, {
        action: "deploy", resource: "production/emergency-0/api", region,
      });
      assert.equal(afterClose.json?.authorized, false);
      const retrospective = await ctx.mutate(baseUrl, `/api/v1/break-glass-sessions/${breakGlassSessionId}/retrospective-reviews`, "h10-retrospective", {
        reviewerId: reviewerCId, outcome: "JUSTIFIED", findings: "Emergency scope was appropriate",
      });
      assert.ok(success(retrospective), retrospective.text);
      const released = await ctx.mutate(baseUrl, `/api/v1/regions/${region}/release`, "h10-release", {
        tenantId, expectedRevision: operation.quarantineRevision, releasedBy: reviewerBId,
      });
      assert.ok(success(released), released.text);
      const snapshot = await ctx.snapshot(baseUrl);
      assert.equal(resource(snapshot, "breakGlassApprovals").filter((entry) => entry.breakGlassSessionId === breakGlassSessionId).length, 2);
      assert.equal(resource(snapshot, "retrospectiveReviews").filter((entry) => entry.breakGlassSessionId === breakGlassSessionId).length, 1);
      assert.equal(resource(snapshot, "regionalQuarantines").find(({ region: value }) => value === region)?.state, "RELEASED");
      assertAuditChain(snapshot);
    },
    async concurrentVerify(ctx, baseUrls, response, operation) {
      const breakGlassSessionId = find(response.json, "breakGlassSessionId");
      const first = await ctx.mutate(baseUrls[0], `/api/v1/break-glass-sessions/${breakGlassSessionId}/approvals`, "h11-first", {
        approverId: reviewerAId, decision: "APPROVE", comment: "first",
      });
      assert.ok(success(first), first.text);
      const final = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(
        baseUrls[index % 2], `/api/v1/break-glass-sessions/${breakGlassSessionId}/approvals`, `h11-final-${index}`,
        { approverId: reviewerBId, decision: "APPROVE", comment: "second" },
      )));
      assert.equal(final.filter(success).length, 1);
      assert.ok(final.filter(({ status }) => status === 409).length >= 19);
      const activated = await Promise.all(baseUrls.map((url, index) => ctx.mutate(
        url, `/api/v1/break-glass-sessions/${breakGlassSessionId}/activate`, `h11-activate-${index}`, { expectedState: "READY" },
      )));
      assert.equal(activated.filter(success).length, 1);
      const quarantine = await Promise.all(baseUrls.map((url, index) => ctx.mutate(
        url, `/api/v1/regions/${region}/quarantine`, `h11-quarantine-${index}`,
        { tenantId, expectedRevision: operation.quarantineRevision, reason: "escalated", createdBy: reviewerAId },
      )));
      assert.equal(quarantine.filter(success).length, 1);
      assert.equal(quarantine.filter(({ status }) => status === 409).length, 1);
      const staleRegionFence = await checkBreakGlass(ctx, baseUrls[0], breakGlassSessionId, {
        action: "deploy", resource: "production/emergency-1/api", region,
      });
      assert.equal(staleRegionFence.status, 200, staleRegionFence.text);
      assert.equal(staleRegionFence.json?.authorized, false);
      const snapshot = await ctx.snapshot(baseUrls[0]);
      assert.equal(resource(snapshot, "breakGlassApprovals").filter((entry) => entry.breakGlassSessionId === breakGlassSessionId).length, 2);
      assert.equal(resource(snapshot, "breakGlassSessions").find((entry) => entry.breakGlassSessionId === breakGlassSessionId).state, "ACTIVE");
    },
  },
  cases: {
    "H-14": identityTrustCase,
    "H-15": policyFreezeCase,
    "H-16": reviewSeparationCase,
    "H-17": grantFenceCase,
    "H-18": auditIntegrityCase,
    "H-19": tenantIsolationCase,
    "H-20": batchAtomicityCase,
    "H-21": cacheConvergenceCase,
    "H-22": refreshUncertaintyCase,
    "H-23": locationReplayCase,
    "H-24": dualRecoveryCase,
    "H-25": retrospectiveCase,
    "H-26": catastropheCase,
  },
  performance: accessSentinelPerformance,
};

async function identityTrustCase(ctx, out) {
  const api = await prepared(ctx);
  const created = await ctx.mutate(api.baseUrl, "/api/v1/sessions", "h14-session", {
    tenantId, principalId: requesterId, deviceId, deviceTrustRevisionId: id(110), requestedTtlSeconds: 600,
  });
  assert.ok(success(created), created.text);
  const createdSessionId = find(created.json, "sessionId");
  const token = created.json?.refreshToken;
  assert.equal(typeof token, "string");
  const refreshed = await ctx.mutate(api.baseUrl, `/api/v1/sessions/${createdSessionId}/refresh`, "h14-refresh", { refreshToken: token, requestedTtlSeconds: 600 });
  assert.ok(success(refreshed), refreshed.text);
  const reused = await ctx.mutate(api.baseUrl, `/api/v1/sessions/${createdSessionId}/refresh`, "h14-reuse", { refreshToken: token, requestedTtlSeconds: 600 });
  assert.equal(reused.status, 409, reused.text);
  assert.equal(code(reused), "REFRESH_TOKEN_REUSED");
  const revoked = await ctx.mutate(api.baseUrl, `/api/v1/devices/${deviceId}/revoke`, "h14-device-revoke", { expectedEpoch: 0, reason: "device lost" });
  assert.ok(success(revoked), revoked.text);
  const staleTrust = await ctx.mutate(api.baseUrl, `/api/v1/devices/${deviceId}/trust-revisions`, "h14-stale-trust", {
    expectedRevision: 1, assurance: 3, validFrom: iso(), validUntil: iso(3_600_000), evidenceDigest: sha256("stale"),
  });
  assert.equal(staleTrust.status, 409, staleTrust.text);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.ok(resource(snapshot, "sessions").filter(({ familyId }) => familyId === find(created.json, "familyId")).every(({ state }) => state === "REVOKED"));
  assert.equal(resource(snapshot, "devices").find((entry) => entry.deviceId === deviceId)?.state, "REVOKED");
  assertSecretFree(snapshot);
  assertValuesAbsentFromProcessLogs(ctx, [token, refreshed.json?.refreshToken]);
  out.push("session rotation reuse revokes its family and device revoke cannot be undone by stale trust publication");
}

async function policyFreezeCase(ctx, out) {
  const api = await prepared(ctx);
  const accepted = await createRequest(ctx, api.baseUrl, 150);
  const accessRequestId = find(accepted.json, "accessRequestId");
  const before = await ctx.snapshot(api.baseUrl);
  const frozen = resource(before, "accessRequests").find((entry) => entry.accessRequestId === accessRequestId).policyRevisionId;
  const original = resource(before, "policyRevisions").find((entry) => entry.policyRevisionId === frozen);
  await publishPolicy(ctx, api.baseUrl, 1, 2, "h15-publish");
  const rollback = await ctx.mutate(api.baseUrl, `/api/v1/policy-bundles/${policyBundleId}/rollback`, "h15-rollback", {
    expectedRevision: 2, targetRevision: 1, effectiveFrom: iso(5_000),
  });
  assert.ok(success(rollback), rollback.text);
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(after, "accessRequests").find((entry) => entry.accessRequestId === accessRequestId).policyRevisionId, frozen);
  assert.deepEqual(resource(after, "policyRevisions").find((entry) => entry.policyRevisionId === frozen), original);
  assert.deepEqual(resource(after, "policyRevisions").filter(({ policyBundleId: value }) => value === policyBundleId).map(({ revision }) => revision), [1, 2, 3]);
  out.push("policy publish and rollback preserve immutable request-pinned history");
}

async function reviewSeparationCase(ctx, out) {
  const api = await prepared(ctx);
  const worker = await ctx.startWorker();
  const created = await createRequest(ctx, api.baseUrl, 160);
  const accessRequestId = find(created.json, "accessRequestId");
  await waitRisk(ctx, api.baseUrl, accessRequestId, [worker]);
  const before = await ctx.snapshot(api.baseUrl);
  const self = await ctx.mutate(api.baseUrl, `/api/v1/access-requests/${accessRequestId}/reviews`, "h16-self", {
    reviewerId: requesterId, decision: "APPROVE", comment: "self",
  });
  assert.equal(self.status, 403, self.text);
  const foreign = await ctx.mutate(api.baseUrl, `/api/v1/access-requests/${accessRequestId}/reviews`, "h16-foreign", {
    reviewerId: foreignPrincipalId, decision: "APPROVE", comment: "foreign",
  });
  assert.equal(foreign.status, 403, foreign.text);
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before));
  const race = await Promise.all([
    ctx.mutate(api.baseUrl, `/api/v1/access-requests/${accessRequestId}/reviews`, "h16-approve", { reviewerId: reviewerAId, decision: "APPROVE", comment: "approve" }),
    ctx.mutate(api.baseUrl, `/api/v1/access-requests/${accessRequestId}/reviews`, "h16-reject", { reviewerId: reviewerAId, decision: "REJECT", comment: "reject" }),
  ]);
  assert.equal(race.filter(success).length, 1);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(snapshot, "accessReviews").filter((entry) => entry.accessRequestId === accessRequestId).length, 1);
  out.push("review separation of duties and competing reviewer decisions produce one terminal fact");
}

async function grantFenceCase(ctx, out) {
  const apiA = await prepared(ctx);
  const apiB = await ctx.startApi();
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const expiring = await createReviewGrant(ctx, apiA.baseUrl, 170, workers, { requestedTtlSeconds: 5 });
  let snapshot = await ctx.snapshot(apiA.baseUrl);
  const expiringGrant = resource(snapshot, "accessGrants").find((entry) => entry.grantId === expiring.grantId);
  assert.equal(expiringGrant.action, "deploy");
  assert.equal(expiringGrant.resource, "production/service-170");
  assert.equal(expiringGrant.region, region);
  assert.equal(expiringGrant.policyRevisionId, policyRevisionId);
  assert.ok(Date.parse(expiringGrant.expiresAt) - Date.parse(expiringGrant.notBefore) <= 5_000);
  await ctx.waitFor(async () => {
    const checks = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => ctx.request(url, `/api/v1/grants/${expiring.grantId}/check`)));
    return checks.every((entry) => entry.status === 200 && entry.json?.active === false) ? checks : undefined;
  }, { timeoutMs: 10_000, label: "short-lived grant expiry", children: workers });

  const revocable = await createReviewGrant(ctx, apiA.baseUrl, 171, workers);
  const before = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => ctx.request(url, `/api/v1/grants/${revocable.grantId}/check`)));
  assert.ok(before.every((entry) => entry.status === 200 && entry.json?.active === true && entry.json?.policyRevisionId === policyRevisionId));
  const revoked = await ctx.mutate(apiA.baseUrl, `/api/v1/grants/${revocable.grantId}/revoke`, "h17-revoke", { reason: "immediate revoke" });
  assert.ok(success(revoked), revoked.text);
  const after = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => ctx.request(url, `/api/v1/grants/${revocable.grantId}/check`)));
  assert.ok(after.every((entry) => entry.status === 200 && entry.json?.active === false));
  snapshot = await ctx.snapshot(apiB.baseUrl);
  assert.equal(resource(snapshot, "accessGrants").find((entry) => entry.grantId === revocable.grantId).state, "REVOKED");
  assert.equal(resource(snapshot, "accessGrants").find((entry) => entry.grantId === expiring.grantId).state, "EXPIRED");
  out.push("exact grant scope and TTL expire correctly, and revoke checks fail closed across API processes immediately after commit");
}

async function auditIntegrityCase(ctx, out) {
  await ctx.prepare();
  const invalid = baseSeed("h18-invalid-audit", {
    auditEntries: [{ auditEntryId: id(1800), tenantId, sequence: 1, occurredAt: iso(), actorType: "SYSTEM", actorId: "seed", action: "seed.tampered", subjectType: "TENANT", subjectId: tenantId, data: {}, previousDigest: "", digest: "0".repeat(64) }],
  });
  const rejected = await ctx.seed(invalid);
  assert.notEqual(rejected.exitCode, 0, "seed accepted a tampered audit digest");
  const imported = await ctx.seed(baseSeed("h18-valid"));
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const api = await ctx.startApi();
  await createRequest(ctx, api.baseUrl, 180);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assertAuditChain(snapshot);
  out.push("strict seed rejects audit tampering and runtime audit remains contiguous, linked, and secret-free");
}

async function tenantIsolationCase(ctx, out) {
  const api = await prepared(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const attempts = [
    requestPayload(190, { sessionId: foreignSessionId }),
    requestPayload(191, { deviceId: foreignDeviceId }),
    requestPayload(192, { tenantId: foreignTenantId, principalId: requesterId }),
  ];
  const denied = [];
  for (const [index, payload] of attempts.entries()) {
    const response = await ctx.mutate(api.baseUrl, "/api/v1/access-requests", `h19-${index}`, payload);
    assert.equal(response.status, 403, response.text);
    denied.push(response.json);
  }
  const unknown = await ctx.mutate(api.baseUrl, "/api/v1/access-requests", "h19-unknown", requestPayload(193, { sessionId: id(999_999) }));
  assert.equal(unknown.status, 403, unknown.text);
  denied.push(unknown.json);
  assert.equal(new Set(denied.map((value) => ctx.canonical(value))).size, 1, "foreign and unknown identities expose different errors");
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before));
  const unauthorized = await ctx.request(api.baseUrl, "/api/v1/verification-snapshot");
  assert.ok([401, 403].includes(unauthorized.status));
  out.push("foreign identity combinations and unauthenticated snapshots reveal no resource and commit no effect");
}

async function batchAtomicityCase(ctx, out) {
  const api = await prepared(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const values = Array.from({ length: 100 }, (_, index) => requestPayload(20_000 + index));
  values[73] = requestPayload(20_073, { requestedTtlSeconds: 901 });
  const rejected = await ctx.mutate(api.baseUrl, "/api/v1/access-requests:batch", "h20-invalid", { requests: values });
  assert.equal(rejected.status, 400, rejected.text);
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(before));
  values[73] = requestPayload(20_073);
  const accepted = await ctx.mutate(api.baseUrl, "/api/v1/access-requests:batch", "h20-valid", { requests: values });
  assert.ok(success(accepted), accepted.text);
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(after, "accessRequests").length, resource(before, "accessRequests").length + 100);
  assertUnique(resource(after, "accessRequests").map(({ accessRequestId }) => accessRequestId), "batch request IDs");
  const replay = await ctx.mutate(api.baseUrl, "/api/v1/access-requests:batch", "h20-valid", { requests: values });
  assert.equal(replay.status, accepted.status);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(accepted.json));
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(after));
  const conflicting = structuredClone(values);
  conflicting[0].resource = "production/conflicting-batch-member";
  const conflict = await ctx.mutate(api.baseUrl, "/api/v1/access-requests:batch", "h20-valid", { requests: conflicting });
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(code(conflict), "IDEMPOTENCY_CONFLICT");
  assert.deepEqual(stableSnapshot(await ctx.snapshot(api.baseUrl)), stableSnapshot(after));
  out.push("100-item batch rolls back atomically, then replays exactly and rejects a changed member without a second effect");
}

async function cacheConvergenceCase(ctx, out) {
  await ctx.prepare();
  const seed = grantedSeed("h21-fences", 5, 5);
  seed.accessRequests[3].region = alternateRegion;
  seed.accessGrants[3].region = alternateRegion;
  const imported = await ctx.seed(seed);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const apiA = await ctx.startApi();
  const apiB = await ctx.startApi();
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const webhook = await ctx.receiver();
  const dispatchers = await Promise.all(Array.from({ length: 2 }, () => ctx.startDispatcher(webhook.url)));
  const grantIds = Array.from({ length: 5 }, (_, index) => id(8_000_000 + index));
  const initiallyActive = await Promise.all(grantIds.flatMap((grantId, index) => [
    ctx.request(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/grants/${grantId}/check`),
  ]));
  assert.ok(initiallyActive.every((entry) => entry.status === 200 && entry.json?.active === true));

  await publishPolicy(ctx, apiA.baseUrl, 1, 2, "h21-publish");
  const rollback = await ctx.mutate(apiB.baseUrl, `/api/v1/policy-bundles/${policyBundleId}/rollback`, "h21-rollback", { expectedRevision: 2, targetRevision: 1, effectiveFrom: iso(4_000) });
  assert.ok(success(rollback), rollback.text);
  const afterPolicy = await Promise.all(grantIds.map((grantId, index) => ctx.request(index % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/grants/${grantId}/check`)));
  assert.ok(afterPolicy.every((entry) => entry.json?.active === true), "policy history changed an already frozen grant");

  const fences = [
    () => ctx.mutate(apiA.baseUrl, `/api/v1/sessions/${id(4_000_000)}/revoke`, "h21-session", { expectedGeneration: 1, reason: "session fence" }),
    () => ctx.mutate(apiB.baseUrl, `/api/v1/devices/${id(2_000_001)}/revoke`, "h21-device", { expectedEpoch: 0, reason: "device fence" }),
    () => ctx.mutate(apiA.baseUrl, `/api/v1/principals/${id(1_000_002)}/revoke`, "h21-principal", { expectedEpoch: 0, reason: "principal fence" }),
    () => ctx.mutate(apiB.baseUrl, `/api/v1/regions/${alternateRegion}/quarantine`, "h21-region", { tenantId, expectedRevision: 0, reason: "regional fence", createdBy: reviewerAId }),
  ];
  for (const [index, applyFence] of fences.entries()) {
    const response = await applyFence();
    assert.ok(success(response), response.text);
    const checks = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => ctx.request(url, `/api/v1/grants/${grantIds[index]}/check`)));
    assert.ok(checks.every((entry) => entry.status === 200 && entry.json?.active === false));
  }
  const unaffected = await ctx.request(apiA.baseUrl, `/api/v1/grants/${grantIds[4]}/check`);
  assert.equal(unaffected.json?.active, true);
  const tenantFence = await ctx.mutate(apiB.baseUrl, `/api/v1/tenants/${tenantId}/revoke`, "h21-tenant", { expectedEpoch: 0, reason: "tenant fence" });
  assert.ok(success(tenantFence), tenantFence.text);
  const tenantChecks = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => ctx.request(url, `/api/v1/grants/${grantIds[4]}/check`)));
  assert.ok(tenantChecks.every((entry) => entry.status === 200 && entry.json?.active === false));

  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiB.baseUrl);
    const relevantWork = value.work.filter(({ kind }) => kind !== "EVENT_DELIVERY");
    return relevantWork.length > 0 && relevantWork.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 60_000, label: "all revocation fences to converge", children: [...workers, ...dispatchers] });
  assert.ok(resource(snapshot, "accessRequests").every((entry) => entry.policyRevisionId === policyRevisionId));
  assert.ok(grantIds.every((grantId) => resource(snapshot, "accessGrants").find((entry) => entry.grantId === grantId)?.state !== "ACTIVE"));
  out.push("policy history stays frozen while session, device, principal, region, and tenant fences fail closed across API processes");
}

async function refreshUncertaintyCase(ctx, out) {
  const api = await prepared(ctx);
  const created = await ctx.mutate(api.baseUrl, "/api/v1/sessions", "h22-session", { tenantId, principalId: requesterId, deviceId, deviceTrustRevisionId: id(110), requestedTtlSeconds: 600 });
  assert.ok(success(created), created.text);
  const dynamicSessionId = find(created.json, "sessionId");
  const token = created.json?.refreshToken;
  const shield = await ctx.responseShield(api.baseUrl);
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, `/api/v1/sessions/${dynamicSessionId}/refresh`, "h22-refresh", { refreshToken: token, requestedTtlSeconds: 600 }).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label: "hidden refresh response" });
  const committed = JSON.parse(shield.captures[0].body);
  const replay = await ctx.mutate(api.baseUrl, `/api/v1/sessions/${dynamicSessionId}/refresh`, "h22-refresh", { refreshToken: token, requestedTtlSeconds: 600 });
  assert.equal(ctx.canonical(replay.json), ctx.canonical(committed));
  const racing = await ctx.concurrent(Array.from({ length: 32 }), 32, (_, index) => ctx.mutate(
    api.baseUrl, `/api/v1/sessions/${dynamicSessionId}/refresh`, `h22-reuse-${index}`, { refreshToken: token, requestedTtlSeconds: 600 },
  ));
  assert.ok(racing.every(({ status }) => status === 409));
  const snapshot = await ctx.snapshot(api.baseUrl);
  const familyId = find(created.json, "familyId");
  const family = resource(snapshot, "sessions").filter((entry) => entry.familyId === familyId);
  assert.ok(family.length >= 1);
  assert.ok(family.every(({ state }) => state === "REVOKED"));
  assert.equal(Math.max(...family.map(({ generation }) => generation)), 2);
  assertSecretFree(snapshot);
  assertValuesAbsentFromProcessLogs(ctx, [token, committed.refreshToken, replay.json?.refreshToken]);
  out.push("unknown refresh response replays exactly and old-token contention revokes one conserved family");
}

async function locationReplayCase(ctx, out) {
  const api = await prepared(ctx);
  const base = Date.now();
  const observations = [
    { sequence: 4, at: base + 4_000, longitude: -73.6 },
    { sequence: 2, at: base + 2_000, longitude: -73.8 },
    { sequence: 3, at: base + 3_000, longitude: -73.7 },
  ];
  for (const item of observations) {
    const response = await ctx.mutate(api.baseUrl, "/api/v1/location-observations", `h23-${item.sequence}`, {
      tenantId, deviceId, deviceSequence: item.sequence, observedAt: new Date(item.at).toISOString(), longitude: item.longitude, latitude: 40.7, region,
    });
    assert.ok(success(response), response.text);
  }
  const duplicate = await ctx.mutate(api.baseUrl, "/api/v1/location-observations", "h23-duplicate-sequence", {
    tenantId, deviceId, deviceSequence: 2, observedAt: new Date(base + 2_000).toISOString(), longitude: -73.8, latitude: 40.7, region,
  });
  assert.ok(success(duplicate) || duplicate.status === 409, duplicate.text);
  const tooLate = await ctx.mutate(api.baseUrl, "/api/v1/location-observations", "h23-too-late", {
    tenantId, deviceId, deviceSequence: 5, observedAt: new Date(base - 3_600_000).toISOString(), longitude: -80, latitude: 40, region: alternateRegion,
  });
  assert.ok(success(tooLate), tooLate.text);
  const tooLateId = find(tooLate.json, "observationId");
  const workers = [await ctx.startWorker(), await ctx.startWorker()];
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const work = value.work.filter(({ kind }) => kind === "LOCATION_REPLAY");
    return work.length >= 4 && work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 60_000, label: "location replay drain", children: workers });
  const location = resource(snapshot, "deviceLocations").find((entry) => entry.deviceId === deviceId);
  assert.equal(location.lastSequence, 4);
  assert.equal(location.longitude, -73.6);
  assertUnique(location.riskFlags, "device risk flags");
  assert.deepEqual(resource(snapshot, "locationObservations").filter((entry) => entry.deviceId === deviceId).map(({ deviceSequence }) => deviceSequence), [1, 2, 3, 4, 5]);
  assert.ok(snapshot.work.some((entry) => entry.aggregateId === tooLateId && entry.lastError === "LOCATION_TOO_LATE" && entry.terminal));
  assertUnique(resource(snapshot, "locationObservations").map(({ deviceId: value, deviceSequence }) => `${value}:${deviceSequence}`), "location sequence identities");
  out.push("duplicate, out-of-order, bounded-late, and too-late observations converge to one deterministic device location");
}

async function dualRecoveryCase(ctx, out) {
  const api = await prepared(ctx);
  const created = await createRequest(ctx, api.baseUrl, 240);
  const accessRequestId = find(created.json, "accessRequestId");
  let releaseWorker;
  const workerHold = new Promise((resolve) => { releaseWorker = resolve; });
  const workerBarrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === accessRequestId ? workerHold : { status: 204 });
  const firstWorker = await ctx.startWorker({ TEST_BARRIER_URL: workerBarrier.url, TEST_BARRIER_TOKEN: "h24-worker" });
  await ctx.waitFor(() => workerBarrier.ledger.some((entry) => entry.json?.aggregateId === accessRequestId), { label: "risk work claim", children: [firstWorker] });
  await ctx.stop(firstWorker, "SIGKILL");
  releaseWorker({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacement = await ctx.startWorker();
  await waitRisk(ctx, api.baseUrl, accessRequestId, [replacement]);

  const webhook = await ctx.receiver();
  let releaseAck;
  const ackHold = new Promise((resolve) => { releaseAck = resolve; });
  const dispatcherBarrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? ackHold : { status: 204 });
  const firstDispatcher = await ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: dispatcherBarrier.url, TEST_BARRIER_TOKEN: "h24-dispatcher" });
  await ctx.waitFor(() => dispatcherBarrier.ledger.length > 0, { label: "dispatcher response", children: [firstDispatcher] });
  await ctx.stop(firstDispatcher, "SIGKILL");
  releaseAck({ status: 204 });
  const secondDispatcher = await ctx.startDispatcher(webhook.url);
  await ctx.waitFor(() => webhook.ledger.length >= 2, { timeoutMs: 60_000, label: "event retry", children: [secondDispatcher] });
  assert.equal(webhook.ledger[0].raw, webhook.ledger[1].raw);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(snapshot, "riskDecisions").filter((entry) => entry.accessRequestId === accessRequestId).length, 1);
  const aggregateWork = snapshot.work.filter((entry) => entry.aggregateId === accessRequestId);
  assert.ok(aggregateWork.length >= 1 && aggregateWork.every(({ terminal }) => terminal));
  assertUnique(aggregateWork.map(({ workId }) => workId), "recovered work IDs");
  assertEventOrder(snapshot);
  assertAuditChain(snapshot);
  out.push("worker lease fencing and unknown webhook acknowledgement recover together without duplicate decision, Event, or audit fact");
}

async function createApprovedBreakGlass(ctx, baseUrl, prefix, requestedTtlSeconds = 300) {
  const created = await ctx.mutate(baseUrl, "/api/v1/break-glass-sessions", `${prefix}-create`, {
    tenantId, requesterId, sessionId, region, actions: ["deploy"], resourcePatterns: ["production/emergency/*"], reason: "restore service", requestedTtlSeconds,
  });
  assert.ok(success(created), created.text);
  const breakGlassSessionId = find(created.json, "breakGlassSessionId");
  for (const [index, approverId] of [reviewerAId, reviewerBId].entries()) {
    const approved = await ctx.mutate(baseUrl, `/api/v1/break-glass-sessions/${breakGlassSessionId}/approvals`, `${prefix}-approve-${index}`, { approverId, decision: "APPROVE", comment: "independent approval" });
    assert.ok(success(approved), approved.text);
  }
  const activated = await ctx.mutate(baseUrl, `/api/v1/break-glass-sessions/${breakGlassSessionId}/activate`, `${prefix}-activate`, { expectedState: "READY" });
  assert.ok(success(activated), activated.text);
  return breakGlassSessionId;
}

async function createManagerLifecycle(ctx, baseUrl, prefix) {
  const quarantine = await ctx.mutate(baseUrl, `/api/v1/regions/${region}/quarantine`, `${prefix}-quarantine`, { tenantId, expectedRevision: 0, reason: "regional incident", createdBy: reviewerAId });
  assert.ok(success(quarantine), quarantine.text);
  const breakGlassSessionId = await createApprovedBreakGlass(ctx, baseUrl, prefix);
  return { breakGlassSessionId, quarantineRevision: find(quarantine.json, "revision") ?? 1 };
}

async function retrospectiveCase(ctx, out) {
  const api = await prepared(ctx);
  const quarantine = await ctx.mutate(api.baseUrl, `/api/v1/regions/${region}/quarantine`, "h25-quarantine", { tenantId, expectedRevision: 0, reason: "regional incident", createdBy: reviewerAId });
  assert.ok(success(quarantine), quarantine.text);
  const quarantineRevision = find(quarantine.json, "revision") ?? 1;
  const closedSessionId = await createApprovedBreakGlass(ctx, api.baseUrl, "h25-closed", 60);
  const expiringSessionId = await createApprovedBreakGlass(ctx, api.baseUrl, "h25-expiring", 60);
  const premature = await ctx.mutate(api.baseUrl, `/api/v1/regions/${region}/release`, "h25-premature-release", { tenantId, expectedRevision: quarantineRevision, releasedBy: reviewerBId });
  assert.equal(premature.status, 409, premature.text);
  const closed = await ctx.mutate(api.baseUrl, `/api/v1/break-glass-sessions/${closedSessionId}/close`, "h25-close", { reason: "done" });
  assert.ok(success(closed), closed.text);
  const worker = await ctx.startWorker();
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return resource(snapshot, "breakGlassSessions").find((entry) => entry.breakGlassSessionId === expiringSessionId)?.state === "EXPIRED" ? snapshot : undefined;
  }, { timeoutMs: 75_000, label: "break-glass expiry", children: [worker] });
  const expiredCheck = await checkBreakGlass(ctx, api.baseUrl, expiringSessionId, { action: "deploy", resource: "production/emergency/api", region });
  assert.equal(expiredCheck.status, 200, expiredCheck.text);
  assert.equal(expiredCheck.json?.authorized, false);
  for (const reviewerId of [requesterId, reviewerAId, reviewerBId]) {
    const invalid = await ctx.mutate(api.baseUrl, `/api/v1/break-glass-sessions/${closedSessionId}/retrospective-reviews`, `h25-invalid-${reviewerId}`, { reviewerId, outcome: "JUSTIFIED", findings: "invalid reviewer" });
    assert.equal(invalid.status, 403, invalid.text);
  }
  for (const [index, target] of [closedSessionId, expiringSessionId].entries()) {
    const reviewed = await ctx.mutate(api.baseUrl, `/api/v1/break-glass-sessions/${target}/retrospective-reviews`, `h25-review-${index}`, { reviewerId: reviewerCId, outcome: "POLICY_GAP", findings: "Add a narrower normal policy" });
    assert.ok(success(reviewed), reviewed.text);
  }
  const duplicate = await ctx.mutate(api.baseUrl, `/api/v1/break-glass-sessions/${closedSessionId}/retrospective-reviews`, "h25-review-duplicate", { reviewerId: reviewerCId, outcome: "JUSTIFIED", findings: "duplicate" });
  assert.equal(duplicate.status, 409, duplicate.text);
  const released = await ctx.mutate(api.baseUrl, `/api/v1/regions/${region}/release`, "h25-release", { tenantId, expectedRevision: quarantineRevision, releasedBy: reviewerBId });
  assert.ok(success(released), released.text);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(snapshot, "retrospectiveReviews").filter((entry) => [closedSessionId, expiringSessionId].includes(entry.breakGlassSessionId)).length, 2);
  out.push("regional release waits for closed and expired emergency sessions and one independent retrospective review for each");
}

async function catastropheCase(ctx, out) {
  const apiA = await prepared(ctx);
  const apiB = await ctx.startApi();
  const grantWorkers = [await ctx.startWorker(), await ctx.startWorker()];
  const { grantId } = await createReviewGrant(ctx, apiA.baseUrl, 259, grantWorkers);
  const initiallyActive = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => ctx.request(url, `/api/v1/grants/${grantId}/check`)));
  assert.ok(initiallyActive.every((entry) => entry.status === 200 && entry.json?.active === true));
  await Promise.all(grantWorkers.map((worker) => ctx.stop(worker)));
  const operation = await createManagerLifecycle(ctx, apiA.baseUrl, "h26");
  const quarantinedGrant = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => ctx.request(url, `/api/v1/grants/${grantId}/check`)));
  assert.ok(quarantinedGrant.every((entry) => entry.status === 200 && entry.json?.active === false));
  const emergencyBefore = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => checkBreakGlass(ctx, url, operation.breakGlassSessionId, {
    action: "deploy", resource: "production/emergency/api", region,
  })));
  assert.ok(emergencyBefore.every((entry) => entry.status === 200 && entry.json?.authorized === true));
  const publish = await publishPolicy(ctx, apiB.baseUrl, 1, 2, "h26-policy");
  assert.ok(success(publish));
  const normal = await createRequest(ctx, apiA.baseUrl, 260);
  const normalId = find(normal.json, "accessRequestId");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === normalId ? held : { status: 204 });
  const staleWorker = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "h26" });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.aggregateId === normalId), { label: "catastrophe stale claim", children: [staleWorker] });
  const revoked = await ctx.mutate(apiB.baseUrl, `/api/v1/tenants/${tenantId}/revoke`, "h26-tenant-revoke", { expectedEpoch: 0, reason: "tenant compromise" });
  assert.ok(success(revoked), revoked.text);
  const revokedGrantChecks = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => ctx.request(url, `/api/v1/grants/${grantId}/check`)));
  assert.ok(revokedGrantChecks.every((entry) => entry.status === 200 && entry.json?.active === false));
  const revokedEmergencyChecks = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => checkBreakGlass(ctx, url, operation.breakGlassSessionId, {
    action: "deploy", resource: "production/emergency/api", region,
  })));
  assert.ok(revokedEmergencyChecks.every((entry) => entry.status === 200 && entry.json?.authorized === false));
  await ctx.stop(staleWorker, "SIGKILL");
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    return snapshot.work.every(({ kind, terminal }) => kind === "EVENT_DELIVERY" || terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "catastrophe work drain", children: workers });

  const webhook = await ctx.receiver();
  let releaseAck;
  const heldAck = new Promise((resolve) => { releaseAck = resolve; });
  const dispatcherBarrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? heldAck : { status: 204 });
  const firstDispatcher = await ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: dispatcherBarrier.url, TEST_BARRIER_TOKEN: "h26-dispatcher" });
  await ctx.waitFor(() => dispatcherBarrier.ledger.length > 0, { label: "catastrophe hidden ACK", children: [firstDispatcher] });
  await ctx.stop(firstDispatcher, "SIGKILL");
  releaseAck({ status: 204 });
  const replacementDispatcher = await ctx.startDispatcher(webhook.url);
  await ctx.waitFor(() => webhook.ledger.length >= 2, { timeoutMs: 60_000, label: "catastrophe event retry", children: [replacementDispatcher] });
  assert.equal(webhook.ledger[0].raw, webhook.ledger[1].raw);

  const snapshot = await ctx.snapshot(apiB.baseUrl);
  assert.equal(resource(snapshot, "riskDecisions").filter((entry) => entry.accessRequestId === normalId).length <= 1, true);
  assert.notEqual(resource(snapshot, "accessGrants").find((entry) => entry.grantId === grantId)?.state, "ACTIVE");
  const finalEmergencyChecks = await Promise.all([apiA.baseUrl, apiB.baseUrl].map((url) => checkBreakGlass(ctx, url, operation.breakGlassSessionId, {
    action: "deploy", resource: "production/emergency/api", region,
  })));
  assert.ok(finalEmergencyChecks.every((entry) => entry.status === 200 && entry.json?.authorized === false));
  assertEventOrder(snapshot);
  assertAuditChain(snapshot);
  out.push("combined policy change, regional isolation, tenant revoke, stale claim, and recovery preserve fail-closed authority and single effects");
}

function scaledCount(base, scale, minimum) {
  return Math.min(base, Math.max(minimum, Math.ceil(base * scale)));
}

function percentile(values, fraction) {
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? 0;
}

async function fixedLoad(ctx, count, concurrency, operation) {
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const started = performance.now();
    const response = await operation(index);
    latencies.push(response.durationMs ?? performance.now() - started);
    statuses.set(response.status ?? 200, (statuses.get(response.status ?? 200) ?? 0) + 1);
  });
  const durationMs = Math.max(1, performance.now() - startedAt);
  latencies.sort((a, b) => a - b);
  return {
    requested: count,
    completed: latencies.length,
    durationMs,
    throughput: count / (durationMs / 1_000),
    p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99),
    statuses: Object.fromEntries(statuses),
  };
}

function assertLoad(metric, label, throughput, p95, scale) {
  assert.equal(metric.completed, metric.requested, `${label} did not execute the fixed count`);
  const failures = Object.entries(metric.statuses).filter(([status]) => Number(status) < 200 || Number(status) >= 300);
  assert.deepEqual(failures, [], `${label} returned failures: ${JSON.stringify(failures)}`);
  if (scale === 1) {
    assert.ok(metric.throughput >= throughput, `${label} throughput ${metric.throughput} < ${throughput}`);
    assert.ok(metric.p95 <= p95, `${label} p95 ${metric.p95} > ${p95}`);
  }
}

async function performanceWorld(ctx, seedValue) {
  await ctx.resetDatabase();
  await ctx.prepare();
  const imported = await ctx.seed(seedValue);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return [await ctx.startApi(), await ctx.startApi()];
}

async function finishPerformanceScenario(ctx, baseUrl, snapshot, metric, postLoadInvariants) {
  const live = ctx.processes.filter(({ child }) => child.exitCode === null);
  const topology = {
    apiProcesses: live.filter(({ script }) => script === "start:api").length,
    workers: live.filter(({ script }) => script === "start:worker").length,
    dispatchers: live.filter(({ script }) => script === "start:dispatcher").length,
  };
  const rssBytes = (await Promise.all(live.map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  const finalSnapshot = snapshot ?? await ctx.snapshot(baseUrl);
  return {
    ...metric,
    topology,
    rssBytes,
    databaseBytes: finalSnapshot.metrics?.databaseBytes ?? null,
    postLoadInvariants,
  };
}

function grantedSeed(seedVersion, grantCount, principalCount = 1_000) {
  const value = baseSeed(seedVersion);
  const now = iso(-60_000);
  for (let index = 0; index < principalCount; index += 1) {
    const principalId = id(1_000_000 + index);
    const deviceId = id(2_000_000 + index);
    const trustId = id(3_000_000 + index);
    const sessionId = id(4_000_000 + index);
    value.principals.push({ principalId, tenantId, displayName: `Performance Principal ${index}`, state: "ACTIVE", revocationEpoch: 0, createdAt: now });
    value.devices.push({ deviceId, tenantId, principalId, publicKeyFingerprint: sha256(`perf-device-${index}`), state: "ACTIVE", currentTrustRevision: 1, revocationEpoch: 0, createdAt: now });
    value.deviceTrustRevisions.push({ deviceTrustRevisionId: trustId, deviceId, tenantId, revision: 1, state: "TRUSTED", assurance: 3, validFrom: now, validUntil: iso(86_400_000), evidenceDigest: sha256(`perf-trust-${index}`), createdAt: now });
    value.sessions.push({ sessionId, tenantId, principalId, deviceId, deviceTrustRevisionId: trustId, familyId: id(5_000_000 + index), generation: 1, refreshTokenDigest: sha256(`perf-token-${index}`), state: "ACTIVE", expiresAt: iso(86_400_000), revocationEpoch: 0, createdAt: now, updatedAt: now });
  }
  for (let index = 0; index < grantCount; index += 1) {
    const owner = index % principalCount;
    const principalId = id(1_000_000 + owner);
    const deviceId = id(2_000_000 + owner);
    const sessionId = id(4_000_000 + owner);
    const accessRequestId = id(6_000_000 + index);
    const riskDecisionId = id(7_000_000 + index);
    value.accessRequests.push({ accessRequestId, tenantId, principalId, deviceId, sessionId, action: "deploy", resource: `production/perf-${index}`, region, requestedTtlSeconds: 900, justification: "performance fixture", state: "GRANTED", policyRevisionId, riskModelRevisionId, deviceTrustRevisionId: id(3_000_000 + owner), sessionGeneration: 1, tenantRevocationEpoch: 0, principalRevocationEpoch: 0, locationWatermark: now, createdAt: now, updatedAt: now });
    value.riskDecisions.push({ riskDecisionId, accessRequestId, tenantId, score: 0, level: "LOW", reasons: [], policyEffect: "ALLOW", inputDigest: sha256(`perf-input-${index}`), decidedAt: now });
    value.accessGrants.push({ grantId: id(8_000_000 + index), accessRequestId, tenantId, principalId, deviceId, sessionId, action: "deploy", resource: `production/perf-${index}`, region, policyRevisionId, riskDecisionId, state: "ACTIVE", notBefore: now, expiresAt: iso(86_400_000), revocationEpoch: 0, createdAt: now, updatedAt: now });
  }
  return value;
}

function performanceRequestPayload(index, identityCount) {
  const owner = index % identityCount;
  return requestPayload(index, {
    principalId: id(1_000_000 + owner),
    deviceId: id(2_000_000 + owner),
    sessionId: id(4_000_000 + owner),
  });
}

function performanceRules(bundleIndex) {
  const rules = [
    ...Array.from({ length: 400 }, (_, path) => ({
      ruleId: `allow-${String(bundleIndex).padStart(3, "0")}-${String(path).padStart(3, "0")}`,
      effect: "ALLOW",
      actions: ["deploy"],
      resourcePattern: `production/hotset-${bundleIndex}/${path}/*`,
      minAssurance: 2,
      regions: [region],
    })),
    ...Array.from({ length: 100 }, (_, path) => ({
      ruleId: `deny-${String(bundleIndex).padStart(3, "0")}-${String(path).padStart(3, "0")}`,
      effect: "DENY",
      actions: ["deploy"],
      resourcePattern: `production/hotset-${bundleIndex}/${path}/*`,
      minAssurance: 2,
      regions: [region],
    })),
  ];
  return rules.sort((left, right) => left.ruleId.localeCompare(right.ruleId));
}

function policyHotsetSeed(seedVersion, grantCount) {
  const value = grantedSeed(seedVersion, grantCount, Math.min(grantCount, 1_000));
  const first = value.policyRevisions[0];
  first.rules = performanceRules(0);
  first.digest = digest(first);
  for (let bundle = 1; bundle < 100; bundle += 1) {
    const bundleId = id(9_000_000 + bundle);
    const revisionId = id(9_100_000 + bundle);
    const revision = { policyRevisionId: revisionId, policyBundleId: bundleId, tenantId, revision: 1, effectiveFrom: iso(-86_400_000), rules: performanceRules(bundle), createdAt: iso(-86_400_000) };
    revision.digest = digest(revision);
    value.policyBundles.push({ policyBundleId: bundleId, tenantId, name: `Hotset Policy ${bundle}`, currentRevision: 1, currentPolicyRevisionId: revisionId, createdAt: iso(-86_400_000) });
    value.policyRevisions.push(revision);
  }
  for (let index = 0; index < value.accessRequests.length; index += 1) {
    const bundle = index % 100;
    const path = Math.floor(index / 100) % 400;
    const revisionId = bundle === 0 ? policyRevisionId : id(9_100_000 + bundle);
    const resource = `production/hotset-${bundle}/${path}/grant-${index}`;
    value.accessRequests[index].policyRevisionId = revisionId;
    value.accessRequests[index].resource = resource;
    value.accessGrants[index].policyRevisionId = revisionId;
    value.accessGrants[index].resource = resource;
  }
  return value;
}

async function sessionRefreshPerformance(ctx, scale) {
  const apis = await performanceWorld(ctx, baseSeed(`perf-session-${scale}`));
  const familyCount = scaledCount(20_000, scale, 100);
  const rotationCount = scaledCount(100_000, scale, 500);
  const sampledTokens = [];
  const families = await ctx.concurrent(Array.from({ length: familyCount }), 64, async (_, index) => {
    const response = await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/sessions", `perf-session-${index}`, {
      tenantId, principalId: requesterId, deviceId, deviceTrustRevisionId: id(110), requestedTtlSeconds: 3_600,
    });
    assert.ok(success(response), response.text);
    if (index < 32) sampledTokens.push(response.json.refreshToken);
    return {
      sessionId: find(response.json, "sessionId"),
      familyId: find(response.json, "familyId"),
      refreshToken: response.json.refreshToken,
      rotations: 0,
    };
  });
  const startedAt = performance.now();
  const latencies = [];
  const statuses = new Map();
  let completed = 0;
  await ctx.concurrent(families, 64, async (family, familyIndex) => {
    for (let rotation = familyIndex; rotation < rotationCount; rotation += familyCount) {
      const started = performance.now();
      const response = await ctx.mutate(apis[rotation % 2].baseUrl, `/api/v1/sessions/${family.sessionId}/refresh`, `perf-refresh-${rotation}`, {
        refreshToken: family.refreshToken, requestedTtlSeconds: 3_600,
      });
      latencies.push(performance.now() - started);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      assert.ok(success(response), response.text);
      family.sessionId = find(response.json, "sessionId") ?? family.sessionId;
      family.refreshToken = response.json.refreshToken;
      family.rotations += 1;
      completed += 1;
    }
    if (familyIndex < 32) sampledTokens.push(family.refreshToken);
  });
  const durationMs = Math.max(1, performance.now() - startedAt);
  latencies.sort((a, b) => a - b);
  const metric = { requested: rotationCount, completed, durationMs, throughput: completed / (durationMs / 1_000), p50: percentile(latencies, .5), p95: percentile(latencies, .95), p99: percentile(latencies, .99), statuses: Object.fromEntries(statuses) };
  assertLoad(metric, "session-refresh-storm", 800, 180, scale);
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  const sessionsByFamily = new Map();
  for (const session of resource(snapshot, "sessions")) {
    const values = sessionsByFamily.get(session.familyId) ?? [];
    values.push(session);
    sessionsByFamily.set(session.familyId, values);
  }
  assert.equal(families.reduce((sum, family) => sum + family.rotations, 0), rotationCount);
  for (const family of families) {
    assert.equal(typeof family.familyId, "string");
    const sessions = sessionsByFamily.get(family.familyId) ?? [];
    const active = sessions.filter(({ state }) => state === "ACTIVE");
    assert.equal(active.length, 1, `family ${family.familyId} has ${active.length} active sessions`);
    assert.equal(active[0].generation, family.rotations + 1);
  }
  assertSecretFree(snapshot);
  const snapshotText = JSON.stringify(snapshot);
  for (const token of sampledTokens) assert.ok(!snapshotText.includes(token), "a sampled raw refresh token appeared in the snapshot");
  assertValuesAbsentFromProcessLogs(ctx, sampledTokens);
  return finishPerformanceScenario(ctx, apis[0].baseUrl, snapshot, {
    scenarioId: "session-refresh-storm", publicCount: 100_000, actualCount: rotationCount, families: familyCount, scale, ...metric,
  }, [
    "every seeded family has exactly one ACTIVE session at rotations + 1 generation",
    "snapshot and live process logs contain no sampled raw refresh token",
  ]);
}

async function accessIngestPerformance(ctx, scale) {
  const count = scaledCount(500_000, scale, 1_000);
  const identityCount = scaledCount(100_000, scale, 1_000);
  const apis = await performanceWorld(ctx, grantedSeed(`perf-ingest-${scale}`, 0, identityCount));
  const workers = await Promise.all(Array.from({ length: 8 }, () => ctx.startWorker()));
  const webhook = await ctx.receiver();
  const dispatchers = await Promise.all(Array.from({ length: 4 }, () => ctx.startDispatcher(webhook.url)));
  const metric = await fixedLoad(ctx, count, 64, (index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/access-requests", `perf-access-${index}`, performanceRequestPayload(100_000 + index, identityCount)));
  assertLoad(metric, "access-decision-ingest", 500, 250, scale);
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apis[0].baseUrl);
    const decisions = resource(value, "riskDecisions").length;
    return decisions === count && value.work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 300_000, label: "performance risk drain", children: [...workers, ...dispatchers] });
  const requests = resource(snapshot, "accessRequests");
  const decisions = resource(snapshot, "riskDecisions");
  assert.equal(requests.length, count);
  assert.equal(resource(snapshot, "riskDecisions").length, count);
  assertUnique(requests.map(({ accessRequestId }) => accessRequestId), "performance requests");
  assertUnique(decisions.map(({ accessRequestId }) => accessRequestId), "performance decisions");
  assert.deepEqual(
    decisions.map(({ accessRequestId }) => accessRequestId).sort(),
    requests.map(({ accessRequestId }) => accessRequestId).sort(),
  );
  assert.ok(snapshot.work.length > 0 && snapshot.work.every(({ terminal }) => terminal));
  return finishPerformanceScenario(ctx, apis[0].baseUrl, snapshot, {
    scenarioId: "access-decision-ingest", publicCount: 500_000, actualCount: count, identities: identityCount, scale, ...metric,
  }, [
    "AccessRequest and RiskDecision cardinality and identity sets match exactly",
    "all generated Work reached a terminal state",
  ]);
}

async function policyHotsetPerformance(ctx, scale) {
  const grantCount = scaledCount(100_000, scale, 1_000);
  const apis = await performanceWorld(ctx, policyHotsetSeed(`perf-policy-${scale}`, grantCount));
  const count = scaledCount(1_000_000, scale, 10_000);
  const metric = await fixedLoad(ctx, count, 64, async (index) => {
    const grantIndex = index % grantCount;
    const bundle = grantIndex % 100;
    const path = Math.floor(grantIndex / 100) % 400;
    const expectedRevisionId = bundle === 0 ? policyRevisionId : id(9_100_000 + bundle);
    const response = await ctx.request(apis[index % 2].baseUrl, `/api/v1/grants/${id(8_000_000 + grantIndex)}/check`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json?.active, path >= 100);
    assert.equal(response.json?.policyRevisionId, expectedRevisionId);
    return response;
  });
  assertLoad(metric, "policy-evaluation-hotset", 2_000, 75, scale);
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  assert.equal(resource(snapshot, "policyBundles").length, 100);
  assert.equal(resource(snapshot, "policyRevisions").length, 100);
  assert.ok(resource(snapshot, "policyRevisions").every(({ rules }) => rules.length === 500));
  return finishPerformanceScenario(ctx, apis[0].baseUrl, snapshot, {
    scenarioId: "policy-evaluation-hotset", publicCount: 1_000_000, actualCount: count, grants: grantCount, scale, ...metric,
  }, [
    "every check returned the grant's exact frozen policy revision",
    "overlapping deny rules overrode matching allow rules deterministically",
  ]);
}

async function locationReplayPerformance(ctx, scale) {
  const apis = await performanceWorld(ctx, grantedSeed(`perf-location-${scale}`, 0, scaledCount(10_000, scale, 100)));
  const count = scaledCount(200_000, scale, 2_000);
  const deviceCount = scaledCount(10_000, scale, 100);
  const workers = await Promise.all(Array.from({ length: 8 }, () => ctx.startWorker()));
  const webhook = await ctx.receiver();
  const dispatchers = await Promise.all(Array.from({ length: 4 }, () => ctx.startDispatcher(webhook.url)));
  const observedBase = Date.now() - 60_000;
  const metric = await fixedLoad(ctx, count, 64, (index) => {
    const owner = index % deviceCount;
    const sequence = Math.floor(index / deviceCount) + 1;
    return ctx.mutate(apis[index % 2].baseUrl, "/api/v1/location-observations", `perf-location-${index}`, {
      tenantId, deviceId: id(2_000_000 + owner), deviceSequence: sequence,
      observedAt: new Date(observedBase + (sequence % 2 ? sequence + 1 : sequence - 1) * 1_000).toISOString(),
      longitude: -73.9 + (sequence % 3) * 0.001, latitude: 40.7, region,
    });
  });
  assertLoad(metric, "location-replay-convergence", 350, 300, scale);
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apis[0].baseUrl);
    return value.work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 300_000, label: "location performance drain", children: [...workers, ...dispatchers] });
  const deviceIds = new Set(Array.from({ length: deviceCount }, (_, index) => id(2_000_000 + index)));
  const observations = resource(snapshot, "locationObservations").filter(({ deviceId: value }) => deviceIds.has(value));
  assert.equal(observations.length, count);
  assertUnique(observations.map(({ deviceId: value, deviceSequence }) => `${value}:${deviceSequence}`), "performance location identities");
  const observationsByDevice = new Map();
  for (const observation of observations) {
    const values = observationsByDevice.get(observation.deviceId) ?? [];
    values.push(observation);
    observationsByDevice.set(observation.deviceId, values);
  }
  const locations = new Map(resource(snapshot, "deviceLocations").map((entry) => [entry.deviceId, entry]));
  for (let owner = 0; owner < deviceCount; owner += 1) {
    const currentDeviceId = id(2_000_000 + owner);
    const values = observationsByDevice.get(currentDeviceId) ?? [];
    const expectedCount = Math.floor((count - 1 - owner) / deviceCount) + 1;
    assert.deepEqual(values.map(({ deviceSequence }) => deviceSequence).sort((a, b) => a - b), Array.from({ length: expectedCount }, (_, index) => index + 1));
    values.sort((left, right) => left.observedAt.localeCompare(right.observedAt)
      || left.deviceSequence - right.deviceSequence || left.observationId.localeCompare(right.observationId));
    const expected = values.at(-1);
    const location = locations.get(currentDeviceId);
    assert.equal(location?.lastSequence, expectedCount);
    assert.equal(location?.watermarkObservedAt, expected.observedAt);
    assert.equal(location?.longitude, expected.longitude);
    assert.equal(location?.latitude, expected.latitude);
    assert.equal(location?.region, expected.region);
    assertUnique(location?.riskFlags ?? [], `risk flags for ${currentDeviceId}`);
  }
  assert.ok(snapshot.work.length > 0 && snapshot.work.every(({ terminal }) => terminal));
  return finishPerformanceScenario(ctx, apis[0].baseUrl, snapshot, {
    scenarioId: "location-replay-convergence", publicCount: 200_000, actualCount: count, devices: deviceCount, scale, ...metric,
  }, [
    "every device has a contiguous immutable sequence identity",
    "each final location matches the deterministic observedAt/sequence/identity oracle without duplicate risk flags",
    "all replay Work reached a terminal state",
  ]);
}

async function revocationFanoutPerformance(ctx, scale) {
  const grantCount = scaledCount(100_000, scale, 1_000);
  const principalCount = Math.min(grantCount, scaledCount(1_000, scale, 20));
  const apis = await performanceWorld(ctx, grantedSeed(`perf-fanout-${scale}`, grantCount, principalCount));
  const workers = await Promise.all(Array.from({ length: 8 }, () => ctx.startWorker()));
  const webhook = await ctx.receiver();
  const dispatchers = await Promise.all(Array.from({ length: 4 }, () => ctx.startDispatcher(webhook.url)));
  const metric = await fixedLoad(ctx, principalCount, 32, (index) => ctx.mutate(
    apis[index % 2].baseUrl, `/api/v1/principals/${id(1_000_000 + index)}/revoke`, `perf-principal-revoke-${index}`,
    { expectedEpoch: 0, reason: "performance fanout" },
  ));
  assertLoad(metric, "grant-revocation-fanout", 1, 250, scale);
  const convergenceStarted = performance.now();
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apis[0].baseUrl);
    return resource(value, "accessGrants").every(({ state }) => state !== "ACTIVE") && value.work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 30_000, label: "grant revocation fanout", children: [...workers, ...dispatchers] });
  const checks = await fixedLoad(ctx, grantCount * 2, 64, async (index) => {
    const grantIndex = Math.floor(index / 2);
    const response = await ctx.request(apis[index % 2].baseUrl, `/api/v1/grants/${id(8_000_000 + grantIndex)}/check`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json?.active, false);
    return response;
  });
  assertLoad(checks, "grant-revocation-fanout checks", 1, 10_000, scale);
  const convergenceMs = performance.now() - convergenceStarted;
  assert.ok(scale !== 1 || convergenceMs <= 30_000);
  const principalIds = new Set(Array.from({ length: principalCount }, (_, index) => id(1_000_000 + index)));
  const revocations = resource(snapshot, "revocations").filter(({ subjectType, subjectId }) => subjectType === "PRINCIPAL" && principalIds.has(subjectId));
  assert.equal(revocations.length, principalCount);
  assertUnique(revocations.map(({ subjectId }) => subjectId), "principal revocations");
  assert.ok(revocations.every(({ epoch }) => epoch === 1));
  return finishPerformanceScenario(ctx, apis[0].baseUrl, snapshot, {
    scenarioId: "grant-revocation-fanout", publicCount: 100_000, actualCount: grantCount, principals: principalCount,
    convergenceMs, verificationChecks: checks.completed, verificationStatuses: checks.statuses, scale, ...metric,
  }, [
    "every principal has exactly one monotonic revocation",
    "every grant failed closed through both live API processes within the convergence window",
    "all propagation Work reached a terminal state",
  ]);
}

async function auditAppendPerformance(ctx, scale) {
  const apis = await performanceWorld(ctx, baseSeed(`perf-audit-${scale}`));
  const count = scaledCount(250_000, scale, 1_000);
  const workers = await Promise.all(Array.from({ length: 8 }, () => ctx.startWorker()));
  const webhook = await ctx.receiver();
  const dispatchers = await Promise.all(Array.from({ length: 4 }, () => ctx.startDispatcher(webhook.url)));
  const requestIds = new Array(count);
  const metric = await fixedLoad(ctx, count, 64, async (index) => {
    const response = await ctx.mutate(apis[index % 2].baseUrl, "/api/v1/access-requests", `perf-audit-${index}`, requestPayload(2_000_000 + index));
    requestIds[index] = find(response.json, "accessRequestId");
    return response;
  });
  assertLoad(metric, "audit-chain-append", 300, 300, scale);
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apis[0].baseUrl);
    return value.work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 300_000, label: "audit load work drain", children: [...workers, ...dispatchers] });
  assertAuditChain(snapshot);
  assertEventOrder(snapshot);
  assertUnique(requestIds, "performance audit request IDs");
  assert.equal(resource(snapshot, "accessRequests").length, count);
  const requestIdSet = new Set(requestIds);
  assert.equal(new Set(resource(snapshot, "auditEntries").filter(({ subjectId }) => requestIdSet.has(subjectId)).map(({ subjectId }) => subjectId)).size, count);
  assert.equal(new Set(snapshot.events.filter(({ aggregateId }) => requestIdSet.has(aggregateId)).map(({ aggregateId }) => aggregateId)).size, count);
  assert.ok(snapshot.work.length > 0 && snapshot.work.every(({ terminal }) => terminal));
  return finishPerformanceScenario(ctx, apis[0].baseUrl, snapshot, {
    scenarioId: "audit-chain-append", publicCount: 250_000, actualCount: count, scale, ...metric,
  }, [
    "every accepted mutation is represented in the Audit chain and Domain Event stream",
    "Audit digests and Event aggregate sequences are contiguous and unique",
    "all generated Work reached a terminal state and persisted data is secret-free",
  ]);
}

async function outboxRecoveryPerformance(ctx, scale) {
  const apis = await performanceWorld(ctx, baseSeed(`perf-outbox-${scale}`));
  const count = scaledCount(50_000, scale, 500);
  const accepted = await fixedLoad(ctx, count, 64, (index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/access-requests", `perf-outbox-${index}`, requestPayload(3_000_000 + index)));
  assertLoad(accepted, "outbox-ack-recovery creation", 1, 10_000, scale);
  const webhook = await ctx.receiver();
  let releaseAck;
  const heldAck = new Promise((resolve) => { releaseAck = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? heldAck : { status: 204 });
  const dispatchers = await Promise.all([
    ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-outbox" }),
    ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-outbox" }),
    ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-outbox" }),
    ctx.startDispatcher(webhook.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-outbox" }),
  ]);
  await ctx.waitFor(() => barrier.ledger.length >= 4, { label: "four hidden dispatcher acknowledgements", children: dispatchers });
  const startedAt = performance.now();
  await ctx.stop(dispatchers[0], "SIGKILL");
  await ctx.stop(dispatchers[1], "SIGKILL");
  releaseAck({ status: 204 });
  const replacements = [await ctx.startDispatcher(webhook.url), await ctx.startDispatcher(webhook.url)];
  await ctx.waitFor(() => {
    const groups = new Map();
    for (const entry of webhook.ledger) {
      const eventId = find(entry.json, "eventId");
      if (typeof eventId !== "string") return false;
      const values = groups.get(eventId) ?? [];
      values.push(entry.raw);
      groups.set(eventId, values);
    }
    return groups.size === count && [...groups.values()].some((values) => values.length > 1);
  }, {
    timeoutMs: 45_000, label: "outbox recovery drain", children: [...dispatchers.slice(2), ...replacements],
  });
  const convergenceMs = performance.now() - startedAt;
  const byId = new Map();
  for (const entry of webhook.ledger) {
    const eventId = find(entry.json, "eventId");
    assert.equal(typeof eventId, "string");
    const prior = byId.get(eventId);
    if (prior) assert.equal(entry.raw, prior);
    else byId.set(eventId, entry.raw);
  }
  assert.equal(byId.size, count);
  const deliveryCounts = new Map();
  for (const entry of webhook.ledger) {
    const eventId = find(entry.json, "eventId");
    deliveryCounts.set(eventId, (deliveryCounts.get(eventId) ?? 0) + 1);
  }
  assert.ok([...deliveryCounts.values()].some((value) => value > 1), "no Event was actually retried after hidden acknowledgement");
  assert.ok(scale !== 1 || convergenceMs <= 45_000);
  const snapshot = await ctx.snapshot(apis[0].baseUrl);
  assert.equal(snapshot.events.length, count);
  assert.deepEqual([...new Set(snapshot.events.map(({ eventId }) => eventId))].sort(), [...byId.keys()].sort());
  assertEventOrder(snapshot);
  const deliveryWork = snapshot.work.filter(({ kind }) => kind === "EVENT_DELIVERY");
  assert.ok(deliveryWork.length > 0 && deliveryWork.every(({ terminal }) => terminal));
  return finishPerformanceScenario(ctx, apis[0].baseUrl, snapshot, {
    scenarioId: "outbox-ack-recovery", publicCount: 50_000, actualCount: count, deliveredEvents: byId.size,
    retriedEvents: [...deliveryCounts.values()].filter((value) => value > 1).length, convergenceMs, scale, ...accepted,
  }, [
    "four dispatchers crossed the response-received barrier and two were killed",
    "at least one committed Event retried with the identical event ID and raw body",
    "exactly one logical Event exists for every accepted mutation and all delivery Work is terminal",
  ]);
}

async function revocationFencePerformance(ctx, scale) {
  const grantCount = scaledCount(50_000, scale, 500);
  const apis = await performanceWorld(ctx, grantedSeed(`perf-fence-${scale}`, grantCount, 4));
  const before = await fixedLoad(ctx, Math.min(grantCount, 10_000), 64, async (index) => {
    const response = await ctx.request(apis[index % 2].baseUrl, `/api/v1/grants/${id(8_000_000 + index % grantCount)}/check`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json?.active, true);
    return response;
  });
  assertLoad(before, "revocation-fence precheck", 1, 10_000, scale);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held : { status: 204 });
  const killed = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-fence" })));
  const committedSamples = [];
  let monitorRunning = true;
  let monitorChecks = 0;
  let monitorFailure;
  const monitor = (async () => {
    while (monitorRunning) {
      try {
        const checks = await Promise.all(committedSamples.flatMap((grantId) => apis.map((api) => ctx.request(api.baseUrl, `/api/v1/grants/${grantId}/check`))));
        monitorChecks += checks.length;
        for (const response of checks) {
          assert.equal(response.status, 200, response.text);
          assert.equal(response.json?.active, false);
        }
      } catch (error) {
        monitorFailure ??= error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  const convergenceStarted = performance.now();
  let snapshot;
  let checks;
  try {
    const fences = [
      {
        grantId: id(8_000_000),
        apply: () => ctx.mutate(apis[0].baseUrl, `/api/v1/devices/${id(2_000_000)}/revoke`, "perf-fence-device", { expectedEpoch: 0, reason: "fence" }),
      },
      {
        grantId: id(8_000_001),
        apply: () => ctx.mutate(apis[1].baseUrl, `/api/v1/sessions/${id(4_000_001)}/revoke`, "perf-fence-session", { expectedGeneration: 1, reason: "fence" }),
      },
      {
        grantId: id(8_000_002),
        apply: () => ctx.mutate(apis[0].baseUrl, `/api/v1/principals/${id(1_000_002)}/revoke`, "perf-fence-principal", { expectedEpoch: 0, reason: "fence" }),
      },
      {
        grantId: id(8_000_003),
        apply: () => ctx.mutate(apis[1].baseUrl, `/api/v1/tenants/${tenantId}/revoke`, "perf-fence-tenant", { expectedEpoch: 0, reason: "fence" }),
      },
    ];
    for (const fence of fences) {
      const mutation = await fence.apply();
      assert.ok(success(mutation), mutation.text);
      committedSamples.push(fence.grantId);
      const immediate = await Promise.all(apis.map((api) => ctx.request(api.baseUrl, `/api/v1/grants/${fence.grantId}/check`)));
      assert.ok(immediate.every((response) => response.status === 200 && response.json?.active === false));
    }
    await ctx.waitFor(() => barrier.ledger.length >= 4, { label: "four revocation work claims", children: killed });
    await Promise.all(killed.map((worker) => ctx.stop(worker, "SIGKILL")));
    release({ status: 204 });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const webhook = await ctx.receiver();
    const dispatchers = await Promise.all(Array.from({ length: 4 }, () => ctx.startDispatcher(webhook.url)));
    snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(apis[0].baseUrl);
      return value.work.length >= 4 && value.work.every(({ terminal }) => terminal) ? value : undefined;
    }, { timeoutMs: 45_000, label: "revocation fence recovery", children: [...replacements, ...dispatchers] });
    checks = await fixedLoad(ctx, grantCount, 64, async (index) => {
      const response = await ctx.request(apis[index % 2].baseUrl, `/api/v1/grants/${id(8_000_000 + index)}/check`);
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json?.active, false);
      return response;
    });
    assertLoad(checks, "revocation-fence-recovery", 1, 10_000, scale);
  } finally {
    monitorRunning = false;
    await monitor;
  }
  if (monitorFailure) throw monitorFailure;
  assert.ok(monitorChecks > 0, "continuous post-commit grant monitor did not execute");
  const convergenceMs = performance.now() - convergenceStarted;
  assert.ok(scale !== 1 || convergenceMs <= 45_000);
  return finishPerformanceScenario(ctx, apis[0].baseUrl, snapshot, {
    scenarioId: "revocation-fence-recovery", publicCount: 50_000, actualCount: grantCount,
    convergenceMs, killedWorkers: 4, replacementWorkers: 4, continuousChecks: monitorChecks, scale, ...checks,
  }, [
    "device, session, principal, and tenant fence commits failed closed immediately through both APIs",
    "four claimed workers were killed and four replacements drained all Work",
    "continuous checks observed no stale active grant after commit and every grant failed closed after recovery",
  ]);
}

async function accessSentinelPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];
  metrics.push(await sessionRefreshPerformance(ctx, scale));
  metrics.push(await accessIngestPerformance(ctx, scale));
  metrics.push(await policyHotsetPerformance(ctx, scale));
  metrics.push(await locationReplayPerformance(ctx, scale));
  metrics.push(await revocationFanoutPerformance(ctx, scale));
  metrics.push(await auditAppendPerformance(ctx, scale));
  metrics.push(await outboxRecoveryPerformance(ctx, scale));
  metrics.push(await revocationFencePerformance(ctx, scale));
  assertions.push("all eight fixed sustained scenarios met their load and post-load security invariants");
  return {
    metrics,
    topology: metrics.at(-1).topology,
    rssBytes: Math.max(...metrics.map(({ rssBytes }) => rssBytes)),
    databaseBytes: Math.max(...metrics.map(({ databaseBytes }) => databaseBytes ?? 0)),
  };
}

export default standardAdapter(spec);
