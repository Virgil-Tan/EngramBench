import authorAssert from "node:assert/strict";
import { candidateAssert as assert } from "../lib/execution.mjs";
import { createHash, createHmac } from "node:crypto";
import { assertPublishedWork } from './openapi.mjs';

export function canonicalJson(value) { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; }
export function exactKeys(value, keys, label = "value") { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} exact keys`); }
export function tupleSort(items, fields) { return [...items].sort((left, right) => { for (const field of fields) { const a = left[field], b = right[field]; if (a === b) continue; if (a === null) return -1; if (b === null) return 1; if (Number.isSafeInteger(a) && Number.isSafeInteger(b)) return a - b; return Buffer.from(String(a)).compare(Buffer.from(String(b))); } return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right))); }); }
export function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
// Across fresh databases, compare business effects, not random physical row IDs.
// Per-run identity, schema, ordering and secret checks remain assertSnapshotShape's job.
export function reproducibleEvidence(snapshot) {
  const aliases = new Map();
  const resources = snapshot.resources;
  for (const row of resources.telemetryReadings ?? []) aliases.set(row.telemetryReadingId, `reading:${row.deviceId}:${row.readingId}`);
  for (const row of resources.excursions ?? []) aliases.set(row.excursionId, `excursion:${row.shipmentId}:${row.kind}:${row.firstSequence}`);
  const operational = new Set(['asOf','receivedAt','updatedAt','occurredAt','createdAt','openedAt','acknowledgedAt','resolvedAt',
    'scheduledAt','availableAt','leasedAt','completedAt','terminalAt','nextAttemptAt','deliveredAt','leaseOwner','leaseToken','leaseExpiresAt','attempt','attempts']);
  function clean(value) {
    if (typeof value === 'string') return aliases.get(value) ?? value;
    if (Array.isArray(value)) return value.map(clean); // Business payload array order is meaningful.
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !operational.has(key)).map(([key, child]) => [key, clean(child)]));
  }
  for (const event of snapshot.events) aliases.set(event.eventId, `event:${event.aggregateType}:${clean(event.aggregateId)}:${event.kind}:${canonicalJson(clean(event.payload))}`);
  for (const row of resources.notificationDeliveries ?? []) aliases.set(row.notificationDeliveryId, `delivery:${row.notificationPolicyId}:${clean(row.eventId)}`);
  for (const row of snapshot.work) aliases.set(row.workId, `work:${row.kind}:${clean(row.aggregateId)}`);
  const sorted = rows => rows.map(clean).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  const result = {
    resources: Object.fromEntries(Object.entries(resources).map(([name, rows]) => [name, sorted(name === 'auditEntries'
      ? rows.map(({ auditEntryId, actorRef, ...row }) => ({ ...row, ...(row.actorType === 'SYSTEM' ? {} : { actorRef }) })) : rows)])),
    managerResources: Object.fromEntries(Object.entries(snapshot.managerResources ?? {}).map(([name, rows]) => [name, sorted(rows)])),
    work: sorted(snapshot.work),
    events: sorted(snapshot.events.map(({ sequence, ...event }) => event)),
  };
  return result;
}
export function hmacSha256(secret, value) { return createHmac("sha256", secret).update(value, "utf8").digest("hex"); }
export function deviceAuthLine(method, path, timestamp, keyVersion) { return `${method}|${path}|${timestamp}|${keyVersion}`; }
export function telemetryLine(reading) { return [reading.deviceId, reading.readingId, reading.sequence, reading.observedAt, reading.latitudeE6, reading.longitudeE6, reading.temperatureMilliC, reading.configVersion, reading.keyVersion].join("|"); }
export function handoffAttestationLine(handoffId, carrierId, acceptedAt, expectedChainRevision, keyVersion) { return `${handoffId}|${carrierId}|${acceptedAt}|${expectedChainRevision}|${keyVersion}`; }
export function signedDeviceHeaders({ method, path, timestamp, keyVersion, deviceId, secret }) { return { "x-device-id": deviceId, "x-device-key-version": String(keyVersion), "x-device-timestamp": timestamp, "x-device-signature": hmacSha256(secret, deviceAuthLine(method, path, timestamp, keyVersion)) }; }
export function signReading(reading, secret) { return { ...reading, signature: hmacSha256(secret, telemetryLine(reading)) }; }

export function distanceMillimetres(a, b) {
  const rad = value => value / 1_000_000 * Math.PI / 180;
  const lat1 = rad(a.latitudeE6), lat2 = rad(b.latitudeE6);
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(rad(b.longitudeE6 - a.longitudeE6) / 2) ** 2;
  return Math.floor(2 * 6371008.8 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h)))) * 1000 + 0.5);
}
export function selectSite(reading, sites) {
  return sites.map(site => ({ site, distance: distanceMillimetres(reading, site) }))
    .filter(({ site, distance }) => distance <= site.radiusMeters * 1000)
    .sort((a, b) => a.distance - b.distance || a.site.siteId.localeCompare(b.site.siteId))[0]?.site;
}
export function assertNotificationWire(snapshot, entries) {
  for (const entry of entries) {
    const event = snapshot.events.find(e => e.eventId === entry.headers['x-coldchain-event-id']);
    assert.ok(event, 'webhook event belongs to committed snapshot');
    const { outboxState, ...wire } = event;
    assert.equal(Buffer.from(entry.raw).toString('utf8'), canonicalJson(wire), 'canonical immutable webhook bytes');
    assert.equal(entry.headers['content-type']?.split(';')[0], 'application/json');
    if (/^(EXCURSION_(OPENED|RESOLVED)|SHIPMENT_(DELIVERED|CANCELLED)|RECALL_(ISSUED|CONTAINED))$/.test(event.kind)) {
      exactKeys(event.payload, ['resourceType', 'resourceId', 'shipmentId', 'state'], 'notification payload');
      const excursion = event.kind.startsWith('EXCURSION_'), recall = event.kind.startsWith('RECALL_');
      assert.equal(event.payload.resourceType, excursion ? 'Excursion' : recall ? 'RecallOrder' : 'ColdShipment');
      const rows = excursion ? snapshot.resources.excursions : recall ? snapshot.managerResources.recallOrders : snapshot.resources.shipments;
      const key = excursion ? 'excursionId' : recall ? 'recallId' : 'shipmentId';
      const row = rows.find(r => r[key] === event.payload.resourceId);
      assert.ok(row, 'notification references a real resource');
      assert.equal(event.payload.shipmentId, recall ? null : excursion ? row.shipmentId : row.shipmentId);
      assert.equal(event.aggregateId, recall ? row.recallId : row.shipmentId);
      assert.equal(event.aggregateType, recall ? 'RecallOrder' : 'ColdShipment');
      const state = { EXCURSION_OPENED: 'OPEN', EXCURSION_RESOLVED: 'RESOLVED', SHIPMENT_DELIVERED: 'DELIVERED', SHIPMENT_CANCELLED: 'CANCELLED', RECALL_ISSUED: 'ISSUED', RECALL_CONTAINED: 'CONTAINED' }[event.kind];
      assert.equal(event.payload.state, state, 'historical transition state, not current projection');
    }
  }
}
export function assertSlidingQuota(times, limit, windowMs = 60_000) {
  const sorted = [...times].sort((a, b) => a - b); let start = 0;
  for (let i = 0; i < sorted.length; i++) { while (sorted[start] <= sorted[i] - windowMs) start++; assert.ok(i - start + 1 <= limit, 'shared rolling-window admission budget'); }
}

export function projectReadings(readings, { minimum = 2_000, maximum = 8_000, sites = [], initialLegOrdinal = 0 } = {}) {
  const ordered = [...readings].sort((left, right) => left.sequence - right.sequence || Buffer.from(left.readingId).compare(Buffer.from(right.readingId))); let lastSequence = 0, last, currentLegOrdinal = initialLegOrdinal, currentSiteId = null, runOut = 0, runIn = 0, open;
  const excursions = [];
  for (const reading of ordered) {
    lastSequence = Math.max(lastSequence, reading.sequence); last = reading;
    const site = selectSite(reading, sites), siteIndex = sites.findIndex(candidate => candidate === site);
    currentSiteId = siteIndex >= currentLegOrdinal && siteIndex >= 0 ? site.siteId : null;
    if (currentSiteId !== null) currentLegOrdinal = siteIndex;
    const outside = reading.temperatureMilliC < minimum || reading.temperatureMilliC > maximum;
    if (outside) { runOut += 1; runIn = 0; if (runOut === 3 && !open) { const first = ordered[ordered.indexOf(reading) - 2]; open = { kind: "TEMPERATURE", state: "OPEN", firstSequence: first.sequence, lastSequence: reading.sequence, minimumObservedMilliC: Math.min(...ordered.slice(ordered.indexOf(reading) - 2, ordered.indexOf(reading) + 1).map((item) => item.temperatureMilliC)), maximumObservedMilliC: Math.max(...ordered.slice(ordered.indexOf(reading) - 2, ordered.indexOf(reading) + 1).map((item) => item.temperatureMilliC)) }; excursions.push(open); } else if (open) { open.lastSequence = reading.sequence; open.minimumObservedMilliC = Math.min(open.minimumObservedMilliC, reading.temperatureMilliC); open.maximumObservedMilliC = Math.max(open.maximumObservedMilliC, reading.temperatureMilliC); } }
    else { runIn += 1; runOut = 0; if (open && open.state !== "RESOLVED" && runIn === 3) { open.state = "RESOLVED"; open = undefined; } }
  }
  return { lastSequence, lastObservedAt: last?.observedAt ?? null, lastLatitudeE6: last?.latitudeE6 ?? null, lastLongitudeE6: last?.longitudeE6 ?? null, lastTemperatureMilliC: last?.temperatureMilliC ?? null, currentSiteId, currentLegOrdinal, excursions };
}
export function validateCustodySteps(steps, shipment, sites) { authorAssert.ok(steps.length >= 1); let carrier = shipment.carrierId, lastWindowEnd = "", lastSiteIndex = -1; for (const [ordinal, step] of steps.entries()) { authorAssert.equal(step.fromCarrierId, carrier, `handoff ${ordinal} connected carrier`); authorAssert.notEqual(step.toCarrierId, step.fromCarrierId); authorAssert.ok(step.windowStart < step.windowEnd && (!lastWindowEnd || step.windowStart >= lastWindowEnd), `handoff ${ordinal} window`); const index = sites.findIndex(({ siteId }) => siteId === step.siteId); authorAssert.ok(index >= lastSiteIndex, `handoff ${ordinal} monotonic site`); carrier = step.toCarrierId; lastWindowEnd = step.windowEnd; lastSiteIndex = index; } return true; }
export function frozenRecallSet(shipments, tenantId, lot) { return shipments.filter((item) => item.tenantId === tenantId && item.productLotCode === lot && item.state !== "CANCELLED").map(({ shipmentId }) => shipmentId).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))); }
export function assertEventSequence(events) { const groups = new Map(); for (const event of events) { const values = groups.get(event.aggregateId) ?? []; values.push(event); groups.set(event.aggregateId, values); } for (const values of groups.values()) { values.sort((a, b) => a.sequence - b.sequence); values.forEach((event, index) => assert.equal(event.sequence, index + 1, `contiguous Event sequence for ${event.aggregateId}`)); assert.equal(new Set(values.map(({ eventId }) => eventId)).size, values.length); } return true; }
export function assertNoSecrets(value, secrets = [], { snapshot = false } = {}) {
  const encoded = JSON.stringify(value);
  let fieldEvidence = value;
  if (snapshot) {
    assertPublishedWork(value.work);
    // Only the published snapshot.work[].leaseToken field is public fencing data.
    fieldEvidence = { ...value, work: value.work.map(({ leaseToken, ...item }) => item) };
  }
  assert.equal(/"(?:secret|authorization|attestation|[^"]*Token)"\s*:/iu.test(JSON.stringify(fieldEvidence)), false, "public evidence omits secret field names");
  function visit(item, key = "") { if (!item || typeof item !== "object") { if (/signature$/iu.test(key) && typeof item === "string") assert.equal(/^[0-9a-f]{64}$/u.test(item), false, `${key} raw signature redacted`); return; } for (const [childKey, child] of Object.entries(item)) visit(child, childKey); }
  visit(value);
  for (const secret of secrets.filter(Boolean)) assert.equal(encoded.includes(secret), false, "public evidence omits secret material");
  return true;
}
export function assertWork(work) { const identities = new Set(); for (const item of work) { assert.equal(typeof item.workId, "string"); assert.equal(identities.has(item.workId), false); identities.add(item.workId); assert.equal(typeof item.kind, "string"); assert.equal(typeof item.aggregateId, "string"); assert.ok(Number.isSafeInteger(item.attempt) && item.attempt >= 0); assert.equal(typeof item.terminal, "boolean"); if (item.terminal) assert.notEqual(item.state, "LEASED"); } return true; }
export function assertNotificationIdentity(deliveries, receiverEntries) { const byEvent = new Map(); for (const delivery of deliveries) { const existing = byEvent.get(`${delivery.notificationPolicyId}:${delivery.eventId}`); if (existing) assert.equal(existing, delivery.notificationDeliveryId); else byEvent.set(`${delivery.notificationPolicyId}:${delivery.eventId}`, delivery.notificationDeliveryId); } for (const group of Map.groupBy(receiverEntries, (entry) => entry.headers["x-coldchain-event-id"]).values()) { assert.ok(group[0]?.headers["x-coldchain-event-id"]); const body = canonicalJson(group[0].json); assert.ok(group.every((entry) => canonicalJson(entry.json) === body), "retry semantic body stable"); } return true; }
