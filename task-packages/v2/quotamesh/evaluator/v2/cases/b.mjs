import { hierarchyWorkedExample, vector } from "../lib/fixtures.mjs";
import { addVectors, canonical, fits } from "../lib/oracle.mjs";
import {
  boot,
  createHierarchy,
  defineCase,
  eventsFor,
  expectError,
  organizationFrom,
  poolFrom,
  projectFrom,
  requireReservation,
  reservationFrom,
  snapshot,
  stableReplay,
  waitReservation,
} from "./helpers.mjs";

const B01 = defineCase(
  "B-01",
  "Same Reservation key across two APIs, response loss and restart",
  "Race twenty identical mutations, drop a complete response, reuse conflicting semantics and replay after process restart",
  "Require original status/body/Reservation ID and exactly one complete held-vector effect for canonical method/path/key scope",
  async (ctx) => {
    const { catalog, apis } = await boot(ctx, {
      apiCount: 2,
      catalogOptions: { capacity: 100, dimensionCount: 3 },
    });
    const body = ctx.reserveBody(catalog, 5),
      key = ctx.key("twenty-way");
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        ctx.reservePool(apis[index % 2].baseUrl, catalog.pool.poolId, body, {
          key,
        }),
      ),
    );
    const original = stableReplay(ctx, responses, "twenty-way Reservation");
    const reservation = requireReservation(ctx, original);
    let state = await snapshot(ctx, apis[0].baseUrl);
    ctx.equal(
      "concurrent replay holds one vector",
      poolFrom(state, catalog.pool.poolId).held,
      vector(5, catalog.dimensions),
    );
    expectError(
      ctx,
      await ctx.reservePool(
        apis[1].baseUrl,
        catalog.pool.poolId,
        { ...body, ttlSeconds: 301 },
        { key },
      ),
      409,
      "IDEMPOTENCY_CONFLICT",
      { hardCapIds: ["IDEMPOTENCY_CORRECTNESS"] },
    );
    const shield = await ctx.responseShield(apis[0].baseUrl),
      unknownKey = ctx.key("unknown"),
      unknownBody = ctx.reserveBody(catalog, 7, {
        ownerId: catalog.otherOwnerId,
      });
    shield.dropNextMutation();
    let disconnected = false;
    try {
      await ctx.reservePool(shield.baseUrl, catalog.pool.poolId, unknownBody, {
        key: unknownKey,
      });
    } catch {
      disconnected = true;
    }
    ctx.ok("response shield produced an unknown outcome", disconnected);
    await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), {
      label: "dropped complete response",
    });
    const replay = requireReservation(
      ctx,
      await ctx.reservePool(apis[1].baseUrl, catalog.pool.poolId, unknownBody, {
        key: unknownKey,
      }),
    );
    ctx.equal(
      "unknown response replay body is durable",
      canonical(replay),
      canonical(
        JSON.parse(
          shield.captures.find(({ dropped }) => dropped).response.body,
        ),
      ),
    );
    for (const api of apis) await ctx.stop(api);
    const restarted = await ctx.startApi();
    const afterRestart = await ctx.reservePool(
      restarted.baseUrl,
      catalog.pool.poolId,
      body,
      { key },
    );
    ctx.equal(
      "restart replay status/body unchanged",
      [afterRestart.status, canonical(afterRestart.json)],
      [original.status, canonical(original.json)],
    );
    state = await snapshot(ctx, restarted.baseUrl);
    ctx.equal(
      "two logical requests hold exactly two vectors",
      poolFrom(state, catalog.pool.poolId).held,
      vector(12, catalog.dimensions),
    );
    ctx.equal(
      "no duplicate Reservation identity",
      state.resources.reservations.filter(
        ({ reservationId }) => reservationId === reservation.reservationId,
      ).length,
      1,
    );
    return { evidence: [reservation.reservationId, replay.reservationId] };
  },
);

