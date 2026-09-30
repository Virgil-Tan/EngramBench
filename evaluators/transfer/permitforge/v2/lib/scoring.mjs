const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

export const IDS = Object.freeze([
  ...Array.from({ length: 15 }, (_, index) => `A-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, index) => `B-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `C-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `D-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 7 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`),
]);
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const GAP_IDS = Object.freeze(["PF-GAP-01", "PF-GAP-02", "PF-GAP-03", "PF-GAP-04", "PF-GAP-05"]);
const CAPS = Object.freeze({ PRODUCTION_BOOT: 25, REVIEW_AUTHORITY: 35, DURABLE_IDEMPOTENCY: 30, EVENT_ATOMICITY: 40, WORK_FENCING: 40, MIGRATION_COMPATIBILITY: 35 });
const MIGRATION = new Set(["A-02", "E-01", "E-02", "E-03"]);
const PERFORMANCE = new Set(["E-04", "E-05", "E-06"]);
const CHROMIUM = new Set(["D-02", "D-03", "D-04", "D-05", "D-06", "D-08"]);

function invariant(condition, message) { if (!condition) throw new Error(message); }

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "permitforge" && manifest.profile === "transfer-v2" && manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "manifest identity");
  invariant(JSON.stringify(manifest.cases?.map(({ id }) => id)) === JSON.stringify(IDS), "case order");
  invariant(new Set(IDS).size === 48, "48 unique cases");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((key) => [key, 0]));
  const blockedIds = new Set();
  for (const item of manifest.cases) {
    invariant(item.dimension === item.id[0], `${item.id} dimension`);
    const expectedWeight = item.dimension === "A" ? 2 : item.dimension === "B" || item.dimension === "C" ? 2.5 : item.dimension === "D" ? (item.id === "D-08" ? 1 : 2) : item.id <= "E-03" ? 2 : 1;
    invariant(item.weight === expectedWeight, `${item.id} weight`);
    const prerequisites = MIGRATION.has(item.id) ? ["V1", "FINAL"] : PERFORMANCE.has(item.id) ? ["FINAL", "PERFORMANCE"] : CHROMIUM.has(item.id) ? ["FINAL", "CHROMIUM"] : ["FINAL"];
    invariant(JSON.stringify(item.prerequisites) === JSON.stringify(prerequisites), `${item.id} prerequisites`);
    invariant(typeof item.title === "string" && item.title.length > 8, `${item.id} title`);
    totals[item.dimension] += item.weight;
    for (const blocked of item.blockedAssertions ?? []) {
      invariant(blocked.policy === "fail-closed-diagnostic" && GAP_IDS.includes(blocked.blockedBy), `${item.id} blocked assertion`);
      invariant(!blockedIds.has(blocked.id), `duplicate blocked assertion ${blocked.id}`);
      blockedIds.add(blocked.id);
    }
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} total`);
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(GAP_IDS), "spec gaps");
  for (const gap of GAP_IDS) invariant(manifest.cases.some((item) => item.blockedAssertions?.some(({ blockedBy }) => blockedBy === gap)), `${gap} unrepresented`);
  const caps = new Map(manifest.hardCaps?.map(({ id, cap, publicInvariant }) => [id, { cap, publicInvariant }]));
  invariant(Object.entries(CAPS).every(([id, cap]) => caps.get(id)?.cap === cap && caps.get(id).publicInvariant.length > 24) && caps.size === Object.keys(CAPS).length, "hard caps");
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "permitforge", "contract map identity");
  invariant(JSON.stringify(contractMap.cases?.map(({ caseId }) => caseId)) === JSON.stringify(IDS), "contract map order");
  invariant(contractMap.cases.every(({ caseId, requirement, privateFailureCodePrefix, publicFeedbackCategory }) => requirement?.id === `PF.${caseId.replace("-", ".")}` && requirement.source.length > 8 && requirement.summary.length > 8 && privateFailureCodePrefix === `PF_${caseId.replace("-", "_")}_` && /^[a-z][a-z0-9_]*$/u.test(publicFeedbackCategory)), "contract map completeness");
  return true;
}

const policy = createScoringPolicy({ validateManifest, excludableCases: [...MIGRATION], exclusionReason: "missing_v1_checkpoint" });
export { classifyFailure };
export const { scoreEvaluation } = policy;
