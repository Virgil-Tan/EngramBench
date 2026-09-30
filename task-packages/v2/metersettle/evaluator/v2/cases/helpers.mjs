const { fillUiContext, navigateReadView } = await import(new URL("browser.mjs", process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url)));
import { candidateAssert as assert } from "../lib/execution.mjs";

import {
  assertDomainEvent,
  assertOpenApiDocument,
  assertPublicError,
  assertSnapshot,
  assertStatement,
  assertStatementRevision,
  assertUsageBatch,
  canonicalJson,
  exactKeys,
} from "../oracles/index.mjs";
import { CaseExcluded } from "../lib/execution.mjs";

export function defineCase(id, fixtureFamily, action, oracle, seams, run) {
  return Object.freeze({ id, taskId: "metersettle", fixtureFamily, action, oracle, seams: Object.freeze([...seams]), run });
}

export function caseResult(ctx, details = {}, diagnostics = []) {
  return ctx.pass({ evidence: [{ taskId: "metersettle", caseId: ctx.caseId, ...details }], ...(diagnostics.length ? { diagnostics } : {}) });
}

export function blocked(assertionId, blockedBy) { return { assertionId, blockedBy }; }

export function requireStatus(ctx, response, expected, label = "request", options = {}) {
  const accepted = Array.isArray(expected) ? expected : [expected];
  ctx.ok(accepted.includes(response.status), `${label} expected ${accepted.join("/")}, got ${response.status}: ${response.text}`, options);
  return response.json;
}

export function expectError(ctx, response, status, code, options = {}) {
  ctx.assert(`${code} exact public error`, () => assertPublicError(response, status, code), options);
  return response;
}

export function usageBody(tenantId, events) {
  return { tenantId, events: events.map(({ eventId, meterId, occurredAt, quantity }) => ({ eventId, meterId, occurredAt, quantity })) };
}

export function correctionBody(tenantId, corrections) {
  return { tenantId, corrections: corrections.map(({ correctionId, sourceEventId, quantityDelta, reason, occurredAt }) => ({ correctionId, sourceEventId, quantityDelta, reason, occurredAt })) };
}

export async function boot(ctx, options = {}) {
  if (options.install) await ctx.command("npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: 300_000 });
  if (options.migrate !== false) await ctx.migrate({ timeoutMs: 180_000 });
  if (options.build) await ctx.npm("build", [], { timeoutMs: 300_000 });
  const family = options.family ?? ctx.fixtures.rating();
  if (options.seed !== false) await ctx.seed(options.seed ?? family.seed, { timeoutMs: 180_000 });
  const apis = [];
  for (let index = 0; index < (options.apiCount ?? 1); index += 1) apis.push(await ctx.startApi({ healthTimeoutMs: 60_000 }));
  return { family, apis, api: apis[0] };
}

export async function snapshot(ctx, baseUrl, options = {}) {
  const value = await ctx.snapshot(baseUrl, options);
  ctx.assert("exact point-in-time verification snapshot", () => assertSnapshot(value, { final: options.final ?? true }), options.assertionOptions);
  return value;
}

export async function waitSnapshot(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const value = await ctx.snapshot(baseUrl, { timeoutMs: options.requestTimeoutMs });
    return predicate(value) ? value : undefined;
  }, { timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 100, label: options.label ?? "MeterSettle durable state", processes: options.processes ?? [] });
}

export function statementValue(value) { return value?.statement ?? value; }
export function statementDetail(value) {
  exactKeys(value, ["statement", "revisions", "effectiveTotalMinor", "pendingRevision"], "StatementDetail");
  assertStatement(value.statement); assert.ok(Array.isArray(value.revisions)); value.revisions.forEach(assertStatementRevision); assert.deepEqual(value.revisions.map(({ revision }) => revision), [...value.revisions.map(({ revision }) => revision)].sort((a, b) => a - b), "StatementDetail revisions ascending"); assert.ok(Number.isSafeInteger(value.effectiveTotalMinor)); assert.ok(value.pendingRevision === null || Number.isSafeInteger(value.pendingRevision)); const finalized = value.revisions.filter(({ state }) => state === "FINALIZED").at(-1); assert.equal(value.effectiveTotalMinor, finalized?.effectiveTotalMinor ?? value.statement.totalMinor, "StatementDetail effective total excludes pending"); const pending = value.revisions.find(({ state }) => state === "FINALIZING"); assert.equal(value.pendingRevision, pending?.revision ?? null, "StatementDetail pendingRevision");
  return value;
}
export function statementFor(snapshotValue, tenantId, periodStart) { return snapshotValue.resources.statements.find((item) => item.tenantId === tenantId && item.periodStart === periodStart); }
export function workFor(snapshotValue, aggregateId) { return snapshotValue.work.filter((item) => aggregateId === undefined || item.aggregateId === aggregateId); }
export function eventsFor(snapshotValue, aggregateId, type) { return snapshotValue.events.filter((item) => (aggregateId === undefined || item.aggregateId === aggregateId) && (type === undefined || item.type === type)); }

