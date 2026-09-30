import assert from "node:assert/strict";

import { assertRevisionChain, assertStatement, assertUsageEvent, monthInterval, ratePeriod, semanticRevisionDetail } from "../oracles/index.mjs";
import {
  blocked, boot, caseResult, correctionBody, eventOracle, exactIdSets, expectError, finalize, ingest,
  openApi, requireStatus, snapshot, stableSemantic, statementDetail, statementFor, usageBody, waitSnapshot,
} from "./helpers.mjs";

const a01 = define(
  "A-01", "F-EMPTY clean command/production process fixture",
  "Install dependencies, migrate, build, then independently boot API, Rating Worker and Dispatcher",
  "Every published command exits truthfully and every production role uses the public localhost seam",
  ["public npm commands", "production HTTP", "owned OS processes"],
  async (ctx) => {
    await ctx.command("npm", ["install", "--no-audit", "--no-fund"], { timeoutMs: 300_000 });
    await ctx.migrate({ timeoutMs: 180_000 }); await ctx.migrate({ timeoutMs: 180_000 }); await ctx.npm("build", [], { timeoutMs: 300_000 });
    const api = await ctx.startApi({ healthTimeoutMs: 60_000 });
    requireStatus(ctx, await ctx.request(api.baseUrl, "/healthz"), 200, "production health", { failureCodeSuffix: "BOOT_FAILED", hardCapIds: ["CLEAN_BUILD_MIGRATION_BOOT"] });
    openApi(ctx, requireStatus(ctx, await ctx.openApi(api.baseUrl), 200, "production OpenAPI"));
    const receiver = await ctx.receiver(); const worker = await ctx.startWorker(); const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    ctx.ok(api.baseUrl.startsWith("http://127.0.0.1:"), "API binds evaluator localhost");
    await ctx.stop(dispatcher); await ctx.stop(worker); await ctx.stop(api);
    ctx.ok([dispatcher, worker, api].every(({ stopped }) => stopped), "all owned production roles stopped", { failureCodeSuffix: "PROCESS_LEAK", hardCapIds: ["CLEAN_BUILD_MIGRATION_BOOT"] });
    return caseResult(ctx, { commands: ["db:migrate", "build", "start:api", "start:worker", "start:dispatcher"] });
  },
);

const a02 = define(
  "A-02", "F-V1-RATING populated migration and replay fixture",
  "Run migration twice before and twice after seeded public mutations and a saved idempotent response",
  "Point-in-time resources, Work, Events and saved response identities remain bytewise stable",
  ["public migration command", "public HTTP", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.rating(); await ctx.migrate(); await ctx.migrate(); await ctx.seed(family.seed); const api = await ctx.startApi();
    const key = ctx.key("a02-saved"); const created = await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [ctx.fixtures.event(70)]), { key }); requireStatus(ctx, created, 202, "saved batch");
    const before = await snapshot(ctx, api.baseUrl); await ctx.stop(api); await ctx.migrate(); await ctx.migrate(); const restarted = await ctx.startApi();
    const replay = await ctx.usageBatch(restarted.baseUrl, usageBody(family.tenant.tenantId, [ctx.fixtures.event(70)]), { key }); stableSemantic(ctx, [created, replay], "migration replay", { failureCodeSuffix: "MIGRATION_REPLAY_CHANGED", hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    const after = await snapshot(ctx, restarted.baseUrl); ctx.equal(ctx.canonical(after.resources), ctx.canonical(before.resources), "migration preserves resources", { failureCodeSuffix: "MIGRATION_RESOURCE_CHANGED", hardCapIds: ["MIGRATION_COMPATIBILITY"] }); ctx.equal(ctx.canonical(after.work), ctx.canonical(before.work), "migration preserves Work"); ctx.equal(ctx.canonical(after.events), ctx.canonical(before.events), "migration preserves Events");
    return caseResult(ctx, { resources: Object.values(after.resources).reduce((sum, items) => sum + items.length, 0), work: after.work.length, events: after.events.length });
  },
);

