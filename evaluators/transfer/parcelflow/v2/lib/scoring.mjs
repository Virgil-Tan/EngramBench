const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL
  ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const EXCLUDABLE = Object.freeze(["A-10", "E-01", "E-02", "E-03"]);

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
  invariant(manifest?.schemaVersion === 2, "manifest schemaVersion must be 2");
  invariant(manifest.taskId === "parcelflow", "manifest taskId must be parcelflow");
  invariant(manifest.maxScore === 100, "manifest maxScore must be 100");
  invariant(manifest.acceptance?.mode === "all_cases_pass", "manifest acceptance must be all_cases_pass");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 49, "manifest must define exactly 49 cases");
  invariant(Array.isArray(manifest.hardCaps) && manifest.hardCaps.length === 7, "manifest must define exactly seven hard caps");
  invariant(JSON.stringify(Object.keys(manifest.dimensions ?? {}).sort()) === JSON.stringify(Object.keys(DIMENSIONS)), "dimensions must be exactly A through E");
  const ids = unique(manifest.cases, "id", "case");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    invariant(/^[A-E]-\d{2}$/u.test(item.id), `invalid case id ${item.id}`);
    invariant(item.dimension in DIMENSIONS, `${item.id} has invalid dimension`);
    invariant(typeof item.title === "string" && item.title.length > 0, `${item.id} requires title`);
    invariant(Number.isFinite(item.weight) && item.weight > 0, `${item.id} requires positive weight`);
    invariant(Array.isArray(item.prerequisites), `${item.id} prerequisites must be an array`);
    totals[item.dimension] += item.weight;
  }
  for (const [id, weight] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[id]?.weight === weight, `${id} declared weight must be ${weight}`);
    invariant(Math.abs(totals[id] - weight) < 1e-9, `${id} case weight must total ${weight}`);
  }
  unique(manifest.hardCaps, "id", "hard cap");
  for (const cap of manifest.hardCaps) {
    invariant(Number.isFinite(cap.cap) && cap.cap >= 0 && cap.cap <= 100, `${cap.id} has invalid cap`);
    invariant(typeof cap.publicInvariant === "string" && cap.publicInvariant.length > 0, `${cap.id} requires public invariant`);
  }
  invariant(contractMap?.schemaVersion === 2 && contractMap.taskId === manifest.taskId, "contract map identity must match manifest");
  invariant(Array.isArray(contractMap.cases) && contractMap.cases.length === 49, "contract map must define exactly 49 mappings");
  const mapped = unique(contractMap.cases, "caseId", "contract mapping");
  invariant(mapped.size === ids.size && [...ids].every((id) => mapped.has(id)), "contract map must cover every case exactly once");
  for (const mapping of contractMap.cases) {
    invariant(JSON.stringify(Object.keys(mapping.requirement ?? {}).sort()) === JSON.stringify(["id", "source", "summary"]), `${mapping.caseId} requires exactly one requirement source`);
    for (const value of Object.values(mapping.requirement)) invariant(typeof value === "string" && value.length > 0, `${mapping.caseId} has an empty requirement field`);
    invariant(mapping.privateFailureCodePrefix === `PF_${mapping.caseId.replace("-", "")}_`, `${mapping.caseId} has invalid failure prefix`);
    invariant(/^[a-z][a-z0-9-]*$/u.test(mapping.publicFeedbackCategory), `${mapping.caseId} has invalid feedback category`);
  }
  return true;
}

const policy = createScoringPolicy({
  validateManifest,
  excludableCases: EXCLUDABLE,
  exclusionReason: "missing_v1_checkpoint",
});

export { classifyFailure };
export const { scoreEvaluation } = policy;
