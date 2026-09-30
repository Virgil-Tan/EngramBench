import assert from "node:assert/strict";
import { assertAppealLineage, assertEvidenceHistory, assertOneDecisionPerStage } from "../oracles/index.mjs";

const definitions = Object.freeze({
  "A-01": ["MF-F-CONTENT", "Submit and replay one public ContentItem with its initial evidence", "Assert one frozen ContentItem, EvidenceVersion, Case, Work, Event, and audit transition"],
  "A-02": ["MF-F-EVIDENCE", "Append and reject evidence around an immutable existing history", "Assert contiguous versions, stable old bodies, exact head, and atomic rejection"],
  "A-03": ["MF-F-REVIEW", "Complete LEVEL_1 and LEVEL_2 while policy and evidence advance", "Assert each Stage and Decision retains its captured policy and evidence authority"],
  "A-04": ["MF-F-APPEAL", "Create and decide Appeals at both sides of the public thirty-day boundary", "Assert one timely frozen Appeal and no late or duplicate side effects"],
  "A-05": ["MF-F-RECALL", "Create compatible and incompatible Policy Recall cohorts", "Assert exact closed-interval membership and all-or-none compatibility validation"],
  "B-01": ["MF-F-EVIDENCE-RACE", "Race same and distinct evidence appends across two API processes", "Assert one linear contiguous sequence without duplicate next-head authority"],
  "B-02": ["MF-F-DECISION-RACE", "Race a fenced Decision with late evidence at both commit orders", "Assert the Decision uses only its Stage snapshot while evidence is retained"],
  "B-03": ["MF-F-APPEAL-RACE", "Race twenty Appeal creations against one eligible Case", "Assert exactly one Appeal, Stage, Work, and public conflict reality"],
  "B-04": ["MF-F-RECALL-REPLAY", "Lose a Recall create response and replay concurrently after cohort growth", "Assert stable Run and Work identity with an immutable frozen total"],
  "B-05": ["MF-F-RECONSIDERATION", "Drain a mixed changed and no-change Recall cohort", "Assert one result per member, one Stage per changed member, and conserved counts"],
  "C-01": ["MF-F-REVIEW-LEASE", "Kill a claimed review owner and recover after persisted lease expiry", "Assert one fenced terminal Decision and no stale duplicate effect"],
  "C-02": ["MF-F-RECALL-LEASE", "Kill Recall workers repeatedly at public recovery barriers", "Assert each frozen member converges exactly once without lost progress"],
  "C-03": ["MF-F-RECALL-CANCEL", "Race cancellation with the final claimed Recall member", "Assert only COMPLETED or CANCELLED and no post-cancel stale commit"],
  "C-04": ["MF-F-OUTBOX", "Kill the dispatcher after receiver persistence and restart delivery", "Assert stable Event identity and semantic body in aggregate order"],
  "D-01": ["MF-F-WIRE", "Exercise exact moderation and recall routes, shapes, errors, sorting, and tenant scope", "Assert OpenAPI and runtime closure with zero rejected-request mutation"],
  "D-02": ["MF-F-V1-UI", "Complete the public moderation and Appeal flow in production Chromium", "Assert visible controls and refreshed state match public HTTP evidence"],
  "D-03": ["MF-F-RECALL-UI", "Create and inspect Recall differences and human confirmation in Chromium", "Assert visible counts and legal Reconsideration outcomes match public GET"],
  "D-04": ["MF-F-AUDIT", "Read one authenticated snapshot and verify every tenant audit digest", "Assert exact sorted resources, same observation point, redaction, and digest continuity"],
  "E-01": ["MF-F-V1-FINAL", "Populate V1 state, migrate the same database, and replay public requests", "Assert identity, body, Work, Event, and audit compatibility without historical rewrite"],
  "E-02": ["MF-F-PERF-INGEST", "Run exactly fifty-thousand submissions at ninety-six concurrency", "Assert fixed throughput and latency plus post-load evidence and idempotency invariants"],
  "E-03": ["MF-F-PERF-CONTENTION", "Run exactly twenty-thousand evidence review and Appeal operations", "Assert fixed terminal rate and latency plus Stage and Appeal uniqueness"],
  "E-04": ["MF-F-PERF-RECALL", "Recover ten-thousand recalled Cases after two claimed workers are killed", "Assert four replacements close in ninety seconds with exact membership and audit closure"],
});

