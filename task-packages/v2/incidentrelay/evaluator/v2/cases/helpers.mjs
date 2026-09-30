import assert from "node:assert/strict";
import { canonicalJson, exactKeys, percentile, tupleSort } from "../oracles/index.mjs";

export const V1_RESOURCE_KEYS = ["services", "responders", "escalationPolicies", "incidents", "escalationSteps", "notificationDeliveries"];
export const FINAL_RESOURCE_KEYS = [...V1_RESOURCE_KEYS, "groupEscalationSteps", "incidentAcknowledgements"].sort();
export const SERVICE_KEYS = ["serviceId", "name", "currentPolicyId", "currentPolicyVersion"];
export const RESPONDER_KEYS = ["responderId", "name", "deliveryUrl"];
export const INCIDENT_V1_KEYS = ["incidentId", "serviceId", "dedupKey", "severity", "title", "details", "state", "policyId", "policyVersion", "createdAt", "expiresAt", "nextEscalationAt", "acknowledgedBy", "acknowledgedAt", "resolvedAt", "sequence"];
export const INCIDENT_FINAL_KEYS = [...INCIDENT_V1_KEYS, "acknowledgementStepIndex", "acknowledgements"];
export const STEP_KEYS = ["incidentId", "stepIndex", "responderId", "dueAt", "state", "notificationId", "successfulDeliveryAt"];
export const GROUP_STEP_KEYS = ["incidentId", "stepIndex", "responderIds", "quorumRequired", "dueAt", "state", "notifications", "successfulDeliveryAt"];
export const DELIVERY_KEYS = ["notificationId", "incidentId", "stepIndex", "responderId", "deliveryUrl", "body", "state", "attemptCount", "nextAttemptAt", "successfulDeliveryAt"];
export const ACK_KEYS = ["acknowledgementId", "incidentId", "stepIndex", "responderId", "acknowledgedAt"];
export const WORK_KEYS = ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"];
export const EVENT_KEYS = ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"];
export const TIMELINE_KEYS = ["sequence", "type", "occurredAt", "actorId", "data"];
export const PUBLIC_PATHS = [
  "/api/v1/incidents", "/api/v1/incidents/{incidentId}", "/api/v1/incidents/{incidentId}/acknowledge",
  "/api/v1/incidents/{incidentId}/acknowledgements", "/api/v1/incidents/{incidentId}/resolve",
  "/api/v1/incidents/{incidentId}/timeline", "/api/v1/services/{serviceId}/escalation-policies",
  "/api/v1/services/{serviceId}/escalation-policy", "/api/v1/domain-events", "/api/v1/verification-snapshot",
];

const TITLES = Object.freeze({
  "A-01": "Published commands and production boot", "A-02": "Repeatable populated migration", "A-03": "Atomic deterministic seed", "A-04": "OpenAPI 3.1 exact contract", "A-05": "Common errors and scalar/cardinality boundaries", "A-06": "Pagination reads and point-in-time snapshot", "A-07": "Immutable policy version CAS", "A-08": "Incident create active dedup and policy capture", "A-09": "Persisted scheduling and business delivery", "A-10": "Acknowledge and resolve V1", "A-11": "Expiry and terminal precedence", "A-12": "Timeline and Domain Events", "A-13": "FINAL group policy and notification quorum", "A-14": "FINAL acknowledgement quorum and compatibility",
  "B-01": "Due expiry and retry arithmetic oracle", "B-02": "Active dedup lifecycle and eternal replay", "B-03": "Atomic policy and incident rejection", "B-04": "Unknown-response durable replay", "B-05": "Same-key contention across two APIs", "B-06": "Distinct-key active-dedup contention", "B-07": "Acknowledge resolve and expiry races", "B-08": "Step delivery order and terminal suppression", "B-09": "Group notification quorum contention", "B-10": "Parallel acknowledgement quorum races",
  "C-01": "Work lifecycle shape and retention", "C-02": "SIGKILL after worker claimed", "C-03": "SIGKILL after business effect complete", "C-04": "SIGKILL at worker before commit", "C-05": "Expired lease fencing", "C-06": "Terminal transition closes obsolete work delivery", "C-07": "Unknown Domain Event webhook ACK", "C-08": "Transactional event ordering and quorum recovery",
  "D-01": "Independent OpenAPI live-traffic validation", "D-02": "Production-browser V1 lifecycle", "D-03": "Production-browser group quorum lifecycle", "D-04": "Loading empty conflict stale offline permission", "D-05": "Keyboard labels focus and mobile", "D-06": "Project-owned gates are not fake green", "D-07": "README-to-evidence closure",
  "E-01": "Populated V1 to FINAL acknowledgement migration", "E-02": "Saved replay and delivery identity migration", "E-03": "Pending Work and Domain delivery continuity", "E-04": "HTTP sustained performance", "E-05": "Escalation recovery performance and operability",
});
const FAMILY = Object.freeze({ A: ["EMPTY", "INCIDENT", "INCIDENT", "POLICY", "POLICY", "INCIDENT", "POLICY", "INCIDENT", "NOTIFICATION", "INCIDENT", "INCIDENT", "EVENT", "QUORUM", "QUORUM"], B: ["NOTIFICATION", "IDEMPOTENCY", "POLICY", "IDEMPOTENCY", "CONTENTION", "CONTENTION", "CONTENTION", "CONTENTION", "QUORUM", "QUORUM"], C: ["WORK", "WORK", "WORK", "WORK", "WORK", "WORK", "EVENT", "WORK"], D: ["POLICY", "BROWSER", "BROWSER", "BROWSER", "BROWSER", "BROWSER", "BROWSER"], E: ["MIGRATION", "MIGRATION", "MIGRATION", "PERF-V1", "PERF-V1"] });

