import assert from "node:assert/strict";

import { rankOneToOne } from "../oracles/index.mjs";
import {
  assertNoChange, assertSnapshot, canonicalJson, crashWorkerAtBarrier, createGroup, createMatch,
  finalEvidence, guardedCase, groupAction, matchAction, prepare, resource, revisionMaps,
  seedWithRecords, waitForDrain,
} from "./helpers.mjs";

const BARRIER_POINTS = Object.freeze(["worker.claimed", "worker.effect-complete", "worker.before-commit"]);

function fixtureRecords(fixtures, label, amounts = [501, 502, 503]) {
  const batchId = fixtures.uuid(`${label}-batch`);
  const statementLines = amounts.map((amountMinor, index) => ({ statementLineId: fixtures.uuid(`${label}-line-${index}`), batchId, externalId: `${label}-${index}`, bookedAt: fixtures.date(index), currency: "USD", amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1 }));
  const ledgerEntries = amounts.map((amountMinor, index) => ({ ledgerEntryId: fixtures.uuid(`${label}-entry-${index}`), postedAt: fixtures.date(index), currency: "USD", amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1 }));
  return { statementLines, ledgerEntries };
}

const C01 = guardedCase({
  id: "C-01", fixtureFamily: "RH-F-SUGGESTION-LEASE-FENCE",
  action: "At each published worker barrier hold one leased Suggestion Task, SIGKILL its owner, wait for expiry and start two replacements.",
  oracle: "The retained workId is reclaimed with a higher attempt, stale ownership cannot commit and the final proposal set and digest equal independent ranking once.",
  async run(ctx) {
    const evidence = []; await prepare(ctx, { build: true, migrate: false });
    for (let index = 0; index < BARRIER_POINTS.length; index += 1) {
      const point = BARRIER_POINTS[index]; await ctx.resetDatabase(); await ctx.migrate();
      const fixture = fixtureRecords(ctx.fixtures, `c01-${index}`); await ctx.seed(seedWithRecords(ctx.fixtures, { label: `c01-${index}`, ...fixture }));
      const api = await ctx.startApi(); const before = await ctx.snapshot(api.baseUrl); const pending = before.work.find(({ kind, terminal }) => kind === "MATCH_SUGGESTION" && !terminal);
      ctx.ok(pending, `${point} has persisted Suggestion Task`);
      const crashed = await crashWorkerAtBarrier(ctx, api.baseUrl, point, ({ workId }) => workId === pending.workId);
      await new Promise((resolve) => setTimeout(resolve, 3_250)); const replacements = [await ctx.startWorker(), await ctx.startWorker()];
      const state = await waitForDrain(ctx, api.baseUrl, { processes: replacements, timeoutMs: 60_000 }); assertSnapshot(ctx, state);
      const retained = state.work.find(({ workId }) => workId === pending.workId); ctx.ok(retained?.terminal && retained.attempt > crashed.entry.json.attempt, `${point} Work is reclaimed`, { hardCapIds: ["STALE_WORK_OR_LOST_WORK"] });
      const expected = rankOneToOne(fixture.statementLines, fixture.ledgerEntries); const actual = resource(state, "matches").filter(({ state: status }) => status === "PROPOSED").map(({ statementLineId, ledgerEntryId, score }) => ({ statementLineId, ledgerEntryId, score }));
      ctx.equal(actual, expected.map(({ statementLineId, ledgerEntryId, score }) => ({ statementLineId, ledgerEntryId, score })), `${point} deterministic proposal set`, { hardCapIds: ["STALE_WORK_OR_LOST_WORK"] });
      ctx.equal(new Set(actual.map(({ statementLineId }) => statementLineId)).size, actual.length, `${point} no duplicate Statement Line proposal`);
      evidence.push({ point, workId: pending.workId, attempt: retained.attempt, proposals: actual.length }); await ctx.stop(api);
    }
    return finalEvidence(ctx, { recoveries: evidence });
  },
}, ["STALE_WORK_OR_LOST_WORK"]);

