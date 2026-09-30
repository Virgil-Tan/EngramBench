import {
  isMissingV1CheckpointOutcome,
  MISSING_V1_CHECKPOINT_REASON,
} from "./execution.mjs";

// Shared weighted-case scoring; each task supplies its own manifest validation policy.
const CASE_STATUSES = new Set(["passed", "failed", "excluded", "diagnostic", "evaluator_error"]);

const roundScore = (value) => Math.round((value + Number.EPSILON) * 1e9) / 1e9;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function uniqueBy(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item?.[key];
    invariant(typeof value === "string" && value.length > 0, `${label} requires ${key}`);
    invariant(!seen.has(value), `duplicate ${label} ${key}: ${value}`);
    seen.add(value);
  }
  return seen;
}

export function createScoringPolicy({ validateManifest, excludableCases = [], exclusionReason = "excluded" }) {
  if (typeof validateManifest !== "function") throw new TypeError("validateManifest must be a function");
  const policy = {
    validateManifest,
    excludableCases: new Set(excludableCases),
    exclusionReason,
  };
  return Object.freeze({
    scoreEvaluation: (manifest, contractMap, evaluation) => scoreEvaluation(policy, manifest, contractMap, evaluation),
  });
}

export function classifyFailure(failure) {
  if (failure?.kind === "invalid_sample" || failure?.origin === "submission-integrity") return "invalid";
  if (failure?.origin === "evaluator" || failure?.origin === "infrastructure") return "evaluator_error";
  if (failure?.origin === "candidate") return "failed";
  throw new Error(`unknown failure origin: ${failure?.origin ?? "missing"}`);
}

