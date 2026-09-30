import { geometryFixture, identityFixture, lateWorkedExample, timelineFixture } from "../fixtures/index.mjs";
import { replayArrivals } from "../oracles/index.mjs";
import {
  acceptBatch,
  acceptEvent,
  assertNoSnapshotChange,
  assertProjection,
  coreFixture,
  createBundle,
  errorCode,
  expectError,
  expectStableRejection,
  finalEvidence,
  guardedCase,
  publishBundle,
  queryRegions,
  readBundle,
  resource,
  rollbackBundle,
  stableSnapshot,
  startPreparedApi,
  transitionProjection,
  waitForDrain,
} from "./helpers.mjs";

const correctness = ["CORRECTNESS_INVARIANT"];

const a01 = guardedCase({
  id: "A-01",
  fixtureFamily: "GP-F-GEOMETRY",
  action: "Create adjacent RegionVersions, query exact edge and vertex points, submit observedAt-crossing events, and reject invalid geometry over public HTTP.",
  oracle: "Independent integer-microdegree polygon classification and half-open effective intervals determine BOUNDARY and the sole selected immutable RegionVersion.",
  async run(ctx) {
    const geometry = geometryFixture(ctx.fixtures);
    const seed = coreFixture(ctx);
    const earlyDeviceId = ctx.uuid("device-early-version");
    seed.devices.push({ deviceId: earlyDeviceId, tenantId: geometry.tenantId, externalRef: "early-version-device", createdAt: ctx.at({ days: -2 }) });
    seed.regionVersions = [
      ...geometry.versions,
      ...seed.regionVersions.filter(({ regionId }) => regionId !== geometry.regionId),
    ];
    const api = await startPreparedApi(ctx, { seed });
    const points = [
      { queryId: "edge-before", ...geometry.edge, at: ctx.at({ hours: -1 }) },
      { queryId: "vertex-after", ...geometry.vertex, at: ctx.at({ seconds: 1 }) },
      { queryId: "inside-after", longitude: 0.015, latitude: 0.005, at: ctx.at({ seconds: 1 }) },
    ];
    const queried = await queryRegions(ctx, api.baseUrl, geometry.tenantId, points);
    ctx.equal(queried.items[0].matches, [{ regionId: geometry.regionId, regionVersionId: geometry.versions[0].regionVersionId }], "edge query matches the observedAt-active version");
    ctx.equal(queried.items[1].matches, [{ regionId: geometry.regionId, regionVersionId: geometry.versions[1].regionVersionId }], "vertex query is a match in the next half-open interval");
    ctx.equal(queried.items[2].matches, [{ regionId: geometry.regionId, regionVersionId: geometry.versions[1].regionVersionId }], "expanded version is selected by at");

    const early = {
      eventId: ctx.uuid("observed-version-early"), tenantId: geometry.tenantId, deviceId: earlyDeviceId,
      deviceSequence: 1, observedAt: ctx.at({ hours: -1 }), longitude: 0.015, latitude: 0.005, accuracyMeters: 2,
    };
    const later = {
      eventId: ctx.uuid("observed-version-later"), tenantId: geometry.tenantId, deviceId: ctx.uuid("device"),
      deviceSequence: 1, observedAt: ctx.at({ seconds: 1 }), longitude: 0.015, latitude: 0.005, accuracyMeters: 2,
    };
    await acceptBatch(ctx, api.baseUrl, [early, later]);
    const worker = await ctx.startWorker();
    const projected = await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    const earlyMembership = resource(projected, "memberships").find(({ deviceId, regionId }) => deviceId === earlyDeviceId && regionId === geometry.regionId);
    const laterMembership = resource(projected, "memberships").find(({ deviceId, regionId }) => deviceId === later.deviceId && regionId === geometry.regionId);
    ctx.equal({ state: earlyMembership?.state, regionVersionId: earlyMembership?.regionVersionId }, {
      state: "OUTSIDE", regionVersionId: geometry.versions[0].regionVersionId,
    }, "received later but observed earlier uses revision one", { hardCapIds: correctness });
    ctx.equal({ state: laterMembership?.state, regionVersionId: laterMembership?.regionVersionId }, {
      state: "INSIDE", regionVersionId: geometry.versions[1].regionVersionId,
    }, "observedAt after the boundary uses revision two", { hardCapIds: correctness });

    const beforeOverlap = await ctx.snapshot(api.baseUrl);
    const overlap = await ctx.mutate(api.baseUrl, `/api/v1/regions/${geometry.regionId}/versions`, ctx.key("overlap-version"), {
      effectiveFrom: ctx.at({ minutes: -30 }),
      effectiveTo: null,
      polygon: geometry.polygon,
      boundaryToleranceMeters: 5,
      dwellSeconds: 2,
    });
    expectError(ctx, overlap, 409, "REGION_REVISION_OVERLAP", "overlapping RegionVersion");
    assertNoSnapshotChange(ctx, beforeOverlap, await ctx.snapshot(api.baseUrl), "overlapping RegionVersion");

    const beforeGeometry = await ctx.snapshot(api.baseUrl);
    const invalidGeometry = await ctx.mutate(api.baseUrl, `/api/v1/regions/${geometry.regionId}/versions`, ctx.key("invalid-geometry"), {
      effectiveFrom: ctx.at({ days: 2 }),
      effectiveTo: null,
      polygon: geometry.selfIntersecting,
      boundaryToleranceMeters: 5,
      dwellSeconds: 2,
    });
    expectError(ctx, invalidGeometry, 400, "INVALID_GEOMETRY", "self-intersecting RegionVersion");
    assertNoSnapshotChange(ctx, beforeGeometry, await ctx.snapshot(api.baseUrl), "invalid geometry");
    return finalEvidence(ctx, { versions: geometry.versions.length, queryPoints: points.length, selectedByObservedAt: true });
  },
}, correctness);

