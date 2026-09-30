import { createHash } from "node:crypto";

const sharedRoot = process.env.FRONTAL_V2_SHARED_ROOT_URL ?? new URL("../../../../../src/task-evaluator-v2/", import.meta.url).href;
const shared = await import(new URL("execution.mjs", sharedRoot));

export const PERMITFORGE_EVIDENCE_LAYERS = Object.freeze([
  "Chromium", "HTTP", "OpenAPI", "PostgreSQL", "UI", "build", "event", "migration", "process", "receiver", "seed", "snapshot", "work",
]);
const ALLOWED_LAYERS = new Set(PERMITFORGE_EVIDENCE_LAYERS);

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
  createMissingV1CheckpointOutcome,
  EvaluationInfrastructureError,
  createPrivateCaseState,
  isMissingV1CheckpointOutcome,
  MISSING_V1_CHECKPOINT_REASON,
  parsePriorCaseState,
  PRIOR_CASE_STATE_ENV,
  PRIVATE_CASE_STATE_ENV,
} = shared;

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function publicKind(item) {
  const value = String(item?.kind ?? item?.event ?? "observed").slice(0, 160);
  return /(?:authorization|bearer|password|secret|token|postgres(?:ql)?:\/\/)/iu.test(value) ? `${item.event} observed` : value;
}

export function summarizePermitForgeEvidence(events, caseId) {
  const grouped = new Map();
  for (const item of Array.isArray(events) ? events : []) {
    if (!ALLOWED_LAYERS.has(item?.event)) continue;
    const count = Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 1;
    const kind = publicKind(item);
    const key = `${item.event}\0${kind}`;
    const prior = grouped.get(key);
    if (prior) prior.count += count;
    else grouped.set(key, { layer: item.event, kind, count });
  }
  const layerCounts = {};
  const representatives = new Map();
  for (const value of grouped.values()) {
    layerCounts[value.layer] = (layerCounts[value.layer] ?? 0) + value.count;
    if (!representatives.has(value.layer)) representatives.set(value.layer, value);
  }
  const artifactRefs = [...representatives.values()]
    .sort((left, right) => left.layer.localeCompare(right.layer))
    .map((value) => Object.freeze({ ...value, ref: digest({ caseId, ...value }) }));
  return Object.freeze({
    schemaVersion: 1,
    caseId,
    observedEventCount: Object.values(layerCounts).reduce((sum, count) => sum + count, 0),
    layers: Object.freeze(Object.fromEntries(Object.entries(layerCounts).sort(([left], [right]) => left.localeCompare(right)))),
    artifactRefs: Object.freeze(artifactRefs),
  });
}

export function assertPermitForgeEvidenceSummary(summary, caseId) {
  if (!summary || summary.schemaVersion !== 1 || summary.caseId !== caseId) throw new Error(`${caseId} lacks task-local evidence summary`);
  if (!summary.layers || typeof summary.layers !== "object" || Array.isArray(summary.layers)) throw new Error(`${caseId} evidence layers invalid`);
  if (!Array.isArray(summary.artifactRefs) || summary.artifactRefs.length > PERMITFORGE_EVIDENCE_LAYERS.length) throw new Error(`${caseId} evidence artifact refs invalid`);
  for (const [layer, count] of Object.entries(summary.layers)) {
    if (!ALLOWED_LAYERS.has(layer) || !Number.isSafeInteger(count) || count < 1) throw new Error(`${caseId} invalid ${layer} evidence count`);
    const ref = summary.artifactRefs.find((item) => item.layer === layer);
    if (!ref || !Number.isSafeInteger(ref.count) || ref.count < 1 || typeof ref.kind !== "string" || ref.kind.length < 1 || ref.kind.length > 160 || !/^[0-9a-f]{64}$/u.test(ref.ref)) {
      throw new Error(`${caseId} missing bounded ${layer} artifact ref`);
    }
  }
  if (summary.artifactRefs.some(({ layer }) => !Object.hasOwn(summary.layers, layer))) throw new Error(`${caseId} artifact ref has no observed layer`);
  const total = Object.values(summary.layers).reduce((sum, count) => sum + count, 0);
  if (summary.observedEventCount !== total) throw new Error(`${caseId} evidence count mismatch`);
  if (JSON.stringify(summary).length > 16_384) throw new Error(`${caseId} evidence summary exceeds private bound`);
  return true;
}

export async function executeCase(args) {
  let captured = [];
  const implementation = {
    ...args.implementation,
    async run(ctx) {
      try {
        return await args.implementation.run(ctx);
      } finally {
        captured = structuredClone(ctx.evidence ?? []);
      }
    },
  };
  const outcome = await shared.executeCase({ ...args, implementation });
  const summary = summarizePermitForgeEvidence(captured, args.definition.id);
  Object.defineProperty(outcome, "privateEvidenceSummary", { value: summary, enumerable: false, writable: false, configurable: false });
  return outcome;
}

export function validateCaseRegistry(manifest, implementations) {
  shared.validateCaseRegistry(manifest, implementations);
  const definitions = new Map(manifest.cases.map((item) => [item.id, item]));
  for (const item of implementations) {
    if (item.taskId !== "permitforge") throw new Error(`${item.id} is not PermitForge-owned`);
    if (!/^PF-F-/u.test(item.fixtureFamily ?? "")) throw new Error(`${item.id} lacks PermitForge fixture ownership`);
    if (typeof item.action !== "string" || item.action.length < 24) throw new Error(`${item.id} lacks public action detail`);
    if (typeof item.oracle !== "string" || item.oracle.length < 24) throw new Error(`${item.id} lacks independent oracle detail`);
    if (item.run.length !== 1 || item.run.constructor.name !== "AsyncFunction") throw new Error(`${item.id} must expose async run(ctx)`);
    const declared = (definitions.get(item.id).blockedAssertions ?? []).map(({ id, blockedBy, policy }) => ({ id, blockedBy, policy }));
    const implemented = (item.blockedAssertions ?? []).map(({ assertionId: id, blockedBy, policy }) => ({ id, blockedBy, policy }));
    if (JSON.stringify(implemented) !== JSON.stringify(declared)) throw new Error(`${item.id} blocked diagnostics differ from manifest`);
  }
  return true;
}
