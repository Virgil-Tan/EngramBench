// Policy revision: learning-final-system-2026-09-08.1. One FINAL submission; current public operations, persistence and restart recovery, not a historical binary upgrade.
import {
  assertEvents,
  canonicalJson,
  createBundle,
  finalEvidence,
  guardedCase,
  prepare,
  publishBundle,
  queryRegions,
  resource,
  runWorkload,
  scaleRegionSeed,
  startPreparedApi,
  waitForDrain,
  waitForWork,
} from "./helpers.mjs";
import { performanceContract } from "../fixtures/index.mjs";

const correctness = ["CORRECTNESS_INVARIANT"];

function withoutBundleField(value) {
  if (Array.isArray(value)) return value.map(withoutBundleField);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "bundleRevisionId").map(([key, child]) => [key, withoutBundleField(child)]));
}

function boundedReceiverBehavior(_entry, ledger) {
  if (ledger.length > 1_000) ledger.splice(0, 900);
  return { status: 204 };
}

async function startFormalRoles(ctx, apiCount = 2, workerCount = 4) {
  const apis = [];
  for (let index = 0; index < apiCount; index += 1) apis.push(await ctx.startApi());
  const workers = await Promise.all(Array.from({ length: workerCount }, () => ctx.startWorker()));
  const receiver = await ctx.receiver({ behavior: boundedReceiverBehavior });
  const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
  return { apis, workers, receiver, dispatcher };
}

const e01 = guardedCase({
  id: "E-01",
  fixtureFamily: "GP-F-base-system-FINAL",
  action: "Use the FINAL runtime to create ordered and late LocationEvents, Membership, Transitions, saved replay, a killed leased Work and an unacknowledged Event, then reinitialize the same database with FINAL.",
  oracle: "Byte-stable base-system resource projections, idempotency response, watermark, Transition sequence, lease fields, event identities and delivery state must survive before the first empty Bundle is created.",
  async run(ctx) {
    const seed = scaleRegionSeed(ctx, 100, 1);
    const initialApi = await startPreparedApi(ctx, { workspace: ctx.workspace, seed });
    const target = ctx;
    const later = {
      eventId: ctx.uuid("reinitialization-later"), tenantId: seed.tenants[0].tenantId, deviceId: seed.devices[0].deviceId,
      deviceSequence: 2, observedAt: ctx.at({ seconds: 20 }), longitude: 0.005, latitude: 0.005, accuracyMeters: 2,
    };
    const savedKey = ctx.key("reinitialization-saved-response");
    const saved = await ctx.mutate(initialApi.baseUrl, "/api/v1/location-events", savedKey, later);
    ctx.equal(saved.status, 200, "base-system saved mutation succeeds");
    const initialWorker = await target.startWorker();
    await waitForDrain(ctx, initialApi.baseUrl, { processes: [initialWorker] });
    await ctx.kill(initialWorker);
    const earlier = {
      eventId: ctx.uuid("reinitialization-earlier"), tenantId: seed.tenants[0].tenantId, deviceId: seed.devices[0].deviceId,
      deviceSequence: 1, observedAt: ctx.at({ seconds: 10 }), longitude: 0.02, latitude: 0.005, accuracyMeters: 2,
    };
    await ctx.mutate(initialApi.baseUrl, "/api/v1/location-events", ctx.key("reinitialization-late"), earlier);
    const staleWorker = await target.startWorker();
    const leased = await waitForWork(ctx, initialApi.baseUrl, (item) => item.kind === "LATE_REPLAY" && item.state === "LEASED", {
      intervalMs: 2, label: "base-system LATE_REPLAY lease", processes: [staleWorker],
    });
    await ctx.kill(staleWorker);

    const receiver = await ctx.receiver({ behavior: () => ({ status: 500 }) });
    const dispatcher = await target.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => receiver.ledger.length > 0, { timeoutMs: 60_000, label: "base-system unacknowledged Event", processes: [dispatcher] });
    await ctx.kill(dispatcher);
    const before = await ctx.snapshot(initialApi.baseUrl);
    const beforeResources = structuredClone(before.resources);
    const beforeWork = structuredClone(before.work);
    const beforeEvents = structuredClone(before.events);
    ctx.ok(beforeWork.some(({ workId, state }) => workId === leased.work.workId && state === "LEASED"), "base-system restart boundary contains the leased Work");
    await ctx.kill(initialApi);

    const finalTarget = await prepare(ctx, { workspace: ctx.workspace });
    const finalApi = await finalTarget.startApi();
    const afterMigration = await ctx.snapshot(finalApi.baseUrl);
    for (const name of ["tenants", "devices", "regions", "regionVersions", "locationEvents", "memberships", "transitions"]) {
      ctx.equal(withoutBundleField(resource(afterMigration, name)), withoutBundleField(beforeResources[name]), `reinitialization preserves base-system ${name}`, { hardCapIds: correctness });
    }
    ctx.equal(afterMigration.work, beforeWork, "reinitialization preserves pending lease owner, expiry and attempt", { hardCapIds: correctness });
    ctx.equal(afterMigration.events, beforeEvents, "reinitialization preserves Event identity, body, cursor and delivery state", { hardCapIds: correctness });
    ctx.equal(resource(afterMigration, "regionBundles"), [], "Bundle resources start empty");
    ctx.equal(resource(afterMigration, "regionBundleRevisions"), [], "Bundle revision resources start empty");
    const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/location-events", savedKey, later);
    ctx.equal({ status: replay.status, body: replay.text }, { status: saved.status, body: saved.text }, "FINAL replays the exact saved base-system response", { hardCapIds: correctness });

    const replacement = await finalTarget.startWorker();
    const recovered = await waitForDrain(ctx, finalApi.baseUrl, { timeoutMs: 120_000, processes: [replacement] });
    ctx.ok((recovered.work ?? []).find(({ workId }) => workId === leased.work.workId)?.terminal, "old leased Work is reclaimable after reinitialization");
    const bundle = await createBundle(ctx, finalApi.baseUrl, seed.tenants[0].tenantId, { name: "First FINAL Bundle" });
    ctx.equal(bundle.currentRevision, 0, "first FINAL Bundle starts at revision zero");
    await queryRegions(ctx, finalApi.baseUrl, seed.tenants[0].tenantId, [{ queryId: "old-client-query", longitude: 0.005, latitude: 0.005, at: later.observedAt }]);
    return finalEvidence(ctx, { v1Events: beforeEvents.length, preservedWorkId: leased.work.workId, oldReplayStable: true });
  },
}, correctness);

