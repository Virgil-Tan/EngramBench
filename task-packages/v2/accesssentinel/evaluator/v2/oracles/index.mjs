import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function assertAccessEvents(snapshot, requestId, receiverEntries = []) {
  const specs = {
    ACCESS_REQUESTED: ['accessRequests', 'accessRequestId', 'accessRequestId,sessionId,policyRevisionId,riskModelRevisionId,deviceTrustRevisionId'],
    RISK_DECIDED: ['riskDecisions', 'riskDecisionId', 'accessRequestId,riskDecisionId,score,level,reasons,policyEffect,inputDigest'],
    ACCESS_REVIEWED: ['accessReviews', 'accessReviewId', 'accessRequestId,accessReviewId,reviewerId,decision,comment'],
    ACCESS_GRANTED: ['accessGrants', 'grantId', 'accessRequestId,grantId,policyRevisionId,riskDecisionId,expiresAt'],
    ACCESS_REVOKED: ['accessGrants', 'grantId', 'accessRequestId,grantId,state,revocationEpoch'],
    ACCESS_EXPIRED: ['accessGrants', 'grantId', 'accessRequestId,grantId,state,revocationEpoch'],
  };
  const events = snapshot.events.filter(event => event.aggregateId === requestId);
  for (const type of ['ACCESS_REQUESTED', 'RISK_DECIDED', 'ACCESS_GRANTED', 'ACCESS_REVOKED']) assert.equal(events.filter(e => e.type === type).length, 1, `${type} exactly once`);
  for (const event of events) {
    const spec = specs[event.type]; if (!spec) continue;
    const [collection, id, fields] = spec;
    const row = snapshot.resources[collection].find(r => r[id] === event.payload?.[id]);
    assert.ok(row, 'Event binds a committed public resource');
    assert.equal(event.aggregateType, 'AccessRequest'); assert.equal(event.tenantId, row.tenantId);
    assert.equal(event.payload.accessRequestId, requestId);
    const expected = Object.fromEntries(fields.split(',').map(key => [key, row[key]]));
    if (event.type === 'ACCESS_REVOKED') expected.state = 'REVOKED';
    if (event.type === 'ACCESS_EXPIRED') expected.state = 'EXPIRED';
    assert.deepEqual(event.payload, expected, `${event.type} exact immutable payload`);
  }
  for (const entry of receiverEntries) {
    const body = JSON.parse(Buffer.from(entry.raw).toString('utf8'));
    const event = snapshot.events.find(e => e.eventId === body.eventId);
    assert.ok(event, 'webhook event committed');
    assert.equal(Buffer.from(entry.raw).toString('utf8'), canonicalJson(event), 'immutable canonical Event bytes');
  }
}

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL('../../../../../src/task-evaluator-v2/', import.meta.url).href;
const { assertUtcTimestamp } = await import(new URL('public-contract.mjs', sharedRoot));

export function utf8Compare(left, right) { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
export function canonicalJson(value) { if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value); if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("RFC 8785 forbids non-finite numbers"); return JSON.stringify(value); } if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (typeof value !== "object") throw new TypeError(`unsupported canonical JSON value ${typeof value}`); return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`; }
export function sha256Hex(value) { return createHash("sha256").update(value).digest("hex"); }
export function exactKeys(value, keys, label = "object") { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} exact keys`); }
export function assertUuid(value, label = "uuid") { assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u, `${label} canonical UUID`); }
export function assertTimestamp(value, label = "timestamp") { return assertUtcTimestamp(value, label); }
export function assertPublicError(response, status, code) { assert.equal(response.status, status); exactKeys(response.json, ["error"], "error envelope"); exactKeys(response.json.error, ["code", "message", "details"], "error"); assert.equal(response.json.error.code, code); assert.equal(typeof response.json.error.message, "string"); assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details)); return true; }

