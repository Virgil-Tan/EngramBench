import { hierarchyWorkedExample, vector } from "../lib/fixtures.mjs";
import { addVectors, available, orderedAdmissions } from "../lib/oracle.mjs";
import {
  boot,
  commitmentsFor,
  createHierarchy,
  defineCase,
  expectError,
  noEffect,
  organizationFrom,
  poolFrom,
  projectFrom,
  queueItems,
  requireAdmission,
  requireCommitment,
  requireOrganization,
  requireProject,
  requireReservation,
  reservationFrom,
  snapshot,
  waitReservation,
} from "./helpers.mjs";

const A01 = defineCase(
  "A-01",
  "Two-to-six Dimension Pools at exact and one-unit boundaries",
  "Create and reject complete Reservation vectors through the public Pool endpoint",
  "Recompute capacity, available, held and committed for every Dimension and require all-or-none durable effects",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 100, dimensionCount: 6 },
    });
    const before = (await ctx.getPool(api.baseUrl, catalog.pool.poolId)).json;
    const first = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 10),
      ),
    );
    const after = (await ctx.getPool(api.baseUrl, catalog.pool.poolId)).json;
    ctx.equal(
      "all Dimensions held together",
      after.held,
      vector(10, catalog.dimensions),
    );
    ctx.equal(
      "all Dimensions available together",
      available(after.capacity, after.held, after.committed),
      vector(90, catalog.dimensions),
    );
    const exact = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 90),
      ),
    );
    ctx.equal(
      "exact boundary consumes every Dimension",
      (await ctx.getPool(api.baseUrl, catalog.pool.poolId)).json.held,
      vector(100, catalog.dimensions),
    );
    const stable = await snapshot(ctx, api.baseUrl);
    const invalids = [
      [ctx.reserveBody(catalog, {}), 400, "INVALID_QUOTA_VECTOR"],
      [
        ctx.reserveBody(catalog, {
          ...vector(1, catalog.dimensions),
          cpuMillis: 0,
        }),
        400,
        "INVALID_QUOTA_VECTOR",
      ],
      [
        ctx.reserveBody(catalog, {
          ...vector(1, catalog.dimensions),
          unknown: 1,
        }),
        400,
        "INVALID_QUOTA_VECTOR",
      ],
      [
        ctx.reserveBody(catalog, {
          ...vector(1, catalog.dimensions),
          cpuMillis: 1.5,
        }),
        400,
        "INVALID_QUOTA_VECTOR",
      ],
      [
        ctx.reserveBody(catalog, vector(1, catalog.dimensions)),
        409,
        "QUOTA_EXCEEDED",
      ],
    ];
    for (const [body, status, code] of invalids)
      expectError(
        ctx,
        await ctx.reservePool(api.baseUrl, catalog.pool.poolId, body),
        status,
        code,
      );
    noEffect(
      ctx,
      stable,
      await snapshot(ctx, api.baseUrl),
      "invalid and exceeded vectors",
    );
    return {
      evidence: [
        first.reservationId,
        exact.reservationId,
        before.revision,
        after.revision,
      ],
    };
  },
);