const a02 = guardedCase({
  id: "A-02",
  fixtureFamily: "GP-F-IDENTITY",
  action: "Submit single and batch LocationEvents across same-body replay, eventId conflict, deviceSequence conflict, and one-bad-member atomic rejection.",
  oracle: "Before/after verification snapshots prove both permanent identities and zero LocationEvent, Work, Membership, Transition, or Event effects for a rejected batch.",
  async run(ctx) {
    const identity = identityFixture(ctx.fixtures);
    const seed = coreFixture(ctx, { includeOtherTenant: true });
    const api = await startPreparedApi(ctx, { seed });
    const first = await acceptEvent(ctx, api.baseUrl, identity.event, { key: ctx.key("identity-first") });
    const replay = await acceptEvent(ctx, api.baseUrl, identity.event, { key: ctx.key("identity-replay") });
    ctx.equal({ status: replay.status, json: replay.json }, { status: first.status, json: first.json }, "canonical event replay returns the original result", { hardCapIds: correctness });

    expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/location-events", ctx.key("event-id-conflict"), identity.sameEventIdDifferentBody), 409, "EVENT_ID_CONFLICT", "eventId conflict");
    expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/location-events", ctx.key("device-sequence-conflict"), identity.sameSequenceDifferentEventId), 409, "DEVICE_SEQUENCE_CONFLICT", "device sequence conflict");

    const beforeInvalid = await ctx.snapshot(api.baseUrl);
    const valid = { ...identity.event, eventId: ctx.uuid("batch-valid"), deviceSequence: 2, observedAt: ctx.at({ seconds: 2 }) };
    const invalid = { ...valid, eventId: ctx.uuid("batch-invalid"), deviceSequence: 3, latitude: 90.000001 };
    const badBatch = await acceptBatch(ctx, api.baseUrl, [valid, invalid], { expectedStatus: 400, key: ctx.key("invalid-batch"), contractExpectation: "invalid" });
    ctx.equal(errorCode(badBatch), "INVALID_REQUEST", "invalid batch semantic error");
    assertNoSnapshotChange(ctx, beforeInvalid, await ctx.snapshot(api.baseUrl), "invalid batch");

    const beforeConflict = await ctx.snapshot(api.baseUrl);
    const conflictBatch = await acceptBatch(ctx, api.baseUrl, [valid, identity.sameEventIdDifferentBody], { expectedStatus: 409, key: ctx.key("conflicting-batch") });
    ctx.equal(errorCode(conflictBatch), "EVENT_ID_CONFLICT", "conflicting batch semantic error");
    assertNoSnapshotChange(ctx, beforeConflict, await ctx.snapshot(api.baseUrl), "conflicting batch");
    const final = await ctx.snapshot(api.baseUrl);
    ctx.equal(resource(final, "locationEvents").filter(({ eventId }) => eventId === identity.event.eventId).length, 1, "one canonical LocationEvent");
    ctx.equal((final.work ?? []).filter(({ aggregateId }) => aggregateId === identity.event.eventId).length, 1, "one Work set for the canonical event");
    return finalEvidence(ctx, { canonicalEvents: resource(final, "locationEvents").length, rejectedBatches: 2 });
  },
}, correctness);

