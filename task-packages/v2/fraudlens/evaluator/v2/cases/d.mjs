import assert from "node:assert/strict";
import { assertNoSecrets, canonicalJson, correctionDigest, exactKeys } from "../oracles/index.mjs";
import {
  CORRECTION_KEYS,
  PUBLIC_PATHS,
  REMEDIATION_RUN_KEYS,
  V1_RESOURCE_KEYS,
  acceptRisk,
  assertFactsPreserved,
  assertRemediationDetail,
  clickVisible,
  createRemediation,
  createVersion,
  defineCase,
  fillVisible,
  findField,
  guardedCase,
  launchProductionBrowser,
  prepare,
  resources,
  setupRollback,
  successful,
  waitAssessment,
  waitRemediation,
  waitReviewCase,
} from "./helpers.mjs";

async function rowAction(page, identity, action) {
  const identityNode = page.getByText(identity, { exact: false }).first();
  assert.ok(await identityNode.count(), `UI displays ${identity}`);
  const row = identityNode.locator("xpath=ancestor::*[self::tr or @role='row' or self::article or self::section][1]");
  const button = row.getByRole("button", { name: new RegExp(action, "i") }).first();
  if (await button.count()) await button.click();
  else await clickVisible(page, action);
}

const D01 = guardedCase("D-01", ["HISTORY_IMMUTABILITY", "REVIEW_TERMINAL", "TENANT_ISOLATION"], async (ctx) => {
  await ctx.migrate();
  await ctx.seed(ctx.fixtures.seed("fl-d01"));
  const api = await ctx.startApi();
  const version = await createVersion(ctx, api.baseUrl, "d01-ui", { rules: [ctx.fixtures.rule({ score: 300, ruleId: "ui-review" })] });
  const { page } = await launchProductionBrowser(ctx);
  await page.reload({ waitUntil: "networkidle" });
  assert.match(await page.locator("body").innerText(), /fraud|risk|tenant/iu, "production UI shell is visible");
  await rowAction(page, version.ruleVersionId, "activate");
  await page.waitForTimeout(100);
  const activeSnapshot = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return resources(snapshot).ruleVersions.find((item) => item.ruleVersionId === version.ruleVersionId)?.state === "ACTIVE" ? snapshot : undefined;
  }, { label: "UI RuleVersion activation" });
  assert.equal(resources(activeSnapshot).ruleVersions.filter((item) => item.ruleSetId === ctx.fixtures.ids.ruleSetId && item.state === "ACTIVE").length, 1, "UI activation preserves one ACTIVE");

  const event = ctx.fixtures.event(130_000, { attributes: { velocity: 9, country: "US" } });
  for (const [name, value] of Object.entries({
    tenantId: event.tenantId,
    externalEventId: event.externalEventId,
    subjectId: event.subjectId,
    amountMinor: event.amountMinor,
    currency: event.currency,
    occurredAt: event.occurredAt,
    attributes: JSON.stringify(event.attributes),
  })) await fillVisible(page, name, value);
  await clickVisible(page, "submit|evaluate|create event");
  const worker = await ctx.startWorker();
  const completed = await waitAssessment(ctx, api.baseUrl, event.externalEventId, { processes: [worker] });
  const review = await waitReviewCase(ctx, api.baseUrl, completed.assessment.assessmentId, { processes: [worker] });
  await page.reload({ waitUntil: "networkidle" });
  const body = await page.locator("body").innerText();
  assert.ok(body.includes(String(completed.assessment.score)), "UI displays Assessment score");
  assert.ok(body.includes(version.ruleVersionId), "UI displays frozen RuleVersion");
  assert.ok(body.includes("ui-review") || body.includes("HIGH_VELOCITY"), "UI displays RuleHit explanation");
  await rowAction(page, review.reviewCase.reviewCaseId, "claim");
  const reviewerControl = page.locator('[name="reviewerId"], [name="assigneeId"]').first();
  if (await reviewerControl.count()) await reviewerControl.fill("ui-analyst");
  const approve = page.getByRole("button", { name: /approve/iu }).first();
  assert.ok(await approve.count(), "visible APPROVE decision");
  await approve.click();
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return resources(snapshot).reviewCases.find((item) => item.reviewCaseId === review.reviewCase.reviewCaseId)?.state === "APPROVED";
  }, { label: "UI ReviewDecision" });
  await rowAction(page, ctx.fixtures.ids.ruleSetId, "rollback");
  await page.reload({ waitUntil: "networkidle" });
  assert.match(await page.locator("body").innerText(), /approved|rollback|rolled/iu, "terminal decision and rollback remain visible after refresh");
  ctx.mark("ui.risk-review-rollback", { assessmentId: completed.assessment.assessmentId, reviewCaseId: review.reviewCase.reviewCaseId });
  return ctx.pass();
});

