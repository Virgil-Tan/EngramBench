// Policy revision: learning-final-system-2026-09-08.1. Current FINAL state and public lifecycle only; no historical binary upgrade.
import { performanceSeed } from "../fixtures/index.mjs";
import { percentile } from "../oracles/index.mjs";
import {
  APPOINTMENT_KEYS,
  FINAL_RESOURCES,
  assertCarePlan,
  assertInvariants,
  assertNoChange,
  clickControl,
  coreSeed,
  createAppointment,
  createCarePlan,
  exactKeys,
  finalEvidence,
  guardedCase,
  launchBrowser,
  prepare,
  resource,
  setControlValue,
  transitionAppointment,
  waitForDrain,
} from "./helpers.mjs";

const cap = ["CORRECTNESS_INVARIANT"];

export async function observeAvailabilityDuringReinitialization(ctx, baseUrl, path) {
  const latencies = [];
  let reading = true, readerError, operationError;
  // Capture each reader rejection immediately, including during setup/migrate.
  const readers = Array.from({ length: 64 }, () => (async () => {
    while (reading) {
      const response = await ctx.request(baseUrl, path, { timeoutMs: 2_000 });
      ctx.equal(response.status, 200, "availability remains successful during reinitialization");
      const starts = response.json.items.map(({ startAt }) => startAt);
      ctx.equal(starts, [...starts].sort(), "reinitialization-time availability order");
      latencies.push(response.durationMs);
    }
  })().catch(error => { readerError ??= error; reading = false; }));
  try {
    await ctx.waitFor(() => {
      if (readerError) throw readerError;
      return latencies.length >= 64;
    }, { timeoutMs: 10_000, label: "pre-reinitialization availability reads" });
    if (readerError) throw readerError;
    await ctx.migrate({ timeoutMs: 300_000 });
  } catch (error) {
    operationError = error;
  } finally {
    reading = false;
    await Promise.all(readers);
  }
  if (readerError) throw readerError;
  if (operationError) throw operationError;
  return latencies;
}

async function prepareCurrentSystem(ctx, seed) {
  const workspace = ctx.workspace;
  await prepare(ctx, { reinitialize: false });
  const target = await prepare(ctx, { workspace, seed });
  return { workspace, target, api: await target.startApi() };
}

async function expectSeedFailure(ctx, target, value, pattern, before, baseUrl, label) {
  let failure;
  try { await target.seed(value, { timeoutMs: 300_000 }); }
  catch (error) { failure = error; }
  ctx.ok(failure, `${label} seed command fails`);
  ctx.ok(pattern.test(`${failure?.result?.stdout ?? ""}\n${failure?.result?.stderr ?? ""}\n${failure?.message ?? ""}`), `${label} reports stable failure`);
  assertNoChange(ctx, before, await ctx.snapshot(baseUrl), `${label} atomic rejection`);
}

function dueAppointment(ctx, seed, label, options = {}) {
  return {
    appointmentId: ctx.uuid(`${label}-appointment`), patientId: options.patientId ?? seed.patients[0].patientId,
    serviceTypeId: seed.serviceTypes[0].serviceTypeId, clinicianId: options.clinicianId ?? seed.clinicians[0].clinicianId,
    roomId: options.roomId ?? seed.rooms[0].roomId,
    equipmentUnitIds: options.equipmentUnitIds ?? [seed.equipmentUnits[0].equipmentUnitId, seed.equipmentUnits[2].equipmentUnitId],
    startAt: options.startAt ?? ctx.at({ days: 2 }), endAt: options.endAt ?? ctx.at({ days: 2, minutes: 30 }),
    state: options.state ?? "HELD", expiresAt: options.expiresAt ?? ctx.at({ days: -1 }),
    confirmedAt: options.confirmedAt ?? null, terminalAt: options.terminalAt ?? null, sequence: options.sequence ?? 1,
  };
}

