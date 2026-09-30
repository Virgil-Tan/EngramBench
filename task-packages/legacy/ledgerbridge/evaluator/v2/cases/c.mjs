import {
  assertEvent,
  canonical,
  compareUtf8,
} from "../lib/oracle.mjs";
import {
  boot,
  defineCase,
  eventsFor,
  postingsFor,
  requireTransfer,
  snapshot,
  transferFrom,
  waitForTransfer,
  workFor,
} from "./helpers.mjs";

const C01 = defineCase(
  "C-01", "F-RECOVERY claimed lease", "Hold worker.claimed through the public barrier, SIGKILL the owner, wait for lease expiry, and start a replacement worker", "Track the same public Work/Transfer identity and prove a fenced single Posting, reservation release, event and retained terminal Work",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 500 } });
    const transfer = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 90)));
    const barrier = await ctx.workerBarrier("worker.claimed", ({ aggregateId }) => aggregateId === transfer.transferId);
    const stale = await ctx.startWorkerAtBarrier(barrier);
    const claimed = await barrier.waitFor(({ json }) => json.aggregateId === transfer.transferId, { processes: [stale] });
    ctx.equal("claimed barrier identifies first attempt", claimed.json.attempt, 1);
    const leased = await ctx.snapshot(api.baseUrl);
    const originalWork = workFor(leased, transfer.transferId)[0];
    ctx.ok("claimed Work is retained and leased", originalWork && originalWork.state === "LEASED");
    await ctx.kill(stale);
    await ctx.sleep(3_200);
    const replacement = await ctx.startWorker();
    await waitForTransfer(ctx, api.baseUrl, transfer.transferId, "POSTED", { processes: [replacement] });
    const final = await snapshot(ctx, api.baseUrl);
    const recoveredWork = workFor(final, transfer.transferId)[0];
    ctx.equal("recovery preserves Work identity", recoveredWork.workId, originalWork.workId);
    ctx.ok("replacement advances durable attempt", recoveredWork.attempt >= 2);
    ctx.equal("recovered Work is terminal and retained", [recoveredWork.state, recoveredWork.terminal, recoveredWork.leaseOwner, recoveredWork.leaseExpiresAt], ["SUCCEEDED", true, null, null]);
    ctx.equal("stale lease cannot duplicate Posting", postingsFor(final, transfer.transferId).length, 1, { failureCodeSuffix: "STALE_COMMIT", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    ctx.equal("recovery emits created and posted exactly once", eventsFor(final, transfer.transferId).map(({ type }) => type), ["transfer.created", "transfer.posted"]);
    return { evidence: [originalWork.workId, recoveredWork.attempt, claimed.json.leaseTokenHash] };
  },
);

const C02 = defineCase(
  "C-02", "F-RECOVERY single and multi at effect/commit barriers", "SIGKILL real workers at worker.effect-complete and worker.before-commit, query public state mid-crash, then recover after lease expiry", "Require complete absence before commit and atomic Transfer, every Posting leg, balances, reservation and Event after replacement",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 2_000, destinationCount: 4 } });
    const scenarios = [
      ["worker.effect-complete", ctx.legacyBody(catalog, 70)],
      ["worker.before-commit", ctx.multiBody(catalog, [30, 20, 10])],
    ];
    const recovered = [];
    for (const [point, body] of scenarios) {
      const transfer = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, body));
      const barrier = await ctx.workerBarrier(point, ({ aggregateId }) => aggregateId === transfer.transferId);
      const stale = await ctx.startWorkerAtBarrier(barrier);
      const held = await barrier.waitFor(({ json }) => json.aggregateId === transfer.transferId, { processes: [stale] });
      ctx.equal(`${point} payload stays exact across held state`, JSON.parse(held.raw), held.json);
      await ctx.kill(stale);
      const crashed = await ctx.snapshot(api.baseUrl);
      ctx.equal(`${point} leaves Transfer pending before commit`, transferFrom(crashed, transfer.transferId).state, "PENDING");
      ctx.equal(`${point} exposes no partial Posting`, postingsFor(crashed, transfer.transferId).length, 0, { failureCodeSuffix: "PARTIAL_POSTING", hardCapIds: ["CORRECTNESS_INVARIANT"] });
      ctx.equal(`${point} emits no rolled-back posted event`, eventsFor(crashed, transfer.transferId).map(({ type }) => type), ["transfer.created"]);
      await ctx.sleep(3_200);
      const replacement = await ctx.startWorker();
      await waitForTransfer(ctx, api.baseUrl, transfer.transferId, "POSTED", { processes: [replacement] });
      await ctx.stop(replacement);
      const final = await snapshot(ctx, api.baseUrl);
      const posting = postingsFor(final, transfer.transferId);
      ctx.equal(`${point} replacement commits exactly one Posting`, posting.length, 1, { failureCodeSuffix: "DUPLICATE_POSTING", hardCapIds: ["CORRECTNESS_INVARIANT"] });
      ctx.equal(`${point} Posting contains all required legs`, posting[0].legs.length, body.legs ? body.legs.length + 1 : 2);
      ctx.equal(`${point} replacement emits posted once`, eventsFor(final, transfer.transferId).map(({ type }) => type), ["transfer.created", "transfer.posted"]);
      recovered.push(transfer.transferId);
    }
    return { evidence: recovered };
  },
);