const D02 = guardedCase("D-02", ["CORRECTION_UNIQUENESS", "HISTORY_IMMUTABILITY"], async (ctx) => {
  const { api } = await prepare(ctx, { seedVersion: "fl-d02" });
  const rollback = await setupRollback(ctx, api.baseUrl, { count: 6, suffix: "d02", includeNoChange: true });
  const { page } = await launchProductionBrowser(ctx);
  await page.reload({ waitUntil: "networkidle" });
  const body = {
    tenantId: ctx.fixtures.ids.tenantId,
    fromRuleVersionId: rollback.fromRuleVersionId,
    toRuleVersionId: rollback.toRuleVersionId,
    ...ctx.fixtures.remediationRange,
  };
  for (const [name, value] of Object.entries(body)) await fillVisible(page, name, value);
  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/v1\/remediation-runs$/u.test(new URL(response.url()).pathname));
  await clickVisible(page, "create.*remediation|start.*remediation");
  const response = await responsePromise;
  assert.equal(response.status(), 201, "UI Remediation create status");
  const createdBody = await response.json();
  const remediationRunId = findField(createdBody, "remediationRunId");
  const worker = await ctx.startWorker();
  const detail = await waitRemediation(ctx, api.baseUrl, remediationRunId, { processes: [worker] });
  assertRemediationDetail(detail, rollback.assessmentIds);
  await page.reload({ waitUntil: "networkidle" });
  const visible = await page.locator("body").innerText();
  assert.ok(visible.includes(remediationRunId), "UI displays frozen RemediationRun");
  assert.ok(visible.includes(String(detail.run.completedCount)) && visible.includes(String(detail.run.totalCount)), "UI displays exact progress counts");
  assert.match(visible, /corrected|no.change/iu, "UI distinguishes correction outcomes");
  const second = await createRemediation(ctx, api.baseUrl, rollback, "d02-cancel");
  await page.reload({ waitUntil: "networkidle" });
  await rowAction(page, second.remediationRunId, "cancel");
  const cancelled = await waitRemediation(ctx, api.baseUrl, second.remediationRunId, { processes: [worker] });
  assert.ok(["CANCELLED", "COMPLETED"].includes(cancelled.run.state), "UI cancel serializes with completion");
  assertFactsPreserved(await ctx.snapshot(api.baseUrl), rollback.captured);
  ctx.mark("ui.remediation.closed", { remediationRunId, cancelledRunId: second.remediationRunId });
  return ctx.pass();
});

