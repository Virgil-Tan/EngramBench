import {
  assertCapacityConservation, assertSnapshot, cancelPortCall, completePortCall, confirmPortCall, createPortCall, createStandby,
  crashAtBarrier, defineCase, expectError, finalEvidence, getPortCall, movementAction, prepare,
  startDockDispatcher, startDockWorker, startPortCall, waitForCallState, waitForMovementState, waitForWorkDrain,
} from "./helpers.mjs";

function dueSeed(ctx, fixture, suffix = "due") { const call = ctx.fixtures.portCall().v1Call(suffix, { arrivalAt: fixture.at({ days: 21 }), departureAt: fixture.at({ days: 21, hours: 2 }), expiresAt: "2020-01-01T00:00:00.000Z" }); return { call, seed: { ...fixture.seed, seedVersion: `${fixture.seed.seedVersion}-${suffix}`, portCalls: [call] } }; }

async function isolatedWorkScenario(ctx, fixture, kind, suffix) {
  await ctx.resetDatabase();
  if (kind === "PORT_CALL_EXPIRY") {
    const { call, seed } = dueSeed(ctx, fixture, suffix);
    const target = await prepare(ctx, { seed });
    return { target, api: await target.startApi(), aggregateId: call.portCallId };
  }
  const target = await prepare(ctx, { seed: { ...fixture.seed, seedVersion: `${fixture.seed.seedVersion}-${suffix}` } });
  const api = await target.startApi();
  if (kind === "CLEARANCE") {
    const call = await createPortCall(ctx, api.baseUrl, fixture.v1Payload(suffix, { arrivalAt: fixture.at({ days: 23 }), departureAt: fixture.at({ days: 23, hours: 2 }) }));
    await confirmPortCall(ctx, api.baseUrl, call.portCallId);
    return { target, api, aggregateId: call.portCallId };
  }
  const entry = await createStandby(ctx, api.baseUrl, fixture.standbyPayload(suffix, { arrivalFrom: fixture.at({ days: 24 }), arrivalTo: fixture.at({ days: 24, hours: 8 }) }));
  return { target, api, aggregateId: entry.standbyEntryId };
}

async function crashAndRecoverKind(ctx, fixture, kind, point, suffix) {
  const { target, api, aggregateId } = await isolatedWorkScenario(ctx, fixture, kind, suffix);
  const crashed = await crashAtBarrier(ctx, target, point, (payload) => payload.aggregateId === aggregateId);
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacement = await startDockWorker(target);
  const snapshot = await waitForWorkDrain(ctx, api.baseUrl, (work) => work.aggregateId === aggregateId && work.kind === kind, [replacement]);
  const work = snapshot.work.filter((item) => item.aggregateId === aggregateId && item.kind === kind);
  ctx.ok(work.length > 0 && work.every(({ terminal }) => terminal), `${kind} recovery terminal`);
  ctx.ok(Math.max(...work.map(({ attempt }) => attempt)) > crashed.entry.json.attempt, `${kind} replacement attempt`);
  assertCapacityConservation(snapshot);
  await Promise.all([ctx.stop(api), ctx.stop(replacement)]);
  return { aggregateId, crashedAttempt: crashed.entry.json.attempt, winningAttempt: Math.max(...work.map(({ attempt }) => attempt)) };
}

const C01 = defineCase({
  id: "C-01", fixtureFamily: "DC-F-WORK",
  action: "Create expiry, Clearance and Standby promotion Work through their public business flows, observe PENDING and LEASED states, drain them with real Workers, and read the retained terminal records.",
  oracle: "Every Work has the exact published kind and shape, lease fields exist only while LEASED, attempt and terminal flags are consistent, terminal Work remains visible, and drain means no matching nonterminal Work.",
  async run(ctx) {
    const fixture = ctx.fixtures.work(); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const call = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("work", { arrivalAt: fixture.at({ days: 21 }), departureAt: fixture.at({ days: 21, hours: 2 }) })); await confirmPortCall(ctx, api.baseUrl, call.portCallId); const standby = await createStandby(ctx, api.baseUrl, fixture.standbyPayload("work", { arrivalFrom: fixture.at({ days: 22 }), arrivalTo: fixture.at({ days: 22, hours: 8 }) })); const before = await ctx.snapshot(api.baseUrl); ctx.ok(before.work.some(({ kind, aggregateId, terminal }) => kind === "CLEARANCE" && aggregateId === call.portCallId && !terminal), "PENDING Clearance Work"); ctx.ok(before.work.some(({ kind, aggregateId }) => kind === "STANDBY_PROMOTION" && aggregateId === standby.standbyEntryId), "Standby promotion Work"); const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.aggregateId === call.portCallId }); const leasingWorker = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }); const claim = await barrier.waitFor(({ json }) => json?.point === "worker.claimed" && json?.aggregateId === call.portCallId, { timeoutMs: 120_000, processes: [leasingWorker] }); const leased = await ctx.snapshot(api.baseUrl); const leasedWork = leased.work.find(({ aggregateId, kind }) => aggregateId === call.portCallId && kind === "CLEARANCE"); ctx.equal(leasedWork.state, "LEASED", "Work observable while leased"); ctx.ok(leasedWork.leaseOwner && leasedWork.leaseExpiresAt, "leased Work publishes lease fields"); await barrier.release(claim); const workers = [leasingWorker, await startDockWorker(target)]; const drained = await waitForWorkDrain(ctx, api.baseUrl, ({ aggregateId }) => [call.portCallId, standby.standbyEntryId].includes(aggregateId), workers); assertSnapshot(ctx, drained); const targetWork = drained.work.filter(({ aggregateId }) => [call.portCallId, standby.standbyEntryId].includes(aggregateId)); ctx.ok(targetWork.every(({ terminal }) => terminal), "target Work retained terminal"); return finalEvidence(ctx, { workKinds: [...new Set(targetWork.map(({ kind }) => kind))], retained: targetWork.length, observedStates: ["PENDING", "LEASED", "terminal"] });
  },
});

