import { createHash } from "node:crypto";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}
function offsetMs(offset = {}) { return (offset.days ?? 0) * 86_400_000 + (offset.hours ?? 0) * 3_600_000 + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1_000 + (offset.milliseconds ?? 0); }
function slug(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 30) || "value"; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be a timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed), caseId: String(caseId), baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const value = bytes.toString("hex");
      return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMs(offset)).toISOString(); },
    key(label) { return `ec-${slug(caseId)}-${slug(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 18)}`.slice(0, 128); },
    integer(label, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) throw new TypeError("invalid integer range");
      return minimum + (hash(namespace, "integer", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

export function baseSeed(fixtures, options = {}) {
  const caseCount = options.caseCount ?? 1;
  const itemsPerCase = options.itemsPerCase ?? 6;
  const facilityCount = options.facilityCount ?? 2;
  const custodianCount = options.custodianCount ?? facilityCount;
  const deviceCount = options.deviceCount ?? facilityCount;
  const custodians = Array.from({ length: custodianCount }, (_, index) => ({ custodianId: fixtures.uuid(`custodian-${index}`), name: `Custodian ${index + 1}` }));
  const facilities = Array.from({ length: facilityCount }, (_, index) => ({ facilityId: fixtures.uuid(`facility-${index}`), name: `Facility ${index + 1}`, receivingCustodianId: custodians[index % custodians.length].custodianId }));
  const cases = Array.from({ length: caseCount }, (_, index) => ({ caseId: fixtures.uuid(`case-${index}`), caseNumber: `EC-${String(index + 1).padStart(5, "0")}` }));
  const caseManifests = cases.map((value, caseIndex) => ({
    caseId: value.caseId,
    version: 1,
    items: Array.from({ length: itemsPerCase }, (_, itemIndex) => ({
      collectedItemId: fixtures.uuid(`item-${caseIndex}-${itemIndex}`),
      expectedLabel: `LABEL-${caseIndex}-${String(itemIndex).padStart(4, "0")}`,
      expectedSealCode: `SEAL-${caseIndex}-${String(itemIndex).padStart(4, "0")}`,
      quantity: options.quantity ?? 10,
    })),
  }));
  const deviceRegistrations = Array.from({ length: deviceCount }, (_, index) => ({
    deviceId: fixtures.uuid(`device-${index}`), facilityId: facilities[index % facilities.length].facilityId, lastBatchSequence: 0,
  }));
  return {
    schemaVersion: 1,
    seedVersion: `ec-${slug(fixtures.caseId)}-${hash(fixtures.evaluationSeed, fixtures.caseId, "seed").toString("hex").slice(0, 12)}`,
    cases,
    caseManifests,
    facilities,
    custodians,
    deviceRegistrations,
    intakeScans: options.intakeScans ?? [],
    custodyMatches: options.custodyMatches ?? [],
    transfers: options.transfers ?? [],
  };
}

export function manifestItems(seed) { return seed.caseManifests.flatMap(({ items }) => items); }

export function intakeBatch(fixtures, seed, options = {}) {
  const device = seed.deviceRegistrations[options.deviceIndex ?? 0];
  const facilityId = options.facilityId ?? device.facilityId;
  const items = options.items ?? manifestItems(seed).slice(options.itemOffset ?? 0, (options.itemOffset ?? 0) + (options.count ?? 3));
  return {
    deviceId: device.deviceId,
    batchSequence: options.batchSequence ?? device.lastBatchSequence + 1,
    scans: items.map((item, index) => ({
      scanId: options.scanIdPrefix ? `${options.scanIdPrefix}-${index}` : `scan-${slug(fixtures.caseId)}-${options.batchSequence ?? 1}-${index}`,
      label: options.labels?.[index] ?? item.expectedLabel,
      sealCode: options.seals?.[index] ?? item.expectedSealCode,
      scannedAt: fixtures.at({ minutes: options.minute ?? 1, seconds: index }),
      facilityId,
    })),
  };
}

export function splitRequest(fixtures, parent, quantities = [2, 3, 5], options = {}) {
  return {
    expectedRevision: options.expectedRevision ?? parent.revision,
    aliquots: quantities.map((quantity, index) => ({ aliquotId: fixtures.uuid(`${options.label ?? "split"}-aliquot-${index}`), quantity, sealCode: `${options.sealPrefix ?? "ALIQUOT"}-${index}` })),
  };
}

export function groupRequest(split, scans) {
  return {
    splitId: split.splitId,
    members: split.aliquots.map((aliquot, index) => ({ aliquotId: aliquot.aliquotId, intakeScanId: scans[index].intakeScanId })),
  };
}

export function performanceContract() {
  return Object.freeze({
    batch: { clients: 64, warmupSeconds: 10, measureSeconds: 60, scansPerBatch: 20, minimumThroughput: 100, maximumP95Ms: 350 },
    timeline: { clients: 64, warmupSeconds: 10, measureSeconds: 60, minimumThroughput: 200, maximumP95Ms: 180 },
    verification: { items: 10_000, killedWorkers: 2, replacementWorkers: 2, maximumSeconds: 60 },
  });
}

export function performanceSeed(fixtures, options = {}) {
  if (options.materialize === false) return { cases: 100, manifests: 100, items: 10_000, facilities: 10, custodians: 10, devices: 100, scans: 10_000, matches: 10_000, transfers: 50_000 };
  const seed = baseSeed(fixtures, { caseCount: 100, itemsPerCase: 100, facilityCount: 10, custodianCount: 10, deviceCount: 100, quantity: 10 });
  const items = manifestItems(seed);
  seed.intakeScans = items.map((item, index) => ({
    intakeScanId: fixtures.uuid(`perf-scan-${index}`), scanId: `perf-scan-${index}`, deviceId: seed.deviceRegistrations[index % 100].deviceId,
    batchSequence: Math.floor(index / 100) + 1, label: item.expectedLabel, sealCode: item.expectedSealCode,
    scannedAt: fixtures.at({ days: -2, milliseconds: index }), facilityId: seed.facilities[index % 10].facilityId, state: "MATCHED", revision: 2,
  }));
  seed.deviceRegistrations = seed.deviceRegistrations.map((device) => ({ ...device, lastBatchSequence: 100 }));
  seed.custodyMatches = items.map((item, index) => ({
    matchId: fixtures.uuid(`perf-match-${index}`), collectedItemId: item.collectedItemId, intakeScanId: seed.intakeScans[index].intakeScanId,
    state: "CONFIRMED", createdAt: fixtures.at({ days: -2, milliseconds: index }), confirmedAt: fixtures.at({ days: -1, milliseconds: index }), reversedAt: null,
  }));
  seed.transfers = items.flatMap((item, itemIndex) => Array.from({ length: 5 }, (_, ordinal) => ({
    transferId: fixtures.uuid(`perf-transfer-${itemIndex}-${ordinal}`), collectedItemId: item.collectedItemId,
    fromCustodianId: seed.custodians[(itemIndex + ordinal) % 10].custodianId, toCustodianId: seed.custodians[(itemIndex + ordinal + 1) % 10].custodianId,
    occurredAt: fixtures.at({ hours: -20 + ordinal, milliseconds: itemIndex % 1000 }), acceptedAt: fixtures.at({ hours: -20 + ordinal, seconds: 1, milliseconds: itemIndex % 1000 }),
    priorTransferId: ordinal === 0 ? null : fixtures.uuid(`perf-transfer-${itemIndex}-${ordinal - 1}`),
  })));
  seed.seedVersion = "perf-v1";
  return seed;
}

export function invalidSeedFixtures(fixtures) {
  const seed = baseSeed(fixtures);
  return [
    { label: "missing-facility", value: { ...structuredClone(seed), seedVersion: `${seed.seedVersion}-missing`, deviceRegistrations: [{ ...seed.deviceRegistrations[0], facilityId: fixtures.uuid("missing-facility") }] } },
    { label: "duplicate-item", value: { ...structuredClone(seed), seedVersion: `${seed.seedVersion}-duplicate`, caseManifests: [{ ...seed.caseManifests[0], items: [seed.caseManifests[0].items[0], seed.caseManifests[0].items[0]] }] } },
    { label: "broken-transfer", value: { ...structuredClone(seed), seedVersion: `${seed.seedVersion}-transfer`, transfers: [{ transferId: fixtures.uuid("broken-transfer"), collectedItemId: seed.caseManifests[0].items[0].collectedItemId, fromCustodianId: seed.custodians[0].custodianId, toCustodianId: seed.custodians[1].custodianId, occurredAt: fixtures.at(), acceptedAt: fixtures.at({ seconds: 1 }), priorTransferId: fixtures.uuid("missing-transfer") }] } },
  ];
}
