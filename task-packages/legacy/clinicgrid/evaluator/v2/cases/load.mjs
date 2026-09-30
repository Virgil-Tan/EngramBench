import { performanceContract, performanceSeed } from "../fixtures/index.mjs";
import { overlaps, planAggregate } from "../oracles/index.mjs";
import {
  FINAL_RESOURCES,
  assertCarePlan,
  assertInvariants,
  calendar,
  createCarePlan,
  exactKeys,
  finalEvidence,
  guardedCase,
  launchBrowser,
  percentile,
  prepare,
  resource,
  runWindow,
} from "./helpers.mjs";

const cap = ["CORRECTNESS_INVARIANT"];
const SLOT_KEYS = ["serviceTypeId", "clinicianId", "startAt", "endAt", "roomIds", "equipmentOptions"];

function orderedPairs(seed) {
  const pairs = [];
  const services = [...seed.serviceTypes].sort((left, right) => Buffer.compare(Buffer.from(left.serviceTypeId), Buffer.from(right.serviceTypeId)));
  const clinicians = [...seed.clinicians].sort((left, right) => Buffer.compare(Buffer.from(left.clinicianId), Buffer.from(right.clinicianId)));
  for (const service of services) for (const clinician of clinicians) {
    const range = clinician.availability.find(({ startAt, endAt }) => Date.parse(endAt) - Date.parse(startAt) >= 86_400_000);
    if (range) pairs.push({ serviceTypeId: service.serviceTypeId, clinicianId: clinician.clinicianId, from: range.startAt, to: new Date(Date.parse(range.startAt) + 86_400_000).toISOString() });
  }
  return pairs;
}

function availabilityPath(pair) {
  return `/api/v1/availability?serviceTypeId=${pair.serviceTypeId}&clinicianId=${pair.clinicianId}&from=${encodeURIComponent(pair.from)}&to=${encodeURIComponent(pair.to)}`;
}

function checkAvailability(ctx, response, pair) {
  ctx.equal(response.status, 200, "measured availability status");
  exactKeys(response.json, ["items"], "Availability response");
  ctx.ok(Array.isArray(response.json.items), "Availability items array");
  let prior;
  for (const slot of response.json.items) {
    exactKeys(slot, SLOT_KEYS, "AvailabilitySlot");
    ctx.equal({ serviceTypeId: slot.serviceTypeId, clinicianId: slot.clinicianId }, { serviceTypeId: pair.serviceTypeId, clinicianId: pair.clinicianId }, "Availability pair identity");
    ctx.ok(Date.parse(slot.startAt) >= Date.parse(pair.from) && Date.parse(slot.endAt) <= Date.parse(pair.to), "AvailabilitySlot stays in complete day");
    if (prior) ctx.ok(Date.parse(prior.startAt) <= Date.parse(slot.startAt) && !overlaps(prior, slot), "AvailabilitySlot order has no duplicate overlap");
    prior = slot;
  }
  return response;
}

export async function runAvailabilityScenario(ctx) {
  const seed = performanceSeed(ctx.fixtures);
  const contract = performanceContract().availability;
  const target = await prepare(ctx, { seed, seedTimeoutMs: 900_000 });
  const apis = [await target.startApi(), await target.startApi()];
  const pairs = orderedPairs(seed);
  ctx.equal(pairs.length, seed.serviceTypes.length * seed.clinicians.length, "all seeded Service Type and Clinician pairs are eligible");
  await runWindow({
    clients: contract.clients,
    seconds: contract.warmupSeconds,
    operation: (index, client) => ctx.request(apis[client % apis.length].baseUrl, availabilityPath(pairs[index % pairs.length])).then((response) => checkAvailability(ctx, response, pairs[index % pairs.length])),
  });
  const measured = await runWindow({
    clients: contract.clients,
    seconds: contract.measureSeconds,
    operation: (index, client) => ctx.request(apis[client % apis.length].baseUrl, availabilityPath(pairs[index % pairs.length])).then((response) => checkAvailability(ctx, response, pairs[index % pairs.length])),
  });
  ctx.equal([...measured.statuses.entries()], [[200, measured.completed]], "availability counts only complete 200 bodies");
  ctx.ok(measured.throughput >= contract.throughput, "availability throughput reaches 200 responses/s");
  ctx.ok(measured.p95Ms <= contract.p95Ms, "availability p95 reaches 180ms target");
  return { seed, api: apis[0], apis, measured };
}

