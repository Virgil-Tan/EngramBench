import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";

import { accountCatalog, createFixtureFactory, ledgerSeed, legacyTransferBody, multiTransferBody } from "./fixtures.mjs";
import { canonical, sha256 } from "./oracle.mjs";

const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL
  ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);

const BLOCKED_ASSERTIONS = Object.freeze({
  "A-05": new Map([["legacy-one-leg-statement-leg-shape", "LB-GAP-01"]]),
  "D-03": new Map([["legacy-one-leg-statement-leg-shape", "LB-GAP-01"]]),
});
const BARRIER_KEYS = ["schemaVersion", "processRole", "point", "workId", "aggregateId", "attempt", "leaseTokenHash"];

function identityResponse(_adapter, { json }) { return json; }
function assertNoCompatibilityAdapter(value) {
  if (value !== undefined && value !== null) throw new Error("LedgerBridge does not publish a response compatibility adapter");
}

export function isLedgerBarrier(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...BARRIER_KEYS].sort())) return false;
  const validPoint = value.processRole === "worker"
    ? ["worker.claimed", "worker.effect-complete", "worker.before-commit"].includes(value.point)
    : value.processRole === "dispatcher" && value.point === "dispatcher.response-received";
  return value.schemaVersion === 1 && validPoint
    && typeof value.workId === "string" && typeof value.aggregateId === "string"
    && Number.isSafeInteger(value.attempt) && value.attempt >= 1
    && typeof value.leaseTokenHash === "string" && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash);
}

const runtime = shared.createCaseRuntime({
  taskSlug: "ledgerbridge",
  databasePrefix: "lb",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: identityResponse,
  assertCompatibilityAdapter: assertNoCompatibilityAdapter,
  validateBarrierPayload: isLedgerBarrier,
});

class ScenarioFailure extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ScenarioFailure";
    this.failureCodeSuffix = options.failureCodeSuffix ?? "ASSERTION_FAILED";
    this.hardCapIds = options.hardCapIds ?? [];
  }
}

class Evidence {
  constructor(caseId) {
    this.assertions = [];
    this.statuses = new Map();
    this.metrics = {};
    this.blockedAssertions = [];
    this.expectedBlocked = BLOCKED_ASSERTIONS[caseId] ?? new Map();
  }
  check(label, operation, options = {}) {
    try { operation(); this.assertions.push({ label, status: "passed" }); }
    catch (cause) {
      this.assertions.push({ label, status: "failed" });
      throw new ScenarioFailure(`${label}: ${cause instanceof Error ? cause.message : String(cause)}`, {
        cause, failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds,
      });
    }
  }
  blocked(assertionId, blockedBy) {
    if (this.expectedBlocked.get(assertionId) !== blockedBy) throw new shared.EvaluationInfrastructureError("EVALUATOR_UNDECLARED_BLOCKED_ASSERTION", "EVALUATOR_UNDECLARED_BLOCKED_ASSERTION");
    if (!this.blockedAssertions.some((item) => item.assertionId === assertionId)) {
      this.blockedAssertions.push({ assertionId, blockedBy, policy: "fail-closed-diagnostic" });
      this.assertions.push({ label: assertionId, status: "blocked", blockedBy });
    }
  }
  finish() {
    for (const [assertionId, blockedBy] of this.expectedBlocked) {
      if (!this.blockedAssertions.some((item) => item.assertionId === assertionId && item.blockedBy === blockedBy)) throw new shared.EvaluationInfrastructureError("EVALUATOR_MISSING_BLOCKED_DIAGNOSTIC", "EVALUATOR_MISSING_BLOCKED_DIAGNOSTIC");
    }
    return { assertions: this.assertions, statuses: Object.fromEntries([...this.statuses.entries()].sort()), metrics: this.metrics, blockedAssertions: this.blockedAssertions };
  }
}

