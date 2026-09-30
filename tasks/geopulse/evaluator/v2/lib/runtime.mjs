import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);

const base = shared.createCaseRuntime({
  taskSlug: "geopulse",
  databasePrefix: "gp",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, { json }) => json,
  assertCompatibilityAdapter: (adapter) => {
    if (adapter !== undefined && adapter !== null) throw new TypeError("GeoPulse v2 does not permit a compatibility response adapter");
  },
  validateBarrierPayload: () => false,
});

function candidateFailure(label, cause, options = {}) {
  const failure = new CaseFailure(`${label}: ${cause.message ?? String(cause)}`, {
    failureCodeSuffix: options.failureCodeSuffix ?? "ASSERTION_FAILED",
    hardCapIds: options.hardCapIds ?? [],
  });
  failure.cause = cause;
  throw failure;
}

function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  context.pass = (details = {}) => ({ ...details, status: "passed", evidence: [...context.evidence, ...(details.evidence ?? [])] });
  context.diagnostic = (assertionId, blockedBy) => ({ assertionId, blockedBy });
  context.fail = (message, failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = []) => {
    throw new CaseFailure(message, { failureCodeSuffix, hardCapIds });
  };
  context.equal = (actual, expected, label = "values are equal", options = {}) => {
    try { assert.deepStrictEqual(actual, expected); }
    catch (error) { candidateFailure(label, error, options); }
  };
  context.ok = (condition, label = "condition is truthy", options = {}) => {
    try { assert.ok(condition); }
    catch (error) { candidateFailure(label, error, options); }
  };
  context.readText = (path, options = {}) => readFile(resolve(options.workspace ?? context.workspace, path), "utf8");
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  context.rssBytes = async (record) => {
    try {
      const status = await readFile(`/proc/${record.pid}/status`, "utf8");
      return Number(/^VmRSS:\s+(\d+)\s+kB$/mu.exec(status)?.[1] ?? 0) * 1024;
    } catch { return 0; }
  };
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
    try { await context.teardown(); }
    catch (cleanupError) {
      if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError;
      throw cleanupError;
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
