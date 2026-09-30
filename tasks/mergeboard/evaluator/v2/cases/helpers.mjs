import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { once } from "node:events";

import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { assertEventSequence, canonicalJson, documentDigest, percentile } from "../oracles/index.mjs";

const builds = new Map();
export const BLOCK_KEYS = Object.freeze(["blockId", "text"]);
export const DOCUMENT_KEYS = Object.freeze(["documentId", "title", "headRevision", "blocks", "canonicalDigest", "createdAt", "sequence"]);
export const CHANGE_KEYS = Object.freeze(["changeId", "documentId", "branchId", "clientId", "clientSequence", "baseRevision", "operations", "state", "revision", "conflicts", "createdAt"]);
export const LEGACY_CHANGE_KEYS = Object.freeze(CHANGE_KEYS.filter((key) => key !== "branchId"));
export const CONFLICT_KEYS = Object.freeze(["conflictId", "changeId", "operationIndex", "code", "path", "baseValue", "headValue"]);
export const REVISION_KEYS = Object.freeze(["documentId", "branchId", "revision", "blocks", "changeId", "mergeRequestId", "canonicalDigest", "createdAt"]);
export const LEGACY_REVISION_KEYS = Object.freeze(REVISION_KEYS.filter((key) => !["branchId", "mergeRequestId"].includes(key)));
export const BRANCH_KEYS = Object.freeze(["branchId", "documentId", "name", "sourceBranchId", "sourceRevision", "headRevision", "state", "createdAt"]);
export const APPROVAL_KEYS = Object.freeze(["approvalId", "mergeRequestId", "reviewerId", "resultDigest", "approvedAt"]);
export const MERGE_OPERATION_KEYS = Object.freeze(["sourceRevision", "sourceOperationIndex", "operation"]);
export const MERGE_CONFLICT_KEYS = Object.freeze(["sourceRevision", "sourceOperationIndex", "code", "path", "baseValue", "headValue"]);
export const MERGE_REQUEST_KEYS = Object.freeze(["mergeRequestId", "documentId", "sourceBranchId", "targetBranchId", "sourceHeadRevision", "targetHeadRevision", "state", "reviewPolicy", "approvals", "mergeOperations", "conflicts", "resultDigest", "mergedTargetRevision", "createdAt", "terminalAt"]);
export const DOCUMENT_SNAPSHOT_KEYS = Object.freeze(["documentId", "revision", "canonicalDigest", "createdAt"]);
export const BRANCH_SNAPSHOT_KEYS = Object.freeze(["documentId", "branchId", "revision", "canonicalDigest", "createdAt"]);
export const WORK_KEYS = Object.freeze(["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"]);
export const EVENT_KEYS = Object.freeze(["eventId", "aggregateId", "sequence", "type", "occurredAt", "schemaVersion", "payload"]);
export const FINAL_RESOURCE_KEYS = Object.freeze(["branches", "branchDocumentSnapshots", "changes", "conflicts", "documentRevisions", "documentSnapshots", "documents", "mergeRequests"]);

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !/^MB-F-/u.test(fixtureFamily ?? "") || typeof action !== "string" || action.length < 24 || typeof oracle !== "string" || oracle.length < 24 || typeof run !== "function" || run.length < 1) throw new TypeError("invalid MergeBoard case definition");
  return Object.freeze({ taskId: "mergeboard", id, fixtureFamily, action, oracle, run });
}

export function guardedCase(definition, hardCapIds = []) {
  return defineCase({ ...definition, async run(ctx) {
    try { return await definition.run(ctx); }
    catch (error) { if (error && typeof error === "object") error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])]; throw error; }
  } });
}

