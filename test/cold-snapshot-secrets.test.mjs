import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/coldchaincontrol.mjs';
import { validator } from '../templates/contract-first/runtime.mjs';
import { assertSnapshotShape } from '../evaluators/transfer/coldchaincontrol/v2/cases/helpers.mjs';
import { assertNoSecrets } from '../evaluators/transfer/coldchaincontrol/v2/oracles/index.mjs';

const id = '00000000-0000-4000-8000-000000000001', at = '2026-09-08T00:00:00.000Z';
function snapshot() {
  return { schemaVersion: 1, asOf: at,
    resources: Object.fromEntries(Object.keys(contract.schemas.SnapshotResources.properties).map(key => [key, []])),
    managerResources: { custodyChains: [], custodyHandoffs: [], recallOrders: [], quarantineActions: [] }, events: [],
    work: [{ workId: id, tenantId: id, kind: 'CONFIG_DELIVER', aggregateId: id, state: 'PENDING', attempt: 0,
      availableAt: at, leaseOwner: null, leaseToken: null, leaseExpiresAt: null, lastError: null,
      terminal: false, createdAt: at, updatedAt: at }],
  };
}

test('public snapshot Work leaseToken is allowed only at its declared schema position', () => {
  const value = snapshot(), valid = validator(contract)(contract.schemas.VerificationSnapshot);
  assert(valid(value), JSON.stringify(valid.errors));
  assert.equal(assertSnapshotShape(value), true);
  Object.assign(value.work[0], { state: 'LEASED', attempt: 1, leaseOwner: 'worker-1', leaseToken: 'fence-7', leaseExpiresAt: '2026-09-08T00:00:03.000Z' });
  assert(valid(value), JSON.stringify(valid.errors));
  assert.equal(assertSnapshotShape(value), true);
  assert.throws(() => assertNoSecrets(value), /secret field names/, 'generic logs and payloads have no snapshot exemption');
  assert.throws(() => assertSnapshotShape(value, { secrets: ['fence-7'] }), /secret material/);
});

test('snapshot exemption still validates complete Work schema and rejects secret/token metadata', () => {
  for (const change of [row => { delete row.tenantId; }, row => { row.attempt = 0.5; }, row => { row.state = 'UNKNOWN'; }, row => { row.leaseToken = 123; }, row => { row.extra = true; }]) {
    const value = snapshot(); change(value.work[0]);
    assert.throws(() => assertSnapshotShape(value));
  }
  for (const key of ['secret', 'authorization', 'attestation', 'accessToken', 'leaseToken']) {
    const value = snapshot();
    value.resources.auditEntries.push({ auditEntryId: id, tenantId: id, actorType: 'SYSTEM', actorRef: 'test', action: 'test', resourceType: 'Device', resourceId: id, occurredAt: at, details: { [key]: null } });
    assert.throws(() => assertSnapshotShape(value), /secret field names/);
  }
  const signature = snapshot();
  signature.resources.auditEntries.push({ auditEntryId: id, tenantId: id, actorType: 'SYSTEM', actorRef: 'test', action: 'test', resourceType: 'Device', resourceId: id, occurredAt: at, details: { signature: 'a'.repeat(64) } });
  assert.throws(() => assertSnapshotShape(signature), /raw signature redacted/);
});
