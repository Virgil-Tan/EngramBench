import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const encoder = new TextEncoder();

export function utf8Compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("RFC 8785 forbids non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError(`unsupported canonical JSON value ${typeof value}`);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotDigest(snapshot) {
  return sha256Hex(canonicalJson(snapshot));
}

export function unsignedBucket(input) {
  const digest = createHash("sha256").update(input).digest();
  return Number(digest.readBigUInt64BE(0) % 10_000n);
}

export function percentageBucket(snapshotDigestValue, flagKey, subjectKey) {
  return unsignedBucket(`${snapshotDigestValue}\0${flagKey}\0${subjectKey}`);
}

export function rolloutBucket(flagKey, environment, subjectKey) {
  return unsignedBucket(`${flagKey}\0${environment}\0${subjectKey}`);
}

function clauseMatches(clause, context) {
  const actual = context[clause.attribute];
  if (clause.operator === "EQUALS") return typeof actual === "string" && actual === clause.value;
  if (clause.operator === "IN") return typeof actual === "string" && clause.value.includes(actual);
  return false;
}

export function evaluateSnapshot(snapshot, { subjectKey, context = {} }) {
  if (typeof subjectKey !== "string" || subjectKey.length === 0) throw new TypeError("subjectKey is required");
  for (const rule of snapshot.rules) {
    if (rule.clauses.every((clause) => clauseMatches(clause, context))) {
      const variant = snapshot.variants.find(({ key }) => key === rule.variantKey);
      if (!variant) throw new TypeError(`rule ${rule.ruleId} references missing variant`);
      return { variant, reason: "RULE", matchedRuleId: rule.ruleId };
    }
  }
  const bucket = percentageBucket(snapshotDigest(snapshot), snapshot.flagKey, subjectKey);
  let cumulative = 0;
  for (const variant of snapshot.variants) {
    cumulative += variant.allocationBasisPoints;
    if (bucket < cumulative) return { variant, reason: "PERCENTAGE", matchedRuleId: null, bucket };
  }
  throw new TypeError("variant allocations do not total 10000");
}

export function selectRolloutSnapshot({ flagKey, environment, subjectKey, exposure, prior, candidate }) {
  const bucket = rolloutBucket(flagKey, environment, subjectKey);
  return { bucket, snapshot: bucket < exposure ? candidate : prior, selected: bucket < exposure ? "candidate" : "prior" };
}

export function failureBasisPoints(successCount, failureCount) {
  assertSafeInteger(successCount, "successCount");
  assertSafeInteger(failureCount, "failureCount");
  const total = successCount + failureCount;
  return total === 0 ? 0 : Math.floor((failureCount * 10_000) / total);
}

export function resolveObservation({ successCount, failureCount, minimumEvaluationCount, maximumFailureBasisPoints }) {
  const evaluationCount = successCount + failureCount;
  return {
    evaluationCount,
    failureBasisPoints: failureBasisPoints(successCount, failureCount),
    passed: evaluationCount >= minimumEvaluationCount && failureBasisPoints(successCount, failureCount) <= maximumFailureBasisPoints,
  };
}

function mapBy(items, key) { return new Map(items.map((item) => [item[key], item])); }
function commonOrder(left, right, key) {
  const rightIds = new Set(right.map((item) => item[key]));
  const leftIds = new Set(left.map((item) => item[key]));
  return [left.filter((item) => rightIds.has(item[key])).map((item) => item[key]), right.filter((item) => leftIds.has(item[key])).map((item) => item[key])];
}

