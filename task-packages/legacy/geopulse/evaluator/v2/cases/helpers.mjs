import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { coreSeed, createFixtureFactory, locationEvent } from "../fixtures/index.mjs";
import { CaseExcluded, CaseFailure } from "../lib/execution.mjs";
import {
  assertContiguousTransitions,
  assertEventLedger,
  canonicalJson,
  classifyPoint,
  percentile,
  projectTimeline,
} from "../oracles/index.mjs";

const buildByWorkspace = new Map();

export const BUNDLE_KEYS = Object.freeze([
  "bundleId", "tenantId", "name", "currentRevision", "currentBundleRevisionId", "createdAt",
]);
export const BUNDLE_REVISION_KEYS = Object.freeze([
  "bundleRevisionId", "bundleId", "tenantId", "revision", "regionVersionIds", "effectiveFrom", "createdAt",
]);
export const WORK_KEYS = Object.freeze([
  "workId", "kind", "aggregateId", "state", "terminal", "attempt", "leaseOwner", "leaseExpiresAt",
]);
export const V1_SNAPSHOT_RESOURCES = Object.freeze([
  "tenants", "devices", "regions", "regionVersions", "locationEvents", "memberships", "transitions",
]);
export const FINAL_SNAPSHOT_RESOURCES = Object.freeze([
  ...V1_SNAPSHOT_RESOURCES, "regionBundles", "regionBundleRevisions",
]);

export function defineCase({ id, fixtureFamily, action, oracle, run }) {
  if (!/^[A-E]-\d{2}$/u.test(id) || !/^GP-F-/u.test(fixtureFamily ?? "") || action?.length < 24 || oracle?.length < 24 || typeof run !== "function") {
    throw new TypeError("invalid GeoPulse case definition");
  }
  return Object.freeze({ taskId: "geopulse", id, fixtureFamily, action, oracle, run });
}

export function guardedCase(definition, hardCapIds = []) {
  return defineCase({
    ...definition,
    async run(ctx) {
      try { return await definition.run(ctx); }
      catch (error) {
        if (error && typeof error === "object") error.hardCapIds = [...new Set([...(error.hardCapIds ?? []), ...hardCapIds])];
        throw error;
      }
    },
  });
}

export function candidateFailure(message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) {
  throw new CaseFailure(message, { failureCodeSuffix, hardCapIds });
}