export function defineCase(id, run) {
  const title = TITLES[id];
  const dimension = id[0], ordinal = Number(id.slice(2));
  const family = FAMILY[dimension]?.[ordinal - 1];
  if (!title || !family) throw new Error(`unknown IncidentRelay case ${id}`);
  return Object.freeze({
    id,
    taskId: "incidentrelay",
    fixtureFamily: `IR-F-${family}`,
    action: `Exercise IncidentRelay public behavior for ${title} through production processes and published seams`,
    oracle: `Compare ${title} against an evaluator-owned deterministic IncidentRelay state and wire oracle`,
    async run(ctx) { return run(ctx); },
  });
}
export function guardedCase(id, hardCapIds, run) { return defineCase(id, async (ctx) => { try { return await run(ctx); } catch (error) { error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])]; throw error; } }); }
export function diagnostic(assertionId, blockedBy) { return { assertionId, blockedBy, policy: "fail-closed-diagnostic" }; }
export function successful(response, label = "request", statuses = [200, 201]) { assert.ok(statuses.includes(response.status), `${label} returned ${response.status}: ${response.text}`); assert.ok(response.json !== undefined, `${label} must return JSON`); return response; }
export function semanticError(response, status, code) { assert.equal(response.status, status, `${code} status`); exactKeys(response.json, ["error"], `${code} envelope`); exactKeys(response.json.error, ["code", "message", "details"], `${code} error`); assert.equal(response.json.error.code, code, `${code} code`); assert.equal(typeof response.json.error.message, "string", `${code} message`); assert.ok(response.json.error.details && typeof response.json.error.details === "object" && !Array.isArray(response.json.error.details), `${code} details`); }
export function resources(snapshot) { assert.ok(snapshot && typeof snapshot.asOf === "string" && snapshot.resources && Array.isArray(snapshot.work) && Array.isArray(snapshot.events), "snapshot exact envelope components"); return snapshot.resources; }
export function stableSnapshot(snapshot) { const value = { ...snapshot }; delete value.asOf; return canonicalJson(value); }
export function findField(value, key) { if (!value || typeof value !== "object") return undefined; if (Object.hasOwn(value, key)) return value[key]; for (const child of Object.values(value)) { const found = findField(child, key); if (found !== undefined) return found; } return undefined; }

