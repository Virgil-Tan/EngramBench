import assert from "node:assert/strict";
import test from "node:test";

import { assertEscrowGuardOpenApi } from "../oracles/index.mjs";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const json = (schema) => ({ description: "response", content: { "application/json": { schema } } });
const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
const array = (items, bounds = {}) => ({ type: "array", items, ...bounds });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const string = { type: "string" };
const uuid = { type: "string", format: "uuid" };
const timestamp = { type: "string", format: "date-time" };
const nullable = (schema) => ({ oneOf: [schema, { type: "null" }] });
const positiveInteger = { type: "integer", minimum: 1, maximum: MAX_SAFE };
const nonnegativeInteger = { type: "integer", minimum: 0, maximum: MAX_SAFE };
const enumeration = (...values) => ({ type: "string", enum: values });

function resourceSchemas() {
  return JSON.parse(JSON.stringify({
    Party: object({ partyId: uuid, displayName: string }),
    Escrow: object({ escrowId: uuid, buyerId: uuid, sellerId: uuid, currency: { type: "string", pattern: "^[A-Z]{3}$" }, totalMinor: positiveInteger, availableMinor: nonnegativeInteger, releasedMinor: nonnegativeInteger, refundedMinor: nonnegativeInteger, state: enumeration("FUNDED", "ACTIVE", "DISPUTED", "RELEASED", "REFUNDED"), expiresAt: timestamp, createdAt: timestamp, terminalAt: nullable(timestamp), sequence: positiveInteger }),
    Milestone: object({ milestoneId: uuid, escrowId: uuid, ordinal: positiveInteger, title: string, amountMinor: positiveInteger, state: enumeration("PENDING", "SUBMITTED", "ACCEPTED", "DISPUTED", "RELEASED", "REFUNDED"), submittedAt: nullable(timestamp), decidedAt: nullable(timestamp), releasedAt: nullable(timestamp) }),
    Dispute: object({ disputeId: uuid, escrowId: uuid, milestoneId: uuid, openedBy: enumeration("BUYER", "SELLER"), reason: string, state: enumeration("OPEN", "RESOLVED_RELEASE", "RESOLVED_REFUND"), openedAt: timestamp, resolvedAt: nullable(timestamp), resolutionNote: nullable(string) }),
    Release: object({ releaseId: uuid, escrowId: uuid, milestoneId: uuid, sellerId: uuid, amountMinor: positiveInteger, createdAt: timestamp }),
    FundPosition: object({ totalMinor: positiveInteger, availableMinor: nonnegativeInteger, releasedMinor: nonnegativeInteger, refundedMinor: nonnegativeInteger }),
    Work: object({ workId: uuid, kind: enumeration("ESCROW_EXPIRY"), aggregateId: uuid, state: enumeration("PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"), terminal: { type: "boolean" }, attempt: nonnegativeInteger, leaseOwner: nullable(string), leaseExpiresAt: nullable(timestamp) }),
    DomainEvent: object({ eventId: uuid, aggregateId: uuid, sequence: positiveInteger, type: enumeration("escrow.funded", "milestone.submitted", "milestone.released", "dispute.opened", "dispute.resolved", "escrow.refunded"), occurredAt: timestamp, schemaVersion: { type: "integer", const: 1 }, payload: object({}) }),
    BeneficiaryShare: object({ beneficiaryShareId: uuid, milestoneId: uuid, ordinal: positiveInteger, beneficiaryId: uuid, amountMinor: positiveInteger }),
    BeneficiaryPayout: object({ payoutId: uuid, releaseId: uuid, beneficiaryShareId: uuid, beneficiaryId: uuid, amountMinor: positiveInteger, createdAt: timestamp }),
  }));
}

