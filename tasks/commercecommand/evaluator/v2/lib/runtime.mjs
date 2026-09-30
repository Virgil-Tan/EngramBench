import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);

// CC-GAP-04: no barrier wire is public. Reject every guessed payload.
export function validateBarrierPayload() {
  return false;
}

const base = shared.createCaseRuntime({
  taskSlug: "commercecommand",
  databasePrefix: "cc",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter: (adapter) => {
    if (adapter !== undefined && adapter !== null) throw new TypeError("CommerceCommand forbids compatibility adapters");
  },
  validateBarrierPayload,
});

function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  context.pass = (fields = {}) => ({ status: "passed", ...fields, evidence: [...context.evidence, ...(fields.evidence ?? [])] });
  context.assert = (label, operation, options = {}) => {
    try {
      return operation();
    } catch (cause) {
      throw new CaseFailure(`${label}: ${cause.message}`, {
        failureCodeSuffix: options.failureCodeSuffix,
        hardCapIds: options.hardCapIds,
      });
    }
  };
  context.equal = (actual, expected, label, options = {}) => context.assert(label, () => assert.deepStrictEqual(actual, expected), options);
  context.ok = (condition, label, options = {}) => context.assert(label, () => assert.ok(condition), options);
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  context.openApi = (baseUrl) => context.request(baseUrl, "/openapi.json");
  return context;
}

export async function createCaseContext(options) {
  return attach(await base.createCaseContext(options));
}

export async function withCaseContext(options, operation) {
  const context = await createCaseContext(options);
  let operationError;
  try {
    await context.setup();
    return await operation(context);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await context.teardown();
    } catch (cleanupError) {
      if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError;
      throw cleanupError;
    }
  }
}

export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
