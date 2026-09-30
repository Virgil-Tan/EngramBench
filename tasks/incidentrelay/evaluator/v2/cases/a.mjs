import assert from "node:assert/strict";
import { canonicalJson, assertEventSequence, assertNotificationIdentity, exactKeys, freezePolicy, schedule } from "../oracles/index.mjs";
import { assertOpenApiContract } from "../oracles/openapi.mjs";
import { ACK_KEYS, DELIVERY_KEYS, GROUP_STEP_KEYS, INCIDENT_FINAL_KEYS, TIMELINE_KEYS, acknowledge, assertNotificationRequest, assertSnapshotShape, createIncident, createPolicy, defineCase, diagnostic, getIncident, guardedCase, legacyAcknowledge, prepare, resolveIncident, resources, semanticError, stableSnapshot, startReceivers, successful, timeline, waitSnapshot, waitStep } from "./helpers.mjs";

const A01 = guardedCase("A-01", ["PRODUCTION_BOOT"], async (ctx) => {
  await ctx.command("npm", ["ci"], { timeoutMs: 180_000 });
  await ctx.migrate(); await ctx.migrate(); await ctx.npm("build", [], { timeoutMs: 180_000 });
  const fixture = ctx.fixtures.empty(); await ctx.seed(fixture.seed);
  const domain = await ctx.receiver({ path: "/events" });
  const api = await ctx.startApi(), worker = await ctx.startWorker(), dispatcher = await ctx.startDispatcher({ webhookUrl: domain.url });
  const health = await ctx.request(api.baseUrl, "/healthz"), openapi = await ctx.request(api.baseUrl, "/openapi.json");
  assert.equal(health.status, 200, "production health"); assert.equal(openapi.status, 200, "production OpenAPI");
  assert.equal(new URL(api.baseUrl).hostname, "127.0.0.1", "API binds localhost");
  await ctx.stop(dispatcher); await ctx.stop(worker); await ctx.stop(api);
  for (const record of [api, worker, dispatcher]) assert.equal(record.forcedKill, undefined, `${record.role} handles SIGTERM`);
  ctx.mark("production.roles.booted", { roles: ["api", "worker", "dispatcher"] }); return ctx.pass();
});

const A02 = defineCase("A-02", async (ctx) => {
  const receivers = await startReceivers(ctx, 3);
  const fixture = ctx.fixtures.incident(receivers.map(({ url }) => url));
  const { api, workers } = await prepare(ctx, fixture, { workerCount: 1, migrateTwice: true });
  const created = await createIncident(ctx, api.baseUrl, fixture, "populated");
  await waitStep(ctx, api.baseUrl, created.incidentId, 0, "SENT", { processes: workers });
  await Promise.all(workers.map((worker) => ctx.stop(worker)));
  const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
  await ctx.migrate(); await ctx.migrate();
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(stableSnapshot(after), before, "repeat migration preserves populated resources Work Events and replay");
  const replay = await ctx.mutate(api.baseUrl, "/api/v1/incidents", ctx.key("incident:populated"), created.body);
  assert.equal(replay.status, created.response.status); assert.equal(canonicalJson(replay.json), canonicalJson(created.response.json), "saved replay survives migration");
  return ctx.pass();
});

