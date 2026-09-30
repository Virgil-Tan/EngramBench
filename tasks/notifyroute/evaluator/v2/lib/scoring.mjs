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
const CAPS = Object.freeze({ CORRECTNESS_INVARIANT: 35, DURABLE_REPLAY_DUPLICATE: 30, WORK_FENCE_OR_LOSS: 40, MIGRATION_IDENTITY_REWRITE: 35 });
const BLOCKED = Object.freeze({
  "A-05": ["campaign-create-read-wire", "SPEC-GAP-NR-01"],
  "B-05": ["campaign-control-wire", "SPEC-GAP-NR-01"],
  "C-03": ["campaign-fanout-recovery-wire", "SPEC-GAP-NR-01"],
  "C-04": ["campaign-cancel-recovery-wire", "SPEC-GAP-NR-01"],
  "D-04": ["campaign-browser-wire", "SPEC-GAP-NR-01"],
  "E-02": ["notification-ingest-workload", "SPEC-GAP-NR-03"],
  "E-03": ["hot-recipient-workload", "SPEC-GAP-NR-03"],
  "E-04": ["delivery-recovery-workload", "SPEC-GAP-NR-03"],
});

function invariant(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, keys, label) { invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be object`); invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields are invalid`); }
function unique(items, select, label) { const values = new Set(); for (const item of items) { const value = select(item); invariant(typeof value === "string" && value.length > 0 && !values.has(value), `${label} is missing or duplicate`); values.add(value); } return values; }

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "notifyroute" && manifest.profile === "learning-v2" && manifest.formalReady === false, "manifest identity/readiness is invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "manifest scoring identity is invalid");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22 && JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS), "case list/order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const gaps = unique(manifest.specGaps, ({ id }) => id, "SPEC-GAP id");
  invariant(JSON.stringify([...gaps]) === JSON.stringify(["SPEC-GAP-NR-01", "SPEC-GAP-NR-02", "SPEC-GAP-NR-03"]), "SPEC-GAPs are not frozen");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((key) => [key, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((key) => [key, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is invalid`);
    totals[item.dimension] += item.weight; counts[item.dimension] += 1;
    const expected = BLOCKED[item.id];
    if (expected) {
      invariant(item.blockedAssertions?.length === 1, `${item.id} must be entirely diagnostic`);
      const blocked = item.blockedAssertions[0];
      exactKeys(blocked, ["id", "blockedBy", "policy"], `${item.id} blocked assertion`);
      invariant(blocked.id === expected[0] && blocked.blockedBy === expected[1] && blocked.policy === "fail-closed-diagnostic", `${item.id} blocked assertion is not frozen`);
    } else invariant(!item.blockedAssertions, `${item.id} must remain executable`);
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
    invariant(mapping.privateFailureCodePrefix === `NR_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix is invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest, excludableCases: ["E-01"], exclusionReason: "missing_v1_checkpoint" });
export { classifyFailure };
export const { scoreEvaluation } = policy;
