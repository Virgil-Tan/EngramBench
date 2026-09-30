import assert from "node:assert/strict";

import {
  assignment, courier, delivery as seededDelivery, dispatchSeed, notification, offer,
} from "../lib/fixtures.mjs";
import { canonical } from "../lib/oracle.mjs";
import {
  acceptOffer, assertAssignment, assertDelivery, assertExactError, assertRoleAssignment,
  assertSnapshotClosure, cancelDelivery, clickForResponse, completeDelivery, createDelivery,
  fillControl, getDelivery, guarded, launchBrowser, pickupDelivery, prepare, readyAssignment,
  requireStatus, result, stableSnapshot, visibleControl, waitForOffers,
} from "./helpers.mjs";

function seededGraph(ctx) {
  const fixture = dispatchSeed(ctx.fixtures, "seed-openapi");
  const targetCourier = fixture.couriers[0];
  const targetDelivery = seededDelivery(ctx.fixtures, "seed-openapi", fixture.customers[0], {
    state: "ASSIGNED", currentRound: 1, sequence: 3, loadUnits: 3,
  });
  const targetOffer = offer(ctx.fixtures, "seed-openapi", targetDelivery, targetCourier, { state: "ACCEPTED" });
  const targetNotification = notification(ctx.fixtures, "seed-openapi", targetOffer, targetCourier, { state: "SUPERSEDED", nextAttemptAt: null });
  const targetAssignment = assignment(ctx.fixtures, "seed-openapi", targetDelivery, targetOffer, targetCourier);
  targetDelivery.assignmentId = targetAssignment.assignmentId;
  targetCourier.activeLoadUnits = targetDelivery.loadUnits;
  fixture.seed.deliveries = [targetDelivery];
  fixture.seed.offers = [targetOffer];
  fixture.seed.offerNotifications = [targetNotification];
  fixture.seed.assignments = [targetAssignment];
  return { fixture, targetDelivery, targetOffer, targetNotification, targetAssignment };
}

function dereference(openapi, schema) {
  if (!schema?.$ref) return schema;
  const name = schema.$ref.split("/").at(-1);
  return openapi.components?.schemas?.[name];
}

function assertOpenApiResponse(openapi, path, method, status, requiredKeys) {
  const operation = openapi.paths?.[path]?.[method];
  assert.ok(operation, `OpenAPI misses ${method.toUpperCase()} ${path}`);
  const response = operation.responses?.[String(status)];
  assert.ok(response, `OpenAPI misses ${status} for ${method.toUpperCase()} ${path}`);
  const schema = dereference(openapi, response.content?.["application/json"]?.schema);
  assert.ok(schema, `OpenAPI misses JSON schema for ${method.toUpperCase()} ${path}`);
  if (requiredKeys) {
    assert.deepEqual(new Set(schema.required ?? []), new Set(requiredKeys));
    assert.equal(schema.additionalProperties, false);
  }
  return schema;
}

