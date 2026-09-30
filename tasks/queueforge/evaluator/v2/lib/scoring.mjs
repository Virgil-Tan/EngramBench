const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const EXPECTED_WEIGHTS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const GAP_IDS = new Set(["SPEC-GAP-QF-01", "SPEC-GAP-QF-02"]);
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
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "queueforge", "QueueForge manifest identity is invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "QueueForge acceptance is invalid");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "QueueForge manifest must contain 22 cases");
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 6, "QueueForge manifest must contain six hard caps");
  invariant(JSON.stringify(Object.keys(manifest.dimensions).sort()) === JSON.stringify(Object.keys(EXPECTED_WEIGHTS)), "dimensions must be A through E");
  const ids = unique(manifest.cases, "id", "case");
  const totals = Object.fromEntries(Object.keys(EXPECTED_WEIGHTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(/^[A-E]-\d{2}$/u.test(item.id), `${item.id} is invalid`);
    invariant(Object.hasOwn(EXPECTED_WEIGHTS, item.dimension), `${item.id} has invalid dimension`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} weight is invalid`);
    invariant(Array.isArray(item.prerequisites), `${item.id} prerequisites are invalid`);
    totals[item.dimension] += item.weight;
    for (const blocked of item.blockedAssertions ?? []) {
      invariant(GAP_IDS.has(blocked.blockedBy), `${item.id} references unknown SPEC-GAP`);
      invariant(blocked.policy === "fail-closed-diagnostic", `${item.id} diagnostic policy is invalid`);
    }
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
    invariant(item.privateFailureCodePrefix === `QF_${item.caseId.replace("-", "")}_`, `${item.caseId} failure prefix is invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(item.publicFeedbackCategory), `${item.caseId} feedback category is invalid`);
    invariant(item.requirement && JSON.stringify(Object.keys(item.requirement).sort()) === JSON.stringify(["id", "source", "summary"]), `${item.caseId} requirement mapping is invalid`);
  }
  return true;
}

const { scoreEvaluation } = createScoringPolicy({ validateManifest, excludableCases: ["E-01"], exclusionReason: "missing_v1_checkpoint" });
export { classifyFailure, scoreEvaluation };
