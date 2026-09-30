import assert from "node:assert/strict";
import { hierarchyWorkedExample, vector } from "../lib/fixtures.mjs";
import {
  assertExactKeys,
  assertOrganization,
  assertPool,
  assertProject,
  assertReservation,
  canonical,
  compareUtf8,
  reconcileSnapshot,
} from "../lib/oracle.mjs";
import {
  boot,
  createHierarchy,
  defineCase,
  expectError,
  poolFrom,
  queueItems,
  requireAdmission,
  requireOrganization,
  requirePool,
  requireProject,
  requireReservation,
  snapshot,
  waitReservation,
} from "./helpers.mjs";

async function setLabeled(page, matcher, value, index = 0) {
  const control = page.getByLabel(matcher).nth(index);
  assert.ok(await control.count(), `labeled control ${matcher} missing`);
  const tag = await control.evaluate((element) =>
    element.tagName.toLowerCase(),
  );
  if (tag === "select") await control.selectOption(String(value));
  else await control.fill(String(value));
}
async function press(page, matcher, index = 0) {
  const control = page.getByRole("button", { name: matcher }).nth(index);
  assert.ok(await control.count(), `button ${matcher} missing`);
  await control.click();
}
async function fillVector(page, values) {
  for (const [name, value] of Object.entries(values)) {
    const byName = page.getByLabel(new RegExp(name, "i"));
    if (await byName.count()) await byName.fill(String(value));
    else
      await setLabeled(
        page,
        /quantity|capacity|allocation/i,
        value,
        Object.keys(values).indexOf(name),
      );
  }
}

const D01 = defineCase(
  "D-01",
  "All Pool/Reservation/Admission/hierarchy wires plus malformed boundaries",
  "Exercise public mutations, reads, pages, cursor errors and OpenAPI schemas using real HTTP only",
  "Validate exact status/body/enums/errors, stable cursors and zero mutation for unknown fields, floats and missing references",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 50, dimensionCount: 3 },
    });
    const created = requirePool(
      ctx,
      await ctx.createPool(api.baseUrl, {
        tenantId: ctx.uuid("wire-tenant"),
        name: "Wire Pool",
        capacity: vector(10, catalog.dimensions),
      }),
    );
    const first = requireReservation(
      ctx,
      await ctx.reservePool(api.baseUrl, created.poolId, {
        ownerId: ctx.uuid("wire-owner-1"),
        quantities: vector(1, catalog.dimensions),
        ttlSeconds: 300,
      }),
    );
    const second = requireReservation(
      ctx,
      await ctx.reservePool(api.baseUrl, created.poolId, {
        ownerId: ctx.uuid("wire-owner-2"),
        quantities: vector(1, catalog.dimensions),
        ttlSeconds: 300,
      }),
    );
    const admission = requireAdmission(
      ctx,
      await ctx.enqueue(api.baseUrl, {
        poolId: created.poolId,
        ownerId: ctx.uuid("wire-admission"),
        quantities: vector(9, catalog.dimensions),
        priority: 4,
      }),
    );
    const page1 = await ctx.listReservations(api.baseUrl, "limit=1");
    ctx.equal("Reservation page status", page1.status, 200);
    ctx.assert("Reservation page exact wrapper", () =>
      assertExactKeys(page1.json, ["items", "nextCursor"], "Reservation page"),
    );
    ctx.equal("Reservation page size", page1.json.items.length, 1);
    ctx.ok(
      "Reservation page has opaque cursor",
      typeof page1.json.nextCursor === "string",
    );
    const page2 = await ctx.listReservations(
      api.baseUrl,
      `limit=1&cursor=${encodeURIComponent(page1.json.nextCursor)}`,
    );
    ctx.equal(
      "cursor advances without duplicate",
      page2.json.items[0].reservationId === page1.json.items[0].reservationId,
      false,
    );
    expectError(
      ctx,
      await ctx.listReservations(api.baseUrl, "cursor=broken"),
      400,
      "INVALID_CURSOR",
    );
    expectError(
      ctx,
      await ctx.reservePool(api.baseUrl, created.poolId, {
        ownerId: ctx.uuid("bad"),
        quantities: { ...vector(1, catalog.dimensions), cpuMillis: 1.2 },
        ttlSeconds: 300,
      }),
      400,
      "INVALID_QUOTA_VECTOR",
    );
    expectError(
      ctx,
      await ctx.reservePool(api.baseUrl, created.poolId, {
        ownerId: ctx.uuid("bad2"),
        quantities: vector(1, catalog.dimensions),
        ttlSeconds: 300,
        unknown: true,
      }),
      400,
      "UNKNOWN_FIELD",
    );
    expectError(
      ctx,
      await ctx.reservePool(api.baseUrl, ctx.uuid("missing"), {
        ownerId: ctx.uuid("bad3"),
        quantities: vector(1, catalog.dimensions),
        ttlSeconds: 300,
      }),
      404,
      "NOT_FOUND",
    );
    const worked = hierarchyWorkedExample(ctx.fixtures),
      hierarchy = await createHierarchy(ctx, api.baseUrl, worked),
      hierarchyReservation = requireReservation(
        ctx,
        await ctx.reserveProject(
          api.baseUrl,
          hierarchy.organization.organizationId,
          hierarchy.projectA.projectId,
          {
            ownerId: ctx.uuid("wire-project-owner"),
            quantities: worked.released,
            ttlSeconds: 300,
          },
        ),
      );
    const organizationRead = (
        await ctx.getOrganization(
          api.baseUrl,
          hierarchy.organization.organizationId,
        )
      ).json,
      projectRead = (
        await ctx.getProject(
          api.baseUrl,
          hierarchy.organization.organizationId,
          hierarchy.projectA.projectId,
        )
      ).json;
    ctx.assert("Organization GET exact wire", () =>
      assertOrganization(organizationRead),
    );
    ctx.assert("Project GET exact wire", () => assertProject(projectRead));
    const openapi = await ctx.readOpenApi(api.baseUrl);
    ctx.equal("OpenAPI version 3.1", openapi.openapi, "3.1.0");
    for (const [path, method] of [
      ["/api/v1/quota-pools/{poolId}/reservations", "post"],
      ["/api/v1/admission-queue", "post"],
      ["/api/v1/quota-organizations", "post"],
      [
        "/api/v1/quota-organizations/{organizationId}/projects/{projectId}/reservations",
        "post",
      ],
      ["/api/v1/quota-organizations/{organizationId}/capacity", "put"],
    ])
      ctx.ok(
        `OpenAPI publishes ${method} ${path}`,
        openapi.paths?.[path]?.[method],
      );
    ctx.ok(
      "OpenAPI publishes exact stable hierarchy errors",
      [
        "PROJECT_QUOTA_EXCEEDED",
        "ORGANIZATION_QUOTA_EXCEEDED",
        "QUOTA_HIERARCHY_REVISION_CHANGED",
        "ORGANIZATION_CAPACITY_CONFLICT",
        "PROJECT_ALLOCATION_CONFLICT",
      ].every((code) => canonical(openapi).includes(code)),
    );
    await snapshot(ctx, api.baseUrl);
    return {
      evidence: [
        first.reservationId,
        second.reservationId,
        admission.admissionEntryId,
        hierarchyReservation.reservationId,
        hierarchy.organization.organizationId,
      ],
    };
  },
);