const migrate01 = guardedCase({
  id: "MIGRATE-01", fixtureFamily: "CG-F-base-system-WIRE-restart boundary",
  action: "Create base-system HELD, CONFIRMED, CANCELLED and Worker-expired Appointments plus a saved mutation replay, then run FINAL reinitialization against the populated database.",
  oracle: "Every base-system Appointment wire body, identity, allocation, timestamp, sequence and replay response remains exact and no historical row is attached to a generated Care Plan.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    seed.appointments.push(dueAppointment(ctx, seed, "initialRuntime-expired"));
    const { api } = await prepareCurrentSystem(ctx, seed);
    const heldBody = { patientId: seed.patients[1].patientId, serviceTypeId: seed.serviceTypes[0].serviceTypeId, clinicianId: seed.clinicians[0].clinicianId, startAt: ctx.at({ hours: 1 }) };
    const heldKey = ctx.key("saved-initialRuntime-hold");
    const heldResponse = await ctx.mutate(api.baseUrl, "/api/v1/appointments", heldKey, heldBody);
    ctx.equal(heldResponse.status, 201, "saved base-system hold status");
    const confirmed = (await createAppointment(ctx, api.baseUrl, { ...heldBody, patientId: seed.patients[2].patientId, startAt: ctx.at({ hours: 2 }) }, { key: ctx.key("initialRuntime-confirmed") })).appointment;
    await transitionAppointment(ctx, api.baseUrl, confirmed.appointmentId, "confirm", {}, { key: ctx.key("initialRuntime-confirm") });
    const cancelled = (await createAppointment(ctx, api.baseUrl, { ...heldBody, patientId: seed.patients[3].patientId, startAt: ctx.at({ hours: 3 }) }, { key: ctx.key("initialRuntime-cancelled") })).appointment;
    await transitionAppointment(ctx, api.baseUrl, cancelled.appointmentId, "cancel", { reason: "reinitialization fixture" }, { key: ctx.key("initialRuntime-cancel") });
    const worker = await ctx.startWorker();
    const before = await waitForDrain(ctx, api.baseUrl, { timeoutMs: 60_000, predicate: ({ aggregateId }) => aggregateId === seed.appointments[0].appointmentId, processes: [worker] });
    const initialAppointments = structuredClone(resource(before, "appointments"));
    ctx.equal(new Set(initialAppointments.map(({ state }) => state)), new Set(["HELD", "CONFIRMED", "CANCELLED", "EXPIRED"]), "base-system restart boundary covers every state");
    await ctx.kill(api);
    await ctx.stop(worker);

    await ctx.migrate({ timeoutMs: 300_000 });
    const finalApi = await ctx.startApi();
    const after = await ctx.snapshot(finalApi.baseUrl);
    ctx.equal(resource(after, "appointments"), initialAppointments, "FINAL preserves every base-system Appointment exactly");
    ctx.equal(resource(after, "carePlans"), [], "reinitialization creates no Care Plan for standalone base-system data");
    for (const appointment of initialAppointments) {
      const response = await ctx.request(finalApi.baseUrl, `/api/v1/appointments/${appointment.appointmentId}`);
      ctx.equal({ status: response.status, json: response.json }, { status: 200, json: appointment }, `base-system wire body ${appointment.appointmentId}`);
      exactKeys(response.json, APPOINTMENT_KEYS, "retained standalone Appointment");
    }
    const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/appointments", heldKey, heldBody);
    ctx.equal({ status: replay.status, json: replay.json }, { status: heldResponse.status, json: heldResponse.json }, "saved base-system replay survives reinitialization");
    const plan = (await createCarePlan(ctx, finalApi.baseUrl, { patientId: seed.patients[5].patientId, visits: [
      { serviceTypeId: seed.serviceTypes[0].serviceTypeId, clinicianId: seed.clinicians[0].clinicianId, startAt: ctx.at({ hours: 5 }) },
      { serviceTypeId: seed.serviceTypes[1].serviceTypeId, clinicianId: seed.clinicians[1].clinicianId, startAt: ctx.at({ hours: 6 }) },
    ] })).plan;
    assertCarePlan(plan);
    assertInvariants(ctx, await ctx.snapshot(finalApi.baseUrl));
    return finalEvidence(ctx, { migratedAppointments: initialAppointments.length, savedReplay: true, newCarePlan: true });
  },
}, cap);

