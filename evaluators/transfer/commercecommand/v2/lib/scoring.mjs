const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const IDS = Object.freeze([
  ...Array.from({ length: 15 }, (_, index) => `A-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, index) => `B-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `C-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `D-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 14 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`),
]);
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 15, B: 10, C: 8, D: 8, E: 14 });
const CAPS = Object.freeze({ PRODUCTION_BOOT: 25, COMMERCE_CONSERVATION: 35, IDEMPOTENCY_PROVIDER_IDENTITY: 30, TRANSACTIONAL_EVIDENCE: 40, WORK_FENCING: 40, MIGRATION_COMPATIBILITY: 35 });
const SPEC_GAPS = Object.freeze([]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, keys, label) {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields are invalid`);
}

function unique(items, select, label) {
  const values = new Set();
  for (const item of items) {
    const value = select(item);
    invariant(typeof value === "string" && value.length > 0, `${label} missing`);
    invariant(!values.has(value), `duplicate ${label}: ${value}`);
    values.add(value);
  }
  return values;
}

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "commercecommand" && manifest.profile === "transfer-v2", "CommerceCommand manifest identity invalid");
  invariant(manifest.formalReady === false, "CommerceCommand remains uncertified until real isolated author validation");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "CommerceCommand acceptance invalid");
  invariant(JSON.stringify(manifest.cases?.map(({ id }) => id)) === JSON.stringify(IDS), "CommerceCommand case order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(SPEC_GAPS), "CommerceCommand gap order invalid");
  const gaps = new Set(SPEC_GAPS);
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata invalid`);
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
    const assertions = new Set();
    for (const blocked of item.blockedAssertions ?? []) {
      invariant(typeof blocked.id === "string" && !assertions.has(blocked.id), `${item.id} blocked assertion invalid`);
      assertions.add(blocked.id);
      invariant(gaps.has(blocked.blockedBy) && blocked.policy === "fail-closed-diagnostic", `${item.id} gap declaration invalid`);
    }
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} total invalid`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} count invalid`);
  }
  invariant(manifest.hardCaps?.length === Object.keys(CAPS).length, "CommerceCommand hard cap count invalid");
  for (const item of manifest.hardCaps) invariant(CAPS[item.id] === item.cap, `${item.id} hard cap invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "commercecommand" && contractMap.cases?.length === IDS.length, "contract map identity/count invalid");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant([...ids].every((id) => mapped.has(id)), "contract map coverage invalid");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(mapping.privateFailureCodePrefix === `CC_${mapping.caseId.replace("-", "_")}_`, `${mapping.caseId} failure prefix invalid`);
    invariant(/^[a-z][a-z0-9_]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category invalid`);
  }
  return true;
}

const policy = createScoringPolicy({
  validateManifest,
  excludableCases: ["E-01", "E-02", "E-03"],
  exclusionReason: "missing_v1_checkpoint",
});

export { classifyFailure };
export const { scoreEvaluation } = policy;
