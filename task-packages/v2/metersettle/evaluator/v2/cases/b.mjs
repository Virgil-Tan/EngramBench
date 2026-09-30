import {
  assertRevisionChain, ratePeriod, revisionDelta,
} from "../oracles/index.mjs";
import {
  blocked, boot, caseResult, correctionBody, exactIdSets, expectError, finalize, ingest, requireStatus,
  snapshot, stableSemantic, statementFor, usageBody, waitSnapshot,
} from "./helpers.mjs";

const b01 = define(
  "B-01", "F-V1-RATING zero, large and plan-boundary arithmetic fixture",
  "Finalize zero-priced, large safe-integer and multi-plan Usage Events through public workers",
  "Independent safe-integer rating recomputes every line, total and plan version without floating point",
  ["public HTTP", "Rating workers", "verification snapshot", "task-local oracle"],
  async (ctx) => {
    const family = ctx.fixtures.rating(); const zeroPlan = { ...family.plans[0], unitPriceMinor: 0 }; const plans = [zeroPlan, family.plans[1]]; const seed = { ...family.seed, ratePlans: [...plans, ctx.fixtures.otherPlan] }; const { api } = await boot(ctx, { family: { ...family, plans, seed } }); const result = await finalize(ctx, api.baseUrl, { ...family, plans, through: "2035-03-01T00:00:00.000Z" });
    for (const statement of result.snapshot.resources.statements) { const source = family.events.filter(({ occurredAt }) => occurredAt >= statement.periodStart && occurredAt < statement.periodEnd); const expected = ratePeriod(source, plans); ctx.equal(statement.lines, expected.lines, `${statement.statementId} rated lines`, { failureCodeSuffix: "ARITHMETIC_MISMATCH", hardCapIds: ["RATING_CONSERVATION"] }); ctx.equal(statement.totalQuantity, expected.totalQuantity, "safe quantity sum"); ctx.equal(statement.totalMinor, expected.totalMinor, "safe money sum"); }
    return caseResult(ctx, { statements: result.snapshot.resources.statements.length });
  },
);

const b02 = define(
  "B-02", "F-DEDUPE mixed-validity atomic batch fixture",
  "Combine legal members with duplicate conflicts, missing plans and duplicate batch members",
  "Each semantic failure returns its stable code and leaves Usage, Statement, Work, idempotency effects and Events unchanged",
  ["public usage HTTP", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.dedupe(); const { api } = await boot(ctx, { family }); await ingest(ctx, api.baseUrl, family, [family.source]);
    const attempts = [
      { events: [ctx.fixtures.event(600), family.conflicts[2]], status: 409, code: "EVENT_ID_CONFLICT" },
      { events: [ctx.fixtures.event(601), ctx.fixtures.event(602, { occurredAt: "2033-01-01T00:00:00.000Z" })], status: 409, code: "RATE_PLAN_UNAVAILABLE" },
      { events: [ctx.fixtures.event(603), ctx.fixtures.event(604, { eventId: "same-member" }), ctx.fixtures.event(605, { eventId: "same-member" })], status: 400, code: "INVALID_USAGE_BATCH" },
    ];
    for (const [index, attempt] of attempts.entries()) { const before = await snapshot(ctx, api.baseUrl); const response = await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, attempt.events), { key: ctx.key(`b02-${index}`) }); expectError(ctx, response, attempt.status, attempt.code, { failureCodeSuffix: "PARTIAL_BATCH", hardCapIds: ["RATING_CONSERVATION"] }); const after = await snapshot(ctx, api.baseUrl); ctx.equal(ctx.canonical({ resources: after.resources, work: after.work, events: after.events }), ctx.canonical({ resources: before.resources, work: before.work, events: before.events }), `${attempt.code} has zero effect`); }
    return caseResult(ctx, { rejectedAtomicBatches: attempts.length });
  },
);