const e02 = guardedCase({
  id: "E-02",
  fixtureFamily: "GP-F-PERF-ORDERED-LOCATION-INGEST",
  action: "Run the published 500000-event, 100000-Device ordered ingest through 64 clients, two APIs, four Workers and one Dispatcher for the formal 60-second window.",
  oracle: "Measured response latency and throughput plus full snapshot recomputation require zero 5xx, exact eventId/deviceSequence uniqueness, drained Work, isolated Memberships and contiguous Event order.",
  async run(ctx) {
    const contract = performanceContract().ordered;
    const seed = scaleRegionSeed(ctx, 1, contract.devices);
    await prepare(ctx, { seed, seedTimeoutMs: 900_000 });
    const roles = await startFormalRoles(ctx);
    const bundle = await createBundle(ctx, roles.apis[0].baseUrl, seed.tenants[0].tenantId, { name: "Ordered Ingest Bundle" });
    await publishBundle(ctx, roles.apis[0].baseUrl, bundle.bundleId, {
      expectedRevision: 0, effectiveFrom: ctx.at({ hours: -1 }), regionVersionIds: [seed.regionVersions[0].regionVersionId],
    });
    const epoch = Date.parse(ctx.at());
    const result = await runWorkload({
      total: contract.events,
      clients: contract.clients,
      seconds: contract.seconds,
      operation: (index) => {
        const deviceIndex = index % contract.devices;
        const sequence = Math.floor(index / contract.devices) + 1;
        return ctx.mutate(roles.apis[index % roles.apis.length].baseUrl, "/api/v1/location-events", ctx.key(`ordered-${index}`), {
          eventId: ctx.uuid(`ordered-event-${index}`),
          tenantId: seed.tenants[0].tenantId,
          deviceId: seed.devices[deviceIndex].deviceId,
          deviceSequence: sequence,
          observedAt: new Date(epoch + sequence).toISOString(),
          longitude: 0.005,
          latitude: 0.005,
          accuracyMeters: 2,
        }, { timeoutMs: 10_000 });
      },
    });
    // README publishes a time window and a throughput floor, not corpus/60 as
    // a second throughput floor. Validate every request actually sent below.
    ctx.equal([...result.statuses.keys()], [200], "ordered workload accepts every event without 4xx or 5xx");
    ctx.ok(result.throughput >= contract.throughput, `ordered throughput ${result.throughput} >= ${contract.throughput}`);
    ctx.ok(result.p95Ms <= contract.p95Ms, `ordered p95 ${result.p95Ms} <= ${contract.p95Ms}`);
    // README requires drainage, but publishes no post-load drainage deadline.
    const snapshot = await waitForDrain(ctx, roles.apis[0].baseUrl, { timeoutMs: Infinity, processes: roles.workers });
    const events = resource(snapshot, "locationEvents");
    ctx.equal(events.length, result.completed, "all submitted LocationEvents are durable", { hardCapIds: correctness });
    ctx.equal(new Set(events.map(({ eventId }) => eventId)).size, result.completed, "eventId uniqueness after load", { hardCapIds: correctness });
    ctx.equal(new Set(events.map(({ deviceId, deviceSequence }) => `${deviceId}:${deviceSequence}`)).size, result.completed, "device sequence uniqueness after load", { hardCapIds: correctness });
    ctx.ok((snapshot.work ?? []).every(({ terminal }) => terminal), "ordered workload drains all Work");
    ctx.ok(resource(snapshot, "memberships").every(({ revision }) => Number.isSafeInteger(revision) && revision > 0), "Membership revisions remain positive and monotonic");
    assertEvents(ctx, snapshot.events ?? []);
    return finalEvidence(ctx, { events: result.completed, corpusEvents: contract.events, durationSeconds: result.durationSeconds,
      windowSeconds: contract.seconds, throughput: result.throughput, p95Ms: result.p95Ms, clients: contract.clients });
  },
}, correctness);

