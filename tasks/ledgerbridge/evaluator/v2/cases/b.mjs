import assert from "node:assert/strict";

import { canonical, reconcileSnapshot, safeSum } from "../lib/oracle.mjs";
import {
  assertStableReplay,
  boot,
  defineCase,
  eventsFor,
  expectError,
  noEffect,
  postingsFor,
  requireTransfer,
  snapshot,
  statementAll,
  transferFrom,
  waitForTransfer,
} from "./helpers.mjs";

const B01 = defineCase(
  "B-01", "Seeded multi-currency transfer graph", "Mix legacy and multi-leg create, settlement, cancellation and reversal through public processes", "Recompute every currency total, outgoing pending reservation, Posting balance and Statement balanceAfter from independent opening balances",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 2_000, destinationCount: 8 } });
    const pending = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 11)));
    const cancelled = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 13, { destinationAccountId: catalog.destinations[1].accountId })));
    requireTransfer(ctx, await ctx.cancelTransfer(api.baseUrl, cancelled.transferId), { status: 200 });
    const multi = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, [17, 19, 23])));
    const worker = await ctx.startWorker();
    await waitForTransfer(ctx, api.baseUrl, pending.transferId, "POSTED", { processes: [worker] });
    await waitForTransfer(ctx, api.baseUrl, multi.transferId, "POSTED", { processes: [worker] });
    requireTransfer(ctx, await ctx.reverseTransfer(api.baseUrl, pending.transferId));
    const stillPending = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, [29, 31], { sourceAccountId: catalog.source2.accountId })));
    await ctx.stop(worker);
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal("only deliberately undrained Transfer remains pending", state.resources.transfers.filter(({ state: value }) => value === "PENDING").map(({ transferId }) => transferId), [stillPending.transferId]);
    for (const account of state.resources.accounts) {
      const entries = await statementAll(ctx, api.baseUrl, account.accountId, 1, { finalMulti: true });
      let balance = account.openingBalanceMinor;
      for (const entry of entries) {
        balance += entry.direction === "CREDIT" ? entry.amountMinor : -entry.amountMinor;
        ctx.equal("Statement balanceAfter recomputes exactly", entry.balanceAfterMinor, balance, { failureCodeSuffix: "STATEMENT_REPLAY", hardCapIds: ["CORRECTNESS_INVARIANT"] });
      }
      ctx.equal("Statement terminal balance matches Account", balance, account.balanceMinor, { failureCodeSuffix: "ACCOUNT_BALANCE", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    }
    const pendingTotal = safeSum(transferFrom(state, stillPending.transferId).legs.map(({ amountMinor }) => amountMinor));
    ctx.equal("pending multi reservation is its total", state.resources.accounts.find(({ accountId }) => accountId === catalog.source2.accountId).reservedMinor, pendingTotal);
    return { evidence: [pending.transferId, cancelled.transferId, multi.transferId, stillPending.transferId] };
  },
);

