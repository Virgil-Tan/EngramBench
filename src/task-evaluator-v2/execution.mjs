import { createHash } from "node:crypto";
import assert from 'node:assert/strict';

// Shared evaluator behavior; task packages provide only case definitions and policy.

export const PRIOR_CASE_STATE_ENV = "FRONTAL_V2_PRIOR_CASE_STATE";
export const PRIVATE_CASE_STATE_ENV = "FRONTAL_V2_PRIVATE_CASE_STATE";
export const MISSING_V1_CHECKPOINT_REASON = "missing_v1_checkpoint";

const CASE_ID = /^[A-Z][A-Z0-9]*-[0-9]{2}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CASE_STATUSES = new Set(["passed", "failed", "excluded", "diagnostic", "evaluator_error"]);
const V1_CHECKPOINT_PREREQUISITES = new Set(["V1", "V1_CHECKPOINT", "frozen_v1_checkpoint"]);
const PRIVATE_CASE_STATE_MAX_BYTES = 256 * 1024;
const PRIOR_CASE_STATE_MAX_BYTES = 8 * 1024 * 1024;

export class CaseExcluded extends Error {
  constructor(reason) {
    super(reason);
    this.name = "CaseExcluded";
    this.reason = reason;
  }
}

export class EvaluationInfrastructureError extends Error {
  constructor(code, options) {
    const normalized = String(code).startsWith("EVALUATOR_")
      ? String(code)
      : `EVALUATOR_${String(code).toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`;
    super(normalized, options);
    this.name = "EvaluationInfrastructureError";
    this.code = normalized;
    this.origin = "infrastructure";
  }
}

// Assertions are an explicit candidate boundary; arbitrary author exceptions are not.
export function assertCandidateError(error) {
  const causes = errorChain(error);
  if (causes.some(({ error: item }) => ['evaluator', 'infrastructure'].includes(item?.origin))
    || (error?.origin !== 'candidate' && error?.code !== 'ERR_ASSERTION')) throw error;
}

// Opt-in at business checks only. Fixture/setup assertions keep node:assert.
function candidateAssertion(operation, args) {
  const classify = error => {
    assertCandidateError(error);
    if (error.actual instanceof Error) assertCandidateError(error.actual);
    error.origin = 'candidate';
    throw error;
  };
  try {
    const value = operation(...args);
    return value?.then ? value.catch(classify) : value;
  } catch (error) { return classify(error); }
}
export const candidateAssert = Object.assign(
  (...args) => candidateAssertion(assert, args),
  Object.fromEntries(['ok', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual', 'deepStrictEqual', 'notDeepStrictEqual',
    'strictEqual', 'notStrictEqual', 'fail', 'match', 'doesNotMatch', 'throws', 'doesNotThrow', 'rejects', 'doesNotReject', 'ifError']
    .map(name => [name, (...args) => candidateAssertion(assert[name], args)])),
);

/** True only when a frozen manifest explicitly requires an unavailable intermediate V1 binary. */
export function requiresV1Checkpoint(definition) {
  return Array.isArray(definition?.prerequisites)
    && definition.prerequisites.some((item) => V1_CHECKPOINT_PREREQUISITES.has(item));
}

/** Build the sole legal synthetic outcome for a V1-only Case in the single-route Task Package protocol. */
export function createMissingV1CheckpointOutcome(definition) {
  if (!CASE_ID.test(definition?.id ?? "") || !requiresV1Checkpoint(definition)) {
    throw new TypeError("missing-V1 outcome requires a manifest Case with an explicit V1 checkpoint prerequisite");
  }
  return {
    id: definition.id,
    dimension: definition.dimension,
    weight: definition.weight,
    status: "excluded",
    reason: MISSING_V1_CHECKPOINT_REASON,
    durationMs: 0,
    evidenceDigest: digest({
      caseId: definition.id,
      reason: MISSING_V1_CHECKPOINT_REASON,
      protocol: "task-package-v1-single-route",
    }),
  };
}

