const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

export const IDS = Object.freeze([
  ...Array.from({ length: 16 }, (_, index) => `A-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, index) => `B-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `C-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `D-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 9 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`),
]);
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 16, B: 10, C: 8, D: 8, E: 9 });
const CAPS = Object.freeze({ PRODUCTION_BOOT: 25, TENANT_SECRET_AUTHORITY: 25, PROJECTION_AUTHORITY: 35, IDEMPOTENCY_AUTHORITY: 30, STALE_WORK_AUTHORITY: 35, EVENT_DELIVERY_AUTHORITY: 40, CUSTODY_RECALL_AUTHORITY: 35, MIGRATION_COMPATIBILITY: 35 });
const SPEC_GAPS = Object.freeze(["SPEC-GAP-01", "SPEC-GAP-02", "SPEC-GAP-03", "SPEC-GAP-04"]);
const PREREQUISITES = Object.freeze({ "E-01": ["V1", "FINAL"], "E-02": ["V1", "FINAL"], "E-03": ["V1", "FINAL"], "E-04": ["FINAL", "PERF"], "E-05": ["FINAL", "PERF"], "E-06": ["FINAL", "PERF"], "E-07": ["FINAL", "PERF"], "E-08": ["FINAL", "PERF"], "E-09": ["FINAL", "PERF"] });
const BLOCKED = Object.freeze({
  "A-04": [["CCC-A04-WIRE-CONTRACT", "SPEC-GAP-01"]], "A-07": [["CCC-A07-CURSOR-WIRE", "SPEC-GAP-01"]], "A-14": [["CCC-A14-SITE-RADIUS-BOUNDARY", "SPEC-GAP-02"]], "A-15": [["CCC-A15-NOTIFICATION-PAYLOAD-WINDOW", "SPEC-GAP-03"]],
  "C-02": [["CCC-C02-STALE-OWNER-BEFORE-COMMIT", "SPEC-GAP-04"]], "C-03": [["CCC-C03-EFFECT-COMPLETE-BEFORE-COMMIT", "SPEC-GAP-04"]], "C-04": [["CCC-C04-OLD-OWNER-BINDING", "SPEC-GAP-04"]], "C-05": [["CCC-C05-STALE-EXPIRY-OWNER", "SPEC-GAP-04"]], "C-06": [["CCC-C06-STALE-QUARANTINE-OWNER", "SPEC-GAP-04"]],
  "C-07": [["CCC-C07-PRIVATE-PAYLOAD-FIELDS", "SPEC-GAP-03"]], "C-08": [["CCC-C08-RATE-WINDOW-ALGORITHM", "SPEC-GAP-03"]], "D-01": [["CCC-D01-WIRE-STATUS-WRAPPER", "SPEC-GAP-01"]],
  "E-03": [["CCC-E03-STALE-TOKEN-COMPLETION", "SPEC-GAP-04"]], "E-06": [["CCC-E06-STALE-COMMIT-BARRIER", "SPEC-GAP-04"]], "E-08": [["CCC-E08-STALE-RELEASE-BARRIER", "SPEC-GAP-04"]],
});

function invariant(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, keys, label) { invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields are invalid`); }
function unique(items, select, label) { const values = new Set(); for (const item of items) { const value = select(item); invariant(typeof value === "string" && value.length > 0, `${label} missing`); invariant(!values.has(value), `duplicate ${label}: ${value}`); values.add(value); } return values; }

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "coldchaincontrol" && manifest.profile === "transfer-v2", "ColdChainControl manifest identity invalid");
  invariant(manifest.formalReady === false, "ColdChainControl remains diagnostic while published SPEC-GAPs are unresolved");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "ColdChainControl acceptance invalid");
  invariant(manifest.cases?.length === 51 && JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS), "ColdChainControl case order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(SPEC_GAPS), "ColdChainControl SPEC-GAP registry invalid");
  const ids = unique(manifest.cases, ({ id }) => id, "case id"), totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0])), counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && JSON.stringify(item.prerequisites) === JSON.stringify(PREREQUISITES[item.id] ?? ["FINAL"]), `${item.id} metadata invalid`);
    const actual = (item.blockedAssertions ?? []).map(({ id, blockedBy, policy }) => [id, blockedBy, policy]);
    const expected = (BLOCKED[item.id] ?? []).map(([id, blockedBy]) => [id, blockedBy, "fail-closed-diagnostic"]);
    invariant(JSON.stringify(actual) === JSON.stringify(expected), `${item.id} blocked assertions are not frozen`);
    totals[item.dimension] += item.weight; counts[item.dimension] += 1;
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) { invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} total invalid`); invariant(counts[dimension] === COUNTS[dimension], `${dimension} count invalid`); }
  invariant(manifest.hardCaps?.length === Object.keys(CAPS).length, "hard cap count invalid"); const seenCaps = unique(manifest.hardCaps, ({ id }) => id, "hard cap id"); invariant(Object.keys(CAPS).every((id) => seenCaps.has(id)), "hard cap registry invalid"); for (const item of manifest.hardCaps) invariant(CAPS[item.id] === item.cap && item.publicInvariant.length > 28, `${item.id} hard cap invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "coldchaincontrol" && contractMap.cases?.length === IDS.length, "contract map identity/count invalid"); invariant(JSON.stringify(contractMap.cases.map(({ caseId }) => caseId)) === JSON.stringify(IDS), "contract map order invalid"); const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id"); invariant([...ids].every((id) => mapped.has(id)), "contract map coverage invalid");
  for (const mapping of contractMap.cases) { exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`); invariant(mapping.privateFailureCodePrefix === `CCC_${mapping.caseId.replace("-", "_")}_`, `${mapping.caseId} failure prefix invalid`); invariant(/^[a-z][a-z0-9_]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category invalid`); }
  return true;
}

const policy = createScoringPolicy({ validateManifest, excludableCases: ["E-01", "E-02", "E-03"], exclusionReason: "missing_v1_checkpoint" });
export { classifyFailure };
export const { scoreEvaluation } = policy;
