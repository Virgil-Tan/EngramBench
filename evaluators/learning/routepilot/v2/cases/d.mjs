import assert from "node:assert/strict";
import { assertEventSequence, assertNoSecrets, assertReleaseAuthority, assertRequestIdentity, canonicalJson, exactKeys } from "../oracles/index.mjs";
import {
  DISPATCH_KEYS,
  FINAL_KEYS,
  PUBLIC_PATHS,
  ROLLOUT_KEYS,
  STAGE_KEYS,
  V1_KEYS,
  assertRolloutDetail,
  clickVisible,
  createRollout,
  defineCase,
  dispatch,
  fillVisible,
  findField,
  guardedCase,
  launchBrowser,
  prepare,
  resources,
  semanticError,
  startUpstream,
  successful,
  waitRelease,
} from "./helpers.mjs";

const RESOURCE_KEYS = Object.freeze({
  tenants: ["tenantId", "name"],
  backends: ["backendId", "tenantId", "name", "originRedacted", "state"],
  routeDefinitions: ["routeId", "tenantId", "name", "priority"],
  routeRevisions: ["routeRevisionId", "routeId", "revision", "pathPattern", "methods", "headerMatches", "backends", "rateLimitPolicyId", "circuitPolicyId", "createdAt"],
  rateLimitPolicies: ["rateLimitPolicyId", "tenantId", "revision", "windowSeconds", "limit"],
  circuitPolicies: ["circuitPolicyId", "tenantId", "revision", "sampleSize", "failureThresholdPercent", "openSeconds", "halfOpenMax"],
  configReleases: ["configReleaseId", "tenantId", "version", "state", "routeRevisionIds", "priorReleaseId", "createdAt", "activatedAt"],
  gatewayRequests: ["gatewayRequestId", "tenantId", "requestKey", "configReleaseId", "routeRevisionId", "backendId", "backendVersion", "bucket", "status", "responseStatus", "createdAt"],
  upstreamAttempts: ["gatewayRequestId", "attempt", "backendId", "requestIdentity", "outcome", "startedAt", "finishedAt"],
  rateWindows: ["tenantId", "rateLimitPolicyId", "windowStart", "consumed"],
  circuitWindows: ["tenantId", "backendId", "epoch", "state", "sampleCount", "failureCount", "openUntil"],
  regionalRollouts: ROLLOUT_KEYS,
  regionalStages: STAGE_KEYS,
});
const WORK_KEYS = ["workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt"];

async function collection(ctx, baseUrl, path, tenantId, limit = 1) {
  const query = new URLSearchParams({ limit: String(limit), ...(tenantId ? { tenantId } : {}) });
  const response = successful(await ctx.request(baseUrl, `${path}?${query}`), `GET ${path}`);
  exactKeys(response.json, ["items", "nextCursor"], `${path} collection`);
  assert.ok(Array.isArray(response.json.items), `${path} items`);
  return response.json;
}

async function setControl(scope, name, value) {
  const named = scope.locator(`[name="${name}"]`).first();
  const labelled = scope.getByLabel(new RegExp(name.replaceAll(/([A-Z])/gu, " $1"), "i")).first();
  const control = await named.count() ? named : labelled;
  assert.ok(await control.count(), `visible ${name} control`);
  const tag = await control.evaluate((node) => node.tagName.toLowerCase());
  if (tag === "select") await control.selectOption(String(value));
  else await control.fill(typeof value === "string" ? value : JSON.stringify(value));
}

async function submitAndRead(page, path, action) {
  const pending = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === path);
  await clickVisible(page, action);
  const response = await pending;
  assert.ok(response.status() >= 200 && response.status() < 300, `${path} UI mutation returned ${response.status()}`);
  return response.json();
}

async function mutateFromUi(page, path, action, values) {
  const button = page.getByRole("button", { name: new RegExp(action, "i") }).first();
  assert.ok(await button.count(), `visible ${action} action`);
  const container = button.locator("xpath=ancestor::*[self::form or self::section or self::article][1]");
  const scope = await container.count() ? container : page;
  for (const [name, value] of Object.entries(values)) await setControl(scope, name, value);
  const pending = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === path);
  await button.click();
  const response = await pending;
  assert.ok(response.status() >= 200 && response.status() < 300, `${path} UI mutation returned ${response.status()}`);
  return response.json();
}

