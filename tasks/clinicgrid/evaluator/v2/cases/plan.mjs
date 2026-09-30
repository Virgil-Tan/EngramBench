import { carePlanRequest } from "../fixtures/index.mjs";
import { planAggregate, terminatePlan } from "../oracles/index.mjs";
import {
  assertCarePlan,
  assertInvariants,
  assertNoChange,
  calendar,
  clickControl,
  coreSeed,
  createAppointment,
  createCarePlan,
  errorCode,
  expectError,
  finalEvidence,
  guardedCase,
  launchBrowser,
  resource,
  setControlValue,
  stableSnapshot,
  startPreparedApi,
  transitionAppointment,
  transitionVisit,
  waitForDrain,
} from "./helpers.mjs";

const cap = ["CORRECTNESS_INVARIANT"];

async function freshApi(ctx, seed) {
  await ctx.resetDatabase();
  return startPreparedApi(ctx, { seed });
}

const plan01 = guardedCase({
  id: "PLAN-01", fixtureFamily: "CG-F-PLAN-ATOMIC-GROUP",
  action: "Exercise one, two, twelve, and thirteen ordered visit requests over the public Care Plan endpoint, including an unavailable final visit.",
  oracle: "The evaluator freezes input order and independently requires two through twelve simultaneous HELD members or an exact zero-delta CARE_PLAN_UNAVAILABLE rejection.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    let api = await startPreparedApi(ctx, { seed });
    for (const count of [1, 13]) {
      const before = await ctx.snapshot(api.baseUrl);
      const rejected = await createCarePlan(ctx, api.baseUrl, carePlanRequest(seed, ctx.fixtures, count), { allowFailure: true, key: ctx.key(`invalid-count-${count}`) });
      expectError(ctx, rejected, 400, "INVALID_REQUEST", `${count}-visit Care Plan`);
      assertNoChange(ctx, before, await ctx.snapshot(api.baseUrl), `${count}-visit rejection`);
    }

    const pair = (await createCarePlan(ctx, api.baseUrl, carePlanRequest(seed, ctx.fixtures, 2))).plan;
    ctx.equal(pair.visits.map(({ visitIndex }) => visitIndex), [1, 2], "two visit input order");
    ctx.equal(pair.visits.map(({ appointment }) => appointment.state), ["HELD", "HELD"], "two visits held together");

    api = await freshApi(ctx, seed);
    const twelveRequest = carePlanRequest(seed, ctx.fixtures, 12, { patientId: seed.patients[1].patientId });
    const twelve = (await createCarePlan(ctx, api.baseUrl, twelveRequest)).plan;
    ctx.equal(twelve.visits.map(({ visitIndex }) => visitIndex), Array.from({ length: 12 }, (_, index) => index + 1), "twelve visit order");
    ctx.ok(twelve.visits.every(({ appointment }) => appointment.state === "HELD"), "all twelve visits held atomically");

    api = await freshApi(ctx, seed);
    const blockedRequest = carePlanRequest(seed, ctx.fixtures, 12, { patientId: seed.patients[2].patientId });
    const finalVisit = blockedRequest.visits.at(-1);
    await createAppointment(ctx, api.baseUrl, { ...finalVisit, patientId: seed.patients[3].patientId }, { key: ctx.key("twelfth-visit-blocker") });
    const beforeConflict = await ctx.snapshot(api.baseUrl);
    const unavailable = await createCarePlan(ctx, api.baseUrl, blockedRequest, { allowFailure: true, key: ctx.key("atomic-plan-conflict") });
    expectError(ctx, unavailable, 409, "CARE_PLAN_UNAVAILABLE", "unavailable twelfth visit");
    assertNoChange(ctx, beforeConflict, await ctx.snapshot(api.baseUrl), "atomic Care Plan rejection");
    assertInvariants(ctx, await ctx.snapshot(api.baseUrl));
    return finalEvidence(ctx, { validVisitCounts: [2, 12], invalidVisitCounts: [1, 13], atomicConflict: true });
  },
}, cap);

