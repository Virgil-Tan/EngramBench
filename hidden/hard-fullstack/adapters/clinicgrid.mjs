import assert from "node:assert/strict";

import { measuredLoad, percentile, performanceScale } from "../performance-runtime.mjs";
import { standardAdapter } from "../standard-adapter.mjs";

const ids = {
  clinicians: Array.from({ length: 3 }, (_, index) => uuid("31000000", index)),
  rooms: Array.from({ length: 2 }, (_, index) => uuid("32000000", index)),
  equipment: Array.from({ length: 2 }, (_, index) => uuid("33000000", index)),
  serviceType: uuid("34000000", 0),
  patients: Array.from({ length: 80 }, (_, index) => uuid("35000000", index)),
  dueAppointment: uuid("36000000", 0),
};

const serviceDurationMinutes = 15;
const actionStart = "2026-08-22T10:00:00.000Z";

const spec = {
  label: "ClinicGrid Appointment",
  performanceScenarioIds: ["availability-read", "competing-holds", "expiry-and-promotion-recovery"],
  seed: async () => seed(),
  path: "/api/v1/appointments",
  payload: (index) => appointmentPayload(index, actionStart),
  conflictPayload: (index) => ({ ...appointmentPayload(index, actionStart), startAt: addMinutes(actionStart, 15) }),
  resource: "appointments",
  identity: (value) => appointmentOf(value)?.appointmentId,
  workIdentity: (value) => appointmentOf(value)?.appointmentId,
  resourceIdentity: ({ appointmentId }) => appointmentId,
  prepareWork,
  cases: {
    "H-03": appointmentLifecycle,
    "H-04": atomicRejection,
    "H-06": resourceContention,
    "H-09": v1Migration,
    "H-10": carePlanAtomicityAndTermination,
    "H-11": carePlanWaitlistRecovery,
  },
  performance: runPerformance,
};

export default standardAdapter(spec);

function uuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function addMinutes(timestamp, minutes) {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

function seed() {
  const availability = [{ startAt: "2026-08-18T00:00:00.000Z", endAt: "2027-09-01T00:00:00.000Z" }];
  return {
    schemaVersion: 1,
    seedVersion: "hidden-clinicgrid-v1",
    clinicians: ids.clinicians.map((clinicianId, index) => ({
      clinicianId,
      name: `Hidden Clinician ${index + 1}`,
      priority: index + 1,
      availability,
    })),
    rooms: ids.rooms.map((roomId, index) => ({
      roomId,
      name: `Hidden Room ${index + 1}`,
      priority: index + 1,
      availability,
    })),
    equipmentUnits: ids.equipment.map((equipmentUnitId, index) => ({
      equipmentUnitId,
      equipmentType: "scanner",
      priority: index + 1,
      availability,
    })),
    serviceTypes: [{
      serviceTypeId: ids.serviceType,
      name: "Hidden scan",
      durationMinutes: serviceDurationMinutes,
      requiredEquipmentTypes: ["scanner"],
    }],
    patients: ids.patients.map((patientId, index) => ({ patientId, name: `Hidden Patient ${index + 1}` })),
    appointments: [{
      appointmentId: ids.dueAppointment,
      patientId: ids.patients[0],
      serviceTypeId: ids.serviceType,
      clinicianId: ids.clinicians[2],
      roomId: ids.rooms[0],
      equipmentUnitIds: [ids.equipment[0]],
      startAt: "2026-08-19T00:00:00.000Z",
      endAt: "2026-08-19T00:15:00.000Z",
      state: "HELD",
      expiresAt: "2026-01-01T00:00:00.000Z",
      confirmedAt: null,
      terminalAt: null,
      sequence: 1,
    }],
    waitlistEntries: [],
  };
}

function appointmentPayload(index = 0, startAt = actionStart, clinicianId = ids.clinicians[0]) {
  return {
    patientId: ids.patients[(index + 1) % ids.patients.length],
    serviceTypeId: ids.serviceType,
    clinicianId,
    startAt,
  };
}

function appointmentOf(value) {
  return value?.appointment ?? value;
}

function carePlanOf(value) {
  return value?.carePlan ?? value;
}

function waitlistOf(value) {
  return value?.carePlanWaitlistEntry ?? value?.waitlistEntry ?? value;
}

function stable(snapshot) {
  const { asOf: _asOf, ...value } = snapshot;
  return value;
}

async function setup(ctx, workspace = ctx.workspace) {
  await ctx.prepare(workspace);
  const imported = await ctx.seed(seed(), workspace);
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return ctx.startApi(workspace);
}

async function createAppointment(ctx, baseUrl, key, payload = appointmentPayload()) {
  const response = await ctx.mutate(baseUrl, "/api/v1/appointments", key, payload);
  assert.equal(response.status, 201, response.text);
  const appointment = appointmentOf(response.json);
  assert.equal(appointment.state, "HELD");
  return { response, appointment, payload };
}

async function createCarePlan(ctx, baseUrl, key, payload) {
  const response = await ctx.mutate(baseUrl, "/api/v1/care-plans", key, payload);
  assert.equal(response.status, 201, response.text);
  const carePlan = carePlanOf(response.json);
  assert.equal(carePlan.state, "HELD");
  return { response, carePlan, payload };
}

async function readCarePlan(ctx, baseUrl, carePlanId) {
  const response = await ctx.request(baseUrl, `/api/v1/care-plans/${carePlanId}`);
  assert.equal(response.status, 200, response.text);
  return carePlanOf(response.json);
}

async function prepareWork(ctx, baseUrl) {
  const snapshot = await ctx.snapshot(baseUrl);
  assert.ok(snapshot.work.some(({ aggregateId, kind, terminal }) => (
    aggregateId === ids.dueAppointment && kind === "APPOINTMENT_EXPIRY" && !terminal
  )), "seeded due Appointment did not create pending expiry Work");
  return { json: { appointmentId: ids.dueAppointment } };
}

async function appointmentLifecycle(ctx, assertions) {
  const api = await setup(ctx);
  const holdStartedAt = Date.now();
  const { appointment } = await createAppointment(ctx, api.baseUrl, "h03-create", appointmentPayload(1));
  const holdFinishedAt = Date.now();
  assert.equal(appointment.roomId, ids.rooms[0]);
  assert.deepEqual(appointment.equipmentUnitIds, [ids.equipment[0]]);
  assert.ok(Date.parse(appointment.expiresAt) >= holdStartedAt + 120_000);
  assert.ok(Date.parse(appointment.expiresAt) <= holdFinishedAt + 120_000);

  const confirmedResponse = await ctx.mutate(
    api.baseUrl,
    `/api/v1/appointments/${appointment.appointmentId}/confirm`,
    "h03-confirm",
    {},
  );
  assert.equal(confirmedResponse.status, 200, confirmedResponse.text);
  const confirmed = appointmentOf(confirmedResponse.json);
  assert.equal(confirmed.state, "CONFIRMED");

  const calendar = await ctx.request(
    api.baseUrl,
    `/api/v1/resources/clinician/${appointment.clinicianId}/calendar?from=${encodeURIComponent(appointment.startAt)}&to=${encodeURIComponent(appointment.endAt)}`,
  );
  assert.equal(calendar.status, 200, calendar.text);
  assert.match(calendar.text, new RegExp(appointment.appointmentId, "u"));

  const snapshot = await ctx.snapshot(api.baseUrl);
  const persisted = snapshot.resources.appointments.find(({ appointmentId }) => appointmentId === appointment.appointmentId);
  assert.equal(persisted.state, "CONFIRMED");
  assert.deepEqual(
    snapshot.events.filter(({ aggregateId }) => aggregateId === appointment.appointmentId).map(({ type, sequence }) => ({ type, sequence })),
    [
      { type: "appointment.held", sequence: 1 },
      { type: "appointment.confirmed", sequence: 2 },
    ],
  );
  assertions.push("Appointment uses deterministic resources, confirms through HTTP, appears on the public calendar, and emits contiguous events");
}

async function atomicRejection(ctx, assertions) {
  const api = await setup(ctx);
  const before = await ctx.snapshot(api.baseUrl);
  const invalid = await ctx.mutate(api.baseUrl, "/api/v1/appointments", "h04-invalid", {
    ...appointmentPayload(2),
    startAt: "2026-08-22T10:07:00.000Z",
  });
  assert.equal(invalid.status, 400, invalid.text);
  assert.equal(invalid.json?.error?.code, "INVALID_APPOINTMENT_INTERVAL");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(before));

  await createAppointment(ctx, api.baseUrl, "h04-base", appointmentPayload(3));
  const occupied = await ctx.snapshot(api.baseUrl);
  const unavailable = await ctx.mutate(api.baseUrl, "/api/v1/appointments", "h04-unavailable", appointmentPayload(4));
  assert.equal(unavailable.status, 409, unavailable.text);
  assert.equal(unavailable.json?.error?.code, "SLOT_UNAVAILABLE");
  assert.deepEqual(stable(await ctx.snapshot(api.baseUrl)), stable(occupied));
  assertions.push("misaligned and unavailable holds leave Appointments, resources, Work, and Events unchanged");
}

