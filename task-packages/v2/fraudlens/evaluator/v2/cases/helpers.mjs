import assert from "node:assert/strict";
import { canonicalJson, evaluateRules, exactKeys, percentile, stableResourceBytes } from "../oracles/index.mjs";

export const V1_RESOURCE_KEYS = [
  "tenants", "ruleSets", "ruleVersions", "riskEvents", "assessments", "ruleHits",
  "reviewCases", "reviewDecisions", "ruleRollbacks", "auditEntries",
];

export const PUBLIC_PATHS = [
  "/api/v1/tenants", "/api/v1/rule-sets", "/api/v1/rule-sets/{ruleSetId}/versions",
  "/api/v1/rule-versions/{ruleVersionId}/activate", "/api/v1/rule-sets/{ruleSetId}/rollback",
  "/api/v1/risk-events", "/api/v1/assessments/{assessmentId}", "/api/v1/review-cases",
  "/api/v1/review-cases/{reviewCaseId}/claim", "/api/v1/review-cases/{reviewCaseId}/decisions",
  "/api/v1/audit", "/api/v1/verification-snapshot", "/api/v1/remediation-runs",
  "/api/v1/remediation-runs/{runId}", "/api/v1/remediation-runs/{runId}/cancel",
];

export const REMEDIATION_RUN_KEYS = [
  "remediationRunId", "tenantId", "fromRuleVersionId", "toRuleVersionId", "occurredFrom",
  "occurredTo", "state", "totalCount", "completedCount", "correctionCount", "noChangeCount",
  "createdAt", "completedAt", "cancelledAt",
];
export const CORRECTION_KEYS = [
  "assessmentCorrectionId", "remediationRunId", "assessmentId", "outcome", "oldDecision",
  "newDecision", "reason", "newRuleHitsDigest", "createdAt",
];

const META = {
  "A-01": ["FL-F-RULE", "Create and activate boundary rules, submit matching events and issue invalid mutations", "Recompute ordered RuleHits, final overflow-safe sum, clamp and thresholds independently"],
  "A-02": ["FL-F-EVENT", "Accept replayed and conflicting external events across tenants and version boundaries", "Close RiskEvent, Assessment, Work and Event identity from the public snapshot"],
  "A-03": ["FL-F-REVIEW", "Claim a REVIEW case and race current, stale and opposite decisions", "Assert one fenced terminal decision while recommendation and RuleHits remain byte-stable"],
  "A-04": ["FL-F-ROLLBACK", "Rollback an active version and accept events on both commit sides", "Assert one atomic active-version switch with immutable historical scoring and audit facts"],
  "A-05": ["FL-F-REMEDIATION", "Freeze a final-decision cohort, mutate later inputs and drain remediation Work", "Recompute every Correction and verify closed counts plus byte-stable original facts"],
  "B-01": ["FL-F-RULE-RANDOM", "Generate deterministic rule and attribute boundary combinations through public HTTP", "Compare every score, recommendation and ordered hit to the local FraudLens reference model"],
  "B-02": ["FL-F-IDENTITIES", "Exercise request-key replay and tenant external identity in all four combinations", "Assert precedence, stable responses and at most one complete atomic side effect"],
  "B-03": ["FL-F-VERSION-RACE", "Race accept, activation and rollback through two independent API processes", "Derive a legal audit order and reject mixed-version hits or multiple active versions"],
  "B-04": ["FL-F-REVIEW-RACE", "Run sixty-four claims and opposite decisions while expiry Work competes", "Assert the database fence selects one terminal state with no losing Event or Audit"],
  "B-05": ["FL-F-REMEDIATION-RACE", "Replay Remediation creation thirty-two ways then race cancel with pending Work", "Assert one frozen run, unique results, terminal exclusivity and exact count closure"],
  "C-01": ["FL-F-ASSESSMENT-CRASH", "Observe RISK_ASSESSMENT Work leased, SIGKILL its Worker and start a replacement", "Assert one frozen score and one terminal Work effect after lease reclamation"],
  "C-02": ["FL-F-EXPIRY-CRASH", "Observe REVIEW_EXPIRY Work leased, SIGKILL and race replacement against a live owner", "Assert expiry or decision wins once and no stale owner resurrects the ReviewCase"],
  "C-03": ["FL-F-REMEDIATION-CRASH", "Observe REMEDIATION_RECHECK Work leased, SIGKILL, cancel and replace", "Assert stable correction identities and that replacements cannot cross the cancel fence"],
  "C-04": ["FL-F-OUTBOX", "Return errors, disconnect after receipt and SIGKILL a known Dispatcher before retry", "Assert byte-identical Event replay and independently close every tenant audit digest chain"],
  "D-01": ["FL-F-UI-RISK", "Use production Chromium controls for rule, event, explanation, review and rollback", "Compare every visible score, hit, version and decision with public HTTP after refresh"],
  "D-02": ["FL-F-UI-REMEDIATION", "Use production Chromium to create, inspect and cancel Remediation Runs", "Compare visible progress, difference rows and terminal state with exact public GET resources"],
  "D-03": ["FL-F-CONTRACT", "Fetch OpenAPI, a full V1 snapshot and Remediation detail through public HTTP", "Validate exact routes, statuses, closed schemas, sorting and recursive secret absence"],
  "D-04": ["FL-F-CORRECTION-LINEAGE", "Capture original public bytes then complete corrected and no-change remediation", "Trace immutable Assessment explanation to one stable Correction and local hit digest"],
  "E-01": ["FL-F-MIGRATION", "Populate V1 with replay, review, pending Work and an unacknowledged Event then migrate", "Compare all V1 public bytes and identities before completing pending FINAL work"],
  "E-02": ["FL-F-PERF-INGEST", "Run the exact 100000-event concurrency-96 ingest workload", "Measure accepted throughput and p95 then recompute every frozen version and score"],
  "E-03": ["FL-F-PERF-REVIEW", "Run the exact 20000-event hot-subject concurrency-64 review workload", "Measure terminal throughput and p95 while excluding duplicate or cross-tenant decisions"],
  "E-04": ["FL-F-PERF-ROLLBACK", "Split 10000 events across rollback, kill two leased Workers and start four replacements", "Drain within ninety seconds and close every Assessment, Work, Event and audit invariant"],
};