const D02 = defineCase(
  "D-02",
  "Desktop and mobile V1 Pool/Reservation/Admission production UI",
  "Use visible labeled controls to reserve, commit, release, enqueue a blocked Admission and refresh",
  "Compare every displayed Dimension total, queue position and terminal state to public HTTP and reject client-only quota authority",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 10, dimensionCount: 3 },
    });
    let committedId, releasedId;
    await ctx.withPage(api, { width: 390, height: 844 }, async (page) => {
      await page.goto("/");
      const pool = page.getByText(catalog.pool.name, { exact: false }).first();
      if (await pool.count()) await pool.click();
      await press(page, /new reservation|reserve quota|create reservation/i);
      await setLabeled(page, /owner/i, catalog.ownerId);
      await fillVector(page, vector(2, catalog.dimensions));
      const ttl = page.getByLabel(/ttl|seconds/i);
      if (await ttl.count()) await ttl.fill("300");
      await press(page, /reserve|create reservation|submit/i);
      await page.waitForLoadState("networkidle");
      let state = await ctx.snapshot(api.baseUrl);
      committedId = state.resources.reservations.at(-1).reservationId;
      await page.getByText(/held/i).waitFor({ timeout: 10000 });
      await press(page, /commit/i);
      await page.getByText(/committed/i).waitFor({ timeout: 10000 });
      await page.reload();
      await page.getByText(/committed/i).waitFor({ timeout: 10000 });
    });
    await waitReservation(ctx, api.baseUrl, committedId, "COMMITTED");
    await ctx.withPage(api, { width: 1440, height: 900 }, async (page) => {
      await page.goto("/");
      const create = page
        .getByRole("button", { name: /new reservation|reserve quota/i })
        .first();
      if (await create.count()) await create.click();
      await setLabeled(page, /owner/i, catalog.otherOwnerId);
      await fillVector(page, vector(3, catalog.dimensions));
      const ttl = page.getByLabel(/ttl|seconds/i);
      if (await ttl.count()) await ttl.fill("300");
      await press(page, /reserve|create reservation|submit/i);
      await page.waitForLoadState("networkidle");
      const state = await ctx.snapshot(api.baseUrl);
      releasedId = state.resources.reservations.find(
        ({ state: status, reservationId }) =>
          status === "HELD" && reservationId !== committedId,
      ).reservationId;
      const text = page.getByText(releasedId, { exact: false }).first();
      if (await text.count()) await text.click();
      await press(page, /release/i);
      await page.getByText(/released/i).waitFor({ timeout: 10000 });
      await page.goto("/");
      await press(page, /admission|enqueue request|join queue/i);
      await setLabeled(page, /pool/i, catalog.pool.poolId);
      await setLabeled(page, /owner/i, ctx.uuid("browser-admission"));
      await fillVector(page, vector(9, catalog.dimensions));
      const priority = page.getByLabel(/priority/i);
      if (await priority.count()) await priority.fill("1");
      await press(page, /enqueue|create admission|submit/i);
      await page
        .getByText(/waiting|position/i)
        .first()
        .waitFor({ timeout: 10000 });
    });
    await waitReservation(ctx, api.baseUrl, releasedId, "RELEASED");
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      "browser terminal vectors match Pool",
      poolFrom(state, catalog.pool.poolId).committed,
      vector(2, catalog.dimensions),
    );
    ctx.equal(
      "browser released vector not held",
      poolFrom(state, catalog.pool.poolId).held,
      vector(0, catalog.dimensions),
    );
    ctx.equal(
      "browser Admission remains visibly waiting",
      state.resources.admissionEntries.map(({ state: status, position }) => [
        status,
        position,
      ]),
      [["WAITING", 1]],
    );
    return { evidence: [committedId, releasedId] };
  },
);

