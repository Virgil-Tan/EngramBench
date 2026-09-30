import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") assert.ok(Number.isFinite(value), "canonical JSON finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function exactKeys(value, keys, label = "value") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} exact fields`);
}

export function assertPublicError(response, status, code) {
  assert.equal(response.status, status, `${code} status`);
  exactKeys(response.json, ["error"], `${code} envelope`);
  exactKeys(response.json.error, ["code", "details", "message"], `${code} error`);
  assert.equal(response.json.error.code, code, `${code} code`);
  assert.equal(typeof response.json.error.message, "string", `${code} message`);
  assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details), `${code} details`);
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function scalar(value, type, label) {
  if (type === "uuid") assert.match(value, UUID, label);
  else if (type === "timestamp") assert.match(value, TIMESTAMP, label);
  else if (type === "sha256") assert.match(value, SHA256, label);
  else if (type === "int") assert.ok(Number.isSafeInteger(value), label);
  else if (type === "string") assert.equal(typeof value, "string", label);
  else if (type === "nullableTimestamp") assert.ok(value === null || TIMESTAMP.test(value), label);
  else if (type === "nullableInt") assert.ok(value === null || Number.isSafeInteger(value), label);
}

export function assertReviewPolicy(policy) {
  exactKeys(policy, ["roles", "requiredTotalApprovals"], "ReviewPolicy");
  assert.ok(Array.isArray(policy.roles) && policy.roles.length >= 1 && policy.roles.length <= 10, "ReviewPolicy roles");
  scalar(policy.requiredTotalApprovals, "int", "ReviewPolicy total");
  let capacity = 0;
  const roles = [];
  for (const item of policy.roles) {
    exactKeys(item, ["eligibleReviewerIds", "requiredApprovals", "role", "veto"], "ReviewPolicy role");
    scalar(item.role, "string", "role");
    assert.ok(!roles.includes(item.role), "roles unique");
    roles.push(item.role);
    assert.equal(typeof item.veto, "boolean", "veto boolean");
    assert.ok(Array.isArray(item.eligibleReviewerIds) && item.eligibleReviewerIds.length >= 1 && item.eligibleReviewerIds.length <= 20, "eligible reviewers cardinality");
    for (const id of item.eligibleReviewerIds) scalar(id, "uuid", "eligible reviewer uuid");
    assert.deepEqual(item.eligibleReviewerIds, [...item.eligibleReviewerIds].sort(), "reviewer IDs bytewise");
    assert.equal(new Set(item.eligibleReviewerIds).size, item.eligibleReviewerIds.length, "reviewer IDs unique");
    assert.ok(Number.isSafeInteger(item.requiredApprovals) && item.requiredApprovals >= 1 && item.requiredApprovals <= item.eligibleReviewerIds.length, "role quota");
    capacity += item.eligibleReviewerIds.length;
  }
  assert.deepEqual(roles, [...roles].sort(), "roles bytewise");
  assert.ok(policy.requiredTotalApprovals >= 1 && policy.requiredTotalApprovals <= capacity, "total attainable");
  return true;
}

const APP_V1 = ["applicationId", "applicantId", "currentRevision", "deadlineAt", "decisionRevision", "permitType", "sequence", "state", "submittedAt", "terminalAt"];
const STAGE_FIELDS = ["activatedAt", "applicationId", "completedAt", "name", "ordinal", "policy", "revision", "stageId", "state"];

export function assertPermitApplication(value, options = {}) {
  const final = options.final ?? true;
  exactKeys(value, final ? [...APP_V1, "currentStageOrdinal", "stages"] : APP_V1, "PermitApplication");
  for (const key of ["applicationId", "applicantId"]) scalar(value[key], "uuid", `PermitApplication ${key}`);
  scalar(value.permitType, "string", "PermitApplication permitType");
  scalar(value.currentRevision, "int", "PermitApplication currentRevision");
  assert.ok(value.currentRevision > 0, "currentRevision positive");
  assert.ok(["SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "CHANGES_REQUIRED", "EXPIRED"].includes(value.state), "Application state");
  scalar(value.decisionRevision, "nullableInt", "decisionRevision");
  scalar(value.submittedAt, "timestamp", "submittedAt");
  scalar(value.deadlineAt, "timestamp", "deadlineAt");
  scalar(value.terminalAt, "nullableTimestamp", "terminalAt");
  scalar(value.sequence, "int", "sequence");
  if (final) {
    scalar(value.currentStageOrdinal, "nullableInt", "currentStageOrdinal");
    assert.ok(Array.isArray(value.stages), "PermitApplication stages");
    value.stages.forEach(assertReviewStage);
  }
  return true;
}

export function assertApplicationRevision(value) {
  exactKeys(value, ["applicationId", "canonicalDigest", "createdAt", "fields", "policy", "revision"], "ApplicationRevision");
  scalar(value.applicationId, "uuid", "Revision applicationId");
  scalar(value.revision, "int", "Revision number");
  assert.ok(value.revision > 0, "Revision positive");
  scalar(value.canonicalDigest, "sha256", "Revision digest");
  assert.equal(value.canonicalDigest, sha256(canonicalJson(value.fields)), "independent canonical digest");
  assertReviewPolicy(value.policy);
  scalar(value.createdAt, "timestamp", "Revision createdAt");
  return true;
}

export function assertReviewClaim(value) {
  exactKeys(value, ["applicationId", "attempt", "claimId", "leaseExpiresAt", "reviewerId", "revision", "role", "state"], "ReviewClaim");
  for (const key of ["claimId", "applicationId", "reviewerId"]) scalar(value[key], "uuid", `ReviewClaim ${key}`);
  scalar(value.revision, "int", "ReviewClaim revision");
  scalar(value.attempt, "int", "ReviewClaim attempt");
  scalar(value.role, "string", "ReviewClaim role");
  assert.ok(["LEASED", "DECIDED", "EXPIRED"].includes(value.state), "ReviewClaim state");
  scalar(value.leaseExpiresAt, "nullableTimestamp", "ReviewClaim leaseExpiresAt");
  assert.equal(value.leaseExpiresAt === null, value.state !== "LEASED", "ReviewClaim lease fields");
  return true;
}

export function assertReviewDecision(value) {
  exactKeys(value, ["applicationId", "decidedAt", "decision", "decisionId", "reason", "reviewerId", "revision", "role"], "ReviewDecision");
  for (const key of ["decisionId", "applicationId", "reviewerId"]) scalar(value[key], "uuid", `ReviewDecision ${key}`);
  scalar(value.revision, "int", "Decision revision");
  scalar(value.role, "string", "Decision role");
  assert.ok(["APPROVE", "REJECT", "REQUEST_CHANGES"].includes(value.decision), "Decision enum");
  scalar(value.reason, "string", "Decision reason");
  scalar(value.decidedAt, "timestamp", "Decision time");
  return true;
}

export function assertApprovedPermit(value) {
  exactKeys(value, ["applicationId", "canonicalDigest", "issuedAt", "permitId", "revision"], "ApprovedPermit");
  for (const key of ["permitId", "applicationId"]) scalar(value[key], "uuid", `ApprovedPermit ${key}`);
  scalar(value.revision, "int", "Permit revision");
  scalar(value.canonicalDigest, "sha256", "Permit digest");
  scalar(value.issuedAt, "timestamp", "Permit issuedAt");
  return true;
}

export function assertReviewStage(value) {
  exactKeys(value, STAGE_FIELDS, "ReviewStage");
  for (const key of ["stageId", "applicationId"]) scalar(value[key], "uuid", `ReviewStage ${key}`);
  scalar(value.revision, "int", "Stage revision");
  scalar(value.ordinal, "int", "Stage ordinal");
  scalar(value.name, "string", "Stage name");
  assert.ok(["PENDING", "ACTIVE", "COMPLETED", "TERMINAL"].includes(value.state), "Stage state");
  assertReviewPolicy(value.policy);
  scalar(value.activatedAt, "nullableTimestamp", "Stage activatedAt");
  scalar(value.completedAt, "nullableTimestamp", "Stage completedAt");
  return true;
}

export function assertWork(value) {
  exactKeys(value, ["aggregateId", "attempt", "kind", "leaseExpiresAt", "leaseOwner", "state", "terminal", "workId"], "Work");
  for (const key of ["workId", "aggregateId"]) scalar(value[key], "uuid", `Work ${key}`);
  assert.equal(value.kind, "PERMIT_DEADLINE", "Work kind");
  assert.ok(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state), "Work state");
  assert.equal(value.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.state), "Work terminal");
  scalar(value.attempt, "int", "Work attempt");
  assert.equal(value.leaseOwner === null, value.state !== "LEASED", "Work leaseOwner");
  assert.equal(value.leaseExpiresAt === null, value.state !== "LEASED", "Work leaseExpiresAt");
  if (value.state === "LEASED") {
    scalar(value.leaseOwner, "string", "Work leaseOwner string");
    scalar(value.leaseExpiresAt, "timestamp", "Work leaseExpiresAt timestamp");
  }
  return true;
}

export function assertDomainEvent(value) {
  exactKeys(value, ["aggregateId", "eventId", "occurredAt", "payload", "schemaVersion", "sequence", "type"], "DomainEvent");
  scalar(value.eventId, "uuid", "Event ID");
  scalar(value.aggregateId, "uuid", "Event aggregate ID");
  scalar(value.sequence, "int", "Event sequence");
  scalar(value.occurredAt, "timestamp", "Event time");
  assert.equal(value.schemaVersion, 1, "Event schemaVersion");
  assert.ok(["application.submitted", "review.claimed", "review.decided", "application.changes-requested", "application.approved", "application.rejected", "application.expired"].includes(value.type), "Event type");
  assert.deepEqual(value.payload, {}, "Event payload empty");
  return true;
}

function rank(value) {
  if (value === null) return 0;
  if (value === false) return 1;
  if (value === true) return 2;
  if (Number.isSafeInteger(value)) return 3;
  return 4;
}

export function compareScalar(left, right) {
  if (rank(left) !== rank(right)) return rank(left) - rank(right);
  if (Number.isSafeInteger(left)) return left - right;
  return Buffer.compare(Buffer.from(String(left)), Buffer.from(String(right)));
}

export function assertSorted(items, paths, label) {
  const ordered = [...items].sort((left, right) => {
    for (const path of paths) {
      const compared = compareScalar(left[path], right[path]);
      if (compared !== 0) return compared;
    }
    return Buffer.compare(Buffer.from(canonicalJson(left)), Buffer.from(canonicalJson(right)));
  });
  assert.deepEqual(items, ordered, `${label} order`);
}

export const V1_RESOURCE_KEYS = Object.freeze(["applicants", "applicationRevisions", "approvedPermits", "permitApplications", "reviewClaims", "reviewDecisions", "reviewers"]);
export const FINAL_RESOURCE_KEYS = Object.freeze([...V1_RESOURCE_KEYS, "reviewStages"].sort());

export function assertSnapshot(snapshot, options = {}) {
  const final = options.final ?? true;
  exactKeys(snapshot, ["asOf", "events", "resources", "work"], "verification snapshot");
  scalar(snapshot.asOf, "timestamp", "snapshot asOf");
  exactKeys(snapshot.resources, final ? FINAL_RESOURCE_KEYS : V1_RESOURCE_KEYS, "snapshot resources");
  const validators = {
    applicants: (value) => { exactKeys(value, ["applicantId", "name"], "Applicant"); scalar(value.applicantId, "uuid", "Applicant id"); scalar(value.name, "string", "Applicant name"); },
    reviewers: (value) => { exactKeys(value, ["name", "reviewerId", "roles"], "Reviewer"); scalar(value.reviewerId, "uuid", "Reviewer id"); scalar(value.name, "string", "Reviewer name"); assert.ok(Array.isArray(value.roles), "Reviewer roles"); },
    permitApplications: (value) => assertPermitApplication(value, { final }),
    applicationRevisions: assertApplicationRevision,
    reviewClaims: assertReviewClaim,
    reviewDecisions: assertReviewDecision,
    approvedPermits: assertApprovedPermit,
    reviewStages: assertReviewStage,
  };
  const sorts = {
    applicants: ["applicantId"], reviewers: ["reviewerId"], permitApplications: ["applicationId"],
    applicationRevisions: ["applicationId", "revision"], reviewClaims: ["applicationId", "revision", "claimId"],
    reviewDecisions: ["applicationId", "revision", "decidedAt", "decisionId"], approvedPermits: ["permitId"],
    reviewStages: ["applicationId", "revision", "ordinal", "stageId"],
  };
  for (const [key, values] of Object.entries(snapshot.resources)) {
    assert.ok(Array.isArray(values), `${key} array`);
    values.forEach(validators[key]);
    assertSorted(values, sorts[key], key);
  }
  snapshot.work.forEach(assertWork);
  assertSorted(snapshot.work, ["workId"], "work");
  snapshot.events.forEach(assertDomainEvent);
  assertSorted(snapshot.events, ["aggregateId", "sequence", "eventId"], "events");
  assertNoSecrets(snapshot);
  return true;
}

export function quorumProjection(policy, decisions) {
  assertReviewPolicy(policy);
  const byRole = new Map(policy.roles.map((role) => [role.role, { ...role, approve: 0, consumed: 0 }]));
  for (const decision of decisions) {
    const role = byRole.get(decision.role);
    if (!role || !role.eligibleReviewerIds.includes(decision.reviewerId)) continue;
    role.consumed += 1;
    if (decision.decision === "REQUEST_CHANGES") return "CHANGES_REQUIRED";
    if (decision.decision === "REJECT" && role.veto) return "REJECTED";
    if (decision.decision === "APPROVE") role.approve += 1;
  }
  const values = [...byRole.values()];
  const approvals = values.reduce((sum, role) => sum + role.approve, 0);
  if (values.every((role) => role.approve >= role.requiredApprovals) && approvals >= policy.requiredTotalApprovals) return "APPROVED";
  if (values.some((role) => role.approve + (role.eligibleReviewerIds.length - role.consumed) < role.requiredApprovals)) return "REJECTED";
  const remaining = values.reduce((sum, role) => sum + role.eligibleReviewerIds.length - role.consumed, 0);
  if (approvals + remaining < policy.requiredTotalApprovals) return "REJECTED";
  return decisions.length ? "UNDER_REVIEW" : "SUBMITTED";
}

export function assertProjection(application, revision, decisions, permit) {
  const expected = quorumProjection(revision.policy, decisions.filter((item) => item.revision === revision.revision));
  assert.equal(application.state, expected, "quorum projection");
  if (expected === "APPROVED") {
    assertApprovedPermit(permit);
    assert.equal(permit.applicationId, application.applicationId, "Permit application");
    assert.equal(permit.revision, revision.revision, "Permit revision");
    assert.equal(permit.canonicalDigest, revision.canonicalDigest, "Permit digest");
  } else assert.equal(permit, undefined, "non-approved has no Permit");
  return expected;
}

export function assertRevisionHistory(revisions) {
  assert.ok(revisions.length > 0, "Revision history nonempty");
  revisions.forEach(assertApplicationRevision);
  const ordered = [...revisions].sort((a, b) => a.revision - b.revision);
  assert.deepEqual(ordered.map(({ revision }) => revision), Array.from({ length: ordered.length }, (_, index) => index + 1), "contiguous revisions");
  return true;
}

export function assertStageSet(stages, count) {
  assert.equal(stages.length, count, "Stage count");
  stages.forEach(assertReviewStage);
  assert.deepEqual(stages.map(({ ordinal }) => ordinal), Array.from({ length: count }, (_, index) => index + 1), "Stage ordinals");
  assert.equal(stages.filter(({ state }) => state === "ACTIVE").length, 1, "one ACTIVE Stage");
  assert.equal(stages[0].state, "ACTIVE", "Stage 1 ACTIVE");
  assert.ok(stages.slice(1).every(({ state }) => state === "PENDING"), "later Stages PENDING");
  return true;
}

export function assertAggregateSequences(events) {
  const groups = Map.groupBy(events, ({ aggregateId }) => aggregateId);
  for (const [aggregateId, items] of groups) {
    const ordered = [...items].sort((a, b) => a.sequence - b.sequence);
    assert.deepEqual(ordered.map(({ sequence }) => sequence), Array.from({ length: ordered.length }, (_, index) => index + 1), `${aggregateId} gapless`);
    assert.equal(new Set(items.map(({ eventId }) => eventId)).size, items.length, `${aggregateId} Event IDs unique`);
  }
  return true;
}

export function assertRetryIdentity(ledger) {
  assert.ok(ledger.length > 0, "receiver observed requests");
  const groups = Map.groupBy(ledger, ({ headers }) => headers["x-permitforge-event-id"]);
  for (const [eventId, items] of groups) {
    assert.ok(eventId, "X-PermitForge-Event-Id present");
    assert.equal(new Set(items.map(({ raw }) => raw)).size, 1, `${eventId} raw body stable`);
    assert.equal(new Set(items.map(({ headers }) => headers["x-permitforge-event-type"])).size, 1, `${eventId} type stable`);
  }
  return true;
}

export function assertRecoveredDelivery(ledger, eventId, options = {}) {
  const attempts = ledger.filter(({ headers }) => headers["x-permitforge-event-id"] === eventId);
  assert.ok(attempts.length >= (options.minAttempts ?? 2), `${eventId} retry count`);
  assertRetryIdentity(attempts);
  if (options.requireDisconnect) {
    assert.ok(attempts.some(({ acknowledged, responseStatus }) => !acknowledged && responseStatus >= 200 && responseStatus < 300), `${eventId} transport disconnect observed`);
  }
  assert.ok(attempts.some(({ acknowledged, responseStatus }) => acknowledged && responseStatus >= 200 && responseStatus < 300), `${eventId} eventually acknowledged`);
  return true;
}

export function assertSingleAggregateWork(work, aggregateId, options = {}) {
  const selected = work.filter((item) => item.aggregateId === aggregateId);
  assert.equal(selected.length, 1, `${aggregateId} exact one Work`);
  assertWork(selected[0]);
  if (options.terminal !== undefined) assert.equal(selected[0].terminal, options.terminal, `${aggregateId} Work terminal`);
  return selected[0];
}

export function assertNoSecrets(value, sentinels = []) {
  const text = typeof value === "string" ? value : canonicalJson(value);
  for (const secret of sentinels) if (secret) assert.equal(text.includes(secret), false, "secret omitted");
  assert.equal(/(?:bearer\s+[a-z0-9._~+/=-]{16,}|postgres(?:ql)?:\/\/[^\s"']+|\/(?:Users|home|tmp)\/[^\s"']+)/iu.test(text), false, "credential value or private path omitted");
  return true;
}

const PATH_METHODS = Object.freeze({
  "/api/v1/permitApplications": ["get"],
  "/api/v1/permitApplications/{permitApplicationId}": ["get"],
  "/api/v1/permit-applications": ["post"],
  "/api/v1/permit-applications/{applicationId}/review-claims": ["post"],
  "/api/v1/review-claims/{claimId}/decisions": ["post"],
  "/api/v1/permit-applications/{applicationId}/revisions": ["post"],
  "/api/v1/permit-applications/{applicationId}": ["get"],
  "/api/v1/permit-applications/{applicationId}/revisions/{revision}": ["get"],
  "/api/v1/permit-applications/{applicationId}/stages": ["get"],
  "/api/v1/domain-events": ["get"],
  "/api/v1/verification-snapshot": ["get"],
});

function dereference(document, schema) {
  if (!schema?.$ref) return schema;
  return schema.$ref.slice(2).split("/").reduce((value, key) => value?.[key], document);
}

function assertClosedSchema(document, schema, label, seen = new Set()) {
  schema = dereference(document, schema);
  assert.ok(schema && typeof schema === "object", `${label} schema`);
  if (seen.has(schema)) return;
  seen.add(schema);
  if (schema.allOf) {
    const merged = mergedAllOf(document, schema);
    if (merged) return assertClosedSchema(document, merged, label, seen);
  }
  if (schema.type === "object" || schema.properties) {
    assert.ok(schema.additionalProperties === false || schema.unevaluatedProperties === false, `${label} closed object`);
    assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(schema.properties ?? {}).sort(), `${label} required fields`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) assertClosedSchema(document, child, `${label}.${key}`, seen);
  }
  if (schema.type === "array") assertClosedSchema(document, schema.items, `${label}[]`, seen);
  for (const [index, child] of [...(schema.oneOf ?? []), ...(schema.anyOf ?? []), ...(schema.allOf ?? [])].entries()) assertClosedSchema(document, child, `${label} composition ${index}`, seen);
}

export function assertOpenApiDocument(document) {
  assert.match(document.openapi, /^3\.1(?:\.|$)/u, "OpenAPI 3.1");
  for (const [path, methods] of Object.entries(PATH_METHODS)) {
    assert.ok(document.paths?.[path], `${path} published`);
    for (const method of methods) {
      const operation = document.paths[path][method];
      assert.ok(operation, `${method.toUpperCase()} ${path}`);
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        const schema = dereference(document, response)?.content?.["application/json"]?.schema;
        if (schema) assertClosedSchema(document, schema, `${method} ${path} ${status}`);
      }
      const request = dereference(document, operation.requestBody)?.content?.["application/json"]?.schema;
      if (request) assertClosedSchema(document, request, `${method} ${path} request`);
    }
  }
  for (const name of ["PermitApplication", "ApplicationRevision", "ReviewPolicy", "ReviewClaim", "ReviewDecision", "ApprovedPermit", "ReviewStage", "Work", "DomainEvent"]) {
    assertClosedSchema(document, document.components?.schemas?.[name], `component ${name}`);
  }
  return true;
}

function resolvedSchema(document, schema) {
  if (!schema?.$ref) return schema;
  const referenced = schema.$ref.slice(2).split("/").reduce((value, key) => value?.[key], document);
  assert.ok(referenced, `missing OpenAPI reference ${schema.$ref}`);
  const { $ref: _ref, ...siblings } = schema;
  return Object.keys(siblings).length ? { ...referenced, ...siblings } : referenced;
}

function mergedAllOf(document, schema) {
  const branches = schema.allOf.map((branch) => resolvedSchema(document, branch));
  if (!branches.every((branch) => branch?.type === "object" || branch?.properties)) return undefined;
  return {
    ...schema,
    allOf: undefined,
    type: "object",
    properties: Object.assign({}, ...branches.map(({ properties = {} }) => properties), schema.properties ?? {}),
    required: [...new Set([...branches.flatMap(({ required = [] }) => required), ...(schema.required ?? [])])],
    additionalProperties: schema.additionalProperties ?? schema.unevaluatedProperties ?? (branches.some(({ additionalProperties }) => additionalProperties === false) ? false : undefined),
  };
}

export function assertOpenApiValue(document, rawSchema, value, label = "OpenAPI value") {
  const schema = resolvedSchema(document, rawSchema);
  assert.ok(schema && typeof schema === "object", `${label} schema exists`);
  if (value === null && (schema.nullable === true || (Array.isArray(schema.type) && schema.type.includes("null")))) return true;
  if (schema.const !== undefined) assert.deepEqual(value, schema.const, `${label} const`);
  if (schema.enum) assert.ok(schema.enum.some((item) => canonicalJson(item) === canonicalJson(value)), `${label} enum`);
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => {
      try { assertOpenApiValue(document, branch, value, label); return true; } catch { return false; }
    });
    assert.equal(matches.length, 1, `${label} oneOf`);
    return true;
  }
  if (schema.anyOf) {
    assert.ok(schema.anyOf.some((branch) => {
      try { assertOpenApiValue(document, branch, value, label); return true; } catch { return false; }
    }), `${label} anyOf`);
    return true;
  }
  if (schema.allOf) {
    const merged = mergedAllOf(document, schema);
    if (merged) return assertOpenApiValue(document, merged, value, label);
    schema.allOf.forEach((branch) => assertOpenApiValue(document, branch, value, label));
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length) {
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value === "number" ? "number" : typeof value;
    assert.ok(types.includes(actual) || (actual === "integer" && types.includes("number")), `${label} type ${types.join("|")}`);
  }
  if (value && typeof value === "object" && !Array.isArray(value) && (schema.type === "object" || schema.properties)) {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${label}.${key} required`);
    for (const [key, member] of Object.entries(value)) {
      if (schema.properties?.[key]) assertOpenApiValue(document, schema.properties[key], member, `${label}.${key}`);
      else if (schema.additionalProperties === false || schema.unevaluatedProperties === false) assert.fail(`${label}.${key} additional property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") assertOpenApiValue(document, schema.additionalProperties, member, `${label}.${key}`);
    }
    if (schema.minProperties !== undefined) assert.ok(Object.keys(value).length >= schema.minProperties, `${label} minProperties`);
    if (schema.maxProperties !== undefined) assert.ok(Object.keys(value).length <= schema.maxProperties, `${label} maxProperties`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) assert.ok(value.length >= schema.minItems, `${label} minItems`);
    if (schema.maxItems !== undefined) assert.ok(value.length <= schema.maxItems, `${label} maxItems`);
    if (schema.uniqueItems) assert.equal(new Set(value.map(canonicalJson)).size, value.length, `${label} uniqueItems`);
    if (schema.items) value.forEach((item, index) => assertOpenApiValue(document, schema.items, item, `${label}[${index}]`));
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined) assert.ok([...value].length >= schema.minLength, `${label} minLength`);
    if (schema.maxLength !== undefined) assert.ok([...value].length <= schema.maxLength, `${label} maxLength`);
    if (schema.pattern) assert.match(value, new RegExp(schema.pattern, "u"), `${label} pattern`);
    if (schema.format === "uuid") assert.match(value, UUID, `${label} uuid`);
    if (schema.format === "date-time") assert.match(value, TIMESTAMP, `${label} date-time`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${label} minimum`);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${label} maximum`);
  }
  return true;
}

export function assertOpenApiRequest(document, path, method, value) {
  const operation = document.paths?.[path]?.[method.toLowerCase()];
  assert.ok(operation, `${method.toUpperCase()} ${path} operation`);
  const requestBody = resolvedSchema(document, operation.requestBody);
  const schema = requestBody?.content?.["application/json"]?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${path} JSON request schema`);
  return assertOpenApiValue(document, schema, value, `${method.toUpperCase()} ${path} request`);
}