const plan02 = guardedCase({
  id: "PLAN-02", fixtureFamily: "CG-F-PLAN-AGGREGATE",
  action: "Create a three-visit Care Plan and confirm visits in a non-input order while reading the aggregate after every public member transition.",
  oracle: "A task-owned member-state oracle recomputes HELD, PARTIALLY_CONFIRMED, CONFIRMED and the minimum expiry among only remaining HELD visits.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    let plan = (await createCarePlan(ctx, api.baseUrl, carePlanRequest(seed, ctx.fixtures, 3))).plan;
    ctx.equal({ state: plan.state, expiresAt: plan.expiresAt }, planAggregate(plan.visits), "initial aggregate");
    const identities = plan.visits.map(({ appointment }) => ({ appointmentId: appointment.appointmentId, clinicianId: appointment.clinicianId, roomId: appointment.roomId, equipmentUnitIds: appointment.equipmentUnitIds }));
    for (const visitIndex of [2, 1, 3]) {
      plan = (await transitionVisit(ctx, api.baseUrl, plan.carePlanId, visitIndex, "confirm", {}, { key: ctx.key(`aggregate-confirm-${visitIndex}`) })).plan;
      ctx.equal({ state: plan.state, expiresAt: plan.expiresAt }, planAggregate(plan.visits), `aggregate after visit ${visitIndex}`);
      ctx.equal(plan.visits.map(({ appointment }) => ({ appointmentId: appointment.appointmentId, clinicianId: appointment.clinicianId, roomId: appointment.roomId, equipmentUnitIds: appointment.equipmentUnitIds })), identities, `member authority after visit ${visitIndex}`);
    }
    ctx.equal(plan.state, "CONFIRMED", "all-confirmed aggregate");
    ctx.equal(plan.expiresAt, null, "confirmed Care Plan has no held expiry");
    assertInvariants(ctx, await ctx.snapshot(api.baseUrl));
    return finalEvidence(ctx, { transitions: ["HELD", "PARTIALLY_CONFIRMED", "CONFIRMED"], visits: 3 });
  },
}, cap);

const plan03 = guardedCase({
  id: "PLAN-03", fixtureFamily: "CG-F-PLAN-MEMBER-AUTHORITY",
  action: "Confirm the third visit first, replay its durable response, request an invalid visit index, and retry the already terminal member through public APIs.",
  oracle: "Only the addressed Appointment changes once; every other visit identity, allocation and expiry stays byte-for-byte stable and aggregate sequence advances once.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const created = (await createCarePlan(ctx, api.baseUrl, carePlanRequest(seed, ctx.fixtures, 3))).plan;
    const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
    const key = ctx.key("visit-three-confirm-replay");
    const changed = (await transitionVisit(ctx, api.baseUrl, created.carePlanId, 3, "confirm", {}, { key })).plan;
    const replay = (await transitionVisit(ctx, api.baseUrl, created.carePlanId, 3, "confirm", {}, { key })).plan;
    ctx.equal(replay, changed, "member confirmation replay body");
    ctx.equal(changed.sequence, created.sequence + 1, "aggregate sequence advances once");
    ctx.equal(changed.visits.slice(0, 2), created.visits.slice(0, 2), "non-target visits remain exact");
    ctx.equal(changed.visits[2].appointment.state, "CONFIRMED", "target visit confirmed");

    const invalid = await transitionVisit(ctx, api.baseUrl, created.carePlanId, 99, "confirm", {}, { allowFailure: true, key: ctx.key("invalid-visit-index") });
    expectError(ctx, invalid, 404, "NOT_FOUND", "invalid visitIndex");
    const terminal = await transitionVisit(ctx, api.baseUrl, created.carePlanId, 3, "confirm", {}, { allowFailure: true, key: ctx.key("terminal-visit-confirm") });
    expectError(ctx, terminal, 409, "APPOINTMENT_NOT_CONFIRMABLE", "already confirmed visit");
    const after = await ctx.snapshot(api.baseUrl);
    const beforeEvents = before.events.filter(({ aggregateId }) => aggregateId === created.carePlanId || created.visits.some(({ appointment }) => appointment.appointmentId === aggregateId));
    const afterEvents = after.events.filter(({ aggregateId }) => aggregateId === created.carePlanId || created.visits.some(({ appointment }) => appointment.appointmentId === aggregateId));
    ctx.equal(afterEvents.length - beforeEvents.length, 1, "one transition event at most");
    ctx.equal(resource(after, "carePlans").find(({ carePlanId }) => carePlanId === created.carePlanId), changed, "snapshot matches replayed Care Plan");
    assertInvariants(ctx, after);
    return finalEvidence(ctx, { targetVisit: 3, replayStable: true, nonTargetVisits: 2 });
  },
}, cap);

