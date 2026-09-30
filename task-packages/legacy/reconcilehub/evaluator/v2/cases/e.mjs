import { createHash } from "node:crypto";

import { performanceContract, performanceSeed } from "../fixtures/index.mjs";
import {
  assertLedgerEntry, assertMatch, assertMatchGroup, assertSnapshot, assertStatementLine, canonicalJson,
  createMatch, exactKeys, finalEvidence, guardedCase, ignoreLine, importBatch, matchAction, prepare,
  requireV1, resource, seedWithRecords, waitForDrain,
} from "./helpers.mjs";

function fixtureRecords(fixtures, label, amounts = [101, 202, 303, 404, 505]) {
  const batchId = fixtures.uuid(`${label}-batch`);
  return {
    statementLines: amounts.map((amountMinor, index) => ({
      statementLineId: fixtures.uuid(`${label}-line-${index}`), batchId, externalId: `${label}-${index}`,
      bookedAt: fixtures.date(index), currency: "USD", amountMinor, reference: `${label}-${index}`,
      state: "UNMATCHED", revision: 1,
    })),
    ledgerEntries: amounts.map((amountMinor, index) => ({
      ledgerEntryId: fixtures.uuid(`${label}-entry-${index}`), postedAt: fixtures.date(index), currency: "USD",
      amountMinor, reference: `${label}-${index}`, state: "UNMATCHED", revision: 1,
    })),
  };
}

function migratedGroup(match, lines, entries) {
  const line = lines.get(match.statementLineId);
  const entry = entries.get(match.ledgerEntryId);
  return {
    matchGroupId: match.matchId,
    matchId: match.matchId,
    statementLineId: match.statementLineId,
    ledgerEntryId: match.ledgerEntryId,
    statementLineIds: [match.statementLineId],
    ledgerEntryIds: [match.ledgerEntryId],
    currency: line.currency,
    statementTotalMinor: line.amountMinor,
    ledgerTotalMinor: entry.amountMinor,
    state: match.state,
    createdAt: match.createdAt,
    confirmedAt: match.confirmedAt,
    reversedAt: match.reversedAt,
    sequence: match.sequence,
  };
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function byteOrder(left, right) {
  return Buffer.from(String(left)).compare(Buffer.from(String(right)));
}

function delay(milliseconds) {
  return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

async function pacedLoad({ count, seconds, concurrency, operation }) {
  const statuses = new Map();
  const latencies = [];
  const responses = new Array(count);
  const startedAt = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async (_, client) => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      await delay(startedAt + (index * seconds * 1_000) / count - performance.now());
      const requestStartedAt = performance.now();
      const response = await operation(index, client);
      latencies.push(performance.now() - requestStartedAt);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      responses[index] = response;
    }
  }));
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  const ordered = [...latencies].sort((left, right) => left - right);
  return {
    responses,
    statuses,
    durationSeconds,
    throughput: count / seconds,
    p95Ms: ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)],
  };
}

function importBody(fixtures, ordinal) {
  const label = `perf-import-${String(ordinal).padStart(4, "0")}`;
  return {
    source: label,
    batchKey: label,
    lines: Array.from({ length: 100 }, (_, line) => ({
      externalId: `${label}-${String(line).padStart(3, "0")}`,
      bookedAt: fixtures.date((ordinal + line) % 28),
      currency: line % 2 === 0 ? "USD" : "EUR",
      amountMinor: ordinal * 1_000 + line + 1,
      reference: `RH-${ordinal}-${line}`,
    })),
  };
}

function assertImportResponse(ctx, response, label) {
  ctx.equal(response.status, 202, `${label} status`);
  ctx.ok(response.json && typeof response.json.batchId === "string", `${label} returns a stable batchId`);
  return response;
}

