import assert from "node:assert/strict";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `41000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const regionId = id(2);
const regionVersionId = id(3);
const secondRegionId = id(4);
const secondRegionVersionId = id(5);
const createdAt = "2026-01-01T00:00:00.000Z";
const polygon = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
const secondPolygon = [[10, 10], [10, 11], [11, 11], [11, 10], [10, 10]];
let migrationHistory;

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function devices(count = 100, firstId = 100) {
  return Array.from({ length: count }, (_, index) => ({
    deviceId: id(firstId + index), tenantId, externalRef: `device-${firstId + index}`, createdAt,
  }));
}

function regionRecord(valueRegionId, valueVersionId, revision, valuePolygon, index = 0) {
  return {
    region: { regionId: valueRegionId, tenantId, name: `Hidden Region ${index}`, createdAt },
    version: {
      regionVersionId: valueVersionId, regionId: valueRegionId, tenantId, revision,
      effectiveFrom: createdAt, effectiveTo: null, polygon: valuePolygon,
      boundaryToleranceMeters: 10, dwellSeconds: 3_600, createdAt,
    },
  };
}

function seed(seedVersion = "hidden-geopulse") {
  const first = regionRecord(regionId, regionVersionId, 1, polygon, 1);
  first.version.effectiveTo = "2026-11-01T00:00:00.000Z";
  const second = regionRecord(secondRegionId, secondRegionVersionId, 1, secondPolygon, 2);
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Geo Tenant" }],
    devices: devices(),
    regions: [first.region, second.region],
    regionVersions: [first.version, second.version],
    locationEvents: [], memberships: [], transitions: [],
  };
}

function eventPayload(index, overrides = {}) {
  const deviceIndex = index % 100;
  const sequence = Math.floor(index / 100) + 1;
  return {
    eventId: id(10_000 + index), tenantId, deviceId: id(100 + deviceIndex), deviceSequence: sequence,
    observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    longitude: 0.5, latitude: 0.5, accuracyMeters: 3, ...overrides,
  };
}

function exactEvent({ eventNumber, deviceId, sequence, observedAt, longitude, latitude }) {
  return {
    eventId: id(eventNumber), tenantId, deviceId, deviceSequence: sequence, observedAt,
    longitude, latitude, accuracyMeters: 3,
  };
}

function success(response) {
  return response.status >= 200 && response.status < 300;
}

function responseRevision(response) {
  const revision = response.json?.revision;
  assert.ok(revision && typeof revision === "object", `missing RegionBundleRevision: ${response.text}`);
  assert.deepEqual(Object.keys(revision).sort(), [
    "bundleId", "bundleRevisionId", "createdAt", "effectiveFrom", "regionVersionIds", "revision", "tenantId",
  ].sort());
  return revision;
}

function responseBundle(response) {
  const bundle = response.json?.bundle;
  assert.ok(bundle && typeof bundle === "object", `missing RegionBundle: ${response.text}`);
  assert.deepEqual(Object.keys(bundle).sort(), [
    "bundleId", "createdAt", "currentBundleRevisionId", "currentRevision", "name", "tenantId",
  ].sort());
  return bundle;
}

function v1Projection(value) {
  const { bundleRevisionId: _managerField, ...v1 } = value;
  return v1;
}

function assertContiguousTransitions(transitions) {
  const groups = new Map();
  for (const transition of transitions) {
    const key = `${transition.deviceId}:${transition.regionId}`;
    const values = groups.get(key) ?? [];
    values.push(transition);
    groups.set(key, values);
  }
  for (const values of groups.values()) {
    values.sort((left, right) => left.sequence - right.sequence);
    assert.deepEqual(values.map(({ sequence }) => sequence), Array.from({ length: values.length }, (_, index) => index + 1));
    assert.equal(new Set(values.map(({ transitionId }) => transitionId)).size, values.length);
    assert.equal(new Set(values.map(({ sourceEventId, type }) => `${sourceEventId}:${type}`)).size, values.length);
  }
}

async function waitForDrain(ctx, baseUrl, children, timeoutMs = 120_000) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs, label: "GeoPulse work drain", children });
}

const spec = {
  label: "GeoPulse LocationEvent acceptance",
  performanceScenarioIds: ["ordered-location-ingest", "boundary-jitter-convergence", "bulk-spatial-query"],
  seed: async () => seed(),
  path: "/api/v1/location-events",
  payload: (index) => eventPayload(index),
  conflictPayload: () => eventPayload(0, { longitude: 0.75 }),
  resource: "locationEvents",
  identity: (json) => find(json, "eventId"),
  resourceIdentity: ({ eventId }) => eventId,
  workIdentity: (json) => find(json, "eventId"),
  async afterPrepare(ctx, api, receiver, workspace) {
    if (workspace === ctx.workspace) return;

    const deviceId = id(190);
    const later = exactEvent({
      eventNumber: 90_002, deviceId, sequence: 2,
      observedAt: "2026-01-01T00:00:20.000Z", longitude: 2, latitude: 0.5,
    });
    const earlier = exactEvent({
      eventNumber: 90_001, deviceId, sequence: 1,
      observedAt: "2026-01-01T00:00:00.000Z", longitude: 0.5, latitude: 0.5,
    });
    for (const [key, payload] of [["h09-history-later", later], ["h09-history-earlier", earlier]]) {
      const accepted = await ctx.mutate(api.baseUrl, "/api/v1/location-events", key, payload);
      assert.ok(success(accepted), accepted.text);
    }

    const worker = await ctx.startWorker({}, workspace);
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(api.baseUrl);
      const transitions = snapshot.resources.transitions.filter((entry) => entry.deviceId === deviceId);
      const membership = snapshot.resources.memberships.find((entry) => entry.deviceId === deviceId && entry.regionId === regionId);
      return membership?.state === "OUTSIDE" && transitions.some(({ type }) => type === "ENTER")
        && transitions.some(({ type }) => type === "EXIT") ? snapshot : undefined;
    }, { timeoutMs: 60_000, label: "V1 membership projection", children: [worker] });
    await ctx.stop(worker);

    const late = exactEvent({
      eventNumber: 90_003, deviceId, sequence: 3,
      observedAt: "2026-01-01T00:00:10.000Z", longitude: 0.75, latitude: 0.5,
    });
    const lateResponse = await ctx.mutate(api.baseUrl, "/api/v1/location-events", "h09-history-late", late);
    assert.ok(success(lateResponse), lateResponse.text);

    let releaseWorker;
    const heldWorker = new Promise((resolve) => { releaseWorker = resolve; });
    const workerBarrier = await ctx.receiver((entry) => (
      entry.json?.point === "worker.claimed" && entry.json?.aggregateId === late.eventId
    ) ? heldWorker : { status: 204 });
    const staleWorker = await ctx.startWorker({
      TEST_BARRIER_URL: workerBarrier.url, TEST_BARRIER_TOKEN: "geopulse-h09-worker",
    }, workspace);
    await ctx.waitFor(() => workerBarrier.ledger.some((entry) => (
      entry.json?.point === "worker.claimed" && entry.json?.aggregateId === late.eventId
    )), { timeoutMs: 60_000, label: "V1 late replay claim", children: [staleWorker] });
    await ctx.stop(staleWorker, "SIGKILL");
    releaseWorker({ status: 204 });

    let releaseDispatcher;
    const heldDispatcher = new Promise((resolve) => { releaseDispatcher = resolve; });
    const dispatcherBarrier = await ctx.receiver((entry) => (
      entry.json?.point === "dispatcher.response-received"
    ) ? heldDispatcher : { status: 204 });
    const dispatcher = await ctx.startDispatcher(receiver.url, {
      TEST_BARRIER_URL: dispatcherBarrier.url, TEST_BARRIER_TOKEN: "geopulse-h09-dispatcher",
    }, workspace);
    await ctx.waitFor(() => dispatcherBarrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
      timeoutMs: 60_000, label: "V1 unconfirmed Event", children: [dispatcher],
    });
    await ctx.stop(dispatcher, "SIGKILL");
    releaseDispatcher({ status: 204 });

    const snapshot = await ctx.snapshot(api.baseUrl);
    migrationHistory = {
      deviceId,
      locationEvents: snapshot.resources.locationEvents.filter((entry) => entry.deviceId === deviceId).map((entry) => structuredClone(entry)),
      memberships: snapshot.resources.memberships.filter((entry) => entry.deviceId === deviceId).map((entry) => structuredClone(entry)),
      transitions: snapshot.resources.transitions.filter((entry) => entry.deviceId === deviceId).map((entry) => structuredClone(entry)),
      eventIds: snapshot.events.map(({ eventId }) => eventId),
      work: snapshot.work.filter(({ aggregateId }) => aggregateId === late.eventId).map((entry) => structuredClone(entry)),
    };
    assert.equal(migrationHistory.locationEvents.length, 3);
    assert.ok(migrationHistory.memberships.length > 0);
    assert.ok(migrationHistory.transitions.length >= 2);
    assert.ok(migrationHistory.work.some(({ terminal }) => !terminal));
  },
  async verify(ctx, baseUrl, response) {
    const eventId = find(response.json, "eventId");
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      const membership = value.resources.memberships.find(({ deviceId, regionId: valueRegionId }) => (
        deviceId === id(100) && valueRegionId === regionId
      ));
      return membership?.state === "INSIDE" ? value : undefined;
    }, { timeoutMs: 60_000, label: "LocationEvent evaluation", children: [worker] });
    assert.ok(snapshot.resources.locationEvents.some((entry) => entry.eventId === eventId));
    assert.equal(snapshot.resources.transitions.filter(({ sourceEventId }) => sourceEventId === eventId).length, 1);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, "/api/v1/location-events/batch", "h04-batch", {
      events: [eventPayload(40), eventPayload(41, { latitude: 91 })],
    });
    assert.equal(rejected.status, 400, rejected.text);
    const after = await ctx.snapshot(baseUrl);
    assert.equal(after.resources.locationEvents.length, before.resources.locationEvents.length);
    assert.equal(after.resources.memberships.length, before.resources.memberships.length);
    assert.equal(after.resources.transitions.length, before.resources.transitions.length);
    assert.equal(after.work.length, before.work.length);
    assert.equal(after.events.length, before.events.length);
  },
  async contention(ctx, baseUrls) {
    const observedAt = "2026-01-01T00:00:20.000Z";
    const sequenceRace = await Promise.all([
      ctx.mutate(baseUrls[0], "/api/v1/location-events", "h06-sequence-a", exactEvent({
        eventNumber: 40_001, deviceId: id(105), sequence: 1, observedAt, longitude: 0.25, latitude: 0.5,
      })),
      ctx.mutate(baseUrls[1], "/api/v1/location-events", "h06-sequence-b", exactEvent({
        eventNumber: 40_002, deviceId: id(105), sequence: 1, observedAt, longitude: 0.75, latitude: 0.5,
      })),
    ]);
    assert.equal(sequenceRace.filter(success).length, 1);
    assert.equal(sequenceRace.filter(({ status }) => status === 409).length, 1);
    assert.equal(sequenceRace.find(({ status }) => status === 409)?.json?.error?.code, "DEVICE_SEQUENCE_CONFLICT");

    const duplicateId = id(40_003);
    const eventRace = await Promise.all([
      ctx.mutate(baseUrls[0], "/api/v1/location-events", "h06-event-a", exactEvent({
        eventNumber: 40_003, deviceId: id(106), sequence: 1, observedAt, longitude: 0.25, latitude: 0.5,
      })),
      ctx.mutate(baseUrls[1], "/api/v1/location-events", "h06-event-b", {
        ...exactEvent({ eventNumber: 40_004, deviceId: id(106), sequence: 2, observedAt, longitude: 0.75, latitude: 0.5 }),
        eventId: duplicateId,
      }),
    ]);
    assert.equal(eventRace.filter(success).length, 1);
    assert.equal(eventRace.filter(({ status }) => status === 409).length, 1);
    assert.equal(eventRace.find(({ status }) => status === 409)?.json?.error?.code, "EVENT_ID_CONFLICT");

    const jitterDeviceId = id(108);
    const jitter = Array.from({ length: 10_000 }, (_, index) => exactEvent({
      eventNumber: 50_000 + index,
      deviceId: jitterDeviceId,
      sequence: index + 1,
      observedAt: new Date(Date.parse("2026-01-01T00:01:00.000Z") + index).toISOString(),
      longitude: index === 0 ? 0.5 : (index % 2 ? 1.00001 : 0.99999),
      latitude: 0.5,
    }));
    const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
    const jitterResponses = await ctx.concurrent(jitter, 64, (payload, index) => ctx.mutate(
      baseUrls[index % 2], "/api/v1/location-events", `h06-jitter-${index}`, payload,
    ));
    assert.ok(jitterResponses.every(success), "all 10,000 jitter observations must be accepted");
    const snapshot = await waitForDrain(ctx, baseUrls[0], workers);
    const stored = snapshot.resources.locationEvents.filter(({ deviceId }) => deviceId === jitterDeviceId);
    assert.equal(stored.length, 10_000);
    assert.equal(new Set(stored.map(({ eventId }) => eventId)).size, stored.length);
    assert.equal(new Set(stored.map(({ deviceSequence }) => deviceSequence)).size, stored.length);
    assert.equal(snapshot.resources.memberships.filter(({ deviceId, regionId: valueRegionId }) => (
      deviceId === jitterDeviceId && valueRegionId === regionId
    )).length, 1);
    const transitions = snapshot.resources.transitions.filter(({ deviceId, regionId: valueRegionId }) => (
      deviceId === jitterDeviceId && valueRegionId === regionId
    ));
    assert.ok(transitions.some(({ type }) => type === "ENTER"), "jitter baseline must establish an inside interval");
    assert.equal(transitions.filter(({ type }) => type === "EXIT").length, 0, "boundary jitter produced a spurious EXIT");
    assertContiguousTransitions(transitions);
  },
  async migrationVerify(ctx, { created, snapshot }) {
    assert.ok(migrationHistory, "V1 migration history was not prepared");
    for (const expected of migrationHistory.locationEvents) {
      assert.deepEqual(v1Projection(snapshot.resources.locationEvents.find(({ eventId }) => eventId === expected.eventId)), expected);
    }
    for (const expected of migrationHistory.memberships) {
      assert.deepEqual(v1Projection(snapshot.resources.memberships.find(({ deviceId, regionId: value }) => (
        deviceId === expected.deviceId && value === expected.regionId
      ))), expected);
    }
    for (const expected of migrationHistory.transitions) {
      assert.deepEqual(v1Projection(snapshot.resources.transitions.find(({ transitionId }) => transitionId === expected.transitionId)), expected);
    }
    const eventIds = new Set(snapshot.events.map(({ eventId }) => eventId));
    assert.ok(migrationHistory.eventIds.every((eventId) => eventIds.has(eventId)));
    for (const expected of migrationHistory.work) {
      assert.deepEqual(snapshot.work.find(({ workId }) => workId === expected.workId), expected);
    }
    const createdEventId = find(created.json, "eventId");
    assert.ok(snapshot.resources.locationEvents.some(({ eventId }) => eventId === createdEventId));
    assert.ok(snapshot.work.some(({ aggregateId }) => aggregateId === createdEventId));
    assert.equal(snapshot.resources.regionBundles.length, 0);
    assert.equal(snapshot.resources.regionBundleRevisions.length, 0);
    assertContiguousTransitions(snapshot.resources.transitions.filter(({ deviceId }) => deviceId === migrationHistory.deviceId));
  },
  manager: {
    async prepare(ctx, baseUrl) {
      const created = await ctx.mutate(baseUrl, "/api/v1/region-bundles", "manager-bundle", {
        tenantId, name: "Hidden Bundle",
      });
      assert.ok(success(created), created.text);
      assert.deepEqual(Object.keys(created.json).sort(), ["bundle"]);
      const createdBundle = responseBundle(created);
      assert.equal(createdBundle.tenantId, tenantId);
      assert.equal(createdBundle.name, "Hidden Bundle");
      assert.equal(createdBundle.currentRevision, 0);
      assert.equal(createdBundle.currentBundleRevisionId, null);
      const bundleId = createdBundle.bundleId;
      return {
        path: `/api/v1/region-bundles/${bundleId}/publish`,
        payload: () => ({
          expectedRevision: 0,
          effectiveFrom: "2026-09-01T00:00:00.000Z",
          regionVersionIds: [secondRegionVersionId, regionVersionId, secondRegionVersionId],
        }),
        bundleId,
        memberIds: [regionVersionId, secondRegionVersionId],
      };
    },
    async verify(ctx, baseUrl, response, operation) {
      assert.deepEqual(Object.keys(response.json).sort(), ["bundle", "revision"]);
      const publishedBundle1 = responseBundle(response);
      const revision1 = responseRevision(response);
      assert.equal(publishedBundle1.currentRevision, 1);
      assert.equal(publishedBundle1.currentBundleRevisionId, revision1.bundleRevisionId);
      assert.equal(revision1.revision, 1);
      assert.deepEqual(revision1.regionVersionIds, operation.memberIds);
      const frozenRevision1 = structuredClone(revision1);

      const beforeInvalid = await ctx.snapshot(baseUrl);
      const invalid = await ctx.mutate(baseUrl, operation.path, "h10-empty-members", {
        expectedRevision: 1, effectiveFrom: "2026-10-01T00:00:00.000Z", regionVersionIds: [],
      });
      assert.ok([400, 409].includes(invalid.status), invalid.text);
      const afterInvalid = await ctx.snapshot(baseUrl);
      assert.deepEqual(afterInvalid.resources.regionBundles, beforeInvalid.resources.regionBundles);
      assert.deepEqual(afterInvalid.resources.regionBundleRevisions, beforeInvalid.resources.regionBundleRevisions);
      assert.deepEqual(afterInvalid.work, beforeInvalid.work);
      assert.deepEqual(afterInvalid.events, beforeInvalid.events);

      const nextRegionVersionId = id(6);
      const version = await ctx.mutate(baseUrl, `/api/v1/regions/${regionId}/versions`, "h10-region-v2", {
        tenantId, regionVersionId: nextRegionVersionId, revision: 2,
        effectiveFrom: "2026-11-01T00:00:00.000Z", effectiveTo: null,
        polygon, boundaryToleranceMeters: 10, dwellSeconds: 3_600,
      });
      assert.ok(success(version), version.text);

      const pinnedDeviceId = id(115);
      const accepted = await Promise.all([
        ctx.mutate(baseUrl, "/api/v1/location-events", "h10-pinned-1", exactEvent({
          eventNumber: 70_001, deviceId: pinnedDeviceId, sequence: 1,
          observedAt: "2026-10-02T00:00:02.000Z", longitude: 0.5, latitude: 0.5,
        })),
        ctx.mutate(baseUrl, "/api/v1/location-events", "h10-pinned-2", exactEvent({
          eventNumber: 70_002, deviceId: pinnedDeviceId, sequence: 2,
          observedAt: "2026-10-02T00:00:01.000Z", longitude: 0.6, latitude: 0.5,
        })),
      ]);
      assert.ok(accepted.every(success));
      assert.ok(accepted.every((entry) => find(entry.json, "bundleRevisionId") === revision1.bundleRevisionId));
      const worker = await ctx.startWorker();
      let snapshot = await waitForDrain(ctx, baseUrl, [worker]);
      const pinnedEvents = snapshot.resources.locationEvents.filter(({ deviceId }) => deviceId === pinnedDeviceId);
      assert.equal(pinnedEvents.length, 2);
      assert.ok(pinnedEvents.every(({ bundleRevisionId }) => bundleRevisionId === revision1.bundleRevisionId));
      assert.ok(snapshot.resources.memberships.filter(({ deviceId }) => deviceId === pinnedDeviceId)
        .every(({ bundleRevisionId }) => bundleRevisionId === revision1.bundleRevisionId));

      const query1 = await ctx.request(baseUrl, "/api/v1/regions/query", { method: "POST", json: {
        tenantId,
        points: [{ queryId: "h10-pinned-query", longitude: 0.5, latitude: 0.5, at: "2026-10-02T00:00:00.000Z" }],
      } });
      assert.equal(query1.status, 200, query1.text);
      assert.equal(query1.json?.bundleRevisionId, revision1.bundleRevisionId);
      assert.deepEqual(query1.json?.items?.map(({ queryId }) => queryId), ["h10-pinned-query"]);
      assert.ok(query1.json.items[0].matches.some(({ regionVersionId: value }) => value === regionVersionId));

      const publish2 = await ctx.mutate(baseUrl, operation.path, "h10-publish-v2", {
        expectedRevision: 1,
        effectiveFrom: "2026-12-01T00:00:00.000Z",
        regionVersionIds: [nextRegionVersionId, secondRegionVersionId],
      });
      assert.ok(success(publish2), publish2.text);
      assert.deepEqual(Object.keys(publish2.json).sort(), ["bundle", "revision"]);
      const revision2 = responseRevision(publish2);
      const rollback = await ctx.mutate(baseUrl, `/api/v1/region-bundles/${operation.bundleId}/rollback`, "h10-rollback", {
        expectedRevision: 2, targetRevision: 1, effectiveFrom: "2027-01-01T00:00:00.000Z",
      });
      assert.ok(success(rollback), rollback.text);
      assert.deepEqual(Object.keys(rollback.json).sort(), ["bundle", "revision"]);
      const revision3 = responseRevision(rollback);
      assert.equal(revision3.revision, 3);
      assert.deepEqual(revision3.regionVersionIds, revision1.regionVersionIds);
      snapshot = await ctx.snapshot(baseUrl);
      const revisions = snapshot.resources.regionBundleRevisions
        .filter(({ bundleId }) => bundleId === operation.bundleId)
        .sort((left, right) => left.revision - right.revision);
      assert.deepEqual(revisions[0], frozenRevision1);
      assert.deepEqual(revisions.map(({ revision }) => revision), [1, 2, 3]);
      const bundle = snapshot.resources.regionBundles.find(({ bundleId }) => bundleId === operation.bundleId);
      assert.equal(bundle.currentBundleRevisionId, revision3.bundleRevisionId);
      assert.ok(snapshot.work.some(({ kind }) => kind === "BUNDLE_REEVALUATION"));
      assert.ok(snapshot.events.some(({ type }) => type === "region_bundle.published"));
      assert.ok(snapshot.events.some(({ type }) => type === "region_bundle.rolled_back"));
      const html = await ctx.request(baseUrl, "/");
      assert.equal(html.status, 200);
      assert.match(html.text, /<html|<!doctype/iu);
    },
    async concurrentVerify(ctx, baseUrls, _response, operation) {
      const before = await ctx.snapshot(baseUrls[0]);
      const revision1 = before.resources.regionBundleRevisions.find(({ bundleId, revision }) => (
        bundleId === operation.bundleId && revision === 1
      ));
      const oldDeviceId = id(116);
      const oldEvent = await ctx.mutate(baseUrls[0], "/api/v1/location-events", "h11-old-event", exactEvent({
        eventNumber: 80_001, deviceId: oldDeviceId, sequence: 1,
        observedAt: "2026-09-15T00:00:00.000Z", longitude: 0.5, latitude: 0.5,
      }));
      assert.ok(success(oldEvent), oldEvent.text);
      const oldEventId = find(oldEvent.json, "eventId");
      assert.equal(find(oldEvent.json, "bundleRevisionId"), revision1.bundleRevisionId);

      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const barrier = await ctx.receiver((entry) => (
        entry.json?.point === "worker.claimed" && entry.json?.aggregateId === oldEventId
      ) ? held : { status: 204 });
      const staleWorker = await ctx.startWorker({
        TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "geopulse-h11",
      });
      await ctx.waitFor(() => barrier.ledger.some((entry) => (
        entry.json?.point === "worker.claimed" && entry.json?.aggregateId === oldEventId
      )), { timeoutMs: 60_000, label: "old bundle event claim", children: [staleWorker] });

      const attempts = await Promise.all([
        ctx.mutate(baseUrls[0], operation.path, "h11-a", {
          expectedRevision: 1,
          effectiveFrom: "2026-10-01T00:00:00.000Z",
          regionVersionIds: [secondRegionVersionId, regionVersionId],
        }),
        ctx.mutate(baseUrls[1], `/api/v1/region-bundles/${operation.bundleId}/rollback`, "h11-b", {
          expectedRevision: 1, targetRevision: 1, effectiveFrom: "2026-10-01T00:00:00.000Z",
        }),
      ]);
      assert.equal(attempts.filter(success).length, 1);
      assert.equal(attempts.filter(({ status }) => status === 409).length, 1);
      assert.equal(attempts.find(({ status }) => status === 409)?.json?.error?.code, "BUNDLE_REVISION_CONFLICT");
      await ctx.stop(staleWorker, "SIGKILL");
      release({ status: 204 });
      await new Promise((resolve) => setTimeout(resolve, 3_200));
      const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));

      let snapshot = await waitForDrain(ctx, baseUrls[0], workers);
      const revision2 = snapshot.resources.regionBundleRevisions.find(({ bundleId, revision }) => (
        bundleId === operation.bundleId && revision === 2
      ));
      assert.ok(revision2);
      assert.equal(snapshot.resources.locationEvents.find(({ eventId }) => eventId === oldEventId)?.bundleRevisionId, revision1.bundleRevisionId);
      assert.ok(snapshot.resources.memberships.filter(({ deviceId }) => deviceId === oldDeviceId)
        .every(({ bundleRevisionId }) => bundleRevisionId === revision1.bundleRevisionId));

      const newDeviceId = id(117);
      const current = await ctx.mutate(baseUrls[1], "/api/v1/location-events", "h11-new-event", exactEvent({
        eventNumber: 80_002, deviceId: newDeviceId, sequence: 1,
        observedAt: "2026-10-02T00:00:00.000Z", longitude: 0.5, latitude: 0.5,
      }));
      assert.ok(success(current), current.text);
      assert.equal(find(current.json, "bundleRevisionId"), revision2.bundleRevisionId);
      snapshot = await waitForDrain(ctx, baseUrls[0], workers);
      for (const baseUrl of baseUrls) {
        const currentBundle = await ctx.request(baseUrl, `/api/v1/region-bundles/${operation.bundleId}`);
        assert.equal(currentBundle.status, 200, currentBundle.text);
        assert.deepEqual(Object.keys(currentBundle.json).sort(), ["bundle", "revisions"]);
        assert.equal(responseBundle(currentBundle).currentBundleRevisionId, revision2.bundleRevisionId);
        assert.ok(currentBundle.json.revisions.length >= 2);
        for (const revision of currentBundle.json.revisions) responseRevision({ json: { revision }, text: currentBundle.text });
        const query = await ctx.request(baseUrl, "/api/v1/regions/query", { method: "POST", json: {
          tenantId,
          points: [{ queryId: `h11-${baseUrl}`, longitude: 0.5, latitude: 0.5, at: "2026-10-02T00:00:00.000Z" }],
        } });
        assert.equal(query.status, 200, query.text);
        assert.equal(query.json?.bundleRevisionId, revision2.bundleRevisionId);
      }
      assertContiguousTransitions(snapshot.resources.transitions.filter(({ deviceId }) => (
        deviceId === oldDeviceId || deviceId === newDeviceId
      )));
    },
  },
  performance: geoPulsePerformance,
};

function scaledCount(base, scale, minimum) {
  return Math.min(base, Math.max(minimum, Math.ceil(base * scale)));
}

function performanceRegions(count) {
  return Array.from({ length: count }, (_, index) => {
    const column = index % 100;
    const row = Math.floor(index / 100);
    const west = -150 + column * 3;
    const south = -75 + row * 1.5;
    const valuePolygon = [[west, south], [west, south + 0.5], [west + 0.5, south + 0.5], [west + 0.5, south], [west, south]];
    return regionRecord(id(20_000_000 + index), id(30_000_000 + index), 1, valuePolygon, index);
  });
}

function performanceSeed(scale) {
  const ingestDeviceCount = scaledCount(100_000, scale, 100);
  const jitterDeviceCount = scaledCount(2_000, scale, 20);
  const regionCount = scaledCount(10_000, scale, 100);
  const regionPairs = performanceRegions(regionCount);
  return {
    counts: { ingestDeviceCount, jitterDeviceCount, regionCount },
    value: {
      schemaVersion: 1,
      seedVersion: `perf-geopulse-${scale}`,
      importedAt: "2026-08-01T00:00:00.000Z",
      tenants: [{ tenantId, name: "Performance Geo Tenant" }],
      devices: [...devices(ingestDeviceCount, 10_000_000), ...devices(jitterDeviceCount, 11_000_000)],
      regions: regionPairs.map(({ region }) => region),
      regionVersions: regionPairs.map(({ version }) => version),
      locationEvents: [], memberships: [], transitions: [],
    },
  };
}

function percentile(values, fraction) {
  return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

async function fixedLoad({ count, concurrency, request }) {
  let next = 0;
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next++;
      const started = performance.now();
      const response = await request(index);
      latencies.push(performance.now() - started);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    }
  }));
  const durationMs = Math.max(1, performance.now() - startedAt);
  latencies.sort((left, right) => left - right);
  return {
    requested: count,
    completed: latencies.length,
    durationMs,
    throughput: count / (durationMs / 1_000),
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    statuses: Object.fromEntries(statuses),
  };
}

function assertSuccessfulLoad(metric, label) {
  assert.equal(metric.completed, metric.requested, `${label} did not execute its fixed request count`);
  const failures = Object.entries(metric.statuses)
    .filter(([status]) => Number(status) < 200 || Number(status) >= 300)
    .reduce((sum, [, count]) => sum + count, 0);
  assert.equal(failures, 0, `${label} returned non-2xx responses: ${JSON.stringify(metric.statuses)}`);
}

function assertEventOrder(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.aggregateId;
    const values = groups.get(key) ?? [];
    values.push(event.sequence);
    groups.set(key, values);
  }
  for (const sequences of groups.values()) {
    sequences.sort((left, right) => left - right);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  }
}

async function geoPulsePerformance(ctx, assertions) {
  const scale = performanceScale();
  const generated = performanceSeed(scale);
  const { ingestDeviceCount, jitterDeviceCount, regionCount } = generated.counts;
  const ingestCount = scaledCount(500_000, scale, 500);
  const jitterCount = scaledCount(100_000, scale, Math.max(1_000, jitterDeviceCount));
  const pointCount = scaledCount(1_000_000, scale, 10_000);
  await ctx.prepare();
  assert.equal((await ctx.seed(generated.value)).exitCode, 0);
  const apis = [await ctx.startApi(), await ctx.startApi()];
  const workers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const webhook = await ctx.receiver();
  const dispatcher = await ctx.startDispatcher(webhook.url);

  const bundle = await ctx.mutate(apis[0].baseUrl, "/api/v1/region-bundles", "perf-bundle", {
    tenantId, name: "Performance Regions",
  });
  assert.ok(success(bundle), bundle.text);
  const bundleId = find(bundle.json, "bundleId");
  const memberIds = generated.value.regionVersions.map(({ regionVersionId: value }) => value);
  const published = await ctx.mutate(apis[0].baseUrl, `/api/v1/region-bundles/${bundleId}/publish`, "perf-bundle-publish", {
    expectedRevision: 0, effectiveFrom: "2026-01-01T00:00:00.000Z", regionVersionIds: memberIds,
  });
  assert.ok(success(published), published.text);
  const activeBundleRevisionId = responseRevision(published).bundleRevisionId;

  const firstRegion = generated.value.regionVersions[0];
  const ingest = await fixedLoad({ count: ingestCount, concurrency: 64, request: (index) => {
    const deviceIndex = index % ingestDeviceCount;
    return ctx.mutate(apis[index % 2].baseUrl, "/api/v1/location-events", `perf-ingest-${index}`, exactEvent({
      eventNumber: 100_000_000 + index,
      deviceId: id(10_000_000 + deviceIndex),
      sequence: Math.floor(index / ingestDeviceCount) + 1,
      observedAt: new Date(Date.parse(createdAt) + index).toISOString(),
      longitude: firstRegion.polygon[0][0] + 0.25,
      latitude: firstRegion.polygon[0][1] + 0.25,
    }));
  } });
  assertSuccessfulLoad(ingest, "ordered-location-ingest");
  assert.ok(ingest.throughput >= 500 && ingest.p95 <= 250, `ordered-location-ingest ${ingest.throughput}/s p95=${ingest.p95}`);
  assertions.push(`ordered-location-ingest ${ingest.completed}/${500_000} events at scale ${scale}; ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  const jitterRegionCount = Math.min(regionCount, scaledCount(100, scale, 1));
  const jitter = await fixedLoad({ count: jitterCount, concurrency: 64, request: (index) => {
    const deviceIndex = index % jitterDeviceCount;
    const sequence = Math.floor(index / jitterDeviceCount) + 1;
    const target = generated.value.regionVersions[deviceIndex % jitterRegionCount];
    const east = target.polygon[2][0];
    return ctx.mutate(apis[index % 2].baseUrl, "/api/v1/location-events", `perf-jitter-${index}`, exactEvent({
      eventNumber: 200_000_000 + index,
      deviceId: id(11_000_000 + deviceIndex),
      sequence,
      observedAt: new Date(Date.parse("2026-01-02T00:00:00.000Z") + index).toISOString(),
      longitude: sequence === 1 ? target.polygon[0][0] + 0.25 : east + (sequence % 2 ? 0.00001 : -0.00001),
      latitude: target.polygon[0][1] + 0.25,
    }));
  } });
  assertSuccessfulLoad(jitter, "boundary-jitter-convergence");
  assert.ok(jitter.throughput >= 300 && jitter.p95 <= 350, `boundary-jitter-convergence ${jitter.throughput}/s p95=${jitter.p95}`);
  assertions.push(`boundary-jitter-convergence ${jitter.completed}/${100_000} observations over ${jitterDeviceCount}/${2_000} devices and ${jitterRegionCount}/${100} regions; ${jitter.throughput.toFixed(1)}/s p95 ${jitter.p95.toFixed(1)}ms`);

  let queriedPoints = 0;
  const queryBatches = Math.ceil(pointCount / 1_000);
  const query = await fixedLoad({ count: queryBatches, concurrency: 16, request: async (batch) => {
    const size = Math.min(1_000, pointCount - batch * 1_000);
    const points = Array.from({ length: size }, (_, offset) => {
      const pointIndex = batch * 1_000 + offset;
      const target = generated.value.regionVersions[pointIndex % regionCount];
      return {
        queryId: `${batch}-${offset}`,
        longitude: target.polygon[0][0] + 0.25,
        latitude: target.polygon[0][1] + 0.25,
        at: "2026-09-15T00:00:00.000Z",
      };
    });
    const response = await ctx.request(apis[batch % 2].baseUrl, "/api/v1/regions/query", {
      method: "POST", json: { tenantId, points },
    });
    if (response.status === 200) {
      assert.equal(response.json?.bundleRevisionId, activeBundleRevisionId);
      assert.deepEqual(response.json?.items?.map(({ queryId }) => queryId), points.map(({ queryId }) => queryId));
      for (let index = 0; index < points.length; index += 1) {
        const target = generated.value.regionVersions[(batch * 1_000 + index) % regionCount];
        assert.ok(response.json.items[index].matches.some(({ regionId: valueRegionId, regionVersionId: valueVersionId }) => (
          valueRegionId === target.regionId && valueVersionId === target.regionVersionId
        )));
      }
      queriedPoints += points.length;
    }
    return response;
  } });
  assertSuccessfulLoad(query, "bulk-spatial-query");
  assert.equal(queriedPoints, pointCount);
  const pointThroughput = pointCount / (query.durationMs / 1_000);
  assert.ok(pointThroughput >= 20_000 && query.p95 <= 700, `bulk-spatial-query ${pointThroughput} points/s p95=${query.p95}`);
  assertions.push(`bulk-spatial-query ${queriedPoints}/${1_000_000} points over ${regionCount}/${10_000} regions; ${pointThroughput.toFixed(1)} points/s p95 ${query.p95.toFixed(1)}ms`);

  const snapshot = await waitForDrain(ctx, apis[0].baseUrl, workers, 60_000);
  const performanceEvents = snapshot.resources.locationEvents.filter(({ eventId }) => (
    Number(eventId.slice(-12)) >= 100_000_000
  ));
  assert.equal(performanceEvents.length, ingestCount + jitterCount);
  assert.equal(new Set(performanceEvents.map(({ eventId }) => eventId)).size, performanceEvents.length);
  assert.equal(new Set(performanceEvents.map(({ deviceId, deviceSequence }) => `${deviceId}:${deviceSequence}`)).size, performanceEvents.length);
  assert.ok(performanceEvents.every(({ bundleRevisionId }) => bundleRevisionId === activeBundleRevisionId));
  assert.equal(new Set(snapshot.resources.memberships.map(({ tenantId: valueTenantId, deviceId, regionId: valueRegionId }) => (
    `${valueTenantId}:${deviceId}:${valueRegionId}`
  ))).size, snapshot.resources.memberships.length);
  assert.ok(snapshot.resources.memberships.every(({ revision }) => Number.isSafeInteger(revision) && revision >= 1));
  const jitterDeviceIds = new Set(Array.from({ length: jitterDeviceCount }, (_, index) => id(11_000_000 + index)));
  const jitterTransitions = snapshot.resources.transitions.filter(({ deviceId }) => jitterDeviceIds.has(deviceId));
  assert.equal(jitterTransitions.filter(({ type }) => type === "EXIT").length, 0);
  assertContiguousTransitions(snapshot.resources.transitions);
  assertEventOrder(snapshot.events);
  assert.ok(snapshot.work.every(({ terminal }) => terminal));
  for (const collection of Object.values(snapshot.resources)) {
    assert.ok(collection.every((entry) => entry.tenantId === undefined || entry.tenantId === tenantId));
  }
  const rssBytes = (await Promise.all([...apis, ...workers, dispatcher].map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  return {
    metrics: [
      { scenarioId: "ordered-location-ingest", publicCount: 500_000, actualCount: ingestCount, scale, ...ingest },
      { scenarioId: "boundary-jitter-convergence", publicCount: 100_000, actualCount: jitterCount, devices: jitterDeviceCount, regions: jitterRegionCount, scale, ...jitter },
      { scenarioId: "bulk-spatial-query", publicCount: 1_000_000, actualCount: pointCount, regions: regionCount, scale, ...query, pointThroughput },
    ],
    topology: { apiProcesses: 2, workers: 4, dispatchers: 1 },
    rssBytes,
    databaseBytes: snapshot.metrics?.databaseBytes ?? null,
  };
}

export default standardAdapter(spec);