export function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has a non-contract field set`);
  return value;
}

export function expectStatus(ctx, response, status, label, options = {}) {
  ctx.equal(response.status, status, `${label} HTTP status`, options);
  return response.json;
}

export function expectSuccess(ctx, response, label, status = 200, options = {}) {
  expectStatus(ctx, response, status, label, options);
  ctx.ok(response.json && typeof response.json === "object", `${label} JSON body`, options);
  return response.json;
}

export function errorCode(response) {
  return response.json?.error?.code ?? response.json?.code;
}

export function expectError(ctx, response, status, code, label, options = {}) {
  expectStatus(ctx, response, status, label, options);
  ctx.equal(errorCode(response), code, `${label} semantic error`, options);
  return response.json;
}

export function expectStableRejection(ctx, response, allowedStatuses, label, options = {}) {
  ctx.ok(allowedStatuses.includes(response.status), `${label} must reject with ${allowedStatuses.join("/")}`, options);
  ctx.ok(typeof errorCode(response) === "string" && errorCode(response).length > 0, `${label} has a stable semantic category`, options);
  return errorCode(response);
}

export function collection(json, label) {
  exactKeys(json, ["items", "nextCursor"], label);
  assert.ok(Array.isArray(json.items), `${label}.items must be an array`);
  assert.ok(json.nextCursor === null || typeof json.nextCursor === "string", `${label}.nextCursor must be null or text`);
  return json.items;
}

export function fixtureOptions(ctx) {
  return { evaluationSeed: ctx.evaluationSeed, caseId: ctx.caseId, baseTime: ctx.fixtures.baseTime };
}

export function freshFixtures(ctx, suffix) {
  return createFixtureFactory({ ...fixtureOptions(ctx), caseId: `${ctx.caseId}-${suffix}` });
}

export function coreFixture(ctx, options = {}) {
  return coreSeed(ctx.fixtures, options);
}

export function scaleRegionSeed(ctx, regionCount, deviceCount = 2) {
  if (!Number.isSafeInteger(regionCount) || regionCount < 1 || regionCount > 10_000) throw new TypeError("regionCount must be 1..10000");
  if (!Number.isSafeInteger(deviceCount) || deviceCount < 1) throw new TypeError("deviceCount must be positive");
  const seed = coreFixture(ctx);
  const tenantId = seed.tenants[0].tenantId;
  seed.regions = [];
  seed.regionVersions = [];
  seed.devices = [];
  for (let index = 0; index < regionCount; index += 1) {
    const regionId = ctx.uuid(`scale-region-${index}`);
    const regionVersionId = ctx.uuid(`scale-version-${index}`);
    const offset = index * 0.000001;
    seed.regions.push({ regionId, tenantId, name: `Evaluator Region ${index}`, createdAt: ctx.at({ days: -2 }) });
    seed.regionVersions.push({
      regionVersionId,
      regionId,
      tenantId,
      revision: 1,
      effectiveFrom: ctx.at({ days: -1 }),
      effectiveTo: null,
      polygon: [[offset, 0], [0.01 + offset, 0], [0.01 + offset, 0.01], [offset, 0.01], [offset, 0]],
      boundaryToleranceMeters: 5,
      dwellSeconds: 60,
      createdAt: ctx.at({ days: -2 }),
    });
  }
  for (let index = 0; index < deviceCount; index += 1) {
    seed.devices.push({ deviceId: ctx.uuid(`scale-device-${index}`), tenantId, externalRef: `scale-device-${index}`, createdAt: ctx.at({ days: -2 }) });
  }
  return seed;
}

export function clone(value) { return structuredClone(value); }

async function ensureBuild(ctx, workspace) {
  const target = ctx.forWorkspace(workspace);
  if (!buildByWorkspace.has(target.workspace)) buildByWorkspace.set(target.workspace, target.npm("build", [], { timeoutMs: 600_000 }));
  await buildByWorkspace.get(target.workspace);
}

export async function prepare(ctx, options = {}) {
  const workspace = options.workspace ?? ctx.workspace;
  const target = ctx.forWorkspace(workspace);
  if (options.build !== false) await ensureBuild(ctx, workspace);
  if (options.migrate !== false) {
    await target.migrate({ timeoutMs: 300_000 });
    if (options.migrateTwice) await target.migrate({ timeoutMs: 300_000 });
  }
  if (options.seed) await target.seed(options.seed, { timeoutMs: options.seedTimeoutMs ?? 600_000 });
  ctx.mark("candidate-prepared", { workspace: target.workspace, seeded: Boolean(options.seed) });
  return target;
}

export async function startPreparedApi(ctx, options = {}) {
  const target = await prepare(ctx, options);
  return target.startApi(options.api ?? {});
}

export function snapshotResources(snapshot) {
  assert.ok(snapshot?.resources && typeof snapshot.resources === "object" && !Array.isArray(snapshot.resources), "snapshot.resources must be an object");
  return snapshot.resources;
}

export function resource(snapshot, key) {
  const value = snapshotResources(snapshot)[key];
  assert.ok(Array.isArray(value), `snapshot resource ${key} must be an array`);
  return value;
}

export function findBy(items, field, value) { return items.find((item) => item?.[field] === value); }

export function recursiveField(value, field) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, field)) return value[field];
  for (const child of Object.values(value)) {
    const found = recursiveField(child, field);
    if (found !== undefined) return found;
  }
}

export function eventPayload(ctx, sequence, point, fields = {}) {
  return locationEvent(ctx.fixtures, sequence, point, fields.offset ?? { seconds: sequence }, fields);
}

export async function acceptEvent(ctx, baseUrl, event, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/location-events", options.key ?? ctx.key(`location-${event.eventId}`), event);
  expectSuccess(ctx, response, options.label ?? `accept LocationEvent ${event.eventId}`, options.status ?? 200, options.assertionOptions);
  ctx.equal(recursiveField(response.json, "eventId"), event.eventId, "accepted LocationEvent identity", options.assertionOptions);
  return response;
}

export async function acceptBatch(ctx, baseUrl, events, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/location-events/batch", options.key ?? ctx.key("location-batch"), { events });
  if (options.expectedStatus !== undefined) expectStatus(ctx, response, options.expectedStatus, options.label ?? "LocationEvent batch", options.assertionOptions);
  else expectSuccess(ctx, response, options.label ?? "LocationEvent batch");
  return response;
}

export async function waitForDrain(ctx, baseUrl, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl, { timeoutMs: options.requestTimeoutMs ?? 10_000 });
    return (snapshot.work ?? []).every(({ terminal }) => terminal) ? snapshot : false;
  }, {
    timeoutMs: options.timeoutMs ?? 120_000,
    intervalMs: options.intervalMs ?? 20,
    label: options.label ?? "GeoPulse Work drainage",
    processes: options.processes,
  });
}

export async function waitForWork(ctx, baseUrl, predicate, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl, { timeoutMs: 5_000 });
    const work = (snapshot.work ?? []).find(predicate);
    return work ? { snapshot, work } : false;
  }, {
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: options.intervalMs ?? 5,
    label: options.label ?? "public Work state",
    processes: options.processes,
  });
}

export async function waitForLeaseExpiry(ctx, baseUrl, workId, options = {}) {
  return ctx.waitFor(async () => {
    const snapshot = await ctx.snapshot(baseUrl);
    const work = (snapshot.work ?? []).find((item) => item.workId === workId);
    if (!work) return false;
    const expired = work.leaseExpiresAt !== null && Date.parse(work.leaseExpiresAt) <= Date.now();
    return expired || work.state === "PENDING" ? { snapshot, work } : false;
  }, { timeoutMs: options.timeoutMs ?? 30_000, intervalMs: 20, label: "Work lease expiry" });
}

export async function createBundle(ctx, baseUrl, tenantId, options = {}) {
  const response = await ctx.mutate(baseUrl, "/api/v1/region-bundles", options.key ?? ctx.key("bundle-create"), {
    tenantId,
    name: options.name ?? "Evaluator Region Bundle",
  });
  expectSuccess(ctx, response, options.label ?? "create RegionBundle");
  exactKeys(response.json, ["bundle"], "RegionBundle create response");
  exactKeys(response.json.bundle, BUNDLE_KEYS, "RegionBundle");
  ctx.equal(response.json.bundle.currentRevision, 0, "new RegionBundle revision");
  ctx.equal(response.json.bundle.currentBundleRevisionId, null, "new RegionBundle active revision");
  return response.json.bundle;
}

export async function publishBundle(ctx, baseUrl, bundleId, body, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/region-bundles/${bundleId}/publish`, options.key ?? ctx.key(`bundle-publish-${body.expectedRevision}`), body);
  if (options.allowFailure) return response;
  expectSuccess(ctx, response, options.label ?? "publish RegionBundle");
  exactKeys(response.json, ["bundle", "revision"], "RegionBundle publish response");
  exactKeys(response.json.bundle, BUNDLE_KEYS, "published RegionBundle");
  exactKeys(response.json.revision, BUNDLE_REVISION_KEYS, "RegionBundleRevision");
  return response.json;
}