export function defineCase(id, run) {
  const [fixtureFamily, action, oracle] = META[id] ?? [];
  if (!fixtureFamily) throw new Error(`unknown FraudLens case ${id}`);
  return Object.freeze({
    id,
    taskId: "fraudlens",
    fixtureFamily,
    action,
    oracle,
    async run(ctx) { return run(ctx); },
  });
}

export function guardedCase(id, hardCapIds, run) {
  return defineCase(id, async (ctx) => {
    try { return await run(ctx); }
    catch (error) {
      error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
      throw error;
    }
  });
}

export function findField(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) {
    const found = findField(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function successful(response, label = "mutation") {
  assert.ok(response.status >= 200 && response.status < 300, `${label} returned ${response.status}: ${response.text}`);
  return response;
}

export function semanticError(response, status, code) {
  assert.equal(response.status, status, `${code} status`);
  assert.equal(response.json?.error?.code, code, `${code} error envelope`);
  exactKeys(response.json, ["error"], `${code} response`);
  exactKeys(response.json.error, ["code", "message", "details"], `${code} error`);
}

export async function prepare(ctx, { seedVersion, apiCount = 1, workerCount = 0, receiver } = {}) {
  await ctx.migrate();
  await ctx.seed(ctx.fixtures.seed(seedVersion));
  const apis = await Promise.all(Array.from({ length: apiCount }, () => ctx.startApi()));
  const workers = await Promise.all(Array.from({ length: workerCount }, () => ctx.startWorker()));
  const dispatchers = receiver ? [await ctx.startDispatcher({ webhookUrl: receiver.url })] : [];
  ctx.mark("fraudlens.prepared", { apiCount, workerCount, dispatcherCount: dispatchers.length });
  return { api: apis[0], apis, workers, dispatchers };
}

export async function createVersion(ctx, baseUrl, suffix, { rules, reviewThreshold = 200, blockThreshold = 700 } = {}) {
  const response = successful(await ctx.mutate(
    baseUrl,
    `/api/v1/rule-sets/${ctx.fixtures.ids.ruleSetId}/versions`,
    ctx.key(`version:${suffix}`),
    { rules: rules ?? [ctx.fixtures.rule()], reviewThreshold, blockThreshold },
    { admin: true },
  ), "create RuleVersion");
  const ruleVersionId = findField(response.json, "ruleVersionId");
  assert.match(ruleVersionId, /^[0-9a-f-]{36}$/u, "RuleVersion response identity");
  return { response, ruleVersionId };
}

export async function activateVersion(ctx, baseUrl, ruleVersionId, expectedActiveRuleVersionId, suffix = ruleVersionId) {
  return successful(await ctx.mutate(
    baseUrl,
    `/api/v1/rule-versions/${ruleVersionId}/activate`,
    ctx.key(`activate:${suffix}`),
    { expectedActiveRuleVersionId },
    { admin: true },
  ), "activate RuleVersion");
}

export async function rollbackVersion(ctx, baseUrl, fromRuleVersionId, toRuleVersionId, suffix = fromRuleVersionId) {
  return successful(await ctx.mutate(
    baseUrl,
    `/api/v1/rule-sets/${ctx.fixtures.ids.ruleSetId}/rollback`,
    ctx.key(`rollback:${suffix}`),
    { fromRuleVersionId, toRuleVersionId, reason: "confirmed false-positive rollback" },
    { admin: true },
  ), "rollback RuleVersion");
}

export async function acceptRisk(ctx, baseUrl, index, overrides = {}, options = {}) {
  const payload = ctx.fixtures.event(index, overrides);
  const response = await ctx.mutate(baseUrl, "/api/v1/risk-events", options.key ?? ctx.key(`risk:${index}`), payload, { contractExpectation: options.contractExpectation });
  if (options.expectSuccess !== false) successful(response, "accept RiskEvent");
  return { payload, response };
}

export function resources(snapshot) {
  assert.ok(snapshot?.resources && Array.isArray(snapshot.work) && Array.isArray(snapshot.events), "snapshot must expose resources, work and events");
  return snapshot.resources;
}

export async function assessmentForExternal(ctx, baseUrl, externalEventId) {
  const snapshot = await ctx.snapshot(baseUrl);
  const riskEvent = resources(snapshot).riskEvents.find((item) => item.externalEventId === externalEventId);
  if (!riskEvent) return undefined;
  const assessment = snapshot.resources.assessments.find((item) => item.riskEventId === riskEvent.riskEventId);
  return assessment ? { assessment, riskEvent, snapshot } : undefined;
}

export async function waitAssessment(ctx, baseUrl, externalEventId, { terminal = true, timeoutMs = 60_000, processes = [] } = {}) {
  return ctx.waitFor(async () => {
    const found = await assessmentForExternal(ctx, baseUrl, externalEventId);
    return found && (!terminal || found.assessment.state !== "PENDING") ? found : undefined;
  }, { timeoutMs, label: `Assessment for ${externalEventId}`, processes });
}

export async function waitReviewCase(ctx, baseUrl, assessmentId, { timeoutMs = 60_000, processes = [] } = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const reviewCase = resources(snapshot).reviewCases.find((item) => item.assessmentId === assessmentId);
    return reviewCase ? { reviewCase, snapshot } : undefined;
  }, { timeoutMs, label: `ReviewCase for ${assessmentId}`, processes });
}

