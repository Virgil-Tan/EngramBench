import test from 'node:test';
import assert from 'node:assert/strict';
import contract from '../contracts/transfer/accesssentinel.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { matchOperation, openApi, requestValidator, validator } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/accesssentinel/v2/fixtures/index.mjs';
import { assertAuditChain, auditDigest, assertOpenApi, assertSnapshot } from '../evaluators/transfer/accesssentinel/v2/oracles/index.mjs';
import { attach } from '../evaluators/transfer/accesssentinel/v2/lib/runtime.mjs';

const factory = () => createFixtureFactory({ evaluationSeed: 'author-alignment-regression', caseId: 'A-01', baseTime: '2026-09-07T00:00:00Z' });
const compile = validator(contract);

test('AccessSentinel audit genesis follows the published digest format without inventing a private empty-string anchor', () => {
  const valid = compile(contract.schemas.AuditEntry);
  const make = (sequence, previousDigest) => {
    const entry = { auditEntryId: `11111111-1111-4111-8111-${String(sequence).padStart(12, '0')}`,
      tenantId: '22222222-2222-4222-8222-222222222222', sequence, occurredAt: '2026-09-07T00:00:00Z',
      actorType: 'SYSTEM', actorId: null, action: 'TENANT_UPDATED', subjectType: 'TENANT',
      subjectId: '22222222-2222-4222-8222-222222222222', data: {}, previousDigest };
    return { ...entry, digest: auditDigest(entry) };
  };
  // The public format is 64 lower-case hex; README does not prescribe one genesis value.
  for (const genesis of ['0'.repeat(64), 'a'.repeat(64)]) {
    const first = make(1, genesis), second = make(2, first.digest);
    for (const entry of [first, second]) assert(valid(entry), JSON.stringify(valid.errors));
    assert.doesNotThrow(() => assertAuditChain([second, first]));
    const snapshot = { schemaVersion: 1, asOf: '2026-09-07T00:00:00Z',
      resources: Object.fromEntries(Object.keys(contract.schemas.Snapshot.properties.resources.properties).map(name => [name, name === 'auditEntries' ? [first, second] : []])),
      work: [], events: [], metrics: { databaseBytes: 0 } };
    assert.doesNotThrow(() => assertSnapshot(snapshot));
    assert.throws(() => assertAuditChain([first, make(2, 'b'.repeat(64))]), 'broken links still fail');
    assert.throws(() => assertAuditChain([first, make(3, first.digest)]), 'sequence gaps still fail');
    assert.throws(() => assertAuditChain([{ ...first, digest: 'f'.repeat(64) }]), 'wrong digest still fails');
    assert.throws(() => assertAuditChain([first, { ...second, data: { tampered: true } }]), 'changed content still fails');
  }
  for (const bad of ['', 'G'.repeat(64), 'a'.repeat(63)]) {
    const entry = make(1, bad);
    assert.equal(valid(entry), false, 'invalid public digest shape');
    assert.throws(() => assertAuditChain([entry]));
  }
});

test('FINAL snapshot requires all published Manager collections; V1 remains a distinct shape', () => {
  const keys = Object.keys(contract.schemas.Snapshot.properties.resources.properties);
  const state = { schemaVersion: 1, asOf: '2026-09-08T00:00:00Z', resources: Object.fromEntries(keys.map(k => [k, []])), work: [], events: [], metrics: { databaseBytes: 0 } };
  const manager = ['breakGlassSessions', 'breakGlassApprovals', 'regionalQuarantines', 'retrospectiveReviews'];
  assert.doesNotThrow(() => assertSnapshot(state));
  for (const key of manager) { const broken = structuredClone(state); delete broken.resources[key]; assert.throws(() => assertSnapshot(broken), key); }
  const v1 = structuredClone(state); for (const key of manager) delete v1.resources[key];
  assert.doesNotThrow(() => assertSnapshot(v1, { final: false }));
  assert.throws(() => assertSnapshot(state, { final: false }));
});

test('AccessSentinel public and hidden snapshots agree on UTC precision and invalid dates', () => {
  const valid = compile(contract.schemas.Snapshot);
  const snapshot = asOf => ({ schemaVersion: 1, asOf,
    resources: Object.fromEntries(Object.keys(contract.schemas.Snapshot.properties.resources.properties).map(name => [name, []])),
    work: [], events: [], metrics: { databaseBytes: 0 },
  });
  for (const asOf of ['2032-02-29T06:07:08Z', '2032-02-29T06:07:08.000Z', '2032-02-29T06:07:08.123456Z', '2032-02-29t06:07:08z', '2032-02-29T06:07:08+00:00']) {
    const value = snapshot(asOf);
    assert(valid(value), JSON.stringify(valid.errors));
    assert.doesNotThrow(() => assertSnapshot(value));
  }
  for (const asOf of ['2031-02-29T06:07:08Z', '2032-02-30T06:07:08Z', '2032-02-29T25:07:08Z', '2032-02-29T06:07:08+08:00', 'not-a-time', 42]) {
    assert.equal(valid(snapshot(asOf)), false);
    assert.throws(() => assertSnapshot(snapshot(asOf)));
  }
});

