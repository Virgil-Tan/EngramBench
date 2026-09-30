import { createFixtureFactory } from "./fixtures.mjs";
import { adaptCompatibilityResponse, assertCompatibilityAdapter } from "./compatibility.mjs";

const BARRIER_FIELDS = [
  "aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId",
];

function validateBarrierPayload(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(BARRIER_FIELDS)
    && value.schemaVersion === 1
    && (value.processRole === "worker" || value.processRole === "dispatcher")
    && typeof value.point === "string"
    && typeof value.workId === "string"
    && typeof value.aggregateId === "string"
    && Number.isSafeInteger(value.attempt) && value.attempt > 0
    && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash);
}

const sharedUrl = process.env.FRONTAL_V2_SHARED_RUNTIME_URL
  ?? new URL("../../../../../src/task-evaluator-v2/runtime.mjs", import.meta.url).href;
const shared = await import(sharedUrl);
const runtime = shared.createCaseRuntime({
  taskSlug: "capacitylease",
  databasePrefix: "cl",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse,
  assertCompatibilityAdapter,
  validateBarrierPayload,
});

export const { createCaseContext, withCaseContext } = runtime;
export const {
  CandidateResponseError,
  CommandError,
  EvaluationInfrastructureError,
  freePort,
  runCommand,
} = shared;