const a03 = guardedCase({
  id: "A-03",
  fixtureFamily: "GP-F-TIMELINE",
  action: "Ingest an outside-to-edge jitter timeline at dwell-minus-one-millisecond, threshold, exit, and re-entry, then drain the real Worker.",
  oracle: "Evaluator-owned signed edge distance and hysteresis state machine requires ENTER,DWELL,EXIT,ENTER once with contiguous sequence and monotonic Membership revision.",
  async run(ctx) {
    const timeline = timelineFixture(ctx.fixtures);
    const seed = coreFixture(ctx);
    seed.regionVersions = [timeline.regionVersion, ...seed.regionVersions.filter(({ regionId }) => regionId !== timeline.regionVersion.regionId)];
    const api = await startPreparedApi(ctx, { seed });
    for (const event of timeline.events) await acceptEvent(ctx, api.baseUrl, event);
    const workers = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: workers });
    const checked = assertProjection(ctx, snapshot, timeline.events, timeline.regionVersion);
    ctx.equal(checked.transitions.map(({ type }) => type), ["ENTER", "DWELL", "EXIT", "ENTER"], "hysteresis and dwell transition sequence", { hardCapIds: correctness });
    ctx.equal(new Set(checked.transitions.map(({ sourceEventId, type }) => `${sourceEventId}:${type}`)).size, checked.transitions.length, "source/type uniqueness", { hardCapIds: correctness });
    return finalEvidence(ctx, { observations: timeline.events.length, transitions: checked.transitions.length });
  },
}, correctness);

async function runLatePermutation(ctx, worked, arrivals, includeOld = false) {
  const seed = coreFixture(ctx);
  seed.regionVersions = [worked.regionVersion, ...seed.regionVersions.filter(({ regionId }) => regionId !== worked.regionVersion.regionId)];
  const api = await startPreparedApi(ctx, { seed });
  const worker = await ctx.startWorker();
  for (const event of arrivals) {
    await acceptEvent(ctx, api.baseUrl, event, { key: ctx.key(`arrival-${event.deviceSequence}`) });
    await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
  }
  const beforeOld = includeOld ? stableSnapshot(await ctx.snapshot(api.baseUrl)) : undefined;
  if (includeOld) {
    await acceptEvent(ctx, api.baseUrl, worked.tooOld, { key: ctx.key("too-old") });
    await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
  }
  const snapshot = await ctx.snapshot(api.baseUrl);
  const membership = resource(snapshot, "memberships").find(({ deviceId, regionId }) => deviceId === arrivals[0].deviceId && regionId === worked.regionVersion.regionId);
  const transitions = resource(snapshot, "transitions").filter(({ deviceId, regionId }) => deviceId === arrivals[0].deviceId && regionId === worked.regionVersion.regionId).sort((left, right) => left.sequence - right.sequence);
  return { api, snapshot, beforeOld, membership, transitions };
}

const a04 = guardedCase({
  id: "A-04",
  fixtureFamily: "GP-F-LATE-GP-W1",
  action: "Run GP-W1 once in canonical order and once in reverse arrival order with per-arrival Worker drainage, then append an event older than watermark minus ten minutes.",
  oracle: "Full deterministic replay over observedAt,deviceSequence,eventId must converge to the same Membership and Transition identities; the old frontier only appends LATE_IGNORED.",
  async run(ctx) {
    const worked = lateWorkedExample(ctx.fixtures);
    const canonical = await runLatePermutation(ctx, worked, worked.canonical);
    const canonicalProjection = {
      membership: canonical.membership,
      transitions: canonical.transitions,
    };
    await ctx.resetDatabase();
    const reverse = await runLatePermutation(ctx, worked, worked.arrivalOrder, true);
    const semantic = (value) => ({
      membership: value.membership && {
        state: value.membership.state,
        enteredAt: value.membership.enteredAt,
        lastObservedAt: value.membership.lastObservedAt,
        lastDeviceSequence: value.membership.lastDeviceSequence,
        watermark: value.membership.watermark,
        regionVersionId: value.membership.regionVersionId,
      },
      transitions: value.transitions.map(transitionProjection),
    });
    ctx.equal(semantic(reverse), semantic(canonicalProjection), "reverse arrival replay converges with canonical processing", { hardCapIds: correctness });
    const expected = replayArrivals(worked.arrivalOrder, worked.regionVersion);
    ctx.equal(reverse.transitions.map(transitionProjection), expected.projection.transitions, "GP-W1 independent replay oracle", { hardCapIds: correctness });
    const beforeResources = reverse.beforeOld.resources;
    ctx.equal(resource(reverse.snapshot, "memberships"), beforeResources.memberships, "too-old event cannot rewrite Membership", { hardCapIds: correctness });
    ctx.equal(resource(reverse.snapshot, "transitions"), beforeResources.transitions, "too-old event cannot rewrite published Transitions", { hardCapIds: correctness });
    ctx.equal(resource(reverse.snapshot, "locationEvents").some(({ eventId }) => eventId === worked.tooOld.eventId), true, "too-old LocationEvent remains stored");
    ctx.ok((reverse.snapshot.events ?? []).some((event) => event.type === "location.late_ignored" && (event.aggregateId === worked.tooOld.eventId || JSON.stringify(event).includes(worked.tooOld.eventId))), "too-old event appends location.late_ignored");
    return finalEvidence(ctx, { permutations: 2, transitionCount: reverse.transitions.length, lateIgnored: 1 });
  },
}, correctness);

