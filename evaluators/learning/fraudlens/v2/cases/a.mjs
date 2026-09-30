import assert from "node:assert/strict";
import { canonicalJson, correctionDigest } from "../oracles/index.mjs";
import {
  acceptRisk,
  activateVersion,
  activeVersion,
  assertAssessment,
  assertFactsPreserved,
  assertRemediationDetail,
  createRemediation,
  createVersion,
  defineCase,
  findField,
  getRemediation,
  guardedCase,
  prepare,
  resources,
  semanticError,
  setupRollback,
  successful,
  waitAssessment,
  waitRemediation,
  waitReviewCase,
} from "./helpers.mjs";

const A01 = defineCase("A-01", async (ctx) => {
  const { api, workers } = await prepare(ctx, { seedVersion: "fl-a01", workerCount: 1 });
  const rules = ctx.fixtures.workedRules();
  const created = await createVersion(ctx, api.baseUrl, "worked", { rules, reviewThreshold: 700, blockThreshold: 900 });
  await activateVersion(ctx, api.baseUrl, created.ruleVersionId, ctx.fixtures.ids.baseVersionId, "worked");
  const accepted = await acceptRisk(ctx, api.baseUrl, 1, { attributes: { a: 1, b: 1, c: 1 } });
  const completed = await waitAssessment(ctx, api.baseUrl, accepted.payload.externalEventId, { processes: workers });
  const version = resources(completed.snapshot).ruleVersions.find((item) => item.ruleVersionId === created.ruleVersionId);
  assert.equal(activeVersion(completed.snapshot, ctx.fixtures.ids.ruleSetId).length, 1, "exactly one ACTIVE version");
  assertAssessment(completed.snapshot, completed.assessment, accepted.payload, version);
  assert.equal(completed.assessment.score, 800, "FL-W1 clamps only the final sum");
  assert.equal(completed.assessment.recommendation, "REVIEW", "FL-W1 threshold result");
  assert.deepEqual(resources(completed.snapshot).ruleHits.filter((item) => item.assessmentId === completed.assessment.assessmentId).map((item) => item.ruleId), ["a", "b", "c"], "FL-W1 hit order");

  const beforeInvalid = await ctx.snapshot(api.baseUrl);
  const invalid = await ctx.mutate(api.baseUrl, `/api/v1/rule-sets/${ctx.fixtures.ids.ruleSetId}/versions`, ctx.key("invalid-thresholds"), {
    rules: [ctx.fixtures.rule()], reviewThreshold: 901, blockThreshold: 100,
  }, { admin: true });
  semanticError(invalid, 400, "RULE_INVALID");
  const overflow = await ctx.mutate(api.baseUrl, `/api/v1/rule-sets/${ctx.fixtures.ids.ruleSetId}/versions`, ctx.key("overflow-rules"), {
    rules: [
      ctx.fixtures.rule({ ruleId: "overflow-a", score: Number.MAX_SAFE_INTEGER }),
      ctx.fixtures.rule({ ruleId: "overflow-b", score: Number.MAX_SAFE_INTEGER }),
    ],
    reviewThreshold: 0,
    blockThreshold: 1_000,
  }, { admin: true });
  assert.equal(overflow.status, 400, "overflow-capable rules rejected atomically");
  assert.ok(["RULE_INVALID", "SCORE_OVERFLOW"].includes(overflow.json?.error?.code), "published overflow error");
  const immutable = await ctx.mutate(api.baseUrl, `/api/v1/rule-sets/${ctx.fixtures.ids.ruleSetId}/versions`, ctx.key("rewrite-active"), {
    ruleVersionId: created.ruleVersionId,
    rules: [ctx.fixtures.rule({ score: 1 })],
    reviewThreshold: 0,
    blockThreshold: 1,
  }, { admin: true, contractExpectation: "invalid" });
  assert.ok((immutable.status === 409 && immutable.json?.error?.code === "RULE_VERSION_IMMUTABLE") || (immutable.status === 400 && immutable.json?.error?.code === "INVALID_REQUEST"), "activated version cannot be rewritten");
  const afterInvalid = await ctx.snapshot(api.baseUrl);
  assert.equal(afterInvalid.resources.ruleVersions.length, beforeInvalid.resources.ruleVersions.length, "invalid mutations create no version");
  assert.equal(afterInvalid.work.length, beforeInvalid.work.length, "invalid mutations create no Work");
  ctx.mark("rules.reference-model.closed", { assessmentId: completed.assessment.assessmentId, ruleVersionId: created.ruleVersionId });
  return ctx.pass();
});

