const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

export const IDS = Object.freeze([
  ...Array.from({ length: 14 }, (_, index) => `A-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 10 }, (_, index) => `B-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 8 }, (_, index) => `C-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 7 }, (_, index) => `D-${String(index + 1).padStart(2, "0")}`),
  ...Array.from({ length: 5 }, (_, index) => `E-${String(index + 1).padStart(2, "0")}`),
]);
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 14, B: 10, C: 8, D: 7, E: 5 });
const CAPS = Object.freeze({
  PRODUCTION_BOOT: 25,
  INCIDENT_TERMINAL_AUTHORITY: 35,
  IDEMPOTENCY_CORRECTNESS: 30,
  EVENT_TRANSACTIONALITY: 40,
  STALE_WORK_OR_LOST_DELIVERY: 40,
  QUORUM_AUTHORITY: 35,
  MIGRATION_COMPATIBILITY: 35,
});
const SPEC_GAPS = Object.freeze(["SPEC-GAP-01", "SPEC-GAP-02", "SPEC-GAP-03", "SPEC-GAP-04", "SPEC-GAP-05", "SPEC-GAP-06"]);
const PREREQUISITES = Object.freeze({
  "E-01": ["V1", "FINAL"], "E-02": ["V1", "FINAL"], "E-03": ["V1", "FINAL"],
  "E-04": ["FINAL", "PERF"], "E-05": ["FINAL", "PERF"],
});
const BLOCKED = Object.freeze({
  "A-10": [["IR-A10-OUTSIDER-ERROR", "SPEC-GAP-05"]],
  "A-13": [["IR-A13-REMAINDER-DELIVERY", "SPEC-GAP-02"]],
  "A-14": [["IR-A14-LEGACY-GROUP-ERROR", "SPEC-GAP-01"], ["IR-A14-RESOLUTION-RECORD", "SPEC-GAP-06"]],
  "B-01": [["IR-B01-EXACT-RETRY-TIMESTAMP", "SPEC-GAP-03"]],
  "C-08": [["IR-C08-ACK-EVENT-TYPE", "SPEC-GAP-04"]],
  "D-07": [["IR-D07-SPEC-GAPS", "SPEC-GAP-06"]],
});

function invariant(condition, message) { if (!condition) throw new Error(message); }
function exactKeys(value, keys, label) { invariant(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields are invalid`); }
function unique(items, select, label) { const result = new Set(); for (const item of items) { const value = select(item); invariant(typeof value === "string" && value.length > 0, `${label} missing`); invariant(!result.has(value), `duplicate ${label}: ${value}`); result.add(value); } return result; }

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "incidentrelay" && manifest.profile === "transfer-v2", "IncidentRelay manifest identity invalid");
  invariant(manifest.formalReady === false, "IncidentRelay remains diagnostic until every published SPEC-GAP is resolved");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "IncidentRelay acceptance invalid");
  invariant(manifest.cases?.length === 44 && JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS), "IncidentRelay case order is not frozen");
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(SPEC_GAPS), "IncidentRelay SPEC-GAP registry invalid");
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(Object.hasOwn(DIMENSIONS, item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && JSON.stringify(item.prerequisites) === JSON.stringify(PREREQUISITES[item.id] ?? ["FINAL"]), `${item.id} metadata invalid`);
    const actualBlocked = (item.blockedAssertions ?? []).map(({ id, blockedBy, policy }) => [id, blockedBy, policy]);
    const expectedBlocked = (BLOCKED[item.id] ?? []).map(([id, blockedBy]) => [id, blockedBy, "fail-closed-diagnostic"]);
    invariant(JSON.stringify(actualBlocked) === JSON.stringify(expectedBlocked), `${item.id} blocked assertions are not frozen`);
    totals[item.dimension] += item.weight; counts[item.dimension] += 1;
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight && totals[dimension] === weight, `${dimension} total invalid`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} count invalid`);
  }
  invariant(manifest.hardCaps?.length === Object.keys(CAPS).length, "IncidentRelay hard cap count invalid");
  const seenCaps = unique(manifest.hardCaps, ({ id }) => id, "hard cap id");
  invariant([...Object.keys(CAPS)].every((id) => seenCaps.has(id)), "IncidentRelay hard cap registry invalid");
  for (const item of manifest.hardCaps) invariant(CAPS[item.id] === item.cap && typeof item.publicInvariant === "string" && item.publicInvariant.length > 24, `${item.id} hard cap invalid`);
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === "incidentrelay" && contractMap.cases?.length === IDS.length, "contract map identity/count invalid");
  invariant(JSON.stringify(contractMap.cases.map(({ caseId }) => caseId)) === JSON.stringify(IDS), "contract map order invalid");
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "contract case id");
  invariant([...ids].every((id) => mapped.has(id)), "contract map coverage invalid");
  for (const mapping of contractMap.cases) {
    exactKeys(mapping.requirement, ["id", "source", "summary"], `${mapping.caseId} requirement`);
    invariant(mapping.privateFailureCodePrefix === `IR_${mapping.caseId.replace("-", "_")}_`, `${mapping.caseId} failure prefix invalid`);
    invariant(/^[a-z][a-z0-9_]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest, excludableCases: ["E-01", "E-02", "E-03"], exclusionReason: "missing_v1_checkpoint" });
export { classifyFailure };
export const { scoreEvaluation } = policy;