const migrate02 = guardedCase({
  id: "MIGRATE-02", fixtureFamily: "CG-F-base-system-INFLIGHT-RECOVERY",
  action: "reinitialize a base-system database after SIGKILL of a claimed expiry Worker and an unknown-ack dispatcher while assignments, pending promotion, Work leases and Events are observable.",
  oracle: "FINAL preserves original resource order, expiry deadlines, Work identity and attempt, and Event identity, body and sequence before replacements resume those exact durable records.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const due = dueAppointment(ctx, seed, "inflight-due");
    seed.appointments.push(due);
    seed.waitlistEntries.push({
      waitlistEntryId: ctx.uuid("inflight-waitlist"), patientId: seed.patients[4].patientId, serviceTypeId: seed.serviceTypes[0].serviceTypeId,
      earliestStart: ctx.at({ days: 3 }), latestEnd: ctx.at({ days: 3, hours: 2 }), priority: 90,
      state: "WAITING", joinedAt: ctx.at({ days: -2 }), appointmentId: null,
    });
    const { workspace, target, api } = await prepareCurrentSystem(ctx, seed);
    const eventSource = (await createAppointment(ctx, api.baseUrl, {
      patientId: seed.patients[5].patientId, serviceTypeId: seed.serviceTypes[1].serviceTypeId,
      clinicianId: seed.clinicians[1].clinicianId, startAt: ctx.at({ hours: 2 }),
    }, { key: ctx.key("inflight-event-source") })).appointment;
    await transitionAppointment(ctx, api.baseUrl, eventSource.appointmentId, "confirm", {}, { key: ctx.key("inflight-event-confirm") });
    const receiver = await ctx.receiver(() => ({ status: 204 }));
    const workerBarrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" });
    const oldWorker = await target.startWorker({ env: { TEST_BARRIER_URL: workerBarrier.url, TEST_BARRIER_TOKEN: workerBarrier.token } });
    await workerBarrier.waitFor(({ json }) => json?.point === "worker.claimed", { timeoutMs: 60_000, processes: [oldWorker] });
    await ctx.kill(oldWorker);
    const dispatcherBarrier = await ctx.barrier({ hold: ({ point }) => point === "dispatcher.response-received" });
    const oldDispatcher = await target.startDispatcher({ webhookUrl: receiver.url, env: { TEST_BARRIER_URL: dispatcherBarrier.url, TEST_BARRIER_TOKEN: dispatcherBarrier.token } });
    await dispatcherBarrier.waitFor(({ json }) => json?.point === "dispatcher.response-received", { timeoutMs: 60_000, processes: [oldDispatcher] });
    await ctx.kill(oldDispatcher);
    const before = await ctx.snapshot(api.baseUrl);
    const originalWorkIds = new Set(before.work.map(({ workId }) => workId));
    ctx.ok(before.work.some(({ state }) => state === "LEASED"), "base-system restart boundary contains a claimed lease");
    await ctx.kill(api);
    await ctx.migrate({ timeoutMs: 300_000 });
    const finalApi = await ctx.startApi();
    const retained = await ctx.snapshot(finalApi.baseUrl);
    for (const key of ["clinicians", "rooms", "equipmentUnits", "serviceTypes", "patients", "appointments", "waitlistEntries"]) ctx.equal(resource(retained, key), resource(before, key), `retained base-system ${key}`);
    ctx.equal(retained.work, before.work, "Work lease identity, attempt and deadline preserved");
    ctx.equal(retained.events, before.events, "Event identity, body and sequence preserved");
    const newWorker = await ctx.startWorker();
    const newDispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const drained = await waitForDrain(ctx, finalApi.baseUrl, { timeoutMs: 90_000, intervalMs: 20, predicate: ({ workId }) => originalWorkIds.has(workId), processes: [newWorker, newDispatcher] });
    ctx.equal(resource(drained, "appointments").find(({ appointmentId }) => appointmentId === due.appointmentId)?.state, "EXPIRED", "original due Appointment expires once");
    ctx.equal(resource(drained, "waitlistEntries").find(({ waitlistEntryId }) => waitlistEntryId === seed.waitlistEntries[0].waitlistEntryId)?.state, "PROMOTED", "original waiting entry promotes once");
    ctx.ok(receiver.ledger.length > 0, "replacement dispatcher resumes committed base-system events");
    ctx.mark("final-system-restart", { killedWorker: true, killedDispatcher: true });
    assertInvariants(ctx, drained);
    return finalEvidence(ctx, { preservedWork: before.work.length, preservedEvents: before.events.length, replacements: 2 });
  },
}, cap);