export function exactKeys(value, keys, label) { assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`); return value; }
export function expectStatus(ctx, response, status, label, options = {}) { ctx.equal(response.status, status, `${label} status`, options); return response.json; }
export function expectSuccess(ctx, response, label, status = 200, options = {}) { const value = expectStatus(ctx, response, status, label, options); ctx.ok(value && typeof value === "object", `${label} JSON`, options); return value; }
export function expectError(ctx, response, status, code, label, options = {}) { expectStatus(ctx, response, status, label, options); exactKeys(response.json, ["error"], `${label} envelope`); exactKeys(response.json.error, ["code", "message", "details"], `${label} error`); ctx.equal(response.json.error.code, code, `${label} code`, options); return response.json.error; }

export function assertBlock(value) { exactKeys(value, BLOCK_KEYS, "Block"); assert.match(value.blockId, /^[0-9a-f-]{36}$/u); assert.equal(typeof value.text, "string"); return value; }
export function assertDocument(value) { exactKeys(value, DOCUMENT_KEYS, "Document"); value.blocks.forEach(assertBlock); assert.ok(Number.isSafeInteger(value.headRevision) && value.headRevision >= 0); assert.match(value.canonicalDigest, /^[0-9a-f]{64}$/u); assert.equal(value.canonicalDigest, documentDigest(value.documentId, value.headRevision, value.blocks)); return value; }
export function assertConflict(value) { exactKeys(value, CONFLICT_KEYS, "Conflict"); assert.ok(Number.isSafeInteger(value.operationIndex) && value.operationIndex >= 0); assert.ok(["TARGET_MISSING", "TARGET_CHANGED", "ANCHOR_MISSING", "BLOCK_ID_EXISTS", "MOVE_BASE_CHANGED"].includes(value.code)); return value; }
export function assertChange(value, { legacy = false } = {}) { exactKeys(value, legacy ? LEGACY_CHANGE_KEYS : CHANGE_KEYS, legacy ? "legacy Change" : "Change"); assert.ok(["APPLIED", "CONFLICTED", "REJECTED"].includes(value.state)); assert.ok(Array.isArray(value.operations) && value.operations.length >= 1 && value.operations.length <= 100); value.conflicts.forEach(assertConflict); if (value.state === "APPLIED") assert.ok(Number.isSafeInteger(value.revision)); else assert.equal(value.revision, null); return value; }
export function assertRevision(value, { legacy = false } = {}) { exactKeys(value, legacy ? LEGACY_REVISION_KEYS : REVISION_KEYS, legacy ? "legacy DocumentRevision" : "DocumentRevision"); value.blocks.forEach(assertBlock); assert.equal(value.canonicalDigest, documentDigest(value.documentId, value.revision, value.blocks)); return value; }
export function assertBranch(value) { exactKeys(value, BRANCH_KEYS, "Branch"); assert.match(value.name, /^[a-z][a-z0-9-]{0,31}$/u); assert.equal(value.state, "ACTIVE"); return value; }
export function assertDocumentSnapshot(value, { branch = false } = {}) { exactKeys(value, branch ? BRANCH_SNAPSHOT_KEYS : DOCUMENT_SNAPSHOT_KEYS, branch ? "BranchDocumentSnapshot" : "DocumentSnapshot"); assert.ok(Number.isSafeInteger(value.revision) && value.revision >= 0); assert.match(value.canonicalDigest, /^[0-9a-f]{64}$/u); return value; }
export function assertMergeRequest(value) {
  exactKeys(value, MERGE_REQUEST_KEYS, "MergeRequest");
  exactKeys(value.reviewPolicy, ["reviewerIds", "requiredApprovals"], "reviewPolicy");
  assert.ok(["CONFLICTED", "IN_REVIEW", "APPROVED", "MERGED", "STALE"].includes(value.state));
  value.approvals.forEach((approval) => exactKeys(approval, APPROVAL_KEYS, "MergeApproval"));
  value.mergeOperations.forEach((operation) => exactKeys(operation, MERGE_OPERATION_KEYS, "MergeOperation"));
  value.conflicts.forEach((item) => exactKeys(item, MERGE_CONFLICT_KEYS, "MergeConflict"));
  assert.deepEqual(value.approvals, [...value.approvals].sort((a, b) => Buffer.from(a.reviewerId).compare(Buffer.from(b.reviewerId))));
  assert.deepEqual(value.mergeOperations, [...value.mergeOperations].sort((a, b) => a.sourceRevision - b.sourceRevision || a.sourceOperationIndex - b.sourceOperationIndex));
  if (value.resultDigest !== null) assert.match(value.resultDigest, /^[0-9a-f]{64}$/u);
  if (value.terminalAt !== null) assert.match(value.terminalAt, /^\d{4}-\d{2}-\d{2}T/u);
  return value;
}

async function build(ctx, workspace) { const target = ctx.forWorkspace(workspace); if (!builds.has(target.workspace)) builds.set(target.workspace, target.npm("build")); await builds.get(target.workspace); }
export async function prepare(ctx, options = {}) { const workspace = options.workspace ?? ctx.workspace; const target = ctx.forWorkspace(workspace); if (options.build !== false) await build(ctx, workspace); if (options.migrate !== false) await target.migrate(); if (options.seed) await target.seed(options.seed); ctx.mark("candidate-prepared", { workspace: target.workspace, seeded: Boolean(options.seed) }); return target; }
export async function startPreparedApi(ctx, options = {}) { return (await prepare(ctx, options)).startApi(options.api ?? {}); }

export async function createDocument(ctx, baseUrl, body, options = {}) { const response = await ctx.mutate(baseUrl, "/api/v1/documents", options.key ?? ctx.key(`document:${body.title}`), body); if (options.allowFailure) return response; return assertDocument(expectSuccess(ctx, response, options.label ?? "create Document", 201, options.assertionOptions)); }
export async function applyChange(ctx, baseUrl, documentId, body, options = {}) { const path = options.branchId ? `/api/v1/documents/${documentId}/branches/${options.branchId}/changes` : `/api/v1/documents/${documentId}/changes`; const response = await ctx.mutate(baseUrl, path, options.key ?? ctx.key(`change:${documentId}:${options.branchId ?? "main"}:${body.clientId}:${body.clientSequence}`), body); if (options.allowFailure) return response; return assertChange(expectSuccess(ctx, response, options.label ?? "apply Change", 201, options.assertionOptions), { legacy: !options.branchId }); }
export async function createBranch(ctx, baseUrl, documentId, body, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/documents/${documentId}/branches`, options.key ?? ctx.key(`branch:${documentId}:${body.name}`), body); if (options.allowFailure) return response; return assertBranch(expectSuccess(ctx, response, options.label ?? "create Branch", 201)); }
export async function createMergeRequest(ctx, baseUrl, documentId, body, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/documents/${documentId}/merge-requests`, options.key ?? ctx.key(`mr:${documentId}:${body.sourceBranchId}:${body.expectedSourceHeadRevision}:${body.expectedTargetHeadRevision}`), body); if (options.allowFailure) return response; return assertMergeRequest(expectSuccess(ctx, response, options.label ?? "create Merge Request", 201)); }
export async function approveMergeRequest(ctx, baseUrl, mergeRequestId, reviewerId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/merge-requests/${mergeRequestId}/approvals`, options.key ?? ctx.key(`approval:${mergeRequestId}:${reviewerId}`), { reviewerId }); if (options.allowFailure) return response; return assertMergeRequest(expectSuccess(ctx, response, options.label ?? "approve Merge Request")); }
export async function mergeRequest(ctx, baseUrl, mergeRequestId, options = {}) { const response = await ctx.mutate(baseUrl, `/api/v1/merge-requests/${mergeRequestId}/merge`, options.key ?? ctx.key(`merge:${mergeRequestId}`), {}); if (options.allowFailure) return response; return assertMergeRequest(expectSuccess(ctx, response, options.label ?? "merge Merge Request")); }
export async function getJson(ctx, baseUrl, path, label) { return expectSuccess(ctx, await ctx.request(baseUrl, path), label); }
export function resource(snapshot, name) { const value = snapshot?.resources?.[name]; assert.ok(Array.isArray(value), `snapshot resource ${name}`); return value; }

