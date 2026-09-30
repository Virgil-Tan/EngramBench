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

export const { CaseExcluded, EvaluationInfrastructureError, executeCase } = shared;

export function validateCaseRegistry(manifest, implementations) {
  shared.validateCaseRegistry(manifest, implementations);
  for (const item of implementations) {
    if (item.taskId !== "geopulse") throw new Error(`${item.id} is not owned by GeoPulse`);
    if (typeof item.fixtureFamily !== "string" || !item.fixtureFamily.startsWith("GP-F-")) throw new Error(`${item.id} lacks a GeoPulse fixture family`);
    if (typeof item.action !== "string" || item.action.length < 24) throw new Error(`${item.id} lacks a substantive public action`);
    if (typeof item.oracle !== "string" || item.oracle.length < 24) throw new Error(`${item.id} lacks a substantive independent oracle`);
  }
  return true;
}
