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
  requireV1,
  resource,
  setControlValue,
  transitionAppointment,
  waitForDrain,
} from "./helpers.mjs";

const cap = ["CORRECTNESS_INVARIANT"];

async function prepareVersionOne(ctx, seed) {
  const workspace = requireV1(ctx);
  await prepare(ctx, { migrate: false });
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
  id: "MIGRATE-01", fixtureFamily: "CG-F-V1-WIRE-CHECKPOINT",
  action: "Create V1 HELD, CONFIRMED, CANCELLED and Worker-expired Appointments plus a saved mutation replay, then run FINAL migration against the populated database.",
  oracle: "Every V1 Appointment wire body, identity, allocation, timestamp, sequence and replay response remains exact and no historical row is attached to a generated Care Plan.",
  async run(ctx) {
    const seed = coreSeed(ctx);
    seed.appointments.push(dueAppointment(ctx, seed, "v1-expired"));
    const { api } = await prepareVersionOne(ctx, seed);
    const heldBody = { patientId: seed.patients[1].patientId, serviceTypeId: seed.serviceTypes[0].serviceTypeId, clinicianId: seed.clinicians[0].clinicianId, startAt: ctx.at({ hours: 1 }) };
    const heldKey = ctx.key("saved-v1-hold");
    const heldResponse = await ctx.mutate(api.baseUrl, "/api/v1/appointments", heldKey, heldBody);
    ctx.equal(heldResponse.status, 201, "saved V1 hold status");
    const confirmed = (await createAppointment(ctx, api.baseUrl, { ...heldBody, patientId: seed.patients[2].patientId, startAt: ctx.at({ hours: 2 }) }, { key: ctx.key("v1-confirmed") })).appointment;
    await transitionAppointment(ctx, api.baseUrl, confirmed.appointmentId, "confirm", {}, { key: ctx.key("v1-confirm") });
    const cancelled = (await createAppointment(ctx, api.baseUrl, { ...heldBody, patientId: seed.patients[3].patientId, startAt: ctx.at({ hours: 3 }) }, { key: ctx.key("v1-cancelled") })).appointment;
    await transitionAppointment(ctx, api.baseUrl, cancelled.appointmentId, "cancel", { reason: "migration fixture" }, { key: ctx.key("v1-cancel") });
    const worker = await ctx.forWorkspace(requireV1(ctx)).startWorker();
    const before = await waitForDrain(ctx, api.baseUrl, { timeoutMs: 60_000, predicate: ({ aggregateId }) => aggregateId === seed.appointments[0].appointmentId, processes: [worker] });
    const v1Appointments = structuredClone(resource(before, "appointments"));
    ctx.equal(new Set(v1Appointments.map(({ state }) => state)), new Set(["HELD", "CONFIRMED", "CANCELLED", "EXPIRED"]), "V1 checkpoint covers every state");
    await ctx.stop(api);
    await ctx.stop(worker);

    await ctx.migrate({ timeoutMs: 300_000 });
    const finalApi = await ctx.startApi();
    const after = await ctx.snapshot(finalApi.baseUrl);
    ctx.equal(resource(after, "appointments"), v1Appointments, "FINAL preserves every V1 Appointment exactly");
    ctx.equal(resource(after, "carePlans"), [], "migration creates no Care Plan for standalone V1 data");
    for (const appointment of v1Appointments) {
      const response = await ctx.request(finalApi.baseUrl, `/api/v1/appointments/${appointment.appointmentId}`);
      ctx.equal({ status: response.status, json: response.json }, { status: 200, json: appointment }, `V1 wire body ${appointment.appointmentId}`);
      exactKeys(response.json, APPOINTMENT_KEYS, "migrated standalone Appointment");
    }
    const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/appointments", heldKey, heldBody);
    ctx.equal({ status: replay.status, json: replay.json }, { status: heldResponse.status, json: heldResponse.json }, "saved V1 replay survives migration");
    const plan = (await createCarePlan(ctx, finalApi.baseUrl, { patientId: seed.patients[5].patientId, visits: [
      { serviceTypeId: seed.serviceTypes[0].serviceTypeId, clinicianId: seed.clinicians[0].clinicianId, startAt: ctx.at({ hours: 5 }) },
      { serviceTypeId: seed.serviceTypes[1].serviceTypeId, clinicianId: seed.clinicians[1].clinicianId, startAt: ctx.at({ hours: 6 }) },
    ] })).plan;
    assertCarePlan(plan);
    assertInvariants(ctx, await ctx.snapshot(finalApi.baseUrl));
    return finalEvidence(ctx, { migratedAppointments: v1Appointments.length, savedReplay: true, newCarePlan: true });
  },
}, cap);

