import { assertPublishedOpenApi } from './openapi.mjs';
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

function compareText(left, right) { return Buffer.from(String(left)).compare(Buffer.from(String(right))); }

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("CarbonLedger canonical integers must be safe integers");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("unsupported canonical JSON value");
  const members = Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${members.join(",")}}`;
}

export function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function compareLots(left, right) {
  return right.priority - left.priority
    || compareText(left.projectId, right.projectId)
    || left.vintage - right.vintage
    || compareText(left.creditLotId, right.creditLotId);
}

export function eligibleLots(lots, eligibility = {}) {
  return lots.filter((lot) => lot.availableGrams > 0
    && (eligibility.projectId === undefined || lot.projectId === eligibility.projectId)
    && (eligibility.methodology === undefined || lot.methodology === eligibility.methodology)
    && (eligibility.vintageFrom === undefined || lot.vintage >= eligibility.vintageFrom)
    && (eligibility.vintageTo === undefined || lot.vintage <= eligibility.vintageTo))
    .sort(compareLots);
}

export function selectAllocations(lots, quantityGrams, eligibility = {}, { maxLots = 20 } = {}) {
  if (!Number.isSafeInteger(quantityGrams) || quantityGrams <= 0) throw new TypeError("quantityGrams must be a positive safe integer");
  const ordered = eligibleLots(lots, eligibility);
  const single = ordered.find(({ availableGrams }) => availableGrams >= quantityGrams);
  if (single) return [{ ordinal: 1, creditLotId: single.creditLotId, quantityGrams }];
  let remaining = quantityGrams;
  const allocations = [];
  for (const lot of ordered) {
    if (remaining === 0) break;
    const quantity = Math.min(lot.availableGrams, remaining);
    if (quantity > 0) allocations.push({ ordinal: allocations.length + 1, creditLotId: lot.creditLotId, quantityGrams: quantity });
    remaining -= quantity;
  }
  if (remaining > 0) return { error: "CREDIT_UNAVAILABLE", allocations: [] };
  if (allocations.length > maxLots) return { error: "CROSS_LOT_LIMIT_EXCEEDED", allocations: [] };
  return allocations;
}

export function enrichAllocations(allocations, lots, retirementId, idForOrdinal) {
  const lotById = new Map(lots.map((lot) => [lot.creditLotId, lot]));
  return allocations.map((allocation) => {
    const lot = lotById.get(allocation.creditLotId);
    if (!lot) throw new Error(`unknown Credit Lot ${allocation.creditLotId}`);
    return {
      lotAllocationId: idForOrdinal(allocation.ordinal),
      retirementId,
      ordinal: allocation.ordinal,
      creditLotId: allocation.creditLotId,
      quantityGrams: allocation.quantityGrams,
      projectId: lot.projectId,
      vintage: lot.vintage,
      methodology: lot.methodology,
      provenanceDigest: lot.provenanceDigest,
    };
  });
}

export function assertLotConservation(lots) {
  for (const lot of lots) {
    for (const field of ["issuedGrams", "availableGrams", "reservedGrams", "retiredGrams"]) assert.ok(Number.isSafeInteger(lot[field]) && lot[field] >= 0, `${lot.creditLotId} ${field}`);
    assert.equal(lot.issuedGrams, lot.availableGrams + lot.reservedGrams + lot.retiredGrams, `${lot.creditLotId} conservation`);
  }
}

export function assertAllocationSet(allocations, lots, quantityGrams) {
  assert.deepEqual(allocations.map(({ ordinal }) => ordinal), allocations.map((_, index) => index + 1), "allocation ordinals");
  assert.equal(allocations.reduce((sum, item) => sum + item.quantityGrams, 0), quantityGrams, "allocation total");
  const lotById = new Map(lots.map((lot) => [lot.creditLotId, lot]));
  for (const allocation of allocations) {
    const lot = lotById.get(allocation.creditLotId);
    assert.ok(lot, `allocation references ${allocation.creditLotId}`);
    assert.equal(allocation.projectId, lot.projectId, "frozen project provenance");
    assert.equal(allocation.vintage, lot.vintage, "frozen vintage provenance");
    assert.equal(allocation.methodology, lot.methodology, "frozen methodology provenance");
    assert.equal(allocation.provenanceDigest, lot.provenanceDigest, "frozen digest provenance");
  }
}

export function certificateV1({ retirement, allocation, lot, retiredAt }) {
  const value = {
    certificateVersion: 1,
    retirementId: retirement.retirementId,
    beneficiaryId: retirement.beneficiaryId,
    quantityGrams: retirement.quantityGrams,
    creditLotId: allocation.creditLotId,
    projectId: lot.projectId,
    vintage: lot.vintage,
    methodology: lot.methodology,
    provenanceDigest: lot.provenanceDigest,
    retiredAt,
  };
  const bytes = Buffer.from(canonicalJson(value));
  return { value, bytes, digest: sha256Bytes(bytes) };
}

export function certificateV2({ retirement, allocations, retiredAt }) {
  const value = {
    certificateVersion: 2,
    retirementId: retirement.retirementId,
    beneficiaryId: retirement.beneficiaryId,
    totalQuantityGrams: retirement.quantityGrams,
    allocations: allocations.map(({ ordinal, creditLotId, quantityGrams, projectId, vintage, methodology, provenanceDigest }) => ({ ordinal, creditLotId, quantityGrams, projectId, vintage, methodology, provenanceDigest })),
    retiredAt,
  };
  const bytes = Buffer.from(canonicalJson(value));
  return { value, bytes, digest: sha256Bytes(bytes) };
}

export function assertEventSequence(events) {
  const grouped = new Map();
  for (const event of events) {
    const values = grouped.get(event.aggregateId) ?? [];
    values.push(event);
    grouped.set(event.aggregateId, values);
  }
  for (const values of grouped.values()) {
    values.sort((left, right) => left.sequence - right.sequence);
    assert.deepEqual(values.map(({ sequence }) => sequence), values.map((_, index) => index + 1), "per-Retirement Event sequence");
  }
}

export function percentile(values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

const OPENAPI_ROUTES = Object.freeze({
  "/api/v1/retirements": Object.freeze({ get: ["200", "400"], post: ["202", "400", "409", "415"] }),
  "/api/v1/retirements/{retirementId}": Object.freeze({ get: ["200", "404"] }),
  "/api/v1/retirements/{retirementId}/release": Object.freeze({ post: ["200", "400", "404", "409", "415"] }),
  "/api/v1/retirements/{retirementId}/certificate": Object.freeze({ get: ["200", "202", "404", "409"] }),
  "/api/v1/retirements/{retirementId}/allocations": Object.freeze({ get: ["200", "404"] }),
  "/api/v1/credit-lots": Object.freeze({ get: ["200", "400"] }),
  "/api/v1/credit-lots/{creditLotId}": Object.freeze({ get: ["200", "404"] }),
  "/api/v1/domain-events": Object.freeze({ get: ["200", "400"] }),
  "/api/v1/verification-snapshot": Object.freeze({ get: ["200", "401"] }),
});
const V1_OPENAPI_ROUTES = Object.freeze(Object.fromEntries(Object.entries(OPENAPI_ROUTES).filter(([path]) => !path.endsWith("/allocations"))));
const CONTRACT_SCHEMAS = Object.freeze({
  CarbonProject: ["projectId", "name"],
  Beneficiary: ["beneficiaryId", "name"],
  CreditLot: ["creditLotId", "projectId", "vintage", "methodology", "priority", "issuedGrams", "availableGrams", "reservedGrams", "retiredGrams", "provenanceDigest"],
  Retirement: ["retirementId", "beneficiaryId", "quantityGrams", "state", "allocation", "expiresAt", "certificateDigest", "createdAt", "terminalAt", "sequence", "allocations"],
  Certificate: ["certificateVersion", "retirementId", "beneficiaryId", "quantityGrams", "creditLotId", "projectId", "vintage", "methodology", "provenanceDigest", "retiredAt"],
  LotAllocation: ["lotAllocationId", "retirementId", "ordinal", "creditLotId", "quantityGrams", "projectId", "vintage", "methodology", "provenanceDigest"],
  SplitCertificate: ["certificateVersion", "retirementId", "beneficiaryId", "totalQuantityGrams", "allocations", "retiredAt"],
  Work: ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"],
  DomainEvent: ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"],
});
const V1_RETIREMENT_FIELDS = Object.freeze(CONTRACT_SCHEMAS.Retirement.filter((field) => field !== "allocations"));
const V1_SCHEMA_NAMES = Object.freeze(["CarbonProject", "Beneficiary", "CreditLot", "Retirement", "Certificate", "Work", "DomainEvent"]);

function resolveSchema(document, schema, seen = new Set()) {
  assert.ok(schema && typeof schema === "object", "OpenAPI schema required");
  if (!schema.$ref) return schema;
  assert.match(schema.$ref, /^#\/components\/schemas\/[^/]+$/u, "only local schema refs");
  assert.ok(!seen.has(schema.$ref), `cyclic schema ref ${schema.$ref}`);
  const name = schema.$ref.split("/").at(-1); const value = document.components?.schemas?.[name];
  assert.ok(value, `missing referenced schema ${name}`);
  return resolveSchema(document, value, new Set([...seen, schema.$ref]));
}
function resolveResponse(document, response) { if (!response?.$ref) return response; assert.match(response.$ref, /^#\/components\/responses\/[^/]+$/u); const value = document.components?.responses?.[response.$ref.split("/").at(-1)]; assert.ok(value, "missing response ref"); return value; }
function resolveParameter(document, parameter) { if (!parameter?.$ref) return parameter; assert.match(parameter.$ref, /^#\/components\/parameters\/[^/]+$/u); const value = document.components?.parameters?.[parameter.$ref.split("/").at(-1)]; assert.ok(value, "missing parameter ref"); return value; }
function closed(document, schema, fields, label) { const value = resolveSchema(document, schema); assert.equal(value.type, "object", `${label} object`); assert.equal(value.additionalProperties, false, `${label} closed`); assert.deepEqual(Object.keys(value.properties ?? {}).sort(), [...fields].sort(), `${label} properties`); assert.deepEqual([...(value.required ?? [])].sort(), [...fields].sort(), `${label} required`); return value; }
function jsonSchema(document, response, label) { const media = resolveResponse(document, response)?.content?.["application/json"]; assert.ok(media?.schema, `${label} JSON schema`); return media.schema; }
function arrayItems(document, schema, fields, label) { const value = resolveSchema(document, schema); assert.equal(value.type, "array", `${label} array`); return closed(document, value.items, fields, `${label} item`); }
function nullable(document, schema) { const value = resolveSchema(document, schema); return (Array.isArray(value.type) && value.type.includes("null")) || [...(value.oneOf ?? []), ...(value.anyOf ?? [])].some((item) => resolveSchema(document, item).type === "null"); }
function errorContract(document, response, label) { const root = closed(document, jsonSchema(document, response, label), ["error"], `${label} envelope`); const error = closed(document, root.properties.error, ["code", "message", "details"], `${label} error`); assert.equal(resolveSchema(document, error.properties.code).type, "string", `${label} code`); assert.equal(resolveSchema(document, error.properties.message).type, "string", `${label} message`); const details = resolveSchema(document, error.properties.details); assert.equal(details.type, "object", `${label} details`); assert.equal(details.additionalProperties, false, `${label} details closed`); }
function idempotencyContract(document, pathItem, operation, label) { const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((item) => resolveParameter(document, item)); const header = parameters.find((item) => item.in === "header" && item.name?.toLowerCase() === "idempotency-key"); assert.ok(header?.required, `${label} requires Idempotency-Key`); const schema = resolveSchema(document, header.schema); assert.equal(schema.type, "string"); assert.ok((schema.minLength ?? 0) >= 1 && (schema.maxLength ?? Infinity) <= 128, `${label} key bounds`); }
function requestContract(document, path, operation) { const request = operation.requestBody?.$ref ? document.components?.requestBodies?.[operation.requestBody.$ref.split("/").at(-1)] : operation.requestBody; assert.ok(request?.required, `POST ${path} body required`); const schema = request?.content?.["application/json"]?.schema; assert.ok(schema, `POST ${path} JSON body`); if (path === "/api/v1/retirements") { const value = closed(document, schema, ["beneficiaryId", "quantityGrams", "eligibility"], "create request"); const eligibility = resolveSchema(document, value.properties.eligibility); assert.equal(eligibility.type, "object", "eligibility object"); assert.equal(eligibility.additionalProperties, false, "eligibility closed"); assert.deepEqual(Object.keys(eligibility.properties ?? {}).sort(), ["methodology", "projectId", "vintageFrom", "vintageTo"], "eligibility properties"); assert.deepEqual(eligibility.required ?? [], [], "eligibility fields optional"); } else closed(document, schema, ["reason"], "release request"); }
function successContract(document, path, method, status, response, { final }) {
  const label = `${method.toUpperCase()} ${path} ${status}`; const schema = jsonSchema(document, response, label);
  const retirementFields = final ? CONTRACT_SCHEMAS.Retirement : V1_RETIREMENT_FIELDS;
  if (path === "/api/v1/retirements" && method === "get") { const page = closed(document, schema, ["items", "nextCursor"], label); arrayItems(document, page.properties.items, retirementFields, `${label} items`); return; }
  if (path === "/api/v1/retirements" || path === "/api/v1/retirements/{retirementId}" || path.endsWith("/release")) { closed(document, schema, retirementFields, label); return; }
  if (path.endsWith("/certificate")) { if (status === "202") { closed(document, schema, ["retirementId", "state"], label); return; } if (!final) closed(document, schema, CONTRACT_SCHEMAS.Certificate, `${label} v1`); else { const alternatives = [...(resolveSchema(document, schema).oneOf ?? [])].map((item) => resolveSchema(document, item)); assert.equal(alternatives.length, 2, `${label} v1/v2 alternatives`); const v1 = alternatives.find((item) => Object.hasOwn(item.properties ?? {}, "quantityGrams")); const v2 = alternatives.find((item) => Object.hasOwn(item.properties ?? {}, "totalQuantityGrams")); closed(document, v1, CONTRACT_SCHEMAS.Certificate, `${label} v1`); closed(document, v2, CONTRACT_SCHEMAS.SplitCertificate, `${label} v2`); } const resolved = resolveResponse(document, response); const etag = Object.entries(resolved.headers ?? {}).find(([name]) => name.toLowerCase() === "etag")?.[1]; assert.ok(etag, `${label} ETag`); return; }
  if (path.endsWith("/allocations")) { const collection = closed(document, schema, ["items"], label); arrayItems(document, collection.properties.items, CONTRACT_SCHEMAS.LotAllocation, `${label} items`); return; }
  if (path === "/api/v1/credit-lots" && method === "get") { const page = closed(document, schema, ["items", "nextCursor"], label); arrayItems(document, page.properties.items, CONTRACT_SCHEMAS.CreditLot, `${label} items`); return; }
  if (path === "/api/v1/credit-lots/{creditLotId}") { closed(document, schema, CONTRACT_SCHEMAS.CreditLot, label); return; }
  if (path === "/api/v1/domain-events") { const page = closed(document, schema, ["items", "nextCursor"], label); arrayItems(document, page.properties.items, CONTRACT_SCHEMAS.DomainEvent, `${label} items`); return; }
  if (path === "/api/v1/verification-snapshot") { const snapshot = closed(document, schema, ["asOf", "resources", "work", "events"], label); const resourceComponents = [["projects", "CarbonProject"], ["beneficiaries", "Beneficiary"], ["creditLots", "CreditLot"], ["retirements", "Retirement"], ["certificates", "Certificate"], ...(final ? [["lotAllocations", "LotAllocation"], ["splitCertificates", "SplitCertificate"]] : [])]; const resources = closed(document, snapshot.properties.resources, resourceComponents.map(([field]) => field), `${label} resources`); for (const [field, component] of resourceComponents) arrayItems(document, resources.properties[field], component === "Retirement" ? retirementFields : CONTRACT_SCHEMAS[component], `${label} ${field}`); arrayItems(document, snapshot.properties.work, CONTRACT_SCHEMAS.Work, `${label} work`); arrayItems(document, snapshot.properties.events, CONTRACT_SCHEMAS.DomainEvent, `${label} events`); }
}

export function carbonLedgerOpenApiRoutes() { return structuredClone(OPENAPI_ROUTES); }
function assertOpenApi(document, { final }) {
  const routes = final ? OPENAPI_ROUTES : V1_OPENAPI_ROUTES;
  assert.match(document?.openapi ?? "", /^3\.1(?:\.\d+)?$/u, "OpenAPI 3.1"); assert.ok(document.paths && document.components?.schemas, "OpenAPI paths and schemas");
  assert.deepEqual(Object.keys(document.paths).filter((path) => path.startsWith("/api/v1/")).sort(), Object.keys(routes).sort(), "exact published API paths");
  const schemaNames = final ? Object.keys(CONTRACT_SCHEMAS) : V1_SCHEMA_NAMES; for (const name of schemaNames) closed(document, document.components.schemas[name], name === "Retirement" && !final ? V1_RETIREMENT_FIELDS : CONTRACT_SCHEMAS[name], name);
  const retirement = resolveSchema(document, document.components.schemas.Retirement); assert.ok(nullable(document, retirement.properties.allocation), "Retirement allocation nullable"); assert.ok(nullable(document, retirement.properties.certificateDigest), "Retirement digest nullable"); assert.ok(nullable(document, retirement.properties.terminalAt), "Retirement terminalAt nullable"); if (final) arrayItems(document, retirement.properties.allocations, CONTRACT_SCHEMAS.LotAllocation, "Retirement allocations");
  if (final) { const split = resolveSchema(document, document.components.schemas.SplitCertificate); const splitItemFields = ["ordinal", "creditLotId", "quantityGrams", "projectId", "vintage", "methodology", "provenanceDigest"]; arrayItems(document, split.properties.allocations, splitItemFields, "SplitCertificate allocations"); }
  const work = resolveSchema(document, document.components.schemas.Work); assert.deepEqual([...(resolveSchema(document, work.properties.kind).enum ?? [])].sort(), ["CERTIFICATE_GENERATION", "RETIREMENT_EXPIRY"].sort(), "Work kind enum");
  for (const [path, methods] of Object.entries(routes)) { const pathItem = document.paths[path]; assert.ok(pathItem, `missing path ${path}`); for (const [method, statuses] of Object.entries(methods)) { const operation = pathItem[method]; assert.ok(operation, `missing ${method} ${path}`); assert.deepEqual(Object.keys(operation.responses ?? {}).sort(), [...statuses].sort(), `${method} ${path} statuses`); for (const status of statuses) { const response = operation.responses[status]; if (Number(status) >= 400) errorContract(document, response, `${method} ${path} ${status}`); else successContract(document, path, method, status, response, { final }); } if (method === "post") { idempotencyContract(document, pathItem, operation, `POST ${path}`); requestContract(document, path, operation); } } }
  const snapshot = document.paths["/api/v1/verification-snapshot"].get; const names = (snapshot.security ?? []).flatMap(Object.keys); assert.ok(names.some((name) => { const scheme = document.components?.securitySchemes?.[name]; return scheme?.type === "http" && scheme.scheme?.toLowerCase() === "bearer"; }), "snapshot HTTP Bearer security"); return true;
}
export function assertCarbonLedgerOpenApi(document) { return assertPublishedOpenApi(document); }
export function assertCarbonLedgerV1OpenApi(document) { return assertOpenApi(document, { final: false }); }
