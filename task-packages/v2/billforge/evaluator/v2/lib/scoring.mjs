const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const EXPECTED_WEIGHTS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
function invariant(condition, message) { if (!condition) throw new Error(message); }
function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item?.[key];
    invariant(typeof value === "string" && value.length > 0, `${label} requires ${key}`);
    invariant(!seen.has(value), `duplicate ${label} ${value}`);
    seen.add(value);
  }
  return seen;
}

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "billforge", "BillForge manifest identity is invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "BillForge acceptance is invalid");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "BillForge manifest must contain 22 cases");
  invariant(Array.isArray(manifest.specGaps) && manifest.specGaps.length === 0, "final-system manifest cannot contain diagnostic gaps");
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 6, "BillForge manifest must contain six hard caps");
  invariant(manifest.evaluationScope === "final-system", "BillForge must target the final system");
  const ids = unique(manifest.cases, "id", "case");
  const totals = Object.fromEntries(Object.keys(EXPECTED_WEIGHTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(/^(?:BILL|PAY|RACE|ADJUST|COMPAT)-\d{2}$/u.test(item.id), `${item.id} is invalid`);
    invariant(Object.hasOwn(EXPECTED_WEIGHTS, item.dimension), `${item.id} has invalid dimension`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} weight is invalid`);
    invariant(Array.isArray(item.prerequisites), `${item.id} prerequisites are invalid`);
    totals[item.dimension] += item.weight;
    invariant(!item.blockedAssertions, `${item.id} must execute real business assertions`);
    invariant(item.prerequisites.every(value => !["V1", "V1_CHECKPOINT", "PERF"].includes(value)), `${item.id} uses only final-system prerequisites`);
  }
  for (const [id, expected] of Object.entries(EXPECTED_WEIGHTS)) {
    invariant(manifest.dimensions[id]?.weight === expected, `${id} declared weight must be ${expected}`);
    invariant(Math.abs(totals[id] - expected) < 1e-9, `${id} case weight must total ${expected}`);
  }
  unique(manifest.hardCaps, "id", "hard cap");
  for (const item of manifest.hardCaps) invariant(Number.isFinite(item.cap) && item.cap >= 0 && item.cap <= 100, `${item.id} has invalid cap`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId, "contract map identity is invalid");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === ids.size, "contract map must cover 22 cases");
  const mapped = unique(contractMap.cases, "caseId", "contract mapping");
  for (const id of ids) invariant(mapped.has(id), `contract map is missing ${id}`);
  for (const item of contractMap.cases) {
    invariant(item.privateFailureCodePrefix === `BF_${item.caseId.replace("-", "")}_`, `${item.caseId} failure prefix is invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(item.publicFeedbackCategory), `${item.caseId} feedback category is invalid`);
    invariant(item.requirement && JSON.stringify(Object.keys(item.requirement).sort()) === JSON.stringify(["id", "source", "summary"]), `${item.caseId} requirement mapping is invalid`);
  }
  return true;
}

const { scoreEvaluation } = createScoringPolicy({ validateManifest, excludableCases: [] });
export { classifyFailure, scoreEvaluation };
