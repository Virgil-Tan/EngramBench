import { createHash } from "node:crypto";

const RFC_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `${evaluationSeed}\0moderationflow\0${caseId}`;
  const at = (label, offsetMs = 0) => new Date(Date.parse(baseTime) + offsetMs + bounded(namespace, `time:${label}`, 10_000)).toISOString();
  const uuid = (label) => deterministicUuid(namespace, label);
  const digest = (value) => createHash("sha256").update(Buffer.isBuffer(value) ? value : String(value)).digest("hex");
  const key = (label) => `mf-${digest(`${namespace}\0key:${label}`).slice(0, 48)}`;

  function policyCategories(action = "ESCALATE") {
    return [
      { categoryCode: "ABUSE", severity: 80, level1Action: action },
      { categoryCode: "SAFE", severity: 0, level1Action: "ALLOW" },
    ];
  }

  function baseSeed(label = "base", options = {}) {
    const tenantId = uuid(`${label}:tenant`);
    const policyId = uuid(`${label}:policy`);
    const policyVersionId = uuid(`${label}:policy-version:1`);
    return {
      schemaVersion: 1,
      seedVersion: `mf-${label}-${digest(namespace).slice(0, 12)}`,
      importedAt: at(`${label}:import`, -86_400_000),
      tenants: [{ tenantId, name: `Tenant ${label}` }],
      policies: [{ policyId, tenantId, name: `Policy ${label}` }],
      policyVersions: [{ policyVersionId, policyId, version: 1, state: "ACTIVE", categories: policyCategories(options.action), createdAt: at(`${label}:policy-created`, -172_800_000), activatedAt: at(`${label}:policy-active`, -86_400_000) }],
      contentItems: [], evidenceVersions: [], moderationCases: [], reviewStages: [], moderationDecisions: [], appeals: [], auditEntries: [], auditCheckpoints: [],
    };
  }

  function submission(seed, label = "content", overrides = {}) {
    const text = overrides.text ?? `moderation fixture ${label}`;
    return {
      tenantId: seed.tenants[0].tenantId,
      externalContentId: `mf-${label}-${digest(namespace).slice(0, 8)}`,
      contentType: "POST",
      bodyDigest: digest(text),
      text,
      evidence: { kind: "SUBMISSION", digest: digest(`evidence:${label}`), summary: `submission ${label}`, createdBy: "hidden-evaluator" },
      ...overrides,
    };
  }

  function evidence(label, expectedHeadVersion, overrides = {}) {
    return {
      expectedHeadVersion,
      kind: "CONTEXT",
      digest: digest(`evidence:${label}:${expectedHeadVersion + 1}`),
      summary: `evidence ${label} ${expectedHeadVersion + 1}`,
      createdBy: "hidden-reviewer",
      ...overrides,
    };
  }

  function recallRequest({ tenantId, recalledPolicyVersionId, replacementPolicyVersionId }, label = "recall") {
    const decided = Date.parse(baseTime);
    return {
      tenantId,
      recalledPolicyVersionId,
      replacementPolicyVersionId,
      decidedFrom: new Date(decided - 60_000).toISOString(),
      decidedTo: new Date(decided + 60_000).toISOString(),
    };
  }

  return Object.freeze({
    namespace, at, uuid, digest, key, baseSeed, submission, evidence, policyCategories, recallRequest,
    performance: Object.freeze({
      ingest: Object.freeze({ requests: 50_000, concurrency: 96, minimumPerSecond: 250, p95Ms: 350 }),
      contention: Object.freeze({ operations: 20_000, concurrency: 64, minimumPerSecond: 150, p95Ms: 800 }),
      recall: Object.freeze({ members: 10_000, killedWorkers: 2, replacementWorkers: 4, maximumSeconds: 90 }),
    }),
  });
}

export function deterministicUuid(namespace, label) {
  const bytes = createHash("sha256").update(`${namespace}\0${label}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const value = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!RFC_UUID.test(value)) throw new Error("fixture UUID generation failed");
  return value;
}

function bounded(namespace, label, maximum) {
  return createHash("sha256").update(`${namespace}\0${label}`).digest().readUInt32BE(0) % maximum;
}