export function defineCase(id, run) {
  const [fixtureFamily, action, oracle] = definitions[id] ?? [];
  if (!fixtureFamily || typeof run !== "function") throw new TypeError(`invalid ModerationFlow case ${id}`);
  return Object.freeze({ id, taskId: "moderationflow", fixtureFamily, action, oracle, run });
}

export async function prepare(ctx, { seed = ctx.fixtures.baseSeed(ctx.caseId.toLowerCase()), workspace = ctx.workspace } = {}) {
  const target = ctx.forWorkspace(workspace);
  await target.migrate();
  const seeded = await target.seed(seed, { allowFailure: true });
  if (seeded.exitCode !== 0) throw new Error(`seed failed: ${seeded.stderr}`);
  return { target, api: await target.startApi(), seed };
}

export function expectSuccess(response, label, status) {
  if (status !== undefined) assert.equal(response.status, status, `${label} status: ${response.text}`);
  else assert.ok(response.status >= 200 && response.status < 300, `${label} status ${response.status}: ${response.text}`);
  assert.ok(response.json && typeof response.json === "object", `${label} response body`);
  return response.json;
}

export function expectError(ctx, response, status, code, label, options = {}) {
  ctx.equal(response.status, status, `${label} status`, options);
  ctx.equal(response.json?.error?.code, code, `${label} code`, options);
  ctx.ok(response.json?.error?.details && typeof response.json.error.details === "object", `${label} details`, options);
  return response;
}

export function resource(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) { const found = resource(child, key); if (found !== undefined) return found; }
  return undefined;
}

export async function createContent(ctx, baseUrl, body, { key = ctx.key(`content:${body.externalContentId}`), allowFailure = false } = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/content-items", key, body);
  return allowFailure ? response : expectSuccess(response, "create ContentItem");
}

export async function appendEvidence(ctx, baseUrl, contentItemId, body, { key = ctx.key(`evidence:${contentItemId}:${body.expectedHeadVersion}`), allowFailure = false, contractExpectation } = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/content-items/${contentItemId}/evidence-versions`, key, body, { contractExpectation });
  return allowFailure ? response : expectSuccess(response, "append EvidenceVersion");
}

export async function createPolicyVersion(ctx, baseUrl, policyId, categories, { key = ctx.key(`policy-version:${policyId}:${JSON.stringify(categories)}`), allowFailure = false } = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/policies/${policyId}/versions`, key, { categories });
  return allowFailure ? response : expectSuccess(response, "create PolicyVersion");
}

