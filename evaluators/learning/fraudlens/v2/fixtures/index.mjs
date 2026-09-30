import { createHash } from "node:crypto";

function digest(seed, label) {
  return createHash("sha256").update(`${seed}\0${label}`).digest();
}

function deterministicUuid(seed, label) {
  const bytes = Buffer.from(digest(seed, label).subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `${evaluationSeed}\0fraudlens\0${caseId}`;
  const origin = Date.parse(baseTime);
  if (!Number.isFinite(origin)) throw new TypeError("baseTime must be ISO-8601");
  const uuid = (label) => deterministicUuid(namespace, label);
  const at = (offsetMs = 0) => new Date(origin + offsetMs).toISOString();
  const key = (label) => `fl-${caseId.toLowerCase()}-${createHash("sha256").update(`${namespace}\0${label}`).digest("hex").slice(0, 28)}`;

  const ids = Object.freeze({
    tenantId: uuid("tenant:primary"),
    otherTenantId: uuid("tenant:other"),
    ruleSetId: uuid("rule-set:primary"),
    otherRuleSetId: uuid("rule-set:other"),
    baseVersionId: uuid("rule-version:base"),
    otherBaseVersionId: uuid("rule-version:other-base"),
  });

  const rule = (overrides = {}) => ({
    ruleId: "velocity",
    priority: 10,
    field: "attributes.velocity",
    operator: "GTE",
    value: 5,
    score: 300,
    reasonCode: "HIGH_VELOCITY",
    ...overrides,
  });

  const workedRules = () => [
    rule({ ruleId: "b", priority: 1, field: "attributes.b", operator: "EQ", value: 1, score: 900, reasonCode: "B_MATCH" }),
    rule({ ruleId: "a", priority: 1, field: "attributes.a", operator: "EQ", value: 1, score: 300, reasonCode: "A_MATCH" }),
    rule({ ruleId: "c", priority: 2, field: "attributes.c", operator: "EQ", value: 1, score: -400, reasonCode: "C_MATCH" }),
  ];

  const event = (index, overrides = {}) => ({
    tenantId: ids.tenantId,
    externalEventId: `risk-${caseId.toLowerCase()}-${index}`,
    subjectId: `subject-${index % 100}`,
    amountMinor: 10_000 + index,
    currency: "USD",
    occurredAt: at(index * 1_000),
    attributes: { velocity: index % 10, country: index % 2 ? "US" : "GB" },
    ...overrides,
  });

  const seed = (seedVersion = `fraudlens-${caseId.toLowerCase()}`) => ({
    schemaVersion: 1,
    seedVersion,
    importedAt: at(-60_000),
    tenants: [
      { tenantId: ids.tenantId, name: "Primary Risk Tenant" },
      { tenantId: ids.otherTenantId, name: "Isolated Risk Tenant" },
    ],
    ruleSets: [
      { ruleSetId: ids.ruleSetId, tenantId: ids.tenantId, name: "Checkout Risk" },
      { ruleSetId: ids.otherRuleSetId, tenantId: ids.otherTenantId, name: "Other Checkout Risk" },
    ],
    ruleVersions: [
      {
        ruleVersionId: ids.baseVersionId,
        ruleSetId: ids.ruleSetId,
        version: 1,
        state: "ACTIVE",
        rules: [rule()],
        reviewThreshold: 200,
        blockThreshold: 700,
        createdAt: at(-120_000),
        activatedAt: at(-90_000),
      },
      {
        ruleVersionId: ids.otherBaseVersionId,
        ruleSetId: ids.otherRuleSetId,
        version: 1,
        state: "ACTIVE",
        rules: [rule({ ruleId: "other-velocity" })],
        reviewThreshold: 200,
        blockThreshold: 700,
        createdAt: at(-120_000),
        activatedAt: at(-90_000),
      },
    ],
    riskEvents: [],
    assessments: [],
    ruleHits: [],
    reviewCases: [],
    reviewDecisions: [],
    ruleRollbacks: [],
    auditEntries: [],
  });

  return Object.freeze({
    at,
    event,
    ids,
    key,
    remediationRange: Object.freeze({ occurredFrom: at(-1_000), occurredTo: at(86_400_000) }),
    rule,
    seed,
    uuid,
    workedRules,
  });
}
