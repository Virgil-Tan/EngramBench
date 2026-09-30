import assert from "node:assert/strict";

import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { makeCoreSeed } from "../fixtures/index.mjs";
import {
  assertContiguousEvents,
  canonicalJson,
  compareResult,
  evaluateRuleSet,
  percentile,
  sha256Canonical,
} from "../oracles/index.mjs";

export { canonicalJson, percentile, sha256Canonical } from "../oracles/index.mjs";

const buildByWorkspace = new Map();

export const EVALUATION_KEYS = Object.freeze([
  "evaluationId", "tenantId", "ruleSetId", "ruleSetVersionId", "factsDigest", "state",
  "decision", "tags", "matchedRuleIds", "explanationDigest", "createdAt", "completedAt", "sequence",
]);
export const REPLAY_KEYS = Object.freeze([
  "replayRunId", "evaluationId", "state", "resultDigest", "createdAt", "completedAt",
]);
export const COMPARISON_RUN_KEYS = Object.freeze([
  "comparisonRunId", "tenantId", "ruleSetId", "baselineVersionId", "candidateVersionId",
  "evaluationIds", "corpusDigest", "state", "revision", "resultCounts", "createdAt", "startedAt",
  "completedAt", "cancelledAt", "promotedAt",
]);
export const COMPARISON_RESULT_KEYS = Object.freeze([
  "comparisonRunId", "evaluationId", "ordinal", "status", "baseline", "candidate", "errorCode", "resultDigest",
]);
export const SNAPSHOT_RESOURCE_KEYS = Object.freeze([
  "tenants", "ruleSets", "ruleSetVersions", "rules", "evaluations", "explanationNodes",
  "replayRuns", "conflictReports", "comparisonRuns", "comparisonResults",
]);

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !/^RB-F-/u.test(fixtureFamily ?? "") || action?.length <= 20 || oracle?.length <= 20 || typeof run !== "function") {
    throw new TypeError("invalid RuleBench case definition");
  }
  return Object.freeze({ id, fixtureFamily, action, oracle, run });
}

export function guardedCase(definition, hardCapIds = []) {
  return defineCase({
    ...definition,
    async run(ctx) {
      try { return await definition.run(ctx); }
      catch (error) {
        if (error && typeof error === "object") error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
        throw error;
      }
    },
  });
}

export function candidateFailure(message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) {
  throw new CaseFailure(message, { failureCodeSuffix, hardCapIds });
}

