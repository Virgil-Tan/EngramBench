const { observeBrowserWait, captureBrowserResponse, uniqueUiTarget } = await import(new URL("browser.mjs", process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url)));
export { observeBrowserWait };
import { candidateAssert as assert } from "../lib/execution.mjs";

import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { prepareEscrowGuardPublicHistory } from "../fixtures/public-history.mjs";
import { assertNoPrivatePaths } from "../lib/public-material.mjs";
import { assertDetail, assertDispute, assertEscrow, assertMilestone, assertRelease, canonicalJson, percentile } from "../oracles/index.mjs";

const HARD_CAPS = Object.freeze({
  "A-01": ["BUILD_MIGRATION_OR_BOOT"], "A-02": ["BUILD_MIGRATION_OR_BOOT", "MIGRATION_COMPATIBILITY"], "A-03": ["FUND_OR_PAYOUT_ATOMICITY"], "A-06": ["FUND_OR_PAYOUT_ATOMICITY"], "A-08": ["FUND_OR_PAYOUT_ATOMICITY"], "A-09": ["FUND_OR_PAYOUT_ATOMICITY"], "A-10": ["FUND_OR_PAYOUT_ATOMICITY"], "A-11": ["FUND_OR_PAYOUT_ATOMICITY"], "A-12": ["EVENT_ATOMICITY_OR_IDENTITY"], "A-13": ["FUND_OR_PAYOUT_ATOMICITY"], "A-14": ["FUND_OR_PAYOUT_ATOMICITY"], "A-15": ["MIGRATION_COMPATIBILITY"],
  "B-01": ["FUND_OR_PAYOUT_ATOMICITY"], "B-02": ["FUND_OR_PAYOUT_ATOMICITY"], "B-03": ["FUND_OR_PAYOUT_ATOMICITY"], "B-04": ["FUND_OR_PAYOUT_ATOMICITY"], "B-05": ["FUND_OR_PAYOUT_ATOMICITY"], "B-06": ["DURABLE_IDEMPOTENCY"], "B-07": ["DURABLE_IDEMPOTENCY", "FUND_OR_PAYOUT_ATOMICITY"], "B-08": ["FUND_OR_PAYOUT_ATOMICITY"], "B-09": ["FUND_OR_PAYOUT_ATOMICITY"], "B-10": ["FUND_OR_PAYOUT_ATOMICITY"],
  "C-01": ["STALE_WORK_OR_LOST_WORK"], "C-02": ["STALE_WORK_OR_LOST_WORK"], "C-03": ["STALE_WORK_OR_LOST_WORK", "FUND_OR_PAYOUT_ATOMICITY"], "C-04": ["STALE_WORK_OR_LOST_WORK", "FUND_OR_PAYOUT_ATOMICITY"], "C-05": ["STALE_WORK_OR_LOST_WORK"], "C-06": ["STALE_WORK_OR_LOST_WORK"], "C-07": ["EVENT_ATOMICITY_OR_IDENTITY"], "C-08": ["EVENT_ATOMICITY_OR_IDENTITY"],
  "D-02": ["FUND_OR_PAYOUT_ATOMICITY"], "D-03": ["FUND_OR_PAYOUT_ATOMICITY"], "D-04": ["FUND_OR_PAYOUT_ATOMICITY"], "D-06": ["FUND_OR_PAYOUT_ATOMICITY", "EVENT_ATOMICITY_OR_IDENTITY"],
  "E-01": ["MIGRATION_COMPATIBILITY"], "E-02": ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY", "EVENT_ATOMICITY_OR_IDENTITY"], "E-03": ["MIGRATION_COMPATIBILITY", "STALE_WORK_OR_LOST_WORK"], "E-04": ["FUND_OR_PAYOUT_ATOMICITY"], "E-05": ["FUND_OR_PAYOUT_ATOMICITY"], "E-06": ["STALE_WORK_OR_LOST_WORK", "FUND_OR_PAYOUT_ATOMICITY"]
});

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !/^EG-F-/u.test(fixtureFamily ?? "") || typeof action !== "string" || action.length < 24 || typeof oracle !== "string" || oracle.length < 24 || typeof run !== "function" || run.length < 1) throw new TypeError("invalid EscrowGuard Case definition");
  const hardCaps = HARD_CAPS[id] ?? [];
  return Object.freeze({ id, taskId: "escrowguard", fixtureFamily, action, oracle, async run(ctx) { try { return await run(ctx); } catch (error) { if (error && typeof error === "object") error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCaps])]; throw error; } } });
}

