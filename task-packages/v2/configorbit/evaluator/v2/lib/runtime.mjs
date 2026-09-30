import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { assignmentBucket, baseCatalog, canonical, createFixtureFactory, performanceContract, trainBody, v1Seed } from "./fixtures.mjs";
const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);
function identity(_adapter, { json }) { return json; }
function noAdapter(value) { if (value != null)
    throw new Error("ConfigOrbit publishes no evaluator response adapter"); }
export function isConfigOrbitBarrier(value) { if (!value || typeof value !== "object" || Array.isArray(value))
    return false; if (value.processRole === "worker")
    return value.point === "worker.claimed" && typeof value.workId === "string" && typeof value.aggregateId === "string" && Number.isSafeInteger(value.attempt) && value.attempt >= 1; if (value.processRole === "dispatcher")
    return typeof value.workId === "string" && typeof value.aggregateId === "string"; return false; }
const runtime = shared.createCaseRuntime({ taskSlug: "configorbit", databasePrefix: "co", snapshotPath: "/api/v1/verification-snapshot", createFixtureFactory, adaptCompatibilityResponse: identity, assertCompatibilityAdapter: noAdapter, validateBarrierPayload: isConfigOrbitBarrier });
class ScenarioFailure extends Error {
    constructor(message, options = {}) { super(message, { cause: options.cause }); this.origin = "candidate"; this.failureCodeSuffix = options.failureCodeSuffix ?? "ASSERTION_FAILED"; this.hardCapIds = options.hardCapIds ?? []; }
}
class Evidence {
    constructor() { this.assertions = []; this.statuses = new Map(); this.metrics = {}; }
    check(label, operation, options = {}) { try {
        operation();
        this.assertions.push({ label, status: "passed" });
    }
    catch (cause) {
        shared.assertCandidateError(cause);
        this.assertions.push({ label, status: "failed" });
        throw new ScenarioFailure(`${label}: ${cause?.message ?? cause}`, { ...options, cause });
    } }
    finish() { return { assertions: this.assertions, statuses: Object.fromEntries([...this.statuses.entries()].sort()), metrics: this.metrics }; }
}
async function decorate(ctx) {
    const evidence = new Evidence(), originalRequest = ctx.request, fixtureKey = ctx.key;
    let keys = 0, seeds = 0;
    ctx.evidence = evidence;
    ctx.key = (label) => fixtureKey(`${label}-${keys++}`);
    ctx.catalog = (label, options) => baseCatalog(ctx.fixtures, label, options);
    ctx.seedFor = (label, options) => v1Seed(ctx.fixtures, label, options);
    ctx.trainBody = (catalog, options) => trainBody(catalog, options);
    ctx.assignmentBucket = assignmentBucket;
    ctx.performanceContract = performanceContract();
    ctx.canonical = canonical;
    ctx.assert = (label, operation, options) => evidence.check(label, operation, options);
    ctx.equal = (label, actual, expected, options) => evidence.check(label, () => assert.deepEqual(actual, expected), options);
    ctx.ok = (label, value, message, options) => evidence.check(label, () => assert.ok(value, message), options);
    ctx.metric = (name, value) => { evidence.metrics[name] = value; };
    ctx.sleep = (ms) => new Promise((done) => setTimeout(done, ms));
    ctx.request = async (baseUrl, path, options = {}) => { const response = await originalRequest(baseUrl, path, options); if (options.record !== false)
        evidence.statuses.set(String(response.status), (evidence.statuses.get(String(response.status)) ?? 0) + 1); return response; };
    ctx.seed = async (value, options = {}) => { const path = ctx.tempPath(`configorbit-seed-${String(++seeds).padStart(3, "0")}.json`); await writeFile(path, JSON.stringify(value)); const result = await ctx.seedFile(path, { workspace: options.workspace, timeoutMs: options.timeoutMs ?? 3600000, allowFailure: true, contractExpectation: options.contractExpectation }); if (options.expectFailure)
        ctx.ok("invalid seed exits nonzero", result.exitCode !== 0, undefined, { failureCodeSuffix: "SEED_ACCEPTED_INVALID", hardCapIds: ["MIGRATION_CORRECTNESS"] });
    else
        ctx.equal("valid seed exits zero", result.exitCode, 0, { failureCodeSuffix: "SEED_FAILED", hardCapIds: ["MIGRATION_CORRECTNESS"] }); return result; };
    ctx.createRevision = (url, body, options = {}) => ctx.mutate(url, "/api/v1/config-revisions", options.key ?? ctx.key("revision"), body, { timeoutMs: options.timeoutMs });
    ctx.getRevision = (url, id, options = {}) => ctx.request(url, `/api/v1/config-revisions/${id}`, options);
    ctx.publishRevision = (url, id, body, options = {}) => ctx.mutate(url, `/api/v1/config-revisions/${id}/publish`, options.key ?? ctx.key("publish"), body, { timeoutMs: options.timeoutMs });
    ctx.rollout = (url, environmentId, body, options = {}) => ctx.mutate(url, `/api/v1/environments/${environmentId}/rollout`, options.key ?? ctx.key("rollout"), body, { timeoutMs: options.timeoutMs });
    ctx.rollbackEnvironment = (url, environmentId, body, options = {}) => ctx.mutate(url, `/api/v1/environments/${environmentId}/rollback`, options.key ?? ctx.key("rollback"), body, { timeoutMs: options.timeoutMs });
    ctx.clientConfig = (url, query, options = {}) => ctx.request(url, `/api/v1/client-config?${new URLSearchParams(query)}`, options);
    ctx.observeClient = (url, body, options = {}) => ctx.mutate(url, "/api/v1/client-observations", options.key ?? ctx.key("observation"), body, { timeoutMs: options.timeoutMs });
    ctx.audit = (url, tenantId, query = "limit=100") => ctx.request(url, `/api/v1/audit?tenantId=${tenantId}&${query}`);
    ctx.releases = (url, environmentId, query = "limit=100") => ctx.request(url, `/api/v1/environments/${environmentId}/releases?${query}`);
    ctx.createTrain = (url, body, options = {}) => ctx.mutate(url, "/api/v1/promotion-trains", options.key ?? ctx.key("train"), body, { timeoutMs: options.timeoutMs, contractExpectation: options.contractExpectation });
    ctx.startTrain = (url, id, options = {}) => ctx.mutate(url, `/api/v1/promotion-trains/${id}/start`, options.key ?? ctx.key("train-start"), {}, { timeoutMs: options.timeoutMs });
    ctx.advanceTrain = (url, id, body, options = {}) => ctx.mutate(url, `/api/v1/promotion-trains/${id}/advance`, options.key ?? ctx.key("train-advance"), body, { timeoutMs: options.timeoutMs });
    ctx.rollbackTrain = (url, id, body, options = {}) => ctx.mutate(url, `/api/v1/promotion-trains/${id}/rollback`, options.key ?? ctx.key("train-rollback"), body, { timeoutMs: options.timeoutMs });
    ctx.readOpenApi = async (url) => { const response = await ctx.request(url, "/openapi.json"); ctx.equal("OpenAPI status", response.status, 200); return response.json; };
    ctx.workerBarrier = (predicate = () => true) => ctx.barrier({ hold: (payload) => payload.processRole === "worker" && payload.point === "worker.claimed" && predicate(payload) });
    ctx.startWorkerAtBarrier = (barrier, options = {}) => ctx.startWorker({ ...options, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token, ...options.env } });
    ctx.withPage = (api, viewport, operation) => withPage(ctx, api, viewport, operation);
    return ctx;
}
export async function createCaseContext(options) { return decorate(await runtime.createCaseContext(options)); }
export async function withCaseContext(options, operation) { return runtime.withCaseContext(options, async (raw) => { const ctx = await decorate(raw); if (!["MIGRATE-01", "MIGRATE-02", "MIGRATE-04"].includes(ctx.caseId))
    await ctx.migrate(); const outcome = await operation(ctx), unexpected = [...ctx.evidence.statuses].filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0); ctx.equal("no unexpected HTTP 5xx", unexpected, 0); return { ...outcome, evidence: { ...ctx.evidence.finish(), caseEvidence: outcome?.evidence ?? [] } }; }); }
async function chromiumExecutable() { for (const candidate of [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].filter(Boolean)) {
    try {
        await access(candidate);
        return candidate;
    }
    catch { }
} throw new shared.EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE", "EVALUATOR_CHROMIUM_UNAVAILABLE"); }
async function withPage(ctx, api, viewport, operation) { let chromium; try {
    ({ chromium } = await import("playwright-core"));
}
catch (cause) {
    throw new shared.EvaluationInfrastructureError("EVALUATOR_PLAYWRIGHT_UNAVAILABLE", "EVALUATOR_PLAYWRIGHT_UNAVAILABLE", { cause });
} const browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }), browserContext = await browser.newContext({ viewport, baseURL: api.baseUrl }), page = await browserContext.newPage(), errors = []; page.on("pageerror", (error) => errors.push(error.message)); page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource.*4\d\d/iu.test(message.text()))
    errors.push(message.text()); }); try {
    await operation(page);
    ctx.equal("browser console clean", errors, []);
    ctx.equal("browser no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
}
finally {
    await browserContext.close();
    await browser.close();
} }
export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
