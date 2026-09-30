import assert from "node:assert/strict";
import { canonicalJson } from "../oracles/index.mjs";
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
  rollbackVersion,
  semanticError,
  setupRollback,
  successful,
  waitAssessment,
  waitRemediation,
  waitReviewCase,
} from "./helpers.mjs";

const B01 = defineCase("B-01", async (ctx) => {
  const { api, workers } = await prepare(ctx, { seedVersion: "fl-b01", workerCount: 2 });
  const rules = [
    ctx.fixtures.rule({ ruleId: "eq-country", priority: 1, field: "attributes.country", operator: "EQ", value: "US", score: 120, reasonCode: "US_COUNTRY" }),
    ctx.fixtures.rule({ ruleId: "in-tags", priority: 1, field: "attributes.tags", operator: "IN", value: "hot", score: 350, reasonCode: "HOT_TAG" }),
    ctx.fixtures.rule({ ruleId: "gte-amount", priority: 2, field: "amountMinor", operator: "GTE", value: 50_000, score: 600, reasonCode: "HIGH_AMOUNT" }),
    ctx.fixtures.rule({ ruleId: "lte-velocity", priority: 3, field: "attributes.velocity", operator: "LTE", value: 2, score: -200, reasonCode: "LOW_VELOCITY" }),
  ];
  const versionCreated = await createVersion(ctx, api.baseUrl, "b01-model", { rules, reviewThreshold: 400, blockThreshold: 900 });
  await activateVersion(ctx, api.baseUrl, versionCreated.ruleVersionId, ctx.fixtures.ids.baseVersionId, "b01-model");
  const fixtures = [
    { amountMinor: 49_999, attributes: { country: "US", tags: ["hot"], velocity: 2 } },
    { amountMinor: 50_000, attributes: { country: "US", tags: ["cold", "hot"], velocity: 3 } },
    { amountMinor: 50_001, attributes: { country: "GB", tags: ["cold"], velocity: 1 } },
    { amountMinor: 9_000_000_000_000, attributes: { country: "US", tags: ["hot"], velocity: 0 } },
    { amountMinor: 0, attributes: { country: "GB", tags: [], velocity: 9 } },
  ];
  const accepted = [];
  for (let index = 0; index < fixtures.length; index += 1) accepted.push(await acceptRisk(ctx, api.baseUrl, 60_000 + index, fixtures[index]));
  for (const item of accepted) {
    const completed = await waitAssessment(ctx, api.baseUrl, item.payload.externalEventId, { processes: workers });
    const version = resources(completed.snapshot).ruleVersions.find((candidate) => candidate.ruleVersionId === versionCreated.ruleVersionId);
    assertAssessment(completed.snapshot, completed.assessment, item.payload, version);
  }
  const before = await ctx.snapshot(api.baseUrl);
  const nested = await acceptRisk(ctx, api.baseUrl, 60_100, { attributes: { nested: { forbidden: true } } }, { expectSuccess: false, contractExpectation: "invalid" });
  semanticError(nested.response, 400, "INVALID_REQUEST");
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(after.resources.riskEvents.length, before.resources.riskEvents.length, "invalid attributes create no RiskEvent");
  assert.equal(after.work.length, before.work.length, "invalid attributes create no Work");
  ctx.mark("scoring.reference-model", { eventCount: accepted.length, ruleCount: rules.length });
  return ctx.pass();
});

