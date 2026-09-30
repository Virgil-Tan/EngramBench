import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/creatorrightsexchange.mjs';
import { royaltyPeriodDigest } from '../evaluators/transfer/creatorrightsexchange/v2/oracles/index.mjs';
import { createFixtureFactory } from '../evaluators/transfer/creatorrightsexchange/v2/fixtures/index.mjs';

test('the evaluator matches every fixed public digest vector without mutating records', () => {
  assert.equal(contract.policyRevision, 'creator-royalty-digest-v1');
  assert.deepEqual([...contract.royaltyDigest.fields].sort(), Object.keys(contract.schemas.RoyaltyEntry.properties).sort());
  for (const vector of contract.royaltyDigest.vectors) {
    const before = structuredClone(vector);
    assert.equal(royaltyPeriodDigest(vector.entries, vector.period), vector.expectedDigest, vector.name);
    assert.deepEqual(vector, before, 'normalization is projection-only');
  }
});

test('digest authenticates every public field but not internal columns or period metadata', () => {
  const { entries, period, expectedDigest } = contract.royaltyDigest.vectors.find(v => v.name === 'balanced-pair');
  const metadata = { ...period, state: 'CLOSING', closedAt: null, snapshotDigest: 'f'.repeat(64), accountTotals: [], entryCount: 999 };
  assert.equal(royaltyPeriodDigest(entries.map(row => ({ ...row, internalColumn: 'not-public' })), metadata), expectedDigest);
  for (const field of contract.royaltyDigest.fields) {
    const changed = structuredClone(entries), missing = structuredClone(entries);
    delete missing[0][field];
    assert.throws(() => royaltyPeriodDigest(missing, period), undefined, `missing ${field}`);
    changed[0][field] = field === 'amountMinor' ? 11 : field === 'createdAt' ? '2026-01-01T00:00:00.000001Z'
      : field === 'direction' ? 'CREDIT' : field === 'currency' ? 'EUR' : `${changed[0][field]}x`;
    assert.notEqual(royaltyPeriodDigest(changed, period), expectedDigest, field);
  }
});

test('all CLOSED period fixture families use the published algorithm and remain balanced', () => {
  const factory = createFixtureFactory({ evaluationSeed: 'public-digest-revision', caseId: 'A-06', baseTime: '2032-04-05T06:07:08Z' });
  for (const family of [factory.royalty({ closed: true }), factory.refund(), factory.dispute(), factory.migration()]) {
    for (const period of family.seed.royaltyPeriods.filter(row => row.state === 'CLOSED')) {
      assert.equal(period.snapshotDigest, royaltyPeriodDigest(family.seed.royaltyEntries, period));
    }
  }
});
