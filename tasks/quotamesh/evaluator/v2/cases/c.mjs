import { hierarchyWorkedExample, vector } from "../lib/fixtures.mjs";
import { assertEvent, canonical, orderedAdmissions } from "../lib/oracle.mjs";
import {
  boot,
  createHierarchy,
  defineCase,
  eventsFor,
  organizationFrom,
  poolFrom,
  projectFrom,
  requireReservation,
  reservationFrom,
  snapshot,
  waitReservation,
  workFor,
} from "./helpers.mjs";

const C01 = defineCase(
  "C-01",
  "Due Reservation Expiry Work at claimed and before-commit barriers",
  "SIGKILL a claimed worker, wait for its persisted lease, and recover with a replacement",
  "Preserve Work identity/attempt, fence stale token and release the complete vector exactly once with one expiry Event",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 10, dimensionCount: 3 },
    });
    const reservation = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 4, { ttlSeconds: 1 }),
      ),
    );
    await ctx.sleep(1100);
    const barrier = await ctx.workerBarrier(
      "worker.claimed",
      ({ aggregateId }) => aggregateId === reservation.reservationId,
    );
    const stale = await ctx.startWorkerAtBarrier(barrier);
    const held = await barrier.waitFor(
      ({ json }) => json.aggregateId === reservation.reservationId,
      { processes: [stale] },
    );
    const leased = await ctx.snapshot(api.baseUrl),
      originalWork = workFor(leased, reservation.reservationId).find(
        ({ kind }) => kind === "RESERVATION_EXPIRY",
      );
    ctx.equal(
      "claimed barrier attempt matches Work",
      held.json.attempt,
      originalWork.attempt,
    );
    await ctx.kill(stale);
    ctx.equal(
      "crashed claim leaves complete vector held",
      (await ctx.getPool(api.baseUrl, catalog.pool.poolId)).json.held,
      vector(4, catalog.dimensions),
    );
    await ctx.sleep(3200);
    const replacement = await ctx.startWorker();
    await waitReservation(
      ctx,
      api.baseUrl,
      reservation.reservationId,
      "EXPIRED",
      { processes: [replacement] },
    );
    const state = await snapshot(ctx, api.baseUrl),
      recovered = workFor(state, reservation.reservationId).find(
        ({ kind }) => kind === "RESERVATION_EXPIRY",
      );
    ctx.equal(
      "recovery preserves Work identity",
      recovered.workId,
      originalWork.workId,
    );
    ctx.ok("recovery advances attempt", recovered.attempt >= 2);
    ctx.equal(
      "recovered Work terminal retained",
      [
        recovered.state,
        recovered.terminal,
        recovered.leaseOwner,
        recovered.leaseExpiresAt,
      ],
      ["SUCCEEDED", true, null, null],
    );
    ctx.equal(
      "expiry releases all Dimensions once",
      poolFrom(state, catalog.pool.poolId).held,
      vector(0, catalog.dimensions),
    );
    ctx.equal(
      "expiry event occurs exactly once",
      eventsFor(state, reservation.reservationId).map(({ type }) => type),
      ["reservation.held", "reservation.expired"],
    );
    return {
      evidence: [recovered.workId, recovered.attempt, held.json.leaseTokenHash],
    };
  },
);