const C02 = defineCase({
  id: "C-02", fixtureFamily: "DC-F-WORK",
  action: "Observe a real worker.claimed barrier for Clearance, due expiry and Standby promotion Work, SIGKILL each claiming Worker, wait for lease expiry, and start a replacement.",
  oracle: "Each replacement reclaims with a greater attempt, commits one legal effect, stale killed owners cannot terminalize, and no complete bundle, aggregate, Work or Event is lost or duplicated.",
  async run(ctx) {
    const fixture = ctx.fixtures.work(); const recoveries = []; for (const kind of ["CLEARANCE", "PORT_CALL_EXPIRY", "STANDBY_PROMOTION"]) recoveries.push(await crashAndRecoverKind(ctx, fixture, kind, "worker.claimed", `claimed-${kind.toLowerCase()}`)); return finalEvidence(ctx, { crashPoint: "worker.claimed", recoveries });
  },
});

const C03 = defineCase({
  id: "C-03", fixtureFamily: "DC-F-WORK",
  action: "Pause after worker.effect-complete for a Clearance decision and a Standby promotion decision, SIGKILL the Worker before commit, then recover both operations with replacements.",
  oracle: "The completed pure effect may be recomputed, but Port Call, Movement, allocation, Work and Event commit at most once and every target eventually reaches one non-hanging legal state.",
  async run(ctx) {
    const fixture = ctx.fixtures.work(); const recoveries = []; for (const kind of ["CLEARANCE", "STANDBY_PROMOTION"]) recoveries.push(await crashAndRecoverKind(ctx, fixture, kind, "worker.effect-complete", `effect-${kind.toLowerCase()}`)); return finalEvidence(ctx, { crashPoint: "worker.effect-complete", recoveries });
  },
});

const C04 = defineCase({
  id: "C-04", fixtureFamily: "DC-F-WORK",
  action: "Hold Clearance, expiry and promotion Workers at worker.before-commit, SIGKILL each process, wait for the lease to expire, and let independent replacement processes finish.",
  oracle: "Each interrupted transaction is wholly absent or commits exactly once after recovery, with no partial bundle, mixed aggregate state, orphan Event or permanently nonterminal Work.",
  async run(ctx) {
    const fixture = ctx.fixtures.work(); const recoveries = []; for (const kind of ["CLEARANCE", "PORT_CALL_EXPIRY", "STANDBY_PROMOTION"]) recoveries.push(await crashAndRecoverKind(ctx, fixture, kind, "worker.before-commit", `before-commit-${kind.toLowerCase()}`)); return finalEvidence(ctx, { crashPoint: "worker.before-commit", recoveries });
  },
});