const B02 = guardedCase("B-02", ["IDENTITY_ATOMICITY"], async (ctx) => {
  const { apis } = await prepare(ctx, { seedVersion: "fl-b02", apiCount: 2 });
  const shield = await ctx.responseShield(apis[0].baseUrl);
  const payload = ctx.fixtures.event(70_000, { attributes: { velocity: 1, country: "US" } });
  const key = ctx.key("b02-lost-response");
  shield.dropNextMutation();
  await assert.rejects(ctx.mutate(shield.baseUrl, "/api/v1/risk-events", key, payload), "response shield must lose the committed response");
  const committed = shield.captures.find((item) => item.dropped);
  assert.ok(committed && committed.response.status >= 200 && committed.response.status < 300, "upstream committed before response loss");
  const replay = successful(await ctx.mutate(apis[1].baseUrl, "/api/v1/risk-events", key, payload), "lost-response replay");
  assert.equal(replay.status, committed.response.status, "replay status is original");
  assert.equal(replay.text, committed.response.body, "replay body is byte-identical");
  const keyConflict = await ctx.mutate(apis[0].baseUrl, "/api/v1/risk-events", key, { ...payload, amountMinor: payload.amountMinor + 1 });
  semanticError(keyConflict, 409, "IDEMPOTENCY_CONFLICT");
  const externalReplay = successful(await ctx.mutate(apis[1].baseUrl, "/api/v1/risk-events", ctx.key("b02-new-key-same-event"), payload), "new key same external payload");
  assert.equal(findField(externalReplay.json, "riskEventId"), findField(replay.json, "riskEventId"), "external replay restores identity");
  const externalConflict = await ctx.mutate(apis[1].baseUrl, "/api/v1/risk-events", ctx.key("b02-new-key-conflict"), { ...payload, amountMinor: payload.amountMinor + 2 });
  semanticError(externalConflict, 409, "EXTERNAL_EVENT_CONFLICT");
  await ctx.stop(apis[0]);
  const restarted = await ctx.startApi();
  const restartReplay = successful(await ctx.mutate(restarted.baseUrl, "/api/v1/risk-events", key, payload), "restart replay");
  assert.equal(restartReplay.text, committed.response.body, "restart replay body exact");
  const concurrent = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(
    index % 2 ? apis[1].baseUrl : restarted.baseUrl,
    "/api/v1/risk-events",
    key,
    payload,
  )));
  assert.ok(concurrent.every((item) => item.status === committed.response.status && item.text === committed.response.body), "concurrent replay exact");
  const snapshot = await ctx.snapshot(restarted.baseUrl);
  const matching = resources(snapshot).riskEvents.filter((item) => item.tenantId === payload.tenantId && item.externalEventId === payload.externalEventId);
  assert.equal(matching.length, 1, "one RiskEvent under both identities");
  assert.equal(resources(snapshot).assessments.filter((item) => item.riskEventId === matching[0].riskEventId).length, 1, "one Assessment side effect");
  ctx.mark("identity.precedence.closed", { riskEventId: matching[0].riskEventId });
  return ctx.pass();
});