const B02 = defineCase(
  "B-02",
  "Hot six-Dimension Pool fitting exactly six of twenty vectors",
  "Send twenty distinct Reservation requests concurrently through two API processes",
  "Linearize winners so every Dimension stays within capacity and every loser is exact QUOTA_EXCEEDED with no orphan effect",
  async (ctx) => {
    const { catalog, apis } = await boot(ctx, {
      apiCount: 2,
      catalogOptions: { capacity: 20, dimensionCount: 6 },
    });
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        ctx.reservePool(
          apis[index % 2].baseUrl,
          catalog.pool.poolId,
          ctx.reserveBody(catalog, 3, { ownerId: ctx.uuid(`owner:${index}`) }),
          { key: ctx.key(`hot:${index}`), timeoutMs: 20000 },
        ),
      ),
    );
    const winners = responses.filter(({ status }) => status === 201);
    ctx.equal("hot Pool admits exact feasible winner count", winners.length, 6);
    for (const loser of responses.filter(({ status }) => status !== 201))
      expectError(ctx, loser, 409, "QUOTA_EXCEEDED");
    const state = await snapshot(ctx, apis[0].baseUrl);
    ctx.equal(
      "hot Pool held vector is winner sum",
      poolFrom(state, catalog.pool.poolId).held,
      vector(18, catalog.dimensions),
    );
    ctx.equal(
      "each success owns one complete vector",
      winners.every(({ json }) =>
        Object.values(json.quantities).every((value) => value === 3),
      ),
      true,
    );
    ctx.equal(
      "snapshot contains exactly winner Reservations",
      state.resources.reservations.length,
      winners.length,
    );
    return { evidence: winners.map(({ json }) => json.reservationId) };
  },
);

const B03 = defineCase(
  "B-03",
  "HELD Reservation at one-second expiry boundary",
  "Race commit and release across two APIs while two Expiry workers execute due Work",
  "Permit exactly one COMMITTED, RELEASED or EXPIRED terminal vector transition and forbid re-entry or double return",
  async (ctx) => {
    const { catalog, apis } = await boot(ctx, {
      apiCount: 2,
      catalogOptions: { capacity: 10, dimensionCount: 3 },
    });
    const held = requireReservation(
      ctx,
      await ctx.reservePool(
        apis[0].baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 4, { ttlSeconds: 1 }),
      ),
    );
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await ctx.sleep(900);
    const [commit, release] = await Promise.all([
      ctx.commitReservation(apis[0].baseUrl, held.reservationId),
      ctx.releaseReservation(apis[1].baseUrl, held.reservationId),
    ]);
    const terminal = await ctx.waitFor(
      async () => {
        const response = await ctx.getReservation(
          apis[0].baseUrl,
          held.reservationId,
        );
        return ["COMMITTED", "RELEASED", "EXPIRED"].includes(
          response.json?.state,
        )
          ? response.json
          : undefined;
      },
      { label: "terminal race winner", processes: workers },
    );
    ctx.ok(
      "at most one API terminal mutation succeeds",
      [commit, release].filter(({ status }) => status === 200).length <= 1,
    );
    const state = await snapshot(ctx, apis[0].baseUrl);
    const pool = poolFrom(state, catalog.pool.poolId);
    ctx.equal(
      "terminal race removes held exactly once",
      pool.held,
      vector(0, catalog.dimensions),
    );
    ctx.equal(
      "committed vector reflects only COMMITTED winner",
      pool.committed,
      vector(terminal.state === "COMMITTED" ? 4 : 0, catalog.dimensions),
    );
    ctx.equal(
      "terminal Event occurs once",
      eventsFor(state, held.reservationId).filter(
        ({ type }) => type !== "reservation.held",
      ).length,
      1,
    );
    return { evidence: [terminal.state, commit.status, release.status] };
  },
);

