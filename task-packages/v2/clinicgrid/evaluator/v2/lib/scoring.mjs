const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 5, B: 5, C: 4, D: 4, E: 4 });
const IDS = [
  "SLOT-01", "SLOT-02", "SLOT-03", "SLOT-04", "SLOT-05",
  "PLAN-01", "PLAN-02", "PLAN-03", "PLAN-04", "PLAN-05",
  "RACE-01", "RACE-02", "RACE-03", "RACE-04",
  "MIGRATE-01", "MIGRATE-02", "MIGRATE-03", "MIGRATE-04",
  "LOAD-01", "LOAD-02", "LOAD-03", "LOAD-04",
];

function invariant(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(); const wanted = [...expected].sort();
  invariant(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} fields are invalid`);
}
function unique(items, select, label) {
  const values = new Set();
  for (const item of items) { const value = select(item); invariant(typeof value === "string" && value.length > 0, `${label} is missing`); invariant(!values.has(value), `duplicate ${label}: ${value}`); values.add(value); }
  return values;
}

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "clinicgrid" && manifest.profile === "learning-v2", "manifest identity is invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "manifest acceptance is invalid");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "manifest must contain 22 cases");
  invariant(JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS), "case order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const gaps = unique(manifest.specGaps, ({ id }) => id, "SPEC-GAP id");
  invariant(JSON.stringify([...gaps]) === JSON.stringify(["SPEC-GAP-CG-01", "SPEC-GAP-CG-02", "SPEC-GAP-CG-03"]), "SPEC-GAPs are not frozen");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((key) => [key, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((key) => [key, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is invalid`);
    totals[item.dimension] += item.weight; counts[item.dimension] += 1;
    for (const blocked of item.blockedAssertions ?? []) {
      exactKeys(blocked, ["id", "blockedBy", "policy"], `${item.id} blocked assertion`);
      invariant(gaps.has(blocked.blockedBy) && blocked.policy === "fail-closed-diagnostic", `${item.id} blocked assertion is invalid`);
    }
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} must total ${weight}`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} must contain ${COUNTS[dimension]} cases`);
  }
  invariant(manifest.hardCaps?.length === 1 && manifest.hardCaps[0].id === "CORRECTNESS_INVARIANT" && manifest.hardCaps[0].cap === 30, "hard cap is not frozen");
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId && contractMap.cases?.length === 22, "contract map identity/count mismatch");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant([...ids].every((id) => mapped.has(id)), "contract map does not cover every case");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(mapping.privateFailureCodePrefix === `CG_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix is invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest });
export { classifyFailure };
export const { scoreEvaluation } = policy;
