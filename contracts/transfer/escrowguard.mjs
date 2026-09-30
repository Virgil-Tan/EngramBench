// Author wire contract, derived only from the unchanged public README and Manager increment.
import { finish, record, obj, ref, list, nullable, text, name, uuid, int, pos, nat, time, currency, en, empty, page, pagination, operation as op, domainEventsOperation, detailedTransportErrors, id, admin, idem, snapshotSmoke } from '../learning/helpers-b.mjs';

const uid = n => id(101, n), at = '2026-01-01T00:00:00.000Z', future = '2099-01-01T00:00:00.000Z';
const schemas = {
  Party: record('partyId:uuid displayName:string'),
  Escrow: record('escrowId:uuid buyerId:uuid sellerId:uuid currency:currency totalMinor:pos availableMinor:nat releasedMinor:nat refundedMinor:nat state:FUNDED|ACTIVE|DISPUTED|RELEASED|REFUNDED expiresAt:timestamp createdAt:timestamp terminalAt:timestamp|null sequence:nat'),
  Milestone: record('milestoneId:uuid escrowId:uuid ordinal:pos title:string amountMinor:pos state:PENDING|SUBMITTED|ACCEPTED|DISPUTED|RELEASED|REFUNDED submittedAt:timestamp|null decidedAt:timestamp|null releasedAt:timestamp|null'),
  Dispute: record('disputeId:uuid escrowId:uuid milestoneId:uuid openedBy:BUYER|SELLER reason:string state:OPEN|RESOLVED_RELEASE|RESOLVED_REFUND openedAt:timestamp resolvedAt:timestamp|null resolutionNote:string|null'),
  LegacyRelease: record('releaseId:uuid escrowId:uuid milestoneId:uuid sellerId:uuid amountMinor:pos createdAt:timestamp'),
  BeneficiaryShare: record('beneficiaryShareId:uuid milestoneId:uuid ordinal:pos beneficiaryId:uuid amountMinor:pos'),
  BeneficiaryPayout: record('payoutId:uuid releaseId:uuid beneficiaryShareId:uuid beneficiaryId:uuid amountMinor:pos createdAt:timestamp'),
  FundPosition: record('totalMinor:pos availableMinor:nat releasedMinor:nat refundedMinor:nat'),
};
schemas.Release = obj({ ...schemas.LegacyRelease.properties, payouts: list(ref('BeneficiaryPayout')) });
schemas.ReleaseResponse = { anyOf: [ref('LegacyRelease'), ref('Release')] };
schemas.EscrowDetail = obj({ ...schemas.Escrow.properties, milestones: list(ref('Milestone')), dispute: nullable(ref('Dispute')), releases: list(ref('ReleaseResponse')), fundPosition: ref('FundPosition'), beneficiaryShares: list(ref('BeneficiaryShare')), beneficiaryPayouts: list(ref('BeneficiaryPayout')) });
const shareInput = obj({ beneficiaryId: uuid, amountMinor: int });
const milestoneInput = obj({ title: text, amountMinor: int, beneficiaries: list(shareInput) }, ['title', 'amountMinor']);
// Published domain-specific errors (INVALID_ESCROW_TOTAL / INVALID_BENEFICIARY_ALLOCATION)
// govern exact counts, signs, currency syntax and sums; wire validation checks scalar types.
schemas.CreateEscrow = obj({ buyerId: uuid, sellerId: uuid, currency: text, totalMinor: int, expiresAt: time, milestones: list(milestoneInput) });
const createBody = { buyerId: uid(1), sellerId: uid(2), currency: 'USD', totalMinor: 1200, expiresAt: future, milestones: [{ title: 'Public delivery', amountMinor: 1200, beneficiaries: [{ beneficiaryId: uid(2), amountMinor: 800 }, { beneficiaryId: uid(3), amountMinor: 400 }] }] };
const seedTypes = { parties: 'Party', escrows: 'Escrow', milestones: 'Milestone', disputes: 'Dispute', releases: 'LegacyRelease' };
const operations = [
  op('list-escrows', 'GET', '/api/v1/escrows', null, page(ref('Escrow')), { parameters: pagination }),
  op('create-escrow', 'POST', '/api/v1/escrows', ref('CreateEscrow'), ref('Escrow'), { status: 201, example: { body: createBody } }),
  op('read-escrow', 'GET', '/api/v1/escrows/:escrowId', null, ref('EscrowDetail')),
  op('submit-milestone', 'POST', '/api/v1/escrows/:escrowId/milestones/:milestoneId/submit', obj({ evidence: ref('Json') }), obj({ milestone: ref('Milestone'), escrow: ref('Escrow') }), { example: { body: { evidence: { description: 'Public delivery evidence' } } } }),
  op('accept-milestone', 'POST', '/api/v1/escrows/:escrowId/milestones/:milestoneId/accept', empty, ref('ReleaseResponse')),
  op('open-dispute', 'POST', '/api/v1/escrows/:escrowId/milestones/:milestoneId/disputes', obj({ openedBy: en('BUYER', 'SELLER'), reason: text }), ref('Dispute'), { example: { body: { openedBy: 'BUYER', reason: 'Public review request' } } }),
  op('resolve-dispute', 'POST', '/api/v1/admin/disputes/:disputeId/resolve', obj({ decision: en('RELEASE', 'REFUND'), note: text }), ref('Dispute'), { parameters: [{ name: 'Authorization', in: 'header', required: true, schema: { ...text, pattern: '^Bearer .+$' } }], example: { body: { decision: 'REFUND', note: 'Public resolution' } } }),
  domainEventsOperation(),
];
const contract = finish({ taskId: 'escrowguard', title: 'EscrowGuard', schemas, seedTypes, operations,
  resources: { ...seedTypes, releases: 'ReleaseResponse', beneficiaryShares: 'BeneficiaryShare', beneficiaryPayouts: 'BeneficiaryPayout' },
  seedData: {
    parties: [{ partyId: uid(1), displayName: 'Public buyer' }, { partyId: uid(2), displayName: 'Public seller' }, { partyId: uid(3), displayName: 'Public beneficiary' }],
    escrows: [{ escrowId: uid(4), buyerId: uid(1), sellerId: uid(2), currency: 'USD', totalMinor: 900, availableMinor: 900, releasedMinor: 0, refundedMinor: 0, state: 'FUNDED', expiresAt: future, createdAt: at, terminalAt: null, sequence: 0 }],
    milestones: [{ milestoneId: uid(5), escrowId: uid(4), ordinal: 1, title: 'Public seeded milestone', amountMinor: 900, state: 'PENDING', submittedAt: null, decidedAt: null, releasedAt: null }],
  },
  workKinds: ['ESCROW_EXPIRY'], eventTypes: ['escrow.funded', 'milestone.submitted', 'milestone.released', 'dispute.opened', 'dispute.resolved', 'escrow.refunded'], emptyEventPayload: true,
  transportErrors: detailedTransportErrors, environmentVariables: ['CHROMIUM_PATH', 'MANAGED_DATA_ROOT'],
  smoke: [
    snapshotSmoke([['escrows', { escrowId: uid(4), availableMinor: 900 }], ['milestones', { milestoneId: uid(5), escrowId: uid(4), ordinal: 1 }]]),
    { operationId: 'create-escrow', body: createBody, headers: idem('escrow-create'), expectStatus: 201, expectBody: { state: 'FUNDED', totalMinor: 1200 }, capture: { createdEscrowId: ['escrowId'] } },
    { operationId: 'read-escrow', params: { escrowId: '${createdEscrowId}' }, expectStatus: 200, expectBody: { escrowId: '${createdEscrowId}', availableMinor: 1200 }, expectContains: [{ path: ['milestones'], match: { ordinal: 1, title: 'Public delivery', amountMinor: 1200 } }], capture: { createdMilestoneId: ['milestones', 0, 'milestoneId'] } },
    { operationId: 'submit-milestone', params: { escrowId: '${createdEscrowId}', milestoneId: '${createdMilestoneId}' }, body: { evidence: { description: 'Public accepted delivery' } }, headers: idem('escrow-submit'), expectStatus: 200, expectBody: { milestone: { milestoneId: '${createdMilestoneId}', state: 'SUBMITTED' }, escrow: { escrowId: '${createdEscrowId}' } } },
    { operationId: 'read-escrow', params: { escrowId: '${createdEscrowId}' }, expectStatus: 200, expectContains: [{ path: ['milestones'], match: { milestoneId: '${createdMilestoneId}', state: 'SUBMITTED' } }, { path: ['beneficiaryShares'], match: { milestoneId: '${createdMilestoneId}', beneficiaryId: uid(3), amountMinor: 400 } }] },
    { operationId: 'create-escrow', body: { ...createBody, unknown: true }, headers: idem('escrow-unknown'), expectStatus: 400, expectBody: { error: { code: 'UNKNOWN_FIELD' } } },
  ],
  notes: [
    'V2 wire clarification: GET Escrow detail is the top-level Escrow plus milestones, dispute (current open Dispute or null), releases, fundPosition, beneficiaryShares and beneficiaryPayouts. FundPosition has totalMinor,availableMinor,releasedMinor,refundedMinor and equals the Escrow amounts. Submit returns {milestone,escrow}; accept returns Release; dispute creation/resolution return Dispute. Collections use {items,nextCursor}.',
    'Evidence is explicitly RFC 8785 JSON, not an invented evidence-resource schema. Escrow and beneficiary count/sign/sum/currency rules retain their named business errors; schema only enforces their JSON scalar types. Unknown keys remain UNKNOWN_FIELD.',
    'ReleaseResponse permits only the exact V1 Release or its exact Manager extension with payouts. Previously saved V1 replay bodies remain unchanged; a new multi-beneficiary release includes all ordered payouts. Manager snapshot collections expose every captured share and payout.',
    'The public seed is V1 only: three Parties plus a funded Escrow and one pending Milestone with exactly conserved value. Migration creates its one Seller share. No Manager-only seed members, worker implementation or settlement algorithm is provided.',
    'All original role authorization, conservation, escrow/dispute/expiry races, migration identities, UI and fixed performance obligations remain mandatory. No new event types or payload members are introduced.',
  ],
});
contract.httpHost = '127.0.0.1';
contract.seed.replay = true;
contract.schemas.Error.properties.error.properties.details = empty;
for (const operation of contract.operations) {
  if (operation.id === 'domain-events') for (const parameter of operation.parameters ?? []) if (parameter.name === 'aggregateId') parameter.required = false;
  operation.source = 'docs/frontal-legacy/README.md; docs/frontal-legacy/manager-requirements.md; contract/README.md (V2 wire clarification)';
  operation.errors = Object.fromEntries([400, 401, 404, 409, 415].map(status => [status, ref('Error')]));
}
contract.schemas.Error.properties.error.properties.code.examples = ['INVALID_ESCROW_TOTAL', 'MILESTONE_NOT_CURRENT', 'MILESTONE_NOT_SUBMITTED', 'ESCROW_DISPUTED', 'ESCROW_TERMINAL', 'INVALID_BENEFICIARY_ALLOCATION', 'BENEFICIARY_PAYOUT_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_CURSOR'];
contract.operations.find(operation => operation.id === 'create-escrow').bodyTransportErrors = [
  {
    "path": "/totalMinor",
    "when": "unsafe_integer",
    "status": 400,
    "code": "INVALID_ESCROW_TOTAL"
  },
  {
    "path": "/milestones/*/amountMinor",
    "when": "unsafe_integer",
    "status": 400,
    "code": "INVALID_ESCROW_TOTAL"
  },
  {
    "path": "/milestones/*/beneficiaries/*/amountMinor",
    "when": "unsafe_integer",
    "status": 400,
    "code": "INVALID_BENEFICIARY_ALLOCATION"
  }
];
export default contract;
