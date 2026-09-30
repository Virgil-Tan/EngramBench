const sharedRoot =
  process.env.FRONTAL_V2_SHARED_ROOT_URL ??
  new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const { classifyFailure, createScoringPolicy } = await import(
  new URL("scoring.mjs", sharedRoot)
);

export const IDS = Object.freeze([
  ...Array.from(
    { length: 18 },
    (_, index) => `A-${String(index + 1).padStart(2, "0")}`,
  ),
  ...Array.from(
    { length: 10 },
    (_, index) => `B-${String(index + 1).padStart(2, "0")}`,
  ),
  ...Array.from(
    { length: 8 },
    (_, index) => `C-${String(index + 1).padStart(2, "0")}`,
  ),
  ...Array.from(
    { length: 8 },
    (_, index) => `D-${String(index + 1).padStart(2, "0")}`,
  ),
  ...Array.from(
    { length: 10 },
    (_, index) => `E-${String(index + 1).padStart(2, "0")}`,
  ),
]);
const DIMENSIONS = Object.freeze({ A: 30, B: 25, C: 20, D: 15, E: 10 });
const COUNTS = Object.freeze({ A: 18, B: 10, C: 8, D: 8, E: 10 });
const CAPS = Object.freeze({
  PRODUCTION_BOOT: 25,
  MEDIA_LINEAGE_ATOMICITY: 35,
  DURABLE_REPLAY: 30,
  STALE_WORK_FENCING: 35,
  LICENSE_AUTHORITY_ATOMICITY: 30,
  ROYALTY_IMMUTABILITY: 35,
  EVENT_NOTIFICATION_DELIVERY: 40,
  HOLD_ADJUSTMENT_AUTHORITY: 35,
  MIGRATION_COMPATIBILITY: 35,
});
const SPEC_GAPS = Object.freeze(["SPEC-GAP-01", "SPEC-GAP-02", "SPEC-GAP-03"]);
const MIGRATION = new Set(["E-01", "E-02", "E-03"]);
const PERFORMANCE = new Set(["E-04", "E-05", "E-06", "E-07", "E-08", "E-09"]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}
function exactKeys(value, keys, label) {
  invariant(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  invariant(
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort()),
    `${label} fields are invalid`,
  );
}
function unique(items, select, label) {
  const result = new Set();
  for (const item of items) {
    const value = select(item);
    invariant(
      typeof value === "string" && value.length > 0,
      `${label} missing`,
    );
    invariant(!result.has(value), `duplicate ${label}: ${value}`);
    result.add(value);
  }
  return result;
}

export function validateManifest(manifest, contractMap) {
  invariant(
    manifest?.schemaVersion === 2 &&
      manifest.taskId === "creatorrightsexchange" &&
      manifest.profile === "transfer-v2",
    "CreatorRightsExchange manifest identity invalid",
  );
  invariant(
    manifest.maxScore === 100 && manifest.acceptance?.mode === "all_cases_pass",
    "CreatorRightsExchange acceptance invalid",
  );
  invariant(
    manifest.cases?.length === 54 &&
      JSON.stringify(manifest.cases.map(({ id }) => id)) ===
        JSON.stringify(IDS),
    "CreatorRightsExchange case order invalid",
  );
  exactKeys(manifest.dimensions, Object.keys(DIMENSIONS), "dimensions");
  invariant(
    JSON.stringify(manifest.specGaps?.map(({ id }) => id)) ===
      JSON.stringify(SPEC_GAPS),
    "CreatorRightsExchange SPEC-GAP registry invalid",
  );

  const ids = unique(manifest.cases, ({ id }) => id, "case id");
  const totals = Object.fromEntries(
    Object.keys(DIMENSIONS).map((id) => [id, 0]),
  );
  const counts = Object.fromEntries(Object.keys(COUNTS).map((id) => [id, 0]));
  for (const item of manifest.cases) {
    const prerequisites = MIGRATION.has(item.id)
      ? ["V1", "FINAL"]
      : PERFORMANCE.has(item.id)
        ? ["FINAL", "PERF"]
        : ["FINAL"];
    invariant(
      Object.hasOwn(DIMENSIONS, item.dimension) &&
        Number.isFinite(item.weight) &&
        item.weight > 0,
      `${item.id} dimension/weight invalid`,
    );
    invariant(
      JSON.stringify(item.prerequisites) === JSON.stringify(prerequisites),
      `${item.id} prerequisites invalid`,
    );
    totals[item.dimension] += item.weight;
    counts[item.dimension] += 1;
  }
  for (const [dimension, weight] of Object.entries(DIMENSIONS)) {
    invariant(
      manifest.dimensions[dimension]?.weight === weight &&
        totals[dimension] === weight,
      `${dimension} total invalid`,
    );
    invariant(
      counts[dimension] === COUNTS[dimension],
      `${dimension} case count invalid`,
    );
  }

  invariant(
    manifest.hardCaps?.length === Object.keys(CAPS).length,
    "CreatorRightsExchange hard cap count invalid",
  );
  const seenCaps = unique(manifest.hardCaps, ({ id }) => id, "hard cap id");
  invariant(
    Object.keys(CAPS).every((id) => seenCaps.has(id)),
    "CreatorRightsExchange hard cap registry invalid",
  );
  for (const item of manifest.hardCaps)
    invariant(
      CAPS[item.id] === item.cap &&
        typeof item.publicInvariant === "string" &&
        item.publicInvariant.length > 24,
      `${item.id} hard cap invalid`,
    );

  invariant(
    contractMap?.schemaVersion === 2 &&
      contractMap.taskId === manifest.taskId &&
      contractMap.cases?.length === IDS.length,
    "CreatorRightsExchange contract-map identity/count invalid",
  );
  invariant(
    JSON.stringify(contractMap.cases.map(({ caseId }) => caseId)) ===
      JSON.stringify(IDS),
    "CreatorRightsExchange contract-map order invalid",
  );
  const mapped = unique(
    contractMap.cases,
    ({ caseId }) => caseId,
    "contract case id",
  );
  invariant(
    [...ids].every((id) => mapped.has(id)),
    "CreatorRightsExchange contract-map coverage invalid",
  );
  for (const mapping of contractMap.cases) {
    exactKeys(
      mapping.requirement,
      ["id", "source", "summary"],
      `${mapping.caseId} requirement`,
    );
    invariant(
      mapping.privateFailureCodePrefix ===
        `CRE_${mapping.caseId.replace("-", "_")}_`,
      `${mapping.caseId} private failure prefix invalid`,
    );
    invariant(
      /^[a-z][a-z0-9_]*$/u.test(mapping.publicFeedbackCategory),
      `${mapping.caseId} public feedback category invalid`,
    );
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
