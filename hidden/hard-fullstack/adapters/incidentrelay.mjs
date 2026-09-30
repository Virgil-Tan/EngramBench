import assert from "node:assert/strict";

import { measuredLoad, performanceScale } from "../performance-runtime.mjs";

const ids = {
  service: "00000000-0000-4000-8000-000000000001",
  policy: "00000000-0000-4000-8000-000000000002",
  responders: [
    "00000000-0000-4000-8000-000000000011",
    "00000000-0000-4000-8000-000000000012",
    "00000000-0000-4000-8000-000000000013",
  ],
};

const cases = {
  "H-03": mainFlow,
  "H-04": atomicRejection,
  "H-05": durableIdempotency,
  "H-06": multiProcessContention,
  "H-07": workerRecovery,
  "H-08": outboxRecovery,
  "H-09": v1Migration,
  "H-10": managerBehavior,
  "H-11": managerConcurrency,
  "H-12": sustainedPerformance,
};

export default {
  performanceScenarioIds: ["deduplicated-incident-ingest", "incident-timeline-read", "escalation-recovery"],
  taskSpecificCaseIds: Object.keys(cases).sort(),
  cases,
};

function seed(deliveryUrl, { group = false } = {}) {
  const responders = ids.responders.map((responderId, index) => ({
    responderId,
    name: `Responder ${index + 1}`,
    deliveryUrl,
  }));
  const steps = group
    ? [{ stepIndex: 0, delaySeconds: 0, responderIds: ids.responders, quorumRequired: 2 }]
    : [
        { stepIndex: 0, delaySeconds: 0, responderId: ids.responders[0] },
        { stepIndex: 1, delaySeconds: 30, responderId: ids.responders[1] },
      ];
  return {
    schemaVersion: 1,
    seedVersion: group ? "hidden-manager-base" : "hidden-v1-base",
    services: [{ serviceId: ids.service, name: "Hidden Service", currentPolicyId: ids.policy, currentPolicyVersion: 1 }],
    responders,
    escalationPolicies: [{ policyId: ids.policy, version: 1, steps, expireAfterSeconds: 90 }],
    incidents: [],
    escalationSteps: [],
    notificationDeliveries: [],
  };
}

function createPayload(suffix = "main") {
  return {
    serviceId: ids.service,
    dedupKey: `hidden-${suffix}`,
    severity: "HIGH",
    title: `Hidden incident ${suffix}`,
    details: "Harness-owned deterministic incident",
  };
}

function incidentOf(response) {
  return response?.json?.incident ?? response?.json;
}

function withoutAsOf(snapshot) {
  const { asOf: _asOf, ...stable } = snapshot;
  return stable;
}

async function setup(ctx, { group = false } = {}) {
  await ctx.prepare();
  const receiver = await ctx.receiver();
  const imported = await ctx.seed(seed(receiver.url, { group }));
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const api = await ctx.startApi();
  return { api, receiver };
}

async function createIncident(ctx, baseUrl, key, payload = createPayload(key)) {
  const response = await ctx.mutate(baseUrl, "/api/v1/incidents", key, payload);
  assert.equal(response.status, 201, response.text);
  const incident = incidentOf(response);
  assert.equal(incident.state, "OPEN");
  assert.equal(incident.serviceId, ids.service);
  return { response, incident, payload };
}

async function waitForSent(ctx, baseUrl, incidentId, children = []) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const step = snapshot.resources.escalationSteps.find((item) => item.incidentId === incidentId && item.stepIndex === 0);
    return step?.state === "SENT" ? snapshot : undefined;
  }, { timeoutMs: 30_000, label: "first escalation step to become SENT", children });
}