const C02 = guardedCase({
  id: "C-02", fixtureFamily: "RH-F-BATCH-COMPLETE-RESPONSE-LOSS",
  action: "Disconnect after a complete batch response, kill that API, restart and replay the same mutation while observing all lines, Work and saved JSON.",
  oracle: "The only legal recovery is exact complete saved status and body with one full batch, or no batch at all before retry; a partial line set is forbidden.",
  async run(ctx) {
    const seedFixture = fixtureRecords(ctx.fixtures, "c02-seed", [901]); const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "c02-seed", ...seedFixture }) });
    const api = await target.startApi(); const body = { source: "c02-bank", batchKey: "lost", lines: Array.from({ length: 12 }, (_, index) => ({ externalId: `c02-${index}`, bookedAt: ctx.fixtures.date(index % 4), currency: "USD", amountMinor: 50_000 + index, reference: `C02-${index}` })) };
    const key = ctx.key("c02-lost-response"); const before = await ctx.snapshot(api.baseUrl); const shield = await ctx.responseShield(api.baseUrl); shield.dropNextMutation();
    await assert.rejects(ctx.mutate(shield.baseUrl, "/api/v1/statement-batches", key, body));
    const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "complete batch response before disconnect" });
    const original = JSON.parse(capture.response.body); await ctx.kill(api); const restarted = await target.startApi();
    const replay = await ctx.mutate(restarted.baseUrl, "/api/v1/statement-batches", key, body);
    ctx.equal([replay.status, replay.json], [capture.response.status, original], "unknown response exact replay", { hardCapIds: ["DURABLE_IDEMPOTENCY", "CONSERVATION_OR_ATOMICITY"] });
    const state = await ctx.snapshot(restarted.baseUrl); assertSnapshot(ctx, state);
    const batches = resource(state, "statementBatches").filter(({ batchId }) => batchId === original.batchId); const lines = resource(state, "statementLines").filter(({ batchId }) => batchId === original.batchId);
    ctx.equal(batches.length, 1, "one recovered batch"); ctx.equal(lines.length, body.lines.length, "complete recovered line set", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    ctx.ok(stableDelta(before, state).newBatchIds.includes(original.batchId), "recovery adds exactly the committed batch");
    return finalEvidence(ctx, { batchId: original.batchId, recoveredLines: lines.length });
  },
}, ["DURABLE_IDEMPOTENCY", "CONSERVATION_OR_ATOMICITY"]);

function stableDelta(before, after) {
  const beforeBatches = new Set(resource(before, "statementBatches").map(({ batchId }) => batchId));
  return { newBatchIds: resource(after, "statementBatches").map(({ batchId }) => batchId).filter((id) => !beforeBatches.has(id)) };
}

const C03 = guardedCase({
  id: "C-03", fixtureFamily: "RH-F-GROUP-TERMINAL-UNKNOWN-OUTCOME",
  action: "Drop complete Match Group confirm and reverse responses at the public proxy boundary, kill each API and replay after restart.",
  oracle: "Every replay returns the frozen response while all members remain wholly confirmed or wholly released and immutable group identity occurs once.",
  async run(ctx) {
    const fixture = fixtureRecords(ctx.fixtures, "c03", [100, 200, 300]); const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "c03", ...fixture }) });
    let api = await target.startApi(); const group = await createGroup(ctx, api.baseUrl, fixture.statementLines.map(({ statementLineId }) => statementLineId), fixture.ledgerEntries.map(({ ledgerEntryId }) => ledgerEntryId));
    const confirmKey = ctx.key("c03-confirm"); const confirmBody = revisionMaps(fixture.statementLines, fixture.ledgerEntries); let shield = await ctx.responseShield(api.baseUrl); shield.dropNextMutation();
    await assert.rejects(ctx.mutate(shield.baseUrl, `/api/v1/match-groups/${group.group.matchGroupId}/confirm`, confirmKey, confirmBody));
    let capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "dropped group confirm response" }); const confirmedBody = JSON.parse(capture.response.body);
    await ctx.kill(api); api = await target.startApi(); let replay = await ctx.mutate(api.baseUrl, `/api/v1/match-groups/${group.group.matchGroupId}/confirm`, confirmKey, confirmBody);
    ctx.equal([replay.status, replay.json], [capture.response.status, confirmedBody], "group confirm exact replay", { hardCapIds: ["DURABLE_IDEMPOTENCY", "CONSERVATION_OR_ATOMICITY"] });
    const reverseKey = ctx.key("c03-reverse"); shield = await ctx.responseShield(api.baseUrl); shield.dropNextMutation();
    await assert.rejects(ctx.mutate(shield.baseUrl, `/api/v1/match-groups/${group.group.matchGroupId}/reverse`, reverseKey, { reason: "correction" }));
    capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "dropped group reverse response" }); const reversedBody = JSON.parse(capture.response.body);
    await ctx.kill(api); api = await target.startApi(); replay = await ctx.mutate(api.baseUrl, `/api/v1/match-groups/${group.group.matchGroupId}/reverse`, reverseKey, { reason: "correction" });
    ctx.equal([replay.status, replay.json], [capture.response.status, reversedBody], "group reverse exact replay", { hardCapIds: ["DURABLE_IDEMPOTENCY", "CONSERVATION_OR_ATOMICITY"] });
    const state = await ctx.snapshot(api.baseUrl); assertSnapshot(ctx, state); const saved = resource(state, "matchGroups").filter(({ matchGroupId }) => matchGroupId === group.group.matchGroupId);
    ctx.equal(saved.length, 1, "group identity retained once"); ctx.equal(saved[0].state, "REVERSED", "whole group reaches reversed");
    ctx.ok(fixture.statementLines.every(({ statementLineId }) => resource(state, "statementLines").find((item) => item.statementLineId === statementLineId)?.state === "UNMATCHED"), "all lines released together");
    return finalEvidence(ctx, { matchGroupId: group.group.matchGroupId, responseLosses: 2 });
  },
}, ["DURABLE_IDEMPOTENCY", "CONSERVATION_OR_ATOMICITY"]);

