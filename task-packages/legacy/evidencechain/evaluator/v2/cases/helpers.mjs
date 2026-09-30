import assert from "node:assert/strict";

import { canonicalDigest, canonicalJson, assertEvidenceInvariants, assertQuantityConserved, assertTimeline, percentile } from "../oracles/index.mjs";

export const V1_RESOURCE_KEYS = ["caseManifests", "cases", "collectedItems", "custodians", "custodyMatches", "custodyTransfers", "deviceRegistrations", "facilities", "intakeScans"];
export const FINAL_RESOURCE_KEYS = [...V1_RESOURCE_KEYS, "aliquots", "custodyMatchGroups", "itemSplits"].sort();
export const SCAN_KEYS = ["batchSequence", "deviceId", "facilityId", "intakeScanId", "label", "revision", "scanId", "scannedAt", "sealCode", "state"];
export const ITEM_KEYS = ["caseId", "collectedItemId", "currentCustodianId", "expectedLabel", "expectedSealCode", "intakeScanId", "quantity", "revision", "sequence", "state"];
export const MATCH_KEYS = ["collectedItemId", "confirmedAt", "createdAt", "intakeScanId", "matchId", "reversedAt", "state"];
export const TRANSFER_KEYS = ["acceptedAt", "collectedItemId", "fromCustodianId", "occurredAt", "priorTransferId", "toCustodianId", "transferId"];
export const ALIQUOT_KEYS = ["aliquotId", "currentCustodianId", "intakeScanId", "parentItemId", "quantity", "revision", "sealCode", "state"];
export const SPLIT_KEYS = ["aliquots", "createdAt", "parentItemId", "reversedAt", "splitId", "state", "totalQuantity"];
export const GROUP_KEYS = ["confirmedAt", "createdAt", "custodyMatchGroupId", "members", "reversedAt", "sequence", "splitId", "state"];

const META = Object.freeze({
  "CONTRACT-01": ["EC-F-BATCH-PUBLIC", "Exercise scanner sequence, validation and public observation surfaces", "Assert exact response, durable sequence and whole-batch atomicity"],
  "CONTRACT-02": ["EC-F-MATCH-PUBLIC", "Propose and confirm exact, mismatch, stale and contended custody matches", "Assert closed wire state and Item/Scan/Work authority closure"],
  "CONTRACT-03": ["EC-F-V1-CUSTODY", "Run verification, item transfer, timeline and reversal public flows", "Assert the published V1 state machine and immutable evidence history"],
  "CONTRACT-04": ["EC-F-SPLIT-PUBLIC", "Create and reverse quantity-conserving splits through public routes", "Assert complete child creation, parent consumption and atomic restoration"],
  "CONTRACT-05": ["EC-F-GROUP-PUBLIC", "Confirm complete Aliquot match groups and read lineage detail", "Assert complete membership, deterministic order and child isolation"],
  "DATA-01": ["EC-F-BATCH-REPLAY", "Race canonical batch replay through two APIs and a response shield", "Assert one durable response and no second batch effect"],
  "DATA-02": ["EC-F-CUSTODY-CAS", "Race match confirmation and transfers against shared authority", "Assert deterministic matching, one active match and one custodian chain"],
  "DATA-03": ["EC-F-SPLIT-RACE", "Race split reversal, group confirmation and parent transfer", "Assert BigInt quantity conservation and exactly one legal authority"],
  "DATA-04": ["EC-F-GROUP-RACE", "Race complete and invalid match groups across two APIs", "Assert all-or-none membership and independent child Verification work"],
  "DATA-05": ["EC-F-SPEC-GAP-EC-01", "Fail closed before exercising an unpublished Aliquot transfer seam", "Report SPEC-GAP-EC-01 without guessing a route or reading private state"],
  "RECOVERY-01": ["EC-F-WORK-CLAIM", "SIGKILL claimed verification workers and start replacements", "Assert fenced convergence without rewriting observed scan evidence"],
  "RECOVERY-02": ["EC-F-CHILD-EFFECT", "SIGKILL child verification after effect-complete and recover", "Assert each child converges once without group-wide result diffusion"],
  "RECOVERY-03": ["EC-F-REVERSAL-FENCE", "Race public reversals with claimed, effect and before-commit workers", "Assert stale workers cannot commit after authority disappears"],
  "RECOVERY-04": ["EC-F-OUTBOX-ACK", "SIGKILL dispatcher after receiver response and restart delivery", "Assert stable event identity, semantic body and aggregate ordering"],
  "LAYER-01": ["EC-F-OPENAPI-RUNTIME", "Compare OpenAPI 3.1 paths and schemas with live public responses", "Assert exact V1 and lineage surfaces and no invented child transfer"],
  "LAYER-02": ["EC-F-V1-CHROMIUM", "Complete the V1 coordinator flow through visible Chromium controls", "Assert browser, public API and durable snapshot agree after refresh"],
  "LAYER-03": ["EC-F-LINEAGE-CHROMIUM", "Complete split, group, detail and untransferred reverse in Chromium", "Assert real UI lineage agrees with HTTP and snapshot authority"],
  "LAYER-04": ["EC-F-SNAPSHOT-CLOSURE", "Read authenticated snapshots during concurrent public mutations", "Assert one-time-point link closure, sorting and recursive redaction"],
  "OPERATE-01": ["EC-F-PERF-BATCH", "Run the fixed 64-client scanner-batch-ingest scenario for 10s plus 60s", "Assert formal throughput, p95, zero 5xx and full post-load invariants"],
  "OPERATE-02": ["EC-F-PERF-TIMELINE", "Run the fixed 64-client custody-timeline-read scenario for 10s plus 60s", "Assert formal throughput, p95, zero 5xx and immutable custody state"],
  "OPERATE-03": ["EC-F-PERF-RECOVERY", "Recover exactly ten thousand pending verification Work records", "Assert the formal two-kill two-replacement sixty-second closure"],
  "OPERATE-04": ["EC-F-V1-MIGRATION", "Upgrade a populated V1 checkpoint with replay and leased Work", "Assert identity-preserving roots, one-member groups and seed atomicity"],
});