const B02 = defineCase(
  "B-02", "F-TRANSFER plus two API processes and response shield", "Race twenty identical keys, drop a complete mutation response, restart APIs, replay create/cancel/reverse and conflict semantic reuse", "Compare durable original status/body/IDs and require one reservation, Posting, Reversal and Event per transition",
  async (ctx) => {
    const { catalog, apis } = await boot(ctx, { apiCount: 2, catalogOptions: { sourceBalance: 2_000 } });
    const createKey = ctx.key("twenty-way-create");
    const body = ctx.legacyBody(catalog, 100);
    const raced = await Promise.all(Array.from({ length: 20 }, (_, index) => ctx.createTransfer(apis[index % 2].baseUrl, body, { key: createKey })));
    const original = assertStableReplay(ctx, raced, "twenty-way create");
    const created = requireTransfer(ctx, original);
    const afterRace = await snapshot(ctx, apis[0].baseUrl);
    ctx.equal("twenty-way replay creates one Transfer", afterRace.resources.transfers.filter(({ transferId }) => transferId === created.transferId).length, 1);
    ctx.equal("twenty-way replay reserves once", afterRace.resources.accounts.find(({ accountId }) => accountId === catalog.source.accountId).reservedMinor, 100);
    expectError(ctx, await ctx.createTransfer(apis[1].baseUrl, { ...body, amountMinor: 101 }, { key: createKey }), 409, "IDEMPOTENCY_CONFLICT");

    const shield = await ctx.responseShield(apis[0].baseUrl);
    const unknownKey = ctx.key("unknown-create");
    const unknownBody = ctx.legacyBody(catalog, 70, { destinationAccountId: catalog.destinations[1].accountId });
    shield.dropNextMutation();
    await assert.rejects(() => ctx.createTransfer(shield.baseUrl, unknownBody, { key: unknownKey }));
    await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), { label: "complete dropped response" });
    const replay = requireTransfer(ctx, await ctx.createTransfer(apis[1].baseUrl, unknownBody, { key: unknownKey }));
    ctx.equal("unknown outcome body is saved before acknowledgement", canonical(replay), canonical(JSON.parse(shield.captures.find(({ dropped }) => dropped).response.body)));

    for (const api of apis) await ctx.stop(api);
    const restarted = await ctx.startApi();
    const restartedReplay = await ctx.createTransfer(restarted.baseUrl, body, { key: createKey });
    ctx.equal("restart preserves original status", restartedReplay.status, original.status);
    ctx.equal("restart preserves original semantic body", canonical(restartedReplay.json), canonical(original.json));

    const cancelKey = ctx.key("cancel-replay");
    const cancels = await Promise.all(Array.from({ length: 20 }, () => ctx.cancelTransfer(restarted.baseUrl, created.transferId, { key: cancelKey })));
    assertStableReplay(ctx, cancels, "cancel replay");
    const worker = await ctx.startWorker();
    await waitForTransfer(ctx, restarted.baseUrl, replay.transferId, "POSTED", { processes: [worker] });
    const reverseKey = ctx.key("reverse-replay");
    const reversals = await Promise.all(Array.from({ length: 20 }, () => ctx.reverseTransfer(restarted.baseUrl, replay.transferId, { key: reverseKey, reason: "same" })));
    assertStableReplay(ctx, reversals, "reverse replay");
    const final = await snapshot(ctx, restarted.baseUrl);
    ctx.equal("cancel transition emits once", eventsFor(final, created.transferId).map(({ type }) => type), ["transfer.created", "transfer.cancelled"]);
    ctx.equal("posted and reversal effects each occur once", postingsFor(final, replay.transferId).length, 2, { failureCodeSuffix: "DUPLICATE_EFFECT", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    ctx.equal("reverse event occurs once", eventsFor(final, replay.transferId).map(({ type }) => type), ["transfer.created", "transfer.posted", "transfer.reversed"]);
    return { evidence: [created.transferId, replay.transferId, shield.captures.length] };
  },
);

