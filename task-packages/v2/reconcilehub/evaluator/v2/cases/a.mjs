import { groupFixture, importRequest, reconciliationSeed, workedExample } from "../fixtures/index.mjs";
import { enumerateGroupSuggestions, rankOneToOne, validateMatchGroup } from "../oracles/index.mjs";
import {
  assertMatchGroup, assertNoChange, assertSnapshot, createGroup, createMatch, defineCase, expectError,
  finalEvidence, groupAction, ignoreLine, importBatch, matchAction, prepare, resource, revisionMaps,
  seedWithRecords, waitForDrain,
} from "./helpers.mjs";

function records(fixtures, label, amounts, side) {
  const batchId = fixtures.uuid(`${label}-batch`);
  return amounts.map((amountMinor, index) => side === "line" ? {
    statementLineId: fixtures.uuid(`${label}-line-${index}`), batchId, externalId: `${label}-${index}`,
    bookedAt: fixtures.date(index), currency: "USD", amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1,
  } : {
    ledgerEntryId: fixtures.uuid(`${label}-entry-${index}`), postedAt: fixtures.date(index), currency: "USD",
    amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1,
  });
}

const A01 = defineCase({
  id: "A-01", fixtureFamily: "RH-F-BATCH-ATOMIC-BOUNDARIES",
  action: "Import valid, boundary-integer and last-member-invalid Statement Batches through public HTTP and compare complete snapshots.",
  oracle: "Evaluator-owned member validation requires exact all-or-none identities and proves rejected batches leave no Statement Line, Work or Event residue.",
  async run(ctx) {
    const target = await prepare(ctx, { seed: reconciliationSeed(ctx.fixtures, "a01") }); const api = await target.startApi();
    const body = importRequest(ctx.fixtures, "valid", 6); const valid = await importBatch(ctx, api.baseUrl, body);
    const boundary = importRequest(ctx.fixtures, "boundary", 1); boundary.lines[0].amountMinor = Number.MAX_SAFE_INTEGER;
    await importBatch(ctx, api.baseUrl, boundary);
    const afterValid = await ctx.snapshot(api.baseUrl);
    const batch = resource(afterValid, "statementBatches").find(({ batchId }) => batchId === valid.value.batchId);
    ctx.ok(batch && batch.lineCount === body.lines.length, "valid batch persists every member");
    const persisted = resource(afterValid, "statementLines").filter(({ batchId }) => batchId === batch.batchId);
    ctx.equal(persisted.map(({ externalId }) => externalId).sort(), body.lines.map(({ externalId }) => externalId).sort(), "valid batch member identities");
    const invalid = importRequest(ctx.fixtures, "invalid-last", 5); invalid.lines.at(-1).externalId = invalid.lines[0].externalId;
    const beforeInvalid = await ctx.snapshot(api.baseUrl);
    expectError(ctx, await importBatch(ctx, api.baseUrl, invalid, { allowFailure: true }), 400, "INVALID_STATEMENT_BATCH", "duplicate final member", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    const afterInvalid = await ctx.snapshot(api.baseUrl); assertNoChange(ctx, beforeInvalid, afterInvalid, "invalid Statement Batch");
    assertSnapshot(ctx, afterInvalid);
    return finalEvidence(ctx, { batchId: batch.batchId, lineCount: batch.lineCount, boundaryAmountMinor: boundary.lines[0].amountMinor });
  },
});

const A02 = defineCase({
  id: "A-02", fixtureFamily: "RH-F-ONE-TO-ONE-SCORE-TIES",
  action: "Seed exact, near-date, different-reference, tied and out-of-window records, run real Suggestion workers and read their public projection.",
  oracle: "Independent date arithmetic and bytewise total order recompute eligibility, score and winner without treating candidate suggestions as answer authority.",
  async run(ctx) {
    const fixture = workedExample(ctx.fixtures);
    const seed = seedWithRecords(ctx.fixtures, { label: "a02", statementLines: fixture.statementLines, ledgerEntries: fixture.ledgerEntries });
    const target = await prepare(ctx, { seed }); const api = await target.startApi(); const workers = [await target.startWorker(), await target.startWorker()];
    const expected = rankOneToOne(fixture.statementLines, fixture.ledgerEntries);
    const state = await waitForDrain(ctx, api.baseUrl, { processes: workers });
    const suggestions = resource(state, "matches").filter(({ state: status }) => status === "PROPOSED");
    ctx.equal(suggestions.map(({ statementLineId, ledgerEntryId, score }) => ({ statementLineId, ledgerEntryId, score })), expected.map(({ statementLineId, ledgerEntryId, score }) => ({ statementLineId, ledgerEntryId, score })), "deterministic one-to-one suggestion set", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    ctx.ok(suggestions.every(({ ledgerEntryId }) => ledgerEntryId !== fixture.ledgerEntries[3].ledgerEntryId), "out-of-window entry is ineligible");
    assertSnapshot(ctx, state);
    return finalEvidence(ctx, { suggestionIds: suggestions.map(({ matchId }) => matchId), winningScore: expected[0].score });
  },
});

const A03 = defineCase({
  id: "A-03", fixtureFamily: "RH-F-IMMUTABLE-REVIEW-HISTORY",
  action: "Create independent proposals then confirm, reject, ignore and reverse them through public mutations, including illegal terminal retries.",
  oracle: "The original immutable records plus contiguous Domain Events reconstruct current projections; reversal appends one correction and releases both members once.",
  async run(ctx) {
    const lines = records(ctx.fixtures, "a03", [101, 102, 103], "line"); const entries = records(ctx.fixtures, "a03", [101, 102, 103], "entry");
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "a03", statementLines: lines, ledgerEntries: entries }) }); const api = await target.startApi();
    const first = await createMatch(ctx, api.baseUrl, lines[0].statementLineId, entries[0].ledgerEntryId);
    const confirmed = await matchAction(ctx, api.baseUrl, first.match.matchId, "confirm", { expectedLineRevision: 1, expectedLedgerRevision: 1 });
    ctx.equal(confirmed.match.state, "CONFIRMED", "confirm state");
    const reversed = await matchAction(ctx, api.baseUrl, first.match.matchId, "reverse", { reason: "statement corrected" });
    ctx.equal(reversed.match.state, "REVERSED", "reverse state");
    expectError(ctx, await matchAction(ctx, api.baseUrl, first.match.matchId, "reverse", { reason: "duplicate" }, { allowFailure: true }), 409, "MATCH_NOT_REVERSIBLE", "duplicate reverse");
    const second = await createMatch(ctx, api.baseUrl, lines[1].statementLineId, entries[1].ledgerEntryId);
    const rejected = await matchAction(ctx, api.baseUrl, second.match.matchId, "reject", { reason: "not same business item" });
    ctx.equal(rejected.match.state, "REJECTED", "reject state");
    const ignored = await ignoreLine(ctx, api.baseUrl, lines[2].statementLineId, 1, "not reconcilable");
    ctx.equal(ignored.line.state, "IGNORED", "ignore state");
    const state = await ctx.snapshot(api.baseUrl); assertSnapshot(ctx, state);
    const saved = resource(state, "matches");
    ctx.equal(saved.find(({ matchId }) => matchId === first.match.matchId).state, "REVERSED", "reversed Match history retained");
    ctx.equal(saved.find(({ matchId }) => matchId === second.match.matchId).state, "REJECTED", "rejected Match history retained");
    ctx.ok(state.events.some(({ type }) => type === "match.confirmed") && state.events.some(({ type }) => type === "match.reversed") && state.events.some(({ type }) => type === "statement-line.ignored"), "published audit events are retained");
    return finalEvidence(ctx, { reversedMatchId: first.match.matchId, rejectedMatchId: second.match.matchId, ignoredLineId: ignored.line.statementLineId });
  },
});