const C02 = defineCase(
  "C-02",
  "Twenty ordered Admissions behind one due complete-vector Reservation",
  "Crash expiry at effect-complete and first promotion before commit, then drain with replacements",
  "Match independent head-only order, promote every entry once and retain terminal Work for both kinds without vector oversubscription",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 20, dimensionCount: 2 },
    });
    const blocker = requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        catalog.pool.poolId,
        ctx.reserveBody(catalog, 20, { ttlSeconds: 1 }),
      ),
    );
    const entries = [];
    for (let index = 0; index < 20; index += 1)
      entries.push(
        (
          await ctx.enqueue(
            api.baseUrl,
            {
              poolId: catalog.pool.poolId,
              ownerId: ctx.uuid(`admission-owner:${index}`),
              quantities: vector(1, catalog.dimensions),
              priority: index < 5 ? 2 : 1,
            },
            { key: ctx.key(`admission:${index}`) },
          )
        ).json,
      );
    await ctx.sleep(1100);
    const expiryBarrier = await ctx.workerBarrier(
      "worker.effect-complete",
      ({ aggregateId }) => aggregateId === blocker.reservationId,
    );
    const expiryStale = await ctx.startWorkerAtBarrier(expiryBarrier);
    await expiryBarrier.waitFor(
      ({ json }) => json.aggregateId === blocker.reservationId,
      { processes: [expiryStale] },
    );
    await ctx.kill(expiryStale);
    ctx.equal(
      "effect-complete crash exposes no expiry effect",
      (await ctx.getReservation(api.baseUrl, blocker.reservationId)).json.state,
      "HELD",
    );
    await ctx.sleep(3200);
    const promotionIds = new Set(
      entries.map(({ admissionEntryId }) => admissionEntryId),
    );
    const promotionBarrier = await ctx.workerBarrier(
      "worker.before-commit",
      ({ aggregateId }) => promotionIds.has(aggregateId),
    );
    const chainWorker = await ctx.startWorkerAtBarrier(promotionBarrier);
    await waitReservation(ctx, api.baseUrl, blocker.reservationId, "EXPIRED", {
      processes: [chainWorker],
    });
    const promotionHeld = await promotionBarrier.waitFor(
      ({ json }) => promotionIds.has(json.aggregateId),
      { processes: [chainWorker] },
    );
    await ctx.kill(chainWorker);
    ctx.equal(
      "before-commit promotion crash leaves entry waiting",
      (await ctx.snapshot(api.baseUrl)).resources.admissionEntries.find(
        ({ admissionEntryId }) =>
          admissionEntryId === promotionHeld.json.aggregateId,
      ).state,
      "WAITING",
    );
    await ctx.sleep(3200);
    const replacements = [await ctx.startWorker(), await ctx.startWorker()];
    await ctx.waitFor(
      async () => {
        const value = await ctx.snapshot(api.baseUrl);
        return value.resources.admissionEntries.every(
          ({ state }) => state === "PROMOTED",
        ) && !value.work.some(({ terminal }) => !terminal)
          ? value
          : undefined;
      },
      {
        timeoutMs: 60000,
        label: "expiry promotion chain drain",
        processes: replacements,
      },
    );
    const state = await snapshot(ctx, api.baseUrl),
      ordered = orderedAdmissions(entries);
    const promoted = ordered.map((entry) =>
      state.resources.admissionEntries.find(
        ({ admissionEntryId }) => admissionEntryId === entry.admissionEntryId,
      ),
    );
    const created = promoted.map(
      (entry) => reservationFrom(state, entry.reservationId).createdAt,
    );
    ctx.equal(
      "promotions follow independent head-only ordering",
      created,
      [...created].sort(),
    );
    ctx.equal(
      "every Admission has one unique Reservation",
      new Set(promoted.map(({ reservationId }) => reservationId)).size,
      20,
    );
    ctx.equal(
      "promotion vector exactly refills Pool",
      poolFrom(state, catalog.pool.poolId).held,
      vector(20, catalog.dimensions),
    );
    ctx.ok(
      "both Work kinds are retained",
      new Set(state.work.map(({ kind }) => kind)).size === 2,
    );
    return {
      evidence: [
        blocker.reservationId,
        promotionHeld.json.aggregateId,
        ...promoted.map(({ reservationId }) => reservationId),
      ],
    };
  },
);

