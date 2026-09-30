const sharedRoot =
  process.env.FRONTAL_V2_SHARED_ROOT_URL ??
  new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(
  new URL("scoring.mjs", sharedRoot)
);
const IDS = [
  "A-01",
  "A-02",
  "A-03",
  "A-04",
  "A-05",
  "B-01",
  "B-02",
  "B-03",
  "B-04",
  "B-05",
  "C-01",
  "C-02",
  "C-03",
  "C-04",
  "D-01",
  "D-02",
  "D-03",
  "D-04",
  "E-01",
  "E-02",
  "E-03",
  "E-04",
];
const DIMENSIONS = { A: 30, B: 25, C: 20, D: 15, E: 10 };
const COUNTS = { A: 5, B: 5, C: 4, D: 4, E: 4 };
const CAPS = {
  IMAGE_INTEGRITY: 40,
  CAMPAIGN_ATOMICITY: 35,
  ACTIVE_AUTHORITY: 30,
  REPORT_REPLAY: 30,
  INSTALL_FENCE: 30,
  ROLLBACK_FENCE: 30,
  WORK_RECOVERY: 35,
  MIGRATION_IDENTITY: 30,
};
function invariant(value, message) {
  if (!value) throw new Error(message);
}
function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const value = item[key];
    invariant(
      typeof value === "string" && value && !seen.has(value),
      `${label} missing or duplicate`,
    );
    seen.add(value);
  }
  return seen;
}
export function validateManifest(manifest, contractMap) {
  invariant(
    manifest?.schemaVersion === 2 &&
      manifest.taskId === "firmwarefleet" &&
      manifest.profile === "learning-v2" &&
      manifest.formalReady === false,
    "manifest identity invalid",
  );
  invariant(
    manifest.maxScore === 100 && manifest.cases?.length === 22,
    "manifest score/count invalid",
  );
  invariant(
    JSON.stringify(manifest.cases.map(({ id }) => id)) === JSON.stringify(IDS),
    "case order invalid",
  );
  unique(manifest.cases, "id", "case");
  invariant(
    JSON.stringify(manifest.specGaps?.map(({ id }) => id)) ===
      JSON.stringify(["FF-GAP-01", "FF-GAP-02"]),
    "gap list invalid",
  );
  const totals = { A: 0, B: 0, C: 0, D: 0, E: 0 },
    counts = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const item of manifest.cases) {
    invariant(
      Object.hasOwn(DIMENSIONS, item.dimension) &&
        Number.isFinite(item.weight) &&
        item.weight > 0,
      "case metadata invalid",
    );
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
    if (item.id === "D-03")
      invariant(
        item.blockedAssertions?.length === 1 &&
          item.blockedAssertions[0].id ===
            "device-update-manager-extension-shape" &&
          item.blockedAssertions[0].blockedBy === "FF-GAP-01" &&
          item.blockedAssertions[0].policy === "fail-closed-diagnostic",
        "D-03 gap invalid",
      );
    else invariant(!item.blockedAssertions, `${item.id} must execute fully`);
  }
  for (const dimension of Object.keys(DIMENSIONS)) {
    invariant(
      manifest.dimensions[dimension].weight === DIMENSIONS[dimension] &&
        totals[dimension] === DIMENSIONS[dimension],
      `${dimension} weight invalid`,
    );
    invariant(
      counts[dimension] === COUNTS[dimension],
      `${dimension} count invalid`,
    );
  }
  invariant(
    manifest.hardCaps.length === Object.keys(CAPS).length,
    "cap count invalid",
  );
  for (const cap of manifest.hardCaps)
    invariant(CAPS[cap.id] === cap.cap, `${cap.id} cap invalid`);
  invariant(
    contractMap?.schemaVersion === 2 &&
      contractMap.taskId === "firmwarefleet" &&
      contractMap.cases?.length === 22,
    "contract identity invalid",
  );
  unique(contractMap.cases, "caseId", "mapping");
  for (const mapping of contractMap.cases) {
    invariant(IDS.includes(mapping.caseId), "unknown mapping");
    invariant(
      mapping.privateFailureCodePrefix ===
        `FF_${mapping.caseId.replace("-", "")}_`,
      `${mapping.caseId} prefix invalid`,
    );
    invariant(
      Object.keys(mapping.requirement).sort().join(",") === "id,source,summary",
      "requirement shape invalid",
    );
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