async function resourceContention(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const results = await ctx.concurrent(Array.from({ length: 64 }), 64, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/appointments",
    `h06-hold-${index}`,
    appointmentPayload(index + 5),
  ));
  assert.equal(results.filter(({ status }) => status === 201).length, 1);
  assert.equal(results.filter(({ status, json }) => status === 409 && json?.error?.code === "SLOT_UNAVAILABLE").length, 63);
  const snapshot = await ctx.snapshot(apiB.baseUrl);
  const active = snapshot.resources.appointments.filter(({ startAt, state }) => startAt === actionStart && ["HELD", "CONFIRMED"].includes(state));
  assert.equal(active.length, 1);
  assert.equal(new Set(active.flatMap(({ roomId, equipmentUnitIds }) => [roomId, ...equipmentUnitIds])).size, 2);
  assertions.push("64 competing requests across two APIs elect one complete Clinician, Room, and Equipment bundle");
}

async function v1Migration(ctx, assertions) {
  const v1Workspace = await ctx.copyV1Workspace();
  const v1Api = await setup(ctx, v1Workspace);
  const created = await createAppointment(ctx, v1Api.baseUrl, "h09-saved", appointmentPayload(9));
  const confirmed = await ctx.mutate(
    v1Api.baseUrl,
    `/api/v1/appointments/${created.appointment.appointmentId}/confirm`,
    "h09-confirm",
    {},
  );
  assert.equal(confirmed.status, 200, confirmed.text);
  const v1Snapshot = await ctx.snapshot(v1Api.baseUrl);
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/appointments", "h09-saved", created.payload);
  assert.equal(replay.status, created.response.status);
  assert.equal(replay.text, created.response.text);
  const migrated = await ctx.snapshot(finalApi.baseUrl);
  const expectedKeys = [...ctx.contract.snapshot.resources, ...ctx.contract.snapshot.managerResources]
    .map(({ key }) => key)
    .sort();
  assert.deepEqual(Object.keys(migrated.resources).sort(), expectedKeys);
  assert.deepEqual(
    migrated.events.filter(({ aggregateId }) => aggregateId === created.appointment.appointmentId),
    v1Snapshot.events.filter(({ aggregateId }) => aggregateId === created.appointment.appointmentId),
  );
  assert.deepEqual(
    migrated.work.filter(({ aggregateId }) => aggregateId === created.appointment.appointmentId),
    v1Snapshot.work.filter(({ aggregateId }) => aggregateId === created.appointment.appointmentId),
  );

  const managerPayload = carePlanPayload(ids.patients[20], "2026-08-24T10:00:00.000Z", 2);
  const manager = await createCarePlan(ctx, finalApi.baseUrl, "h09-manager", managerPayload);
  assert.equal(manager.carePlan.visits.length, 2);
  assertions.push("V1 response replay, Appointment state, Work, and Events survive FINAL migration before new Care Plan state is created");
}

function carePlanPayload(patientId, startAt, visitCount, clinicianId = ids.clinicians[0]) {
  return {
    patientId,
    visits: Array.from({ length: visitCount }, (_, index) => ({
      serviceTypeId: ids.serviceType,
      clinicianId,
      startAt: addMinutes(startAt, index * serviceDurationMinutes),
    })),
  };
}