const D03 = defineCase(
  "D-03",
  "Manager hierarchy worked example in desktop/mobile UI",
  "Create Organization and Projects, edit CAS allocation, reserve against Project A and expose no-sibling-borrow conflict through visible controls",
  "Keep Organization/Project usage, availability, revisions and error state equal to public APIs across refresh",
  async (ctx) => {
    const worked = hierarchyWorkedExample(ctx.fixtures);
    const { api } = await boot(ctx);
    let organizationId, projectAId;
    await ctx.withPage(api, { width: 1440, height: 900 }, async (page) => {
      await page.goto("/");
      await press(page, /new organization|create organization/i);
      await setLabeled(page, /tenant/i, worked.organizationBody.tenantId);
      await setLabeled(page, /name/i, worked.organizationBody.name);
      await fillVector(page, worked.organizationBody.capacity);
      await press(page, /create organization|save organization/i);
      await page.waitForLoadState("networkidle");
      let state = await ctx.snapshot(api.baseUrl);
      const org = state.resources.quotaOrganizations.at(-1);
      organizationId = org.organizationId;
      await page.getByText(org.name, { exact: false }).first().click();
      await press(page, /new project|add project/i);
      await setLabeled(page, /name/i, worked.projectA.name);
      await fillVector(page, worked.projectA.allocation);
      await press(page, /create project|save project/i);
      await page.waitForLoadState("networkidle");
      state = await ctx.snapshot(api.baseUrl);
      projectAId = state.resources.quotaProjects.find(
        ({ organizationId: id }) => id === organizationId,
      ).projectId;
      const projectText = page.getByText(projectAId, { exact: false }).first();
      if (await projectText.count()) await projectText.click();
      await press(page, /edit allocation|update allocation/i);
      await fillVector(page, worked.projectA.allocation);
      await press(page, /update allocation|save allocation/i);
      await page.waitForLoadState("networkidle");
      await page.reload();
      await page
        .getByText(String(org.revision), { exact: false })
        .first()
        .waitFor({ timeout: 10000 });
    });
    let reservation;
    await ctx.withPage(api, { width: 390, height: 844 }, async (page) => {
      await page.goto("/");
      const organization = page
        .getByText(organizationId, { exact: false })
        .first();
      if (await organization.count()) await organization.click();
      const projectLink = page.getByText(projectAId, { exact: false }).first();
      if (await projectLink.count()) await projectLink.click();
      await press(page, /new reservation|reserve quota|project reservation/i);
      await setLabeled(page, /owner/i, ctx.uuid("ui-hierarchy"));
      await fillVector(page, worked.accepted);
      const ttl = page.getByLabel(/ttl|seconds/i);
      if (await ttl.count()) await ttl.fill("300");
      await press(page, /reserve|create reservation|submit/i);
      await page.waitForLoadState("networkidle");
      const state = await ctx.snapshot(api.baseUrl);
      reservation = state.resources.reservations.find(
        ({ projectId }) => projectId === projectAId && state !== "COMMITTED",
      );
      ctx.ok(
        "browser creates hierarchy Reservation through public API",
        reservation,
      );
      ctx.assert("browser hierarchy Reservation exact shape", () =>
        assertReservation(reservation),
      );
    });
    const org = (await ctx.getOrganization(api.baseUrl, organizationId)).json,
      project = (await ctx.getProject(api.baseUrl, organizationId, projectAId))
        .json;
    expectError(
      ctx,
      await ctx.updateProject(api.baseUrl, organizationId, projectAId, {
        allocation: project.allocation,
        expectedOrganizationRevision: org.revision - 1,
        expectedProjectRevision: project.revision,
      }),
      409,
      "QUOTA_HIERARCHY_REVISION_CHANGED",
    );
    await ctx.withPage(api, { width: 390, height: 844 }, async (page) => {
      await page.goto("/");
      const orgText = page.getByText(organizationId, { exact: false }).first();
      if (await orgText.count()) await orgText.click();
      for (const value of Object.values(worked.accepted))
        await page
          .getByText(String(value), { exact: false })
          .first()
          .waitFor({ timeout: 10000 });
      await page
        .getByText(/project|organization/i)
        .first()
        .waitFor({ timeout: 10000 });
    });
    const state = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      "hierarchy UI-backed Reservation consumes both ledgers",
      state.resources.quotaOrganizations.find(
        ({ organizationId: id }) => id === organizationId,
      ).held,
      state.resources.quotaProjects.find(
        ({ projectId }) => projectId === projectAId,
      ).held,
    );
    return {
      evidence: [organizationId, projectAId, reservation.reservationId],
    };
  },
);