const a03 = define(
  "A-03", "F-EMPTY legal and adversarial versioned seed family",
  "Import, replay and mutate deterministic seeds while injecting every published referential and scalar failure",
  "Valid seed state is exact and every invalid import exits nonzero without changing snapshot, Work or Events",
  ["public seed command", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.rating(); await ctx.migrate(); await ctx.seed(family.seed); await ctx.seed(family.seed); const api = await ctx.startApi(); const baseline = await snapshot(ctx, api.baseUrl);
    await ctx.stop(api); const conflict = structuredClone(family.seed); conflict.tenants[0].name = "changed"; const conflictResult = await ctx.seed(conflict, { allowFailure: true }); ctx.ok(conflictResult.exitCode !== 0 && `${conflictResult.stdout}${conflictResult.stderr}`.includes("SEED_VERSION_CONFLICT"), "same seedVersion changed digest rejected");
    const invalids = [];
    const unknown = structuredClone(family.seed); unknown.seedVersion = "invalid-unknown"; unknown.extra = true; invalids.push(unknown);
    const duplicate = structuredClone(family.seed); duplicate.seedVersion = "invalid-duplicate"; duplicate.meterDefinitions.push({ ...duplicate.meterDefinitions[0] }); invalids.push(duplicate);
    const missing = structuredClone(family.seed); missing.seedVersion = "invalid-reference"; missing.usageEvents[0].meterId = ctx.uuid("missing-meter"); invalids.push(missing);
    const overlap = structuredClone(family.seed); overlap.seedVersion = "invalid-overlap"; overlap.ratePlans[1].effectiveFrom = overlap.ratePlans[0].effectiveFrom; invalids.push(overlap);
    const badTime = structuredClone(family.seed); badTime.seedVersion = "invalid-time"; badTime.importedAt = "not-time"; invalids.push(badTime);
    const overflow = structuredClone(family.seed); overflow.seedVersion = "invalid-overflow"; overflow.usageEvents[0].quantity = Number.MAX_SAFE_INTEGER + 1; invalids.push(overflow);
    for (const value of invalids) { const result = await ctx.seed(value, { allowFailure: true }); ctx.ok(result.exitCode !== 0, `${value.seedVersion} rejected`); }
    const restarted = await ctx.startApi(); const after = await snapshot(ctx, restarted.baseUrl); ctx.equal(ctx.canonical(after.resources), ctx.canonical(baseline.resources), "invalid seeds preserve resources"); ctx.equal(after.work.length, baseline.work.length, "invalid seeds create no Work"); ctx.equal(after.events.length, baseline.events.length, "invalid seeds create no Events");
    return caseResult(ctx, { invalidFamilies: invalids.length });
  },
);

const a04 = define(
  "A-04", "F-EMPTY FINAL OpenAPI contract fixture",
  "Parse canonical OpenAPI and inspect every V1 and Manager operation, closed schema and public status",
  "Independent evaluator schema accepts exact OpenAPI 3.1 contract without assuming the unpublished revision wrapper",
  ["production OpenAPI HTTP"],
  async (ctx) => {
    const { api } = await boot(ctx, { family: ctx.fixtures.empty() }); const document = requireStatus(ctx, await ctx.openApi(api.baseUrl), 200, "OpenAPI"); openApi(ctx, document);
    for (const [path, pathItem] of Object.entries(document.paths)) for (const [method, operation] of Object.entries(pathItem)) if (["get", "post"].includes(method)) { ctx.ok(operation.responses && Object.keys(operation.responses).length > 0, `${method.toUpperCase()} ${path} publishes responses`); }
    const schemas = Object.values(document.components?.schemas ?? {}); ctx.ok(schemas.length > 0, "OpenAPI publishes component schemas"); ctx.ok(schemas.some((schema) => schema.properties?.effectiveTotalMinor), "Manager Statement detail is represented");
    return caseResult(ctx, { paths: Object.keys(document.paths).length, schemas: schemas.length }, [blocked("MS-A04-REVISION-DETAIL-WRAPPER", "SPEC-GAP-01")]);
  },
);