const A02 = guardedCase("A-02", ["IDENTITY_ATOMICITY", "VERSION_AUTHORITY", "TENANT_ISOLATION"], async (ctx) => {
  const { apis, workers } = await prepare(ctx, { seedVersion: "fl-a02", apiCount: 2, workerCount: 2 });
  const first = await acceptRisk(ctx, apis[0].baseUrl, 2, { attributes: { velocity: 9, country: "US" } }, { key: ctx.key("a02:first") });
  const replay = await ctx.mutate(apis[1].baseUrl, "/api/v1/risk-events", ctx.key("a02:first"), first.payload);
  successful(replay, "cross-API exact replay");
  assert.equal(canonicalJson(replay.json), canonicalJson(first.response.json), "idempotent response body is exact");
  const externalReplay = await ctx.mutate(apis[1].baseUrl, "/api/v1/risk-events", ctx.key("a02:external-replay"), first.payload);
  successful(externalReplay, "external identity replay");
  assert.equal(findField(externalReplay.json, "riskEventId"), findField(first.response.json, "riskEventId"), "external identity RiskEvent stable");
  const conflict = await ctx.mutate(apis[0].baseUrl, "/api/v1/risk-events", ctx.key("a02:external-conflict"), { ...first.payload, amountMinor: first.payload.amountMinor + 1 });
  semanticError(conflict, 409, "EXTERNAL_EVENT_CONFLICT");
  const otherPayload = { ...first.payload, tenantId: ctx.fixtures.ids.otherTenantId };
  const other = successful(await ctx.mutate(apis[1].baseUrl, "/api/v1/risk-events", ctx.key("a02:other-tenant"), otherPayload), "other tenant external identity");
  assert.notEqual(findField(other.json, "riskEventId"), findField(first.response.json, "riskEventId"), "cross-tenant external identity is independent");
  const before = await waitAssessment(ctx, apis[0].baseUrl, first.payload.externalEventId, { processes: workers });
  assert.equal(before.assessment.ruleVersionId, ctx.fixtures.ids.baseVersionId, "acceptance freezes current version");
  const newer = await createVersion(ctx, apis[0].baseUrl, "a02-new", { rules: [ctx.fixtures.rule({ score: 900 })] });
  await activateVersion(ctx, apis[1].baseUrl, newer.ruleVersionId, ctx.fixtures.ids.baseVersionId, "a02-new");
  const after = await ctx.snapshot(apis[0].baseUrl);
  const historical = resources(after).assessments.find((item) => item.assessmentId === before.assessment.assessmentId);
  assert.equal(canonicalJson(historical), canonicalJson(before.assessment), "activation cannot rewrite historical Assessment");
  const tenantEvents = resources(after).riskEvents.filter((item) => item.tenantId === ctx.fixtures.ids.tenantId && item.externalEventId === first.payload.externalEventId);
  assert.equal(tenantEvents.length, 1, "one RiskEvent per tenant external identity");
  const riskId = tenantEvents[0].riskEventId;
  assert.equal(resources(after).assessments.filter((item) => item.riskEventId === riskId).length, 1, "one Assessment per RiskEvent");
  assert.equal(after.work.filter((item) => item.aggregateId === before.assessment.assessmentId).length, 1, "one Work per Assessment");
  ctx.mark("risk.identity-and-version.closed", { riskEventId: riskId, assessmentId: before.assessment.assessmentId });
  return ctx.pass();
});

