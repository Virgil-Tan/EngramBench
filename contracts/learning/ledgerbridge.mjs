import { ref, obj, arr, one, nil, str, text, count, positive, uuid, time, currency, en, page, op, paging, manager, T, id, key, environmentVariables, commands, commonSchemas, snapshot, seedSchema, infra, observe, basicSmoke, seedSmoke, commonNotes } from './helpers-a2.mjs';

const schemas = {
  ...commonSchemas(['SETTLEMENT'], ['transfer.created', 'transfer.posted', 'transfer.cancelled', 'transfer.reversed']),
  Account: obj({ accountId: uuid, currency, openingBalanceMinor: count, balanceMinor: count, reservedMinor: count, availableMinor: count, revision: count }),
  TransferLeg: obj({ legId: uuid, destinationAccountId: uuid, amountMinor: positive, postingLegId: nil(uuid) }),
  Transfer: obj({ transferId: uuid, sourceAccountId: uuid, destinationAccountId: nil(uuid), currency, amountMinor: nil(positive), state: en('PENDING', 'POSTED', 'CANCELLED', 'REVERSED'), postingId: nil(uuid), reversalPostingId: nil(uuid), createdAt: time, postedAt: nil(time), cancelledAt: nil(time), reversedAt: nil(time), sequence: count, legs: arr(ref('TransferLeg'), { minItems: 1, maxItems: 20 }) }),
  LegacyPostingLeg: obj({ accountId: uuid, direction: en('DEBIT', 'CREDIT'), amountMinor: positive }),
  ManagerPostingLeg: obj({ postingLegId: uuid, legId: nil(uuid), accountId: uuid, direction: en('DEBIT', 'CREDIT'), amountMinor: positive }),
  StatementItem: obj({ postingId: uuid, transferId: uuid, kind: en('TRANSFER', 'REVERSAL'), direction: en('DEBIT', 'CREDIT'), amountMinor: positive, balanceAfterMinor: count, createdAt: time, legId: nil(uuid) }),
  SeedAccount: obj({ accountId: uuid, currency, openingBalanceMinor: count }),
  SeedTransfer: obj({ transferId: uuid, sourceAccountId: uuid, destinationAccountId: uuid, currency, amountMinor: positive, state: en('PENDING', 'POSTED', 'CANCELLED'), createdAt: time, terminalAt: nil(time) }),
};
schemas.Posting = obj({ postingId: uuid, transferId: uuid, kind: en('TRANSFER', 'REVERSAL'), legs: one(arr(ref('LegacyPostingLeg'), { minItems: 2, maxItems: 2 }), arr(ref('ManagerPostingLeg'), { minItems: 2, maxItems: 21 })), createdAt: time });
schemas.StatementPage = page(ref('StatementItem'));
schemas.Seed = seedSchema({ accounts: 'SeedAccount', transfers: 'SeedTransfer' });
schemas.VerificationSnapshot = snapshot({ accounts: 'Account', transfers: 'Transfer', postings: 'Posting' });
const sourceAccountId = id(31), destinationAccountId = id(32), otherAccountId = id(33), transferId = id(34);
const single = obj({ sourceAccountId: uuid, destinationAccountId: uuid, currency, amountMinor: positive });
const multiple = obj({ sourceAccountId: uuid, currency, legs: arr(obj({ destinationAccountId: uuid, amountMinor: positive }), { minItems: 1, maxItems: 20 }) });
const createBody = { sourceAccountId, currency: 'USD', legs: [{ destinationAccountId, amountMinor: 7 }, { destinationAccountId: otherAccountId, amountMinor: 3 }] };
export default {
  taskId: 'ledgerbridge', title: 'LedgerBridge', environmentVariables, commands,
  seed: { schema: schemas.Seed, example: { schemaVersion: 1, seedVersion: 'v2-public-ledgerbridge-1', accounts: [{ accountId: sourceAccountId, currency: 'USD', openingBalanceMinor: 1000 }, { accountId: destinationAccountId, currency: 'USD', openingBalanceMinor: 0 }, { accountId: otherAccountId, currency: 'USD', openingBalanceMinor: 0 }], transfers: [{ transferId, sourceAccountId, destinationAccountId, currency: 'USD', amountMinor: 5, state: 'CANCELLED', createdAt: T, terminalAt: T }] } }, schemas,
  operations: [
    ...infra(),
    op('list-transfers', 'GET', '/api/v1/transfers', 200, page(ref('Transfer')), undefined, { query: { limit: 20 } }, { parameters: paging }),
    op('read-transfer', 'GET', '/api/v1/transfers/:transferId', 200, ref('Transfer'), undefined, { params: { transferId } }, { source: manager }),
    op('create-transfer', 'POST', '/api/v1/transfers', 202, ref('Transfer'), one(single, multiple), { body: createBody }, { source: manager }),
    op('cancel-transfer', 'POST', '/api/v1/transfers/:transferId/cancel', 200, ref('Transfer'), obj({}), { params: { transferId }, body: {} }),
    op('reverse-transfer', 'POST', '/api/v1/transfers/:transferId/reverse', 202, ref('Transfer'), obj({ reason: text }), { params: { transferId }, body: { reason: 'Reverse the complete transfer' } }),
    op('account-statement', 'GET', '/api/v1/accounts/:accountId/statement', 200, ref('StatementPage'), undefined, { params: { accountId: sourceAccountId }, query: { limit: 20 } }, { source: manager, parameters: paging }),
    op('read-account', 'GET', '/api/v1/accounts/:accountId', 200, ref('Account'), undefined, { params: { accountId: sourceAccountId } }),
    ...observe(),
  ],
  smoke: [
    ...basicSmoke,
    seedSmoke({ accounts: [{ accountId: sourceAccountId, balanceMinor: 1000, reservedMinor: 0, availableMinor: 1000 }, { accountId: destinationAccountId, balanceMinor: 0 }, { accountId: otherAccountId, balanceMinor: 0 }], transfers: [{ transferId, state: 'CANCELLED', postingId: null }] }),
    { operationId: 'create-transfer', body: createBody, headers: key('create-transfer'), expectStatus: 202, expectBody: { sourceAccountId, destinationAccountId: null, amountMinor: null, currency: 'USD' }, capture: { createdTransfer: ['transferId'] } },
    { operationId: 'read-transfer', params: { transferId: '${createdTransfer}' }, expectStatus: 200, expectBody: { transferId: '${createdTransfer}', sourceAccountId, destinationAccountId: null, amountMinor: null }, expectContains: [{ path: ['legs'], match: { destinationAccountId, amountMinor: 7 } }, { path: ['legs'], match: { destinationAccountId: otherAccountId, amountMinor: 3 } }] },
  ],
  notes: [...commonNotes,
    'V2 wire clarification: fresh Transfer create/detail/list/cancel/reverse success bodies use the Manager-extended Transfer at top level; saved pre-migration replay bodies remain unchanged. A single destination preserves destinationAccountId and amountMinor; multiple destinations set both to null.',
    'V2 wire clarification: Account statement items add required legId:uuid|null. Source aggregate legs of multi-leg transfers use null; destination legs use their stable TransferLeg ID. One-leg statement entries expose that leg ID. One-leg Posting bodies retain their V1 two-leg shape; multi-leg Postings use the Manager shape and ordering.',
    'Seed stays V1: three funded same-currency Accounts and one CANCELLED Transfer with terminalAt. This avoids an invented derived posting UUID in the example while requiring real Transfer import and Manager leg migration. Cancelled history consumes no balance or reservation.',
    'Seed-derived POSTED posting and leg IDs must be deterministic, stable across replay and documented by the implementation; the original did not prescribe a UUID derivation algorithm. Smoke checks only published source identities and never assumes an unpublished derivation.',
    'Smoke verifies new two-destination input through a separate GET; it intentionally permits PENDING or POSTED because a real worker may settle before the read. Atomic posting/reversal, conservation and safe-integer sums remain required business checks.',
  ],
};
