import {
  performanceContract,
  performanceSeed,
  vector,
} from "../lib/fixtures.mjs";
import {
  assertPool,
  assertReservation,
  canonical,
  compareUtf8,
  percentile,
  reconcileSnapshot,
} from "../lib/oracle.mjs";
import { EvaluationInfrastructureError } from "../lib/runtime.mjs";
import {
  defineCase,
  poolFrom,
  requirePool,
  requireReservation,
  reservationFrom,
  snapshot,
  waitReservation,
  workFor,
} from "./helpers.mjs";
function scale() {
  const value = Number(process.env.BENCH_PERF_SCALE ?? "1");
  if (!(value > 0 && value <= 1))
    throw new EvaluationInfrastructureError(
      "EVALUATOR_INVALID_PERF_SCALE",
      "BENCH_PERF_SCALE must be in (0,1]",
    );
  return value;
}
async function installPerf(ctx, value) {
  const seed = performanceSeed(ctx.fixtures, value);
  await ctx.seed(seed, { timeoutMs: 1800000 });
  return seed;
}
async function closedLoop(seconds, concurrency, operation) {
  const deadline = performance.now() + seconds * 1000;
  let index = 0;
  const samples = [];
  await Promise.all(
    Array.from({ length: concurrency }, async (_, client) => {
      while (performance.now() < deadline)
        samples.push(await operation(index++, client));
    }),
  );
  return samples;
}
async function finiteLoad(seconds, concurrency, schedule, operation) {
  const deadline = performance.now() + seconds * 1000;
  let next = 0;
  const samples = new Array(schedule.length);
  await Promise.all(
    Array.from({ length: concurrency }, async (_, client) => {
      while (performance.now() < deadline) {
        const index = next++;
        if (index >= schedule.length) break;
        samples[index] = await operation(schedule[index], index, client);
      }
    }),
  );
  const remaining = deadline - performance.now();
  if (remaining > 0)
    await new Promise((resolve) => setTimeout(resolve, remaining));
  return samples.filter(Boolean);
}
const RES_V1 = [
  "reservationId",
  "poolId",
  "ownerId",
  "quantities",
  "state",
  "expiresAt",
  "createdAt",
  "terminalAt",
  "sequence",
];
function v1Projection(value) {
  return Object.fromEntries(RES_V1.map((key) => [key, value[key]]));
}