export function exactKeys(value, keys, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} exact fields`); return value; }
export function successful(response, label = "request", status) { if (status === undefined) assert.ok(response.status >= 200 && response.status < 300, `${label} returned ${response.status}: ${response.text}`); else assert.equal(response.status, status, `${label} status`); return response; }
export { assertNoPrivatePaths };
export function semanticError(response, status, code, label = code) { assert.equal(response.status, status, `${label} status`); exactKeys(response.json, ["error"], `${label} envelope`); exactKeys(response.json.error, ["code", "message", "details"], `${label} error`); assert.equal(response.json.error.code, code, `${label} code`); assert.equal(typeof response.json.error.message, "string", `${label} message`); exactKeys(response.json.error.details, [], `${label} details`); assertNoPrivatePaths(response.text ?? JSON.stringify(response.json), `${label} error`); return response.json.error; }
export function resources(snapshot) { assert.ok(snapshot?.resources && Array.isArray(snapshot.work) && Array.isArray(snapshot.events), "snapshot resources/work/events"); return snapshot.resources; }

export async function prepare(ctx, { seed, workspace = ctx.workspace, build = true, migrate = true, apiCount = 1, workerCount = 0, dispatcher = false, receiver } = {}) {
  const target = ctx.forWorkspace(workspace);
  if (build) await target.npm("build", [], { timeoutMs: 240_000 });
  if (migrate) await target.migrate();
  const history = prepareEscrowGuardPublicHistory(ctx, seed);
  if (history.seed) await target.seed(history.seed);
  const apis = await Promise.all(Array.from({ length: apiCount }, () => target.startApi()));
  await history.replay(apis[0]);
  const workers = await Promise.all(Array.from({ length: workerCount }, () => target.startWorker()));
  const dispatchers = dispatcher ? [await target.startDispatcher({ webhookUrl: receiver?.url })] : [];
  ctx.mark("escrowguard.prepared", { apiCount, workerCount, dispatcher: dispatchers.length, seeded: Boolean(seed) });
  return { target, api: apis[0], apis, workers, dispatchers };
}

export async function createEscrow(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/escrows", options.key ?? ctx.key(`create:${body.buyerId}:${body.sellerId}:${body.totalMinor}`), body, { contractExpectation: options.contractExpectation });
  if (options.allowFailure) return response;
  return assertEscrow(successful(response, options.label ?? "create Escrow", 201).json);
}
export async function listEscrows(ctx, baseUrl, query = {}) { const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])); const response = successful(await ctx.request(baseUrl, `/api/v1/escrows?${search}`), "list Escrows", 200); exactKeys(response.json, ["items", "nextCursor"], "Escrow page"); assert.ok(Array.isArray(response.json.items), "Escrow page items"); response.json.items.forEach(assertEscrow); assert.ok(response.json.nextCursor === null || typeof response.json.nextCursor === "string", "Escrow nextCursor"); return response.json; }
export async function getDetail(ctx, baseUrl, escrowId, { final = true } = {}) { return assertDetail(successful(await ctx.request(baseUrl, `/api/v1/escrows/${escrowId}`), "get Escrow detail", 200).json, { final }); }
export async function acceptMilestone(ctx, baseUrl, escrowId, milestoneId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/escrows/${escrowId}/milestones/${milestoneId}/accept`, options.key ?? ctx.key(`accept:${escrowId}:${milestoneId}`), {}, { contractExpectation: options.contractExpectation }); if (options.allowFailure) return response; return assertRelease(successful(response, options.label ?? "accept Milestone", 200).json, { response: true }); }
export async function openDispute(ctx, baseUrl, escrowId, milestoneId, openedBy = "BUYER", reason = "Hidden dispute", options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/escrows/${escrowId}/milestones/${milestoneId}/disputes`, options.key ?? ctx.key(`dispute:${escrowId}:${milestoneId}`), { openedBy, reason }, { contractExpectation: options.contractExpectation }); if (options.allowFailure) return response; return assertDispute(successful(response, options.label ?? "open Dispute", 200).json); }
export async function resolveDispute(ctx, baseUrl, disputeId, decision, note = "Hidden resolution", options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/admin/disputes/${disputeId}/resolve`, options.key ?? ctx.key(`resolve:${disputeId}:${decision}`), { decision, note }, { admin: options.admin !== false, contractExpectation: options.contractExpectation }); if (options.allowFailure) return response; successful(response, options.label ?? "resolve Dispute", 200); return response.json; }
export async function queryEvents(ctx, baseUrl, query = {}) { const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])); const response = successful(await ctx.request(baseUrl, `/api/v1/domain-events?${search}`), "query Domain Events", 200); exactKeys(response.json, ["items", "nextCursor"], "Domain Event page"); assert.ok(Array.isArray(response.json.items), "Domain Event items"); return response.json; }

