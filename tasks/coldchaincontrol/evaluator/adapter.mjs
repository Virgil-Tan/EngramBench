import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { standardAdapter } from "../framework/standard-adapter.mjs";
import { measuredLoad, performanceScale } from "../framework/performance-runtime.mjs";

export const PERFORMANCE_SCENARIO_IDS = [
  "signed-telemetry-ingest",
  "hot-device-ordering",
  "configuration-rollout-recovery",
  "excursion-notification-recovery",
  "recall-quarantine-convergence",
];

const id = (n) => `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const tenantId = id(1);
const siteIds = [id(10), id(11), id(12), id(13)];
const carrierIds = [id(20), id(21), id(22)];
const deviceIds = [id(30), id(31), id(32)];
const credentialIds = [id(40), id(41), id(42)];
const secrets = ["coldchain-hidden-secret-1", "coldchain-hidden-secret-2", "coldchain-hidden-secret-3"];
const configRevisionId = id(50);
const success = ({ status }) => status >= 200 && status < 300;
let managerShipmentId;
let migrationExpected;

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

function resource(snapshot, key) {
  const values = snapshot.resources?.[key];
  assert.ok(Array.isArray(values), `snapshot is missing ${key}`);
  return values;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

function responseStatuses(responses) {
  return Object.fromEntries(Map.groupBy(responses, ({ status }) => status).entries().map(([status, values]) => [status, values.length]));
}

function assertUnique(values, key, label) {
  assert.equal(new Set(values.map((value) => value[key])).size, values.length, `duplicate ${label}`);
}

function assertContiguousEventSequences(snapshot) {
  for (const [aggregate, events] of Map.groupBy(snapshot.events ?? [], ({ tenantId: valueTenantId, aggregateId }) => `${valueTenantId ?? ""}:${aggregateId}`).entries()) {
    const sequences = events.map((event) => event.aggregateSequence ?? event.sequence);
    assert.ok(sequences.every(Number.isSafeInteger), `missing event sequence for ${aggregate}`);
    assert.equal(new Set(sequences).size, sequences.length, `duplicate event sequence for ${aggregate}`);
    const ordered = [...sequences].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      assert.equal(ordered[index], ordered[index - 1] + 1, `event sequence gap for ${aggregate}`);
    }
  }
}

function hmac(secret, value) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function baseSeed(seedVersion = "hidden-coldchaincontrol") {
  return {
    schemaVersion: 1,
    seedVersion,
    importedAt: "2026-08-01T00:00:00.000Z",
    tenants: [{ tenantId, name: "Hidden Global Cold Chain" }],
    sites: siteIds.map((siteId, index) => ({
      siteId, tenantId, code: `SITE-${index + 1}`, name: `Hidden Site ${index + 1}`,
      latitudeE6: 31_000_000 + index * 100_000, longitudeE6: 121_000_000 + index * 100_000,
      radiusMeters: 1_000, timeZone: "UTC",
    })),
    carriers: carrierIds.map((carrierId, index) => ({ carrierId, tenantId, code: `C${index + 1}`, name: `Hidden Carrier ${index + 1}`, state: "ACTIVE" })),
    deviceCredentials: deviceIds.map((deviceId, index) => ({
      deviceCredentialId: credentialIds[index], tenantId, deviceId, keyVersion: 1,
      state: "ACTIVE", validFrom: "2026-01-01T00:00:00.000Z", revokedAt: null, secret: secrets[index],
    })),
    devices: deviceIds.map((deviceId, index) => ({
      deviceId, tenantId, carrierId: carrierIds[index], serialNumber: `HIDDEN-SENSOR-${index + 1}`,
      state: "ACTIVE", currentKeyVersion: 1, currentConfigVersion: 1, lastSequence: 0, lastSeenAt: null,
    })),
    configRevisions: [{
      configRevisionId, tenantId, version: 1, state: "PUBLISHED",
      minTemperatureMilliC: 2_000, maxTemperatureMilliC: 8_000,
      sampleIntervalSeconds: 30, offlineAfterSeconds: 300,
      createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:01.000Z",
    }],
    configAssignments: [], shipments: [], shipmentLegs: [], telemetryReadings: [],
    shipmentProjections: [], excursions: [], notificationPolicies: [], notificationDeliveries: [], auditEntries: [],
  };
}

function performanceDeviceId(index) {
  return id(1_000_000 + index);
}

function performanceSecret(index) {
  return `coldchain-performance-secret-${index}`;
}

function activeFleetSeed(seedVersion, { deviceCount, shipmentCount, targetLotCount = 0 }) {
  const value = baseSeed(seedVersion);
  const generatedDevices = Array.from({ length: deviceCount }, (_, index) => ({
    deviceId: performanceDeviceId(index), tenantId, carrierId: carrierIds[0], serialNumber: `PERF-SENSOR-${index}`,
    state: "ACTIVE", currentKeyVersion: 1, currentConfigVersion: 1, lastSequence: 0, lastSeenAt: null,
  }));
  const generatedCredentials = generatedDevices.map((device, index) => ({
    deviceCredentialId: id(2_000_000 + index), tenantId, deviceId: device.deviceId, keyVersion: 1,
    state: "ACTIVE", validFrom: "2026-01-01T00:00:00.000Z", revokedAt: null, secret: performanceSecret(index),
  }));
  value.devices = [...value.devices, ...generatedDevices];
  value.deviceCredentials = [...value.deviceCredentials, ...generatedCredentials];
  value.shipments = Array.from({ length: shipmentCount }, (_, index) => ({
    shipmentId: id(3_000_000 + index), tenantId, externalRef: `PERF-SHIPMENT-${index}`,
    productLotCode: index < targetLotCount ? "PERF-RECALL" : `PERF-SAFE-${index}`,
    carrierId: carrierIds[0], originSiteId: siteIds[0], destinationSiteId: siteIds[3],
    deviceId: performanceDeviceId(index % deviceCount), state: "ACTIVE",
    minimumTemperatureMilliC: 2_000, maximumTemperatureMilliC: 8_000,
    expectedStartAt: "2026-01-01T00:00:00.000Z", expectedEndAt: "2030-01-01T00:00:00.000Z",
    activatedAt: "2026-01-01T00:00:00.000Z", terminalAt: null,
  }));
  value.shipmentLegs = value.shipments.flatMap((shipment, index) => siteIds.slice(0, 3).map((fromSiteId, ordinal) => ({
    shipmentLegId: id(4_000_000 + index * 3 + ordinal), shipmentId: shipment.shipmentId, ordinal,
    fromSiteId, toSiteId: siteIds[ordinal + 1],
    plannedDepartureAt: new Date(Date.UTC(2027, 0, 1 + ordinal)).toISOString(),
    plannedArrivalAt: new Date(Date.UTC(2027, 0, 2 + ordinal)).toISOString(),
  })));
  value.shipmentProjections = value.shipments.map((shipment) => ({
    shipmentId: shipment.shipmentId, tenantId, lastSequence: 0, lastObservedAt: null,
    lastLatitudeE6: null, lastLongitudeE6: null, lastTemperatureMilliC: null,
    currentSiteId: siteIds[0], currentLegOrdinal: 0, state: "AT_SITE", updatedAt: "2026-01-01T00:00:00.000Z",
  }));
  return value;
}

function shipmentPayload(index, overrides = {}) {
  return {
    tenantId,
    externalRef: `hidden-cold-shipment-${index}`,
    productLotCode: `LOT-${Math.floor(index / 10)}`,
    carrierId: carrierIds[0], originSiteId: siteIds[0], destinationSiteId: siteIds[3], deviceId: deviceIds[0],
    minimumTemperatureMilliC: 2_000, maximumTemperatureMilliC: 8_000,
    expectedStartAt: "2028-01-01T00:00:00.000Z", expectedEndAt: "2028-01-04T00:00:00.000Z",
    legs: siteIds.slice(0, 3).map((fromSiteId, ordinal) => ({
      fromSiteId, toSiteId: siteIds[ordinal + 1],
      plannedDepartureAt: new Date(Date.UTC(2028, 0, 1 + ordinal)).toISOString(),
      plannedArrivalAt: new Date(Date.UTC(2028, 0, 2 + ordinal)).toISOString(),
    })),
    ...overrides,
  };
}

async function createShipment(ctx, baseUrl, index, overrides = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/shipments", `shipment-${index}`, shipmentPayload(index, overrides));
  assert.ok(success(response), response.text);
  return response;
}

async function activateShipment(ctx, baseUrl, index, overrides = {}) {
  const created = await createShipment(ctx, baseUrl, index, overrides);
  const shipmentId = find(created.json, "shipmentId");
  const activated = await ctx.mutate(baseUrl, `/api/v1/shipments/${shipmentId}/activate`, `activate-${index}`, {});
  assert.ok(success(activated), activated.text);
  return { shipmentId, created, activated };
}

function telemetryPayload({ shipmentId, deviceId = deviceIds[0], secret = secrets[0], keyVersion = 1, sequence, readingId = `reading-${sequence}`, temperatureMilliC = 5_000, observedAt, latitudeE6, longitudeE6, configVersion = 1 }) {
  const payload = {
    tenantId, deviceId, readingId, sequence,
    observedAt: observedAt ?? new Date(Date.UTC(2028, 0, 1, 0, 0, sequence)).toISOString(),
    latitudeE6: latitudeE6 ?? 31_000_000 + Math.min(sequence, 3) * 100_000,
    longitudeE6: longitudeE6 ?? 121_000_000 + Math.min(sequence, 3) * 100_000,
    temperatureMilliC, configVersion, keyVersion,
  };
  const canonical = `${payload.deviceId}|${payload.readingId}|${payload.sequence}|${payload.observedAt}|${payload.latitudeE6}|${payload.longitudeE6}|${payload.temperatureMilliC}|${payload.configVersion}|${payload.keyVersion}`;
  return { ...payload, signature: hmac(secret, canonical), shipmentId };
}

async function sendTelemetry(ctx, baseUrl, key, payload) {
  const { shipmentId: _shipmentId, ...body } = payload;
  return ctx.mutate(baseUrl, "/api/v1/telemetry-readings", key, body);
}

async function prepare(ctx, seedVersion) {
  await ctx.prepare();
  const imported = await ctx.seed(baseSeed(seedVersion));
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return ctx.startApi();
}

async function waitForProjection(ctx, baseUrl, shipmentId, lastSequence, children = []) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const projection = snapshot.resources.shipmentProjections.find((entry) => entry.shipmentId === shipmentId);
    return projection?.lastSequence === lastSequence ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: `projection ${shipmentId}/${lastSequence}`, children });
}

function signedDeviceHeaders(method, path, deviceId, keyVersion, secret) {
  const timestamp = new Date().toISOString();
  return {
    "x-device-id": deviceId,
    "x-device-key-version": String(keyVersion),
    "x-device-timestamp": timestamp,
    "x-device-signature": hmac(secret, `${method}|${path}|${timestamp}|${keyVersion}`),
  };
}

function deviceHeaders(method, path, deviceIndex = 0, keyVersion = 1, secret = secrets[deviceIndex]) {
  return signedDeviceHeaders(method, path, deviceIds[deviceIndex], keyVersion, secret);
}

function managerSteps() {
  const now = Date.now();
  return [
    { fromCarrierId: carrierIds[0], toCarrierId: carrierIds[1], siteId: siteIds[1], windowStart: new Date(now - 60_000).toISOString(), windowEnd: new Date(now + 300_000).toISOString() },
    { fromCarrierId: carrierIds[1], toCarrierId: carrierIds[2], siteId: siteIds[2], windowStart: new Date(now + 301_000).toISOString(), windowEnd: new Date(now + 600_000).toISOString() },
  ];
}

async function offerHandoff(ctx, baseUrl, custodyChainId, revision = 1) {
  const offered = await ctx.mutate(baseUrl, `/api/v1/custody-chains/${custodyChainId}/handoffs`, `offer-${custodyChainId}-${revision}`, { expectedChainRevision: revision });
  assert.ok(success(offered), offered.text);
  return offered;
}

async function replaceTwoClaimedWorkers(ctx, token) {
  let release;
  let claims = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => {
    if (entry.json?.point === "worker.claimed" && claims < 2) {
      claims += 1;
      return held;
    }
    return { status: 204 };
  });
  const doomed = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker({
    TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: token,
  })));
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, {
    label: `${token} two claimed workers`, children: doomed,
  });
  const survivors = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
  await Promise.all(doomed.map((worker) => ctx.stop(worker, "SIGKILL")));
  release({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacements = await Promise.all(Array.from({ length: 2 }, () => ctx.startWorker()));
  return [...survivors, ...replacements];
}

function attestedAccept(handoffId, expectedChainRevision = 1, deviceIndex = 1) {
  const acceptedAt = new Date().toISOString();
  const carrierId = carrierIds[deviceIndex];
  const keyVersion = 1;
  return {
    carrierId, deviceId: deviceIds[deviceIndex], keyVersion, acceptedAt, expectedChainRevision,
    attestation: hmac(secrets[deviceIndex], `${handoffId}|${carrierId}|${acceptedAt}|${expectedChainRevision}|${keyVersion}`),
  };
}

async function verifyMainFlow(ctx, baseUrl, response) {
  const shipmentId = find(response.json, "shipmentId");
  const activated = await ctx.mutate(baseUrl, `/api/v1/shipments/${shipmentId}/activate`, "h03-activate", {});
  assert.ok(success(activated), activated.text);
  for (const sequence of [3, 1, 2]) {
    const accepted = await sendTelemetry(ctx, baseUrl, `h03-reading-${sequence}`, telemetryPayload({ shipmentId, sequence, temperatureMilliC: 9_500 }));
    assert.ok(success(accepted), accepted.text);
  }
  const worker = await ctx.startWorker();
  const snapshot = await waitForProjection(ctx, baseUrl, shipmentId, 3, [worker]);
  assert.equal(snapshot.resources.telemetryReadings.filter((entry) => entry.deviceId === deviceIds[0]).length, 3);
  assert.ok(snapshot.resources.excursions.some((entry) => entry.shipmentId === shipmentId && entry.kind === "TEMPERATURE" && entry.state === "OPEN"));
  assert.ok(snapshot.resources.auditEntries.some((entry) => entry.resourceId === shipmentId));
  assert.ok(snapshot.events.some((entry) => entry.aggregateId === shipmentId));
}

async function atomicRejections(ctx, baseUrl) {
  const beforeRoute = await ctx.snapshot(baseUrl);
  const badRoute = await ctx.mutate(baseUrl, "/api/v1/shipments", "h04-route", shipmentPayload(400, {
    legs: [shipmentPayload(400).legs[0], { ...shipmentPayload(400).legs[2], fromSiteId: siteIds[2] }],
  }));
  assert.equal(badRoute.status, 400, badRoute.text);
  assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(beforeRoute));
  const { shipmentId } = await activateShipment(ctx, baseUrl, 401);
  const beforeSignature = await ctx.snapshot(baseUrl);
  const invalid = telemetryPayload({ shipmentId, sequence: 1 });
  invalid.signature = "0".repeat(64);
  const badSignature = await sendTelemetry(ctx, baseUrl, "h04-signature", invalid);
  assert.equal(badSignature.status, 401, badSignature.text);
  assert.equal(badSignature.json?.error?.code, "INVALID_DEVICE_SIGNATURE");
  assert.deepEqual(stable(await ctx.snapshot(baseUrl)), stable(beforeSignature));
}

async function hotTelemetryContention(ctx, baseUrls) {
  const { shipmentId } = await activateShipment(ctx, baseUrls[0], 600);
  const requests = Array.from({ length: 64 }, (_, index) => {
    const sequence = index % 16 + 1;
    return sendTelemetry(ctx, baseUrls[index % 2], `h06-reading-${sequence}`, telemetryPayload({ shipmentId, sequence, readingId: `h06-reading-${sequence}` }));
  });
  const results = await Promise.all(requests);
  assert.ok(results.every(success), results.find((item) => !success(item))?.text);
  const worker = await ctx.startWorker();
  const snapshot = await waitForProjection(ctx, baseUrls[0], shipmentId, 16, [worker]);
  assert.equal(snapshot.resources.telemetryReadings.filter((entry) => entry.deviceId === deviceIds[0]).length, 16);
}

async function prepareProjectionWork(ctx, baseUrl) {
  const { shipmentId } = await activateShipment(ctx, baseUrl, 700);
  const response = await sendTelemetry(ctx, baseUrl, "h07-reading", telemetryPayload({ shipmentId, sequence: 1 }));
  assert.ok(success(response), response.text);
  return { ...response, json: { ...response.json, shipmentId } };
}

async function verifyMigration(ctx, { snapshot }) {
  assert.ok(migrationExpected, "V1 migration fixture was not prepared");
  for (const [resource, ids] of Object.entries(migrationExpected.resources)) {
    const key = migrationExpected.keys[resource];
    const current = new Set(snapshot.resources[resource].map((entry) => entry[key]));
    for (const expected of ids) assert.ok(current.has(expected), `${resource}/${expected} was not preserved`);
  }
  assert.equal(snapshot.resources.shipmentProjections.find((entry) => entry.shipmentId === migrationExpected.shipmentId)?.lastSequence, 1);
  assert.ok(snapshot.work.some((entry) => migrationExpected.pendingWorkIds.has(entry.workId) && !entry.terminal), "pending V1 Work was not preserved");
  assert.ok(migrationExpected.eventIds.every((eventId) => snapshot.events.some((entry) => entry.eventId === eventId)), "V1 Event identity changed");
  for (const key of ["custodyChains", "custodyHandoffs", "recallOrders", "quarantineActions"]) assert.equal(snapshot.resources[key].length, 0);
  assert.ok(snapshot.resources.deviceCredentials.every((entry) => !("secret" in entry)));
}

async function prepareV1Migration(ctx, api, _receiver, workspace) {
  if (workspace === ctx.workspace) return;
  const { shipmentId } = await activateShipment(ctx, api.baseUrl, 900);
  const reading = await sendTelemetry(ctx, api.baseUrl, "h09-reading", telemetryPayload({ shipmentId, sequence: 1, readingId: "h09-reading" }));
  assert.ok(success(reading), reading.text);
  const worker = await ctx.startWorker({}, workspace);
  let snapshot = await waitForProjection(ctx, api.baseUrl, shipmentId, 1, [worker]);
  await ctx.stop(worker);
  const draft = await ctx.mutate(api.baseUrl, "/api/v1/config-revisions", "h09-config-draft", {
    tenantId, minTemperatureMilliC: 1_500, maxTemperatureMilliC: 7_500, sampleIntervalSeconds: 25, offlineAfterSeconds: 240,
  });
  assert.ok(success(draft), draft.text);
  const nextRevisionId = find(draft.json, "configRevisionId");
  assert.ok(success(await ctx.mutate(api.baseUrl, `/api/v1/config-revisions/${nextRevisionId}/publish`, "h09-config-publish", { expectedVersion: 1 })));
  const assignment = await ctx.mutate(api.baseUrl, `/api/v1/devices/${deviceIds[0]}/config-assignments`, "h09-config-assignment", {
    configRevisionId: nextRevisionId, expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.ok(success(assignment), assignment.text);
  snapshot = await ctx.snapshot(api.baseUrl);
  const keyByResource = {
    deviceCredentials: "deviceCredentialId", devices: "deviceId", configRevisions: "configRevisionId",
    configAssignments: "configAssignmentId", shipments: "shipmentId", shipmentLegs: "shipmentLegId",
    telemetryReadings: "telemetryReadingId", shipmentProjections: "shipmentId", excursions: "excursionId",
    notificationPolicies: "notificationPolicyId", notificationDeliveries: "notificationDeliveryId", auditEntries: "auditEntryId",
  };
  migrationExpected = {
    shipmentId,
    keys: keyByResource,
    resources: Object.fromEntries(Object.entries(keyByResource).map(([resource, key]) => [resource, snapshot.resources[resource].map((entry) => entry[key])])),
    pendingWorkIds: new Set(snapshot.work.filter(({ terminal }) => !terminal).map(({ workId }) => workId)),
    eventIds: snapshot.events.map(({ eventId }) => eventId),
  };
}

async function managerPrepare(ctx, baseUrl) {
  const created = await activateShipment(ctx, baseUrl, 800);
  managerShipmentId = created.shipmentId;
  return {
    path: "/api/v1/custody-chains",
    payload: () => ({ tenantId, shipmentId: managerShipmentId, expectedShipmentState: "ACTIVE", steps: managerSteps() }),
  };
}

async function verifyManager(ctx, baseUrl, response) {
  const custodyChainId = find(response.json, "custodyChainId");
  const offered = await offerHandoff(ctx, baseUrl, custodyChainId);
  const handoffId = find(offered.json, "custodyHandoffId");
  const accepted = await ctx.mutate(baseUrl, `/api/v1/custody-handoffs/${handoffId}/accept`, "h10-accept", attestedAccept(handoffId));
  assert.ok(success(accepted), accepted.text);
  const snapshot = await ctx.snapshot(baseUrl);
  assert.equal(snapshot.resources.custodyHandoffs.filter((entry) => entry.custodyChainId === custodyChainId).length, 2);
  assert.equal(snapshot.resources.custodyHandoffs.find((entry) => entry.custodyHandoffId === handoffId)?.state, "ACCEPTED");
  assert.equal(snapshot.resources.custodyChains.find((entry) => entry.custodyChainId === custodyChainId)?.currentOrdinal, 1);
  assert.equal(snapshot.resources.shipments.find((entry) => entry.shipmentId === managerShipmentId)?.carrierId, carrierIds[1]);
}

async function verifyManagerContention(ctx, baseUrls, response) {
  const custodyChainId = find(response.json, "custodyChainId");
  const offered = await offerHandoff(ctx, baseUrls[0], custodyChainId);
  const handoffId = find(offered.json, "custodyHandoffId");
  const acceptPayload = attestedAccept(handoffId);
  const accepts = await Promise.all(Array.from({ length: 16 }, (_, index) =>
    ctx.mutate(baseUrls[index % 2], `/api/v1/custody-handoffs/${handoffId}/accept`, "h11-accept", acceptPayload)));
  assert.equal(new Set(accepts.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
  const recalls = await Promise.all(Array.from({ length: 16 }, (_, index) => ctx.mutate(baseUrls[index % 2], "/api/v1/recalls", "h11-recall", {
    tenantId, productLotCode: shipmentPayload(800).productLotCode, reason: "quality investigation", issuedAt: "2028-01-02T02:00:00.000Z",
  })));
  assert.equal(new Set(recalls.map(({ status, json }) => `${status}:${ctx.canonical(json)}`)).size, 1);
  const recallId = find(recalls[0].json, "recallId");
  const quarantined = await ctx.mutate(baseUrls[0], `/api/v1/recalls/${recallId}/quarantine`, "h11-quarantine", { expectedRevision: 1 });
  assert.ok(success(quarantined), quarantined.text);
  const replacements = await replaceTwoClaimedWorkers(ctx, "h11-manager-recovery");
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(baseUrls[0]);
    return value.resources.recallOrders.find((entry) => entry.recallId === recallId)?.state === "CONTAINED" ? value : undefined;
  }, { timeoutMs: 90_000, label: "H-11 quarantine recovery", children: replacements });
  assert.equal(snapshot.resources.custodyHandoffs.filter((entry) => entry.state === "ACCEPTED").length, 1);
  assert.equal(snapshot.resources.recallOrders.length, 1);
  assert.equal(snapshot.resources.quarantineActions.filter((entry) => entry.shipmentId === managerShipmentId && entry.state === "APPLIED").length, 1);
}

async function createNotificationPolicy(ctx, baseUrl, key, destination, index = 0, overrides = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/notification-policies", key, {
    tenantId,
    eventKinds: ["EXCURSION_OPENED", "EXCURSION_RESOLVED", "RECALL_ISSUED", "QUARANTINE_APPLIED"],
    destination,
    rateLimitPerMinute: 1_000_000,
    state: "ACTIVE",
    ...overrides,
  });
  assert.ok(success(response), response.text);
  const notificationPolicyId = find(response.json, "notificationPolicyId");
  assert.equal(typeof notificationPolicyId, "string", `policy ${index} returned no notificationPolicyId`);
  return { response, notificationPolicyId };
}

async function openTemperatureExcursion(ctx, baseUrl, index, overrides = {}) {
  const { shipmentId } = await activateShipment(ctx, baseUrl, index, overrides);
  for (const sequence of [1, 2, 3]) {
    const response = await sendTelemetry(ctx, baseUrl, `excursion-${index}-${sequence}`, telemetryPayload({ shipmentId, sequence, temperatureMilliC: 9_500 }));
    assert.ok(success(response), response.text);
  }
  const worker = await ctx.startWorker();
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(baseUrl);
    return resource(value, "excursions").some((entry) => entry.shipmentId === shipmentId && entry.state === "OPEN") ? value : undefined;
  }, { timeoutMs: 60_000, label: `open excursion ${shipmentId}`, children: [worker] });
  return { shipmentId, worker, snapshot };
}

function duplicateWebhookDelivery(ledger) {
  for (let index = 1; index < ledger.length; index += 1) {
    const current = ledger[index];
    const header = Object.keys(current.headers).find((name) => name.endsWith("-event-id"));
    if (!header) continue;
    const prior = ledger.slice(0, index).find((entry) => entry.headers[header] === current.headers[header] && entry.raw === current.raw);
    if (prior) return { prior, current, header };
  }
}

async function forceUnknownAcknowledgement(ctx, receiver, token) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const barrier = await ctx.receiver((entry) => entry.json?.point === "dispatcher.response-received" ? held : { status: 204 });
  const doomed = await ctx.startDispatcher(receiver.url, { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: token });
  await ctx.waitFor(() => barrier.ledger.some((entry) => entry.json?.point === "dispatcher.response-received"), {
    timeoutMs: 60_000, label: `${token} downstream response`, children: [doomed],
  });
  await ctx.stop(doomed, "SIGKILL");
  release({ status: 204 });
  const replacement = await ctx.startDispatcher(receiver.url);
  const duplicate = await ctx.waitFor(() => duplicateWebhookDelivery(receiver.ledger), {
    timeoutMs: 60_000, label: `${token} identical retry`, children: [replacement],
  });
  assert.equal(duplicate.prior.raw, duplicate.current.raw);
  assert.equal(duplicate.prior.headers[duplicate.header], duplicate.current.headers[duplicate.header]);
  return { replacement, duplicate };
}

async function contractSecurity(ctx, assertions) {
  await ctx.prepare();
  const seed = baseSeed("h02-contract-security");
  const foreignTenantId = id(901);
  const foreignCarrierId = id(902);
  seed.tenants.push({ tenantId: foreignTenantId, name: "Hidden Foreign Tenant" });
  seed.carriers.push({ carrierId: foreignCarrierId, tenantId: foreignTenantId, code: "FOREIGN", name: "Hidden Foreign Carrier", state: "ACTIVE" });
  assert.equal((await ctx.seed(seed)).exitCode, 0);
  const api = await ctx.startApi();
  const before = await ctx.snapshot(api.baseUrl);
  const unknown = await ctx.mutate(api.baseUrl, "/api/v1/shipments", "h02-unknown", { ...shipmentPayload(200), hiddenUnknownMember: true });
  assert.equal(unknown.status, 400, unknown.text);
  assert.equal(typeof unknown.json?.error?.code, "string");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(before));
  const foreign = await ctx.mutate(api.baseUrl, "/api/v1/shipments", "h02-foreign", shipmentPayload(201, { carrierId: foreignCarrierId }));
  assert.equal(foreign.status, 404, foreign.text);
  assert.equal(foreign.json?.error?.code, "NOT_FOUND");
  const serialized = ctx.canonical(await ctx.snapshot(api.baseUrl));
  assert.doesNotMatch(serialized, /coldchain-hidden-secret|authorization|signature|attestation/iu);
  assert.doesNotMatch(`${unknown.text}\n${foreign.text}`, /stack|postgres|\/workspace|coldchain-hidden-secret/iu);
  assertions.push("strict fields, stable error envelopes, tenant isolation and secret redaction hold through public HTTP");
}

async function notificationUnknownAck(ctx, assertions) {
  const api = await prepare(ctx, "h08-notification-recovery");
  const receiver = await ctx.receiver();
  const { notificationPolicyId } = await createNotificationPolicy(ctx, api.baseUrl, "h08-policy", receiver.url);
  const { shipmentId, worker } = await openTemperatureExcursion(ctx, api.baseUrl, 800);
  const beforeDispatch = await ctx.snapshot(api.baseUrl);
  const excursionEventIds = new Set(beforeDispatch.events.filter(({ aggregateId, kind }) => aggregateId === shipmentId && /EXCURSION_OPENED/iu.test(kind ?? "")).map(({ eventId }) => eventId));
  assert.ok(excursionEventIds.size > 0, "opening the excursion emitted no public Event");
  assert.equal(resource(beforeDispatch, "notificationDeliveries").filter(({ eventId, notificationPolicyId: valuePolicyId }) => excursionEventIds.has(eventId) && valuePolicyId === notificationPolicyId).length, 1);
  await forceUnknownAcknowledgement(ctx, receiver, "h08-notification-ack");
  const final = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const deliveries = resource(value, "notificationDeliveries").filter(({ eventId }) => excursionEventIds.has(eventId));
    return deliveries.length === 1 && deliveries[0].state === "DELIVERED" ? value : undefined;
  }, { timeoutMs: 60_000, label: "H-08 stable logical delivery", children: [worker] });
  assertUnique(resource(final, "notificationDeliveries"), "notificationDeliveryId", "NotificationDelivery identity");
  assertContiguousEventSequences(final);
  assertions.push("a matching excursion notification survives an unknown webhook acknowledgement with one durable logical delivery");
}

const coreSpec = {
  label: "ColdChainControl Shipment",
  performanceScenarioIds: PERFORMANCE_SCENARIO_IDS.slice(0, 3),
  seed: async () => baseSeed(),
  path: "/api/v1/shipments",
  payload: (index) => shipmentPayload(index),
  conflictPayload: (index) => shipmentPayload(index, { maximumTemperatureMilliC: 9_000 }),
  resource: "shipments",
  identity: (json) => find(json, "shipmentId"),
  resourceIdentity: ({ shipmentId }) => shipmentId,
  workIdentity: (json) => find(json, "shipmentId"),
  noWork: true,
  afterPrepare: prepareV1Migration,
  verify: verifyMainFlow,
  atomic: atomicRejections,
  contention: hotTelemetryContention,
  prepareWork: prepareProjectionWork,
  migrationVerify: verifyMigration,
  manager: {
    path: "/api/v1/custody-chains",
    payload: () => ({ tenantId, shipmentId: managerShipmentId, expectedShipmentState: "ACTIVE", steps: managerSteps() }),
    prepare: managerPrepare,
    verify: verifyManager,
    concurrentVerify: verifyManagerContention,
  },
  performance: coldChainPerformance,
};

async function credentialRotation(ctx, assertions) {
  const apiA = await prepare(ctx, "h14-credential");
  const apiB = await ctx.startApi();
  const { shipmentId } = await activateShipment(ctx, apiA.baseUrl, 1_400);
  const rotatedSecret = "rotated-hidden-secret";
  const [rotate, racingIngest] = await Promise.all([
    ctx.mutate(apiA.baseUrl, `/api/v1/devices/${deviceIds[0]}/credentials/rotate`, "h14-rotate", {
      expectedKeyVersion: 1, secret: rotatedSecret, validFrom: "2026-01-01T00:00:00.000Z",
    }),
    sendTelemetry(ctx, apiB.baseUrl, "h14-racing-ingest", telemetryPayload({ shipmentId, sequence: 1, readingId: "h14-racing-ingest" })),
  ]);
  assert.ok(success(rotate), rotate.text);
  assert.ok(success(racingIngest) || racingIngest.status === 401, racingIngest.text);
  const afterRace = await ctx.snapshot(apiA.baseUrl);
  assert.equal(resource(afterRace, "devices").find(({ deviceId }) => deviceId === deviceIds[0])?.currentKeyVersion, 2);
  assert.ok(resource(afterRace, "telemetryReadings").filter(({ readingId }) => readingId === "h14-racing-ingest").length <= 1);

  const revoke = await ctx.mutate(apiB.baseUrl, `/api/v1/devices/${deviceIds[0]}/credentials/1/revoke`, "h14-revoke", { reason: "rotation complete" });
  assert.ok(success(revoke), revoke.text);
  const beforeFailures = await ctx.snapshot(apiA.baseUrl);
  const stale = await sendTelemetry(ctx, apiA.baseUrl, "h14-stale", telemetryPayload({ shipmentId, sequence: 2, readingId: "h14-stale" }));
  assert.equal(stale.status, 401, stale.text);
  const invalidPayload = telemetryPayload({ shipmentId, sequence: 3, readingId: "h14-invalid", keyVersion: 2, secret: rotatedSecret });
  invalidPayload.signature = "0".repeat(64);
  const invalid = await sendTelemetry(ctx, apiB.baseUrl, "h14-invalid", invalidPayload);
  assert.equal(invalid.status, 401, invalid.text);
  assert.deepEqual(stable(await ctx.snapshot(apiA.baseUrl)), stable(beforeFailures));

  const current = await sendTelemetry(ctx, apiB.baseUrl, "h14-current", telemetryPayload({
    shipmentId, sequence: 2, readingId: "h14-current", keyVersion: 2, secret: rotatedSecret,
  }));
  assert.ok(success(current), current.text);
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  const credentials = resource(snapshot, "deviceCredentials").filter(({ deviceId }) => deviceId === deviceIds[0]);
  assert.equal(credentials.filter(({ state }) => state === "ACTIVE").length, 1);
  assert.equal(credentials.find(({ keyVersion }) => keyVersion === 1)?.state, "REVOKED");
  assert.ok(credentials.every((entry) => !("secret" in entry)));
  assertContiguousEventSequences(snapshot);
  assertions.push("rotation races old-key ingest across two APIs, then revocation and invalid signatures remain side-effect free while key version 2 succeeds");
}

async function configurationConvergence(ctx, assertions) {
  await ctx.prepare();
  const fleetSize = 20_000;
  const seed = activeFleetSeed("h15-config", { deviceCount: fleetSize, shipmentCount: 0 });
  const rolloutDevices = seed.devices.slice(-fleetSize);
  assert.equal((await ctx.seed(seed)).exitCode, 0);
  const apiA = await ctx.startApi();
  const apiB = await ctx.startApi();
  const draft = await ctx.mutate(apiA.baseUrl, "/api/v1/config-revisions", "h15-draft", {
    tenantId, minTemperatureMilliC: 1_000, maxTemperatureMilliC: 7_000, sampleIntervalSeconds: 20, offlineAfterSeconds: 240,
  });
  assert.ok(success(draft), draft.text);
  const revisionId = find(draft.json, "configRevisionId");
  const published = await ctx.mutate(apiB.baseUrl, `/api/v1/config-revisions/${revisionId}/publish`, "h15-publish", { expectedVersion: 1 });
  assert.ok(success(published), published.text);
  const assignments = await ctx.concurrent(rolloutDevices, 64, (device, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/devices/${device.deviceId}/config-assignments`,
    `h15-assignment-${index}`,
    { configRevisionId: revisionId, expiresAt: "2030-01-01T00:00:00.000Z" },
  ));
  assert.ok(assignments.every(success), assignments.find((response) => !success(response))?.text);
  const expiring = await ctx.mutate(apiA.baseUrl, `/api/v1/devices/${deviceIds[0]}/config-assignments`, "h15-expiring", {
    configRevisionId: revisionId, expiresAt: new Date(Date.now() + 1_000).toISOString(),
  });
  assert.ok(success(expiring), expiring.text);
  const workers = await replaceTwoClaimedWorkers(ctx, "h15-config-recovery");
  const converged = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    const relevantAssignments = resource(value, "configAssignments").filter(({ configRevisionId: valueRevisionId }) => valueRevisionId === revisionId);
    const work = value.work.filter(({ kind }) => kind === "CONFIG_DELIVER");
    return relevantAssignments.length === fleetSize + 1
      && relevantAssignments.every(({ state }) => ["DELIVERED", "CONFIRMED", "EXPIRED"].includes(state))
      && relevantAssignments.some(({ deviceId, state }) => deviceId === deviceIds[0] && state === "EXPIRED")
      && work.length >= fleetSize + 1 && work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 120_000, intervalMs: 100, label: "20k configuration convergence", children: workers });

  const firstDevice = rolloutDevices[0];
  const assignmentId = find(assignments[0].json, "configAssignmentId");
  const path = `/api/v1/devices/${firstDevice.deviceId}/config-acknowledgements`;
  const acknowledged = await ctx.request(apiA.baseUrl, path, {
    method: "POST",
    headers: { "idempotency-key": "h15-ack", ...signedDeviceHeaders("POST", path, firstDevice.deviceId, 1, performanceSecret(0)) },
    json: { configAssignmentId: assignmentId, configVersion: 2, appliedAt: new Date().toISOString() },
  });
  assert.ok(success(acknowledged), acknowledged.text);
  const stale = await ctx.request(apiB.baseUrl, path, {
    method: "POST",
    headers: { "idempotency-key": "h15-stale", ...signedDeviceHeaders("POST", path, firstDevice.deviceId, 1, performanceSecret(0)) },
    json: { configAssignmentId: assignmentId, configVersion: 1, appliedAt: new Date().toISOString() },
  });
  assert.equal(stale.status, 409, stale.text);
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  assert.equal(resource(snapshot, "devices").find(({ deviceId }) => deviceId === firstDevice.deviceId)?.currentConfigVersion, 2);
  assert.deepEqual(resource(snapshot, "configRevisions").map(({ version }) => version).sort((left, right) => left - right), [1, 2]);
  assertUnique(snapshot.work, "workId", "configuration Work identity");
  assertContiguousEventSequences(snapshot);
  assert.ok(resource(converged, "configAssignments").length >= fleetSize + 1);
  assertions.push("20k assignments converge through four workers, two SIGKILLs, expiry and stale acknowledgement without version downgrade");
}