const C03 = defineCase(
  "C-03",
  "Organization/Project Reservation and allocation unknown-response windows",
  "Drop complete hierarchy mutation responses, replay across API restart, and compare both public ledgers",
  "Require exact saved responses and both Organization and Project vectors/revisions to appear together or not at all",
  async (ctx) => {
    const worked = hierarchyWorkedExample(ctx.fixtures);
    const { apis } = await boot(ctx, { apiCount: 2 });
    const { organization, projectA } = await createHierarchy(
      ctx,
      apis[0].baseUrl,
      worked,
    );
    const shield = await ctx.responseShield(apis[0].baseUrl);
    const reserveBody = {
        ownerId: ctx.uuid("unknown-owner"),
        quantities: worked.accepted,
        ttlSeconds: 300,
      },
      reserveKey = ctx.key("unknown-hierarchy-reserve");
    shield.dropNextMutation();
    let disconnected = false;
    try {
      await ctx.reserveProject(
        shield.baseUrl,
        organization.organizationId,
        projectA.projectId,
        reserveBody,
        { key: reserveKey },
      );
    } catch {
      disconnected = true;
    }
    ctx.ok("hierarchy Reservation response becomes unknown", disconnected);
    await ctx.waitFor(() => shield.captures.find(({ dropped }) => dropped), {
      label: "dropped hierarchy Reservation response",
    });
    const replay = requireReservation(
      ctx,
      await ctx.reserveProject(
        apis[1].baseUrl,
        organization.organizationId,
        projectA.projectId,
        reserveBody,
        { key: reserveKey },
      ),
    );
    ctx.equal(
      "hierarchy Reservation replay matches saved body",
      canonical(replay),
      canonical(
        JSON.parse(
          shield.captures.find(({ dropped }) => dropped).response.body,
        ),
      ),
    );
    let state = await snapshot(ctx, apis[1].baseUrl);
    ctx.equal(
      "unknown Reservation updates both held ledgers",
      projectFrom(state, projectA.projectId).held,
      organizationFrom(state, organization.organizationId).held,
    );
    const org = (
        await ctx.getOrganization(apis[1].baseUrl, organization.organizationId)
      ).json,
      project = (
        await ctx.getProject(
          apis[1].baseUrl,
          organization.organizationId,
          projectA.projectId,
        )
      ).json;
    const allocationBody = {
        allocation: { cpuMillis: 6, memoryMiB: 12 },
        expectedOrganizationRevision: org.revision,
        expectedProjectRevision: project.revision,
      },
      allocationKey = ctx.key("unknown-allocation");
    shield.dropNextMutation();
    disconnected = false;
    try {
      await ctx.updateProject(
        shield.baseUrl,
        org.organizationId,
        project.projectId,
        allocationBody,
        { key: allocationKey },
      );
    } catch {
      disconnected = true;
    }
    ctx.ok("allocation CAS response becomes unknown", disconnected);
    await ctx.waitFor(
      () => shield.captures.filter(({ dropped }) => dropped).length === 2,
      { label: "dropped allocation response" },
    );
    for (const api of apis) await ctx.stop(api);
    const restarted = await ctx.startApi();
    const allocationReplay = await ctx.updateProject(
      restarted.baseUrl,
      org.organizationId,
      project.projectId,
      allocationBody,
      { key: allocationKey },
    );
    ctx.equal(
      "allocation CAS replay preserves complete response",
      canonical(allocationReplay.json),
      canonical(
        JSON.parse(
          shield.captures.filter(({ dropped }) => dropped)[1].response.body,
        ),
      ),
    );
    state = await snapshot(ctx, restarted.baseUrl);
    ctx.equal(
      "allocation CAS preserves hierarchy feasibility",
      projectFrom(state, project.projectId).allocation,
      worked.projectA.allocation,
    );
    return { evidence: [replay.reservationId, allocationReplay.status] };
  },
);

const C04 = defineCase(
  "C-04",
  "Successful and rolled-back quota transitions with receiver ACK loss",
  "Commit hold/commit/release/expiry Events, hold dispatcher after response, SIGKILL and restart against retrying receiver",
  "Match public Event rows to stable QuotaMesh headers/body and contiguous aggregate sequence while rollback emits nothing",
  async (ctx) => {
    const { catalog, api } = await boot(ctx, {
      catalogOptions: { capacity: 20, dimensionCount: 2 },
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
    const conflict = await ctx.releaseReservation(
      api.baseUrl,
      released.reservationId,
    );
    ctx.equal("rollback mutation is conflict", conflict.status, 409);
    const state = await snapshot(ctx, api.baseUrl),
      publicEvents = state.events;
    const receiver = await ctx.receiver(() => ({ status: 204 })),
      barrier = await ctx.dispatcherBarrier(),
      dispatcher = await ctx.startDispatcherAtBarrier(receiver, barrier);
    const held = await barrier.waitFor(() => true, { processes: [dispatcher] });
    await ctx.kill(dispatcher);
    const first = receiver.ledger[0];
    await ctx.startDispatcher({ webhookUrl: receiver.url });
    await ctx.waitFor(
      () => {
        const delivered = new Set(
          receiver.ledger
            .filter(
              ({ acknowledged, responseStatus }) =>
                acknowledged && responseStatus === 204,
            )
            .map(({ json }) => json?.eventId),
        );
        return publicEvents.every(({ eventId }) => delivered.has(eventId));
      },
      { timeoutMs: 60000, label: "all quota Events delivered" },
    );
    const retry = receiver.ledger.find(
      (entry, index) =>
        index > 0 && entry.json?.eventId === first.json?.eventId,
    );
    ctx.ok("unknown ACK retries same Event", retry);
    ctx.equal(
      "retry body and headers stable",
      [
        retry.raw,
        retry.headers["x-quotamesh-event-id"],
        retry.headers["x-quotamesh-event-type"],
      ],
      [
        first.raw,
        first.headers["x-quotamesh-event-id"],
        first.headers["x-quotamesh-event-type"],
      ],
    );
    for (const event of publicEvents)
      ctx.assert("public Event exact shape", () => assertEvent(event));
    ctx.equal(
      "rolled-back release adds no Event",
      eventsFor(state, released.reservationId).map(({ type }) => type),
      ["reservation.held", "reservation.released"],
    );
    ctx.equal(
      "aggregate sequences contiguous",
      eventsFor(state, committed.reservationId).map(({ sequence }) => sequence),
      [1, 2],
    );
    return {
      evidence: [held.json.point, first.json.eventId, receiver.ledger.length],
    };
  },
);
export const C_CASES = [C01, C02, C03, C04];
