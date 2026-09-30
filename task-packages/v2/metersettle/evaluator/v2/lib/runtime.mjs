import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createFixtureFactory } from "../fixtures/index.mjs";
import { canonicalJson } from "../oracles/index.mjs";
import { CaseFailure } from "./execution.mjs";
const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(process.env.FRONTAL_V2_SHARED_RUNTIME_URL ?? new URL("runtime.mjs", sharedRoot).href);
const FIELDS = ["aggregateId", "attempt", "leaseTokenHash", "point", "processRole", "schemaVersion", "workId"];
export function validateBarrierPayload(value) { const validPoint = value?.processRole === "worker" ? ["worker.claimed", "worker.effect-complete", "worker.before-commit"].includes(value.point) : value?.processRole === "dispatcher" && value.point === "dispatcher.response-received"; return Boolean(value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(FIELDS) && value.schemaVersion === 1 && validPoint && typeof value.workId === "string" && value.workId.length > 0 && typeof value.aggregateId === "string" && value.aggregateId.length > 0 && Number.isSafeInteger(value.attempt) && value.attempt > 0 && /^[0-9a-f]{64}$/u.test(value.leaseTokenHash)); }
const base = shared.createCaseRuntime({ taskSlug: "metersettle", databasePrefix: "ms", snapshotPath: "/api/v1/verification-snapshot", createFixtureFactory, adaptCompatibilityResponse: (_adapter, response) => response.json, assertCompatibilityAdapter: (adapter) => { if (adapter !== undefined && adapter !== null) throw new TypeError("MeterSettle forbids compatibility adapters"); }, validateBarrierPayload });
function find(value, key) { if (Array.isArray(value)) { for (const item of value) { const result = find(item, key); if (result !== undefined) return result; } } else if (value && typeof value === "object") { if (Object.hasOwn(value, key)) return value[key]; for (const item of Object.values(value)) { const result = find(item, key); if (result !== undefined) return result; } } return undefined; }
function attach(context) {
  context.evidence = [];
  context.mark = (event, fields = {}) => context.evidence.push({ ordinal: context.evidence.length + 1, event, ...fields });
  context.pass = (fields = {}) => ({ status: "passed", ...fields, evidence: [...context.evidence, ...(fields.evidence ?? [])] });
  context.assert = (label, operation, options = {}) => { try { return operation(); } catch (cause) { shared.assertCandidateError(cause); throw new CaseFailure(`${label}: ${cause.message}`, { failureCodeSuffix: options.failureCodeSuffix, hardCapIds: options.hardCapIds }); } };
  context.equal = (actual, expected, label, options = {}) => context.assert(label, () => assert.deepStrictEqual(actual, expected), options);
  context.ok = (condition, label, options = {}) => context.assert(label, () => assert.ok(condition), options);
  context.canonical = canonicalJson;
  context.find = find;
  context.sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  context.loadChromium = async () => createRequire(import.meta.url)("playwright-core").chromium;
  context.openApi = (baseUrl) => context.request(baseUrl, "/openapi.json");
  context.usageBatch = (baseUrl, body, options = {}) => context.mutate(baseUrl, "/api/v1/usage-batches", options.key ?? context.key(`usage:${context.evidence.length}`), body, options);
  context.correctionBatch = (baseUrl, body, options = {}) => context.mutate(baseUrl, "/api/v1/correction-batches", options.key ?? context.key(`correction:${context.evidence.length}`), body, options);
  context.advanceWatermark = (baseUrl, tenantId, through, options = {}) => context.mutate(baseUrl, `/api/v1/tenants/${encodeURIComponent(tenantId)}/watermark`, options.key ?? context.key(`watermark:${tenantId}:${through}`), { through }, options);
  context.statements = (baseUrl, query = "") => context.request(baseUrl, `/api/v1/statements${query ? `?${new URLSearchParams(query)}` : ""}`);
  context.statement = (baseUrl, statementId) => context.request(baseUrl, `/api/v1/statements/${encodeURIComponent(statementId)}`);
  context.revision = (baseUrl, statementId, revision) => context.request(baseUrl, `/api/v1/statements/${encodeURIComponent(statementId)}/revisions/${revision}`);
  context.meterUsage = (baseUrl, meterId, query = {}) => context.request(baseUrl, `/api/v1/meters/${encodeURIComponent(meterId)}/usage?${new URLSearchParams(query)}`);
  context.watermark = (baseUrl, tenantId) => context.request(baseUrl, `/api/v1/tenants/${encodeURIComponent(tenantId)}/watermark`);
  context.domainEvents = (baseUrl, query = {}) => context.request(baseUrl, `/api/v1/domain-events?${new URLSearchParams(query)}`);
  return context;
}
export async function createCaseContext(options) { return attach(await base.createCaseContext(options)); }
export async function withCaseContext(options, operation) { const context = await createCaseContext(options); let operationError; try { await context.setup(); return await operation(context); } catch (error) { operationError = error; throw error; } finally { try { await context.teardown(); } catch (cleanupError) { if (operationError) { if (typeof operationError === "object" && operationError !== null && operationError.cleanupError === undefined) operationError.cleanupError = cleanupError; } else throw cleanupError; } } }
export const { CandidateResponseError, CommandError, EvaluationInfrastructureError, freePort, runCommand } = shared;