function assertReviewPage(ctx, value, expected) {
  exactKeys(value, ["statementLines", "ledgerEntries", "suggestions", "nextCursor"], "Reconciliation Work page");
  ctx.ok(Array.isArray(value.statementLines) && Array.isArray(value.ledgerEntries) && Array.isArray(value.suggestions), "Reconciliation Work arrays");
  ctx.ok(value.nextCursor === null || typeof value.nextCursor === "string", "Reconciliation Work cursor");
  value.statementLines.forEach(assertStatementLine);
  value.ledgerEntries.forEach(assertLedgerEntry);
  value.suggestions.forEach(assertMatch);
  ctx.equal(value.statementLines.map(({ statementLineId }) => statementLineId), expected.statementLineIds, "published Statement Line order");
  ctx.equal(value.ledgerEntries.map(({ ledgerEntryId }) => ledgerEntryId), expected.ledgerEntryIds, "published Ledger Entry order");
  ctx.equal(value.suggestions, [], "unchanged perf-v1 set starts without generated proposals");
  return value;
}

function expectedReviewPage(seed) {
  const statementLines = seed.statementBatches.flatMap(({ batchId, lines }) => lines.map((line) => ({ ...line, batchId, revision: line.state === "MATCHED" ? 2 : 1 })));
  return {
    statementLineIds: statementLines.filter(({ state }) => state === "UNMATCHED")
      .sort((left, right) => byteOrder(left.bookedAt, right.bookedAt) || byteOrder(left.externalId, right.externalId) || byteOrder(left.statementLineId, right.statementLineId))
      .slice(0, 100).map(({ statementLineId }) => statementLineId),
    ledgerEntryIds: seed.ledgerEntries.filter(({ state }) => state === "UNMATCHED")
      .sort((left, right) => byteOrder(left.postedAt, right.postedAt) || byteOrder(left.ledgerEntryId, right.ledgerEntryId))
      .slice(0, 100).map(({ ledgerEntryId }) => ledgerEntryId),
  };
}

