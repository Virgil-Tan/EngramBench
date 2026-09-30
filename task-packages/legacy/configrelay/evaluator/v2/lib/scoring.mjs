const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const WEIGHTS = { A:30,B:25,C:20,D:15,E:10 };
const CASE_ID = /^[A-E]-[0-9]{2}$/u;
const CATEGORY = /^[a-z][a-z0-9-]*$/u;

function invariant(condition,message) { if (!condition) throw new Error(message); }
function exact(value,keys,label) {
  invariant(value && typeof value === "object" && !Array.isArray(value),`${label} object required`);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  invariant(actual.length === expected.length && actual.every((key,index) => key === expected[index]),`${label} keys invalid`);
}
function unique(items,select,label) {
  const values = new Set();
  for (const item of items) { const value = select(item); invariant(typeof value === "string" && value,`${label} missing`); invariant(!values.has(value),`duplicate ${label}`); values.add(value); }
  return values;
}

export function validateManifest(manifest,map) {
  invariant(manifest?.schemaVersion === 2 && manifest.taskId === "configrelay","manifest identity mismatch");
  invariant(manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass","manifest scoring mismatch");
  invariant(Array.isArray(manifest.cases) && manifest.cases.length === 22,"22 cases required");
  exact(manifest.dimensions,Object.keys(WEIGHTS),"dimensions");
  const ids = unique(manifest.cases,({ id }) => id,"case id"), totals = Object.fromEntries(Object.keys(WEIGHTS).map((key) => [key,0]));
  for (const item of manifest.cases) {
    invariant(CASE_ID.test(item.id) && Object.hasOwn(WEIGHTS,item.dimension) && Number.isFinite(item.weight) && item.weight > 0 && Array.isArray(item.prerequisites),`${item.id} invalid`);
    totals[item.dimension] += item.weight;
    if (item.id === "B-04") {
      invariant(JSON.stringify(item.blockedAssertions) === JSON.stringify([{ id:"successful-cohort-ordered-successor",blockedBy:"SPEC-GAP-CR-02",policy:"fail-closed-diagnostic" }]),"B-04 diagnostic declaration invalid");
    } else invariant(!item.blockedAssertions?.length,`${item.id} must execute`);
  }
  for (const [key,weight] of Object.entries(WEIGHTS)) invariant(manifest.dimensions[key]?.weight === weight && totals[key] === weight,`${key} weight invalid`);
  invariant(JSON.stringify(manifest.specGaps.map(({ id }) => id)) === JSON.stringify(["SPEC-GAP-CR-01","SPEC-GAP-CR-02"]),"spec gaps invalid");
  const caps = new Map(manifest.hardCaps.map((item) => [item.id,item.cap]));
  invariant(caps.size === 4 && caps.get("ORDERED_DELIVERY_CORRECTNESS") === 35 && caps.get("IDEMPOTENCY_CORRECTNESS") === 30 && caps.get("ROLLBACK_RECOVERY_CORRECTNESS") === 40 && caps.get("MIGRATION_CORRECTNESS") === 35,"hard caps invalid");
  invariant(map?.schemaVersion === 2 && map.taskId === manifest.taskId && map.cases?.length === 22,"contract map identity invalid");
  const mapped = unique(map.cases,({ caseId }) => caseId,"mapping");
  invariant(mapped.size === ids.size && [...ids].every((id) => mapped.has(id)),"mapping coverage invalid");
  for (const item of map.cases) {
    exact(item.requirement,["id","source","summary"],`${item.caseId} requirement`);
    invariant(item.privateFailureCodePrefix === `CR_${item.caseId.replace("-","")}_`,`${item.caseId} prefix invalid`);
    invariant(CATEGORY.test(item.publicFeedbackCategory),`${item.caseId} category invalid`);
  }
  return true;
}

const policy = createScoringPolicy({ validateManifest });
export { classifyFailure };
export const { scoreEvaluation } = policy;
