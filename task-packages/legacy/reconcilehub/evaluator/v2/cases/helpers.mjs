import assert from "node:assert/strict";

import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { assertEventLedger, assertOwnershipAndConservation, canonicalJson, percentile } from "../oracles/index.mjs";

const builds = new Map();
export const STATEMENT_BATCH_KEYS = Object.freeze(["batchId", "source", "batchKey", "digest", "state", "lineCount", "createdAt"]);
export const STATEMENT_LINE_KEYS = Object.freeze(["statementLineId", "batchId", "externalId", "bookedAt", "currency", "amountMinor", "reference", "state", "revision"]);
export const LEDGER_ENTRY_KEYS = Object.freeze(["ledgerEntryId", "postedAt", "currency", "amountMinor", "reference", "state", "revision"]);
export const MATCH_KEYS = Object.freeze(["matchId", "statementLineId", "ledgerEntryId", "state", "score", "reasons", "createdAt", "confirmedAt", "reversedAt", "sequence"]);
export const MATCH_GROUP_KEYS = Object.freeze(["matchGroupId", "matchId", "statementLineId", "ledgerEntryId", "statementLineIds", "ledgerEntryIds", "currency", "statementTotalMinor", "ledgerTotalMinor", "state", "createdAt", "confirmedAt", "reversedAt", "sequence"]);
export const WORK_KEYS = Object.freeze(["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"]);
export const EVENT_KEYS = Object.freeze(["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"]);

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !/^RH-F-/u.test(fixtureFamily ?? "") || action?.length < 24 || oracle?.length < 24 || typeof run !== "function") throw new TypeError("invalid ReconcileHub case definition");
  return Object.freeze({ taskId: "reconcilehub", id, fixtureFamily, action, oracle, run });
}

export function guardedCase(definition, hardCapIds = []) {
  return defineCase({ ...definition, async run(ctx) {
    try { return await definition.run(ctx); }
    catch (error) {
      if (error && typeof error === "object") error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
      throw error;
    }
  } });
}