const C05 = defineCase({
  id: "C-05", fixtureFamily: "DC-F-WORK",
  action: "Pause Worker A at before-commit past its lease, let Worker B reclaim and complete the exact Clearance Work, then release A and observe its stale completion attempt.",
  oracle: "Worker A's expired owner and token cannot alter terminal Work, aggregate, allocation or Event after B commits, and the final attempt and single effect belong to the replacement.",
  async run(ctx) {
    const fixture = ctx.fixtures.work();
    const target = await prepare(ctx, { seed: fixture.seed });
    const api = await target.startApi();
    const call = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("fence", { arrivalAt: fixture.at({ days: 29 }), departureAt: fixture.at({ days: 29, hours: 2 }) }));
    await confirmPortCall(ctx, api.baseUrl, call.portCallId);
    const barrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.before-commit" && payload.aggregateId === call.portCallId });
    const first = await target.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor(({ json }) => json?.aggregateId === call.portCallId && json?.point === "worker.before-commit", { timeoutMs: 120_000, processes: [first] });
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const replacement = await startDockWorker(target);
    const completed = await waitForCallState(ctx, api.baseUrl, call.portCallId, "CLEARED", [replacement]);
    const beforeRelease = JSON.stringify({ resources: completed.resources, work: completed.work, events: completed.events });
    await barrier.release(held);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const after = await ctx.snapshot(api.baseUrl);
    ctx.equal(JSON.stringify({ resources: after.resources, work: after.work, events: after.events }), beforeRelease, "stale completion is fenced");
    const work = after.work.filter(({ aggregateId, kind }) => aggregateId === call.portCallId && kind === "CLEARANCE");
    ctx.ok(work.every(({ terminal }) => terminal), "replacement terminalized Work");
    ctx.ok(Math.max(...work.map(({ attempt }) => attempt)) > held.json.attempt, "replacement owns later attempt");
    return finalEvidence(ctx, { portCallId: call.portCallId, staleAttempt: held.json.attempt, winningAttempt: Math.max(...work.map(({ attempt }) => attempt)) });
  },
});

const C06 = defineCase({
  id: "C-06", fixtureFamily: "DC-F-LINKED",
  action: "Race manual confirm and cancel transitions with obsolete expiry and Clearance Work on V1 Calls and linked Movements, then run Workers until every affected backlog closes.",
  oracle: "Obsolete expiry and Clearance Work becomes terminal or cancelled, late Workers cannot change the manual winner, Standby promotion converges, and no immortal nonterminal Work remains.",
  async run(ctx) {
    const fixture = ctx.fixtures.linked(); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const cancelled = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("manual-cancel", { arrivalAt: fixture.at({ days: 20 }), departureAt: fixture.at({ days: 20, hours: 2 }) })); await cancelPortCall(ctx, api.baseUrl, cancelled.portCallId); const linked = await createPortCall(ctx, api.baseUrl, fixture.linkedPayload("manual-linked"), { final: true }); const arrival = linked.movements[0]; await movementAction(ctx, api.baseUrl, linked.portCallId, arrival.movementId, "confirm"); await movementAction(ctx, api.baseUrl, linked.portCallId, arrival.movementId, "cancel"); const workers = [await startDockWorker(target), await startDockWorker(target)]; const snapshot = await ctx.waitFor(async () => { const value = await ctx.snapshot(api.baseUrl); const targets = value.work.filter(({ aggregateId }) => [cancelled.portCallId, arrival.movementId, linked.portCallId].includes(aggregateId)); return targets.length > 0 && targets.every(({ terminal }) => terminal) ? value : false; }, { timeoutMs: 120_000, label: "obsolete Work closure", processes: workers }); ctx.equal(snapshot.resources.portCalls.find(({ portCallId }) => portCallId === cancelled.portCallId).state, "CANCELLED", "manual Call cancellation wins"); ctx.equal(snapshot.resources.portMovements.find(({ movementId }) => movementId === arrival.movementId).state, "CANCELLED", "manual Movement cancellation wins"); ctx.ok(snapshot.work.filter(({ aggregateId }) => [cancelled.portCallId, arrival.movementId, linked.portCallId].includes(aggregateId)).every(({ terminal }) => terminal), "no immortal target Work"); assertCapacityConservation(snapshot); return finalEvidence(ctx, { cancelledPortCallId: cancelled.portCallId, cancelledMovementId: arrival.movementId });
  },
});

