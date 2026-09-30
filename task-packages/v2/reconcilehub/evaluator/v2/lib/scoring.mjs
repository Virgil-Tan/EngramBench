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
const CAPS = Object.freeze({ CONSERVATION_OR_ATOMICITY: 35, DURABLE_IDEMPOTENCY: 30, STALE_WORK_OR_LOST_WORK: 40, MIGRATION_COMPATIBILITY: 35 });

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
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "reconcilehub" && manifest.profile === "learning-v2", "manifest identity is invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "manifest acceptance is invalid");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "manifest must contain 22 cases");
  invariant(JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS), "case order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const gaps = unique(manifest.specGaps, ({ id }) => id, "SPEC-GAP id");
  invariant(JSON.stringify([...gaps]) === JSON.stringify(["SPEC-GAP-RH-01", "SPEC-GAP-RH-02"]), "SPEC-GAPs are not frozen");
  invariant(manifest.cases.every(({ blockedAssertions = [] }) => blockedAssertions.length === 0), "ReconcileHub has no blocked scoring Case");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((key) => [key, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((key) => [key, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is invalid`);
    totals[item.dimension] += item.weight; counts[item.dimension] += 1;
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} must total ${weight}`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} must contain ${COUNTS[dimension]} cases`);
  }
  invariant(manifest.hardCaps?.length === 4, "four hard caps must be frozen");
  for (const cap of manifest.hardCaps) invariant(CAPS[cap.id] === cap.cap, `hard cap ${cap.id} is invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId && contractMap.cases?.length === 22, "contract map identity/count mismatch");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant([...ids].every((id) => mapped.has(id)), "contract map does not cover every case");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(mapping.privateFailureCodePrefix === `RH_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix is invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest });
export { classifyFailure };
export const { scoreEvaluation } = policy;