export function candidateFailure(message, suffix = "ASSERTION_FAILED", hardCapIds = []) { throw new CaseFailure(message, { failureCodeSuffix: suffix, hardCapIds }); }
export function exactKeys(value, keys, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`); return value; }
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

export function assertStatementBatch(value) { exactKeys(value, STATEMENT_BATCH_KEYS, "StatementBatch"); assert.equal(value.state, "IMPORTED"); assert.ok(Number.isSafeInteger(value.lineCount) && value.lineCount >= 0); return value; }
export function assertStatementLine(value) { exactKeys(value, STATEMENT_LINE_KEYS, "StatementLine"); assert.ok(["UNMATCHED", "MATCHED", "IGNORED"].includes(value.state)); assert.ok(Number.isSafeInteger(value.amountMinor) && value.amountMinor !== 0); assert.ok(Number.isSafeInteger(value.revision) && value.revision > 0); return value; }
export function assertLedgerEntry(value) { exactKeys(value, LEDGER_ENTRY_KEYS, "LedgerEntry"); assert.ok(["UNMATCHED", "MATCHED"].includes(value.state)); assert.ok(Number.isSafeInteger(value.amountMinor) && value.amountMinor !== 0); assert.ok(Number.isSafeInteger(value.revision) && value.revision > 0); return value; }
export function assertMatch(value) { exactKeys(value, MATCH_KEYS, "Match"); assert.ok(["PROPOSED", "CONFIRMED", "REJECTED", "REVERSED"].includes(value.state)); assert.ok(Number.isSafeInteger(value.score)); assert.ok(Array.isArray(value.reasons)); return value; }
export function assertMatchGroup(value) {
  exactKeys(value, MATCH_GROUP_KEYS, "MatchGroup");
  assert.ok(["PROPOSED", "CONFIRMED", "REJECTED", "REVERSED"].includes(value.state));
  assert.ok(value.statementLineIds.length >= 1 && value.statementLineIds.length <= 20 && value.ledgerEntryIds.length >= 1 && value.ledgerEntryIds.length <= 20);
  assert.deepEqual(value.statementLineIds, [...value.statementLineIds].sort()); assert.deepEqual(value.ledgerEntryIds, [...value.ledgerEntryIds].sort());
  if (value.statementLineIds.length === 1 && value.ledgerEntryIds.length === 1) assert.deepEqual([value.matchId, value.statementLineId, value.ledgerEntryId], [value.matchGroupId, value.statementLineIds[0], value.ledgerEntryIds[0]]);
  else assert.deepEqual([value.matchId, value.statementLineId, value.ledgerEntryId], [null, null, null]);
  return value;
}

async function build(ctx, workspace) {
  const target = ctx.forWorkspace(workspace);
  if (!builds.has(target.workspace)) builds.set(target.workspace, target.npm("build", [], { timeoutMs: 600_000 }));
  await builds.get(target.workspace);
}

export async function prepare(ctx, options = {}) {
  const workspace = options.workspace ?? ctx.workspace; const target = ctx.forWorkspace(workspace);
  if (options.build !== false) await build(ctx, workspace);
  if (options.migrate !== false) await target.migrate({ timeoutMs: options.migrateTimeoutMs ?? 300_000 });
  if (options.seed) await target.seed(options.seed, { timeoutMs: options.seedTimeoutMs ?? 900_000 });
  ctx.mark("candidate-prepared", { workspace: target.workspace, seeded: Boolean(options.seed) });
  return target;
}

export async function startPreparedApi(ctx, options = {}) { return (await prepare(ctx, options)).startApi(options.api ?? {}); }

export function seedWithRecords(fixtures, { label, statementLines, ledgerEntries, matches = [] }) {
  const groups = new Map();
  for (const line of statementLines) {
    const batchId = line.batchId;
    const values = groups.get(batchId) ?? [];
    values.push(line); groups.set(batchId, values);
  }
  const statementBatches = [...groups.entries()].map(([batchId, lines], index) => ({
    batchId,
    source: `fixture-${label}-${index}`,
    batchKey: `fixture-${label}-${index}`,
    digest: fixtures.sha(`fixture-${label}-${index}`),
    createdAt: fixtures.at({ minutes: -10 + index }),
    lines: lines.map(({ batchId: _batchId, revision: _revision, ...line }) => line),
  }));
  return { schemaVersion: 1, seedVersion: `rh-${label}-${fixtures.sha(label).slice(0, 12)}`, ledgerEntries: structuredClone(ledgerEntries), statementBatches, matches: structuredClone(matches) };
}

export function resource(snapshot, name) { const value = snapshot?.resources?.[name]; assert.ok(Array.isArray(value), `snapshot resource ${name}`); return value; }
export function stableSnapshot(snapshot) { return { resources: structuredClone(snapshot.resources), work: structuredClone(snapshot.work), events: structuredClone(snapshot.events) }; }
export function assertNoChange(ctx, before, after, label, hardCapIds = ["CONSERVATION_OR_ATOMICITY"]) { ctx.equal(stableSnapshot(after), stableSnapshot(before), `${label} has zero durable effects`, { hardCapIds }); }

export async function importBatch(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/statement-batches", options.key ?? ctx.key(`batch-${body.source}-${body.batchKey}`), body);
  if (options.allowFailure) return response;
  const value = expectSuccess(ctx, response, options.label ?? "import Statement Batch", 202, options.assertionOptions);
  ctx.ok(typeof value.batchId === "string", "Statement Batch response has stable batchId", options.assertionOptions);
  return { response, value };
}

export async function createMatch(ctx, baseUrl, statementLineId, ledgerEntryId, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/matches", options.key ?? ctx.key(`match-${statementLineId}-${ledgerEntryId}`), { statementLineId, ledgerEntryId });
  if (options.allowFailure) return response;
  return { response, match: assertMatch(expectSuccess(ctx, response, options.label ?? "create Match", 201, options.assertionOptions)) };
}

export async function matchAction(ctx, baseUrl, matchId, action, body, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/matches/${matchId}/${action}`, options.key ?? ctx.key(`${action}-${matchId}`), body);
  if (options.allowFailure) return response;
  return { response, match: assertMatch(expectSuccess(ctx, response, `${action} Match`, 200, options.assertionOptions)) };
}

export async function ignoreLine(ctx, baseUrl, statementLineId, expectedRevision, reason, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/statement-lines/${statementLineId}/ignore`, options.key ?? ctx.key(`ignore-${statementLineId}`), { expectedRevision, reason });
  if (options.allowFailure) return response;
  return { response, line: assertStatementLine(expectSuccess(ctx, response, "ignore Statement Line")) };
}

export async function createGroup(ctx, baseUrl, statementLineIds, ledgerEntryIds, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/match-groups", options.key ?? ctx.key(`group-${statementLineIds.join("-")}-${ledgerEntryIds.join("-")}`), { statementLineIds, ledgerEntryIds });
  if (options.allowFailure) return response;
  return { response, group: assertMatchGroup(expectSuccess(ctx, response, options.label ?? "create Match Group", 201, options.assertionOptions)) };
}

export async function groupAction(ctx, baseUrl, groupId, action, body, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/match-groups/${groupId}/${action}`, options.key ?? ctx.key(`${action}-${groupId}`), body);
  if (options.allowFailure) return response;
  return { response, group: assertMatchGroup(expectSuccess(ctx, response, `${action} Match Group`)) };
}

export function revisionMaps(lines, entries) {
  return {
    expectedStatementLineRevisions: Object.fromEntries(lines.map(({ statementLineId, revision }) => [statementLineId, revision])),
    expectedLedgerEntryRevisions: Object.fromEntries(entries.map(({ ledgerEntryId, revision }) => [ledgerEntryId, revision])),
  };
}

