import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";
const sharedRoot =
  process.env.FRONTAL_V2_SHARED_ROOT_URL ??
  new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(
  process.env.FRONTAL_V2_SHARED_RUNTIME_URL ??
    new URL("runtime.mjs", sharedRoot).href
);
const base = shared.createCaseRuntime({
  taskSlug: "firmwarefleet",
  databasePrefix: "ff",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, { json }) => json,
  assertCompatibilityAdapter: (adapter) => {
    if (adapter !== undefined && adapter !== null)
      throw new TypeError("FirmwareFleet v2 forbids compatibility adapters");
  },
  validateBarrierPayload: (value) =>
    value?.schemaVersion === 1 &&
    ["worker", "dispatcher"].includes(value.processRole) &&
    [
      "worker.claimed",
      "worker.effect-complete",
      "worker.before-commit",
      "dispatcher.response-received",
    ].includes(value.point) &&
    typeof value.workId === "string" &&
    typeof value.aggregateId === "string" &&
    Number.isSafeInteger(value.attempt) &&
    value.attempt > 0 &&
    /^[a-f0-9]{64}$/u.test(value.leaseTokenHash),
});
function attach(ctx) {
  ctx.evidence = [];
  ctx.mark = (event, fields = {}) =>
    ctx.evidence.push({ ordinal: ctx.evidence.length + 1, event, ...fields });
  ctx.pass = (details = {}) => ({
    ...details,
    status: "passed",
    evidence: [...ctx.evidence, ...(details.evidence ?? [])],
  });
  ctx.diagnostic = (assertionId, blockedBy) => ({ assertionId, blockedBy });
  ctx.fail = (
    message,
    failureCodeSuffix = "ASSERTION_FAILED",
    hardCapIds = [],
  ) => {
    throw new CaseFailure(message, { failureCodeSuffix, hardCapIds });
  };
  ctx.equal = (actual, expected, label = "values equal", options = {}) => {
    try {
      assert.deepStrictEqual(actual, expected);
    } catch (cause) {
      shared.assertCandidateError(cause);
      throw new CaseFailure(`${label}: ${cause.message}`, {
        failureCodeSuffix: options.failureCodeSuffix,
        hardCapIds: options.hardCapIds,
      });
    }
  };
  ctx.ok = (condition, label = "condition truthy", options = {}) => {
    try {
      assert.ok(condition);
    } catch (cause) {
      shared.assertCandidateError(cause);
      throw new CaseFailure(`${label}: ${cause.message}`, {
        failureCodeSuffix: options.failureCodeSuffix,
        hardCapIds: options.hardCapIds,
      });
    }
  };
  ctx.loadChromium = async () =>
    createRequire(import.meta.url)("playwright-core").chromium;
  return ctx;
}
export async function createCaseContext(options) {
  return attach(await base.createCaseContext(options));
}
export async function withCaseContext(options, operation) {
  const ctx = await createCaseContext(options);
  let error;
  try {
    await ctx.setup();
    return await operation(ctx);
  } catch (cause) {
    error = cause;
    throw cause;
  } finally {
    try {
      await ctx.teardown();
    } catch (cleanup) {
      if (
        error &&
        cleanup &&
        typeof cleanup === "object" &&
        cleanup.cause === undefined
      )
        cleanup.cause = error;
      throw cleanup;
    }
  }
}
export const {
  CandidateResponseError,
  CommandError,
  EvaluationInfrastructureError,
  freePort,
  runCommand,
} = shared;