const B03 = guardedCase("B-03", ["VERSION_AUTHORITY", "HISTORY_IMMUTABILITY"], async (ctx) => {
  const outcomes = [];
  for (let round = 0; round < 3; round += 1) {
    if (round > 0) await ctx.resetDatabase();
    const { apis } = await prepare(ctx, { seedVersion: `fl-b03-${round}`, apiCount: 2 });
    const from = await createVersion(ctx, apis[0].baseUrl, `b03-from-${round}`, { rules: [ctx.fixtures.rule({ score: 800, ruleId: `strict-${round}` })] });
    await activateVersion(ctx, apis[0].baseUrl, from.ruleVersionId, ctx.fixtures.ids.baseVersionId, `b03-from-${round}`);
    const newer = await createVersion(ctx, apis[0].baseUrl, `b03-newer-${round}`, { rules: [ctx.fixtures.rule({ score: 950, ruleId: `newer-${round}` })] });
    const payload = ctx.fixtures.event(80_000 + round, { attributes: { velocity: 9, country: "US" } });
    const operations = [
      () => ctx.mutate(apis[round % 2].baseUrl, "/api/v1/risk-events", ctx.key(`b03-risk-${round}`), payload),
      () => ctx.mutate(apis[(round + 1) % 2].baseUrl, `/api/v1/rule-versions/${newer.ruleVersionId}/activate`, ctx.key(`b03-activate-${round}`), { expectedActiveRuleVersionId: from.ruleVersionId }, { admin: true }),
      () => ctx.mutate(apis[round % 2].baseUrl, `/api/v1/rule-sets/${ctx.fixtures.ids.ruleSetId}/rollback`, ctx.key(`b03-rollback-${round}`), { fromRuleVersionId: from.ruleVersionId, toRuleVersionId: ctx.fixtures.ids.baseVersionId, reason: "race rollback" }, { admin: true }),
    ];
    const order = round === 0 ? [0, 1, 2] : round === 1 ? [2, 0, 1] : [1, 2, 0];
    const responses = await Promise.all(order.map((index) => operations[index]()));
    const riskResponse = responses[order.indexOf(0)];
    successful(riskResponse, "raced RiskEvent acceptance");
    const controlResponses = [responses[order.indexOf(1)], responses[order.indexOf(2)]];
    assert.equal(controlResponses.filter((item) => item.status >= 200 && item.status < 300).length, 1, "activate and rollback have one serialization winner");
    const lost = controlResponses.find((item) => item.status >= 300);
    semanticError(lost, 409, "ACTIVE_RULE_VERSION_CHANGED");
    const worker = await ctx.startWorker();
    const completed = await waitAssessment(ctx, apis[0].baseUrl, payload.externalEventId, { processes: [worker] });
    const version = resources(completed.snapshot).ruleVersions.find((item) => item.ruleVersionId === completed.assessment.ruleVersionId);
    assert.ok([ctx.fixtures.ids.baseVersionId, from.ruleVersionId, newer.ruleVersionId].includes(version.ruleVersionId), "Assessment uses one committed ACTIVE version");
    assertAssessment(completed.snapshot, completed.assessment, payload, version);
    assert.equal(activeVersion(completed.snapshot, ctx.fixtures.ids.ruleSetId).length, 1, "one ACTIVE after race");
    outcomes.push({ round, frozenVersion: version.ruleVersionId, activeVersion: activeVersion(completed.snapshot, ctx.fixtures.ids.ruleSetId)[0].ruleVersionId });
  }
  ctx.mark("version.serialization.seeds", { outcomes });
  return ctx.pass();
});

const B04 = guardedCase("B-04", ["REVIEW_TERMINAL", "TENANT_ISOLATION"], async (ctx) => {
  const { apis, workers } = await prepare(ctx, { seedVersion: "fl-b04", apiCount: 2, workerCount: 1 });
  const accepted = await acceptRisk(ctx, apis[0].baseUrl, 90_000, { attributes: { velocity: 9, country: "US" } });
  const completed = await waitAssessment(ctx, apis[0].baseUrl, accepted.payload.externalEventId, { processes: workers });
  const { reviewCase } = await waitReviewCase(ctx, apis[0].baseUrl, completed.assessment.assessmentId, { processes: workers });
  const claims = await Promise.all(Array.from({ length: 64 }, (_, index) => ctx.mutate(
    apis[index % 2].baseUrl,
    `/api/v1/review-cases/${reviewCase.reviewCaseId}/claim`,
    ctx.key(`b04-claim-${index}`),
    { reviewerId: `analyst-${index}`, expectedRevision: reviewCase.revision, leaseSeconds: 3 },
  )));
  const winners = claims.map((item, index) => ({ item, index })).filter(({ item }) => item.status >= 200 && item.status < 300);
  assert.equal(winners.length, 1, "one claimant owns the live lease");
  for (const response of claims.filter((item) => item.status >= 300)) semanticError(response, 409, "REVIEW_LEASE_CONFLICT");
  const reviewerId = `analyst-${winners[0].index}`;
  const expiryWorker = await ctx.startWorker();
  const decisions = await Promise.all(["APPROVE", "BLOCK"].map((outcome, index) => ctx.mutate(
    apis[index].baseUrl,
    `/api/v1/review-cases/${reviewCase.reviewCaseId}/decisions`,
    ctx.key(`b04-${outcome}`),
    { reviewerId, expectedRevision: winners[0].item.json.revision, outcome, reasonCode: `HOT_${outcome}` },
  )));
  assert.ok(decisions.filter((item) => item.status >= 200 && item.status < 300).length <= 1, "at most one opposite decision wins");
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    const value = resources(snapshot).reviewCases.find((item) => item.reviewCaseId === reviewCase.reviewCaseId);
    return ["APPROVED", "BLOCKED", "EXPIRED"].includes(value?.state) ? { snapshot, value } : undefined;
  }, { timeoutMs: 30_000, label: "Review terminal race", processes: [expiryWorker] });
  const stored = resources(final.snapshot).reviewDecisions.filter((item) => item.reviewCaseId === reviewCase.reviewCaseId);
  assert.equal(stored.length, final.value.state === "EXPIRED" ? 0 : 1, "terminal decision cardinality");
  assert.equal(new Set(stored.map((item) => item.reviewDecisionId)).size, stored.length, "ReviewDecision identity unique");
  ctx.mark("review.hot-race.closed", { state: final.value.state, claimant: reviewerId });
  return ctx.pass();
});