test('AccessSentinel publishes executable examples, all response shapes and a linked trust seed', () => {
  assert.equal(validatePublicContract(contract).operations, 33);
  const seed = contract.seed.example;
  assert.equal(seed.devices[0].principalId, seed.principals[0].principalId);
  assert.equal(seed.deviceTrustRevisions[0].deviceId, seed.devices[0].deviceId);
  assert.equal(seed.deviceTrustRevisions[0].revision, seed.devices[0].currentTrustRevision);
  const visit = schema => { assert(Object.keys(schema).length > 0, 'unconstrained field'); for (const child of Object.values(schema.properties ?? {})) visit(child); for (const child of schema.anyOf ?? []) visit(child); if (schema.items) visit(schema.items); };
  for (const schema of Object.values(contract.schemas)) visit(schema);
  assertOpenApi(openApi(contract));
});

test('AccessSentinel private seed families obey the public closed schemas', () => {
  const f = factory(), check = compile(contract.seed.schema);
  for (const name of ['empty', 'identity', 'policyRisk', 'location', 'access', 'idempotency', 'contention', 'workEventAudit', 'breakglass', 'migration', 'browser', 'performance']) assert(check(f[name]().seed), `${name}: ${JSON.stringify(check.errors)}`);
  const seed = f.identity().seed;
  seed.devices[0].revocationEpoch = '0';
  assert.equal(check(seed), false, 'resource numbers are not arbitrary JSON');
});

test('AccessSentinel private convenience requests obey the author wire and preserve per-call invalid markers', async () => {
  const f = factory(), family = f.identity(), check = requestValidator(contract), calls = [];
  const request = async (_base, path, options = {}) => {
    const url = new URL(path, 'http://localhost'), route = matchOperation(contract.operations, options.method ?? 'GET', url.pathname);
    assert(route, path);
    const result = check(route.operation, { params: route.params, query: Object.fromEntries(url.searchParams), headers: { ...options.headers, ...(options.json === undefined ? {} : { 'content-type': 'application/json' }) }, body: options.json, hasBody: options.json !== undefined });
    if (options.contractExpectation !== 'invalid') assert(result.valid, `${route.operation.id}: ${JSON.stringify(result)}`);
    calls.push({ id: route.operation.id, options, valid: result.valid }); return { status: 200, json: {} };
  };
  const ctx = attach({ key: f.key, request, mutate: (base, path, key, json, options = {}) => request(base, path, { ...options, method: options.method ?? 'POST', headers: { 'idempotency-key': key, ...options.headers }, json }) });
  await ctx.tenants('http://localhost'); await ctx.principals('http://localhost', family.tenant.tenantId); await ctx.devices('http://localhost', family.tenant.tenantId);
  await ctx.createSession('http://localhost', family.sessionBody());
  await ctx.createAccessRequest('http://localhost', family.requestBody());
  await ctx.createAccessBatch('http://localhost', { requests: [family.requestBody()] });
  await ctx.observeLocation('http://localhost', family.locationBody(2));
  await ctx.publishPolicy('http://localhost', family.policyBundle.policyBundleId, { expectedRevision: 1, effectiveFrom: f.at(), rules: family.policyRules(2) });
  await ctx.createBreakGlass('http://localhost', family.breakGlassBody());
  await ctx.checkBreakGlass('http://localhost', f.uuid('breakglass'), { action: 'deploy', resource: 'production/report', region: 'us-east' });
  const checkCall = calls.at(-1);
  assert.equal(checkCall.options.headers, undefined, 'side-effect-free check needs no Idempotency-Key');
  await ctx.createSession('http://localhost', {}, { contractExpectation: 'invalid' });
  assert.equal(calls.at(-1).valid, false);
  assert.equal(calls.at(-1).options.contractExpectation, 'invalid');
});

test('AccessSentinel batch response is closed and accepts exact resource records', () => {
  const operation = contract.operations.find(op => op.id === 'batchAccessRequests'), check = compile(operation.response);
  assert(check({ accessRequests: [] }));
  assert.equal(check({ requests: [] }), false);
  assert.equal(check({ accessRequests: [{ accessRequestId: 'not-a-resource' }] }), false);
  const validate = requestValidator(contract), body = structuredClone(operation.example.body);
  body.requests = Array.from({ length: 101 }, () => body.requests[0]);
  assert.equal(validate(operation, { headers: { 'content-type': 'application/json', 'idempotency-key': 'batch-boundary' }, body, hasBody: true }).valid, false);
});