export async function waitForSnapshot(ctx, baseUrl, predicate, options = {}) { return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl, { timeoutMs: options.requestTimeoutMs }); return predicate(snapshot) ? snapshot : undefined; }, { timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 100, label: options.label ?? "EscrowGuard snapshot condition", processes: options.processes ?? [] }); }
export async function waitForEscrow(ctx, baseUrl, escrowId, state, processes = [], timeoutMs = 120_000) { const snapshot = await waitForSnapshot(ctx, baseUrl, (value) => resources(value).escrows.find((item) => item.escrowId === escrowId)?.state === state, { timeoutMs, label: `Escrow ${escrowId} ${state}`, processes }); return { snapshot, escrow: resources(snapshot).escrows.find((item) => item.escrowId === escrowId) }; }
export async function waitForWorkDrain(ctx, baseUrl, predicate, processes = [], timeoutMs = 120_000) { return waitForSnapshot(ctx, baseUrl, (snapshot) => { const selected = snapshot.work.filter(predicate); return selected.length > 0 && selected.every(({ terminal }) => terminal); }, { timeoutMs, label: "EscrowGuard Work drain", processes }); }

export async function sustainedClosedLoop({ clients, warmupMs, measureMs, operation }) {
  async function runPhase(name, durationMs, collect) {
    let ordinal = 0;
    const responses = [], latencies = [], statuses = new Map();
    const startedAt = performance.now(); const deadline = startedAt + durationMs;
    await Promise.all(Array.from({ length: clients }, async (_, client) => {
      while (performance.now() < deadline) {
        const requestOrdinal = ordinal += 1; const dispatchedAt = performance.now();
        const response = await operation({ client, ordinal: requestOrdinal, phase: name, measuring: collect });
        if (collect) { const latencyMs = Number.isFinite(response.durationMs) ? response.durationMs : performance.now() - dispatchedAt; response._latencyMs = latencyMs; responses.push(response); latencies.push(latencyMs); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1); }
      }
    }));
    return { elapsedMs: performance.now() - startedAt, responses, latencies, statuses };
  }
  const warmup = await runPhase("warmup", warmupMs, false);
  const measured = await runPhase("measure", measureMs, true);
  return { count: measured.responses.length, responses: measured.responses, statuses: measured.statuses, measureWindowMs: measureMs, warmupElapsedMs: warmup.elapsedMs, measuredElapsedMs: measured.elapsedMs, throughput: measured.responses.length / (measureMs / 1_000), p50Ms: percentile(measured.latencies, 0.5), p95Ms: percentile(measured.latencies, 0.95), p99Ms: percentile(measured.latencies, 0.99) };
}
export function countStatus(load, predicate) { return [...load.statuses].filter(([status]) => predicate(status)).reduce((sum, [, count]) => sum + count, 0); }

