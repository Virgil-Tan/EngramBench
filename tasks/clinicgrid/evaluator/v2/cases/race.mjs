import { appointmentRequest, carePlanRequest } from "../fixtures/index.mjs";
import { canonicalJson } from "../oracles/index.mjs";
import {
  assertInvariants,
  calendar,
  coreSeed,
  createAppointment,
  createCarePlan,
  expectError,
  finalEvidence,
  guardedCase,
  launchBrowser,
  prepare,
  resource,
  terminateCarePlan,
  transitionVisit,
  waitForDrain,
} from "./helpers.mjs";

const cap = ["CORRECTNESS_INVARIANT"];
const EVENT_TYPES = new Set(["appointment.held", "appointment.confirmed", "appointment.cancelled", "appointment.expired", "waitlist.promoted"]);

async function droppedMutation(ctx, shield, path, key, body) {
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, path, key, body).catch(() => undefined);
  return ctx.waitFor(() => shield.captures.find(({ request, dropped }) => dropped && request.path === path), { timeoutMs: 30_000, label: `committed dropped response ${path}` });
}

async function replayAcross(ctx, apis, path, key, body, expected) {
  const results = await ctx.concurrent(Array.from({ length: 20 }, (_, index) => index), 20, (index) => ctx.mutate(apis[index % apis.length].baseUrl, path, key, body));
  for (const response of results) ctx.equal({ status: response.status, json: response.json }, expected, `durable replay ${path}`);
  return results;
}

const race01 = guardedCase({
  id: "RACE-01", fixtureFamily: "CG-F-DURABLE-RESPONSE-REPLAY",
  action: "Drop committed hold, per-visit confirm, and explicit Care Plan termination responses, restart an API, and issue twenty concurrent retries across two processes.",
  oracle: "Captured committed status and semantic JSON are immutable replay authority; each aggregate identity, sequence, Work and Event effect occurs once and changed semantics conflict.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const target = await prepare(ctx, { seed });
    let api1 = await target.startApi();
    const api2 = await target.startApi();

    const holdBody = appointmentRequest(seed, ctx.fixtures, { startAt: ctx.at({ hours: 1 }) });
    const holdKey = ctx.key("dropped-hold");
    let shield = await ctx.responseShield(api1.baseUrl);
    const holdCapture = await droppedMutation(ctx, shield, "/api/v1/appointments", holdKey, holdBody);
    const holdExpected = { status: holdCapture.response.status, json: JSON.parse(holdCapture.response.body) };
    ctx.equal(holdExpected.status, 201, "dropped hold committed");
    await ctx.kill(api1);
    api1 = await target.startApi();
    await replayAcross(ctx, [api1, api2], "/api/v1/appointments", holdKey, holdBody, holdExpected);
    const changedHold = await ctx.mutate(api2.baseUrl, "/api/v1/appointments", holdKey, { ...holdBody, patientId: seed.patients[1].patientId });
    expectError(ctx, changedHold, 409, "IDEMPOTENCY_CONFLICT", "changed hold replay");

    const plan = (await createCarePlan(ctx, api1.baseUrl, carePlanRequest(seed, ctx.fixtures, 3, { patientId: seed.patients[2].patientId }), { key: ctx.key("race-plan") })).plan;
    const confirmPath = `/api/v1/care-plans/${plan.carePlanId}/visits/2/confirm`;
    const confirmKey = ctx.key("dropped-member-confirm");
    shield = await ctx.responseShield(api2.baseUrl);
    const confirmCapture = await droppedMutation(ctx, shield, confirmPath, confirmKey, {});
    const confirmExpected = { status: confirmCapture.response.status, json: JSON.parse(confirmCapture.response.body) };
    ctx.equal(confirmExpected.status, 200, "dropped member confirmation committed");
    await replayAcross(ctx, [api1, api2], confirmPath, confirmKey, {}, confirmExpected);

    const terminatePath = `/api/v1/care-plans/${plan.carePlanId}/terminate`;
    const terminateKey = ctx.key("dropped-plan-termination");
    const terminateBody = { reason: "patient request" };
    shield = await ctx.responseShield(api1.baseUrl);
    const terminateCapture = await droppedMutation(ctx, shield, terminatePath, terminateKey, terminateBody);
    const terminateExpected = { status: terminateCapture.response.status, json: JSON.parse(terminateCapture.response.body) };
    ctx.equal(terminateExpected.status, 200, "dropped Plan termination committed");
    await replayAcross(ctx, [api1, api2], terminatePath, terminateKey, terminateBody, terminateExpected);
    const changedTermination = await ctx.mutate(api2.baseUrl, terminatePath, terminateKey, { reason: "different semantics" });
    expectError(ctx, changedTermination, 409, "IDEMPOTENCY_CONFLICT", "changed termination replay");

    const snapshot = await ctx.snapshot(api1.baseUrl);
    ctx.equal(resource(snapshot, "appointments").filter(({ appointmentId }) => appointmentId === holdExpected.json.appointmentId).length, 1, "one dropped hold effect");
    ctx.equal(resource(snapshot, "carePlans").find(({ carePlanId }) => carePlanId === plan.carePlanId), terminateExpected.json, "one terminal aggregate body");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { replayRequests: 60, apiProcesses: 2, droppedResponses: 3 });
  },
}, cap);