export function assertOpenApiResponse(document, path, method, response) {
  const operation = document.paths?.[path]?.[method.toLowerCase()];
  assert.ok(operation, `${method.toUpperCase()} ${path} operation`);
  const status = String(response.status);
  const declaration = resolvedSchema(document, operation.responses?.[status]);
  assert.ok(declaration, `${method.toUpperCase()} ${path} status ${status} declared`);
  const schema = declaration.content?.["application/json"]?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${path} ${status} JSON response schema`);
  assert.notEqual(response.json, undefined, `${method.toUpperCase()} ${path} ${status} runtime JSON`);
  return assertOpenApiValue(document, schema, response.json, `${method.toUpperCase()} ${path} ${status} response`);
}

function operationParameters(document, pathItem, operation) {
  return [...(pathItem?.parameters ?? []), ...(operation?.parameters ?? [])].map((item) => resolvedSchema(document, item));
}

function expectedParameter(parameters, expected) {
  return parameters.find((item) => item.in === expected.in && (expected.in === "header"
    ? item.name.toLowerCase() === expected.name.toLowerCase()
    : item.name === expected.name));
}

export function assertExactOpenApiOperation(document, path, method, contract) {
  const pathItem = document.paths?.[path];
  const operation = pathItem?.[method.toLowerCase()];
  assert.ok(operation, `${method.toUpperCase()} ${path} operation`);
  assert.deepEqual(Object.keys(operation.responses ?? {}).sort(), [...contract.statuses].map(String).sort(), `${method.toUpperCase()} ${path} exact statuses`);

  const actualParameters = operationParameters(document, pathItem, operation);
  assert.equal(actualParameters.length, contract.parameters.length, `${method.toUpperCase()} ${path} exact parameter count`);
  for (const expected of contract.parameters) {
    const actual = expectedParameter(actualParameters, expected);
    assert.ok(actual, `${method.toUpperCase()} ${path} ${expected.in} ${expected.name}`);
    assert.equal(actual.required, expected.required, `${expected.name} required`);
    const schema = resolvedSchema(document, actual.schema);
    for (const field of ["type", "format", "minimum", "maximum", "minLength", "maxLength"]) {
      if (Object.hasOwn(expected, field)) assert.deepEqual(schema?.[field], expected[field], `${expected.name} ${field}`);
    }
  }

  if ((contract.validRequests?.length ?? 0) > 0) {
    assert.equal(resolvedSchema(document, operation.requestBody)?.required, true, `${method.toUpperCase()} ${path} request body required`);
  }
  for (const value of contract.validRequests ?? []) assertOpenApiRequest(document, path, method, value);
  for (const value of contract.invalidRequests ?? []) {
    assert.throws(() => assertOpenApiRequest(document, path, method, value), `${method.toUpperCase()} ${path} rejects invalid request schema sample`);
  }
  for (const response of contract.validResponses ?? []) assertOpenApiResponse(document, path, method, response);
  for (const response of contract.invalidResponses ?? []) {
    assert.throws(() => assertOpenApiResponse(document, path, method, response), `${method.toUpperCase()} ${path} rejects invalid response schema sample`);
  }
  return true;
}