export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has a non-contract field set`);
  return value;
}

export function expectStatus(ctx, response, status, label, options = {}) {
  ctx.equal(response.status, status, `${label} HTTP status`, options);
  return response.json;
}

export function expectSuccess(ctx, response, label, status = 200, options = {}) {
  expectStatus(ctx, response, status, label, options);
  ctx.ok(response.json && typeof response.json === "object", `${label} JSON response`, options);
  return response.json;
}

export function expectError(ctx, response, status, code, label, options = {}) {
  expectStatus(ctx, response, status, `${label} error`, options);
  exactKeys(response.json, ["error"], `${label} error envelope`);
  const error = response.json.error;
  exactKeys(error, ["code", "message", "details"], `${label} error`);
  ctx.equal(error.code, code, `${label} error code`, options);
  ctx.ok(typeof error.message === "string" && error.message.length > 0, `${label} error message`, options);
  ctx.ok(Array.isArray(error.details), `${label} error details`, options);
  return error;
}

export function collection(json, label = "collection") {
  exactKeys(json, ["items", "nextCursor"], label);
  assert.ok(Array.isArray(json.items), `${label}.items must be an array`);
  assert.ok(json.nextCursor === null || typeof json.nextCursor === "string", `${label}.nextCursor must be null or opaque text`);
  return json.items;
}

export function fixtureOptions(ctx) {
  return { evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime };
}

export function coreFixture(ctx, settings = {}) {
  return makeCoreSeed(fixtureOptions(ctx), settings);
}

export function clone(value) { return structuredClone(value); }

export function replaceVersionRules(fixture, versionId, rules, fields = {}) {
  fixture.seed.rules = fixture.seed.rules.filter(({ ruleSetVersionId }) => ruleSetVersionId !== versionId).concat(rules);
  const version = fixture.seed.ruleSetVersions.find(({ ruleSetVersionId }) => ruleSetVersionId === versionId);
  if (!version) throw new Error(`missing fixture RuleSetVersion ${versionId}`);
  Object.assign(version, fields, { rulesDigest: sha256Canonical(rules) });
  if (versionId === fixture.ids.baselineVersionId) fixture.baselineRules = rules;
  if (versionId === fixture.ids.candidateVersionId) fixture.candidateRules = rules;
  if (versionId === fixture.ids.errorVersionId) fixture.errorRules = rules;
  if (versionId === fixture.ids.draftVersionId) fixture.draftRules = rules;
  return fixture;
}

export function rule(ctx, versionId, label, fields = {}) {
  return {
    ruleId: ctx.uuid(`rule-${label}`),
    ruleSetVersionId: versionId,
    priority: fields.priority ?? 1,
    name: fields.name ?? String(label),
    condition: fields.condition ?? { op: "exists", path: "$.value", value: true },
    effect: fields.effect ?? { decision: "ALLOW", tags: [] },
    terminal: fields.terminal ?? false,
  };
}

async function ensureBuild(ctx, workspace) {
  const target = ctx.forWorkspace(workspace);
  if (!buildByWorkspace.has(target.workspace)) {
    buildByWorkspace.set(target.workspace, target.npm("build", [], { timeoutMs: 600_000 }));
  }
  await buildByWorkspace.get(target.workspace);
}

export async function prepare(ctx, options = {}) {
  const workspace = options.workspace ?? ctx.workspace;
  const target = ctx.forWorkspace(workspace);
  if (options.build !== false) await ensureBuild(ctx, workspace);
  if (options.migrate !== false) {
    await target.migrate({ timeoutMs: 300_000 });
    if (options.migrateTwice) await target.migrate({ timeoutMs: 300_000 });
  }
  if (options.seed) await target.seed(options.seed, { timeoutMs: options.seedTimeoutMs ?? 600_000 });
  ctx.mark("candidate-prepared", { workspace: target.workspace, seeded: Boolean(options.seed) });
  return target;
}

export async function startPreparedApi(ctx, options = {}) {
  const target = await prepare(ctx, options);
  return target.startApi(options.api ?? {});
}

export function evaluationRequest(fixture, facts, versionId = fixture.ids.baselineVersionId) {
  return {
    tenantId: fixture.ids.tenantId,
    ruleSetId: fixture.ids.ruleSetId,
    ruleSetVersionId: versionId,
    facts,
  };
}

export async function createEvaluation(ctx, baseUrl, fixture, facts, options = {}) {
  const body = options.body ?? evaluationRequest(fixture, facts, options.versionId);
  const response = await ctx.mutate(baseUrl, "/api/v1/evaluations", options.key ?? ctx.key(`evaluation-${ctx.evidence.length}`), body);
  expectSuccess(ctx, response, options.label ?? "create Evaluation", options.status ?? 200, options.assertionOptions);
  exactKeys(response.json, EVALUATION_KEYS, options.label ?? "Evaluation response");
  return { response, evaluation: response.json, body };
}

export async function readEvaluation(ctx, baseUrl, evaluationId) {
  const response = await ctx.request(baseUrl, `/api/v1/evaluations/${evaluationId}`);
  expectSuccess(ctx, response, `read Evaluation ${evaluationId}`);
  exactKeys(response.json, EVALUATION_KEYS, "Evaluation read");
  return response.json;
}

export async function waitForEvaluation(ctx, baseUrl, evaluationId, states = "COMPLETED", options = {}) {
  const accepted = new Set(Array.isArray(states) ? states : [states]);
  return ctx.waitFor(async () => {
    const response = await ctx.request(baseUrl, `/api/v1/evaluations/${evaluationId}`, { timeoutMs: 2_000 }).catch(() => undefined);
    return response?.status === 200 && accepted.has(response.json?.state) ? response.json : false;
  }, {
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: options.intervalMs ?? 20,
    label: options.label ?? `Evaluation ${evaluationId} ${[...accepted].join("/")}`,
    processes: options.processes,
  });
}

export async function createReplay(ctx, baseUrl, evaluationId, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/evaluations/${evaluationId}/replay`, options.key ?? ctx.key(`replay-${evaluationId}`), {});
  expectSuccess(ctx, response, options.label ?? "create ReplayRun");
  exactKeys(response.json, REPLAY_KEYS, "ReplayRun response");
  return { response, replay: response.json };
}

export async function waitForReplay(ctx, baseUrl, replayRunId, states = ["MATCHED", "DIVERGED", "FAILED"], options = {}) {
  const accepted = new Set(Array.isArray(states) ? states : [states]);
  return ctx.waitFor(async () => {
    const response = await ctx.request(baseUrl, `/api/v1/replay-runs/${replayRunId}`, { timeoutMs: 2_000 }).catch(() => undefined);
    return response?.status === 200 && accepted.has(response.json?.state) ? response.json : false;
  }, {
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: options.intervalMs ?? 20,
    label: options.label ?? `ReplayRun ${replayRunId} terminal`,
    processes: options.processes,
  });
}

