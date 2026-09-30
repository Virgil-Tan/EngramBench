const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 5, B: 5, C: 4, D: 4, E: 4 });

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
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "rulebench", "manifest identity must be RuleBench v2");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass", "manifest acceptance must require all 100 points");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22, "manifest must define exactly 22 cases");
  invariant(JSON.stringify(Object.keys(manifest.dimensions ?? {}).sort()) === JSON.stringify(Object.keys(DIMENSIONS)), "dimensions must be exactly A through E");
  const ids = unique(manifest.cases, "id", "case");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  const counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(/^[A-E]-\d{2}$/u.test(item.id), `${item.id} is not a RuleBench case ID`);
    invariant(item.dimension in DIMENSIONS && item.id.startsWith(`${item.dimension}-`), `${item.id} has an invalid dimension`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} requires positive weight`);
    invariant(typeof item.title === "string" && item.title.length > 0 && Array.isArray(item.prerequisites), `${item.id} metadata is incomplete`);
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[dimension]?.weight === weight && Math.abs(totals[dimension] - weight) < 1e-9, `${dimension} must total ${weight}`);
    invariant(counts[dimension] === COUNTS[dimension], `${dimension} must define ${COUNTS[dimension]} cases`);
  }
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 7, "manifest must define seven RuleBench hard caps");
  unique(manifest.hardCaps, "id", "hard cap");
  for (const cap of manifest.hardCaps) invariant(Number.isFinite(cap.cap) && cap.cap >= 0 && cap.cap <= 100 && typeof cap.publicInvariant === "string", `${cap.id} is invalid`);

  const c04 = manifest.cases.find(({ id }) => id === "C-04");
  invariant(JSON.stringify(c04.blockedAssertions) === JSON.stringify([{ id: "external-delivery-unknown-ack", blockedBy: "SPEC-GAP-RB-03", policy: "fail-closed-diagnostic" }]), "C-04 must declare exactly SPEC-GAP-RB-03");
  invariant(manifest.cases.filter(({ id }) => id !== "C-04").every((item) => item.blockedAssertions === undefined), "only C-04 may declare a blocked assertion");

  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId, "contract map identity must match manifest");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === 22, "contract map must define 22 mappings");
  const mapped = unique(contractMap.cases, "caseId", "contract mapping");
  invariant(mapped.size === ids.size && [...ids].every((id) => mapped.has(id)), "contract map must cover each case once");
  for (const mapping of contractMap.cases) {
    invariant(JSON.stringify(Object.keys(mapping.requirement ?? {}).sort()) === JSON.stringify(["id", "source", "summary"]), `${mapping.caseId} requires one authoritative requirement`);
    invariant(Object.values(mapping.requirement).every((value) => typeof value === "string" && value.length > 0), `${mapping.caseId} requirement is incomplete`);
    invariant(mapping.privateFailureCodePrefix === `RB_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} failure prefix is invalid`);
    invariant(/^[A-E]\.[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} feedback category is invalid`);
  }
  return true;
}

const policy = createScoringPolicy({
  validateManifest,
  excludableCases: ["E-01"],
  exclusionReason: "missing_v1_checkpoint",
});
export { classifyFailure };
export const { scoreEvaluation } = policy;