export async function rollbackBundle(ctx, baseUrl, bundleId, body, options = {}) {
  const response = await ctx.mutate(baseUrl, `/api/v1/region-bundles/${bundleId}/rollback`, options.key ?? ctx.key(`bundle-rollback-${body.expectedRevision}`), body);
  if (options.allowFailure) return response;
  expectSuccess(ctx, response, options.label ?? "rollback RegionBundle");
  exactKeys(response.json, ["bundle", "revision"], "RegionBundle rollback response");
  exactKeys(response.json.bundle, BUNDLE_KEYS, "rolled back RegionBundle");
  exactKeys(response.json.revision, BUNDLE_REVISION_KEYS, "rollback RegionBundleRevision");
  return response.json;
}

export async function readBundle(ctx, baseUrl, bundleId) {
  const response = await ctx.request(baseUrl, `/api/v1/region-bundles/${bundleId}`);
  expectSuccess(ctx, response, "read RegionBundle");
  exactKeys(response.json, ["bundle", "revisions"], "RegionBundle detail response");
  exactKeys(response.json.bundle, BUNDLE_KEYS, "RegionBundle detail");
  assert.ok(Array.isArray(response.json.revisions), "RegionBundle revisions must be an array");
  response.json.revisions.forEach((item) => exactKeys(item, BUNDLE_REVISION_KEYS, "RegionBundleRevision detail"));
  return response.json;
}