async function mainFlow(ctx, assertions) {
  const { api, receiver } = await setup(ctx);
  const dispatcher = await ctx.startDispatcher(receiver.url);
  const worker = await ctx.startWorker();
  const { incident } = await createIncident(ctx, api.baseUrl, "h03-create");
  const sent = await waitForSent(ctx, api.baseUrl, incident.incidentId, [worker]);
  const step0 = sent.resources.escalationSteps.find((step) => step.incidentId === incident.incidentId && step.stepIndex === 0);
  assert.equal(step0.state, "SENT");
  assert.equal(sent.resources.notificationDeliveries.filter((delivery) => delivery.incidentId === incident.incidentId && delivery.state === "DELIVERED").length, 1);

  const acknowledgement = await ctx.mutate(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/acknowledge`, "h03-ack", { responderId: ids.responders[0] });
  assert.ok([200, 201].includes(acknowledgement.status), acknowledgement.text);
  assert.equal(incidentOf(acknowledgement).state, "ACKNOWLEDGED");
  const resolution = await ctx.mutate(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/resolve`, "h03-resolve", {
    responderId: ids.responders[0],
    resolution: "Recovered by Harness",
  });
  assert.equal(resolution.status, 200, resolution.text);
  assert.equal(incidentOf(resolution).state, "RESOLVED");

  const timeline = await ctx.request(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/timeline`);
  assert.equal(timeline.status, 200, timeline.text);
  const items = timeline.json?.items ?? timeline.json;
  assert.ok(Array.isArray(items) && items.length >= 4);
  assert.deepEqual(items.map(({ sequence }) => sequence), Array.from({ length: items.length }, (_, index) => index + 1));
  const final = await ctx.snapshot(api.baseUrl);
  const stored = final.resources.incidents.find((item) => item.incidentId === incident.incidentId);
  assert.equal(stored.state, "RESOLVED");
  assert.equal(final.resources.escalationSteps.find((item) => item.incidentId === incident.incidentId && item.stepIndex === 1).state, "SUPERSEDED");
  await ctx.waitFor(() => receiver.ledger.some((entry) => entry.headers["x-incidentrelay-event-type"] === "incident.resolved"), {
    timeoutMs: 30_000,
    label: "resolved Domain Event delivery",
    children: [dispatcher],
  });
  assertions.push("V1 create, delivery, acknowledge, resolve, timeline, work, and events agree");
}

async function atomicRejection(ctx, assertions) {
  const { api } = await setup(ctx);
  const { incident, payload } = await createIncident(ctx, api.baseUrl, "h04-create", createPayload("atomic"));
  const before = await ctx.snapshot(api.baseUrl);
  const conflict = await ctx.mutate(api.baseUrl, "/api/v1/incidents", "h04-dedup-conflict", { ...payload, title: "Different semantics" });
  assert.equal(conflict.status, 409, conflict.text);
  assert.equal(conflict.json?.error?.code, "INCIDENT_DEDUP_CONFLICT");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(before));

  const pendingAck = await ctx.mutate(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/acknowledge`, "h04-pending-ack", { responderId: ids.responders[1] });
  assert.equal(pendingAck.status, 409, pendingAck.text);
  assert.equal(pendingAck.json?.error?.code, "INCIDENT_NOT_ACKNOWLEDGEABLE");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(before));

  const stalePolicy = await ctx.mutate(api.baseUrl, `/api/v1/services/${ids.service}/escalation-policies`, "h04-stale-policy", {
    expectedCurrentVersion: 0,
    steps: [{ stepIndex: 0, delaySeconds: 0, responderId: ids.responders[0] }],
    expireAfterSeconds: 60,
  });
  assert.equal(stalePolicy.status, 409, stalePolicy.text);
  assert.equal(stalePolicy.json?.error?.code, "ESCALATION_POLICY_VERSION_CHANGED");
  assert.deepEqual(withoutAsOf(await ctx.snapshot(api.baseUrl)), withoutAsOf(before));
  assertions.push("dedup, pending acknowledgement, and stale policy failures are whole-state atomic");
}

async function durableIdempotency(ctx, assertions) {
  const { api } = await setup(ctx);
  const shield = await ctx.responseShield(api.baseUrl);
  const payload = createPayload("unknown-response");
  shield.dropNextMutation();
  await ctx.mutate(shield.baseUrl, "/api/v1/incidents", "h05-stable-key", payload).catch(() => undefined);
  await ctx.waitFor(() => shield.captures.length === 1, { label: "upstream committed response" });
  assert.equal(shield.captures[0].status, 201);

  const replay = await ctx.mutate(api.baseUrl, "/api/v1/incidents", "h05-stable-key", payload);
  assert.equal(replay.status, 201, replay.text);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(JSON.parse(shield.captures[0].body)));
  const concurrent = await ctx.concurrent(Array.from({ length: 20 }), 20, () => ctx.mutate(api.baseUrl, "/api/v1/incidents", "h05-stable-key", payload));
  assert.equal(new Set(concurrent.map((result) => `${result.status}:${ctx.canonical(result.json)}`)).size, 1);
  await ctx.stop(api);
  const restarted = await ctx.startApi();
  const afterRestart = await ctx.mutate(restarted.baseUrl, "/api/v1/incidents", "h05-stable-key", payload);
  assert.equal(ctx.canonical(afterRestart.json), ctx.canonical(replay.json));
  const conflict = await ctx.mutate(restarted.baseUrl, "/api/v1/incidents", "h05-stable-key", { ...payload, details: "changed" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json?.error?.code, "IDEMPOTENCY_CONFLICT");
  const snapshot = await ctx.snapshot(restarted.baseUrl);
  assert.equal(snapshot.resources.incidents.filter((item) => item.dedupKey === payload.dedupKey).length, 1);
  assertions.push("unknown response, 20-way replay, semantic conflict, and API restart preserve one result");
}