const A03 = defineCase("A-03", async (ctx) => {
  const fixture = ctx.fixtures.incident(); const createdAt = ctx.at(), expiresAt = ctx.at({ seconds: fixture.policyV1.expireAfterSeconds }), incidentId = ctx.uuid("seed-incident");
  const incident = { incidentId, serviceId: fixture.service.serviceId, dedupKey: "seed-incident", severity: "HIGH", title: "Seed incident", details: "Atomic populated seed", state: "OPEN", policyId: fixture.policyV1.policyId, policyVersion: 1, createdAt, expiresAt, nextEscalationAt: createdAt, acknowledgedBy: null, acknowledgedAt: null, resolvedAt: null, sequence: 1 };
  const escalationSteps = fixture.policyV1.steps.map((step) => { const notificationId = ctx.uuid(`seed-notification:${step.stepIndex}`), dueAt = ctx.at({ seconds: step.delaySeconds }); return { incidentId, stepIndex: step.stepIndex, responderId: step.responderId, dueAt, state: "PENDING", notificationId, successfulDeliveryAt: null }; });
  const notificationDeliveries = escalationSteps.map((step) => { const responder = fixture.responders.find((item) => item.responderId === step.responderId); return { notificationId: step.notificationId, incidentId, stepIndex: step.stepIndex, responderId: step.responderId, deliveryUrl: responder.deliveryUrl, body: { notificationId: step.notificationId, incidentId, serviceId: fixture.service.serviceId, stepIndex: step.stepIndex, responderId: step.responderId, severity: incident.severity, title: incident.title, details: incident.details }, state: "PENDING", attemptCount: 0, nextAttemptAt: step.dueAt, successfulDeliveryAt: null }; });
  fixture.seed = { ...fixture.seed, incidents: [incident], escalationSteps, notificationDeliveries }; await ctx.migrate();
  await ctx.seed(fixture.seed); const api = await ctx.startApi(); const baseline = stableSnapshot(await ctx.snapshot(api.baseUrl));
  await ctx.seed(fixture.seed); assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), baseline, "same seed digest no-op");
  const conflict = { ...fixture.seed, services: fixture.seed.services.map((item) => ({ ...item, name: `${item.name} changed` })) };
  const conflictResult = await ctx.seed(conflict, { allowFailure: true }); assert.notEqual(conflictResult.exitCode, 0, "same seedVersion different digest rejected"); assert.match(`${conflictResult.stdout}\n${conflictResult.stderr}`, /SEED_VERSION_CONFLICT/u);
  const invalidSeeds = [
    { ...fixture.seed, seedVersion: "unknown-key", unknown: true },
    { ...fixture.seed, seedVersion: "duplicate-responder", responders: [...fixture.responders, fixture.responders[0]] },
    { ...fixture.seed, seedVersion: "missing-target", escalationPolicies: [{ ...fixture.policyV1, steps: [{ stepIndex: 0, delaySeconds: 0, responderId: ctx.uuid("missing") }] }] },
    { ...fixture.seed, seedVersion: "bad-delay", escalationPolicies: [{ ...fixture.policyV1, steps: [{ stepIndex: 0, delaySeconds: -1, responderId: fixture.responders[0].responderId }] }] },
    { ...fixture.seed, seedVersion: "bad-body", notificationDeliveries: notificationDeliveries.map((item, index) => index ? item : { ...item, body: { ...item.body, incidentId: ctx.uuid("wrong-body-incident") } }) },
    { ...fixture.seed, seedVersion: "bad-state", incidents: [{ ...incident, state: "BROKEN" }] },
    { ...fixture.seed, seedVersion: "bad-time", incidents: [{ ...incident, createdAt: "not-a-time" }] },
    { ...fixture.seed, seedVersion: "bad-int", incidents: [{ ...incident, sequence: 1.5 }] },
  ];
  for (const invalid of invalidSeeds) { const outcome = await ctx.seed(invalid, { allowFailure: true }); assert.notEqual(outcome.exitCode, 0, `invalid seed ${invalid.seedVersion}`); assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), baseline, `invalid seed ${invalid.seedVersion} atomic`); }
  return ctx.pass();
});

