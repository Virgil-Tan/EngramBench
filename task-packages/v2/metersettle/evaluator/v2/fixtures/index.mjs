import { createHash } from "node:crypto";

function digest(...parts) { return createHash("sha256").update(parts.join("\0")).digest(); }
function uuidFrom(buffer) { const bytes = Buffer.from(buffer.subarray(0, 16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export function createFixtureFactory({ evaluationSeed, caseId }) {
  const baseTime = "2034-06-01T00:00:00.000Z";
  const namespace = `metersettle\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `ms-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({ milliseconds = 0, seconds = 0, minutes = 0, days = 0 } = {}) => new Date(Date.parse(baseTime) + ((((days * 24) * 60 + minutes) * 60 + seconds) * 1_000) + milliseconds).toISOString();
  const tenant = { tenantId: uuid("tenant"), name: "MeterSettle Tenant", watermarkThrough: null };
  const otherTenant = { tenantId: uuid("other-tenant"), name: "Other Meter Tenant", watermarkThrough: null };
  const meters = Array.from({ length: 4 }, (_, index) => ({ meterId: uuid(`meter:${index}`), tenantId: tenant.tenantId, name: `Meter ${index + 1}` }));
  const otherMeter = { meterId: uuid("other-meter"), tenantId: otherTenant.tenantId, name: "Other Meter" };
  const plans = [
    { tenantId: tenant.tenantId, version: 1, effectiveFrom: "2034-01-01T00:00:00.000Z", effectiveTo: "2035-01-01T00:00:00.000Z", unitPriceMinor: 7 },
    { tenantId: tenant.tenantId, version: 2, effectiveFrom: "2035-01-01T00:00:00.000Z", effectiveTo: null, unitPriceMinor: 11 },
  ];
  const otherPlan = { tenantId: otherTenant.tenantId, version: 1, effectiveFrom: "2034-01-01T00:00:00.000Z", effectiveTo: null, unitPriceMinor: 5 };
  const event = (ordinal, overrides = {}) => ({ eventId: overrides.eventId ?? `event-${caseId.toLowerCase()}-${ordinal}`, meterId: overrides.meterId ?? meters[ordinal % meters.length].meterId, tenantId: overrides.tenantId ?? tenant.tenantId, occurredAt: overrides.occurredAt ?? at({ seconds: ordinal }), quantity: overrides.quantity ?? ordinal + 1, ingestedAt: overrides.ingestedAt ?? at({ minutes: 1 }) });
  const correction = (ordinal, source, overrides = {}) => ({ correctionId: overrides.correctionId ?? `correction-${caseId.toLowerCase()}-${ordinal}`, tenantId: overrides.tenantId ?? source.tenantId, sourceEventId: source.eventId, quantityDelta: overrides.quantityDelta ?? 1, reason: overrides.reason ?? "meter reconciliation", occurredAt: overrides.occurredAt ?? at({ minutes: 2, seconds: ordinal }), ingestedAt: overrides.ingestedAt ?? at({ minutes: 3 }) });
  const seed = (seedVersion = `${caseId.toLowerCase()}-seed`, usageEvents = []) => ({ schemaVersion: 1, seedVersion, importedAt: at(), tenants: [tenant, otherTenant], meterDefinitions: [...meters, otherMeter], ratePlans: [...plans, otherPlan], usageEvents: usageEvents.map(({ ingestedAt: _ingestedAt, ...value }) => value) });
  function empty() { return { fixtureFamily: "F-EMPTY", seed: seed(`${caseId.toLowerCase()}-empty`) }; }
  function rating() { const events = [event(0, { quantity: 0, occurredAt: "2034-12-01T00:00:00.001Z" }), event(1, { quantity: 10, occurredAt: "2034-12-31T23:59:59.999Z" }), event(2, { quantity: 5, occurredAt: "2035-01-01T00:00:00.000Z" }), event(3, { quantity: 1_000_000_000, occurredAt: "2035-02-01T00:00:00.001Z" })]; return { fixtureFamily: "F-V1-RATING", tenant, otherTenant, meters, otherMeter, plans, events, seed: seed(`${caseId.toLowerCase()}-rating`, events) }; }
  function contract() { return rating(); }
  function dedupe() { const source = event(10, { eventId: "stable-event" }); const other = event(11, { eventId: source.eventId, tenantId: otherTenant.tenantId, meterId: otherMeter.meterId }); return { fixtureFamily: "F-DEDUPE", tenant, otherTenant, meters, otherMeter, source, other, duplicate: { ...source }, conflicts: [{ ...source, meterId: meters[1].meterId }, { ...source, occurredAt: at({ days: 1 }) }, { ...source, quantity: source.quantity + 1 }], seed: seed(`${caseId.toLowerCase()}-dedupe`) }; }
  function watermark() { const events = [event(20, { occurredAt: "2034-12-15T00:00:00.000Z" }), event(21, { occurredAt: "2035-01-31T23:59:59.999Z" }), event(22, { occurredAt: "2035-02-01T00:00:00.000Z" }), event(23, { occurredAt: "2035-02-28T23:59:59.999Z" })]; return { fixtureFamily: "F-WATERMARK", tenant, meters, plans, events, through: "2035-03-01T00:00:00.000Z", seed: seed(`${caseId.toLowerCase()}-watermark`, events) }; }
  function correctionFamily() { const events = [event(30, { quantity: 10, occurredAt: "2034-12-15T00:00:00.000Z" }), event(31, { quantity: 5, occurredAt: "2035-01-15T00:00:00.000Z" })]; const corrections = [correction(1, events[0], { correctionId: "correction-z", quantityDelta: 3, occurredAt: "2035-04-01T00:00:00.000Z" }), correction(2, events[0], { correctionId: "correction-a", quantityDelta: -2, occurredAt: "2035-04-02T00:00:00.000Z" }), correction(3, events[1], { quantityDelta: 4, occurredAt: "2035-04-03T00:00:00.000Z" })]; return { fixtureFamily: "F-CORRECTION", tenant, meters, plans, events, corrections, seed: seed(`${caseId.toLowerCase()}-correction`, events) }; }
  function recovery() { return { ...watermark(), fixtureFamily: "F-WORK", barriers: ["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"] }; }
  function eventFamily() { return { ...watermark(), fixtureFamily: "F-EVENT" }; }
  function migration() { const events = [event(40, { occurredAt: "2034-12-15T00:00:00.000Z" }), event(41, { occurredAt: "2035-02-15T00:00:00.000Z" })]; return { fixtureFamily: "F-MIGRATION", tenant, meters, plans, events, savedReplayKey: key("v1-replay"), seed: seed(`${caseId.toLowerCase()}-migration`, events) }; }
  function browser() { return { ...correctionFamily(), fixtureFamily: "F-BROWSER" }; }
  function performance() { return { fixtureFamily: "F-PERF-V1", seedVersion: "perf-v1", importedAt: "2026-01-01T00:00:00.000Z", tenantCount: 100, meterCount: 10_000, ratePlanCount: 100, eventCount: 1_000_000, closedEventCount: 10_000, warmupBatchCount: 100, measuredBatchCount: 600, batchSize: 100, httpConcurrency: 64, warmupSeconds: 10, measureSeconds: 60, scenarios: ["usage-batch-ingest", "statement-read", "rating-recovery"] }; }
  return Object.freeze({ uuid, key, at, event, correction, seed, tenant, otherTenant, meters, otherMeter, plans, otherPlan, empty, rating, contract, dedupe, watermark, correctionFamily, recovery, eventFamily, migration, browser, performance });
}
