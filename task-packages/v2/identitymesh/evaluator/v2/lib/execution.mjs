const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;

export const {
  CaseExcluded,
  EvaluationInfrastructureError,
  executeCase,
  validateCaseRegistry,
} = await import(new URL("execution.mjs", sharedRoot));
