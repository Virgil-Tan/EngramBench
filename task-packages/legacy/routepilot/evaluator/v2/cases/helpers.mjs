import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { canonicalJson, exactKeys, percentile } from "../oracles/index.mjs";

export const V1_KEYS = ["tenants", "backends", "routeDefinitions", "routeRevisions", "rateLimitPolicies", "circuitPolicies", "configReleases", "gatewayRequests", "upstreamAttempts", "rateWindows", "circuitWindows"];
export const FINAL_KEYS = [...V1_KEYS, "regionalRollouts", "regionalStages"].sort();
export const ROLLOUT_KEYS = ["regionalRolloutId", "tenantId", "targetConfigReleaseId", "requestRef", "state", "currentStageOrdinal", "createdAt", "updatedAt", "sequence"];
export const STAGE_KEYS = ["regionalStageId", "regionalRolloutId", "ordinal", "region", "minimumObservationSeconds", "failureThresholdPercent", "priorConfigReleaseId", "targetConfigReleaseId", "state", "activatedAt", "completedAt"];
export const DISPATCH_KEYS = ["gatewayRequestId", "routeRevisionId", "backendVersion", "status", "responseStatus", "responseHeaders", "body"];
export const PUBLIC_PATHS = [
  "/api/v1/tenants", "/api/v1/backends", "/api/v1/route-definitions", "/api/v1/route-revisions",
  "/api/v1/rate-limit-policies", "/api/v1/circuit-policies", "/api/v1/config-releases",
  "/api/v1/config-releases/{configReleaseId}", "/api/v1/config-releases/{configReleaseId}/rollback",
  "/api/v1/gateway/dispatch", "/api/v1/gateway-requests/{gatewayRequestId}", "/api/v1/regional-rollouts",
  "/api/v1/regional-rollouts/{regionalRolloutId}", "/api/v1/regional-rollouts/{regionalRolloutId}/pause",
  "/api/v1/regional-rollouts/{regionalRolloutId}/resume", "/api/v1/regional-rollouts/{regionalRolloutId}/cancel",
  "/api/v1/regional-rollouts/{regionalRolloutId}/rollback", "/api/v1/verification-snapshot",
];