async function decorateContext(context) {
  const evidence = new Evidence(context.caseId);
  const originalRequest = context.request;
  const fixtureKey = context.key;
  let keySequence = 0;
  let seedSequence = 0;
  context.evidence = evidence;
  context.key = (label) => fixtureKey(`${label}-${keySequence++}`);
  context.catalog = (options = {}) => accountCatalog(context.fixtures, options);
  context.seedFor = (seedVersion, options = {}) => ledgerSeed(context.fixtures, seedVersion, options);
  context.legacyBody = (catalog, amount, overrides) => legacyTransferBody(catalog, amount, overrides);
  context.multiBody = (catalog, amounts, overrides) => multiTransferBody(catalog, amounts, overrides);
  context.assert = (label, operation, options) => evidence.check(label, operation, options);
  context.equal = (label, actual, expected, options) => evidence.check(label, () => assert.deepEqual(actual, expected), options);
  context.ok = (label, condition, message, options) => evidence.check(label, () => assert.ok(condition, message), options);
  context.blocked = (assertionId, blockedBy) => evidence.blocked(assertionId, blockedBy);
  context.metric = (name, value) => { evidence.metrics[name] = value; };
  context.sleep = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
  context.canonical = canonical;
  context.sha256 = sha256;
  context.request = async (baseUrl, path, options = {}) => {
    const response = await originalRequest(baseUrl, path, options);
    if (options.record !== false) evidence.statuses.set(String(response.status), (evidence.statuses.get(String(response.status)) ?? 0) + 1);
    return response;
  };
  context.seed = async (value, options = {}) => {
    const path = context.tempPath(`ledgerbridge-seed-${String(seedSequence += 1).padStart(3, "0")}.json`);
    await writeFile(path, JSON.stringify(value));
    const result = await context.npm("db:seed", ["--file", path], { workspace: options.workspace, timeoutMs: options.timeoutMs ?? 900_000, allowFailure: true });
    if (options.expectFailure) context.ok("invalid seed exits nonzero", result.exitCode !== 0, undefined, { failureCodeSuffix: "SEED_ACCEPTED_INVALID_INPUT" });
    else context.equal("valid seed exits zero", result.exitCode, 0, { failureCodeSuffix: "SEED_FAILED" });
    return result;
  };
  context.createTransfer = (baseUrl, body, options = {}) => context.mutate(baseUrl, "/api/v1/transfers", options.key ?? context.key("create-transfer"), body, { timeoutMs: options.timeoutMs });
  context.getTransfer = (baseUrl, transferId) => context.request(baseUrl, `/api/v1/transfers/${transferId}`);
  context.listTransfers = (baseUrl, query = "limit=100") => context.request(baseUrl, `/api/v1/transfers?${query}`);
  context.cancelTransfer = (baseUrl, transferId, options = {}) => context.mutate(baseUrl, `/api/v1/transfers/${transferId}/cancel`, options.key ?? context.key("cancel-transfer"), {}, { timeoutMs: options.timeoutMs });
  context.reverseTransfer = (baseUrl, transferId, options = {}) => context.mutate(baseUrl, `/api/v1/transfers/${transferId}/reverse`, options.key ?? context.key("reverse-transfer"), { reason: options.reason ?? "evaluator" }, { timeoutMs: options.timeoutMs });
  context.getAccount = (baseUrl, accountId) => context.request(baseUrl, `/api/v1/accounts/${accountId}`);
  context.getStatement = (baseUrl, accountId, query = "limit=100") => context.request(baseUrl, `/api/v1/accounts/${accountId}/statement?${query}`);
  context.getEvents = (baseUrl, query = "limit=100") => context.request(baseUrl, `/api/v1/domain-events?${query}`);
  context.workerBarrier = (points, predicate = () => true) => {
    const accepted = new Set(Array.isArray(points) ? points : [points]);
    return context.barrier({ hold: (payload) => payload.processRole === "worker" && accepted.has(payload.point) && predicate(payload) });
  };
  context.dispatcherBarrier = (predicate = () => true) => context.barrier({ hold: (payload) => payload.processRole === "dispatcher" && payload.point === "dispatcher.response-received" && predicate(payload) });
  context.startWorkerAtBarrier = (barrier, options = {}) => context.startWorker({ ...options, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, ...(options.env ?? {}) } });
  context.startDispatcherAtBarrier = (receiver, barrier, options = {}) => context.startDispatcher({ ...options, webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, ...(options.env ?? {}) } });
  context.readOpenApi = async (baseUrl) => {
    const response = await context.request(baseUrl, "/openapi.json");
    context.equal("OpenAPI route returns 200", response.status, 200);
    context.ok("OpenAPI body is an object", response.json && typeof response.json === "object");
    return response.json;
  };
  context.withPage = (api, viewport, operation) => withPage(context, api, viewport, operation);
  return context;
}

export async function createCaseContext(options) { return decorateContext(await runtime.createCaseContext(options)); }
export async function withCaseContext(options, operation) {
  return runtime.withCaseContext(options, async (rawContext) => {
    const context = await decorateContext(rawContext);
    if (context.caseId !== "E-01") await context.migrate();
    const outcome = await operation(context);
    const unexpected5xx = [...context.evidence.statuses].filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0);
    context.equal("no unexpected HTTP 5xx", unexpected5xx, 0);
    const result = context.evidence.finish();
    return { ...outcome, evidence: { ...result, caseEvidence: outcome?.evidence ?? [] }, ...(result.blockedAssertions.length ? { blockedAssertions: result.blockedAssertions } : {}) };
  });
}

async function chromiumExecutable() {
  for (const candidate of [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE", "EVALUATOR_CHROMIUM_UNAVAILABLE");
}

async function withPage(context, api, viewport, operation) {
  let chromium;
  try { ({ chromium } = await import("playwright-core")); }
  catch (cause) { throw new shared.EvaluationInfrastructureError("EVALUATOR_PLAYWRIGHT_UNAVAILABLE", "EVALUATOR_PLAYWRIGHT_UNAVAILABLE", { cause }); }
  const browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const browserContext = await browser.newContext({ viewport, baseURL: api.baseUrl });
  const page = await browserContext.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource.*4\d\d/iu.test(message.text())) errors.push(message.text()); });
  try {
    await operation(page);
    context.equal("production browser has no page or console errors", errors, []);
    context.equal("production browser has no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  } finally { await browserContext.close(); await browser.close(); }
}

export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