const A02 = defineCase(
  "A-02",
  "HELD Reservations around database expiry time",
  "Commit one, release one and let a real Expiry worker expire one at ttlSeconds=1",
  "Move complete vectors exactly once, close terminal state and keep Commitment distinct from released/expired capacity",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 100, dimensionCount: 3 },
    });
    const committed = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, vector(2, catalog.dimensions), {
          ttlSeconds: 300,
        }),
      ),
    );
    const commitment = requireCommitment(
      ctx,
      await ctx.commitReservation(api.baseUrl, committed.reservationId),
    );
    const released = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, vector(3, catalog.dimensions)),
      ),
      {},
    );
    requireReservation(
      ctx,
      await ctx.releaseReservation(api.baseUrl, released.reservationId),
      { status: 200, expected: { state: "RELEASED" } },
    );
    const expiring = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, vector(4, catalog.dimensions), {
          ttlSeconds: 1,
        }),
      ),
    );
    const worker = await ctx.startWorker();
    await waitReservation(ctx, api.baseUrl, expiring.reservationId, "EXPIRED", {
      timeoutMs: 10000,
      processes: [worker],
    });
    expectError(
      ctx,
      await ctx.releaseReservation(api.baseUrl, committed.reservationId),
      409,
      "RESERVATION_NOT_RELEASABLE",
    );
    expectError(
      ctx,
      await ctx.commitReservation(api.baseUrl, expiring.reservationId),
      409,
      "RESERVATION_EXPIRED",
    );
    expectError(
      ctx,
      await ctx.releaseReservation(api.baseUrl, released.reservationId),
      409,
      "RESERVATION_NOT_RELEASABLE",
    );
    const state = await snapshot(ctx, api.baseUrl);
    const pool = poolFrom(state, catalog.pool.poolId);
    ctx.equal(
      "terminal transitions leave no held quantity",
      pool.held,
      vector(0, catalog.dimensions),
    );
    ctx.equal(
      "only committed vector remains active",
      pool.committed,
      vector(2, catalog.dimensions),
    );
    ctx.equal(
      "Commitment is immutable and unique",
      commitmentsFor(state, committed.reservationId).map(
        ({ commitmentId }) => commitmentId,
      ),
      [commitment.commitmentId],
    );
    ctx.equal(
      "state closure exact",
      [
        reservationFrom(state, committed.reservationId).state,
        reservationFrom(state, released.reservationId).state,
        reservationFrom(state, expiring.reservationId).state,
      ],
      ["COMMITTED", "RELEASED", "EXPIRED"],
    );
    return {
      evidence: [
        committed.reservationId,
        released.reservationId,
        expiring.reservationId,
      ],
    };
  },
);

const A03 = defineCase(
  "A-03",
  "Priority/time/ID ties with blocked head and fitting later entry",
  "Fill a Pool, enqueue an unfitting head plus fitting later entry, release capacity and drive real promotion workers",
  "Compare public positions and promotion sequence to strict priority/requestedAt/ID head-only order",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 2, dimensionCount: 2 },
    });
    const blocker = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 2),
      ),
    );
    const head = requireAdmission(
      ctx,
      await ctx.enqueue(api.baseUrl, {
        poolId: catalog.pool.poolId,
        ownerId: catalog.ownerId,
        quantities: vector(2, catalog.dimensions),
        priority: 10,
      }),
    );
    const later = requireAdmission(
      ctx,
      await ctx.enqueue(api.baseUrl, {
        poolId: catalog.pool.poolId,
        ownerId: catalog.otherOwnerId,
        quantities: vector(1, catalog.dimensions),
        priority: 10,
      }),
    );
    const queue = queueItems(
      await ctx.getQueue(api.baseUrl, catalog.pool.poolId),
    );
    ctx.equal(
      "public queue derives head-only positions",
      queue.map(({ admissionEntryId, position }) => [
        admissionEntryId,
        position,
      ]),
      [
        [head.admissionEntryId, 1],
        [later.admissionEntryId, 2],
      ],
    );
    const worker = await ctx.startWorker();
    await ctx.sleep(300);
    let state = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      "blocked head prevents fitting later bypass",
      [
        reservationFrom(state, blocker.reservationId).state,
        resourceAdmissions(state, head.admissionEntryId).state,
        resourceAdmissions(state, later.admissionEntryId).state,
      ],
      ["HELD", "WAITING", "WAITING"],
    );
    requireReservation(
      ctx,
      await ctx.releaseReservation(api.baseUrl, blocker.reservationId),
      { status: 200 },
    );
    await ctx.waitFor(
      async () => {
        const value = await ctx.snapshot(api.baseUrl);
        return resourceAdmissions(value, head.admissionEntryId).state ===
          "PROMOTED"
          ? value
          : undefined;
      },
      { label: "head promotion", processes: [worker] },
    );
    state = await snapshot(ctx, api.baseUrl);
    const promotedHead = resourceAdmissions(state, head.admissionEntryId);
    ctx.equal(
      "head promotes first and later remains waiting",
      [
        promotedHead.state,
        resourceAdmissions(state, later.admissionEntryId).state,
      ],
      ["PROMOTED", "WAITING"],
    );
    requireReservation(
      ctx,
      await ctx.releaseReservation(api.baseUrl, promotedHead.reservationId),
      { status: 200 },
    );
    await ctx.waitFor(
      async () => {
        const value = await ctx.snapshot(api.baseUrl);
        return resourceAdmissions(value, later.admissionEntryId).state ===
          "PROMOTED"
          ? value
          : undefined;
      },
      { label: "later promotion", processes: [worker] },
    );
    const final = await snapshot(ctx, api.baseUrl);
    ctx.equal(
      "each Admission creates at most one Reservation",
      [head, later].map(
        (entry) =>
          final.resources.reservations.filter(
            (item) =>
              item.reservationId ===
              resourceAdmissions(final, entry.admissionEntryId).reservationId,
          ).length,
      ),
      [1, 1],
    );
    return {
      evidence: orderedAdmissions([head, later]).map(
        ({ admissionEntryId }) => admissionEntryId,
      ),
    };
  },
);
function resourceAdmissions(state, id) {
  return state.resources.admissionEntries.find(
    (item) => item.admissionEntryId === id,
  );
}

