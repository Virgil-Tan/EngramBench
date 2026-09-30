import { createFixtureFactory } from "./fixtures.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(new URL("runtime.mjs", sharedRoot));

const runtime = shared.createCaseRuntime({
  taskSlug: "billforge",
  databasePrefix: "bf",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter: (adapter) => {
    if (adapter !== undefined && adapter !== null) throw new Error("BillForge has no compatibility response adapter");
  },
  validateBarrierPayload: () => false,
});

export const { createCaseContext, withCaseContext } = runtime;
export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
