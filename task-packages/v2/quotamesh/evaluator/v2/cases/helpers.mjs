import assert from "node:assert/strict";
import {
  assertAdmission,
  assertCommitment,
  assertOrganization,
  assertPool,
  assertProject,
  assertPublicError,
  assertReservation,
  canonical,
  reconcileSnapshot,
} from "../lib/oracle.mjs";
export function defineCase(id, fixtureFamily, action, oracle, run) {
  return Object.freeze({
    id,
    taskId: "quotamesh",
    fixtureFamily,
    action,
    oracle,
    run,
  });
}
export async function boot(ctx, options = {}) {
  const catalog = options.catalog ?? ctx.catalog(options.catalogOptions);
  await ctx.seed(
    options.seed ??
      ctx.seedFor(options.seedVersion ?? `${ctx.caseId.toLowerCase()}-v1`, {
        catalog,
        dimensions: options.dimensions,
        quotaPools: options.quotaPools,
        commitments: options.commitments,
        reservations: options.reservations,
        admissionQueue: options.admissionQueue,
      }),
  );
  const apis = [];
  for (let i = 0; i < (options.apiCount ?? 1); i += 1)
    apis.push(await ctx.startApi());
  const workers = [];
  for (let i = 0; i < (options.workerCount ?? 0); i += 1)
    workers.push(await ctx.startWorker());
  return { catalog, api: apis[0], apis, workers };
}
export function requirePool(ctx, response, status = 201) {
  ctx.equal("QuotaPool mutation status", response.status, status);
  ctx.assert("QuotaPool exact shape", () => assertPool(response.json));
  return response.json;
}
export function requireReservation(ctx, response, options = {}) {
  ctx.equal(
    "Reservation mutation status",
    response.status,
    options.status ?? 201,
  );
  ctx.assert("Reservation exact FINAL shape", () =>
    assertReservation(response.json, { expected: options.expected }),
  );
  return response.json;
}
export function requireCommitment(ctx, response) {
  ctx.equal("Commitment mutation status", response.status, 200);
  ctx.assert("Commitment exact FINAL shape", () =>
    assertCommitment(response.json),
  );
  return response.json;
}
export function requireAdmission(ctx, response) {
  ctx.equal("Admission mutation status", response.status, 200);
  ctx.assert("Admission exact FINAL shape", () =>
    assertAdmission(response.json),
  );
  return response.json;
}
export function requireOrganization(ctx, response, status = 201) {
  ctx.equal("Organization mutation status", response.status, status);
  ctx.assert("Organization exact shape", () =>
    assertOrganization(response.json),
  );
  return response.json;
}
export function requireProject(ctx, response, status = 201) {
  ctx.equal("Project mutation status", response.status, status);
  ctx.assert("Project exact shape", () => assertProject(response.json));
  return response.json;
}
export function expectError(ctx, response, status, code, options = {}) {
  ctx.assert(
    `${code} exact error`,
    () => assertPublicError(response, status, code),
    {
      failureCodeSuffix: options.failureCodeSuffix ?? code,
      hardCapIds: options.hardCapIds ?? [],
    },
  );
}
export async function snapshot(ctx, url, options = {}) {
  const value = await ctx.snapshot(url, { timeoutMs: options.timeoutMs });
  ctx.assert(
    "snapshot independently reconciles vectors",
    () => reconcileSnapshot(value, { final: options.final !== false }),
    {
      failureCodeSuffix: "VECTOR_INVARIANT",
      hardCapIds: ["VECTOR_CORRECTNESS"],
    },
  );
  return value;
}
export function resource(snapshot, name) {
  const value = snapshot.resources[name];
  assert.ok(Array.isArray(value), `${name} missing`);
  return value;
}
export function byId(values, key, id) {
  const value = values.find((item) => item[key] === id);
  assert.ok(value, `${key} ${id} missing`);
  return value;
}
export function reservationFrom(state, id) {
  return byId(resource(state, "reservations"), "reservationId", id);
}
export function poolFrom(state, id) {
  return byId(resource(state, "quotaPools"), "poolId", id);
}
export function organizationFrom(state, id) {
  return byId(resource(state, "quotaOrganizations"), "organizationId", id);
}
export function projectFrom(state, id) {
  return byId(resource(state, "quotaProjects"), "projectId", id);
}
export function commitmentsFor(state, id) {
  return resource(state, "commitments").filter(
    (item) => item.reservationId === id,
  );
}
export function eventsFor(state, id) {
  return state.events.filter((item) => item.aggregateId === id);
}
export function workFor(state, id) {
  return state.work.filter((item) => item.aggregateId === id);
}
export async function waitReservation(ctx, url, id, state, options = {}) {
  return ctx.waitFor(
    async () => {
      const response = await ctx.getReservation(url, id);
      if (response.status !== 200 || response.json?.state !== state) return;
      assertReservation(response.json);
      return response.json;
    },
    {
      timeoutMs: options.timeoutMs ?? 60000,
      intervalMs: options.intervalMs ?? 40,
      label: `Reservation ${id} ${state}`,
      processes: options.processes,
    },
  );
}
export function queueItems(response) {
  return response.json?.items ?? response.json;
}
export function stableReplay(ctx, responses, label) {
  ctx.ok(`${label} has responses`, responses.length > 0);
  const first = responses[0];
  for (const item of responses.slice(1)) {
    ctx.equal(`${label} status stable`, item.status, first.status);
    ctx.equal(
      `${label} body stable`,
      canonical(item.json),
      canonical(first.json),
    );
  }
  return first;
}
export function noEffect(ctx, before, after, label) {
  ctx.equal(
    `${label} resources unchanged`,
    canonical(after.resources),
    canonical(before.resources),
  );
  ctx.equal(
    `${label} Work unchanged`,
    canonical(after.work),
    canonical(before.work),
  );
  ctx.equal(
    `${label} Events unchanged`,
    canonical(after.events),
    canonical(before.events),
  );
}
export async function createHierarchy(ctx, url, worked) {
  const organization = requireOrganization(
    ctx,
    await ctx.createOrganization(url, worked.organizationBody),
  );
  const projectA = requireProject(
    ctx,
    await ctx.createProject(url, organization.organizationId, worked.projectA),
  );
  const projectB = requireProject(
    ctx,
    await ctx.createProject(url, organization.organizationId, worked.projectB),
  );
  return { organization, projectA, projectB };
}