/** Validate that an exclusion is exactly the bounded single-route V1 outcome for its manifest Case. */
export function isMissingV1CheckpointOutcome(definition, outcome) {
  if (!requiresV1Checkpoint(definition)
    || outcome?.status !== "excluded"
    || (outcome.reason ?? outcome.exclusionReason) !== MISSING_V1_CHECKPOINT_REASON) return false;
  const expected = createMissingV1CheckpointOutcome(definition);
  return outcome.id === expected.id && outcome.evidenceDigest === expected.evidenceDigest;
}

/** Build the bounded, evaluator-private state passed between isolated Case containers. */
export function createPriorCaseState(taskId, records) {
  requiredTaskId(taskId);
  if (!Array.isArray(records)) throw new TypeError("prior Case records must be an array");
  const seen = new Set();
  const cases = records.map((record) => {
    const outcome = normalizePriorOutcome(record?.outcome);
    if (seen.has(outcome.id)) throw new TypeError(`duplicate prior Case ${outcome.id}`);
    seen.add(outcome.id);
    const evidence = record?.evidence == null ? null : jsonObject(record.evidence, `${outcome.id} private evidence`);
    if (evidence !== null) assertJsonBound(evidence, PRIVATE_CASE_STATE_MAX_BYTES, `${outcome.id} private evidence`);
    return { outcome, evidence };
  });
  const state = { kind: "frontal-v2-prior-case-state", schemaVersion: 1, taskId, cases };
  assertJsonBound(state, PRIOR_CASE_STATE_MAX_BYTES, "prior Case state");
  return state;
}

/** Parse an evaluator-private prior-state file without exposing it through the public result. */
export function parsePriorCaseState(serialized, expectedTaskId) {
  const state = parseBoundedJson(serialized, PRIOR_CASE_STATE_MAX_BYTES, "prior Case state");
  exactKeys(state, ["kind", "schemaVersion", "taskId", "cases"], "prior Case state");
  if (state.kind !== "frontal-v2-prior-case-state" || state.schemaVersion !== 1 || state.taskId !== expectedTaskId) {
    throw new TypeError("prior Case state identity is invalid");
  }
  if (!Array.isArray(state.cases)) throw new TypeError("prior Case state cases must be an array");
  for (const record of state.cases) {
    exactKeys(record, ["outcome", "evidence"], "prior Case record");
    exactKeys(record.outcome, [
      "id", "status", "evidenceDigest",
      ...(Object.hasOwn(record.outcome, "reason") ? ["reason"] : []),
      ...(Object.hasOwn(record.outcome, "diagnostics") ? ["diagnostics"] : []),
    ], "prior Case outcome");
  }
  return createPriorCaseState(state.taskId, state.cases);
}

/** Build one bounded task-private evidence record for the parent evaluator. */
export function createPrivateCaseState(taskId, caseId, evidence) {
  requiredTaskId(taskId);
  if (!CASE_ID.test(caseId ?? "")) throw new TypeError("private Case state caseId is invalid");
  const state = {
    kind: "frontal-v2-private-case-state",
    schemaVersion: 1,
    taskId,
    caseId,
    evidence: jsonObject(evidence, `${caseId} private evidence`),
  };
  assertJsonBound(state, PRIVATE_CASE_STATE_MAX_BYTES, `${caseId} private Case state`);
  return state;
}

/** Parse one task-private evidence record emitted by an isolated Case container. */
export function parsePrivateCaseState(serialized, expectedTaskId, expectedCaseId) {
  const state = parseBoundedJson(serialized, PRIVATE_CASE_STATE_MAX_BYTES, `${expectedCaseId} private Case state`);
  exactKeys(state, ["kind", "schemaVersion", "taskId", "caseId", "evidence"], `${expectedCaseId} private Case state`);
  if (state.kind !== "frontal-v2-private-case-state" || state.schemaVersion !== 1
    || state.taskId !== expectedTaskId || state.caseId !== expectedCaseId) {
    throw new TypeError(`${expectedCaseId} private Case state identity is invalid`);
  }
  return createPrivateCaseState(state.taskId, state.caseId, state.evidence);
}