export async function ingest(ctx, baseUrl, family, events = family.events, options = {}) {
  const response = await ctx.usageBatch(baseUrl, usageBody(options.tenantId ?? family.tenant.tenantId, events), options);
  const body = requireStatus(ctx, response, 202, options.label ?? "usage batch", options.assertionOptions);
  ctx.assert("UsageBatch exact response", () => assertUsageBatch(body));
  return response;
}

export async function finalize(ctx, baseUrl, family, options = {}) {
  const through = options.through ?? family.through ?? "2035-03-01T00:00:00.000Z";
  const response = await ctx.advanceWatermark(baseUrl, options.tenantId ?? family.tenant.tenantId, through, { key: options.key });
  requireStatus(ctx, response, 200, "advance Watermark", options.assertionOptions);
  const workers = [];
  for (let index = 0; index < (options.workerCount ?? 2); index += 1) workers.push(await ctx.startWorker(options.workerOptions ?? {}));
  const result = await waitSnapshot(ctx, baseUrl, (state) => {
    const relevant = state.work.filter(({ kind }) => kind === "RATING");
    return relevant.length > 0 && relevant.every(({ terminal }) => terminal) && state.resources.statements.filter(({ tenantId }) => tenantId === (options.tenantId ?? family.tenant.tenantId)).every(({ periodEnd, state: statementState }) => periodEnd > through || statementState === "FINALIZED") ? state : undefined;
  }, { label: "Rating backlog drain", timeoutMs: options.timeoutMs ?? 180_000, processes: workers });
  return { response, workers, snapshot: result };
}

export function stableSemantic(ctx, responses, label, options = {}) {
  ctx.ok(responses.length > 0, `${label} has responses`);
  ctx.equal(new Set(responses.map(({ status }) => status)).size, 1, `${label} status stable`, options);
  ctx.equal(new Set(responses.map(({ json }) => canonicalJson(json))).size, 1, `${label} JSON stable`, options);
  return responses[0];
}

export function exactIdSets(ctx, response, acceptedKey, duplicateKey, accepted, duplicate, label) {
  const body = response.json;
  ctx.equal(body[acceptedKey], accepted, `${label} accepted set`);
  ctx.equal(body[duplicateKey], duplicate, `${label} duplicate set`);
  ctx.equal(body[acceptedKey].length, new Set(body[acceptedKey]).size, `${label} accepted unique`);
  ctx.equal(body[duplicateKey].length, new Set(body[duplicateKey]).size, `${label} duplicate unique`);
}

export function assertNoSecret(value, sentinels = []) {
  const text = typeof value === "string" ? value : canonicalJson(value);
  for (const secret of sentinels) if (secret) assert.equal(text.includes(secret), false, "secret exposed");
  assert.equal(/(?:idempotency|barrier|lease)[_-]?token/i.test(text), false, "token-named material exposed");
  return true;
}

export function openApi(ctx, value, options = {}) { ctx.assert("independent OpenAPI 3.1 contract", () => assertOpenApiDocument(value, options)); return value; }

export function requireV1Workspace(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  return ctx.forWorkspace(ctx.v1Workspace);
}

export async function crashAtWorkerBarrier(ctx, baseUrl, point, options = {}) {
  let hold = true;
  const barrier = await ctx.barrier({ hold: (body) => hold && body.processRole === "worker" && body.point === point });
  const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const entry = await barrier.waitFor(({ json }) => json.point === point, { timeoutMs: 90_000, processes: [worker] });
  const before = await ctx.snapshot(baseUrl);
  await ctx.kill(worker); hold = false;
  await ctx.sleep(options.leaseWaitMs ?? 3_200);
  const replacement = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const after = await waitSnapshot(ctx, baseUrl, (state) => state.work.some(({ workId, terminal }) => workId === entry.json.workId && terminal) ? state : undefined, { label: `${point} replacement completion`, timeoutMs: 180_000, processes: [replacement] });
  return { barrier, entry, before, after, worker, replacement };
}

export async function launchBrowser(ctx, api, options = {}) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", headless: true });
  ctx.defer(() => browser.close());
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 1280, height: 900 } });
  await page.goto(api.baseUrl, { waitUntil: "networkidle" });
  await fillUiContext(page, [[/admin.*token/i, ctx.adminToken], [/^tenant(?: id)?$/i, ctx.fixtures.browser().tenant.tenantId], [/^meter(?: id)?$/i, ctx.fixtures.browser().meters[0].meterId]]); await navigateReadView(page, /snapshot/i) || await navigateReadView(page, /^refresh$/i); await page.waitForLoadState("networkidle");
  return { browser, page };
}

export async function publishedGate(ctx, script, timeoutMs = 600_000) {
  const result = await ctx.npm(script, [], { timeoutMs });
  ctx.equal(result.exitCode, 0, `${script} exit status`);
  ctx.ok(result.durationMs > 0, `${script} executed`);
  return result;
}

export function eventOracle(ctx, events, allowedTypes) {
  for (const event of events) { ctx.assert("exact DomainEvent", () => assertDomainEvent(event)); ctx.ok(allowedTypes.includes(event.type), `published event type ${event.type}`); }
}