function scoreEvaluation(policy, manifest, contractMap, evaluation) {
  policy.validateManifest(manifest, contractMap);
  invariant(Array.isArray(evaluation?.cases), "evaluation cases must be an array");

  const manifestById = new Map(manifest.cases.map((item) => [item.id, item]));
  const mappingById = new Map(contractMap.cases.map((item) => [item.caseId, item]));
  const hardCapById = new Map(manifest.hardCaps.map((item) => [item.id, item]));
  const resultIds = uniqueBy(evaluation.cases, "id", "case result");
  invariant(
    resultIds.size === manifestById.size && [...manifestById.keys()].every((id) => resultIds.has(id)),
    "results must cover every manifest case exactly once",
  );

  const dimensions = Object.fromEntries(Object.keys(manifest.dimensions).map((id) => [id, 0]));
  const triggeredCaps = new Map();
  const normalizedCases = [];
  let blockedWeight = 0;
  let excludedWeight = 0;
  let candidateFailureCount = 0;
  let evaluatorErrorCount = 0;
  let diagnosticCaseCount = 0;
  let excludedCaseCount = 0;

  for (const result of evaluation.cases) {
    const item = manifestById.get(result.id);
    invariant(item, `unknown case result ${result.id}`);
    invariant(CASE_STATUSES.has(result.status), `${result.id} has invalid status ${result.status}`);
    const mapping = mappingById.get(result.id);
    const hardCapIds = result.hardCapIds ?? [];
    invariant(Array.isArray(hardCapIds), `${result.id} hardCapIds must be an array`);
    invariant(
      result.status === "failed" || hardCapIds.length === 0,
      `${result.id} can trigger hard caps only when failed`,
    );

    if (result.status === "passed") {
      dimensions[item.dimension] = roundScore(dimensions[item.dimension] + item.weight);
    } else if (result.status === "failed") {
      candidateFailureCount += 1;
      invariant(
        typeof result.privateFailureCode === "string" &&
          result.privateFailureCode.startsWith(mapping.privateFailureCodePrefix),
        `${result.id} private failure code must start with ${mapping.privateFailureCodePrefix}`,
      );
      for (const id of hardCapIds) {
        invariant(hardCapById.has(id), `${result.id} references unknown hard cap ${id}`);
        if (!triggeredCaps.has(id)) triggeredCaps.set(id, new Set());
        triggeredCaps.get(id).add(result.id);
      }
    } else if (result.status === "excluded") {
      const reason = result.reason ?? result.exclusionReason;
      const missingV1 = reason === MISSING_V1_CHECKPOINT_REASON;
      if (missingV1) {
        invariant(
          isMissingV1CheckpointOutcome(item, result),
          `${result.id} missing_v1_checkpoint exclusion must match its explicit manifest prerequisite and stable evidence`,
        );
        excludedCaseCount += 1;
        excludedWeight = roundScore(excludedWeight + item.weight);
      } else {
        invariant(policy.excludableCases.has(result.id), `${result.id} cannot be excluded`);
        invariant(reason === policy.exclusionReason, `${result.id} exclusion reason must be ${policy.exclusionReason}`);
        blockedWeight = roundScore(blockedWeight + item.weight);
      }
    } else if (result.status === "diagnostic") {
      validateDiagnostics(item, result);
      diagnosticCaseCount += 1;
      blockedWeight = roundScore(blockedWeight + item.weight);
    } else {
      evaluatorErrorCount += 1;
      invariant(
        typeof result.evaluatorErrorCode === "string" && result.evaluatorErrorCode.startsWith("EVALUATOR_"),
        `${result.id} evaluator_error requires an EVALUATOR_ code`,
      );
    }

    normalizedCases.push({
      ...result,
      dimension: item.dimension,
      weight: item.weight,
      publicFeedbackCategory: mapping.publicFeedbackCategory,
    });
  }

  const rawScore = roundScore(Object.values(dimensions).reduce((sum, value) => sum + value, 0));
  const hardCapsApplied = manifest.hardCaps
    .filter(({ id }) => triggeredCaps.has(id))
    .map(({ id, cap, publicInvariant }) => ({
      id,
      cap,
      publicInvariant,
      triggeredBy: [...triggeredCaps.get(id)].sort(),
    }));
  const score = hardCapsApplied.reduce((value, cap) => Math.min(value, cap.cap), rawScore);
  const invalid = typeof evaluation.invalidReason === "string" && evaluation.invalidReason.length > 0;
  const evaluatorFailed = evaluatorErrorCount > 0 || evaluation.evaluatorError != null;
  const formalEligible = blockedWeight === 0 && !invalid && !evaluatorFailed;
  const everyApplicableCasePassed = normalizedCases.every((result) => result.status === "passed"
    || (result.status === "excluded" && isMissingV1CheckpointOutcome(manifestById.get(result.id), result)));
  const verdict = invalid
    ? "invalid"
    : evaluatorFailed
      ? "evaluator_error"
      : diagnosticCaseCount > 0
        ? "diagnostic"
        : formalEligible && everyApplicableCasePassed
          ? "accepted"
          : "rejected";
  const reportableScore = invalid || evaluatorFailed ? null : roundScore(score);

  return {
    schemaVersion: 2,
    taskId: manifest.taskId,
    score: reportableScore,
    rawScore,
    maxScore: manifest.maxScore,
    maxAchievable: roundScore(manifest.maxScore - blockedWeight - excludedWeight),
    blockedWeight,
    excludedWeight,
    verdict,
    evaluationMode: formalEligible ? "formal" : "diagnostic",
    formalEligible,
    dimensions,
    hardCapsApplied,
    candidateFailureCount,
    evaluatorErrorCount,
    diagnosticCaseCount,
    excludedCaseCount,
    invalidReason: invalid ? evaluation.invalidReason : null,
    cases: normalizedCases,
  };
}

function validateDiagnostics(definition, result) {
  invariant(Array.isArray(result.diagnostics) && result.diagnostics.length > 0, `${result.id} diagnostic result has no blocked assertions`);
  const allowed = new Map((definition.blockedAssertions ?? []).map((item) => [item.id, item]));
  for (const diagnostic of result.diagnostics) {
    const declaration = allowed.get(diagnostic?.assertionId);
    invariant(
      diagnostic?.status === "blocked"
        && diagnostic.policy === "fail-closed-diagnostic"
        && declaration?.blockedBy === diagnostic.blockedBy
        && declaration.policy === "fail-closed-diagnostic",
      `${result.id} contains an undeclared blocked assertion`,
    );
  }
}