async function lateTelemetryCorrection(ctx, assertions) {
  const api = await prepare(ctx, "h16-late-telemetry");
  const { shipmentId } = await activateShipment(ctx, api.baseUrl, 1_600);
  for (const sequence of [6, 4, 5]) {
    const response = await sendTelemetry(ctx, api.baseUrl, `h16-${sequence}`, telemetryPayload({
      shipmentId, sequence, readingId: `h16-${sequence}`, temperatureMilliC: 9_500,
    }));
    assert.ok(success(response), response.text);
  }
  const workers = await Promise.all([ctx.startWorker(), ctx.startWorker()]);
  const beforeLate = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const excursion = resource(value, "excursions").find((entry) => entry.shipmentId === shipmentId && entry.kind === "TEMPERATURE");
    const projection = resource(value, "shipmentProjections").find((entry) => entry.shipmentId === shipmentId);
    return projection?.lastSequence === 6 && excursion?.firstSequence === 4 ? value : undefined;
  }, { timeoutMs: 60_000, label: "initial high-sequence projection", children: workers });
  const priorProjection = resource(beforeLate, "shipmentProjections").find((entry) => entry.shipmentId === shipmentId);
  for (const sequence of [1, 3, 2]) {
    const response = await sendTelemetry(ctx, api.baseUrl, `h16-${sequence}`, telemetryPayload({
      shipmentId, sequence, readingId: `h16-${sequence}`, temperatureMilliC: sequence === 3 ? 9_500 : 5_000,
    }));
    assert.ok(success(response), response.text);
  }
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const excursion = resource(value, "excursions").find((entry) => entry.shipmentId === shipmentId && entry.kind === "TEMPERATURE");
    return excursion?.firstSequence === 3 && excursion?.lastSequence === 6
      && value.work.filter(({ kind, aggregateId }) => kind === "TELEMETRY_PROJECT" && aggregateId === shipmentId).every(({ terminal }) => terminal)
      ? value : undefined;
  }, { timeoutMs: 60_000, label: "late history correction", children: workers });
  const projection = resource(snapshot, "shipmentProjections").find((entry) => entry.shipmentId === shipmentId);
  assert.equal(projection.lastSequence, 6);
  assert.equal(projection.currentSiteId, priorProjection.currentSiteId);
  assert.equal(projection.currentLegOrdinal, priorProjection.currentLegOrdinal);
  assert.equal(resource(snapshot, "telemetryReadings").filter(({ deviceId }) => deviceId === deviceIds[0]).length, 6);
  assertUnique(resource(snapshot, "telemetryReadings"), "readingId", "TelemetryReading identity");
  const beforeReplay = stable(snapshot);
  for (const sequence of [6, 4, 5, 1, 3, 2]) {
    const replay = await sendTelemetry(ctx, api.baseUrl, `h16-${sequence}`, telemetryPayload({
      shipmentId, sequence, readingId: `h16-${sequence}`, temperatureMilliC: sequence >= 3 ? 9_500 : 5_000,
    }));
    assert.ok(success(replay), replay.text);
  }
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), beforeReplay);
  assertContiguousEventSequences(snapshot);
  assertions.push("a projected high-sequence excursion is corrected by genuinely late lower sequences without current route regression, and full replay is stable");
}

