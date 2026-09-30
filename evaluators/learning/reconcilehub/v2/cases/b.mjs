import assert from "node:assert/strict";

import {
  assertMatchGroup, assertNoChange, assertSnapshot, createGroup, createMatch, expectError, finalEvidence,
  guardedCase, groupAction, matchAction, prepare, resource, revisionMaps, seedWithRecords,
} from "./helpers.mjs";

function pairRecords(fixtures, label, amounts) {
  const batchId = fixtures.uuid(`${label}-batch`);
  const statementLines = amounts.map((amountMinor, index) => ({
    statementLineId: fixtures.uuid(`${label}-line-${index}`), batchId, externalId: `${label}-line-${index}`,
    bookedAt: fixtures.date(index), currency: "USD", amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1,
  }));
  const ledgerEntries = amounts.map((amountMinor, index) => ({
    ledgerEntryId: fixtures.uuid(`${label}-entry-${index}`), postedAt: fixtures.date(index), currency: "USD",
    amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1,
  }));
  return { statementLines, ledgerEntries };
}

const B01 = guardedCase({
  id: "B-01", fixtureFamily: "RH-F-BATCH-IDEMPOTENCY-UNKNOWN-RESPONSE",
  action: "Drop a committed public batch response, restart an API, then issue twenty identical concurrent retries and one semantic-key conflict.",
  oracle: "Captured committed status, semantic JSON, stable IDs and complete snapshot constitute replay authority and permit exactly one batch effect.",
  async run(ctx) {
    const fixture = pairRecords(ctx.fixtures, "b01-seed", [901]);
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "b01-seed", ...fixture }) });
    const apis = [await target.startApi(), await target.startApi()];
    const body = { source: "bank-b01", batchKey: "unknown-response", lines: Array.from({ length: 7 }, (_, index) => ({ externalId: `b01-${index}`, bookedAt: ctx.fixtures.date(index), currency: index % 2 ? "EUR" : "USD", amountMinor: 10_000 + index, reference: `B01-${index}` })) };
    const key = ctx.key("batch-unknown-response"); const shield = await ctx.responseShield(apis[0].baseUrl); shield.dropNextMutation();
    await assert.rejects(ctx.mutate(shield.baseUrl, "/api/v1/statement-batches", key, body));
    const capture = await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "dropped committed batch response" });
    ctx.equal(capture.response.status, 202, "captured import status"); const original = JSON.parse(capture.response.body);
    await ctx.stop(apis[0]); const restarted = await target.startApi();
    const retries = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate([apis[1], restarted][index % 2].baseUrl, "/api/v1/statement-batches", key, body)));
    ctx.ok(retries.every(({ status, json }) => status === capture.response.status && JSON.stringify(json) === JSON.stringify(original)), "all concurrent retries replay the exact saved response");
    const beforeConflict = await ctx.snapshot(apis[1].baseUrl);
    expectError(ctx, await ctx.mutate(restarted.baseUrl, "/api/v1/statement-batches", key, { ...body, batchKey: "changed" }), 409, "IDEMPOTENCY_CONFLICT", "semantic replay conflict");
    const state = await ctx.snapshot(apis[1].baseUrl); assertNoChange(ctx, beforeConflict, state, "semantic key conflict", ["DURABLE_IDEMPOTENCY"]); assertSnapshot(ctx, state);
    const batchId = original.batchId; const batch = resource(state, "statementBatches").filter((item) => item.batchId === batchId); const lines = resource(state, "statementLines").filter((item) => item.batchId === batchId);
    ctx.equal(batch.length, 1, "one durable Statement Batch", { hardCapIds: ["DURABLE_IDEMPOTENCY"] }); ctx.equal(lines.length, body.lines.length, "one complete line effect", { hardCapIds: ["DURABLE_IDEMPOTENCY"] });
    return finalEvidence(ctx, { batchId, replayCount: retries.length, lineCount: lines.length });
  },
}, ["DURABLE_IDEMPOTENCY"]);