export function assertAssessment(snapshot, assessment, event, version) {
  const expected = evaluateRules(event, version);
  const hits = resources(snapshot).ruleHits
    .filter((item) => item.assessmentId === assessment.assessmentId)
    .map(({ ruleId, priority, score, reasonCode }) => ({ ruleId, priority, score, reasonCode }));
  assert.equal(assessment.ruleVersionId, version.ruleVersionId, "Assessment frozen RuleVersion");
  assert.equal(assessment.score, expected.score, "Assessment reference score");
  assert.equal(assessment.recommendation, expected.recommendation, "Assessment reference recommendation");
  assert.deepEqual(hits, expected.ruleHits, "Assessment ordered RuleHits");
  if (expected.recommendation === "APPROVE" || expected.recommendation === "BLOCK") assert.equal(assessment.decision, expected.recommendation, "automated decision");
  else assert.equal(assessment.decision, null, "REVIEW has no automated final decision");
}

export function activeVersion(snapshot, ruleSetId) {
  return resources(snapshot).ruleVersions.filter((item) => item.ruleSetId === ruleSetId && item.state === "ACTIVE");
}

export function captureFacts(snapshot, assessmentIds) {
  const ids = new Set(assessmentIds);
  const riskIds = new Set(resources(snapshot).assessments.filter((item) => ids.has(item.assessmentId)).map((item) => item.riskEventId));
  const reviewIds = new Set(resources(snapshot).reviewCases.filter((item) => ids.has(item.assessmentId)).map((item) => item.reviewCaseId));
  const auditIds = new Set(resources(snapshot).auditEntries.map((item) => item.auditEntryId));
  const selection = {
    riskEvents: (item) => riskIds.has(item.riskEventId),
    assessments: (item) => ids.has(item.assessmentId),
    ruleHits: (item) => ids.has(item.assessmentId),
    reviewCases: (item) => ids.has(item.assessmentId),
    reviewDecisions: (item) => reviewIds.has(item.reviewCaseId),
    auditEntries: (item) => auditIds.has(item.auditEntryId),
  };
  return { bytes: stableResourceBytes(snapshot, selection), selection };
}