const a05 = define(
  "A-05", "F-EMPTY scalar, media, auth and cursor boundary fixture",
  "Send malformed media, JSON, unknown fields, auth, UUID, cursor and integer boundary requests",
  "Every public failure uses the exact stable error envelope and no invalid mutation changes durable state",
  ["public HTTP", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.rating(); const { api } = await boot(ctx, { family }); const before = await snapshot(ctx, api.baseUrl);
    expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/usage-batches", { method: "POST", headers: { "content-type": "text/plain", "idempotency-key": ctx.key("media") }, raw: "{}" }), 415, "UNSUPPORTED_MEDIA_TYPE");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/usage-batches", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("json") }, raw: "{" }), 400, "MALFORMED_JSON");
    expectError(ctx, await ctx.usageBatch(api.baseUrl, { ...usageBody(family.tenant.tenantId, [family.events[0]]), unknown: true }, { key: ctx.key("unknown") }), 400, "UNKNOWN_FIELD");
    expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/verification-snapshot"), 401, "ADMIN_AUTH_REQUIRED");
    expectError(ctx, await ctx.statement(api.baseUrl, "not-a-uuid"), 400, "INVALID_REQUEST");
    expectError(ctx, await ctx.statements(api.baseUrl, { cursor: "not-opaque" }), 400, "INVALID_CURSOR");
    const invalidQuantity = ctx.fixtures.event(91, { quantity: 1_000_000_001 }); expectError(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [invalidQuantity]), { key: ctx.key("quantity") }), 400, "INVALID_USAGE_BATCH");
    const after = await snapshot(ctx, api.baseUrl); ctx.equal(ctx.canonical({ resources: after.resources, work: after.work, events: after.events }), ctx.canonical({ resources: before.resources, work: before.work, events: before.events }), "invalid requests have zero durable effects");
    return caseResult(ctx, { checkedErrors: 7 }, [blocked("MS-A05-CORRECTION-REASON-BOUNDARIES", "SPEC-GAP-02")]);
  },
);

const a06 = define(
  "A-06", "F-V1-RATING multi-page snapshot fixture",
  "Create more than 110 immutable usage records, paginate with limits 1 and 100, and read one snapshot",
  "Opaque cursor traversal has no gap or duplicate and snapshot shapes, sorts, secrets and asOf are exact",
  ["public HTTP pagination", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.rating(); const events = Array.from({ length: 115 }, (_, index) => ctx.fixtures.event(200 + index, { meterId: family.meters[0].meterId, occurredAt: ctx.fixtures.at({ seconds: index }) })); family.seed = ctx.fixtures.seed("a06-pages", events); const { api } = await boot(ctx, { family });
    const seen = []; let cursor;
    for (let page = 0; page < 130; page += 1) { const response = await ctx.meterUsage(api.baseUrl, family.meters[0].meterId, { from: ctx.fixtures.at({ seconds: -1 }), to: ctx.fixtures.at({ minutes: 3 }), limit: page === 0 ? 1 : 100, ...(cursor ? { cursor } : {}) }); requireStatus(ctx, response, 200, "usage page"); assert.deepEqual(Object.keys(response.json).sort(), ["items", "nextCursor"]); response.json.items.forEach(assertUsageEvent); seen.push(...response.json.items); cursor = response.json.nextCursor; if (cursor === null) break; }
    ctx.equal(new Set(seen.map(({ eventId }) => eventId)).size, events.length, "pagination no duplicate or gap"); const state = await snapshot(ctx, api.baseUrl); ctx.equal(state.resources.usageEvents.length, events.length, "snapshot contains every event once");
    return caseResult(ctx, { pagesCovered: seen.length, asOf: state.asOf });
  },
);

