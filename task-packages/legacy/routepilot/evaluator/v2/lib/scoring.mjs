const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

export const IDS = [
  "A-01", "A-02", "A-03", "A-04", "A-05",
  "B-01", "B-02", "B-03", "B-04", "B-05",
  "C-01", "C-02", "C-03", "C-04",
  "D-01", "D-02", "D-03", "D-04",
  "E-01", "E-02", "E-03", "E-04",
];
const DIMENSIONS = { A: 30, B: 25, C: 20, D: 15, E: 10 };
const COUNTS = { A: 5, B: 5, C: 4, D: 4, E: 4 };
const CAPS = { ROUTE_AUTHORITY: 35, RELEASE_ATOMICITY: 35, RATE_CIRCUIT_CONSERVATION: 35, IDEMPOTENCY_CORRECTNESS: 30, STALE_WORK_OR_LOST_WORK: 40, MIGRATION_COMPATIBILITY: 35 };
const BLOCKED = {
  "A-05": ["RP-A05-AUTO-ADVANCE", "SPEC-GAP-RP-01"],
  "C-03": ["RP-C03-READINESS", "SPEC-GAP-RP-01"],
  "D-03": ["RP-D03-AUTO-ADVANCE", "SPEC-GAP-RP-01"],
};

function invariant(value, message) { if (!value) throw new Error(message); }
function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    invariant(typeof item?.[key] === "string" && item[key] && !seen.has(item[key]), `${label} missing or duplicate`);
    seen.add(item[key]);
  }
  return seen;
}

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "routepilot" && manifest.profile === "learning-v2" && manifest.formalReady === false, "manifest identity invalid");
  invariant(manifest.maxScore === 100 && manifest.cases?.length === 22, "manifest score/count invalid");
  invariant(JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS), "case order invalid");
  unique(manifest.cases, "id", "case");
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(["SPEC-GAP-RP-01", "SPEC-GAP-RP-02"]), "spec gap list invalid");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((key) => [key, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((key) => [key, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0, `${item.id} metadata invalid`);
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
    const blocked = BLOCKED[item.id];
    if (!blocked) invariant(item.blockedAssertions === undefined, `${item.id} must execute fully`);
    else invariant(item.blockedAssertions?.length === 1 && item.blockedAssertions[0].id === blocked[0] && item.blockedAssertions[0].blockedBy === blocked[1] && item.blockedAssertions[0].policy === "fail-closed-diagnostic", `${item.id} blocked assertion invalid`);
  }
  for (const dimension of Object.keys(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension].weight === DIMENSIONS[dimension] && totals[dimension] === DIMENSIONS[dimension], `${dimension} weight invalid`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} count invalid`);
  }
  invariant(manifest.hardCaps?.length === Object.keys(CAPS).length, "hard cap count invalid");
  for (const cap of manifest.hardCaps) invariant(CAPS[cap.id] === cap.cap, `${cap.id} hard cap invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "routepilot" && contractMap.cases?.length === 22, "contract map identity invalid");
  unique(contractMap.cases, "caseId", "contract mapping");
  invariant(JSON.stringify(contractMap.cases.map(({ caseId }) => caseId)) === JSON.stringify(IDS), "contract map order invalid");
  for (const mapping of contractMap.cases) {
    invariant(mapping.privateFailureCodePrefix === `RP_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix invalid`);
    invariant(Object.keys(mapping.requirement).sort().join(",") === "id,source,summary", `${mapping.caseId} requirement shape invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest, excludableCases: ["E-01"], exclusionReason: "missing_v1_checkpoint" });
export { classifyFailure };
export const { scoreEvaluation } = policy;