const E01 = defineCase(
  "E-01",
  "Populated V1 Pool with held/committed/released Reservations, Admission, pending Work, Events and replay",
  "Create V1 state, migrate the same PostgreSQL database with FINAL, replay old HTTP and recover pending expiry",
  "Map each Pool to one Organization/default Project while preserving every legacy identity, vector, queue order, Work/Event and saved response",
  async (ctx) => {
    if (!ctx.v1Workspace)
      throw new EvaluationInfrastructureError(
        "EVALUATOR_V1_WORKSPACE_REQUIRED",
        "E-01 requires --v1-workspace",
      );
    const catalog = ctx.catalog({ capacity: 50, dimensionCount: 3 }),
      v1 = ctx.forWorkspace(ctx.v1Workspace);
    await v1.migrate();
    await ctx.seed(ctx.seedFor("v1-final", { catalog }), {
      workspace: ctx.v1Workspace,
    });
    const api = await v1.startApi();
    const heldResponse = await ctx.reservePool(
      api.baseUrl,
      catalog.pool.poolId,
      ctx.reserveBody(catalog, 4, { ttlSeconds: 1 }),
      { key: ctx.key("v1-held") },
    );
    ctx.equal("V1 hold status", heldResponse.status, 201);
    ctx.assert("V1 Reservation exact legacy shape", () =>
      assertReservation(heldResponse.json, { final: false }),
    );
    const committedResponse = await ctx.reservePool(
      api.baseUrl,
      catalog.pool.poolId,
      ctx.reserveBody(catalog, 3),
      { key: ctx.key("v1-commit-create") },
    );
    const committed = (
      await ctx.commitReservation(
        api.baseUrl,
        committedResponse.json.reservationId,
        { key: ctx.key("v1-commit") },
      )
    ).json;
    const releasedResponse = await ctx.reservePool(
      api.baseUrl,
      catalog.pool.poolId,
      ctx.reserveBody(catalog, 2),
      { key: ctx.key("v1-release-create") },
    );
    await ctx.releaseReservation(
      api.baseUrl,
      releasedResponse.json.reservationId,
      { key: ctx.key("v1-release") },
    );
    const replayBody = ctx.reserveBody(catalog, 1, {
        ownerId: catalog.otherOwnerId,
      }),
      replayKey = ctx.key("v1-replay");
    const savedReplay = await ctx.reservePool(
      api.baseUrl,
      catalog.pool.poolId,
      replayBody,
      { key: replayKey },
    );
    await ctx.enqueue(
      api.baseUrl,
      {
        poolId: catalog.pool.poolId,
        ownerId: ctx.uuid("v1-admission"),
        quantities: vector(40, catalog.dimensions),
        priority: 1,
      },
      { key: ctx.key("v1-admission") },
    );
    const before = await ctx.snapshot(api.baseUrl),
      savedWork = workFor(before, heldResponse.json.reservationId).find(
        ({ kind }) => kind === "RESERVATION_EXPIRY",
      );
    await ctx.stop(api);
    await ctx.migrate();
    const finalApi = await ctx.startApi();
    const after = await ctx.snapshot(finalApi.baseUrl);
    ctx.equal(
      "migration preserves flat Pool exact wire",
      canonical(after.resources.quotaPools),
      canonical(before.resources.quotaPools),
    );
    ctx.equal(
      "migration preserves Commitments",
      canonical(
        after.resources.commitments.map((item) =>
          Object.fromEntries(
            Object.entries(item).filter(
              ([key]) => !["organizationId", "projectId"].includes(key),
            ),
          ),
        ),
      ),
      canonical(before.resources.commitments),
    );
    ctx.equal(
      "migration preserves Admission order and legacy fields",
      canonical(
        after.resources.admissionEntries.map((item) =>
          Object.fromEntries(
            Object.entries(item).filter(
              ([key]) => !["organizationId", "projectId"].includes(key),
            ),
          ),
        ),
      ),
      canonical(before.resources.admissionEntries),
    );
    ctx.equal(
      "migration preserves Events exactly",
      canonical(after.events),
      canonical(before.events),
    );
    for (const old of before.resources.reservations) {
      const upgraded = after.resources.reservations.find(
        ({ reservationId }) => reservationId === old.reservationId,
      );
      ctx.equal(
        "migration preserves Reservation legacy identity/vector",
        v1Projection(upgraded),
        old,
        {
          failureCodeSuffix: "MIGRATION_IDENTITY",
          hardCapIds: ["MIGRATION_CORRECTNESS"],
        },
      );
      ctx.equal(
        "migrated Reservation retains Pool and gains hierarchy",
        upgraded.poolId === catalog.pool.poolId &&
          typeof upgraded.organizationId === "string" &&
          typeof upgraded.projectId === "string",
        true,
      );
    }
    ctx.equal(
      "one legacy Pool maps to one Organization/default Project",
      [
        after.resources.quotaOrganizations.length,
        after.resources.quotaProjects.length,
      ],
      [1, 1],
    );
    const org = after.resources.quotaOrganizations[0],
      project = after.resources.quotaProjects[0];
    ctx.equal(
      "default hierarchy mirrors Pool vectors",
      [
        org.capacity,
        org.held,
        org.committed,
        project.allocation,
        project.held,
        project.committed,
      ],
      [
        catalog.pool.capacity,
        before.resources.quotaPools[0].held,
        before.resources.quotaPools[0].committed,
        catalog.pool.capacity,
        before.resources.quotaPools[0].held,
        before.resources.quotaPools[0].committed,
      ],
    );
    const replay = await ctx.reservePool(
      finalApi.baseUrl,
      catalog.pool.poolId,
      replayBody,
      { key: replayKey },
    );
    ctx.equal(
      "saved V1 replay status/body unchanged",
      [replay.status, canonical(replay.json)],
      [savedReplay.status, canonical(savedReplay.json)],
      {
        failureCodeSuffix: "REPLAY_REWRITTEN",
        hardCapIds: ["MIGRATION_CORRECTNESS"],
      },
    );
    const preservedWork = workFor(after, heldResponse.json.reservationId).find(
      ({ kind }) => kind === "RESERVATION_EXPIRY",
    );
    ctx.equal(
      "pending Expiry Work identity/retry preserved",
      [preservedWork.workId, preservedWork.attempt],
      [savedWork.workId, savedWork.attempt],
    );
    await ctx.sleep(1100);
    const worker = await ctx.startWorker();
    await waitReservation(
      ctx,
      finalApi.baseUrl,
      heldResponse.json.reservationId,
      "EXPIRED",
      { processes: [worker] },
    );
    await snapshot(ctx, finalApi.baseUrl);
    return {
      evidence: [
        heldResponse.json.reservationId,
        committed.commitmentId,
        releasedResponse.json.reservationId,
        savedWork.workId,
      ],
    };
  },
);