function comparePath(paths) { return (left, right) => { for (const path of paths) { const a = left[path]; const b = right[path]; const order = Number.isSafeInteger(a) && Number.isSafeInteger(b) ? a - b : Buffer.from(String(a)).compare(Buffer.from(String(b))); if (order) return order; } return Buffer.from(canonicalJson(left)).compare(Buffer.from(canonicalJson(right))); }; }
export function assertSnapshot(ctx, snapshot) {
  exactKeys(snapshot, ["asOf", "resources", "work", "events"], "verification snapshot");
  ctx.equal(Object.keys(snapshot.resources).sort(), [...FINAL_RESOURCE_KEYS].sort(), "FINAL resource union", { hardCapIds: ["SNAPSHOT_INTEGRITY"] });
  resource(snapshot, "documents").forEach(assertDocument);
  resource(snapshot, "documentRevisions").forEach(assertRevision);
  resource(snapshot, "changes").forEach(assertChange);
  resource(snapshot, "conflicts").forEach(assertConflict);
  resource(snapshot, "documentSnapshots").forEach((item) => assertDocumentSnapshot(item));
  resource(snapshot, "branches").forEach(assertBranch);
  resource(snapshot, "mergeRequests").forEach(assertMergeRequest);
  resource(snapshot, "branchDocumentSnapshots").forEach((item) => assertDocumentSnapshot(item, { branch: true }));
  exactSort(resource(snapshot, "documents"), ["documentId"]); exactSort(resource(snapshot, "documentRevisions"), ["documentId", "revision"]); exactSort(resource(snapshot, "changes"), ["documentId", "changeId"]); exactSort(resource(snapshot, "conflicts"), ["changeId", "operationIndex", "conflictId"]); exactSort(resource(snapshot, "documentSnapshots"), ["documentId", "revision"]); exactSort(resource(snapshot, "branches"), ["documentId", "branchId"]); exactSort(resource(snapshot, "mergeRequests"), ["mergeRequestId"]); exactSort(resource(snapshot, "branchDocumentSnapshots"), ["documentId", "branchId", "revision"]);
  for (const work of snapshot.work) { exactKeys(work, WORK_KEYS, "Work"); assert.equal(work.kind, "SNAPSHOT_COMPACTION"); assert.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state)); assert.equal(work.state === "LEASED", work.leaseOwner !== null && work.leaseExpiresAt !== null); }
  for (const event of snapshot.events) { exactKeys(event, EVENT_KEYS, "Domain Event"); assert.deepEqual(event.payload, {}); }
  exactSort(snapshot.work, ["workId"]); exactSort(snapshot.events, ["aggregateId", "sequence", "eventId"]);
  assertEventSequence(snapshot.events);
  ctx.ok(!/(?:adminToken|leaseToken|idempotencyKey|authorization|postgres(?:ql)?:\/\/|\/(?:Users|home|tmp)\/)/iu.test(canonicalJson(snapshot)), "snapshot omits tokens and private paths", { hardCapIds: ["SNAPSHOT_INTEGRITY"] });
  return snapshot;
}
function exactSort(values, paths) { assert.deepEqual(values, [...values].sort(comparePath(paths)), `${paths.join(",")} canonical order`); }