async function carePlanAtomicityAndTermination(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const rejectedPlan = carePlanPayload(ids.patients[1], "2026-08-23T00:00:00.000Z", 12);
  const unavailableVisit = rejectedPlan.visits.at(-1);
  await createAppointment(ctx, apiA.baseUrl, "h10-blocker", {
    patientId: ids.patients[60],
    ...unavailableVisit,
  });
  const beforeRejected = await ctx.snapshot(apiA.baseUrl);
  const rejected = await ctx.mutate(apiA.baseUrl, "/api/v1/care-plans", "h10-rejected-plan", rejectedPlan);
  assert.equal(rejected.status, 409, rejected.text);
  assert.equal(rejected.json?.error?.code, "CARE_PLAN_UNAVAILABLE");
  assert.deepEqual(stable(await ctx.snapshot(apiA.baseUrl)), stable(beforeRejected));

  const payload = carePlanPayload(ids.patients[2], "2026-08-24T00:00:00.000Z", 12);
  const { carePlan } = await createCarePlan(ctx, apiA.baseUrl, "h10-plan", payload);
  assert.deepEqual(carePlan.visits.map(({ visitIndex }) => visitIndex), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(new Set(carePlan.visits.map(({ appointment }) => appointment.appointmentId)).size, 12);

  const confirmedResponse = await ctx.mutate(
    apiA.baseUrl,
    `/api/v1/care-plans/${carePlan.carePlanId}/visits/1/confirm`,
    "h10-confirm-first",
    {},
  );
  assert.equal(confirmedResponse.status, 200, confirmedResponse.text);
  const partial = await readCarePlan(ctx, apiA.baseUrl, carePlan.carePlanId);
  assert.equal(partial.state, "PARTIALLY_CONFIRMED");
  assert.equal(partial.visits[0].appointment.state, "CONFIRMED");

  const terminalRace = await Promise.all([
    ctx.mutate(
      apiA.baseUrl,
      `/api/v1/care-plans/${carePlan.carePlanId}/visits/2/cancel`,
      "h10-cancel-visit",
      { reason: "Harness cancellation" },
    ),
    ctx.mutate(
      apiB.baseUrl,
      `/api/v1/care-plans/${carePlan.carePlanId}/terminate`,
      "h10-terminate-plan",
      { reason: "Harness termination" },
    ),
  ]);
  assert.equal(terminalRace.filter(({ status }) => status === 200).length, 1);
  assert.equal(terminalRace.filter(({ status }) => status === 409).length, 1);

  const terminated = await readCarePlan(ctx, apiB.baseUrl, carePlan.carePlanId);
  assert.equal(terminated.state, "TERMINATED");
  assert.equal(terminated.visits[0].appointment.state, "CONFIRMED");
  assert.equal(terminated.visits.slice(1).every(({ appointment }) => appointment.state === "CANCELLED"), true);

  const occupied = await ctx.mutate(apiA.baseUrl, "/api/v1/appointments", "h10-confirmed-slot", {
    ...payload.visits[0],
    patientId: ids.patients[30],
  });
  assert.equal(occupied.status, 409, occupied.text);
  assert.equal(occupied.json?.error?.code, "SLOT_UNAVAILABLE");
  for (let index = 1; index < payload.visits.length; index += 1) {
    await createAppointment(ctx, apiA.baseUrl, `h10-rehold-${index}`, {
      ...payload.visits[index],
      patientId: ids.patients[30 + index],
    });
  }

  const snapshot = await ctx.snapshot(apiA.baseUrl);
  for (const { appointment } of terminated.visits.slice(1)) {
    assert.equal(
      snapshot.events.filter(({ aggregateId, type }) => aggregateId === appointment.appointmentId && type === "appointment.cancelled").length,
      1,
    );
  }
  assertions.push("a 12-visit plan rolls back completely on one unavailable visit; partial confirmation and cancel/terminate racing preserve confirmed work and release every remaining bundle once");
}

function multiVisitWaitlistPayload(patientId, priority, clinicians, starts) {
  return {
    patientId,
    priority,
    visits: clinicians.map((clinicianId, index) => ({
      serviceTypeId: ids.serviceType,
      clinicianId,
      earliestStart: starts[index],
      latestEnd: addMinutes(starts[index], serviceDurationMinutes),
    })),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function createWaitlist(ctx, baseUrl, key, payload) {
  const response = await ctx.mutate(baseUrl, "/api/v1/waitlist-entries", key, payload);
  assert.equal(response.status, 201, response.text);
  return waitlistOf(response.json);
}

async function carePlanWaitlistRecovery(ctx, assertions) {
  const apiA = await setup(ctx);
  const apiB = await ctx.startApi();
  const startAt = "2026-08-26T10:00:00.000Z";
  const blocker = await createAppointment(ctx, apiA.baseUrl, "h11-blocker", {
    patientId: ids.patients[63],
    serviceTypeId: ids.serviceType,
    clinicianId: ids.clinicians[0],
    startAt,
  });

  const head = await createWaitlist(ctx, apiA.baseUrl, "h11-head", multiVisitWaitlistPayload(
    ids.patients[64],
    100,
    [ids.clinicians[0], ids.clinicians[2]],
    [startAt, startAt],
  ));
  const tail = await createWaitlist(ctx, apiB.baseUrl, "h11-tail", multiVisitWaitlistPayload(
    ids.patients[65],
    90,
    [ids.clinicians[1], ids.clinicians[1]],
    [startAt, addMinutes(startAt, 15)],
  ));
  assert.equal(head.state, "WAITING");
  assert.equal(tail.state, "WAITING");

  const pending = await ctx.snapshot(apiA.baseUrl);
  const initialPromotionWork = pending.work.filter(({ kind, terminal }) => kind === "WAITLIST_PROMOTION" && !terminal);
  assert.ok(initialPromotionWork.length > 0, "multi-visit waitlists scheduled no promotion Work");
  const initialWorkIds = new Set(initialPromotionWork.map(({ workId }) => workId));
  const inspected = deferred();
  const initialBarrier = await ctx.receiver((entry) => (
    entry.json?.point === "worker.effect-complete" && initialWorkIds.has(entry.json?.workId)
      ? inspected.promise
      : { status: 204 }
  ));
  const initialWorkers = [
    await ctx.startWorker({ TEST_BARRIER_URL: initialBarrier.url, TEST_BARRIER_TOKEN: "h11-head-check" }),
    await ctx.startWorker({ TEST_BARRIER_URL: initialBarrier.url, TEST_BARRIER_TOKEN: "h11-head-check" }),
  ];
  await ctx.waitFor(() => initialBarrier.ledger.some(({ json }) => (
    json?.point === "worker.effect-complete" && initialWorkIds.has(json?.workId)
  )), { label: "blocked waitlist head evaluation", children: initialWorkers });
  inspected.resolve({ status: 204 });
  const blocked = await ctx.snapshot(apiB.baseUrl);
  assert.equal(blocked.resources.carePlans.length, 0);
  assert.equal(blocked.resources.carePlanWaitlistEntries.every(({ state }) => state === "WAITING"), true);
  await Promise.all(initialWorkers.map((worker) => ctx.stop(worker)));

  const cancelled = await ctx.mutate(
    apiA.baseUrl,
    `/api/v1/appointments/${blocker.appointment.appointmentId}/cancel`,
    "h11-release-head",
    { reason: "Make the queue head eligible" },
  );
  assert.equal(cancelled.status, 200, cancelled.text);
  const promotable = await ctx.snapshot(apiA.baseUrl);
  const recoveryWork = promotable.work.filter(({ kind, terminal }) => kind === "WAITLIST_PROMOTION" && !terminal);
  assert.ok(recoveryWork.length > 0, "resource release scheduled no promotion recovery Work");
  const recoveryWorkIds = new Set(recoveryWork.map(({ workId }) => workId));

  const beforeCommit = deferred();
  const recoveryBarrier = await ctx.receiver((entry) => (
    entry.json?.point === "worker.before-commit" && recoveryWorkIds.has(entry.json?.workId)
      ? beforeCommit.promise
      : { status: 204 }
  ));
  const killed = await ctx.startWorker({ TEST_BARRIER_URL: recoveryBarrier.url, TEST_BARRIER_TOKEN: "h11-recovery" });
  await ctx.waitFor(() => recoveryBarrier.ledger.some(({ json }) => (
    json?.point === "worker.before-commit" && recoveryWorkIds.has(json?.workId)
  )), { label: "multi-visit promotion before-commit barrier", children: [killed] });
  await ctx.stop(killed, "SIGKILL");
  beforeCommit.resolve({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));

  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const recovered = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiB.baseUrl);
    const currentHead = snapshot.resources.carePlanWaitlistEntries.find(({ waitlistEntryId }) => waitlistEntryId === head.waitlistEntryId);
    return currentHead?.state === "PROMOTED" ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "multi-visit head promotion recovery", children: replacements });

  const promotedHead = recovered.resources.carePlanWaitlistEntries.find(({ waitlistEntryId }) => waitlistEntryId === head.waitlistEntryId);
  const blockedTail = recovered.resources.carePlanWaitlistEntries.find(({ waitlistEntryId }) => waitlistEntryId === tail.waitlistEntryId);
  assert.equal(blockedTail.state, "WAITING");
  assert.equal(recovered.resources.carePlans.filter(({ carePlanId }) => carePlanId === promotedHead.carePlanId).length, 1);
  const promotedPlan = recovered.resources.carePlans.find(({ carePlanId }) => carePlanId === promotedHead.carePlanId);
  assert.equal(promotedPlan.visits.length, 2);
  assert.equal(new Set(promotedPlan.visits.map(({ appointment }) => appointment.appointmentId)).size, 2);
  assert.equal(
    recovered.events.filter(({ aggregateId, type }) => aggregateId === head.waitlistEntryId && type === "waitlist.promoted").length,
    1,
  );
  assertions.push("a feasible lower-priority multi-visit entry cannot bypass a blocked head, and a before-commit SIGKILL recovers one atomic two-visit promotion");
}