export function revisionDiff(from, to) {
  const variantsFrom = mapBy(from.variants, "key"), variantsTo = mapBy(to.variants, "key");
  const rulesFrom = mapBy(from.rules, "ruleId"), rulesTo = mapBy(to.rules, "ruleId");
  const addedVariantKeys = [...variantsTo.keys()].filter((key) => !variantsFrom.has(key)).sort(utf8Compare);
  const removedVariantKeys = [...variantsFrom.keys()].filter((key) => !variantsTo.has(key)).sort(utf8Compare);
  const changedVariantKeys = [...variantsFrom.keys()].filter((key) => variantsTo.has(key) && canonicalJson({ value: variantsFrom.get(key).value, allocationBasisPoints: variantsFrom.get(key).allocationBasisPoints }) !== canonicalJson({ value: variantsTo.get(key).value, allocationBasisPoints: variantsTo.get(key).allocationBasisPoints })).sort(utf8Compare);
  const addedRuleIds = [...rulesTo.keys()].filter((key) => !rulesFrom.has(key)).sort(utf8Compare);
  const removedRuleIds = [...rulesFrom.keys()].filter((key) => !rulesTo.has(key)).sort(utf8Compare);
  const changedRuleIds = [...rulesFrom.keys()].filter((key) => rulesTo.has(key) && canonicalJson({ clauses: rulesFrom.get(key).clauses, variantKey: rulesFrom.get(key).variantKey }) !== canonicalJson({ clauses: rulesTo.get(key).clauses, variantKey: rulesTo.get(key).variantKey })).sort(utf8Compare);
  const [fromVariantOrder, toVariantOrder] = commonOrder(from.variants, to.variants, "key");
  const [fromRuleOrder, toRuleOrder] = commonOrder(from.rules, to.rules, "ruleId");
  return { defaultVariantChanged: from.defaultVariant !== to.defaultVariant, addedVariantKeys, removedVariantKeys, changedVariantKeys, variantOrderChanged: canonicalJson(fromVariantOrder) !== canonicalJson(toVariantOrder), addedRuleIds, removedRuleIds, changedRuleIds, ruleOrderChanged: canonicalJson(fromRuleOrder) !== canonicalJson(toRuleOrder) };
}