const E01 = guardedCase({
  id: "E-01", fixtureFamily: "RH-F-V1-TO-FINAL-MATCH-GROUP-MIGRATION",
  action: "Create V1 confirmed, reversed, rejected, ignored and proposed histories plus pending Work, Events and a saved import replay, then migrate the same database with FINAL.",
  oracle: "Every legacy resource, action, Event, Work item and replay stays byte-semantically exact while each V1 Match gains one same-ID two-member Match Group and pending Work drains normally.",
  async run(ctx) {
    const v1Workspace = requireV1(ctx);
    await prepare(ctx, { migrate: false });
    const fixture = fixtureRecords(ctx.fixtures, "e01");
    const seed = seedWithRecords(ctx.fixtures, { label: "e01", ...fixture });
    const v1 = await prepare(ctx, { workspace: v1Workspace, seed });
    const v1Api = await v1.startApi();
    const reversed = await createMatch(ctx, v1Api.baseUrl, fixture.statementLines[0].statementLineId, fixture.ledgerEntries[0].ledgerEntryId);
    await matchAction(ctx, v1Api.baseUrl, reversed.match.matchId, "confirm", { expectedLineRevision: 1, expectedLedgerRevision: 1 });
    await matchAction(ctx, v1Api.baseUrl, reversed.match.matchId, "reverse", { reason: "V1 correction" });
    const rejected = await createMatch(ctx, v1Api.baseUrl, fixture.statementLines[1].statementLineId, fixture.ledgerEntries[1].ledgerEntryId);
    await matchAction(ctx, v1Api.baseUrl, rejected.match.matchId, "reject", { reason: "V1 rejection" });
    await ignoreLine(ctx, v1Api.baseUrl, fixture.statementLines[2].statementLineId, 1, "V1 ignore");
    await createMatch(ctx, v1Api.baseUrl, fixture.statementLines[3].statementLineId, fixture.ledgerEntries[3].ledgerEntryId);
    const replayKey = ctx.key("e01-saved-batch");
    const replayBody = importBody(ctx.fixtures, 9_001);
    const saved = await importBatch(ctx, v1Api.baseUrl, replayBody, { key: replayKey });
    const before = await ctx.snapshot(v1Api.baseUrl);
    await ctx.stop(v1Api);

    const final = await prepare(ctx);
    const finalApi = await final.startApi();
    const after = await ctx.snapshot(finalApi.baseUrl);
    for (const name of ["statementBatches", "statementLines", "ledgerEntries", "matches"]) {
      ctx.equal(resource(after, name), resource(before, name), `migration preserves V1 ${name}`, { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    }
    ctx.equal(after.work, before.work, "migration preserves pending Suggestion Work", { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    ctx.equal(after.events, before.events, "migration preserves Event identity body and sequence", { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    const lines = new Map(resource(before, "statementLines").map((line) => [line.statementLineId, line]));
    const entries = new Map(resource(before, "ledgerEntries").map((entry) => [entry.ledgerEntryId, entry]));
    const groups = new Map(resource(after, "matchGroups").map((group) => [group.matchGroupId, group]));
    ctx.equal(groups.size, resource(before, "matches").length, "one Match Group exists for every V1 Match", { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    for (const match of resource(before, "matches")) {
      const expected = migratedGroup(match, lines, entries);
      assertMatchGroup(groups.get(match.matchId));
      ctx.equal(groups.get(match.matchId), expected, `same-ID migration for ${match.matchId}`, { hardCapIds: ["MIGRATION_COMPATIBILITY"] });
    }
    const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/statement-batches", replayKey, replayBody);
    ctx.equal({ status: replay.status, json: replay.json }, { status: saved.response.status, json: saved.value }, "saved V1 import response replays exactly", { hardCapIds: ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"] });
    assertSnapshot(ctx, after);
    const workers = [await final.startWorker(), await final.startWorker()];
    const drained = await waitForDrain(ctx, finalApi.baseUrl, { processes: workers, timeoutMs: 120_000 });
    for (const match of resource(before, "matches")) ctx.equal(resource(drained, "matchGroups").find(({ matchGroupId }) => matchGroupId === match.matchId), migratedGroup(match, lines, entries), `pending Work does not rewrite ${match.matchId}`);
    return finalEvidence(ctx, { migratedMatches: groups.size, preservedWork: before.work.length, preservedEvents: before.events.length, savedReplay: true });
  },
}, ["MIGRATION_COMPATIBILITY", "DURABLE_IDEMPOTENCY"]);

const E02 = guardedCase({
  id: "E-02", fixtureFamily: "RH-F-FORMAL-STATEMENT-BATCH-IMPORT",
  action: "Prepare exactly 500 warm-up and 3000 measured disjoint 100-line batches, then issue them through 64 clients for the published ten and sixty second windows.",
  oracle: "Exactly 3000 measured complete 202 imports sustain fifty batches per second with p95 at most 500ms, zero 5xx and a post-load snapshot containing every batch wholly with 100 lines.",
  async run(ctx) {
    const contract = performanceContract().import;
    const base = fixtureRecords(ctx.fixtures, "e02-seed", [991]);
    const target = await prepare(ctx, { seed: seedWithRecords(ctx.fixtures, { label: "e02-seed", ...base }) });
    const apis = [await target.startApi(), await target.startApi()];
    const bodies = Array.from({ length: contract.warmupBatches + contract.measuredBatches }, (_, index) => importBody(ctx.fixtures, index));
    const run = (offset, count, seconds, label) => pacedLoad({
      count, seconds, concurrency: contract.clients,
      operation: async (index, client) => assertImportResponse(ctx, await ctx.mutate(
        apis[client % apis.length].baseUrl,
        "/api/v1/statement-batches",
        ctx.key(`${label}-${index}`),
        bodies[offset + index],
        { timeoutMs: 30_000 },
      ), `${label} ${index}`),
    });
    const warmup = await run(0, contract.warmupBatches, contract.warmupSeconds, "warmup-import");
    const measured = await run(contract.warmupBatches, contract.measuredBatches, contract.measureSeconds, "measured-import");
    ctx.equal(measured.statuses.get(202), contract.measuredBatches, "every measured import succeeds");
    ctx.ok([...measured.statuses].every(([status]) => status < 500), "measured import has zero 5xx");
    ctx.ok(measured.throughput >= contract.batchesPerSecond, "measured import reaches 50 complete batches/s");
    ctx.ok(measured.p95Ms <= contract.p95Ms, "measured import p95 is at most 500ms");
    ctx.ok(measured.durationSeconds <= contract.measureSeconds + 1, "measured import completes in the sixty-second window");
    const snapshot = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 120_000 });
    assertSnapshot(ctx, snapshot);
    const batchIds = [...warmup.responses, ...measured.responses].map(({ json }) => json.batchId);
    ctx.equal(new Set(batchIds).size, bodies.length, "every fixed batch has one identity", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    const lineCounts = new Map();
    for (const line of resource(snapshot, "statementLines")) lineCounts.set(line.batchId, (lineCounts.get(line.batchId) ?? 0) + 1);
    ctx.ok(batchIds.every((batchId) => lineCounts.get(batchId) === contract.linesPerBatch), "every fixed batch is fully imported", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    return finalEvidence(ctx, { clients: contract.clients, warmupBatches: warmup.responses.length, measuredBatches: measured.responses.length, linesPerBatch: contract.linesPerBatch, throughput: measured.throughput, p95Ms: measured.p95Ms });
  },
}, ["CONSERVATION_OR_ATOMICITY"]);

const E03 = guardedCase({
  id: "E-03", fixtureFamily: "RH-F-FORMAL-RECONCILIATION-REVIEW",
  action: "Load the exact perf-v1 corpus and issue the unchanged first-page review query through 64 clients at 250 reads per second for ten warm-up and sixty measured seconds.",
  oracle: "Every response is the same independently ordered complete 200 page; measured p95 is at most 180ms, throughput is 250/s, 5xx is zero and GET load changes no durable state.",
  async run(ctx) {
    const contract = performanceContract().review;
    const seed = performanceSeed(ctx.fixtures);
    const target = await prepare(ctx, { seed, seedTimeoutMs: 900_000 });
    const apis = [await target.startApi(), await target.startApi()];
    const path = `/api/v1/reconciliation-work?state=UNMATCHED&limit=${contract.limit}`;
    const expected = expectedReviewPage(seed);
    const referenceResponse = await ctx.request(apis[0].baseUrl, path, { timeoutMs: 30_000 });
    ctx.equal(referenceResponse.status, 200, "reference review status");
    const reference = assertReviewPage(ctx, referenceResponse.json, expected);
    const before = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 120_000 });
    const run = (count, seconds, label) => pacedLoad({
      count, seconds, concurrency: contract.clients,
      operation: async (index, client) => {
        const response = await ctx.request(apis[client % apis.length].baseUrl, path, { timeoutMs: 30_000 });
        ctx.equal(response.status, 200, `${label} ${index} status`);
        ctx.equal(response.json, reference, `${label} ${index} deterministic page`);
        return response;
      },
    });
    await run(contract.readsPerSecond * contract.warmupSeconds, contract.warmupSeconds, "warmup-review");
    const measured = await run(contract.readsPerSecond * contract.measureSeconds, contract.measureSeconds, "measured-review");
    ctx.equal(measured.statuses.get(200), contract.readsPerSecond * contract.measureSeconds, "every measured review succeeds");
    ctx.ok([...measured.statuses].every(([status]) => status < 500), "measured review has zero 5xx");
    ctx.ok(measured.throughput >= contract.readsPerSecond, "measured review reaches 250 reads/s");
    ctx.ok(measured.p95Ms <= contract.p95Ms, "measured review p95 is at most 180ms");
    ctx.ok(measured.durationSeconds <= contract.measureSeconds + 1, "measured review completes in the sixty-second window");
    const after = await ctx.snapshot(apis[0].baseUrl, { timeoutMs: 120_000 });
    ctx.equal(digest(after), digest(before), "read workload has no durable side effect", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    assertSnapshot(ctx, after);
    return finalEvidence(ctx, { clients: contract.clients, warmupSeconds: contract.warmupSeconds, measureSeconds: contract.measureSeconds, measuredReads: measured.responses.length, throughput: measured.throughput, p95Ms: measured.p95Ms });
  },
}, ["CONSERVATION_OR_ATOMICITY"]);

const E04 = guardedCase({
  id: "E-04", fixtureFamily: "RH-F-FORMAL-SUGGESTION-GENERATION",
  action: "Seed exactly 10000 unmatched Statement Lines and 10000 unmatched Ledger Entries beside 10000 confirmed pairs, start exactly two Workers and time the first complete drain snapshot.",
  oracle: "Within sixty seconds exactly 10000 proposals equal the evaluator-owned unique amount/currency pairing, cover every unmatched member once, preserve confirmed history and leave no nonterminal Work.",
  async run(ctx) {
    const contract = performanceContract().suggestion;
    const seed = performanceSeed(ctx.fixtures);
    const target = await prepare(ctx, { seed, seedTimeoutMs: 900_000 });
    const api = await target.startApi();
    const before = await ctx.snapshot(api.baseUrl, { timeoutMs: 120_000 });
    const confirmed = resource(before, "matches").filter(({ state }) => state === "CONFIRMED");
    ctx.equal(confirmed.length, performanceContract().seed.confirmedMatches, "fixed seed confirmed history");
    const unmatchedLines = resource(before, "statementLines").filter(({ state }) => state === "UNMATCHED");
    const unmatchedEntries = resource(before, "ledgerEntries").filter(({ state }) => state === "UNMATCHED");
    ctx.equal(unmatchedLines.length, contract.unmatchedLines, "fixed unmatched Statement Lines");
    ctx.equal(unmatchedEntries.length, contract.unmatchedLedgerEntries, "fixed unmatched Ledger Entries");
    const entriesByValue = new Map(unmatchedEntries.map((entry) => [`${entry.currency}:${entry.amountMinor}`, entry]));
    ctx.equal(entriesByValue.size, contract.unmatchedLedgerEntries, "independent pair keys are unique");
    const expected = new Map(unmatchedLines.map((line) => [line.statementLineId, entriesByValue.get(`${line.currency}:${line.amountMinor}`)?.ledgerEntryId]));
    ctx.ok([...expected.values()].every(Boolean), "every unmatched Statement Line has one independent candidate");
    const workers = [await target.startWorker(), await target.startWorker()];
    const startedAt = performance.now();
    const snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(api.baseUrl, { timeoutMs: 10_000 });
      const proposed = resource(value, "matches").filter(({ state }) => state === "PROPOSED");
      return proposed.length === contract.proposals && value.work.every(({ terminal }) => terminal) ? value : false;
    }, { timeoutMs: contract.seconds * 1_000, intervalMs: 250, label: "10000 deterministic suggestions and Work drain", processes: workers });
    const durationSeconds = (performance.now() - startedAt) / 1_000;
    ctx.ok(durationSeconds <= contract.seconds, "two Workers drain within sixty seconds", { hardCapIds: ["STALE_WORK_OR_LOST_WORK"] });
    assertSnapshot(ctx, snapshot);
    const proposed = resource(snapshot, "matches").filter(({ state }) => state === "PROPOSED");
    ctx.equal(proposed.length, contract.proposals, "exact proposal count");
    ctx.equal(new Set(proposed.map(({ statementLineId }) => statementLineId)).size, contract.proposals, "every unmatched Statement Line appears once", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    ctx.equal(new Set(proposed.map(({ ledgerEntryId }) => ledgerEntryId)).size, contract.proposals, "every unmatched Ledger Entry appears once", { hardCapIds: ["CONSERVATION_OR_ATOMICITY"] });
    for (const match of proposed) {
      ctx.equal(match.ledgerEntryId, expected.get(match.statementLineId), `independent pair for ${match.statementLineId}`);
      ctx.equal(match.score, 1050, `exact score for ${match.statementLineId}`);
    }
    const afterConfirmed = resource(snapshot, "matches").filter(({ state }) => state === "CONFIRMED");
    ctx.equal(afterConfirmed, confirmed, "confirmed history remains unchanged");
    ctx.ok(snapshot.work.every(({ terminal }) => terminal), "MATCH_SUGGESTION backlog is drained", { hardCapIds: ["STALE_WORK_OR_LOST_WORK"] });
    return finalEvidence(ctx, { workers: contract.workers, unmatchedRecords: contract.unmatchedLines + contract.unmatchedLedgerEntries, proposals: proposed.length, durationSeconds });
  },
}, ["STALE_WORK_OR_LOST_WORK", "CONSERVATION_OR_ATOMICITY"]);

export const E_CASES = Object.freeze([E01, E02, E03, E04]);
