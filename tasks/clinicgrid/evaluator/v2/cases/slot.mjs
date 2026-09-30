import { appointmentRequest } from "../fixtures/index.mjs";
import { interval, selectResources, sortWaitlist } from "../oracles/index.mjs";
import {
  assertInvariants,
  assertNoChange,
  calendar,
  coreSeed,
  createAppointment,
  createWaitlist,
  expectError,
  finalEvidence,
  guardedCase,
  resource,
  startPreparedApi,
  transitionAppointment,
  waitForDrain,
} from "./helpers.mjs";

const cap = ["CORRECTNESS_INVARIANT"];

const slot01 = guardedCase({
  id: "SLOT-01", fixtureFamily: "CG-F-SLOT-BOUNDARIES",
  action: "Create adjacent, overlapping, and millisecond-misaligned Appointment requests over public HTTP and inspect every resource calendar and snapshot effect.",
  oracle: "Independent half-open interval arithmetic accepts adjacency, rejects overlap or alignment error, and requires persisted 120-second expiry without partial Work or Event effects.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const firstRequest = appointmentRequest(seed, ctx.fixtures, { startAt: ctx.at({ hours: 1 }) });
    const before = Date.now();
    const first = await createAppointment(ctx, api.baseUrl, firstRequest);
    const after = Date.now();
    ctx.equal({ startAt: first.appointment.startAt, endAt: first.appointment.endAt }, interval(firstRequest.startAt, 30), "first interval");
    ctx.ok(Date.parse(first.appointment.expiresAt) >= before + 120_000 && Date.parse(first.appointment.expiresAt) <= after + 120_000, "expiresAt is 120 seconds after the database transaction");
    const adjacent = await createAppointment(ctx, api.baseUrl, appointmentRequest(seed, ctx.fixtures, { patientId: seed.patients[1].patientId, startAt: ctx.at({ hours: 1, minutes: 30 }) }));
    ctx.equal(adjacent.appointment.startAt, first.appointment.endAt, "half-open adjacent Appointment starts at prior end");
    const beforeOverlap = await ctx.snapshot(api.baseUrl);
    const overlap = await createAppointment(ctx, api.baseUrl, appointmentRequest(seed, ctx.fixtures, { patientId: seed.patients[2].patientId, startAt: ctx.at({ hours: 1, minutes: 15 }) }), { allowFailure: true });
    expectError(ctx, overlap, 409, "SLOT_UNAVAILABLE", "overlapping Appointment");
    assertNoChange(ctx, beforeOverlap, await ctx.snapshot(api.baseUrl), "overlap rejection");
    const oneMillisecondBeforeBoundary = await createAppointment(ctx, api.baseUrl, appointmentRequest(seed, ctx.fixtures, { patientId: seed.patients[3].patientId, startAt: new Date(Date.parse(first.appointment.endAt) - 1).toISOString() }), { allowFailure: true });
    expectError(ctx, oneMillisecondBeforeBoundary, 400, "INVALID_APPOINTMENT_INTERVAL", "one-millisecond boundary overlap");
    assertNoChange(ctx, beforeOverlap, await ctx.snapshot(api.baseUrl), "one-millisecond boundary rejection");
    const misaligned = await createAppointment(ctx, api.baseUrl, appointmentRequest(seed, ctx.fixtures, { patientId: seed.patients[3].patientId, startAt: ctx.at({ hours: 3, milliseconds: 1 }) }), { allowFailure: true });
    expectError(ctx, misaligned, 400, "INVALID_APPOINTMENT_INTERVAL", "misaligned Appointment");
    assertNoChange(ctx, beforeOverlap, await ctx.snapshot(api.baseUrl), "misalignment rejection");
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { adjacentAccepted: 2, invalidRejected: 3 });
  },
}, cap);

const slot02 = guardedCase({
  id: "SLOT-02", fixtureFamily: "CG-F-RESOURCE-ORDER",
  action: "Create four isolated feasible slots through the public Appointment API with multiple ordered Rooms and Equipment Units available for the complete intervals.",
  oracle: "An evaluator-owned full-interval allocator sorts Room and each required Equipment type by priority then identifier and compares every assigned resource exactly.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const created = [];
    for (let index = 0; index < 4; index += 1) {
      const request = appointmentRequest(seed, ctx.fixtures, { patientId: seed.patients[index].patientId, startAt: ctx.at({ hours: 1 + index }) });
      const expected = selectResources({ seed, request, activeAppointments: created });
      ctx.ok(expected, `fixture slot ${index} is feasible`);
      const { appointment } = await createAppointment(ctx, api.baseUrl, request);
      ctx.equal({ clinicianId: appointment.clinicianId, roomId: appointment.roomId, equipmentUnitIds: appointment.equipmentUnitIds, startAt: appointment.startAt, endAt: appointment.endAt }, expected, `deterministic resource selection ${index}`, { hardCapIds: cap });
      created.push(appointment);
    }
    const snapshot = await ctx.snapshot(api.baseUrl);
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { appointments: created.length, deterministicAssignments: true });
  },
}, cap);