const a07 = define(
  "A-07", "F-DEDUPE tenant-scoped batch fixture",
  "Submit one and one-thousand member batches, replay identical content and inject member and semantic conflicts",
  "Accepted and duplicate sets are exact while tenant scope and complete-batch rollback remain atomic",
  ["public usage batch HTTP", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.dedupe(); const { api } = await boot(ctx, { family }); const first = await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [family.source]), { key: ctx.key("first") }); requireStatus(ctx, first, 202, "first event"); exactIdSets(ctx, first, "acceptedEventIds", "duplicateEventIds", [family.source.eventId], [], "first");
    const replay = await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [family.duplicate]), { key: ctx.key("new-key-replay") }); requireStatus(ctx, replay, 202, "semantic duplicate"); exactIdSets(ctx, replay, "acceptedEventIds", "duplicateEventIds", [], [family.source.eventId], "replay");
    for (const conflict of family.conflicts) expectError(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [conflict]), { key: ctx.key(`conflict:${conflict.meterId}:${conflict.quantity}:${conflict.occurredAt}`) }), 409, "EVENT_ID_CONFLICT", { failureCodeSuffix: "DEDUPE_CONFLICT", hardCapIds: ["RATING_CONSERVATION"] });
    const crossTenant = await ctx.usageBatch(api.baseUrl, usageBody(family.otherTenant.tenantId, [family.other]), { key: ctx.key("other-tenant") }); requireStatus(ctx, crossTenant, 202, "cross-tenant same eventId");
    const thousand = Array.from({ length: 1000 }, (_, index) => ctx.fixtures.event(1_000 + index, { eventId: `a07-${String(index).padStart(4, "0")}` })); requireStatus(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, thousand), { key: ctx.key("thousand"), timeoutMs: 30_000 }), 202, "1000 event batch");
    const before = await snapshot(ctx, api.baseUrl); expectError(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [ctx.fixtures.event(9999, { eventId: "within" }), ctx.fixtures.event(9998, { eventId: "within" })]), { key: ctx.key("within-duplicate") }), 400, "INVALID_USAGE_BATCH"); const after = await snapshot(ctx, api.baseUrl); ctx.equal(ctx.canonical(after), ctx.canonical(before), "batch-member duplicate rolls back");
    return caseResult(ctx, { storedEvents: after.resources.usageEvents.length });
  },
);

const a08 = define(
  "A-08", "F-V1-RATING month and plan boundary fixture",
  "Ingest events at UTC month and Rate Plan switch boundaries, advance Watermark, and drain two workers",
  "Independent occurredAt oracle exactly matches Statement periods, versions, integer quantities and charges",
  ["public HTTP", "Rating workers", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.rating(); const { api } = await boot(ctx, { family: ctx.fixtures.empty() }); await ingest(ctx, api.baseUrl, family); const finished = await finalize(ctx, api.baseUrl, { ...family, through: "2035-03-01T00:00:00.000Z" });
    for (const period of new Set(family.events.map((event) => monthInterval(event.occurredAt).periodStart))) { const events = family.events.filter((event) => monthInterval(event.occurredAt).periodStart === period); const expected = ratePeriod(events, family.plans); const actual = statementFor(finished.snapshot, family.tenant.tenantId, period); ctx.ok(actual, `Statement ${period}`); ctx.assert(`Statement ${period} exact`, () => assertStatement(actual)); ctx.equal(actual.lines, expected.lines, `${period} independent rated lines`, { failureCodeSuffix: "RATING_MISMATCH", hardCapIds: ["RATING_CONSERVATION"] }); }
    return caseResult(ctx, { statements: finished.snapshot.resources.statements.length });
  },
);

const a09 = define(
  "A-09", "F-WATERMARK adjacent-month scheduling fixture",
  "Advance Watermark strictly across three months and drain a shared backlog with two workers",
  "Only covered periods finalize once in period/statement order with base revision, Work and event closure",
  ["public Watermark HTTP", "two Rating workers", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.watermark(); const { api } = await boot(ctx, { family }); const first = await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, "2035-02-01T00:00:00.000Z", { key: ctx.key("a09-first") }); requireStatus(ctx, first, 200, "first Watermark"); const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await waitSnapshot(ctx, api.baseUrl, (state) => state.resources.statements.filter(({ periodEnd }) => periodEnd <= "2035-02-01T00:00:00.000Z").every(({ state }) => state === "FINALIZED"), { processes: workers, label: "first Watermark drain" });
    requireStatus(ctx, await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, family.through, { key: ctx.key("a09-second") }), 200, "second Watermark"); const final = await waitSnapshot(ctx, api.baseUrl, (state) => state.work.length > 0 && state.work.every(({ terminal }) => terminal) && state.resources.statements.every(({ periodEnd, state: value }) => periodEnd > family.through || value === "FINALIZED") ? state : undefined, { processes: workers, label: "second Watermark drain" });
    ctx.ok(final.resources.statements.every(({ revision }) => revision === 1), "all base revisions equal one"); ctx.equal(eventsByType(final, "watermark.advanced").length, 2, "one event per Watermark advance"); ctx.equal(eventsByType(final, "statement.finalized").length, final.resources.statements.filter(({ state }) => state === "FINALIZED").length, "one event per finalized Statement");
    return caseResult(ctx, { work: final.work.length, finalized: final.resources.statements.filter(({ state }) => state === "FINALIZED").length });
  },
);

