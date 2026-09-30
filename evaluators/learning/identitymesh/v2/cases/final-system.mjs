import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { EvaluationInfrastructureError } from "../lib/execution.mjs";
import { boot, createSuccessfulSession, requireStatus, resource, snapshot, waitSnapshot } from "./helpers.mjs";

export async function incidentScenario(ctx, label) {
  const { api, catalog } = await boot(ctx, { label });
  const login = await createSuccessfulSession(ctx, api.baseUrl, catalog, `${label}-login`);
  const before = await snapshot(ctx, api.baseUrl);
  const approverIds = ["security-owner", "security-reviewer"];
  const body = { tenantId: catalog.tenant.tenantId, approverIds, requiredApprovals: 2 };
  const key = ctx.key(`${label}-incident`);
  const incident = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/compromise-incidents", key, body), 201, "quarantine incident");
  assert.equal(incident.state, "QUARANTINED");
  assert.deepEqual([...incident.approverIds].sort(), [...approverIds].sort());
  assert.equal(incident.requiredApprovals, 2);
  const priorEpoch = Math.max(0, ...before.resources.compromiseIncidents.filter(x => x.tenantId === body.tenantId).map(x => x.compromiseEpoch));
  assert.equal(incident.compromiseEpoch, priorEpoch + 1, "quarantine advances the tenant epoch once");
  const replay = requireStatus(await ctx.mutate(api.baseUrl, "/api/v1/compromise-incidents", key, body), 201, "quarantine replay");
  assert.deepEqual(replay, incident, "incident replay identity");
  const after = await snapshot(ctx, api.baseUrl);
  assert.equal(resource(after, "sessions", "sessionId", login.session.sessionId).state, "REVOKED");
  assert.ok(after.resources.devices.filter(x => x.tenantId === body.tenantId).every(x => ["SUSPENDED", "REVOKED"].includes(x.state)), "quarantine suspends device trust");
  assert.equal(after.resources.signingKeys.filter(x => x.tenantId === body.tenantId && x.state === "ACTIVE").length, 0, "old keys stop issuing");
  assert.equal(after.resources.compromiseIncidents.filter(x => x.incidentId === incident.incidentId).length, 1);
  assert.equal(after.events.filter(x => x.aggregateId === incident.incidentId && x.type === "tenant.quarantined").length, 1);
  const denied = await ctx.refreshSession(api.baseUrl, login.session.sessionId, login.refreshToken, { key: ctx.key(`${label}-old-refresh`) });
  assert.equal(denied.status, 409, "quarantine denies an old Session");
  return { api, catalog, login, incident, before, after };
}

export async function approveIncident(ctx, api, incident, approverId, key = ctx.key("recovery-approval")) {
  return ctx.mutate(api.baseUrl, `/api/v1/compromise-incidents/${incident.incidentId}/approvals`, key,
    { approverId, expectedCompromiseEpoch: incident.compromiseEpoch });
}