export async function queryRegions(ctx, baseUrl, tenantId, points, options = {}) {
  const response = await ctx.request(baseUrl, "/api/v1/regions/query", {
    method: "POST",
    headers: options.headers,
    json: { tenantId, points },
    timeoutMs: options.timeoutMs,
  });
  expectSuccess(ctx, response, options.label ?? "query Regions");
  exactKeys(response.json, ["bundleRevisionId", "items"], "Region query response");
  ctx.ok(response.json.bundleRevisionId === null || typeof response.json.bundleRevisionId === "string", "query has one bundleRevisionId");
  ctx.ok(Array.isArray(response.json.items), "query items are an array");
  ctx.equal(response.json.items.map(({ queryId }) => queryId), points.map(({ queryId }) => queryId), "query preserves input order");
  return response.json;
}

export async function readMemberships(ctx, baseUrl, deviceId) {
  const response = await ctx.request(baseUrl, `/api/v1/devices/${deviceId}/memberships`);
  expectSuccess(ctx, response, "read Device Memberships");
  return collection(response.json, "Membership collection");
}

export async function readTransitions(ctx, baseUrl, deviceId) {
  const response = await ctx.request(baseUrl, `/api/v1/devices/${deviceId}/transitions`);
  expectSuccess(ctx, response, "read Device Transitions");
  return collection(response.json, "Transition collection");
}

function membershipProjection(value) {
  if (!value) return null;
  return {
    tenantId: value.tenantId,
    deviceId: value.deviceId,
    regionId: value.regionId,
    regionVersionId: value.regionVersionId,
    state: value.state,
    enteredAt: value.enteredAt,
    lastObservedAt: value.lastObservedAt,
    lastDeviceSequence: value.lastDeviceSequence,
    watermark: value.watermark,
  };
}

export function transitionProjection(value) {
  return {
    tenantId: value.tenantId,
    deviceId: value.deviceId,
    regionId: value.regionId,
    regionVersionId: value.regionVersionId,
    type: value.type,
    observedAt: value.observedAt,
    sourceEventId: value.sourceEventId,
    sequence: value.sequence,
  };
}

