import { assertSnapshotSchema } from '../oracles/openapi.mjs';
import assert from "node:assert/strict";

import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { activeReservations, assertAggregateProjection, assertCapacityConservation, assertEventSequence, assertSorted, canonicalJson, percentile, selectBundle } from "../oracles/index.mjs";

export { activeReservations, assertAggregateProjection, assertCapacityConservation, selectBundle } from "../oracles/index.mjs";

const builds = new Map();
export const V1_PORT_CALL_KEYS = Object.freeze(["portCallId", "vesselId", "arrivalAt", "departureAt", "requiredTugs", "containerUnits", "berthId", "tugPoolId", "yardWindowId", "state", "expiresAt", "startedAt", "completedAt", "sequence"]);
export const FINAL_PORT_CALL_KEYS = Object.freeze([...V1_PORT_CALL_KEYS, "movements"]);
export const MOVEMENT_KEYS = Object.freeze(["movementId", "portCallId", "type", "berthId", "tugPoolId", "yardWindowId", "startAt", "endAt", "requiredTugs", "containerUnits", "state", "expiresAt", "startedAt", "completedAt", "clearanceTaskId", "sequence"]);
export const STANDBY_KEYS = Object.freeze(["standbyEntryId", "vesselId", "arrivalFrom", "arrivalTo", "durationMinutes", "requiredTugs", "containerUnits", "priority", "state", "requestedAt", "portCallId"]);
export const CLEARANCE_KEYS = Object.freeze(["portCallId", "taskId", "attempt", "state", "checkedRules", "completedAt"]);
export const ALLOCATION_KEYS = Object.freeze(["resourceType", "resourceId", "startAt", "endAt", "quantity"]);
export const V1_RESOURCE_KEYS = Object.freeze(["berths", "tugPools", "yardWindows", "vessels", "portCalls", "resourceAllocations", "standbyEntries", "clearances"]);
export const FINAL_RESOURCE_KEYS = Object.freeze([...V1_RESOURCE_KEYS, "portMovements"]);
export const WORK_KINDS = Object.freeze(["PORT_CALL_EXPIRY", "CLEARANCE", "STANDBY_PROMOTION"]);

const CASE_HARD_CAPS = Object.freeze({
  "A-01": ["PRODUCTION_BOOT"], "A-02": ["MIGRATION_COMPATIBILITY"], "A-03": ["BUNDLE_CONSERVATION"], "A-08": ["BUNDLE_CONSERVATION"], "A-10": ["BUNDLE_CONSERVATION", "EVENT_TRANSACTIONALITY"], "A-12": ["EVENT_TRANSACTIONALITY"], "A-13": ["LINKED_MOVEMENT_ATOMICITY"], "A-14": ["LINKED_MOVEMENT_ATOMICITY"],
  "B-01": ["BUNDLE_CONSERVATION"], "B-02": ["BUNDLE_CONSERVATION"], "B-03": ["BUNDLE_CONSERVATION"], "B-04": ["IDEMPOTENCY_CORRECTNESS"], "B-05": ["IDEMPOTENCY_CORRECTNESS"], "B-06": ["BUNDLE_CONSERVATION"], "B-07": ["BUNDLE_CONSERVATION", "EVENT_TRANSACTIONALITY"], "B-08": ["BUNDLE_CONSERVATION"], "B-09": ["LINKED_MOVEMENT_ATOMICITY", "BUNDLE_CONSERVATION"], "B-10": ["LINKED_MOVEMENT_ATOMICITY"],
  "C-02": ["STALE_WORK_OR_LOST_WORK"], "C-03": ["STALE_WORK_OR_LOST_WORK"], "C-04": ["STALE_WORK_OR_LOST_WORK"], "C-05": ["STALE_WORK_OR_LOST_WORK"], "C-06": ["STALE_WORK_OR_LOST_WORK"], "C-07": ["EVENT_TRANSACTIONALITY"], "C-08": ["EVENT_TRANSACTIONALITY", "STALE_WORK_OR_LOST_WORK"],
  "E-01": ["MIGRATION_COMPATIBILITY"], "E-02": ["MIGRATION_COMPATIBILITY", "IDEMPOTENCY_CORRECTNESS", "EVENT_TRANSACTIONALITY"], "E-03": ["MIGRATION_COMPATIBILITY", "STALE_WORK_OR_LOST_WORK"], "E-04": ["BUNDLE_CONSERVATION"], "E-05": ["STALE_WORK_OR_LOST_WORK", "BUNDLE_CONSERVATION"],
});

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !/^DC-F-/u.test(fixtureFamily ?? "") || typeof action !== "string" || action.length < 24 || typeof oracle !== "string" || oracle.length < 24 || typeof run !== "function" || run.length < 1) throw new TypeError("invalid DockChain case definition");
  const hardCaps = CASE_HARD_CAPS[id] ?? [];
  return Object.freeze({ taskId: "dockchain", id, fixtureFamily, action, oracle, async run(ctx) { try { return await run(ctx); } catch (error) { if (error && typeof error === "object") error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCaps])]; throw error; } } });
}