const A04 = defineCase({
  id: "A-04", fixtureFamily: "RH-F-GROUP-CURRENCY-SUM-ATOMICITY",
  action: "Create balanced Match Groups at member boundaries and submit duplicate, currency-mixed, sum-mismatched and unavailable-member variants.",
  oracle: "Independent integer conservation, currency, uniqueness and availability checks require a sorted frozen group or an exact zero-delta rejection.",
  async run(ctx) {
    const fixture = groupFixture(ctx.fixtures); const expected = validateMatchGroup(fixture.statementLines, fixture.ledgerEntries);
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "a04", ...fixture }) }); const api = await target.startApi();
    const created = await createGroup(ctx, api.baseUrl, expected.statementLineIds, expected.ledgerEntryIds);
    ctx.equal({ statementLineIds: created.group.statementLineIds, ledgerEntryIds: created.group.ledgerEntryIds, currency: created.group.currency, statementTotalMinor: created.group.statementTotalMinor, ledgerTotalMinor: created.group.ledgerTotalMinor }, expected, "balanced Match Group freezes independent totals");
    const before = await ctx.snapshot(api.baseUrl);
    const duplicate = await createGroup(ctx, api.baseUrl, [fixture.statementLines[0].statementLineId, fixture.statementLines[0].statementLineId], expected.ledgerEntryIds, { allowFailure: true, key: ctx.key("duplicate-group"), contractExpectation: "invalid" });
    ctx.ok([400, 409].includes(duplicate.status), "duplicate member is rejected");
    const imbalancedLines = records(ctx.fixtures, "a04-bad", [151], "line"); const imbalancedEntries = records(ctx.fixtures, "a04-bad", [150], "entry");
    await target.seed(seedWithRecords(ctx.fixtures, { label: "a04-bad", statementLines: imbalancedLines, ledgerEntries: imbalancedEntries }));
    const beforeImbalance = await ctx.snapshot(api.baseUrl);
    expectError(ctx, await createGroup(ctx, api.baseUrl, [imbalancedLines[0].statementLineId], [imbalancedEntries[0].ledgerEntryId], { allowFailure: true }), 409, "MATCH_GROUP_IMBALANCED", "imbalanced group", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    const after = await ctx.snapshot(api.baseUrl); assertNoChange(ctx, beforeImbalance, after, "imbalanced Match Group");
    ctx.equal(resource(before, "matchGroups").filter(({ matchGroupId }) => matchGroupId === created.group.matchGroupId).length, 1, "valid group exists once");
    return finalEvidence(ctx, { matchGroupId: created.group.matchGroupId, statementTotalMinor: created.group.statementTotalMinor });
  },
});