export async function waitForDrain(ctx, baseUrl, options = {}) { return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl, { timeoutMs: options.requestTimeoutMs }); return snapshot.work.filter(options.predicate ?? (() => true)).every(({ terminal }) => terminal) ? snapshot : false; }, { timeoutMs: options.timeoutMs ?? 120_000, intervalMs: options.intervalMs ?? 100, label: options.label ?? "Snapshot Work drainage", processes: options.processes }); }
export async function crashWorkerAt(ctx, baseUrl, point, workPredicate = () => true) { const barrier = await ctx.barrier({ hold: (payload) => payload.point === point }); const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); const found = await ctx.waitFor(async () => { const snapshot = await ctx.snapshot(baseUrl); const work = snapshot.work.find((item) => item.state === "LEASED" && workPredicate(item)); return work ? { snapshot, work } : false; }, { timeoutMs: 120_000, label: `${point} leased Work`, processes: [worker] }); const entry = await barrier.waitFor(({ json }) => json?.point === point && json?.workId === found.work.workId, { timeoutMs: 120_000, processes: [worker] }); ctx.equal(entry.json.leaseTokenHash.length, 64, "barrier exposes only lease hash"); await ctx.kill(worker); return { barrier, entry, ...found }; }

export async function launchBrowser(ctx, baseUrl, viewport = { width: 1280, height: 800 }) { const chromium = await ctx.loadChromium(); const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox"] }); ctx.defer(() => browser.close()); const browserContext = await browser.newContext({ viewport }); const page = await browserContext.newPage(); await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }); return { browser, browserContext, page }; }
async function firstVisible(locator) { for (let index = 0; index < await locator.count(); index += 1) { const item = locator.nth(index); if (await item.isVisible().catch(() => false)) return item; } }
export async function fillField(page, labels, value) { for (const label of labels) { const item = await firstVisible(page.getByLabel(label)); if (item) { await item.fill(String(value)); return; } } throw new Error(`missing labelled field ${labels.join("/")}`); }
export async function clickControl(page, names) { for (const name of names) { for (const role of ["button", "link", "option", "tab"]) { const item = await firstVisible(page.getByRole(role, { name })); if (item) { await item.click(); return; } } } throw new Error(`missing visible control ${names.join("/")}`); }
export async function chooseOption(page, labels, value) { for (const label of labels) { const item = await firstVisible(page.getByLabel(label)); if (item) { await item.selectOption({ label: value }).catch(() => item.selectOption(value)); return; } } throw new Error(`missing select ${labels.join("/")}`); }

export async function runWindow({ clients, seconds, operation }) { const latencies = []; const statuses = new Map(); let completed = 0; const startedAt = performance.now(); const deadline = startedAt + seconds * 1_000; await Promise.all(Array.from({ length: clients }, async (_, client) => { while (performance.now() < deadline) { const index = completed++; const started = performance.now(); const response = await operation(index, client); latencies.push(performance.now() - started); statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1); } })); const durationSeconds = (performance.now() - startedAt) / 1_000; return { completed, durationSeconds, throughput: completed / durationSeconds, p95Ms: percentile(latencies, 0.95), statuses }; }
export function requireV1(ctx) { if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint"); return ctx.v1Workspace; }
export function finalEvidence(ctx, values = {}, diagnostics = []) { return ctx.pass({ diagnostics, evidence: [{ kind: "mergeboard-case-summary", ...values }] }); }
export function diagnostic(assertionId, blockedBy) { return { assertionId, status: "blocked", blockedBy, policy: "fail-closed-diagnostic" }; }
export function candidateFailure(message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) { throw new CaseFailure(message, { failureCodeSuffix, hardCapIds }); }

function integerUuid(kind, index) { const prefix = kind.toString(16).padStart(8, "0"); return `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, "0")}`; }
async function writeChunk(stream, value) { if (!stream.write(value)) await once(stream, "drain"); }
export async function writeMillionOperationSeed(ctx) {
  const path = ctx.tempPath("mergeboard-perf-v1.json"); const stream = createWriteStream(path, { encoding: "utf8", mode: 0o600 });
  await writeChunk(stream, '{"schemaVersion":1,"seedVersion":"perf-v1","documents":[');
  for (let document = 1; document <= 10_000; document += 1) { if (document > 1) await writeChunk(stream, ","); const documentId = integerUuid(1, document); const blockId = integerUuid(2, document); await writeChunk(stream, JSON.stringify({ documentId, title: `Perf ${document}`, initialBlocks: [{ blockId, text: "v000" }], createdAt: "2035-01-01T00:00:00.000Z" })); }
  await writeChunk(stream, '],"changes":['); let ordinal = 0;
  for (let document = 1; document <= 10_000; document += 1) { const documentId = integerUuid(1, document); const blockId = integerUuid(2, document); const clientId = integerUuid(3, document); for (let revision = 1; revision <= 100; revision += 1) { if (ordinal++ > 0) await writeChunk(stream, ","); await writeChunk(stream, JSON.stringify({ changeId: integerUuid(4 + document, revision), documentId, clientId, clientSequence: revision, baseRevision: revision - 1, operations: [{ op: "REPLACE", blockId, expectedText: `v${String(revision - 1).padStart(3, "0")}`, newText: `v${String(revision).padStart(3, "0")}` }], state: "APPLIED", revision, conflicts: [], createdAt: "2035-01-01T00:00:00.000Z" })); } }
  await writeChunk(stream, '],"snapshots":[]}'); stream.end(); await once(stream, "finish"); return path;
}
