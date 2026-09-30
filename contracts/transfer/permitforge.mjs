// Public README + Manager wire only; no private fixtures or historical submission adapters.
import { readFileSync } from 'node:fs';
import { finish, record, obj, ref, list, nullable, text, name, uuid, int, pos, time, en, page, pagination, operation as op, domainEventsOperation, detailedTransportErrors, id, digest, idem, admin, snapshotSmoke } from '../learning/helpers-b.mjs';
const uid = n => id(102, n), at = '2026-01-01T00:00:00.000Z', decided = '2026-01-01T01:00:00.000Z', deadline = '2026-01-02T00:00:00.000Z';
const policy = { roles: [{ role: 'safety', eligibleReviewerIds: [uid(2)], requiredApprovals: 1, veto: false }], requiredTotalApprovals: 1 };
const fields = { project: 'Public canopy' }, canonicalDigest = digest(fields);
const role = obj({ role: text, eligibleReviewerIds: list(uuid), requiredApprovals: int, veto: { type: 'boolean' } });
const stageName = { ...text, minLength: 1, pattern: '\\S', description: 'Must contain a non-whitespace character. Duplicate names are allowed; preserve the supplied name.' };
const schemas = {
  Applicant: record('applicantId:uuid name:string'), Reviewer: record('reviewerId:uuid name:string roles:[string]'),
  ReviewPolicy: obj({ roles: list(role), requiredTotalApprovals: int }),
  LegacyPermitApplication: record('applicationId:uuid applicantId:uuid permitType:string currentRevision:pos state:SUBMITTED|UNDER_REVIEW|APPROVED|REJECTED|CHANGES_REQUIRED|EXPIRED decisionRevision:pos|null submittedAt:timestamp deadlineAt:timestamp terminalAt:timestamp|null sequence:nat'),
  ApplicationRevision: record('applicationId:uuid revision:pos fields:json canonicalDigest:sha256 policy:ReviewPolicy createdAt:timestamp'),
  ReviewClaim: record('claimId:uuid applicationId:uuid revision:pos reviewerId:uuid role:string state:LEASED|DECIDED|EXPIRED attempt:pos leaseExpiresAt:timestamp|null'),
  ReviewDecision: record('decisionId:uuid applicationId:uuid revision:pos reviewerId:uuid role:string decision:APPROVE|REJECT|REQUEST_CHANGES reason:string decidedAt:timestamp'),
  ApprovedPermit: record('permitId:uuid applicationId:uuid revision:pos canonicalDigest:sha256 issuedAt:timestamp'),
  ReviewStage: record('stageId:uuid applicationId:uuid revision:pos ordinal:pos name:string state:PENDING|ACTIVE|COMPLETED|TERMINAL policy:ReviewPolicy activatedAt:timestamp|null completedAt:timestamp|null'),
};
schemas.PermitApplication = obj({ ...schemas.LegacyPermitApplication.properties, currentStageOrdinal: nullable(pos), stages: list(ref('ReviewStage')) });
schemas.ReviewStage.properties.name = stageName;
schemas.StageEvidence = obj({ stageId: uuid, claimIds: { ...list(uuid), uniqueItems: true }, decisionIds: { ...list(uuid), uniqueItems: true } });
schemas.ApplicationResponse = { anyOf: [ref('LegacyPermitApplication'), ref('PermitApplication')] };
schemas.ClaimResponse = obj({ ...schemas.ReviewClaim.properties, claimToken: name });
schemas.ApplicationDetail = obj({ permitApplication: ref('ApplicationResponse'), applicationRevision: ref('ApplicationRevision'), reviewPolicy: ref('ReviewPolicy'), reviewClaims: list(ref('ReviewClaim')), reviewDecisions: list(ref('ReviewDecision')), approvedPermit: nullable(ref('ApprovedPermit')) });
const stageInput = obj({ name: stageName, reviewPolicy: ref('ReviewPolicy') });
// Selection/count/quota validity uses the named domain errors, after wire type checks.
const applicationInput = { applicantId: uuid, permitType: text, fields: ref('Json'), deadlineAt: time, reviewPolicy: ref('ReviewPolicy'), stages: list(stageInput) };
schemas.CreateApplication = obj(applicationInput, ['applicantId', 'permitType', 'fields', 'deadlineAt']);
schemas.ReplaceRevision = obj({ expectedRevision: int, fields: ref('Json'), deadlineAt: time, reviewPolicy: ref('ReviewPolicy'), stages: list(stageInput) }, ['expectedRevision', 'fields', 'deadlineAt']);
const createBody = { applicantId: uid(1), permitType: 'CANOPY', fields: { project: 'Public new canopy' }, deadlineAt: deadline, stages: [{ name: 'Public review', reviewPolicy: policy }, { name: 'Public review', reviewPolicy: policy }] };
const seedTypes = { applicants: 'Applicant', reviewers: 'Reviewer', permitApplications: 'LegacyPermitApplication', applicationRevisions: 'ApplicationRevision', reviewClaims: 'ReviewClaim', reviewDecisions: 'ReviewDecision', approvedPermits: 'ApprovedPermit' };
const operations = [
  op('list-applications', 'GET', '/api/v1/permitApplications', null, page(ref('ApplicationResponse')), { parameters: pagination }),
  op('read-application-legacy-path', 'GET', '/api/v1/permitApplications/:permitApplicationId', null, ref('ApplicationDetail')),
  op('create-application', 'POST', '/api/v1/permit-applications', ref('CreateApplication'), ref('ApplicationResponse'), { status: 201, example: { body: createBody } }),
  op('claim-review', 'POST', '/api/v1/permit-applications/:applicationId/review-claims', obj({ reviewerId: uuid, role: text }), ref('ClaimResponse'), { example: { body: { reviewerId: uid(2), role: 'safety' } } }),
  op('decide-review', 'POST', '/api/v1/review-claims/:claimId/decisions', obj({ claimToken: name, decision: en('APPROVE', 'REJECT', 'REQUEST_CHANGES'), reason: text }), ref('ApplicationResponse'), { example: { body: { claimToken: 'public-example-fence', decision: 'APPROVE', reason: 'Public evidence accepted' } } }),
  op('replace-revision', 'POST', '/api/v1/permit-applications/:applicationId/revisions', ref('ReplaceRevision'), ref('ApplicationRevision'), { example: { body: { expectedRevision: 1, fields: { project: 'Public revised canopy' }, deadlineAt: deadline, reviewPolicy: policy } } }),
  op('read-application', 'GET', '/api/v1/permit-applications/:applicationId', null, ref('ApplicationDetail')),
  op('read-revision', 'GET', '/api/v1/permit-applications/:applicationId/revisions/:revision', null, ref('ApplicationRevision'), { parameters: [{ name: 'revision', in: 'path', required: true, schema: pos }] }),
  op('read-stages', 'GET', '/api/v1/permit-applications/:applicationId/stages', null, obj({ items: list(ref('ReviewStage')), evidence: list(ref('StageEvidence')) })),
  domainEventsOperation(),
];
const seedCheck = snapshotSmoke([['permitApplications', { applicationId: uid(3), state: 'APPROVED', decisionRevision: 1 }], ['applicationRevisions', { applicationId: uid(3), revision: 1, canonicalDigest }], ['approvedPermits', { permitId: uid(6), applicationId: uid(3), canonicalDigest }]]);
seedCheck.capture = { publicClock: ['asOf'] };
const contract = finish({ taskId: 'permitforge', title: 'PermitForge', schemas, seedTypes, operations,
  resources: { ...seedTypes, permitApplications: 'ApplicationResponse', reviewStages: 'ReviewStage' },
  seedData: {
    applicants: [{ applicantId: uid(1), name: 'Public applicant' }], reviewers: [{ reviewerId: uid(2), name: 'Public reviewer', roles: ['safety'] }],
    permitApplications: [{ applicationId: uid(3), applicantId: uid(1), permitType: 'CANOPY', currentRevision: 1, state: 'APPROVED', decisionRevision: 1, submittedAt: at, deadlineAt: deadline, terminalAt: decided, sequence: 0 }],
    applicationRevisions: [{ applicationId: uid(3), revision: 1, fields, canonicalDigest, policy, createdAt: at }],
    reviewClaims: [{ claimId: uid(4), applicationId: uid(3), revision: 1, reviewerId: uid(2), role: 'safety', state: 'DECIDED', attempt: 1, leaseExpiresAt: null }],
    reviewDecisions: [{ decisionId: uid(5), applicationId: uid(3), revision: 1, reviewerId: uid(2), role: 'safety', decision: 'APPROVE', reason: 'Public seeded approval', decidedAt: decided }],
    approvedPermits: [{ permitId: uid(6), applicationId: uid(3), revision: 1, canonicalDigest, issuedAt: decided }],
  },
  workKinds: ['PERMIT_DEADLINE'], eventTypes: ['application.submitted', 'review.claimed', 'review.decided', 'application.changes-requested', 'application.approved', 'application.rejected', 'application.expired'], emptyEventPayload: true,
  transportErrors: detailedTransportErrors, environmentVariables: ['CHROMIUM_PATH', 'MANAGED_DATA_ROOT'],
  smoke: [seedCheck,
    { operationId: 'create-application', body: { ...createBody, deadlineAt: '${publicClock+3600000ms}' }, headers: idem('permit-create'), expectStatus: 201, expectBody: { currentRevision: 1, currentStageOrdinal: 1, state: 'SUBMITTED' }, capture: { createdApplicationId: ['applicationId'] } },
    { operationId: 'read-application', params: { applicationId: '${createdApplicationId}' }, expectStatus: 200, expectBody: { permitApplication: { applicationId: '${createdApplicationId}', currentRevision: 1 }, applicationRevision: { applicationId: '${createdApplicationId}', fields: { project: 'Public new canopy' } } } },
    { operationId: 'read-stages', params: { applicationId: '${createdApplicationId}' }, expectStatus: 200, expectContains: [{ path: ['items'], match: { applicationId: '${createdApplicationId}', ordinal: 1, state: 'ACTIVE', name: 'Public review' } }, { path: ['items'], match: { applicationId: '${createdApplicationId}', ordinal: 2, state: 'PENDING', name: 'Public review' } }], capture: { firstStageId: ['items', 0, 'stageId'], secondStageId: ['items', 1, 'stageId'] } },
    { operationId: 'claim-review', params: { applicationId: '${createdApplicationId}' }, body: { reviewerId: uid(2), role: 'safety' }, headers: idem('permit-first-claim'), expectStatus: 200, capture: { firstClaimId: ['claimId'], firstClaimToken: ['claimToken'] } },
    { operationId: 'decide-review', params: { claimId: '${firstClaimId}' }, body: { claimToken: '${firstClaimToken}', decision: 'APPROVE', reason: 'Public Stage 1 approval' }, headers: idem('permit-first-decision'), expectStatus: 200, expectBody: { applicationId: '${createdApplicationId}', currentStageOrdinal: 2 } },
    { operationId: 'read-stages', params: { applicationId: '${createdApplicationId}' }, expectStatus: 200, expectContains: [{ path: ['items'], match: { stageId: '${firstStageId}', state: 'COMPLETED' } }, { path: ['items'], match: { stageId: '${secondStageId}', state: 'ACTIVE' } }, { path: ['evidence'], match: { stageId: '${firstStageId}', claimIds: ['${firstClaimId}'] } }] },
    { operationId: 'claim-review', params: { applicationId: '${createdApplicationId}' }, body: { reviewerId: uid(2), role: 'safety' }, headers: idem('permit-second-claim'), expectStatus: 200, capture: { secondClaimId: ['claimId'], secondClaimToken: ['claimToken'] } },
    { operationId: 'decide-review', params: { claimId: '${secondClaimId}' }, body: { claimToken: '${secondClaimToken}', decision: 'APPROVE', reason: 'Public Stage 2 approval' }, headers: idem('permit-second-decision'), expectStatus: 200, expectBody: { applicationId: '${createdApplicationId}', state: 'APPROVED', decisionRevision: 1 } },
    { operationId: 'read-stages', params: { applicationId: '${createdApplicationId}' }, expectStatus: 200, expectContains: [{ path: ['items'], match: { stageId: '${firstStageId}', state: 'COMPLETED' } }, { path: ['items'], match: { stageId: '${secondStageId}', state: 'COMPLETED' } }, { path: ['evidence'], match: { stageId: '${firstStageId}', claimIds: ['${firstClaimId}'] } }, { path: ['evidence'], match: { stageId: '${secondStageId}', claimIds: ['${secondClaimId}'] } }] },
    { operationId: 'verification-snapshot', headers: admin, expectStatus: 200, expectContains: [{ path: ['resources', 'permitApplications'], match: { applicationId: '${createdApplicationId}', currentRevision: 1 } }, { path: ['resources', 'applicationRevisions'], match: { applicationId: '${createdApplicationId}', revision: 1, fields: { project: 'Public new canopy' } } }] },
    { operationId: 'create-application', body: { ...createBody, deadlineAt: '${publicClock+3600000ms}', unknown: true }, headers: idem('permit-unknown'), expectStatus: 400, expectBody: { error: { code: 'UNKNOWN_FIELD' } } },
    ...['', ' \t\n'].map((name, index) => ({ operationId: 'create-application', body: { ...createBody, deadlineAt: '${publicClock+3600000ms}', stages: [{ name, reviewPolicy: policy }] }, headers: idem(`permit-invalid-name-${index}`), expectStatus: 400, expectBody: { error: { code: 'INVALID_REVIEW_STAGES' } } })),
  ],
  notes: [
    'V2 wire clarification: both literally documented camelCase read paths and kebab-case detail paths remain public. They return the same detail {permitApplication,applicationRevision,reviewPolicy,reviewClaims,reviewDecisions,approvedPermit}; the approvedPermit is null until approval. Creation/decision return PermitApplication; replacement returns the newly created ApplicationRevision.',
    'V2 wire clarification: successful claim adds claimToken:string to the closed ReviewClaim response. The token is required to invoke the published decision API and is omitted recursively from snapshots and event evidence; this does not provide the token generation/fencing algorithm.',
    'Submission and replacement must choose exactly one reviewPolicy or stages. Empty/mixed forms, counts and quotas retain INVALID_REVIEW_POLICY or INVALID_REVIEW_STAGES; JSON schemas publish the possible fields without turning those named domain errors into generic shape errors. Revision replacement captures the selected policy/stages under the same Manager semantics as submission.',
    'The exact V1 PermitApplication and the exact Manager extension are distinct response alternatives so previously saved one-stage replay bodies remain unchanged. New staged submissions expose currentStageOrdinal and stages. No undocumented media negotiation is required by the V2 scaffold; the original unspecified legacy media-type contract remains a release-audit item.',
    'The V1 seed is a fully approved single-stage application, with Applicant, Reviewer, matching canonical fields/digest/policy, decided Claim, approval Decision and Permit. Migration derives its completed Stage 1. No Manager-only seed fields are added.',
    'Smoke uses captured snapshot.asOf plus one hour for a deadline within the public thirty-day rule. All quorum, current-stage fencing, immutable evidence, compatibility, recovery and fixed performance requirements remain implementation obligations.',
  ],
});
contract.httpHost = '127.0.0.1'; contract.seed.replay = true;
contract.schemas.Error.properties.error.properties.details = obj({});
for (const operation of contract.operations) {
  if (operation.id === 'domain-events') for (const parameter of operation.parameters ?? []) if (parameter.name === 'aggregateId') parameter.required = false;
  operation.source = 'docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification)';
  operation.errors = Object.fromEntries([400, 401, 404, 409, 415].map(status => [status, ref('Error')]));
}
contract.schemas.Error.properties.error.properties.code.examples = ['INVALID_REVIEW_POLICY', 'APPLICATION_REVISION_CHANGED', 'REVIEW_SLOT_UNAVAILABLE', 'REVIEW_LEASE_LOST', 'APPLICATION_TERMINAL', 'INVALID_REVIEW_STAGES', 'REVIEW_STAGE_CHANGED', 'IDEMPOTENCY_CONFLICT', 'INVALID_CURSOR'];
for (const operation of contract.operations.filter(item => ['create-application', 'replace-revision'].includes(item.id))) operation.bodyTransportErrors = [{ path: '/stages/*/name', status: 400, code: 'INVALID_REVIEW_STAGES' }];
contract.policyRevision = 'permitforge-stage-review-v1';
contract.notes.push(readFileSync(new URL('./permitforge-policy.md', import.meta.url), 'utf8'));
export default contract;