const META = {
  "A-01": ["RP-F-ROUTING", "Dispatch literal parameter wildcard and invalid normalized paths through public gateway HTTP", "Run the task-local parser and precedence order then close route identity and tenant isolation"],
  "A-02": ["RP-F-CANARY", "Dispatch exact bucket-boundary affinities across processes releases and restarts", "Recompute SHA-256 uint32 buckets and weighted intervals for one frozen revision"],
  "A-03": ["RP-F-RATE", "Consume one tenant window across accepted rejected replay and rollover requests", "Maintain an integer database-time ledger and compare exact tokens and upstream calls"],
  "A-04": ["RP-F-CIRCUIT", "Orchestrate success failure timeout OPEN and HALF_OPEN upstream outcomes", "Apply the independent circuit state machine and globally bounded probe oracle"],
  "A-05": ["RP-F-ROLLOUT", "Create valid duplicate-region and invalid RegionalRollout requests", "Freeze first occurrence order prior release target parameters Work and zero-side-effect failures"],
  "B-01": ["RP-F-PUBLICATION", "Activate and rollback complete releases while two APIs continuously dispatch", "Assert every request sees one complete old or new immutable route revision set"],
  "B-02": ["RP-F-REPLAY", "Lose and concurrently replay release mutations through two APIs and restart", "Compare stable response bytes identity active authority Work and Event cardinality"],
  "B-03": ["RP-F-HOT-RATE", "Race an exact shared token budget through two independent API processes", "Linearize success and throttle counts against one PostgreSQL RateWindow"],
  "B-04": ["RP-F-BREAKER-RELOAD", "Hold an old-release upstream result while a new release activates", "Attach the late result only to request-frozen circuit and route authority"],
  "B-05": ["RP-F-ROLLOUT-CONTROL", "Race pause resume cancel rollback and claimed advance Work through two APIs", "Converge on one legal state and fence every stale regional activation"],
  "C-01": ["RP-F-GATEWAY-UNKNOWN", "Drop a committed gateway response kill the API then replay after restart", "Return one saved response with one quota circuit upstream and request effect"],
  "C-02": ["RP-F-RELEASE-CRASH", "Kill around public release activation Work and restart control-plane roles", "Observe complete old or new release authority and immutable sequence after recovery"],
  "C-03": ["RP-F-ROLLOUT-RECOVERY", "Kill a worker holding RegionalRollout advance Work then replace it", "Keep strict ordinal and lease fencing while diagnosing the unpublished readiness input"],
  "C-04": ["RP-F-OUTBOX", "Return 500 hold ACK and kill a known Dispatcher before retry", "Match stable Event identity canonical bytes aggregate sequence and failed-mutation silence"],
  "D-01": ["RP-F-CONTRACT", "Exercise strict runtime requests errors pagination and OpenAPI through HTTP", "Validate exact closed resource envelopes statuses enums and zero mutation on rejection"],
  "D-02": ["RP-F-BROWSER-V1", "Use production Chromium controls for routes releases gateway rate and circuit evidence", "Compare visible decisions after refresh and error states with independent HTTP authority"],
  "D-03": ["RP-F-BROWSER-ROLLOUT", "Use production Chromium to create pause resume cancel and rollback rollouts", "Compare visible frozen order controls and current ordinal while health advance stays blocked"],
  "D-04": ["RP-F-SNAPSHOT", "Read one populated authorized FINAL verification snapshot", "Validate exact redacted shapes sorts union Work Events and tenant authority from one asOf"],
  "E-01": ["RP-F-V1-FINAL", "Populate V1 replay windows Events and leased Work then repeatedly migrate", "Preserve every V1 identity and create deterministic GLOBAL rollout and stage identities"],
  "E-02": ["RP-F-PERF-ROUTE", "Run 100000 dispatches against 250 routes and 20 weighted versions at concurrency 64", "Measure published thresholds and independently recompute every route bucket and frozen release"],
  "E-03": ["RP-F-PERF-RATE", "Run 50000 hot-tenant dispatches against fixed 1000-token windows", "Measure published thresholds and close exact quota upstream and throttle conservation"],
  "E-04": ["RP-F-PERF-RECOVERY", "Mix 20000 results with 100 release transitions and kill two claimed workers", "Drain four replacements within sixty seconds and close breaker release Work and Event invariants"],
};

export function defineCase(id, run) {
  const [fixtureFamily, action, oracle] = META[id] ?? [];
  if (!fixtureFamily) throw new Error(`unknown RoutePilot case ${id}`);
  return Object.freeze({ id, taskId: "routepilot", fixtureFamily, action, oracle, async run(ctx) { return run(ctx); } });
}
export function guardedCase(id, hardCapIds, run) {
  return defineCase(id, async (ctx) => { try { return await run(ctx); } catch (error) { error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])]; throw error; } });
}

export function findField(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, key)) return value[key];
  for (const child of Object.values(value)) { const found = findField(child, key); if (found !== undefined) return found; }
  return undefined;
}
export function successful(response, label = "request") { assert.ok(response.status >= 200 && response.status < 300, `${label} returned ${response.status}: ${response.text}`); return response; }
export function semanticError(response, status, code) {
  assert.equal(response.status, status, `${code} status`);
  assert.equal(response.json?.error?.code, code, `${code} code`);
  exactKeys(response.json, ["error"], `${code} envelope`);
  assert.ok(typeof response.json.error.message === "string" && response.json.error.details && typeof response.json.error.details === "object", `${code} closed error`);
}
export function resources(snapshot) { assert.ok(snapshot?.resources && Array.isArray(snapshot.work) && Array.isArray(snapshot.events), "snapshot resources/work/events"); return snapshot.resources; }

