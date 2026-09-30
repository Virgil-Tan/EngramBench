const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
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

export const {
  CaseExcluded,
  EvaluationInfrastructureError,
  executeCase,
} = shared;

export function validateCaseRegistry(manifest, implementations) {
  shared.validateCaseRegistry(manifest, implementations);
  for (const item of implementations) {
    if (typeof item.fixtureFamily !== "string" || typeof item.action !== "string" || typeof item.oracle !== "string") {
      throw new Error(`${item.id} lacks ParcelFlow fixture/action/oracle metadata`);
    }
  }
  return true;
}