async function notificationControl(ctx, assertions) {
  const api = await prepare(ctx, "h17-notification");
  const receiver = await ctx.receiver();
  const policies = await Promise.all([0, 1].map((index) => createNotificationPolicy(
    ctx, api.baseUrl, `h17-policy-${index}`, receiver.url, index,
    { eventKinds: ["EXCURSION_OPENED", "EXCURSION_RESOLVED"], rateLimitPerMinute: 4 },
  )));
  const { shipmentId, worker } = await openTemperatureExcursion(ctx, api.baseUrl, 1_700);
  const { replacement } = await forceUnknownAcknowledgement(ctx, receiver, "h17-unknown-ack");
  const secondDispatcher = await ctx.startDispatcher(receiver.url);
  for (const sequence of [4, 5, 6]) {
    const response = await sendTelemetry(ctx, api.baseUrl, `h17-${sequence}`, telemetryPayload({ shipmentId, sequence, temperatureMilliC: 5_000 }));
    assert.ok(success(response), response.text);
  }
  const resolved = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const excursion = resource(value, "excursions").find((entry) => entry.shipmentId === shipmentId && entry.kind === "TEMPERATURE");
    const eventIds = new Set(value.events.filter(({ aggregateId, kind }) => aggregateId === shipmentId && /EXCURSION_(?:OPENED|RESOLVED)/u.test(kind ?? "")).map(({ eventId }) => eventId));
    const deliveries = resource(value, "notificationDeliveries").filter(({ eventId }) => eventIds.has(eventId));
    return excursion?.state === "RESOLVED" && eventIds.size === 2 && deliveries.length === 4
      && deliveries.every(({ state }) => state === "DELIVERED") ? { value, deliveries, eventIds } : undefined;
  }, { timeoutMs: 60_000, label: "two-policy open and resolved delivery", children: [worker, replacement, secondDispatcher] });
  assert.equal(new Set(resolved.deliveries.map(({ notificationPolicyId, eventId }) => `${notificationPolicyId}:${eventId}`)).size, 4);
  assert.deepEqual(new Set(resolved.deliveries.map(({ notificationPolicyId }) => notificationPolicyId)), new Set(policies.map(({ notificationPolicyId }) => notificationPolicyId)));

  const { shipmentId: cancelledShipmentId } = await activateShipment(ctx, api.baseUrl, 1_701, { deviceId: deviceIds[1], carrierId: carrierIds[1] });
  for (const sequence of [1, 2, 3]) {
    const response = await sendTelemetry(ctx, api.baseUrl, `h17-cancel-${sequence}`, telemetryPayload({
      shipmentId: cancelledShipmentId, deviceId: deviceIds[1], secret: secrets[1], sequence, readingId: `h17-cancel-${sequence}`, temperatureMilliC: 9_500,
    }));
    assert.ok(success(response), response.text);
  }
  const cancelled = await ctx.mutate(api.baseUrl, `/api/v1/shipments/${cancelledShipmentId}/cancel`, "h17-cancel", {});
  assert.ok(success(cancelled), cancelled.text);
  await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const work = value.work.filter(({ aggregateId }) => aggregateId === cancelledShipmentId);
    return work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 60_000, label: "cancelled shipment fence", children: [worker] });
  const final = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(final, "excursions").filter(({ shipmentId: valueShipmentId }) => valueShipmentId === cancelledShipmentId).length, 0);
  assertUnique(resource(final, "notificationDeliveries"), "notificationDeliveryId", "NotificationDelivery identity");
  assert.doesNotMatch(receiver.ledger.map(({ raw }) => raw).join("\n"), /coldchain-hidden-secret|signature|attestation/iu);
  assertContiguousEventSequences(final);
  assertions.push("two policies share durable quota, survive unknown ACK, deliver open/resolved once per policy, and respect terminal cancellation fencing");
}