const B04 = defineCase(
  "B-04",
  "Blocked head plus fitting later entries and two concurrent releases",
  "Release two held vectors concurrently while two workers execute Admission promotion",
  "Recompute only the head after each capacity commit and require unique promotions in published queue order",
  async (ctx) => {
    const { catalog, apis } = await boot(ctx, {
      apiCount: 2,
      catalogOptions: { capacity: 5, dimensionCount: 2 },
    });
    const first = requireReservation(
      ctx,
      await ctx.reservePool(
        apis[0].baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 3, { ownerId: ctx.uuid("block-a") }),
      ),
    );
    const second = requireReservation(
      ctx,
      await ctx.reservePool(
        apis[0].baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 2, { ownerId: ctx.uuid("block-b") }),
      ),
    );
    const head = (
      await ctx.enqueue(apis[0].baseUrl, {
        poolId: catalog.pool.poolId,
        ownerId: ctx.uuid("head"),
        quantities: vector(4, catalog.dimensions),
        priority: 10,
      })
    ).json;
    const later = (
      await ctx.enqueue(apis[0].baseUrl, {
        poolId: catalog.pool.poolId,
        ownerId: ctx.uuid("later"),
        quantities: vector(1, catalog.dimensions),
        priority: 10,
      })
    ).json;
    const workers = [await ctx.startWorker(), await ctx.startWorker()];
    await Promise.all([
      ctx.releaseReservation(apis[0].baseUrl, first.reservationId),
      ctx.releaseReservation(apis[1].baseUrl, second.reservationId),
    ]);
    await ctx.waitFor(
      async () => {
        const value = await ctx.snapshot(apis[0].baseUrl);
        return value.resources.admissionEntries.every(
          ({ state }) => state === "PROMOTED",
        )
          ? value
          : undefined;
      },
      { label: "concurrent head-only promotion", processes: workers },
    );
    const state = await snapshot(ctx, apis[0].baseUrl);
    const savedHead = state.resources.admissionEntries.find(
        ({ admissionEntryId }) => admissionEntryId === head.admissionEntryId,
      ),
      savedLater = state.resources.admissionEntries.find(
        ({ admissionEntryId }) => admissionEntryId === later.admissionEntryId,
      );
    ctx.ok(
      "head Reservation is created before later Reservation",
      reservationFrom(state, savedHead.reservationId).createdAt <=
        reservationFrom(state, savedLater.reservationId).createdAt,
    );
    ctx.equal(
      "each Admission points to one unique Reservation",
      new Set([savedHead.reservationId, savedLater.reservationId]).size,
      2,
    );
    ctx.equal(
      "both promotion effects exactly fill Pool",
      poolFrom(state, catalog.pool.poolId).held,
      vector(5, catalog.dimensions),
    );
    return { evidence: [savedHead.reservationId, savedLater.reservationId] };
  },
);

const B05 = defineCase(
  "B-05",
  "Project allocation shrink racing a Project Reservation",
  "Run allocation CAS and Reservation concurrently through separate API processes",
  "Accept only serializable winner combinations and verify Organization and Project vectors remain feasible at every successful commit",
  async (ctx) => {
    const worked = hierarchyWorkedExample(ctx.fixtures);
    const { apis } = await boot(ctx, { apiCount: 2 });
    const { organization, projectA } = await createHierarchy(
      ctx,
      apis[0].baseUrl,
      worked,
    );
    const org = (
        await ctx.getOrganization(apis[0].baseUrl, organization.organizationId)
      ).json,
      project = (
        await ctx.getProject(
          apis[0].baseUrl,
          organization.organizationId,
          projectA.projectId,
        )
      ).json;
    const [cas, reserve] = await Promise.all([
      ctx.updateProject(
        apis[0].baseUrl,
        organization.organizationId,
        project.projectId,
        {
          allocation: { cpuMillis: 2, memoryMiB: 4 },
          expectedOrganizationRevision: org.revision,
          expectedProjectRevision: project.revision,
        },
        { key: ctx.key("race-cas") },
      ),
      ctx.reserveProject(
        apis[1].baseUrl,
        organization.organizationId,
        project.projectId,
        {
          ownerId: ctx.uuid("race-owner"),
          quantities: worked.accepted,
          ttlSeconds: 300,
        },
        { key: ctx.key("race-reserve") },
      ),
    ]);
    ctx.equal(
      "hierarchy conflict race has one success",
      [cas, reserve].filter(({ status }) => [200, 201].includes(status)).length,
      1,
    );
    ctx.ok(
      "hierarchy conflict loser is published",
      [cas, reserve]
        .filter(({ status }) => status === 409)
        .every(({ json }) =>
          [
            "QUOTA_HIERARCHY_REVISION_CHANGED",
            "PROJECT_ALLOCATION_CONFLICT",
            "PROJECT_QUOTA_EXCEEDED",
          ].includes(json.error.code),
        ),
    );
    const state = await snapshot(ctx, apis[0].baseUrl);
    const savedOrg = organizationFrom(state, organization.organizationId),
      savedProject = projectFrom(state, project.projectId);
    ctx.ok(
      "Project usage fits final allocation",
      fits(
        addVectors(savedProject.held, savedProject.committed),
        savedProject.allocation,
      ),
    );
    ctx.ok(
      "Organization usage fits final capacity",
      fits(addVectors(savedOrg.held, savedOrg.committed), savedOrg.capacity),
    );
    ctx.equal(
      "both hierarchy held ledgers match",
      savedProject.held,
      savedOrg.held,
    );
    return {
      evidence: [
        cas.status,
        reserve.status,
        savedOrg.revision,
        savedProject.revision,
      ],
    };
  },
);
export const B_CASES = [B01, B02, B03, B04, B05];
