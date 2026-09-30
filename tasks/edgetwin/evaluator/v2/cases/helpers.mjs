import assert from "node:assert/strict";

import { baseSeed, receiptPermutation, waveRequest } from "../fixtures/index.mjs";
import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import { assertEdgeInvariants, canonicalJson } from "../oracles/index.mjs";

const builds = new Map();

export const V1_RESOURCE_KEYS = Object.freeze([
  "tenants", "devices", "deviceShadows", "deviceCommands", "commandReceipts",
  "firmwareReleases", "upgradeCampaigns", "upgradeTargets",
]);
export const FINAL_RESOURCE_KEYS = Object.freeze([...V1_RESOURCE_KEYS, "deploymentWaves", "waveDevices"]);
export const SHADOW_KEYS = Object.freeze(["deviceId", "desiredVersion", "desired", "reportedVersion", "reported", "updatedAt"]);
export const COMMAND_KEYS = Object.freeze(["commandId", "tenantId", "deviceId", "kind", "payload", "desiredVersion", "deliveryIdentity", "state", "expiresAt", "createdAt"]);
export const RECEIPT_KEYS = Object.freeze(["receiptId", "tenantId", "deviceId", "commandId", "deviceSequence", "outcome", "reportedPatch", "observedAt", "receivedAt"]);
export const CAMPAIGN_KEYS = Object.freeze(["upgradeCampaignId", "tenantId", "firmwareReleaseId", "state", "createdAt"]);
export const TARGET_KEYS = Object.freeze(["upgradeCampaignId", "deviceId", "priorFirmwareDigest", "state", "commandId"]);
export const DEPLOYMENT_WAVE_KEYS = Object.freeze(["deploymentWaveId", "tenantId", "upgradeCampaignId", "requestRef", "state", "currentWaveOrdinal", "waves", "createdAt", "updatedAt", "sequence"]);
export const WAVE_DEVICE_KEYS = Object.freeze(["deploymentWaveId", "waveOrdinal", "deviceId", "priorFirmwareReleaseId", "targetFirmwareReleaseId", "state", "commandId", "rollbackTargetId", "confirmedAt"]);

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^(?:CONTRACT|DATA|RECOVERY|LAYER|OPERATE)-\d{2}$/u.test(id) || !/^ET-F-/u.test(fixtureFamily ?? "") || action?.length < 24 || oracle?.length < 24 || typeof run !== "function") throw new TypeError("invalid EdgeTwin case definition");
  return Object.freeze({ taskId: "edgetwin", id, fixtureFamily, action, oracle, run });
}

export function guardedCase(definition) {
  return defineCase({ ...definition, async run(ctx) { return definition.run(ctx); } });
}

export function diagnosticCase(definition) {
  return defineCase({ ...definition, async run(ctx) {
    const details = await definition.run(ctx);
    ctx.mark("contract-gap", { assertionId: definition.assertionId, blockedBy: definition.blockedBy });
    return ctx.pass({ ...details, diagnostics: [ctx.diagnostic(definition.assertionId, definition.blockedBy)] });
  } });
}

