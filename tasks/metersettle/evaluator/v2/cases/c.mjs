import { assertEventSequence, assertWork } from "../oracles/index.mjs";
import {
  boot, caseResult, correctionBody, crashAtWorkerBarrier, eventsFor, finalize, requireStatus, snapshot,
  statementFor, waitSnapshot, workFor,
} from "./helpers.mjs";

const c01 = define(
  "C-01", "F-WORK public Rating lifecycle fixture",
  "Create Rating Work through Watermark and correction paths, observe lease transitions, then drain and restart",
  "Every Work has the exact shape, lease fields reflect only LEASED, terminal derivation is exact and history is retained",
  ["public Watermark HTTP", "Rating worker OS process", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.recovery(); const { api } = await boot(ctx, { family }); requireStatus(ctx, await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, family.through, { key: ctx.key("c01") }), 200, "Watermark creates Work"); const pending = await snapshot(ctx, api.baseUrl); ctx.ok(pending.work.some(({ state }) => state === "PENDING"), "PENDING Work observable"); ctx.assert("pending Work shape", () => assertWork(pending.work));
    let hold = true; const barrier = await ctx.barrier({ hold: ({ point }) => hold && point === "worker.claimed" }); const worker = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); await barrier.waitFor(({ json }) => json.point === "worker.claimed", { processes: [worker] }); const leased = await snapshot(ctx, api.baseUrl); ctx.ok(leased.work.some(({ state }) => state === "LEASED"), "LEASED Work observable"); ctx.assert("leased Work shape", () => assertWork(leased.work)); hold = false; barrier.releaseAll(); const final = await waitSnapshot(ctx, api.baseUrl, (state) => state.work.length && state.work.every(({ terminal }) => terminal) ? state : undefined, { label: "terminal Work", processes: [worker] }); ctx.assert("terminal Work shape", () => assertWork(final.work)); const ids = final.work.map(({ workId }) => workId); await ctx.stop(worker); const replacement = await ctx.startWorker(); await ctx.sleep(250); const restarted = await snapshot(ctx, api.baseUrl); ctx.ok(ids.every((id) => restarted.work.some(({ workId }) => workId === id)), "terminal Work retained after worker restart");
    return caseResult(ctx, { retainedWork: ids.length });
  },
);

const c02 = recoveryCase("C-02", "worker.claimed", "Claimed Work is reclaimed after SIGKILL and lease expiry without a stale completion");
const c03 = recoveryCase("C-03", "worker.effect-complete", "Computed Rating effects converge atomically after SIGKILL without duplicate line or Event");
const c04 = recoveryCase("C-04", "worker.before-commit", "The pre-commit transaction is wholly absent or committed exactly once after replacement recovery");

const c05 = define(
  "C-05", "F-WORK expired lease and stale-owner fencing fixture",
  "Hold Worker A after claim beyond lease expiry, let Worker B reclaim and commit, then release Worker A",
  "A stale owner cannot write and final Work attempt, Statement totals and event identity reflect one B completion",
  ["recovery barrier", "two worker OS processes", "SIGCONT-safe release", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.recovery(); const { api } = await boot(ctx, { family }); requireStatus(ctx, await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, family.through, { key: ctx.key("c05-watermark") }), 200, "create Rating Work"); let hold = true; const barrier = await ctx.barrier({ hold: ({ processRole, point }) => hold && processRole === "worker" && point === "worker.claimed" }); const workerA = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); const claim = await barrier.waitFor(({ json }) => json.point === "worker.claimed", { processes: [workerA] }); await ctx.sleep(3_300); const workerB = await ctx.startWorker(); const completed = await waitSnapshot(ctx, api.baseUrl, (state) => state.work.find(({ workId }) => workId === claim.json.workId)?.terminal ? state : undefined, { label: "replacement fenced completion", processes: [workerB] }); hold = false; barrier.releaseAll(); await ctx.sleep(500); const final = await snapshot(ctx, api.baseUrl); const work = final.work.find(({ workId }) => workId === claim.json.workId); ctx.ok(work.attempt > claim.json.attempt, "replacement increments Work attempt"); ctx.equal(ctx.canonical(final.resources.statements), ctx.canonical(completed.resources.statements), "stale worker cannot alter Statements", { failureCodeSuffix: "STALE_WORKER_COMMIT", hardCapIds: ["STALE_WORK_OR_LOST_WORK"] }); ctx.equal(ctx.canonical(final.events), ctx.canonical(completed.events), "stale worker cannot add Events");
    return caseResult(ctx, { workId: work.workId, attempt: work.attempt });
  },
);

