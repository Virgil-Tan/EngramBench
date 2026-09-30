import assert from "node:assert/strict";
import { createRequire } from "node:module";

import { createFixtureFactory } from "../fixtures/index.mjs";
import { canonicalJson } from "../oracles/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot =
  process.env.FRONTAL_V2_SHARED_ROOT_URL ??
  new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(
  process.env.FRONTAL_V2_SHARED_RUNTIME_URL ??
    new URL("runtime.mjs", sharedRoot).href
);
const BARRIER_FIELDS = Object.freeze([
  "aggregateId",
  "attempt",
  "kind",
  "leaseToken",
  "point",
  "workId",
]);

export function validateBarrierPayload(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify(BARRIER_FIELDS) &&
      // The public contract requires external-response hooks without enumerating
      // point names. Case selectors still match their exact required points.
      typeof value.point === "string" &&
      value.point.length > 0 &&
      typeof value.kind === "string" &&
      value.kind.length > 0 &&
      typeof value.workId === "string" &&
      value.workId.length > 0 &&
      typeof value.aggregateId === "string" &&
      value.aggregateId.length > 0 &&
      Number.isSafeInteger(value.attempt) &&
      value.attempt > 0 &&
      typeof value.leaseToken === "string" &&
      value.leaseToken.length >= 16,
  );
}

const base = shared.createCaseRuntime({
  taskSlug: "creatorrightsexchange",
  databasePrefix: "cre",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter: (adapter) => {
    if (adapter !== undefined && adapter !== null)
      throw new TypeError(
        "CreatorRightsExchange forbids compatibility adapters",
      );
  },
  validateBarrierPayload,
  authorizeBarrierRequest: (headers, token) => {
    const bearer = headers.authorization, legacy = headers["x-test-barrier-token"];
    return (bearer !== undefined || legacy !== undefined)
      && (bearer === undefined || bearer === `Bearer ${token}`)
      && (legacy === undefined || legacy === token);
  },
});

function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) =>
    context.evidence.push({
      ordinal: context.evidence.length + 1,
      event,
      ...fields,
    });
  context.pass = (fields = {}) => ({
    status: "passed",
    ...fields,
    evidence: [...context.evidence, ...(fields.evidence ?? [])],
  });
  context.assert = (label, operation, options = {}) => {
    try {
      return operation();
    } catch (cause) {
      shared.assertCandidateError(cause);
      throw new CaseFailure(`${label}: ${cause.message}`, {
        failureCodeSuffix: options.failureCodeSuffix,
        hardCapIds: options.hardCapIds,
      });
    }
  };
  context.equal = (actual, expected, label, options = {}) =>
    context.assert(
      label,
      () => assert.deepStrictEqual(actual, expected),
      options,
    );
  context.ok = (condition, label, options = {}) =>
    context.assert(label, () => assert.ok(condition), options);
  context.canonical = canonicalJson;
  context.sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
  context.openApi = (baseUrl) => context.request(baseUrl, "/openapi.json");
  context.loadChromium = async () =>
    createRequire(import.meta.url)("playwright-core").chromium;
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
      if (
        operationError &&
        cleanupError &&
        typeof cleanupError === "object" &&
        cleanupError.cause === undefined
      )
        cleanupError.cause = operationError;
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