const B02 = guardedCase({
  id: "B-02", fixtureFamily: "RH-F-CONCURRENT-ONE-TO-ONE-OWNERSHIP",
  action: "Create two proposals sharing one Statement Line and concurrently confirm them through two API processes with exact member revisions.",
  oracle: "Database-wide ownership permits exactly one atomic winner, one published conflict and at most one active owner on either side.",
  async run(ctx) {
    const fixture = pairRecords(ctx.fixtures, "b02", [500, 500]);
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "b02", ...fixture }) }); const apis = [await target.startApi(), await target.startApi()];
    const first = await createMatch(ctx, apis[0].baseUrl, fixture.statementLines[0].statementLineId, fixture.ledgerEntries[0].ledgerEntryId);
    const second = await createMatch(ctx, apis[1].baseUrl, fixture.statementLines[0].statementLineId, fixture.ledgerEntries[1].ledgerEntryId);
    const responses = await Promise.all([
      matchAction(ctx, apis[0].baseUrl, first.match.matchId, "confirm", { expectedLineRevision: 1, expectedLedgerRevision: 1 }, { allowFailure: true, key: ctx.key("confirm-first") }),
      matchAction(ctx, apis[1].baseUrl, second.match.matchId, "confirm", { expectedLineRevision: 1, expectedLedgerRevision: 1 }, { allowFailure: true, key: ctx.key("confirm-second") }),
    ]);
    ctx.equal(responses.map(({ status }) => status).sort((left, right) => left - right), [200, 409], "one confirm and one conflict", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    expectError(ctx, responses.find(({ status }) => status === 409), 409, "MATCH_CONFLICT", "losing confirmation");
    const state = await ctx.snapshot(apis[0].baseUrl); assertSnapshot(ctx, state);
    const relevant = resource(state, "matches").filter(({ matchId, state: status }) => [first.match.matchId, second.match.matchId].includes(matchId) && status === "CONFIRMED");
    ctx.equal(relevant.length, 1, "shared Statement Line has one active Match", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    return finalEvidence(ctx, { winner: relevant[0].matchId, attempted: responses.length, activeCount: relevant.length });
  },
}, ["CONSERVATION_OR_ATOMICITY"]);

const B03 = guardedCase({
  id: "B-03", fixtureFamily: "RH-F-CONCURRENT-REVIEW-ACTION-LEDGER",
  action: "Race confirm, reject and ignore against one proposal across two APIs, then race repeated reversal when confirmation is the legal winner.",
  oracle: "Committed events and resource revisions admit one legal serial history only, with no state regression, lost action or duplicate member release.",
  async run(ctx) {
    const fixture = pairRecords(ctx.fixtures, "b03", [777]);
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "b03", ...fixture }) }); const apis = [await target.startApi(), await target.startApi()];
    const proposal = await createMatch(ctx, apis[0].baseUrl, fixture.statementLines[0].statementLineId, fixture.ledgerEntries[0].ledgerEntryId);
    const firstWave = await Promise.all(Array.from({ length: 20 }, (_, index) => {
      if (index % 3 === 0) return matchAction(ctx, apis[index % 2].baseUrl, proposal.match.matchId, "confirm", { expectedLineRevision: 1, expectedLedgerRevision: 1 }, { allowFailure: true, key: ctx.key(`race-confirm-${index}`) });
      if (index % 3 === 1) return matchAction(ctx, apis[index % 2].baseUrl, proposal.match.matchId, "reject", { reason: `review-${index}` }, { allowFailure: true, key: ctx.key(`race-reject-${index}`) });
      return ctx.mutate(apis[index % 2].baseUrl, `/api/v1/statement-lines/${fixture.statementLines[0].statementLineId}/ignore`, ctx.key(`race-ignore-${index}`), { expectedRevision: 1, reason: `ignore-${index}` });
    }));
    ctx.ok(firstWave.some(({ status }) => status === 200), "one review mutation commits"); ctx.ok(firstWave.every(({ status }) => status === 200 || status === 409), "all losers are semantic conflicts");
    let state = await ctx.snapshot(apis[0].baseUrl); const current = resource(state, "matches").find(({ matchId }) => matchId === proposal.match.matchId);
    if (current.state === "CONFIRMED") {
      const reversals = await Promise.all(Array.from({ length: 12 }, (_, index) => matchAction(ctx, apis[index % 2].baseUrl, current.matchId, "reverse", { reason: "correction" }, { allowFailure: true, key: ctx.key(`reverse-race-${index}`) })));
      ctx.equal(reversals.filter(({ status }) => status === 200).length, 1, "one reversal commits"); state = await ctx.snapshot(apis[1].baseUrl);
    }
    assertSnapshot(ctx, state); const finalMatch = resource(state, "matches").find(({ matchId }) => matchId === proposal.match.matchId);
    ctx.ok(["REJECTED", "REVERSED", "PROPOSED"].includes(finalMatch.state), "projection is a legal terminal or untouched state");
    const sequences = state.events.filter(({ aggregateId }) => aggregateId === proposal.match.matchId).map(({ sequence }) => sequence);
    ctx.equal(sequences, [...sequences].sort((left, right) => left - right), "aggregate event history is ordered");
    return finalEvidence(ctx, { matchId: proposal.match.matchId, finalState: finalMatch.state, attempts: firstWave.length });
  },
}, ["CONSERVATION_OR_ATOMICITY"]);