const D01 = {
  id: "D-01",
  async run(ctx) {
    return guarded(["MIGRATION_COMPATIBILITY", "ASSIGNMENT_OR_CAPACITY", "DURABLE_IDEMPOTENCY"], async () => {
      const graph = seededGraph(ctx);
      const { api } = await prepare(ctx, graph.fixture.seed);
      const original = assertSnapshotClosure(await ctx.snapshot(api.baseUrl));
      assert.deepEqual(await getDelivery(ctx, api, graph.targetDelivery.deliveryId), graph.targetDelivery);
      const replay = await ctx.seed(graph.fixture.seed, { timeoutMs: 120_000 });
      assert.equal(replay.exitCode, 0, replay.stderr || replay.stdout);
      assert.deepEqual(stableSnapshot(assertSnapshotClosure(await ctx.snapshot(api.baseUrl))), stableSnapshot(original));

      const conflict = structuredClone(graph.fixture.seed);
      conflict.customers[0].name = "Different semantic content";
      const conflictResult = await ctx.seed(conflict, { allowFailure: true, timeoutMs: 120_000 });
      assert.notEqual(conflictResult.exitCode, 0);
      assert.match(`${conflictResult.stdout}\n${conflictResult.stderr}`, /SEED_VERSION_CONFLICT/u);
      const invalidGraphs = [
        (() => { const value = structuredClone(graph.fixture.seed); value.seedVersion = ctx.fixtures.seedVersion("invalid-reference"); value.couriers[0].homeZone = "MISSING"; return value; })(),
        (() => { const value = structuredClone(graph.fixture.seed); value.seedVersion = ctx.fixtures.seedVersion("invalid-distance"); value.zoneDistances.pop(); return value; })(),
        (() => { const value = structuredClone(graph.fixture.seed); value.seedVersion = ctx.fixtures.seedVersion("invalid-load"); value.couriers[0].activeLoadUnits = 0; return value; })(),
        (() => { const value = structuredClone(graph.fixture.seed); value.seedVersion = ctx.fixtures.seedVersion("unknown-key"); value.privateTeams = []; return value; })(),
      ];

      const openApiResponse = await ctx.request(api.baseUrl, "/openapi.json");
      const openapi = requireStatus(openApiResponse, 200, "OpenAPI");
      assert.match(openapi.openapi, /^3\.1(?:\.|$)/u);
      assertOpenApiResponse(openapi, "/api/v1/deliveries", "post", 202, [
        "deliveryId", "customerId", "pickupZone", "dropoffZone", "readyAt", "deliverBy", "loadUnits",
        "state", "assignmentId", "currentRound", "createdAt", "terminalAt", "sequence",
      ]);
      assertOpenApiResponse(openapi, "/api/v1/deliveries/{deliveryId}", "get", 200);
      assertOpenApiResponse(openapi, "/api/v1/offers/{offerId}/accept", "post", 200);
      assertOpenApiResponse(openapi, "/api/v1/verification-snapshot", "get", 200);
      const health = await ctx.request(api.baseUrl, "/healthz");
      assert.equal(health.status, 200);
      assert.equal(graph.fixture.seed.deliveries.some((item) => Object.hasOwn(item, "requiredRoles")), false);
      for (const [index, invalid] of invalidGraphs.entries()) {
        await ctx.resetDatabase();
        await ctx.migrate();
        const invalidApi = await ctx.startApi();
        const empty = stableSnapshot(assertSnapshotClosure(await ctx.snapshot(invalidApi.baseUrl)));
        const response = await ctx.seed(invalid, { allowFailure: true, timeoutMs: 120_000, contractExpectation: index === 3 ? "invalid" : undefined });
        assert.notEqual(response.exitCode, 0, "invalid seed unexpectedly imported");
        assert.deepEqual(stableSnapshot(assertSnapshotClosure(await ctx.snapshot(invalidApi.baseUrl))), empty, "invalid seed changed an isolated database");
      }
      return result({ deliveryId: graph.targetDelivery.deliveryId, seedVersion: graph.fixture.seed.seedVersion, invalidSeedCount: invalidGraphs.length, openapiVersion: openapi.openapi });
    });
  },
};

async function navigateToCreate(page) {
  const candidates = [page.getByRole("link", { name: /new|create.*delivery/i }), page.getByRole("button", { name: /new|create.*delivery/i })];
  for (const locator of candidates) if (await locator.count() && await locator.first().isVisible()) {
    await locator.first().click();
    return;
  }
}

async function fillDeliveryForm(page, fixture, { roles, customerIndex = 0 } = {}) {
  await navigateToCreate(page);
  await fillControl(await visibleControl(page, [/customer/i]), fixture.customers[customerIndex].customerId);
  await fillControl(await visibleControl(page, [/pickup.*zone/i]), fixture.zones[0].zoneId);
  await fillControl(await visibleControl(page, [/dropoff.*zone/i]), fixture.zones[1].zoneId);
  await fillControl(await visibleControl(page, [/ready/i]), new Date(Date.now() + 600_000).toISOString().slice(0, 16));
  await fillControl(await visibleControl(page, [/deliver.*by|deadline/i]), new Date(Date.now() + 4_200_000).toISOString().slice(0, 16));
  await fillControl(await visibleControl(page, [/load.*units|load/i]), "1");
  if (roles) {
    const grouped = page.getByLabel(/roles|required roles/i);
    if (await grouped.count()) {
      await fillControl(grouped.first(), roles.join(","));
    } else {
      const roleInputs = page.getByLabel(/role/i);
      while (await roleInputs.count() < roles.length) await (await visibleControl(page, [/add.*role/i], "button")).click();
      for (const [index, role] of roles.entries()) await roleInputs.nth(index).fill(role);
    }
  }
}