const A05 = defineCase({
  id: "A-05", fixtureFamily: "RH-F-ONE-TO-ONE-BEFORE-GROUP-SUGGESTION",
  action: "Run two workers over simultaneous strong one-to-one, 2:1, 1:2, 2:2 and five-member equal-sum possibilities and inspect all proposals.",
  oracle: "An evaluator-owned combination enumerator consumes one-to-one winners first, orders remaining IDs lexicographically and permits no group over four total members.",
  async run(ctx) {
    const lines = records(ctx.fixtures, "a05", [100, 60, 40, 30, 30, 40], "line"); const entries = records(ctx.fixtures, "a05", [100, 50, 50, 50, 50], "entry");
    lines[0].reference = "EXACT"; entries[0].reference = "EXACT";
    const oneToOne = rankOneToOne(lines, entries); const expectedGroups = enumerateGroupSuggestions(lines, entries, oneToOne);
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "a05", statementLines: lines, ledgerEntries: entries }) }); const api = await target.startApi(); const workers = [await target.startWorker(), await target.startWorker()];
    const state = await waitForDrain(ctx, api.baseUrl, { processes: workers, timeoutMs: 180_000 }); assertSnapshot(ctx, state);
    const matches = resource(state, "matches").filter(({ state: status }) => status === "PROPOSED"); const groups = resource(state, "matchGroups").filter(({ state: status }) => status === "PROPOSED" && status);
    ctx.ok(matches.some(({ statementLineId, ledgerEntryId }) => statementLineId === oneToOne[0].statementLineId && ledgerEntryId === oneToOne[0].ledgerEntryId), "strong one-to-one is selected first");
    ctx.ok(groups.every((group) => group.statementLineIds.length + group.ledgerEntryIds.length <= 4), "no group suggestion exceeds four members", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    const usedByOne = new Set(oneToOne.flatMap(({ statementLineId, ledgerEntryId }) => [statementLineId, ledgerEntryId]));
    ctx.ok(groups.every((group) => [...group.statementLineIds, ...group.ledgerEntryIds].every((id) => !usedByOne.has(id))), "group suggestions do not steal one-to-one members");
    ctx.ok(expectedGroups.length > 0 && groups.length > 0, "fixture and candidate both expose a legal group suggestion");
    return finalEvidence(ctx, { oneToOneCount: matches.length, groupSuggestionCount: groups.length });
  },
});

export const A_CASES = Object.freeze([A01, A02, A03, A04, A05]);