const C04 = guardedCase({
  id: "C-04", fixtureFamily: "RH-F-OUTBOX-UNKNOWN-ACK",
  action: "Commit V1 proposal, confirmation and reversal events, hold dispatcher after a receiver response, SIGKILL it and start a replacement.",
  oracle: "Every retry preserves parsed event identity, type and semantic body, aggregate sequences deliver in order and rollback creates no invented event or token leak.",
  async run(ctx) {
    const fixture = fixtureRecords(ctx.fixtures, "c04", [800]); const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "c04", ...fixture }) }); const api = await target.startApi();
    const match = await createMatch(ctx, api.baseUrl, fixture.statementLines[0].statementLineId, fixture.ledgerEntries[0].ledgerEntryId);
    await matchAction(ctx, api.baseUrl, match.match.matchId, "confirm", { expectedLineRevision: 1, expectedLedgerRevision: 1 }); await matchAction(ctx, api.baseUrl, match.match.matchId, "reverse", { reason: "audit correction" });
    const state = await ctx.snapshot(api.baseUrl); const committedIds = new Set(state.events.map(({ eventId }) => eventId)); ctx.ok(committedIds.size >= 3, "committed V1 event history exists");
    const receiver = await ctx.receiver(() => ({ status: 204 })); const barrier = await ctx.barrier({ hold: ({ point }) => point === "dispatcher.response-received" });
    const doomed = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor(({ json }) => json?.point === "dispatcher.response-received", { timeoutMs: 60_000, processes: [doomed] }); await ctx.kill(doomed);
    const first = receiver.ledger.find(({ json }) => json?.eventId === held.json.workId || json?.aggregateId === held.json.aggregateId) ?? receiver.ledger[0]; ctx.ok(first?.json, "receiver persisted a complete event before crash");
    const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => [...committedIds].every((id) => receiver.ledger.some(({ json }) => json?.eventId === id)), { timeoutMs: 60_000, intervalMs: 20, label: "replacement dispatcher delivery", processes: [replacement] });
    const duplicates = receiver.ledger.filter(({ json }) => json?.eventId === first.json.eventId); ctx.ok(duplicates.length >= 2, "unknown acknowledgement retries the same event");
    for (const entry of duplicates) {
      ctx.equal(canonicalJson(entry.json), canonicalJson(first.json), "retry semantic event body");
      ctx.equal(entry.headers["x-reconcilehub-event-id"], first.json.eventId, "retry event identity header");
      ctx.equal(entry.headers["x-reconcilehub-event-type"], first.json.type, "retry event type header");
    }
    const allowed = new Set(["statement-batch.imported", "match.proposed", "match.confirmed", "match.rejected", "match.reversed", "statement-line.ignored"]);
    const delivered = receiver.ledger.filter(({ json }) => committedIds.has(json?.eventId)); ctx.ok(delivered.every(({ json }) => allowed.has(json.type) && canonicalJson(json.payload) === "{}"), "only published empty-payload events are delivered");
    ctx.ok(delivered.every(({ raw }) => !/(?:token|authorization|idempotency|postgres(?:ql)?:\/\/|\/(?:Users|home|tmp)\/)/iu.test(raw)), "delivery omits tokens and private paths");
    const byAggregate = new Map(); for (const { json } of delivered) { const values = byAggregate.get(json.aggregateId) ?? new Map(); values.set(json.eventId, json.sequence); byAggregate.set(json.aggregateId, values); }
    for (const values of byAggregate.values()) { const sequence = [...values.values()]; ctx.equal(sequence, [...sequence].sort((left, right) => left - right), "successful delivery order"); }
    assertSnapshot(ctx, state);
    return finalEvidence(ctx, { matchId: match.match.matchId, committedEvents: committedIds.size, retriedEventId: first.json.eventId });
  },
}, ["STALE_WORK_OR_LOST_WORK"]);

export const C_CASES = Object.freeze([C01, C02, C03, C04]);