export async function startUpstream(ctx, behavior = () => ({ status: 200, json: { ok: true } })) {
  const ledger = [];
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    let json; try { json = JSON.parse(raw); } catch {}
    const entry = { ordinal: ledger.length + 1, method: request.method, path: request.url, headers: { ...request.headers }, raw, json };
    ledger.push(entry);
    const selected = await behavior(entry, ledger) ?? { status: 200, json: { ok: true } };
    if (selected.delayMs) await new Promise((resolveWait) => setTimeout(resolveWait, selected.delayMs));
    if (selected.disconnect) { response.destroy(); return; }
    const headers = { ...(selected.headers ?? {}) };
    let body = selected.body ?? "";
    if (Object.hasOwn(selected, "json")) { headers["content-type"] ??= "application/json"; body = JSON.stringify(selected.json); }
    entry.response = { status: selected.status ?? 200, headers, body };
    response.writeHead(selected.status ?? 200, headers); response.end(body);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  const record = { server, ledger, baseUrl: `http://127.0.0.1:${address.port}` };
  ctx.defer(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise((resolveClose) => server.close(resolveClose)); });
  return record;
}

export async function prepare(ctx, fixture, { apiCount = 1, workerCount = 0 } = {}) {
  await ctx.migrate(); await ctx.seed(fixture.seed);
  const apis = await Promise.all(Array.from({ length: apiCount }, () => ctx.startApi()));
  const workers = await Promise.all(Array.from({ length: workerCount }, () => ctx.startWorker()));
  ctx.mark("routepilot.prepared", { fixtureFamily: fixture.fixtureFamily, apiCount, workerCount });
  return { api: apis[0], apis, workers };
}

export function gatewayPayload(fixture, index, overrides = {}) {
  return {
    tenantId: fixture.tenant.tenantId,
    method: "POST",
    path: `/orders/${index}`,
    headers: { "x-route-affinity": `affinity-${index}` },
    body: { orderId: index },
    requestKey: `gateway-${index}`,
    ...overrides,
  };
}
export async function dispatch(ctx, baseUrl, fixture, index, overrides = {}, options = {}) {
  const payload = gatewayPayload(fixture, index, overrides);
  const response = await ctx.mutate(baseUrl, "/api/v1/gateway/dispatch", options.key ?? ctx.key(`dispatch:${payload.requestKey}`), payload);
  if (options.expectSuccess !== false) successful(response, "gateway dispatch");
  return { payload, response };
}

export async function createRelease(ctx, baseUrl, fixture, suffix, overrides = {}) {
  const active = resources(await ctx.snapshot(baseUrl)).configReleases.find((item) => item.tenantId === fixture.tenant.tenantId && item.state === "ACTIVE");
  const body = {
    tenantId: fixture.tenant.tenantId,
    version: Math.max(...resources(await ctx.snapshot(baseUrl)).configReleases.filter((item) => item.tenantId === fixture.tenant.tenantId).map((item) => item.version)) + 1,
    routeRevisionIds: fixture.seed.routeRevisions.map((item) => item.routeRevisionId),
    expectedActiveVersion: active?.version ?? null,
    ...overrides,
  };
  const response = successful(await ctx.mutate(baseUrl, "/api/v1/config-releases", ctx.key(`release:${suffix}`), body), "create ConfigRelease");
  return { body, response, configReleaseId: findField(response.json, "configReleaseId") };
}
export async function waitRelease(ctx, baseUrl, configReleaseId, { state = "ACTIVE", timeoutMs = 60_000, processes = [] } = {}) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); const release = resources(snapshot).configReleases.find((item) => item.configReleaseId === configReleaseId); return release?.state === state ? { release, snapshot } : undefined; }, { timeoutMs, label: `ConfigRelease ${state}`, processes });
}
export async function rollbackRelease(ctx, baseUrl, configReleaseId, expectedActiveVersion, suffix = configReleaseId) {
  const response = successful(await ctx.mutate(baseUrl, `/api/v1/config-releases/${configReleaseId}/rollback`, ctx.key(`rollback:${suffix}`), { expectedActiveVersion }), "rollback ConfigRelease");
  return { response, configReleaseId: findField(response.json, "configReleaseId") };
}

