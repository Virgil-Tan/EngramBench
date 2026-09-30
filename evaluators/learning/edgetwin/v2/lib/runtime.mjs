import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);

const base = shared.createCaseRuntime({
  taskSlug: "edgetwin",
  databasePrefix: "et",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, { json }) => json,
  assertCompatibilityAdapter: (adapter) => { if (adapter !== undefined && adapter !== null) throw new TypeError("EdgeTwin v2 forbids compatibility response adapters"); },
  validateBarrierPayload: (value) => value && typeof value === "object"
    && ["worker.claimed", "dispatcher.response-received", "poll.before-delivery"].includes(value.point),
});

function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  context.pass = (details = {}) => ({ ...details, status: "passed", evidence: [...context.evidence, ...(details.evidence ?? [])] });
  context.diagnostic = (assertionId, blockedBy) => ({ assertionId, blockedBy });
  context.fail = (message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) => { throw new CaseFailure(message, { failureCodeSuffix, hardCapIds }); };
  context.equal = (actual, expected, label = "values are equal", options = {}) => {
    try { assert.deepStrictEqual(actual, expected); }
    catch (cause) { shared.assertCandidateError(cause); throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); }
  };
  context.ok = (condition, label = "condition is truthy", options = {}) => {
    try { assert.ok(condition); }
    catch (cause) { shared.assertCandidateError(cause); throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); }
  };
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  return context;
}

export async function createCaseContext(options) { return attach(await base.createCaseContext(options)); }

export async function withCaseContext(options, operation) {
  const context = await createCaseContext(options);
  let operationError;
  try { await context.setup(); return await operation(context); }
  catch (error) { operationError = error; throw error; }
  finally {
    try { await context.teardown(); }
    catch (cleanupError) {
      if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError;
      throw cleanupError;
    }
  }
}

export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
