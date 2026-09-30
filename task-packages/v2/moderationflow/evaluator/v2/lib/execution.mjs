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

export function validateCaseRegistry(manifest, cases) {
  shared.validateCaseRegistry(manifest, cases);
  for (const item of cases) {
    if (item.taskId !== "moderationflow") throw new Error(`${item.id} is not ModerationFlow-owned`);
    if (!/^MF-F-/u.test(item.fixtureFamily ?? "")) throw new Error(`${item.id} lacks a ModerationFlow fixture family`);
    if (typeof item.action !== "string" || item.action.length < 24) throw new Error(`${item.id} lacks a public action description`);
    if (typeof item.oracle !== "string" || item.oracle.length < 24) throw new Error(`${item.id} lacks an independent oracle description`);
    if (typeof item.run !== "function" || item.run.length < 1) throw new Error(`${item.id} must implement run(ctx)`);
  }
  return true;
}