const race02 = guardedCase({
  id: "RACE-02", fixtureFamily: "CG-F-HOT-SLOT-CROSS-LAYER",
  action: "Send two groups of ten patient contenders for adjacent complete bundles concurrently through two APIs, then inspect OpenAPI, production UI, public calendars and snapshot.",
  oracle: "Half-open resource serialization yields exactly one HELD winner per interval and nine exact conflicts while adjacent winners share resources without overlap or ghost UI state.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const target = await prepare(ctx, { seed });
    const apis = [await target.startApi(), await target.startApi()];
    const slots = [ctx.at({ hours: 1 }), ctx.at({ hours: 1, minutes: 30 })];
    const attempts = slots.flatMap((startAt, slotIndex) => Array.from({ length: 10 }, (_, contender) => ({ slotIndex, contender, startAt })));
    const responses = await ctx.concurrent(attempts, 20, ({ slotIndex, contender, startAt }, index) => ctx.mutate(
      apis[index % 2].baseUrl,
      "/api/v1/appointments",
      ctx.key(`hot-${slotIndex}-${contender}`),
      appointmentRequest(seed, ctx.fixtures, { patientId: seed.patients[slotIndex * 10 + contender].patientId, startAt }),
    ));
    const winners = [];
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const group = responses.filter((_, index) => attempts[index].slotIndex === slotIndex);
      ctx.equal(group.filter(({ status }) => status === 201).length, 1, `one winner for hot slot ${slotIndex}`);
      ctx.equal(group.filter(({ status, json }) => status === 409 && json?.error?.code === "SLOT_UNAVAILABLE").length, 9, `nine exact conflicts for hot slot ${slotIndex}`);
      winners.push(group.find(({ status }) => status === 201).json);
    }
    ctx.equal(winners[0].endAt, winners[1].startAt, "adjacent winners meet at a half-open boundary");
    ctx.equal({ clinicianId: winners[1].clinicianId, roomId: winners[1].roomId, equipmentUnitIds: winners[1].equipmentUnitIds }, { clinicianId: winners[0].clinicianId, roomId: winners[0].roomId, equipmentUnitIds: winners[0].equipmentUnitIds }, "adjacent slots may reuse complete bundle");
    const openapi = await ctx.request(apis[0].baseUrl, "/openapi.json");
    ctx.ok(openapi.json?.paths?.["/api/v1/appointments"]?.post, "OpenAPI publishes contended mutation");
    const calendars = await Promise.all([
      calendar(ctx, apis[0].baseUrl, "clinicians", winners[0].clinicianId, slots[0], winners[1].endAt),
      calendar(ctx, apis[0].baseUrl, "rooms", winners[0].roomId, slots[0], winners[1].endAt),
      ...winners[0].equipmentUnitIds.map((id) => calendar(ctx, apis[0].baseUrl, "equipment-units", id, slots[0], winners[1].endAt)),
    ]);
    for (const value of calendars) for (const winner of winners) ctx.ok(JSON.stringify(value).includes(winner.appointmentId), "every resource calendar contains both adjacent winners");
    const { page } = await launchBrowser(ctx, apis[1].baseUrl);
    for (const winner of winners) ctx.ok(await page.getByText(winner.appointmentId, { exact: false }).first().isVisible(), "UI renders the persisted hot-slot winner");
    const snapshot = await ctx.snapshot(apis[0].baseUrl);
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { contenders: 20, winners: 2, conflicts: 18, apiProcesses: 2 });
  },
}, cap);