export async function recoverIncident(ctx, scenario, { concurrent = false, restart = false } = {}) {
  let { api } = scenario;
  const { catalog, incident, login } = scenario;
  const first = requireStatus(await approveIncident(ctx, api, incident, incident.approverIds[0]), 200, "first approval");
  assert.equal(first.incident.state, "QUARANTINED", "one approval cannot satisfy quorum two");
  const invalid = await approveIncident(ctx, api, incident, "not-a-frozen-approver");
  assert.equal(invalid.status, 409); assert.equal(invalid.json.error.code, "APPROVER_NOT_ALLOWED");
  const approvalKey = ctx.key("final-approval");
  const approvals = await Promise.all(Array.from({ length: concurrent ? 16 : 1 }, () => approveIncident(ctx, api, incident, incident.approverIds[1], approvalKey)));
  for (const response of approvals) requireStatus(response, 200, "final approval replay");
  assert.ok(approvals.every(x => JSON.stringify(x.json) === JSON.stringify(approvals[0].json)), "same approval key replays one response");
  const ready = await snapshot(ctx, api.baseUrl);
  assert.equal(ready.resources.recoveryApprovals.filter(x => x.incidentId === incident.incidentId).length, 2);
  assert.equal(ready.events.filter(x => x.aggregateId === incident.incidentId && x.type === "tenant.recovery_ready").length, 1, "quorum emits exactly one transition");
  if (restart) {
    await ctx.stop(api);
    api = await ctx.startApi();
  }
  let worker = await ctx.startWorker();
  await waitSnapshot(ctx, api.baseUrl, state => state.resources.revocations.filter(x => x.tenantId === catalog.tenant.tenantId).every(x => x.state === "PROPAGATED"), { processes: [worker], label: "quarantine propagation before recovery" });
  const state = await snapshot(ctx, api.baseUrl);
  const active = state.resources.signingKeys.find(x => x.tenantId === catalog.tenant.tenantId && x.state === "ACTIVE");
  const key = requireStatus(await ctx.rotateKey(api.baseUrl, { tenantId: catalog.tenant.tenantId, expectedActiveKeyId: active?.keyId ?? null, retiringForSeconds: 0 }), 200, "new recovery signing key");
  assert.ok(Date.parse(key.activatedAt) >= Date.parse(incident.createdAt), "recovery key was activated after quarantine");
  const recoveryKey = ctx.key("recover-tenant");
  const body = { expectedCompromiseEpoch: incident.compromiseEpoch, newKeyId: key.keyId };
  const responses = await Promise.all(Array.from({ length: concurrent ? 16 : 1 }, () => ctx.mutate(api.baseUrl, `/api/v1/compromise-incidents/${incident.incidentId}/recover`, recoveryKey, body)));
  for (const response of responses) requireStatus(response, 200, "recover replay");
  assert.ok(responses.every(x => JSON.stringify(x.json) === JSON.stringify(responses[0].json)), "same recovery key preserves response identity");
  if (restart) {
    const committed = await snapshot(ctx, api.baseUrl);
    assert.equal(committed.work.filter(x => x.kind === "TENANT_RECOVERY").length, 1, "recovery committed one durable Work before replacement");
    await ctx.kill(worker);
    worker = await ctx.startWorker();
  }
  const final = await waitSnapshot(ctx, api.baseUrl, state => resource(state, "compromiseIncidents", "incidentId", incident.incidentId)?.state === "RECOVERED", { processes: [worker], label: "tenant recovered" });
  assert.equal(final.events.filter(x => x.aggregateId === incident.incidentId && x.type === "tenant.recovered").length, 1);
  assert.equal(resource(final, "sessions", "sessionId", login.session.sessionId).state, "REVOKED", "recovery never resurrects old Session");
  assert.ok(final.resources.devices.filter(x => x.tenantId === catalog.tenant.tenantId).every(x => x.state !== "TRUSTED"), "recovery never restores old trust");
  assert.equal(resource(final, "compromiseIncidents", "incidentId", incident.incidentId).newKeyId, key.keyId);
  return { api, final, incidentId: incident.incidentId, approvals: 2, recoveryResponses: responses.length };
}

export async function productionShell(ctx, api) {
  const response = await ctx.request(api.baseUrl, "/");
  assert.equal(response.status, 200, "production UI responds");
  assert.match(response.text, /<(?:html|div|main|body)\b/iu, "production UI is HTML");
  const { chromium } = await import("playwright-core");
  let executablePath;
  for (const path of [process.env.CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean)) {
    try { await access(path); executablePath = path; break; } catch {}
  }
  if (!executablePath) throw new EvaluationInfrastructureError("EVALUATOR_CHROMIUM_UNAVAILABLE", "Chromium is unavailable");
  const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const page = await browser.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(api.baseUrl, { waitUntil: "networkidle" });
    assert.ok((await page.locator("body").innerText()).trim(), "production UI renders visible content");
    await page.reload({ waitUntil: "networkidle" });
    assert.deepEqual(errors, [], "production UI survives reload");
  } finally { await browser.close(); }
}