const A04 = defineCase(
  "A-04",
  "Manager Organization/Project worked example and sibling Project",
  "Create hierarchy, commit and hold Project A vectors, attempt sibling borrowing, release held capacity and retry",
  "Maintain independent Organization and Project ledgers and require both levels to change atomically with Project checked first",
  async (ctx) => {
    const { api } = await boot(ctx);
    const worked = hierarchyWorkedExample(ctx.fixtures);
    const { organization, projectA, projectB } = await createHierarchy(
      ctx,
      api.baseUrl,
      worked,
    );
    const committed = requireReservation(
      ctx,
      await ctx.reserveProject(
        api.baseUrl,
        organization.organizationId,
        projectA.projectId,
        {
          ownerId: ctx.uuid("owner:a"),
          quantities: worked.committed,
          ttlSeconds: 300,
        },
      ),
    );
    requireCommitment(
      ctx,
      await ctx.commitReservation(api.baseUrl, committed.reservationId),
    );
    const held = requireReservation(
      ctx,
      await ctx.reserveProject(
        api.baseUrl,
        organization.organizationId,
        projectA.projectId,
        {
          ownerId: ctx.uuid("owner:held"),
          quantities: worked.released,
          ttlSeconds: 300,
        },
      ),
    );
    const before = await snapshot(ctx, api.baseUrl);
    expectError(
      ctx,
      await ctx.reserveProject(
        api.baseUrl,
        organization.organizationId,
        projectA.projectId,
        {
          ownerId: ctx.uuid("owner:reject"),
          quantities: worked.rejected,
          ttlSeconds: 300,
        },
      ),
      409,
      "PROJECT_QUOTA_EXCEEDED",
    );
    noEffect(
      ctx,
      before,
      await snapshot(ctx, api.baseUrl),
      "sibling borrowing rejection",
    );
    requireReservation(
      ctx,
      await ctx.releaseReservation(api.baseUrl, held.reservationId),
      { status: 200 },
    );
    const accepted = requireReservation(
      ctx,
      await ctx.reserveProject(
        api.baseUrl,
        organization.organizationId,
        projectA.projectId,
        {
          ownerId: ctx.uuid("owner:accepted"),
          quantities: worked.accepted,
          ttlSeconds: 300,
        },
      ),
    );
    const state = await snapshot(ctx, api.baseUrl);
    const org = organizationFrom(state, organization.organizationId),
      project = projectFrom(state, projectA.projectId),
      sibling = projectFrom(state, projectB.projectId);
    ctx.equal(
      "accepted vector increments Project and Organization held identically",
      [project.held, org.held],
      [worked.accepted, worked.accepted],
    );
    ctx.equal(
      "committed vector exists at both levels",
      [project.committed, org.committed],
      [worked.committed, worked.committed],
    );
    ctx.equal(
      "unused sibling allocation is not consumed",
      [sibling.held, sibling.committed],
      [
        { cpuMillis: 0, memoryMiB: 0 },
        { cpuMillis: 0, memoryMiB: 0 },
      ],
    );
    ctx.equal(
      "new hierarchy Reservation has null legacy Pool",
      reservationFrom(state, accepted.reservationId).poolId,
      null,
    );
    return {
      evidence: [
        organization.organizationId,
        projectA.projectId,
        projectB.projectId,
        accepted.reservationId,
      ],
    };
  },
);