export function validateCaseRegistry(manifest, implementations) {
  const manifestIds = manifest.cases.map(({ id }) => id).sort();
  const implementationIds = implementations.map(({ id }) => id).sort();
  if (new Set(implementationIds).size !== implementationIds.length) {
    throw new Error("case registry contains a duplicate case id");
  }
  if (JSON.stringify(manifestIds) !== JSON.stringify(implementationIds)) {
    throw new Error("case registry must implement exactly the manifest cases");
  }
  for (const item of implementations) {
    if (typeof item.run !== "function") throw new Error(`${item.id} has no run function`);
  }
}

export async function executeCase({
  definition,
  implementation,
  withContext,
  contextOptions,
  failureCodePrefix,
}) {
  const startedAt = performance.now();
  try {
    const details = await withContext({ ...contextOptions, caseId: definition.id }, (ctx) => implementation.run(ctx));
    const diagnostics = normalizeDiagnostics(details?.diagnostics ?? details?.blockedAssertions ?? []);
    const status = diagnostics.length > 0 ? "diagnostic" : details?.status ?? "passed";
    return {
      id: definition.id,
      dimension: definition.dimension,
      weight: definition.weight,
      status,
      durationMs: elapsed(startedAt),
      evidenceDigest: digest(details?.evidence ?? []),
      ...(status === "failed" && details?.hardCapIds?.length ? { hardCapIds: [...details.hardCapIds] } : {}),
      ...(status === "excluded" ? { reason: details.reason } : {}),
      ...(status === "diagnostic" ? { diagnostics } : {}),
    };
  } catch (error) {
    const errors = errorChain(error);
    const privateErrorDetails = errors.map(({ error: item, relation }) => ({
      relation, name: item.name ?? 'Error', message: String(item.message ?? item),
      ...(item.origin && { origin: item.origin }),
      ...(item.code && { code: item.code }),
      ...(item.details && { details: item.details }),
      ...(item.stage && { stage: item.stage }),
      ...(item.command && { command: item.command }),
      ...(item.result && { commandResult: {
        exitCode: item.result.exitCode, signal: item.result.signal, cleanupComplete: item.result.cleanupComplete,
        stdout: item.result.stdout, stderr: item.result.stderr,
        timedOut: item.result.timedOut, spawnError: item.result.spawnError,
        leakedProcessGroup: item.result.leakedProcessGroup, durationMs: item.result.durationMs,
      } }),
    }));
    const evaluatorFailure = errors.find(({ error: item }) => item instanceof EvaluationInfrastructureError || ['evaluator', 'infrastructure'].includes(item.origin))?.error;
    if (error instanceof CaseExcluded && !evaluatorFailure) {
      if (error.reason === MISSING_V1_CHECKPOINT_REASON && requiresV1Checkpoint(definition)) {
        return {
          ...createMissingV1CheckpointOutcome(definition),
          durationMs: elapsed(startedAt),
        };
      }
      return {
        id: definition.id,
        dimension: definition.dimension,
        weight: definition.weight,
        status: "excluded",
        reason: error.reason,
        durationMs: elapsed(startedAt),
        evidenceDigest: digest({ exclusionReason: error.reason }),
      };
    }
    if (evaluatorFailure) {
      const rawCode = evaluatorFailure.code ?? "EVALUATOR_INFRASTRUCTURE_FAILURE";
      const code = String(rawCode).startsWith("EVALUATOR_")
        ? String(rawCode)
        : `EVALUATOR_${String(rawCode).toUpperCase().replace(/[^A-Z0-9]+/gu, "_")}`;
      return {
        id: definition.id,
        dimension: definition.dimension,
        weight: definition.weight,
        status: "evaluator_error",
        evaluatorErrorCode: code,
        privateMessage: String(evaluatorFailure.message),
        privateErrorDetails,
        ...(Object.hasOwn(error, 'operationResult') && { privateOperationResult: {
          status: error.operationResult?.status ?? 'passed',
          evidenceDigest: digest(error.operationResult?.evidence ?? []),
        } }),
        durationMs: elapsed(startedAt),
        evidenceDigest: digest({ code }),
      };
    }
    if (error?.origin !== 'candidate') {
      return {
        id: definition.id, dimension: definition.dimension, weight: definition.weight,
        status: 'evaluator_error', evaluatorErrorCode: 'EVALUATOR_UNATTRIBUTED_FAILURE',
        privateMessage: String(error?.message ?? error), privateErrorDetails,
        durationMs: elapsed(startedAt),
        evidenceDigest: digest({ origin: 'unattributed', message: String(error?.message ?? error) }),
      };
    }
    const suffix = error?.failureCodeSuffix ?? "ASSERTION_FAILED";
    return {
      id: definition.id,
      dimension: definition.dimension,
      weight: definition.weight,
      status: "failed",
      privateFailureCode: `${failureCodePrefix}${suffix}`,
      durationMs: elapsed(startedAt),
      evidenceDigest: digest({ name: error?.name ?? "Error", message: error?.message ?? String(error) }),
      privateMessage: String(error?.message ?? error).slice(0, 4_000),
      privateErrorDetails,
      ...(error?.hardCapIds?.length ? { hardCapIds: [...error.hardCapIds] } : {}),
    };
  }
}