const a10 = define(
  "A-10", "F-WATERMARK finalized cutoff and rollback fixture",
  "After finalization submit events before, at and after cutoff plus a mixed late/legal batch",
  "Late batches return LATE_USAGE_EVENT, mixed batches roll back completely, and immutable history is unchanged",
  ["public HTTP", "Rating worker", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.watermark(); const { api } = await boot(ctx, { family }); const finished = await finalize(ctx, api.baseUrl, family); const before = finished.snapshot;
    const early = ctx.fixtures.event(400, { occurredAt: "2035-02-28T23:59:59.999Z" }); const equal = ctx.fixtures.event(401, { occurredAt: family.through }); const later = ctx.fixtures.event(402, { occurredAt: "2035-03-01T00:00:00.001Z" });
    expectError(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [early]), { key: ctx.key("early") }), 409, "LATE_USAGE_EVENT", { failureCodeSuffix: "LATE_ACCEPTED", hardCapIds: ["RATING_CONSERVATION"] });
    expectError(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [equal]), { key: ctx.key("equal") }), 409, "LATE_USAGE_EVENT");
    expectError(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [early, later]), { key: ctx.key("mixed") }), 409, "LATE_USAGE_EVENT"); requireStatus(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [later]), { key: ctx.key("later") }), 202, "post-cutoff open usage");
    const after = await snapshot(ctx, api.baseUrl); ctx.equal(after.resources.usageEvents.filter(({ eventId }) => [early.eventId, equal.eventId].includes(eventId)).length, 0, "late members absent"); ctx.equal(after.resources.usageEvents.filter(({ eventId }) => eventId === later.eventId).length, 1, "legal member accepted once"); ctx.equal(ctx.canonical(after.resources.statements.filter(({ state }) => state === "FINALIZED")), ctx.canonical(before.resources.statements.filter(({ state }) => state === "FINALIZED")), "finalized history immutable");
    return caseResult(ctx, { lateRejected: 3 });
  },
);

const a11 = define(
  "A-11", "F-V1-RATING strictly-interior usage range fixture",
  "Read Statement collection/detail, meter usage interior range and tenant Watermark across opaque pages",
  "Exact shapes, sorting, sums and Watermark progress match the independent oracle without guessing query boundaries",
  ["public read HTTP", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.rating(); const { api } = await boot(ctx, { family }); const finished = await finalize(ctx, api.baseUrl, { ...family, through: "2035-03-01T00:00:00.000Z" });
    const list = requireStatus(ctx, await ctx.statements(api.baseUrl, { limit: "100" }), 200, "Statement collection"); ctx.equal(Object.keys(list).sort(), ["items", "nextCursor"], "collection wrapper");
    for (const item of list.items) { const detail = requireStatus(ctx, await ctx.statement(api.baseUrl, item.statementId), 200, "Statement detail"); ctx.assert("StatementDetail", () => statementDetail(detail)); }
    const usage = requireStatus(ctx, await ctx.meterUsage(api.baseUrl, family.meters[0].meterId, { from: "2034-01-01T00:00:00.000Z", to: "2036-01-01T00:00:00.000Z", limit: "100" }), 200, "meter usage"); usage.items.forEach(assertUsageEvent);
    const watermark = requireStatus(ctx, await ctx.watermark(api.baseUrl, family.tenant.tenantId), 200, "Watermark read"); ctx.equal(watermark.watermarkThrough, "2035-03-01T00:00:00.000Z", "Watermark through"); ctx.ok(Array.isArray(watermark.openPeriodStarts), "openPeriodStarts array");
    return caseResult(ctx, { statements: list.items.length, usage: usage.items.length, asOf: finished.snapshot.asOf }, [blocked("MS-A11-RANGE-BOUNDARIES", "SPEC-GAP-05")]);
  },
);

