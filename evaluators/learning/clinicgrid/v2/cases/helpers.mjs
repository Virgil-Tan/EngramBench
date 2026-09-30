import assert from "node:assert/strict";

import { baseSeed } from "../fixtures/index.mjs";
import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { assertCalendarExclusivity, assertCompleteBundles, assertEventLedger, canonicalJson, percentile } from "../oracles/index.mjs";

const builds = new Map();
export const APPOINTMENT_KEYS = Object.freeze(["appointmentId", "patientId", "serviceTypeId", "clinicianId", "roomId", "equipmentUnitIds", "startAt", "endAt", "state", "expiresAt", "confirmedAt", "terminalAt", "sequence"]);
export const CARE_PLAN_KEYS = Object.freeze(["carePlanId", "patientId", "state", "visits", "expiresAt", "createdAt", "terminalAt", "sequence"]);
export const WAITLIST_KEYS = Object.freeze(["waitlistEntryId", "patientId", "serviceTypeId", "earliestStart", "latestEnd", "priority", "state", "joinedAt", "appointmentId"]);
export const CARE_PLAN_WAITLIST_KEYS = Object.freeze(["waitlistEntryId", "patientId", "priority", "visits", "state", "joinedAt", "carePlanId"]);
export const WORK_KEYS = Object.freeze(["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"]);
export const FINAL_RESOURCES = Object.freeze(["clinicians", "rooms", "equipmentUnits", "serviceTypes", "patients", "appointments", "waitlistEntries", "carePlans", "carePlanWaitlistEntries"]);

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^(?:SLOT|PLAN|RACE|MIGRATE|LOAD)-\d{2}$/u.test(id) || !/^CG-F-/u.test(fixtureFamily ?? "") || action?.length < 24 || oracle?.length < 24 || typeof run !== "function") throw new TypeError("invalid ClinicGrid case definition");
  return Object.freeze({ taskId: "clinicgrid", id, fixtureFamily, action, oracle, run });
}

export function guardedCase(definition, hardCapIds = []) {
  return defineCase({ ...definition, async run(ctx) {
    try { return await definition.run(ctx); }
    catch (error) { if (error && typeof error === "object") error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])]; throw error; }
  } });
}

export function candidateFailure(message, suffix = "ASSERTION_FAILED", hardCapIds = []) { throw new CaseFailure(message, { failureCodeSuffix: suffix, hardCapIds }); }
export function exactKeys(value, keys, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`); return value; }
export function errorCode(response) { return response.json?.error?.code; }
export function expectStatus(ctx, response, status, label, options = {}) { ctx.equal(response.status, status, `${label} status`, options); return response.json; }
export function expectSuccess(ctx, response, label, status = 200, options = {}) { expectStatus(ctx, response, status, label, options); ctx.ok(response.json && typeof response.json === "object", `${label} JSON`, options); return response.json; }
export function expectError(ctx, response, status, code, label, options = {}) {
  expectStatus(ctx, response, status, label, options);
  exactKeys(response.json, ["error"], `${label} error envelope`);
  exactKeys(response.json.error, ["code", "message", "details"], `${label} error`);
  ctx.equal(response.json.error.code, code, `${label} code`, options);
  ctx.ok(typeof response.json.error.message === "string" && response.json.error.details && typeof response.json.error.details === "object", `${label} error fields`, options);
  return response.json.error;
}

export function coreSeed(ctx, options = {}) { return baseSeed(ctx.fixtures, options); }
export function clone(value) { return structuredClone(value); }

async function build(ctx, workspace) {
  const target = ctx.forWorkspace(workspace);
  if (!builds.has(target.workspace)) builds.set(target.workspace, target.npm("build", [], { timeoutMs: 600_000 }));
  await builds.get(target.workspace);
}

export async function prepare(ctx, options = {}) {
  const workspace = options.workspace ?? ctx.workspace;
  const target = ctx.forWorkspace(workspace);
  if (options.build !== false) await build(ctx, workspace);
  if (options.migrate !== false) await target.migrate({ timeoutMs: options.migrateTimeoutMs ?? 300_000 });
  if (options.seed) await target.seed(options.seed, { timeoutMs: options.seedTimeoutMs ?? 900_000 });
  ctx.mark("candidate-prepared", { workspace: target.workspace, seeded: Boolean(options.seed) });
  return target;
}

export async function startPreparedApi(ctx, options = {}) { return (await prepare(ctx, options)).startApi(options.api ?? {}); }

export function resource(snapshot, key) { const value = snapshot?.resources?.[key]; assert.ok(Array.isArray(value), `snapshot resource ${key}`); return value; }
export function stableSnapshot(snapshot) { return { resources: clone(snapshot.resources), work: clone(snapshot.work), events: clone(snapshot.events) }; }
export function assertNoChange(ctx, before, after, label) { ctx.equal(stableSnapshot(after), stableSnapshot(before), `${label} has zero durable effects`, { hardCapIds: ["CORRECTNESS_INVARIANT"] }); }

export async function createAppointment(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/appointments", options.key ?? ctx.key(`appointment-${body.patientId}-${body.startAt}`), body);
  if (options.allowFailure) return response;
  const appointment = expectSuccess(ctx, response, options.label ?? "create Appointment", 201, options.assertionOptions);
  exactKeys(appointment, APPOINTMENT_KEYS, "Appointment");
  return { response, appointment };
}

export async function transitionAppointment(ctx, baseUrl, appointmentId, action, body = {}, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/appointments/${appointmentId}/${action}`, options.key ?? ctx.key(`${action}-${appointmentId}`), body);
  if (options.allowFailure) return response;
  const appointment = expectSuccess(ctx, response, `${action} Appointment`);
  exactKeys(appointment, APPOINTMENT_KEYS, "Appointment transition");
  return { response, appointment };
}

