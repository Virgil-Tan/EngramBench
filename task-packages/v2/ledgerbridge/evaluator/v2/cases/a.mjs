import assert from "node:assert/strict";

import { SAFE_MAX } from "../lib/fixtures.mjs";
import { assertAccount, assertTransfer, safeSum } from "../lib/oracle.mjs";
import {
  assertAccountDelta,
  assertPostingOrder,
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

const A01 = defineCase(
  "A-01", "F-ACCOUNTS/F-TRANSFER", "Exercise public create route across valid, same-account, currency, safe-integer and available-funds boundaries", "Compare public Accounts, Transfer, Work and Events to exact reservation and zero-effect rules",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 1_000 } });
    const beforeSource = (await ctx.getAccount(api.baseUrl, catalog.source.accountId)).json;
    const beforeDestination = (await ctx.getAccount(api.baseUrl, catalog.destinations[0].accountId)).json;
    const created = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 100)), { expected: { state: "PENDING", amountMinor: 100, destinationAccountId: catalog.destinations[0].accountId } });
    const afterSource = (await ctx.getAccount(api.baseUrl, catalog.source.accountId)).json;
    const afterDestination = (await ctx.getAccount(api.baseUrl, catalog.destinations[0].accountId)).json;
    assertAccountDelta(ctx, beforeSource, afterSource, { balanceMinor: 0, reservedMinor: 100, availableMinor: -100 }, "create source");
    assertAccountDelta(ctx, beforeDestination, afterDestination, { balanceMinor: 0, reservedMinor: 0, availableMinor: 0 }, "create destination");
    ctx.equal("create sequence begins at one", created.sequence, 1);

    const stable = await snapshot(ctx, api.baseUrl);
    const invalids = [
      [ctx.legacyBody(catalog, 1, { destinationAccountId: catalog.source.accountId }), 400, "INVALID_REQUEST"],
      [ctx.legacyBody(catalog, 1, { destinationAccountId: catalog.euro.accountId }), 409, "ACCOUNT_CURRENCY_MISMATCH"],
      [ctx.legacyBody(catalog, 0), 400, "INVALID_AMOUNT", { contractExpectation: "invalid" }],
      [ctx.legacyBody(catalog, SAFE_MAX + 1), 400, "INVALID_AMOUNT", { contractExpectation: "invalid" }],
      [ctx.legacyBody(catalog, 901), 409, "INSUFFICIENT_FUNDS"],
    ];
    for (const [body, status, code, options] of invalids) expectError(ctx, await ctx.createTransfer(api.baseUrl, body, options), status, code);
    noEffect(ctx, stable, await snapshot(ctx, api.baseUrl), "all rejected legacy requests");

    const maximumBody = {
      sourceAccountId: catalog.maximum.accountId,
      destinationAccountId: catalog.empty.accountId,
      currency: "USD",
      amountMinor: SAFE_MAX,
    };
    requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, maximumBody), { expected: { amountMinor: SAFE_MAX, state: "PENDING" } });
    const maximum = (await ctx.getAccount(api.baseUrl, catalog.maximum.accountId)).json;
    ctx.assert("maximum Account stays exact and non-negative", () => assertAccount(maximum));
    ctx.equal("maximum safe amount consumes available funds exactly", maximum.availableMinor, 0);
    return { evidence: [created.transferId, maximum.accountId] };
  },
);

const A02 = defineCase(
  "A-02", "F-TRANSFER", "Create several pending Transfers, drain them with a real Settlement worker, and page both public Statements", "Replay Posting direction, currency conservation, cursor order and balanceAfter independently",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 500 } });
    const created = [];
    for (const amount of [10, 20, 30]) created.push(requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, amount, { destinationAccountId: catalog.destinations[amount / 10 - 1].accountId }))));
    const worker = await ctx.startWorker();
    for (const transfer of created) await waitForTransfer(ctx, api.baseUrl, transfer.transferId, "POSTED", { processes: [worker] });
    const state = await snapshot(ctx, api.baseUrl);
    for (const transfer of created) {
      const saved = transferFrom(state, transfer.transferId);
      const postings = postingsFor(state, transfer.transferId);
      ctx.equal("settlement creates one Posting", postings.length, 1, { failureCodeSuffix: "POSTING_COUNT", hardCapIds: ["CORRECTNESS_INVARIANT"] });
      assertPostingOrder(ctx, postings[0], saved, "TRANSFER");
      ctx.equal("Transfer points at its Posting", saved.postingId, postings[0].postingId);
      ctx.equal("posted timestamp equals Posting timestamp", saved.postedAt, postings[0].createdAt);
      ctx.equal("created and posted events are exact", eventsFor(state, transfer.transferId).map(({ type }) => type), ["transfer.created", "transfer.posted"]);
    }
    const sourceItems = await statementAll(ctx, api.baseUrl, catalog.source.accountId, 1);
    ctx.equal("source Statement has all debits", sourceItems.map(({ direction, amountMinor }) => [direction, amountMinor]), [["DEBIT", 10], ["DEBIT", 20], ["DEBIT", 30]]);
    ctx.equal("source balanceAfter replays committed balances", sourceItems.map(({ balanceAfterMinor }) => balanceAfterMinor), [490, 470, 440]);
    for (let index = 0; index < 3; index += 1) {
      const items = await statementAll(ctx, api.baseUrl, catalog.destinations[index].accountId, 1);
      ctx.equal("destination Statement has its credit", items.map(({ direction, amountMinor, balanceAfterMinor }) => [direction, amountMinor, balanceAfterMinor]), [["CREDIT", (index + 1) * 10, (index + 1) * 10]]);
    }
    return { evidence: created.map(({ transferId }) => transferId) };
  },
);