const a12 = define(
  "A-12", "F-EVENT V1 success, rollback and delivery fixture",
  "Create successful and rejected V1 transitions, query event sequences, and deliver them to a receiver",
  "Only committed transitions have one exact published empty-payload event with contiguous aggregate sequence",
  ["public HTTP", "Domain Event query", "webhook receiver", "dispatcher"],
  async (ctx) => {
    const family = ctx.fixtures.eventFamily(); const { api } = await boot(ctx, { family }); const before = await snapshot(ctx, api.baseUrl); const batch = ctx.fixtures.event(500); await ingest(ctx, api.baseUrl, family, [batch]); const afterSuccess = await snapshot(ctx, api.baseUrl); expectError(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [{ ...batch, quantity: batch.quantity + 1 }]), { key: ctx.key("rollback") }), 409, "EVENT_ID_CONFLICT"); const afterFailure = await snapshot(ctx, api.baseUrl); ctx.equal(afterFailure.events.length, afterSuccess.events.length, "rollback creates no event", { failureCodeSuffix: "ROLLBACK_EVENT", hardCapIds: ["EVENT_TRANSACTIONALITY"] });
    const response = requireStatus(ctx, await ctx.domainEvents(api.baseUrl, { afterSequence: "0", limit: "100" }), 200, "Domain Event query"); const items = response.items ?? response; eventOracle(ctx, items, ["usage.batch-accepted", "watermark.advanced", "statement.finalized"]);
    const receiver = await ctx.receiver(); const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url }); await ctx.waitFor(() => receiver.ledger.some(({ acknowledged }) => acknowledged), { label: "event webhook delivery", timeoutMs: 90_000, processes: [dispatcher] });
    ctx.ok(afterSuccess.events.length > before.events.length, "successful batch commits event", { failureCodeSuffix: "MISSING_EVENT", hardCapIds: ["EVENT_TRANSACTIONALITY"] });
    return caseResult(ctx, { queried: items.length, delivered: receiver.ledger.length });
  },
);

const a13 = define(
  "A-13", "F-CORRECTION pre-finalization signed-delta fixture",
  "Commit positive and negative corrections before base finalization, then drain Rating Work",
  "Immutable corrections alter one effective base line using source occurredAt pricing and create no Revision",
  ["public correction HTTP", "Rating workers", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.correctionFamily(); const { api } = await boot(ctx, { family }); const response = await ctx.correctionBatch(api.baseUrl, correctionBody(family.tenant.tenantId, family.corrections.slice(0, 2)), { key: ctx.key("pre-final") }); requireStatus(ctx, response, 200, "pre-final corrections"); exactIdSets(ctx, response, "acceptedCorrectionIds", "duplicateCorrectionIds", family.corrections.slice(0, 2).map(({ correctionId }) => correctionId), [], "pre-final correction");
    const finished = await finalize(ctx, api.baseUrl, { ...family, through: "2035-01-01T00:00:00.000Z" }); const statement = statementFor(finished.snapshot, family.tenant.tenantId, "2034-12-01T00:00:00.000Z"); const expected = ratePeriod([family.events[0]], family.plans, family.corrections.slice(0, 2)); ctx.equal(statement.lines, expected.lines, "pre-final effective rated line", { failureCodeSuffix: "PRE_FINAL_RATING", hardCapIds: ["CORRECTION_REVISION_CORRECTNESS", "RATING_CONSERVATION"] }); ctx.equal(finished.snapshot.resources.statementRevisions.length, 0, "pre-final corrections create no Revision");
    const invalid = { ...family.corrections[2], sourceEventId: "missing-source" }; const before = await snapshot(ctx, api.baseUrl); expectError(ctx, await ctx.correctionBatch(api.baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[2], invalid]), { key: ctx.key("bad-pre") }), 400, "INVALID_CORRECTION_BATCH"); const after = await snapshot(ctx, api.baseUrl); ctx.equal(ctx.canonical(after), ctx.canonical(before), "invalid correction batch rolls back");
    return caseResult(ctx, { effectiveQuantity: statement.lines[0].quantity }, [blocked("MS-A13-CORRECTION-RESPONSE-ORDER", "SPEC-GAP-03"), blocked("MS-A13-CORRECTION-INGESTION-EVENT", "SPEC-GAP-04")]);
  },
);