const migrate03 = guardedCase({
  id: "MIGRATE-03", fixtureFamily: "CG-F-SEED-ONLINE-reinitialization",
  action: "Exercise base-system valid seed, digest replay, version conflict and multiple member-invariant failures, then continuously query availability while FINAL reinitialization runs.",
  oracle: "Canonical seed authority makes replay a no-op and rejects every invalid aggregate with zero durable effects; reinitialization-time public reads stay correct with p95 at most 500 milliseconds.",
  async run(ctx) {
    const workspace = ctx.workspace;
    await prepare(ctx, { reinitialize: false });
    const initialRuntime = await prepare(ctx, { workspace, reinitialize: true, build: true });
    const valid = coreSeed(ctx);
    await initialRuntime.seed(valid);
    const api = await initialRuntime.startApi();
    const baseline = await ctx.snapshot(api.baseUrl);
    await initialRuntime.seed(valid);
    assertNoChange(ctx, baseline, await ctx.snapshot(api.baseUrl), "same seed version and digest replay");

    const changed = structuredClone(valid);
    changed.patients[0].name = "Changed digest";
    await expectSeedFailure(ctx, initialRuntime, changed, /SEED_VERSION_CONFLICT/u, baseline, api.baseUrl, "same-version different-digest");
    const invalidSeeds = [];
    const brokenReference = structuredClone(valid);
    brokenReference.seedVersion = "cg-invalid-reference";
    brokenReference.appointments.push({ ...dueAppointment(ctx, valid, "broken-reference"), patientId: ctx.uuid("missing-patient") });
    invalidSeeds.push([brokenReference, /(?:reference|patient|invalid)/iu, "broken reference"]);
    const overlap = structuredClone(valid);
    overlap.seedVersion = "cg-invalid-overlap";
    overlap.appointments.push(dueAppointment(ctx, valid, "overlap-a"), dueAppointment(ctx, valid, "overlap-b", { patientId: valid.patients[1].patientId }));
    invalidSeeds.push([overlap, /(?:overlap|invalid)/iu, "resource overlap"]);
    const priorities = structuredClone(valid);
    priorities.seedVersion = "cg-invalid-room-priority";
    priorities.rooms[1].priority = priorities.rooms[0].priority;
    invalidSeeds.push([priorities, /(?:priority|unique|invalid)/iu, "duplicate Room priority"]);
    const state = structuredClone(valid);
    state.seedVersion = "cg-invalid-state";
    state.waitlistEntries.push({ waitlistEntryId: ctx.uuid("bad-state-waitlist"), patientId: valid.patients[2].patientId, serviceTypeId: valid.serviceTypes[0].serviceTypeId, earliestStart: ctx.at({ days: 4 }), latestEnd: ctx.at({ days: 5 }), priority: 1, state: "PROMOTED", joinedAt: ctx.at({ days: -1 }), appointmentId: null });
    invalidSeeds.push([state, /(?:state|appointment|invalid)/iu, "broken promoted state"]);
    for (const [value, pattern, label] of invalidSeeds) await expectSeedFailure(ctx, initialRuntime, value, pattern, baseline, api.baseUrl, label);

    await ctx.kill(api);
    await ctx.resetDatabase();
    await initialRuntime.migrate();
    const large = performanceSeed(ctx.fixtures);
    await initialRuntime.seed(large, { timeoutMs: 900_000 });
    const onlineApi = await initialRuntime.startApi();
    const path = `/api/v1/availability?serviceTypeId=${large.serviceTypes[0].serviceTypeId}&clinicianId=${large.clinicians[0].clinicianId}&from=${encodeURIComponent(ctx.at({ days: 10 }))}&to=${encodeURIComponent(ctx.at({ days: 11 }))}`;
    const latencies = await observeAvailabilityDuringReinitialization(ctx, onlineApi.baseUrl, path);
    ctx.ok(latencies.length >= 64, "availability sampled throughout reinitialization");
    ctx.ok(percentile(latencies, 0.95) <= 500, "reinitialization-time availability p95 is at most 500ms");
    await ctx.stop(onlineApi);
    const finalApi = await ctx.startApi();
    assertInvariants(ctx, await ctx.snapshot(finalApi.baseUrl));
    return ctx.pass({ evidence: [{ kind: "clinicgrid-case-summary", invalidSeeds: invalidSeeds.length, reinitializationReads: latencies.length, p95Ms: percentile(latencies, 0.95) }] });
  },
}, cap);