const C07 = defineCase({
  id: "C-07", fixtureFamily: "DC-F-EVENT",
  action: "Persist a webhook request at a receiver while disconnecting before ACK, SIGKILL the Dispatcher, then return 500 and finally 204 to its replacement while later aggregate Events queue behind it.",
  oracle: "Every retry keeps the exact eventId, type header and semantic body, successful delivery for each aggregate remains increasing by sequence, and ACK does not create a second Event identity.",
  async run(ctx) {
    const fixture = ctx.fixtures.event(); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const receiver = await ctx.receiver({ behavior: (entry) => entry.attempt === 1 ? { disconnect: true } : entry.attempt === 2 ? { status: 500 } : { status: 204 } }); const dispatcher = await startDockDispatcher(target, receiver); const call = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("delivery", { arrivalAt: fixture.at({ days: 18 }), departureAt: fixture.at({ days: 18, hours: 2 }) })); await ctx.waitFor(() => receiver.ledger.length >= 1, { timeoutMs: 120_000, label: "unknown webhook ACK", processes: [dispatcher] }); const firstEventId = receiver.ledger[0].headers["x-dockchain-event-id"]; await ctx.kill(dispatcher); await confirmPortCall(ctx, api.baseUrl, call.portCallId); const worker = await startDockWorker(target); await waitForCallState(ctx, api.baseUrl, call.portCallId, "CLEARED", [worker]); await startPortCall(ctx, api.baseUrl, call.portCallId); await completePortCall(ctx, api.baseUrl, call.portCallId); const replacement = await startDockDispatcher(target, receiver); const snapshot = await ctx.snapshot(api.baseUrl); const committed = snapshot.events.filter(({ aggregateId }) => aggregateId === call.portCallId); const successfulDeliveries = () => receiver.ledger.filter(({ acknowledged, responseStatus, raw }) => acknowledged && responseStatus >= 200 && responseStatus < 300 && JSON.parse(raw).aggregateId === call.portCallId); await ctx.waitFor(() => new Set(successfulDeliveries().map(({ headers }) => headers["x-dockchain-event-id"])).size === committed.length, { timeoutMs: 120_000, label: "ordered webhook backlog", processes: [replacement] }); const retries = receiver.ledger.filter(({ headers }) => headers["x-dockchain-event-id"] === firstEventId); ctx.ok(retries.length >= 3, "disconnect and 500 retried"); ctx.ok(retries.every(({ raw, headers }) => raw === retries[0].raw && headers["x-dockchain-event-type"] === retries[0].headers["x-dockchain-event-type"]), "retry identity and body stable"); const acknowledged = successfulDeliveries(); ctx.equal(acknowledged.map(({ raw }) => JSON.parse(raw).sequence), committed.map(({ sequence }) => sequence), "successful delivery preserves aggregate sequence"); ctx.equal(new Set(committed.map(({ eventId }) => eventId)).size, committed.length, "ACK invents no Event identity"); return finalEvidence(ctx, { eventId: firstEventId, attempts: retries.length, deliveredSequences: committed.map(({ sequence }) => sequence) });
  },
});

const C08 = defineCase({
  id: "C-08", fixtureFamily: "DC-F-LINKED",
  action: "Crash a linked Movement Clearance Worker at before-commit, recover it, submit a conflicting linked transition that rolls back, and deliver every committed V1-compatible Event through a restarted Dispatcher.",
  oracle: "Successful aggregate transitions and Events commit together, rollback emits none, linked state, Work and allocations converge even without invented movement event types, and snapshot, barrier and logs reveal no token or private path.",
  async run(ctx) {
    const fixture = ctx.fixtures.linked(); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const receiver = await ctx.receiver(); const dispatcher = await startDockDispatcher(target, receiver); const linked = await createPortCall(ctx, api.baseUrl, fixture.linkedPayload("transactional"), { final: true }); const arrival = linked.movements[0]; await movementAction(ctx, api.baseUrl, linked.portCallId, arrival.movementId, "confirm"); await crashAtBarrier(ctx, target, "worker.before-commit", (payload) => [arrival.movementId, linked.portCallId].includes(payload.aggregateId)); await ctx.kill(dispatcher); await new Promise((resolve) => setTimeout(resolve, 3_200)); const replacement = await startDockWorker(target); const replacementDispatcher = await startDockDispatcher(target, receiver); await waitForMovementState(ctx, api.baseUrl, arrival.movementId, "CLEARED", [replacement]); const beforeConflict = await ctx.snapshot(api.baseUrl); const conflict = await movementAction(ctx, api.baseUrl, linked.portCallId, arrival.movementId, "complete", { allowFailure: true }); expectError(ctx, conflict, 409, "MOVEMENT_STATE_CONFLICT", "complete before start"); const afterConflict = await ctx.snapshot(api.baseUrl); ctx.equal(afterConflict.events, beforeConflict.events, "rollback emits no Event"); ctx.equal(afterConflict.resources.portMovements, beforeConflict.resources.portMovements, "rollback changes no Movement"); const committed = afterConflict.events.filter(({ aggregateId }) => [linked.portCallId, arrival.movementId].includes(aggregateId)); await ctx.waitFor(() => new Set(receiver.ledger.filter(({ acknowledged }) => acknowledged).map(({ headers }) => headers["x-dockchain-event-id"])).size >= committed.length, { timeoutMs: 120_000, label: "linked Event delivery after Dispatcher restart", processes: [replacementDispatcher] }); const acknowledgedIds = new Set(receiver.ledger.filter(({ acknowledged }) => acknowledged).map(({ headers }) => headers["x-dockchain-event-id"])); ctx.ok(committed.every(({ eventId }) => acknowledgedIds.has(eventId)), "all committed linked Events delivered after restart"); assertSnapshot(ctx, afterConflict); return finalEvidence(ctx, { portCallId: linked.portCallId, movementId: arrival.movementId, committedEvents: committed.length, deliveredRequests: receiver.ledger.length });
  },
});

export const C_CASES = Object.freeze([C01, C02, C03, C04, C05, C06, C07, C08]);