const c06 = define(
  "C-06", "F-WATERMARK multi-period ordered backlog fixture",
  "Advance several tenant months, observe claims through the public barrier, drain with two workers and restart",
  "Covered Statements finalize once in periodStart then statementId order and no obsolete nonterminal Work survives",
  ["public Watermark HTTP", "two workers", "recovery barrier", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.recovery(); const { api } = await boot(ctx, { family }); requireStatus(ctx, await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, family.through, { key: ctx.key("c06-watermark") }), 200, "multi-period Watermark"); const barrier = await ctx.barrier(); const workers = [await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }), await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } })]; const final = await waitSnapshot(ctx, api.baseUrl, (state) => state.work.length && state.work.every(({ terminal }) => terminal) ? state : undefined, { label: "ordered backlog drain", processes: workers }); const statementOrder = [...final.resources.statements].sort((a, b) => a.periodStart.localeCompare(b.periodStart) || Buffer.from(a.statementId).compare(Buffer.from(b.statementId))).map(({ statementId }) => statementId); const claimed = barrier.ledger.filter(({ json }) => json.point === "worker.claimed").map(({ json }) => json.aggregateId); ctx.equal(claimed.slice(0, statementOrder.length), statementOrder, "claim order follows periodStart then statementId"); ctx.equal(final.work.filter(({ terminal }) => !terminal).length, 0, "no immortal backlog"); ctx.equal(new Set(final.resources.statements.map(({ statementId }) => statementId)).size, final.resources.statements.length, "Statements finalized once");
    return caseResult(ctx, { claims: claimed.length, terminalWork: final.work.length });
  },
);

const c07 = define(
  "C-07", "F-EVENT unknown webhook acknowledgement fixture",
  "Hold dispatcher after a persisted 2xx response, SIGKILL it, then return 500, disconnect and finally acknowledge",
  "Every retry preserves event ID, type and semantic body and acknowledged aggregate order remains increasing",
  ["webhook receiver", "dispatcher barrier", "dispatcher SIGKILL", "verification snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.eventFamily(); const { api } = await boot(ctx, { family }); requireStatus(ctx, await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, family.through, { key: ctx.key("c07-watermark") }), 200, "event-producing Watermark"); const worker = await ctx.startWorker(); await waitSnapshot(ctx, api.baseUrl, (state) => state.work.length && state.work.every(({ terminal }) => terminal) ? state : undefined, { label: "event creation", processes: [worker] });
    const receiver = await ctx.receiver({ behavior: (_entry, ledger) => ledger.length === 1 ? { status: 204 } : ledger.length === 2 ? { status: 500 } : ledger.length === 3 ? { disconnect: true } : { status: 204 } }); let held = true; const barrier = await ctx.barrier({ hold: ({ processRole, point }) => held && processRole === "dispatcher" && point === "dispatcher.response-received" }); const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); await barrier.waitFor(({ json }) => json.point === "dispatcher.response-received", { timeoutMs: 90_000, processes: [dispatcher] }); await ctx.kill(dispatcher); held = false; const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); await ctx.waitFor(() => receiver.ledger.length >= 4 && receiver.ledger.some((entry, index) => index >= 3 && entry.acknowledged), { label: "unknown ACK redelivery", timeoutMs: 120_000, processes: [replacement] }); const groups = new Map(); for (const entry of receiver.ledger) { const id = entry.headers["x-metersettle-event-id"]; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(entry); } for (const entries of groups.values()) { ctx.equal(new Set(entries.map(({ headers }) => headers["x-metersettle-event-type"])).size, 1, "retry event type stable"); ctx.equal(new Set(entries.map(({ raw }) => raw)).size, 1, "retry semantic body stable", { failureCodeSuffix: "EVENT_RETRY_CHANGED", hardCapIds: ["EVENT_TRANSACTIONALITY"] }); }
    const acknowledged = receiver.ledger.filter(({ acknowledged }) => acknowledged).map(({ json }) => json); for (const aggregate of new Set(acknowledged.map(({ aggregateId }) => aggregateId))) { const sequences = acknowledged.filter((event) => event.aggregateId === aggregate).map(({ sequence }) => sequence); ctx.equal(sequences, [...sequences].sort((a, b) => a - b), "acknowledged aggregate sequence order"); }
    return caseResult(ctx, { attempts: receiver.ledger.length, eventIdentities: groups.size });
  },
);

