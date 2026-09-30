import { assertPublishedOpenApi, assertLiveSchema, assertSnapshotSchema } from './openapi.mjs';
import { candidateAssert as assert } from "../lib/execution.mjs";

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite JSON number"); return Object.is(value, -0) ? "0" : JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  throw new TypeError("value is not JSON");
}

export function safeAdd(left, right, label = "integer sum") { const result = left + right; assert.ok(Number.isSafeInteger(left) && Number.isSafeInteger(right) && Number.isSafeInteger(result), `${label} overflow`); return result; }
export function safeMultiply(left, right, label = "integer product") { const result = left * right; assert.ok(Number.isSafeInteger(left) && Number.isSafeInteger(right) && Number.isSafeInteger(result), `${label} overflow`); return result; }

export function monthInterval(occurredAt) {
  const value = new Date(occurredAt); assert.ok(Number.isFinite(value.valueOf()), "invalid occurredAt");
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
  const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

export function selectRatePlan(ratePlans, tenantId, occurredAt) {
  const matches = ratePlans.filter((plan) => plan.tenantId === tenantId && plan.effectiveFrom <= occurredAt && (plan.effectiveTo === null || occurredAt < plan.effectiveTo));
  assert.equal(matches.length, 1, `expected one Rate Plan for ${tenantId} at ${occurredAt}`);
  return matches[0];
}

export function effectiveQuantity(event, corrections = []) {
  return corrections.filter(({ sourceEventId }) => sourceEventId === event.eventId).reduce((quantity, item) => safeAdd(quantity, item.quantityDelta, `effective quantity ${event.eventId}`), event.quantity);
}

export function rateLine(event, ratePlans, corrections = []) {
  const plan = selectRatePlan(ratePlans, event.tenantId, event.occurredAt); const quantity = effectiveQuantity(event, corrections);
  assert.ok(quantity >= 0, `${event.eventId} effective quantity is negative`);
  return { eventId: event.eventId, meterId: event.meterId, quantity, ratePlanVersion: plan.version, unitPriceMinor: plan.unitPriceMinor, chargeMinor: safeMultiply(quantity, plan.unitPriceMinor, `${event.eventId} charge`) };
}

export function ratePeriod(events, ratePlans, corrections = []) {
  const lines = events.map((event) => rateLine(event, ratePlans, corrections)).sort((a, b) => Buffer.from(a.eventId).compare(Buffer.from(b.eventId)));
  return { lines, totalQuantity: lines.reduce((sum, line) => safeAdd(sum, line.quantity, "Statement quantity"), 0), totalMinor: lines.reduce((sum, line) => safeAdd(sum, line.chargeMinor, "Statement total"), 0), ratePlanVersions: [...new Set(lines.map(({ ratePlanVersion }) => ratePlanVersion))].sort((a, b) => a - b) };
}

export function revisionDelta(corrections, events, ratePlans) {
  const eventById = new Map(events.map((event) => [event.eventId, event]));
  return corrections.reduce((sum, correction) => { const source = eventById.get(correction.sourceEventId); assert.ok(source, `missing source ${correction.sourceEventId}`); const plan = selectRatePlan(ratePlans, source.tenantId, source.occurredAt); return safeAdd(sum, safeMultiply(correction.quantityDelta, plan.unitPriceMinor, `${correction.correctionId} delta`), "revision delta"); }, 0);
}

export function expectedRevision({ statementId, revision, priorTotalMinor, corrections, events, ratePlans }) {
  const deltaMinor = revisionDelta(corrections, events, ratePlans);
  return { statementId, revision, priorTotalMinor, deltaMinor, effectiveTotalMinor: safeAdd(priorTotalMinor, deltaMinor, "revision effective total"), correctionIds: corrections.map(({ correctionId }) => correctionId).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))) };
}

export function assertRevisionChain(base, revisions) {
  let prior = base.totalMinor; let expectedNumber = 2;
  for (const revision of [...revisions].sort((a, b) => a.revision - b.revision)) { assert.equal(revision.revision, expectedNumber++, "continuous Statement revision"); assert.equal(revision.priorTotalMinor, prior, "revision prior total"); assert.equal(revision.effectiveTotalMinor, safeAdd(prior, revision.deltaMinor), "revision effective total"); assert.deepEqual(revision.correctionIds, [...revision.correctionIds].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))), "correctionIds UTF-8 order"); if (revision.state === "FINALIZED") prior = revision.effectiveTotalMinor; }
  return prior;
}

