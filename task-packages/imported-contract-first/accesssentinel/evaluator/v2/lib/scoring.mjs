const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const IDS = Object.freeze([
  ...Array.from({ length: 16 }, (_, index) => `A-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, index) => `B-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `C-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `D-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 11 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`),
]);
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 16, B: 10, C: 8, D: 8, E: 11 });
const CAPS = Object.freeze({ PRODUCTION_BOOT: 25, AUTHORITY_CORRECTNESS: 35, IDEMPOTENCY_CORRECTNESS: 30, TRANSACTIONAL_EVIDENCE: 40, WORK_FENCING: 40, REVOCATION_FAIL_CLOSED: 35, MIGRATION_COMPATIBILITY: 35 });
const SPEC_GAPS = Object.freeze(["AS-GAP-01", "AS-GAP-02", "AS-GAP-03", "AS-GAP-04", "AS-GAP-05"]);
const BLOCKED_ASSERTIONS = Object.freeze({
  "A-12": [["AS-A12-REVIEW-BODY", "AS-GAP-01", "fail-closed-diagnostic"]],
  "A-14": [["AS-A14-EVENT-TYPE-PAYLOAD", "AS-GAP-03", "fail-closed-diagnostic"]],
  "A-15": [["AS-A15-FINAL-SNAPSHOT-KEYS", "AS-GAP-04", "fail-closed-diagnostic"]],
  "A-16": [["AS-A16-FINAL-SNAPSHOT-KEYS", "AS-GAP-04", "fail-closed-diagnostic"]],
  "D-01": [["AS-D01-V1-REVIEW-SUCCESS", "AS-GAP-01", "fail-closed-diagnostic"]],
  "D-03": [["AS-D03-REVIEW-MUTATION", "AS-GAP-01", "fail-closed-diagnostic"]],
  "D-05": [["AS-D05-FINAL-SNAPSHOT-KEYS", "AS-GAP-04", "fail-closed-diagnostic"]],
  "D-08": [["AS-D08-FINAL-SNAPSHOT-KEYS", "AS-GAP-04", "fail-closed-diagnostic"]],
});

function invariant(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, keys, label) { invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields are invalid`); }
function unique(items, select, label) { const result = new Set(); for (const item of items) { const value = select(item); invariant(typeof value === "string" && value.length > 0, `${label} missing`); invariant(!result.has(value), `duplicate ${label}: ${value}`); result.add(value); } return result; }

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "accesssentinel" && manifest.profile === "transfer-v2", "AccessSentinel manifest identity invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "AccessSentinel acceptance invalid");
  invariant(JSON.stringify(manifest.cases?.map(({ id }) => id)) === JSON.stringify(IDS), "AccessSentinel case order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(SPEC_GAPS), "AccessSentinel gap registry invalid");
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites), `${item.id} metadata invalid`);
    const actual = (item.blockedAssertions ?? []).map(({ id, blockedBy, policy: blockedPolicy }) => [id, blockedBy, blockedPolicy]);
    invariant(JSON.stringify(actual) === JSON.stringify(BLOCKED_ASSERTIONS[item.id] ?? []), `${item.id} blocked assertions invalid`);
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) { invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} total invalid`); invariant(counts[dimension] === COUNTS[dimension], `${dimension} count invalid`); }
  invariant(manifest.hardCaps?.length === Object.keys(CAPS).length, "AccessSentinel hard cap count invalid");
  for (const item of manifest.hardCaps) invariant(CAPS[item.id] === item.cap, `${item.id} hard cap invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "accesssentinel" && contractMap.cases?.length === IDS.length, "contract map identity/count invalid");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant([...ids].every((id) => mapped.has(id)), "contract map coverage invalid");
  for (const mapping of contractMap.cases) { exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`); invariant(mapping.privateFailureCodePrefix === `AS_${mapping.caseId.replace("-", "_")}_`, `${mapping.caseId} failure prefix invalid`); invariant(/^[a-z][a-z0-9_]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category invalid`); }
  return true;
}

const policy = createScoringPolicy({ validateManifest, excludableCases: ["E-01", "E-02", "E-03"], exclusionReason: "missing_v1_checkpoint" });
export { classifyFailure };
export const { scoreEvaluation } = policy;