async function submitDeliveryForm(page) {
  const button = await visibleControl(page, [/create.*delivery|submit/i], "button");
  return clickForResponse(page, button, (response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/v1/deliveries");
}

async function openDelivery(page, deliveryId) {
  await page.reload({ waitUntil: "networkidle" });
  const text = page.getByText(deliveryId, { exact: false }).first();
  await text.waitFor({ state: "visible", timeout: 30_000 });
  const link = page.getByRole("link", { name: new RegExp(deliveryId.slice(0, 8), "i") }).first();
  if (await link.count()) await link.click();
}

async function clickMutation(page, pattern, pathPattern) {
  const button = await visibleControl(page, [pattern], "button");
  return clickForResponse(page, button, (response) => response.request().method() === "POST" && pathPattern.test(new URL(response.url()).pathname));
}

async function fillProof(page, value = "proof-123456") {
  const control = await visibleControl(page, [/proof.*code|proof/i]);
  await fillControl(control, value);
}

const D02 = {
  id: "D-02",
  async run(ctx) {
    return guarded(["ASSIGNMENT_OR_CAPACITY", "TEAM_AGGREGATE_CLOSURE"], async () => {
      const receiver = await ctx.receiver({ path: "/offers", behavior: () => ({ status: 204 }) });
      const fixture = dispatchSeed(ctx.fixtures, "ordinary-ui", {
        couriers: Array.from({ length: 8 }, (_, index) => courier(ctx.fixtures, `ordinary-ui-${index}`, { deliveryUrl: receiver.url, eligibleZones: ["NORTH", "SOUTH", "EAST"] })),
      });
      const { api, workers: [worker] } = await prepare(ctx, fixture.seed, { workers: 1 });
      const page = await launchBrowser(ctx, api, { viewport: { width: 1280, height: 800 } });
      await page.keyboard.press("Tab");
      assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BODY", "keyboard focus did not enter the UI");
      await fillDeliveryForm(page, fixture);
      const createResponse = await submitDeliveryForm(page);
      assert.equal(createResponse.status, 202);
      const created = assertDelivery(createResponse.json, { team: false });
      assert.equal(Object.hasOwn(created, "requiredRoles"), false);
      const offers = await waitForOffers(ctx, api, created.deliveryId, (items) => items.some(({ state }) => state === "OPEN"), { processes: [worker] });
      await openDelivery(page, created.deliveryId);
      const acceptedResponse = await clickMutation(page, /accept/i, /^\/api\/v1\/offers\/[^/]+\/accept$/u);
      assert.equal(acceptedResponse.status, 200);
      const accepted = assertAssignment(acceptedResponse.json);
      assert.ok(offers.some(({ offerId }) => offerId === accepted.offerId));
      const pickedResponse = await clickMutation(page, /pick\s*up/i, new RegExp(`^/api/v1/deliveries/${created.deliveryId}/pickup$`, "u"));
      assert.equal(pickedResponse.status, 200);
      assert.equal(assertDelivery(pickedResponse.json).state, "PICKED_UP");
      await fillProof(page);
      const completedResponse = await clickMutation(page, /complete/i, new RegExp(`^/api/v1/deliveries/${created.deliveryId}/complete$`, "u"));
      assert.equal(completedResponse.status, 200);
      assert.equal(assertDelivery(completedResponse.json).state, "DELIVERED");
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText(/DELIVERED/i).first().waitFor({ state: "visible" });
      assert.deepEqual(await getDelivery(ctx, api, created.deliveryId), completedResponse.json);

      await page.setViewportSize({ width: 390, height: 844 });
      await fillDeliveryForm(page, fixture, { customerIndex: 1 });
      const mobileCreate = await submitDeliveryForm(page);
      assert.equal(mobileCreate.status, 202);
      const cancellable = assertDelivery(mobileCreate.json);
      await openDelivery(page, cancellable.deliveryId);
      const cancelledResponse = await clickMutation(page, /cancel/i, new RegExp(`^/api/v1/deliveries/${cancellable.deliveryId}/cancel$`, "u"));
      assert.equal(cancelledResponse.status, 200);
      assert.equal(assertDelivery(cancelledResponse.json).state, "CANCELLED");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "mobile UI overflows horizontally");
      await page.context().setOffline(true);
      const retry = page.getByRole("button", { name: /refresh|retry/i }).first();
      if (await retry.count()) await retry.click();
      const offlineVisible = await page.getByRole("alert").filter({ hasText: /offline|network|retry/i }).count();
      await page.context().setOffline(false);
      assert.ok(offlineVisible > 0, "offline failure was not exposed accessibly");
      const snapshot = assertSnapshotClosure(await ctx.snapshot(api.baseUrl));
      assert.ok(snapshot.resources.offerNotifications.some(({ deliveryUrl }) => deliveryUrl === receiver.url));
      assert.ok(snapshot.resources.couriers.every(({ activeLoadUnits }) => activeLoadUnits === 0));
      return result({ completedDeliveryId: created.deliveryId, cancelledDeliveryId: cancellable.deliveryId, notificationAttempts: receiver.ledger.length, viewports: ["desktop", "mobile"] });
    });
  },
};

async function acceptVisibleRoles(page, deliveryId, roleCount) {
  const accepted = [];
  while (accepted.length < roleCount) {
    await openDelivery(page, deliveryId);
    const buttons = page.getByRole("button", { name: /accept/i });
    const count = await buttons.count();
    assert.ok(count > 0, "team UI exposes no acceptable role Offer");
    let response;
    for (let index = 0; index < count; index += 1) {
      const candidate = buttons.nth(index);
      if (!await candidate.isVisible() || await candidate.isDisabled()) continue;
      response = await clickForResponse(page, candidate, (item) => item.request().method() === "POST" && /^\/api\/v1\/offers\/[^/]+\/accept$/u.test(new URL(item.url()).pathname));
      if (response.status === 200) break;
      assert.ok(["TEAM_ROLE_ALREADY_FILLED", "COURIER_TEAM_ROLE_CONFLICT", "OFFER_LOST"].includes(response.json?.error?.code));
      await page.reload({ waitUntil: "networkidle" });
    }
    assert.equal(response?.status, 200, "no visible TeamOffer could be accepted");
    accepted.push(assertRoleAssignment(response.json));
  }
  return accepted;
}

const D03 = {
  id: "D-03",
  async run(ctx) {
    return guarded(["TEAM_AGGREGATE_CLOSURE", "ASSIGNMENT_OR_CAPACITY"], async () => {
      const receiver = await ctx.receiver({ path: "/offers", behavior: () => ({ status: 204 }) });
      const fixture = dispatchSeed(ctx.fixtures, "team-ui", {
        couriers: Array.from({ length: 10 }, (_, index) => courier(ctx.fixtures, `team-ui-${index}`, { deliveryUrl: receiver.url, capacityUnits: 10, eligibleZones: ["NORTH", "SOUTH", "EAST"] })),
      });
      const { api, workers: [worker] } = await prepare(ctx, fixture.seed, { workers: 1 });
      const page = await launchBrowser(ctx, api, { viewport: { width: 1280, height: 800 } });
      const roles = ["DRIVER", "LOADER"];
      await fillDeliveryForm(page, fixture, { roles });
      const createdResponse = await submitDeliveryForm(page);
      assert.equal(createdResponse.status, 202);
      const created = assertDelivery(createdResponse.json, { team: true });
      assert.deepEqual(created.requiredRoles, roles);
      await waitForOffers(ctx, api, created.deliveryId, (items) => roles.every((role) => items.some((item) => item.role === role && item.state === "OPEN")), { processes: [worker] });
      const accepted = await acceptVisibleRoles(page, created.deliveryId, roles.length);
      assert.equal(new Set(accepted.map(({ courierId }) => courierId)).size, roles.length);
      await openDelivery(page, created.deliveryId);
      for (let index = 0; index < roles.length; index += 1) {
        const response = await clickMutation(page, /ready/i, new RegExp(`^/api/v1/deliveries/${created.deliveryId}/assignments/[^/]+/ready$`, "u"));
        assert.equal(response.status, 200);
        assertRoleAssignment(response.json);
        if (index + 1 < roles.length) await page.reload({ waitUntil: "networkidle" });
      }
      const picked = await clickMutation(page, /pick\s*up/i, new RegExp(`^/api/v1/deliveries/${created.deliveryId}/pickup$`, "u"));
      assert.equal(picked.status, 200);
      await fillProof(page);
      const completed = await clickMutation(page, /complete/i, new RegExp(`^/api/v1/deliveries/${created.deliveryId}/complete$`, "u"));
      assert.equal(completed.status, 200);
      assert.equal(assertDelivery(completed.json, { team: true }).state, "DELIVERED");
      await page.reload({ waitUntil: "networkidle" });
      await page.getByText(/DELIVERED/i).first().waitFor({ state: "visible" });

      await fillDeliveryForm(page, fixture, { roles: ["DRIVER", "ESCORT"], customerIndex: 1 });
      const cancelledCreate = await submitDeliveryForm(page);
      const cancelledId = assertDelivery(cancelledCreate.json, { team: true }).deliveryId;
      await openDelivery(page, cancelledId);
      const cancelled = await clickMutation(page, /cancel/i, new RegExp(`^/api/v1/deliveries/${cancelledId}/cancel$`, "u"));
      assert.equal(cancelled.status, 200);
      assert.equal(assertDelivery(cancelled.json, { team: true }).state, "CANCELLED");
      const snapshot = assertSnapshotClosure(await ctx.snapshot(api.baseUrl));
      const team = snapshot.resources.teamAssignments.find(({ deliveryId }) => deliveryId === created.deliveryId);
      assert.equal(team.state, "COMPLETED");
      assert.ok(team.assignments.every(({ state }) => state === "COMPLETED"));
      assert.ok(snapshot.resources.teamOffers.filter(({ deliveryId }) => deliveryId === created.deliveryId).every((item) => item.role === roles[item.roleIndex]));
      return result({ completedDeliveryId: created.deliveryId, teamAssignmentId: team.teamAssignmentId, cancelledDeliveryId: cancelledId, roleAssignmentIds: accepted.map(({ assignmentId }) => assignmentId) });
    });
  },
};

const D04 = {
  id: "D-04",
  async run(ctx) {
    return guarded(["TEAM_AGGREGATE_CLOSURE", "ASSIGNMENT_OR_CAPACITY", "WORK_FENCING_OR_RECOVERY"], async () => {
      const fixture = dispatchSeed(ctx.fixtures, "snapshot", {
        couriers: Array.from({ length: 10 }, (_, index) => courier(ctx.fixtures, `snapshot-${index}`, { capacityUnits: 10, eligibleZones: ["NORTH", "SOUTH", "EAST"] })),
      });
      const { apis, workers } = await prepare(ctx, fixture.seed, { apis: 2, workers: 2 });
      const ordinary = await createDelivery(ctx, apis[0], fixture, "snapshot-ordinary", { loadUnits: 1 });
      const ordinaryOffers = await waitForOffers(ctx, apis[0], ordinary.delivery.deliveryId, (items) => items.some(({ state }) => state === "OPEN"), { processes: workers });
      const ordinaryAssignment = assertAssignment(requireStatus((await acceptOffer(ctx, apis[0], ordinaryOffers[0], "snapshot-ordinary")).response, 200, "snapshot ordinary claim"));
      const team = await createDelivery(ctx, apis[1], fixture, "snapshot-team", { roles: ["DRIVER", "LOADER"], loadUnits: 1, customerId: fixture.customers[1].customerId });
      const teamOffers = await waitForOffers(ctx, apis[1], team.delivery.deliveryId, (items) => items.some(({ role }) => role === "DRIVER") && items.some(({ role }) => role === "LOADER"), { processes: workers });
      const selected = [];
      for (const role of ["DRIVER", "LOADER"]) {
        const item = teamOffers.find((offerItem) => offerItem.role === role && !selected.some(({ courierId }) => courierId === offerItem.courierId));
        selected.push(item);
        assertRoleAssignment(requireStatus((await acceptOffer(ctx, apis[selected.length % 2], item, `snapshot-${role}`)).response, 200, "snapshot team role claim"));
      }
      const teamDetail = await getDelivery(ctx, apis[0], team.delivery.deliveryId);
      requireStatus(await readyAssignment(ctx, apis[0], teamDetail.deliveryId, teamDetail.assignments[0], "snapshot-one-ready"), 200, "snapshot one role ready");
      const openTeam = await createDelivery(ctx, apis[0], fixture, "snapshot-open-team", { roles: ["ESCORT", "NAVIGATOR"], customerId: fixture.customers[2].customerId });
      await waitForOffers(ctx, apis[0], openTeam.delivery.deliveryId, (items) => items.length > 0, { processes: workers });

      const snapshots = [];
      const mutation = Promise.all([
        readyAssignment(ctx, apis[1], teamDetail.deliveryId, teamDetail.assignments[1], "snapshot-final-ready"),
        pickupDelivery(ctx, apis[0], ordinaryAssignment.deliveryId, ordinaryAssignment.courierId, "snapshot-ordinary-pickup"),
      ]);
      for (let index = 0; index < 8; index += 1) snapshots.push(assertSnapshotClosure(await ctx.snapshot(apis[index % 2].baseUrl)));
      const mutationResponses = await mutation;
      assert.equal(mutationResponses[0].status, 200);
      assert.equal(mutationResponses[1].status, 200);
      requireStatus(await completeDelivery(ctx, apis[0], ordinaryAssignment.deliveryId, ordinaryAssignment.courierId, "snapshot-ordinary-complete"), 200, "snapshot ordinary complete");
      requireStatus(await cancelDelivery(ctx, apis[1], openTeam.delivery.deliveryId, "snapshot-open-team-cancel"), 200, "snapshot team cancel");
      const final = assertSnapshotClosure(await ctx.snapshot(apis[0].baseUrl));
      assert.equal(Object.keys(final.resources).length, 10);
      assert.ok(final.resources.deliveries.some((item) => !Object.hasOwn(item, "requiredRoles")));
      assert.ok(final.resources.deliveries.some((item) => Object.hasOwn(item, "requiredRoles")));
      assert.ok(final.resources.offers.some(({ state }) => ["ACCEPTED", "LOST", "EXPIRED"].includes(state)));
      assert.ok(final.resources.teamOffers.length > 0);
      assert.ok(final.resources.teamAssignments.some(({ assignments }) => assignments.some(({ state }) => ["READY", "RESERVED"].includes(state))));
      for (const delivery of final.resources.deliveries) {
        const publicDetail = await getDelivery(ctx, apis[0], delivery.deliveryId);
        assert.equal(canonical(publicDetail), canonical(delivery));
      }
      for (const aggregateId of new Set(final.events.map(({ aggregateId }) => aggregateId))) {
        const publicEvents = requireStatus(await ctx.request(apis[0].baseUrl, `/api/v1/domain-events?aggregateId=${encodeURIComponent(aggregateId)}&limit=100`), 200, "public Domain Event list");
        assert.deepEqual(publicEvents.items ?? publicEvents, final.events.filter((item) => item.aggregateId === aggregateId));
      }
      assert.ok(snapshots.every((snapshot) => Object.keys(snapshot.resources).length === 10));
      return result({ snapshotCount: snapshots.length + 1, ordinaryDeliveryId: ordinaryAssignment.deliveryId, teamDeliveryIds: [teamDetail.deliveryId, openTeam.delivery.deliveryId], asOf: final.asOf });
    });
  },
};

export const D_CASES = Object.freeze([D01, D02, D03, D04]);