const b03 = define(
  "B-03", "F-DEDUPE immutable terminal-history fixture",
  "Finalize a tenant event, replay identical and conflicting semantics with new keys, then reuse the ID in another tenant",
  "Terminal history charges once, conflicts forever within tenant, and another tenant remains an independent scope",
  ["public HTTP", "Rating workers", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.dedupe(); const seeded = { ...family, events: [family.source], through: "2036-01-01T00:00:00.000Z", seed: ctx.fixtures.seed("b03-terminal", [family.source]) }; const { api } = await boot(ctx, { family: seeded }); const done = await finalize(ctx, api.baseUrl, seeded); const base = ctx.canonical(done.snapshot.resources.statements);
    const duplicate = await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [family.source]), { key: ctx.key("terminal-duplicate") }); requireStatus(ctx, duplicate, 202, "terminal duplicate"); exactIdSets(ctx, duplicate, "acceptedEventIds", "duplicateEventIds", [], [family.source.eventId], "terminal duplicate");
    expectError(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.tenant.tenantId, [family.conflicts[0]]), { key: ctx.key("terminal-conflict") }), 409, "EVENT_ID_CONFLICT", { failureCodeSuffix: "TERMINAL_DEDUPE_CHANGED", hardCapIds: ["RATING_CONSERVATION"] });
    requireStatus(ctx, await ctx.usageBatch(api.baseUrl, usageBody(family.otherTenant.tenantId, [family.other]), { key: ctx.key("cross") }), 202, "other tenant same eventId"); const after = await snapshot(ctx, api.baseUrl); ctx.equal(ctx.canonical(after.resources.statements.filter(({ tenantId }) => tenantId === family.tenant.tenantId)), base, "tenant finalized history immutable");
    return caseResult(ctx, { tenantEvents: after.resources.usageEvents.filter(({ tenantId }) => tenantId === family.tenant.tenantId).length });
  },
);

const b04 = define(
  "B-04", "F-DEDUPE response-loss durable replay fixture",
  "Drop complete upstream responses for Usage Batch, Watermark and Correction, then replay before and after API restart",
  "Saved status, semantic JSON and identities remain stable with exactly one business, Work and Event effect",
  ["public HTTP response shield", "API restart", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.correctionFamily(); const { api } = await boot(ctx, { family }); const shield = await ctx.responseShield(api.baseUrl);
    const operations = [
      { label: "usage", key: ctx.key("lost-usage"), call: (url) => ctx.usageBatch(url, usageBody(family.tenant.tenantId, [ctx.fixtures.event(700)]), { key: ctx.key("lost-usage") }) },
      { label: "watermark", key: ctx.key("lost-watermark"), call: (url) => ctx.advanceWatermark(url, family.tenant.tenantId, "2035-01-01T00:00:00.000Z", { key: ctx.key("lost-watermark") }) },
      { label: "correction", key: ctx.key("lost-correction"), call: (url) => ctx.correctionBatch(url, correctionBody(family.tenant.tenantId, [family.corrections[0]]), { key: ctx.key("lost-correction") }) },
    ];
    for (const operation of operations) { shield.dropNextMutation(); await operation.call(shield.baseUrl).catch(() => undefined); await ctx.waitFor(() => shield.captures.find(({ dropped, request }) => dropped && request.headers["idempotency-key"] === operation.key), { label: `${operation.label} dropped upstream response` }); const capture = shield.captures.find(({ request }) => request.headers["idempotency-key"] === operation.key); const replay = await operation.call(api.baseUrl); ctx.equal(replay.status, capture.response.status, `${operation.label} replay status`); ctx.equal(ctx.canonical(replay.json), ctx.canonical(JSON.parse(capture.response.body)), `${operation.label} replay body`, { failureCodeSuffix: "UNKNOWN_REPLAY_CHANGED", hardCapIds: ["IDEMPOTENCY_CORRECTNESS"] }); }
    const beforeRestart = await snapshot(ctx, api.baseUrl); await ctx.stop(api); const restarted = await ctx.startApi(); for (const operation of operations) { const firstCapture = shield.captures.find(({ request }) => request.headers["idempotency-key"] === operation.key); const replay = await operation.call(restarted.baseUrl); ctx.equal(ctx.canonical(replay.json), ctx.canonical(JSON.parse(firstCapture.response.body)), `${operation.label} restart replay`); } const afterRestart = await snapshot(ctx, restarted.baseUrl); ctx.equal(ctx.canonical({ resources: afterRestart.resources, work: afterRestart.work, events: afterRestart.events }), ctx.canonical({ resources: beforeRestart.resources, work: beforeRestart.work, events: beforeRestart.events }), "restart replay creates no second effect");
    return caseResult(ctx, { operations: operations.length });
  },
);

