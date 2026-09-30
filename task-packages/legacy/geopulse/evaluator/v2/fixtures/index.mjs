import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function milliseconds(offset = {}) {
  return (offset.days ?? 0) * 86_400_000
    + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000
    + (offset.seconds ?? 0) * 1_000
    + (offset.milliseconds ?? 0);
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32) || "value";
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + milliseconds(offset)).toISOString(); },
    key(label) { return `gp-${slug(caseId)}-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 18)}`.slice(0, 128); },
    integer(label, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) throw new TypeError("invalid integer range");
      return minimum + (hash(namespace, "integer", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

function regionVersion(fixtures, fields = {}) {
  return {
    regionVersionId: fields.regionVersionId ?? fixtures.uuid("region-version-1"),
    regionId: fields.regionId ?? fixtures.uuid("region-1"),
    tenantId: fields.tenantId ?? fixtures.uuid("tenant"),
    revision: fields.revision ?? 1,
    effectiveFrom: fields.effectiveFrom ?? fixtures.at({ days: -1 }),
    effectiveTo: fields.effectiveTo ?? null,
    polygon: fields.polygon ?? [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]],
    boundaryToleranceMeters: fields.boundaryToleranceMeters ?? 5,
    dwellSeconds: fields.dwellSeconds ?? 2,
    createdAt: fields.createdAt ?? fixtures.at({ days: -2 }),
  };
}

export function geometryFixture(fixtures) {
  const tenantId = fixtures.uuid("tenant");
  const regionId = fixtures.uuid("region-1");
  const polygon = [[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]];
  return {
    tenantId,
    regionId,
    polygon,
    inside: { longitude: 0.005, latitude: 0.005 },
    outside: { longitude: 0.02, latitude: 0.005 },
    edge: { longitude: 0.01, latitude: 0.005 },
    vertex: { longitude: 0, latitude: 0 },
    openRing: polygon.slice(0, -1),
    selfIntersecting: [[0, 0], [0.01, 0.01], [0, 0.01], [0.01, 0], [0, 0]],
    versions: [
      regionVersion(fixtures, {
        tenantId,
        regionId,
        revision: 1,
        regionVersionId: fixtures.uuid("region-version-1"),
        effectiveFrom: fixtures.at({ days: -1 }),
        effectiveTo: fixtures.at(),
        polygon,
      }),
      regionVersion(fixtures, {
        tenantId,
        regionId,
        revision: 2,
        regionVersionId: fixtures.uuid("region-version-2"),
        effectiveFrom: fixtures.at(),
        effectiveTo: null,
        polygon: [[0, 0], [0.02, 0], [0.02, 0.02], [0, 0.02], [0, 0]],
      }),
    ],
  };
}

function locationEvent(fixtures, sequence, point, offset = {}, fields = {}) {
  return {
    eventId: fields.eventId ?? fixtures.uuid(`event-${sequence}`),
    tenantId: fields.tenantId ?? fixtures.uuid("tenant"),
    deviceId: fields.deviceId ?? fixtures.uuid("device"),
    deviceSequence: sequence,
    observedAt: fields.observedAt ?? fixtures.at(offset),
    longitude: point.longitude,
    latitude: point.latitude,
    accuracyMeters: fields.accuracyMeters ?? 3,
  };
}

export function timelineFixture(fixtures) {
  const geometry = geometryFixture(fixtures);
  const version = regionVersion(fixtures, {
    tenantId: geometry.tenantId,
    regionId: geometry.regionId,
    polygon: geometry.polygon,
    boundaryToleranceMeters: 5,
    dwellSeconds: 2,
  });
  const points = {
    outside: { longitude: 0.0102, latitude: 0.005 },
    nearOutside: { longitude: 0.01002, latitude: 0.005 },
    nearInside: { longitude: 0.00998, latitude: 0.005 },
    inside: { longitude: 0.0099, latitude: 0.005 },
    edge: geometry.edge,
  };
  return {
    regionVersion: version,
    events: [
      locationEvent(fixtures, 1, points.outside, { seconds: 0 }),
      locationEvent(fixtures, 2, points.nearOutside, { milliseconds: 500 }),
      locationEvent(fixtures, 3, points.nearInside, { seconds: 1 }),
      locationEvent(fixtures, 4, points.inside, { seconds: 2 }),
      locationEvent(fixtures, 5, points.edge, { seconds: 3, milliseconds: 999 }),
      locationEvent(fixtures, 6, points.inside, { seconds: 4 }),
      locationEvent(fixtures, 7, points.nearOutside, { seconds: 5 }),
      locationEvent(fixtures, 8, points.outside, { seconds: 6 }),
      locationEvent(fixtures, 9, points.inside, { seconds: 7 }),
    ],
  };
}

export function lateWorkedExample(fixtures) {
  const geometry = geometryFixture(fixtures);
  const region = regionVersion(fixtures, {
    tenantId: geometry.tenantId,
    regionId: geometry.regionId,
    polygon: geometry.polygon,
    boundaryToleranceMeters: 0,
    dwellSeconds: 3_600,
  });
  const outside = { longitude: 0.02, latitude: 0.005 };
  const inside = geometry.inside;
  const boundary = geometry.edge;
  const canonical = [
    locationEvent(fixtures, 1, outside, { seconds: 1 }),
    locationEvent(fixtures, 2, boundary, { seconds: 2 }),
    locationEvent(fixtures, 3, inside, { seconds: 3 }),
    locationEvent(fixtures, 4, outside, { seconds: 4 }),
    locationEvent(fixtures, 5, boundary, { seconds: 5 }),
    locationEvent(fixtures, 6, inside, { seconds: 6 }),
  ];
  const tooOld = locationEvent(fixtures, 0, outside, { minutes: -11 }, { eventId: fixtures.uuid("event-0") });
  return { regionVersion: region, canonical, arrivalOrder: [canonical[3], canonical[4], canonical[5], canonical[2], canonical[1], canonical[0]], tooOld };
}

export function identityFixture(fixtures) {
  const geometry = geometryFixture(fixtures);
  const event = locationEvent(fixtures, 1, geometry.inside, { seconds: 1 });
  return {
    event,
    sameEventIdDifferentBody: { ...event, longitude: 0.006 },
    sameSequenceDifferentEventId: { ...event, eventId: fixtures.uuid("identity-other-event"), longitude: 0.007 },
    otherTenant: {
      ...event,
      tenantId: fixtures.uuid("tenant-other"),
      deviceId: fixtures.uuid("device-other"),
    },
  };
}

export function bundleFixture(fixtures, count = 3) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new TypeError("bundle member count must be 1..10000");
  const regionVersionIds = Array.from({ length: count }, (_, index) => fixtures.uuid(`bundle-region-version-${index + 1}`)).sort();
  return Object.freeze({
    tenantId: fixtures.uuid("tenant"),
    bundleId: fixtures.uuid("bundle"),
    regionVersionIds,
    effectiveFrom: fixtures.at({ hours: -1 }),
  });
}