// Cleanup is a separate failure branch: never lose it behind a business error.
function errorChain(error) {
  const pending = [{ error, relation: 'operation' }], entries = [], seen = new Set();
  while (pending.length) {
    const entry = pending.shift(), item = entry.error;
    if (item == null || seen.has(item)) continue;
    seen.add(item); entries.push(entry);
    if (item.cause) pending.push({ error: item.cause, relation: `${entry.relation}.cause` });
    if (item.cleanupError) pending.push({ error: item.cleanupError, relation: 'cleanup' });
    if (item instanceof AggregateError) for (const cause of item.errors) pending.push({ error: cause, relation: `${entry.relation}.resource` });
  }
  return entries;
}

function normalizeDiagnostics(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    assertionId: item.assertionId,
    status: "blocked",
    blockedBy: item.blockedBy,
    policy: "fail-closed-diagnostic",
  }));
}

function normalizePriorOutcome(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("prior Case outcome must be an object");
  if (!CASE_ID.test(value.id ?? "") || !CASE_STATUSES.has(value.status) || !SHA256.test(value.evidenceDigest ?? "")) {
    throw new TypeError("prior Case outcome identity/status/evidenceDigest is invalid");
  }
  return {
    id: value.id,
    status: value.status,
    evidenceDigest: value.evidenceDigest,
    ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 1_000) } : {}),
    ...(Array.isArray(value.diagnostics) ? { diagnostics: jsonValue(value.diagnostics, `${value.id} diagnostics`) } : {}),
  };
}

function requiredTaskId(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) throw new TypeError("private Case state taskId is invalid");
}

function jsonObject(value, label) {
  const normalized = jsonValue(value, label);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) throw new TypeError(`${label} must be an object`);
  return normalized;
}

function jsonValue(value, label) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not JSON serializable");
    return JSON.parse(serialized);
  } catch (error) {
    throw new TypeError(`${label} must be JSON serializable`, { cause: error });
  }
}

function parseBoundedJson(serialized, maximum, label) {
  if (typeof serialized !== "string" && !Buffer.isBuffer(serialized)) throw new TypeError(`${label} must be serialized JSON`);
  if (Buffer.byteLength(serialized) > maximum) throw new TypeError(`${label} exceeds ${maximum} bytes`);
  try { return JSON.parse(String(serialized)); }
  catch (error) { throw new TypeError(`${label} is invalid JSON`, { cause: error }); }
}

function assertJsonBound(value, maximum, label) {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw new TypeError(`${label} exceeds ${maximum} bytes`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unsupported fields`);
  }
}

function digest(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function elapsed(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