const b05 = define(
  "B-05", "F-DEDUPE two-API same-key contention fixture",
  "Issue sixty-four identical same-key mutations across two API processes and replay from a third process",
  "All responses converge on one saved result while a different body conflicts and snapshot has one effect chain",
  ["three API OS processes", "public HTTP", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.dedupe(); const { apis } = await boot(ctx, { family, apiCount: 2 }); const key = ctx.key("contended"); const body = usageBody(family.tenant.tenantId, [family.source]); const responses = await ctx.concurrent(Array.from({ length: 64 }), 64, (_, index) => ctx.usageBatch(apis[index % 2].baseUrl, body, { key })); responses.forEach((response) => requireStatus(ctx, response, 202, "contended mutation")); stableSemantic(ctx, responses, "64-way contended replay", { failureCodeSuffix: "CONTENTION_DIVERGED", hardCapIds: ["IDEMPOTENCY_CORRECTNESS"] });
    const third = await ctx.startApi(); stableSemantic(ctx, [responses[0], await ctx.usageBatch(third.baseUrl, body, { key })], "third API replay"); expectError(ctx, await ctx.usageBatch(third.baseUrl, usageBody(family.tenant.tenantId, [{ ...family.source, quantity: family.source.quantity + 1 }]), { key }), 409, "IDEMPOTENCY_CONFLICT"); const state = await snapshot(ctx, third.baseUrl); ctx.equal(state.resources.usageEvents.filter(({ eventId, tenantId }) => eventId === family.source.eventId && tenantId === family.tenant.tenantId).length, 1, "one durable event effect"); ctx.equal(state.events.filter(({ type }) => type === "usage.batch-accepted").length, 1, "one business event effect");
    return caseResult(ctx, { responses: responses.length });
  },
);

