const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 16, B: 10, C: 8, D: 8, E: 7 });
const EXCLUDABLE = Object.freeze(["E-01", "E-02", "E-03"]);
const SPEC_GAPS = Object.freeze(["SPEC-GAP-01", "SPEC-GAP-02"]);

function invariant(condition, message) { if (!condition) throw new Error(message); }
function unique(items, field, label) {
  const values = new Set();
  for (const item of items) {
    const value = item?.[field];
    invariant(typeof value === "string" && value.length > 0, `${label} requires ${field}`);
    invariant(!values.has(value), `duplicate ${label} ${value}`);
    values.add(value);
  }
  return values;
}

export function validateManifest(manifest, contractMap) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "carbonledger", "manifest identity invalid");
  invariant(manifest.profile === "transfer-v2" && typeof manifest.formalReady === "boolean", "manifest profile invalid");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "manifest score or acceptance invalid");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 49, "manifest must define exactly 49 cases");
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 7, "manifest must define exactly seven hard caps");
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(SPEC_GAPS), "spec gaps invalid");
  const ids = unique(manifest.cases, "id", "case");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(/^[A-E]-\d{2}$/u.test(item.id), `invalid case id ${item.id}`);
    invariant(item.dimension in DIMENSIONS && item.id.startsWith(`${item.dimension}-`), `${item.id} dimension invalid`);
    invariant(typeof item.title === "string" && item.title.length > 0, `${item.id} requires title`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} requires positive weight`);
    invariant(Array.isArray(item.prerequisites), `${item.id} prerequisites must be an array`);
    invariant(item.blockedAssertions === undefined, `${item.id} may not turn a non-scoring specification gap into a blocked Case`);
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions?.[dimension]?.weight === weight, `${dimension} declared weight invalid`);
    invariant(Math.abs(totals[dimension] - weight) < 1e-9, `${dimension} case weight invalid`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} case count invalid`);
  }
  unique(manifest.hardCaps, "id", "hard cap");
  for (const cap of manifest.hardCaps) {
    invariant(Number.isFinite(cap.cap) && cap.cap >= 0 && cap.cap <= 100, `${cap.id} cap invalid`);
    invariant(typeof cap.publicInvariant === "string" && cap.publicInvariant.length > 0, `${cap.id} invariant missing`);
  }
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId, "contract map identity invalid");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === 49, "contract map must define 49 mappings");
  const mapped = unique(contractMap.cases, "caseId", "contract mapping");
  invariant(mapped.size === ids.size && [...ids].every((id) => mapped.has(id)), "contract map coverage invalid");
  for (const mapping of contractMap.cases) {
    invariant(JSON.stringify(Object.keys(mapping.requirement ?? {}).sort()) === JSON.stringify(["id", "source", "summary"]), `${mapping.caseId} requirement invalid`);
    for (const value of Object.values(mapping.requirement)) invariant(typeof value === "string" && value.length > 0, `${mapping.caseId} requirement empty`);
    invariant(mapping.privateFailureCodePrefix === `CL_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix invalid`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest, excludableCases: EXCLUDABLE, exclusionReason: "missing_v1_checkpoint" });
export { classifyFailure };
export const { scoreEvaluation } = policy;