export function assertEventSequence(events) { const next = new Map(); for (const event of events) { const expected = (next.get(event.aggregateId) ?? 0) + 1; assert.equal(event.sequence, expected, `${event.aggregateId} Event sequence`); next.set(event.aggregateId, event.sequence); } return true; }
export function assertWork(work) { for (const item of work) { exactKeys(item, ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"], "Work"); assertUuid(item.workId, "Work.workId"); assertUuid(item.aggregateId, "Work.aggregateId"); assert.equal(item.kind, "RATING", "Work.kind"); assert.ok(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state), "Work.state"); assertSafeInteger(item.attempt, "Work.attempt"); assert.ok(item.attempt >= 0, "Work.attempt non-negative"); const leased = item.state === "LEASED"; assert.equal(item.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state), `${item.workId} terminal derivation`); assert.equal(item.leaseOwner !== null, leased, `${item.workId} leaseOwner`); assert.equal(item.leaseExpiresAt !== null, leased, `${item.workId} leaseExpiresAt`); if (leased) { assert.equal(typeof item.leaseOwner, "string"); assertTimestamp(item.leaseExpiresAt); } } return true; }
function scalar(left, right) { if (left === right) return 0; if (left === null) return -1; if (right === null) return 1; if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) return left - right; if (typeof left === "boolean" && typeof right === "boolean") return left ? 1 : -1; return Buffer.from(String(left)).compare(Buffer.from(String(right))); }
export function compareBy(paths) { return (left, right) => { for (const path of paths) { const order = scalar(left[path], right[path]); if (order) return order; } return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right))); }; }
export function assertSorted(values, paths) { assert.deepEqual(values, [...values].sort(compareBy(paths)), `${paths.join(",")} canonical order`); return true; }
export function percentile(values, fraction) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]; }

export function exactKeys(value, keys, label = "object") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export function assertUuid(value, label = "uuid") { assert.match(value, UUID, label); }
export function assertTimestamp(value, label = "timestamp") { assert.match(value, TIMESTAMP, label); assert.ok(Number.isFinite(Date.parse(value)), label); }
export function assertSafeInteger(value, label = "integer") { assert.ok(Number.isSafeInteger(value), label); }

export function assertPublicError(response, status, code) {
  assert.equal(response.status, status, `${code} status`);
  exactKeys(response.json, ["error"], `${code} response`);
  exactKeys(response.json.error, ["code", "message", "details"], `${code} error`);
  assert.equal(response.json.error.code, code, `${code} code`);
  assert.equal(typeof response.json.error.message, "string", `${code} message`);
  assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details), `${code} details`);
  return true;
}

export function assertUsageEvent(value) {
  exactKeys(value, ["eventId", "meterId", "tenantId", "occurredAt", "quantity", "ingestedAt"], "UsageEvent");
  assert.equal(typeof value.eventId, "string"); assertUuid(value.meterId, "UsageEvent.meterId"); assertUuid(value.tenantId, "UsageEvent.tenantId");
  assertTimestamp(value.occurredAt, "UsageEvent.occurredAt"); assertTimestamp(value.ingestedAt, "UsageEvent.ingestedAt"); assertSafeInteger(value.quantity, "UsageEvent.quantity");
  return true;
}

export function assertUsageBatch(value) {
  exactKeys(value, ["batchId", "tenantId", "acceptedEventIds", "duplicateEventIds", "createdAt"], "UsageBatch");
  assertUuid(value.batchId, "UsageBatch.batchId"); assertUuid(value.tenantId, "UsageBatch.tenantId"); assertTimestamp(value.createdAt, "UsageBatch.createdAt");
  assert.ok(Array.isArray(value.acceptedEventIds) && Array.isArray(value.duplicateEventIds), "UsageBatch id arrays");
  return true;
}