const migrate04 = guardedCase({
  id: "MIGRATE-04", fixtureFamily: "CG-F-CROSS-LAYER-FINAL",
  action: "Create standalone Appointment and multi-visit Care Plan flows with visible production controls, refresh the browser, and reconcile runtime OpenAPI and the exact FINAL snapshot union.",
  oracle: "Closed wire shapes, sorted snapshot resources and refreshed UI must agree on old and new identities, aggregate state, member resources and reachable public operations.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    const api = await (await prepare(ctx, { seed })).startApi();
    const openapi = await ctx.request(api.baseUrl, "/openapi.json");
    ctx.equal(openapi.status, 200, "canonical OpenAPI status");
    for (const path of ["/api/v1/appointments", "/api/v1/care-plans", "/api/v1/care-plans/{carePlanId}", "/api/v1/waitlist-entries"]) ctx.ok(openapi.json?.paths?.[path], `OpenAPI route ${path}`);
    const { page } = await launchBrowser(ctx, api.baseUrl);
    await clickControl(page, ["link", "button"], [/appointment/i, /new appointment/i]);
    await setControlValue(page.getByLabel(/patient/i).first(), seed.patients[10].patientId);
    await setControlValue(page.getByLabel(/service type/i).first(), seed.serviceTypes[0].serviceTypeId);
    await setControlValue(page.getByLabel(/clinician/i).first(), seed.clinicians[0].clinicianId);
    await setControlValue(page.getByLabel(/start/i).first(), ctx.at({ hours: 1 }));
    await clickControl(page, "button", [/hold/i, /create/i, /submit/i]);
    const standalone = await ctx.waitFor(async () => resource(await ctx.snapshot(api.baseUrl), "appointments").find(({ patientId }) => patientId === seed.patients[10].patientId), { timeoutMs: 30_000, label: "UI standalone Appointment" });
    exactKeys(standalone, APPOINTMENT_KEYS, "UI Appointment wire shape");

    await clickControl(page, ["link", "button"], [/care plan/i, /new plan/i]);
    await setControlValue(page.getByLabel(/patient/i).first(), seed.patients[11].patientId);
    for (let index = 0; index < 2; index += 1) {
      if (index > 0) await clickControl(page, "button", [/add visit/i, /another visit/i]);
      await setControlValue(page.getByLabel(/service type/i).nth(index), seed.serviceTypes[index].serviceTypeId);
      await setControlValue(page.getByLabel(/clinician/i).nth(index), seed.clinicians[index].clinicianId);
      await setControlValue(page.getByLabel(/start/i).nth(index), ctx.at({ hours: index + 3 }));
    }
    await clickControl(page, "button", [/create care plan/i, /hold plan/i, /submit/i]);
    const plan = await ctx.waitFor(async () => resource(await ctx.snapshot(api.baseUrl), "carePlans").find(({ patientId }) => patientId === seed.patients[11].patientId), { timeoutMs: 30_000, label: "UI Care Plan" });
    assertCarePlan(plan);
    const snapshot = await ctx.snapshot(api.baseUrl);
    ctx.equal(Object.keys(snapshot.resources).sort(), [...FINAL_RESOURCES].sort(), "exact FINAL snapshot resource union");
    for (const [key, idField] of [["clinicians", "clinicianId"], ["rooms", "roomId"], ["equipmentUnits", "equipmentUnitId"], ["serviceTypes", "serviceTypeId"], ["patients", "patientId"], ["appointments", "appointmentId"], ["waitlistEntries", "waitlistEntryId"], ["carePlans", "carePlanId"], ["carePlanWaitlistEntries", "waitlistEntryId"]]) {
      const ids = resource(snapshot, key).map((value) => value[idField]);
      ctx.equal(ids, [...ids].sort(), `${key} snapshot order`);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    ctx.ok(await page.getByText(standalone.appointmentId, { exact: false }).first().isVisible(), "standalone identity survives refresh");
    ctx.ok(await page.getByText(plan.carePlanId, { exact: false }).first().isVisible(), "Care Plan identity survives refresh");
    assertInvariants(ctx, snapshot);
    return finalEvidence(ctx, { openapiPaths: 4, standaloneAppointments: 1, carePlans: 1, browserRefresh: true });
  },
}, cap);

export const MIGRATE_CASES = Object.freeze([migrate01, migrate02, migrate03, migrate04]);