async function handoffAuthority(ctx, assertions) {
  const apiA = await prepare(ctx, "h18-handoff");
  const apiB = await ctx.startApi();
  const { shipmentId } = await activateShipment(ctx, apiA.baseUrl, 1_800);
  const before = await ctx.snapshot(apiA.baseUrl);
  const invalid = await ctx.mutate(apiA.baseUrl, "/api/v1/custody-chains", "h18-disconnected", {
    tenantId, shipmentId, expectedShipmentState: "ACTIVE",
    steps: [{ ...managerSteps()[0] }, { ...managerSteps()[1], fromCarrierId: carrierIds[0] }],
  });
  assert.equal(invalid.status, 400, invalid.text);
  const overlapSteps = managerSteps();
  overlapSteps[1].windowStart = new Date(new Date(overlapSteps[0].windowEnd).getTime() - 1_000).toISOString();
  const overlap = await ctx.mutate(apiB.baseUrl, "/api/v1/custody-chains", "h18-overlap", {
    tenantId, shipmentId, expectedShipmentState: "ACTIVE", steps: overlapSteps,
  });
  assert.equal(overlap.status, 400, overlap.text);
  assert.deepEqual(stable(await ctx.snapshot(apiA.baseUrl)), stable(before));
  const chain = await ctx.mutate(apiA.baseUrl, "/api/v1/custody-chains", "h18-chain", { tenantId, shipmentId, expectedShipmentState: "ACTIVE", steps: managerSteps() });
  assert.ok(success(chain), chain.text);
  const chainId = find(chain.json, "custodyChainId");
  const offer = await offerHandoff(ctx, apiA.baseUrl, chainId);
  const handoffId = find(offer.json, "custodyHandoffId");
  const wrongCarrier = await ctx.mutate(apiB.baseUrl, `/api/v1/custody-handoffs/${handoffId}/accept`, "h18-wrong-carrier", attestedAccept(handoffId, 1, 2));
  assert.ok([401, 409].includes(wrongCarrier.status), wrongCarrier.text);
  const acceptedAt = new Date().toISOString();
  const wrongKey = {
    carrierId: carrierIds[1], deviceId: deviceIds[1], keyVersion: 2, acceptedAt, expectedChainRevision: 1,
    attestation: hmac(secrets[1], `${handoffId}|${carrierIds[1]}|${acceptedAt}|1|2`),
  };
  const invalidKey = await ctx.mutate(apiA.baseUrl, `/api/v1/custody-handoffs/${handoffId}/accept`, "h18-wrong-key", wrongKey);
  assert.equal(invalidKey.status, 401, invalidKey.text);
  const staleRevision = await ctx.mutate(apiA.baseUrl, `/api/v1/custody-handoffs/${handoffId}/accept`, "h18-wrong-revision", attestedAccept(handoffId, 2));
  assert.equal(staleRevision.status, 409, staleRevision.text);

  const valid = attestedAccept(handoffId);
  const accepts = await Promise.all(Array.from({ length: 16 }, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/custody-handoffs/${handoffId}/accept`,
    `h18-accept-${index}`,
    valid,
  )));
  assert.equal(accepts.filter(success).length, 1, accepts.map(({ status }) => status).join(","));
  assert.ok(accepts.every((response) => success(response) || response.status === 409));
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  assert.equal(resource(snapshot, "custodyHandoffs").filter(({ custodyHandoffId, state }) => custodyHandoffId === handoffId && state === "ACCEPTED").length, 1);
  assert.equal(resource(snapshot, "custodyChains").find(({ custodyChainId }) => custodyChainId === chainId)?.currentOrdinal, 1);
  assert.equal(resource(snapshot, "shipments").find(({ shipmentId: valueShipmentId }) => valueShipmentId === shipmentId)?.carrierId, carrierIds[1]);
  assertContiguousEventSequences(snapshot);
  assertions.push("disconnected/overlapping chains reject atomically and 16 distinct-key accepts leave one attested Carrier authority");
}

async function recallContainment(ctx, assertions) {
  const apiA = await prepare(ctx, "h19-recall");
  const apiB = await ctx.startApi();
  const targetIds = [];
  for (const index of [1_901, 1_902, 1_903]) targetIds.push((await activateShipment(ctx, apiA.baseUrl, index, {
    deviceId: deviceIds[(index - 1_901) % 3], carrierId: carrierIds[(index - 1_901) % 3], productLotCode: "RECALL-LOT",
  })).shipmentId);
  const safeShipmentId = find((await createShipment(ctx, apiA.baseUrl, 1_904, { productLotCode: "SAFE-LOT" })).json, "shipmentId");
  const payload = { tenantId, productLotCode: "RECALL-LOT", reason: "temperature investigation", issuedAt: new Date().toISOString() };
  const recalls = await Promise.all(Array.from({ length: 16 }, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/recalls", `h19-recall-${index}`, payload,
  )));
  assert.equal(recalls.filter(success).length, 1, recalls.map(({ status }) => status).join(","));
  assert.ok(recalls.every((response) => success(response) || response.status === 409));
  const winningIndex = recalls.findIndex(success);
  const recall = recalls[winningIndex];
  const replay = await ctx.mutate(apiA.baseUrl, "/api/v1/recalls", `h19-recall-${winningIndex}`, payload);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(recall.json));
  const recallId = find(recall.json, "recallId");
  const started = await ctx.mutate(apiA.baseUrl, `/api/v1/recalls/${recallId}/quarantine`, "h19-quarantine", { expectedRevision: 1 });
  assert.ok(success(started), started.text);
  const workers = await replaceTwoClaimedWorkers(ctx, "h19-recall-recovery");
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(apiA.baseUrl);
    return resource(value, "recallOrders").find((entry) => entry.recallId === recallId)?.state === "CONTAINED" ? value : undefined;
  }, { timeoutMs: 90_000, label: "recall containment", children: workers });
  const actions = resource(snapshot, "quarantineActions").filter((entry) => entry.recallId === recallId);
  assert.deepEqual(new Set(actions.map(({ shipmentId }) => shipmentId)), new Set(targetIds));
  assert.ok(actions.every(({ state }) => state === "APPLIED"));
  assertUnique(actions, "quarantineActionId", "QuarantineAction identity");
  assert.ok(actions.every(({ shipmentId }) => shipmentId !== safeShipmentId));
  const blocked = await ctx.mutate(apiB.baseUrl, `/api/v1/shipments/${targetIds[0]}/deliver`, "h19-deliver-quarantined", {});
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.json?.error?.code, "SHIPMENT_QUARANTINED");
  assertContiguousEventSequences(snapshot);
  assertions.push("16 competing Recall creations freeze one exact affected set and recover through four workers with two SIGKILLs");
}

async function crossFeatureFaultDrill(ctx, assertions) {
  const api = await prepare(ctx, "h20-fault-drill");
  const apiB = await ctx.startApi();
  const { shipmentId } = await activateShipment(ctx, api.baseUrl, 2_000, { productLotCode: "FAULT-LOT" });
  const receiver = await ctx.receiver();
  await createNotificationPolicy(ctx, api.baseUrl, "h20-policy", receiver.url, 0, {
    eventKinds: ["EXCURSION_OPENED", "RECALL_ISSUED", "QUARANTINE_APPLIED"], rateLimitPerMinute: 1_000,
  });
  const draft = await ctx.mutate(api.baseUrl, "/api/v1/config-revisions", "h20-config", {
    tenantId, minTemperatureMilliC: 1_500, maxTemperatureMilliC: 7_500, sampleIntervalSeconds: 20, offlineAfterSeconds: 240,
  });
  assert.ok(success(draft), draft.text);
  const revisionId = find(draft.json, "configRevisionId");
  assert.ok(success(await ctx.mutate(api.baseUrl, `/api/v1/config-revisions/${revisionId}/publish`, "h20-config-publish", { expectedVersion: 1 })));
  assert.ok(success(await ctx.mutate(api.baseUrl, `/api/v1/devices/${deviceIds[0]}/config-assignments`, "h20-config-assign", {
    configRevisionId: revisionId, expiresAt: "2030-01-01T00:00:00.000Z",
  })));
  assert.ok(success(await ctx.mutate(api.baseUrl, `/api/v1/devices/${deviceIds[0]}/credentials/rotate`, "h20-key-rotate", {
    expectedKeyVersion: 1, secret: "h20-rotated-secret", validFrom: "2026-01-01T00:00:00.000Z",
  })));
  assert.ok(success(await ctx.mutate(api.baseUrl, `/api/v1/devices/${deviceIds[0]}/credentials/1/revoke`, "h20-key-revoke", { reason: "fault drill" })));
  const beforeStaleKey = await ctx.snapshot(api.baseUrl);
  const staleKey = await sendTelemetry(ctx, api.baseUrl, "h20-stale-key", telemetryPayload({ shipmentId, sequence: 99, readingId: "h20-stale-key" }));
  assert.equal(staleKey.status, 401, staleKey.text);
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(beforeStaleKey));
  const readings = await Promise.all([8, 3, 7, 1, 6, 2, 5, 4].map((sequence, index) =>
    sendTelemetry(ctx, index % 2 ? api.baseUrl : apiB.baseUrl, `h20-reading-${sequence}`, telemetryPayload({
      shipmentId, sequence, temperatureMilliC: sequence >= 6 ? 9_500 : 5_000,
      keyVersion: 2, secret: "h20-rotated-secret",
    }))));
  assert.ok(readings.every(success));
  const chain = await ctx.mutate(api.baseUrl, "/api/v1/custody-chains", "h20-chain", { tenantId, shipmentId, expectedShipmentState: "ACTIVE", steps: managerSteps() });
  assert.ok(success(chain), chain.text);
  const chainId = find(chain.json, "custodyChainId");
  const offered = await offerHandoff(ctx, apiB.baseUrl, chainId);
  const handoffId = find(offered.json, "custodyHandoffId");
  const accepted = await ctx.mutate(api.baseUrl, `/api/v1/custody-handoffs/${handoffId}/accept`, "h20-accept", attestedAccept(handoffId));
  assert.ok(success(accepted), accepted.text);
  const recall = await ctx.mutate(apiB.baseUrl, "/api/v1/recalls", "h20-recall", { tenantId, productLotCode: "FAULT-LOT", reason: "fault drill", issuedAt: new Date().toISOString() });
  assert.ok(success(recall), recall.text);
  const recallId = find(recall.json, "recallId");
  assert.ok(success(await ctx.mutate(api.baseUrl, `/api/v1/recalls/${recallId}/quarantine`, "h20-quarantine", { expectedRevision: 1 })));
  const replacements = await replaceTwoClaimedWorkers(ctx, "h20-cross-feature");
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const projection = value.resources.shipmentProjections.find((entry) => entry.shipmentId === shipmentId);
    const action = value.resources.quarantineActions.find((entry) => entry.shipmentId === shipmentId);
    const work = value.work.filter(({ kind }) => ["CONFIG_DELIVER", "TELEMETRY_PROJECT", "RECALL_PROPAGATE", "QUARANTINE_ENFORCE"].includes(kind));
    return projection?.lastSequence === 8 && action?.state === "APPLIED" && work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 90_000, label: "cross-feature fault drill", children: replacements });
  assertUnique(snapshot.events, "eventId", "Event identity");
  assertUnique(snapshot.work, "workId", "Work identity");
  assertContiguousEventSequences(snapshot);
  assert.equal(snapshot.resources.quarantineActions.filter((entry) => entry.shipmentId === shipmentId).length, 1);
  assert.equal(snapshot.resources.configRevisions.find((entry) => entry.configRevisionId === revisionId)?.state, "PUBLISHED");
  assert.equal(snapshot.resources.deviceCredentials.find((entry) => entry.deviceId === deviceIds[0] && entry.keyVersion === 1)?.state, "REVOKED");
  assert.equal(snapshot.resources.deviceCredentials.find((entry) => entry.deviceId === deviceIds[0] && entry.keyVersion === 2)?.state, "ACTIVE");
  assert.equal(resource(snapshot, "custodyChains").find(({ custodyChainId }) => custodyChainId === chainId)?.currentOrdinal, 1);
  assert.equal(resource(snapshot, "shipments").find(({ shipmentId: valueShipmentId }) => valueShipmentId === shipmentId)?.carrierId, carrierIds[1]);
  const blockedOffer = await ctx.mutate(apiB.baseUrl, `/api/v1/custody-chains/${chainId}/handoffs`, "h20-blocked-handoff", { expectedChainRevision: 2 });
  assert.equal(blockedOffer.status, 409, blockedOffer.text);
  assert.equal(blockedOffer.json?.error?.code, "SHIPMENT_QUARANTINED");
  await forceUnknownAcknowledgement(ctx, receiver, "h20-dispatcher-recovery");
  assert.doesNotMatch(receiver.ledger.map(({ raw }) => raw).join("\n"), /h20-rotated-secret|signature|attestation/iu);
  assertions.push("two APIs, attested handoff, out-of-order telemetry, two Worker SIGKILLs and an unknown-ACK dispatcher converge without authority or sequence drift");
}

function metric(scenarioId, value, extra = {}) {
  return {
    scenarioId, completed: value.completed ?? 0, durationMs: value.durationMs ?? 0,
    throughput: value.throughput ?? 0, p50: value.p50 ?? 0, p95: value.p95 ?? 0, p99: value.p99 ?? 0,
    statuses: value.statuses ?? {}, ...extra,
  };
}

function scaledDuration(value, scale) {
  return Math.max(250, Math.ceil(value * scale));
}

async function coldChainPerformance(ctx, assertions) {
  const scale = performanceScale();
  const metrics = [];

  await ctx.prepare();
  const ingestDeviceCount = Math.max(20, Math.ceil(2_000 * scale));
  const ingestShipmentCount = Math.max(10, Math.ceil(500 * scale));
  const ingestSeed = activeFleetSeed("perf-signed-ingest", { deviceCount: ingestDeviceCount, shipmentCount: ingestShipmentCount });
  ingestSeed.tenants.push(...Array.from({ length: 99 }, (_, index) => ({ tenantId: id(10_000 + index), name: `Hidden Inactive Tenant ${index + 2}` })));
  assert.equal((await ctx.seed(ingestSeed)).exitCode, 0);
  let api = await ctx.startApi();
  let issued = 0;
  const sequences = Array.from({ length: ingestShipmentCount }, () => 0);
  const ingest = await measuredLoad(ctx, {
    concurrency: 64, warmupMs: scaledDuration(10_000, scale), measureMs: scaledDuration(60_000, scale),
    request: () => {
      const requestId = ++issued;
      const shipmentIndex = requestId % ingestShipmentCount;
      const sequence = ++sequences[shipmentIndex];
      const shipment = ingestSeed.shipments[shipmentIndex];
      return sendTelemetry(ctx, api.baseUrl, `perf-ingest-${requestId}`, telemetryPayload({
        shipmentId: shipment.shipmentId, deviceId: shipment.deviceId,
        secret: performanceSecret(shipmentIndex), sequence, readingId: `perf-ingest-${requestId}`,
      }));
    },
  });
  assert.ok(Object.keys(ingest.statuses).every((status) => Number(status) >= 200 && Number(status) < 300));
  if (scale === 1) assert.ok(ingest.throughput >= 1_500 && ingest.p95 <= 120, `signed-telemetry-ingest ${ingest.throughput}/s p95=${ingest.p95}`);
  const ingestWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const ingestSnapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const work = value.work.filter(({ kind }) => kind === "TELEMETRY_PROJECT");
    return resource(value, "telemetryReadings").length === issued && work.length === issued
      && work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 120_000, label: "signed telemetry drain", children: ingestWorkers });
  assert.equal(ingestSeed.tenants.length, 100);
  assert.equal(ingestSnapshot.events.length, issued);
  assert.equal(resource(ingestSnapshot, "auditEntries").length, issued);
  assertUnique(resource(ingestSnapshot, "telemetryReadings"), "telemetryReadingId", "signed TelemetryReading identity");
  assertUnique(ingestSnapshot.work, "workId", "signed telemetry Work identity");
  assertContiguousEventSequences(ingestSnapshot);
  assert.doesNotMatch(ctx.canonical({ events: ingestSnapshot.events, auditEntries: ingestSnapshot.resources.auditEntries }), /coldchain-performance-secret|signature/iu);
  metrics.push(metric(PERFORMANCE_SCENARIO_IDS[0], ingest, { acceptedReadings: issued, tenants: 100, devices: ingestDeviceCount, shipments: ingestShipmentCount }));
  assertions.push(`signed-telemetry-ingest ${ingest.throughput.toFixed(1)}/s p95 ${ingest.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const hotDeviceCount = Math.max(10, Math.ceil(500 * scale));
  const sequencesPerDevice = 100;
  const hotSeed = activeFleetSeed("perf-hot-ordering", { deviceCount: hotDeviceCount, shipmentCount: hotDeviceCount });
  assert.equal((await ctx.seed(hotSeed)).exitCode, 0);
  api = await ctx.startApi();
  const apiB = await ctx.startApi();
  const uniqueCount = hotDeviceCount * sequencesPerDevice;
  const requests = Array.from({ length: Math.ceil(uniqueCount * 1.2) }, (_, index) => index % uniqueCount).reverse();
  const startedHot = performance.now();
  const hotLatencies = [];
  const hotResponses = await ctx.concurrent(requests, 64, async (value, index) => {
    const deviceIndex = Math.floor(value / sequencesPerDevice);
    const sequence = value % sequencesPerDevice + 1;
    const shipment = hotSeed.shipments[deviceIndex];
    const response = await sendTelemetry(ctx, index % 2 ? api.baseUrl : apiB.baseUrl, `perf-hot-${value}`, telemetryPayload({
      shipmentId: shipment.shipmentId, deviceId: shipment.deviceId, secret: performanceSecret(deviceIndex),
      sequence, readingId: `perf-hot-${deviceIndex}-${sequence}`,
    }));
    hotLatencies.push(response.durationMs);
    return response;
  });
  const hotDuration = performance.now() - startedHot;
  hotLatencies.sort((a, b) => a - b);
  const percentile = (fraction) => hotLatencies[Math.max(0, Math.ceil(hotLatencies.length * fraction) - 1)] ?? 0;
  assert.ok(hotResponses.every(success));
  const hotMetric = { completed: hotResponses.length, durationMs: hotDuration, throughput: hotResponses.length / (hotDuration / 1_000), p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), statuses: { 200: hotResponses.length } };
  if (scale === 1) assert.ok(hotMetric.throughput >= 900 && hotMetric.p95 <= 180, `hot-device-ordering ${hotMetric.throughput}/s p95=${hotMetric.p95}`);
  const hotWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const hotSnapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const projections = resource(value, "shipmentProjections").filter(({ shipmentId }) => hotSeed.shipments.some((shipment) => shipment.shipmentId === shipmentId));
    return resource(value, "telemetryReadings").length === uniqueCount && projections.length === hotDeviceCount
      && projections.every(({ lastSequence }) => lastSequence === sequencesPerDevice)
      && value.work.filter(({ kind }) => kind === "TELEMETRY_PROJECT").every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 180_000, intervalMs: 100, label: "500 hot-device projections", children: hotWorkers });
  assert.equal(resource(hotSnapshot, "telemetryReadings").length, uniqueCount);
  assert.ok(resource(hotSnapshot, "shipmentProjections").filter(({ shipmentId }) => hotSeed.shipments.some((shipment) => shipment.shipmentId === shipmentId)).every((projection) => (
    projection.lastLatitudeE6 === 31_300_000 && projection.lastLongitudeE6 === 121_300_000
    && projection.currentSiteId === siteIds[3] && projection.currentLegOrdinal >= 2
  )), "hot-device projections disagree with the independent final-coordinate oracle");
  assert.equal(hotSnapshot.events.length, uniqueCount);
  assert.equal(resource(hotSnapshot, "auditEntries").length, uniqueCount);
  assertUnique(hotSnapshot.work, "workId", "hot-device Work identity");
  assertContiguousEventSequences(hotSnapshot);
  metrics.push(metric(PERFORMANCE_SCENARIO_IDS[1], { ...hotMetric, statuses: responseStatuses(hotResponses) }, {
    uniqueReadings: uniqueCount, hotDevices: hotDeviceCount, sequencesPerDevice,
  }));
  assertions.push(`hot-device-ordering ${hotMetric.throughput.toFixed(1)}/s p95 ${hotMetric.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const configSeed = baseSeed("perf-config-recovery");
  const fleetSize = Math.max(100, Math.ceil(20_000 * scale));
  configSeed.devices = Array.from({ length: fleetSize }, (_, index) => ({ ...configSeed.devices[index % 3], deviceId: id(100_000 + index), serialNumber: `PERF-${index}`, carrierId: carrierIds[index % 3] }));
  configSeed.deviceCredentials = configSeed.devices.map((device, index) => ({ deviceCredentialId: id(200_000 + index), tenantId, deviceId: device.deviceId, keyVersion: 1, state: "ACTIVE", validFrom: "2026-01-01T00:00:00.000Z", revokedAt: null, secret: `perf-secret-${index}` }));
  assert.equal((await ctx.seed(configSeed)).exitCode, 0);
  api = await ctx.startApi();
  const draft = await ctx.mutate(api.baseUrl, "/api/v1/config-revisions", "perf-config-draft", { tenantId, minTemperatureMilliC: 1_500, maxTemperatureMilliC: 7_500, sampleIntervalSeconds: 15, offlineAfterSeconds: 180 });
  assert.ok(success(draft), draft.text);
  const perfRevision = find(draft.json, "configRevisionId");
  assert.ok(success(await ctx.mutate(api.baseUrl, `/api/v1/config-revisions/${perfRevision}/publish`, "perf-config-publish", { expectedVersion: 1 })));
  const configStarted = performance.now();
  const assignments = await ctx.concurrent(configSeed.devices, 64, (device, index) => ctx.mutate(api.baseUrl, `/api/v1/devices/${device.deviceId}/config-assignments`, `perf-assignment-${index}`, { configRevisionId: perfRevision, expiresAt: "2030-01-01T00:00:00.000Z" }));
  assert.ok(assignments.every(success));
  const configWorkers = await replaceTwoClaimedWorkers(ctx, "perf-config-recovery");
  const configSnapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const work = value.work.filter(({ kind }) => kind === "CONFIG_DELIVER");
    return resource(value, "configAssignments").length === fleetSize
      && resource(value, "configAssignments").every(({ state }) => ["DELIVERED", "CONFIRMED", "EXPIRED"].includes(state))
      && work.length === fleetSize && work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 60_000, label: "configuration rollout recovery", children: configWorkers });
  const configRecoveryMs = performance.now() - configStarted;
  const assignmentLatencies = assignments.map(({ durationMs }) => durationMs);
  const queueP95Ms = percentile(assignmentLatencies, .95);
  const firstAssignmentId = find(assignments[0].json, "configAssignmentId");
  const firstDevice = configSeed.devices[0];
  const acknowledgementPath = `/api/v1/devices/${firstDevice.deviceId}/config-acknowledgements`;
  const acknowledged = await ctx.request(api.baseUrl, acknowledgementPath, {
    method: "POST",
    headers: { "idempotency-key": "perf-config-ack", ...signedDeviceHeaders("POST", acknowledgementPath, firstDevice.deviceId, 1, "perf-secret-0") },
    json: { configAssignmentId: firstAssignmentId, configVersion: 2, appliedAt: new Date().toISOString() },
  });
  assert.ok(success(acknowledged), acknowledged.text);
  const stale = await ctx.request(api.baseUrl, acknowledgementPath, {
    method: "POST",
    headers: { "idempotency-key": "perf-config-stale", ...signedDeviceHeaders("POST", acknowledgementPath, firstDevice.deviceId, 1, "perf-secret-0") },
    json: { configAssignmentId: firstAssignmentId, configVersion: 1, appliedAt: new Date().toISOString() },
  });
  assert.equal(stale.status, 409, stale.text);
  const afterAck = await ctx.snapshot(api.baseUrl);
  assert.equal(resource(afterAck, "devices").find(({ deviceId }) => deviceId === firstDevice.deviceId)?.currentConfigVersion, 2);
  assertUnique(configSnapshot.work, "workId", "configuration-rollout Work identity");
  assertContiguousEventSequences(afterAck);
  metrics.push(metric(PERFORMANCE_SCENARIO_IDS[2], {
    completed: fleetSize,
    durationMs: configRecoveryMs,
    throughput: fleetSize / (configRecoveryMs / 1_000),
    p50: percentile(assignmentLatencies, .5), p95: queueP95Ms, p99: percentile(assignmentLatencies, .99),
    statuses: responseStatuses(assignments),
  }, { recoveryMs: configRecoveryMs, queueP95Ms, terminalAssignments: fleetSize, killedWorkers: 2, survivingWorkers: 2, replacementWorkers: 2 }));
  assertions.push(`configuration-rollout-recovery ${fleetSize} assignments in ${configRecoveryMs.toFixed(0)}ms`);

  await ctx.resetDatabase();
  const excursionCount = Math.max(20, Math.ceil(5_000 * scale));
  const excursionSeed = activeFleetSeed("perf-excursion-notification", { deviceCount: excursionCount, shipmentCount: excursionCount });
  assert.equal((await ctx.seed(excursionSeed)).exitCode, 0);
  api = await ctx.startApi();
  const excursionReceiver = await ctx.receiver();
  for (const policyIndex of [0, 1]) {
    const policy = await ctx.mutate(api.baseUrl, "/api/v1/notification-policies", `perf-policy-${policyIndex}`, {
      tenantId, eventKinds: ["EXCURSION_OPENED", "EXCURSION_RESOLVED"],
      destination: excursionReceiver.url, rateLimitPerMinute: 1_000_000, state: "ACTIVE",
    });
    assert.ok(success(policy), policy.text);
  }
  const excursionStarted = performance.now();
  const excursionRequests = Array.from({ length: excursionCount * 6 }, (_, requestIndex) => ({
    index: Math.floor(requestIndex / 6), sequence: requestIndex % 6 + 1,
  }));
  const excursionResponses = await ctx.concurrent(excursionRequests, 64, async ({ index, sequence }) => {
      const shipment = excursionSeed.shipments[index];
      return sendTelemetry(ctx, api.baseUrl, `perf-excursion-${index}-${sequence}`, telemetryPayload({
        shipmentId: shipment.shipmentId, deviceId: shipment.deviceId, secret: performanceSecret(index),
        sequence, readingId: `perf-excursion-${index}-${sequence}`,
        temperatureMilliC: sequence <= 3 ? 9_500 : 5_000,
      }));
  });
  assert.ok(excursionResponses.every(success), excursionResponses.find((response) => !success(response))?.text);
  const excursionWorkers = await Promise.all(Array.from({ length: 4 }, () => ctx.startWorker()));
  const excursionSnapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const excursions = resource(value, "excursions").filter(({ kind }) => kind === "TEMPERATURE");
    const work = value.work.filter(({ kind }) => kind === "TELEMETRY_PROJECT");
    const eventIds = new Set(value.events.filter(({ kind }) => /EXCURSION_(?:OPENED|RESOLVED)/u.test(kind ?? "")).map(({ eventId }) => eventId));
    const deliveries = resource(value, "notificationDeliveries").filter(({ eventId }) => eventIds.has(eventId));
    return excursions.length === excursionCount && excursions.every(({ state }) => state === "RESOLVED")
      && work.length === excursionCount * 6 && work.every(({ terminal }) => terminal)
      && eventIds.size === excursionCount * 2 && deliveries.length === excursionCount * 4 ? value : undefined;
  }, { timeoutMs: 60_000, label: "excursion notification recovery", children: excursionWorkers });
  const excursionEventIds = new Set(excursionSnapshot.events
    .filter(({ kind }) => /EXCURSION_(?:OPENED|RESOLVED)/u.test(kind ?? ""))
    .map(({ eventId }) => eventId));
  const logicalExcursionDeliveries = resource(excursionSnapshot, "notificationDeliveries")
    .filter(({ eventId }) => excursionEventIds.has(eventId));
  assert.equal(logicalExcursionDeliveries.length, excursionCount * 4);
  assert.equal(new Set(logicalExcursionDeliveries.map(({ notificationPolicyId, eventId }) => `${notificationPolicyId}:${eventId}`)).size, excursionCount * 4);
  let releaseAcks;
  let heldAcks = 0;
  const ackHold = new Promise((resolve) => { releaseAcks = resolve; });
  const dispatcherBarrier = await ctx.receiver((entry) => {
    if (entry.json?.point === "dispatcher.response-received" && heldAcks < 2) {
      heldAcks += 1;
      return ackHold;
    }
    return { status: 204 };
  });
  const doomedDispatchers = await Promise.all(Array.from({ length: 2 }, () => ctx.startDispatcher(excursionReceiver.url, {
    TEST_BARRIER_URL: dispatcherBarrier.url, TEST_BARRIER_TOKEN: "perf-excursion-ack",
  })));
  await ctx.waitFor(() => dispatcherBarrier.ledger.filter((entry) => entry.json?.point === "dispatcher.response-received").length >= 2, {
    label: "two lost dispatcher acknowledgements", children: doomedDispatchers,
  });
  await Promise.all(doomedDispatchers.map((dispatcher) => ctx.stop(dispatcher, "SIGKILL")));
  releaseAcks({ status: 204 });
  const excursionDispatchers = await Promise.all([ctx.startDispatcher(excursionReceiver.url), ctx.startDispatcher(excursionReceiver.url)]);
  await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const deliveries = resource(value, "notificationDeliveries").filter(({ eventId }) => excursionEventIds.has(eventId));
    return excursionReceiver.ledger.length >= excursionCount * 4 + 2
      && deliveries.length === excursionCount * 4
      && deliveries.every(({ state }) => state === "DELIVERED") ? value : undefined;
  }, {
    timeoutMs: 60_000, label: "excursion notification fan-out", children: excursionDispatchers,
  });
  const eventHeader = Object.keys(excursionReceiver.ledger[0].headers).find((name) => name.endsWith("-event-id"));
  assert.ok(eventHeader, "dispatcher omitted the stable event identity");
  assert.ok(excursionReceiver.ledger.some((entry, index, values) => index > 0
    && values.slice(0, index).some((prior) => prior.headers[eventHeader] === entry.headers[eventHeader] && prior.raw === entry.raw)),
  "unknown acknowledgement did not retry an identical event identity and body");
  const excursionRecoveryMs = performance.now() - excursionStarted;
  assert.ok(excursionRecoveryMs <= 60_000 || scale < 1, `excursion-notification-recovery took ${excursionRecoveryMs}ms`);
  assertUnique(logicalExcursionDeliveries, "notificationDeliveryId", "performance NotificationDelivery identity");
  assertContiguousEventSequences(excursionSnapshot);
  metrics.push(metric(PERFORMANCE_SCENARIO_IDS[3], {
    completed: excursionCount, durationMs: excursionRecoveryMs,
    throughput: excursionCount / (excursionRecoveryMs / 1_000),
    p50: percentile(excursionResponses.map(({ durationMs }) => durationMs), .5),
    p95: percentile(excursionResponses.map(({ durationMs }) => durationMs), .95),
    p99: percentile(excursionResponses.map(({ durationMs }) => durationMs), .99),
    statuses: responseStatuses(excursionResponses),
  }, {
    recoveryMs: excursionRecoveryMs, excursions: excursionCount,
    resolvedExcursions: excursionCount, logicalDeliveries: excursionCount * 4,
    lostAcknowledgements: 2,
  }));
  assertions.push(`excursion-notification-recovery ${excursionCount} shipments in ${excursionRecoveryMs.toFixed(0)}ms`);

  await ctx.resetDatabase();
  const recallTotal = Math.max(100, Math.ceil(10_000 * scale));
  const recallCount = Math.max(20, Math.ceil(2_500 * scale));
  const recallSeed = activeFleetSeed("perf-recall-quarantine", { deviceCount: recallTotal, shipmentCount: recallTotal, targetLotCount: recallCount });
  assert.equal((await ctx.seed(recallSeed)).exitCode, 0);
  api = await ctx.startApi();
  const recallApiB = await ctx.startApi();
  const recallReceiver = await ctx.receiver();
  const { notificationPolicyId: recallPolicyId } = await createNotificationPolicy(ctx, api.baseUrl, "perf-recall-policy", recallReceiver.url, 0, {
    eventKinds: ["RECALL_ISSUED", "QUARANTINE_APPLIED"], rateLimitPerMinute: 1_000_000,
  });
  const chainCount = Math.min(recallCount, Math.max(5, Math.ceil(500 * scale)));
  const chains = await ctx.concurrent(Array.from({ length: chainCount }), 32, async (_, index) => {
    const response = await ctx.mutate(api.baseUrl, "/api/v1/custody-chains", `perf-chain-${index}`, {
      tenantId, shipmentId: recallSeed.shipments[index].shipmentId, expectedShipmentState: "ACTIVE", steps: managerSteps(),
    });
    assert.ok(success(response), response.text);
    return response;
  });
  const offers = await ctx.concurrent(chains, 32, async (chain, index) => {
    const response = await offerHandoff(ctx, api.baseUrl, find(chain.json, "custodyChainId"));
    assert.ok(success(response), response.text);
    return { index, chainId: find(chain.json, "custodyChainId"), handoffId: find(response.json, "custodyHandoffId") };
  });
  const recallStarted = performance.now();
  const recallPayload = { tenantId, productLotCode: "PERF-RECALL", reason: "performance containment", issuedAt: new Date().toISOString() };
  const conflictingRecallPayload = { ...recallPayload, reason: "conflicting performance containment" };
  const recallRequests = Array.from({ length: 64 }, (_, index) => ({ index, payload: index % 2 ? recallPayload : conflictingRecallPayload }));
  const [recallResponses, acceptResponses, deliverResponses, telemetryResponses] = await Promise.all([
    ctx.concurrent(recallRequests, 64, ({ index, payload }) => ctx.mutate(index % 2 ? api.baseUrl : recallApiB.baseUrl, "/api/v1/recalls", "perf-recall", payload)),
    ctx.concurrent(offers, 64, ({ index, handoffId }) => ctx.mutate(index % 2 ? api.baseUrl : recallApiB.baseUrl, `/api/v1/custody-handoffs/${handoffId}/accept`, `perf-accept-${index}`, attestedAccept(handoffId))),
    ctx.concurrent(recallSeed.shipments.slice(0, chainCount), 64, (shipment, index) => ctx.mutate(index % 2 ? api.baseUrl : recallApiB.baseUrl, `/api/v1/shipments/${shipment.shipmentId}/deliver`, `perf-deliver-${index}`, {})),
    ctx.concurrent(recallSeed.shipments.slice(0, chainCount), 64, (shipment, index) => sendTelemetry(ctx, index % 2 ? api.baseUrl : recallApiB.baseUrl, `perf-recall-telemetry-${index}`, telemetryPayload({
      shipmentId: shipment.shipmentId, deviceId: shipment.deviceId, secret: performanceSecret(index), sequence: 1,
      readingId: `perf-recall-telemetry-${index}`,
    }))),
  ]);
  assert.ok(recallResponses.every(({ status }) => success({ status }) || status === 409));
  const winningRecall = recallResponses.find(success);
  assert.ok(winningRecall, "64 replay/conflict clients created no Recall");
  assert.equal(new Set(recallResponses.filter(success).map(({ json }) => ctx.canonical(json))).size, 1);
  const winningRequest = recallRequests[recallResponses.findIndex(success)];
  const replayedRecall = await ctx.mutate(api.baseUrl, "/api/v1/recalls", "perf-recall", winningRequest.payload);
  assert.equal(ctx.canonical(replayedRecall.json), ctx.canonical(winningRecall.json));
  assert.ok(acceptResponses.every(({ status }) => success({ status }) || status === 409));
  assert.ok(deliverResponses.every(({ status }) => success({ status }) || status === 409));
  assert.ok(telemetryResponses.every(({ status }) => success({ status }) || status === 409));
  const recallId = find(winningRecall.json, "recallId");
  assert.ok(success(await ctx.mutate(api.baseUrl, `/api/v1/recalls/${recallId}/quarantine`, "perf-quarantine", { expectedRevision: 1 })));
  const recallWorkers = await replaceTwoClaimedWorkers(ctx, "perf-recall-recovery");
  const recallSnapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const actions = resource(value, "quarantineActions").filter((entry) => entry.recallId === recallId);
    const work = value.work.filter(({ kind }) => ["TELEMETRY_PROJECT", "RECALL_PROPAGATE", "QUARANTINE_ENFORCE"].includes(kind));
    return resource(value, "recallOrders").find((entry) => entry.recallId === recallId)?.state === "CONTAINED"
      && actions.length === recallCount && actions.every(({ state }) => state === "APPLIED")
      && work.length > 0 && work.every(({ terminal }) => terminal) ? value : undefined;
  }, { timeoutMs: 90_000, label: "recall quarantine convergence", children: recallWorkers });
  const recallRecoveryMs = performance.now() - recallStarted;
  const appliedActions = resource(recallSnapshot, "quarantineActions").filter((entry) => entry.recallId === recallId && entry.state === "APPLIED");
  const applied = appliedActions.length;
  const targetShipmentIds = new Set(recallSeed.shipments.slice(0, recallCount).map(({ shipmentId }) => shipmentId));
  assert.equal(applied, recallCount);
  assert.equal(appliedActions.filter(({ shipmentId }) => !targetShipmentIds.has(shipmentId)).length, 0);
  assert.equal(resource(recallSnapshot, "quarantineActions").filter(({ state }) => state === "RELEASED").length, 0);
  assertUnique(appliedActions, "quarantineActionId", "performance QuarantineAction identity");
  for (const handoff of resource(recallSnapshot, "custodyHandoffs").filter(({ state }) => state === "ACCEPTED")) {
    const chain = resource(recallSnapshot, "custodyChains").find(({ custodyChainId }) => custodyChainId === handoff.custodyChainId);
    const shipment = resource(recallSnapshot, "shipments").find(({ shipmentId }) => shipmentId === chain?.shipmentId);
    assert.equal(chain?.currentOrdinal, 1, `accepted handoff ${handoff.custodyHandoffId} split chain authority`);
    assert.equal(shipment?.carrierId, handoff.toCarrierId, `accepted handoff ${handoff.custodyHandoffId} split Shipment authority`);
  }
  const blocked = await ctx.mutate(recallApiB.baseUrl, `/api/v1/shipments/${recallSeed.shipments[0].shipmentId}/deliver`, "perf-post-quarantine-deliver", {});
  assert.equal(blocked.status, 409, blocked.text);
  assert.equal(blocked.json?.error?.code, "SHIPMENT_QUARANTINED");
  const beforeStaleAccept = await ctx.snapshot(api.baseUrl);
  const staleAccept = await ctx.mutate(recallApiB.baseUrl, `/api/v1/custody-handoffs/${offers[0].handoffId}/accept`, "perf-post-quarantine-accept", attestedAccept(offers[0].handoffId));
  assert.equal(staleAccept.status, 409, staleAccept.text);
  const afterStaleAccept = await ctx.snapshot(api.baseUrl);
  for (const key of ["shipments", "custodyChains", "custodyHandoffs", "recallOrders", "quarantineActions"]) {
    assert.equal(ctx.canonical(resource(afterStaleAccept, key)), ctx.canonical(resource(beforeStaleAccept, key)), `stale accept changed ${key}`);
  }
  const recallDispatchers = await Promise.all([ctx.startDispatcher(recallReceiver.url), ctx.startDispatcher(recallReceiver.url)]);
  const recallDelivered = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl);
    const deliveries = resource(value, "notificationDeliveries").filter(({ notificationPolicyId }) => notificationPolicyId === recallPolicyId);
    return deliveries.length > 0 && deliveries.every(({ state }) => state === "DELIVERED") ? { value, deliveries } : undefined;
  }, { timeoutMs: 90_000, label: "recall notification drain", children: recallDispatchers });
  assert.equal(new Set(recallDelivered.deliveries.map(({ notificationPolicyId, eventId }) => `${notificationPolicyId}:${eventId}`)).size, recallDelivered.deliveries.length);
  const recallWebhookEventIds = recallReceiver.ledger.map((entry) => Object.entries(entry.headers).find(([name]) => name.endsWith("-event-id"))?.[1]);
  assert.ok(recallWebhookEventIds.every(Boolean), "recall webhook omitted stable Event identity");
  assert.equal(recallReceiver.ledger.length, recallDelivered.deliveries.length);
  assert.equal(new Set(recallWebhookEventIds).size, recallWebhookEventIds.length, "recall emitted a duplicate external Event identity");
  assert.ok(recallRecoveryMs <= 90_000 || scale < 1, `recall-quarantine-convergence took ${recallRecoveryMs}ms`);
  assertContiguousEventSequences(recallDelivered.value);
  metrics.push(metric(PERFORMANCE_SCENARIO_IDS[4], {
    completed: recallCount, durationMs: recallRecoveryMs,
    throughput: recallCount / (recallRecoveryMs / 1_000),
    p50: percentile(recallResponses.map(({ durationMs }) => durationMs), .5),
    p95: percentile(recallResponses.map(({ durationMs }) => durationMs), .95),
    p99: percentile(recallResponses.map(({ durationMs }) => durationMs), .99),
    statuses: responseStatuses(recallResponses),
  }, {
    recoveryMs: recallRecoveryMs, appliedQuarantines: applied, activeShipments: recallTotal,
    offeredChains: chainCount, acceptedHandoffs: acceptResponses.filter(success).length,
    concurrentDeliveries: deliverResponses.length, concurrentTelemetry: telemetryResponses.length,
    notificationDeliveries: recallDelivered.deliveries.length, killedWorkers: 2,
  }));
  assertions.push(`recall-quarantine-convergence ${applied} shipments in ${recallRecoveryMs.toFixed(0)}ms`);

  return { metrics };
}

const base = standardAdapter(coreSpec);

const adapter = {
  ...base,
  performanceScenarioIds: PERFORMANCE_SCENARIO_IDS,
  taskSpecificCaseIds: [...new Set([...base.taskSpecificCaseIds, "H-14", "H-15", "H-16", "H-17", "H-18", "H-19", "H-20"])].sort(),
  cases: {
    ...base.cases,
    "H-08": notificationUnknownAck,
    "coldchain-contract-security": contractSecurity,
    "H-14": credentialRotation,
    "H-15": configurationConvergence,
    "H-16": lateTelemetryCorrection,
    "H-17": notificationControl,
    "H-18": handoffAuthority,
    "H-19": recallContainment,
    "H-20": crossFeatureFaultDrill,
  },
};

export default adapter;