const B03 = defineCase(
  "B-03", "F-RACE at claimed/effect/commit boundaries", "Race public cancellation against Settlement workers held at controlled recovery barriers", "Allow only complete CANCELLED or POSTED authority outcomes and reject double release, half Posting, negative available or missing event",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 500 } });
    const claimedTransfer = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 40)));
    const claimedBarrier = await ctx.workerBarrier("worker.claimed", ({ aggregateId }) => aggregateId === claimedTransfer.transferId);
    const claimedWorker = await ctx.startWorkerAtBarrier(claimedBarrier);
    const claim = await claimedBarrier.waitFor(({ json }) => json.aggregateId === claimedTransfer.transferId, { processes: [claimedWorker] });
    requireTransfer(ctx, await ctx.cancelTransfer(api.baseUrl, claimedTransfer.transferId), { status: 200, expected: { state: "CANCELLED" } });
    claimedBarrier.release(claim);
    await waitForTransfer(ctx, api.baseUrl, claimedTransfer.transferId, "CANCELLED");
    await ctx.stop(claimedWorker);

    const commitTransfer = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 50, { destinationAccountId: catalog.destinations[1].accountId })));
    const commitBarrier = await ctx.workerBarrier("worker.before-commit", ({ aggregateId }) => aggregateId === commitTransfer.transferId);
    const commitWorker = await ctx.startWorkerAtBarrier(commitBarrier);
    const beforeCommit = await commitBarrier.waitFor(({ json }) => json.aggregateId === commitTransfer.transferId, { processes: [commitWorker] });
    const cancelAtCommit = await ctx.cancelTransfer(api.baseUrl, commitTransfer.transferId);
    ctx.ok("commit-boundary cancel has only published outcomes", (cancelAtCommit.status === 200 && cancelAtCommit.json?.state === "CANCELLED") || (cancelAtCommit.status === 409 && cancelAtCommit.json?.error?.code === "TRANSFER_NOT_CANCELLABLE"));
    commitBarrier.release(beforeCommit);
    const commitWinner = await ctx.waitFor(async () => {
      const value = (await ctx.getTransfer(api.baseUrl, commitTransfer.transferId)).json;
      return ["POSTED", "CANCELLED"].includes(value?.state) ? value : undefined;
    }, { label: "commit race terminal", processes: [commitWorker] });
    await ctx.stop(commitWorker);

    const freeRace = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 60, { destinationAccountId: catalog.destinations[2].accountId })));
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    const raceCancel = await ctx.cancelTransfer(api.baseUrl, freeRace.transferId);
    ctx.ok("free race cancel has only published outcomes", [200, 409].includes(raceCancel.status));
    const freeWinner = await ctx.waitFor(async () => {
      const value = (await ctx.getTransfer(api.baseUrl, freeRace.transferId)).json;
      return ["POSTED", "CANCELLED"].includes(value?.state) ? value : undefined;
    }, { label: "free settlement/cancel race", processes: workers });
    const state = await snapshot(ctx, api.baseUrl);
    for (const winner of [transferFrom(state, claimedTransfer.transferId), transferFrom(state, commitTransfer.transferId), transferFrom(state, freeRace.transferId)]) {
      const postings = postingsFor(state, winner.transferId);
      ctx.equal("race terminal owns complete Posting cardinality", postings.length, winner.state === "POSTED" ? 1 : 0, { failureCodeSuffix: "RACE_PARTIAL_POSTING", hardCapIds: ["CORRECTNESS_INVARIANT"] });
      ctx.equal("race terminal owns exactly two events", eventsFor(state, winner.transferId).length, 2);
    }
    return { evidence: [commitWinner.state, freeWinner.state] };
  },
);

