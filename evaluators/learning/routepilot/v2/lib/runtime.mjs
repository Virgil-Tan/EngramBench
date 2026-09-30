import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);
const base = shared.createCaseRuntime({
  taskSlug: "routepilot",
  databasePrefix: "rp",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, { json }) => json,
  assertCompatibilityAdapter: (adapter) => { if (adapter !== undefined && adapter !== null) throw new TypeError("RoutePilot v2 forbids compatibility adapters"); },
  validateBarrierPayload: (value) => value && typeof value === "object"
    && ["worker.claimed", "dispatcher.response-received"].includes(value.point)
    && typeof value.aggregateId === "string",
});

function attach(ctx) {
  ctx.evidence = [];
  ctx.mark = (event, fields = {}) => ctx.evidence.push({ ordinal: ctx.evidence.length + 1, event, ...fields });
  ctx.pass = (details = {}) => ({ ...details, status: "passed", evidence: [...ctx.evidence, ...(details.evidence ?? [])] });
  ctx.diagnostic = (assertionId, blockedBy) => ({ assertionId, blockedBy });
  ctx.fail = (message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) => { throw new CaseFailure(message, { failureCodeSuffix, hardCapIds }); };
  ctx.equal = (actual, expected, label = "values equal", options = {}) => { try { assert.deepStrictEqual(actual, expected); } catch (cause) { shared.assertCandidateError(cause); throw new CaseFailure(`${label}: ${cause.message}`, options); } };
  ctx.ok = (condition, label = "condition truthy", options = {}) => { try { assert.ok(condition); } catch (cause) { shared.assertCandidateError(cause); throw new CaseFailure(`${label}: ${cause.message}`, options); } };
  ctx.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  return ctx;
}

export async function createCaseContext(options) { return attach(await base.createCaseContext(options)); }
export async function withCaseContext(options, operation) {
  const ctx = await createCaseContext(options);
  let operationError;
  try { await ctx.setup(); return await operation(ctx); }
  catch (error) { operationError = error; throw error; }
  finally {
    try { await ctx.teardown(); }
    catch (cleanupError) { if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError; throw cleanupError; }
  }
}
export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