function globMatch(pattern, value) { const expression = `^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`; return new RegExp(expression, "u").test(value); }
export function policyEffect(rules, { action, resource, region, assurance }) { let allowed = false; for (const rule of rules) { const applies = rule.actions.includes(action) && globMatch(rule.resourcePattern, resource) && assurance >= rule.minAssurance && rule.regions.includes(region); if (!applies) continue; if (rule.effect === "DENY") return "DENY"; if (rule.effect === "ALLOW") allowed = true; } return allowed ? "ALLOW" : "DENY"; }
export function riskOracle({ model, policy, sessionAgeSeconds, locationAgeSeconds, requestRegion, locationRegion, impossibleTravel = false }) { const signals = []; if (sessionAgeSeconds > 1_800) signals.push("oldSession"); if (locationAgeSeconds > model.maxLocationAgeSeconds) signals.push("staleLocation"); if (requestRegion !== locationRegion) signals.push("regionMismatch"); if (impossibleTravel) signals.push("impossibleTravel"); signals.sort(utf8Compare); let score = signals.reduce((sum, signal) => sum + model.weights[signal], 0); let level = score <= model.lowMax ? "LOW" : score <= model.reviewMax ? "REVIEW" : "HIGH"; const reasons = [...signals]; if (policy === "DENY") { level = "HIGH"; if (!reasons.includes("POLICY_DENY")) reasons.push("POLICY_DENY"); reasons.sort(utf8Compare); } return { score, level, reasons, policyEffect: policy }; }
export function riskInputDigest(input) { return sha256Hex(canonicalJson(input)); }

function haversineKph(left, right) { const radians = (degrees) => degrees * Math.PI / 180; const dLat = radians(right.latitude - left.latitude), dLon = radians(right.longitude - left.longitude); const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) * Math.sin(dLon / 2) ** 2; const kilometers = 6_371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); const hours = (Date.parse(right.observedAt) - Date.parse(left.observedAt)) / 3_600_000; return hours > 0 ? kilometers / hours : Number.POSITIVE_INFINITY; }
export function locationOracle(observations, { maxTravelKph = 900, lateWindowMs = 600_000 } = {}) {
  const unique = new Map();
  for (const item of observations) {
    const key = `${item.deviceId}\0${item.deviceSequence}`;
    const prior = unique.get(key);
    if (prior && canonicalJson(prior) !== canonicalJson(item)) throw new Error("location sequence conflict");
    if (!prior) unique.set(key, item);
  }
  const arrivalOrder = [...unique.values()].sort((left, right) => (
    Date.parse(left.acceptedAt) - Date.parse(right.acceptedAt)
      || left.deviceSequence - right.deviceSequence
      || utf8Compare(left.observationId, right.observationId)
  ));
  const accepted = [];
  const tooLate = [];
  let watermark = Number.NEGATIVE_INFINITY;
  for (const item of arrivalOrder) {
    const time = Date.parse(item.observedAt);
    if (watermark !== Number.NEGATIVE_INFINITY && time < watermark - lateWindowMs) tooLate.push(item);
    else {
      accepted.push(item);
      watermark = Math.max(watermark, time);
    }
  }
  accepted.sort((left, right) => (
    Date.parse(left.observedAt) - Date.parse(right.observedAt)
      || left.deviceSequence - right.deviceSequence
      || utf8Compare(left.observationId, right.observationId)
  ));
  const latest = accepted.at(-1);
  const flags = new Set();
  for (let index = 1; index < accepted.length; index += 1) {
    if (haversineKph(accepted[index - 1], accepted[index]) > maxTravelKph) flags.add("impossibleTravel");
  }
  return {
    ordered: arrivalOrder,
    accepted,
    tooLate,
    projection: latest ? {
      lastSequence: latest.deviceSequence,
      watermarkObservedAt: new Date(watermark).toISOString(),
      longitude: latest.longitude,
      latitude: latest.latitude,
      region: latest.region,
      riskFlags: [...flags].sort(utf8Compare),
    } : null,
  };
}