const plan04 = guardedCase({
  id: "PLAN-04", fixtureFamily: "CG-F-PLAN-TERMINATION-FANOUT",
  action: "Confirm visit one then cancel visit two in the published three-visit example, and separately let a real Worker expire one visit of another Care Plan.",
  oracle: "Independent fanout preserves CONFIRMED visits, changes every remaining HELD visit to CANCELLED, releases only those bundles once, and closes aggregate expiry.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    let plan = (await createCarePlan(ctx, api.baseUrl, carePlanRequest(seed, ctx.fixtures, 3))).plan;
    plan = (await transitionVisit(ctx, api.baseUrl, plan.carePlanId, 1, "confirm", {}, { key: ctx.key("worked-confirm-one") })).plan;
    const calendarsBefore = await Promise.all(plan.visits.map(({ appointment }) => calendar(ctx, api.baseUrl, "clinicians", appointment.clinicianId, appointment.startAt, appointment.endAt)));
    plan = (await transitionVisit(ctx, api.baseUrl, plan.carePlanId, 2, "cancel", { reason: "patient changed schedule" }, { key: ctx.key("worked-cancel-two") })).plan;
    const expected = terminatePlan([
      { ...plan.visits[0], appointment: { ...plan.visits[0].appointment, state: "CONFIRMED" } },
      ...plan.visits.slice(1).map((visit) => ({ ...visit, appointment: { ...visit.appointment, state: "HELD" } })),
    ], plan.terminalAt).map(({ appointment }) => appointment.state);
    ctx.equal(plan.state, "TERMINATED", "cancellation terminates Care Plan");
    ctx.equal(plan.visits.map(({ appointment }) => appointment.state), expected, "published fanout member states");
    ctx.equal(plan.expiresAt, null, "terminated Care Plan closes expiry");
    const calendarsAfter = await Promise.all(plan.visits.map(({ appointment }) => calendar(ctx, api.baseUrl, "clinicians", appointment.clinicianId, appointment.startAt, appointment.endAt)));
    ctx.equal(Boolean(JSON.stringify(calendarsAfter[0]).includes(plan.visits[0].appointment.appointmentId)), true, "confirmed member allocation remains visible");
    ctx.ok(calendarsAfter.slice(1).every((value, index) => !JSON.stringify(value).includes(plan.visits[index + 1].appointment.appointmentId)), "cancelled member allocations are released");
    ctx.ok(calendarsBefore.every((value) => JSON.stringify(value).length > 0), "precondition calendars were public");
    const staleConfirm = await transitionVisit(ctx, api.baseUrl, plan.carePlanId, 3, "confirm", {}, { allowFailure: true, key: ctx.key("stale-confirm-three") });
    ctx.equal(errorCode(staleConfirm), "APPOINTMENT_NOT_CONFIRMABLE", "old confirm cannot revive cancelled visit");
    let snapshot = await waitForDrain(ctx, api.baseUrl, { timeoutMs: 30_000 });
    ctx.equal(resource(snapshot, "carePlans").find(({ carePlanId }) => carePlanId === plan.carePlanId), plan, "expiry Work cannot mutate terminated aggregate");

    const expiring = (await createCarePlan(ctx, api.baseUrl, {
      patientId: seed.patients[4].patientId,
      visits: [
        { serviceTypeId: seed.serviceTypes[0].serviceTypeId, clinicianId: seed.clinicians[0].clinicianId, startAt: ctx.at({ hours: 4 }) },
        { serviceTypeId: seed.serviceTypes[1].serviceTypeId, clinicianId: seed.clinicians[1].clinicianId, startAt: ctx.at({ hours: 5 }) },
      ],
    }, { key: ctx.key("expiry-fanout-plan") })).plan;
    const worker = await ctx.startWorker();
    snapshot = await ctx.waitFor(async () => {
      const value = await ctx.snapshot(api.baseUrl);
      const current = resource(value, "carePlans").find(({ carePlanId }) => carePlanId === expiring.carePlanId);
      return current?.state === "TERMINATED" ? value : false;
    }, { timeoutMs: 140_000, intervalMs: 20, label: "member expiry termination fanout", processes: [worker] });
    const expiredPlan = resource(snapshot, "carePlans").find(({ carePlanId }) => carePlanId === expiring.carePlanId);
    ctx.equal(expiredPlan.expiresAt, null, "expiry fanout closes aggregate expiry");
    ctx.equal(expiredPlan.visits.filter(({ appointment }) => appointment.state === "EXPIRED").length, 1, "one member expiry wins");
    ctx.equal(expiredPlan.visits.filter(({ appointment }) => appointment.state === "CANCELLED").length, 1, "other held member cancels atomically");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { confirmedPreserved: 1, cancelFanout: 2, expiryFanout: 2 });
  },
}, cap);