export function assertProjection(ctx, snapshot, events, version, options = {}) {
  const expected = projectTimeline(events, version);
  const actualMembership = resource(snapshot, "memberships").find(({ deviceId, regionId }) => deviceId === events[0]?.deviceId && regionId === version.regionId);
  const actualTransitions = resource(snapshot, "transitions")
    .filter(({ deviceId, regionId }) => deviceId === events[0]?.deviceId && regionId === version.regionId)
    .sort((left, right) => left.sequence - right.sequence);
  ctx.equal(membershipProjection(actualMembership), membershipProjection(expected.membership), options.label ?? "Membership reference projection", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
  ctx.equal(actualTransitions.map(transitionProjection), expected.transitions, options.transitionLabel ?? "Transition reference projection", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
  ctx.ok(Number.isSafeInteger(actualMembership?.revision) && actualMembership.revision >= events.length, "Membership revision advances monotonically", { hardCapIds: ["CORRECTNESS_INVARIANT"] });
  assertContiguousTransitions(actualTransitions);
  return { expected, membership: actualMembership, transitions: actualTransitions };
}

export function stableSnapshot(snapshot) {
  return { resources: clone(snapshot.resources), work: clone(snapshot.work), events: clone(snapshot.events) };
}

export function assertNoSnapshotChange(ctx, before, after, label = "rejected mutation") {
  ctx.equal(stableSnapshot(after), stableSnapshot(before), `${label} has zero durable side effects`, { hardCapIds: ["CORRECTNESS_INVARIANT"] });
}

export function assertWorkShape(snapshot) {
  for (const item of snapshot.work ?? []) {
    exactKeys(item, WORK_KEYS, "Work");
    assert.ok(["LOCATION_EVALUATION", "LATE_REPLAY", "BUNDLE_REEVALUATION"].includes(item.kind), `invalid Work kind ${item.kind}`);
    assert.equal(item.terminal, ["SUCCEEDED", "FAILED", "CANCELLED"].includes(item.state));
  }
}

export function assertEvents(ctx, events) {
  try { assertEventLedger(events); }
  catch (error) { candidateFailure(error.message, "EVENT_LEDGER", ["CORRECTNESS_INVARIANT"]); }
  const forbidden = /(?:longitude|latitude|authorization|admin[_-]?token|database_url|postgres(?:ql)?:\/\/)/iu;
  for (const event of events) ctx.ok(!forbidden.test(canonicalJson(event.body ?? event.payload ?? {})), `Event ${event.eventId} redacts location and secrets`, { hardCapIds: ["CORRECTNESS_INVARIANT"] });
}

export async function killLeasedWork(ctx, baseUrl, target, options = {}) {
  const worker = await ctx.startWorker(options.worker ?? {});
  const leased = await waitForWork(ctx, baseUrl, (item) => item.kind === target.kind
    && (!target.aggregateId || item.aggregateId === target.aggregateId)
    && item.state === "LEASED", {
    timeoutMs: options.timeoutMs ?? 60_000,
    intervalMs: 2,
    label: `${target.kind} publicly LEASED`,
    processes: [worker],
  });
  exactKeys(leased.work, WORK_KEYS, `${target.kind} Work`);
  ctx.ok(leased.work.leaseOwner !== null && leased.work.leaseExpiresAt !== null, "LEASED Work publishes its owner and expiry");
  await ctx.kill(worker);
  ctx.mark("worker-sigkill", { workId: leased.work.workId, kind: leased.work.kind, attempt: leased.work.attempt });
  await waitForLeaseExpiry(ctx, baseUrl, leased.work.workId, options);
  return leased;
}

export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export async function launchBrowser(ctx, baseUrl, options = {}) {
  const chromium = await ctx.loadChromium();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  ctx.defer(() => browser.close());
  const browserContext = await browser.newContext({ viewport: options.viewport ?? { width: 1280, height: 800 } });
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

export async function visibleControl(page, role, names) {
  for (const name of Array.isArray(names) ? names : [names]) {
    const match = await firstVisible(page.getByRole(role, { name }));
    if (match) return match;
  }
  throw new Error(`production UI has no visible ${role} for ${String(names)}`);
}

export async function fillField(page, labels, value) {
  for (const label of Array.isArray(labels) ? labels : [labels]) {
    const match = await firstVisible(page.getByLabel(label));
    if (match) { await match.fill(String(value)); return match; }
  }
  throw new Error(`production UI has no labelled field for ${String(labels)}`);
}

export async function clickControl(page, role, names) {
  const control = await visibleControl(page, role, names);
  await control.click();
  return control;
}

export async function runWorkload({ total, clients, seconds, operation }) {
  const latencies = [];
  const statuses = new Map();
  let next = 0;
  const startedAt = performance.now();
  const deadline = startedAt + seconds * 1_000;
  await Promise.all(Array.from({ length: clients }, async (_, client) => {
    while (next < total && performance.now() <= deadline) {
      const index = next;
      next += 1;
      const started = performance.now();
      const response = await operation(index, client);
      latencies.push(performance.now() - started);
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    }
  }));
  const durationSeconds = Math.max((performance.now() - startedAt) / 1_000, 0.001);
  return {
    completed: next,
    durationSeconds,
    throughput: next / durationSeconds,
    p95Ms: percentile(latencies, 0.95),
    statuses,
  };
}

export function requireV1Workspace(ctx) {
  if (!ctx.v1Workspace) throw new CaseExcluded("missing_v1_checkpoint");
  return ctx.v1Workspace;
}

export function finalEvidence(ctx, values = {}) {
  return ctx.pass({ evidence: [{ kind: "geopulse-case-summary", ...values }] });
}

export { canonicalJson, classifyPoint, percentile };