const B05 = guardedCase("B-05", ["CORRECTION_UNIQUENESS", "HISTORY_IMMUTABILITY"], async (ctx) => {
  const { apis } = await prepare(ctx, { seedVersion: "fl-b05", apiCount: 2 });
  const rollback = await setupRollback(ctx, apis[0].baseUrl, { count: 20, suffix: "b05", includeNoChange: true });
  const body = {
    tenantId: ctx.fixtures.ids.tenantId,
    fromRuleVersionId: rollback.fromRuleVersionId,
    toRuleVersionId: rollback.toRuleVersionId,
    ...ctx.fixtures.remediationRange,
  };
  const key = ctx.key("b05-run");
  const creations = await Promise.all(Array.from({ length: 32 }, (_, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/remediation-runs", key, body, { admin: true })));
  assert.ok(creations.every((item) => item.status >= 200 && item.status < 300), "all concurrent run replays succeed");
  const runIds = new Set(creations.map((item) => findField(item.json, "remediationRunId")));
  assert.equal(runIds.size, 1, "one frozen RemediationRun");
  const remediationRunId = [...runIds][0];
  const worker = await ctx.startWorker();
  await ctx.waitFor(async () => {
    const detail = await getRemediation(ctx, apis[0].baseUrl, remediationRunId);
    return detail.corrections.length > 0 || ["COMPLETED", "CANCELLED"].includes(detail.run.state) ? detail : undefined;
  }, { timeoutMs: 30_000, label: "partial remediation progress", processes: [worker] });
  const cancels = await Promise.all(apis.map((api, index) => ctx.mutate(api.baseUrl, `/api/v1/remediation-runs/${remediationRunId}/cancel`, ctx.key(`b05-cancel-${index}`), {}, { admin: true })));
  assert.ok(cancels.some((item) => item.status >= 200 && item.status < 300), "cancel or completed replay succeeds");
  for (const response of cancels.filter((item) => item.status >= 300)) semanticError(response, 409, "REMEDIATION_RUN_TERMINAL");
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const detail = await waitRemediation(ctx, apis[0].baseUrl, remediationRunId, { processes: replacements });
  assertRemediationDetail(detail, rollback.assessmentIds);
  assert.ok(["COMPLETED", "CANCELLED"].includes(detail.run.state), "one terminal Run state");
  assert.equal(detail.corrections.length, detail.run.completedCount, "each completed item has one correction");
  const final = await ctx.snapshot(apis[0].baseUrl);
  assertFactsPreserved(final, rollback.captured);
  ctx.mark("remediation.cancel-closure", { remediationRunId, state: detail.run.state, completed: detail.run.completedCount });
  return ctx.pass({ evidence: [{ kind: "terminal-cohort-cancel-closure", remediationRunId, state: detail.run.state, correctionCount: detail.corrections.length }] });
});

export const B_CASES = [B01, B02, B03, B04, B05];