const B04 = guardedCase({
  id: "B-04", fixtureFamily: "RH-F-CROSS-CARDINALITY-MEMBER-RACE",
  action: "Create a legacy proposal and balanced Match Group sharing a Statement Line, then confirm both concurrently through separate APIs.",
  oracle: "The shared member is one database ownership boundary: one complete aggregate wins and the loser creates no partial reservation or cross-currency state.",
  async run(ctx) {
    const batchId = ctx.fixtures.uuid("b04-batch");
    const statementLines = [60, 40].map((amountMinor, index) => ({ statementLineId: ctx.fixtures.uuid(`b04-line-${index}`), batchId, externalId: `b04-${index}`, bookedAt: ctx.fixtures.date(index), currency: "USD", amountMinor, reference: `B04-L${index}`, state: "UNMATCHED", revision: 1 }));
    const ledgerEntries = [
      { ledgerEntryId: ctx.fixtures.uuid("b04-legacy"), postedAt: ctx.fixtures.date(0), currency: "USD", amountMinor: 60, reference: "B04-LEGACY", state: "UNMATCHED", revision: 1 },
      ...[50, 50].map((amountMinor, index) => ({ ledgerEntryId: ctx.fixtures.uuid(`b04-group-${index}`), postedAt: ctx.fixtures.date(index), currency: "USD", amountMinor, reference: `B04-G${index}`, state: "UNMATCHED", revision: 1 })),
    ];
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "b04", statementLines, ledgerEntries }) }); const apis = [await target.startApi(), await target.startApi()];
    const legacy = await createMatch(ctx, apis[0].baseUrl, statementLines[0].statementLineId, ledgerEntries[0].ledgerEntryId);
    const group = await createGroup(ctx, apis[1].baseUrl, statementLines.map(({ statementLineId }) => statementLineId), ledgerEntries.slice(1).map(({ ledgerEntryId }) => ledgerEntryId));
    const responses = await Promise.all([
      matchAction(ctx, apis[0].baseUrl, legacy.match.matchId, "confirm", { expectedLineRevision: 1, expectedLedgerRevision: 1 }, { allowFailure: true }),
      groupAction(ctx, apis[1].baseUrl, group.group.matchGroupId, "confirm", revisionMaps(statementLines, ledgerEntries.slice(1)), { allowFailure: true }),
    ]);
    ctx.equal(responses.filter(({ status }) => status === 200).length, 1, "one cross-cardinality owner wins", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    const loser = responses.find(({ status }) => status !== 200); ctx.equal(loser.status, 409, "loser conflicts");
    const state = await ctx.snapshot(apis[0].baseUrl); assertSnapshot(ctx, state);
    const owners = resource(state, "matchGroups").filter(({ state: status, statementLineIds }) => status === "CONFIRMED" && statementLineIds.includes(statementLines[0].statementLineId));
    ctx.equal(owners.length, 1, "shared member has one active group", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    return finalEvidence(ctx, { legacyMatchId: legacy.match.matchId, groupId: group.group.matchGroupId, winnerId: owners[0].matchGroupId });
  },
}, ["CONSERVATION_OR_ATOMICITY"]);