export function assertStatement(value) {
  exactKeys(value, ["statementId", "tenantId", "periodStart", "periodEnd", "state", "revision", "totalQuantity", "totalMinor", "watermarkThrough", "ratePlanVersions", "lines", "finalizedAt", "sequence"], "Statement");
  assertUuid(value.statementId, "Statement.statementId"); assertUuid(value.tenantId, "Statement.tenantId"); assertTimestamp(value.periodStart, "Statement.periodStart"); assertTimestamp(value.periodEnd, "Statement.periodEnd");
  assert.ok(["OPEN", "FINALIZING", "FINALIZED"].includes(value.state), "Statement.state"); assert.equal(value.revision, 1, "base Statement revision");
  for (const field of ["totalQuantity", "totalMinor", "sequence"]) assertSafeInteger(value[field], `Statement.${field}`);
  assert.ok(value.watermarkThrough === null || TIMESTAMP.test(value.watermarkThrough), "Statement.watermarkThrough"); assert.ok(value.finalizedAt === null || TIMESTAMP.test(value.finalizedAt), "Statement.finalizedAt");
  assert.ok(Array.isArray(value.ratePlanVersions) && Array.isArray(value.lines), "Statement arrays");
  for (const line of value.lines) { exactKeys(line, ["eventId", "meterId", "quantity", "ratePlanVersion", "unitPriceMinor", "chargeMinor"], "RatedLine"); assertUuid(line.meterId, "RatedLine.meterId"); for (const field of ["quantity", "ratePlanVersion", "unitPriceMinor", "chargeMinor"]) assertSafeInteger(line[field], `RatedLine.${field}`); assert.equal(line.chargeMinor, safeMultiply(line.quantity, line.unitPriceMinor), "RatedLine charge"); }
  assert.equal(value.lines.reduce((sum, line) => safeAdd(sum, line.quantity), 0), value.totalQuantity, "Statement quantity conservation");
  assert.equal(value.lines.reduce((sum, line) => safeAdd(sum, line.chargeMinor), 0), value.totalMinor, "Statement money conservation");
  return true;
}

export function assertCorrectionEvent(value) {
  exactKeys(value, ["correctionId", "tenantId", "sourceEventId", "quantityDelta", "reason", "occurredAt", "ingestedAt"], "CorrectionEvent");
  assert.equal(typeof value.correctionId, "string"); assertUuid(value.tenantId, "CorrectionEvent.tenantId"); assert.equal(typeof value.sourceEventId, "string"); assertSafeInteger(value.quantityDelta, "CorrectionEvent.quantityDelta"); assert.notEqual(value.quantityDelta, 0); assert.equal(typeof value.reason, "string"); assertTimestamp(value.occurredAt); assertTimestamp(value.ingestedAt);
  return true;
}

export function assertStatementRevision(value) {
  exactKeys(value, ["statementRevisionId", "statementId", "revision", "priorTotalMinor", "deltaMinor", "effectiveTotalMinor", "correctionIds", "state", "finalizedAt"], "StatementRevision");
  assertUuid(value.statementRevisionId); assertUuid(value.statementId); for (const field of ["revision", "priorTotalMinor", "deltaMinor", "effectiveTotalMinor"]) assertSafeInteger(value[field], `StatementRevision.${field}`);
  assert.ok(value.revision >= 2); assert.equal(value.effectiveTotalMinor, safeAdd(value.priorTotalMinor, value.deltaMinor)); assert.ok(["FINALIZING", "FINALIZED"].includes(value.state)); assert.ok(value.finalizedAt === null || TIMESTAMP.test(value.finalizedAt));
  assert.deepEqual(value.correctionIds, [...value.correctionIds].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))), "StatementRevision correctionIds byte order");
  return true;
}