const B04 = defineCase(
  "B-04", "F-RACE with duplicate Settlement recovery and 32 Reversals", "Crash one worker before commit, recover with two workers, then race thirty-two public Reversal mutations across two APIs", "Require one original Posting, one compensation, one balance restoration and contiguous stable event sequence",
  async (ctx) => {
    const { catalog, apis } = await boot(ctx, { apiCount: 2, catalogOptions: { sourceBalance: 500 } });
    const transfer = requireTransfer(ctx, await ctx.createTransfer(apis[0].baseUrl, ctx.legacyBody(catalog, 75)));
    const barrier = await ctx.workerBarrier("worker.before-commit", ({ aggregateId }) => aggregateId === transfer.transferId);
    const stale = await ctx.startWorkerAtBarrier(barrier);
    await barrier.waitFor(({ json }) => json.aggregateId === transfer.transferId, { processes: [stale] });
    await ctx.kill(stale);
    await ctx.sleep(3_200);
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await waitForTransfer(ctx, apis[0].baseUrl, transfer.transferId, "POSTED", { processes: workers });
    const responses = await Promise.all(Array.from({ length: 32 }, (_, index) => ctx.reverseTransfer(apis[index % 2].baseUrl, transfer.transferId, { key: ctx.key(`reverse-${index}`), reason: `race-${index}` })));
    ctx.equal("one reverse winner", responses.filter(({ status }) => status === 202).length, 1);
    for (const loser of responses.filter(({ status }) => status !== 202)) expectError(ctx, loser, 409, "TRANSFER_NOT_REVERSIBLE");
    const state = await snapshot(ctx, apis[0].baseUrl);
    ctx.equal("duplicate settlement recovery leaves one original and one Reversal", postingsFor(state, transfer.transferId).length, 2, { failureCodeSuffix: "DUPLICATE_POSTING", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    ctx.equal("event sequence is contiguous", eventsFor(state, transfer.transferId).map(({ sequence }) => sequence), [1, 2, 3]);
    ctx.equal("event types are exact", eventsFor(state, transfer.transferId).map(({ type }) => type), ["transfer.created", "transfer.posted", "transfer.reversed"]);
    const source = state.resources.accounts.find(({ accountId }) => accountId === catalog.source.accountId);
    ctx.equal("concurrent reversal restores source once", source.balanceMinor, source.openingBalanceMinor);
    return { evidence: [transfer.transferId, responses.map(({ status }) => status)] };
  },
);

const B05 = defineCase(
  "B-05", "F-MULTI shared source and overlapping destinations", "Race differently ordered multi-leg requests for the last funds through two APIs, then settle and reverse winners with two workers", "Bound winner sums by source availability, reject duplicate/overflow atomically, and reconcile every all-or-none Posting without deadlock",
  async (ctx) => {
    const { catalog, apis } = await boot(ctx, { apiCount: 2, catalogOptions: { sourceBalance: 100, destinationCount: 6 } });
    const requests = Array.from({ length: 12 }, (_, index) => {
      const first = index % 6;
      const second = (index + 1) % 6;
      return { sourceAccountId: catalog.source.accountId, currency: "USD", legs: [first, second].map((destinationIndex) => ({ destinationAccountId: catalog.destinations[destinationIndex].accountId, amountMinor: 15 })) };
    });
    const responses = await Promise.all(requests.map((body, index) => ctx.createTransfer(apis[index % 2].baseUrl, body, { key: ctx.key(`hotspot-${index}`), timeoutMs: 20_000 })));
    const winners = responses.filter(({ status }) => status === 202).map(({ json }) => json);
    ctx.ok("hotspot admits at least one complete winner", winners.length > 0);
    ctx.ok("hotspot winner sums do not exceed source funds", winners.reduce((sum, transfer) => sum + safeSum(transfer.legs.map(({ amountMinor }) => amountMinor)), 0) <= 100);
    for (const loser of responses.filter(({ status }) => status !== 202)) expectError(ctx, loser, 409, "MULTI_LEG_INSUFFICIENT_FUNDS");
    const reserved = (await ctx.getAccount(apis[0].baseUrl, catalog.source.accountId)).json.reservedMinor;
    ctx.equal("reservation equals exact winner sums", reserved, winners.reduce((sum, transfer) => sum + safeSum(transfer.legs.map(({ amountMinor }) => amountMinor)), 0));

    const beforeInvalid = await snapshot(ctx, apis[0].baseUrl);
    const duplicate = ctx.multiBody(catalog, [1, 1]); duplicate.legs[1].destinationAccountId = duplicate.legs[0].destinationAccountId;
    expectError(ctx, await ctx.createTransfer(apis[0].baseUrl, duplicate), 400, "DUPLICATE_DESTINATION_ACCOUNT");
    expectError(ctx, await ctx.createTransfer(apis[1].baseUrl, ctx.multiBody(catalog, [Number.MAX_SAFE_INTEGER, 1])), 400, "INVALID_MULTI_LEG_AMOUNT");
    noEffect(ctx, beforeInvalid, await snapshot(ctx, apis[0].baseUrl), "invalid hotspot requests");

    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    for (const winner of winners) await waitForTransfer(ctx, apis[0].baseUrl, winner.transferId, "POSTED", { processes: workers });
    const reversals = await Promise.all(winners.map((winner, index) => ctx.reverseTransfer(apis[index % 2].baseUrl, winner.transferId, { key: ctx.key(`hotspot-reverse-${index}`) })));
    ctx.equal("all hotspot winners reverse atomically", reversals.map(({ status }) => status), winners.map(() => 202));
    const final = await snapshot(ctx, apis[0].baseUrl);
    for (const winner of winners) ctx.equal("each winner has complete original and reversal", postingsFor(final, winner.transferId).length, 2, { failureCodeSuffix: "PARTIAL_MULTI_POSTING", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    return { evidence: winners.map(({ transferId }) => transferId) };
  },
);

export const B_CASES = [B01, B02, B03, B04, B05];