export function assertFactsPreserved(snapshot, captured) {
  assert.equal(stableResourceBytes(snapshot, captured.selection), captured.bytes, "original public facts changed");
}

export async function setupRollback(ctx, baseUrl, { count = 3, suffix = "remediation", includeNoChange = true } = {}) {
  const from = await createVersion(ctx, baseUrl, `${suffix}:from`, {
    rules: [ctx.fixtures.rule({ ruleId: "strict-velocity", score: 800, reasonCode: "STRICT_VELOCITY" })],
  });
  await activateVersion(ctx, baseUrl, from.ruleVersionId, ctx.fixtures.ids.baseVersionId, `${suffix}:activate`);
  const accepted = [];
  for (let index = 0; index < count; index += 1) {
    const velocity = includeNoChange && index === count - 1 ? 0 : 9;
    accepted.push(await acceptRisk(ctx, baseUrl, 10_000 + index, { attributes: { velocity, country: "US" } }, { key: ctx.key(`${suffix}:risk:${index}`) }));
  }
  const workers = [await ctx.startWorker()];
  const completed = [];
  for (const item of accepted) completed.push(await waitAssessment(ctx, baseUrl, item.payload.externalEventId, { processes: workers }));
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const beforeRollback = await ctx.snapshot(baseUrl);
  const assessmentIds = completed.map((item) => item.assessment.assessmentId);
  const captured = captureFacts(beforeRollback, assessmentIds);
  await rollbackVersion(ctx, baseUrl, from.ruleVersionId, ctx.fixtures.ids.baseVersionId, `${suffix}:rollback`);
  return { fromRuleVersionId: from.ruleVersionId, toRuleVersionId: ctx.fixtures.ids.baseVersionId, assessmentIds, accepted, captured };
}

export async function createRemediation(ctx, baseUrl, rollback, suffix = "run") {
  const response = successful(await ctx.mutate(baseUrl, "/api/v1/remediation-runs", ctx.key(`remediation:${suffix}`), {
    tenantId: ctx.fixtures.ids.tenantId,
    fromRuleVersionId: rollback.fromRuleVersionId,
    toRuleVersionId: rollback.toRuleVersionId,
    ...ctx.fixtures.remediationRange,
  }, { admin: true }), "create RemediationRun");
  const remediationRunId = findField(response.json, "remediationRunId");
  assert.match(remediationRunId, /^[0-9a-f-]{36}$/u, "RemediationRun identity");
  return { remediationRunId, response };
}

export async function getRemediation(ctx, baseUrl, remediationRunId) {
  const response = await ctx.request(baseUrl, `/api/v1/remediation-runs/${remediationRunId}`, { headers: { authorization: `Bearer ${ctx.adminToken}` } });
  successful(response, "GET RemediationRun");
  exactKeys(response.json, ["run", "corrections"], "Remediation detail");
  return response.json;
}