export async function createCarePlan(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/care-plans", options.key ?? ctx.key(`care-plan-${body.patientId}-${body.visits.length}`), body, { contractExpectation: options.contractExpectation });
  if (options.allowFailure) return response;
  const plan = expectSuccess(ctx, response, options.label ?? "create Care Plan", 201);
  assertCarePlan(plan);
  return { response, plan };
}

export function assertCarePlan(plan) {
  exactKeys(plan, CARE_PLAN_KEYS, "CarePlan");
  assert.ok(Array.isArray(plan.visits) && plan.visits.length >= 2 && plan.visits.length <= 12, "CarePlan visits must be 2..12");
  plan.visits.forEach((visit, index) => { exactKeys(visit, ["visitIndex", "appointment"], "CarePlan visit"); assert.equal(visit.visitIndex, index + 1); exactKeys(visit.appointment, APPOINTMENT_KEYS, "CarePlan Appointment"); });
  return plan;
}

export async function readCarePlan(ctx, baseUrl, carePlanId) {
  const response = await ctx.request(baseUrl, `/api/v1/care-plans/${carePlanId}`);
  return assertCarePlan(expectSuccess(ctx, response, "read Care Plan"));
}

export async function transitionVisit(ctx, baseUrl, planId, visitIndex, action, body = {}, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/care-plans/${planId}/visits/${visitIndex}/${action}`, options.key ?? ctx.key(`${action}-${planId}-${visitIndex}`), body);
  if (options.allowFailure) return response;
  return { response, plan: assertCarePlan(expectSuccess(ctx, response, `${action} Care Plan visit`)) };
}

export async function terminateCarePlan(ctx, baseUrl, carePlanId, reason, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/care-plans/${carePlanId}/terminate`, options.key ?? ctx.key(`terminate-${carePlanId}`), { reason });
  if (options.allowFailure) return response;
  return { response, plan: assertCarePlan(expectSuccess(ctx, response, "terminate Care Plan")) };
}

export async function createWaitlist(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/waitlist-entries", options.key ?? ctx.key(`waitlist-${body.patientId}`), body);
  if (options.allowFailure) return response;
  const item = expectSuccess(ctx, response, "create Waitlist Entry", 201);
  exactKeys(item, body.visits ? CARE_PLAN_WAITLIST_KEYS : WAITLIST_KEYS, body.visits ? "CarePlanWaitlistEntry" : "WaitlistEntry");
  return { response, item };
}

export async function waitForDrain(ctx, baseUrl, options = {}) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); return (snapshot.work ?? []).filter(options.predicate ?? (() => true)).every(({ terminal }) => terminal) ? snapshot : false; }, {
    timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 20, label: options.label ?? "ClinicGrid Work drainage", processes: options.processes,
  });
}

