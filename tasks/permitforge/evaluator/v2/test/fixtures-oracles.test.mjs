import assert from "node:assert/strict";
import test from "node:test";

import { createFixtureFactory } from "../fixtures/index.mjs";
import {
  assertAggregateSequences,
  assertExactOpenApiOperation,
  assertOpenApiRequest,
  assertOpenApiResponse,
  assertNoSecrets,
  assertProjection,
  assertPublicError,
  assertRecoveredDelivery,
  assertRetryIdentity,
  assertRevisionHistory,
  assertSingleAggregateWork,
  canonicalJson,
  quorumProjection,
  sha256,
} from "../oracles/index.mjs";

function factory(caseId = "A-01") {
  return createFixtureFactory({ evaluationSeed: "permitforge-test-seed", caseId, baseTime: "2035-06-01T12:00:00.000Z" });
}

test("PermitForge fixtures are deterministic isolated and task-owned", () => {
  const left = factory("A-06").main("fixture");
  const right = factory("A-06").main("fixture");
  const other = factory("B-01").main("fixture");
  assert.equal(left.fixtureFamily, "PF-F-V1-POLICY");
  assert.deepEqual(left.seed, right.seed);
  assert.notEqual(left.application.applicationId, other.application.applicationId);
  assert.deepEqual(left.policy.roles.map(({ role }) => role), ["legal", "security"]);
});

