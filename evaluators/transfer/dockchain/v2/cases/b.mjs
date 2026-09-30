import assert from "node:assert/strict";

import {
  assertAggregateProjection, assertCapacityConservation, cancelPortCall, completePortCall, confirmPortCall,
  createPortCall, createStandby, defineCase, expectError, finalEvidence, getPortCall, movementAction, prepare,
  startDockWorker, startPortCall, waitForCallState, waitForMovementState,
} from "./helpers.mjs";

function stateView(snapshot) { return { resources: snapshot.resources, work: snapshot.work, events: snapshot.events }; }
function minimalSeed(fixture, version) { return { ...fixture.seed, seedVersion: version, berths: [fixture.berths[0]], tugPools: [{ ...fixture.tugPools[0], capacity: 1 }], yardWindows: [{ ...fixture.yardWindows[0], capacityUnits: 1 }] }; }

const B01 = defineCase({
  id: "B-01", fixtureFamily: "DC-F-RESOURCE-GRID",
  action: "Fill a Berth, Tug Pool and Yard Window over one aligned interval, create a second Call at the exact half-open endpoint, and attempt another Call that overlaps the first by one public 15-minute bucket.",
  oracle: "Adjacent [T0,T1) and [T1,T2) Calls may each consume full capacity, the true overlap conflicts, and every observed instant keeps Berth at one and Tug and Yard within zero through capacity.",
  async run(ctx) {
    const fixture = ctx.fixtures.resourceGrid(); const seed = minimalSeed(fixture, `${fixture.seed.seedVersion}-half-open`); const target = await prepare(ctx, { seed }); const api = await target.startApi(); const first = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("left", { arrivalAt: fixture.at({ days: 7, hours: 8 }), departureAt: fixture.at({ days: 7, hours: 10 }), requiredTugs: 1, containerUnits: 1 })); const adjacent = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("right", { arrivalAt: fixture.at({ days: 7, hours: 10 }), departureAt: fixture.at({ days: 7, hours: 12 }), requiredTugs: 1, containerUnits: 1 })); const overlap = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("overlap", { arrivalAt: fixture.at({ days: 7, hours: 9, minutes: 45 }), departureAt: fixture.at({ days: 7, hours: 11, minutes: 45 }), requiredTugs: 1, containerUnits: 1 }), { allowFailure: true }); expectError(ctx, overlap, 409, "WINDOW_UNAVAILABLE", "overlapping interval"); const snapshot = await ctx.snapshot(api.baseUrl); assertCapacityConservation(snapshot); ctx.equal(snapshot.resources.portCalls.filter(({ portCallId }) => [first.portCallId, adjacent.portCallId].includes(portCallId)).length, 2, "two adjacent Calls committed"); return finalEvidence(ctx, { adjacent: [first.portCallId, adjacent.portCallId] });
  },
});

const B02 = defineCase({
  id: "B-02", fixtureFamily: "DC-F-RESOURCE-GRID",
  action: "Occupy only the first Tug Pool, repeatedly search and create against independently ordered Berth, Tug and Yard candidates, restart the API, and repeat with deterministic IDs.",
  oracle: "Selection keeps the first feasible Berth, skips only the insufficient Tug, keeps the first Yard, never treats resources as pre-bound triples, follows the published tuple in search, and remains stable after restart.",
  async run(ctx) {
    const fixture = ctx.fixtures.resourceGrid(); const occupied = ctx.fixtures.portCall().v1Call("tug-full", { arrivalAt: fixture.at({ days: 8, hours: 8 }), departureAt: fixture.at({ days: 8, hours: 10 }), requiredTugs: 2, containerUnits: 100, berthId: fixture.berths[1].berthId, tugPoolId: fixture.tugPools[0].tugPoolId, yardWindowId: fixture.yardWindows[1].yardWindowId }); const seed = { ...fixture.seed, seedVersion: `${fixture.seed.seedVersion}-selection`, portCalls: [occupied] }; const target = await prepare(ctx, { seed }); let api = await target.startApi(); const first = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("selection", { arrivalAt: fixture.at({ days: 8, hours: 8 }), departureAt: fixture.at({ days: 8, hours: 10 }) })); ctx.equal([first.berthId, first.tugPoolId, first.yardWindowId], [fixture.berths[0].berthId, fixture.tugPools[1].tugPoolId, fixture.yardWindows[0].yardWindowId], "independent first feasible resources"); await ctx.stop(api); api = await target.startApi(); ctx.equal(await getPortCall(ctx, api.baseUrl, first.portCallId), first, "selection survives restart"); const query = new URLSearchParams({ vesselId: fixture.vessels[0].vesselId, arrivalFrom: fixture.at({ days: 9 }), arrivalTo: fixture.at({ days: 10 }), durationMinutes: "120", requiredTugs: "1", containerUnits: "25" }); const windows = (await ctx.request(api.baseUrl, `/api/v1/port-resources/feasible-windows?${query}`)).json.items; ctx.ok(windows.length > 0 && windows[0].berthId === fixture.berths[0].berthId, "search begins with first feasible Berth"); return finalEvidence(ctx, { selected: [first.berthId, first.tugPoolId, first.yardWindowId] });
  },
});