const D03 = defineCase("D-03", async (ctx) => {
  const { api } = await prepare(ctx, { seedVersion: "fl-d03" });
  const openapiResponse = successful(await ctx.request(api.baseUrl, "/openapi.json"), "OpenAPI");
  const document = openapiResponse.json;
  assert.equal(document.openapi, "3.1.0", "OpenAPI exact version");
  for (const path of PUBLIC_PATHS) assert.ok(document.paths?.[path], `OpenAPI publishes ${path}`);
  assert.ok(document.paths["/api/v1/remediation-runs"].post.responses["201"], "Remediation create publishes 201");
  assert.ok(document.paths["/api/v1/remediation-runs/{runId}"].get.responses["200"], "Remediation detail publishes 200");
  assert.ok(document.paths["/api/v1/remediation-runs/{runId}/cancel"].post.responses["200"], "Remediation cancel publishes 200");
  const published = canonicalJson(document);
  for (const code of ["REMEDIATION_VERSION_MISMATCH", "REMEDIATION_RUN_TERMINAL", "REMEDIATION_RANGE_INVALID", "INVALID_REQUEST", "NOT_FOUND"]) assert.ok(published.includes(code), `OpenAPI publishes ${code}`);
  const snapshot = await ctx.snapshot(api.baseUrl);
  for (const key of V1_RESOURCE_KEYS) assert.ok(Array.isArray(resources(snapshot)[key]), `snapshot publishes V1 ${key}`);
  assert.deepEqual(resources(snapshot).ruleVersions, [...resources(snapshot).ruleVersions].sort((left, right) => left.ruleSetId.localeCompare(right.ruleSetId) || left.version - right.version), "RuleVersions sorted by public identity");
  assert.deepEqual(resources(snapshot).auditEntries, [...resources(snapshot).auditEntries].sort((left, right) => left.tenantId.localeCompare(right.tenantId) || left.sequence - right.sequence), "Audit sorted by tenant sequence");
  const rollback = await setupRollback(ctx, api.baseUrl, { count: 2, suffix: "d03", includeNoChange: true });
  const created = await createRemediation(ctx, api.baseUrl, rollback, "d03");
  const worker = await ctx.startWorker();
  await waitRemediation(ctx, api.baseUrl, created.remediationRunId, { processes: [worker] });
  const detailResponse = await ctx.request(api.baseUrl, `/api/v1/remediation-runs/${created.remediationRunId}`, { headers: { authorization: `Bearer ${ctx.adminToken}` } });
  successful(detailResponse, "Remediation detail");
  const detail = detailResponse.json;
  exactKeys(detail, ["run", "corrections"], "Remediation GET wrapper");
  exactKeys(detail.run, REMEDIATION_RUN_KEYS, "RemediationRun");
  assert.equal(detail.corrections.length, 2, "published detail contains both completed cohort corrections");
  for (const correction of detail.corrections) exactKeys(correction, CORRECTION_KEYS, "AssessmentCorrection");
  assertNoSecrets({ openapi: document, snapshot, detail }, [ctx.adminToken, ctx.barrierToken, ctx.databaseUrl]);
  ctx.mark("contract.openapi-and-snapshot", { pathCount: PUBLIC_PATHS.length });
  return ctx.pass({ evidence: [{ kind: "public-remediation-detail-contract", remediationRunId: created.remediationRunId, correctionCount: detail.corrections.length }] });
});

const D04 = guardedCase("D-04", ["HISTORY_IMMUTABILITY", "CORRECTION_UNIQUENESS"], async (ctx) => {
  const { api } = await prepare(ctx, { seedVersion: "fl-d04" });
  const rollback = await setupRollback(ctx, api.baseUrl, { count: 2, suffix: "d04", includeNoChange: true });
  const created = await createRemediation(ctx, api.baseUrl, rollback, "d04");
  const worker = await ctx.startWorker();
  const detail = await waitRemediation(ctx, api.baseUrl, created.remediationRunId, { processes: [worker] });
  assertRemediationDetail(detail, rollback.assessmentIds);
  assert.equal(detail.corrections.length, 2, "one corrected and one no-change lineage");
  assert.deepEqual(new Set(detail.corrections.map((item) => item.outcome)), new Set(["CORRECTED", "NO_CHANGE"]), "both correction outcomes");
  const snapshot = await ctx.snapshot(api.baseUrl);
  assertFactsPreserved(snapshot, rollback.captured);
  const restored = resources(snapshot).ruleVersions.find((item) => item.ruleVersionId === rollback.toRuleVersionId);
  for (const correction of detail.corrections) {
    const assessment = resources(snapshot).assessments.find((item) => item.assessmentId === correction.assessmentId);
    const riskEvent = resources(snapshot).riskEvents.find((item) => item.riskEventId === assessment.riskEventId);
    assert.equal(correction.newRuleHitsDigest, correctionDigest(riskEvent, restored), "Correction closes to restored RuleHits");
    assert.equal(typeof correction.reason, "string", "reason is a stable public string");
    assert.ok(correction.reason.length > 0, "reason is not empty");
    assert.equal(correction.remediationRunId, created.remediationRunId, "Correction references frozen Run");
  }
  const replay = await ctx.request(api.baseUrl, `/api/v1/remediation-runs/${created.remediationRunId}`, { headers: { authorization: `Bearer ${ctx.adminToken}` } });
  successful(replay, "re-read Correction lineage");
  assert.equal(canonicalJson(replay.json), canonicalJson(detail), "Correction detail stable on replay");
  ctx.mark("correction.lineage.closed", { remediationRunId: created.remediationRunId });
  return ctx.pass();
});

export const D_CASES = [D01, D02, D03, D04];