test("canonical digest and Revision history oracle reject common corruption", () => {
  const value = factory("B-01");
  const left = { alpha: 1, nested: { a: true, z: false }, omega: "same" };
  const right = { omega: "same", nested: { z: false, a: true }, alpha: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(sha256(canonicalJson(left)), sha256(canonicalJson(right)));
  const history = value.history("revision", "SUBMITTED");
  const revision2 = { ...history.revision, revision: 2, fields: { amendment: 2 }, canonicalDigest: sha256(canonicalJson({ amendment: 2 })), createdAt: value.at({ days: -1 }) };
  assert.equal(assertRevisionHistory([history.revision, revision2]), true);
  assert.throws(() => assertRevisionHistory([history.revision, { ...revision2, revision: 3 }]));
});

test("independent quorum oracle covers worked approval veto reachable and impossible paths", () => {
  const value = factory("B-02");
  const policy = value.policy;
  const decision = (reviewer, role, result) => ({ reviewerId: reviewer.reviewerId, role, decision: result });
  assert.equal(quorumProjection(policy, [decision(value.securityReviewers[0], "security", "APPROVE"), decision(value.securityReviewers[1], "security", "APPROVE"), decision(value.legalReviewers[0], "legal", "APPROVE")]), "APPROVED");
  assert.equal(quorumProjection(policy, [decision(value.securityReviewers[0], "security", "REJECT")]), "REJECTED");
  assert.equal(quorumProjection(policy, [decision(value.legalReviewers[0], "legal", "REJECT")]), "UNDER_REVIEW");
  const projections = value.projections();
  for (const item of projections.histories) assert.equal(assertProjection(item.application, item.revision, item.decisions, item.permits[0]), item.application.state);
});

test("Event and receiver retry oracles fail on identity or sequence corruption", () => {
  const value = factory("C-08");
  const applicationId = value.uuid("aggregate");
  const events = [
    { aggregateId: applicationId, eventId: value.uuid("event-1"), sequence: 1 },
    { aggregateId: applicationId, eventId: value.uuid("event-2"), sequence: 2 },
  ];
  assert.equal(assertAggregateSequences(events), true);
  assert.throws(() => assertAggregateSequences([events[0], { ...events[1], sequence: 3 }]));
  const receiver = [
    { headers: { "x-permitforge-event-id": events[0].eventId, "x-permitforge-event-type": "application.submitted" }, raw: "{\"same\":true}" },
    { headers: { "x-permitforge-event-id": events[0].eventId, "x-permitforge-event-type": "application.submitted" }, raw: "{\"same\":true}" },
  ];
  assert.equal(assertRetryIdentity(receiver), true);
  assert.throws(() => assertRetryIdentity([receiver[0], { ...receiver[1], raw: "{\"changed\":true}" }]));

  const recovered = [
    { ...receiver[0], acknowledged: false, responseStatus: 204 },
    { ...receiver[1], acknowledged: true, responseStatus: 500 },
    { ...receiver[1], acknowledged: true, responseStatus: 204 },
  ];
  assert.equal(assertRecoveredDelivery(recovered, events[0].eventId, { minAttempts: 3, requireDisconnect: true }), true);
  assert.throws(() => assertRecoveredDelivery(recovered.slice(1), events[0].eventId, { minAttempts: 3, requireDisconnect: true }));
  assert.throws(() => assertRecoveredDelivery(recovered.map((entry) => ({ ...entry, acknowledged: true })), events[0].eventId, { minAttempts: 3, requireDisconnect: true }));
});

test("aggregate Work oracle rejects deletion, duplication and nonterminal fake drain", () => {
  const value = factory("C-01");
  const aggregateId = value.uuid("aggregate-work");
  const work = {
    workId: value.uuid("work"),
    kind: "PERMIT_DEADLINE",
    aggregateId,
    state: "SUCCEEDED",
    terminal: true,
    attempt: 2,
    leaseOwner: null,
    leaseExpiresAt: null,
  };
  assert.deepEqual(assertSingleAggregateWork([work], aggregateId, { terminal: true }), work);
  assert.throws(() => assertSingleAggregateWork([], aggregateId, { terminal: true }));
  assert.throws(() => assertSingleAggregateWork([work, { ...work, workId: value.uuid("duplicate-work") }], aggregateId, { terminal: true }));
  assert.throws(() => assertSingleAggregateWork([{ ...work, state: "PENDING", terminal: false, attempt: 1 }], aggregateId, { terminal: true }));
});

test("runtime OpenAPI oracle rejects undeclared statuses and shape drift", () => {
  const document = {
    openapi: "3.1.0",
    paths: {
      "/items": {
        post: {
          requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["itemId"], properties: { itemId: { type: "string", format: "uuid" } } } } } },
          responses: {
            201: { content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["created"], properties: { created: { type: "boolean" } } } } } },
            400: { content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["code"], properties: { code: { type: "string", enum: ["BAD"] } } } } } },
          },
        },
      },
    },
  };
  const body = { itemId: "9f8fe98e-b16f-4b20-aea7-e8d84ba029d1" };
  assert.equal(assertOpenApiRequest(document, "/items", "post", body), true);
  assert.equal(assertOpenApiResponse(document, "/items", "post", { status: 201, json: { created: true } }), true);
  assert.throws(() => assertOpenApiRequest(document, "/items", "post", { ...body, extra: true }));
  assert.throws(() => assertOpenApiResponse(document, "/items", "post", { status: 201, json: { created: "yes" } }));
  assert.throws(() => assertOpenApiResponse(document, "/items", "post", { status: 500, json: { code: "BAD" } }));
});