export async function waitForSnapshot(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); const selected = predicate(snapshot); return selected ? { snapshot, selected } : false; }, {
    timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 25, label: options.label ?? "ReconcileHub state", processes: options.processes,
  });
}

export async function waitForDrain(ctx, baseUrl, options = {}) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); return snapshot.work.filter(options.predicate ?? (() => true)).every(({ terminal }) => terminal) ? snapshot : false; }, {
    timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 25, label: options.label ?? "Suggestion Task drainage", processes: options.processes,
  });
}

export async function crashWorkerAtBarrier(ctx, baseUrl, point, workPredicate) {
  const barrier = await ctx.barrier({ hold: (payload) => payload.point === point });
  const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
  const found = await waitForSnapshot(ctx, baseUrl, (snapshot) => snapshot.work.find((work) => work.state === "LEASED" && workPredicate(work)), { processes: [worker], label: `${point} leased Suggestion Task` });
  const entry = await barrier.waitFor(({ json }) => json?.point === point && json?.workId === found.selected.workId, { timeoutMs: 120_000, processes: [worker] });
  ctx.equal(entry.json.leaseTokenHash.length, 64, "barrier publishes only a lease token hash");
  await ctx.kill(worker); ctx.mark("worker-sigkill", { point, workId: found.selected.workId });
  return { barrier, entry, work: found.selected, snapshot: found.snapshot };
}

export function assertSnapshot(ctx, snapshot) {
  exactKeys(snapshot, ["asOf", "resources", "work", "events"], "verification snapshot");
  const allowed = ["statementBatches", "statementLines", "ledgerEntries", "matches", "matchGroups"];
  ctx.equal(Object.keys(snapshot.resources).sort(), allowed.sort(), "FINAL snapshot resource union", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
  resource(snapshot, "statementBatches").forEach(assertStatementBatch);
  resource(snapshot, "statementLines").forEach(assertStatementLine);
  resource(snapshot, "ledgerEntries").forEach(assertLedgerEntry);
  resource(snapshot, "matches").forEach(assertMatch);
  resource(snapshot, "matchGroups").forEach(assertMatchGroup);
  for (const work of snapshot.work) { exactKeys(work, WORK_KEYS, "Suggestion Task Work"); assert.equal(work.kind, "MATCH_SUGGESTION"); assert.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state)); assert.equal(work.state === "LEASED", work.leaseOwner !== null && work.leaseExpiresAt !== null); }
  for (const event of snapshot.events) { exactKeys(event, EVENT_KEYS, "Domain Event"); assert.equal(event.schemaVersion, 1); assert.deepEqual(event.payload, {}); }
  try { assertOwnershipAndConservation(snapshot); assertEventLedger(snapshot.events); }
  catch (error) { candidateFailure(error.message, "POST_STATE", ["CONSERVATION_OR_ATOMICITY"]); }
  ctx.ok(!/(?:authorization|idempotency|adminToken|leaseToken|database_url|postgres(?:ql)?:\/\/|\/(?:Users|home|tmp)\/)/iu.test(canonicalJson(snapshot)), "snapshot omits secrets, tokens and private paths", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
  return snapshot;
}

export async function launchBrowser(ctx, baseUrl, viewport = { width: 1280, height: 800 }) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] });
  ctx.defer(() => browser.close()); const browserContext = await browser.newContext({ viewport }); const page = await browserContext.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return { browser, browserContext, page };
}

async function firstVisible(locator) { for (let index = 0; index < await locator.count(); index += 1) { const item = locator.nth(index); if (await item.isVisible().catch(() => false)) return item; } }
export async function fillField(page, labels, value) { for (const label of Array.isArray(labels) ? labels : [labels]) { const item = await firstVisible(page.getByLabel(label)); if (item) { await item.fill(String(value)); return; } } throw new Error(`missing labelled field ${String(labels)}`); }
export async function clickControl(page, roles, names) { for (const role of Array.isArray(roles) ? roles : [roles]) for (const name of Array.isArray(names) ? names : [names]) { const item = await firstVisible(page.getByRole(role, { name })); if (item) { await item.click(); return; } } throw new Error(`missing visible control ${String(names)}`); }

export async function runWindow({ clients, seconds, operation }) {
  const latencies = []; const statuses = new Map(); let completed = 0; const startedAt = performance.now(); const deadline = startedAt + seconds * 1_000;
  await Promise.all(Array.from({ length: clients }, async (_, client) => { while (performance.now() < deadline) { const index = completed; completed += 1; const started = performance.now(); const response = await operation(index, client); latencies.push(performance.now() - started); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1); } }));
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  return { completed, durationSeconds, throughput: completed / durationSeconds, p95Ms: percentile(latencies, 0.95), statuses };
}

export function requireV1(ctx) { if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint"); return ctx.v1Workspace; }
export function finalEvidence(ctx, values = {}) { return ctx.pass({ evidence: [{ kind: "reconcilehub-case-summary", ...values }] }); }
export { canonicalJson, percentile };