const race03 = guardedCase({
  id: "RACE-03", fixtureFamily: "CG-F-PLAN-EXPIRY-LEASE-FENCE",
  action: "Hold an expiry Worker at its published claimed barrier, SIGKILL it, race per-visit confirm with explicit Plan termination, then reclaim through a replacement Worker.",
  oracle: "Persisted expiry authority and lease fencing permit only a legal linear terminal aggregate, preserve any confirmed member, release each other bundle once, and fully drain Work.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const target = await prepare(ctx, { seed });
    const apis = [await target.startApi(), await target.startApi()];
    const plan = (await createCarePlan(ctx, apis[0].baseUrl, carePlanRequest(seed, ctx.fixtures, 2))).plan;
    const firstId = plan.visits[0].appointment.appointmentId;
    const barrier = await ctx.barrier({ hold: ({ point, aggregateId }) => point === "worker.claimed" && aggregateId === firstId });
    const doomed = await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const claimed = await barrier.waitFor(({ json }) => json?.point === "worker.claimed" && json.aggregateId === firstId, { timeoutMs: 140_000, intervalMs: 20, label: "due Plan member claim", processes: [doomed] });
    await ctx.kill(doomed);
    ctx.ok(claimed.disconnected || !claimed.released, "SIGKILL interrupts the claimed attempt");
    const [confirm, terminate] = await Promise.all([
      transitionVisit(ctx, apis[0].baseUrl, plan.carePlanId, 1, "confirm", {}, { allowFailure: true, key: ctx.key("expiry-race-confirm") }),
      terminateCarePlan(ctx, apis[1].baseUrl, plan.carePlanId, "race terminal", { allowFailure: true, key: ctx.key("expiry-race-terminate") }),
    ]);
    ctx.ok([200, 409].includes(confirm.status) && [200, 409].includes(terminate.status), "public terminal race has only contract outcomes");
    const replacement = await ctx.startWorker();
    const snapshot = await waitForDrain(ctx, apis[0].baseUrl, { timeoutMs: 45_000, intervalMs: 20, processes: [replacement] });
    const finalPlan = resource(snapshot, "carePlans").find(({ carePlanId }) => carePlanId === plan.carePlanId);
    ctx.equal(finalPlan?.state, "TERMINATED", "race closes Care Plan");
    ctx.equal(finalPlan?.expiresAt, null, "terminal race closes aggregate expiry");
    ctx.ok(finalPlan.visits.every(({ appointment }) => ["CONFIRMED", "CANCELLED", "EXPIRED"].includes(appointment.state)), "every member reaches a legal linear state");
    ctx.ok(finalPlan.visits.filter(({ appointment }) => appointment.state === "CONFIRMED").every(({ appointment }) => appointment.terminalAt === null), "confirmed member is never cancelled by stale work");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { killedWorkers: 1, replacementWorkers: 1, confirmStatus: confirm.status, terminateStatus: terminate.status });
  },
}, cap);

