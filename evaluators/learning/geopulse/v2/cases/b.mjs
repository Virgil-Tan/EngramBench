import { identityFixture, timelineFixture } from "../fixtures/index.mjs";
import { classifyPoint } from "../oracles/index.mjs";
import {
  acceptEvent,
  assertEvents,
  assertProjection,
  coreFixture,
  createBundle,
  errorCode,
  expectError,
  expectSuccess,
  finalEvidence,
  guardedCase,
  killLeasedWork,
  publishBundle,
  queryRegions,
  readBundle,
  resource,
  rollbackBundle,
  scaleRegionSeed,
  startPreparedApi,
  waitForDrain,
} from "./helpers.mjs";

const correctness = ["CORRECTNESS_INVARIANT"];

const b01 = guardedCase({
  id: "B-01",
  fixtureFamily: "GP-F-GEOMETRY-RANDOM-SEED",
  action: "Publish two saved-seed RegionVersions, submit input-ordered inside/outside/edge point batches and a jitter timeline, then read public projection state.",
  oracle: "Evaluator-owned exact edge predicates, planar edge distance, hysteresis and dwell model independently derives every match, Membership field and Transition semantic identity.",
  async run(ctx) {
    const timeline = timelineFixture(ctx.fixtures);
    const seed = coreFixture(ctx);
    seed.regionVersions = [timeline.regionVersion, ...seed.regionVersions.filter(({ regionId }) => regionId !== timeline.regionVersion.regionId)];
    const api = await startPreparedApi(ctx, { seed });
    const bundle = await createBundle(ctx, api.baseUrl, seed.tenants[0].tenantId, { name: "Reference Model Bundle" });
    const published = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 0,
      effectiveFrom: ctx.at({ hours: -1 }),
      regionVersionIds: seed.regionVersions.map(({ regionVersionId }) => regionVersionId).reverse(),
    });
    const points = [
      { queryId: "inside", longitude: 0.005, latitude: 0.005, at: ctx.at({ seconds: 1 }) },
      { queryId: "edge", longitude: 0.01, latitude: 0.005, at: ctx.at({ seconds: 1 }) },
      { queryId: "outside", longitude: 0.015, latitude: 0.005, at: ctx.at({ seconds: 1 }) },
      { queryId: "second", longitude: 0.025, latitude: 0.025, at: ctx.at({ seconds: 1 }) },
    ];
    const result = await queryRegions(ctx, api.baseUrl, seed.tenants[0].tenantId, points);
    ctx.equal(result.bundleRevisionId, published.revision.bundleRevisionId, "query freezes the published Bundle revision");
    const expected = points.map((point) => ({
      queryId: point.queryId,
      matches: seed.regionVersions
        .filter((version) => classifyPoint(version.polygon, point).state !== "OUTSIDE")
        .map(({ regionId, regionVersionId }) => ({ regionId, regionVersionId }))
        .sort((left, right) => left.regionId.localeCompare(right.regionId) || left.regionVersionId.localeCompare(right.regionVersionId)),
    }));
    ctx.equal(result.items, expected, "public spatial query equals independent geometry oracle", { hardCapIds: correctness });
    for (const event of timeline.events) await acceptEvent(ctx, api.baseUrl, event);
    const workers = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: workers });
    assertProjection(ctx, snapshot, timeline.events, timeline.regionVersion);
    return finalEvidence(ctx, { queryPoints: points.length, observations: timeline.events.length, bundleRevisionId: result.bundleRevisionId });
  },
}, correctness);