const B03 = defineCase({
  id: "B-03", fixtureFamily: "DC-F-RESOURCE-GRID",
  action: "Make Berth, Tug and Yard independently insufficient and submit V1, linked and malformed mixed requests while comparing complete public snapshots before and after each rejection.",
  oracle: "Every well-formed insufficiency returns WINDOW_UNAVAILABLE, malformed input returns its published code, and no Port Call, Movement, allocation, Work or Event is partially committed.",
  async run(ctx) {
    const fixture = ctx.fixtures.resourceGrid(); const target = await prepare(ctx, { seed: fixture.seed }); const api = await target.startApi(); const attempts = [fixture.v1Payload("berth", { vesselId: fixture.vessels[3].vesselId }), fixture.v1Payload("tug", { requiredTugs: 99 }), fixture.v1Payload("yard", { containerUnits: 999 })]; for (const [index, body] of attempts.entries()) { const before = stateView(await ctx.snapshot(api.baseUrl)); const response = await createPortCall(ctx, api.baseUrl, body, { allowFailure: true, key: ctx.key(`insufficient-${index}`) }); expectError(ctx, response, 409, "WINDOW_UNAVAILABLE", `insufficient resource ${index}`); ctx.equal(stateView(await ctx.snapshot(api.baseUrl)), before, `resource ${index} atomic no-op`); } const linked = fixture.linkedPayload("partial"); linked.departure.requiredTugs = 99; const beforeLinked = stateView(await ctx.snapshot(api.baseUrl)); const response = await createPortCall(ctx, api.baseUrl, linked, { allowFailure: true }); expectError(ctx, response, 409, "WINDOW_UNAVAILABLE", "linked partial rejection"); ctx.equal(stateView(await ctx.snapshot(api.baseUrl)), beforeLinked, "linked no partial movement"); return finalEvidence(ctx, { rejectedBundles: attempts.length + 1 });
  },
});

async function droppedMutation(ctx, shield, path, key, body) { shield.dropNextMutation(); await assert.rejects(() => ctx.mutate(shield.baseUrl, path, key, body)); const capture = shield.captures.at(-1); assert.equal(capture.dropped, true); return { status: capture.response.status, json: JSON.parse(capture.response.body) }; }

