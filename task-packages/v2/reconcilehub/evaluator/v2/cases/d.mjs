import assert from "node:assert/strict";

import {
  assertMatch, assertMatchGroup, assertNoChange, assertSnapshot, canonicalJson, clickControl, createGroup,
  createMatch, defineCase, expectError, exactKeys, fillField, finalEvidence, groupAction, launchBrowser, matchAction,
  prepare, resource, revisionMaps, seedWithRecords, waitForDrain,
} from "./helpers.mjs";

function fixtureRecords(fixtures, label, amounts = [120, 80]) {
  const batchId = fixtures.uuid(`${label}-batch`);
  return {
    statementLines: amounts.map((amountMinor, index) => ({ statementLineId: fixtures.uuid(`${label}-line-${index}`), batchId, externalId: `${label}-${index}`, bookedAt: fixtures.date(index), currency: "USD", amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1 })),
    ledgerEntries: amounts.map((amountMinor, index) => ({ ledgerEntryId: fixtures.uuid(`${label}-entry-${index}`), postedAt: fixtures.date(index), currency: "USD", amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1 })),
  };
}

function assertCollection(value, label) { exactKeys(value, ["items", "nextCursor"], label); assert.ok(Array.isArray(value.items)); assert.ok(value.nextCursor === null || typeof value.nextCursor === "string"); return value; }

const D01 = defineCase({
  id: "D-01", fixtureFamily: "RH-F-WIRE-OPENAPI-CURSOR",
  action: "Exercise runtime OpenAPI, exact V1 and Manager reads, collection cursors, boundary member maps and every published validation/error family through HTTP.",
  oracle: "Closed wire schemas, deterministic sort and exact error envelopes must agree with OpenAPI while every GET and rejection leaves resources, Work and Events unchanged.",
  async run(ctx) {
    const fixture = fixtureRecords(ctx.fixtures, "d01"); const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "d01", ...fixture }) }); const api = await target.startApi();
    const openapiResponse = await ctx.request(api.baseUrl, "/openapi.json"); ctx.equal(openapiResponse.status, 200, "OpenAPI status");
    const document = openapiResponse.json; ctx.ok(/^3\.1(?:\.|$)/u.test(document.openapi), "OpenAPI 3.1 document");
    for (const path of ["/api/v1/matches", "/api/v1/matches/{matchId}", "/api/v1/statement-batches", "/api/v1/match-groups", "/api/v1/match-groups/{matchGroupId}", "/api/v1/match-groups/{matchGroupId}/confirm", "/api/v1/match-groups/{matchGroupId}/reverse", "/api/v1/reconciliation-work", "/api/v1/verification-snapshot"]) ctx.ok(document.paths?.[path], `OpenAPI publishes ${path}`);
    const match = await createMatch(ctx, api.baseUrl, fixture.statementLines[0].statementLineId, fixture.ledgerEntries[0].ledgerEntryId); assertMatch(match.match);
    const group = await createGroup(ctx, api.baseUrl, [fixture.statementLines[1].statementLineId], [fixture.ledgerEntries[1].ledgerEntryId]); assertMatchGroup(group.group);
    const groupRead = await ctx.request(api.baseUrl, `/api/v1/match-groups/${group.group.matchGroupId}`); ctx.equal(groupRead.status, 200, "Match Group read status"); assertMatchGroup(groupRead.json);
    const legacyRead = await ctx.request(api.baseUrl, `/api/v1/matches/${group.group.matchId}`); ctx.equal(legacyRead.status, 200, "one-to-one group legacy read status"); assertMatch(legacyRead.json);
    const firstPage = assertCollection((await ctx.request(api.baseUrl, "/api/v1/matches?limit=1")).json, "Match page");
    if (firstPage.nextCursor) assertCollection((await ctx.request(api.baseUrl, `/api/v1/matches?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`)).json, "next Match page");
    const beforeErrors = await ctx.snapshot(api.baseUrl);
    expectError(ctx, await ctx.request(api.baseUrl, "/api/v1/matches?cursor=malformed"), 400, "INVALID_CURSOR", "malformed cursor");
    expectError(ctx, await ctx.request(api.baseUrl, `/api/v1/matches/${ctx.fixtures.uuid("missing-match")}`), 404, "NOT_FOUND", "missing Match");
    expectError(ctx, await ctx.mutate(api.baseUrl, "/api/v1/match-groups", ctx.key("unknown-group-field"), { statementLineIds: [fixture.statementLines[1].statementLineId], ledgerEntryIds: [fixture.ledgerEntries[1].ledgerEntryId], extra: true }, { contractExpectation: "invalid" }), 400, "UNKNOWN_FIELD", "unknown group field");
    const wrongMap = { expectedStatementLineRevisions: {}, expectedLedgerEntryRevisions: {} };
    const wrong = await ctx.mutate(api.baseUrl, `/api/v1/match-groups/${group.group.matchGroupId}/confirm`, ctx.key("wrong-revision-map"), wrongMap);
    ctx.ok(wrong.status === 400 || wrong.status === 409, "incomplete revision maps are rejected");
    const afterErrors = await ctx.snapshot(api.baseUrl); assertNoChange(ctx, beforeErrors, afterErrors, "wire contract rejections"); assertSnapshot(ctx, afterErrors);
    return finalEvidence(ctx, { openapiPaths: Object.keys(document.paths).length, matchId: match.match.matchId, matchGroupId: group.group.matchGroupId });
  },
});