const slot03 = guardedCase({
  id: "SLOT-03", fixtureFamily: "CG-F-ATOMIC-RESOURCE-BUNDLE",
  action: "Make the final required Equipment type unavailable for the requested complete interval, attempt a hold, and read all Clinician, Room and Equipment calendars before and after.",
  oracle: "Independent bundle allocation returns unavailable and exact snapshot/calendar deltas must be empty: no Appointment, assignment, expiry Work, Event, audit residue or ghost hold.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    for (const unit of seed.equipmentUnits.filter(({ equipmentType }) => equipmentType === "MRI")) unit.availability = [{ startAt: ctx.at({ days: -1 }), endAt: ctx.at({ minutes: 30 }) }];
    const api = await startPreparedApi(ctx, { seed });
    const request = appointmentRequest(seed, ctx.fixtures, { startAt: ctx.at({ hours: 1 }) });
    ctx.equal(selectResources({ seed, request }), null, "independent allocator sees unavailable final Equipment");
    const before = await ctx.snapshot(api.baseUrl);
    const calendars = await Promise.all([
      calendar(ctx, api.baseUrl, "clinicians", seed.clinicians[0].clinicianId, ctx.at(), ctx.at({ days: 1 })),
      calendar(ctx, api.baseUrl, "rooms", seed.rooms[0].roomId, ctx.at(), ctx.at({ days: 1 })),
      calendar(ctx, api.baseUrl, "equipment-units", seed.equipmentUnits[0].equipmentUnitId, ctx.at(), ctx.at({ days: 1 })),
    ]);
    const rejected = await createAppointment(ctx, api.baseUrl, request, { allowFailure: true });
    expectError(ctx, rejected, 409, "SLOT_UNAVAILABLE", "incomplete bundle hold");
    assertNoChange(ctx, before, await ctx.snapshot(api.baseUrl), "incomplete bundle hold");
    const calendarsAfter = await Promise.all([
      calendar(ctx, api.baseUrl, "clinicians", seed.clinicians[0].clinicianId, ctx.at(), ctx.at({ days: 1 })),
      calendar(ctx, api.baseUrl, "rooms", seed.rooms[0].roomId, ctx.at(), ctx.at({ days: 1 })),
      calendar(ctx, api.baseUrl, "equipment-units", seed.equipmentUnits[0].equipmentUnitId, ctx.at(), ctx.at({ days: 1 })),
    ]);
    ctx.equal(calendarsAfter, calendars, "every resource calendar remains unchanged", { hardCapIds: cap });
    return finalEvidence(ctx, { rejectedCompleteBundle: true, calendarCount: calendars.length });
  },
}, cap);

const slot04 = guardedCase({
  id: "SLOT-04", fixtureFamily: "CG-F-EXPIRY-BOUNDARY",
  action: "Confirm one fresh HELD Appointment with a two-second safety margin and process one publicly seeded due HELD Appointment through the real expiry Worker.",
  oracle: "Public transaction timing brackets the exact 120-second expiresAt; before-boundary confirmation and after-boundary persisted expiry each win once and release resources without resurrection.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const due = {
      appointmentId: ctx.uuid("due-appointment"), patientId: seed.patients[10].patientId, serviceTypeId: seed.serviceTypes[0].serviceTypeId,
      clinicianId: seed.clinicians[1].clinicianId, roomId: seed.rooms[2].roomId,
      equipmentUnitIds: [seed.equipmentUnits[1].equipmentUnitId, seed.equipmentUnits[3].equipmentUnitId],
      startAt: ctx.at({ days: 1, hours: 5 }), endAt: ctx.at({ days: 1, hours: 5, minutes: 30 }), state: "HELD",
      expiresAt: ctx.at({ days: -1 }), confirmedAt: null, terminalAt: null, sequence: 1,
    };
    seed.appointments.push(due);
    const api = await startPreparedApi(ctx, { seed });
    const started = Date.now();
    const fresh = await createAppointment(ctx, api.baseUrl, appointmentRequest(seed, ctx.fixtures, { startAt: ctx.at({ hours: 1 }) }));
    const finished = Date.now();
    ctx.ok(Date.parse(fresh.appointment.expiresAt) >= started + 120_000 && Date.parse(fresh.appointment.expiresAt) <= finished + 120_000, "fresh expiresAt is transaction time plus 120 seconds");
    ctx.ok(Date.parse(fresh.appointment.expiresAt) - Date.now() > 2_000, "confirm uses at least two seconds safety margin");
    const confirmed = await transitionAppointment(ctx, api.baseUrl, fresh.appointment.appointmentId, "confirm");
    ctx.equal(confirmed.appointment.state, "CONFIRMED", "strictly-before confirmation wins");
    const worker = await ctx.startWorker();
    const snapshot = await waitForDrain(ctx, api.baseUrl, { processes: [worker] });
    const expired = resource(snapshot, "appointments").find(({ appointmentId }) => appointmentId === due.appointmentId);
    ctx.equal(expired?.state, "EXPIRED", "persisted due Appointment expires");
    const afterExpiry = await transitionAppointment(ctx, api.baseUrl, due.appointmentId, "confirm", {}, { allowFailure: true, key: ctx.key("confirm-after-expiry") });
    expectError(ctx, afterExpiry, 409, "APPOINTMENT_EXPIRED", "confirm after persisted expiry");
    ctx.equal(resource(snapshot, "appointments").find(({ appointmentId }) => appointmentId === fresh.appointment.appointmentId)?.state, "CONFIRMED", "confirmed Appointment cannot be revived or expired");
    assertInvariants(ctx, snapshot);
    return ctx.pass({ diagnostics: [ctx.diagnostic("confirm-exactly-at-expires-at", "SPEC-GAP-CG-03")], evidence: [{ kind: "clinicgrid-case-summary", confirmed: 1, expired: 1 }] });
  },
}, cap);