const E02 = defineCase(
  "E-02",
  "Exact perf-v1 seed with 1,000 Quota Pools and member vectors",
  "Run 64 closed-loop GET clients round-robin by bytewise poolId for exact warm-up and measure windows",
  "Validate every complete QuotaPool against seeded members and enforce 500/s, p95 100 ms, zero inconsistencies/5xx and post-load invariants",
  async (ctx) => {
    const factor = scale(),
      contract = performanceContract(factor).read;
    await installPerf(ctx, factor);
    const api = await ctx.startApi({ healthTimeoutMs: 60000 });
    const initial = await ctx.snapshot(api.baseUrl, { timeoutMs: 120000 }),
      pools = [...initial.resources.quotaPools].sort((a, b) =>
        compareUtf8(a.poolId, b.poolId),
      ),
      byId = new Map(pools.map((item) => [item.poolId, item]));
    const exercise = async (index) => {
      const poolId = pools[index % pools.length].poolId,
        response = await ctx.getPool(api.baseUrl, poolId);
      if (response.status === 200) {
        assertPool(response.json);
        if (canonical(response.json) !== canonical(byId.get(poolId)))
          throw new Error(
            "QuotaPool read is inconsistent with authority snapshot",
          );
      }
      return { status: response.status, durationMs: response.durationMs };
    };
    await closedLoop(contract.warmupSeconds, contract.concurrency, exercise);
    const samples = await closedLoop(
        contract.measureSeconds,
        contract.concurrency,
        exercise,
      ),
      success = samples.filter(({ status }) => status === 200),
      throughput = success.length / contract.measureSeconds,
      p95 = percentile(
        success.map(({ durationMs }) => durationMs),
        0.95,
      );
    ctx.metric("throughputPerSecond", throughput);
    ctx.metric("p95Ms", p95);
    ctx.ok(
      "quota-pool-read reaches 500/s target",
      throughput >= contract.targetPerSecond,
    );
    ctx.ok("quota-pool-read meets p95 target", p95 <= contract.p95Ms);
    ctx.equal(
      "quota-pool-read unexpected 5xx",
      samples.filter(({ status }) => status >= 500).length,
      0,
    );
    const final = await ctx.snapshot(api.baseUrl, { timeoutMs: 120000 });
    ctx.assert("quota-pool-read post-load snapshot reconciles", () =>
      reconcileSnapshot(final),
    );
    return { evidence: [{ factor, throughput, p95, count: success.length }] };
  },
);

