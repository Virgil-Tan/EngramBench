import { createHash } from "node:crypto";

import { canonicalJson, sha256 } from "../oracles/index.mjs";

function digest(...parts) {
  return createHash("sha256").update(parts.join("\0")).digest();
}

function uuidFrom(buffer) {
  const bytes = Buffer.from(buffer.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createFixtureFactory({ evaluationSeed, caseId, baseTime }) {
  const namespace = `permitforge\0${evaluationSeed}\0${caseId}`;
  const uuid = (label) => uuidFrom(digest(namespace, "uuid", label));
  const key = (label) => `pf-${digest(namespace, "key", label).toString("hex").slice(0, 48)}`;
  const at = ({ milliseconds = 0, seconds = 0, minutes = 0, hours = 0, days = 0 } = {}) =>
    new Date(Date.parse(baseTime) + (((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1_000) + milliseconds).toISOString();

  const applicants = [
    { applicantId: uuid("applicant:primary"), name: "PermitForge Applicant" },
    { applicantId: uuid("applicant:other"), name: "Other Applicant" },
  ];
  const reviewers = [
    ...Array.from({ length: 3 }, (_, index) => ({ reviewerId: uuid(`reviewer:security:${index}`), name: `Security Reviewer ${index + 1}`, roles: ["security"] })),
    ...Array.from({ length: 2 }, (_, index) => ({ reviewerId: uuid(`reviewer:legal:${index}`), name: `Legal Reviewer ${index + 1}`, roles: ["legal"] })),
  ].sort((left, right) => left.reviewerId.localeCompare(right.reviewerId));
  const securityReviewers = reviewers.filter(({ roles }) => roles.includes("security"));
  const legalReviewers = reviewers.filter(({ roles }) => roles.includes("legal"));
  const policy = Object.freeze({
    roles: [
      { role: "legal", eligibleReviewerIds: legalReviewers.map(({ reviewerId }) => reviewerId).sort(), requiredApprovals: 1, veto: false },
      { role: "security", eligibleReviewerIds: securityReviewers.map(({ reviewerId }) => reviewerId).sort(), requiredApprovals: 2, veto: true },
    ],
    requiredTotalApprovals: 3,
  });
  const strictLegalPolicy = Object.freeze({
    roles: [{ role: "legal", eligibleReviewerIds: legalReviewers.map(({ reviewerId }) => reviewerId).sort(), requiredApprovals: 2, veto: false }],
    requiredTotalApprovals: 2,
  });

  const emptySeed = (seedVersion = `${caseId.toLowerCase()}-empty`) => ({
    schemaVersion: 1,
    seedVersion,
    applicants: [],
    reviewers: [],
    permitApplications: [],
    applicationRevisions: [],
    reviewClaims: [],
    reviewDecisions: [],
    approvedPermits: [],
  });

  function submissionBody(label = "submission", overrides = {}) {
    const fields = overrides.fields ?? { address: `${label} Main Street`, district: "north", units: 7 };
    return {
      applicantId: overrides.applicantId ?? applicants[0].applicantId,
      permitType: overrides.permitType ?? "CONSTRUCTION",
      fields,
      deadlineAt: overrides.deadlineAt ?? at({ days: 2 }),
      reviewPolicy: overrides.reviewPolicy ?? structuredClone(policy),
      ...Object.fromEntries(Object.entries(overrides).filter(([name]) => !["fields", "applicantId", "permitType", "deadlineAt", "reviewPolicy"].includes(name))),
    };
  }

  function stagedBody(count, label = `staged-${count}`, overrides = {}) {
    const names = ["Intake", "Technical", "Legal", "Executive", "Issue"];
    const base = submissionBody(label);
    delete base.reviewPolicy;
    return {
      ...base,
      stages: Array.from({ length: count }, (_, index) => ({ name: names[index], reviewPolicy: structuredClone(index % 2 === 0 ? policy : strictLegalPolicy) })),
      ...overrides,
    };
  }

  function history(label = "main", kind = "SUBMITTED", options = {}) {
    const applicationId = uuid(`application:${label}`);
    const fields = options.fields ?? { address: `${label} Avenue`, district: "central", units: 3 };
    const selectedPolicy = options.policy ?? policy;
    const revision = {
      applicationId,
      revision: 1,
      fields: structuredClone(fields),
      canonicalDigest: sha256(canonicalJson(fields)),
      policy: structuredClone(selectedPolicy),
      createdAt: at({ days: -2 }),
    };
    const claims = [];
    const decisions = [];
    const addDecision = (reviewer, role, decision, ordinal) => {
      claims.push({ claimId: uuid(`claim:${label}:${ordinal}`), applicationId, revision: 1, reviewerId: reviewer.reviewerId, role, state: "DECIDED", attempt: 1, leaseExpiresAt: null });
      decisions.push({ decisionId: uuid(`decision:${label}:${ordinal}`), applicationId, revision: 1, reviewerId: reviewer.reviewerId, role, decision, reason: `${kind.toLowerCase()}-${ordinal}`, decidedAt: at({ days: -1, milliseconds: ordinal }) });
    };
    if (kind === "APPROVED") {
      addDecision(securityReviewers[0], "security", "APPROVE", 1);
      addDecision(securityReviewers[1], "security", "APPROVE", 2);
      addDecision(legalReviewers[0], "legal", "APPROVE", 3);
    } else if (kind === "VETO_REJECTED") addDecision(securityReviewers[0], "security", "REJECT", 1);
    else if (kind === "REACHABLE") addDecision(legalReviewers[0], "legal", "REJECT", 1);
    else if (kind === "IMPOSSIBLE_REJECTED") addDecision(legalReviewers[0], "legal", "REJECT", 1);
    else if (kind === "CHANGES_REQUIRED") addDecision(securityReviewers[0], "security", "REQUEST_CHANGES", 1);
    const state = {
      VETO_REJECTED: "REJECTED",
      IMPOSSIBLE_REJECTED: "REJECTED",
      REACHABLE: "UNDER_REVIEW",
    }[kind] ?? kind;
    const terminal = ["APPROVED", "REJECTED", "EXPIRED"].includes(state);
    const application = {
      applicationId,
      applicantId: applicants[0].applicantId,
      permitType: "CONSTRUCTION",
      currentRevision: 1,
      state,
      decisionRevision: ["APPROVED", "REJECTED", "CHANGES_REQUIRED"].includes(state) ? 1 : null,
      submittedAt: at({ days: -2 }),
      deadlineAt: options.deadlineAt ?? at({ days: 2 }),
      terminalAt: terminal ? at({ days: -1, seconds: 1 }) : null,
      sequence: Math.max(1, 1 + claims.length * 2 + (state === "SUBMITTED" || state === "UNDER_REVIEW" ? 0 : 1)),
    };
    const permits = state === "APPROVED" ? [{ permitId: uuid(`permit:${label}`), applicationId, revision: 1, canonicalDigest: revision.canonicalDigest, issuedAt: at({ days: -1, seconds: 1 }) }] : [];
    return { application, revision, claims, decisions, permits };
  }

  function seedFromHistories(label, histories) {
    return {
      schemaVersion: 1,
      seedVersion: `${caseId.toLowerCase()}-${label}`,
      applicants: structuredClone(applicants),
      reviewers: structuredClone(reviewers),
      permitApplications: histories.map(({ application }) => application),
      applicationRevisions: histories.map(({ revision }) => revision),
      reviewClaims: histories.flatMap(({ claims }) => claims),
      reviewDecisions: histories.flatMap(({ decisions }) => decisions),
      approvedPermits: histories.flatMap(({ permits }) => permits),
    };
  }

  function main(label = "main", options = {}) {
    const item = history(label, options.kind ?? "SUBMITTED", options);
    return { fixtureFamily: "PF-F-V1-POLICY", applicants, reviewers, securityReviewers, legalReviewers, policy, strictLegalPolicy, ...item, seed: seedFromHistories(label, [item]) };
  }

  function projections() {
    const projected = (label, selectedPolicy, specifications) => {
      const item = history(label, "SUBMITTED", { policy: selectedPolicy });
      for (const [index, specification] of specifications.entries()) {
        const reviewer = specification.role === "security" ? securityReviewers[specification.reviewer] : legalReviewers[specification.reviewer];
        item.claims.push({ claimId: uuid(`claim:${label}:${index + 1}`), applicationId: item.application.applicationId, revision: 1, reviewerId: reviewer.reviewerId, role: specification.role, state: "DECIDED", attempt: 1, leaseExpiresAt: null });
        item.decisions.push({ decisionId: uuid(`decision:${label}:${index + 1}`), applicationId: item.application.applicationId, revision: 1, reviewerId: reviewer.reviewerId, role: specification.role, decision: specification.decision, reason: `${label}-${index + 1}`, decidedAt: at({ days: -1, milliseconds: index + 1 }) });
      }
      item.application.state = "UNDER_REVIEW";
      item.application.sequence = 1 + item.decisions.length * 2;
      return item;
    };
    const totalOnlyPolicy = {
      roles: [
        { role: "legal", eligibleReviewerIds: legalReviewers.map(({ reviewerId }) => reviewerId).sort(), requiredApprovals: 1, veto: false },
        { role: "security", eligibleReviewerIds: securityReviewers.map(({ reviewerId }) => reviewerId).sort(), requiredApprovals: 2, veto: true },
      ],
      requiredTotalApprovals: 2,
    };
    const rolesOnlyPolicy = {
      roles: [
        { role: "legal", eligibleReviewerIds: legalReviewers.map(({ reviewerId }) => reviewerId).sort(), requiredApprovals: 1, veto: false },
        { role: "security", eligibleReviewerIds: securityReviewers.map(({ reviewerId }) => reviewerId).sort(), requiredApprovals: 1, veto: true },
      ],
      requiredTotalApprovals: 4,
    };
    const histories = [
      history("approved", "APPROVED"),
      projected("total-only", totalOnlyPolicy, [
        { role: "security", reviewer: 0, decision: "APPROVE" },
        { role: "security", reviewer: 1, decision: "APPROVE" },
      ]),
      projected("roles-only", rolesOnlyPolicy, [
        { role: "security", reviewer: 0, decision: "APPROVE" },
        { role: "legal", reviewer: 0, decision: "APPROVE" },
      ]),
      history("veto", "VETO_REJECTED"),
      history("reachable", "REACHABLE"),
      history("impossible", "IMPOSSIBLE_REJECTED", { policy: strictLegalPolicy }),
      history("changes", "CHANGES_REQUIRED"),
    ];
    return { fixtureFamily: "PF-F-DECISIONS", applicants, reviewers, policy, strictLegalPolicy, totalOnlyPolicy, rolesOnlyPolicy, histories, seed: seedFromHistories("projections", histories) };
  }

  function pagination(total = 121) {
    const histories = Array.from({ length: total }, (_, index) => history(`page-${String(index).padStart(3, "0")}`, "SUBMITTED"));
    return { fixtureFamily: "PF-F-V1-POLICY", applicants, reviewers, histories, seed: seedFromHistories(`pagination-${total}`, histories) };
  }

  function changes(label = "changes") {
    return main(label, { kind: "CHANGES_REQUIRED" });
  }

  function due(label = "due") {
    return main(label, { kind: "SUBMITTED", deadlineAt: at({ days: -2 }) });
  }

  function event(label = "events") {
    const histories = [history(`${label}-submitted`, "SUBMITTED"), history(`${label}-changes`, "CHANGES_REQUIRED"), history(`${label}-expired`, "EXPIRED", { deadlineAt: at({ days: -1 }) })];
    return { fixtureFamily: "PF-F-WORK-EVENT", applicants, reviewers, histories, seed: seedFromHistories(label, histories) };
  }

  function idempotency(label = "idempotency") {
    return { ...main(label), fixtureFamily: "PF-F-IDEMPOTENCY", stagedBodies: [stagedBody(1, `${label}-one`), stagedBody(5, `${label}-five`)] };
  }

  function finalStages(label = "stages") {
    return { ...main(label), fixtureFamily: "PF-F-FINAL-STAGES", bodies: [stagedBody(1, `${label}-one`), stagedBody(2, `${label}-two`), stagedBody(5, `${label}-five`)] };
  }

  function migration() {
    const histories = [history("migration-submitted", "SUBMITTED"), history("migration-approved", "APPROVED"), history("migration-rejected", "VETO_REJECTED"), history("migration-changes", "CHANGES_REQUIRED"), history("migration-due", "SUBMITTED", { deadlineAt: at({ days: -2 }) })];
    return { fixtureFamily: "PF-F-MIGRATION", applicants, reviewers, histories, seed: seedFromHistories("migration-v1", histories), savedReplayKey: key("migration-saved-replay") };
  }

  function invalidSeeds(validSeed) {
    const valid = structuredClone(validSeed);
    const variants = [];
    const add = (label, mutate) => { const value = structuredClone(valid); value.seedVersion = `${valid.seedVersion}-${label}`; mutate(value); variants.push({ label, seed: value }); };
    add("unknown", (value) => { value.unknown = true; });
    add("duplicate", (value) => { value.applicants.push(structuredClone(value.applicants[0])); });
    add("broken-ref", (value) => { value.applicationRevisions[0].applicationId = uuid("missing-application"); });
    add("revision-gap", (value) => { value.applicationRevisions[0].revision = 2; });
    add("policy", (value) => { value.applicationRevisions[0].policy.roles[0].requiredApprovals = 99; });
    add("claim", (value) => { value.reviewClaims.push({ claimId: uuid("invalid-claim"), applicationId: value.permitApplications[0].applicationId, revision: 1, reviewerId: uuid("ineligible"), role: "legal", state: "LEASED", attempt: 1, leaseExpiresAt: at({ days: 1 }) }); });
    add("decision", (value) => { value.reviewDecisions.push({ decisionId: uuid("invalid-decision"), applicationId: value.permitApplications[0].applicationId, revision: 1, reviewerId: uuid("ineligible"), role: "legal", decision: "APPROVE", reason: "invalid", decidedAt: at() }); });
    add("state", (value) => { value.permitApplications[0].state = "APPROVED"; });
    add("time", (value) => { value.permitApplications[0].deadlineAt = "not-a-time"; });
    add("digest", (value) => { value.applicationRevisions[0].canonicalDigest = "0".repeat(64); });
    return variants;
  }

  function performance() {
    const spec = Object.freeze({
      applicants: 20_000,
      reviewers: 2_000,
      applications: 20_000,
      revisions: 20_000,
      claims: 20_000,
      dueWork: 10_000,
      read: { clients: 64, warmupMs: 10_000, measureMs: 60_000, minimumThroughput: 350, maximumP95Ms: 120 },
      submit: { clients: 64, warmupMs: 10_000, measureMs: 60_000, minimumThroughput: 100, maximumP95Ms: 350 },
      recovery: { workers: 2, applications: 10_000, deadlineMs: 75_000 },
    });
    const buildSeed = () => {
      const perfApplicants = Array.from({ length: spec.applicants }, (_, index) => ({ applicantId: uuid(`perf:applicant:${index}`), name: `Applicant ${index}` }));
      const perfReviewers = Array.from({ length: spec.reviewers }, (_, index) => ({ reviewerId: uuid(`perf:reviewer:${index}`), name: `Reviewer ${index}`, roles: ["reviewer"] }));
      const permitApplications = [];
      const applicationRevisions = [];
      const reviewClaims = [];
      for (let index = 0; index < spec.applications; index += 1) {
        const applicationId = uuid(`perf:application:${index}`);
        const reviewer = perfReviewers[index % perfReviewers.length];
        const selectedPolicy = { roles: [{ role: "reviewer", eligibleReviewerIds: [reviewer.reviewerId], requiredApprovals: 1, veto: false }], requiredTotalApprovals: 1 };
        const fields = { ordinal: index, stable: index < 10_000 };
        permitApplications.push({ applicationId, applicantId: perfApplicants[index].applicantId, permitType: "PERF", currentRevision: 1, state: "SUBMITTED", decisionRevision: null, submittedAt: at({ days: -3 }), deadlineAt: index < 10_000 ? at({ days: 7 }) : at({ days: -2 }), terminalAt: null, sequence: 1 });
        applicationRevisions.push({ applicationId, revision: 1, fields, canonicalDigest: sha256(canonicalJson(fields)), policy: selectedPolicy, createdAt: at({ days: -2 }) });
        reviewClaims.push({ claimId: uuid(`perf:claim:${index}`), applicationId, revision: 1, reviewerId: reviewer.reviewerId, role: "reviewer", state: "EXPIRED", attempt: 1, leaseExpiresAt: null });
      }
      return { schemaVersion: 1, seedVersion: "perf-v1", applicants: perfApplicants, reviewers: perfReviewers, permitApplications, applicationRevisions, reviewClaims, reviewDecisions: [], approvedPermits: [] };
    };
    return { fixtureFamily: "PF-F-PERF", spec, buildSeed };
  }

  return Object.freeze({ uuid, key, at, applicants, reviewers, securityReviewers, legalReviewers, policy, strictLegalPolicy, emptySeed, submissionBody, stagedBody, history, seedFromHistories, main, projections, pagination, changes, due, event, idempotency, finalStages, migration, invalidSeeds, browser: () => ({ ...finalStages("browser"), fixtureFamily: "PF-F-BROWSER" }), performance });
}