const A05 = defineCase(
  "A-05",
  "Organization capacity and Project allocation revisions around usage",
  "Run successful, stale and infeasible PUT compare-and-set updates through exact public hierarchy resources",
  "Require revision increments only with complete feasible vector updates and zero mutation for stale or conflicting CAS",
  async (ctx) => {
    const { api } = await boot(ctx);
    const worked = hierarchyWorkedExample(ctx.fixtures);
    const created = await createHierarchy(ctx, api.baseUrl, worked);
    let org = (
        await ctx.getOrganization(
          api.baseUrl,
          created.organization.organizationId,
        )
      ).json,
      project = (
        await ctx.getProject(
          api.baseUrl,
          org.organizationId,
          created.projectA.projectId,
        )
      ).json;
    const reserved = requireReservation(
      ctx,
      await ctx.reserveProject(
        api.baseUrl,
        org.organizationId,
        project.projectId,
        {
          ownerId: ctx.uuid("cas-owner"),
          quantities: worked.released,
          ttlSeconds: 300,
        },
      ),
    );
    org = (await ctx.getOrganization(api.baseUrl, org.organizationId)).json;
    project = (
      await ctx.getProject(api.baseUrl, org.organizationId, project.projectId)
    ).json;
    const stable = await snapshot(ctx, api.baseUrl);
    expectError(
      ctx,
      await ctx.updateOrganization(api.baseUrl, org.organizationId, {
        capacity: worked.organizationBody.capacity,
        expectedRevision: org.revision - 1,
      }),
      409,
      "QUOTA_HIERARCHY_REVISION_CHANGED",
    );
    expectError(
      ctx,
      await ctx.updateOrganization(api.baseUrl, org.organizationId, {
        capacity: { cpuMillis: 9, memoryMiB: 19 },
        expectedRevision: org.revision,
      }),
      409,
      "ORGANIZATION_CAPACITY_CONFLICT",
    );
    expectError(
      ctx,
      await ctx.updateProject(
        api.baseUrl,
        org.organizationId,
        project.projectId,
        {
          allocation: { cpuMillis: 1, memoryMiB: 3 },
          expectedOrganizationRevision: org.revision,
          expectedProjectRevision: project.revision,
        },
      ),
      409,
      "PROJECT_ALLOCATION_CONFLICT",
    );
    noEffect(
      ctx,
      stable,
      await snapshot(ctx, api.baseUrl),
      "failed CAS operations",
    );
    const updatedOrg = requireOrganization(
      ctx,
      await ctx.updateOrganization(api.baseUrl, org.organizationId, {
        capacity: { cpuMillis: 12, memoryMiB: 24 },
        expectedRevision: org.revision,
      }),
      200,
    );
    ctx.equal(
      "Organization successful CAS increments revision",
      updatedOrg.revision,
      org.revision + 1,
    );
    const currentProject = (
      await ctx.getProject(api.baseUrl, org.organizationId, project.projectId)
    ).json;
    const updatedProject = requireProject(
      ctx,
      await ctx.updateProject(
        api.baseUrl,
        org.organizationId,
        project.projectId,
        {
          allocation: { cpuMillis: 7, memoryMiB: 14 },
          expectedOrganizationRevision: updatedOrg.revision,
          expectedProjectRevision: currentProject.revision,
        },
      ),
      200,
    );
    ctx.equal(
      "Project successful CAS increments revision",
      updatedProject.revision,
      currentProject.revision + 1,
    );
    await snapshot(ctx, api.baseUrl);
    return {
      evidence: [
        reserved.reservationId,
        updatedOrg.revision,
        updatedProject.revision,
      ],
    };
  },
);
export const A_CASES = [A01, A02, A03, A04, A05];