function hotSlot(seed, slotIndex) {
  const clinicianIndex = 1_500 + Math.floor(slotIndex / 70);
  const localIndex = slotIndex % 70;
  const start = Date.parse(seed.clinicians[clinicianIndex].availability[0].startAt) + (390 + localIndex * 15) * 60_000;
  return { clinicianId: seed.clinicians[clinicianIndex].clinicianId, serviceTypeId: seed.serviceTypes[0].serviceTypeId, startAt: new Date(start).toISOString() };
}

async function contendSlot(ctx, apis, seed, slotIndex, measured) {
  const slot = hotSlot(seed, slotIndex);
  const patientOffset = 60_000 + slotIndex * 10;
  const attempts = Array.from({ length: 10 }, (_, contender) => ({ contender, patientId: seed.patients[patientOffset + contender].patientId }));
  const responses = await ctx.concurrent(attempts, 10, async ({ contender, patientId }, index) => {
    const startedAt = performance.now();
    const response = await ctx.mutate(apis[(slotIndex + index) % apis.length].baseUrl, "/api/v1/appointments", ctx.key(`perf-hot-${slotIndex}-${contender}`), { patientId, ...slot });
    return { response, latencyMs: performance.now() - startedAt };
  });
  const winners = responses.filter(({ response }) => response.status === 201);
  const conflicts = responses.filter(({ response }) => response.status === 409 && response.json?.error?.code === "SLOT_UNAVAILABLE");
  ctx.equal(winners.length, 1, `hot slot ${slotIndex} has exactly one winner`);
  ctx.equal(conflicts.length, 9, `hot slot ${slotIndex} has exactly nine exact conflicts`);
  if (measured) measured.push(...responses);
  return winners[0].response.json;
}