const b02 = guardedCase({
  id: "B-02",
  fixtureFamily: "GP-F-IDENTITY-RESPONSE-SHIELD",
  action: "Drop one committed mutation response, replay through a second API, vary the same Idempotency-Key body, then exercise eventId, deviceSequence and tenant scopes.",
  oracle: "Captured upstream status/body plus a public snapshot prove durable request replay is separate from both event identities and creates at most one Work per canonical event.",
  async run(ctx) {
    const identity = identityFixture(ctx.fixtures);
    const seed = coreFixture(ctx, { includeOtherTenant: true });
    const target = await (async () => {
      const prepared = await startPreparedApi(ctx, { seed });
      const second = await ctx.startApi();
      return { first: prepared, second };
    })();
    const shield = await ctx.responseShield(target.first.baseUrl);
    const key = ctx.key("unknown-response");
    shield.dropNextMutation();
    await ctx.mutate(shield.baseUrl, "/api/v1/location-events", key, identity.event).then(
      () => ctx.fail("response shield did not create an unknown mutation outcome"),
      () => {},
    );
    const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "committed dropped response" });
    const replay = await ctx.mutate(target.second.baseUrl, "/api/v1/location-events", key, identity.event);
    ctx.equal({ status: replay.status, body: replay.text }, { status: capture.response.status, body: capture.response.body }, "unknown outcome replays original status and body", { hardCapIds: correctness });
    expectError(ctx, await ctx.mutate(target.second.baseUrl, "/api/v1/location-events", key, identity.sameEventIdDifferentBody), 409, "IDEMPOTENCY_CONFLICT", "same key different body");

    const eventReplay = await ctx.mutate(target.first.baseUrl, "/api/v1/location-events", ctx.key("new-key-same-event"), identity.event);
    ctx.equal({ status: eventReplay.status, json: eventReplay.json }, { status: replay.status, json: replay.json }, "new request key with same canonical event returns its original result");
    expectError(ctx, await ctx.mutate(target.second.baseUrl, "/api/v1/location-events", ctx.key("new-key-same-sequence"), identity.sameSequenceDifferentEventId), 409, "DEVICE_SEQUENCE_CONFLICT", "new key same device sequence");

    const otherTenantEvent = { ...identity.otherTenant, eventId: ctx.uuid("other-tenant-event") };
    expectSuccess(ctx, await ctx.mutate(target.second.baseUrl, "/api/v1/location-events", key, otherTenantEvent), "same request key in another tenant");
    const snapshot = await ctx.snapshot(target.first.baseUrl);
    ctx.equal(resource(snapshot, "locationEvents").length, 2, "one canonical event per tenant");
    ctx.equal((snapshot.work ?? []).filter(({ kind }) => kind === "LOCATION_EVALUATION").length, 2, "one evaluation Work per canonical event");
    ctx.equal(new Set(resource(snapshot, "locationEvents").map(({ tenantId }) => tenantId)).size, 2, "tenant identity remains isolated", { hardCapIds: correctness });
    return finalEvidence(ctx, { apiProcesses: 2, canonicalEvents: 2, droppedResponses: 1 });
  },
}, correctness);

const b03 = guardedCase({
  id: "B-03",
  fixtureFamily: "GP-F-HOT-DEVICE",
  action: "Race 64 distinct bodies for one Device sequence and 64 same-body submissions for another Device across two APIs, then drain four Workers.",
  oracle: "Only one canonical identity wins each hotspot; snapshot Membership uniqueness, monotonic revision and source/type plus contiguous sequence prove deterministic convergence.",
  async run(ctx) {
    const seed = coreFixture(ctx);
    const tenantId = seed.tenants[0].tenantId;
    const secondDeviceId = ctx.uuid("hot-device-second");
    seed.devices.push({ deviceId: secondDeviceId, tenantId, externalRef: "hot-second", createdAt: ctx.at({ days: -2 }) });
    const api1 = await startPreparedApi(ctx, { seed });
    const api2 = await ctx.startApi();
    const observedAt = ctx.at({ seconds: 10 });
    const contenders = Array.from({ length: 64 }, (_, index) => ({
      eventId: ctx.uuid(`hot-sequence-${index}`), tenantId, deviceId: seed.devices[0].deviceId,
      deviceSequence: 1, observedAt, longitude: (1_000 + index) / 1_000_000, latitude: 0.005, accuracyMeters: 2,
    }));
    const sequenceRace = await ctx.concurrent(contenders, 64, (event, index) => ctx.mutate(
      index % 2 ? api1.baseUrl : api2.baseUrl, "/api/v1/location-events", ctx.key(`hot-sequence-${index}`), event,
    ));
    ctx.equal(sequenceRace.filter(({ status }) => status === 200).length, 1, "one Device sequence contender wins", { hardCapIds: correctness });
    ctx.equal(sequenceRace.filter(({ status }) => status === 409).length, 63, "sequence losers return conflicts");
    for (const response of sequenceRace.filter(({ status }) => status !== 200)) ctx.equal(errorCode(response), "DEVICE_SEQUENCE_CONFLICT", "hot sequence loser category");

    const repeated = {
      eventId: ctx.uuid("hot-repeated-event"), tenantId, deviceId: secondDeviceId,
      deviceSequence: 1, observedAt, longitude: 0.005, latitude: 0.005, accuracyMeters: 2,
    };
    const eventRace = await ctx.concurrent(Array.from({ length: 64 }), 64, (_unused, index) => ctx.mutate(
      index % 2 ? api1.baseUrl : api2.baseUrl, "/api/v1/location-events", ctx.key(`hot-event-${index}`), repeated,
    ));
    ctx.ok(eventRace.every(({ status }) => status === 200), "same canonical event contenders all replay success");
    const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const snapshot = await waitForDrain(ctx, api1.baseUrl, { processes: workers });
    ctx.equal(resource(snapshot, "locationEvents").length, 2, "two hotspot identities create two LocationEvents", { hardCapIds: correctness });
    ctx.equal((snapshot.work ?? []).filter(({ kind }) => kind === "LOCATION_EVALUATION").length, 2, "losers create no Work", { hardCapIds: correctness });
    for (const deviceId of [seed.devices[0].deviceId, secondDeviceId]) {
      const memberships = resource(snapshot, "memberships").filter(({ deviceId: value, regionId }) => value === deviceId && regionId === seed.regions[0].regionId);
      ctx.equal(memberships.length, 1, `one Membership for ${deviceId}`, { hardCapIds: correctness });
      const transitions = resource(snapshot, "transitions").filter(({ deviceId: value }) => value === deviceId);
      ctx.equal(new Set(transitions.map(({ deviceId, regionId, sourceEventId, type }) => `${deviceId}:${regionId}:${sourceEventId}:${type}`)).size, transitions.length, "Transition source/type uniqueness per device/region", { hardCapIds: correctness });
    }
    assertEvents(ctx, snapshot.events ?? []);
    return finalEvidence(ctx, { sequenceContenders: 64, eventContenders: 64, workers: 4 });
  },
}, correctness);

