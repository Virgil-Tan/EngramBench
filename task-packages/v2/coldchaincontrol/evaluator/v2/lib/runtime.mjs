import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { CaseFailure } from "./execution.mjs";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);
export function validateBarrierPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(v);
  const positive = v => Number.isSafeInteger(v) && v > 0;
  const keys = names => JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names.split(',').sort());
  if (value.role === 'worker') return (value.point === 'worker.after-attempt' ? keys('role,point,kind,workId,aggregateId,attempt,leaseToken,outcome') && ['committed', 'stale'].includes(value.outcome) : keys('role,point,kind,workId,aggregateId,attempt,leaseToken'))
    && ['worker.claimed', 'worker.before-commit', 'worker.after-attempt'].includes(value.point)
    && ['CONFIG_DELIVER', 'TELEMETRY_PROJECT', 'DEVICE_OFFLINE_CHECK', 'CUSTODY_HANDOFF_EXPIRY', 'RECALL_PROPAGATE', 'QUARANTINE_ENFORCE'].includes(value.kind)
    && uuid(value.workId) && uuid(value.aggregateId) && positive(value.attempt) && typeof value.leaseToken === 'string' && value.leaseToken.length > 0;
  return value.role === 'dispatcher' && value.point === 'dispatcher.response-received'
    && keys('role,point,notificationDeliveryId,eventId,attempt,responseStatus') && uuid(value.notificationDeliveryId) && uuid(value.eventId)
    && positive(value.attempt) && Number.isInteger(value.responseStatus) && value.responseStatus >= 100 && value.responseStatus <= 599;
}
const base = shared.createCaseRuntime({
  taskSlug: "coldchaincontrol",
  databasePrefix: "ccc",
  snapshotPath: "/api/v1/verification-snapshot",
  createFixtureFactory,
  adaptCompatibilityResponse: (_adapter, response) => response.json,
  assertCompatibilityAdapter: (adapter) => { if (adapter !== undefined && adapter !== null) throw new TypeError("ColdChainControl forbids compatibility adapters"); },
  validateBarrierPayload,
});

function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  context.pass = (fields = {}) => ({ status: "passed", ...fields, evidence: [...context.evidence, ...(fields.evidence ?? [])] });
  context.equal = (actual, expected, label, options = {}) => { try { assert.deepStrictEqual(actual, expected); } catch (cause) { shared.assertCandidateError(cause); throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); } };
  context.ok = (condition, label, options = {}) => { try { assert.ok(condition); } catch (cause) { shared.assertCandidateError(cause); throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); } };
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  return context;
}

export async function createCaseContext(options) { return attach(await base.createCaseContext(options)); }
export async function withCaseContext(options, operation) {
  const context = await createCaseContext(options); let operationError;
  try { await context.setup(); return await operation(context); }
  catch (error) { operationError = error; throw error; }
  finally { try { await context.teardown(); } catch (cleanupError) { if (operationError && cleanupError && typeof cleanupError === "object" && cleanupError.cause === undefined) cleanupError.cause = operationError; throw cleanupError; } }
}

export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