export function jitterSeed(ctx, contract) {
  const seed = scaleRegionSeed(ctx, contract.regions, contract.devices);
  for (let index = 0; index < seed.regionVersions.length; index += 1) {
    const west = (-10_000_000 + index * 100_000) / 1_000_000;
    const east = (-10_000_000 + index * 100_000 + 10_000) / 1_000_000;
    seed.regionVersions[index].polygon = [[west, 0], [east, 0], [east, 0.01], [west, 0.01], [west, 0]];
  }
  return seed;
}

const e03 = guardedCase({
  id: "E-03",
  fixtureFamily: "GP-F-PERF-BOUNDARY-JITTER",
  action: "Run 100000 observations for 2000 Devices around 100 Region edges through 64 clients, two APIs, four Workers and a Dispatcher during the published 60-second window.",
  oracle: "Evaluator tolerance construction makes the first point unambiguously inside and every later oscillation remain inside the five-meter band, so no EXIT/ENTER pair is permitted.",
  async run(ctx) {
    const contract = performanceContract().jitter;
    const seed = jitterSeed(ctx, contract);
    await prepare(ctx, { seed, seedTimeoutMs: 900_000 });
    const roles = await startFormalRoles(ctx);
    const bundle = await createBundle(ctx, roles.apis[0].baseUrl, seed.tenants[0].tenantId, { name: "Boundary Jitter Bundle" });
    await publishBundle(ctx, roles.apis[0].baseUrl, bundle.bundleId, {
      expectedRevision: 0,
      effectiveFrom: ctx.at({ hours: -1 }),
      regionVersionIds: seed.regionVersions.map(({ regionVersionId }) => regionVersionId),
    });
    const epoch = Date.parse(ctx.at());
    const result = await runWorkload({
      total: contract.events,
      clients: contract.clients,
      seconds: contract.seconds,
      operation: (index) => {
        const deviceIndex = index % contract.devices;
        const sequence = Math.floor(index / contract.devices) + 1;
        const regionIndex = deviceIndex % contract.regions;
        const westMicros = -10_000_000 + regionIndex * 100_000;
        const longitude = (westMicros + (sequence === 1 ? 9_900 : 10_000 + (sequence % 2 ? 10 : -10))) / 1_000_000;
        return ctx.mutate(roles.apis[index % roles.apis.length].baseUrl, "/api/v1/location-events", ctx.key(`jitter-${index}`), {
          eventId: ctx.uuid(`jitter-event-${index}`),
          tenantId: seed.tenants[0].tenantId,
          deviceId: seed.devices[deviceIndex].deviceId,
          deviceSequence: sequence,
          observedAt: new Date(epoch + sequence).toISOString(),
          longitude,
          latitude: 0.005,
          accuracyMeters: 2,
        }, { timeoutMs: 10_000 });
      },
    });
    ctx.equal([...result.statuses.keys()], [200], "jitter workload accepts every observation without 4xx or 5xx");
    ctx.ok(result.throughput >= contract.throughput, `jitter throughput ${result.throughput} >= ${contract.throughput}`);
    ctx.ok(result.p95Ms <= contract.p95Ms, `jitter p95 ${result.p95Ms} <= ${contract.p95Ms}`);
    const snapshot = await waitForDrain(ctx, roles.apis[0].baseUrl, { timeoutMs: Infinity, processes: roles.workers });
    const events = resource(snapshot, "locationEvents");
    ctx.equal(events.length, result.completed, "all submitted jitter LocationEvents are durable", { hardCapIds: correctness });
    ctx.equal(new Set(events.map(({ eventId }) => eventId)).size, result.completed, "jitter eventId uniqueness after load", { hardCapIds: correctness });
    ctx.equal(new Set(events.map(({ deviceId, deviceSequence }) => `${deviceId}:${deviceSequence}`)).size, result.completed, "jitter device sequence uniqueness after load", { hardCapIds: correctness });
    const transitions = resource(snapshot, "transitions");
    ctx.equal(transitions.filter(({ type }) => type === "EXIT").length, 0, "five-meter boundary jitter emits no spurious EXIT", { hardCapIds: correctness });
    ctx.equal(new Set(transitions.map(({ deviceId, regionId, sourceEventId, type }) => `${deviceId}:${regionId}:${sourceEventId}:${type}`)).size, transitions.length, "jitter transitions remain unique per device/region", { hardCapIds: correctness });
    ctx.ok((snapshot.work ?? []).every(({ terminal }) => terminal), "jitter workload drains all Work");
    assertEvents(ctx, snapshot.events ?? []);
    return finalEvidence(ctx, { observations: result.completed, corpusObservations: contract.events, durationSeconds: result.durationSeconds,
      windowSeconds: contract.seconds, throughput: result.throughput, p95Ms: result.p95Ms, spuriousExits: 0 });
  },
}, correctness);