const c08 = define(
  "C-08", "F-CORRECTION combined transaction and recovery fixture",
  "Crash base and Revision Rating work at all three worker barriers, then crash dispatcher after response",
  "Statement, Revision, Work and published events converge together once with contiguous sequence and no rollback event",
  ["three worker barriers", "dispatcher barrier", "SIGKILL", "public snapshot"],
  async (ctx) => {
    const family = ctx.fixtures.correctionFamily(); const { api } = await boot(ctx, { family }); requireStatus(ctx, await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, "2035-01-01T00:00:00.000Z", { key: ctx.key("c08-watermark") }), 200, "base Work"); const baseCrash = await crashAtWorkerBarrier(ctx, api.baseUrl, "worker.claimed"); await ctx.stop(baseCrash.replacement); const base = statementFor(baseCrash.after, family.tenant.tenantId, "2034-12-01T00:00:00.000Z");
    for (const [index, point] of ["worker.effect-complete", "worker.before-commit"].entries()) { requireStatus(ctx, await ctx.correctionBatch(api.baseUrl, correctionBody(family.tenant.tenantId, [family.corrections[index]]), { key: ctx.key(`c08-correction-${index}`) }), 200, "revision correction"); const crash = await crashAtWorkerBarrier(ctx, api.baseUrl, point); await ctx.stop(crash.replacement); }
    const beforeDispatch = await snapshot(ctx, api.baseUrl); const receiver = await ctx.receiver(); let hold = true; const barrier = await ctx.barrier({ hold: ({ processRole, point }) => hold && processRole === "dispatcher" && point === "dispatcher.response-received" }); const dispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); await barrier.waitFor(({ json }) => json.point === "dispatcher.response-received", { timeoutMs: 90_000, processes: [dispatcher] }); await ctx.kill(dispatcher); hold = false; const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); await ctx.waitFor(() => receiver.ledger.some((entry, index) => index > 0 && entry.acknowledged), { label: "post-crash dispatch acknowledgement", timeoutMs: 120_000, processes: [replacement] }); const final = await snapshot(ctx, api.baseUrl); ctx.equal(final.resources.statements.find(({ statementId }) => statementId === base.statementId).state, "FINALIZED", "base Statement finalized"); ctx.ok(final.resources.statementRevisions.filter(({ statementId }) => statementId === base.statementId).every(({ state }) => state === "FINALIZED"), "Revisions finalized"); ctx.assert("event sequences contiguous", () => assertEventSequence(final.events), { failureCodeSuffix: "EVENT_SEQUENCE", hardCapIds: ["EVENT_TRANSACTIONALITY"] }); ctx.equal(final.events.length, beforeDispatch.events.length, "dispatch does not create new event identities");
    return caseResult(ctx, { work: final.work.length, revisions: final.resources.statementRevisions.length, deliveries: receiver.ledger.length });
  },
);

function recoveryCase(id, point, oracle) {
  return define(id, "F-WORK deterministic worker crash fixture", `Advance Watermark, hold ${point}, SIGKILL the worker, wait for lease expiry and start a replacement`, oracle, ["public Watermark HTTP", "recovery barrier", "worker SIGKILL", "verification snapshot"], async (ctx) => {
    const family = ctx.fixtures.recovery(); const { api } = await boot(ctx, { family }); requireStatus(ctx, await ctx.advanceWatermark(api.baseUrl, family.tenant.tenantId, family.through, { key: ctx.key(`${id}-watermark`) }), 200, "create due Work"); const result = await crashAtWorkerBarrier(ctx, api.baseUrl, point); const work = result.after.work.find(({ workId }) => workId === result.entry.json.workId); ctx.ok(work.terminal && work.attempt > result.entry.json.attempt, "replacement reclaims and terminates Work", { failureCodeSuffix: "WORK_NOT_RECOVERED", hardCapIds: ["STALE_WORK_OR_LOST_WORK"] }); const statement = result.after.resources.statements.find(({ statementId }) => statementId === result.entry.json.aggregateId); ctx.ok(statement && statement.state === "FINALIZED", "Statement finalized once"); ctx.equal(new Set(statement.lines.map(({ eventId }) => eventId)).size, statement.lines.length, "no duplicate rated line"); ctx.equal(eventsFor(result.after, statement.statementId, "statement.finalized").length, 1, "one finalized event", { failureCodeSuffix: "EVENT_DUPLICATED", hardCapIds: ["EVENT_TRANSACTIONALITY"] }); return caseResult(ctx, { point, workId: work.workId, attempt: work.attempt });
  });
}
function define(id, fixtureFamily, action, oracle, seams, run) { return Object.freeze({ id, taskId: "metersettle", fixtureFamily, action, oracle, seams: Object.freeze(seams), run }); }

export const C_CASES = Object.freeze([c01, c02, c03, c04, c05, c06, c07, c08]);