export async function activatePolicyVersion(ctx, baseUrl, policyVersionId, expectedActivePolicyVersionId, { key = ctx.key(`activate:${policyVersionId}`), allowFailure = false } = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/policy-versions/${policyVersionId}/activate`, key, { expectedActivePolicyVersionId });
  return allowFailure ? response : expectSuccess(response, "activate PolicyVersion");
}

export async function listStages(ctx, baseUrl, query = "state=OPEN&limit=100") {
  const response = await ctx.request(baseUrl, `/api/v1/review-stages?${query}`);
  const json = expectSuccess(response, "list ReviewStages", 200);
  assert.ok(Array.isArray(json.items));
  return json.items;
}

export async function waitStage(ctx, baseUrl, predicate, { processes = [], timeoutMs = 60_000, label = "ReviewStage" } = {}) {
  return ctx.waitFor(async () => (await listStages(ctx, baseUrl)).find(predicate) ?? false, { processes, timeoutMs, intervalMs: 75, label });
}

export async function completeCase(ctx, api, submission, { outcome = "ALLOW", categoryCode = outcome === "ALLOW" ? "SAFE" : "ABUSE", reviewerId = "hidden-reviewer" } = {}) {
  const created = await createContent(ctx, api.baseUrl, submission);
  const caseId = resource(created, "caseId"); const contentItemId = resource(created, "contentItemId");
  assert.ok(caseId && contentItemId, "content response must identify Case and ContentItem");
  const worker = await ctx.startWorker();
  const levelOne = await waitStage(ctx, api.baseUrl, ({ caseId: candidate, level, state }) => candidate === caseId && level === "LEVEL_1" && state === "OPEN", { processes: [worker], label: "LEVEL_1 open" });
  await ctx.stop(worker); await claimStage(ctx, api.baseUrl, levelOne.stageId, reviewerId);
  const firstOutcome = outcome === "ESCALATE" ? "ESCALATE" : outcome;
  await decideStage(ctx, api.baseUrl, levelOne.stageId, { reviewerId, outcome: firstOutcome, categoryCode, reason: "hidden moderation decision" });
  if (firstOutcome === "ESCALATE") {
    const nextWorker = await ctx.startWorker();
    const levelTwo = await waitStage(ctx, api.baseUrl, ({ caseId: candidate, level, state }) => candidate === caseId && level === "LEVEL_2" && state === "OPEN", { processes: [nextWorker], label: "LEVEL_2 open" });
    await ctx.stop(nextWorker); const levelTwoReviewer = `${reviewerId}-level2`; await claimStage(ctx, api.baseUrl, levelTwo.stageId, levelTwoReviewer);
    await decideStage(ctx, api.baseUrl, levelTwo.stageId, { reviewerId: levelTwoReviewer, outcome: "REMOVE", categoryCode: "ABUSE", reason: "hidden final decision" });
  }
  const state = await snapshot(ctx, api.baseUrl); const moderationCase = state.resources.moderationCases.find((item) => item.caseId === caseId);
  assert.equal(moderationCase.state, "DECIDED");
  return { created, caseId, contentItemId, moderationCase, snapshot: state };
}

const claimedReviewInputs = new WeakMap();

export async function claimStage(ctx, baseUrl, stageId, reviewerId, { key = ctx.key(`claim:${stageId}`), leaseSeconds = 3, allowFailure = false, authority } = {}) {
  if (!authority) {
    const { resources } = await ctx.snapshot(baseUrl);
    const stage = resources.reviewStages.find((item) => item.stageId === stageId);
    assert.ok(stage, "claim fixture requires a public ReviewStage");
    const moderationCase = resources.moderationCases.find((item) => item.caseId === stage.caseId);
    const reconsideration = resources.reconsiderations?.find((item) => item.reconsiderationStageId === stageId);
    authority = { stage, moderationCase, reconsideration };
  }
  const { stage, moderationCase, reconsideration } = authority;
  assert.ok(moderationCase, "claim fixture requires its public ModerationCase");
  const frozen = {
    evidenceHeadVersion: reconsideration?.evidenceHeadVersion ?? moderationCase.evidenceHeadVersion,
    policyVersionId: reconsideration?.replacementPolicyVersionId ?? moderationCase.policyVersionId,
  };
  const response = await ctx.mutate(baseUrl, `/api/v1/review-stages/${stageId}/claim`, key, { reviewerId, leaseSeconds, expectedRevision: stage.revision });
  if (response.status >= 200 && response.status < 300) {
    if (!claimedReviewInputs.has(ctx)) claimedReviewInputs.set(ctx, new Map());
    claimedReviewInputs.get(ctx).set(`${stageId}:${reviewerId}`, { ...frozen, expectedRevision: response.json.revision });
  }
  return allowFailure ? response : expectSuccess(response, "claim ReviewStage");
}

export async function decideStage(ctx, baseUrl, stageId, body, { key = ctx.key(`decision:${stageId}`), allowFailure = false } = {}) {
  const request = { ...claimedReviewInputs.get(ctx)?.get(`${stageId}:${body.reviewerId}`), ...body };
  const response = await ctx.mutate(baseUrl, `/api/v1/review-stages/${stageId}/decisions`, key, request);
  return allowFailure ? response : expectSuccess(response, "decide ReviewStage");
}

export async function createAppeal(ctx, baseUrl, caseId, reason, { key = ctx.key(`appeal:${caseId}`), allowFailure = false, challengedDecisionId, evidenceHeadVersion } = {}) {
  if (challengedDecisionId === undefined || evidenceHeadVersion === undefined) {
    const current = expectSuccess(await ctx.request(baseUrl, `/api/v1/moderation-cases/${caseId}`), "read Case for Appeal", 200);
    challengedDecisionId ??= current.finalDecisionId;
    evidenceHeadVersion ??= current.evidenceHeadVersion;
  }
  const response = await ctx.mutate(baseUrl, `/api/v1/moderation-cases/${caseId}/appeals`, key, { reason, challengedDecisionId, evidenceHeadVersion });
  return allowFailure ? response : expectSuccess(response, "create Appeal");
}

export async function decideAppeal(ctx, baseUrl, appealId, body, { key = ctx.key(`appeal-decision:${appealId}`), allowFailure = false } = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/appeals/${appealId}/decision`, key, body);
  return allowFailure ? response : expectSuccess(response, "decide Appeal");
}

