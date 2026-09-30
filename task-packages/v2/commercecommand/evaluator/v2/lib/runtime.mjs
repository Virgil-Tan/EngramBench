import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);

// The public CommerceCommand protocol uses Bearer auth and closed, role-specific bodies.
export function validateBarrierPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const keys = body.role === 'worker'
    ? ['point', 'role', 'kind', 'workId', 'aggregateId', 'attempt', 'fencingToken']
    : ['point', 'role', 'notificationDeliveryId', 'eventId', 'aggregateId', 'attempt', 'fencingToken', 'responseStatus'];
  if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(keys.sort())) return false;
  if (!uuid(body.aggregateId) || !positive(body.attempt) || !positive(body.fencingToken)) return false;
  if (body.role === 'worker') return ['worker.claimed', 'worker.before-effect'].includes(body.point)
    && ['QUOTE_EXPIRY', 'PAYMENT_RECONCILIATION', 'FULFILLMENT', 'ENTITLEMENT_GRANT', 'ENTITLEMENT_REVOCATION', 'SELLER_SETTLEMENT_CLOSE', 'DISPUTE_RECONCILIATION', 'SETTLEMENT_ADJUSTMENT'].includes(body.kind)
    && uuid(body.workId);
  return body.role === 'dispatcher' && body.point === 'dispatcher.response-received'
    && uuid(body.notificationDeliveryId) && uuid(body.eventId)
    && Number.isInteger(body.responseStatus) && body.responseStatus >= 100 && body.responseStatus <= 599;
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
  authorizeBarrierRequest: (headers, token) => headers.authorization === `Bearer ${token}`,
});

function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  context.pass = (fields = {}) => ({ status: "passed", ...fields, evidence: [...context.evidence, ...(fields.evidence ?? [])] });
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