export async function prepare(ctx, fixture, { apiCount = 1, workerCount = 0, dispatcherCount = 0, migrateTwice = false } = {}) {
  await ctx.migrate(); if (migrateTwice) await ctx.migrate(); await ctx.seed(fixture.seed);
  const apis = await Promise.all(Array.from({ length: apiCount }, () => ctx.startApi()));
  const workers = await Promise.all(Array.from({ length: workerCount }, () => ctx.startWorker()));
  const dispatchers = await Promise.all(Array.from({ length: dispatcherCount }, () => ctx.startDispatcher()));
  ctx.mark("incidentrelay.prepared", { fixtureFamily: fixture.fixtureFamily, apiCount, workerCount, dispatcherCount });
  return { api: apis[0], apis, workers, dispatchers };
}
export async function createIncident(ctx, baseUrl, fixture, label, overrides = {}, options = {}) {
  const body = fixture.incidentBody(label, overrides);
  const response = await ctx.mutate(baseUrl, "/api/v1/incidents", options.key ?? ctx.key(`incident:${label}`), body, { contractExpectation: options.contractExpectation });
  if (options.expectSuccess !== false) successful(response, "create Incident", [201]);
  return { body, response, incident: response.json, incidentId: response.json?.incidentId };
}
export async function getIncident(ctx, baseUrl, incidentId) { return successful(await ctx.request(baseUrl, `/api/v1/incidents/${incidentId}`), "GET Incident", [200]).json; }
export async function createPolicy(ctx, baseUrl, fixture, label, overrides = {}) {
  const body = { expectedCurrentVersion: overrides.expectedCurrentVersion ?? fixture.service.currentPolicyVersion, steps: overrides.steps ?? fixture.policyGroup.steps, expireAfterSeconds: overrides.expireAfterSeconds ?? fixture.policyGroup.expireAfterSeconds };
  const response = await ctx.mutate(baseUrl, `/api/v1/services/${fixture.service.serviceId}/escalation-policies`, ctx.key(`policy:${label}`), body, { contractExpectation: overrides.contractExpectation });
  if (overrides.expectSuccess !== false) successful(response, "create EscalationPolicy", [200]);
  return { body, response, policy: response.json };
}
export async function legacyAcknowledge(ctx, baseUrl, incidentId, responderId, label = responderId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/incidents/${incidentId}/acknowledge`, options.key ?? ctx.key(`legacy-ack:${label}`), { responderId }); if (options.expectSuccess !== false) successful(response, "legacy acknowledge", [200]); return response; }
export async function acknowledge(ctx, baseUrl, incidentId, stepIndex, responderId, label = responderId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/incidents/${incidentId}/acknowledgements`, options.key ?? ctx.key(`ack:${label}`), { stepIndex, responderId }); if (options.expectSuccess !== false) successful(response, "quorum acknowledgement", [200]); return response; }
export async function resolveIncident(ctx, baseUrl, incidentId, responderId, label = responderId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/incidents/${incidentId}/resolve`, options.key ?? ctx.key(`resolve:${label}`), { responderId, resolution: options.resolution ?? "Recovered by deterministic evaluator" }); if (options.expectSuccess !== false) successful(response, "resolve Incident", [200]); return response; }
export async function timeline(ctx, baseUrl, incidentId) { const response = successful(await ctx.request(baseUrl, `/api/v1/incidents/${incidentId}/timeline`), "Incident timeline", [200]); assert.ok(Array.isArray(response.json?.items), "timeline items array"); exactKeys(response.json, ["items"], "timeline envelope"); return response.json.items; }

export async function waitSnapshot(ctx, baseUrl, predicate, { timeoutMs = 30_000, intervalMs = 25, processes = [], label = "snapshot predicate" } = {}) { return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); return predicate(snapshot) ? snapshot : undefined; }, { timeoutMs, intervalMs, processes, label }); }
export async function waitStep(ctx, baseUrl, incidentId, stepIndex, state, options = {}) { return waitSnapshot(ctx, baseUrl, (snapshot) => [...(resources(snapshot).groupEscalationSteps ?? []), ...(resources(snapshot).escalationSteps ?? [])].some((step) => step.incidentId === incidentId && step.stepIndex === stepIndex && step.state === state), { ...options, label: `Step ${incidentId}/${stepIndex} ${state}` }); }
export async function waitTerminalWork(ctx, baseUrl, aggregateId, options = {}) { return waitSnapshot(ctx, baseUrl, (snapshot) => snapshot.work.filter((item) => item.aggregateId === aggregateId).length > 0 && snapshot.work.filter((item) => item.aggregateId === aggregateId).every((item) => item.terminal), { ...options, label: `Work ${aggregateId} terminal` }); }

export async function startReceivers(ctx, count, behavior = () => ({ status: 204 })) { return Promise.all(Array.from({ length: count }, (_, index) => ctx.receiver({ path: `/notifications/${index}`, behavior: (entry, ledger) => behavior(index, entry, ledger) }))); }
export function assertNotificationRequest(entry, delivery) { assert.equal(entry.method, "POST", "notification method"); assert.match(String(entry.headers["content-type"]), /^application\/json\b/u, "notification content type"); assert.equal(entry.headers["x-incidentrelay-notification-id"], delivery.notificationId, "notification identity header"); assert.equal(canonicalJson(entry.json), canonicalJson(delivery.body), "notification canonical body"); }
export function assertSnapshotShape(snapshot, { final = true } = {}) {
  exactKeys(snapshot, ["asOf", "resources", "work", "events"], "snapshot");
  exactKeys(resources(snapshot), final ? FINAL_RESOURCE_KEYS : V1_RESOURCE_KEYS, "snapshot resources");
  for (const value of resources(snapshot).services) exactKeys(value, SERVICE_KEYS, "Service");
  for (const value of resources(snapshot).responders) exactKeys(value, RESPONDER_KEYS, "Responder");
  for (const value of resources(snapshot).incidents) exactKeys(value, final ? INCIDENT_FINAL_KEYS : INCIDENT_V1_KEYS, "Incident");
  for (const value of resources(snapshot).notificationDeliveries) exactKeys(value, DELIVERY_KEYS, "NotificationDelivery");
  for (const value of resources(snapshot).groupEscalationSteps ?? []) exactKeys(value, GROUP_STEP_KEYS, "GroupEscalationStep");
  for (const value of resources(snapshot).incidentAcknowledgements ?? []) exactKeys(value, ACK_KEYS, "IncidentAcknowledgement");
  for (const value of snapshot.work) exactKeys(value, WORK_KEYS, "Work");
  for (const value of snapshot.events) exactKeys(value, EVENT_KEYS, "DomainEvent");
  assert.deepEqual(resources(snapshot).incidents, tupleSort(resources(snapshot).incidents, ["incidentId"]), "Incident sort");
  assert.deepEqual(snapshot.work, tupleSort(snapshot.work, ["workId"]), "Work sort");
  assert.deepEqual(snapshot.events, tupleSort(snapshot.events, ["aggregateId", "sequence", "eventId"]), "Event sort");
  assert.equal(/"[^"]*Token"\s*:/u.test(JSON.stringify(snapshot)), false, "snapshot recursively omits Token fields");
  return true;
}

export async function fixedDurationLoad(ctx, { warmupMs, measureMs, concurrency, request, validate }) {
  let ordinal = 0;
  async function phase(durationMs, measured) {
    const deadline = performance.now() + durationMs, latencies = [], statuses = new Map(); let completed = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { while (performance.now() < deadline) { const index = ordinal++; const started = performance.now(); const response = await request(index, measured); const latency = performance.now() - started; if (validate) await validate(response, index, measured); if (measured) { completed += 1; latencies.push(latency); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1); } } }));
    return { completed, durationMs, throughput: completed / (durationMs / 1_000), p95: percentile(latencies, 0.95), p50: percentile(latencies, 0.5), p99: percentile(latencies, 0.99), statuses: Object.fromEntries(statuses) };
  }
  await phase(warmupMs, false); return phase(measureMs, true);
}
export function assertLoad(result, { minimumThroughput, maximumP95, acceptedStatuses }) { const accepted = Object.entries(result.statuses).filter(([status]) => acceptedStatuses.includes(Number(status))).reduce((sum, [, count]) => sum + count, 0); const serverErrors = Object.entries(result.statuses).filter(([status]) => Number(status) >= 500).reduce((sum, [, count]) => sum + count, 0); assert.equal(accepted, result.completed, "every measured response accepted"); assert.equal(serverErrors, 0, "unexpected 5xx count"); assert.ok(result.throughput >= minimumThroughput, `throughput ${result.throughput} below ${minimumThroughput}`); assert.ok(result.p95 <= maximumP95, `p95 ${result.p95} above ${maximumP95}`); }

export async function launchBrowser(ctx, fixture, { workers = 1, dispatchers = 1, viewport = { width: 1280, height: 900 } } = {}) { await ctx.migrate(); await ctx.seed(fixture.seed); await ctx.npm("build", [], { timeoutMs: 180_000 }); const api = await ctx.startApi({ healthTimeoutMs: 60_000 }); const workerRecords = await Promise.all(Array.from({ length: workers }, () => ctx.startWorker())); const domain = await ctx.receiver({ path: "/events" }); const dispatcherRecords = await Promise.all(Array.from({ length: dispatchers }, () => ctx.startDispatcher({ webhookUrl: domain.url }))); const chromium = await ctx.loadChromium(); const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true }); ctx.defer(() => browser.close()); const page = await browser.newPage({ viewport }); await page.goto(api.baseUrl, { waitUntil: "networkidle" }); return { api, workerRecords, domain, dispatcherRecords, browser, page }; }
export async function fillVisible(page, name, value) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(words.join("[\\s_-]*"), "i");
  const target = page.getByLabel(pattern).and(page.locator("input:visible,textarea:visible,select:visible"))
    .or(page.locator(`[name="${name}"]:visible`)).first();
  await target.waitFor({ state: "visible" });
  if (await target.evaluate(element => element.tagName === "SELECT")) {
    const options = await target.locator("option").evaluateAll(items => items.map(item => ({ value: item.value, label: item.label })));
    const match = options.find(option => option.value === String(value) || option.label === String(value));
    assert.ok(match, `visible control ${name} has requested option`);
    return target.selectOption(match.value);
  }
  return target.fill(String(value));
}
export async function clickVisible(page, name) { const button = page.getByRole("button", { name: new RegExp(name, "i") }).first(); assert.ok(await button.count(), `visible action ${name}`); await button.click(); }
export async function visibleText(page, expression) { const locator = page.getByText(expression).and(page.locator(":visible")).first(); await locator.waitFor({ state: "visible" }); return locator; }