const B05 = guardedCase({
  id: "B-05", fixtureFamily: "RH-F-TWENTY-BY-TWENTY-GROUP-CORRECTION",
  action: "Create the 20-by-20 boundary Match Group, concurrently replay complete confirmation, then concurrently replay one full reversal.",
  oracle: "Every member changes or releases in one transaction, integer sums remain equal, one immutable group survives and retries never duplicate correction effects.",
  async run(ctx) {
    const amounts = Array.from({ length: 20 }, (_, index) => index + 1); const fixture = pairRecords(ctx.fixtures, "b05", amounts);
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "b05", ...fixture }) }); const apis = [await target.startApi(), await target.startApi()];
    const group = await createGroup(ctx, apis[0].baseUrl, fixture.statementLines.map(({ statementLineId }) => statementLineId), fixture.ledgerEntries.map(({ ledgerEntryId }) => ledgerEntryId)); assertMatchGroup(group.group);
    const confirmKey = ctx.key("confirm-boundary-group"); const confirmBody = revisionMaps(fixture.statementLines, fixture.ledgerEntries);
    const confirmed = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(apis[index % 2].baseUrl, `/api/v1/match-groups/${group.group.matchGroupId}/confirm`, confirmKey, confirmBody)));
    ctx.ok(confirmed.every(({ status, json }) => status === 200 && JSON.stringify(json) === JSON.stringify(confirmed[0].json)), "confirm retries converge on one response", { hardCapIds: ["DURABLE_IDEMPOTENCY", "CONSERVATION_OR_ATOMICITY"] });
    const reverseKey = ctx.key("reverse-boundary-group"); const reversed = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.mutate(apis[index % 2].baseUrl, `/api/v1/match-groups/${group.group.matchGroupId}/reverse`, reverseKey, { reason: "complete correction" })));
    ctx.ok(reversed.every(({ status, json }) => status === 200 && JSON.stringify(json) === JSON.stringify(reversed[0].json)), "reverse retries converge on one response", { hardCapIds: ["DURABLE_IDEMPOTENCY", "CONSERVATION_OR_ATOMICITY"] });
    const state = await ctx.snapshot(apis[0].baseUrl); assertSnapshot(ctx, state); const saved = resource(state, "matchGroups").filter(({ matchGroupId }) => matchGroupId === group.group.matchGroupId);
    ctx.equal(saved.length, 1, "one immutable Match Group record"); ctx.equal(saved[0].state, "REVERSED", "complete group reversed");
    ctx.ok(fixture.statementLines.every(({ statementLineId }) => resource(state, "statementLines").find((item) => item.statementLineId === statementLineId)?.state === "UNMATCHED"), "all Statement Lines released");
    ctx.ok(fixture.ledgerEntries.every(({ ledgerEntryId }) => resource(state, "ledgerEntries").find((item) => item.ledgerEntryId === ledgerEntryId)?.state === "UNMATCHED"), "all Ledger Entries released");
    return finalEvidence(ctx, { matchGroupId: group.group.matchGroupId, members: 40, confirmReplays: confirmed.length, reverseReplays: reversed.length });
  },
}, ["CONSERVATION_OR_ATOMICITY", "DURABLE_IDEMPOTENCY"]);

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05]);