async function createRacePools(ctx, api, dimensions, prefix) {
  const spare = [],
    saturated = [];
  for (let index = 0; index < 10; index += 1) {
    const pool = requirePool(
      ctx,
      await ctx.createPool(
        api.baseUrl,
        {
          tenantId: ctx.uuid(`${prefix}-tenant:${index}`),
          name: `${prefix} ${index}`,
          capacity: vector(20000, dimensions),
        },
        { key: ctx.key(`${prefix}-pool:${index}`) },
      ),
    );
    (index < 8 ? spare : saturated).push(pool);
  }
  for (const pool of saturated)
    requireReservation(
      ctx,
      await ctx.reservePool(
        api.baseUrl,
        pool.poolId,
        {
          ownerId: ctx.uuid(`${prefix}-saturate:${pool.poolId}`),
          quantities: vector(20000, dimensions),
          ttlSeconds: 300,
        },
        { key: ctx.key(`${prefix}-saturate:${pool.poolId}`) },
      ),
    );
  return { spare, saturated };
}
function raceSchedule(pools, count) {
  return Array.from({ length: count }, (_, index) => {
    const slot = index % 10;
    return {
      pool:
        slot < 8
          ? pools.spare[index % pools.spare.length]
          : pools.saturated[index % pools.saturated.length],
      expected: slot < 8 ? 201 : 409,
    };
  });
}
const E03 = defineCase(
  "E-03",
  "Ten warm-up and ten measured five-Dimension hot Pools with exact 80/20 targets",
  "Run 64 clients over eight spare then two saturated targets with unique owners/keys for exact warm-up and measure windows",
  "Enforce 200 attempts/s, all-response p95 400 ms, every hundred exactly 80 HELD and 20 QUOTA_EXCEEDED, and post-load vector conservation",
  async (ctx) => {
    const factor = scale(),
      contract = performanceContract(factor).race,
      seed = await installPerf(ctx, factor),
      api = await ctx.startApi({ healthTimeoutMs: 60000 }),
      dimensions = seed.dimensions,
      warmPools = await createRacePools(ctx, api, dimensions, "warm"),
      measuredPools = await createRacePools(ctx, api, dimensions, "measured"),
      warmCount = Math.max(
        100,
        Math.ceil(
          (contract.targetPerSecond * contract.warmupSeconds * 1.25) / 100,
        ) * 100,
      ),
      measureCount = Math.max(
        100,
        Math.ceil(
          (contract.targetPerSecond * contract.measureSeconds * 1.25) / 100,
        ) * 100,
      );
    const exercise = async (item, index, prefix) => {
      const response = await ctx.reservePool(
        api.baseUrl,
        item.pool.poolId,
        {
          ownerId: ctx.uuid(`${prefix}-owner:${index}`),
          quantities: vector(1, dimensions),
          ttlSeconds: 300,
        },
        { key: ctx.key(`${prefix}-key:${index}`) },
      );
      return {
        expected: item.expected,
        status: response.status,
        code: response.json?.error?.code,
        durationMs: response.durationMs,
      };
    };
    await finiteLoad(
      contract.warmupSeconds,
      contract.concurrency,
      raceSchedule(warmPools, warmCount),
      (item, index) => exercise(item, index, "warm"),
    );
    const samples = await finiteLoad(
        contract.measureSeconds,
        contract.concurrency,
        raceSchedule(measuredPools, measureCount),
        (item, index) => exercise(item, index, "measure"),
      ),
      throughput = samples.length / contract.measureSeconds,
      p95 = percentile(
        samples.map(({ durationMs }) => durationMs),
        0.95,
      );
    ctx.metric("attemptsPerSecond", throughput);
    ctx.metric("p95Ms", p95);
    ctx.ok(
      "hot Pool attempts reach 200/s",
      throughput >= contract.targetPerSecond,
    );
    ctx.ok("hot Pool p95 meets 400ms", p95 <= contract.p95Ms);
    for (let offset = 0; offset + 100 <= samples.length; offset += 100) {
      const group = samples.slice(offset, offset + 100);
      ctx.equal(
        "each hundred has exact 80/20 outcomes",
        [
          group.filter(({ status }) => status === 201).length,
          group.filter(
            ({ status, code }) => status === 409 && code === "QUOTA_EXCEEDED",
          ).length,
        ],
        [80, 20],
      );
    }
    ctx.equal(
      "hot Pool unexpected 5xx",
      samples.filter(({ status }) => status >= 500).length,
      0,
    );
    const state = await ctx.snapshot(api.baseUrl, { timeoutMs: 120000 });
    ctx.assert(
      "hot Pool post-load vectors reconcile",
      () => reconcileSnapshot(state),
      { failureCodeSuffix: "PERF_VECTOR", hardCapIds: ["VECTOR_CORRECTNESS"] },
    );
    return {
      evidence: [{ factor, throughput, p95, attempts: samples.length }],
    };
  },
);