export function exactKeys(value, keys, label = "object") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} is an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} exact keys`);
}

export function assertPublicError(response, status, code) { assert.equal(response.status, status); exactKeys(response.json, ["error"], "error envelope"); exactKeys(response.json.error, ["code", "message", "details"], "error"); assert.equal(response.json.error.code, code); assert.equal(typeof response.json.error.message, "string"); assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details)); return true; }

export function assertSafeInteger(value, label = "value") { assert.ok(Number.isSafeInteger(value), `${label} is a safe integer`); }
export function assertUuid(value, label = "uuid") { assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u, `${label} is lowercase UUID`); }
export function assertTimestamp(value, label = "timestamp") { assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u, `${label} is UTC millisecond timestamp`); }

export function assertWork(items, { final = true } = {}) {
  for (const item of items) {
    exactKeys(item, ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"], "Work");
    assert.ok((final ? ["FLAG_COMPILATION", "ROLLOUT_DEADLINE"] : ["FLAG_COMPILATION"]).includes(item.kind));
    assertUuid(item.workId, "Work.workId"); assertUuid(item.aggregateId, "Work.aggregateId"); assertSafeInteger(item.attempt, "Work.attempt"); assert.ok(item.attempt > 0); assert.ok(["PENDING", "LEASED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state));
    assert.equal(item.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state));
    assert.equal(item.state === "LEASED", item.leaseOwner !== null && item.leaseExpiresAt !== null);
    if (item.leaseOwner !== null) assert.equal(typeof item.leaseOwner, "string"); if (item.leaseExpiresAt !== null) assertTimestamp(item.leaseExpiresAt, "Work.leaseExpiresAt");
  }
}

export function assertEventSequence(events) {
  const byAggregate = new Map();
  for (const event of events) {
    exactKeys(event, ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"], "DomainEvent");
    const values = byAggregate.get(event.aggregateId) ?? [];
    values.push(event.sequence); byAggregate.set(event.aggregateId, values);
  }
  for (const values of byAggregate.values()) assert.deepEqual(values, Array.from({ length: values.length }, (_, index) => index + 1), "contiguous aggregate sequence");
}

export function findSubjectForBucket(bucketFn, predicate, prefix = "subject") {
  for (let index = 0; index < 2_000_000; index += 1) {
    const subjectKey = `${prefix}-${index}`;
    const bucket = bucketFn(subjectKey);
    if (predicate(bucket)) return { subjectKey, bucket };
  }
  throw new Error("unable to find deterministic bucket fixture");
}

export function canonicalBytes(value) { return encoder.encode(canonicalJson(value)); }

export function assertFlagRule(value) {
  exactKeys(value, ["ruleId", "clauses", "variantKey"], "FlagRule"); assertUuid(value.ruleId, "FlagRule.ruleId"); assert.equal(typeof value.variantKey, "string"); assert.ok(Array.isArray(value.clauses) && value.clauses.length > 0);
  for (const clause of value.clauses) { exactKeys(clause, ["attribute", "operator", "value"], "FlagRule clause"); assert.match(clause.attribute, /^[\x21-\x7e]{1,64}$/u); assert.ok(["EQUALS", "IN"].includes(clause.operator)); if (clause.operator === "EQUALS") assert.equal(typeof clause.value, "string"); else { assert.ok(Array.isArray(clause.value) && clause.value.length >= 1 && clause.value.length <= 20); assert.deepEqual(clause.value, [...new Set(clause.value)].sort(utf8Compare), "IN values sorted unique"); } }
  return true;
}

function assertVariant(value, flagType) { exactKeys(value, ["key", "value", "allocationBasisPoints"], "Flag variant"); assert.match(value.key, /^[\x21-\x7e]{1,64}$/u); assert.equal(typeof value.value, flagType === "BOOLEAN" ? "boolean" : "string"); assertSafeInteger(value.allocationBasisPoints, "allocationBasisPoints"); assert.ok(value.allocationBasisPoints >= 0 && value.allocationBasisPoints <= 10_000); }

export function assertProject(value) { exactKeys(value, ["projectId", "name"], "Project"); assertUuid(value.projectId); assert.equal(typeof value.name, "string"); return true; }
export function assertEnvironment(value) { exactKeys(value, ["projectId", "name", "contextAttributes", "schemaRevision"], "Environment"); assertUuid(value.projectId); assert.equal(typeof value.name, "string"); assert.deepEqual(value.contextAttributes, [...new Set(value.contextAttributes)].sort(utf8Compare), "contextAttributes sorted unique"); assertSafeInteger(value.schemaRevision); assert.ok(value.schemaRevision > 0); return true; }
export function assertFlag(value) { exactKeys(value, ["flagId", "projectId", "key", "flagType", "createdAt"], "Flag"); assertUuid(value.flagId); assertUuid(value.projectId); assert.match(value.key, /^[\x21-\x7e]{1,64}$/u); assert.ok(["STRING", "BOOLEAN"].includes(value.flagType)); assertTimestamp(value.createdAt); return true; }

function assertRevisionMembers(value) { assert.ok(["STRING", "BOOLEAN"].includes(value.flagType)); assert.equal(typeof value.defaultVariant, "string"); assert.ok(Array.isArray(value.variants) && value.variants.length > 0); value.variants.forEach((item) => assertVariant(item, value.flagType)); assert.equal(value.variants.reduce((sum, item) => sum + item.allocationBasisPoints, 0), 10_000); assert.equal(new Set(value.variants.map(({ key }) => key)).size, value.variants.length); assert.ok(value.variants.some(({ key }) => key === value.defaultVariant)); assert.ok(Array.isArray(value.rules)); value.rules.forEach(assertFlagRule); const keys = new Set(value.variants.map(({ key }) => key)); assert.ok(value.rules.every(({ variantKey }) => keys.has(variantKey))); }

export function assertFlagRevision(value) {
  exactKeys(value, ["revisionId", "flagId", "environment", "revision", "flagType", "defaultVariant", "variants", "rules", "state", "snapshotDigest", "createdAt", "activatedAt", "sequence"], "FlagRevision"); assertUuid(value.revisionId); assertUuid(value.flagId); assert.equal(typeof value.environment, "string"); assertSafeInteger(value.revision); assert.ok(value.revision > 0); assertRevisionMembers(value); assert.ok(["COMPILING", "READY", "ACTIVE", "REJECTED", "SUPERSEDED"].includes(value.state)); assert.ok(value.snapshotDigest === null || /^[0-9a-f]{64}$/u.test(value.snapshotDigest)); assertTimestamp(value.createdAt); assert.ok(value.activatedAt === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.activatedAt)); assertSafeInteger(value.sequence); assert.ok(value.sequence > 0); if (["READY", "ACTIVE", "SUPERSEDED"].includes(value.state)) assert.match(value.snapshotDigest, /^[0-9a-f]{64}$/u); return true;
}

export function assertFlagSnapshot(value) {
  exactKeys(value, ["snapshotVersion", "projectId", "flagId", "flagKey", "environment", "revisionId", "revision", "flagType", "defaultVariant", "variants", "rules", "contextAttributes", "contextSchemaRevision"], "FlagSnapshot"); assert.equal(value.snapshotVersion, 1); assertUuid(value.projectId); assertUuid(value.flagId); assertUuid(value.revisionId); assert.match(value.flagKey, /^[\x21-\x7e]{1,64}$/u); assert.equal(typeof value.environment, "string"); assertSafeInteger(value.revision); assert.ok(value.revision > 0); assertRevisionMembers(value); assert.deepEqual(value.contextAttributes, [...new Set(value.contextAttributes)].sort(utf8Compare), "Snapshot contextAttributes sorted unique"); assertSafeInteger(value.contextSchemaRevision); assert.ok(value.contextSchemaRevision > 0); return true;
}

export function assertEvaluation(value, { final = true } = {}) {
  const keys = ["projectId", "flagId", "flagKey", "environment", "subjectKey", "variantKey", "value", "revisionId", "snapshotDigest", "reason", "matchedRuleId", ...(final ? ["rolloutId", "stepIndex"] : [])]; exactKeys(value, keys, "Evaluation"); assertUuid(value.projectId); assertUuid(value.flagId); assertUuid(value.revisionId); assert.equal(typeof value.flagKey, "string"); assert.equal(typeof value.environment, "string"); assert.equal(typeof value.subjectKey, "string"); assert.equal(typeof value.variantKey, "string"); assert.ok(typeof value.value === "string" || typeof value.value === "boolean"); assert.match(value.snapshotDigest, /^[0-9a-f]{64}$/u); assert.ok(["DEFAULT", "RULE", "PERCENTAGE"].includes(value.reason)); assert.ok(value.matchedRuleId === null || /^[0-9a-f-]{36}$/u.test(value.matchedRuleId)); if (final) { assert.ok(value.rolloutId === null || /^[0-9a-f-]{36}$/u.test(value.rolloutId)); assert.ok(value.stepIndex === null || Number.isSafeInteger(value.stepIndex)); } return true;
}

export function assertRevisionDiff(value) { exactKeys(value, ["flagId", "environment", "fromRevision", "toRevision", "defaultVariantChanged", "addedVariantKeys", "removedVariantKeys", "changedVariantKeys", "variantOrderChanged", "addedRuleIds", "removedRuleIds", "changedRuleIds", "ruleOrderChanged"], "FlagRevisionDiff"); assertUuid(value.flagId); assert.equal(typeof value.environment, "string"); assertSafeInteger(value.fromRevision); assertSafeInteger(value.toRevision); for (const key of ["defaultVariantChanged", "variantOrderChanged", "ruleOrderChanged"]) assert.equal(typeof value[key], "boolean"); for (const key of ["addedVariantKeys", "removedVariantKeys", "changedVariantKeys", "addedRuleIds", "removedRuleIds", "changedRuleIds"]) assert.deepEqual(value[key], [...value[key]].sort(utf8Compare), `${key} byte sorted`); return true; }

export function assertProgressiveRollout(value) {
  exactKeys(value, ["rolloutId", "flagId", "environment", "priorRevisionId", "candidateRevisionId", "state", "currentStepIndex", "steps", "createdAt", "terminalAt"], "ProgressiveRollout"); for (const key of ["rolloutId", "flagId", "priorRevisionId", "candidateRevisionId"]) assertUuid(value[key], `ProgressiveRollout.${key}`); assert.equal(typeof value.environment, "string"); assert.ok(["RUNNING", "COMPLETED", "ROLLED_BACK", "STALE"].includes(value.state)); assertSafeInteger(value.currentStepIndex); assert.ok(Array.isArray(value.steps) && value.steps.length >= 1 && value.steps.length <= 10); assertTimestamp(value.createdAt); assert.ok(value.terminalAt === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.terminalAt)); let priorExposure = -1; for (const [index, step] of value.steps.entries()) { exactKeys(step, ["stepIndex", "candidateExposureBasisPoints", "minimumEvaluationCount", "maximumFailureBasisPoints", "observationSeconds", "successCount", "failureCount", "state", "startedAt", "observationDeadlineAt", "completedAt"], "RolloutStep"); assert.equal(step.stepIndex, index); for (const key of ["candidateExposureBasisPoints", "minimumEvaluationCount", "maximumFailureBasisPoints", "observationSeconds", "successCount", "failureCount"]) assertSafeInteger(step[key], `RolloutStep.${key}`); assert.ok(step.candidateExposureBasisPoints > priorExposure && step.candidateExposureBasisPoints <= 10_000); priorExposure = step.candidateExposureBasisPoints; assert.ok(step.minimumEvaluationCount >= 0); assert.ok(step.maximumFailureBasisPoints >= 0 && step.maximumFailureBasisPoints <= 10_000); assert.ok(step.observationSeconds >= 1 && step.observationSeconds <= 86_400); assert.ok(step.successCount >= 0 && step.failureCount >= 0); assert.ok(["PENDING", "OBSERVING", "PASSED", "FAILED"].includes(step.state)); for (const key of ["startedAt", "observationDeadlineAt", "completedAt"]) assert.ok(step[key] === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(step[key])); if (step.startedAt !== null) { assertTimestamp(step.observationDeadlineAt); assert.equal(Date.parse(step.observationDeadlineAt) - Date.parse(step.startedAt), step.observationSeconds * 1_000); } } assert.equal(value.steps.at(-1).candidateExposureBasisPoints, 10_000); return true;
}

export function assertEvaluationOutcome(value) { exactKeys(value, ["outcomeId", "rolloutId", "stepIndex", "subjectKey", "snapshotDigest", "outcome", "reportedAt"], "EvaluationOutcome"); assert.equal(typeof value.outcomeId, "string"); assertUuid(value.rolloutId); assertSafeInteger(value.stepIndex); assert.equal(typeof value.subjectKey, "string"); assert.match(value.snapshotDigest, /^[0-9a-f]{64}$/u); assert.ok(["SUCCESS", "FAILURE"].includes(value.outcome)); assertTimestamp(value.reportedAt); return true; }

export function assertDomainEvent(value) { exactKeys(value, ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"], "DomainEvent"); assertUuid(value.eventId); assertUuid(value.aggregateId); assertSafeInteger(value.sequence); assert.ok(value.sequence > 0); assert.ok(["flag.compilation-started", "flag.revision-rejected", "flag.revision-activated", "flag.revision-superseded"].includes(value.type)); assertTimestamp(value.occurredAt); assert.equal(value.schemaVersion, 1); assert.deepEqual(value.payload, {}); return true; }

function scalarCompare(left, right) { if (left === right) return 0; if (left === null) return -1; if (right === null) return 1; if (typeof left === "boolean" && typeof right === "boolean") return left ? 1 : -1; if (typeof left === "number" && typeof right === "number") return left - right; return utf8Compare(String(left), String(right)); }
function assertSorted(items, paths) { const compare = (left, right) => { for (const path of paths) { const result = scalarCompare(left[path], right[path]); if (result) return result; } return utf8Compare(canonicalJson(left), canonicalJson(right)); }; assert.deepEqual(items, [...items].sort(compare), `${paths.join(",")} sort`); }

export function assertSnapshot(value, { final = true } = {}) {
  exactKeys(value, ["asOf", "resources", "work", "events"], "verification snapshot"); assertTimestamp(value.asOf); const resourceKeys = ["projects", "environments", "flags", "flagRevisions", "flagSnapshots", ...(final ? ["progressiveRollouts", "evaluationOutcomes"] : [])]; exactKeys(value.resources, resourceKeys, "snapshot.resources"); for (const key of resourceKeys) assert.ok(Array.isArray(value.resources[key]), `${key} array`); value.resources.projects.forEach(assertProject); value.resources.environments.forEach(assertEnvironment); value.resources.flags.forEach(assertFlag); value.resources.flagRevisions.forEach(assertFlagRevision); value.resources.flagSnapshots.forEach((snapshot) => { assertFlagSnapshot(snapshot); const revision = value.resources.flagRevisions.find(({ revisionId }) => revisionId === snapshot.revisionId); assert.ok(revision, `Snapshot ${snapshot.revisionId} has Revision`); assert.equal(revision.snapshotDigest, snapshotDigest(snapshot)); }); if (final) { value.resources.progressiveRollouts.forEach(assertProgressiveRollout); value.resources.evaluationOutcomes.forEach(assertEvaluationOutcome); }
  assertSorted(value.resources.projects, ["projectId"]); assertSorted(value.resources.environments, ["projectId", "name"]); assertSorted(value.resources.flags, ["flagId"]); assertSorted(value.resources.flagRevisions, ["flagId", "environment", "revision"]); assertSorted(value.resources.flagSnapshots, ["projectId", "flagId", "environment", "revision"]); if (final) { assertSorted(value.resources.progressiveRollouts, ["rolloutId"]); assertSorted(value.resources.evaluationOutcomes, ["rolloutId", "stepIndex", "outcomeId"]); } assertWork(value.work, { final }); value.events.forEach(assertDomainEvent); assertSorted(value.work, ["workId"]); assertSorted(value.events, ["aggregateId", "sequence", "eventId"]); assertEventSequence(value.events); const secret = (member) => member && typeof member === "object" && Object.entries(member).some(([key, nested]) => key.endsWith("Token") || secret(nested)); assert.equal(secret(value), false, "snapshot recursively omits *Token fields"); return true;
}

export function expectedEvaluation(snapshot, body, { final = true, rolloutId = null, stepIndex = null } = {}) { const result = evaluateSnapshot(snapshot, { subjectKey: body.context.subjectKey, context: body.context }); return { projectId: snapshot.projectId, flagId: snapshot.flagId, flagKey: snapshot.flagKey, environment: snapshot.environment, subjectKey: body.context.subjectKey, variantKey: result.variant.key, value: result.variant.value, revisionId: snapshot.revisionId, snapshotDigest: snapshotDigest(snapshot), reason: result.reason, matchedRuleId: result.matchedRuleId, ...(final ? { rolloutId, stepIndex } : {}) }; }
export function snapshotFromRevision(revision, flag, projectId, environment) { return { snapshotVersion: 1, projectId, flagId: flag.flagId, flagKey: flag.key, environment: revision.environment, revisionId: revision.revisionId, revision: revision.revision, flagType: revision.flagType, defaultVariant: revision.defaultVariant, variants: structuredClone(revision.variants), rules: structuredClone(revision.rules), contextAttributes: [...environment.contextAttributes], contextSchemaRevision: environment.schemaRevision }; }

export function assertOpenApiDocument(document, { final = true } = {}) {
  assert.ok(document && typeof document === "object"); assert.match(document.openapi, /^3\.1(?:\.|$)/u); assert.equal(document.jsonSchemaDialect ?? "https://json-schema.org/draft/2020-12/schema", "https://json-schema.org/draft/2020-12/schema"); const paths = ["/healthz", "/openapi.json", "/api/v1/flags", "/api/v1/flags/{flagId}/revisions", "/api/v1/flag-revisions", "/api/v1/flag-revisions/{revisionId}", "/api/v1/flag-revisions/{revisionId}/activate", "/api/v1/evaluations", "/api/v1/flags/{flagId}/revisions/{revision}/diff", "/api/v1/domain-events", "/api/v1/verification-snapshot", ...(final ? ["/api/v1/flag-revisions/{revisionId}/progressive-activate", "/api/v1/progressive-rollouts/{rolloutId}/outcome-batches", "/api/v1/progressive-rollouts/{rolloutId}"] : [])]; for (const path of paths) assert.ok(document.paths?.[path], `OpenAPI path ${path}`); const statuses = { "post /api/v1/flags": ["201", "400", "409", "415"], "post /api/v1/flags/{flagId}/revisions": ["202", "400", "404", "409", "415"], "post /api/v1/flag-revisions/{revisionId}/activate": ["200", "400", "404", "409", "415"], "post /api/v1/evaluations": ["200", "400", "404", "409", "415"], "get /api/v1/flag-revisions": ["200", "400"], "get /api/v1/flag-revisions/{revisionId}": ["200", "400", "404"], "get /api/v1/flags/{flagId}/revisions": ["200", "400", "404"], "get /api/v1/flags/{flagId}/revisions/{revision}/diff": ["200", "400", "404"], "get /api/v1/domain-events": ["200", "400"], "get /api/v1/verification-snapshot": ["200", "401"], ...(final ? { "post /api/v1/flag-revisions/{revisionId}/progressive-activate": ["202", "400", "404", "409", "415"], "post /api/v1/progressive-rollouts/{rolloutId}/outcome-batches": ["200", "400", "404", "409", "415"], "get /api/v1/progressive-rollouts/{rolloutId}": ["200", "400", "404"] } : {}) }; for (const [key, expected] of Object.entries(statuses)) { const [method, path] = key.split(" "); for (const status of expected) assert.ok(document.paths[path]?.[method]?.responses?.[status] ?? document.paths[path]?.[method]?.responses?.default, `${key} ${status}`); }
  const signatures = [["flagId", "projectId", "key", "flagType", "createdAt"], ["ruleId", "clauses", "variantKey"], ["revisionId", "flagId", "environment", "revision", "flagType", "defaultVariant", "variants", "rules", "state", "snapshotDigest", "createdAt", "activatedAt", "sequence"], ["snapshotVersion", "projectId", "flagId", "flagKey", "environment", "revisionId", "revision", "flagType", "defaultVariant", "variants", "rules", "contextAttributes", "contextSchemaRevision"], ["projectId", "flagId", "flagKey", "environment", "subjectKey", "variantKey", "value", "revisionId", "snapshotDigest", "reason", "matchedRuleId", ...(final ? ["rolloutId", "stepIndex"] : [])], ["flagId", "environment", "fromRevision", "toRevision", "defaultVariantChanged", "addedVariantKeys", "removedVariantKeys", "changedVariantKeys", "variantOrderChanged", "addedRuleIds", "removedRuleIds", "changedRuleIds", "ruleOrderChanged"], ...(final ? [["rolloutId", "flagId", "environment", "priorRevisionId", "candidateRevisionId", "state", "currentStepIndex", "steps", "createdAt", "terminalAt"], ["outcomeId", "rolloutId", "stepIndex", "subjectKey", "snapshotDigest", "outcome", "reportedAt"]] : [])]; const schemas = collectSchemas(document); for (const signature of signatures) { const schema = schemas.find((candidate) => candidate?.properties && JSON.stringify(Object.keys(candidate.properties).sort()) === JSON.stringify([...signature].sort())); assert.ok(schema, `OpenAPI exact schema ${signature.join(",")}`); assert.deepEqual([...(schema.required ?? [])].sort(), [...signature].sort()); assert.equal(schema.additionalProperties, false); } return true;
}

function collectSchemas(document) { const values = [], seen = new Set(); (function visit(member) { if (!member || typeof member !== "object" || seen.has(member)) return; seen.add(member); const resolved = dereference(document, member); if (resolved !== member) { visit(resolved); return; } if (member.properties || member.type || member.oneOf || member.anyOf || member.allOf) values.push(member); Object.values(member).forEach(visit); })(document); return values; }
function dereference(document, value) { if (!value?.$ref) return value; return value.$ref.replace(/^#\//u, "").split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")).reduce((member, part) => member?.[part], document); }
export function validateOpenApiResponse(document, path, method, response) { const operation = document.paths?.[path]?.[method.toLowerCase()]; assert.ok(operation, `${method} ${path}`); const declared = operation.responses?.[String(response.status)] ?? operation.responses?.default; assert.ok(declared, `${method} ${path} ${response.status}`); const content = dereference(document, declared).content; if (!content) { assert.equal(response.text, ""); return true; } const media = content["application/json"] ?? content[Object.keys(content)[0]]; assert.ok(media?.schema); validateSchema(document, media.schema, response.json, `${method} ${path}`); return true; }
function validateSchema(document, schema, value, label) { schema = dereference(document, schema); assert.ok(schema); if (schema.oneOf || schema.anyOf) { const alternatives = schema.oneOf ?? schema.anyOf; assert.ok(alternatives.some((candidate) => { try { validateSchema(document, candidate, value, label); return true; } catch { return false; } }), `${label} union`); return; } if (value === null) { assert.ok(schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) || schema.nullable, `${label} nullable`); return; } const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type; if (type === "object" || schema.properties) { assert.ok(value && typeof value === "object" && !Array.isArray(value)); for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${label}.${key}`); if (schema.additionalProperties === false) assert.ok(Object.keys(value).every((key) => Object.hasOwn(schema.properties ?? {}, key))); for (const [key, member] of Object.entries(value)) if (schema.properties?.[key]) validateSchema(document, schema.properties[key], member, `${label}.${key}`); } else if (type === "array") { assert.ok(Array.isArray(value)); value.forEach((member, index) => validateSchema(document, schema.items, member, `${label}[${index}]`)); } else if (type === "integer") assertSafeInteger(value, label); else if (type === "string") { assert.equal(typeof value, "string"); if (schema.enum) assert.ok(schema.enum.includes(value)); if (schema.format === "uuid") assertUuid(value); if (schema.format === "date-time") assertTimestamp(value); } else if (type === "boolean") assert.equal(typeof value, "boolean"); else if (type === "number") assert.ok(typeof value === "number" && Number.isFinite(value)); }