async function rowAction(page, identity, action) {
  const visible = page.getByText(identity, { exact: false }).first();
  assert.ok(await visible.count(), `UI displays ${identity}`);
  const row = visible.locator("xpath=ancestor::*[self::tr or @role='row' or self::article or self::section][1]");
  const button = row.getByRole("button", { name: new RegExp(action, "i") }).first();
  if (await button.count()) await button.click();
  else await clickVisible(page, action);
}

const D01 = guardedCase("D-01", ["ROUTE_AUTHORITY", "RELEASE_ATOMICITY"], async (ctx) => {
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.rollout([upstream.baseUrl, upstream.baseUrl]);
  const { api } = await prepare(ctx, fixture);
  const before = await ctx.snapshot(api.baseUrl);
  const openapi = successful(await ctx.request(api.baseUrl, "/openapi.json"), "OpenAPI").json;
  assert.equal(openapi.openapi, "3.1.0", "OpenAPI 3.1 exact version");
  for (const path of PUBLIC_PATHS) assert.ok(openapi.paths?.[path], `OpenAPI publishes ${path}`);
  const published = canonicalJson(openapi);
  for (const code of ["INVALID_REQUEST", "MALFORMED_JSON", "AMBIGUOUS_ROUTE", "INVALID_ROUTE_PATTERN", "INVALID_WEIGHT", "INVALID_POLICY", "NO_ACTIVE_RELEASE", "ROUTE_NOT_FOUND", "IDEMPOTENCY_CONFLICT", "VERSION_CONFLICT", "RELEASE_NOT_READY", "TERMINAL_STATE", "RATE_LIMITED", "CIRCUIT_OPEN", "UPSTREAM_TIMEOUT", "REGIONAL_ROLLOUT_TERMINAL", "REGIONAL_STAGE_NOT_READY", "REGIONAL_ROLLBACK_UNAVAILABLE", "EXPECTED_ROLLOUT_STATE_MISMATCH"]) assert.ok(published.includes(code), `OpenAPI publishes ${code}`);
  for (const path of ["/api/v1/tenants", "/api/v1/config-releases", "/api/v1/regional-rollouts"]) {
    assert.equal(openapi.paths[path].get?.responses?.["200"] !== undefined, true, `${path} GET 200`);
    assert.equal(openapi.paths[path].post?.responses?.["200"] !== undefined, true, `${path} POST 200`);
  }

  const tenants = await collection(ctx, api.baseUrl, "/api/v1/tenants", undefined, 100);
  assert.ok(tenants.items.some((item) => item.tenantId === fixture.tenant.tenantId), "tenant collection contains seeded tenant");
  for (const item of tenants.items) exactKeys(item, RESOURCE_KEYS.tenants, "Tenant");
  const releases = await collection(ctx, api.baseUrl, "/api/v1/config-releases", fixture.tenant.tenantId);
  for (const item of releases.items) exactKeys(item, RESOURCE_KEYS.configReleases, "ConfigRelease");
  const repeatPage = await collection(ctx, api.baseUrl, "/api/v1/config-releases", fixture.tenant.tenantId);
  assert.equal(canonicalJson(repeatPage), canonicalJson(releases), "collection cursor view stable without mutation");

  const detail = successful(await ctx.request(api.baseUrl, `/api/v1/config-releases/${fixture.release.configReleaseId}`), "ConfigRelease detail");
  exactKeys(detail.json, RESOURCE_KEYS.configReleases, "ConfigRelease detail");
  const created = await createRollout(ctx, api.baseUrl, fixture, "d01");
  assert.equal(created.response.status, 200, "RegionalRollout create status");
  exactKeys(created.response.json, ["regionalRollout", "stages"], "RegionalRollout create wrapper");
  assertRolloutDetail(created.response.json, fixture);

  const malformed = await ctx.request(api.baseUrl, "/api/v1/regional-rollouts", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("d01-malformed") }, raw: "{", contractExpectation: "invalid" });
  semanticError(malformed, 400, "MALFORMED_JSON");
  const duplicate = await ctx.request(api.baseUrl, "/api/v1/regional-rollouts", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": ctx.key("d01-duplicate") }, raw: `{"tenantId":"${fixture.tenant.tenantId}","tenantId":"${fixture.otherTenant?.tenantId ?? fixture.tenant.tenantId}","targetConfigReleaseId":"${fixture.target.configReleaseId}","stages":[],"requestRef":"duplicate"}`, contractExpectation: "invalid" });
  semanticError(duplicate, 400, "INVALID_REQUEST");
  const unknown = await ctx.mutate(api.baseUrl, "/api/v1/regional-rollouts", ctx.key("d01-unknown"), { ...created.body, unknown: true }, { contractExpectation: "invalid" });
  semanticError(unknown, 400, "INVALID_REQUEST");
  for (const [suffix, stages] of [["low", [{ region: "x", minimumObservationSeconds: 0, failureThresholdPercent: 1 }]], ["high", [{ region: "x", minimumObservationSeconds: 86401, failureThresholdPercent: 101 }]]]) {
    const response = await ctx.mutate(api.baseUrl, "/api/v1/regional-rollouts", ctx.key(`d01-range-${suffix}`), { ...created.body, requestRef: `range-${suffix}`, stages }, { contractExpectation: "invalid" });
    semanticError(response, 400, "INVALID_REQUEST");
  }
  const missing = await ctx.request(api.baseUrl, `/api/v1/regional-rollouts/${ctx.uuid("missing-rollout")}`);
  assert.equal(missing.status, 404, "missing rollout status");
  const terminal = successful(await ctx.mutate(api.baseUrl, `/api/v1/regional-rollouts/${created.regionalRolloutId}/cancel`, ctx.key("d01-cancel"), {}), "cancel rollout");
  assert.equal(findField(terminal.json, "state"), "CANCELLED", "cancel reaches terminal");
  semanticError(await ctx.mutate(api.baseUrl, `/api/v1/regional-rollouts/${created.regionalRolloutId}/resume`, ctx.key("d01-terminal"), {}), 409, "REGIONAL_ROLLOUT_TERMINAL");
  const after = await ctx.snapshot(api.baseUrl);
  assert.equal(resources(after).regionalRollouts.length, resources(before).regionalRollouts.length + 1, "only valid rollout persisted");
  assert.equal(resources(after).regionalStages.length, resources(before).regionalStages.length + 3, "only valid unique stages persisted");
  ctx.mark("contract.http-openapi.closed", { paths: PUBLIC_PATHS.length, errors: 21 });
  return ctx.pass();
});