const A03 = guardedCase("A-03", ["REVIEW_TERMINAL", "HISTORY_IMMUTABILITY"], async (ctx) => {
  const { apis, workers } = await prepare(ctx, { seedVersion: "fl-a03", apiCount: 2, workerCount: 1 });
  const accepted = await acceptRisk(ctx, apis[0].baseUrl, 3, { attributes: { velocity: 9, country: "US" } });
  const completed = await waitAssessment(ctx, apis[0].baseUrl, accepted.payload.externalEventId, { processes: workers });
  assert.equal(completed.assessment.recommendation, "REVIEW", "fixture must create review");
  const { reviewCase } = await waitReviewCase(ctx, apis[0].baseUrl, completed.assessment.assessmentId, { processes: workers });
  const beforeExplanation = canonicalJson({
    assessment: {
      assessmentId: completed.assessment.assessmentId,
      riskEventId: completed.assessment.riskEventId,
      ruleVersionId: completed.assessment.ruleVersionId,
      score: completed.assessment.score,
      recommendation: completed.assessment.recommendation,
      createdAt: completed.assessment.createdAt,
      sequence: completed.assessment.sequence,
    },
    hits: resources(completed.snapshot).ruleHits.filter((item) => item.assessmentId === completed.assessment.assessmentId),
  });
  const claimant = "fraud-analyst-primary";
  const claim = successful(await ctx.mutate(apis[0].baseUrl, `/api/v1/review-cases/${reviewCase.reviewCaseId}/claim`, ctx.key("a03-claim"), { reviewerId: claimant, expectedRevision: reviewCase.revision, leaseSeconds: 10 }), "claim ReviewCase");
  const foreignClaim = await ctx.mutate(apis[1].baseUrl, `/api/v1/review-cases/${reviewCase.reviewCaseId}/claim`, ctx.key("a03-foreign-claim"), { reviewerId: "other-analyst", expectedRevision: claim.json.revision, leaseSeconds: 10 });
  semanticError(foreignClaim, 409, "REVIEW_LEASE_CONFLICT");
  const decisions = await Promise.all(["APPROVE", "BLOCK"].map((outcome, index) => ctx.mutate(
    apis[index].baseUrl,
    `/api/v1/review-cases/${reviewCase.reviewCaseId}/decisions`,
    ctx.key(`a03-decision-${outcome}`),
    { reviewerId: claimant, expectedRevision: claim.json.revision, outcome, reasonCode: `ANALYST_${outcome}` },
  )));
  assert.equal(decisions.filter((item) => item.status >= 200 && item.status < 300).length, 1, "one concurrent decision wins");
  const loser = decisions.find((item) => item.status >= 300);
  semanticError(loser, 409, "REVIEW_TERMINAL");
  const final = await ctx.snapshot(apis[0].baseUrl);
  const terminal = resources(final).reviewCases.find((item) => item.reviewCaseId === reviewCase.reviewCaseId);
  assert.ok(["APPROVED", "BLOCKED"].includes(terminal.state), "ReviewCase terminal state");
  assert.equal(resources(final).reviewDecisions.filter((item) => item.reviewCaseId === reviewCase.reviewCaseId).length, 1, "one ReviewDecision");
  const afterAssessment = resources(final).assessments.find((item) => item.assessmentId === completed.assessment.assessmentId);
  const afterExplanation = canonicalJson({
    assessment: {
      assessmentId: afterAssessment.assessmentId,
      riskEventId: afterAssessment.riskEventId,
      ruleVersionId: afterAssessment.ruleVersionId,
      score: afterAssessment.score,
      recommendation: afterAssessment.recommendation,
      createdAt: afterAssessment.createdAt,
      sequence: afterAssessment.sequence,
    },
    hits: resources(final).ruleHits.filter((item) => item.assessmentId === completed.assessment.assessmentId),
  });
  assert.equal(afterAssessment.recommendation, completed.assessment.recommendation, "recommendation remains frozen");
  assert.equal(afterExplanation, beforeExplanation, "Review decision cannot rewrite score or RuleHits");
  const storedDecision = resources(final).reviewDecisions.find((item) => item.reviewCaseId === reviewCase.reviewCaseId);
  assert.equal(afterAssessment.decision, storedDecision.outcome, "Assessment exposes the appended final business decision");
  assert.equal(afterAssessment.state, "DECIDED", "reviewed Assessment reaches DECIDED");
  ctx.mark("review.fenced-terminal", { reviewCaseId: reviewCase.reviewCaseId, state: terminal.state });
  return ctx.pass();
});

