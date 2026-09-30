import { campaignRecoveryScenario, campaignControlScenario } from "./current-system.mjs";
import { canonicalJson } from "../oracles/index.mjs";
import {
  assertInvariants,
  cancelNotification,
  coreNotification,
  createNotification,
  finalEvidence,
  guardedCase,
  prepare,
  providerReceiver,
  resource,
  scriptedSeed,
  waitDelivery,
} from "./helpers.mjs";

const c01 = guardedCase({
  id: "C-01", fixtureFamily: "NR-F-UNKNOWN-PROCESS-CRASH",
  action: "Pause a real Webhook response after the receiver persists the request, SIGKILL the sending Worker, release the unknown response and recover with a replacement Worker.",
  oracle: "Recovery retains the original providerRequestId, delivery identity and canonical body, never creates a second logical Delivery, and fences the killed lease commit.",
  async run(ctx) {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const receiver = await providerReceiver(ctx, async (entry) => entry.attempt === 1 ? (await gate, { status: 204 }) : { status: 204 });
    const { seed } = scriptedSeed(ctx, receiver);
    const api = await (await prepare(ctx, { seed })).startApi();
    const { notification } = await createNotification(ctx, api.baseUrl, coreNotification(ctx, seed));
    const doomed = await ctx.startWorker();
    await ctx.waitFor(() => receiver.ledger.length === 1, { timeoutMs: 60_000, label: "persisted Provider request", processes: [doomed] });
    const first = receiver.ledger[0];
    await ctx.kill(doomed);
    release();
    const replacement = await ctx.startWorker();
    const snapshot = await waitDelivery(ctx, api.baseUrl, notification.notificationId, ["ACCEPTED", "DELIVERED"], { timeoutMs: 90_000, processes: [replacement] });
    const delivery = resource(snapshot, "deliveries").find(({ notificationId }) => notificationId === notification.notificationId);
    const calls = receiver.ledger.filter(({ headers }) => headers["x-notifyroute-delivery-id"] === delivery.deliveryId);
    ctx.ok(calls.length >= 1 && calls.length <= 2, "unknown external outcome uses at most one stable retry");
    for (const call of calls) {
      ctx.equal(call.headers["idempotency-key"], first.headers["idempotency-key"], "providerRequestId stays stable after crash");
      ctx.equal(call.raw, first.raw, "canonical Provider body stays stable after crash");
    }
    ctx.equal(resource(snapshot, "deliveries").filter(({ deliveryId }) => deliveryId === delivery.deliveryId).length, 1, "one business Delivery after recovery", { hardCapIds: ["WORK_FENCE_OR_LOSS"] });
    const attempts = resource(snapshot, "deliveryAttempts").filter(({ deliveryId }) => deliveryId === delivery.deliveryId);
    ctx.equal(new Set(attempts.map(({ providerRequestId }) => providerRequestId)).size, 1, "one Provider identity after recovery", { hardCapIds: ["WORK_FENCE_OR_LOSS"] });
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { killedWorkers: 1, replacements: 1, receiverCalls: calls.length, stableIdentity: true });
  },
});

const c02 = guardedCase({
  id: "C-02", fixtureFamily: "NR-F-OUTBOX-UNKNOWN-ACK",
  action: "Commit accepted and terminal events, let a receiver persist the first complete webhook then close its response, SIGKILL the dispatcher and start a replacement.",
  oracle: "At-least-once retry preserves eventId and canonical semantic body, loses no committed Event, and delivers unique events in increasing aggregate sequence.",
  async run(ctx) {
    const provider = await providerReceiver(ctx, () => ({ status: 204 }));
    const { seed } = scriptedSeed(ctx, provider);
    const target = await prepare(ctx, { seed });
    const api = await target.startApi();
    const { notification } = await createNotification(ctx, api.baseUrl, coreNotification(ctx, seed));
    await cancelNotification(ctx, api.baseUrl, notification.notificationId);
    const snapshot = await ctx.snapshot(api.baseUrl);
    const committed = snapshot.events.filter(({ aggregateId }) => aggregateId === notification.notificationId);
    ctx.ok(committed.length >= 2, "fixture commits ordered accepted and terminal Events");
    let first = true;
    const receiver = await ctx.receiver({ path: "/events", behavior: () => { if (first) { first = false; return { disconnect: true }; } return { status: 204 }; } });
    const doomed = await ctx.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(() => receiver.ledger.length >= 1, { timeoutMs: 60_000, label: "receiver persisted unknown-ack event", processes: [doomed] });
    await ctx.kill(doomed);
    const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const committedIds = new Set(committed.map(({ eventId }) => eventId));
    await ctx.waitFor(() => [...committedIds].every((id) => receiver.ledger.some(({ json }) => json?.eventId === id)) && receiver.ledger.filter(({ json }) => json?.eventId === committed[0].eventId).length >= 2, { timeoutMs: 60_000, label: "replacement ordered event recovery", processes: [replacement] });
    const duplicate = receiver.ledger.filter(({ json }) => json?.eventId === committed[0].eventId);
    for (const entry of duplicate) ctx.equal(canonicalJson(entry.json), canonicalJson(duplicate[0].json), "unknown-ACK event semantic body");
    const unique = new Map();
    for (const entry of receiver.ledger.filter(({ json }) => committedIds.has(json?.eventId))) if (!unique.has(entry.json.eventId)) unique.set(entry.json.eventId, entry.json);
    const sequences = [...unique.values()].filter(({ aggregateId }) => aggregateId === notification.notificationId).map(({ sequence }) => sequence);
    ctx.equal(sequences, [...sequences].sort((left, right) => left - right), "successful aggregate delivery order");
    ctx.equal(unique.size, committedIds.size, "no committed Event is lost", { hardCapIds: ["WORK_FENCE_OR_LOSS"] });
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { killedDispatchers: 1, replacements: 1, committedEvents: committedIds.size, firstEventAttempts: duplicate.length });
  },
});

const c03 = guardedCase({
  id: "C-03", fixtureFamily: "NR-F-CAMPAIGN-FANOUT-RECOVERY-CONTRACT",
  action: "Commit Campaign fan-out, restart the API and run concurrent and replacement workers on the same final database.",
  oracle: "Durable work closes every frozen recipient once and replacement workers do not duplicate fan-out.",
  run: ctx => campaignRecoveryScenario(ctx),
});

const c04 = guardedCase({
  id: "C-04", fixtureFamily: "NR-F-CAMPAIGN-CANCEL-RECOVERY-CONTRACT",
  action: "Commit pause and cancel, replace the API, then process independent Notification work with two workers.",
  oracle: "The durable cancellation fence survives replacement and prevents both member creation and provider send.",
  run: ctx => campaignControlScenario(ctx, { recover: true, cancel: true }),
});

export const C_CASES = Object.freeze([c01, c02, c03, c04]);
