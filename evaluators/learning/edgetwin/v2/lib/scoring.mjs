const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const IDS = [
  "CONTRACT-01", "CONTRACT-02", "CONTRACT-03", "CONTRACT-04", "CONTRACT-05",
  "DATA-01", "DATA-02", "DATA-03", "DATA-04", "DATA-05",
  "RECOVERY-01", "RECOVERY-02", "RECOVERY-03", "RECOVERY-04",
  "LAYER-01", "LAYER-02", "LAYER-03", "LAYER-04",
  "OPERATE-01", "OPERATE-02", "OPERATE-03", "OPERATE-04",
];
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 5, B: 5, C: 4, D: 4, E: 4 });
const CAPS = Object.freeze({
  VERSION_REGRESSION: 35,
  EXPIRED_DELIVERY: 35,
  RECEIPT_DUPLICATE_EFFECT: 35,
  FALSE_FIRMWARE_SUCCESS: 35,
  WAVE_AUTHORITY_OR_ROLLBACK_DRIFT: 35,
  DURABLE_IDEMPOTENCY: 30,
  STALE_WORK_COMMIT: 40,
  MIGRATION_IDENTITY_REWRITE: 35,
});

function invariant(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, keys, label) { invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be object`); invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields are invalid`); }
function unique(items, select, label) { const values = new Set(); for (const item of items) { const value = select(item); invariant(typeof value === "string" && value.length > 0 && !values.has(value), `${label} is missing or duplicate`); values.add(value); } return values; }

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "edgetwin" && manifest.profile === "learning-v2" && manifest.formalReady === false, "manifest identity/readiness is invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "manifest scoring identity is invalid");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22 && JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS), "case list/order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const gaps = unique(manifest.specGaps, ({ id }) => id, "SPEC-GAP id");
  invariant(JSON.stringify([...gaps]) === JSON.stringify(["SPEC-GAP-ET-01", "SPEC-GAP-ET-02", "SPEC-GAP-ET-03", "SPEC-GAP-ET-04"]), "SPEC-GAPs are not frozen");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((key) => [key, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((key) => [key, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is invalid`);
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
    invariant(!item.blockedAssertions?.length, `${item.id} must execute fully`);
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension].weight === weight && totals[dimension] === weight, `${dimension} total is invalid`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} count is invalid`);
  }
  invariant(manifest.hardCaps?.length === Object.keys(CAPS).length, "hard cap count is invalid");
  for (const cap of manifest.hardCaps) invariant(CAPS[cap.id] === cap.cap, `${cap.id} hard cap is invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId && contractMap.cases?.length === 22, "contract map identity/count is invalid");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant([...ids].every((id) => mapped.has(id)), "contract map coverage is incomplete");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(mapping.privateFailureCodePrefix === `ET_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix is invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest });
export { classifyFailure };
export const { scoreEvaluation } = policy;