export function clone(value) { return structuredClone(value); }
export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields`);
  return value;
}
export function expectStatus(ctx, response, status, label, options = {}) { ctx.equal(response.status, status, `${label} status`, options); return response.json; }
export function expectSuccess(ctx, response, status, label) {
  expectStatus(ctx, response, status, label);
  ctx.ok(response.json && typeof response.json === "object", `${label} JSON`);
  return response.json;
}
export function expectError(ctx, response, status, code, label, options = {}) {
  expectStatus(ctx, response, status, label, options);
  exactKeys(response.json, ["error"], `${label} envelope`);
  exactKeys(response.json.error, ["code", "message", "details"], `${label} error`);
  ctx.equal(response.json.error.code, code, `${label} error code`, options);
  return response.json.error;
}
export function resource(snapshot, key) {
  const value = snapshot?.resources?.[key];
  assert.ok(Array.isArray(value), `snapshot resource ${key}`);
  return value;
}
export function stableSnapshot(snapshot) {
  const { asOf: _asOf, ...value } = clone(snapshot);
  return value;
}
export function assertNoChange(ctx, before, after, label, hardCapIds = []) {
  ctx.equal(stableSnapshot(after), stableSnapshot(before), `${label} has zero durable effects`, { hardCapIds });
}

async function build(ctx, workspace) {
  const target = ctx.forWorkspace(workspace);
  if (!builds.has(target.workspace)) builds.set(target.workspace, target.npm("build", [], { timeoutMs: 600_000 }));
  await builds.get(target.workspace);
}

export async function prepare(ctx, options = {}) {
  const target = ctx.forWorkspace(options.workspace ?? ctx.workspace);
  if (options.build !== false) await build(ctx, target.workspace);
  if (options.migrate !== false) await target.migrate({ timeoutMs: options.migrateTimeoutMs ?? 300_000 });
  if (options.seed) await target.seed(options.seed, { timeoutMs: options.seedTimeoutMs ?? 600_000 });
  return target;
}

export async function startPreparedApi(ctx, options = {}) {
  const target = await prepare(ctx, options);
  return target.startApi(options.apiOptions ?? {});
}

export function edgeSeed(ctx, options = {}) { return baseSeed(ctx.fixtures, options); }

export async function patchDesired(ctx, baseUrl, deviceId, body, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/devices/${deviceId}/shadow/desired`, options.key ?? ctx.key(`patch-${deviceId}-${body.expectedVersion}`), body, { method: "PATCH" });
  if (options.allowFailure) return response;
  const shadow = expectSuccess(ctx, response, 200, "desired shadow patch");
  exactKeys(shadow, SHADOW_KEYS, "DeviceShadow");
  return { response, shadow };
}

export async function createCommand(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/device-commands", options.key ?? ctx.key(`command-${body.deviceId}`), body);
  if (options.allowFailure) return response;
  const command = expectSuccess(ctx, response, 200, "create command");
  exactKeys(command, COMMAND_KEYS, "DeviceCommand");
  return { response, command };
}

export async function connect(ctx, baseUrl, deviceId, tenantId, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/devices/${deviceId}/connect`, options.key ?? ctx.key(`connect-${deviceId}`), { tenantId });
  return options.allowFailure ? response : { response, body: expectSuccess(ctx, response, 200, "connect device") };
}

export async function disconnect(ctx, baseUrl, deviceId, tenantId, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/devices/${deviceId}/disconnect`, options.key ?? ctx.key(`disconnect-${deviceId}`), { tenantId });
  return options.allowFailure ? response : { response, body: expectSuccess(ctx, response, 200, "disconnect device") };
}

export async function poll(ctx, baseUrl, deviceId, tenantId, connectionId, limit = 100, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/devices/${deviceId}/poll`, options.key ?? ctx.key(`poll-${deviceId}-${limit}`), { tenantId, connectionId, limit });
  if (options.allowFailure) return response;
  const body = expectSuccess(ctx, response, 200, "device poll");
  const items = Array.isArray(body) ? body : body.items;
  ctx.ok(Array.isArray(items), "poll returns command envelopes");
  return { response, body, items };
}

export async function submitReceipt(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/command-receipts", options.key ?? ctx.key(`receipt-${body.receiptId}`), body);
  if (options.allowFailure) return response;
  const receipt = expectSuccess(ctx, response, 200, "command receipt");
  ctx.ok(receipt && typeof receipt === "object", "receipt response is an object");
  return { response, receipt };
}

export async function createCampaign(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/upgrade-campaigns", options.key ?? ctx.key("campaign-create"), body);
  if (options.allowFailure) return response;
  const campaign = expectSuccess(ctx, response, 200, "create campaign");
  exactKeys(campaign, CAMPAIGN_KEYS, "UpgradeCampaign");
  return { response, campaign };
}

export async function controlCampaign(ctx, baseUrl, campaignId, action, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/upgrade-campaigns/${campaignId}/${action}`, options.key ?? ctx.key(`campaign-${action}`), {});
  if (options.allowFailure) return response;
  const campaign = expectSuccess(ctx, response, 200, `campaign ${action}`);
  exactKeys(campaign, CAMPAIGN_KEYS, "UpgradeCampaign");
  return { response, campaign };
}

export async function createWave(ctx, baseUrl, body, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/deployment-waves", options.key ?? ctx.key("wave-create"), body);
  if (options.allowFailure) return response;
  const value = expectSuccess(ctx, response, 200, "create DeploymentWave");
  exactKeys(value, ["deploymentWave", "waveDevices"], "DeploymentWave create result");
  exactKeys(value.deploymentWave, DEPLOYMENT_WAVE_KEYS, "DeploymentWave");
  ctx.ok(Array.isArray(value.waveDevices), "WaveDevice list");
  for (const device of value.waveDevices) exactKeys(device, WAVE_DEVICE_KEYS, "WaveDevice");
  return { response, ...value };
}