const E04 = defineCase(
  "E-04",
  "Exact perf-v1 20,000 due Reservations and 20,000 eligible Admissions",
  "Hold two workers at claimed, SIGKILL, wait for leases and time two replacements until one snapshot proves both backlogs drained",
  "Require 60 seconds, exact EXPIRED/PROMOTED counts, head-only uniqueness, no stale commit/nonterminal Work and complete vector reconciliation",
  async (ctx) => {
    const factor = scale(),
      contract = performanceContract(factor).recovery,
      seed = await installPerf(ctx, factor),
      dueIds = seed.reservations
        .filter(({ state }) => state === "HELD")
        .map(({ reservationId }) => reservationId),
      admissionIds = seed.admissionQueue.map(
        ({ admissionEntryId }) => admissionEntryId,
      ),
      dueSet = new Set(dueIds),
      admissionSet = new Set(admissionIds),
      api = await ctx.startApi({ healthTimeoutMs: 60000 });
    ctx.equal(
      "performance seed exact due/admission counts",
      [dueIds.length, admissionIds.length],
      [contract.dueCount, contract.admissionCount],
    );
    let holds = 0;
    const barrier = await ctx.workerBarrier(
        "worker.claimed",
        () => holds++ < 2,
      ),
      stale = [
        await ctx.startWorkerAtBarrier(barrier),
        await ctx.startWorkerAtBarrier(barrier),
      ];
    await ctx.waitFor(
      () =>
        barrier.ledger.length >= 2 ? barrier.ledger.slice(0, 2) : undefined,
      { timeoutMs: 60000, label: "two performance claims", processes: stale },
    );
    await Promise.all(stale.map((worker) => ctx.kill(worker)));
    await ctx.sleep(3200);
    const started = performance.now(),
      replacements = [await ctx.startWorker(), await ctx.startWorker()];
    const drained = await ctx.waitFor(
      async () => {
        const value = await ctx.snapshot(api.baseUrl, { timeoutMs: 120000 });
        const expired = value.resources.reservations.filter(
            ({ reservationId, state }) =>
              dueSet.has(reservationId) && state === "EXPIRED",
          ).length,
          promoted = value.resources.admissionEntries.filter(
            ({ admissionEntryId, state }) =>
              admissionSet.has(admissionEntryId) && state === "PROMOTED",
          ).length;
        return expired === dueIds.length &&
          promoted === admissionIds.length &&
          !value.work.some(({ terminal }) => !terminal)
          ? value
          : undefined;
      },
      {
        timeoutMs: contract.maximumSeconds * 1000,
        intervalMs: 250,
        label: "expiry and Admission recovery",
        processes: replacements,
      },
    );
    const elapsedSeconds = (performance.now() - started) / 1000;
    ctx.metric("drainSeconds", elapsedSeconds);
    ctx.ok(
      "both backlogs drain within 60 seconds",
      elapsedSeconds <= contract.maximumSeconds,
    );
    ctx.assert(
      "recovery workload vectors reconcile",
      () => reconcileSnapshot(drained),
      {
        failureCodeSuffix: "PERF_VECTOR",
        hardCapIds: ["VECTOR_CORRECTNESS", "WORK_RECOVERY_CORRECTNESS"],
      },
    );
    ctx.equal(
      "all due Reservations expire exactly once",
      drained.resources.reservations.filter(
        ({ reservationId, state }) =>
          dueSet.has(reservationId) && state === "EXPIRED",
      ).length,
      dueIds.length,
    );
    ctx.equal(
      "all Admissions promote to unique Reservations",
      new Set(
        drained.resources.admissionEntries
          .filter(({ admissionEntryId }) => admissionSet.has(admissionEntryId))
          .map(({ reservationId }) => reservationId),
      ).size,
      admissionIds.length,
    );
    return {
      evidence: [
        {
          factor,
          elapsedSeconds,
          due: dueIds.length,
          admissions: admissionIds.length,
        },
      ],
    };
  },
);
export const E_CASES = [E01, E02, E03, E04];
