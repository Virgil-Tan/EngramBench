import { createFixtureFactory } from "./fixtures.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(new URL("runtime.mjs", sharedRoot));

const BARRIER_FIELDS = ["aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId"];
const BARRIER_POINTS = new Set(["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"]);

export function validateBarrierPayload(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(BARRIER_FIELDS)
    && value.schemaVersion === 1
    && (value.processRole === "worker" || value.processRole === "dispatcher")
    && BARRIER_POINTS.has(value.point)
    && typeof value.workId === "string" && value.workId.length > 0
    && typeof value.aggregateId === "string" && value.aggregateId.length > 0
    && Number.isSafeInteger(value.attempt) && value.attempt > 0
    && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash));
}

const runtime = shared.createCaseRuntime({
  taskSlug: "dispatchboard",
  databasePrefix: "db",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter: (adapter) => {
    if (adapter !== undefined && adapter !== null) throw new Error("DispatchBoard has no response compatibility adapter");
  },
  validateBarrierPayload,
});

export const { createCaseContext, withCaseContext } = runtime;
export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