const slot05 = guardedCase({
  id: "SLOT-05", fixtureFamily: "CG-F-WAITLIST-HEAD",
  action: "Fill the high-priority head interval, create a blocked head and a lower-priority feasible Waitlist Entry, run promotion, then cancel blockers and rerun Workers.",
  oracle: "Priority, joinedAt and identifier ordering plus earliest-slot resource search permits no bypass; opening the head produces exactly one earliest Appointment without changing joinedAt.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const api = await startPreparedApi(ctx, { seed });
    const slot = ctx.at({ hours: 1 });
    const blockers = [];
    for (let index = 0; index < 2; index += 1) blockers.push((await createAppointment(ctx, api.baseUrl, appointmentRequest(seed, ctx.fixtures, { patientId: seed.patients[index].patientId, clinicianId: seed.clinicians[index].clinicianId, startAt: slot }))).appointment);
    const headBody = { patientId: seed.patients[5].patientId, serviceTypeId: seed.serviceTypes[0].serviceTypeId, earliestStart: slot, latestEnd: ctx.at({ hours: 1, minutes: 30 }), priority: 100 };
    const laterBody = { patientId: seed.patients[6].patientId, serviceTypeId: seed.serviceTypes[0].serviceTypeId, earliestStart: ctx.at({ hours: 3 }), latestEnd: ctx.at({ hours: 3, minutes: 30 }), priority: 10 };
    const head = await createWaitlist(ctx, api.baseUrl, headBody);
    const later = await createWaitlist(ctx, api.baseUrl, laterBody);
    ctx.equal(sortWaitlist([later.item, head.item]).map(({ waitlistEntryId }) => waitlistEntryId), [head.item.waitlistEntryId, later.item.waitlistEntryId], "independent Waitlist order");
    const worker = await ctx.startWorker();
    let snapshot = await waitForDrain(ctx, api.baseUrl, { timeoutMs: 60_000, predicate: ({ kind }) => kind === "WAITLIST_PROMOTION", label: "blocked promotion attempts", processes: [worker] });
    ctx.equal(resource(snapshot, "waitlistEntries").find(({ waitlistEntryId }) => waitlistEntryId === later.item.waitlistEntryId)?.state, "WAITING", "later entry cannot bypass blocked head", { hardCapIds: cap });
    for (const appointment of blockers) await transitionAppointment(ctx, api.baseUrl, appointment.appointmentId, "cancel", { reason: "open head slot" });
    snapshot = await waitForDrain(ctx, api.baseUrl, { timeoutMs: 120_000, predicate: ({ kind }) => kind === "WAITLIST_PROMOTION", processes: [worker] });
    const promoted = resource(snapshot, "waitlistEntries").find(({ waitlistEntryId }) => waitlistEntryId === head.item.waitlistEntryId);
    ctx.equal(promoted?.state, "PROMOTED", "head promotes after resources open");
    ctx.equal(resource(snapshot, "appointments").find(({ appointmentId }) => appointmentId === promoted.appointmentId)?.startAt, slot, "head chooses earliest feasible slot");
    ctx.equal(promoted.joinedAt, head.item.joinedAt, "promotion never rewrites joinedAt");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { blockers: blockers.length, headPromoted: true, bypassed: false });
  },
}, cap);

export const SLOT_CASES = Object.freeze([slot01, slot02, slot03, slot04, slot05]);