const A04 = defineCase("A-04", async (ctx) => {
  const fixture = ctx.fixtures.policy(); const { api } = await prepare(ctx, fixture);
  const document = successful(await ctx.request(api.baseUrl, "/openapi.json"), "OpenAPI", [200]).json;
  const schemas = assertOpenApiContract(document);
  const created = await createIncident(ctx, api.baseUrl, fixture, "openapi-live");
  assert.equal(created.response.status, 201, "runtime create status is frozen OpenAPI status");
  assert.deepEqual(Object.keys(created.response.json).sort(), [...INCIDENT_FINAL_KEYS].sort(), "FINAL Incident closed runtime shape");
  const v1Policy = successful(await ctx.request(api.baseUrl, `/api/v1/services/${fixture.service.serviceId}/escalation-policy`), "V1 policy runtime", [200]).json;
  assert.deepEqual(v1Policy.steps, fixture.policyV1.steps, "V1 singular policy variant remains live");
  const policy = await createPolicy(ctx, api.baseUrl, fixture, "openapi-group");
  assert.deepEqual(policy.policy.steps, freezePolicy(fixture.policyGroup).steps.map(({ stepIndex, delaySeconds, responderIds, quorumRequired }) => ({ stepIndex, delaySeconds, responderIds, quorumRequired })), "group policy runtime normalized");
  assert.deepEqual(Object.keys(schemas.Incident.properties).sort(), [...INCIDENT_FINAL_KEYS].sort(), "runtime Incident and closed schema share exact fields");
  const missing = await ctx.request(api.baseUrl, `/api/v1/incidents/${ctx.uuid("openapi-missing")}`); semanticError(missing, 404, "NOT_FOUND");
  const malformed = await ctx.request(api.baseUrl, "/api/v1/incidents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("openapi-malformed") }, raw: "{" }); semanticError(malformed, 400, "MALFORMED_JSON");
  const unauthorized = await ctx.request(api.baseUrl, "/api/v1/verification-snapshot"); semanticError(unauthorized, 401, "ADMIN_AUTH_REQUIRED");
  return ctx.pass();
});

const A05 = defineCase("A-05", async (ctx) => {
  const fixture = ctx.fixtures.policy(); const { api } = await prepare(ctx, fixture);
  const canary = await createIncident(ctx, api.baseUrl, fixture, "failure-canary");
  async function zeroEffect(label, operation, status, code) {
    const before = stableSnapshot(await ctx.snapshot(api.baseUrl));
    const replayBefore = await ctx.mutate(api.baseUrl, "/api/v1/incidents", ctx.key("incident:failure-canary"), canary.body);
    const response = await operation(); semanticError(response, status, code);
    assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), before, `${label} preserves resources Work and Events`);
    const replayAfter = await ctx.mutate(api.baseUrl, "/api/v1/incidents", ctx.key("incident:failure-canary"), canary.body);
    assert.equal(replayAfter.status, replayBefore.status, `${label} preserves replay status`); assert.equal(replayAfter.text, replayBefore.text, `${label} preserves replay body`);
  }
  await zeroEffect("unsupported media", () => ctx.request(api.baseUrl, "/api/v1/incidents", { method: "POST", headers: { "content-type": "text/plain", "idempotency-key": ctx.key("media") }, raw: "{}" }), 415, "UNSUPPORTED_MEDIA_TYPE");
  await zeroEffect("malformed JSON", () => ctx.request(api.baseUrl, "/api/v1/incidents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("json") }, raw: "{" }), 400, "MALFORMED_JSON");
  await zeroEffect("unknown field", () => ctx.mutate(api.baseUrl, "/api/v1/incidents", ctx.key("unknown"), { ...fixture.incidentBody("unknown"), unexpected: true }), 400, "UNKNOWN_FIELD");
  await zeroEffect("snapshot auth", () => ctx.request(api.baseUrl, "/api/v1/verification-snapshot"), 401, "ADMIN_AUTH_REQUIRED");
  await zeroEffect("not found", () => ctx.request(api.baseUrl, `/api/v1/incidents/${ctx.uuid("not-found")}`), 404, "NOT_FOUND");
  await zeroEffect("cursor", () => ctx.request(api.baseUrl, "/api/v1/incidents?cursor=not-opaque"), 400, "INVALID_CURSOR");
  for (const length of [1, 128]) successful(await ctx.request(api.baseUrl, "/api/v1/incidents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "i".repeat(length) }, json: fixture.incidentBody(`idempotency-${length}`, { dedupKey: `idempotency-${length}` }) }), `Idempotency-Key boundary ${length}`, [201]);
  for (const [label, key] of [["empty Idempotency-Key", ""], ["long Idempotency-Key", "i".repeat(129)], ["non-visible Idempotency-Key", "bad\tkey"]]) await zeroEffect(label, () => ctx.request(api.baseUrl, "/api/v1/incidents", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, json: fixture.incidentBody(label, { dedupKey: `bad-key-${label}` }) }), 400, "INVALID_REQUEST");
  for (const length of [1, 128]) successful(await ctx.mutate(api.baseUrl, "/api/v1/incidents", ctx.key(`dedup-boundary:${length}`), fixture.incidentBody(`dedup-${length}`, { dedupKey: "x".repeat(length) })), `dedup boundary ${length}`, [201]);
  for (const [label, dedupKey] of [["empty dedup", ""], ["long dedup", "x".repeat(129)], ["non-visible dedup", "bad\ndedup"]]) await zeroEffect(label, () => ctx.mutate(api.baseUrl, "/api/v1/incidents", ctx.key(`bad-dedup:${label}`), fixture.incidentBody(label, { dedupKey })), 400, "INVALID_REQUEST");
  for (const limit of [1, 100]) { const page = successful(await ctx.request(api.baseUrl, `/api/v1/incidents?limit=${limit}`), `limit boundary ${limit}`, [200]); assert.ok(page.json.items.length <= limit); }
  for (const limit of [0, 101, "1.5"]) await zeroEffect(`invalid limit ${limit}`, () => ctx.request(api.baseUrl, `/api/v1/incidents?limit=${limit}`), 400, "INVALID_REQUEST");

  let currentVersion = fixture.service.currentPolicyVersion;
  const validPolicies = [
    { steps: [{ stepIndex: 0, delaySeconds: 0, responderIds: fixture.responders.map(({ responderId }) => responderId), quorumRequired: 1 }, { stepIndex: 1, delaySeconds: 86_400, responderIds: fixture.responders.map(({ responderId }) => responderId), quorumRequired: 3 }], expireAfterSeconds: 86_401 },
    { steps: [{ stepIndex: 0, delaySeconds: 0, responderIds: [fixture.responders[0].responderId], quorumRequired: 1 }], expireAfterSeconds: 1 },
  ];
  for (let index = 0; index < validPolicies.length; index += 1) { const result = await createPolicy(ctx, api.baseUrl, fixture, `valid-boundary-${index}`, { expectedCurrentVersion: currentVersion, ...validPolicies[index] }); currentVersion = result.policy.version; }
  const invalidPolicies = [
    ["empty steps", [], 1, "INVALID_ESCALATION_POLICY"],
    ["negative delay", [{ stepIndex: 0, delaySeconds: -1, responderIds: [fixture.responders[0].responderId], quorumRequired: 1 }], 1, "INVALID_ESCALATION_POLICY"],
    ["delay above 86400", [{ stepIndex: 0, delaySeconds: 86_401, responderIds: [fixture.responders[0].responderId], quorumRequired: 1 }], 86_402, "INVALID_ESCALATION_POLICY"],
    ["fractional delay", [{ stepIndex: 0, delaySeconds: 1.5, responderIds: [fixture.responders[0].responderId], quorumRequired: 1 }], 2, "INVALID_ESCALATION_POLICY"],
    ["duplicate delay", [{ stepIndex: 0, delaySeconds: 1, responderIds: [fixture.responders[0].responderId], quorumRequired: 1 }, { stepIndex: 1, delaySeconds: 1, responderIds: [fixture.responders[1].responderId], quorumRequired: 1 }], 2, "INVALID_ESCALATION_POLICY"],
    ["decreasing delay", [{ stepIndex: 0, delaySeconds: 2, responderIds: [fixture.responders[0].responderId], quorumRequired: 1 }, { stepIndex: 1, delaySeconds: 1, responderIds: [fixture.responders[1].responderId], quorumRequired: 1 }], 3, "INVALID_ESCALATION_POLICY"],
    ["expiry not greater", [{ stepIndex: 0, delaySeconds: 1, responderIds: [fixture.responders[0].responderId], quorumRequired: 1 }], 1, "INVALID_ESCALATION_POLICY"],
    ["missing responder", [{ stepIndex: 0, delaySeconds: 0, responderIds: [ctx.uuid("missing-responder")], quorumRequired: 1 }], 1, "INVALID_ESCALATION_POLICY"],
    ["empty responder group", [{ stepIndex: 0, delaySeconds: 0, responderIds: [], quorumRequired: 1 }], 1, "INVALID_QUORUM_POLICY"],
    ["duplicate responder group", [{ stepIndex: 0, delaySeconds: 0, responderIds: [fixture.responders[0].responderId, fixture.responders[0].responderId], quorumRequired: 1 }], 1, "INVALID_QUORUM_POLICY"],
    ["zero quorum", [{ stepIndex: 0, delaySeconds: 0, responderIds: [fixture.responders[0].responderId], quorumRequired: 0 }], 1, "INVALID_QUORUM_POLICY"],
    ["quorum above cardinality", [{ stepIndex: 0, delaySeconds: 0, responderIds: [fixture.responders[0].responderId], quorumRequired: 2 }], 1, "INVALID_QUORUM_POLICY"],
  ];
  for (const [label, steps, expireAfterSeconds, code] of invalidPolicies) await zeroEffect(label, async () => (await createPolicy(ctx, api.baseUrl, fixture, `invalid-${label}`, { expectedCurrentVersion: currentVersion, steps, expireAfterSeconds, expectSuccess: false })).response, 400, code);
  return ctx.pass();
});

const A06 = defineCase("A-06", async (ctx) => {
  const fixture = ctx.fixtures.incident(); const { api } = await prepare(ctx, fixture);
  await ctx.concurrent(Array.from({ length: 111 }), 16, async (_, index) => createIncident(ctx, api.baseUrl, fixture, `page-${index}`));
  const ids = [], cursors = new Set(); let cursor;
  do { const response = successful(await ctx.request(api.baseUrl, `/api/v1/incidents?limit=17${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), "incident page", [200]); assert.deepEqual(Object.keys(response.json).sort(), ["items", "nextCursor"].sort()); ids.push(...response.json.items.map(({ incidentId }) => incidentId)); cursor = response.json.nextCursor; if (cursor) { assert.ok(!cursors.has(cursor), "cursor progresses"); cursors.add(cursor); } } while (cursor);
  assert.equal(ids.length, 111); assert.equal(new Set(ids).size, 111, "pagination has no omission or duplicate");
  const snapshot = await ctx.snapshot(api.baseUrl); assertSnapshotShape(snapshot); assert.equal(resources(snapshot).incidents.length, 111);
  const events = successful(await ctx.request(api.baseUrl, "/api/v1/domain-events?afterSequence=0&limit=100"), "event page", [200]).json; assert.ok(Array.isArray(events.items), "event page items");
  return ctx.pass();
});

const A07 = defineCase("A-07", async (ctx) => {
  const fixture = ctx.fixtures.policy(); const { apis } = await prepare(ctx, fixture, { apiCount: 2 });
  const before = successful(await ctx.request(apis[0].baseUrl, `/api/v1/services/${fixture.service.serviceId}/escalation-policy`), "current policy", [200]).json;
  const results = await Promise.all([0, 1].map((index) => createPolicy(ctx, apis[index].baseUrl, fixture, `cas-${index}`, { expectSuccess: false })));
  const winner = results.find(({ response }) => response.status === 200), loser = results.find(({ response }) => response.status === 409);
  assert.ok(winner && loser, "one policy CAS winner and one stale loser"); semanticError(loser.response, 409, "ESCALATION_POLICY_VERSION_CHANGED");
  assert.equal(winner.policy.version, before.version + 1, "version increments exactly once");
  const after = successful(await ctx.request(apis[0].baseUrl, `/api/v1/services/${fixture.service.serviceId}/escalation-policy`), "current policy after CAS", [200]).json;
  assert.equal(canonicalJson(after), canonicalJson(winner.policy));
  const snapshot = await ctx.snapshot(apis[0].baseUrl); assert.ok(resources(snapshot).escalationPolicies.some((item) => item.policyId === before.policyId && item.version === before.version), "old immutable policy retained");
  return ctx.pass();
});

const A08 = guardedCase("A-08", ["INCIDENT_TERMINAL_AUTHORITY", "IDEMPOTENCY_CORRECTNESS"], async (ctx) => {
  const fixture = ctx.fixtures.incident(); const { api } = await prepare(ctx, fixture);
  const first = await createIncident(ctx, api.baseUrl, fixture, "dedup"); assert.equal(first.incident.state, "OPEN");
  const identical = await ctx.mutate(api.baseUrl, "/api/v1/incidents", ctx.key("dedup-fresh"), first.body); successful(identical, "active semantic replay", [200, 201]); assert.equal(identical.json.incidentId, first.incidentId);
  const conflict = await ctx.mutate(api.baseUrl, "/api/v1/incidents", ctx.key("dedup-conflict"), { ...first.body, title: "different" }); semanticError(conflict, 409, "INCIDENT_DEDUP_CONFLICT");
  await createPolicy(ctx, api.baseUrl, fixture, "later-version"); const captured = await getIncident(ctx, api.baseUrl, first.incidentId);
  assert.equal(captured.policyId, first.incident.policyId); assert.equal(captured.policyVersion, first.incident.policyVersion, "Incident permanently captures policy version");
  const expected = schedule(fixture.policyV1, first.incident.createdAt); assert.equal(first.incident.expiresAt, expected[0].expiresAt); assert.equal(first.incident.nextEscalationAt, expected[0].dueAt);
  return ctx.pass();
});

const A09 = guardedCase("A-09", ["STALE_WORK_OR_LOST_DELIVERY", "EVENT_TRANSACTIONALITY"], async (ctx) => {
  let attempts = 0; const receivers = await startReceivers(ctx, 3, (index) => index === 0 && attempts++ === 0 ? { status: 500 } : { status: 204 });
  const fixture = ctx.fixtures.notification(receivers.map(({ url }) => url)); const { api, workers } = await prepare(ctx, fixture, { workerCount: 2 });
  const created = await createIncident(ctx, api.baseUrl, fixture, "delivery"); const snapshot = await waitStep(ctx, api.baseUrl, created.incidentId, 0, "SENT", { processes: workers, timeoutMs: 20_000 });
  const delivery = resources(snapshot).notificationDeliveries.find((item) => item.incidentId === created.incidentId && item.stepIndex === 0); assert.equal(delivery.state, "DELIVERED"); assert.ok(delivery.attemptCount >= 2, "failed attempt persisted before 2xx"); assertNotificationRequest(receivers[0].ledger.at(-1), delivery);
  assert.equal(new Set(receivers[0].ledger.map((entry) => entry.headers["x-incidentrelay-notification-id"])).size, 1, "retry identity stable"); assertNotificationIdentity(resources(snapshot).notificationDeliveries);
  return ctx.pass();
});

const A10 = guardedCase("A-10", ["INCIDENT_TERMINAL_AUTHORITY"], async (ctx) => {
  const receivers = await startReceivers(ctx, 3); const fixture = ctx.fixtures.incident(receivers.map(({ url }) => url)); const { api, workers } = await prepare(ctx, fixture, { workerCount: 2 });
  const pending = await createIncident(ctx, api.baseUrl, fixture, "pending"); const premature = await legacyAcknowledge(ctx, api.baseUrl, pending.incidentId, fixture.responders[1].responderId, "pending", { expectSuccess: false }); semanticError(premature, 409, "INCIDENT_NOT_ACKNOWLEDGEABLE");
  await waitStep(ctx, api.baseUrl, pending.incidentId, 0, "SENT", { processes: workers }); const winner = await legacyAcknowledge(ctx, api.baseUrl, pending.incidentId, fixture.responders[0].responderId, "winner"); assert.equal(winner.json.state, "ACKNOWLEDGED");
  const other = await legacyAcknowledge(ctx, api.baseUrl, pending.incidentId, fixture.responders[1].responderId, "other", { expectSuccess: false }); semanticError(other, 409, "INCIDENT_ALREADY_ACKNOWLEDGED");
  const beforeOutsider = stableSnapshot(await ctx.snapshot(api.baseUrl)); const outsider = await resolveIncident(ctx, api.baseUrl, pending.incidentId, ctx.uuid("outsider"), "outsider", { expectSuccess: false }); assert.ok(outsider.status >= 400, "outsider rejected"); assert.equal(stableSnapshot(await ctx.snapshot(api.baseUrl)), beforeOutsider, "outsider cannot mutate acknowledged authority");
  const resolved = await resolveIncident(ctx, api.baseUrl, pending.incidentId, fixture.responders[1].responderId, "alternate"); assert.equal(resolved.json.state, "RESOLVED");
  return ctx.pass({ diagnostics: [diagnostic("IR-A10-OUTSIDER-ERROR", "SPEC-GAP-05")] });
});

const A11 = guardedCase("A-11", ["INCIDENT_TERMINAL_AUTHORITY", "STALE_WORK_OR_LOST_DELIVERY"], async (ctx) => {
  const receivers = await startReceivers(ctx, 3, () => ({ status: 500 })); const fixture = ctx.fixtures.incident(receivers.map(({ url }) => url)); const { api } = await prepare(ctx, fixture);
  const shortPolicy = await createPolicy(ctx, api.baseUrl, fixture, "short-expiry", { steps: [{ stepIndex: 0, delaySeconds: 0, responderIds: [fixture.responders[0].responderId], quorumRequired: 1 }], expireAfterSeconds: 1 }); assert.equal(shortPolicy.response.status, 200);
  const created = await createIncident(ctx, api.baseUrl, fixture, "expiry"); await new Promise((resolve) => setTimeout(resolve, 1_100)); const worker = await ctx.startWorker();
  const snapshot = await waitSnapshot(ctx, api.baseUrl, (value) => resources(value).incidents.find((item) => item.incidentId === created.incidentId)?.state === "EXPIRED", { processes: [worker], timeoutMs: 15_000, label: "Incident expiry" });
  const incident = resources(snapshot).incidents.find((item) => item.incidentId === created.incidentId); assert.equal(incident.state, "EXPIRED"); assert.ok([...resources(snapshot).escalationSteps, ...resources(snapshot).groupEscalationSteps].filter((item) => item.incidentId === created.incidentId).every((item) => item.state === "SUPERSEDED"), "expiry supersedes steps");
  const ack = await acknowledge(ctx, api.baseUrl, created.incidentId, 0, fixture.responders[0].responderId, "expired", { expectSuccess: false }); assert.ok(ack.status >= 400); assert.equal((await getIncident(ctx, api.baseUrl, created.incidentId)).state, "EXPIRED");
  return ctx.pass();
});

const A12 = guardedCase("A-12", ["EVENT_TRANSACTIONALITY"], async (ctx) => {
  const business = await startReceivers(ctx, 3); const domain = await ctx.receiver({ path: "/events" }); const fixture = ctx.fixtures.event(business.map(({ url }) => url));
  await ctx.migrate(); await ctx.seed(fixture.seed); const api = await ctx.startApi(), worker = await ctx.startWorker(), dispatcher = await ctx.startDispatcher({ webhookUrl: domain.url });
  const created = await createIncident(ctx, api.baseUrl, fixture, "events"); await waitStep(ctx, api.baseUrl, created.incidentId, 0, "SENT", { processes: [worker] }); await legacyAcknowledge(ctx, api.baseUrl, created.incidentId, fixture.responders[0].responderId); await resolveIncident(ctx, api.baseUrl, created.incidentId, fixture.responders[0].responderId);
  const history = await timeline(ctx, api.baseUrl, created.incidentId); for (const item of history) assert.deepEqual(Object.keys(item).sort(), [...TIMELINE_KEYS].sort()); history.forEach((item, index) => assert.equal(item.sequence, index + 1));
  const snapshot = await ctx.snapshot(api.baseUrl); const events = snapshot.events.filter((item) => item.aggregateId === created.incidentId); assertEventSequence(events); assert.deepEqual(events.map(({ type }) => type), ["incident.opened", "escalation.sent", "incident.acknowledged", "incident.resolved"]); assert.ok(events.every(({ payload, schemaVersion }) => schemaVersion === 1 && canonicalJson(payload) === "{}"));
  await ctx.waitFor(() => domain.ledger.filter(({ acknowledged }) => acknowledged).length >= events.length, { timeoutMs: 15_000, processes: [dispatcher], label: "Domain Event delivery" }); assert.equal(business.some(({ ledger }) => ledger.some((entry) => entry.headers["x-incidentrelay-event-id"])), false, "business and Domain receivers separated");
  return ctx.pass();
});

const A13 = guardedCase("A-13", ["QUORUM_AUTHORITY", "STALE_WORK_OR_LOST_DELIVERY"], async (ctx) => {
  const released = new Set([0]); const receivers = await startReceivers(ctx, 3, (index) => released.has(index) ? { status: 204 } : { status: 500 }); const fixture = ctx.fixtures.quorum(receivers.map(({ url }) => url)); const { api, workers } = await prepare(ctx, fixture, { workerCount: 2 });
  const policy = await createPolicy(ctx, api.baseUrl, fixture, "group"); assert.deepEqual(policy.policy.steps[0].responderIds, [...new Set(fixture.policyGroup.steps[0].responderIds)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))), "responderIds byte sorted unique");
  const created = await createIncident(ctx, api.baseUrl, fixture, "group-notification");
  await ctx.waitFor(() => receivers[0].ledger.length > 0 && receivers[1].ledger.length > 0, { timeoutMs: 15_000, processes: workers, label: "group notification attempts" }); const before = await ctx.snapshot(api.baseUrl); const stepBefore = resources(before).groupEscalationSteps.find((item) => item.incidentId === created.incidentId && item.stepIndex === 0); assert.equal(stepBefore.state, "PENDING", "one delivery below quorum");
  released.add(1); const after = await waitStep(ctx, api.baseUrl, created.incidentId, 0, "SENT", { processes: workers, timeoutMs: 15_000 }); const step = resources(after).groupEscalationSteps.find((item) => item.incidentId === created.incidentId && item.stepIndex === 0); assert.deepEqual(Object.keys(step).sort(), [...GROUP_STEP_KEYS].sort()); assert.equal(step.notifications.length, step.responderIds.length); step.notifications.forEach((delivery, index) => { assert.deepEqual(Object.keys(delivery).sort(), [...DELIVERY_KEYS].sort()); assert.equal(delivery.responderId, step.responderIds[index]); }); assert.equal(step.notifications.filter(({ state }) => state === "DELIVERED").length >= step.quorumRequired, true);
  const bad = await createPolicy(ctx, api.baseUrl, fixture, "invalid-group", { expectedCurrentVersion: policy.policy.version, steps: [{ stepIndex: 0, delaySeconds: 0, responderIds: [], quorumRequired: 1 }], expectSuccess: false }); semanticError(bad.response, 400, "INVALID_QUORUM_POLICY");
  return ctx.pass({ diagnostics: [diagnostic("IR-A13-REMAINDER-DELIVERY", "SPEC-GAP-02")] });
});

const A14 = guardedCase("A-14", ["QUORUM_AUTHORITY", "IDEMPOTENCY_CORRECTNESS"], async (ctx) => {
  const receivers = await startReceivers(ctx, 3); const fixture = ctx.fixtures.quorum(receivers.map(({ url }) => url)); const { api, workers } = await prepare(ctx, fixture, { workerCount: 2 });
  const legacyIncident = await createIncident(ctx, api.baseUrl, fixture, "legacy-quorum1"); await waitStep(ctx, api.baseUrl, legacyIncident.incidentId, 0, "SENT", { processes: workers });
  await createPolicy(ctx, api.baseUrl, fixture, "group"); const created = await createIncident(ctx, api.baseUrl, fixture, "ack-quorum"); await waitStep(ctx, api.baseUrl, created.incidentId, 0, "SENT", { processes: workers });
  const first = await acknowledge(ctx, api.baseUrl, created.incidentId, 0, fixture.responders[0].responderId, "first"); assert.equal(first.json.incident.state, "OPEN"); assert.equal(first.json.replayed, false); exactKeys(first.json.acknowledgement, ACK_KEYS, "acknowledgement");
  const duplicate = await acknowledge(ctx, api.baseUrl, created.incidentId, 0, fixture.responders[0].responderId, "duplicate", { key: ctx.key("ack:first-duplicate") }); assert.equal(duplicate.json.replayed, true); assert.equal(duplicate.json.acknowledgement.acknowledgementId, first.json.acknowledgement.acknowledgementId);
  const quorum = await acknowledge(ctx, api.baseUrl, created.incidentId, 0, fixture.responders[1].responderId, "second"); assert.equal(quorum.json.incident.state, "ACKNOWLEDGED"); assert.equal(quorum.json.incident.acknowledgementStepIndex, 0); assert.equal(quorum.json.incident.acknowledgedBy, null); const beforeResolve = quorum.json.incident.acknowledgements;
  await resolveIncident(ctx, api.baseUrl, created.incidentId, fixture.responders[2].responderId, "group-resolve"); const afterResolve = await getIncident(ctx, api.baseUrl, created.incidentId); assert.deepEqual(afterResolve.acknowledgements, beforeResolve, "acknowledgement records immutable through resolution");
  const legacy = await legacyAcknowledge(ctx, api.baseUrl, legacyIncident.incidentId, fixture.responders[0].responderId, "legacy-compatible"); assert.equal(legacy.json.acknowledgedBy, fixture.responders[0].responderId); assert.equal(legacy.json.acknowledgements.length, 1);
  const wrong = await acknowledge(ctx, api.baseUrl, created.incidentId, 0, ctx.uuid("wrong-responder"), "wrong", { expectSuccess: false }); semanticError(wrong, 409, "RESPONDER_NOT_IN_ACTIVE_QUORUM");
  return ctx.pass({ diagnostics: [diagnostic("IR-A14-LEGACY-GROUP-ERROR", "SPEC-GAP-01"), diagnostic("IR-A14-RESOLUTION-RECORD", "SPEC-GAP-06")] });
});

export const A_CASES = [A01, A02, A03, A04, A05, A06, A07, A08, A09, A10, A11, A12, A13, A14];