export function defineCase(id, run) {
  const [fixtureFamily, action, oracle] = META[id] ?? [];
  if (!fixtureFamily) throw new TypeError(`unknown EvidenceChain case ${id}`);
  return Object.freeze({ id, taskId: "evidencechain", fixtureFamily, action, oracle, async run(ctx) { return run(ctx); } });
}

export function guardedCase(id, hardCapIds, run) {
  return defineCase(id, async (ctx) => {
    try { return await run(ctx); }
    catch (error) { error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])]; throw error; }
  });
}

export function diagnosticCase(id, assertionId, blockedBy) {
  return defineCase(id, async (ctx) => {
    ctx.mark("spec-gap.blocked", { assertionId, blockedBy, policy: "fail-closed-diagnostic" });
    return { evidence: ctx.evidence, diagnostics: [ctx.diagnostic(assertionId, blockedBy)] };
  });
}

export async function prepare(ctx, seed, { build = false, migrate = true } = {}) {
  if (build) {
    await ctx.command("npm", ["ci"], { timeoutMs: 600_000 });
    await ctx.npm("build", [], { timeoutMs: 600_000 });
  }
  if (migrate) await ctx.migrate({ timeoutMs: 600_000 });
  if (seed) {
    const imported = await ctx.seed(seed, { timeoutMs: 600_000, allowFailure: false });
    assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  }
  const api = await ctx.startApi();
  return api;
}

export function requireStatus(response, expected, label = "request") {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `${label}: expected ${statuses.join("/")}, got ${response.status}: ${response.text}`);
  assert.notEqual(response.json, undefined, `${label}: response is not JSON`);
  return response.json;
}