const b06 = define(
  "B-06", "F-WATERMARK deterministic ingest/finalization race fixture",
  "Run three fixed two-API/two-worker interleavings of usage commit, Watermark commit and Rating lock",
  "Each event is either included once before the lock or atomically rejected late, never lost or appended to finalized history",
  ["two API processes", "two Rating workers", "public HTTP", "verification snapshot"],
  async (ctx) => {
    const outcomes = [];
    for (let interleaving = 0; interleaving < 3; interleaving += 1) {
      if (interleaving > 0) await ctx.resetDatabase(); const family = ctx.fixtures.watermark(); await ctx.migrate(); await ctx.seed({ ...family.seed, seedVersion: `b06-${interleaving}` }); const apis = [await ctx.startApi(), await ctx.startApi()]; const raced = ctx.fixtures.event(800 + interleaving, { occurredAt: "2035-02-28T23:59:59.999Z" });
      const tasks = interleaving === 0 ? [ctx.usageBatch(apis[0].baseUrl, usageBody(family.tenant.tenantId, [raced]), { key: ctx.key(`ingest-${interleaving}`) }), ctx.advanceWatermark(apis[1].baseUrl, family.tenant.tenantId, family.through, { key: ctx.key(`watermark-${interleaving}`) })] : [ctx.advanceWatermark(apis[1].baseUrl, family.tenant.tenantId, family.through, { key: ctx.key(`watermark-${interleaving}`) }), ctx.usageBatch(apis[0].baseUrl, usageBody(family.tenant.tenantId, [raced]), { key: ctx.key(`ingest-${interleaving}`) })]; const [first, second] = await Promise.all(tasks); const ingestResponse = interleaving === 0 ? first : second; ctx.ok(ingestResponse.status === 202 || (ingestResponse.status === 409 && ingestResponse.json?.error?.code === "LATE_USAGE_EVENT"), "race has one published outcome"); const workers = [await ctx.startWorker(), await ctx.startWorker()]; const final = await waitSnapshot(ctx, apis[0].baseUrl, (state) => state.work.length > 0 && state.work.every(({ terminal }) => terminal) ? state : undefined, { label: "race drain", processes: workers }); const stored = final.resources.usageEvents.filter(({ eventId }) => eventId === raced.eventId).length; const rated = final.resources.statements.flatMap(({ lines }) => lines).filter(({ eventId }) => eventId === raced.eventId).length; ctx.equal(stored, ingestResponse.status === 202 ? 1 : 0, "race storage outcome"); ctx.equal(rated, stored, "race rated exactly once", { failureCodeSuffix: "RACE_LOST_OR_DUPLICATED", hardCapIds: ["RATING_CONSERVATION"] }); outcomes.push(ingestResponse.status);
    }
    return caseResult(ctx, { interleavings: outcomes });
  },
);

const b07 = define(
  "B-07", "F-CORRECTION negative and safe-integer overflow fixture",
  "Mix valid corrections with negative-effective, multiplication-overflow and total-overflow members",
  "Each batch fails with its published code and commits no Correction, Revision, Work, Statement or Event fragment",
  ["public correction HTTP", "verification snapshot", "task-local integer oracle"],
  async (ctx) => {
    const family = ctx.fixtures.correctionFamily(); const { api } = await boot(ctx, { family }); const negative = { ...family.corrections[0], correctionId: "negative", quantityDelta: -11 }; const overflow = { ...family.corrections[2], correctionId: "overflow", quantityDelta: Number.MAX_SAFE_INTEGER };
    for (const [index, item, status, code] of [[0, negative, 409, "NEGATIVE_EFFECTIVE_USAGE"], [1, overflow, 400, "CORRECTION_TOTAL_OVERFLOW"]]) { const before = await snapshot(ctx, api.baseUrl); expectError(ctx, await ctx.correctionBatch(api.baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[1], item]), { key: ctx.key(`b07-${index}`) }), status, code, { failureCodeSuffix: "CORRECTION_PARTIAL", hardCapIds: ["CORRECTION_REVISION_CORRECTNESS"] }); const after = await snapshot(ctx, api.baseUrl); ctx.equal(ctx.canonical({ resources: after.resources, work: after.work, events: after.events }), ctx.canonical({ resources: before.resources, work: before.work, events: before.events }), `${code} full rollback`); }
    return caseResult(ctx, { rejected: 2 });
  },
);

