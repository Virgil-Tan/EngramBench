import assert from "node:assert/strict";
import { standardAdapter } from "../framework/standard-adapter.mjs";
import { performanceScale } from "../framework/performance-runtime.mjs";

const id = (n) => `32000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const hubIds = [id(10), id(11), id(12), id(13), id(14)];
const carrierId = id(20);
const success = ({ status }) => status >= 200 && status < 300;
const typePrecedence = new Map(["LOSS_REPORTED", "FOUND", "PICKED_UP", "DEPARTED", "ARRIVED", "DELIVERED"].map((type, index) => [type, index]));

function find(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const result = find(child, key);
    if (result !== undefined) return result;
  }
}

function stable(snapshot) {
  const { asOf: _asOf, ...value } = snapshot;
  return value;
}

function seed(version = "hidden-routeweave") {
  return {
    schemaVersion: 1, seedVersion: version, importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Logistics Tenant" }],
    hubs: hubIds.map((hubId, index) => ({ hubId, tenantId, code: `H${index + 1}`, name: `Hidden Hub ${index + 1}`, timeZone: "UTC" })),
    carriers: [{ carrierId, tenantId, code: "C1", name: "Hidden Carrier", state: "ACTIVE" }],
    shipments: [], routePlans: [], transportLegs: [], scanEvents: [], journeyProjections: [], lossCases: [], reassignments: [],
  };
}

function networkSeed(version) {
  const hubs = Array.from({ length: 100 }, (_, index) => ({
    hubId: id(100_000 + index), tenantId, code: `P${String(index).padStart(3, "0")}`,
    name: `Performance Hub ${index}`, timeZone: "UTC",
  }));
  const carriers = Array.from({ length: 20 }, (_, index) => ({
    carrierId: id(200_000 + index), tenantId, code: `PC${index}`, name: `Performance Carrier ${index}`, state: "ACTIVE",
  }));
  return { ...seed(version), hubs, carriers };
}

function shipment(index) {
  return {
    tenantId, trackingCode: `hidden-track-${index}`,
    legs: hubIds.slice(0, 4).map((fromHubId, ordinal) => ({ fromHubId, toHubId: hubIds[ordinal + 1], carrierId })),
  };
}

function networkShipment(index) {
  const start = index % 96;
  return {
    tenantId, trackingCode: `perf-track-${index}`,
    legs: Array.from({ length: 4 }, (_, ordinal) => ({
      fromHubId: id(100_000 + start + ordinal), toHubId: id(100_000 + start + ordinal + 1),
      carrierId: id(200_000 + ((index + ordinal) % 20)),
    })),
  };
}

function scan({ shipmentId, routePlanRevision, legId, hubId, type, index, observedAt }) {
  return { tenantId, shipmentId, scannerEventId: `scanner-${index}`, type, routePlanRevision, legId, hubId, observedAt };
}

async function routeFor(ctx, baseUrl, shipmentId) {
  const snapshot = await ctx.snapshot(baseUrl);
  const plans = snapshot.resources.routePlans.filter((entry) => entry.shipmentId === shipmentId).sort((a, b) => a.revision - b.revision);
  const plan = plans.at(-1);
  const legs = snapshot.resources.transportLegs.filter((entry) => entry.routePlanId === plan.routePlanId).sort((a, b) => a.ordinal - b.ordinal);
  return { plan, legs, snapshot };
}

async function fixedLoad(ctx, { count, concurrency, request }) {
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const response = await request(index);
    latencies.push(response.durationMs);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  });
  const durationMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);
  const at = (fraction) => latencies[Math.max(0, Math.ceil(latencies.length * fraction) - 1)];
  return { completed: count, durationMs, throughput: count / (durationMs / 1000), p50: at(0.5), p95: at(0.95), p99: at(0.99), statuses: Object.fromEntries(statuses) };
}

function assertIdsPreserved(before, after, resource, key) {
  const current = new Set(after.resources[resource].map((entry) => entry[key]));
  assert.ok(before.resources[resource].every((entry) => current.has(entry[key])), `${resource} identity changed during migration`);
}

function journeyScans({ shipmentId, plan, legs, prefix, complete = false, startedAt }) {
  let step = 0;
  const observedAt = () => new Date(Date.parse(startedAt) + step++ * 1_000).toISOString();
  const values = [scan({
    shipmentId, routePlanRevision: plan.revision, legId: legs[0].legId, hubId: legs[0].fromHubId,
    type: "PICKED_UP", index: `${prefix}-picked-up`, observedAt: observedAt(),
  })];
  for (const [index, leg] of legs.entries()) {
    values.push(scan({ shipmentId, routePlanRevision: plan.revision, legId: leg.legId, hubId: leg.fromHubId, type: "DEPARTED", index: `${prefix}-departed-${index}`, observedAt: observedAt() }));
    values.push(scan({ shipmentId, routePlanRevision: plan.revision, legId: leg.legId, hubId: leg.toHubId, type: "ARRIVED", index: `${prefix}-arrived-${index}`, observedAt: observedAt() }));
  }
  if (complete) {
    const leg = legs.at(-1);
    values.push(scan({ shipmentId, routePlanRevision: plan.revision, legId: leg.legId, hubId: leg.toHubId, type: "DELIVERED", index: `${prefix}-delivered`, observedAt: observedAt() }));
  }
  return values;
}

async function submitShipmentScans(ctx, baseUrl, values) {
  const responses = [];
  for (const value of values) {
    const response = await ctx.mutate(baseUrl, "/api/v1/scan-events", value.scannerEventId, value);
    assert.ok(success(response), response.text);
    responses.push(response);
  }
  return responses;
}

function assertEventOrder(events) {
  const groups = new Map();
  for (const event of events) {
    const sequences = groups.get(event.aggregateId) ?? [];
    sequences.push(event.sequence);
    groups.set(event.aggregateId, sequences);
  }
  for (const sequences of groups.values()) {
    sequences.sort((left, right) => left - right);
    assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  }
}

function assertIndependentStormReplay(routes, snapshot) {
  const projections = new Map(snapshot.resources.journeyProjections.map((entry) => [entry.shipmentId, entry]));
  const eventsByShipment = new Map();
  for (const event of snapshot.resources.scanEvents) {
    const events = eventsByShipment.get(event.shipmentId) ?? [];
    events.push(event);
    eventsByShipment.set(event.shipmentId, events);
  }
  let replayed = 0;
  for (const route of routes) {
    const legById = new Map(route.legs.map((leg) => [leg.legId, leg]));
    const events = (eventsByShipment.get(route.shipmentId) ?? []).sort((left, right) => (
      left.observedAt.localeCompare(right.observedAt)
      || typePrecedence.get(left.type) - typePrecedence.get(right.type)
      || left.scanEventId.localeCompare(right.scanEventId)
    ));
    assert.equal(events.length, route.legs.length * 2);
    let nextOrdinal = 1;
    let departedLegId;
    let currentHubId = route.legs[0].fromHubId;
    let currentLegId = route.legs[0].legId;
    for (const event of events) {
      const leg = legById.get(event.legId);
      assert.ok(leg, "replay encountered a leg outside the frozen RoutePlan");
      assert.equal(event.routePlanRevision, route.plan.revision);
      assert.equal(leg.ordinal, nextOrdinal);
      if (event.type === "DEPARTED") {
        assert.equal(event.hubId, leg.fromHubId);
        assert.equal(departedLegId, undefined);
        departedLegId = leg.legId;
        currentHubId = leg.fromHubId;
        currentLegId = leg.legId;
      } else {
        assert.equal(event.type, "ARRIVED");
        assert.equal(event.hubId, leg.toHubId);
        assert.equal(departedLegId, leg.legId);
        departedLegId = undefined;
        currentHubId = leg.toHubId;
        currentLegId = leg.legId;
        nextOrdinal += 1;
      }
    }
    assert.equal(nextOrdinal, route.legs.length + 1);
    const projection = projections.get(route.shipmentId);
    assert.deepEqual({
      shipmentId: projection?.shipmentId,
      currentHubId: projection?.currentHubId,
      currentLegId: projection?.currentLegId,
      state: projection?.state,
      lastObservedAt: projection?.lastObservedAt,
      routePlanRevision: projection?.routePlanRevision,
    }, {
      shipmentId: route.shipmentId,
      currentHubId,
      currentLegId,
      state: "IN_TRANSIT",
      lastObservedAt: events.at(-1).observedAt,
      routePlanRevision: route.plan.revision,
    });
    assert.ok(Number.isSafeInteger(projection.projectionVersion) && projection.projectionVersion >= 1);
    replayed += events.length;
  }
  assert.equal(replayed, snapshot.resources.scanEvents.length);
  assert.equal(projections.size, routes.length);
}

async function routeWeaveMigration(ctx, assertions) {
  const v1 = await ctx.copyV1Workspace();
  await ctx.prepare(v1);
  assert.equal((await ctx.seed(seed("h09-routeweave"), v1)).exitCode, 0);
  const v1Api = await ctx.startApi(v1);
  const records = [];
  for (const [name, index] of [["delivered", 909], ["in-flight", 910], ["reassigned", 911]]) {
    const payload = shipment(index);
    const created = await ctx.mutate(v1Api.baseUrl, "/api/v1/shipments", `h09-${name}-shipment`, payload);
    assert.ok(success(created), created.text);
    const shipmentId = find(created.json, "shipmentId");
    const route = await routeFor(ctx, v1Api.baseUrl, shipmentId);
    records.push({ name, payload, created, shipmentId, ...route });
  }
  const worker = await ctx.startWorker({}, v1);
  const deliveredScans = journeyScans({ ...records[0], prefix: "h09-delivered", complete: true, startedAt: "2026-02-09T00:00:00.000Z" });
  const deliveredResponses = await submitShipmentScans(ctx, v1Api.baseUrl, deliveredScans);
  const inFlightScans = journeyScans({ ...records[1], prefix: "h09-in-flight", startedAt: "2026-02-10T00:00:00.000Z" }).slice(0, 3);
  await submitShipmentScans(ctx, v1Api.baseUrl, inFlightScans);
  const lossPayload = { reason: "migration evidence", observedAt: "2026-02-11T00:00:00.000Z" };
  const lost = await ctx.mutate(v1Api.baseUrl, `/api/v1/shipments/${records[2].shipmentId}/loss`, "h09-reassigned-loss", lossPayload);
  assert.ok(success(lost), lost.text);
  const lossSnapshot = await ctx.snapshot(v1Api.baseUrl);
  const lossCaseId = lossSnapshot.resources.lossCases.find(({ shipmentId }) => shipmentId === records[2].shipmentId)?.lossCaseId;
  assert.equal(typeof lossCaseId, "string", "public snapshot did not expose the created LossCase");
  const reassigned = await ctx.mutate(v1Api.baseUrl, `/api/v1/shipments/${records[2].shipmentId}/reassign`, "h09-reassigned-route", {
    lossCaseId, expectedRoutePlanRevision: 1, reason: "migration reroute", legs: shipment(912).legs,
  });
  assert.ok(success(reassigned), reassigned.text);
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(v1Api.baseUrl);
    const projections = new Map(snapshot.resources.journeyProjections.map((entry) => [entry.shipmentId, entry]));
    return projections.get(records[0].shipmentId)?.state === "DELIVERED"
      && projections.get(records[1].shipmentId)?.state === "IN_TRANSIT"
      && projections.get(records[2].shipmentId)?.routePlanRevision === 2
      && snapshot.work.filter(({ aggregateId }) => records.some(({ shipmentId }) => shipmentId === aggregateId)).every(({ terminal }) => terminal)
      ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "V1 delivered, in-flight, and reassigned projections", children: [worker] });
  await ctx.stop(worker);
  const pendingPayload = shipment(913);
  const pendingCreated = await ctx.mutate(v1Api.baseUrl, "/api/v1/shipments", "h09-pending-shipment", pendingPayload);
  assert.ok(success(pendingCreated), pendingCreated.text);
  const pendingShipmentId = find(pendingCreated.json, "shipmentId");
  const before = await ctx.snapshot(v1Api.baseUrl);
  assert.ok(before.work.some(({ aggregateId, terminal }) => aggregateId === pendingShipmentId && !terminal));
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/shipments", "h09-delivered-shipment", records[0].payload);
  assert.equal(replay.status, records[0].created.status);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(records[0].created.json));
  const scanReplay = await ctx.mutate(finalApi.baseUrl, "/api/v1/scan-events", deliveredScans[0].scannerEventId, deliveredScans[0]);
  assert.equal(scanReplay.status, deliveredResponses[0].status);
  assert.equal(ctx.canonical(scanReplay.json), ctx.canonical(deliveredResponses[0].json));
  const after = await ctx.snapshot(finalApi.baseUrl);
  for (const [resource, key] of [["shipments", "shipmentId"], ["routePlans", "routePlanId"], ["transportLegs", "legId"], ["scanEvents", "scanEventId"], ["journeyProjections", "shipmentId"], ["lossCases", "lossCaseId"], ["reassignments", "reassignmentId"]]) {
    assertIdsPreserved(before, after, resource, key);
  }
  assert.deepEqual(after.resources.routePlans.map(({ routePlanId }) => routePlanId).sort(), before.resources.routePlans.map(({ routePlanId }) => routePlanId).sort());
  for (const projection of before.resources.journeyProjections) {
    assert.deepEqual(after.resources.journeyProjections.find(({ shipmentId }) => shipmentId === projection.shipmentId), projection);
  }
  const eventIds = new Set(after.events.map(({ eventId }) => eventId));
  const workIds = new Set(after.work.map(({ workId }) => workId));
  assert.ok(before.events.every(({ eventId }) => eventIds.has(eventId)));
  assert.ok(before.work.every(({ workId }) => workIds.has(workId)));
  assert.equal(after.resources.parcelPieces.length, before.resources.shipments.length);
  assert.equal(after.resources.consignments.length, before.resources.shipments.length);
  for (const shipmentRecord of before.resources.shipments) {
    const piece = after.resources.parcelPieces.find(({ legacyShipmentId }) => legacyShipmentId === shipmentRecord.shipmentId);
    assert.ok(piece, `missing legacy ParcelPiece for ${shipmentRecord.shipmentId}`);
    assert.equal(piece.pieceRef, shipmentRecord.trackingCode);
    const consignment = after.resources.consignments.find(({ consignmentId }) => consignmentId === piece.consignmentId);
    const plan = before.resources.routePlans.find(({ routePlanId }) => routePlanId === shipmentRecord.currentRoutePlanId);
    assert.equal(consignment.routePlanId, plan.routePlanId);
    assert.equal(consignment.routePlanRevision, plan.revision);
  }
  assertions.push("V1 delivered, in-flight, reassigned, and pending journeys retain route/projection/replay identity and deterministic legacy Consignments");
}

const spec = {
  label: "RouteWeave Shipment creation",
  performanceScenarioIds: ["shipment-plan-ingest", "out-of-order-scan-storm", "loss-reroute-recovery"],
  seed: async () => seed(),
  path: "/api/v1/shipments",
  payload: (index) => shipment(index),
  conflictPayload: () => ({ ...shipment(0), legs: shipment(0).legs.slice(0, 2).reverse() }),
  resource: "shipments",
  identity: (json) => find(json, "shipmentId"),
  resourceIdentity: ({ shipmentId }) => shipmentId,
  workIdentity: (json) => find(json, "shipmentId"),
  async verify(ctx, baseUrl, response) {
    const shipmentId = find(response.json, "shipmentId");
    const { plan, legs } = await routeFor(ctx, baseUrl, shipmentId);
    const events = [
      scan({ shipmentId, routePlanRevision: plan.revision, legId: legs[0].legId, hubId: legs[1].fromHubId, type: "ARRIVED", index: "h03-arrive", observedAt: "2026-02-01T02:00:00.000Z" }),
      scan({ shipmentId, routePlanRevision: plan.revision, legId: legs[0].legId, hubId: legs[0].fromHubId, type: "PICKED_UP", index: "h03-pick", observedAt: "2026-02-01T00:00:00.000Z" }),
      scan({ shipmentId, routePlanRevision: plan.revision, legId: legs[0].legId, hubId: legs[0].fromHubId, type: "DEPARTED", index: "h03-depart", observedAt: "2026-02-01T01:00:00.000Z" }),
    ];
    for (const [index, event] of events.entries()) {
      const accepted = await ctx.mutate(baseUrl, "/api/v1/scan-events", `h03-scan-${index}`, event);
      assert.ok([200, 201, 202].includes(accepted.status), accepted.text);
    }
    const worker = await ctx.startWorker();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(baseUrl);
      const projected = value.resources.journeyProjections.find((entry) => entry.shipmentId === shipmentId);
      return projected?.currentHubId === legs[0].toHubId ? value : undefined;
    }, { timeoutMs: 60_000, label: "out-of-order journey projection", children: [worker] });
    assert.equal(snapshot.resources.scanEvents.filter((entry) => entry.shipmentId === shipmentId).length, 3);
  },
  async atomic(ctx, baseUrl) {
    const before = await ctx.snapshot(baseUrl);
    const rejected = await ctx.mutate(baseUrl, "/api/v1/shipments", "h04-disconnected", {
      tenantId, trackingCode: "invalid-disconnected", legs: [
        { fromHubId: hubIds[0], toHubId: hubIds[1], carrierId },
        { fromHubId: hubIds[3], toHubId: hubIds[4], carrierId },
      ],
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(before));
  },
  async contention(ctx, baseUrls) {
    const created = await ctx.mutate(baseUrls[0], "/api/v1/shipments", "h06-shipment", shipment(600));
    const shipmentId = find(created.json, "shipmentId");
    const { plan, legs } = await routeFor(ctx, baseUrls[0], shipmentId);
    const payloads = Array.from({ length: 64 }, (_, index) => scan({
      shipmentId, routePlanRevision: plan.revision, legId: legs[index % legs.length].legId,
      hubId: index % 2 ? legs[index % legs.length].fromHubId : legs[index % legs.length].toHubId,
      type: index % 2 ? "DEPARTED" : "ARRIVED", index: `h06-${index % 16}`,
      observedAt: new Date(Date.UTC(2026, 1, 2, 0, index % 16)).toISOString(),
    }));
    const accepted = await ctx.concurrent(payloads, 64, (payload, index) => ctx.mutate(baseUrls[index % 2], "/api/v1/scan-events", `h06-key-${index % 16}`, payload));
    assert.ok(accepted.every(({ status }) => [200, 201, 202, 409].includes(status)));
    const worker = await ctx.startWorker();
    await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(baseUrls[0]);
      return snapshot.work.filter(({ aggregateId }) => aggregateId === shipmentId).every(({ terminal }) => terminal) ? snapshot : undefined;
    }, { label: "scan contention drain", children: [worker] });
  },
  manager: {
    path: "/api/v1/consignments",
    payload: (index) => ({
      tenantId, externalRef: `consignment-${index}`, pieceRefs: ["piece-a", "piece-b", "piece-c"],
      legs: shipment(index).legs,
    }),
    async verify(ctx, baseUrl, response) {
      const consignmentId = find(response.json, "consignmentId");
      const worker = await ctx.startWorker();
      let snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const work = value.work.filter(({ aggregateId }) => aggregateId === consignmentId);
        return value.resources.parcelPieces.filter((entry) => entry.consignmentId === consignmentId).length === 3
          && work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
      }, { timeoutMs: 60_000, label: "Consignment piece freeze", children: [worker] });
      const pieces = snapshot.resources.parcelPieces.filter((entry) => entry.consignmentId === consignmentId);
      assert.deepEqual(pieces.map(({ pieceRef }) => pieceRef).sort(), ["piece-a", "piece-b", "piece-c"]);
      const beforeDuplicate = snapshot;
      const duplicate = await ctx.mutate(baseUrl, "/api/v1/consignments", "h10-duplicate-pieces", {
        tenantId, externalRef: "duplicate-pieces", pieceRefs: ["duplicate", "duplicate"], legs: shipment(901).legs,
      });
      assert.equal(duplicate.status, 409, duplicate.text);
      assert.equal(duplicate.json?.error?.code, "PIECE_REF_CONFLICT");
      assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(beforeDuplicate));
      const consignment = snapshot.resources.consignments.find((entry) => entry.consignmentId === consignmentId);
      const plan = snapshot.resources.routePlans.find((entry) => entry.routePlanId === consignment.routePlanId);
      const legs = snapshot.resources.transportLegs
        .filter((entry) => entry.routePlanId === consignment.routePlanId)
        .sort((a, b) => a.ordinal - b.ordinal);
      let step = 0;
      const pieceScans = [{ type: "PICKED_UP", leg: legs[0], hubId: legs[0].fromHubId }];
      for (const leg of legs) pieceScans.push({ type: "DEPARTED", leg, hubId: leg.fromHubId }, { type: "ARRIVED", leg, hubId: leg.toHubId });
      pieceScans.push({ type: "DELIVERED", leg: legs.at(-1), hubId: legs.at(-1).toHubId });
      for (const value of pieceScans) {
        const scannerEventId = `h10-piece-delivery-${step}`;
        const scanned = await ctx.mutate(baseUrl, `/api/v1/parcel-pieces/${pieces[0].pieceId}/scan-events`, scannerEventId, {
          tenantId, scannerEventId, type: value.type, routePlanRevision: plan.revision,
          legId: value.leg.legId, hubId: value.hubId,
          observedAt: new Date(Date.parse("2026-02-10T00:00:00.000Z") + step++ * 1_000).toISOString(),
        });
        assert.ok(success(scanned), scanned.text);
      }
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const aggregate = value.resources.consignments.find((entry) => entry.consignmentId === consignmentId);
        const projection = value.resources.pieceProjections.find(({ pieceId }) => pieceId === pieces[0].pieceId);
        return aggregate?.state === "PARTIALLY_DELIVERED" && projection?.state === "DELIVERED" ? value : undefined;
      }, { timeoutMs: 60_000, label: "PARTIALLY_DELIVERED Consignment", children: [worker] });
      const lost = await ctx.mutate(baseUrl, `/api/v1/parcel-pieces/${pieces[1].pieceId}/loss`, "h10-piece-loss", {
        reason: "missing piece", observedAt: "2026-02-10T01:00:00.000Z",
      });
      assert.ok(success(lost), lost.text);
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrl);
        const aggregate = value.resources.consignments.find((entry) => entry.consignmentId === consignmentId);
        const piece = value.resources.parcelPieces.find(({ pieceId }) => pieceId === pieces[1].pieceId);
        const work = value.work.filter(({ aggregateId }) => aggregateId === consignmentId);
        return aggregate?.state === "EXCEPTION" && piece?.state === "LOST"
          && work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
      }, { timeoutMs: 60_000, label: "EXCEPTION Consignment", children: [worker] });
      assert.equal(snapshot.resources.parcelPieces.find(({ pieceId }) => pieceId === pieces[2].pieceId)?.state, "PLANNED");
      assert.ok(snapshot.work.some(({ kind, aggregateId }) => kind === "CONSIGNMENT_PROJECT" && aggregateId === consignmentId));
    },
    async concurrentVerify(ctx, baseUrls, response) {
      const consignmentId = find(response.json, "consignmentId");
      let snapshot = await ctx.snapshot(baseUrls[0]);
      const consignment = snapshot.resources.consignments.find((entry) => entry.consignmentId === consignmentId);
      const originalPlan = snapshot.resources.routePlans.find(({ routePlanId }) => routePlanId === consignment.routePlanId);
      const originalLeg = snapshot.resources.transportLegs
        .filter(({ routePlanId }) => routePlanId === originalPlan.routePlanId)
        .sort((left, right) => left.ordinal - right.ordinal)[0];
      const beforeInvalid = snapshot;
      const invalid = await ctx.mutate(baseUrls[0], `/api/v1/consignments/${consignmentId}/reassign`, "h11-invalid-shared-route", {
        reason: "broken route", expectedRoutePlanRevision: 1, legs: [shipment(700).legs[0], shipment(700).legs[2]],
      });
      assert.equal(invalid.status, 400, invalid.text);
      assert.equal(invalid.json?.error?.code, "INVALID_ROUTE_PLAN");
      assert.deepEqual(stable(await ctx.snapshot(baseUrls[0])), stable(beforeInvalid));
      let releaseBarrier;
      const held = new Promise((resolve) => { releaseBarrier = resolve; });
      const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === consignmentId ? held : { status: 204 });
      const first = await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "routeweave-h11" });
      await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === consignmentId), { label: "consignment claim", children: [first] });
      await ctx.stop(first, "SIGKILL");
      releaseBarrier({ status: 204 });
      const results = await Promise.all(Array.from({ length: 16 }, (_, index) => ctx.mutate(
        baseUrls[index % 2], `/api/v1/consignments/${consignmentId}/reassign`, "h11-consignment-reassign",
        { reason: "network disruption", expectedRoutePlanRevision: 1, legs: shipment(700).legs },
      )));
      assert.equal(new Set(results.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
      assert.ok(results.every(success), results[0].text);
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const replacement = await ctx.startWorker();
      snapshot = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const work = value.work.filter(({ aggregateId }) => aggregateId === consignmentId);
        const aggregate = value.resources.consignments.find((entry) => entry.consignmentId === consignmentId);
        const projections = value.resources.pieceProjections.filter(({ pieceId }) => (
          value.resources.parcelPieces.some((piece) => piece.consignmentId === consignmentId && piece.pieceId === pieceId)
        ));
        return aggregate?.routePlanRevision === 2 && projections.length === 3
          && projections.every(({ routePlanRevision }) => routePlanRevision === 2)
          && work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
      }, { timeoutMs: 60_000, label: "atomic shared reroute recovery", children: [replacement] });
      const currentConsignment = snapshot.resources.consignments.find((entry) => entry.consignmentId === consignmentId);
      const currentPlan = snapshot.resources.routePlans.find(({ routePlanId }) => routePlanId === currentConsignment.routePlanId);
      assert.equal(currentPlan.revision, 2);
      assert.equal(currentPlan.priorRoutePlanId, originalPlan.routePlanId);
      assert.equal(snapshot.resources.routePlans.filter(({ routePlanId, priorRoutePlanId }) => routePlanId === originalPlan.routePlanId || priorRoutePlanId === originalPlan.routePlanId).length, 2);
      const pieces = snapshot.resources.parcelPieces.filter((entry) => entry.consignmentId === consignmentId);
      const staleScannerEventId = "h11-stale-old-route";
      const [staleScan, cancelled] = await Promise.all([
        ctx.mutate(baseUrls[0], `/api/v1/parcel-pieces/${pieces[0].pieceId}/scan-events`, staleScannerEventId, {
          tenantId, scannerEventId: staleScannerEventId, type: "ARRIVED", routePlanRevision: 1,
          legId: originalLeg.legId, hubId: originalLeg.toHubId, observedAt: "2026-03-01T00:00:00.000Z",
        }),
        ctx.mutate(baseUrls[1], `/api/v1/consignments/${consignmentId}/cancel`, "h11-consignment-cancel", {}),
      ]);
      assert.ok([staleScan, cancelled].every(({ status }) => success({ status }) || status === 409));
      if (staleScan.status === 409) assert.ok(["ROUTE_REVISION_CONFLICT", "EXPECTED_ROUTE_PLAN_REVISION_MISMATCH", "PIECE_TERMINAL", "CONSIGNMENT_TERMINAL"].includes(staleScan.json?.error?.code));
      const after = await ctx.waitFor(async () => {
        const value = await ctx.snapshot(baseUrls[0]);
        const work = value.work.filter(({ aggregateId }) => aggregateId === consignmentId);
        return work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
      }, { timeoutMs: 60_000, label: "scan/cancel fence recovery", children: [replacement] });
      const finalPieces = after.resources.parcelPieces.filter((entry) => entry.consignmentId === consignmentId);
      assert.equal(finalPieces.length, 3);
      assert.ok(cancelled.status === 409
        ? finalPieces.every(({ state }) => state !== "CANCELLED")
        : finalPieces.every(({ state }) => state === "CANCELLED"));
      const pieceIds = new Set(finalPieces.map(({ pieceId }) => pieceId));
      assert.ok(after.resources.pieceProjections.filter(({ pieceId }) => pieceIds.has(pieceId)).every(({ routePlanRevision }) => routePlanRevision === 2));
      assert.equal(after.resources.scanEvents.filter(({ scannerEventId }) => scannerEventId === staleScannerEventId).length, success(staleScan) ? 1 : 0);
      assert.ok(after.work.some(({ kind, aggregateId }) => kind === "CONSIGNMENT_PROJECT" && aggregateId === consignmentId));
      assert.equal(new Set(after.work.map(({ workId }) => workId)).size, after.work.length);
      assertEventOrder(after.events);
    },
  },
  cases: { "H-09": routeWeaveMigration },
  performance: routeWeavePerformance,
};

async function routeWeavePerformance(ctx, assertions) {
  const scale = performanceScale();
  await ctx.prepare();
  assert.equal((await ctx.seed(networkSeed("perf-routeweave-ingest"))).exitCode, 0);
  let api = await ctx.startApi();
  const ingestApiB = await ctx.startApi();
  const ingestCount = Math.max(100, Math.ceil(50_000 * scale));
  const ingest = await fixedLoad(ctx, { count: ingestCount, concurrency: 64, request: (index) => ctx.mutate(index % 2 ? api.baseUrl : ingestApiB.baseUrl, "/api/v1/shipments", `perf-shipment-${index}`, networkShipment(10_000 + index)) });
  assert.ok(ingest.throughput >= 300 && ingest.p95 <= 400, `shipment-plan-ingest ${ingest.throughput}/s p95=${ingest.p95}`);
  assert.equal(Object.entries(ingest.statuses).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((n, [, count]) => n + count, 0), 0);
  const ingestSnapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(ingestSnapshot.resources.shipments.length, ingestCount);
  const ingestLegs = new Map();
  for (const leg of ingestSnapshot.resources.transportLegs) {
    const values = ingestLegs.get(leg.routePlanId) ?? [];
    values.push(leg);
    ingestLegs.set(leg.routePlanId, values);
  }
  assert.ok(ingestSnapshot.resources.routePlans.every((plan) => {
    const legs = (ingestLegs.get(plan.routePlanId) ?? []).sort((a, b) => a.ordinal - b.ordinal);
    return legs.length === 4 && legs.every((leg, index) => index === 0 || legs[index - 1].toHubId === leg.fromHubId);
  }));
  assertions.push(`shipment-plan-ingest ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  assert.equal((await ctx.seed(networkSeed("perf-routeweave-scans"))).exitCode, 0);
  api = await ctx.startApi();
  const apiB = await ctx.startApi();
  const shipmentCount = Math.max(20, Math.ceil(20_000 * scale));
  const created = await ctx.concurrent(Array.from({ length: shipmentCount }), 64, (_, index) => ctx.mutate(index % 2 ? api.baseUrl : apiB.baseUrl, "/api/v1/shipments", `storm-shipment-${index}`, networkShipment(100_000 + index)));
  assert.ok(created.every(({ status }) => status >= 200 && status < 300));
  const routeSnapshot = await ctx.snapshot(api.baseUrl);
  const plansByShipment = new Map(routeSnapshot.resources.routePlans.map((plan) => [plan.shipmentId, plan]));
  const legsByPlan = new Map();
  for (const leg of routeSnapshot.resources.transportLegs) {
    const values = legsByPlan.get(leg.routePlanId) ?? [];
    values.push(leg);
    legsByPlan.set(leg.routePlanId, values);
  }
  const routes = created.map((response) => {
    const shipmentId = find(response.json, "shipmentId");
    const plan = plansByShipment.get(shipmentId);
    return { shipmentId, plan, legs: legsByPlan.get(plan.routePlanId).sort((a, b) => a.ordinal - b.ordinal) };
  });
  const uniqueScanCount = shipmentCount * 8;
  const scanCount = shipmentCount * 10;
  const storm = await fixedLoad(ctx, { count: scanCount, concurrency: 64, request: (index) => {
    const shuffled = scanCount - index - 1;
    const unique = shuffled < uniqueScanCount ? shuffled : shuffled - uniqueScanCount;
    const route = routes[Math.floor(unique / 8)];
    const step = unique % 8;
    const leg = route.legs[Math.floor(step / 2)];
    const departed = step % 2 === 0;
    return ctx.mutate(index % 2 ? api.baseUrl : apiB.baseUrl, "/api/v1/scan-events", `storm-${unique}`, scan({
      shipmentId: route.shipmentId,
      routePlanRevision: route.plan.revision,
      legId: leg.legId,
      hubId: departed ? leg.fromHubId : leg.toHubId,
      type: departed ? "DEPARTED" : "ARRIVED",
      index: `storm-${unique}`,
      observedAt: new Date(Date.UTC(2026, 2, 1, 0, 0, step)).toISOString(),
    }));
  } });
  assert.ok(storm.throughput >= 600 && storm.p95 <= 500, `out-of-order-scan-storm ${storm.throughput}/s p95=${storm.p95}`);
  assert.equal(Object.entries(storm.statuses).filter(([status]) => Number(status) < 200 || Number(status) >= 300).reduce((n, [, count]) => n + count, 0), 0);
  const projectionWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const projected = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 120_000, label: "scan projection drain", children: projectionWorkers });
  assert.equal(new Set(projected.resources.scanEvents.map(({ scannerEventId }) => scannerEventId)).size, projected.resources.scanEvents.length);
  assert.equal(projected.resources.scanEvents.length, uniqueScanCount);
  assertIndependentStormReplay(routes, projected);
  assert.equal(new Set(projected.events.map(({ eventId }) => eventId)).size, projected.events.length);
  assert.equal(new Set(projected.work.map(({ workId }) => workId)).size, projected.work.length);
  assertEventOrder(projected.events);
  assert.ok(projected.work.every(({ terminal }) => terminal));
  for (const collection of Object.values(projected.resources)) {
    assert.ok(collection.every((entry) => entry.tenantId === undefined || entry.tenantId === tenantId));
  }
  const stormRssBytes = (await Promise.all([api, apiB, ...projectionWorkers].map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  assertions.push(`out-of-order-scan-storm ${storm.throughput.toFixed(1)}/s p95 ${storm.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  assert.equal((await ctx.seed(networkSeed("perf-routeweave-loss"))).exitCode, 0);
  api = await ctx.startApi();
  const lossCount = Math.max(50, Math.ceil(10_000 * scale));
  const lossApiB = await ctx.startApi();
  const lossShipments = await ctx.concurrent(Array.from({ length: lossCount }), 64, (_, index) => ctx.mutate(api.baseUrl, "/api/v1/shipments", `loss-shipment-${index}`, networkShipment(300_000 + index)));
  assert.ok(lossShipments.every(({ status }) => status >= 200 && status < 300));
  const lossSetup = await ctx.snapshot(api.baseUrl);
  const initialPlans = new Map(lossSetup.resources.routePlans.map((entry) => [entry.shipmentId, entry]));
  const initialLegs = new Map();
  for (const leg of lossSetup.resources.transportLegs) {
    const values = initialLegs.get(leg.routePlanId) ?? [];
    values.push(leg);
    initialLegs.set(leg.routePlanId, values);
  }
  const lostResponses = await ctx.concurrent(lossShipments, 64, async (response, index) => {
    const shipmentId = find(response.json, "shipmentId");
    const lost = await ctx.mutate(index % 2 ? api.baseUrl : lossApiB.baseUrl, `/api/v1/shipments/${shipmentId}/loss`, `loss-${index}`, { reason: "missing scan", observedAt: "2026-04-01T00:00:00.000Z" });
    assert.ok(lost.status >= 200 && lost.status < 300, lost.text);
    return lost;
  });
  const lossCasesByShipment = new Map((await ctx.snapshot(api.baseUrl)).resources.lossCases.map(({ shipmentId, lossCaseId }) => [shipmentId, lossCaseId]));
  assert.equal(lossCasesByShipment.size, lossCount);
  const lifecycle = await ctx.concurrent(lossShipments, 64, async (response, index) => {
    const shipmentId = find(response.json, "shipmentId");
    const lossCaseId = lossCasesByShipment.get(shipmentId);
    assert.equal(typeof lossCaseId, "string");
    const findShipment = () => ctx.mutate(api.baseUrl, `/api/v1/shipments/${shipmentId}/found`, `found-${index}`, { observedAt: "2026-04-01T00:00:01.000Z" });
    const reassignShipment = () => ctx.mutate(lossApiB.baseUrl, `/api/v1/shipments/${shipmentId}/reassign`, `reassign-${index}`, { lossCaseId, reason: "network disruption", expectedRoutePlanRevision: 1, legs: networkShipment(400_000 + index).legs });
    let found;
    let reassigned;
    if (index % 3 === 0) {
      reassigned = await reassignShipment();
      found = await findShipment();
    } else if (index % 3 === 1) {
      found = await findShipment();
      reassigned = await reassignShipment();
    } else {
      [found, reassigned] = await Promise.all([findShipment(), reassignShipment()]);
    }
    return [lostResponses[index], found, reassigned];
  });
  assert.ok(lifecycle.flat().every(({ status }) => (status >= 200 && status < 300) || status === 409));
  assert.ok(lifecycle.every(([lost]) => lost.status >= 200 && lost.status < 300));
  assert.ok(lifecycle.every(([, found, reassigned]) => [found, reassigned].filter(({ status }) => status >= 200 && status < 300).length === 1));
  assert.ok(lifecycle.some(([, found]) => found.status >= 200 && found.status < 300));
  assert.ok(lifecycle.some(([, , reassigned]) => reassigned.status >= 200 && reassigned.status < 300));
  const recoveryAggregateId = find(lossShipments[0].json, "shipmentId");
  let releaseBarrier;
  const held = new Promise((resolve) => { releaseBarrier = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" && entry.json?.aggregateId === recoveryAggregateId ? held : { status: 204 });
  const first = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "routeweave-perf" })));
  await ctx.waitFor(() => barrier.ledger.filter(({ json }) => json?.point === "worker.claimed" && json?.aggregateId === recoveryAggregateId).length >= 2, { label: "two target projection claims", children: first });
  await Promise.all(first.map((worker) => ctx.stop(worker, "SIGKILL")));
  releaseBarrier({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const startedAt = Date.now();
  const replacements = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "loss projection drain", children: replacements });
  const durationMs = Date.now() - startedAt;
  const reassignedShipments = new Set(lossShipments.flatMap((response, index) => lifecycle[index][2].status >= 200 && lifecycle[index][2].status < 300 ? [find(response.json, "shipmentId")] : []));
  assert.equal(final.resources.lossCases.length, lossCount);
  assert.equal(new Set(final.resources.lossCases.map(({ shipmentId }) => shipmentId)).size, final.resources.lossCases.length);
  assert.ok(final.resources.lossCases.every(({ state }) => state === "RESOLVED_FOUND" || state === "RESOLVED_REASSIGNED"));
  assert.equal(new Set(final.resources.routePlans.map(({ shipmentId, revision }) => `${shipmentId}:${revision}`)).size, final.resources.routePlans.length);
  assert.equal(new Set(final.resources.reassignments.map(({ reassignmentId }) => reassignmentId)).size, final.resources.reassignments.length);
  assert.equal(new Set(final.resources.reassignments.map(({ shipmentId }) => shipmentId)).size, final.resources.reassignments.length);
  assert.equal(final.resources.reassignments.length, reassignedShipments.size);
  const lossPlansByShipment = new Map();
  for (const plan of final.resources.routePlans) {
    const values = lossPlansByShipment.get(plan.shipmentId) ?? [];
    values.push(plan);
    lossPlansByShipment.set(plan.shipmentId, values);
  }
  for (const shipment of final.resources.shipments) {
    const plans = lossPlansByShipment.get(shipment.shipmentId).sort((a, b) => a.revision - b.revision);
    const expectedRevision = reassignedShipments.has(shipment.shipmentId) ? 2 : 1;
    assert.equal(plans.at(-1).revision, expectedRevision);
    assert.equal(shipment.currentRoutePlanId, plans.at(-1).routePlanId);
  }
  const staleSamples = [...reassignedShipments].slice(0, Math.min(reassignedShipments.size, Math.max(20, Math.ceil(1000 * scale))));
  const staleResults = await ctx.concurrent(staleSamples, 64, (shipmentId, index) => {
    const plan = initialPlans.get(shipmentId);
    const leg = initialLegs.get(plan.routePlanId).sort((a, b) => a.ordinal - b.ordinal)[0];
    return ctx.mutate(index % 2 ? api.baseUrl : lossApiB.baseUrl, "/api/v1/scan-events", `stale-old-plan-${index}`, scan({
      shipmentId,
      routePlanRevision: plan.revision,
      legId: leg.legId,
      hubId: leg.toHubId,
      type: "ARRIVED",
      index: `stale-old-plan-${index}`,
      observedAt: "2026-04-02T00:00:00.000Z",
    }));
  });
  assert.ok(staleResults.every(({ status }) => status >= 200 && status < 300));
  const fenced = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return snapshot.work.every(({ terminal }) => terminal) ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "stale old-plan projection drain", children: replacements });
  const fencedProjections = new Map(fenced.resources.journeyProjections.map((entry) => [entry.shipmentId, entry]));
  assert.ok(staleSamples.every((shipmentId) => fencedProjections.get(shipmentId)?.routePlanRevision === 2));
  assert.equal(new Set(fenced.events.map(({ eventId }) => eventId)).size, fenced.events.length);
  assert.equal(new Set(fenced.work.map(({ workId }) => workId)).size, fenced.work.length);
  assertEventOrder(fenced.events);
  assert.ok(fenced.work.every(({ terminal }) => terminal));
  for (const collection of Object.values(fenced.resources)) {
    assert.ok(collection.every((entry) => entry.tenantId === undefined || entry.tenantId === tenantId));
  }
  const lossRssBytes = (await Promise.all([api, lossApiB, ...replacements].map((processRecord) => ctx.rssBytes(processRecord))))
    .reduce((sum, value) => sum + value, 0);
  assertions.push(`loss-reroute-recovery ${lossCount} shipments drained in ${durationMs}ms after two SIGKILLs`);
  return {
    metrics: [
      { scenarioId: "shipment-plan-ingest", ...ingest },
      { scenarioId: "out-of-order-scan-storm", ...storm, rssBytes: stormRssBytes },
      { scenarioId: "loss-reroute-recovery", completed: lossCount, durationMs, killedWorkers: 2, replacementWorkers: 4, rssBytes: lossRssBytes },
    ],
    topology: { apiProcesses: 2, workers: 4 },
    rssBytes: Math.max(stormRssBytes, lossRssBytes),
    databaseBytes: fenced.metrics?.databaseBytes ?? null,
  };
}

export default standardAdapter(spec);
