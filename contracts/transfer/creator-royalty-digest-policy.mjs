// Public author policy and synthetic conformance vectors, not evaluator fixtures
// or a reference implementation of period close/accounting.
export const ROYALTY_DIGEST_REVISION = 'creator-royalty-digest-v1';
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const period = { tenantId: id(4), currency: 'USD', periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-01-02T00:00:00Z' };
const debit = { royaltyEntryId: id(1), postingId: id(3), tenantId: id(4), royaltyPeriodId: id(5), royaltyAccountId: id(6), ownerId: id(4), accountRole: 'PLATFORM_CLEARING', direction: 'DEBIT', amountMinor: 10, currency: 'USD', sourceType: 'LICENSE', sourceId: id(8), createdAt: '2026-01-01T00:00:00Z' };
const credit = { ...debit, royaltyEntryId: id(2), royaltyAccountId: id(7), ownerId: id(9), accountRole: 'CREATOR_PAYABLE', direction: 'CREDIT' };
const entries = [debit, credit];
const baseDigest = '5e6e4c120bc6d9c46a35c1c79316e2a7253b4333c27a448d4949f4c5ab056cfe';

export const royaltyDigestPolicy = {
  revision: ROYALTY_DIGEST_REVISION,
  algorithm: 'lowercaseHex(SHA256(UTF8(RFC8785(entries))))',
  scope: 'All committed RoyaltyEntries with entry.tenantId == period.tenantId, entry.currency == period.currency, and periodStart <= createdAt < periodEnd, comparing UTC instants. ownerId and royaltyPeriodId are not extra selection filters; royaltyPeriodId remains an authenticated field. Closing must not rewrite immutable entries to make the selection fit.',
  fields: ['royaltyEntryId', 'postingId', 'tenantId', 'royaltyPeriodId', 'royaltyAccountId', 'ownerId', 'accountRole', 'direction', 'amountMinor', 'currency', 'sourceType', 'sourceId', 'createdAt'],
  order: ['createdAt ascending by UTC instant with all fractional precision', 'royaltyEntryId ascending by UTF-8 byte order'],
  timestamp: 'In the hash projection ONLY: uppercase T/Z, replace +00:00 with Z, remove trailing zeros from the fractional seconds and remove the decimal point if the fraction becomes empty. Preserve all significant fractional digits. Do not use Date.toISOString() to round/truncate submillisecond precision. Do not rewrite stored records or unrelated signed/idempotent payloads.',
  payload: 'A bare JSON array of objects containing exactly the listed public fields. Field values are unchanged except the createdAt normalization above. No period wrapper, period metadata, accountTotals, entryCount, closedAt, snapshotDigest, newline, BOM or internal database columns. Missing public fields are invalid, not silently omitted. The empty array is valid and has the empty-array digest below.',
  seed: 'A CLOSED period imported through the published seed interface uses this same scope, field projection, ordering and normalization over the seed royaltyEntries. The importer validates this digest and imports atomically; OPEN/CLOSING periods keep snapshotDigest:null. Exact seed replay/conflict rules remain unchanged.',
  obligations: 'The service still selects the exact committed rows, closes with a lease fence and transaction, preserves CLOSED periods/entries, and implements idempotency, conservation, recovery and concurrency. These vectors test only digest conformance, not a complete legal seed or business workflow.',
  vectors: [
    { name: 'empty', period, entries: [], expectedDigest: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945' },
    { name: 'balanced-pair', period, entries, expectedDigest: baseDigest },
    { name: 'reversed-input', period, entries: [...entries].reverse(), expectedDigest: baseDigest },
    { name: 'equivalent-utc-spellings', period, entries: [{ ...credit, createdAt: '2026-01-01t00:00:00.000000z' }, { ...debit, createdAt: '2026-01-01T00:00:00+00:00' }], expectedDigest: baseDigest },
    { name: 'amount-change', period, entries: entries.map(row => ({ ...row, amountMinor: 11 })), expectedDigest: 'd33f3b9c26777c634d98daa7fd4b25e1ae20463d979a8b428f348087ba916e46' },
    { name: 'submillisecond-precision', period, entries: entries.map(row => ({ ...row, createdAt: '2026-01-01T00:00:00.000001Z' })), expectedDigest: 'e0314ee7283d9fdf4ea07a0e5348f649d80b6bd8c469595219500ca652d4c429' },
    { name: 'tenant-currency-half-open-scope', period, entries: [...entries,
      { ...debit, royaltyEntryId: id(10), tenantId: id(11) },
      { ...debit, royaltyEntryId: id(12), currency: 'EUR' },
      { ...debit, royaltyEntryId: id(13), createdAt: '2025-12-31T23:59:59.999999Z' },
      { ...debit, royaltyEntryId: id(14), createdAt: period.periodEnd },
    ], expectedDigest: baseDigest },
  ],
};

export const royaltyDigestNotes = [
  `Author-approved policy ${ROYALTY_DIGEST_REVISION} supplements README section 7: snapshotDigest = ${royaltyDigestPolicy.algorithm}. This is an explicit new digest contract, not a retroactive interpretation of old submissions. See contract.json royaltyDigest for complete rules and fixed input/expectedDigest vectors.`,
  `Royalty digest selection: ${royaltyDigestPolicy.scope}`,
  `Royalty digest fields: ${royaltyDigestPolicy.fields.join(', ')}. ${royaltyDigestPolicy.payload}`,
  `Royalty digest order: ${royaltyDigestPolicy.order.join('; ')}. ${royaltyDigestPolicy.timestamp}`,
  `Royalty digest seed: ${royaltyDigestPolicy.seed}`,
  royaltyDigestPolicy.obligations,
];