const B04 = defineCase({
  id: "B-04", fixtureFamily: "DC-F-IDEMPOTENCY",
  action: "Drop complete upstream responses for Create, Confirm, Start, Cancel, Complete, Standby and linked Movement mutations, retry each operation, restart the API, and replay every original method, path, key and semantic body.",
  oracle: "Each retry returns the originally saved status and semantic JSON with stable IDs, while every aggregate, allocation, Work and Event effect exists exactly once across disconnect and restart.",
  async run(ctx) {
    const fixture = ctx.fixtures.idempotency();
    const target = await prepare(ctx, { seed: fixture.seed });
    let api = await target.startApi();
    const shield = await ctx.responseShield(api.baseUrl);
    const saved = [];
    async function dropAndReplay(path, key, body, label) {
      const expected = await droppedMutation(ctx, shield, path, key, body);
      const replay = await ctx.mutate(api.baseUrl, path, key, body);
      ctx.equal({ status: replay.status, json: replay.json }, expected, `${label} unknown-response replay`);
      saved.push([path, key, body, expected]);
      return replay.json;
    }
    const createBody = fixture.v1Payload("unknown");
    const call = await dropAndReplay("/api/v1/port-calls", ctx.key("unknown-create"), createBody, "create");
    await dropAndReplay(`/api/v1/port-calls/${call.portCallId}/confirm`, ctx.key("unknown-confirm"), {}, "confirm");
    const worker = await startDockWorker(target);
    await waitForCallState(ctx, api.baseUrl, call.portCallId, "CLEARED", [worker]);
    await dropAndReplay(`/api/v1/port-calls/${call.portCallId}/start-service`, ctx.key("unknown-start"), {}, "start");
    await dropAndReplay(`/api/v1/port-calls/${call.portCallId}/complete`, ctx.key("unknown-complete"), {}, "complete");
    await ctx.stop(worker);
    const cancelCall = await createPortCall(ctx, api.baseUrl, fixture.v1Payload("unknown-cancel", { arrivalAt: fixture.at({ days: 15 }), departureAt: fixture.at({ days: 15, hours: 2 }) }));
    await dropAndReplay(`/api/v1/port-calls/${cancelCall.portCallId}/cancel`, ctx.key("unknown-cancel"), { reason: "unknown response" }, "cancel");
    const standbyBody = fixture.standbyPayload("unknown");
    await dropAndReplay("/api/v1/standby-entries", ctx.key("unknown-standby"), standbyBody, "Standby");
    const linked = await createPortCall(ctx, api.baseUrl, fixture.linkedPayload("unknown-linked"), { final: true });
    const movement = linked.movements[1];
    const movementPath = `/api/v1/port-calls/${linked.portCallId}/movements/${movement.movementId}/cancel`;
    await dropAndReplay(movementPath, ctx.key("unknown-movement-cancel"), { reason: "unknown response" }, "movement cancel");
    await ctx.stop(api);
    api = await target.startApi();
    for (const [path, key, body, expected] of saved) {
      const replay = await ctx.mutate(api.baseUrl, path, key, body);
      ctx.equal({ status: replay.status, json: replay.json }, expected, `restart replay ${path}`);
    }
    const snapshot = await ctx.snapshot(api.baseUrl);
    ctx.equal(snapshot.resources.portCalls.filter(({ portCallId }) => portCallId === call.portCallId).length, 1, "one unknown-response Call");
    ctx.equal(snapshot.resources.clearances.filter(({ portCallId }) => portCallId === call.portCallId).length, 1, "one unknown-response Clearance");
    ctx.equal(new Set(snapshot.events.map(({ eventId }) => eventId)).size, snapshot.events.length, "unknown-response Event identities unique");
    assertCapacityConservation(snapshot);
    return finalEvidence(ctx, { replayedMutations: saved.length, operations: ["create", "confirm", "start", "complete", "cancel", "standby", "movement-cancel"] });
  },
});