const a05 = guardedCase({
  id: "A-05",
  fixtureFamily: "GP-F-BUNDLE",
  action: "Create a RegionBundle, publish unsorted duplicate members, accept frozen work, publish a new member set, roll back by copying revision one, query, and reject an empty publication.",
  oracle: "Immutable sorted revisions, CAS lineage, snapshot zero-delta rejection, Membership pinning and one-revision query results prove atomic Bundle composition and rollback.",
  async run(ctx) {
    const seed = coreFixture(ctx);
    const tenantId = seed.tenants[0].tenantId;
    const [firstVersion, secondVersion] = seed.regionVersions;
    const api = await startPreparedApi(ctx, { seed });
    const bundle = await createBundle(ctx, api.baseUrl, tenantId);
    const revision1 = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 0,
      effectiveFrom: ctx.at({ hours: -1 }),
      regionVersionIds: [secondVersion.regionVersionId, firstVersion.regionVersionId, secondVersion.regionVersionId],
    });
    ctx.equal(revision1.revision.regionVersionIds, [firstVersion.regionVersionId, secondVersion.regionVersionId].sort(), "published members are sorted and deduplicated");
    const frozenRevision1 = structuredClone(revision1.revision);

    const beforeInvalid = await ctx.snapshot(api.baseUrl);
    const invalid = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 1,
      effectiveFrom: ctx.at({ minutes: 30 }),
      regionVersionIds: [],
    }, { allowFailure: true, key: ctx.key("empty-bundle"), contractExpectation: "invalid" });
    expectStableRejection(ctx, invalid, [400, 409], "empty RegionBundle publication");
    assertNoSnapshotChange(ctx, beforeInvalid, await ctx.snapshot(api.baseUrl), "empty RegionBundle publication");

    const oldEvent = {
      eventId: ctx.uuid("bundle-old-event"), tenantId, deviceId: seed.devices[0].deviceId,
      deviceSequence: 1, observedAt: ctx.at({ seconds: 1 }), longitude: 0.005, latitude: 0.005, accuracyMeters: 2,
    };
    await acceptEvent(ctx, api.baseUrl, oldEvent);
    await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 1,
      effectiveFrom: ctx.at({ hours: 1 }),
      regionVersionIds: [secondVersion.regionVersionId],
    });
    const rolledBack = await rollbackBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 2,
      targetRevision: 1,
      effectiveFrom: ctx.at({ hours: 2 }),
    });
    ctx.equal(rolledBack.revision.revision, 3, "rollback creates revision three");
    ctx.equal(rolledBack.revision.regionVersionIds, frozenRevision1.regionVersionIds, "rollback copies target members");
    const detail = await readBundle(ctx, api.baseUrl, bundle.bundleId);
    ctx.equal(detail.revisions.find(({ revision }) => revision === 1), frozenRevision1, "revision one remains immutable");

    const worker = await ctx.startWorker();
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    const oldMembership = resource(snapshot, "memberships").find(({ deviceId, regionId }) => deviceId === oldEvent.deviceId && regionId === firstVersion.regionId);
    ctx.equal(oldMembership?.bundleRevisionId, revision1.revision.bundleRevisionId, "accepted old event remains pinned to revision one", { hardCapIds: correctness });
    const queried = await queryRegions(ctx, api.baseUrl, tenantId, [{ queryId: "rolled-back", longitude: 0.005, latitude: 0.005, at: ctx.at({ hours: 2, seconds: 1 }) }]);
    ctx.equal(queried.bundleRevisionId, rolledBack.revision.bundleRevisionId, "query publishes one rollback revision");
    ctx.equal(queried.items[0].matches, [{ regionId: firstVersion.regionId, regionVersionId: firstVersion.regionVersionId }], "rollback query matches copied member set");
    return ctx.pass({
      evidence: [{ kind: "geopulse-case-summary", revisions: detail.revisions.length, oldEventPinned: true }],
    });
  },
}, correctness);

export const A_CASES = Object.freeze([a01, a02, a03, a04, a05]);