async function multiProcessContention(ctx, assertions) {
  await ctx.prepare();
  const receiver = await ctx.receiver();
  assert.equal((await ctx.seed(seed(receiver.url))).exitCode, 0);
  const apiA = await ctx.startApi();
  const apiB = await ctx.startApi();
  const workerA = await ctx.startWorker();
  const workerB = await ctx.startWorker();
  const payload = createPayload("hot");
  const creates = await ctx.concurrent(Array.from({ length: 40 }), 40, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    "/api/v1/incidents",
    `h06-create-${index}`,
    payload,
  ));
  assert.equal(creates.every(({ status }) => status === 201), true);
  const incidentIds = creates.map((response) => incidentOf(response).incidentId);
  assert.equal(new Set(incidentIds).size, 1);
  await waitForSent(ctx, apiA.baseUrl, incidentIds[0], [workerA, workerB]);
  const policyPayload = {
    expectedCurrentVersion: 1,
    steps: [{ stepIndex: 0, delaySeconds: 0, responderId: ids.responders[0] }],
    expireAfterSeconds: 60,
  };
  const policies = await ctx.concurrent(Array.from({ length: 20 }), 20, (_, index) => ctx.mutate(
    index % 2 ? apiA.baseUrl : apiB.baseUrl,
    `/api/v1/services/${ids.service}/escalation-policies`,
    `h06-policy-${index}`,
    policyPayload,
  ));
  assert.equal(policies.filter(({ status }) => status >= 200 && status < 300).length, 1);
  assert.equal(policies.filter(({ status, json }) => status === 409 && json?.error?.code === "ESCALATION_POLICY_VERSION_CHANGED").length, 19);
  const snapshot = await ctx.snapshot(apiB.baseUrl);
  assert.equal(snapshot.resources.incidents.filter((item) => item.dedupKey === payload.dedupKey).length, 1);
  assert.equal(snapshot.resources.services[0].currentPolicyVersion, 2);
  assertions.push("two APIs and two workers converge under 40-way incident and 20-way policy contention");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function workerRecovery(ctx, assertions) {
  await ctx.prepare();
  const held = deferred();
  const receiver = await ctx.receiver(async (entry) => entry.attempt === 1 ? held.promise : { status: 204 });
  assert.equal((await ctx.seed(seed(receiver.url))).exitCode, 0);
  const api = await ctx.startApi();
  const { incident } = await createIncident(ctx, api.baseUrl, "h07-create");
  const firstWorker = await ctx.startWorker();
  await ctx.waitFor(() => receiver.ledger.length === 1, { label: "worker external effect", children: [firstWorker] });
  await ctx.stop(firstWorker, "SIGKILL");
  held.resolve({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const replacement = await ctx.startWorker();
  await ctx.waitFor(() => receiver.ledger.length >= 2, { timeoutMs: 30_000, label: "reclaimed notification", children: [replacement] });
  assert.equal(receiver.ledger[0].headers["x-incidentrelay-notification-id"], receiver.ledger[1].headers["x-incidentrelay-notification-id"]);
  assert.equal(receiver.ledger[0].raw, receiver.ledger[1].raw);
  const snapshot = await waitForSent(ctx, api.baseUrl, incident.incidentId, [replacement]);
  assert.equal(snapshot.resources.notificationDeliveries.filter((delivery) => delivery.incidentId === incident.incidentId).length, 2);
  assertions.push("SIGKILL after external notification is reclaimed with stable identity and one business state");
}

async function outboxRecovery(ctx, assertions) {
  await ctx.prepare();
  const business = await ctx.receiver();
  assert.equal((await ctx.seed(seed(business.url))).exitCode, 0);
  const api = await ctx.startApi();
  await createIncident(ctx, api.baseUrl, "h08-create");
  const held = deferred();
  const events = await ctx.receiver(async (entry) => entry.attempt === 1 ? held.promise : { status: 204 });
  const first = await ctx.startDispatcher(events.url);
  await ctx.waitFor(() => events.ledger.length === 1, { label: "dispatcher received unknown ACK point", children: [first] });
  await ctx.stop(first, "SIGKILL");
  held.resolve({ status: 204 });
  const replacement = await ctx.startDispatcher(events.url);
  await ctx.waitFor(() => events.ledger.length >= 2, { timeoutMs: 30_000, label: "outbox retry", children: [replacement] });
  assert.equal(events.ledger[0].headers["x-incidentrelay-event-id"], events.ledger[1].headers["x-incidentrelay-event-id"]);
  assert.equal(events.ledger[0].raw, events.ledger[1].raw);
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.events.filter(({ type }) => type === "incident.opened").length, 1);
  assertions.push("unknown webhook ACK retries the same committed outbox event identity and body");
}

async function v1Migration(ctx, assertions) {
  const v1Workspace = await ctx.copyV1Workspace();
  await ctx.prepare(v1Workspace);
  const receiver = await ctx.receiver();
  assert.equal((await ctx.seed(seed(receiver.url), v1Workspace)).exitCode, 0);
  const v1Api = await ctx.startApi(v1Workspace);
  const created = await createIncident(ctx, v1Api.baseUrl, "h09-saved", createPayload("migration"));
  await ctx.stop(v1Api);

  await ctx.prepare();
  const finalApi = await ctx.startApi();
  const replay = await ctx.mutate(finalApi.baseUrl, "/api/v1/incidents", "h09-saved", created.payload);
  assert.equal(replay.status, created.response.status);
  assert.equal(ctx.canonical(replay.json), ctx.canonical(created.response.json));
  const snapshot = await ctx.snapshot(finalApi.baseUrl);
  assert.equal(snapshot.resources.incidents.some(({ incidentId }) => incidentId === created.incident.incidentId), true);
  assert.deepEqual(Object.keys(snapshot.resources).sort(), [...ctx.contract.snapshot.resources, ...ctx.contract.snapshot.managerResources].map(({ key }) => key).sort());
  assertions.push("populated V1 state and saved replay survive FINAL migration with Manager resources present");
}

async function installManagerFixture(ctx) {
  await ctx.prepare();
  const receiver = await ctx.receiver();
  assert.equal((await ctx.seed(seed(receiver.url))).exitCode, 0);
  const api = await ctx.startApi();
  const policy = await ctx.mutate(api.baseUrl, `/api/v1/services/${ids.service}/escalation-policies`, "manager-policy", {
    expectedCurrentVersion: 1,
    steps: [
      { stepIndex: 0, delaySeconds: 0, responderIds: ids.responders, quorumRequired: 2 },
      { stepIndex: 1, delaySeconds: 30, responderIds: [ids.responders[2]], quorumRequired: 1 },
    ],
    expireAfterSeconds: 60,
  });
  assert.ok([200, 201].includes(policy.status), policy.text);
  return { api, receiver };
}

async function managerBehavior(ctx, assertions) {
  const { api, receiver } = await installManagerFixture(ctx);
  const worker = await ctx.startWorker();
  const { incident } = await createIncident(ctx, api.baseUrl, "h10-create", createPayload("quorum"));
  await ctx.waitFor(() => receiver.ledger.filter((entry) => entry.headers["x-incidentrelay-notification-id"]).length >= 3, {
    timeoutMs: 30_000,
    label: "group notification delivery",
    children: [worker],
  });
  const first = await ctx.mutate(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/acknowledgements`, "h10-ack-1", {
    stepIndex: 0,
    responderId: ids.responders[0],
  });
  assert.ok([200, 201].includes(first.status), first.text);
  assert.equal(incidentOf(first).state, "OPEN");
  const second = await ctx.mutate(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/acknowledgements`, "h10-ack-2", {
    stepIndex: 0,
    responderId: ids.responders[1],
  });
  assert.ok([200, 201].includes(second.status), second.text);
  assert.equal(incidentOf(second).state, "ACKNOWLEDGED");
  const resolution = await ctx.mutate(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/resolve`, "h10-resolve", {
    responderId: ids.responders[0],
    resolution: "Harness quorum resolution",
  });
  assert.equal(resolution.status, 200, resolution.text);
  assert.equal(incidentOf(resolution).state, "RESOLVED");
  const replay = await ctx.mutate(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/acknowledgements`, "h10-ack-1", {
    stepIndex: 0,
    responderId: ids.responders[0],
  });
  assert.equal(replay.json?.replayed, true);
  assert.equal(replay.status, first.status);
  assert.equal(find(replay.json, "acknowledgementId"), find(first.json, "acknowledgementId"));
  assert.equal(find(replay.json, "incidentId"), incident.incidentId);
  const third = await ctx.mutate(api.baseUrl, `/api/v1/incidents/${incident.incidentId}/acknowledgements`, "h10-ack-3", {
    stepIndex: 0,
    responderId: ids.responders[2],
  });
  assert.equal(third.status, 409, third.text);
  assert.equal(third.json?.error?.code, "RESPONDER_NOT_IN_ACTIVE_QUORUM");
  const snapshot = await ctx.snapshot(api.baseUrl);
  assert.equal(snapshot.resources.incidentAcknowledgements.filter((item) => item.incidentId === incident.incidentId).length, 2);
  assert.equal(snapshot.resources.incidents.find((item) => item.incidentId === incident.incidentId).state, "RESOLVED");
  const laterSteps = snapshot.resources.escalationSteps.filter((item) => item.incidentId === incident.incidentId && item.stepIndex === 1);
  const laterNotifications = snapshot.resources.notificationDeliveries.filter((item) => item.incidentId === incident.incidentId && item.stepIndex === 1);
  assert.ok(laterSteps.length > 0 && laterSteps.every(({ state }) => state === "SUPERSEDED"));
  assert.ok(laterNotifications.length > 0 && laterNotifications.every(({ state }) => state === "SUPERSEDED"));
  assertions.push("Manager quorum preserves terminal duplicate replay and rejects extra votes without side effects");
}

async function managerConcurrency(ctx, assertions) {
  const { api, receiver } = await installManagerFixture(ctx);
  const apiB = await ctx.startApi();
  const workerA = await ctx.startWorker();
  const workerB = await ctx.startWorker();
  const { incident } = await createIncident(ctx, api.baseUrl, "h11-create", createPayload("manager-race"));
  await ctx.waitFor(() => receiver.ledger.filter((entry) => entry.headers["x-incidentrelay-notification-id"]).length >= 3, {
    timeoutMs: 30_000,
    label: "manager race notifications",
    children: [workerA, workerB],
  });
  const acknowledgements = await ctx.concurrent(ids.responders, 3, (responderId, index) => ctx.mutate(
    index % 2 ? api.baseUrl : apiB.baseUrl,
    `/api/v1/incidents/${incident.incidentId}/acknowledgements`,
    `h11-ack-${index}`,
    { stepIndex: 0, responderId },
  ));
  assert.equal(acknowledgements.filter(({ status }) => status >= 200 && status < 300).length, 2);
  const snapshot = await ctx.snapshot(apiB.baseUrl);
  assert.equal(snapshot.resources.incidentAcknowledgements.filter((item) => item.incidentId === incident.incidentId).length, 2);
  assert.equal(snapshot.resources.incidents.find((item) => item.incidentId === incident.incidentId).state, "ACKNOWLEDGED");
  const browser = await fetch(`${api.baseUrl}/`).then((response) => response.text());
  assert.match(browser, /incident|escalation|responder/iu);
  assertions.push("two APIs and workers converge on one quorum winner and the production UI exposes Manager state");
}

async function sustainedPerformance(ctx, assertions) {
  const durationScale = performanceScale();
  const metrics = [];

  const ingest = await incidentPerformanceDatabase(ctx, async ({ apiA, apiB }) => {
    let sequence = 0;
    const measured = await measuredLoad(ctx, { concurrency: 64, warmupMs: 10_000 * durationScale, measureMs: 60_000 * durationScale, request: async () => {
      const ordinal = sequence++;
      const duplicate = ordinal % 10 === 9;
      const dedupOrdinal = duplicate
        ? ordinal - Math.floor((ordinal + 1) / 10)
        : ordinal - Math.floor(ordinal / 10);
      const serviceId = perfUuid(1, dedupOrdinal % 1_000);
      const payload = {
        serviceId,
        dedupKey: `perf-measured-${dedupOrdinal}`,
        severity: ["LOW", "MEDIUM", "HIGH", "CRITICAL"][dedupOrdinal % 4],
        title: "perf incident",
        details: "x".repeat(64),
      };
      const response = await ctx.mutate(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, "/api/v1/incidents", `perf-ingest-${ordinal}`, payload);
      assert.equal(response.status, 201, response.text);
      return response;
    } });
    assert.ok(measured.throughput >= 200, `ingest throughput ${measured.throughput.toFixed(1)} < 200/s`);
    assert.ok(measured.p95 <= 250, `ingest p95 ${measured.p95.toFixed(1)}ms > 250ms`);
    const snapshot = await ctx.snapshot(apiA.baseUrl);
    const created = snapshot.resources.incidents.length - 100_000;
    assert.equal(created, sequence - Math.floor(sequence / 10));
    return measured;
  });
  assertions.push(`deduplicated-incident-ingest: ${ingest.throughput.toFixed(1)}/s, p95 ${ingest.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "deduplicated-incident-ingest", ...ingest });

  await ctx.resetDatabase();
  const timeline = await incidentPerformanceDatabase(ctx, async ({ apiA, apiB }) => {
    let sequence = 0;
    const measured = await measuredLoad(ctx, { concurrency: 64, warmupMs: 10_000 * durationScale, measureMs: 60_000 * durationScale, request: async () => {
      const ordinal = sequence++;
      const incidentId = perfUuid(4, ordinal % 100_000);
      const response = await ctx.request(ordinal % 2 ? apiA.baseUrl : apiB.baseUrl, `/api/v1/incidents/${incidentId}/timeline`);
      assert.equal(response.status, 200, response.text);
      const items = response.json?.items ?? response.json;
      assert.ok(Array.isArray(items));
      assert.deepEqual(items.map(({ sequence: itemSequence }) => itemSequence), Array.from({ length: items.length }, (_, index) => index + 1));
      return response;
    } });
    assert.ok(measured.throughput >= 250, `timeline throughput ${measured.throughput.toFixed(1)} < 250/s`);
    assert.ok(measured.p95 <= 150, `timeline p95 ${measured.p95.toFixed(1)}ms > 150ms`);
    return measured;
  });
  assertions.push(`incident-timeline-read: ${timeline.throughput.toFixed(1)}/s, p95 ${timeline.p95.toFixed(1)}ms`);
  metrics.push({ scenarioId: "incident-timeline-read", ...timeline });

  await ctx.resetDatabase();
  await ctx.prepare();
  const notifications = await ctx.receiver();
  assert.equal((await ctx.seed(performanceSeed(notifications.url))).exitCode, 0);
  const api = await ctx.startApi();
  const held = deferred();
  const barrier = await ctx.receiver((entry) => entry.json?.point === "worker.claimed" ? held.promise : { status: 204 });
  const workers = [
    await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-worker" }),
    await ctx.startWorker({ TEST_BARRIER_URL: barrier.url, TEST_BARRIER_TOKEN: "perf-worker" }),
  ];
  await ctx.waitFor(() => barrier.ledger.filter((entry) => entry.json?.point === "worker.claimed").length >= 2, {
    timeoutMs: 30_000,
    label: "two claimed escalation works",
    children: workers,
  });
  await Promise.all(workers.map((worker) => ctx.stop(worker, "SIGKILL")));
  held.resolve({ status: 204 });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const startedAt = Date.now();
  const replacements = [await ctx.startWorker(), await ctx.startWorker()];
  const final = await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const pending = snapshot.work.filter(({ kind, terminal }) => kind === "ESCALATION_STEP" && !terminal);
    return pending.length === 0 ? snapshot : undefined;
  }, { timeoutMs: 45_000, label: "3,000 escalation steps to drain", children: replacements });
  const drainMs = Date.now() - startedAt;
  assert.ok(drainMs <= 45_000, `escalation drain ${drainMs}ms > 45000ms`);
  assert.equal(final.resources.escalationSteps.filter(({ state }) => state === "SENT").length, 300_000);
  assert.equal(new Set(notifications.ledger.map((entry) => entry.headers["x-incidentrelay-notification-id"])).size, 3_000);
  assertions.push(`escalation-recovery: 3,000 due steps drained in ${drainMs}ms after two SIGKILLs`);
  metrics.push({ scenarioId: "escalation-recovery", completed: 3_000, durationMs: drainMs, killedWorkers: 2, replacementWorkers: 2 });
  return { metrics, fixtureSummary: { services: 1_000, responders: 10_000, incidents: 100_000, escalationSteps: 300_000, dueSteps: 3_000 } };
}

async function incidentPerformanceDatabase(ctx, operation) {
  await ctx.prepare();
  const receiver = await ctx.receiver();
  const imported = await ctx.seed(performanceSeed(receiver.url));
  assert.equal(imported.exitCode, 0, imported.stderr || imported.stdout);
  const apiA = await ctx.startApi();
  const apiB = await ctx.startApi();
  return operation({ apiA, apiB, receiver });
}

function perfUuid(namespace, ordinal) {
  return `${String(namespace).padStart(8, "0")}-0000-4000-8000-${String(ordinal + 1).padStart(12, "0")}`;
}

function performanceSeed(deliveryUrl) {
  const services = Array.from({ length: 1_000 }, (_, index) => ({
    serviceId: perfUuid(1, index),
    name: `Service ${index}`,
    currentPolicyId: perfUuid(3, index),
    currentPolicyVersion: 1,
  }));
  const responders = Array.from({ length: 10_000 }, (_, index) => ({
    responderId: perfUuid(2, index),
    name: `Responder ${index}`,
    deliveryUrl,
  }));
  const escalationPolicies = Array.from({ length: 1_000 }, (_, index) => ({
    policyId: perfUuid(3, index),
    version: 1,
    steps: Array.from({ length: 3 }, (_, stepIndex) => ({
      stepIndex,
      delaySeconds: stepIndex,
      responderId: perfUuid(2, index * 3 + stepIndex),
    })),
    expireAfterSeconds: 31_536_000,
  }));
  const incidents = [];
  const escalationSteps = [];
  const notificationDeliveries = [];
  for (let incidentIndex = 0; incidentIndex < 100_000; incidentIndex += 1) {
    const serviceIndex = incidentIndex % 1_000;
    const incidentId = perfUuid(4, incidentIndex);
    const pending = incidentIndex < 1_000;
    incidents.push({
      incidentId,
      serviceId: perfUuid(1, serviceIndex),
      dedupKey: `seed-${incidentIndex}`,
      severity: ["LOW", "MEDIUM", "HIGH", "CRITICAL"][incidentIndex % 4],
      title: `Seed incident ${incidentIndex}`,
      details: "seeded performance incident",
      state: "OPEN",
      policyId: perfUuid(3, serviceIndex),
      policyVersion: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
      nextEscalationAt: pending ? "2026-01-01T00:00:00.000Z" : null,
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolvedAt: null,
      sequence: pending ? 1 : 4,
    });
    for (let stepIndex = 0; stepIndex < 3; stepIndex += 1) {
      const responderId = perfUuid(2, serviceIndex * 3 + stepIndex);
      const notificationId = perfUuid(5 + stepIndex, incidentIndex);
      const state = pending ? "PENDING" : "DELIVERED";
      escalationSteps.push({
        incidentId,
        stepIndex,
        responderId,
        dueAt: `2026-01-01T00:00:0${stepIndex}.000Z`,
        state: pending ? "PENDING" : "SENT",
        notificationId,
        successfulDeliveryAt: pending ? null : `2026-01-01T00:00:1${stepIndex}.000Z`,
      });
      notificationDeliveries.push({
        notificationId,
        incidentId,
        stepIndex,
        responderId,
        deliveryUrl,
        body: {
          notificationId,
          incidentId,
          serviceId: perfUuid(1, serviceIndex),
          stepIndex,
          responderId,
          severity: ["LOW", "MEDIUM", "HIGH", "CRITICAL"][incidentIndex % 4],
          title: `Seed incident ${incidentIndex}`,
          details: "seeded performance incident",
        },
        state,
        attemptCount: pending ? 0 : 1,
        nextAttemptAt: pending ? `2026-01-01T00:00:0${stepIndex}.000Z` : null,
        successfulDeliveryAt: pending ? null : `2026-01-01T00:00:1${stepIndex}.000Z`,
      });
    }
  }
  return {
    schemaVersion: 1,
    seedVersion: "perf-v1",
    services,
    responders,
    escalationPolicies,
    incidents,
    escalationSteps,
    notificationDeliveries,
  };
}