export function assertExactKeys(value, keys, label) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} wire shape`); }
export function assertError(response, status, code) {
  const body = requireStatus(response, status, code);
  assertExactKeys(body, ["error"], `${code} envelope`);
  assertExactKeys(body.error, ["code", "details", "message"], `${code} error`);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.error.details && typeof body.error.details === "object" && !Array.isArray(body.error.details));
}
export function stableSnapshot(snapshot) { const { asOf: _asOf, ...stable } = snapshot; return stable; }
export function clone(value) { return structuredClone(value); }
export function byId(items, key, id, label = key) { const item = items.find((value) => value[key] === id); assert.ok(item, `${label} ${id} missing`); return item; }

export function assertNoSecrets(value, path = "snapshot") {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoSecrets(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(key, /Token$/u, `${path}.${key} leaks token`);
    assert.doesNotMatch(key, /^(?:idempotencyKey|rawWebhook|privatePath|secret)$/iu, `${path}.${key} leaks private data`);
    assertNoSecrets(entry, `${path}.${key}`);
  }
}

export function assertSnapshot(snapshot, { final = true } = {}) {
  assertExactKeys(snapshot, ["asOf", "events", "resources", "work"], "verification snapshot");
  assert.deepEqual(Object.keys(snapshot.resources).sort(), final ? FINAL_RESOURCE_KEYS : [...V1_RESOURCE_KEYS].sort());
  for (const value of Object.values(snapshot.resources)) assert.ok(Array.isArray(value));
  assert.ok(Array.isArray(snapshot.work) && Array.isArray(snapshot.events));
  assertNoSecrets(snapshot);
  assertEvidenceInvariants(snapshot);
  return snapshot;
}

export async function importBatch(ctx, api, key, body, expected = 202) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/intake-batches", ctx.key(key), body);
  requireStatus(response, expected, key);
  return response;
}
export async function proposeMatch(ctx, api, key, collectedItemId, intakeScanId, expected = 200) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/custody-matches", ctx.key(key), { collectedItemId, intakeScanId });
  requireStatus(response, expected, key); return response;
}
export async function confirmMatch(ctx, api, key, match, item, scan, expected = 200) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${match.matchId}/confirm`, ctx.key(key), { expectedItemRevision: item.revision, expectedScanRevision: scan.revision });
  requireStatus(response, expected, key); return response;
}
export async function reverseMatch(ctx, api, key, matchId, reason = "evaluator reversal", expected = 200) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/custody-matches/${matchId}/reverse`, ctx.key(key), { reason });
  requireStatus(response, expected, key); return response;
}
export async function transferItem(ctx, api, key, itemId, body, expected = 200) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/collected-items/${itemId}/transfers`, ctx.key(key), body);
  requireStatus(response, expected, key); return response;
}
export async function timeline(ctx, api, itemId) {
  const response = await ctx.request(api.baseUrl, `/api/v1/collected-items/${itemId}/timeline`);
  const body = requireStatus(response, 200, "timeline"); assertExactKeys(body, ["item", "items"], "timeline"); assertTimeline(body.items); return body;
}
export async function createSplit(ctx, api, key, itemId, body, expected = 200) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/collected-items/${itemId}/splits`, ctx.key(key), body);
  requireStatus(response, expected, key); return response;
}
export async function reverseSplit(ctx, api, key, splitId, reason = "evaluator reversal", expected = 200) {
  const response = await ctx.mutate(api.baseUrl, `/api/v1/item-splits/${splitId}/reverse`, ctx.key(key), { reason });
  requireStatus(response, expected, key); return response;
}
export async function splitDetail(ctx, api, splitId) {
  const response = await ctx.request(api.baseUrl, `/api/v1/item-splits/${splitId}`);
  return requireStatus(response, 200, "split detail");
}
export async function createGroup(ctx, api, key, body, expected = 201) {
  const response = await ctx.mutate(api.baseUrl, "/api/v1/custody-match-groups", ctx.key(key), body);
  requireStatus(response, expected, key); return response;
}
export async function groupDetail(ctx, api, groupId) {
  const response = await ctx.request(api.baseUrl, `/api/v1/custody-match-groups/${groupId}`);
  return requireStatus(response, 200, "group detail");
}

export async function waitSnapshot(ctx, api, predicate, label, options = {}) {
  return ctx.waitFor(async () => { const snapshot = await ctx.snapshot(api.baseUrl); return predicate(snapshot) ? snapshot : undefined; }, { timeoutMs: 45_000, intervalMs: 75, label, ...options });
}

export async function publicVerifiedItem(ctx, api, seed, batch, itemIndex = 0, { mismatch = false, label = "verified" } = {}) {
  await importBatch(ctx, api, `${label}-batch`, batch);
  let snapshot = await ctx.snapshot(api.baseUrl);
  const item = snapshot.resources.collectedItems[itemIndex];
  const scan = byId(snapshot.resources.intakeScans, "scanId", batch.scans[itemIndex].scanId, "scan");
  const proposed = (await proposeMatch(ctx, api, `${label}-propose`, item.collectedItemId, scan.intakeScanId)).json;
  await confirmMatch(ctx, api, `${label}-confirm`, proposed, item, scan);
  const worker = await ctx.startWorker();
  snapshot = await waitSnapshot(ctx, api, (value) => {
    const current = value.resources.collectedItems.find(({ collectedItemId }) => collectedItemId === item.collectedItemId);
    return current && [mismatch ? "QUARANTINED" : "VERIFIED"].includes(current.state);
  }, `${label} verification`, { processes: [worker] });
  await ctx.stop(worker);
  return { item: byId(snapshot.resources.collectedItems, "collectedItemId", item.collectedItemId), scan: byId(snapshot.resources.intakeScans, "intakeScanId", scan.intakeScanId), snapshot };
}

export function assertSplit(split, parentQuantity) {
  assertExactKeys(split, SPLIT_KEYS, "ItemSplit");
  assert.ok(split.aliquots.length >= 2 && split.aliquots.length <= 20);
  split.aliquots.forEach((aliquot) => assertExactKeys(aliquot, ALIQUOT_KEYS, "Aliquot"));
  assertQuantityConserved(parentQuantity, split.aliquots);
}

export function assertGroup(group, split) {
  assertExactKeys(group, GROUP_KEYS, "CustodyMatchGroup");
  assert.equal(group.splitId, split.splitId); assert.equal(group.state, "CONFIRMED");
  assert.deepEqual(group.members.map(({ aliquotId }) => aliquotId), [...split.aliquots].map(({ aliquotId }) => aliquotId).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))));
  assert.equal(new Set(group.members.map(({ intakeScanId }) => intakeScanId)).size, split.aliquots.length);
}

export async function openVisibleUi(ctx, api, operation) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    await operation(page);
  } finally { await browser.close(); }
}

export async function clickVisible(page, names) {
  const alternatives = Array.isArray(names) ? names : [names];
  for (const name of alternatives) {
    const locator = page.getByRole("button", { name, exact: false }).or(page.getByRole("link", { name, exact: false })).first();
    if (await locator.count()) { await locator.click(); return; }
  }
  throw new Error(`visible control not found: ${alternatives.join(" / ")}`);
}

export async function fillVisible(page, label, value) {
  const control = page.getByLabel(label, { exact: false }).first();
  assert.ok(await control.count(), `visible labelled control missing: ${label}`);
  await control.fill(String(value));
}

export async function closedLoop({ clients, warmupMs, measureMs, operation, betweenWindows }) {
  const runWindow = async (durationMs, collect) => {
    const deadline = performance.now() + durationMs; const latencies = []; let completed = 0; let unexpected5xx = 0; let ordinal = 0;
    await Promise.all(Array.from({ length: clients }, async (_, client) => {
      while (performance.now() < deadline) {
        const index = ordinal++; const started = performance.now(); const response = await operation({ client, index, collect });
        const latency = performance.now() - started;
        if (collect) { completed += 1; latencies.push(latency); if (response.status >= 500) unexpected5xx += 1; }
      }
    }));
    return { completed, latencies, unexpected5xx, elapsedSeconds: durationMs / 1000 };
  };
  await runWindow(warmupMs, false);
  await betweenWindows?.();
  const measured = await runWindow(measureMs, true);
  return { ...measured, throughput: measured.completed / measured.elapsedSeconds, p95: percentile(measured.latencies, 0.95) };
}

export function sameSemanticResponse(left, right) { assert.equal(left.status, right.status); assert.equal(canonicalJson(left.json), canonicalJson(right.json)); }
export function snapshotDigest(snapshot) { return canonicalDigest(stableSnapshot(snapshot)); }
export function evidence(...items) { return { evidence: items }; }
