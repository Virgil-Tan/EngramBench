import { createHash } from "node:crypto";

import { sha256Canonical } from "../oracles/index.mjs";

function hash(seed, ...parts) {
  const digest = createHash("sha256").update(String(seed));
  for (const part of parts) digest.update("\0").update(String(part));
  return digest.digest();
}

function offsetMilliseconds(offset = {}) {
  return (offset.days ?? 0) * 86_400_000
    + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000
    + (offset.seconds ?? 0) * 1_000
    + (offset.milliseconds ?? 0);
}

function safe(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 32) || "value";
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  if (!evaluationSeed || !caseId || !baseTime) throw new TypeError("evaluationSeed, caseId, and baseTime are required");
  const epoch = Date.parse(baseTime);
  if (!Number.isFinite(epoch)) throw new TypeError("baseTime must be an ISO timestamp");
  const namespace = `${evaluationSeed}\0${caseId}`;
  return Object.freeze({
    evaluationSeed: String(evaluationSeed),
    caseId: String(caseId),
    baseTime: new Date(epoch).toISOString(),
    uuid(label) {
      const bytes = hash(namespace, "uuid", label).subarray(0, 16);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    at(offset = {}) { return new Date(epoch + offsetMilliseconds(offset)).toISOString(); },
    key(label) { return `rb-${safe(caseId)}-${safe(label)}-${hash(namespace, "key", label).toString("hex").slice(0, 18)}`.slice(0, 128); },
    integer(label, minimum, maximum) {
      if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) throw new TypeError("invalid integer range");
      return minimum + (hash(namespace, "integer", label).readUInt32BE(0) % (maximum - minimum + 1));
    },
  });
}

export function makeDepthExpression(depth) {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new TypeError("depth must be positive");
  let expression = { op: "exists", path: "$.value", value: true };
  for (let level = 1; level < depth; level += 1) expression = { not: expression };
  return expression;
}

export function makeWorkedExample(options) {
  const fixtures = createFixtureFactory(options);
  const ids = {
    versionId: fixtures.uuid("baseline-version"),
    rule1Id: fixtures.uuid("worked-rule-1"),
    rule2Id: fixtures.uuid("worked-rule-2"),
    rule3Id: fixtures.uuid("worked-rule-3"),
  };
  return {
    fixtures,
    ids,
    facts: { risk: "high", inserted: { z: 1, a: 2 } },
    rules: [
      { ruleId: ids.rule1Id, ruleSetVersionId: ids.versionId, priority: 10, name: "tag for review", condition: { op: "exists", path: "$.risk", value: true }, effect: { decision: "REVIEW", tags: ["a", "b"] }, terminal: false },
      { ruleId: ids.rule2Id, ruleSetVersionId: ids.versionId, priority: 20, name: "terminal deny", condition: { op: "eq", path: "$.risk", value: "high" }, effect: { decision: "DENY", tags: ["b"] }, terminal: true },
      { ruleId: ids.rule3Id, ruleSetVersionId: ids.versionId, priority: 30, name: "must stay skipped", condition: { op: "eq", path: "$.mustNotRun", value: true }, effect: { decision: "ALLOW", tags: ["never"] }, terminal: true },
    ],
  };
}

function version(fixtures, { id, ruleSetId, tenantId, revision, state, rules }) {
  return {
    ruleSetVersionId: id,
    ruleSetId,
    tenantId,
    revision,
    state,
    defaultDecision: "ALLOW",
    rulesDigest: sha256Canonical(rules),
    publishedAt: state === "PUBLISHED" ? fixtures.at({ days: -revision }) : null,
  };
}

function clonedRule(source, fields) {
  return { ...structuredClone(source), ...fields };
}

export function makeCoreSeed(options, settings = {}) {
  const fixtures = createFixtureFactory(options);
  const worked = makeWorkedExample(options);
  const tenantId = fixtures.uuid("tenant");
  const ruleSetId = fixtures.uuid("rule-set");
  const baselineVersionId = worked.ids.versionId;
  const candidateVersionId = fixtures.uuid("candidate-version");
  const errorVersionId = fixtures.uuid("error-version");
  const draftVersionId = fixtures.uuid("draft-version");
  const baselineRules = worked.rules;
  const candidateRules = baselineRules.map((rule, index) => clonedRule(rule, {
    ruleId: fixtures.uuid(`candidate-rule-${index + 1}`),
    ruleSetVersionId: candidateVersionId,
    ...(index === 1 ? { effect: { decision: "REVIEW", tags: ["b", "candidate"] } } : {}),
  }));
  const errorRules = [{
    ruleId: fixtures.uuid("error-rule"), ruleSetVersionId: errorVersionId, priority: 1, name: "safe integer only",
    condition: { op: "lt", path: "$.score", value: 10 }, effect: { decision: "REVIEW", tags: ["score"] }, terminal: true,
  }];
  const draftRules = [{
    ruleId: fixtures.uuid("draft-rule"), ruleSetVersionId: draftVersionId, priority: 1, name: "draft review",
    condition: { op: "exists", path: "$.risk", value: true }, effect: { decision: "REVIEW", tags: ["draft"] }, terminal: true,
  }];
  const ruleSetVersions = [
    version(fixtures, { id: baselineVersionId, ruleSetId, tenantId, revision: 1, state: "PUBLISHED", rules: baselineRules }),
    version(fixtures, { id: candidateVersionId, ruleSetId, tenantId, revision: 2, state: "PUBLISHED", rules: candidateRules }),
    version(fixtures, { id: errorVersionId, ruleSetId, tenantId, revision: 3, state: "PUBLISHED", rules: errorRules }),
    version(fixtures, { id: draftVersionId, ruleSetId, tenantId, revision: 4, state: "DRAFT", rules: draftRules }),
  ];
  const ids = { tenantId, ruleSetId, baselineVersionId, candidateVersionId, errorVersionId, draftVersionId };
  const seed = {
    schemaVersion: 1,
    seedVersion: settings.seedVersion ?? `rb-${safe(options.caseId)}-${hash(options.evaluationSeed, options.caseId, "seed").toString("hex").slice(0, 12)}`,
    importedAt: fixtures.at({ days: -10 }),
    tenants: [{ tenantId, name: "Private RuleBench Tenant" }],
    ruleSets: [{ ruleSetId, tenantId, name: "Private Decisions", currentRevision: 4, currentPublishedVersionId: baselineVersionId, publicationRevision: 1, createdAt: fixtures.at({ days: -5 }) }],
    ruleSetVersions,
    rules: [...baselineRules, ...candidateRules, ...errorRules, ...draftRules],
    evaluations: [],
    explanationNodes: [],
    replayRuns: [],
    conflictReports: [],
    comparisonRuns: [],
    comparisonResults: [],
    evaluationInputs: [],
  };
  return { fixtures, ids, baselineRules, candidateRules, errorRules, draftRules, seed };
}

export function makeComparisonCorpus(evaluationIds) {
  const frozen = [...new Set(evaluationIds)].sort();
  return Object.freeze({ evaluationIds: frozen, corpusDigest: sha256Canonical(frozen) });
}

export function performanceContract() {
  return Object.freeze({
    evaluation: { rules: 200, evaluations: 200_000, clients: 64, seconds: 60, throughput: 600, p95Ms: 250, drainSeconds: 60 },
    shortCircuit: { rules: 5_000, evaluations: 100_000, terminalMaximum: 10, clients: 64, seconds: 60, throughput: 400, p95Ms: 350 },
    comparison: { evaluations: 50_000, killedWorkers: 2, replacements: 4, seconds: 60 },
  });
}
