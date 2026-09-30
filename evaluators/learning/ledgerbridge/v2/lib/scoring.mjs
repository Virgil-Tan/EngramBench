const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSION_WEIGHTS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const CASE_ID = /^[A-E]-[0-9]{2}$/u;
const FEEDBACK_CATEGORY = /^[a-z][a-z0-9-]*$/u;

function invariant(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} fields are invalid`);
}
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
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "ledgerbridge", "manifest identity mismatch");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "manifest scoring contract mismatch");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "manifest must define exactly 22 cases");
  exactKeys(manifest.dimensions, Object.keys(DIMENSION_WEIGHTS), "manifest dimensions");
  const caseIds = unique(manifest.cases, ({ id }) => id, "case id");
  invariant(manifest.evaluationScope === "final-system" && manifest.specGaps?.length === 0, "final-system cases cannot depend on spec gaps");
  const totals = Object.fromEntries(Object.keys(DIMENSION_WEIGHTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(CASE_ID.test(item.id), `${item.id} is invalid`);
    invariant(Object.hasOwn(DIMENSION_WEIGHTS, item.dimension), `${item.id} has invalid dimension`);
    invariant(Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is invalid`);
    totals[item.dimension] += item.weight;
    invariant(!item.blockedAssertions, `${item.id} must execute real business assertions`);
  }
  for (const [dimension, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `dimension ${dimension} must total ${weight}`);
  }
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 1 && manifest.hardCaps[0].id === "CORRECTNESS_INVARIANT" && manifest.hardCaps[0].cap === 30, "correctness hard cap mismatch");
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId, "contract map identity mismatch");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === 22, "contract map must define exactly 22 cases");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant(mapped.size === caseIds.size && [...caseIds].every((id) => mapped.has(id)), "contract map coverage mismatch");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(mapping.privateFailureCodePrefix === `LB_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix mismatch`);
    invariant(FEEDBACK_CATEGORY.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest });
export { classifyFailure };
export const { scoreEvaluation } = policy;
