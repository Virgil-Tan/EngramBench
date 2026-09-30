const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const IDS = [
  "A-01", "A-02", "A-03", "A-04", "A-05",
  "B-01", "B-02", "B-03", "B-04", "B-05",
  "C-01", "C-02", "C-03", "C-04",
  "D-01", "D-02", "D-03", "D-04",
  "E-01", "E-02", "E-03", "E-04",
];
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 5, B: 5, C: 4, D: 4, E: 4 });
const CAPS = Object.freeze({ DOCUMENT_ATOMICITY: 30, CLIENT_IDENTITY: 30, MERGE_ATOMICITY: 30, SNAPSHOT_INTEGRITY: 30, MIGRATION_COMPATIBILITY: 35 });
function invariant(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, keys, label) { invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields are invalid`); }
function unique(items, selector, label) { const values = new Set(); for (const item of items) { const value = selector(item); invariant(typeof value === "string" && value.length > 0, `${label} is missing`); invariant(!values.has(value), `duplicate ${label}: ${value}`); values.add(value); } return values; }

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "mergeboard" && manifest.profile === "learning-v2", "MergeBoard manifest identity is invalid");
  invariant(manifest.designVersion === "hidden-test-v2" && manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "MergeBoard acceptance is invalid");
  invariant(Array.isArray(manifest.cases) && JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS), "MergeBoard case order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  invariant(manifest.evaluationScope === "final-system" && manifest.specGaps?.length === 0, "final-system cases cannot depend on spec gaps");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is invalid`);
    totals[item.dimension] += item.weight; counts[item.dimension] += 1;
    invariant(!item.blockedAssertions, `${item.id} must execute real business assertions`);
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} must total ${weight}`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} must contain ${COUNTS[dimension]} cases`);
  }
  invariant(manifest.hardCaps?.length === 5, "MergeBoard must freeze five hard caps");
  for (const item of manifest.hardCaps) invariant(CAPS[item.id] === item.cap, `${item.id} hard cap is invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "mergeboard" && contractMap.cases?.length === 22, "contract map identity/count is invalid");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant([...ids].every((id) => mapped.has(id)), "contract map does not cover every case");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(mapping.privateFailureCodePrefix === `MB_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix is invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest, excludableCases: [] });
export { classifyFailure };
export const { scoreEvaluation } = policy;