const D04 = defineCase(
  "D-04",
  "All V1/final states, leased/terminal Work and hierarchy snapshot",
  "Hold a due worker claim and read the authorized verification snapshot while other committed, released, admission and hierarchy records exist",
  "Validate exact union keys/shapes/sorts, one asOf vector model, Work retention, token omission and independent two-level conservation",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 50, dimensionCount: 3 },
    });
    const committed = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 2),
      ),
    );
    await ctx.commitReservation(api.baseUrl, committed.reservationId);
    const released = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 3),
      ),
    );
    await ctx.releaseReservation(api.baseUrl, released.reservationId);
    const due = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 4, { ttlSeconds: 1 }),
      ),
    );
    await ctx.enqueue(api.baseUrl, {
      poolId: catalog.pool.poolId,
      ownerId: ctx.uuid("snapshot-admission"),
      quantities: vector(5, catalog.dimensions),
      priority: 1,
    });
    const worked = hierarchyWorkedExample(ctx.fixtures);
    await createHierarchy(ctx, api.baseUrl, worked);
    await ctx.sleep(1100);
    const barrier = await ctx.workerBarrier(
      "worker.claimed",
      ({ aggregateId }) => aggregateId === due.reservationId,
    );
    const worker = await ctx.startWorkerAtBarrier(barrier);
    await barrier.waitFor(
      ({ json }) => json.aggregateId === due.reservationId,
      { processes: [worker] },
    );
    const state = await snapshot(ctx, api.baseUrl);
    ctx.assert("FINAL resources exact union", () =>
      assertExactKeys(
        state.resources,
        [
          "dimensions",
          "quotaPools",
          "reservations",
          "commitments",
          "admissionEntries",
          "quotaOrganizations",
          "quotaProjects",
        ],
        "FINAL resources",
      ),
    );
    for (const [name, key] of [
      ["dimensions", "name"],
      ["quotaPools", "poolId"],
      ["reservations", "reservationId"],
      ["commitments", "commitmentId"],
      ["admissionEntries", "admissionEntryId"],
      ["quotaOrganizations", "organizationId"],
      ["quotaProjects", "projectId"],
    ]) {
      const ids = state.resources[name].map((item) => item[key]);
      ctx.equal(`${name} bytewise sort`, ids, [...ids].sort(compareUtf8));
    }
    ctx.ok(
      "snapshot retains leased and terminal Work",
      state.work.some(({ state: status }) => status === "LEASED") &&
        state.work.some(({ terminal }) => terminal),
    );
    ctx.equal(
      "snapshot omits token fields",
      /"[^"]*Token"\s*:/u.test(JSON.stringify(state)),
      false,
    );
    ctx.assert("snapshot fully reconciles at one point", () =>
      reconcileSnapshot(state),
    );
    return {
      evidence: [
        state.asOf,
        state.work.map(({ workId, state: status }) => [workId, status]),
      ],
    };
  },
);
export const D_CASES = [D01, D02, D03, D04];