export function auditDigest(entry) { const { digest: _digest, ...body } = entry; return sha256Hex(`${entry.previousDigest ?? ""}${canonicalJson(body)}`); }
export function assertAuditChain(entries) {
  const byTenant = new Map();
  for (const item of entries) { const list = byTenant.get(item.tenantId) ?? []; list.push(item); byTenant.set(item.tenantId, list); }
  for (const list of byTenant.values()) {
    list.sort((left, right) => left.sequence - right.sequence);
    for (let index = 0; index < list.length; index += 1) {
      assert.equal(list[index].sequence, index + 1);
      // The public contract requires a hex digest but does not prescribe a genesis anchor.
      assert.match(list[index].previousDigest, /^[0-9a-f]{64}$/u);
      if (index > 0) assert.equal(list[index].previousDigest, list[index - 1].digest);
      assert.equal(list[index].digest, auditDigest(list[index]));
    }
  }
  return true;
}
export function assertEventSequence(events) { const identities = new Set(); const byAggregate = new Map(); for (const event of events) { assert.ok(!identities.has(event.eventId), `duplicate Event ${event.eventId}`); identities.add(event.eventId); const list = byAggregate.get(event.aggregateId) ?? []; list.push(event); byAggregate.set(event.aggregateId, list); } for (const list of byAggregate.values()) { list.sort((left, right) => left.sequence - right.sequence || utf8Compare(left.eventId, right.eventId)); for (let index = 1; index < list.length; index += 1) assert.equal(list[index].sequence, list[index - 1].sequence + 1); } return true; }
export function assertSecretFree(value) { const forbidden = /^(?:refreshToken|deviceNonce|privateKey|credential|authorization|adminToken)$/iu; (function visit(member) { if (!member || typeof member !== "object") return; if (Array.isArray(member)) { member.forEach(visit); return; } for (const [key, child] of Object.entries(member)) { assert.doesNotMatch(key, forbidden, `secret field ${key}`); visit(child); } })(value); return true; }

export function grantAuthorityOracle({ grant, now, request, current }) { if (grant.state !== "ACTIVE") return { active: false, reason: grant.state }; if (Date.parse(now) < Date.parse(grant.notBefore) || Date.parse(now) >= Date.parse(grant.expiresAt)) return { active: false, reason: "EXPIRED" }; const fences = [[request.policyRevisionId, grant.policyRevisionId], [request.sessionId, grant.sessionId], [request.principalId, grant.principalId], [request.deviceId, grant.deviceId], [request.region, grant.region]]; if (fences.some(([left, right]) => left !== right)) return { active: false, reason: "FROZEN_AUTHORITY_MISMATCH" }; if (current.tenantEpoch !== request.tenantRevocationEpoch || current.principalEpoch !== request.principalRevocationEpoch || current.sessionGeneration !== request.sessionGeneration || current.trustRevisionId !== request.deviceTrustRevisionId || current.regionQuarantined) return { active: false, reason: "AUTHORITY_STALE" }; return { active: true, reason: "ACTIVE" }; }
export function breakGlassOracle({ session, approvals, requesterId, now, check, current }) { const independent = new Set(approvals.filter((entry) => entry.decision === "APPROVE" && entry.approverId !== requesterId).map(({ approverId }) => approverId)); if (session.requiredApprovals !== 2 || independent.size < 2 || session.state !== "ACTIVE") return { authorized: false, reason: "NOT_ACTIVE" }; if (Date.parse(now) < Date.parse(session.notBefore) || Date.parse(now) >= Date.parse(session.expiresAt)) return { authorized: false, reason: "EXPIRED" }; if (check.region !== session.region || !session.actions.includes(check.action) || !session.resourcePatterns.some((pattern) => globMatch(pattern, check.resource))) return { authorized: false, reason: "SCOPE_MISMATCH" }; if (!current.tenant || !current.principal || !current.device || !current.session || !current.trust) return { authorized: false, reason: "FENCE_REVOKED" }; return { authorized: true, reason: "AUTHORIZED" }; }

const V1_RESOURCE_KEYS = ["accessGrants", "accessRequests", "accessReviews", "auditEntries", "deviceLocations", "deviceTrustRevisions", "devices", "locationObservations", "policyBundles", "policyRevisions", "principals", "revocations", "riskDecisions", "riskModelRevisions", "sessions", "tenants"];
const FINAL_RESOURCE_KEYS = ["breakGlassApprovals", "breakGlassSessions", "regionalQuarantines", "retrospectiveReviews"];
export function assertSnapshot(snapshot, { final = true } = {}) { exactKeys(snapshot, ["schemaVersion", "asOf", "resources", "work", "events", "metrics"], "snapshot"); assert.equal(snapshot.schemaVersion, 1); assertTimestamp(snapshot.asOf); const keys = Object.keys(snapshot.resources).sort(); const required = final ? [...V1_RESOURCE_KEYS, ...FINAL_RESOURCE_KEYS].sort() : [...V1_RESOURCE_KEYS].sort(); assert.deepEqual(keys, required, "snapshot published resource collections"); for (const key of keys) assert.ok(Array.isArray(snapshot.resources[key]), `${key} array`); assert.ok(Array.isArray(snapshot.work)); assert.ok(Array.isArray(snapshot.events)); assertAuditChain(snapshot.resources.auditEntries); assertEventSequence(snapshot.events); assertSecretFree(snapshot); return true; }