function perfUuid(namespace, ordinal) {
  return `${namespace}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

const perf = {
  clinicians: 2_000,
  rooms: 2_000,
  equipment: 4_000,
  serviceTypes: 20,
  patients: 100_000,
  confirmed: 50_000,
  due: 1_000,
  waitlist: 1_000,
};

function perfServiceTypeId(index) {
  return perfUuid("41000000", index);
}

function perfClinicianId(index) {
  return perfUuid("42000000", index);
}

function perfRoomId(index) {
  return perfUuid("43000000", index);
}

function perfEquipmentId(index) {
  return perfUuid("44000000", index);
}

function perfPatientId(index) {
  return perfUuid("45000000", index);
}

function perfAppointmentId(index) {
  return perfUuid("46000000", index);
}

function perfWaitlistId(index) {
  return perfUuid("47000000", index);
}

function perfSlot(base, slot) {
  return new Date(Date.parse(base) + slot * serviceDurationMinutes * 60_000).toISOString();
}

function performanceSeed() {
  const availability = [{ startAt: "2026-01-01T00:00:00.000Z", endAt: "2031-01-01T00:00:00.000Z" }];
  const clinicians = Array.from({ length: perf.clinicians }, (_, index) => ({
    clinicianId: perfClinicianId(index),
    name: `Clinician ${index}`,
    priority: index + 1,
    availability,
  }));
  const rooms = Array.from({ length: perf.rooms }, (_, index) => ({
    roomId: perfRoomId(index),
    name: `Room ${index}`,
    priority: index + 1,
    availability,
  }));
  const equipmentUnits = Array.from({ length: perf.equipment }, (_, index) => ({
    equipmentUnitId: perfEquipmentId(index),
    equipmentType: `equipment-${Math.floor(index / 200)}`,
    priority: (index % 200) + 1,
    availability,
  }));
  const serviceTypes = Array.from({ length: perf.serviceTypes }, (_, index) => ({
    serviceTypeId: perfServiceTypeId(index),
    name: `Service ${index}`,
    durationMinutes: serviceDurationMinutes,
    requiredEquipmentTypes: [`equipment-${index}`],
  }));
  const patients = Array.from({ length: perf.patients }, (_, index) => ({
    patientId: perfPatientId(index),
    name: `Patient ${index}`,
  }));
  const appointments = Array.from({ length: perf.confirmed + perf.due }, (_, index) => {
    const serviceIndex = index % perf.serviceTypes;
    const clinicianIndex = index % perf.clinicians;
    const roomIndex = index % perf.rooms;
    const equipmentIndex = serviceIndex * 200 + (Math.floor(index / perf.serviceTypes) % 200);
    const isConfirmed = index < perf.confirmed;
    const slot = isConfirmed ? Math.floor(index / perf.clinicians) : 200;
    const startAt = perfSlot("2027-01-01T00:00:00.000Z", slot);
    return {
      appointmentId: perfAppointmentId(index),
      patientId: perfPatientId(index),
      serviceTypeId: perfServiceTypeId(serviceIndex),
      clinicianId: perfClinicianId(clinicianIndex),
      roomId: perfRoomId(roomIndex),
      equipmentUnitIds: [perfEquipmentId(equipmentIndex)],
      startAt,
      endAt: addMinutes(startAt, serviceDurationMinutes),
      state: isConfirmed ? "CONFIRMED" : "HELD",
      expiresAt: "2026-01-01T00:00:00.000Z",
      confirmedAt: isConfirmed ? "2026-01-01T00:00:00.000Z" : null,
      terminalAt: isConfirmed ? "2026-01-01T00:00:00.000Z" : null,
      sequence: isConfirmed ? 2 : 1,
    };
  });
  const waitlistEntries = Array.from({ length: perf.waitlist }, (_, index) => ({
    waitlistEntryId: perfWaitlistId(index),
    patientId: perfPatientId(perf.confirmed + perf.due + index),
    serviceTypeId: perfServiceTypeId(index % perf.serviceTypes),
    earliestStart: "2028-06-01T00:00:00.000Z",
    latestEnd: "2028-06-01T00:15:00.000Z",
    priority: 100 - (index % 101),
    state: "WAITING",
    joinedAt: new Date(Date.UTC(2026, 0, 1) + index).toISOString(),
    appointmentId: null,
  }));
  return {
    schemaVersion: 1,
    seedVersion: "perf-v1",
    clinicians,
    rooms,
    equipmentUnits,
    serviceTypes,
    patients,
    appointments,
    waitlistEntries,
  };
}

async function preparePerformance(ctx) {
  await ctx.prepare();
  const imported = await ctx.seed(performanceSeed());
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  return { apiA: await ctx.startApi(), apiB: await ctx.startApi() };
}

function assertAvailabilityOrder(items) {
  assert.ok(Array.isArray(items), "availability response is missing items");
  for (let index = 1; index < items.length; index += 1) {
    assert.ok(items[index - 1].startAt <= items[index].startAt, "availability slots are not ordered by startAt");
  }
  assert.equal(new Set(items.map(({ clinicianId, startAt, endAt }) => `${clinicianId}:${startAt}:${endAt}`)).size, items.length);
}

async function availabilityPerformance(ctx, scale) {
  const { apiA, apiB } = await preparePerformance(ctx);
  let ordinal = 0;
  const metrics = await measuredLoad(ctx, {
    concurrency: 64,
    warmupMs: 10_000 * scale,
    measureMs: 60_000 * scale,
    request: async () => {
      const selected = ordinal++ % (perf.serviceTypes * perf.clinicians);
      const serviceIndex = Math.floor(selected / perf.clinicians);
      const clinicianIndex = selected % perf.clinicians;
      const path = `/api/v1/availability?serviceTypeId=${perfServiceTypeId(serviceIndex)}&clinicianId=${perfClinicianId(clinicianIndex)}&from=2029-06-01T00%3A00%3A00.000Z&to=2029-06-02T00%3A00%3A00.000Z`;
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, path);
      assert.equal(response.status, 200, response.text);
      assertAvailabilityOrder(response.json?.items);
      return response;
    },
  });
  assert.ok(metrics.throughput >= 200, `availability-read throughput ${metrics.throughput}/s`);
  assert.ok(metrics.p95 <= 180, `availability-read p95 ${metrics.p95}ms`);
  assert.equal(Object.keys(metrics.statuses).some((status) => Number(status) >= 500), false);
  return metrics;
}

function hotSlot(index) {
  return {
    serviceTypeId: perfServiceTypeId(0),
    clinicianId: perfClinicianId(0),
    startAt: perfSlot("2029-07-01T00:00:00.000Z", index),
  };
}

async function runHotSlots(ctx, baseUrls, slotOffset, slotCount, patientOffset, windowMs, keyPrefix) {
  const startedAt = Date.now();
  const results = [];
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const slot = hotSlot(slotOffset + slotIndex);
    const group = await Promise.all(Array.from({ length: 10 }, (_, contender) => ctx.mutate(
      baseUrls[(slotIndex * 10 + contender) % baseUrls.length],
      "/api/v1/appointments",
      `${keyPrefix}-${slotIndex}-${contender}`,
      { patientId: perfPatientId(patientOffset + slotIndex * 10 + contender), ...slot },
    )));
    results.push(...group);
  }
  const requestDurationMs = Date.now() - startedAt;
  if (requestDurationMs < windowMs) await new Promise((resolve) => setTimeout(resolve, windowMs - requestDurationMs));
  const durationMs = Math.max(windowMs, requestDurationMs);
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const group = results.slice(slotIndex * 10, slotIndex * 10 + 10);
    assert.equal(group.filter(({ status }) => status === 201).length, 1, `hot slot ${slotIndex} did not have one winner`);
    assert.equal(group.filter(({ status, json }) => status === 409 && json?.error?.code === "SLOT_UNAVAILABLE").length, 9);
  }
  const successfulLatencies = results.filter(({ status }) => status === 201).map(({ durationMs: latency }) => latency).sort((a, b) => a - b);
  return {
    completed: results.length,
    throughput: results.length / (durationMs / 1_000),
    p50: percentile(successfulLatencies, 0.5),
    p95: percentile(successfulLatencies, 0.95),
    p99: percentile(successfulLatencies, 0.99),
    statuses: Object.fromEntries([...new Set(results.map(({ status }) => status))].map((status) => [
      status,
      results.filter((response) => response.status === status).length,
    ])),
  };
}

async function competingHoldsPerformance(ctx, scale) {
  const { apiA, apiB } = await preparePerformance(ctx);
  const warmupSlots = Math.max(1, Math.round(30 * scale));
  const measuredSlots = Math.max(1, Math.round(180 * scale));
  await runHotSlots(ctx, [apiA.baseUrl, apiB.baseUrl], 0, warmupSlots, 10_000, 10_000 * scale, "perf-warmup-hold");
  const metrics = await runHotSlots(
    ctx,
    [apiA.baseUrl, apiB.baseUrl],
    warmupSlots,
    measuredSlots,
    20_000,
    60_000 * scale,
    "perf-measured-hold",
  );
  assert.ok(metrics.throughput >= 30, `competing-holds throughput ${metrics.throughput}/s`);
  assert.ok(metrics.p95 <= 600, `competing-holds successful p95 ${metrics.p95}ms`);
  const snapshot = await ctx.snapshot(apiA.baseUrl);
  const measuredStarts = new Set(Array.from({ length: measuredSlots }, (_, index) => hotSlot(warmupSlots + index).startAt));
  assert.equal(
    snapshot.resources.appointments.filter(({ startAt, state }) => measuredStarts.has(startAt) && state === "HELD").length,
    measuredSlots,
  );
  return metrics;
}

function assertExclusiveActiveCalendars(appointments) {
  const calendars = new Map();
  for (const appointment of appointments.filter(({ state }) => ["HELD", "CONFIRMED"].includes(state))) {
    const resources = [
      `clinician:${appointment.clinicianId}`,
      `room:${appointment.roomId}`,
      ...appointment.equipmentUnitIds.map((id) => `equipment:${id}`),
    ];
    for (const resource of resources) {
      const values = calendars.get(resource) ?? [];
      values.push({ startAt: appointment.startAt, endAt: appointment.endAt });
      calendars.set(resource, values);
    }
  }
  for (const [resource, values] of calendars) {
    values.sort((left, right) => left.startAt.localeCompare(right.startAt));
    for (let index = 1; index < values.length; index += 1) {
      assert.ok(values[index - 1].endAt <= values[index].startAt, `${resource} has overlapping active appointments`);
    }
  }
}

async function expiryAndPromotionRecovery(ctx) {
  const { apiA } = await preparePerformance(ctx);
  const heldBarrier = deferred();
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? heldBarrier.promise : { status: 204 });
  const killed = [
    await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-clinicgrid" }),
    await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-clinicgrid" }),
  ];
  await ctx.waitFor(() => barrier.ledger.filter(({ json }) => json?.point === "worker.claimed").length >= 2, {
    timeoutMs: 30_000,
    label: "two claimed expiry or promotion tasks",
    children: killed,
  });
  await Promise.all(killed.map((worker) => ctx.stop(worker, "SIGKILL")));
  heldBarrier.resolve({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));

  const startedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const dueIds = new Set(Array.from({ length: perf.due }, (_, index) => perfAppointmentId(perf.confirmed + index)));
  const waitlistIds = new Set(Array.from({ length: perf.waitlist }, (_, index) => perfWaitlistId(index)));
  const recovered = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const due = snapshot.resources.appointments.filter(({ appointmentId }) => dueIds.has(appointmentId));
    const promoted = snapshot.resources.waitlistEntries.filter(({ waitlistEntryId }) => waitlistIds.has(waitlistEntryId));
    const drained = snapshot.work.every(({ kind, terminal }) => (
      !["APPOINTMENT_EXPIRY", "WAITLIST_PROMOTION"].includes(kind) || terminal
    ));
    return due.length === perf.due && due.every(({ state }) => state === "EXPIRED")
      && promoted.length === perf.waitlist && promoted.every(({ state }) => state === "PROMOTED")
      && drained
      ? snapshot
      : undefined;
  }, { timeoutMs: 45_000, label: "2,000 expiry and promotion records to recover", children: replacements });
  const durationMs = Date.now() - startedAt;
  assert.ok(durationMs <= 45_000, `expiry-and-promotion-recovery took ${durationMs}ms`);
  const promoted = recovered.resources.waitlistEntries.filter(({ waitlistEntryId }) => waitlistIds.has(waitlistEntryId));
  assert.equal(new Set(promoted.map(({ appointmentId }) => appointmentId)).size, perf.waitlist);
  assertExclusiveActiveCalendars(recovered.resources.appointments);
  return { completed: perf.due + perf.waitlist, durationMs, killedWorkers: 2, replacementWorkers: 2 };
}

async function runPerformance(ctx, assertions) {
  const scale = performanceScale();
  const availability = await availabilityPerformance(ctx, scale);
  assertions.push(`availability-read: ${availability.throughput.toFixed(1)}/s at p95 ${availability.p95.toFixed(1)}ms`);

  await ctx.resetDatabase();
  const holds = await competingHoldsPerformance(ctx, scale);
  assertions.push(`competing-holds: ${holds.throughput.toFixed(1)} attempts/s at successful p95 ${holds.p95.toFixed(1)}ms with one winner per slot`);

  await ctx.resetDatabase();
  const recovery = await expiryAndPromotionRecovery(ctx);
  assertions.push(`expiry-and-promotion-recovery: ${recovery.completed} records drained in ${recovery.durationMs}ms after two SIGKILLs`);
  return {
    metrics: [
      { scenarioId: "availability-read", ...availability },
      { scenarioId: "competing-holds", ...holds },
      { scenarioId: "expiry-and-promotion-recovery", ...recovery },
    ],
    fixtureSummary: {
      clinicians: perf.clinicians,
      rooms: perf.rooms,
      equipmentUnits: perf.equipment,
      serviceTypes: perf.serviceTypes,
      patients: perf.patients,
      appointments: perf.confirmed + perf.due,
      waitlistEntries: perf.waitlist,
    },
  };
}