export async function waitRemediation(ctx, baseUrl, remediationRunId, { terminal = true, timeoutMs = 60_000, processes = [] } = {}) {
  return ctx.waitFor(async () => {
    const detail = await getRemediation(ctx, baseUrl, remediationRunId);
    return !terminal || ["COMPLETED", "CANCELLED"].includes(detail.run.state) ? detail : undefined;
  }, { timeoutMs, label: `RemediationRun ${remediationRunId}`, processes });
}

export function assertRemediationDetail(detail, expectedAssessmentIds) {
  exactKeys(detail.run, REMEDIATION_RUN_KEYS, "RemediationRun");
  for (const correction of detail.corrections) exactKeys(correction, CORRECTION_KEYS, "AssessmentCorrection");
  assert.equal(detail.run.completedCount, detail.run.correctionCount + detail.run.noChangeCount, "Remediation count partition");
  assert.ok(detail.run.completedCount <= detail.run.totalCount, "Remediation completedCount bound");
  assert.equal(new Set(detail.corrections.map((item) => item.assessmentId)).size, detail.corrections.length, "one correction per Assessment");
  assert.ok(detail.corrections.every((item) => expectedAssessmentIds.includes(item.assessmentId)), "Correction belongs to frozen cohort");
  if (detail.run.state === "COMPLETED") {
    assert.equal(detail.run.completedCount, detail.run.totalCount, "completed Run closes all items");
    assert.deepEqual(new Set(detail.corrections.map((item) => item.assessmentId)), new Set(expectedAssessmentIds), "completed Run covers frozen cohort");
  }
}

export async function waitLeasedWork(ctx, baseUrl, predicate, { timeoutMs = 30_000, processes = [] } = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const work = snapshot.work.find((item) => item.state === "LEASED" && predicate(item));
    return work ? { work, snapshot } : undefined;
  }, { timeoutMs, label: "public Work lease", processes });
}

export async function fixedLoad(ctx, { count, concurrency, request, collectResponses = true }) {
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  const responses = collectResponses ? new Array(count) : undefined;
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const started = performance.now();
    const response = await request(index);
    latencies.push(performance.now() - started);
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    if (responses) responses[index] = response;
  });
  const durationMs = performance.now() - startedAt;
  return { responses, durationMs, throughput: count / (durationMs / 1_000), p95: percentile(latencies, 0.95), statuses: Object.fromEntries(statuses) };
}

export function assertLoad(load, { count, minimumThroughput, maximumP95 }) {
  const successfulCount = Object.entries(load.statuses).filter(([status]) => Number(status) >= 200 && Number(status) < 300).reduce((sum, [, value]) => sum + value, 0);
  const serverErrors = Object.entries(load.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, value]) => sum + value, 0);
  assert.equal(successfulCount, count, "all workload operations accepted");
  assert.equal(serverErrors, 0, "workload 5xx count");
  assert.ok(load.throughput >= minimumThroughput, `throughput ${load.throughput.toFixed(2)} < ${minimumThroughput}`);
  assert.ok(load.p95 <= maximumP95, `p95 ${load.p95.toFixed(2)} > ${maximumP95}`);
}

export async function fillVisible(page, name, value) {
  const byLabel = page.getByLabel(new RegExp(name, "i")).first();
  if (await byLabel.count()) return byLabel.fill(String(value));
  const byName = page.locator(`[name="${name}"]`).first();
  assert.ok(await byName.count(), `visible control ${name}`);
  return byName.fill(String(value));
}

export async function clickVisible(page, name) {
  const button = page.getByRole("button", { name: new RegExp(name, "i") }).first();
  assert.ok(await button.count(), `visible action ${name}`);
  await button.click();
}

export async function launchProductionBrowser(ctx) {
  await ctx.npm("build", [], { timeoutMs: 180_000 });
  const app = await ctx.startDev({ healthTimeoutMs: 60_000 });
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  ctx.defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  return { app, browser, page };
}

export function assertV1SnapshotShape(snapshot) {
  assert.deepEqual(Object.keys(resources(snapshot)).sort(), V1_RESOURCE_KEYS.sort(), "V1 snapshot resources exact members");
  for (const key of V1_RESOURCE_KEYS) assert.ok(Array.isArray(snapshot.resources[key]), `${key} must be an array`);
}

export function resourceBytes(value) {
  return canonicalJson(value);
}
