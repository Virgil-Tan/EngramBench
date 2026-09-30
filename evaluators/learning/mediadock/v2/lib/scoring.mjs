const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSION_WEIGHTS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const CASE_ID = /^[A-E]-[0-9]{2}$/u;

function invariant(condition, message) { if (!condition) throw new Error(message); }

function unique(items, select, label) {
  const values = new Set();
  for (const item of items) {
    const value = select(item);
    invariant(typeof value === "string" && value.length > 0, `${label} is missing`);
    invariant(!values.has(value), `duplicate ${label}: ${value}`);
    values.add(value);
  }
  return values;
}

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "mediadock", "MediaDock manifest identity mismatch");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "MediaDock scoring contract mismatch");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "MediaDock must own exactly 22 cases");
  const caseIds = unique(manifest.cases, ({ id }) => id, "case id");
  invariant(manifest.policyRevision === "learning-final-system-2026-09-08.1" && manifest.evaluationScope === "final-system", "final-system scope revision");
  invariant(Array.isArray(manifest.specGaps) && manifest.specGaps.length === 0, "final-system assertions cannot be placeholder gaps");
  const totals = Object.fromEntries(Object.keys(DIMENSION_WEIGHTS).map((dimension) => [dimension, 0]));
  for (const item of manifest.cases) {
    invariant(CASE_ID.test(item.id), `invalid case id ${item.id}`);
    invariant(Object.hasOwn(DIMENSION_WEIGHTS, item.dimension), `${item.id} has invalid dimension`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} has invalid weight`);
    totals[item.dimension] += item.weight;
    invariant(!(item.blockedAssertions?.length), `${item.id} must have executable final-system assertions`);
    invariant(!item.prerequisites.some(value => ["V1", "V1_CHECKPOINT"].includes(value)), `${item.id} cannot require historical execution`);
  }
  for (const [dimension, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    invariant(manifest.dimensions?.[dimension]?.weight === weight, `${dimension} declared weight mismatch`);
    invariant(totals[dimension] === weight, `${dimension} case weights must total ${weight}`);
  }
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "mediadock", "contract map identity mismatch");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === 22, "contract map must own 22 cases");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant(mapped.size === caseIds.size && [...caseIds].every((id) => mapped.has(id)), "contract map must cover all cases exactly once");
  for (const mapping of contractMap.cases) {
    invariant(mapping.privateFailureCodePrefix === `MD_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix mismatch`);
    invariant(typeof mapping.requirement?.source === "string" && typeof mapping.requirement?.summary === "string", `${mapping.caseId} requirement incomplete`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest });

export { classifyFailure };
export const { scoreEvaluation } = policy;
