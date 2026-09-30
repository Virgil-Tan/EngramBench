import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);
const BARRIER_FIELDS = ["aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId"];
const BARRIER_POINTS = new Set(["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"]);

export function validateBarrierPayload(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(BARRIER_FIELDS)
    && value.schemaVersion === 1
    && ["worker", "dispatcher"].includes(value.processRole)
    && BARRIER_POINTS.has(value.point)
    && typeof value.workId === "string" && value.workId.length > 0
    && typeof value.aggregateId === "string" && value.aggregateId.length > 0
    && Number.isSafeInteger(value.attempt) && value.attempt > 0
    && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash));
}

const base = shared.createCaseRuntime({
  taskSlug: "mergeboard",
  databasePrefix: "mb",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter: (adapter) => {
    if (adapter !== undefined && adapter !== null) throw new TypeError("MergeBoard forbids response compatibility adapters");
  },
  validateBarrierPayload,
});

function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  context.pass = (fields = {}) => ({ status: "passed", ...fields, evidence: [...context.evidence, ...(fields.evidence ?? [])] });
  context.equal = (actual, expected, label, options = {}) => {
    try { assert.deepStrictEqual(actual, expected); }
    catch (cause) { throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); }
  };
  context.ok = (condition, label, options = {}) => {
    try { assert.ok(condition); }
    catch (cause) { throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); }
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