const D02 = guardedCase("D-02", ["ROUTE_AUTHORITY", "RATE_CIRCUIT_CONSERVATION"], async (ctx) => {
  const upstream = await startUpstream(ctx, (entry) => ({ status: 200, headers: { "x-routepilot-ui": "live" }, json: { path: entry.path, accepted: true } }));
  const fixture = ctx.fixtures.routing([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 20;
  await ctx.migrate(); await ctx.seed(fixture.seed);
  const { api, page } = await launchBrowser(ctx);
  assert.match(await page.locator("body").innerText(), /route|gateway|release|tenant/iu, "production RoutePilot UI visible");
  const definition = await mutateFromUi(page, "/api/v1/route-definitions", "create.*route|add.*route", { tenantId: fixture.tenant.tenantId, name: "UI priority route", priority: 150 });
  const routeId = findField(definition, "routeId");
  assert.equal(typeof routeId, "string", "UI created RouteDefinition");
  const revision = await mutateFromUi(page, "/api/v1/route-revisions", "create.*revision|add.*revision", { routeId, revision: 1, pathPattern: "/ui/:itemId", methods: ["POST"], headerMatches: {}, backends: fixture.definition.revision.backends, rateLimitPolicyId: fixture.rate.rateLimitPolicyId, circuitPolicyId: fixture.circuit.circuitPolicyId });
  const routeRevisionId = findField(revision, "routeRevisionId");
  assert.equal(typeof routeRevisionId, "string", "UI created RouteRevision");
  const releaseBody = await mutateFromUi(page, "/api/v1/config-releases", "create.*release|activate.*release", { tenantId: fixture.tenant.tenantId, version: 2, routeRevisionIds: [routeRevisionId], expectedActiveVersion: 1 });
  const configReleaseId = findField(releaseBody, "configReleaseId");
  const worker = await ctx.startWorker();
  await waitRelease(ctx, api.baseUrl, configReleaseId, { processes: [worker] });

  const decision = await mutateFromUi(page, "/api/v1/gateway/dispatch", "dispatch|send.*request", { tenantId: fixture.tenant.tenantId, method: "POST", path: "/ui/visible", headers: { "x-route-affinity": "ui-affinity" }, body: { visible: true }, requestKey: "ui-visible-request" });
  exactKeys(decision, DISPATCH_KEYS, "UI gateway response");
  assert.equal(decision.routeRevisionId, routeRevisionId, "UI decision matches activated revision");
  assert.equal(upstream.ledger.length, 1, "UI dispatch reached real upstream");
  await page.reload({ waitUntil: "networkidle" });
  const visible = await page.locator("body").innerText();
  for (const value of [configReleaseId, routeRevisionId, decision.gatewayRequestId, decision.backendVersion]) assert.ok(visible.includes(String(value)), `UI shows ${value}`);
  assert.match(visible, /rate|consum|circuit|closed/iu, "UI shows rate and circuit authority");
  await page.context().setOffline(true);
  const refresh = page.getByRole("button", { name: /refresh|reload|retry/iu }).first();
  if (await refresh.count()) await refresh.click(); else await page.reload({ waitUntil: "domcontentloaded", timeout: 5_000 }).catch(() => undefined);
  await page.context().setOffline(false);
  assert.match(await page.locator("body").innerText(), /offline|network|retry|error/iu, "UI exposes offline recovery state");
  await page.reload({ waitUntil: "networkidle" });
  const primary = page.getByRole("button").first(); await primary.focus(); await page.keyboard.press("Tab");
  assert.ok(await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement !== document.body), "UI has keyboard focus order");
  ctx.mark("browser.v1-cross-layer", { configReleaseId, gatewayRequestId: decision.gatewayRequestId });
  return ctx.pass();
});

const D03 = guardedCase("D-03", ["RELEASE_ATOMICITY", "STALE_WORK_OR_LOST_WORK"], async (ctx) => {
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.rollout([upstream.baseUrl, upstream.baseUrl]);
  await ctx.migrate(); await ctx.seed(fixture.seed);
  const { api, page } = await launchBrowser(ctx);
  const createViaUi = async (suffix) => {
    const body = await mutateFromUi(page, "/api/v1/regional-rollouts", "create.*rollout|start.*rollout", { tenantId: fixture.tenant.tenantId, targetConfigReleaseId: fixture.target.configReleaseId, stages: fixture.stages, requestRef: `${fixture.requestRef}-${suffix}` });
    assertRolloutDetail(body, fixture);
    return findField(body, "regionalRolloutId");
  };
  const secondId = await createViaUi("d03-cancel");
  await page.reload({ waitUntil: "networkidle" });
  await rowAction(page, secondId, "cancel");
  const cancelled = await ctx.waitFor(async () => {
    const response = await ctx.request(api.baseUrl, `/api/v1/regional-rollouts/${secondId}`);
    return findField(response.json, "state") === "CANCELLED" ? response.json : undefined;
  }, { label: "UI cancel" });
  assert.equal(cancelled.regionalRollout.state, "CANCELLED", "HTTP agrees with UI cancel");
  const firstId = await createViaUi("d03-main");
  const worker = await ctx.startWorker();
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    const stage = resources(snapshot).regionalStages.find((item) => item.regionalRolloutId === firstId && item.ordinal === 0);
    return stage?.state === "ACTIVE" ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "UI rollout first stage", processes: [worker] });
  await page.reload({ waitUntil: "networkidle" });
  await rowAction(page, firstId, "pause");
  await ctx.waitFor(async () => findField((await ctx.request(api.baseUrl, `/api/v1/regional-rollouts/${firstId}`)).json, "state") === "PAUSED", { label: "UI pause" });
  await rowAction(page, firstId, "resume");
  await ctx.waitFor(async () => findField((await ctx.request(api.baseUrl, `/api/v1/regional-rollouts/${firstId}`)).json, "state") === "RUNNING", { label: "UI resume" });
  await rowAction(page, firstId, "rollback");
  const rolledBack = await ctx.waitFor(async () => {
    const response = await ctx.request(api.baseUrl, `/api/v1/regional-rollouts/${firstId}`);
    return findField(response.json, "state") === "ROLLED_BACK" ? response.json : undefined;
  }, { timeoutMs: 60_000, label: "UI rollback", processes: [worker] });
  assert.equal(rolledBack.regionalRollout.state, "ROLLED_BACK", "HTTP agrees with UI rollback");
  await page.reload({ waitUntil: "networkidle" });
  assert.ok((await page.locator("body").innerText()).includes(firstId), "rollout remains visible after refresh");
  assert.match(await page.locator("body").innerText(), /rolled.back/iu, "UI distinguishes rollback from cancel");
  assert.notEqual(cancelled.regionalRollout.state, rolledBack.regionalRollout.state, "cancel is not shown as rollback");
  assert.deepEqual(cancelled.stages.map(({ ordinal, region }) => ({ ordinal, region })), rolledBack.stages.map(({ ordinal, region }) => ({ ordinal, region })), "UI preserves frozen region order");
  ctx.mark("browser.rollout-controls", { firstId, secondId });
  return ctx.pass({ evidence: [{ kind: "browser-explicit-rollout-controls", firstId, secondId, controls: ["create", "pause", "resume", "cancel", "rollback"] }] });
});

