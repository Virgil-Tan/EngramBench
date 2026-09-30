const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(new URL("execution.mjs", sharedRoot));

export class CaseFailure extends Error {
  constructor(message, { failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = [] } = {}) {
    super(message); this.name = "CaseFailure"; this.failureCodeSuffix = failureCodeSuffix; this.hardCapIds = hardCapIds; this.origin = "candidate";
  }
}

export const { CaseExcluded, EvaluationInfrastructureError, executeCase, candidateAssert } = shared;

export function validateCaseRegistry(manifest, implementations) {
  shared.validateCaseRegistry(manifest, implementations);
  for (const item of implementations) {
    if (item.taskId !== "coldchaincontrol") throw new Error(`${item.id} is not ColdChainControl-owned`);
    if (!/^CCC-F-/u.test(item.fixtureFamily ?? "")) throw new Error(`${item.id} lacks ColdChainControl fixture ownership`);
    if (typeof item.action !== "string" || item.action.length < 28) throw new Error(`${item.id} lacks public action detail`);
    if (typeof item.oracle !== "string" || item.oracle.length < 28) throw new Error(`${item.id} lacks independent oracle detail`);
    if (item.run.length !== 1 || item.run.constructor.name !== "AsyncFunction") throw new Error(`${item.id} must expose async run(ctx)`);
  }
  return true;
}