const C03 = defineCase(
  "C-03", "Committed and rolled-back Transfer events with receiver acknowledgement loss", "Commit create/post/cancel/reverse events, hold dispatcher.response-received after a complete response, SIGKILL and restart the dispatcher", "Match public event query to webhook headers/body, stable event identity and contiguous aggregate sequence with no rollback event",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, { catalogOptions: { sourceBalance: 500 } });
    const cancelled = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 20)));
    requireTransfer(ctx, await ctx.cancelTransfer(api.baseUrl, cancelled.transferId), { status: 200 });
    const reversed = requireTransfer(ctx, await ctx.createTransfer(api.baseUrl, ctx.legacyBody(catalog, 30, { destinationAccountId: catalog.destinations[1].accountId })));
    const worker = await ctx.startWorker();
    await waitForTransfer(ctx, api.baseUrl, reversed.transferId, "POSTED", { processes: [worker] });
    requireTransfer(ctx, await ctx.reverseTransfer(api.baseUrl, reversed.transferId));
    const bad = await ctx.cancelTransfer(api.baseUrl, reversed.transferId);
    ctx.equal("rolled-back terminal mutation returns conflict", bad.status, 409);
    const publicEvents = (await snapshot(ctx, api.baseUrl)).events;

    const attempts = new Map();
    const receiver = await ctx.receiver(({ json }) => {
      const count = (attempts.get(json?.eventId) ?? 0) + 1;
      attempts.set(json?.eventId, count);
      return { status: count === 1 && attempts.size > 1 ? 500 : 204 };
    });
    const barrier = await ctx.dispatcherBarrier();
    const firstDispatcher = await ctx.startDispatcherAtBarrier(receiver, barrier);
    const held = await barrier.waitFor(() => true, { processes: [firstDispatcher] });
    await ctx.kill(firstDispatcher);
    ctx.ok("dispatcher barrier follows a complete receiver response", receiver.ledger.length >= 1);
    const firstDelivery = receiver.ledger[0];
    const firstEventId = firstDelivery.json.eventId;
    await ctx.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => {
      const delivered = new Set(receiver.ledger.filter(({ acknowledged, responseStatus }) => acknowledged && responseStatus === 204).map(({ json }) => json?.eventId));
      return publicEvents.every(({ eventId }) => delivered.has(eventId));
    }, { timeoutMs: 60_000, label: "all public Domain Events acknowledged" });
    const retry = receiver.ledger.find((entry, index) => index > 0 && entry.json?.eventId === firstEventId);
    ctx.ok("unknown acknowledgement retries the same event", retry);
    ctx.equal("unknown acknowledgement preserves semantic body", retry.raw, firstDelivery.raw);
    ctx.equal("unknown acknowledgement preserves event id header", retry.headers["x-ledgerbridge-event-id"], firstDelivery.headers["x-ledgerbridge-event-id"]);
    ctx.equal("unknown acknowledgement preserves event type header", retry.headers["x-ledgerbridge-event-type"], firstDelivery.headers["x-ledgerbridge-event-type"]);
    for (const event of publicEvents) ctx.assert("delivered event keeps exact public wire", () => assertEvent(event));
    for (const aggregateId of [cancelled.transferId, reversed.transferId]) {
      const sequences = publicEvents.filter((event) => event.aggregateId === aggregateId).map(({ sequence }) => sequence);
      ctx.equal("aggregate Event sequence stays contiguous", sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
    }
    ctx.equal("failed cancel creates no event", publicEvents.filter(({ aggregateId }) => aggregateId === reversed.transferId).length, 3);
    return { evidence: [held.json.point, firstEventId, receiver.ledger.length] };
  },
);