export async function controlWave(ctx, baseUrl, deploymentWaveId, action, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/deployment-waves/${deploymentWaveId}/${action}`, options.key ?? ctx.key(`wave-${action}`), {});
  if (options.allowFailure) return response;
  const deploymentWave = expectSuccess(ctx, response, 200, `DeploymentWave ${action}`);
  exactKeys(deploymentWave, DEPLOYMENT_WAVE_KEYS, "DeploymentWave control result");
  return { response, deploymentWave };
}

export async function waitSnapshot(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    return predicate(snapshot) ? snapshot : false;
  }, { timeoutMs: options.timeoutMs ?? 60_000, intervalMs: options.intervalMs ?? 25, label: options.label ?? "EdgeTwin snapshot state", processes: options.processes });
}

export function assertSnapshot(ctx, snapshot, options = {}) {
  const keys = options.v1 ? V1_RESOURCE_KEYS : FINAL_RESOURCE_KEYS;
  ctx.equal(Object.keys(snapshot.resources).sort(), [...keys].sort(), options.v1 ? "exact V1 resource union" : "exact FINAL resource union");
  assertEdgeInvariants(snapshot);
  const text = canonicalJson(snapshot);
  ctx.ok(!/(?:authorization|databaseUrl|postgres(?:ql)?:\/\/|adminToken|signingMaterial|privateBroker|idempotencyKey|\/Users\/|\/tmp\/)/iu.test(text), "snapshot contains no secret or private endpoint");
  for (const work of snapshot.work ?? []) {
    ctx.ok(["COMMAND_DISPATCH", "COMMAND_EXPIRE", "UPGRADE_FANOUT", "RECEIPT_PROJECT", "DEPLOYMENT_WAVE_ADVANCE"].includes(work.kind), "published Work kind");
    ctx.equal(work.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(work.state), "Work terminal flag matches state");
  }
  return snapshot;
}

export function receiptBodies(ctx, seed = edgeSeed(ctx)) {
  return receiptPermutation(ctx.fixtures, seed);
}
export function deploymentWaveBody(ctx, seed, options = {}) { return waveRequest(ctx.fixtures, seed, options); }

export async function startWorkers(ctx, count, options = {}) {
  return Promise.all(Array.from({ length: count }, () => ctx.startWorker(options)));
}

export async function launchBrowser(ctx, baseUrl, viewport = { width: 1440, height: 1000 }) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  ctx.defer(() => browser.close());
  const browserContext = await browser.newContext({ viewport });
  const page = await browserContext.newPage();
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return { browser, browserContext, page };
}

async function firstVisible(locator) {
  for (let index = 0; index < await locator.count(); index += 1) {
    const item = locator.nth(index);
    if (await item.isVisible().catch(() => false)) return item;
  }
}

export async function clickControl(page, names) {
  for (const role of ["button", "link"]) for (const name of names) {
    const item = await firstVisible(page.getByRole(role, { name }));
    if (item) { await item.click(); return; }
  }
  throw new CaseFailure(`missing visible control ${String(names)}`);
}

export async function setField(page, labels, value) {
  for (const label of labels) {
    const item = await firstVisible(page.getByLabel(label));
    if (!item) continue;
    const tag = await item.evaluate((element) => element.tagName.toLowerCase());
    if (tag === "select") await item.selectOption(String(value));
    else await item.fill(String(value));
    return;
  }
  throw new CaseFailure(`missing visible field ${String(labels)}`);
}

export function openApiOperation(document, path, method) {
  const normalized = path.replace(/:([A-Za-z][A-Za-z0-9]*)/gu, "{$1}");
  const operation = document?.paths?.[normalized]?.[method.toLowerCase()];
  assert.ok(operation, `OpenAPI missing ${method.toUpperCase()} ${path}`);
  return operation;
}

export function requireV1(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  return ctx.v1Workspace;
}

export function addCaps(error, hardCapIds) {
  error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
  return error;
}

export function finalEvidence(ctx, values = {}) {
  return ctx.pass({ evidence: [{ kind: "edgetwin-case-summary", ...values }] });
}