export async function createRecall(ctx, baseUrl, body, { key = ctx.key("recall:create"), allowFailure = false } = {}) {
  const request = { ...body }; delete request.label;
  const response = await ctx.mutate(baseUrl, "/api/v1/policy-recall-runs", key, request);
  return allowFailure ? response : expectSuccess(response, "create PolicyRecallRun", 201);
}

export async function getRecall(ctx, baseUrl, runId) {
  return expectSuccess(await ctx.request(baseUrl, `/api/v1/policy-recall-runs/${runId}`), "get PolicyRecallRun", 200);
}

export async function cancelRecall(ctx, baseUrl, runId, { key = ctx.key(`recall:cancel:${runId}`), allowFailure = false } = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/policy-recall-runs/${runId}/cancel`, key, {});
  return allowFailure ? response : expectSuccess(response, "cancel PolicyRecallRun", 200);
}

export async function snapshot(ctx, baseUrl) {
  const value = await ctx.snapshot(baseUrl);
  assertOneDecisionPerStage(value);
  assertAppealLineage(value);
  for (const item of value.resources.contentItems) assertEvidenceHistory(value.resources.evidenceVersions, item.contentItemId);
  return value;
}

export async function waitSnapshot(ctx, baseUrl, predicate, { processes = [], timeoutMs = 60_000, label = "ModerationFlow state" } = {}) {
  return ctx.waitFor(async () => { const value = await snapshot(ctx, baseUrl); return predicate(value) ? value : false; }, { processes, timeoutMs, intervalMs: 75, label });
}

export async function stopAll(ctx, records) { for (const record of records) await ctx.stop(record); }

export async function withPage(ctx, api, viewport, operation) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ executablePath: await ctx.chromiumExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const browserContext = await browser.newContext({ viewport }); const page = await browserContext.newPage(); const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource.*4\d\d/iu.test(message.text())) errors.push(message.text()); });
  try { await page.goto(api.baseUrl, { waitUntil: "networkidle" }); await operation(page); ctx.equal(errors, [], "browser console errors"); }
  finally { await browserContext.close(); await browser.close(); }
}

export async function clickVisible(page, patterns) {
  for (const pattern of patterns) {
    const control = page.getByRole("button", { name: pattern }).or(page.getByRole("link", { name: pattern })).first();
    if (await control.count() && await control.isVisible()) { await control.click(); return; }
  }
  throw new Error(`visible control not found: ${patterns.join(", ")}`);
}

export async function fillVisible(page, pattern, value) {
  const control = page.getByLabel(pattern).or(page.getByPlaceholder(pattern)).first();
  if (!await control.count() || !await control.isVisible()) throw new Error(`visible input not found: ${pattern}`);
  await control.fill(String(value));
}

export function finalEvidence(ctx, details) { return ctx.pass([{ kind: "moderationflow-case-summary", ...details }]); }