const C04 = defineCase(
  "C-04", "F-RECOVERY same-createdAt ordered backlog", "Seed same-timestamp pending Transfers, hold the first two public claims across two workers, kill one, then drain with survivor and replacement", "Compare claim aggregate IDs to bytewise transferId order and require every retained Work terminal with one Posting and no stale commit",
  async (ctx) => {
    const catalog = ctx.catalog({ sourceBalance: 1_000, destinationCount: 10 });
    const createdAt = ctx.at({ seconds: 1 });
    const transfers = Array.from({ length: 10 }, (_, index) => ({
      transferId: ctx.uuid(`ordered-transfer:${index}`),
      sourceAccountId: catalog.source.accountId,
      destinationAccountId: catalog.destinations[index].accountId,
      currency: "USD", amountMinor: 1, state: "PENDING", createdAt, terminalAt: null,
    }));
    const { api } = await boot(ctx, { catalog, transfers });
    let heldCount = 0;
    const barrier = await ctx.workerBarrier("worker.claimed", () => heldCount++ < 2);
    const workers = [await ctx.startWorkerAtBarrier(barrier), await ctx.startWorkerAtBarrier(barrier)];
    await ctx.waitFor(() => barrier.ledger.length >= 2 ? barrier.ledger.slice(0, 2) : undefined, { label: "first two ordered claims", processes: workers });
    const firstClaims = barrier.ledger.slice(0, 2);
    const expectedFirst = transfers.map(({ transferId }) => transferId).sort(compareUtf8).slice(0, 2);
    ctx.equal("first two claims follow createdAt then bytewise transferId", firstClaims.map(({ json }) => json.aggregateId).sort(compareUtf8), expectedFirst);
    await ctx.kill(workers[0]);
    await ctx.waitFor(() => firstClaims.some(({ disconnected }) => disconnected), { label: "killed claim disconnect" });
    const survivingClaim = firstClaims.find(({ disconnected }) => !disconnected);
    ctx.ok("one held claim remains owned by the surviving worker", survivingClaim);
    barrier.release(survivingClaim);
    await ctx.sleep(3_200);
    const replacement = await ctx.startWorker();
    await ctx.waitFor(async () => {
      const state = await ctx.snapshot(api.baseUrl);
      return state.work.length === transfers.length && state.work.every(({ terminal }) => terminal) ? state : undefined;
    }, { timeoutMs: 60_000, intervalMs: 50, label: "ordered Settlement backlog drain", processes: [workers[1], replacement] });
    const final = await snapshot(ctx, api.baseUrl);
    ctx.equal("all ordered Transfers post", transfers.map(({ transferId }) => transferFrom(final, transferId).state), transfers.map(() => "POSTED"));
    for (const transfer of transfers) ctx.equal("each ordered Transfer posts once", postingsFor(final, transfer.transferId).length, 1, { failureCodeSuffix: "ORDERED_DUPLICATE", hardCapIds: ["CORRECTNESS_INVARIANT"] });
    ctx.equal("all terminal Work is retained", final.work.filter(({ terminal }) => terminal).length, transfers.length);
    return { evidence: [expectedFirst, final.work.map(({ attempt }) => attempt)] };
  },
);

export const C_CASES = [C01, C02, C03, C04];
