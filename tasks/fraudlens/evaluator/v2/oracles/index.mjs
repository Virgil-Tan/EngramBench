import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function fieldValue(event, field) {
  if (field.startsWith("attributes.")) return event.attributes?.[field.slice("attributes.".length)];
  if (["tenantId", "externalEventId", "subjectId", "amountMinor", "currency", "occurredAt"].includes(field)) return event[field];
  return undefined;
}

function matches(actual, operator, expected) {
  if (operator === "EQ") return actual === expected;
  if (operator === "IN") return Array.isArray(actual) ? actual.includes(expected) : Array.isArray(expected) && expected.includes(actual);
  if (operator === "GTE") return typeof actual === typeof expected && actual >= expected;
  if (operator === "LTE") return typeof actual === typeof expected && actual <= expected;
  return false;
}

export function evaluateRules(event, version) {
  const ordered = [...version.rules].sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
  const ruleHits = [];
  let sum = 0;
  for (const rule of ordered) {
    if (!matches(fieldValue(event, rule.field), rule.operator, rule.value)) continue;
    const next = sum + rule.score;
    if (!Number.isSafeInteger(next)) {
      const error = new RangeError("SCORE_OVERFLOW");
      error.code = "SCORE_OVERFLOW";
      throw error;
    }
    sum = next;
    ruleHits.push({ ruleId: rule.ruleId, priority: rule.priority, score: rule.score, reasonCode: rule.reasonCode });
  }
  const score = Math.max(0, Math.min(1_000, sum));
  const recommendation = score >= version.blockThreshold ? "BLOCK" : score >= version.reviewThreshold ? "REVIEW" : "APPROVE";
  return { score, recommendation, ruleHits };
}

export function correctionDigest(event, version) {
  return sha256(evaluateRules(event, version).ruleHits);
}

export function auditDigest(entry) {
  return sha256({
    tenantId: entry.tenantId,
    sequence: entry.sequence,
    eventType: entry.eventType,
    subjectRef: entry.subjectRef,
    payloadDigest: entry.payloadDigest,
    priorDigest: entry.priorDigest,
    createdAt: entry.createdAt,
  });
}

export function assertAuditChains(entries) {
  const tenants = new Map();
  for (const entry of entries) {
    const values = tenants.get(entry.tenantId) ?? [];
    values.push(entry);
    tenants.set(entry.tenantId, values);
  }
  for (const values of tenants.values()) {
    values.sort((left, right) => left.sequence - right.sequence);
    for (let index = 0; index < values.length; index += 1) {
      assert.equal(values[index].sequence, index + 1, "tenant audit sequence must be contiguous");
      assert.equal(values[index].priorDigest, index === 0 ? null : values[index - 1].digest, "tenant audit priorDigest must link");
      assert.equal(values[index].digest, auditDigest(values[index]), "tenant audit digest must match the public canonical fields");
    }
  }
}

export function assertNoSecrets(value, secrets = []) {
  const serialized = canonicalJson(value).toLowerCase();
  for (const secret of secrets.filter(Boolean)) assert.equal(serialized.includes(String(secret).toLowerCase()), false, "public data contains a secret");
  assert.equal(/\/submission|\/private|database_url|admin_token|barrier_token/iu.test(serialized), false, "public data exposes private paths or secret names");
}

export function exactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} must use the closed public shape`);
}

export function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function stableResourceBytes(snapshot, selection) {
  return canonicalJson(Object.fromEntries(Object.entries(selection).map(([key, predicate]) => [
    key,
    (snapshot.resources?.[key] ?? []).filter(predicate),
  ])));
}