export function assertDomainEvent(value) {
  exactKeys(value, ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"], "DomainEvent");
  assertUuid(value.eventId); assertUuid(value.aggregateId); assertSafeInteger(value.sequence); assert.ok(value.sequence > 0); assert.equal(value.schemaVersion, 1); assertTimestamp(value.occurredAt); assert.deepEqual(value.payload, {}); return true;
}

export function assertSnapshot(snapshot, { final = true } = {}) {
  if (final) assertSnapshotSchema(snapshot);
  exactKeys(snapshot, ["asOf", "resources", "work", "events"], "verification snapshot"); assertTimestamp(snapshot.asOf, "snapshot.asOf");
  const resourceKeys = ["tenantStates", "meterDefinitions", "ratePlans", "usageEvents", "usageBatches", "statements", ...(final ? ["correctionEvents", "statementRevisions"] : [])];
  exactKeys(snapshot.resources, resourceKeys, "snapshot.resources");
  for (const key of resourceKeys) assert.ok(Array.isArray(snapshot.resources[key]), `${key} array`);
  for (const item of snapshot.resources.tenantStates) { exactKeys(item, ["tenantId", "name", "watermarkThrough", "openPeriodStarts", "finalizedThrough"], "TenantState"); assertUuid(item.tenantId); assert.equal(typeof item.name, "string"); assert.ok(item.watermarkThrough === null || TIMESTAMP.test(item.watermarkThrough)); assert.ok(Array.isArray(item.openPeriodStarts) && item.openPeriodStarts.every((value) => TIMESTAMP.test(value))); assert.ok(item.finalizedThrough === null || TIMESTAMP.test(item.finalizedThrough)); }
  for (const item of snapshot.resources.meterDefinitions) { exactKeys(item, ["meterId", "tenantId", "name"], "MeterDefinition"); assertUuid(item.meterId); assertUuid(item.tenantId); assert.equal(typeof item.name, "string"); }
  for (const item of snapshot.resources.ratePlans) { exactKeys(item, ["tenantId", "version", "effectiveFrom", "effectiveTo", "unitPriceMinor"], "RatePlan"); assertUuid(item.tenantId); assertSafeInteger(item.version); assert.ok(item.version > 0); assertTimestamp(item.effectiveFrom); assert.ok(item.effectiveTo === null || TIMESTAMP.test(item.effectiveTo)); assertSafeInteger(item.unitPriceMinor); assert.ok(item.unitPriceMinor >= 0); }
  snapshot.resources.usageEvents.forEach(assertUsageEvent); snapshot.resources.usageBatches.forEach(assertUsageBatch); snapshot.resources.statements.forEach(assertStatement);
  if (final) { snapshot.resources.correctionEvents.forEach(assertCorrectionEvent); snapshot.resources.statementRevisions.forEach(assertStatementRevision); }
  assertSorted(snapshot.resources.tenantStates, ["tenantId"]); assertSorted(snapshot.resources.meterDefinitions, ["meterId"]); assertSorted(snapshot.resources.ratePlans, ["tenantId", "version"]); assertSorted(snapshot.resources.usageEvents, ["tenantId", "eventId"]); assertSorted(snapshot.resources.usageBatches, ["batchId"]); assertSorted(snapshot.resources.statements, ["statementId"]);
  if (final) { assertSorted(snapshot.resources.correctionEvents, ["tenantId", "correctionId"]); assertSorted(snapshot.resources.statementRevisions, ["statementId", "revision"]); }
  assertWork(snapshot.work); snapshot.events.forEach(assertDomainEvent); assertSorted(snapshot.work, ["workId"]); assertSorted(snapshot.events, ["aggregateId", "sequence", "eventId"]); assertEventSequence(snapshot.events);
  const secretField = (value) => value && typeof value === "object" && Object.entries(value).some(([key, member]) => key.endsWith("Token") || secretField(member));
  assert.equal(secretField(snapshot), false, "snapshot recursively omits *Token fields");
  return true;
}

export function semanticRevisionDetail(value) {
  exactKeys(value, ["statementRevision", "correctionEvents"], "RevisionDetail");
  const revision=value.statementRevision, corrections=value.correctionEvents;
  assertStatementRevision(revision); corrections.forEach(assertCorrectionEvent);
  assert.deepEqual(new Set(corrections.map(({correctionId})=>correctionId)),new Set(revision.correctionIds),"revision detail correction membership");
  return {revision,corrections};
}

export function assertOpenApiDocument(document, { final = true } = {}) {
  if (final) return assertPublishedOpenApi(document);
  assert.ok(document && typeof document === "object"); assert.match(document.openapi, /^3\.1(?:\.|$)/u); assert.equal(document.jsonSchemaDialect ?? "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema");
  const paths = ["/healthz", "/openapi.json", "/api/v1/usage-batches", "/api/v1/tenants/{tenantId}/watermark", "/api/v1/statements", "/api/v1/statements/{statementId}", "/api/v1/meters/{meterId}/usage", "/api/v1/domain-events", "/api/v1/verification-snapshot", ...(final ? ["/api/v1/correction-batches", "/api/v1/statements/{statementId}/revisions/{revision}"] : [])];
  for (const path of paths) assert.ok(document.paths?.[path], `OpenAPI path ${path}`);
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) for (const [method, operation] of Object.entries(pathItem)) if (["get", "post", "put", "patch", "delete"].includes(method)) { assert.ok(operation.responses && Object.keys(operation.responses).length > 0, `${method.toUpperCase()} ${path} responses`); if (["post", "put", "patch"].includes(method)) assert.ok(operation.requestBody, `${method.toUpperCase()} ${path} requestBody`); }
  const statusContract = {
    "get /healthz": ["200"], "get /openapi.json": ["200"], "get /api/v1/statements": ["200", "400"], "get /api/v1/statements/{statementId}": ["200", "400", "404"], "post /api/v1/usage-batches": ["202", "400", "409", "415"], "post /api/v1/tenants/{tenantId}/watermark": ["200", "400", "409", "415"], "get /api/v1/tenants/{tenantId}/watermark": ["200", "400", "404"], "get /api/v1/meters/{meterId}/usage": ["200", "400", "404"], "get /api/v1/domain-events": ["200", "400"], "get /api/v1/verification-snapshot": ["200", "401"], ...(final ? { "post /api/v1/correction-batches": ["200", "400", "409", "415"], "get /api/v1/statements/{statementId}/revisions/{revision}": ["200", "400", "404"] } : {}),
  };
  for (const [operationKey, statuses] of Object.entries(statusContract)) { const [method, path] = operationKey.split(" "); const operation = document.paths[path]?.[method]; for (const status of statuses) assert.ok(operation?.responses?.[status] ?? operation?.responses?.default, `${operationKey} response ${status}`); }
  const signatures = [
    ["eventId", "meterId", "tenantId", "occurredAt", "quantity", "ingestedAt"], ["batchId", "tenantId", "acceptedEventIds", "duplicateEventIds", "createdAt"], ["statementId", "tenantId", "periodStart", "periodEnd", "state", "revision", "totalQuantity", "totalMinor", "watermarkThrough", "ratePlanVersions", "lines", "finalizedAt", "sequence"], ["eventId", "meterId", "quantity", "ratePlanVersion", "unitPriceMinor", "chargeMinor"], ...(final ? [["correctionId", "tenantId", "sourceEventId", "quantityDelta", "reason", "occurredAt", "ingestedAt"], ["statementRevisionId", "statementId", "revision", "priorTotalMinor", "deltaMinor", "effectiveTotalMinor", "correctionIds", "state", "finalizedAt"], ["statement", "revisions", "effectiveTotalMinor", "pendingRevision"]] : []),
  ];
  const schemas = []; const seen = new Set(); (function visit(value) { if (!value || typeof value !== "object" || seen.has(value)) return; seen.add(value); const resolved = dereference(document, value); if (resolved !== value) { visit(resolved); return; } if (value.properties || value.type || value.oneOf || value.anyOf || value.allOf) schemas.push(value); for (const member of Object.values(value)) visit(member); })(document);
  for (const signature of signatures) { const schema = schemas.find((candidate) => candidate?.properties && JSON.stringify(Object.keys(candidate.properties).sort()) === JSON.stringify([...signature].sort())); assert.ok(schema, `OpenAPI exact wire schema ${signature.join(",")}`); assert.deepEqual([...(schema.required ?? [])].sort(), [...signature].sort(), `OpenAPI required ${signature.join(",")}`); assert.equal(schema.additionalProperties, false, `OpenAPI closed schema ${signature.join(",")}`); }
  return true;
}