const plan05 = guardedCase({
  id: "PLAN-05", fixtureFamily: "CG-F-PLAN-WAITLIST-UI",
  action: "Use visible production controls to create one two-visit Waitlist head, observe blocked Work, release the complete combination, refresh, and inspect OpenAPI and snapshot.",
  oracle: "The entry remains one queue identity and creates no partial Appointment until both visits fit; promotion then links exactly one ordered Care Plan through persisted Work.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const blocker = (await createAppointment(ctx, api.baseUrl, {
      patientId: seed.patients[1].patientId, serviceTypeId: seed.serviceTypes[0].serviceTypeId,
      clinicianId: seed.clinicians[1].clinicianId, startAt: ctx.at({ hours: 2 }),
    }, { key: ctx.key("plan-waitlist-blocker") })).appointment;
    const openapi = await ctx.request(api.baseUrl, "/openapi.json");
    ctx.equal(openapi.status, 200, "OpenAPI is public");
    ctx.ok(openapi.json?.paths?.["/api/v1/waitlist-entries"]?.post, "OpenAPI publishes multi-shape Waitlist mutation");

    const { page } = await launchBrowser(ctx, api.baseUrl);
    await clickControl(page, ["link", "button"], [/waitlist/i, /new request/i]);
    const patient = page.getByLabel(/patient/i).first();
    const priority = page.getByLabel(/priority/i).first();
    await setControlValue(patient, seed.patients[8].patientId);
    await setControlValue(priority, "90");
    for (let index = 0; index < 2; index += 1) {
      if (index > 0) await clickControl(page, "button", [/add visit/i, /another visit/i]);
      await setControlValue(page.getByLabel(/service type/i).nth(index), seed.serviceTypes[0].serviceTypeId);
      await setControlValue(page.getByLabel(/clinician/i).nth(index), seed.clinicians[index].clinicianId);
      await setControlValue(page.getByLabel(/earliest/i).nth(index), ctx.at({ hours: index + 1 }));
      await setControlValue(page.getByLabel(/latest/i).nth(index), ctx.at({ hours: index + 1, minutes: 30 }));
    }
    await clickControl(page, "button", [/join waitlist/i, /create/i, /submit/i]);
    const item = await ctx.waitFor(async () => {
      const snapshot = await ctx.snapshot(api.baseUrl);
      return resource(snapshot, "carePlanWaitlistEntries").find(({ patientId }) => patientId === seed.patients[8].patientId);
    }, { timeoutMs: 30_000, label: "UI-created multi-visit Waitlist Entry" });
    const worker = await ctx.startWorker();
    await ctx.waitFor(async () => (await ctx.snapshot(api.baseUrl)).work.some(({ kind, terminal }) => kind === "WAITLIST_PROMOTION" && terminal), { timeoutMs: 60_000, label: "blocked multi-visit promotion", processes: [worker] });
    let snapshot = await ctx.snapshot(api.baseUrl);
    ctx.equal(resource(snapshot, "carePlanWaitlistEntries").find(({ waitlistEntryId }) => waitlistEntryId === item.waitlistEntryId)?.state, "WAITING", "combination conflict keeps one waiting entry");
    ctx.equal(resource(snapshot, "carePlans").filter(({ patientId }) => patientId === item.patientId).length, 0, "no partial Care Plan while blocked");
    await transitionAppointment(ctx, api.baseUrl, blocker.appointmentId, "cancel", { reason: "open complete combination" }, { key: ctx.key("open-plan-waitlist") });
    snapshot = await waitForDrain(ctx, api.baseUrl, { timeoutMs: 120_000, predicate: ({ kind }) => kind === "WAITLIST_PROMOTION", processes: [worker] });
    const promoted = resource(snapshot, "carePlanWaitlistEntries").find(({ waitlistEntryId }) => waitlistEntryId === item.waitlistEntryId);
    ctx.equal(promoted?.state, "PROMOTED", "multi-visit head promotes once");
    const carePlan = resource(snapshot, "carePlans").find(({ carePlanId }) => carePlanId === promoted.carePlanId);
    assertCarePlan(carePlan);
    ctx.equal(carePlan.visits.map(({ visitIndex }) => visitIndex), [1, 2], "promotion preserves visitIndex order");
    await page.reload({ waitUntil: "domcontentloaded" });
    ctx.ok(await page.getByText(carePlan.carePlanId, { exact: false }).first().isVisible(), "refreshed UI reads promoted Care Plan from HTTP");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { waitlistEntries: 1, promotedCarePlans: 1, chromiumRefresh: true });
  },
}, cap);

export const PLAN_CASES = Object.freeze([plan01, plan02, plan03, plan04, plan05]);
