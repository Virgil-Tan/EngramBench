import { createHash } from "node:crypto";
import { snapshotDigest } from "../oracles/index.mjs";

function digest(...parts) { return createHash("sha256").update(parts.join("\0")).digest(); }
function uuidFrom(buffer) { const bytes = Buffer.from(buffer.subarray(0, 16)); bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80; const hex = bytes.toString("hex"); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; }

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `flagfoundry\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `ff-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({ milliseconds = 0, seconds = 0, minutes = 0, hours = 0, days = 0 } = {}) => new Date(Date.parse(baseTime) + (((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1_000) + milliseconds).toISOString();

  const project = { projectId: uuid("project"), name: "FlagFoundry Project" };
  const otherProject = { projectId: uuid("project:other"), name: "Other Project" };
  const environment = { projectId: project.projectId, name: "production", contextAttributes: ["country", "plan", "region"], schemaRevision: 7 };
  const otherEnvironment = { projectId: otherProject.projectId, name: "production", contextAttributes: ["country"], schemaRevision: 1 };
  const stringFlag = { flagId: uuid("flag:string"), projectId: project.projectId, key: "checkout_mode", flagType: "STRING" };
  const booleanFlag = { flagId: uuid("flag:boolean"), projectId: project.projectId, key: "risk_gate", flagType: "BOOLEAN" };
  const otherFlag = { flagId: uuid("flag:other"), projectId: otherProject.projectId, key: stringFlag.key, flagType: "STRING" };

  const stringVariants = [
    { key: "control", value: "classic", allocationBasisPoints: 5_000 },
    { key: "candidate", value: "streamlined", allocationBasisPoints: 5_000 },
  ];
  const booleanVariants = [
    { key: "off", value: false, allocationBasisPoints: 7_500 },
    { key: "on", value: true, allocationBasisPoints: 2_500 },
  ];
  const rules = [
    { ruleId: uuid("rule:enterprise-us"), clauses: [{ attribute: "plan", operator: "EQUALS", value: "enterprise" }, { attribute: "country", operator: "IN", value: ["CA", "US"] }], variantKey: "candidate" },
    { ruleId: uuid("rule:eu"), clauses: [{ attribute: "region", operator: "EQUALS", value: "eu" }], variantKey: "control" },
  ];

  function snapshot(flag = stringFlag, { revisionId = uuid(`revision:${flag.flagId}:1`), revision = 1, variants = flag.flagType === "BOOLEAN" ? booleanVariants : stringVariants, snapshotRules = flag.flagType === "BOOLEAN" ? [] : rules, defaultVariant = variants[0].key, environmentValue = environment } = {}) {
    return { snapshotVersion: 1, projectId: flag.projectId, flagId: flag.flagId, flagKey: flag.key, environment: environmentValue.name, revisionId, revision, flagType: flag.flagType, defaultVariant, variants: structuredClone(variants), rules: structuredClone(snapshotRules), contextAttributes: [...environmentValue.contextAttributes], contextSchemaRevision: environmentValue.schemaRevision };
  }
  function activeRevision(flag = stringFlag, options = {}) {
    const artifact = snapshot(flag, options);
    return { revisionId: artifact.revisionId, flagId: flag.flagId, environment: artifact.environment, revision: artifact.revision, flagType: flag.flagType, defaultVariant: artifact.defaultVariant, variants: structuredClone(artifact.variants), rules: structuredClone(artifact.rules), state: "ACTIVE", snapshotDigest: snapshotDigest(artifact), createdAt: at({ days: -2 }), activatedAt: at({ days: -1 }), sequence: 2 };
  }
  const stringActive = activeRevision(stringFlag);
  const booleanActive = activeRevision(booleanFlag, { revisionId: uuid("revision:boolean:1"), snapshotRules: [], variants: booleanVariants });
  const otherActive = activeRevision(otherFlag, { revisionId: uuid("revision:other:1"), environmentValue: otherEnvironment, snapshotRules: [] });
  const seed = (seedVersion = `${caseId.toLowerCase()}-seed`, overrides = {}) => ({ schemaVersion: 1, seedVersion, projects: [project, otherProject], environments: [environment, otherEnvironment], flags: [stringFlag, booleanFlag, otherFlag], activeRevisions: [stringActive, booleanActive, otherActive], ...overrides });
  const revisionBody = (flag = stringFlag, label = "draft", overrides = {}) => ({ environment: environment.name, flagType: flag.flagType, defaultVariant: flag.flagType === "BOOLEAN" ? "off" : "control", variants: structuredClone(flag.flagType === "BOOLEAN" ? booleanVariants : stringVariants), rules: structuredClone(flag.flagType === "BOOLEAN" ? [] : rules), expectedActiveRevision: flag.flagType === "BOOLEAN" ? booleanActive.revision : stringActive.revision, ...overrides });
  const evaluationBody = (label, overrides = {}) => ({ projectId: project.projectId, flagKey: stringFlag.key, environment: environment.name, context: { subjectKey: `subject-${label}`, plan: "enterprise", country: "US", region: "na" }, ...overrides });
  const rolloutSteps = [
    { candidateExposureBasisPoints: 2_500, minimumEvaluationCount: 4, maximumFailureBasisPoints: 2_500, observationSeconds: 60 },
    { candidateExposureBasisPoints: 5_000, minimumEvaluationCount: 4, maximumFailureBasisPoints: 2_500, observationSeconds: 60 },
    { candidateExposureBasisPoints: 10_000, minimumEvaluationCount: 4, maximumFailureBasisPoints: 2_500, observationSeconds: 60 },
  ];

  function family(name, overrides = {}) { return { fixtureFamily: `FF-F-${name}`, uuid, key, at, project, otherProject, environment, otherEnvironment, stringFlag, booleanFlag, otherFlag, stringVariants, booleanVariants, rules, stringActive, booleanActive, otherActive, snapshot, activeRevision, revisionBody, evaluationBody, rolloutSteps: structuredClone(rolloutSteps), seed: seed(`${caseId.toLowerCase()}-${name.toLowerCase()}`, overrides) }; }
  function empty() { return family("EMPTY", { projects: [], environments: [], flags: [], activeRevisions: [] }); }
  function flag() { return family("FLAG"); }
  function revision() { return family("REVISION"); }
  function evaluation() { return family("EVALUATION"); }
  function idempotency() { return { ...family("IDEMPOTENCY"), mutationPaths: ["flags", "revisions", "activate", "progressive-activate", "outcome-batches"] }; }
  function contention() { return { ...family("CONTENTION"), interleavings: ["activate-activate", "compile-activate", "outcome-deadline"] }; }
  function work() { return { ...family("WORK"), barriers: ["worker.claimed", "worker.effect-complete", "worker.before-commit", "dispatcher.response-received"] }; }
  function event() { return { ...family("EVENT"), eventTypes: ["flag.compilation-started", "flag.revision-rejected", "flag.revision-activated", "flag.revision-superseded"] }; }
  function rollout() { return { ...family("ROLLOUT"), outcome: (ordinal, overrides = {}) => ({ outcomeId: `outcome-${caseId.toLowerCase()}-${ordinal}`, stepIndex: 0, subjectKey: `subject-${ordinal}`, snapshotDigest: overrides.snapshotDigest ?? stringActive.snapshotDigest, outcome: ordinal % 4 === 0 ? "FAILURE" : "SUCCESS", ...overrides }) }; }
  function migration() { return { ...family("MIGRATION"), savedReplayKey: key("v1-replay") }; }
  function browser() { return { ...family("BROWSER") }; }
  function performance() { return { ...family("PERF-V1"), projectCount: 100, environmentCount: 300, flagCount: 5_000, activeRevisionCount: 5_000, readyCandidateCount: 500, activationPairCount: 500, concurrency: 64, warmupSeconds: 10, measureSeconds: 60, scenarios: ["flag-evaluation", "revision-compilation", "disjoint-activation"] }; }

  return Object.freeze({ uuid, key, at, project, otherProject, environment, otherEnvironment, stringFlag, booleanFlag, otherFlag, stringVariants, booleanVariants, rules, stringActive, booleanActive, otherActive, seed, snapshot, activeRevision, revisionBody, evaluationBody, empty, flag, revision, evaluation, idempotency, contention, work, event, rollout, migration, browser, performance });
}