const b04 = guardedCase({
  id: "B-04",
  fixtureFamily: "GP-F-BUNDLE-CAS",
  action: "Race publish and rollback at the same expectedRevision through two API processes, then immediately read both APIs and execute identical point queries.",
  oracle: "Exactly one CAS winner adds one immutable revision, Work and Event; both APIs expose the winner revision and independently computed match set without stale cache mixing.",
  async run(ctx) {
    const seed = coreFixture(ctx);
    const api1 = await startPreparedApi(ctx, { seed });
    const api2 = await ctx.startApi();
    const bundle = await createBundle(ctx, api1.baseUrl, seed.tenants[0].tenantId);
    const initial = await publishBundle(ctx, api1.baseUrl, bundle.bundleId, {
      expectedRevision: 0,
      effectiveFrom: ctx.at({ hours: -1 }),
      regionVersionIds: seed.regionVersions.map(({ regionVersionId }) => regionVersionId),
    });
    const before = await ctx.snapshot(api1.baseUrl);
    const effectiveFrom = ctx.at({ hours: 1 });
    const [publish, rollback] = await Promise.all([
      publishBundle(ctx, api1.baseUrl, bundle.bundleId, {
        expectedRevision: 1, effectiveFrom, regionVersionIds: [seed.regionVersions[1].regionVersionId],
      }, { allowFailure: true, key: ctx.key("cas-publish") }),
      rollbackBundle(ctx, api2.baseUrl, bundle.bundleId, {
        expectedRevision: 1, targetRevision: 1, effectiveFrom,
      }, { allowFailure: true, key: ctx.key("cas-rollback") }),
    ]);
    const winner = [publish, rollback].find(({ status }) => status === 200);
    const loser = [publish, rollback].find(({ status }) => status !== 200);
    ctx.ok(winner && loser, "publish/rollback CAS has one winner and one loser", { hardCapIds: correctness });
    ctx.equal(loser.status, 409, "CAS loser status");
    ctx.equal(errorCode(loser), "BUNDLE_REVISION_CONFLICT", "CAS loser semantic category");
    const winnerRevisionId = winner.json?.revision?.bundleRevisionId;
    ctx.ok(typeof winnerRevisionId === "string", "CAS winner returns one Bundle revision");
    for (const api of [api1, api2]) {
      const detail = await readBundle(ctx, api.baseUrl, bundle.bundleId);
      ctx.equal(detail.bundle.currentBundleRevisionId, winnerRevisionId, "API cache sees the CAS winner");
      const query = await queryRegions(ctx, api.baseUrl, seed.tenants[0].tenantId, [{ queryId: "cache-check", longitude: 0.025, latitude: 0.025, at: ctx.at({ hours: 1, seconds: 1 }) }]);
      ctx.equal(query.bundleRevisionId, winnerRevisionId, "point query sees the same winner revision");
    }
    const after = await ctx.snapshot(api1.baseUrl);
    ctx.equal(resource(after, "regionBundleRevisions").length - resource(before, "regionBundleRevisions").length, 1, "one CAS revision committed", { hardCapIds: correctness });
    ctx.equal((after.work ?? []).length - (before.work ?? []).length, 1, "one reevaluation Work committed", { hardCapIds: correctness });
    ctx.equal((after.events ?? []).length - (before.events ?? []).length, 1, "one Bundle Event committed", { hardCapIds: correctness });
    ctx.equal(resource(after, "regionBundleRevisions").find(({ revision }) => revision === 1), initial.revision, "initial revision remains immutable");
    return ctx.pass({
      evidence: [{ kind: "geopulse-case-summary", apiProcesses: 2, casWinners: 1 }],
    });
  },
}, correctness);