export async function runContentionScenario(ctx) {
  const seed = performanceSeed(ctx.fixtures);
  const contract = performanceContract().holds;
  const target = await prepare(ctx, { seed, seedTimeoutMs: 900_000 });
  const apis = [await target.startApi(), await target.startApi()];
  const warmupStartedAt = performance.now();
  for (let index = 0; index < contract.warmupSlots; index += 1) {
    await contendSlot(ctx, apis, seed, index);
    const nextAt = warmupStartedAt + ((index + 1) * contract.warmupSeconds * 1_000) / contract.warmupSlots;
    const delay = nextAt - performance.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  ctx.ok(performance.now() - warmupStartedAt >= contract.warmupSeconds * 1_000 - 50, "contention warm-up lasts ten seconds");
  const measured = [];
  const measuredStartedAt = performance.now();
  for (let index = contract.warmupSlots; index < contract.warmupSlots + contract.measuredSlots; index += 1) await contendSlot(ctx, apis, seed, index, measured);
  const durationSeconds = (performance.now() - measuredStartedAt) / 1_000;
  const successfulLatencies = measured.filter(({ response }) => response.status === 201).map(({ latencyMs }) => latencyMs);
  ctx.equal(measured.length, contract.measuredSlots * contract.contenders, "exact measured hot-slot attempt count");
  ctx.ok(durationSeconds <= contract.measureSeconds, "measured contention completes within sixty seconds");
  ctx.ok(measured.length / durationSeconds >= contract.throughput, "contention reaches thirty complete attempts/s");
  ctx.ok(percentile(successfulLatencies, 0.95) <= contract.p95Ms, "successful hold p95 reaches 600ms target");
  return { seed, api: apis[0], apis, measured: { attempts: measured.length, durationSeconds, p95Ms: percentile(successfulLatencies, 0.95) } };
}

export async function runRecoveryScenario(ctx) {
  const seed = performanceSeed(ctx.fixtures);
  const contract = performanceContract().recovery;
  const target = await prepare(ctx, { seed, seedTimeoutMs: 900_000 });
  const api = await target.startApi();
  const barrier = await ctx.barrier({ hold: ({ point }) => point === "worker.claimed" });
  const killed = [
    await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }),
    await ctx.startWorker({ env: { TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: barrier.token } }),
  ];
  const claims = await ctx.waitFor(() => {
    const values = barrier.ledger.filter(({ json }) => json?.point === "worker.claimed");
    return new Set(values.map(({ json }) => json.workId)).size >= contract.killedWorkers ? values.slice(0, contract.killedWorkers) : false;
  }, { timeoutMs: 60_000, intervalMs: 5, label: "two distinct claimed backlog items", processes: killed });
  for (const worker of killed) await ctx.kill(worker);
  ctx.equal(new Set(claims.map(({ json }) => json.workId)).size, contract.killedWorkers, "two distinct Work claims before SIGKILL");
  const leased = await ctx.snapshot(api.baseUrl);
  const backlogIds = new Set(leased.work.map(({ workId }) => workId));
  const leaseDeadline = Math.max(...leased.work.filter(({ state }) => state === "LEASED").map(({ leaseExpiresAt }) => Date.parse(leaseExpiresAt)));
  await ctx.waitFor(() => Date.now() >= leaseDeadline, { timeoutMs: 10_000, intervalMs: 10, label: "persisted lease expiry" });
  const startedAt = performance.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const snapshot = await ctx.waitFor(async () => {
    const value = await ctx.snapshot(api.baseUrl, { timeoutMs: 10_000 });
    const expired = resource(value, "appointments").filter(({ state }) => state === "EXPIRED").length;
    const promoted = resource(value, "waitlistEntries").filter(({ state }) => state === "PROMOTED").length;
    const drained = value.work.filter(({ workId }) => backlogIds.has(workId)).every(({ terminal }) => terminal);
    return expired === contract.dueAppointments && promoted === contract.waitingEntries && drained ? value : false;
  }, { timeoutMs: contract.seconds * 1_000, intervalMs: 25, label: "2,000-record recovery backlog", processes: replacements });
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  ctx.ok(durationSeconds <= contract.seconds, "replacement workers drain within 45 seconds");
  assertInvariants(ctx, snapshot);
  return { seed, api, replacements, snapshot, measured: { durationSeconds, expired: contract.dueAppointments, promoted: contract.waitingEntries } };
}

async function reconcileAfterLoad(ctx, result, label, patientIndex) {
  const { seed, api } = result;
  const visits = [1_900, 1_901].map((clinicianIndex, index) => ({
    serviceTypeId: seed.serviceTypes[index].serviceTypeId,
    clinicianId: seed.clinicians[clinicianIndex].clinicianId,
    startAt: new Date(Date.parse(seed.clinicians[clinicianIndex].availability[0].startAt) + 7 * 3_600_000).toISOString(),
  }));
  const plan = (await createCarePlan(ctx, api.baseUrl, { patientId: seed.patients[patientIndex].patientId, visits }, { key: ctx.key(`${label}-post-load-plan`) })).plan;
  ctx.equal({ state: plan.state, expiresAt: plan.expiresAt }, planAggregate(plan.visits), `${label} Care Plan aggregate reconciliation`);
  for (const { appointment } of plan.visits) {
    const value = await calendar(ctx, api.baseUrl, "clinicians", appointment.clinicianId, appointment.startAt, appointment.endAt);
    ctx.ok(JSON.stringify(value).includes(appointment.appointmentId), `${label} public calendar contains Care Plan member`);
  }
  const openapi = await ctx.request(api.baseUrl, "/openapi.json");
  ctx.ok(openapi.json?.paths?.["/api/v1/care-plans"]?.post, `${label} OpenAPI retains Care Plan mutation after load`);
  const snapshot = await ctx.snapshot(api.baseUrl, { timeoutMs: 30_000 });
  ctx.equal(Object.keys(snapshot.resources).sort(), [...FINAL_RESOURCES].sort(), `${label} exact FINAL snapshot union`);
  assertCarePlan(resource(snapshot, "carePlans").find(({ carePlanId }) => carePlanId === plan.carePlanId));
  assertInvariants(ctx, snapshot);
  const { browser, page } = await launchBrowser(ctx, api.baseUrl);
  ctx.ok(await page.getByText(plan.carePlanId, { exact: false }).first().isVisible(), `${label} UI renders reconciled Care Plan`);
  await browser.close();
  return { appointments: resource(snapshot, "appointments").length, events: snapshot.events.length, work: snapshot.work.length };
}