export function coreSeed(fixtures, options = {}) {
  const geometry = geometryFixture(fixtures);
  const secondRegionId = fixtures.uuid("region-2");
  const secondVersion = regionVersion(fixtures, {
    tenantId: geometry.tenantId,
    regionId: secondRegionId,
    regionVersionId: fixtures.uuid("region-version-second"),
    polygon: [[0.02, 0.02], [0.03, 0.02], [0.03, 0.03], [0.02, 0.03], [0.02, 0.02]],
  });
  const firstVersion = geometry.versions[1];
  return {
    schemaVersion: 1,
    seedVersion: options.seedVersion ?? `gp-${slug(fixtures.caseId)}-${hash(fixtures.evaluationSeed, fixtures.caseId, "seed").toString("hex").slice(0, 12)}`,
    importedAt: fixtures.at({ days: -3 }),
    tenants: [
      { tenantId: geometry.tenantId, name: "GeoPulse Evaluator Tenant" },
      ...(options.includeOtherTenant ? [{ tenantId: fixtures.uuid("tenant-other"), name: "Other Isolated Tenant" }] : []),
    ],
    devices: [
      { deviceId: fixtures.uuid("device"), tenantId: geometry.tenantId, externalRef: "device-primary", createdAt: fixtures.at({ days: -2 }) },
      ...(options.includeOtherTenant ? [{ deviceId: fixtures.uuid("device-other"), tenantId: fixtures.uuid("tenant-other"), externalRef: "device-other", createdAt: fixtures.at({ days: -2 }) }] : []),
    ],
    regions: [
      { regionId: geometry.regionId, tenantId: geometry.tenantId, name: "Primary Rectangle", createdAt: fixtures.at({ days: -2 }) },
      { regionId: secondRegionId, tenantId: geometry.tenantId, name: "Second Rectangle", createdAt: fixtures.at({ days: -2 }) },
    ],
    regionVersions: [firstVersion, secondVersion],
    locationEvents: [],
    memberships: [],
    transitions: [],
  };
}

export function performanceContract() {
  return Object.freeze({
    ordered: { events: 500_000, devices: 100_000, clients: 64, seconds: 60, throughput: 500, p95Ms: 250 },
    jitter: { events: 100_000, devices: 2_000, regions: 100, clients: 64, seconds: 60, throughput: 300, p95Ms: 350 },
    query: { regions: 10_000, points: 1_000_000, batchSize: 1_000, seconds: 60, throughput: 20_000, p95Ms: 700 },
  });
}

export { locationEvent, regionVersion };
