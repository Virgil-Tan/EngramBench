const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSION_WEIGHTS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const EXCLUDABLE_CASES = Object.freeze(["E-01", "E-02", "E-03"]);
const CASE_ID = /^[A-E]-[0-9]{2}$/u;
const FEEDBACK_CATEGORY = /^[a-z][a-z0-9-]*$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  invariant(
    actual.length === wanted.length && actual.every((key, index) => key === wanted[index]),
    `${label} fields are invalid`,
  );
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

/** CapacityLease-owned manifest and requirement-map contract. */
export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2, "manifest schemaVersion must be 2");
  invariant(manifest.taskId === "capacitylease", "manifest taskId must be capacitylease");
  invariant(manifest.maxScore === 100, "manifest maxScore must be 100");
  invariant(manifest.acceptance?.mode === "all_cases_pass", "manifest acceptance must be all_cases_pass");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 49, "manifest must define exactly 49 cases");
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 7, "manifest must define exactly 7 hard caps");
  exactKeys(manifest.dimensions, Object.keys(DIMENSION_WEIGHTS), "manifest dimensions");

  const totals = Object.fromEntries(Object.keys(DIMENSION_WEIGHTS).map((id) => [id, 0]));
  const caseIds = unique(manifest.cases, ({ id }) => id, "case id");
  for (const item of manifest.cases) {
    invariant(CASE_ID.test(item.id), `invalid case id: ${item.id}`);
    invariant(Object.hasOwn(DIMENSION_WEIGHTS, item.dimension), `${item.id} has invalid dimension`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} weight must be positive`);
    invariant(Array.isArray(item.prerequisites), `${item.id} prerequisites must be an array`);
    totals[item.dimension] += item.weight;
  }
  for (const [id, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    invariant(manifest.dimensions[id]?.weight === weight, `dimension ${id} declared weight must be ${weight}`);
    invariant(Math.abs(totals[id] - weight) < 1e-9, `dimension ${id} weight must total ${weight}`);
  }
  invariant(Math.abs(Object.values(totals).reduce((sum, value) => sum + value, 0) - 100) < 1e-9, "total weight must be 100");

  unique(manifest.hardCaps, ({ id }) => id, "hard cap id");
  for (const cap of manifest.hardCaps) {
    invariant(Number.isFinite(cap.cap) && cap.cap >= 0 && cap.cap <= 100, `${cap.id} hard cap is invalid`);
    invariant(typeof cap.publicInvariant === "string" && cap.publicInvariant.length > 0, `${cap.id} public invariant is missing`);
  }

  invariant(contractMap?.schemaVersion === 2, "contract map schemaVersion must be 2");
  invariant(contractMap.taskId === manifest.taskId, "contract map taskId must match manifest");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === 49, "contract map must define exactly 49 cases");
  const mappedIds = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant(mappedIds.size === caseIds.size && [...caseIds].every((id) => mappedIds.has(id)), "contract map must cover every case exactly once");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    for (const [key, value] of Object.entries(mapping.requirement)) {
      invariant(typeof value === "string" && value.length > 0, `${mapping.caseId} requirement ${key} is missing`);
    }
    const expectedPrefix = `CL_${mapping.caseId.replace("-", "")}_`;
    invariant(mapping.privateFailureCodePrefix === expectedPrefix, `${mapping.caseId} private failure prefix must be ${expectedPrefix}`);
    invariant(FEEDBACK_CATEGORY.test(mapping.publicFeedbackCategory), `${mapping.caseId} public feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({
  validateManifest,
  excludableCases: EXCLUDABLE_CASES,
  exclusionReason: "missing_v1_checkpoint",
});

export { classifyFailure };
export const { scoreEvaluation } = policy;
