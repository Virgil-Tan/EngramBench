const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(new URL("execution.mjs", sharedRoot));
const PRIVATE_EVIDENCE = Symbol("escrowguard.privateEvidence");
const PRIVATE_EVIDENCE_TARGET_BYTES = 128 * 1024;

export class CaseFailure extends Error {
  constructor(message, { failureCodeSuffix = "ASSERTION_FAILED", hardCapIds = [] } = {}) {
    super(message);
    this.name = "CaseFailure";
    this.failureCodeSuffix = failureCodeSuffix;
    this.hardCapIds = hardCapIds;
    this.origin = "candidate";
  }
}

export const {
  CaseExcluded,
  EvaluationInfrastructureError,
  createMissingV1CheckpointOutcome,
  createPrivateCaseState,
  isMissingV1CheckpointOutcome,
  MISSING_V1_CHECKPOINT_REASON,
  parsePriorCaseState,
  PRIOR_CASE_STATE_ENV,
  PRIVATE_CASE_STATE_ENV,
} = shared;

function evidenceBindings(observations, streamedIdentities) {
  const grouped = new Map();
  for (const observation of observations) {
    for (const [kind, field] of [["identity", "identityHashes"], ["aggregate", "aggregateHashes"], ["work", "workHashes"], ["event", "eventHashes"], ["resource", "resourceHashes"]]) {
      for (const hash of observation[field] ?? []) {
        const key = `${kind}:${hash}`;
        const binding = grouped.get(key) ?? { kind, hash, layers: new Set() };
        binding.layers.add(observation.layer);
        grouped.set(key, binding);
      }
    }
  }
  for (const [hash, layers] of streamedIdentities ?? []) {
    const key = `identity:${hash}`;
    const binding = grouped.get(key) ?? { kind: "identity", hash, layers: new Set() };
    for (const layer of layers) binding.layers.add(layer);
    grouped.set(key, binding);
  }
  return [...grouped.values()]
    .filter(({ layers }) => layers.size >= 2)
    .sort((left, right) => right.layers.size - left.layers.size || `${left.kind}:${left.hash}`.localeCompare(`${right.kind}:${right.hash}`))
    .slice(0, 64)
    .map(({ kind, hash, layers }) => Object.freeze({ kind, hash, layers: Object.freeze([...layers].sort()) }));
}

export function summarizeCaseEvidence(ctx, details) {
  const layers = { ...(ctx.layerEvidenceCounts ?? {}) };
  if (Object.keys(layers).length === 0) for (const item of ctx.evidence ?? []) { const layer = /^layer\.([a-z]+)$/u.exec(item?.event ?? "")?.[1]; if (layer) layers[layer] = (layers[layer] ?? 0) + 1; }
  const grouped = Map.groupBy([...(ctx.layerEvidence ?? [])], ({ layer }) => layer);
  const observations = [];
  const layerNames = [...grouped.keys()].sort();
  for (let ordinal = 0; ordinal < 6; ordinal += 1) for (const layer of layerNames) {
    const observation = grouped.get(layer)?.[ordinal];
    if (observation) observations.push(observation);
  }
  const evidenceKinds = [...new Set((details?.evidence ?? []).map(({ kind }) => kind).filter((kind) => typeof kind === "string"))].slice(0, 16);
  let summary;
  do {
    summary = {
      caseId: ctx.caseId,
      layers: Object.freeze(layers),
      evidenceKinds: Object.freeze(evidenceKinds),
      observations: Object.freeze([...observations]),
      bindings: Object.freeze(evidenceBindings(observations, ctx.layerIdentityBindings)),
    };
    if (Buffer.byteLength(JSON.stringify(summary)) <= PRIVATE_EVIDENCE_TARGET_BYTES) return Object.freeze(summary);
    observations.pop();
  } while (observations.length > 0);
  summary = {
    caseId: ctx.caseId,
    layers: Object.freeze(layers),
    evidenceKinds: Object.freeze(evidenceKinds),
    observations: Object.freeze([]),
    bindings: Object.freeze([]),
  };
  if (Buffer.byteLength(JSON.stringify(summary)) > PRIVATE_EVIDENCE_TARGET_BYTES) throw new Error(`${ctx.caseId} evidence summary exceeds task-private bound`);
  return Object.freeze(summary);
}

export async function executeCase(options) {
  let privateEvidence;
  let details;
  const outcome = await shared.executeCase({
    ...options,
    withContext: (contextOptions, operation) => options.withContext(contextOptions, async (ctx) => {
      try {
        details = await operation(ctx);
        return details;
      } finally {
        privateEvidence = summarizeCaseEvidence(ctx, details);
      }
    }),
  });
  if (privateEvidence) Object.defineProperty(outcome, PRIVATE_EVIDENCE, { value: privateEvidence, enumerable: false });
  return outcome;
}

export function privateEvidenceFor(outcome) { return outcome?.[PRIVATE_EVIDENCE]; }

export function validateCaseRegistry(manifest, implementations) {
  shared.validateCaseRegistry(manifest, implementations);
  for (const item of implementations) {
    if (item.taskId !== "escrowguard") throw new Error(`${item.id} is not EscrowGuard-owned`);
    if (!/^EG-F-/u.test(item.fixtureFamily ?? "")) throw new Error(`${item.id} lacks an EscrowGuard fixture family`);
    if (typeof item.action !== "string" || item.action.length < 24) throw new Error(`${item.id} lacks public action detail`);
    if (typeof item.oracle !== "string" || item.oracle.length < 24) throw new Error(`${item.id} lacks independent oracle detail`);
    if (item.run.length < 1) throw new Error(`${item.id} must implement run(ctx)`);
  }
  return true;
}