const a14 = define(
  "A-14", "F-CORRECTION finalized Statement revision fixture",
  "Finalize base usage, commit two correction batches, drain workers, and read Statement and revision APIs",
  "One Revision per batch/Statement forms a continuous oracle-checked chain while the base JSON stays immutable",
  ["public correction HTTP", "Rating workers", "Statement APIs", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.correctionFamily(); const { api } = await boot(ctx, { family }); const baseRun = await finalize(ctx, api.baseUrl, { ...family, through: "2035-03-01T00:00:00.000Z" }); for (const worker of baseRun.workers) await ctx.stop(worker); const base = statementFor(baseRun.snapshot, family.tenant.tenantId, "2034-12-01T00:00:00.000Z"); const baseJson = ctx.canonical(base);
    for (const [index, correction] of family.corrections.slice(0, 2).entries()) { requireStatus(ctx, await ctx.correctionBatch(api.baseUrl, correctionBody(family.tenant.tenantId, [correction]), { key: ctx.key(`revision-${index}`) }), 200, "finalized correction"); const worker = await ctx.startWorker(); await waitSnapshot(ctx, api.baseUrl, (state) => state.resources.statementRevisions.filter(({ statementId, state: revisionState }) => statementId === base.statementId && revisionState === "FINALIZED").length === index + 1 ? state : undefined, { label: `Revision ${index + 2}`, processes: [worker] }); }
    const final = await snapshot(ctx, api.baseUrl); const revisions = final.resources.statementRevisions.filter(({ statementId }) => statementId === base.statementId); ctx.assert("continuous Revision chain", () => assertRevisionChain(base, revisions), { failureCodeSuffix: "REVISION_CHAIN", hardCapIds: ["CORRECTION_REVISION_CORRECTNESS"] }); ctx.equal(ctx.canonical(final.resources.statements.find(({ statementId }) => statementId === base.statementId)), baseJson, "base Statement immutable");
    const detail = requireStatus(ctx, await ctx.statement(api.baseUrl, base.statementId), 200, "StatementDetail"); statementDetail(detail); ctx.equal(detail.pendingRevision, null, "no pending Revision after drain");
    for (const revision of revisions) { const response = requireStatus(ctx, await ctx.revision(api.baseUrl, base.statementId, revision.revision), 200, "revision detail"); const semantic = semanticRevisionDetail(response); ctx.equal(semantic.revision.statementRevisionId, revision.statementRevisionId, "revision detail identity"); }
    ctx.equal(eventsByType(final, "statement.revision-finalized").length, revisions.length, "one event per finalized Revision", { failureCodeSuffix: "REVISION_EVENT", hardCapIds: ["EVENT_TRANSACTIONALITY"] });
    return caseResult(ctx, { statementId: base.statementId, revisions: revisions.length }, [blocked("MS-A14-REVISION-DETAIL-WRAPPER", "SPEC-GAP-01")]);
  },
);

function define(id, fixtureFamily, action, oracle, seams, run) { return Object.freeze({ id, taskId: "metersettle", fixtureFamily, action, oracle, seams: Object.freeze(seams), run }); }
function eventsByType(state, type) { return state.events.filter((event) => event.type === type); }

export const A_CASES = Object.freeze([a01, a02, a03, a04, a05, a06, a07, a08, a09, a10, a11, a12, a13, a14]);