export async function launchBrowser(ctx, baseUrl, viewport = { width: 1280, height: 800 }) { const chromium = await ctx.loadChromium(); const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] }); ctx.defer(() => browser.close()); const browserContext = await browser.newContext({ viewport }); const page = await browserContext.newPage(); await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 }); ctx.mark("layer.ui", { viewport: `${viewport.width}x${viewport.height}` }); return { browser, browserContext, page }; }
async function firstVisible(page, choices) {
  if (!choices.length) throw new TypeError('evaluator must supply at least one semantic locator');
  const target = choices.reduce((union, locator) => union.or(locator)).and(page.locator(':visible'));
  // A click can initiate asynchronous detail loading; count() is not a wait.
  return uniqueUiTarget(target, 'Escrow semantic control');
}
export async function visibleControl(page, roles, names) {
  const groups = names.map(name => roles.map(role => page.getByRole(role, { name })).reduce((a, b) => a.or(b)).and(page.locator(':visible')));
  await groups.reduce((a, b) => a.or(b)).first().waitFor({ state: 'visible' });
  for (const group of groups) if (await group.count()) return uniqueUiTarget(group, 'Escrow semantic control');
  return firstVisible(page, groups);
}
export async function visibleField(page, names) { return firstVisible(page, names.map(name => page.getByLabel(name))); }
export async function fillControl(control, value) { const tag = await control.evaluate((element) => element.tagName.toLowerCase()); if (tag === "select") return control.selectOption(String(value)); const type = await control.getAttribute("type"); return control.fill(type === "datetime-local" ? String(value).replace(/Z$/u, "").slice(0, 16) : String(value)); }
export async function tabTo(page, control) { for (let index = 0; index < 200; index += 1) { if (await control.evaluate((element) => element === document.activeElement)) return; await page.keyboard.press("Tab"); } throw new Error("keyboard traversal could not reach visible control"); }
export async function keyboardFill(page, control, value) { await tabTo(page, control); const type = await control.getAttribute("type"); const text = type === "datetime-local" ? String(value).replace(/Z$/u, "").slice(0, 16) : String(value); await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A"); await page.keyboard.insertText(text); }
export async function browserMutation(page, actionNames, pathPattern, options) { return captureBrowserResponse(page, request => request.method() === 'POST' && pathPattern.test(new URL(request.url()).pathname), async () => { await (await visibleControl(page, ['button', 'link'], actionNames)).click(); }, options); }
export async function submitViaBrowser(ctx, baseUrl, escrowId) { const { page } = await launchBrowser(ctx, baseUrl); const identity = page.getByText(escrowId, { exact: false }).first(); assert.ok(await identity.count(), "Escrow identity visible in production UI"); await identity.click(); await page.waitForLoadState('networkidle'); ctx.mark("layer.ui", { escrowId }); const response = await browserMutation(page, [/submit/i], /\/milestones\/[^/]+\/submit$/u); assert.ok(response.status() >= 200 && response.status() < 300, "visible submit succeeds"); await page.reload({ waitUntil: "networkidle" }); return page; }
export function identityPattern(value) { return new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"); }
export function stableSnapshot(snapshot) { const { asOf: _asOf, ...stable } = snapshot; return canonicalJson(stable); }
export function requireV1(ctx) { if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint"); return ctx.v1Workspace; }
export function finalEvidence(ctx, values = {}) { ctx.mark("layer.hidden", values); return ctx.pass({ evidence: [{ kind: "escrowguard-case-summary", ...values }] }); }
export function candidateFailure(message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) { throw new CaseFailure(message, { failureCodeSuffix, hardCapIds }); }