const b05 = guardedCase({
  id: "B-05",
  fixtureFamily: "GP-F-BUNDLE-RECOVERY",
  action: "Observe old LOCATION_EVALUATION Work as LEASED, SIGKILL its Worker, publish a new Bundle revision, reclaim the lease, accept a new event and trigger late replay.",
  oracle: "Transition source lineage and public Membership bundleRevisionId prove old and new events retain captured authority while replacement Work converges without mixed member sets.",
  async run(ctx) {
    const seed = scaleRegionSeed(ctx, 100, 2);
    const tenantId = seed.tenants[0].tenantId;
    const primaryVersion = seed.regionVersions[0];
    const api = await startPreparedApi(ctx, { seed });
    const bundle = await createBundle(ctx, api.baseUrl, tenantId);
    const members = seed.regionVersions.map(({ regionVersionId }) => regionVersionId).sort();
    const first = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 0, effectiveFrom: ctx.at({ hours: -1 }), regionVersionIds: members,
    });
    const warmWorker = await ctx.startWorker();
    await waitForDrain(ctx, api.baseUrl, { processes: [warmWorker] });
    await ctx.stop(warmWorker);
    const oldEvent = {
      eventId: ctx.uuid("frozen-old-event"), tenantId, deviceId: seed.devices[0].deviceId,
      deviceSequence: 2, observedAt: ctx.at({ seconds: 20 }), longitude: 0.005, latitude: 0.005, accuracyMeters: 2,
    };
    await acceptEvent(ctx, api.baseUrl, oldEvent);
    await killLeasedWork(ctx, api.baseUrl, { kind: "LOCATION_EVALUATION", aggregateId: oldEvent.eventId });
    const nextMembers = [primaryVersion.regionVersionId, ...members.filter((id) => id !== primaryVersion.regionVersionId).slice(0, 49)].sort();
    const second = await publishBundle(ctx, api.baseUrl, bundle.bundleId, {
      expectedRevision: 1, effectiveFrom: ctx.at({ hours: 1 }), regionVersionIds: nextMembers,
    });
    const replacement = await ctx.startWorker();
    await waitForDrain(ctx, api.baseUrl, { processes: [replacement] });
    const newEvent = {
      eventId: ctx.uuid("frozen-new-event"), tenantId, deviceId: seed.devices[1].deviceId,
      deviceSequence: 1, observedAt: ctx.at({ hours: 1, seconds: 2 }), longitude: 0.005, latitude: 0.005, accuracyMeters: 2,
    };
    await acceptEvent(ctx, api.baseUrl, newEvent);
    const late = {
      eventId: ctx.uuid("frozen-late-event"), tenantId, deviceId: seed.devices[0].deviceId,
      deviceSequence: 1, observedAt: ctx.at({ seconds: 10 }), longitude: 0.02, latitude: 0.005, accuracyMeters: 2,
    };
    await acceptEvent(ctx, api.baseUrl, late);
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [replacement] });
    const oldTransition = resource(snapshot, "transitions").find(({ sourceEventId, regionId }) => sourceEventId === oldEvent.eventId && regionId === primaryVersion.regionId);
    const oldMembership = resource(snapshot, "memberships").find(({ deviceId, regionId }) => deviceId === oldEvent.deviceId && regionId === primaryVersion.regionId);
    const newMembership = resource(snapshot, "memberships").find(({ deviceId, regionId }) => deviceId === newEvent.deviceId && regionId === primaryVersion.regionId);
    ctx.equal(oldTransition?.bundleRevisionId, first.revision.bundleRevisionId, "old event Transition retains revision one", { hardCapIds: correctness });
    ctx.equal(oldMembership?.bundleRevisionId, first.revision.bundleRevisionId, "late replay converges under the final canonical event captured revision", { hardCapIds: correctness });
    ctx.equal(newMembership?.bundleRevisionId, second.revision.bundleRevisionId, "new event uses revision two", { hardCapIds: correctness });
    ctx.ok((snapshot.work ?? []).every(({ terminal }) => terminal), "all old, reevaluation, new and replay Work is terminal");
    ctx.equal(new Set(resource(snapshot, "transitions").map(({ deviceId, regionId, sourceEventId, type }) => `${deviceId}:${regionId}:${sourceEventId}:${type}`)).size, resource(snapshot, "transitions").length, "no duplicated Transition effect per device/region", { hardCapIds: correctness });
    return ctx.pass({
      evidence: [{ kind: "geopulse-case-summary", killedWorkers: 1, bundleRevisions: 2, recovered: true }],
    });
  },
}, correctness);

export const B_CASES = Object.freeze([b01, b02, b03, b04, b05]);