const D04 = guardedCase("D-04", ["ROUTE_AUTHORITY", "STALE_WORK_OR_LOST_WORK"], async (ctx) => {
  const upstream = await startUpstream(ctx);
  const fixture = ctx.fixtures.rollout([upstream.baseUrl, upstream.baseUrl]);
  fixture.rate.limit = 100;
  const { api } = await prepare(ctx, fixture);
  await dispatch(ctx, api.baseUrl, fixture, 904, { requestKey: "d04-success" });
  await ctx.mutate(api.baseUrl, "/api/v1/gateway/dispatch", ctx.key("d04-rejected"), { tenantId: fixture.tenant.tenantId, method: "POST", path: "/missing/route", headers: {}, body: {}, requestKey: "d04-rejected" });
  const rollout = await createRollout(ctx, api.baseUrl, fixture, "d04");
  const worker = await ctx.startWorker();
  await ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(api.baseUrl);
    return resources(snapshot).regionalStages.some((item) => item.regionalRolloutId === rollout.regionalRolloutId && item.state === "ACTIVE") ? snapshot : undefined;
  }, { timeoutMs: 60_000, label: "populated rollout snapshot", processes: [worker] });
  await ctx.stop(worker);
  const snapshot = await ctx.snapshot(api.baseUrl);
  exactKeys(snapshot, ["schemaVersion", "asOf", "resources", "work", "events"], "verification snapshot");
  assert.equal(snapshot.schemaVersion, 1, "snapshot schemaVersion");
  assert.ok(Number.isFinite(Date.parse(snapshot.asOf)), "snapshot asOf RFC3339");
  exactKeys(snapshot.resources, FINAL_KEYS, "FINAL resources");
  for (const key of FINAL_KEYS) {
    assert.ok(Array.isArray(snapshot.resources[key]), `${key} array`);
    for (const item of snapshot.resources[key]) exactKeys(item, RESOURCE_KEYS[key], key);
  }
  for (const work of snapshot.work) {
    exactKeys(work, WORK_KEYS, "Work");
    assert.ok(["CONFIG_ACTIVATE", "CIRCUIT_RECONCILE", "REGIONAL_ROLLOUT_ADVANCE"].includes(work.kind), "Work kind union");
    assert.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state), "Work terminal agrees with state");
  }
  assert.ok(snapshot.resources.regionalStages.some((item) => item.region !== "GLOBAL"), "FINAL snapshot includes regional stages");
  assert.ok(snapshot.work.some((item) => item.kind === "REGIONAL_ROLLOUT_ADVANCE" && item.aggregateId === rollout.regionalRolloutId), "rollout Work retained");
  assert.ok(snapshot.events.length > 0, "durable Events retained");
  assert.equal(new Set(snapshot.events.map((item) => item.eventId)).size, snapshot.events.length, "Event identity unique");
  assertEventSequence(snapshot.events);
  assertReleaseAuthority(snapshot.resources.configReleases);
  assertRequestIdentity(snapshot.resources.gatewayRequests, snapshot.resources.upstreamAttempts);
  for (const [key, identity] of [["tenants", "tenantId"], ["backends", "backendId"], ["routeDefinitions", "routeId"], ["routeRevisions", "routeRevisionId"], ["configReleases", "configReleaseId"], ["gatewayRequests", "gatewayRequestId"], ["regionalRollouts", "regionalRolloutId"]]) {
    assert.deepEqual(snapshot.resources[key].map((item) => item[identity]), [...snapshot.resources[key].map((item) => item[identity])].sort(), `${key} sorted by identity`);
  }
  assertNoSecrets(snapshot, [ctx.adminToken, ctx.barrierToken, ctx.databaseUrl, upstream.baseUrl]);
  assert.ok(snapshot.resources.backends.every((item) => !Object.hasOwn(item, "origin") && item.originRedacted === true), "backend origins redacted");
  const repeat = await ctx.snapshot(api.baseUrl);
  assert.equal(canonicalJson({ ...snapshot, asOf: null }), canonicalJson({ ...repeat, asOf: null }), "idle snapshot is stable apart from asOf");
  ctx.mark("snapshot.final.closed", { resources: FINAL_KEYS.length, work: snapshot.work.length, events: snapshot.events.length });
  return ctx.pass();
});

export const D_CASES = [D01, D02, D03, D04];