export function comparisonRequest(fixture, evaluationIds, options = {}) {
  return {
    tenantId: fixture.ids.tenantId,
    ruleSetId: fixture.ids.ruleSetId,
    baselineVersionId: options.baselineVersionId ?? fixture.ids.baselineVersionId,
    candidateVersionId: options.candidateVersionId ?? fixture.ids.candidateVersionId,
    evaluationIds,
  };
}

export async function createComparison(ctx, baseUrl, fixture, evaluationIds, options = {}) {
  const body = options.body ?? comparisonRequest(fixture, evaluationIds, options);
  const response = await ctx.mutate(baseUrl, "/api/v1/comparison-runs", options.key ?? ctx.key(`comparison-${ctx.evidence.length}`), body);
  expectSuccess(ctx, response, options.label ?? "create ComparisonRun");
  exactKeys(response.json, ["run"], "ComparisonRun create wrapper");
  exactKeys(response.json.run, COMPARISON_RUN_KEYS, "ComparisonRun");
  return { response, run: response.json.run, body };
}

export async function startComparison(ctx, baseUrl, run, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/comparison-runs/${run.comparisonRunId}/start`, options.key ?? ctx.key(`start-${run.comparisonRunId}`), {
    expectedRevision: options.expectedRevision ?? run.revision,
  });
  expectSuccess(ctx, response, options.label ?? "start ComparisonRun");
  exactKeys(response.json, ["run"], "ComparisonRun start wrapper");
  exactKeys(response.json.run, COMPARISON_RUN_KEYS, "started ComparisonRun");
  return { response, run: response.json.run };
}

export async function readComparison(ctx, baseUrl, comparisonRunId) {
  const response = await ctx.request(baseUrl, `/api/v1/comparison-runs/${comparisonRunId}`);
  expectSuccess(ctx, response, "read ComparisonRun");
  exactKeys(response.json, ["run", "results"], "ComparisonRun detail wrapper");
  exactKeys(response.json.run, COMPARISON_RUN_KEYS, "ComparisonRun detail");
  assert.ok(Array.isArray(response.json.results), "ComparisonRun results must be an array");
  response.json.results.forEach((item) => exactKeys(item, COMPARISON_RESULT_KEYS, "ComparisonResult"));
  return response.json;
}

export async function waitForComparison(ctx, baseUrl, comparisonRunId, states = ["COMPLETED", "CANCELLED", "FAILED"], options = {}) {
  const accepted = new Set(Array.isArray(states) ? states : [states]);
  return ctx.waitFor(async () => {
    const response = await ctx.request(baseUrl, `/api/v1/comparison-runs/${comparisonRunId}`, { timeoutMs: 5_000 }).catch(() => undefined);
    return response?.status === 200 && accepted.has(response.json?.run?.state) ? response.json : false;
  }, {
    timeoutMs: options.timeoutMs ?? 90_000,
    intervalMs: options.intervalMs ?? 50,
    label: options.label ?? `ComparisonRun ${comparisonRunId} terminal`,
    processes: options.processes,
  });
}

export function snapshotResources(snapshot) {
  assert.ok(snapshot?.resources && typeof snapshot.resources === "object" && !Array.isArray(snapshot.resources), "snapshot.resources must be an object");
  return snapshot.resources;
}

export function resource(snapshot, key) {
  const value = snapshotResources(snapshot)[key];
  assert.ok(Array.isArray(value), `snapshot resource ${key} must be an array`);
  return value;
}

export function byId(items, field, value) { return items.find((item) => item?.[field] === value); }

export async function waitForWork(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const found = (snapshot.work ?? []).find(predicate);
    return found ? { snapshot, work: found } : false;
  }, {
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: options.intervalMs ?? 10,
    label: options.label ?? "observable Work",
    processes: options.processes,
  });
}

export function outcomeFor(fixture, versionId, facts) {
  const version = fixture.seed.ruleSetVersions.find(({ ruleSetVersionId }) => ruleSetVersionId === versionId);
  const rules = fixture.seed.rules.filter(({ ruleSetVersionId }) => ruleSetVersionId === versionId);
  if (!version) throw new Error(`fixture lacks RuleSetVersion ${versionId}`);
  return evaluateRuleSet({ rules, defaultDecision: version.defaultDecision, facts });
}

function nodeProjection(node) {
  return {
    ordinal: node.ordinal,
    ruleId: node.ruleId,
    path: node.path,
    result: node.result,
    reason: node.reason,
  };
}

export function assertEvaluationOracle(ctx, snapshot, fixture, evaluationId, facts, versionId = fixture.ids.baselineVersionId) {
  const evaluation = byId(resource(snapshot, "evaluations"), "evaluationId", evaluationId);
  ctx.ok(evaluation, `snapshot contains Evaluation ${evaluationId}`);
  const expected = outcomeFor(fixture, versionId, facts);
  ctx.equal(evaluation.ruleSetVersionId, versionId, "Evaluation freezes RuleSetVersion");
  ctx.equal(evaluation.factsDigest, sha256Canonical(facts), "Evaluation facts digest");
  ctx.equal(evaluation.decision, expected.decision, "Evaluation decision", { hardCapIds: ["DETERMINISTIC_EVALUATION"] });
  ctx.equal(evaluation.tags, expected.tags, "Evaluation tags", { hardCapIds: ["DETERMINISTIC_EVALUATION"] });
  ctx.equal(evaluation.matchedRuleIds, expected.matchedRuleIds, "Evaluation matched Rule order", { hardCapIds: ["DETERMINISTIC_EVALUATION"] });
  const nodes = resource(snapshot, "explanationNodes").filter((item) => item.evaluationId === evaluationId).sort((left, right) => left.ordinal - right.ordinal);
  ctx.equal(nodes.length, expected.nodes.length, "ExplanationNode oracle length", { hardCapIds: ["DETERMINISTIC_EVALUATION"] });
  for (let index = 0; index < nodes.length; index += 1) {
    ctx.equal(nodeProjection(nodes[index]), expected.nodes[index], `ExplanationNode oracle at index ${index}`, { hardCapIds: ["DETERMINISTIC_EVALUATION"] });
  }
  ctx.equal(evaluation.explanationDigest, expected.explanationDigest, "independent explanation digest", { hardCapIds: ["DETERMINISTIC_EVALUATION"] });
  ctx.equal(sha256Canonical(nodes.map(nodeProjection)), evaluation.explanationDigest, "public nodes recompute explanation digest", { hardCapIds: ["DETERMINISTIC_EVALUATION"] });
  return { evaluation, nodes, expected };
}

export function expectedComparisonResult(fixture, evaluationId, ordinal, facts, options = {}) {
  let baseline = null;
  let candidate = null;
  let errorCode = null;
  try {
    const outcome = outcomeFor(fixture, options.baselineVersionId ?? fixture.ids.baselineVersionId, facts);
    baseline = { decision: outcome.decision, tags: outcome.tags, explanationDigest: outcome.explanationDigest };
  } catch { errorCode = "DETERMINISTIC_EVALUATION_FAILED"; }
  try {
    const outcome = outcomeFor(fixture, options.candidateVersionId ?? fixture.ids.candidateVersionId, facts);
    candidate = { decision: outcome.decision, tags: outcome.tags, explanationDigest: outcome.explanationDigest };
  } catch { errorCode = "DETERMINISTIC_EVALUATION_FAILED"; }
  return compareResult({ comparisonRunId: options.comparisonRunId, evaluationId, ordinal, baseline, candidate, errorCode });
}

export function assertComparisonResult(ctx, actual, expected) {
  exactKeys(actual, COMPARISON_RESULT_KEYS, "ComparisonResult");
  if (expected.status === "ERROR") {
    ctx.equal({
      comparisonRunId: actual.comparisonRunId,
      evaluationId: actual.evaluationId,
      ordinal: actual.ordinal,
      status: actual.status,
    }, {
      comparisonRunId: expected.comparisonRunId,
      evaluationId: expected.evaluationId,
      ordinal: expected.ordinal,
      status: "ERROR",
    }, `ComparisonResult ${actual.evaluationId} ERROR identity`, { hardCapIds: ["COMPARISON_ATOMICITY"] });
    ctx.ok(typeof actual.errorCode === "string" && actual.errorCode.length > 0, "ERROR Result has a stable errorCode", { hardCapIds: ["COMPARISON_ATOMICITY"] });
    ctx.ok(actual.baseline === null || actual.candidate === null, "ERROR Result exposes a failed side", { hardCapIds: ["COMPARISON_ATOMICITY"] });
  } else {
    ctx.equal(actual, expected, `ComparisonResult ${actual.evaluationId}`, { hardCapIds: ["COMPARISON_ATOMICITY"] });
  }
  const projection = Object.fromEntries(Object.entries(actual).filter(([key]) => key !== "resultDigest"));
  ctx.equal(actual.resultDigest, sha256Canonical(projection), "ComparisonResult canonical digest", { hardCapIds: ["COMPARISON_ATOMICITY"] });
}

export function assertEventLedger(ctx, events) {
  try { return assertContiguousEvents(events); }
  catch (error) { candidateFailure(error.message, "EVENT_LEDGER", ["WORK_RECOVERY"]); }
}

export function factsAtCanonicalBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 16) throw new TypeError("facts byte target must be a positive safe integer");
  const overhead = Buffer.byteLength(canonicalJson({ payload: "" }));
  const facts = { payload: "x".repeat(bytes - overhead) };
  assert.equal(Buffer.byteLength(canonicalJson(facts)), bytes);
  return facts;
}

export function stableSnapshot(snapshot) {
  return {
    resources: clone(snapshot.resources),
    work: clone(snapshot.work),
    events: clone(snapshot.events),
  };
}

export function finalEvidence(ctx, values = {}) {
  return ctx.pass({ evidence: [{ kind: "rulebench-case-summary", ...values }] });
}

export function noSensitiveText(value) {
  const text = typeof value === "string" ? value : canonicalJson(value);
  return !/postgres(?:ql)?:\/\/|authorization|admin[_-]?token|test[_-]?barrier|DATABASE_URL|facts\s*[:=]/iu.test(text);
}

export async function launchBrowser(ctx, baseUrl, options = {}) {
  const chromium = await ctx.loadChromium();
  const executablePath = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
  const browser = await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox"] });
  ctx.defer(() => browser.close());
  const browserContext = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 } });
  const page = await browserContext.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return { browser, browserContext, page };
}

export async function firstVisible(locator) {
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return undefined;
}

export async function visibleControl(page, role, name) {
  const locator = page.getByRole(role, { name });
  const selected = await firstVisible(locator);
  if (!selected) throw new Error(`production UI has no visible ${role} matching ${name}`);
  return selected;
}

export async function setNamedField(page, label, value) {
  const labelled = await firstVisible(page.getByLabel(label));
  if (!labelled) throw new Error(`production UI has no field labelled ${label}`);
  const tag = await labelled.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "select") {
    try { await labelled.selectOption({ value: String(value) }); }
    catch { await labelled.selectOption({ label: String(value) }); }
  } else await labelled.fill(typeof value === "string" ? value : JSON.stringify(value));
  return labelled;
}

export async function waitForVisibleText(page, pattern, timeout = 60_000) {
  const locator = page.locator("main, [role=status], [role=alert], [aria-live]:not([aria-live=off])").filter({ hasText: pattern });
  await locator.first().waitFor({ timeout });
  return locator.first();
}


export function formalPerformanceScale() {
  const raw = process.env.BENCH_PERF_SCALE ?? "1";
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error(`invalid BENCH_PERF_SCALE ${raw}`);
  if (scale !== 1 && process.env.BENCH_ALLOW_NON_SCORING !== "1") throw new CaseExcluded("non_formal_performance_mode");
  return scale;
}

export function scaledCount(publicCount, scale, smokeMinimum) {
  return scale === 1 ? publicCount : Math.min(publicCount, Math.max(smokeMinimum, Math.ceil(publicCount * scale)));
}

export async function fixedLoad({ count, concurrency, operation }) {
  let next = 0;
  const latencies = [];
  const statuses = new Map();
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      const started = performance.now();
      let response;
      try { response = await operation(index); }
      catch { response = { status: 0 }; }
      latencies.push(performance.now() - started);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    }
  }));
  const durationMs = Math.max(1, performance.now() - startedAt);
  return {
    count,
    durationMs,
    throughput: count / (durationMs / 1_000),
    p50Ms: percentile(latencies, 0.50),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    statuses: Object.fromEntries([...statuses].sort(([left], [right]) => left - right)),
  };
}

export function assertSuccessfulLoad(ctx, metric, thresholds, label) {
  const accepted = Object.entries(metric.statuses).filter(([status]) => Number(status) >= 200 && Number(status) < 300).reduce((sum, [, count]) => sum + count, 0);
  const unexpected5xx = Object.entries(metric.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0);
  ctx.equal(accepted, metric.count, `${label} accepted count`);
  ctx.equal(unexpected5xx, 0, `${label} unexpected 5xx`);
  ctx.ok(metric.throughput >= thresholds.throughput, `${label} throughput ${metric.throughput.toFixed(1)} < ${thresholds.throughput}`);
  ctx.ok(metric.p95Ms <= thresholds.p95Ms, `${label} p95 ${metric.p95Ms.toFixed(1)}ms > ${thresholds.p95Ms}ms`);
}

export async function processRss(ctx, records) {
  return (await Promise.all(records.map((record) => ctx.rssBytes(record)))).reduce((sum, value) => sum + value, 0);
}