export async function createRollout(ctx, baseUrl, fixture, suffix, overrides = {}) {
  const body = { tenantId: fixture.tenant.tenantId, targetConfigReleaseId: fixture.target.configReleaseId, stages: fixture.stages, requestRef: `${fixture.requestRef}-${suffix}`, ...overrides };
  const response = successful(await ctx.mutate(baseUrl, "/api/v1/regional-rollouts", ctx.key(`rollout:${suffix}`), body), "create RegionalRollout");
  const regionalRolloutId = findField(response.json, "regionalRolloutId");
  return { body, response, regionalRolloutId };
}
export async function getRollout(ctx, baseUrl, regionalRolloutId) {
  const response = successful(await ctx.request(baseUrl, `/api/v1/regional-rollouts/${regionalRolloutId}`), "GET RegionalRollout");
  exactKeys(response.json, ["regionalRollout", "stages"], "RegionalRollout detail");
  return response.json;
}
export async function controlRollout(ctx, baseUrl, regionalRolloutId, action, suffix = action) {
  return ctx.mutate(baseUrl, `/api/v1/regional-rollouts/${regionalRolloutId}/${action}`, ctx.key(`rollout:${suffix}`), {});
}
export function assertRolloutDetail(detail, fixture) {
  exactKeys(detail.regionalRollout, ROLLOUT_KEYS, "RegionalRollout");
  for (const stage of detail.stages) exactKeys(stage, STAGE_KEYS, "RegionalStage");
  const expectedRegions = [...new Set(fixture.stages.map((item) => item.region))];
  assert.deepEqual(detail.stages.map((item) => item.region), expectedRegions, "stage first-occurrence order");
  assert.deepEqual(detail.stages.map((item) => item.ordinal), expectedRegions.map((_, index) => index), "stage ordinals contiguous");
  assert.ok(detail.stages.every((item) => item.priorConfigReleaseId === fixture.release.configReleaseId && item.targetConfigReleaseId === fixture.target.configReleaseId), "stage freezes prior and target releases");
}

export async function waitWork(ctx, baseUrl, predicate, { state, timeoutMs = 30_000, processes = [] } = {}) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); const work = snapshot.work.find((item) => predicate(item) && (!state || item.state === state)); return work ? { work, snapshot } : undefined; }, { timeoutMs, intervalMs: 10, label: `Work ${state ?? "presence"}`, processes });
}
export async function fixedLoad(ctx, { count, concurrency, request, collectResponses = false }) {
  const latencies = [], statuses = new Map(), responses = collectResponses ? new Array(count) : undefined;
  const startedAt = performance.now();
  await ctx.concurrent(Array.from({ length: count }), concurrency, async (_, index) => {
    const started = performance.now(), response = await request(index);
    latencies.push(performance.now() - started); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    if (responses) responses[index] = response;
  });
  const durationMs = performance.now() - startedAt;
  return { responses, durationMs, throughput: count / (durationMs / 1_000), p95: percentile(latencies, 0.95), statuses: Object.fromEntries(statuses) };
}
export function assertLoad(load, { count, minimumThroughput, maximumP95, acceptedStatuses = [200] }) {
  const accepted = Object.entries(load.statuses).filter(([status]) => acceptedStatuses.includes(Number(status))).reduce((sum, [, value]) => sum + value, 0);
  const serverErrors = Object.entries(load.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, value]) => sum + value, 0);
  assert.equal(accepted, count, "all workload statuses expected"); assert.equal(serverErrors, 0, "unexpected 5xx count");
  assert.ok(load.throughput >= minimumThroughput, `throughput ${load.throughput.toFixed(2)} < ${minimumThroughput}`);
  assert.ok(load.p95 <= maximumP95, `p95 ${load.p95.toFixed(2)} > ${maximumP95}`);
}

export async function launchBrowser(ctx) {
  await ctx.npm("build", [], { timeoutMs: 180_000 });
  const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  ctx.defer(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  return { api, browser, page };
}
export async function fillVisible(page, name, value) {
  const label = page.getByLabel(new RegExp(name, "i")).first();
  if (await label.count()) return label.fill(String(value));
  const control = page.locator(`[name="${name}"]`).first(); assert.ok(await control.count(), `visible control ${name}`); return control.fill(String(value));
}
export async function clickVisible(page, name) { const button = page.getByRole("button", { name: new RegExp(name, "i") }).first(); assert.ok(await button.count(), `visible action ${name}`); await button.click(); }

export function stableSnapshot(snapshot) { const { asOf: _asOf, ...stable } = snapshot; return canonicalJson(stable); }