const load01 = guardedCase({
  id: "LOAD-01", fixtureFamily: "CG-F-FORMAL-AVAILABILITY-READ",
  action: "Run the fixed 2k/2k/4k/20/100k/51k/1k seed through two APIs with 64 closed-loop clients for ten warm-up and sixty measured seconds.",
  oracle: "Every complete response is HTTP 200 with ordered non-overlapping AvailabilitySlots; measured throughput is at least 200 per second and p95 at most 180 milliseconds.",
  async run(ctx) {
    const result = await runAvailabilityScenario(ctx);
    assertInvariants(ctx, await ctx.snapshot(result.api.baseUrl, { timeoutMs: 30_000 }));
    return finalEvidence(ctx, { clients: 64, warmupSeconds: 10, measureSeconds: 60, throughput: result.measured.throughput, p95Ms: result.measured.p95Ms });
  },
}, cap);

const load02 = guardedCase({
  id: "LOAD-02", fixtureFamily: "CG-F-FORMAL-COMPETING-HOLDS",
  action: "Run thirty disjoint warm-up hot slots for ten seconds and 180 measured slots with ten fresh patient contenders each across two real API processes.",
  oracle: "Each measured interval has exactly one complete 201 bundle and nine exact SLOT_UNAVAILABLE responses while 1,800 attempts meet thirty per second and 600ms hold p95.",
  async run(ctx) {
    const result = await runContentionScenario(ctx);
    assertInvariants(ctx, await ctx.snapshot(result.api.baseUrl, { timeoutMs: 30_000 }));
    return finalEvidence(ctx, { warmupSlots: 30, measuredSlots: 180, contenders: 10, ...result.measured });
  },
}, cap);

const load03 = guardedCase({
  id: "LOAD-03", fixtureFamily: "CG-F-FORMAL-RECOVERY-BACKLOG",
  action: "Seed exactly one thousand due HELD Appointments and one thousand eligible Waitlist Entries, SIGKILL two claimed Workers, then start two replacements.",
  oracle: "Within 45 seconds every due Appointment expires once, every eligible head promotes once, both named Work kinds drain and complete resource calendars remain exclusive.",
  async run(ctx) {
    const result = await runRecoveryScenario(ctx);
    return finalEvidence(ctx, { killedWorkers: 2, replacements: 2, ...result.measured });
  },
}, cap);

const load04 = guardedCase({
  id: "LOAD-04", fixtureFamily: "CG-F-POST-LOAD-CROSS-LAYER",
  action: "Repeat each fixed workload from a fresh database and after each one create a Care Plan, read every member calendar, inspect OpenAPI and production Chromium, and take a full snapshot.",
  oracle: "Full post-load reconciliation proves interval exclusivity, complete bundles, Waitlist and Plan closure, terminal Work and contiguous Events rather than accepting performance samples alone.",
  async run(ctx) {
    const summaries = [];
    summaries.push(await reconcileAfterLoad(ctx, await runAvailabilityScenario(ctx), "availability-read", 90_000));
    await ctx.resetDatabase();
    summaries.push(await reconcileAfterLoad(ctx, await runContentionScenario(ctx), "competing-holds", 90_001));
    await ctx.resetDatabase();
    summaries.push(await reconcileAfterLoad(ctx, await runRecoveryScenario(ctx), "expiry-and-promotion-recovery", 90_002));
    return finalEvidence(ctx, { independentDatabases: 3, reconciledScenarios: summaries });
  },
}, cap);

export const LOAD_CASES = Object.freeze([load01, load02, load03, load04]);