const b08 = define(
  "B-08", "F-CORRECTION three finalization-lock interleavings fixture",
  "Race correction commit against base Rating finalization in three deterministic process schedules",
  "The correction is counted once in base before the lock or one Revision after it, with exact conserved totals",
  ["public HTTP", "two Rating workers", "recovery barrier", "verification snapshot"],
  async (ctx) => {
    const results = [];
    for (let schedule = 0; schedule < 3; schedule += 1) {
      if (schedule > 0) await ctx.resetDatabase(); const family = ctx.fixtures.correctionFamily(); await ctx.migrate(); await ctx.seed({ ...family.seed, seedVersion: `b08-${schedule}` }); const api = await ctx.startApi();
      if (schedule === 0) requireStatus(ctx, await ctx.correctionBatch(api.baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[0]]), { key: ctx.key(`before-${schedule}`) }), 200, "correction before worker");
      requireStatus(ctx, await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, "2035-01-01T00:00:00.000Z", { key: ctx.key(`watermark-${schedule}`) }), 200, "race Watermark"); const workers = [await ctx.startWorker(), await ctx.startWorker()];
      if (schedule > 0) await ctx.sleep(schedule === 1 ? 0 : 25).then(() => ctx.correctionBatch(api.baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[0]]), { key: ctx.key(`race-${schedule}`) })).then((response) => requireStatus(ctx, response, 200, "raced correction"));
      const final = await waitSnapshot(ctx, api.baseUrl, (state) => state.work.length > 0 && state.work.every(({ terminal }) => terminal) && state.resources.statements.some(({ state: value }) => value === "FINALIZED") && !state.resources.statementRevisions.some(({ state: value }) => value === "FINALIZING") ? state : undefined, { label: "correction/finalization race closure", processes: workers }); const sourceStatement = statementFor(final, family.tenant.tenantId, "2034-12-01T00:00:00.000Z"); const baseHasCorrection = sourceStatement.lines[0]?.quantity === family.events[0].quantity + family.corrections[0].quantityDelta; const revisions = final.resources.statementRevisions.filter(({ statementId }) => statementId === sourceStatement.statementId); ctx.equal(final.resources.correctionEvents.filter(({ correctionId }) => correctionId === family.corrections[0].correctionId).length, 1, "race accepts correction exactly once"); ctx.ok(baseHasCorrection || revisions.length === 1, "published lock-boundary result", { failureCodeSuffix: "CORRECTION_RACE_LOST", hardCapIds: ["CORRECTION_REVISION_CORRECTNESS", "RATING_CONSERVATION"] }); if (revisions.length) ctx.equal(revisions[0].deltaMinor, revisionDelta([family.corrections[0]], family.events, family.plans), "race revision delta"); results.push({ baseHasCorrection, revisions: revisions.length });
    }
    return caseResult(ctx, { schedules: results });
  },
);

const b09 = define(
  "B-09", "F-CORRECTION concurrent pending-Revision fixture",
  "Create one FINALIZING Revision, contend a second correction batch, drain it and retry",
  "At most one Revision is pending, the loser has zero effect, and the later finalized chain increments exactly once",
  ["two API processes", "public correction HTTP", "Rating worker", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.correctionFamily(); const { apis } = await boot(ctx, { family, apiCount: 2 }); const baseRun = await finalize(ctx, apis[0].baseUrl, { ...family, through: "2035-03-01T00:00:00.000Z" }); for (const worker of baseRun.workers) await ctx.stop(worker); const base = statementFor(baseRun.snapshot, family.tenant.tenantId, "2034-12-01T00:00:00.000Z");
    requireStatus(ctx, await ctx.correctionBatch(apis[0].baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[0]]), { key: ctx.key("pending-first") }), 200, "first pending revision"); const pending = await snapshot(ctx, apis[0].baseUrl); ctx.equal(pending.resources.statementRevisions.filter(({ statementId, state }) => statementId === base.statementId && state === "FINALIZING").length, 1, "one pending Revision");
    const beforeLoser = ctx.canonical({ corrections: pending.resources.correctionEvents, revisions: pending.resources.statementRevisions, events: pending.events }); expectError(ctx, await ctx.correctionBatch(apis[1].baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[1]]), { key: ctx.key("pending-loser") }), 409, "STATEMENT_REVISION_PENDING", { failureCodeSuffix: "PENDING_ACCEPTED", hardCapIds: ["CORRECTION_REVISION_CORRECTNESS"] }); const afterLoser = await snapshot(ctx, apis[0].baseUrl); ctx.equal(ctx.canonical({ corrections: afterLoser.resources.correctionEvents, revisions: afterLoser.resources.statementRevisions, events: afterLoser.events }), beforeLoser, "pending loser zero effect");
    const worker = await ctx.startWorker(); await waitSnapshot(ctx, apis[0].baseUrl, (state) => state.resources.statementRevisions.some(({ statementId, state: value }) => statementId === base.statementId && value === "FINALIZED"), { label: "first Revision finalized", processes: [worker] }); requireStatus(ctx, await ctx.correctionBatch(apis[1].baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[1]]), { key: ctx.key("pending-retry") }), 200, "later correction retry"); const worker2 = await ctx.startWorker(); const final = await waitSnapshot(ctx, apis[0].baseUrl, (state) => state.resources.statementRevisions.filter(({ statementId, state: value }) => statementId === base.statementId && value === "FINALIZED").length === 2 ? state : undefined, { label: "second Revision finalized", processes: [worker2] }); ctx.assert("pending Revision chain", () => assertRevisionChain(base, final.resources.statementRevisions.filter(({ statementId }) => statementId === base.statementId)));
    return caseResult(ctx, { revisions: 2 });
  },
);

