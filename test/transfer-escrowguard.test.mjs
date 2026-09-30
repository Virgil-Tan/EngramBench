import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import contract from '../contracts/transfer/escrowguard.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import * as runtime from '../templates/contract-first/runtime.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { makeEscrowFixture, makeAllV1StatesFixture, fundedRequest, beneficiaryRequest } from '../evaluators/transfer/escrowguard/v2/fixtures/index.mjs';
import { assertEscrowGuardOpenApi, assertDetail, assertSnapshot } from '../evaluators/transfer/escrowguard/v2/oracles/index.mjs';
import { createEscrow, getDetail } from '../evaluators/transfer/escrowguard/v2/cases/helpers.mjs';
import { CASES } from '../evaluators/transfer/escrowguard/v2/cases/index.mjs';
const options = { evaluationSeed: 'author-wire-regression', caseId: 'A-06', baseTime: new Date(Date.now() + 86_400_000).toISOString() };
const compile = runtime.validator(contract);

test('Escrow public operation examples, linked V1 seed and dynamic smoke compile', () => {
  assert.deepEqual(validatePublicContract(contract), { operations: 12, probes: 8, schemas: 22 });
  assert.equal(CASES.length, 48);
  const seed = contract.seed.example;
  assert(seed.parties.some(party => party.partyId === seed.escrows[0].buyerId));
  assert.equal(seed.milestones[0].escrowId, seed.escrows[0].escrowId);
  assert.equal(seed.milestones[0].amountMinor, seed.escrows[0].totalMinor);
  assert(contract.smoke.some(step => step.capture?.createdEscrowId));
});

test('Escrow hidden oracle uses published OpenAPI, not an obsolete wrapper/status contract', () => {
  const document = runtime.openApi(contract), author = { contract, runtime };
  assertEscrowGuardOpenApi(document, { author });
  document.components.schemas.Escrow.properties.totalMinor = { type: 'string' };
  assert.throws(() => assertEscrowGuardOpenApi(document, { author }));
});

test('Escrow actual private seed families and beneficiary request builders obey the public types', () => {
  const checkSeed = compile(contract.seed.schema), request = contract.operations.find(op => op.id === 'create-escrow'), check = runtime.requestValidator(contract);
  for (const fixture of [makeEscrowFixture(options), makeAllV1StatesFixture(options)]) assert(checkSeed(fixture.seed), JSON.stringify(checkSeed.errors));
  const f = makeEscrowFixture(options);
  for (const body of [fundedRequest(f), beneficiaryRequest(f, [1, 2, 20])]) {
    assert(check(request, { body, hasBody: true, headers: { 'content-type': 'application/json', 'idempotency-key': f.fixtures.key('create') } }).valid);
    for (const milestone of body.milestones) for (const share of milestone.beneficiaries ?? []) assert(f.parties.some(p => p.partyId === share.beneficiaryId));
  }
});

test('Escrow actual helpers preserve flat wire, share conservation and explicit malformed markers', async () => {
  const f = makeEscrowFixture(options), shares = f.milestones.map(m => ({ beneficiaryShareId: f.fixtures.uuid(m.milestoneId), milestoneId: m.milestoneId, ordinal: 1, beneficiaryId: f.sellerId, amountMinor: m.amountMinor }));
  const detail = { ...f.escrow, milestones: f.milestones, dispute: null, releases: [], fundPosition: { totalMinor: 100, availableMinor: 100, releasedMinor: 0, refundedMinor: 0 }, beneficiaryShares: shares, beneficiaryPayouts: [] };
  assert(compile(contract.schemas.EscrowDetail)(detail));
  assert.equal(assertDetail(detail).escrow.escrowId, f.escrowId);
  const wrong = structuredClone(detail); wrong.beneficiaryShares[0].amountMinor++;
  assert.throws(() => assertDetail(wrong), /Share amount conservation/);
  assert.throws(() => assertDetail({ escrow: f.escrow, milestones: f.milestones }), /exact fields/);
  const calls = [], ctx = { key: f.fixtures.key, request: async () => ({ status: 200, json: detail }), mutate: async (_base, path, _key, body, opts) => { calls.push({ path, body, opts }); return { status: 201, json: f.escrow }; } };
  await createEscrow(ctx, 'http://localhost', fundedRequest(f));
  await getDetail(ctx, 'http://localhost', f.escrowId);
  await createEscrow(ctx, 'http://localhost', { ...fundedRequest(f), totalMinor: '100' }, { allowFailure: true, contractExpectation: 'invalid' });
  assert.equal(calls[0].opts.contractExpectation, undefined);
  assert.equal(calls[1].opts.contractExpectation, 'invalid');
});