const A04 = guardedCase("A-04", ["HISTORY_IMMUTABILITY", "VERSION_AUTHORITY"], async (ctx) => {
  const { api } = await prepare(ctx, { seedVersion: "fl-a04" });
  const rollback = await setupRollback(ctx, api.baseUrl, { count: 2, suffix: "a04", includeNoChange: false });
  const exactReplay = await ctx.mutate(api.baseUrl, `/api/v1/rule-sets/${ctx.fixtures.ids.ruleSetId}/rollback`, ctx.key("rollback:a04:rollback"), {
    fromRuleVersionId: rollback.fromRuleVersionId,
    toRuleVersionId: rollback.toRuleVersionId,
    reason: "confirmed false-positive rollback",
  }, { admin: true });
  successful(exactReplay, "rollback exact replay");
  const invalid = await ctx.mutate(api.baseUrl, `/api/v1/rule-sets/${ctx.fixtures.ids.ruleSetId}/rollback`, ctx.key("a04-invalid-target"), {
    fromRuleVersionId: rollback.toRuleVersionId,
    toRuleVersionId: rollback.fromRuleVersionId,
    reason: "newer target is invalid",
  }, { admin: true });
  semanticError(invalid, 409, "ROLLBACK_TARGET_INVALID");
  const afterAccepted = await acceptRisk(ctx, api.baseUrl, 40_001, { attributes: { velocity: 9, country: "US" } });
  const replacement = await ctx.startWorker();
  const afterCompleted = await waitAssessment(ctx, api.baseUrl, afterAccepted.payload.externalEventId, { processes: [replacement] });
  assert.equal(afterCompleted.assessment.ruleVersionId, rollback.toRuleVersionId, "post-rollback event uses restored version");
  for (const assessmentId of rollback.assessmentIds) {
    const prior = resources(afterCompleted.snapshot).assessments.find((item) => item.assessmentId === assessmentId);
    assert.equal(prior.ruleVersionId, rollback.fromRuleVersionId, "pre-rollback event keeps from version");
  }
  assert.equal(activeVersion(afterCompleted.snapshot, ctx.fixtures.ids.ruleSetId).length, 1, "one ACTIVE after rollback");
  assert.equal(activeVersion(afterCompleted.snapshot, ctx.fixtures.ids.ruleSetId)[0].ruleVersionId, rollback.toRuleVersionId, "rollback target ACTIVE");
  assert.equal(resources(afterCompleted.snapshot).ruleRollbacks.filter((item) => item.fromRuleVersionId === rollback.fromRuleVersionId).length, 1, "one RuleRollback under replay");
  assertFactsPreserved(afterCompleted.snapshot, rollback.captured);
  ctx.mark("rollback.boundary.closed", { from: rollback.fromRuleVersionId, to: rollback.toRuleVersionId });
  return ctx.pass();
});

const A05 = guardedCase("A-05", ["HISTORY_IMMUTABILITY", "CORRECTION_UNIQUENESS"], async (ctx) => {
  const { api } = await prepare(ctx, { seedVersion: "fl-a05" });
  const rollback = await setupRollback(ctx, api.baseUrl, { count: 3, suffix: "a05", includeNoChange: true });
  const created = await createRemediation(ctx, api.baseUrl, rollback, "a05");
  await acceptRisk(ctx, api.baseUrl, 50_000, { attributes: { velocity: 9, country: "US" } });
  const worker = await ctx.startWorker();
  const detail = await waitRemediation(ctx, api.baseUrl, created.remediationRunId, { processes: [worker] });
  assertRemediationDetail(detail, rollback.assessmentIds);
  assert.equal(detail.run.totalCount, rollback.assessmentIds.length, "cohort frozen at creation");
  assert.ok(detail.corrections.some((item) => item.outcome === "CORRECTED"), "corrected result present");
  assert.ok(detail.corrections.some((item) => item.outcome === "NO_CHANGE"), "no-change result present");
  const finalSnapshot = await ctx.snapshot(api.baseUrl);
  assertFactsPreserved(finalSnapshot, rollback.captured);
  const restored = resources(finalSnapshot).ruleVersions.find((item) => item.ruleVersionId === rollback.toRuleVersionId);
  for (const correction of detail.corrections) {
    const assessment = resources(finalSnapshot).assessments.find((item) => item.assessmentId === correction.assessmentId);
    const riskEvent = resources(finalSnapshot).riskEvents.find((item) => item.riskEventId === assessment.riskEventId);
    assert.equal(correction.newRuleHitsDigest, correctionDigest(riskEvent, restored), "Correction hit digest");
    assert.equal(typeof correction.reason, "string", "Correction reason is a stable string");
    const replayDetail = await getRemediation(ctx, api.baseUrl, created.remediationRunId);
    const replayed = replayDetail.corrections.find((item) => item.assessmentId === correction.assessmentId);
    assert.equal(replayed.reason, correction.reason, "Correction reason stable on replay");
  }
  ctx.mark("remediation.append-only.closed", { remediationRunId: created.remediationRunId, totalCount: detail.run.totalCount });
  return ctx.pass({ evidence: [{ kind: "terminal-remediation-cohort", remediationRunId: created.remediationRunId, verifiedCorrections: detail.corrections.length }] });
});

export const A_CASES = [A01, A02, A03, A04, A05];