export function validateOpenApiResponse(document, path, method, response) { return assertLiveSchema(document, path, method, response.status, response.json); }

function dereference(document, value) { if (!value?.$ref) return value; const parts = value.$ref.replace(/^#\//u, "").split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")); return parts.reduce((member, part) => member?.[part], document); }
function validateSchema(document, schema, value, label) {
  schema = dereference(document, schema); assert.ok(schema, `${label} schema resolves`);
  if (schema.oneOf || schema.anyOf) { const alternatives = schema.oneOf ?? schema.anyOf; const successes = alternatives.filter((candidate) => { try { validateSchema(document, candidate, value, label); return true; } catch { return false; } }); assert.ok(successes.length >= 1, `${label} union`); return; }
  if (value === null) { assert.ok(schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) || schema.nullable, `${label} nullable`); return; }
  const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type;
  if (type === "object" || schema.properties) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object`); for (const required of schema.required ?? []) assert.ok(Object.hasOwn(value, required), `${label}.${required} required`); if (schema.additionalProperties === false) assert.ok(Object.keys(value).every((key) => Object.hasOwn(schema.properties ?? {}, key)), `${label} closed object`); for (const [key, member] of Object.entries(value)) if (schema.properties?.[key]) validateSchema(document, schema.properties[key], member, `${label}.${key}`); }
  else if (type === "array") { assert.ok(Array.isArray(value), `${label} array`); for (const [index, member] of value.entries()) validateSchema(document, schema.items, member, `${label}[${index}]`); }
  else if (type === "integer") { assert.ok(Number.isSafeInteger(value), `${label} safe integer`); if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${label} minimum`); if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${label} maximum`); }
  else if (type === "number") assert.ok(typeof value === "number" && Number.isFinite(value), `${label} number`);
  else if (type === "string") { assert.equal(typeof value, "string", `${label} string`); if (schema.enum) assert.ok(schema.enum.includes(value), `${label} enum`); if (schema.format === "uuid") assertUuid(value, label); if (schema.format === "date-time") assertTimestamp(value, label); }
  else if (type === "boolean") assert.equal(typeof value, "boolean", `${label} boolean`);
}
