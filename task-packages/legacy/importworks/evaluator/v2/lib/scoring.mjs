const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSION_WEIGHTS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const CASE_ID = /^[A-E]-[0-9]{2}$/u;
const FEEDBACK_CATEGORY = /^[a-z][a-z0-9-]*$/u;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

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
  invariant(manifest?.schemaVersion === 2, "manifest schemaVersion must be 2");
  invariant(manifest.taskId === "importworks", "manifest taskId must be importworks");
  invariant(manifest.maxScore === 100, "manifest maxScore must be 100");
  invariant(manifest.acceptance?.mode === "all_cases_pass", "manifest acceptance must be all_cases_pass");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "manifest must define exactly 22 cases");
  exactKeys(manifest.dimensions, Object.keys(DIMENSION_WEIGHTS), "manifest dimensions");
  const caseIds = unique(manifest.cases, ({ id }) => id, "case id");
  const gapIds = unique(manifest.specGaps, ({ id }) => id, "spec gap id");
  const totals = Object.fromEntries(Object.keys(DIMENSION_WEIGHTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(CASE_ID.test(item.id), `invalid case id: ${item.id}`);
    invariant(Object.hasOwn(DIMENSION_WEIGHTS, item.dimension), `${item.id} has invalid dimension`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} weight must be positive`);
    invariant(Array.isArray(item.prerequisites), `${item.id} prerequisites must be an array`);
    totals[item.dimension] += item.weight;
    for (const blocked of item.blockedAssertions ?? []) {
      exactKeys(blocked, ["id", "blockedBy", "policy"], `${item.id} blocked assertion`);
      invariant(gapIds.has(blocked.blockedBy), `${item.id} references unknown spec gap`);
      invariant(blocked.policy === "fail-closed-diagnostic", `${item.id} blocked assertion must fail closed`);
    }
  }
  for (const [dimension, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight, `dimension ${dimension} declared weight must be ${weight}`);
    invariant(totals[dimension] === weight, `dimension ${dimension} weight must total ${weight}`);
  }
  invariant(Object.values(totals).reduce((sum, value) => sum + value, 0) === 100, "total weight must be 100");
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 1, "manifest must define one correctness hard cap");
  for (const cap of manifest.hardCaps) {
    invariant(Number.isFinite(cap.cap) && cap.cap >= 0 && cap.cap <= 100, `${cap.id} hard cap is invalid`);
    invariant(typeof cap.publicInvariant === "string" && cap.publicInvariant.length > 0, `${cap.id} public invariant is missing`);
  }
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId, "contract map identity mismatch");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === 22, "contract map must define exactly 22 cases");
  const mappedIds = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant(mappedIds.size === caseIds.size && [...caseIds].every((id) => mappedIds.has(id)), "contract map must cover every case exactly once");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(mapping.privateFailureCodePrefix === `IW_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} has invalid failure prefix`);
    invariant(FEEDBACK_CATEGORY.test(mapping.publicFeedbackCategory), `${mapping.caseId} has invalid feedback category`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest });

export { classifyFailure };
export const { scoreEvaluation } = policy;