const migrate02 = guardedCase({
  id: "MIGRATE-02", fixtureFamily: "CG-F-V1-INFLIGHT-RECOVERY",
  action: "Migrate a V1 database after SIGKILL of a claimed expiry Worker and an unknown-ack dispatcher while assignments, pending promotion, Work leases and Events are observable.",
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
    const { workspace, target, api } = await prepareVersionOne(ctx, seed);
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
    ctx.ok(before.work.some(({ state }) => state === "LEASED"), "V1 checkpoint contains a claimed lease");
    await ctx.stop(api);
    await ctx.migrate({ timeoutMs: 300_000 });
    const finalApi = await ctx.startApi();
    const migrated = await ctx.snapshot(finalApi.baseUrl);
    for (const key of ["clinicians", "rooms", "equipmentUnits", "serviceTypes", "patients", "appointments", "waitlistEntries"]) ctx.equal(resource(migrated, key), resource(before, key), `migrated V1 ${key}`);
    ctx.equal(migrated.work, before.work, "Work lease identity, attempt and deadline preserved");
    ctx.equal(migrated.events, before.events, "Event identity, body and sequence preserved");
    const newWorker = await ctx.startWorker();
    const newDispatcher = await ctx.startDispatcher({ webhookUrl: receiver.url });
    const drained = await waitForDrain(ctx, finalApi.baseUrl, { timeoutMs: 90_000, intervalMs: 20, predicate: ({ workId }) => originalWorkIds.has(workId), processes: [newWorker, newDispatcher] });
    ctx.equal(resource(drained, "appointments").find(({ appointmentId }) => appointmentId === due.appointmentId)?.state, "EXPIRED", "original due Appointment expires once");
    ctx.equal(resource(drained, "waitlistEntries").find(({ waitlistEntryId }) => waitlistEntryId === seed.waitlistEntries[0].waitlistEntryId)?.state, "PROMOTED", "original waiting entry promotes once");
    ctx.ok(receiver.ledger.length > 0, "replacement dispatcher resumes committed V1 events");
    ctx.mark("v1-workspace", { workspaceDigestInput: workspace.split("/").at(-1) });
    assertInvariants(ctx, drained);
    return finalEvidence(ctx, { preservedWork: before.work.length, preservedEvents: before.events.length, replacements: 2 });
  },
}, cap);

const migrate03 = guardedCase({
  id: "MIGRATE-03", fixtureFamily: "CG-F-SEED-ONLINE-MIGRATION",
  action: "Exercise V1 valid seed, digest replay, version conflict and multiple member-invariant failures, then continuously query availability while FINAL migration runs.",
  oracle: "Canonical seed authority makes replay a no-op and rejects every invalid aggregate with zero durable effects; migration-time public reads stay correct with p95 at most 500 milliseconds.",
  async run(ctx) {
    const workspace = requireV1(ctx);
    await prepare(ctx, { migrate: false });
    const v1 = await prepare(ctx, { workspace, migrate: true, build: true });
    const valid = coreSeed(ctx);
    await v1.seed(valid);
    const api = await v1.startApi();
    const baseline = await ctx.snapshot(api.baseUrl);
    await v1.seed(valid);
    assertNoChange(ctx, baseline, await ctx.snapshot(api.baseUrl), "same seed version and digest replay");

    const changed = structuredClone(valid);
    changed.patients[0].name = "Changed digest";
    await expectSeedFailure(ctx, v1, changed, /SEED_VERSION_CONFLICT/u, baseline, api.baseUrl, "same-version different-digest");
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
    for (const [value, pattern, label] of invalidSeeds) await expectSeedFailure(ctx, v1, value, pattern, baseline, api.baseUrl, label);

    await ctx.stop(api);
    await ctx.resetDatabase();
    await v1.migrate();
    const large = performanceSeed(ctx.fixtures);
    await v1.seed(large, { timeoutMs: 900_000 });
    const onlineApi = await v1.startApi();
    const path = `/api/v1/availability?serviceTypeId=${large.serviceTypes[0].serviceTypeId}&clinicianId=${large.clinicians[0].clinicianId}&from=${encodeURIComponent(ctx.at({ days: 10 }))}&to=${encodeURIComponent(ctx.at({ days: 11 }))}`;
    const latencies = [];
    let migrating = true;
    const readers = Array.from({ length: 64 }, async () => {
      while (migrating) {
        const response = await ctx.request(onlineApi.baseUrl, path, { timeoutMs: 2_000 });
        ctx.equal(response.status, 200, "availability remains successful during migration");
        const starts = response.json.items.map(({ startAt }) => startAt);
        ctx.equal(starts, [...starts].sort(), "migration-time availability order");
        latencies.push(response.durationMs);
      }
    });
    await ctx.waitFor(() => latencies.length >= 64, { timeoutMs: 10_000, label: "pre-migration availability reads" });
    try { await ctx.migrate({ timeoutMs: 300_000 }); }
    finally { migrating = false; }
    await Promise.all(readers);
    ctx.ok(latencies.length >= 64, "availability sampled throughout migration");
    ctx.ok(percentile(latencies, 0.95) <= 500, "migration-time availability p95 is at most 500ms");
    await ctx.stop(onlineApi);
    const finalApi = await ctx.startApi();
    assertInvariants(ctx, await ctx.snapshot(finalApi.baseUrl));
    return ctx.pass({ diagnostics: [ctx.diagnostic("per-statement-access-exclusive-lock", "SPEC-GAP-CG-02")], evidence: [{ kind: "clinicgrid-case-summary", invalidSeeds: invalidSeeds.length, migrationReads: latencies.length, p95Ms: percentile(latencies, 0.95) }] });
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