const b10 = define(
  "B-10", "F-CORRECTION multi-Statement grouping and replay fixture",
  "Submit one correction batch spanning two finalized Statements, replay concurrently, then mix one duplicate and one new correction",
  "Each affected Statement receives at most one Revision with byte-sorted IDs and accepted/duplicate sets are atomic",
  ["public correction HTTP", "two API processes", "Rating workers", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.correctionFamily(); const { apis } = await boot(ctx, { family, apiCount: 2 }); const baseRun = await finalize(ctx, apis[0].baseUrl, { ...family, through: "2035-03-01T00:00:00.000Z" }); for (const worker of baseRun.workers) await ctx.stop(worker); const bases = baseRun.snapshot.resources.statements; const key = ctx.key("multi-statement"); const body = correctionBody(family.tenant.tenantId, [family.corrections[0], family.corrections[2]]); const responses = await ctx.concurrent(Array.from({ length: 16 }), 16, (_, index) => ctx.correctionBatch(apis[index % 2].baseUrl, body, { key })); responses.forEach((response) => requireStatus(ctx, response, 200, "multi-Statement replay")); stableSemantic(ctx, responses, "multi-Statement replay");
    const workers = [await ctx.startWorker(), await ctx.startWorker()]; const first = await waitSnapshot(ctx, apis[0].baseUrl, (state) => state.resources.statementRevisions.filter(({ state: value }) => value === "FINALIZED").length === 2 ? state : undefined, { label: "two grouped revisions", processes: workers }); for (const base of bases) ctx.equal(first.resources.statementRevisions.filter(({ statementId }) => statementId === base.statementId).length, 1, `${base.statementId} one Revision`);
    const mixed = await ctx.correctionBatch(apis[0].baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[0], family.corrections[1]]), { key: ctx.key("mixed-duplicate-new") }); requireStatus(ctx, mixed, 200, "mixed duplicate/new"); exactIdSets(ctx, mixed, "acceptedCorrectionIds", "duplicateCorrectionIds", [family.corrections[1].correctionId], [family.corrections[0].correctionId], "mixed correction"); const worker = await ctx.startWorker(); const final = await waitSnapshot(ctx, apis[0].baseUrl, (state) => state.resources.statementRevisions.filter(({ state: value }) => value === "FINALIZED").length === 3 ? state : undefined, { label: "mixed correction Revision", processes: [worker] }); for (const revision of final.resources.statementRevisions) ctx.equal(revision.correctionIds, [...revision.correctionIds].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))), "Revision IDs byte sorted");
    return caseResult(ctx, { revisions: final.resources.statementRevisions.length });
  },
);

function define(id, fixtureFamily, action, oracle, seams, run) { return Object.freeze({ id, taskId: "metersettle", fixtureFamily, action, oracle, seams: Object.freeze(seams), run }); }

export const B_CASES = Object.freeze([b01, b02, b03, b04, b05, b06, b07, b08, b09, b10]);
