const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const IDS = Object.freeze(["A-01", "A-02", "A-03", "A-04", "A-05", "B-01", "B-02", "B-03", "B-04", "B-05", "C-01", "C-02", "C-03", "C-04", "D-01", "D-02", "D-03", "D-04", "E-01", "E-02", "E-03", "E-04"]);
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const CAPS = Object.freeze({ DOMAIN_CORRECTNESS: 35, DURABLE_IDEMPOTENCY: 30, WORK_RECOVERY_CORRECTNESS: 40, MIGRATION_COMPATIBILITY: 35 });

function invariant(condition, message) { if (!condition) throw new Error(message); }

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "moderationflow" && manifest.profile === "learning-v2", "ModerationFlow manifest identity is invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "ModerationFlow acceptance is invalid");
  invariant(JSON.stringify(manifest.cases?.map(({ id }) => id)) === JSON.stringify(IDS), "ModerationFlow case order is not frozen");
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(["SPEC-GAP-MF-01", "SPEC-GAP-MF-02"]), "ModerationFlow SPEC-GAP registry is invalid");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  const seen = new Set();
  for (const item of manifest.cases) {
    invariant(!seen.has(item.id), `duplicate case ${item.id}`); seen.add(item.id);
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is invalid`);
    totals[item.dimension] += item.weight;
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) invariant(totals[dimension] === weight && manifest.dimensions?.[dimension]?.weight === weight, `${dimension} must total ${weight}`);
  invariant(manifest.hardCaps?.length === Object.keys(CAPS).length, "ModerationFlow hard-cap count is invalid");
  for (const cap of manifest.hardCaps) invariant(CAPS[cap.id] === cap.cap, `${cap.id} hard cap is invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "moderationflow" && contractMap.cases?.length === IDS.length, "ModerationFlow contract-map identity is invalid");
  invariant(JSON.stringify(contractMap.cases.map(({ caseId }) => caseId)) === JSON.stringify(IDS), "ModerationFlow contract-map order is invalid");
  for (const mapping of contractMap.cases) {
    invariant(mapping.privateFailureCodePrefix === `MF_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix is invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} public feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest });
export { classifyFailure };
export const { scoreEvaluation } = policy;