const A03 = defineCase(
  "A-03", "F-TRANSFER pending/posted/cancelled/reversed", "Cancel one pending Transfer and reverse one posted Transfer through public idempotent mutations", "Prove reservation release once and an immutable exact opposite Posting with no illegal-state side effects",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 500 } });
    const pending = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 80)));
    const cancelled = requireTransfer(ctx, await ctx.cancelTransfer(api.baseUrl, pending.transferId), { status: 200, expected: { state: "CANCELLED" } });
    expectError(ctx, await ctx.cancelTransfer(api.baseUrl, pending.transferId), 409, "TRANSFER_NOT_CANCELLABLE");
    expectError(ctx, await ctx.reverseTransfer(api.baseUrl, pending.transferId), 409, "TRANSFER_NOT_REVERSIBLE");
    const postedCandidate = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 120, { destinationAccountId: catalog.destinations[1].accountId })));
    const worker = await ctx.startWorker();
    const posted = await waitForTransfer(ctx, api.baseUrl, postedCandidate.transferId, "POSTED", { processes: [worker] });
    expectError(ctx, await ctx.cancelTransfer(api.baseUrl, posted.transferId), 409, "TRANSFER_NOT_CANCELLABLE");
    const reversed = requireTransfer(ctx, await ctx.reverseTransfer(api.baseUrl, posted.transferId, { reason: "duplicate-safe" }), { expected: { state: "REVERSED" } });
    expectError(ctx, await ctx.reverseTransfer(api.baseUrl, posted.transferId), 409, "TRANSFER_NOT_REVERSIBLE");
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal("cancelled Transfer has no Posting", postingsFor(state, cancelled.transferId).length, 0);
    ctx.equal("reversed Transfer preserves original plus compensation", postingsFor(state, reversed.transferId).length, 2);
    const [original, compensation] = postingsFor(state, reversed.transferId);
    assertPostingOrder(ctx, original, transferFrom(state, reversed.transferId), "TRANSFER");
    assertPostingOrder(ctx, compensation, transferFrom(state, reversed.transferId), "REVERSAL");
    ctx.equal("reversal links only the compensating Posting", reversed.reversalPostingId, compensation.postingId);
    ctx.equal("cancel event sequence exact", eventsFor(state, cancelled.transferId).map(({ type }) => type), ["transfer.created", "transfer.cancelled"]);
    ctx.equal("reverse event sequence exact", eventsFor(state, reversed.transferId).map(({ type }) => type), ["transfer.created", "transfer.posted", "transfer.reversed"]);
    ctx.equal("source reservation fully released", state.resources.accounts.find(({ accountId }) => accountId === catalog.source.accountId).reservedMinor, 0);
    return { evidence: [cancelled.transferId, reversed.transferId, original.postingId, compensation.postingId] };
  },
);