test('Escrow actual creation cases seed Parties before any positive mutation', async () => {
  for (const id of ['A-06', 'A-13', 'A-14', 'D-01', 'D-02', 'D-04', 'D-05', 'D-06', 'D-08']) {
    const stopped = new Error('checked seed; no submission execution');
    const f = makeEscrowFixture({ ...options, caseId: id });
    const target = { npm: async () => {}, migrate: async () => {}, seed: async value => {
      const check = compile(contract.seed.schema); assert(check(value), JSON.stringify(check.errors));
      assert(value.parties.some(p => p.partyId === f.buyerId)); assert(value.parties.some(p => p.partyId === f.sellerId));
      throw stopped;
    } };
    await assert.rejects(CASES.find(item => item.id === id).run({ ...options, caseId: id, fixtures: f.fixtures, workspace: '/unused', forWorkspace: () => target }), error => error === stopped);
  }
});

test('Escrow invalid positive author input is evaluator error, while named numeric errors are preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'escrow-author-contract-'));
  try {
    await writeFile(join(root, 'contract.json'), JSON.stringify(contract));
    await symlink(new URL('../templates/contract-first/runtime.mjs', import.meta.url).pathname, join(root, 'runtime.mjs'));
    const boundary = await evaluatorContract(root), invalid = { ...contract.seed.example, unknown: true };
    assert.throws(() => boundary.seed(invalid), error => error.origin === 'evaluator' && error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
    boundary.seed(invalid, { contractExpectation: 'invalid' });
    const operation = contract.operations.find(op => op.id === 'create-escrow'), check = runtime.requestValidator(contract);
    const input = { ...structuredClone(operation.example), hasBody: true }; input.headers['content-type'] = 'application/json';
    input.body.totalMinor = 1.5; assert.equal(check(operation, input).code, 'INVALID_ESCROW_TOTAL');
    input.body.totalMinor = '100'; assert.equal(check(operation, input).code, 'INVALID_REQUEST');
    assert.throws(() => boundary.request('/api/v1/escrows', { method: 'POST', headers: input.headers, json: input.body }), error => error.origin === 'evaluator');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Scripted observations for the actual A-09 case, not a replacement settlement
// implementation: the three fixed public states come from its existing fixtures.
async function runDisputeReleaseCase({ resolvedInDetail = false, resolutionState = 'RESOLVED_RELEASE' } = {}) {
  const caseId = 'A-09', fixtureOptions = { ...options, caseId };
  const variants = [
    { label: 'buyer-dispute-release', amounts: [40, 60], openedBy: 'BUYER' },
    { label: 'seller-dispute-release', amounts: [25, 75], openedBy: 'SELLER' },
  ];
  const phases = [0, 0], f = makeEscrowFixture(fixtureOptions), markers = [], assertions = [];
  const setupPending = new Set();
  const observe = index => {
    const variant = variants[index], phase = phases[index];
    const fixture = makeEscrowFixture(fixtureOptions, {
      ...variant, states: setupPending.has(index) ? ['PENDING', 'PENDING'] : [["SUBMITTED", "PENDING"], ["DISPUTED", "PENDING"], ["RELEASED", "PENDING"]][phase],
      ...(phase ? { dispute: { milestoneIndex: 0, openedBy: variant.openedBy, state: phase === 1 ? 'OPEN' : 'RESOLVED_RELEASE' } } : {}),
    });
    const beneficiaryShares = fixture.milestones.map(m => ({ beneficiaryShareId: f.fixtures.uuid(`share-${m.milestoneId}`), milestoneId: m.milestoneId, ordinal: 1, beneficiaryId: fixture.sellerId, amountMinor: m.amountMinor }));
    const beneficiaryPayouts = fixture.releases.map(release => ({ payoutId: f.fixtures.uuid(`payout-${release.releaseId}`), releaseId: release.releaseId, beneficiaryShareId: beneficiaryShares[0].beneficiaryShareId, beneficiaryId: fixture.sellerId, amountMinor: release.amountMinor, createdAt: release.createdAt }));
    const fundPosition = Object.fromEntries(['totalMinor', 'availableMinor', 'releasedMinor', 'refundedMinor'].map(key => [key, fixture.escrow[key]]));
    const detail = { ...fixture.escrow, milestones: fixture.milestones, dispute: phase === 1 || resolvedInDetail && phase === 2 ? fixture.dispute : null, releases: fixture.releases, fundPosition, beneficiaryShares, beneficiaryPayouts };
    assert(compile(contract.schemas.EscrowDetail)(detail));
    return { ...fixture, detail, beneficiaryShares, beneficiaryPayouts };
  };
  const snapshot = () => {
    const fixtures = variants.map((_, index) => observe(index));
    const sorts = { parties: ['partyId'], escrows: ['escrowId'], milestones: ['escrowId', 'ordinal', 'milestoneId'], disputes: ['escrowId', 'openedAt', 'disputeId'], releases: ['escrowId', 'createdAt', 'releaseId'], beneficiaryShares: ['milestoneId', 'ordinal', 'beneficiaryShareId'], beneficiaryPayouts: ['releaseId', 'beneficiaryShareId', 'payoutId'] };
    const sort = (items, fields) => items.sort((a, b) => { for (const field of fields) { if (a[field] < b[field]) return -1; if (a[field] > b[field]) return 1; } return 0; });
    const resources = { parties: f.parties, escrows: fixtures.map(v => v.escrow), milestones: fixtures.flatMap(v => v.milestones), disputes: fixtures.flatMap(v => v.dispute ? [v.dispute] : []), releases: fixtures.flatMap(v => v.releases), beneficiaryShares: fixtures.flatMap(v => v.beneficiaryShares), beneficiaryPayouts: fixtures.flatMap(v => v.beneficiaryPayouts) };
    for (const [name, fields] of Object.entries(sorts)) sort(resources[name], fields);
    const events = fixtures.flatMap((fixture, index) => ['escrow.funded', 'milestone.submitted', ...(phases[index] ? ['dispute.opened'] : []), ...(phases[index] === 2 ? ['dispute.resolved', 'milestone.released'] : [])].map((type, eventIndex) => ({ eventId: f.fixtures.uuid(`${index}-event-${eventIndex}`), aggregateId: fixture.escrowId, sequence: eventIndex + 1, type, occurredAt: f.fixtures.at(), schemaVersion: 1, payload: {} })));
    const work = fixtures.map(v => ({ workId: f.fixtures.uuid(`work-${v.escrowId}`), aggregateId: v.escrowId, kind: 'ESCROW_EXPIRY', state: 'PENDING', terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null }));
    return assertSnapshot({ asOf: f.fixtures.at(), resources, work: sort(work, ['workId']), events: sort(events, ['aggregateId', 'sequence', 'eventId']) });
  };
  const response = (json, status = 200) => ({ status, json: structuredClone(json), text: JSON.stringify(json), headers: { 'content-type': 'application/json' } });
  const target = { npm: async () => {}, migrate: async () => {}, seed: async seed => { assert(compile(contract.seed.schema)(seed)); }, startApi: async () => ({ baseUrl: 'http://escrow.invalid' }) };
  const ctx = {
    ...fixtureOptions, fixtures: f.fixtures, workspace: '/unused', adminToken: 'test-admin', key: f.fixtures.key,
    forWorkspace: () => target, mark() {}, pass: value => value,
    equal: (actual, expected, label) => { assertions.push(label); assert.deepEqual(actual, expected, label); }, ok: assert.ok,
    snapshot: async () => snapshot(),
    request: async (_base, path) => { const index = variants.findIndex((_, i) => observe(i).escrowId === path.split('/').at(-1)); assert(index >= 0); return response(observe(index).detail); },
    mutate: async (_base, path, key, body, opts = {}) => {
      const matched = runtime.matchOperation(contract.operations, 'POST', path);
      const wire = runtime.requestValidator(contract)(matched.operation, { params: matched.params, body, hasBody: true, headers: { 'content-type': 'application/json', 'idempotency-key': key, ...(opts.admin ? { authorization: 'Bearer test-admin' } : {}) } });
      markers.push(opts.contractExpectation);
      assert.equal(opts.contractExpectation, wire.valid ? undefined : 'invalid');
      if (path === '/api/v1/escrows') {
        const index = variants.findIndex(v => v.amounts[0] === body.milestones[0].amountMinor);
        assert(index >= 0); setupPending.add(index); return response(observe(index).escrow, 201);
      }
      if (path.endsWith('/submit')) {
        const index = variants.findIndex((_, i) => path.includes(observe(i).escrowId));
        assert(setupPending.delete(index)); return response({});
      }
      if (path.endsWith('/disputes')) {
        const index = variants.findIndex((_, i) => path.includes(observe(i).escrowId)); phases[index] = 1;
        return response(observe(index).dispute);
      }
      assert(path.endsWith('/resolve'));
      if (!opts.admin) return response({ error: { code: 'ADMIN_AUTH_REQUIRED', message: 'Admin authorization required', details: {} } }, 401);
      const index = variants.findIndex((_, i) => path.includes(observe(i).dispute?.disputeId)); phases[index] = 2;
      return response({ ...observe(index).dispute, state: resolutionState });
    },
  };
  const result = await CASES.find(item => item.id === caseId).run(ctx);
  return { result, markers, assertions };
}

test('Escrow actual A-09 accepts resolved history with no current dispute in detail', async () => {
  const { result, markers, assertions } = await runDisputeReleaseCase();
  assert.equal(result.evidence[0].disputeIds.length, 2);
  assert.equal(markers.filter(marker => marker === 'invalid').length, 1);
  assert.equal(assertions.filter(label => label === 'Dispute resolution').length, 2);
});

test('Escrow actual A-09 still rejects incorrect resolution and a non-current dispute in detail', async () => {
  await assert.rejects(runDisputeReleaseCase({ resolutionState: 'OPEN' }), /Dispute resolution/);
  await assert.rejects(runDisputeReleaseCase({ resolvedInDetail: true }), /resolved Dispute is no longer current/);
});

test('Escrow actual D-03 browser-resolution path consumes the returned Dispute and clears current detail', async () => {
  const caseId = 'D-03', fixtureOptions = { ...options, caseId }, f = makeEscrowFixture(fixtureOptions);
  const stopped = new Error('resolution checked; unrelated expiry slice not executed');
  let resolved = false, browserRequests = 0, observedResolution = false, seeded = false;
  let historySubmitted = false, browserStarted = false;
  const historyFixture = () => makeEscrowFixture(fixtureOptions, { label: 'ui-dispute', states: [historySubmitted ? 'SUBMITTED' : 'PENDING', 'PENDING', 'PENDING'] });
  const observation = () => {
    const fixture = makeEscrowFixture(fixtureOptions, { label: 'ui-dispute', states: resolved ? ['REFUNDED', 'REFUNDED', 'REFUNDED'] : ['DISPUTED', 'PENDING', 'PENDING'], dispute: { state: resolved ? 'RESOLVED_REFUND' : 'OPEN', milestoneIndex: 0 } });
    const beneficiaryShares = fixture.milestones.map(m => ({ beneficiaryShareId: f.fixtures.uuid(`share-${m.milestoneId}`), milestoneId: m.milestoneId, ordinal: 1, beneficiaryId: fixture.sellerId, amountMinor: m.amountMinor }));
    const detail = { ...fixture.escrow, milestones: fixture.milestones, dispute: resolved ? null : fixture.dispute, releases: [], fundPosition: { totalMinor: 100, availableMinor: resolved ? 0 : 100, releasedMinor: 0, refundedMinor: resolved ? 100 : 0 }, beneficiaryShares, beneficiaryPayouts: [] };
    assert(compile(contract.schemas.EscrowDetail)(detail));
    return { fixture, detail };
  };
  // Only public observations are scripted. The evaluator's own visible-control,
  // response parser, getDetail helper and business assertions execute unchanged.
  const { EventEmitter } = await import('node:events');
  const events = new EventEmitter(); let armed = false;
  const control = { count: async () => 1, isVisible: async () => true, evaluate: async () => 'input', getAttribute: async () => 'text', fill: async () => {},
    click: async () => {
      if (!armed) return; armed = false;
      const status = [200, 409, 401, 200][browserRequests++]; assert(status);
      if (browserRequests === 4) resolved = true;
      const request = { method: () => 'POST', url: () => browserRequests <= 2 ? 'http://escrow.invalid/api/v1/escrows/e/milestones/m/disputes' : 'http://escrow.invalid/api/v1/admin/disputes/' + observation().fixture.dispute.disputeId + '/resolve' };
      const json = status === 401 ? { error: { code: 'ADMIN_AUTH_REQUIRED', message: 'Admin authorization required', details: {} } } : observation().fixture.dispute;
      events.emit('request', request);
      events.emit('response', { request: () => request, status: () => status, text: async () => JSON.stringify(json), headers: () => ({ 'content-type': 'application/json' }) });
    },
  };
  control.nth = control.first = control.or = control.and = control.filter = () => control;
  control.waitFor = async () => {};
  const page = {
    goto: async () => {}, reload: async () => {}, waitForLoadState: async () => {}, getByLabel: () => control, getByRole: () => control, locator: () => control,
    getByText: pattern => String(pattern).includes('state|status') ? { count: async () => 0 } : control,
    on: (name, listener) => { if (name === 'response') armed = true; events.on(name, listener); }, off: events.off.bind(events),
  };
  const target = { npm: async () => {}, migrate: async () => {}, startApi: async () => ({ baseUrl: 'http://escrow.invalid' }), seed: async seed => {
    seeded = true; assert(compile(contract.seed.schema)(seed));
    assert.equal(seed.milestones.length, 0); assert(seed.parties.length > 0);
  } };
  const ctx = {
    ...fixtureOptions, fixtures: f.fixtures, workspace: '/unused', adminToken: 'test-admin', key: f.fixtures.key,
    forWorkspace: () => target, mark() {}, defer() {}, ok: assert.ok,
    loadChromium: async () => { browserStarted = true; return { launch: async () => ({ close: async () => {}, newContext: async () => ({ newPage: async () => page }) }) }; },
    equal: (actual, expected, label) => { assert.deepEqual(actual, expected, label); if (label === 'visible resolution agrees with server detail') observedResolution = true; },
    request: async () => ({ status: 200, json: browserStarted ? observation().detail : { ...historyFixture().escrow, milestones: historyFixture().milestones } }),
    mutate: async (_base, path, _key, body) => {
      if (path === '/api/v1/escrows') { assert.equal(body.milestones.length, 3); assert.equal(body.milestones.reduce((n, m) => n + m.amountMinor, 0), 100); return { status: 201, json: historyFixture().escrow }; }
      assert(path.endsWith('/submit')); assert.deepEqual(body, { evidence: {} }); historySubmitted = true; return { status: 200, json: {} };
    },
    snapshot: async () => { assert(observedResolution); throw stopped; },
  };
  await assert.rejects(CASES.find(item => item.id === caseId).run(ctx), error => error === stopped);
  assert(seeded); assert(observedResolution); assert.equal(browserRequests, 4);
});
