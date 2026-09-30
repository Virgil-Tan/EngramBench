const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 5, B: 5, C: 4, D: 4, E: 4 });
const CASE_ID = /^[A-E]-[0-9]{2}$/u;
const CATEGORY = /^[a-z][a-z0-9-]*$/u;
const AUTHORITIES = /^(workspace\/README\.md|orchestration\/manager-prompt\.zh-CN\.md|CONTEXT\.md)#/u;

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
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "geopulse", "manifest identity must be GeoPulse v2");
  invariant(manifest.profile === "learning-v2" && manifest.maxScore === 100, "manifest profile and score are invalid");
  invariant(manifest.acceptance?.mode === "all_cases_pass", "manifest must require all cases");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "manifest dimensions");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "manifest must define exactly 22 cases");
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const gaps = unique(manifest.specGaps, ({ id }) => id, "spec gap id");
  invariant(JSON.stringify([...gaps]) === JSON.stringify(["GP-GAP-01", "GP-GAP-02", "GP-GAP-03"]), "manifest SPEC-GAPs are not frozen");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(CASE_ID.test(item.id) && item.id.startsWith(`${item.dimension}-`), `${item.id} has an invalid id/dimension`);
    invariant(typeof item.title === "string" && item.title.length > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is incomplete`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} has invalid weight`);
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
    for (const blocked of item.blockedAssertions ?? []) {
      exactKeys(blocked, ["id", "blockedBy", "policy"], `${item.id} blocked assertion`);
      invariant(gaps.has(blocked.blockedBy), `${item.id} references an unknown SPEC-GAP`);
      invariant(blocked.policy === "fail-closed-diagnostic", `${item.id} blocked assertion must fail closed`);
    }
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} must total ${weight}`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} must contain ${COUNTS[dimension]} cases`);
  }
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 1, "GeoPulse defines one task-specific correctness cap");
  invariant(manifest.hardCaps[0].id === "CORRECTNESS_INVARIANT" && manifest.hardCaps[0].cap === 30, "GeoPulse correctness cap is not frozen");

  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId, "contract map identity mismatch");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === 22, "contract map must define 22 mappings");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant(mapped.size === ids.size && [...ids].every((id) => mapped.has(id)), "contract map must cover all cases exactly once");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(AUTHORITIES.test(mapping.requirement.source), `${mapping.caseId} uses a non-authoritative source`);
    invariant(mapping.privateFailureCodePrefix === `GP_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix is invalid`);
    invariant(CATEGORY.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({
  validateManifest,
  excludableCases: ["E-01"],
  exclusionReason: "missing_v1_checkpoint",
});

export { classifyFailure };
export const { scoreEvaluation } = policy;