function errorSchema() { return object({ error: object({ code: string, message: string, details: object({}) }) }); }
function pageSchema(item) { return object({ items: array(item), nextCursor: nullable(string) }); }
function detailSchema() { return object({ escrow: ref("Escrow"), milestones: array(ref("Milestone")), dispute: nullable(ref("Dispute")), releases: array(ref("Release")), fundPosition: ref("FundPosition"), beneficiaryShares: array(ref("BeneficiaryShare")), beneficiaryPayouts: array(ref("BeneficiaryPayout")) }); }
function snapshotSchema() { return object({ asOf: timestamp, resources: object({ parties: array(ref("Party")), escrows: array(ref("Escrow")), milestones: array(ref("Milestone")), disputes: array(ref("Dispute")), releases: array(ref("Release")), beneficiaryShares: array(ref("BeneficiaryShare")), beneficiaryPayouts: array(ref("BeneficiaryPayout")) }), work: array(ref("Work")), events: array(ref("DomainEvent")) }); }
function idempotencyParameter() { return { in: "header", name: "Idempotency-Key", required: true, schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[\\x20-\\x7E]+$" } }; }
function pathParameter(name) { return { in: "path", name, required: true, schema: uuid }; }
function queryParameter(name, schema) { return { in: "query", name, required: false, schema }; }
function requestBody(schema) { return { required: true, content: { "application/json": { schema } } }; }
function responses(status, schema, errors) { return Object.fromEntries([[String(status), json(schema)], ...errors.map((code) => [String(code), json(errorSchema())])]); }
function mutation(parameters, schema, status, response, errors, security) { return { parameters: [...parameters, idempotencyParameter()], requestBody: requestBody(schema), responses: responses(status, response, errors), ...(security ? { security: [{ bearerAuth: [] }] } : {}) }; }

function finalDocument() {
  const createMilestone = object({ title: string, amountMinor: positiveInteger, beneficiaries: array(object({ beneficiaryId: uuid, amountMinor: positiveInteger }), { minItems: 1, maxItems: 20 }) }, ["title", "amountMinor"]);
  const createRequest = object({ buyerId: uuid, sellerId: uuid, currency: { type: "string", pattern: "^[A-Z]{3}$" }, totalMinor: positiveInteger, expiresAt: timestamp, milestones: array(createMilestone, { minItems: 1, maxItems: 20 }) });
  const submitResponse = object({ escrow: ref("Escrow"), milestone: ref("Milestone") });
  const releaseResponse = object({ ...resourceSchemas().Release.properties, payouts: array(ref("BeneficiaryPayout")) });
  return JSON.parse(JSON.stringify({
    openapi: "3.1.0",
    components: { schemas: resourceSchemas(), securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths: {
      "/api/v1/escrows": {
        get: { parameters: [queryParameter("limit", { type: "integer", minimum: 1, maximum: 100 }), queryParameter("cursor", string)], responses: responses(200, pageSchema(ref("Escrow")), [400]) },
        post: mutation([], createRequest, 201, ref("Escrow"), [400, 409, 415]),
      },
      "/api/v1/escrows/{escrowId}": { get: { parameters: [pathParameter("escrowId")], responses: responses(200, detailSchema(), [404]) } },
      "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/submit": { post: mutation([pathParameter("escrowId"), pathParameter("milestoneId")], object({ evidence: {} }), 200, submitResponse, [400, 404, 409, 415]) },
      "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/accept": { post: mutation([pathParameter("escrowId"), pathParameter("milestoneId")], object({}), 200, releaseResponse, [400, 404, 409, 415]) },
      "/api/v1/escrows/{escrowId}/milestones/{milestoneId}/disputes": { post: mutation([pathParameter("escrowId"), pathParameter("milestoneId")], object({ openedBy: enumeration("BUYER", "SELLER"), reason: string }), 200, ref("Dispute"), [400, 404, 409, 415]) },
      "/api/v1/admin/disputes/{disputeId}/resolve": { post: mutation([pathParameter("disputeId")], object({ decision: enumeration("RELEASE", "REFUND"), note: string }), 200, ref("Dispute"), [400, 401, 404, 409, 415], true) },
      "/api/v1/domain-events": { get: { parameters: [queryParameter("aggregateId", uuid), queryParameter("afterSequence", nonnegativeInteger), queryParameter("limit", { type: "integer", minimum: 1, maximum: 100 })], responses: responses(200, pageSchema(ref("DomainEvent")), [400]) } },
      "/api/v1/verification-snapshot": { get: { parameters: [], security: [{ bearerAuth: [] }], responses: responses(200, snapshotSchema(), [401]) } },
    },
  }));
}

test("frozen EscrowGuard OpenAPI oracle accepts the exact semantic contract", () => {
  const document = finalDocument();
  assert.equal(assertEscrowGuardOpenApi(document), true);
});

test("semantic OpenAPI oracle does not require evaluator-chosen component names", () => {
  const document = finalDocument();
  const names = Object.keys(document.components.schemas);
  const renamed = new Map(names.map((name, index) => [name, `Schema${index + 1}`]));
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, key === "$ref" && typeof child === "string" ? child.replace(/^#\/components\/schemas\/([^/]+)$/u, (_match, name) => `#/components/schemas/${renamed.get(name) ?? name}`) : rewrite(child)]));
  };
  document.paths = rewrite(document.paths);
  document.components.schemas = Object.fromEntries(names.map((name) => [renamed.get(name), rewrite(document.components.schemas[name])]));
  assert.equal(assertEscrowGuardOpenApi(document), true);
});

test("frozen EscrowGuard OpenAPI oracle rejects schema, parameter, request, response, and status mutants", () => {
  const cases = [
    (document) => { document.components.schemas.Escrow.properties.totalMinor = { type: "number" }; },
    (document) => { document.components.schemas.Escrow.properties.terminalAt = timestamp; },
    (document) => { delete document.paths["/api/v1/escrows/{escrowId}"].get.parameters[0].schema.format; },
    (document) => { document.paths["/api/v1/escrows"].post.requestBody.content["application/json"].schema.properties.hidden = string; },
    (document) => { document.paths["/api/v1/escrows"].post.responses["201"] = json(object({ data: ref("Escrow") })); },
    (document) => { document.paths["/api/v1/escrows"].post.responses.default = json(errorSchema()); },
  ];
  for (const mutate of cases) { const document = finalDocument(); mutate(document); assert.throws(() => assertEscrowGuardOpenApi(document)); }
});

test("admin operations require a referenced HTTP Bearer security scheme", () => {
  const cases = [
    (document) => { document.security = [{ bearerAuth: [] }]; },
    (document) => { document.paths["/api/v1/escrows"].get.security = [{ bearerAuth: [] }]; },
    (document) => { delete document.paths["/api/v1/verification-snapshot"].get.security; },
    (document) => { document.paths["/api/v1/verification-snapshot"].get.security = []; },
    (document) => { document.paths["/api/v1/verification-snapshot"].get.security = [{ missingAuth: [] }]; },
    (document) => { document.components.securitySchemes.bearerAuth = { type: "apiKey", in: "header", name: "Authorization" }; },
    (document) => { document.components.securitySchemes.bearerAuth = { type: "http", scheme: "basic" }; },
    (document) => { document.paths["/api/v1/admin/disputes/{disputeId}/resolve"].post.security = [{ bearerAuth: ["admin"] }]; },
    (document) => { document.paths["/api/v1/admin/disputes/{disputeId}/resolve"].post.security = [{ bearerAuth: [], second: [] }]; },
  ];
  for (const mutate of cases) {
    const document = finalDocument();
    mutate(document);
    assert.throws(() => assertEscrowGuardOpenApi(document), /anonymous|authentication|security|Bearer/u);
  }
});
