const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(new URL("scoring.mjs", sharedRoot));

const DIMENSIONS = { A: 30, B: 25, C: 20, D: 15, E: 10 };
const EXACT = [
  ["A-01", 6, "A"], ["A-02", 6, "A"], ["A-03", 6, "A"], ["A-04", 6, "A"], ["A-05", 6, "A"],
  ["B-01", 5, "B"], ["B-02", 5, "B"], ["B-03", 5, "B"], ["B-04", 5, "B"], ["B-05", 5, "B"],
  ["C-01", 5, "C"], ["C-02", 5, "C"], ["C-03", 5, "C"], ["C-04", 5, "C"],
  ["D-01", 4, "D"], ["D-02", 4, "D"], ["D-03", 4, "D"], ["D-04", 3, "D"],
  ["E-01", 2.5, "E"], ["E-02", 2.5, "E"], ["E-03", 2.5, "E"], ["E-04", 2.5, "E"],
];
const GAP_IDS = ["IM-GAP-01", "IM-GAP-02", "IM-GAP-03", "IM-GAP-04", "IM-GAP-05", "IM-GAP-06"];

function invariant(value, message) {
  if (!value) throw new Error(message);
}

function unique(items, selector, label) {
  const values = new Set();
  for (const item of items) {
    const value = selector(item);
    invariant(typeof value === "string" && value.length > 0, `${label} missing`);
    invariant(!values.has(value), `duplicate ${label}: ${value}`);
    values.add(value);
  }
  return values;
}

export function validateManifest(manifest, contractMap) {
  invariant(
    manifest?.schemaVersion === 2 && manifest.taskId === "identitymesh" && manifest.maxScore === 100
      && manifest.acceptance?.mode === "all_cases_pass",
    "manifest identity",
  );
  invariant(
    JSON.stringify(manifest.cases?.map(({ id, weight, dimension }) => [id, weight, dimension])) === JSON.stringify(EXACT),
    "case order/weight/dimension",
  );
  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const totals = Object.fromEntries(Object.keys(DIMENSIONS).map((key) => [key, 0]));
  for (const item of manifest.cases) {
    totals[item.dimension] += item.weight;
    for (const blocked of item.blockedAssertions ?? []) {
      invariant(blocked.policy === "fail-closed-diagnostic", `${item.id} blocked assertion policy`);
      invariant(GAP_IDS.includes(blocked.blockedBy), `${item.id} unknown blockedBy`);
    }
  }
  for (const [key, expected] of Object.entries(DIMENSIONS)) {
    invariant(manifest.dimensions[key]?.weight === expected && totals[key] === expected, `${key} weights`);
  }
  invariant(JSON.stringify(manifest.specGaps?.map(({ id }) => id)) === JSON.stringify(GAP_IDS), "spec gap order");
  const caps = new Map(manifest.hardCaps?.map(({ id, cap }) => [id, cap]));
  invariant(
    caps.size === 4 && ["SECRET_EXPOSURE", "IDENTITY_RESURRECTION", "REVOCATION_FAIL_OPEN", "AUDIT_IMMUTABILITY"].every((id) => caps.get(id) === 25),
    "hard caps",
  );
  invariant(
    contractMap?.schemaVersion === 2 && contractMap.taskId === "identitymesh"
      && JSON.stringify(contractMap.cases?.map(({ caseId }) => caseId)) === JSON.stringify(EXACT.map(([id]) => id)),
    "contract map identity/order",
  );
  const mapped = unique(contractMap.cases, ({ caseId }) => caseId, "case mapping");
  invariant(mapped.size === ids.size && [...ids].every((id) => mapped.has(id)), "contract map coverage");
  return true;
}

const policy = createScoringPolicy({ validateManifest });
export { classifyFailure };
export const { scoreEvaluation } = policy;