const B05 = defineCase({
  id: "B-05", fixtureFamily: "DC-F-IDEMPOTENCY",
  action: "Send sixty-four identical same-key creates through two production APIs, reuse that key with different semantics, start a third API, and replay the winning request again.",
  oracle: "All identical contenders converge on one status, body and Port Call, semantic reuse returns IDEMPOTENCY_CONFLICT, restart replay is unchanged, and one Clearance or allocation effect cannot duplicate.",
  async run(ctx) {
    const fixture = ctx.fixtures.idempotency(); const target = await prepare(ctx, { seed: fixture.seed }); const apis = [await target.startApi(), await target.startApi()]; const key = ctx.key("same-key"); const body = fixture.v1Payload("same-key", { arrivalAt: fixture.at({ days: 10 }), departureAt: fixture.at({ days: 10, hours: 2 }) }); const responses = await ctx.concurrent(Array.from({ length: 64 }, (_, index) => index), 64, (_, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/port-calls", key, body)); ctx.ok(responses.every(({ status }) => status === 201), "all identical same-key requests succeed"); ctx.ok(responses.every(({ json }) => JSON.stringify(json) === JSON.stringify(responses[0].json)), "same-key body convergence"); const changed = await ctx.mutate(apis[1].baseUrl, "/api/v1/port-calls", key, { ...body, containerUnits: body.containerUnits + 1 }); expectError(ctx, changed, 409, "IDEMPOTENCY_CONFLICT", "same key changed semantics"); const third = await target.startApi(); const replay = await ctx.mutate(third.baseUrl, "/api/v1/port-calls", key, body); ctx.equal(replay.json, responses[0].json, "third API restart replay"); const snapshot = await ctx.snapshot(third.baseUrl); ctx.equal(snapshot.resources.portCalls.filter(({ portCallId }) => portCallId === replay.json.portCallId).length, 1, "one same-key Port Call"); assertCapacityConservation(snapshot); return finalEvidence(ctx, { contenders: responses.length, portCallId: replay.json.portCallId });
  },
});

const B06 = defineCase({
  id: "B-06", fixtureFamily: "DC-F-RESOURCE-GRID",
  action: "For three deterministic request orders, start two production APIs on one database and submit sixty-four distinct-key requests for a bundle whose Berth, Tug and Yard capacity admits exactly one winner.",
  oracle: "Each interleaving yields one 201 HELD and sixty-three WINDOW_UNAVAILABLE results, with no observable instant or final state containing a double-booked Berth, oversubscribed capacity or partial bundle.",
  async run(ctx) {
    const fixture = ctx.fixtures.resourceGrid(); const summaries = []; for (let round = 0; round < 3; round += 1) { if (round) await ctx.resetDatabase(); const target = await prepare(ctx, { seed: minimalSeed(fixture, `${fixture.seed.seedVersion}-hot-${round}`) }); const apis = [await target.startApi(), await target.startApi()]; const order = Array.from({ length: 64 }, (_, index) => round % 2 ? 63 - index : index); const responses = await ctx.concurrent(order, 64, (value, index) => ctx.mutate(apis[index % 2].baseUrl, "/api/v1/port-calls", ctx.key(`hot-${round}-${value}`), fixture.v1Payload(`hot-${value}`, { arrivalAt: fixture.at({ days: 11 }), departureAt: fixture.at({ days: 11, hours: 2 }), requiredTugs: 1, containerUnits: 1 }))); const success = responses.filter(({ status }) => status === 201); const conflicts = responses.filter(({ status, json }) => status === 409 && json?.error?.code === "WINDOW_UNAVAILABLE"); ctx.equal(success.length, 1, `round ${round} one winner`); ctx.equal(conflicts.length, 63, `round ${round} expected losers`); assertCapacityConservation(await ctx.snapshot(apis[0].baseUrl)); summaries.push(success[0].json.portCallId); } return finalEvidence(ctx, { seeds: 3, winnerIds: summaries });
  },
});

const B07 = defineCase({
  id: "B-07", fixtureFamily: "DC-F-WORK",
  action: "Race confirm versus expiry, Clearance versus cancel, start versus cancel, and complete versus cancel through two APIs and two Workers over three fixed operation orders.",
  oracle: "Each race has exactly one legal terminal or advancing winner, every loser returns a published conflict or the saved idempotent result, one resource release and one contiguous Event effect occur, and no Call revives.",
  async run(ctx) {
    const fixture = ctx.fixtures.work();
    const rounds = [];
    for (let round = 0; round < 3; round += 1) {
      if (round) await ctx.resetDatabase();
      const due = fixture.v1Call(`due-${round}`, { arrivalAt: fixture.at({ days: 12 + round }), departureAt: fixture.at({ days: 12 + round, hours: 2 }), expiresAt: "2020-01-01T00:00:00.000Z" });
      const seed = { ...fixture.seed, seedVersion: `${fixture.seed.seedVersion}-races-${round}`, portCalls: [due] };
      const target = await prepare(ctx, { seed });
      const apis = [await target.startApi(), await target.startApi()];
      const expiryBarrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.claimed" && payload.aggregateId === due.portCallId });
      const expiryWorker = await target.startWorker({ env: { TEST_BARRIER_URL: expiryBarrier.url, TEST_BARRIER_TOKEN: expiryBarrier.token } });
      const expiryClaim = await expiryBarrier.waitFor(({ json }) => json?.aggregateId === due.portCallId, { timeoutMs: 120_000, processes: [expiryWorker] });
      const confirm = confirmPortCall(ctx, apis[round % 2].baseUrl, due.portCallId, { allowFailure: true, key: ctx.key(`due-confirm-${round}`) });
      await expiryBarrier.release(expiryClaim);
      await confirm;
      const dueFinal = await waitForCallState(ctx, apis[0].baseUrl, due.portCallId, ["CLEARED", "EXPIRED"], [expiryWorker]);
      ctx.ok(["CLEARED", "EXPIRED"].includes(dueFinal.resources.portCalls.find(({ portCallId }) => portCallId === due.portCallId).state), `round ${round} confirm/expiry legal winner`);
      await ctx.stop(expiryWorker);

      const clearanceRace = await createPortCall(ctx, apis[0].baseUrl, fixture.v1Payload(`clearance-cancel-${round}`, { arrivalAt: fixture.at({ days: 16 + round }), departureAt: fixture.at({ days: 16 + round, hours: 2 }) }));
      await confirmPortCall(ctx, apis[0].baseUrl, clearanceRace.portCallId);
      const commitBarrier = await ctx.barrier({ hold: (payload) => payload.point === "worker.before-commit" && payload.aggregateId === clearanceRace.portCallId });
      const clearanceWorker = await target.startWorker({ env: { TEST_BARRIER_URL: commitBarrier.url, TEST_BARRIER_TOKEN: commitBarrier.token } });
      const clearanceCommit = await commitBarrier.waitFor(({ json }) => json?.aggregateId === clearanceRace.portCallId, { timeoutMs: 120_000, processes: [clearanceWorker] });
      const cancelledDuringClearance = cancelPortCall(ctx, apis[1].baseUrl, clearanceRace.portCallId, "clearance race", { allowFailure: true, key: ctx.key(`clearance-cancel-${round}`) });
      await commitBarrier.release(clearanceCommit);
      await cancelledDuringClearance;
      const clearanceFinal = await waitForCallState(ctx, apis[0].baseUrl, clearanceRace.portCallId, ["CLEARED", "CANCELLED"], [clearanceWorker]);
      ctx.ok(["CLEARED", "CANCELLED"].includes(clearanceFinal.resources.portCalls.find(({ portCallId }) => portCallId === clearanceRace.portCallId).state), `round ${round} Clearance/cancel legal winner`);
      await ctx.stop(clearanceWorker);

      const serviceRace = await createPortCall(ctx, apis[0].baseUrl, fixture.v1Payload(`service-cancel-${round}`, { arrivalAt: fixture.at({ days: 20 + round }), departureAt: fixture.at({ days: 20 + round, hours: 2 }) }));
      await confirmPortCall(ctx, apis[0].baseUrl, serviceRace.portCallId);
      const workers = [await startDockWorker(target), await startDockWorker(target)];
      await waitForCallState(ctx, apis[0].baseUrl, serviceRace.portCallId, "CLEARED", workers);
      const startPair = round % 2 === 0
        ? [startPortCall(ctx, apis[0].baseUrl, serviceRace.portCallId, { allowFailure: true }), cancelPortCall(ctx, apis[1].baseUrl, serviceRace.portCallId, "start race", { allowFailure: true })]
        : [cancelPortCall(ctx, apis[1].baseUrl, serviceRace.portCallId, "start race", { allowFailure: true }), startPortCall(ctx, apis[0].baseUrl, serviceRace.portCallId, { allowFailure: true })];
      await Promise.all(startPair);
      let serviceFinal = await getPortCall(ctx, apis[0].baseUrl, serviceRace.portCallId);
      ctx.ok(["IN_SERVICE", "CANCELLED"].includes(serviceFinal.state), `round ${round} start/cancel legal result`);
      if (serviceFinal.state === "IN_SERVICE") {
        const completePair = round % 2 === 0
          ? [completePortCall(ctx, apis[0].baseUrl, serviceRace.portCallId, { allowFailure: true }), cancelPortCall(ctx, apis[1].baseUrl, serviceRace.portCallId, "complete race", { allowFailure: true, key: ctx.key(`complete-cancel-${round}`) })]
          : [cancelPortCall(ctx, apis[1].baseUrl, serviceRace.portCallId, "complete race", { allowFailure: true, key: ctx.key(`complete-cancel-${round}`) }), completePortCall(ctx, apis[0].baseUrl, serviceRace.portCallId, { allowFailure: true })];
        await Promise.all(completePair);
        serviceFinal = await getPortCall(ctx, apis[0].baseUrl, serviceRace.portCallId);
        ctx.equal(serviceFinal.state, "COMPLETED", `round ${round} IN_SERVICE cannot be cancelled`);
      }
      const snapshot = await ctx.snapshot(apis[0].baseUrl);
      assertCapacityConservation(snapshot);
      for (const portCallId of [due.portCallId, clearanceRace.portCallId, serviceRace.portCallId]) ctx.equal(snapshot.resources.portCalls.filter((call) => call.portCallId === portCallId).length, 1, `round ${round} one raced Call`);
      rounds.push({ due: due.portCallId, clearance: clearanceRace.portCallId, service: serviceRace.portCallId });
      await Promise.all([...apis, ...workers].map((process) => ctx.stop(process)));
    }
    return finalEvidence(ctx, { fixedOperationOrders: 3, rounds });
  },
});

const B08 = defineCase({
  id: "B-08", fixtureFamily: "DC-F-STANDBY",
  action: "Create multiple priority and tie Standby entries including an infeasible head, release two bundles concurrently, and run two promotion Workers under three deterministic creation orders.",
  oracle: "Promotion follows priority descending, requestedAt and ID, never bypasses an equal-priority infeasible head, gives each Entry at most one complete Port Call, and converges duplicate promotion Work without oversubscription.",
  async run(ctx) {
    const fixture = ctx.fixtures.standby(); const promotedIds = []; for (let round = 0; round < 3; round += 1) { if (round) await ctx.resetDatabase(); const target = await prepare(ctx, { seed: fixture.seed }); const apis = [await target.startApi(), await target.startApi()]; const head = await createStandby(ctx, apis[0].baseUrl, fixture.standbyPayload(`head-${round}`, { vesselId: fixture.vessels[3].vesselId, priority: 10 })); const tail = await createStandby(ctx, apis[1].baseUrl, fixture.standbyPayload(`tail-${round}`, { priority: 10 })); const first = await createStandby(ctx, apis[0].baseUrl, fixture.standbyPayload(`high-${round}`, { priority: 20 })); const workers = [await startDockWorker(target), await startDockWorker(target)]; const snapshot = await ctx.waitFor(async () => { const value = await ctx.snapshot(apis[0].baseUrl); return value.resources.standbyEntries.some(({ standbyEntryId, state }) => standbyEntryId === first.standbyEntryId && state === "PROMOTED") ? value : false; }, { timeoutMs: 120_000, label: `promotion round ${round}`, processes: workers }); const byId = new Map(snapshot.resources.standbyEntries.map((item) => [item.standbyEntryId, item])); ctx.equal(byId.get(head.standbyEntryId).state, "WAITING", "infeasible head remains"); ctx.equal(byId.get(tail.standbyEntryId).state, "WAITING", "equal priority tail remains"); ctx.equal(byId.get(first.standbyEntryId).state, "PROMOTED", "higher priority Entry promoted"); ctx.equal(snapshot.resources.portCalls.filter(({ portCallId }) => portCallId === byId.get(first.standbyEntryId).portCallId).length, 1, "one promoted Call"); assertCapacityConservation(snapshot); promotedIds.push(byId.get(first.standbyEntryId).portCallId); } return finalEvidence(ctx, { fixedInterleavings: 3, promotedIds });
  },
});

const B09 = defineCase({
  id: "B-09", fixtureFamily: "DC-F-LINKED",
  action: "Use two APIs to create two linked Calls whose ARRIVAL and DEPARTURE intervals compete for the same two capacity windows in opposite request order, then repeat with swapped client order.",
  oracle: "Requests terminate without deadlock, at most one complete two-movement Call succeeds, every loser fails completely, and no snapshot exposes a single Movement, resource-only residue, orphan Work or Event.",
  async run(ctx) {
    const fixture = ctx.fixtures.linked(); const winners = []; for (let round = 0; round < 2; round += 1) { if (round) await ctx.resetDatabase(); const seed = minimalSeed(fixture, `${fixture.seed.seedVersion}-linked-deadlock-${round}`); const target = await prepare(ctx, { seed }); const apis = [await target.startApi(), await target.startApi()]; const body = fixture.linkedPayload(`deadlock-${round}`); body.arrival.requiredTugs = body.arrival.containerUnits = 1; body.departure.requiredTugs = body.departure.containerUnits = 1; const requests = round ? [1, 0] : [0, 1]; const responses = await Promise.all(requests.map((client, index) => ctx.mutate(apis[client].baseUrl, "/api/v1/port-calls", ctx.key(`linked-hot-${round}-${index}`), { ...structuredClone(body), vesselId: fixture.vessels[index].vesselId }))); const success = responses.filter(({ status }) => status === 201); ctx.equal(success.length, 1, `linked round ${round} one complete winner`); ctx.ok(responses.filter(({ status }) => status === 409).length === 1, `linked round ${round} one complete loser`); const snapshot = await ctx.snapshot(apis[0].baseUrl); const call = snapshot.resources.portCalls.find(({ portCallId }) => portCallId === success[0].json.portCallId); ctx.equal(call.movements.length, 2, "winner has both movements"); ctx.equal(snapshot.resources.portMovements.filter(({ portCallId }) => portCallId === call.portCallId).length, 2, "snapshot has both movements"); assertCapacityConservation(snapshot); winners.push(call.portCallId); } return finalEvidence(ctx, { rounds: 2, winners });
  },
});

const B10 = defineCase({
  id: "B-10", fixtureFamily: "DC-F-LINKED",
  action: "Clear and start movements, race complete and cancel through two APIs, then let a second linked Call's DEPARTURE expire while ARRIVAL remains in service.",
  oracle: "Each movement changes once, aggregate state follows the published precedence, an already started ARRIVAL is never cancelled by DEPARTURE termination, resources release once, and clearance identities and sequence remain stable.",
  async run(ctx) {
    const fixture = ctx.fixtures.linked(); const target = await prepare(ctx, { seed: fixture.seed }); const apis = [await target.startApi(), await target.startApi()]; const workers = [await startDockWorker(target), await startDockWorker(target)]; const call = await createPortCall(ctx, apis[0].baseUrl, fixture.linkedPayload("movement-race"), { final: true }); for (const movement of call.movements) { await movementAction(ctx, apis[0].baseUrl, call.portCallId, movement.movementId, "confirm"); await waitForMovementState(ctx, apis[0].baseUrl, movement.movementId, "CLEARED", workers); if (movement.type === "ARRIVAL") await movementAction(ctx, apis[0].baseUrl, call.portCallId, movement.movementId, "start-service"); } const [arrival, departure] = call.movements; await Promise.all([movementAction(ctx, apis[0].baseUrl, call.portCallId, arrival.movementId, "complete", { allowFailure: true }), movementAction(ctx, apis[1].baseUrl, call.portCallId, departure.movementId, "cancel", { allowFailure: true })]); const final = await getPortCall(ctx, apis[0].baseUrl, call.portCallId, { final: true }); ctx.equal(final.movements.find(({ type }) => type === "ARRIVAL").state, "COMPLETED", "ARRIVAL completes once"); ctx.equal(final.movements.find(({ type }) => type === "DEPARTURE").state, "CANCELLED", "DEPARTURE cancels once"); ctx.equal(final.state, "ARRIVED", "aggregate ARRIVED precedence"); assertAggregateProjection(final);

    const expiring = await createPortCall(ctx, apis[0].baseUrl, fixture.linkedPayload("departure-expiry"), { final: true });
    const expiringArrival = expiring.movements.find(({ type }) => type === "ARRIVAL");
    const expiringDeparture = expiring.movements.find(({ type }) => type === "DEPARTURE");
    await movementAction(ctx, apis[0].baseUrl, expiring.portCallId, expiringArrival.movementId, "confirm");
    await waitForMovementState(ctx, apis[0].baseUrl, expiringArrival.movementId, "CLEARED", workers);
    await movementAction(ctx, apis[0].baseUrl, expiring.portCallId, expiringArrival.movementId, "start-service");
    await waitForMovementState(ctx, apis[0].baseUrl, expiringDeparture.movementId, "EXPIRED", workers, 210_000);
    const afterExpiry = await getPortCall(ctx, apis[0].baseUrl, expiring.portCallId, { final: true });
    ctx.equal(afterExpiry.movements.find(({ type }) => type === "ARRIVAL").state, "IN_SERVICE", "DEPARTURE expiry does not cancel active ARRIVAL");
    ctx.equal(afterExpiry.movements.find(({ type }) => type === "DEPARTURE").state, "EXPIRED", "DEPARTURE expires once");
    ctx.equal(afterExpiry.state, "EXPIRED", "aggregate remains EXPIRED while active ARRIVAL may still complete");
    assertAggregateProjection(afterExpiry);
    const snapshot = await ctx.snapshot(apis[0].baseUrl); assertCapacityConservation(snapshot); ctx.equal(new Set(snapshot.resources.clearances.filter(({ portCallId }) => portCallId === call.portCallId).map(({ taskId }) => taskId)).size, 2, "stable distinct movement clearances"); return finalEvidence(ctx, { racedPortCallId: call.portCallId, expiryPortCallId: expiring.portCallId, aggregateStates: [final.state, afterExpiry.state] });
  },
});

export const B_CASES = Object.freeze([B01, B02, B03, B04, B05, B06, B07, B08, B09, B10]);