const race04 = guardedCase({
  id: "RACE-04", fixtureFamily: "CG-F-OUTBOX-UNKNOWN-ACK",
  action: "Deliver committed Appointment and Care Plan member events to a real receiver, hold the dispatcher after a complete response, SIGKILL it, and observe replacement retries.",
  oracle: "Parsed event identity, type and semantic body remain stable on unknown acknowledgement, and each aggregate is delivered in contiguous sequence without invented event names or secrets.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const target = await prepare(ctx, { seed });
    const api = await target.startApi();
    const standalone = (await createAppointment(ctx, api.baseUrl, appointmentRequest(seed, ctx.fixtures, { startAt: ctx.at({ hours: 1 }) }))).appointment;
    const plan = (await createCarePlan(ctx, api.baseUrl, carePlanRequest(seed, ctx.fixtures, 2, { patientId: seed.patients[2].patientId }))).plan;
    await transitionVisit(ctx, api.baseUrl, plan.carePlanId, 1, "confirm", {}, { key: ctx.key("outbox-member-confirm") });
    const snapshot = await ctx.snapshot(api.baseUrl);
    const receiver = await ctx.receiver(() => ({ status: 204 }));
    const barrier = await ctx.barrier({ hold: ({ point }) => point === "dispatcher.response-received" });
    const doomed = await ctx.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } });
    const held = await barrier.waitFor(({ json }) => json?.point === "dispatcher.response-received", { timeoutMs: 60_000, processes: [doomed] });
    await ctx.kill(doomed);
    const firstDelivery = receiver.ledger.find(({ json }) => json?.eventId === held.json.workId || json?.aggregateId === held.json.aggregateId) ?? receiver.ledger[0];
    ctx.ok(firstDelivery?.json, "receiver parsed a complete event before dispatcher crash");
    const replacement = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const committedIds = new Set(snapshot.events.map(({ eventId }) => eventId));
    await ctx.waitFor(() => committedIds.size > 0 && [...committedIds].every((id) => receiver.ledger.some(({ json }) => json?.eventId === id)), { timeoutMs: 60_000, intervalMs: 20, label: "replacement dispatcher delivery", processes: [replacement] });
    const duplicates = receiver.ledger.filter(({ json }) => json?.eventId === firstDelivery.json.eventId);
    ctx.ok(duplicates.length >= 2, "unknown acknowledgement retries the same event");
    for (const entry of duplicates) {
      ctx.equal(canonicalJson(entry.json), canonicalJson(firstDelivery.json), "retry semantic event body");
      ctx.equal(entry.headers["x-clinicgrid-event-id"], firstDelivery.json.eventId, "retry event identity header");
      ctx.equal(entry.headers["x-clinicgrid-event-type"], firstDelivery.json.type, "retry event type header");
    }
    const delivered = receiver.ledger.filter(({ json }) => committedIds.has(json?.eventId));
    for (const entry of delivered) {
      ctx.ok(EVENT_TYPES.has(entry.json.type), "dispatcher emits only published event types");
      ctx.equal(entry.json.payload, {}, "published event payload is empty");
      ctx.ok(!/(?:token|authorization|idempotency|postgres(?:ql)?:\/\/|\/Users\/|\/tmp\/)/iu.test(entry.raw), "delivery contains no token or private path");
    }
    const uniqueByAggregate = new Map();
    for (const entry of delivered) {
      const values = uniqueByAggregate.get(entry.json.aggregateId) ?? new Map();
      values.set(entry.json.eventId, entry.json.sequence);
      uniqueByAggregate.set(entry.json.aggregateId, values);
    }
    for (const values of uniqueByAggregate.values()) {
      const sequences = [...values.values()];
      ctx.equal(sequences, [...sequences].sort((left, right) => left - right), "per-aggregate delivery order");
    }
    ctx.ok(snapshot.events.some(({ aggregateId }) => aggregateId === standalone.appointmentId), "standalone Appointment event included");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { killedDispatchers: 1, committedEvents: committedIds.size, retriedEventId: firstDelivery.json.eventId });
  },
}, cap);

export const RACE_CASES = Object.freeze([race01, race02, race03, race04]);
