import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
}

export function exactKeys(value, keys, label = "object") {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
  return value;
}

export function assertEvidenceHistory(items, contentItemId) {
  const selected = items.filter((item) => item.contentItemId === contentItemId).sort((left, right) => left.version - right.version);
  assert.deepEqual(selected.map(({ version }) => version), Array.from({ length: selected.length }, (_, index) => index + 1), "evidence versions must be contiguous");
  assert.equal(new Set(selected.map(({ evidenceVersionId }) => evidenceVersionId)).size, selected.length, "evidence identities must be unique");
  assert.equal(new Set(selected.map(({ digest }) => digest)).size, selected.length, "fixture evidence digests must be unique");
  return selected;
}

export function assertOneDecisionPerStage(snapshot) {
  const counts = new Map();
  for (const decision of snapshot.resources.moderationDecisions) counts.set(decision.stageId, (counts.get(decision.stageId) ?? 0) + 1);
  assert.ok([...counts.values()].every((count) => count === 1), "a stage has duplicate Decisions");
}

export function assertAppealLineage(snapshot) {
  const decisions = new Map(snapshot.resources.moderationDecisions.map((item) => [item.decisionId, item]));
  const cases = new Map(snapshot.resources.moderationCases.map((item) => [item.caseId, item]));
  for (const appeal of snapshot.resources.appeals) {
    assert.ok(cases.has(appeal.caseId), "Appeal references missing Case");
    assert.ok(decisions.has(appeal.challengedDecisionId), "Appeal references missing Decision");
    if (appeal.appealDecisionId !== null) assert.ok(decisions.has(appeal.appealDecisionId), "Appeal result references missing Decision");
  }
}

export function assertReconsiderationConservation(run, reconsiderations, snapshot) {
  const selected = reconsiderations.filter((item) => item.policyRecallRunId === run.policyRecallRunId);
  assert.equal(new Set(selected.map(({ caseId }) => caseId)).size, selected.length, "duplicate Reconsideration member");
  assert.equal(run.completedCount, run.changedCount + run.noChangeCount, "Recall counters do not conserve");
  assert.ok(run.completedCount <= run.totalCount, "Recall completed exceeds total");
  assert.equal(selected.filter(({ outcome }) => outcome === "CHANGED").length, run.changedCount, "changed count mismatch");
  assert.equal(selected.filter(({ outcome }) => outcome === "NO_CHANGE").length, run.noChangeCount, "no-change count mismatch");
  for (const item of selected) {
    if (item.outcome === "CHANGED") {
      assert.ok(item.reconsiderationStageId, "changed result lacks Stage");
      assert.equal(snapshot.resources.reviewStages.filter(({ stageId, level }) => stageId === item.reconsiderationStageId && level === "RECONSIDERATION").length, 1, "changed result must own one Reconsideration Stage");
    } else {
      assert.equal(item.reconsiderationStageId, null, "no-change result created a Stage");
    }
  }
  return selected;
}

export function assertAuditChain(entries) {
  const byTenant = Map.groupBy(entries, ({ tenantId }) => tenantId);
  for (const tenantEntries of byTenant.values()) {
    const ordered = [...tenantEntries].sort((left, right) => left.sequence - right.sequence);
    assert.deepEqual(ordered.map(({ sequence }) => sequence), Array.from({ length: ordered.length }, (_, index) => index + 1), "audit sequence gap");
    let priorDigest = null;
    for (const entry of ordered) {
      assert.equal(entry.priorDigest, priorDigest, "audit prior digest mismatch");
      const publicFields = { tenantId: entry.tenantId, sequence: entry.sequence, eventType: entry.eventType, subjectRef: entry.subjectRef, payloadDigest: entry.payloadDigest, priorDigest: entry.priorDigest, createdAt: entry.createdAt };
      assert.equal(entry.digest, sha256(canonical(publicFields)), "audit digest mismatch");
      priorDigest = entry.digest;
    }
  }
}

export function percentile(values, fraction) {
  assert.ok(values.length > 0, "percentile requires observations");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function stablePublicSnapshot(snapshot) {
  const clone = structuredClone(snapshot);
  delete clone.asOf;
  return canonical(clone);
}