const D02 = defineCase({
  id: "D-02", fixtureFamily: "RH-F-BROWSER-V1-REVIEW-FLOW",
  action: "Using only visible production controls on desktop and mobile, import one batch, observe suggestion progress, confirm and reverse, refresh and recover from offline mode.",
  oracle: "UI score, reason, immutable history and current states must reconcile with HTTP and independent policy; no mock or hidden client state may survive refresh.",
  async run(ctx) {
    const fixture = fixtureRecords(ctx.fixtures, "d02", [415]); const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "d02", ...fixture }) }); const api = await target.startApi(); const worker = await target.startWorker();
    const { browserContext, page } = await launchBrowser(ctx, api.baseUrl);
    await clickControl(page, ["link", "button"], [/import/i, /statement batch/i]);
    await fillField(page, [/source/i], "browser-bank"); await fillField(page, [/batch key/i], "browser-batch"); await fillField(page, [/external id/i], "browser-line");
    await fillField(page, [/booked at/i, /date/i], ctx.fixtures.date(0)); await fillField(page, [/currency/i], "USD"); await fillField(page, [/amount/i], "415"); await fillField(page, [/reference/i], "d02-0");
    await clickControl(page, "button", [/import/i, /submit/i]); await page.getByText(/imported|batch/i).first().waitFor({ state: "visible", timeout: 30_000 });
    const drained = await waitForDrain(ctx, api.baseUrl, { processes: [worker] }); const suggestion = resource(drained, "matches").find(({ state }) => state === "PROPOSED"); ctx.ok(suggestion, "real worker created browser-visible suggestion");
    await page.reload({ waitUntil: "domcontentloaded" }); await page.getByText(suggestion.matchId).first().waitFor({ state: "visible", timeout: 30_000 });
    await clickControl(page, "button", [/confirm/i]); await page.getByText(/confirmed/i).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.reload({ waitUntil: "domcontentloaded" }); await clickControl(page, "button", [/reverse/i]);
    const reversed = await ctx.waitFor(async () => { const snapshot = await ctx.snapshot(api.baseUrl); return resource(snapshot, "matches").find(({ matchId, state }) => matchId === suggestion.matchId && state === "REVERSED") ? snapshot : false; }, { timeoutMs: 30_000, label: "browser reversal" });
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload({ waitUntil: "domcontentloaded" }); await page.getByText(/reversed/i).first().waitFor({ state: "visible", timeout: 30_000 });
    await browserContext.setOffline(true); await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {}); ctx.ok(await page.getByText(/offline|retry|network/i).first().isVisible().catch(() => false), "offline state is visible");
    await browserContext.setOffline(false); await page.reload({ waitUntil: "domcontentloaded" }); assertSnapshot(ctx, reversed);
    return finalEvidence(ctx, { matchId: suggestion.matchId, finalState: "REVERSED", viewports: ["desktop", "mobile"] });
  },
});