test("exact OpenAPI operation oracle rejects loose formats headers and fallback statuses", () => {
  const document = {
    openapi: "3.1.0",
    paths: {
      "/items/{itemId}": {
        post: {
          parameters: [
            { name: "itemId", in: "path", required: true, schema: { type: "string", format: "uuid" } },
            { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 1, maxLength: 128 } },
          ],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["reviewerId"], properties: { reviewerId: { type: "string", format: "uuid" } } } } } },
          responses: {
            200: { content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["claimId"], properties: { claimId: { type: "string", format: "uuid" } } } } } },
            400: { content: { "application/json": { schema: { type: "object", additionalProperties: false, required: ["error"], properties: { error: { type: "object", additionalProperties: false, required: ["code", "message", "details"], properties: { code: { type: "string" }, message: { type: "string" }, details: { type: "object", additionalProperties: true } } } } } } } },
          },
        },
      },
    },
  };
  const uuid = "9f8fe98e-b16f-4b20-aea7-e8d84ba029d1";
  const contract = {
    statuses: ["200", "400"],
    parameters: [
      { name: "itemId", in: "path", required: true, type: "string", format: "uuid" },
      { name: "Idempotency-Key", in: "header", required: true, type: "string", minLength: 1, maxLength: 128 },
    ],
    validRequests: [{ reviewerId: uuid }],
    invalidRequests: [{}, { reviewerId: "not-a-uuid" }, { reviewerId: uuid, extra: true }],
    validResponses: [{ status: 200, json: { claimId: uuid } }, { status: 400, json: { error: { code: "INVALID_REQUEST", message: "bad", details: {} } } }],
    invalidResponses: [{ status: 200, json: {} }, { status: 200, json: { claimId: "not-a-uuid" } }, { status: 200, json: { claimId: uuid, extra: true } }],
  };
  assert.equal(assertExactOpenApiOperation(document, "/items/{itemId}", "post", contract), true);

  const looseFormat = structuredClone(document);
  delete looseFormat.paths["/items/{itemId}"].post.requestBody.content["application/json"].schema.properties.reviewerId.format;
  assert.throws(() => assertExactOpenApiOperation(looseFormat, "/items/{itemId}", "post", contract));
  const missingHeader = structuredClone(document);
  missingHeader.paths["/items/{itemId}"].post.parameters.pop();
  assert.throws(() => assertExactOpenApiOperation(missingHeader, "/items/{itemId}", "post", contract));
  const fallback = structuredClone(document);
  fallback.paths["/items/{itemId}"].post.responses.default = fallback.paths["/items/{itemId}"].post.responses[400];
  delete fallback.paths["/items/{itemId}"].post.responses[400];
  assert.throws(() => assertExactOpenApiOperation(fallback, "/items/{itemId}", "post", contract));
  assert.throws(() => assertOpenApiResponse(fallback, "/items/{itemId}", "post", contract.validResponses[1]));
});

test("public error oracle requires the exact details member", () => {
  assert.equal(assertPublicError({ status: 400, json: { error: { code: "INVALID_REQUEST", message: "bad", details: {} } } }, 400, "INVALID_REQUEST"), true);
  assert.throws(() => assertPublicError({ status: 400, json: { error: { code: "INVALID_REQUEST", message: "bad" } } }, 400, "INVALID_REQUEST"));
});

test("secret oracle permits public field names and rejects concrete secret values", () => {
  const secret = "permitforge-admin-0123456789abcdef";
  assert.equal(assertNoSecrets({ leaseTokenHash: "a".repeat(64), authorizationFieldDocumented: true }), true);
  assert.throws(() => assertNoSecrets({ log: `Authorization: Bearer ${secret}` }, [secret]));
  assert.throws(() => assertNoSecrets({ log: "postgresql://user:pass@database/private" }));
});

test("performance fixture freezes all three published workloads and exact seed counts", () => {
  const value = factory("E-04").performance();
  assert.deepEqual(value.spec.read, { clients: 64, warmupMs: 10_000, measureMs: 60_000, minimumThroughput: 350, maximumP95Ms: 120 });
  assert.deepEqual(value.spec.submit, { clients: 64, warmupMs: 10_000, measureMs: 60_000, minimumThroughput: 100, maximumP95Ms: 350 });
  assert.deepEqual(value.spec.recovery, { workers: 2, applications: 10_000, deadlineMs: 75_000 });
  const seed = value.buildSeed();
  assert.equal(seed.seedVersion, "perf-v1");
  assert.equal(seed.applicants.length, 20_000);
  assert.equal(seed.reviewers.length, 2_000);
  assert.equal(seed.permitApplications.length, 20_000);
  assert.equal(seed.applicationRevisions.length, 20_000);
  assert.equal(seed.reviewClaims.length, 20_000);
  assert.equal(seed.permitApplications.filter(({ deadlineAt }) => deadlineAt < "2035-06-01T12:00:00.000Z").length, 10_000);
});