export async function waitForWork(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); const work = (snapshot.work ?? []).find(predicate); return work ? { snapshot, work } : false; }, {
    timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 5, label: options.label ?? "public Work", processes: options.processes,
  });
}

export function assertWork(snapshot) {
  for (const work of snapshot.work ?? []) {
    exactKeys(work, WORK_KEYS, "Work");
    assert.ok(["APPOINTMENT_EXPIRY", "WAITLIST_PROMOTION"].includes(work.kind));
    assert.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state));
    assert.equal(work.state === "LEASED", work.leaseOwner !== null && work.leaseExpiresAt !== null);
  }
}

export function assertInvariants(ctx, snapshot) {
  try { assertCalendarExclusivity(resource(snapshot, "appointments")); assertCompleteBundles(snapshot); assertEventLedger(snapshot.events ?? []); }
  catch (error) { candidateFailure(error.message, "POST_STATE", ["CORRECTNESS_INVARIANT"]); }
  assertWork(snapshot);
  const text = canonicalJson(snapshot);
  ctx.ok(!/(?:authorization|idempotency|adminToken|leaseToken|database_url|postgres(?:ql)?:\/\/|private path)/iu.test(text), "snapshot redacts secrets and tokens", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
}

export async function calendar(ctx, baseUrl, type, id, from, to) {
  const response = await ctx.request(baseUrl, `/api/v1/resources/${type}/${id}/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  return expectSuccess(ctx, response, `${type} calendar`);
}

export async function crashAtBarrier(ctx, baseUrl, point, workPredicate) {
  const barrier = await ctx.barrier({ hold: (payload) => payload.point === point });
  const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const found = await waitForWork(ctx, baseUrl, (work) => work.state === "LEASED" && workPredicate(work), { processes: [worker], label: `${point} leased Work` });
  const entry = await barrier.waitFor(({ json }) => json?.point === point && json?.workId === found.work.workId, { timeoutMs: 120_000, processes: [worker] });
  ctx.equal(entry.json.leaseTokenHash.length, 64, "barrier publishes only lease token hash");
  await ctx.kill(worker);
  ctx.mark("worker-sigkill", { point, workId: found.work.workId });
  return { barrier, entry, work: found.work };
}

export async function launchBrowser(ctx, baseUrl, viewport = { width: 1280, height: 800 }) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  ctx.defer(() => browser.close());
  const browserContext = await browser.newContext({ viewport });
  const page = await browserContext.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return { browser, browserContext, page };
}

async function firstVisible(locator) { for (let index = 0; index < await locator.count(); index += 1) { const item = locator.nth(index); if (await item.isVisible().catch(() => false)) return item; } }
export async function setControlValue(item, value) {
  const tag = await item.evaluate((element) => element.tagName.toLowerCase());
  if (tag === "select") { await item.selectOption(String(value)); return; }
  const type = await item.getAttribute("type");
  const normalized = type === "datetime-local" ? String(value).replace(/Z$/u, "").slice(0, 23) : String(value);
  await item.fill(normalized);
}
export async function fillField(page, labels, value) { for (const label of Array.isArray(labels) ? labels : [labels]) { const item = await firstVisible(page.getByLabel(label)); if (item) { await setControlValue(item, value); return; } } throw new Error(`missing labelled field ${String(labels)}`); }
export async function clickControl(page, roles, names) { for (const role of Array.isArray(roles) ? roles : [roles]) for (const name of Array.isArray(names) ? names : [names]) { const item = await firstVisible(page.getByRole(role, { name })); if (item) { await item.click(); return; } } throw new Error(`missing visible control ${String(names)}`); }

export async function runWindow({ clients, seconds, operation }) {
  const latencies = []; const statuses = new Map(); let completed = 0; const startedAt = performance.now(); const deadline = startedAt + seconds * 1_000;
  await Promise.all(Array.from({ length: clients }, async (_, client) => {
    while (performance.now() < deadline) {
      const index = completed; completed += 1; const started = performance.now(); const response = await operation(index, client);
      latencies.push(performance.now() - started); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    }
  }));
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  return { completed, durationSeconds, throughput: completed / durationSeconds, p95Ms: percentile(latencies, 0.95), statuses };
}

export function finalEvidence(ctx, values = {}) { return ctx.pass({ evidence: [{ kind: "clinicgrid-case-summary", ...values }] }); }
export { canonicalJson, percentile };