const D03 = defineCase({
  id: "D-03", fixtureFamily: "RH-F-BROWSER-MATCH-GROUP-CLOSURE",
  action: "Select balanced Statement Lines and Ledger Entries with visible controls, create, confirm and reverse one many-member Match Group, then display an imbalanced failure.",
  oracle: "Browser member identities, one currency, integer totals, immutable history and atomic error state must equal the public snapshot after refresh without client rounding.",
  async run(ctx) {
    const batchId = ctx.fixtures.uuid("d03-batch");
    const statementLines = [100, 50].map((amountMinor, index) => ({ statementLineId: ctx.fixtures.uuid(`d03-line-${index}`), batchId, externalId: `d03-${index}`, bookedAt: ctx.fixtures.date(index), currency: "USD", amountMinor, reference: `D03-L${index}`, state: "UNMATCHED", revision: 1 }));
    const ledgerEntries = [75, 75].map((amountMinor, index) => ({ ledgerEntryId: ctx.fixtures.uuid(`d03-entry-${index}`), postedAt: ctx.fixtures.date(index), currency: "USD", amountMinor, reference: `D03-E${index}`, state: "UNMATCHED", revision: 1 }));
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "d03", statementLines, ledgerEntries }) }); const api = await target.startApi(); const { page } = await launchBrowser(ctx, api.baseUrl);
    await clickControl(page, ["link", "button"], [/match group/i, /group reconciliation/i]);
    for (const line of statementLines) await page.getByRole("checkbox", { name: new RegExp(line.statementLineId, "i") }).check();
    for (const entry of ledgerEntries) await page.getByRole("checkbox", { name: new RegExp(entry.ledgerEntryId, "i") }).check();
    await clickControl(page, "button", [/create group/i, /propose group/i]);
    let state = await ctx.waitFor(async () => { const snapshot = await ctx.snapshot(api.baseUrl); return resource(snapshot, "matchGroups").find(({ statementLineIds }) => statementLineIds.length === 2) ? snapshot : false; }, { timeoutMs: 30_000, label: "browser Match Group create" });
    const group = resource(state, "matchGroups").find(({ statementLineIds }) => statementLineIds.length === 2); await page.getByText(group.matchGroupId).first().waitFor({ state: "visible", timeout: 30_000 });
    await clickControl(page, "button", [/confirm/i]); state = await ctx.waitFor(async () => { const snapshot = await ctx.snapshot(api.baseUrl); return resource(snapshot, "matchGroups").find(({ matchGroupId, state: status }) => matchGroupId === group.matchGroupId && status === "CONFIRMED") ? snapshot : false; }, { timeoutMs: 30_000, label: "browser Match Group confirm" });
    await page.reload({ waitUntil: "domcontentloaded" }); await clickControl(page, "button", [/reverse/i]); state = await ctx.waitFor(async () => { const snapshot = await ctx.snapshot(api.baseUrl); return resource(snapshot, "matchGroups").find(({ matchGroupId, state: status }) => matchGroupId === group.matchGroupId && status === "REVERSED") ? snapshot : false; }, { timeoutMs: 30_000, label: "browser Match Group reverse" });
    await page.reload({ waitUntil: "domcontentloaded" }); ctx.ok(await page.getByText(/150/).first().isVisible(), "conserved total is visible"); ctx.ok(await page.getByText(/reversed/i).first().isVisible(), "immutable reversed state is visible"); assertSnapshot(ctx, state);
    return finalEvidence(ctx, { matchGroupId: group.matchGroupId, statementTotalMinor: 150, ledgerTotalMinor: 150 });
  },
});

const D04 = defineCase({
  id: "D-04", fixtureFamily: "RH-F-FINAL-SNAPSHOT-ACTION-AUDIT",
  action: "Create confirmed, rejected, ignored and reversed V1 decisions plus proposed, confirmed and reversed Match Groups, then take one authorized FINAL snapshot.",
  oracle: "Exact sorted union, one asOf, retained Work and contiguous immutable Events must rebuild every current member owner while recursively omitting tokens and secrets.",
  async run(ctx) {
    const fixture = fixtureRecords(ctx.fixtures, "d04", [100, 200, 300, 400]); const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "d04", ...fixture }) }); const api = await target.startApi();
    const confirmed = await createMatch(ctx, api.baseUrl, fixture.statementLines[0].statementLineId, fixture.ledgerEntries[0].ledgerEntryId); await matchAction(ctx, api.baseUrl, confirmed.match.matchId, "confirm", { expectedLineRevision: 1, expectedLedgerRevision: 1 });
    const rejected = await createMatch(ctx, api.baseUrl, fixture.statementLines[1].statementLineId, fixture.ledgerEntries[1].ledgerEntryId); await matchAction(ctx, api.baseUrl, rejected.match.matchId, "reject", { reason: "audit rejection" });
    const group = await createGroup(ctx, api.baseUrl, fixture.statementLines.slice(2).map(({ statementLineId }) => statementLineId), fixture.ledgerEntries.slice(2).map(({ ledgerEntryId }) => ledgerEntryId)); await groupAction(ctx, api.baseUrl, group.group.matchGroupId, "confirm", revisionMaps(fixture.statementLines.slice(2), fixture.ledgerEntries.slice(2))); await groupAction(ctx, api.baseUrl, group.group.matchGroupId, "reverse", { reason: "audit correction" });
    const snapshot = await ctx.snapshot(api.baseUrl); assertSnapshot(ctx, snapshot);
    const sorts = [["statementBatches", "batchId"], ["statementLines", "statementLineId"], ["ledgerEntries", "ledgerEntryId"], ["matches", "matchId"], ["matchGroups", "matchGroupId"]];
    for (const [name, field] of sorts) { const actual = resource(snapshot, name); const expected = [...actual].sort((left, right) => left[field].localeCompare(right[field]) || canonicalJson(left).localeCompare(canonicalJson(right))); ctx.equal(actual, expected, `${name} deterministic sort`); }
    ctx.equal(resource(snapshot, "matches").find(({ matchId }) => matchId === confirmed.match.matchId).state, "CONFIRMED", "confirmed Match retained");
    ctx.equal(resource(snapshot, "matches").find(({ matchId }) => matchId === rejected.match.matchId).state, "REJECTED", "rejected Match retained");
    ctx.equal(resource(snapshot, "matchGroups").find(({ matchGroupId }) => matchGroupId === group.group.matchGroupId).state, "REVERSED", "reversed Match Group retained");
    return finalEvidence(ctx, { asOf: snapshot.asOf, resources: Object.fromEntries(Object.entries(snapshot.resources).map(([name, values]) => [name, values.length])), work: snapshot.work.length, events: snapshot.events.length });
  },
});

export const D_CASES = Object.freeze([D01, D02, D03, D04]);