export function spatialSeed(ctx, regionCount) {
  const seed = scaleRegionSeed(ctx, regionCount, 1);
  for (let index = 0; index < regionCount; index += 1) {
    const column = index % 100;
    const row = Math.floor(index / 100);
    const west = (-1_000_000 + column * 10_000) / 1_000_000;
    const south = (-1_000_000 + row * 10_000) / 1_000_000;
    const east = (-1_000_000 + column * 10_000 + 5_000) / 1_000_000;
    const north = (-1_000_000 + row * 10_000 + 5_000) / 1_000_000;
    seed.regionVersions[index].polygon = [[west, south], [east, south], [east, north], [west, north], [west, south]];
  }
  return seed;
}

const e04 = guardedCase({
  id: "E-04",
  fixtureFamily: "GP-F-PERF-BULK-SPATIAL-QUERY",
  action: "Publish 10000 Regions, submit one million points in ordered batches of 1000 for 60 seconds while a second Bundle revision becomes visible, and measure every public response.",
  oracle: "Generated disjoint grid centers provide independent non-empty match samples; every response must retain query order, one top-level revision, zero 5xx and published point throughput/p95.",
  async run(ctx) {
    const contract = performanceContract().query;
    const seed = spatialSeed(ctx, contract.regions);
    await prepare(ctx, { seed, seedTimeoutMs: 900_000 });
    const roles = await startFormalRoles(ctx);
    const [api1, api2] = roles.apis;
    const bundle = await createBundle(ctx, api1.baseUrl, seed.tenants[0].tenantId, { name: "Spatial Query Bundle" });
    const members = seed.regionVersions.map(({ regionVersionId }) => regionVersionId).sort();
    const first = await publishBundle(ctx, api1.baseUrl, bundle.bundleId, {
      expectedRevision: 0, effectiveFrom: ctx.at({ hours: -1 }), regionVersionIds: members,
    });
    const batches = contract.points / contract.batchSize;
    const seenRevisions = new Set();
    let publication;
    const result = await runWorkload({
      total: batches,
      clients: 64,
      seconds: contract.seconds,
      operation: async (batchIndex) => {
        if (batchIndex === 20 && !publication) {
          publication = Promise.allSettled([publishBundle(ctx, api2.baseUrl, bundle.bundleId, {
            expectedRevision: 1, effectiveFrom: ctx.at({ hours: 1 }), regionVersionIds: members,
          })]);
        }
        const points = Array.from({ length: contract.batchSize }, (_, offset) => {
          const ordinal = batchIndex * contract.batchSize + offset;
          const regionIndex = ordinal % contract.regions;
          const column = regionIndex % 100;
          const row = Math.floor(regionIndex / 100);
          return {
            queryId: `point-${ordinal}`,
            longitude: (-1_000_000 + column * 10_000 + 2_500) / 1_000_000,
            latitude: (-1_000_000 + row * 10_000 + 2_500) / 1_000_000,
            at: ctx.at({ hours: 2 }),
          };
        });
        const response = await ctx.request(batchIndex % 2 ? api1.baseUrl : api2.baseUrl, "/api/v1/regions/query", {
          method: "POST", headers: { "idempotency-key": ctx.key(`spatial-query-${batchIndex}`) }, json: { tenantId: seed.tenants[0].tenantId, points }, timeoutMs: 10_000,
        });
        if (response.status === 200) {
          seenRevisions.add(response.json?.bundleRevisionId);
          ctx.equal(response.json?.items?.map(({ queryId }) => queryId), points.map(({ queryId }) => queryId), "bulk query preserves input order");
          ctx.ok(response.json.items.every(({ matches }) => Array.isArray(matches) && matches.length > 0), "bulk query cannot fake throughput with empty matches");
          if (batchIndex % 50 === 0) {
            const expectedVersionId = seed.regionVersions[(batchIndex * contract.batchSize) % contract.regions].regionVersionId;
            ctx.ok(response.json.items[0].matches.some(({ regionVersionId }) => regionVersionId === expectedVersionId), "independent grid sample matches its RegionVersion");
          }
        }
        return response;
      },
    });
    const [published] = publication ? await publication : [];
    if (published?.status === "rejected") throw published.reason;
    const second = published?.value;
    ctx.equal([...result.statuses.keys()], [200], "spatial workload returns every batch without 4xx or 5xx");
    ctx.ok(result.throughput * contract.batchSize >= contract.throughput, `point throughput ${result.throughput * contract.batchSize} >= ${contract.throughput}`);
    ctx.ok(result.p95Ms <= contract.p95Ms, `spatial p95 ${result.p95Ms} <= ${contract.p95Ms}`);
    ctx.ok([...seenRevisions].every((id) => [first.revision.bundleRevisionId, second?.revision.bundleRevisionId].includes(id)), "each response uses one complete visible Bundle revision", { hardCapIds: correctness });
    const snapshot = await waitForDrain(ctx, api1.baseUrl, { timeoutMs: Infinity, processes: roles.workers });
    ctx.equal(resource(snapshot, "regions").length, contract.regions, "all formal Regions remain durable");
    ctx.equal(resource(snapshot, "regionBundleRevisions").length, 2, "publication boundary creates exactly two immutable Bundle revisions");
    ctx.ok(!canonicalJson(snapshot.events ?? []).includes("longitude"), "query load emits no raw-coordinate Domain Event");
    return finalEvidence(ctx, { points: result.completed * contract.batchSize, corpusPoints: contract.points, durationSeconds: result.durationSeconds,
      windowSeconds: contract.seconds, pointThroughput: result.throughput * contract.batchSize, p95Ms: result.p95Ms, revisionsObserved: seenRevisions.size });
  },
}, correctness);

export const E_CASES = Object.freeze([e01, e02, e03, e04]);