export function exactKeys(value, keys, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`); return value; }
export function expectStatus(ctx, response, status, label, options = {}) { ctx.equal(response.status, status, `${label} status`, options); return response.json; }
export function expectSuccess(ctx, response, label, status = 200, options = {}) { const value = expectStatus(ctx, response, status, label, options); ctx.ok(value && typeof value === "object", `${label} JSON`, options); return value; }
export function expectError(ctx, response, status, code, label, options = {}) { expectStatus(ctx, response, status, label, options); exactKeys(response.json, ["error"], `${label} envelope`); exactKeys(response.json.error, ["code", "message", "details"], `${label} error`); ctx.equal(response.json.error.code, code, `${label} code`, options); return response.json.error; }
export function assertMovement(value) { exactKeys(value, MOVEMENT_KEYS, "PortMovement"); assert.ok(["ARRIVAL", "DEPARTURE"].includes(value.type)); assert.ok(["HELD", "CLEARED", "IN_SERVICE", "COMPLETED", "CANCELLED", "EXPIRED"].includes(value.state)); assert.ok(Number.isSafeInteger(value.requiredTugs) && value.requiredTugs > 0); assert.ok(Number.isSafeInteger(value.containerUnits) && value.containerUnits > 0); return value; }
export function assertPortCall(value, options = {}) { const final = options.final ?? Object.hasOwn(value ?? {}, "movements"); exactKeys(value, final ? FINAL_PORT_CALL_KEYS : V1_PORT_CALL_KEYS, "PortCall"); assert.ok(["HELD", "CLEARED", "IN_SERVICE", "ARRIVED", "COMPLETED", "CANCELLED", "EXPIRED"].includes(value.state)); if (final) { assert.ok(Array.isArray(value.movements) && [1, 2].includes(value.movements.length)); value.movements.forEach(assertMovement); if (value.movements.length === 2) { assert.deepEqual(value.movements.map(({ type }) => type), ["ARRIVAL", "DEPARTURE"]); for (const field of ["arrivalAt", "departureAt", "requiredTugs", "containerUnits", "berthId", "tugPoolId", "yardWindowId", "expiresAt", "startedAt", "completedAt"]) assert.equal(value[field], null, `new linked ${field}`); assertAggregateProjection(value); } } return value; }
export function assertStandby(value) { exactKeys(value, STANDBY_KEYS, "StandbyEntry"); assert.ok(["WAITING", "PROMOTED", "WITHDRAWN"].includes(value.state)); return value; }
export function assertClearance(value) { exactKeys(value, CLEARANCE_KEYS, "Clearance"); assert.ok(["PENDING", "LEASED", "PASSED", "FAILED"].includes(value.state)); assert.ok(Array.isArray(value.checkedRules)); return value; }

async function build(ctx, workspace) { const target = ctx.forWorkspace(workspace); if (!builds.has(target.workspace)) builds.set(target.workspace, target.npm("build")); await builds.get(target.workspace); }
export async function prepare(ctx, options = {}) { const workspace = options.workspace ?? ctx.workspace; const target = ctx.forWorkspace(workspace); if (options.build !== false) await build(ctx, workspace); if (options.migrate !== false) await target.migrate(); if (options.seed) await target.seed(options.seed); ctx.mark("dockchain-prepared", { workspace: target.workspace, seeded: Boolean(options.seed) }); return target; }
export async function startPreparedApi(ctx, options = {}) { const target = await prepare(ctx, options); return { target, api: await target.startApi({ env: options.env }) }; }

export async function createPortCall(ctx, baseUrl, body, options = {}) { const response = await ctx.mutate(baseUrl, "/api/v1/port-calls", options.key ?? ctx.key(`call:${body.vesselId}:${body.arrivalAt ?? body.arrival.startAt}`), body, options); if (options.allowFailure) return response; return assertPortCall(expectSuccess(ctx, response, options.label ?? "create Port Call", 201), { final: options.final }); }
export async function getPortCall(ctx, baseUrl, portCallId, options = {}) { return assertPortCall(expectSuccess(ctx, await ctx.request(baseUrl, `/api/v1/port-calls/${portCallId}`), "get Port Call"), { final: options.final }); }
export async function confirmPortCall(ctx, baseUrl, portCallId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/port-calls/${portCallId}/confirm`, options.key ?? ctx.key(`confirm:${portCallId}`), {}, options); if (options.allowFailure) return response; return assertPortCall(expectSuccess(ctx, response, options.label ?? "confirm Port Call"), { final: options.final }); }
export async function startPortCall(ctx, baseUrl, portCallId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/port-calls/${portCallId}/start-service`, options.key ?? ctx.key(`start:${portCallId}`), {}, options); if (options.allowFailure) return response; return assertPortCall(expectSuccess(ctx, response, options.label ?? "start Port Call"), { final: options.final }); }
export async function completePortCall(ctx, baseUrl, portCallId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/port-calls/${portCallId}/complete`, options.key ?? ctx.key(`complete:${portCallId}`), {}, options); if (options.allowFailure) return response; return assertPortCall(expectSuccess(ctx, response, options.label ?? "complete Port Call"), { final: options.final }); }
export async function cancelPortCall(ctx, baseUrl, portCallId, reason = "operator cancellation", options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/port-calls/${portCallId}/cancel`, options.key ?? ctx.key(`cancel:${portCallId}`), { reason }, options); if (options.allowFailure) return response; return assertPortCall(expectSuccess(ctx, response, options.label ?? "cancel Port Call"), { final: options.final }); }
export async function movementAction(ctx, baseUrl, portCallId, movementId, action, options = {}) { const body = action === "cancel" ? { reason: options.reason ?? "movement cancellation" } : {}; const response = await ctx.mutate(baseUrl, `/api/v1/port-calls/${portCallId}/movements/${movementId}/${action}`, options.key ?? ctx.key(`movement:${action}:${movementId}`), body, options); if (options.allowFailure) return response; return assertMovement(expectSuccess(ctx, response, options.label ?? `${action} movement`)); }
export async function createStandby(ctx, baseUrl, body, options = {}) { const response = await ctx.mutate(baseUrl, "/api/v1/standby-entries", options.key ?? ctx.key(`standby:${body.vesselId}:${body.priority}:${body.arrivalFrom}`), body, options); if (options.allowFailure) return response; return assertStandby(expectSuccess(ctx, response, options.label ?? "create Standby Entry", 201)); }
export async function feasibleWindows(ctx, baseUrl, query) { const response = await ctx.request(baseUrl, `/api/v1/port-resources/feasible-windows?${new URLSearchParams(query)}`); const value = expectSuccess(ctx, response, "feasible windows"); exactKeys(value, ["items", "nextCursor"], "FeasibleWindowPage"); return value; }

export async function waitForSnapshot(ctx, baseUrl, predicate, options = {}) { return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); return predicate(snapshot) ? snapshot : false; }, { timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 100, label: options.label ?? "DockChain snapshot condition", processes: options.processes ?? [] }); }
export async function waitForWorkDrain(ctx, baseUrl, predicate, processes = [], timeoutMs = 120_000) { return waitForSnapshot(ctx, baseUrl, (snapshot) => { const work = snapshot.work.filter(predicate); return work.length > 0 && work.every(({ terminal }) => terminal); }, { timeoutMs, label: "DockChain Work drain", processes }); }
export async function waitForCallState(ctx, baseUrl, portCallId, states, processes = [], timeoutMs = 120_000) { const accepted = new Set(Array.isArray(states) ? states : [states]); return waitForSnapshot(ctx, baseUrl, (snapshot) => accepted.has(snapshot.resources.portCalls.find((item) => item.portCallId === portCallId)?.state), { timeoutMs, label: `Port Call ${portCallId} ${[...accepted].join("/")}`, processes }); }
export async function waitForMovementState(ctx, baseUrl, movementId, states, processes = [], timeoutMs = 120_000) { const accepted = new Set(Array.isArray(states) ? states : [states]); return waitForSnapshot(ctx, baseUrl, (snapshot) => accepted.has(snapshot.resources.portMovements.find((item) => item.movementId === movementId)?.state), { timeoutMs, label: `Port Movement ${movementId} ${[...accepted].join("/")}`, processes }); }

export function startDockWorker(target, options = {}) { return target.startWorker(options); }
export function startDockDispatcher(target, receiver, options = {}) { return target.startDispatcher({ ...options, webhookUrl: receiver.url }); }
export async function crashAtBarrier(ctx, target, point, predicate = () => true) { const barrier = await ctx.barrier({ hold: (payload) => payload.point === point && predicate(payload) }); const worker = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); const entry = await barrier.waitFor(({ json }) => json?.point === point && predicate(json), { timeoutMs: 120_000, processes: [worker] }); await ctx.kill(worker); return { barrier, worker, entry }; }

export function assertSnapshot(ctx, snapshot, options = {}) {
  const final = options.final !== false; if(final)assertSnapshotSchema(snapshot); exactKeys(snapshot, ["asOf", "resources", "work", "events"], "verification snapshot"); ctx.equal(Object.keys(snapshot.resources).sort(), [...(final ? FINAL_RESOURCE_KEYS : V1_RESOURCE_KEYS)].sort(), `${final ? "FINAL" : "V1"} resource union`);
  for (const call of snapshot.resources.portCalls) assertPortCall(call, { final }); for (const allocation of snapshot.resources.resourceAllocations) exactKeys(allocation, ALLOCATION_KEYS, "ResourceAllocation"); for (const entry of snapshot.resources.standbyEntries) assertStandby(entry); for (const clearance of snapshot.resources.clearances) assertClearance(clearance); if (final) for (const movement of snapshot.resources.portMovements) assertMovement(movement);
  const sorts = { berths: ["berthId"], tugPools: ["tugPoolId"], yardWindows: ["yardWindowId"], vessels: ["vesselId"], portCalls: ["portCallId"], resourceAllocations: ["resourceType", "resourceId", "startAt", "endAt"], standbyEntries: ["standbyEntryId"], clearances: ["portCallId", "taskId"], portMovements: ["portCallId", "movementId"] }; for (const [name, paths] of Object.entries(sorts)) if (snapshot.resources[name]) assertSorted(snapshot.resources[name], paths);
  for (const work of snapshot.work) { exactKeys(work, ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"], "Work"); ctx.ok(WORK_KINDS.includes(work.kind), `published Work kind ${work.kind}`); ctx.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state), `${work.workId} terminal`); ctx.equal(work.state === "LEASED", work.leaseOwner !== null && work.leaseExpiresAt !== null, `${work.workId} lease fields`); }
  for (const event of snapshot.events) exactKeys(event, ["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"], "DomainEvent"); assertSorted(snapshot.events, ["aggregateId", "sequence", "eventId"]); assertEventSequence(snapshot.events); assertCapacityConservation(snapshot); ctx.ok(!/(?:adminToken|leaseToken|idempotencyKey|postgres(?:ql)?:\/\/|\/(?:Users|home|tmp)\/)/iu.test(canonicalJson(snapshot)), "snapshot omits tokens, keys and private paths"); return snapshot;
}

export async function launchBrowser(ctx, baseUrl, viewport = { width: 1280, height: 800 }) { const chromium = await ctx.loadChromium(); const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] }); ctx.defer(() => browser.close()); const browserContext = await browser.newContext({ viewport }); const page = await browserContext.newPage(); await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 }); return { browser, browserContext, page }; }
async function firstVisible(locator) { for (let index = 0; index < await locator.count(); index += 1) { const item = locator.nth(index); if (await item.isVisible().catch(() => false)) return item; } }
export async function visibleControl(page, roles, names) { for (const role of roles) for (const name of names) { const item = await firstVisible(page.getByRole(role, { name })); if (item) return item; } throw new Error(`missing visible ${roles.join("/")} control for ${names.join("/")}`); }
export async function visibleField(page, names) { for (const name of names) { const item = await firstVisible(page.getByLabel(name)); if (item) return item; } throw new Error(`missing visible field for ${names.join("/")}`); }
export async function browserMutation(page, pattern, pathPattern) { const response = page.waitForResponse((value) => value.request().method() === "POST" && pathPattern.test(new URL(value.url()).pathname), { timeout: 30_000 }); await (await visibleControl(page, ["button", "link"], [pattern])).click(); return response; }

export async function runClosedLoop({ clients, warmupMs, measureMs, operation }) {
  let ordinal = 0; const samples = []; const statuses = new Map();
  async function phase(durationMs, measuring) {
    const phaseName = measuring ? "measure" : "warmup"; const startedAt = performance.now(); const deadline = startedAt + durationMs;
    const loops = Array.from({ length: clients }, async (_, client) => {
      while (performance.now() < deadline) {
        const current = ordinal += 1; const requestStartedAt = performance.now();
        const response = await operation({ client, ordinal: current, measuring, phase: phaseName });
        if (measuring) { samples.push(performance.now() - requestStartedAt); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1); }
      }
    });
    await Promise.all(loops);
    return performance.now() - startedAt;
  }
  const warmupElapsedMs = await phase(warmupMs, false);
  ordinal = 0;
  const measuredElapsedMs = await phase(measureMs, true);
  return { count: samples.length, durationMs: measureMs, measureWindowMs: measureMs, warmupElapsedMs, measuredElapsedMs, throughput: samples.length / (measureMs / 1000), p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95), p99Ms: percentile(samples, 0.99), statuses };
}
export function countStatuses(load, predicate) { return [...load.statuses].filter(([status]) => predicate(status)).reduce((sum, [, value]) => sum + value, 0); }

export function requireV1(ctx) { if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint"); return ctx.v1Workspace; }
export function finalEvidence(ctx, values = {}) { return ctx.pass({ evidence: [{ kind: "dockchain-case-summary", ...values }] }); }
export function candidateFailure(message, suffix = "ASSERTION_FAILED", hardCapIds = []) { throw new CaseFailure(message, { failureCodeSuffix: suffix, hardCapIds }); }