export function assertOpenApi(document, { final = true } = {}) { assert.match(document.openapi, /^3\.1(?:\.|$)/u); const v1 = ["/api/v1/tenants", "/api/v1/principals", "/api/v1/devices", "/api/v1/access-requests/{accessRequestId}", "/api/v1/sessions", "/api/v1/sessions/{sessionId}/refresh", "/api/v1/sessions/{sessionId}/revoke", "/api/v1/devices/{deviceId}/trust-revisions", "/api/v1/devices/{deviceId}/revoke", "/api/v1/principals/{principalId}/revoke", "/api/v1/tenants/{tenantId}/revoke", "/api/v1/policy-bundles", "/api/v1/policy-bundles/{policyBundleId}/publish", "/api/v1/policy-bundles/{policyBundleId}/rollback", "/api/v1/location-observations", "/api/v1/access-requests", "/api/v1/access-requests:batch", "/api/v1/access-requests/{accessRequestId}/reviews", "/api/v1/access-requests/{accessRequestId}/grant", "/api/v1/grants/{grantId}/check", "/api/v1/grants/{grantId}/revoke", "/api/v1/verification-snapshot"]; const manager = ["/api/v1/break-glass-sessions", "/api/v1/break-glass-sessions/{breakGlassSessionId}/approvals", "/api/v1/break-glass-sessions/{breakGlassSessionId}/activate", "/api/v1/break-glass-sessions/{breakGlassSessionId}/close", "/api/v1/break-glass-sessions/{breakGlassSessionId}/check", "/api/v1/regions/{region}/quarantine", "/api/v1/regions/{region}/release", "/api/v1/break-glass-sessions/{breakGlassSessionId}/retrospective-reviews"]; for (const path of [...v1, ...(final ? manager : [])]) assert.ok(document.paths?.[path], `OpenAPI path ${path}`); return true; }
function dereference(document, value) { if (!value?.$ref) return value; return value.$ref.replace(/^#\//u, "").split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")).reduce((member, part) => member?.[part], document); }
export function validateOpenApiResponse(document, path, method, response) { const operation = document.paths?.[path]?.[method.toLowerCase()]; assert.ok(operation, `${method} ${path}`); const declared = operation.responses?.[String(response.status)] ?? operation.responses?.default; assert.ok(declared, `${method} ${path} ${response.status}`); const content = dereference(document, declared).content; if (!content) { assert.equal(response.text, ""); return true; } const media = content["application/json"] ?? content[Object.keys(content)[0]]; assert.ok(media?.schema); validateSchema(document, media.schema, response.json, `${method} ${path}`); return true; }
function validateSchema(document, schema, value, label) { schema = dereference(document, schema); if (schema.oneOf || schema.anyOf) { const choices = schema.oneOf ?? schema.anyOf; assert.ok(choices.some((candidate) => { try { validateSchema(document, candidate, value, label); return true; } catch { return false; } }), `${label} union`); return; } if (value === null) { assert.ok(schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) || schema.nullable, `${label} nullable`); return; } const type = Array.isArray(schema.type) ? schema.type.find((item) => item !== "null") : schema.type; if (type === "object" || schema.properties) { assert.ok(value && typeof value === "object" && !Array.isArray(value)); for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${label}.${key}`); if (schema.additionalProperties === false) assert.ok(Object.keys(value).every((key) => Object.hasOwn(schema.properties ?? {}, key)), `${label} closed`); for (const [key, child] of Object.entries(value)) if (schema.properties?.[key]) validateSchema(document, schema.properties[key], child, `${label}.${key}`); } else if (type === "array") { assert.ok(Array.isArray(value)); value.forEach((child, index) => validateSchema(document, schema.items, child, `${label}[${index}]`)); } else if (type === "integer") assert.ok(Number.isSafeInteger(value), `${label} integer`); else if (type === "number") assert.ok(typeof value === "number" && Number.isFinite(value)); else if (type === "string") { assert.equal(typeof value, "string"); if (schema.enum) assert.ok(schema.enum.includes(value)); } else if (type === "boolean") assert.equal(typeof value, "boolean"); }
export function percentile(values, ratio) { assert.ok(values.length > 0); const ordered = [...values].sort((left, right) => left - right); return ordered[Math.min(ordered.length - 1, Math.ceil(ratio * ordered.length) - 1)]; }
