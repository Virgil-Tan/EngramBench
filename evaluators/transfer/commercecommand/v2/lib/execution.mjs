const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(new URL("execution.mjs", sharedRoot));

export class CaseFailure extends Error {
  constructor(message, { failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = [] } = {}) {
    super(message);
    this.name = "CaseFailure";
    this.failureCodeSuffix = failureCodeSuffix;
    this.hardCapIds = hardCapIds;
    this.origin = "candidate";
  }
}

export const { CaseExcluded, EvaluationInfrastructureError, executeCase } = shared;

// Historical evaluation runtimes predate the shared opt-in assertion helper.
// Keep the same boundary here without reclassifying arbitrary author errors.
function candidateAssertion(operation, args) {
  try {
    return operation(...args);
  } catch (error) {
    shared.assertCandidateError(error);
    if (error.actual instanceof Error) shared.assertCandidateError(error.actual);
    error.origin = 'candidate';
    throw error;
  }
}
export const candidateAssert = shared.candidateAssert ?? Object.fromEntries(
  ['ok', 'equal', 'deepEqual', 'match'].map(name => [name, (...args) => candidateAssertion(assert[name], args)]),
);

export function validateCaseRegistry(manifest, implementations) {
  shared.validateCaseRegistry(manifest, implementations);
  for (const item of implementations) {
    if (item.taskId !== "commercecommand") throw new Error(`${item.id} is not CommerceCommand-owned`);
    if (!/^CC-F-/u.test(item.fixtureFamily ?? "")) throw new Error(`${item.id} lacks CommerceCommand fixture ownership`);
    if (typeof item.action !== "string" || item.action.length < 24) throw new Error(`${item.id} lacks a public action`);
    if (typeof item.oracle !== "string" || item.oracle.length < 24) throw new Error(`${item.id} lacks an independent oracle`);
    if (item.run.constructor.name !== "AsyncFunction" || item.run.length !== 1) throw new Error(`${item.id} must expose async run(ctx)`);
  }
  return true;
}
import assert from 'node:assert/strict';