const A04 = defineCase(
  "A-04", "F-MULTI one/two/twenty/duplicate/overflow", "Submit both request alternatives and all multi-beneficiary count, duplicate, member, sum and funding boundaries", "Check stable ordered TransferLeg identity, exact reservation sum, nullable discriminator and whole-request rejection",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 1_000, destinationCount: 20 } });
    const one = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, [1])));
    ctx.equal("one-leg new body keeps legacy fields", [one.destinationAccountId, one.amountMinor], [catalog.destinations[0].accountId, 1]);
    const two = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, [1, 2])));
    ctx.equal("multi-leg legacy fields are required null", [two.destinationAccountId, two.amountMinor], [null, null]);
    ctx.equal("two-leg order is request order", two.legs.map(({ destinationAccountId, amountMinor }) => [destinationAccountId, amountMinor]), ctx.multiBody(catalog, [1, 2]).legs.map(({ destinationAccountId, amountMinor }) => [destinationAccountId, amountMinor]));
    const twentyAmounts = Array.from({ length: 20 }, (_, index) => index + 1);
    const twenty = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, twentyAmounts)));
    ctx.equal("twenty destination limit is accepted", twenty.legs.length, 20);
    ctx.equal("TransferLeg IDs are stable and unique", new Set(twenty.legs.map(({ legId }) => legId)).size, 20);
    const source = (await ctx.getAccount(api.baseUrl, catalog.source.accountId)).json;
    ctx.equal("reservation equals exact safe sums", source.reservedMinor, 1 + 3 + safeSum(twentyAmounts));
    const stable = await snapshot(ctx, api.baseUrl);
    const duplicate = ctx.multiBody(catalog, [1, 2]); duplicate.legs[1].destinationAccountId = duplicate.legs[0].destinationAccountId;
    const invalids = [
      [duplicate, 400, "DUPLICATE_DESTINATION_ACCOUNT"],
      [ctx.multiBody(catalog, [0]), 400, "INVALID_MULTI_LEG_AMOUNT", { contractExpectation: "invalid" }],
      [ctx.multiBody(catalog, [SAFE_MAX, 1]), 400, "INVALID_MULTI_LEG_AMOUNT"],
      [ctx.multiBody(catalog, Array.from({ length: 21 }, () => 1)), 400, "INVALID_REQUEST", { contractExpectation: "invalid" }],
      [{ ...ctx.multiBody(catalog, [1]), destinationAccountId: catalog.destinations[1].accountId, amountMinor: 1 }, 400, "INVALID_REQUEST", { contractExpectation: "invalid" }],
      [ctx.multiBody(catalog, [900, 900]), 409, "MULTI_LEG_INSUFFICIENT_FUNDS"],
    ];
    for (const [body, status, code, options] of invalids) expectError(ctx, await ctx.createTransfer(api.baseUrl, body, options), status, code);
    noEffect(ctx, stable, await snapshot(ctx, api.baseUrl), "rejected multi-leg requests");
    return { evidence: [one.transferId, two.transferId, twenty.transferId] };
  },
);

const A05 = defineCase(
  "A-05", "F-MULTI and LB-W1", "Settle and reverse one-, two- and twenty-leg Transfers with a real worker, then query every public Statement and snapshot", "Replay ordered source totals, destination amounts, public leg identity and currency conservation for one- and multi-leg Transfers",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 10_000, destinationCount: 20 } });
    const transfers = [
      requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 17))),
      requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, [30, 20]))),
      requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.multiBody(catalog, Array.from({ length: 20 }, () => 5), { sourceAccountId: catalog.source2.accountId }))),
    ];
    const worker = await ctx.startWorker();
    for (const transfer of transfers) await waitForTransfer(ctx, api.baseUrl, transfer.transferId, "POSTED", { processes: [worker] });
    for (const transfer of transfers) requireTransfer(ctx, await ctx.reverseTransfer(api.baseUrl, transfer.transferId), { expected: { state: "REVERSED" } });
    const state = await snapshot(ctx, api.baseUrl);
    for (const transfer of transfers) {
      const saved = transferFrom(state, transfer.transferId);
      const postings = postingsFor(state, transfer.transferId);
      ctx.equal("multi Transfer has original and reversal", postings.length, 2, { failureCodeSuffix: "PARTIAL_POSTING", hardCapIds: ["CORRECTNESS_INVARIANT"] });
      assertPostingOrder(ctx, postings[0], saved, "TRANSFER");
      assertPostingOrder(ctx, postings[1], saved, "REVERSAL");
      for (const leg of saved.legs) {
        const items = await statementAll(ctx, api.baseUrl, leg.destinationAccountId, 1, { finalMulti: true });
        const related = items.filter(({ transferId }) => transferId === saved.transferId);
        ctx.equal("destination Statement preserves legId both directions", related.map(({ legId }) => legId), [leg.legId, leg.legId]);
        ctx.equal("destination Statement compensates exact amount", related.map(({ direction, amountMinor }) => [direction, amountMinor]), [["CREDIT", leg.amountMinor], ["DEBIT", leg.amountMinor]]);
      }
      const sourceItems = (await statementAll(ctx, api.baseUrl, saved.sourceAccountId, 1, { finalMulti: true })).filter(({ transferId }) => transferId === saved.transferId);
      ctx.equal("source Statement uses stable one-leg ID or null multi-leg aggregate", sourceItems.map(({ legId }) => legId), saved.legs.length === 1 ? [saved.legs[0].legId, saved.legs[0].legId] : [null, null]);
      ctx.equal("source Statement charges and compensates exact total", sourceItems.map(({ direction, amountMinor }) => [direction, amountMinor]), [["DEBIT", safeSum(saved.legs.map(({ amountMinor }) => amountMinor))], ["CREDIT", safeSum(saved.legs.map(({ amountMinor }) => amountMinor))]]);
    }
    return { evidence: transfers.map(({ transferId }) => transferId) };
  },
);

export const A_CASES = [A01, A02, A03, A04, A05];
