import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import * as bill from '../evaluators/learning/billforge/v2/lib/fixtures.mjs';
import { createCarePlan } from '../evaluators/learning/clinicgrid/v2/cases/helpers.mjs';
import { createExport, createGrant } from '../evaluators/learning/exportvault/v2/cases/helpers.mjs';
import { createCaseContext as relayContext } from '../evaluators/learning/configrelay/v2/lib/runtime.mjs';
import * as relay from '../evaluators/learning/configrelay/v2/lib/fixtures.mjs';
import { CASES as billCases } from '../evaluators/learning/billforge/v2/cases/index.mjs';
import { scoreEvaluation, validateManifest } from '../evaluators/learning/billforge/v2/lib/scoring.mjs';
import { assertSnapshot as assertBillSnapshot, createInvoice, createPayment } from '../evaluators/learning/billforge/v2/cases/helpers.mjs';
import { CONTRACT_CASES as edgeCases } from '../evaluators/learning/edgetwin/v2/cases/contract.mjs';
import * as edge from '../evaluators/learning/edgetwin/v2/fixtures/index.mjs';
import { applyMergePatch } from '../evaluators/learning/edgetwin/v2/oracles/index.mjs';
import { createWave } from '../evaluators/learning/edgetwin/v2/cases/helpers.mjs';
import { A_CASES as relayACases } from '../evaluators/learning/configrelay/v2/cases/a.mjs';

const root = resolve(import.meta.dirname, '..');
const boundaries = Object.fromEntries(await Promise.all(['billforge', 'clinicgrid', 'configrelay', 'edgetwin', 'exportvault'].map(async task => [task, await evaluatorContract(resolve(root, 'task-packages/v2', task, 'public-contract'))])));
const fixtureOptions = { evaluationSeed: 'author-wire-regression', caseId: 'BILL-01', baseTime: '2026-09-07T00:00:00.000Z' };
const id = '00000001-0000-4000-8000-000000000001';
const post = (task, path, json, options = {}) => boundaries[task].request(path, { method: 'POST', headers: { 'Idempotency-Key': 'author-wire' }, json, ...options });
const mismatch = error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH';

test('BillForge authored base and invoice/payment graph seeds match public wire', () => {
  const f = bill.createFixtureFactory(fixtureOptions), value = bill.billingSeed(f);
  boundaries.billforge.seed(value.seed);
  const invoice = bill.invoice(f, 'paid', value.tenant, value.customer, value.subscription, value.rate);
  const payment = bill.paymentIntent(f, 'paid', invoice);
  boundaries.billforge.seed({ ...value.seed, invoices: [invoice], paymentIntents: [payment], settlementRuns: [bill.settlementRun(f, 'settled', value.tenant)] });
  const old = structuredClone(value.seed); old.priceVersions[0].taxVersion = 17;
  assert.throws(() => boundaries.billforge.seed(old), mismatch, 'unpublished tax configuration must remain rejected');
});

test('BillForge all initial case seeds validate before starting a candidate', async () => {
  let seeds = 0;
  const reached = new Error('stop before candidate startup');
  for (const definition of billCases) {
    const f = bill.createFixtureFactory({ ...fixtureOptions, caseId: definition.id });
    const ctx = { fixtures: f, at: f.at, uuid: f.uuid, key: f.key, workspace: root,
      command: async () => ({ exitCode: 0 }), npm: async () => ({ exitCode: 0 }), migrate: async () => {},
      seed: async value => { boundaries.billforge.seed(value); seeds++; return { exitCode: 0 }; },
      startApi: async () => { throw reached; } };
    try { await definition.run(ctx); } catch (error) {
      if (error.reason === 'missing_v1_checkpoint') assert.equal(definition.id, 'COMPAT-01');
      else assert.equal(error, reached, definition.id);
    }
  }
  assert.equal(seeds, 23, 'all 22 final-system cases seed real setup; COMPAT-03 also replays seed before API startup');
});

test('BillForge invoice/payment helper bodies use public fields, not provider-controlled IDs', async () => {
  const f = bill.createFixtureFactory(fixtureOptions), value = bill.billingSeed(f);
  const invoice = bill.invoice(f, 'draft', value.tenant, value.customer, value.subscription, value.rate, { state: 'DRAFT', finalizedAt: null });
  const payment = bill.paymentIntent(f, 'created', invoice);
  const bodies = [];
  const ctx = { at: f.at, key: f.key, mutate: async (_url, path, _key, json) => { post('billforge', path, json); bodies.push(json); return { status: 200, json: path === '/api/v1/invoices' ? invoice : payment }; } };
  await createInvoice(ctx, { baseUrl: 'http://author.invalid' }, 'wire', value);
  await createPayment(ctx, { baseUrl: 'http://author.invalid' }, invoice, 'wire');
  assert.equal(bodies[0].subscriptionVersion, 1);
  assert.equal(bodies[0].currency, 'USD');
  assert.equal(Object.hasOwn(bodies[1], 'providerRequestId'), false);
});

test('BillForge stated billing invariants replace unpublished formulas and actual failure earns no credit', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'evaluators/learning/billforge/v2/manifest.v2.json')));
  const map = JSON.parse(await readFile(resolve(root, 'evaluators/learning/billforge/v2/contract-map.v2.json')));
  assert.equal(validateManifest(manifest, map), true);
  assert.equal(manifest.cases.length, 22);
  assert.equal(manifest.cases.find(c => c.id === 'BILL-01').weight, 6);
  assert.equal(manifest.evaluationScope, 'final-system');
  assert.equal(manifest.cases.find(c => c.id === 'BILL-01').blockedAssertions, undefined);
  assert.ok(manifest.semanticRevisions.some(revision => revision.caseIds.includes('BILL-01') && /unpublished.*formulas/.test(revision.summary)));
  const cases = manifest.cases.map(c => ({ id: c.id, status: c.id === 'BILL-01' ? 'failed' : 'passed', ...(c.id === 'BILL-01' ? { privateFailureCode: 'BF_BILL01_FROZEN_TERMS' } : {}) }));
  const scored = scoreEvaluation(manifest, map, { cases });
  assert.notEqual(scored.verdict, 'accepted');
  assert.equal(scored.blockedWeight, 0);
  assert.equal(scored.rawScore, 94);
});

function billSnapshot(seed) {
  const { schemaVersion, seedVersion, importedAt, ...resources } = structuredClone(seed);
  return { asOf: fixtureOptions.baseTime, resources, work: [], events: [] };
}

test('BillForge snapshot price versions are strictly sorted by primary priceVersionId, not plan/version', () => {
  const f = bill.createFixtureFactory(fixtureOptions), value = bill.billingSeed(f);
  value.seed.priceVersions = [
    { ...value.price, priceVersionId: '00000001-0000-4000-8000-000000000001', version: 2 },
    { ...value.price, priceVersionId: '00000002-0000-4000-8000-000000000001', version: 1 },
  ];
  const snapshot = billSnapshot(value.seed);
  assert.doesNotThrow(() => assertBillSnapshot(snapshot));
  snapshot.resources.priceVersions.reverse();
  assert.throws(() => assertBillSnapshot(snapshot), /priceVersions is not in published order/);
});

test('BillForge COMPAT-03 reaches all five seed calls and marks only the unknown Manager collection invalid', async () => {
  const f = bill.createFixtureFactory({ ...fixtureOptions, caseId: 'COMPAT-03' });
  const reached = new Error('all original seed rejection checks reached'), calls = [];
  let initial, snapshots = 0;
  const ctx = { fixtures: f, at: f.at, uuid: f.uuid, key: f.key,
    command: async () => ({ exitCode: 0 }), npm: async () => ({ exitCode: 0 }), migrate: async () => {},
    startApi: async () => ({ baseUrl: 'http://author.invalid' }),
    seed: async (value, options = {}) => {
      boundaries.billforge.seed(value, options); calls.push({ value, options });
      initial ??= billSnapshot(value);
      return { exitCode: calls.length <= 2 ? 0 : 1, stdout: calls.length === 3 ? 'SEED_VERSION_CONFLICT' : '', stderr: '' };
    },
    snapshot: async () => { if (++snapshots === 4) throw reached; return initial; },
  };
  await assert.rejects(billCases.find(c => c.id === 'COMPAT-03').run(ctx), error => error === reached);
  assert.equal(calls.length, 5);
  assert(calls.slice(0, 4).every(c => c.options.contractExpectation === undefined));
  assert.deepEqual(calls[4].value.disputes, []);
  assert.equal(calls[4].options.contractExpectation, 'invalid');
});

test('BillForge BILL-02 cancellation remains after the change and inside the seeded subscription period', async () => {
  const f = bill.createFixtureFactory({ ...fixtureOptions, caseId: 'BILL-02' });
  const reached = new Error('valid cancellation request reached');
  let seed, changedAt, invoice;
  const ctx = { fixtures: f, at: f.at, uuid: f.uuid, key: f.key,
    command: async () => ({ exitCode: 0 }), npm: async () => ({ exitCode: 0 }), migrate: async () => {},
    startApi: async () => ({ baseUrl: 'http://author.invalid' }), startWorker: async () => ({}),
    seed: async value => { boundaries.billforge.seed(value); seed = value; return { exitCode: 0 }; },
    snapshot: async () => ({ resources: { invoices: [invoice] } }), waitFor: action => action(),
    mutate: async (_url, path, _key, json) => {
      post('billforge', path, json);
      if (path.endsWith('/change')) { changedAt = json.effectiveAt; return { status: 200, json: { ...seed.subscriptions[0], planId: json.planId, version: 2 } }; }
      if (path === '/api/v1/invoices') {
        invoice = bill.invoice(f, 'wire', seed.tenants[0], seed.customers[0], seed.subscriptions[0], seed.exchangeRateSnapshots[0], { state: 'DRAFT', finalizedAt: null });
        invoice.lines[0].kind = 'PRORATION';
        return { status: 200, json: invoice };
      }
      if (path.endsWith('/finalize')) { invoice = { ...invoice, state: 'OPEN', finalizedAt: f.at() }; return { status: 200, json: invoice }; }
      assert(path.endsWith('/cancel'));
      assert(Date.parse(json.effectiveAt) > Date.parse(changedAt), 'cancellation must follow the plan change');
      assert(Date.parse(json.effectiveAt) >= Date.parse(seed.subscriptions[0].periodStart) && Date.parse(json.effectiveAt) < Date.parse(seed.subscriptions[0].periodEnd), 'cancellation must remain inside current period');
      assert.equal(json.expectedVersion, 2);
      throw reached;
    },
  };
  await assert.rejects(billCases.find(c => c.id === 'BILL-02').run(ctx), error => error === reached);
});

test('ClinicGrid invalid visit counts reach the candidate only with explicit invalid intent', async () => {
  const body = { patientId: id, visits: [{ serviceTypeId: id, clinicianId: id, startAt: fixtureOptions.baseTime }] };
  const ctx = { key: () => 'author-wire', mutate: async (_url, path, _key, json, options) => { post('clinicgrid', path, json, options); return { status: 400 }; } };
  await assert.rejects(createCarePlan(ctx, 'http://author.invalid', body, { allowFailure: true }), mismatch);
  assert.equal((await createCarePlan(ctx, 'http://author.invalid', body, { allowFailure: true, contractExpectation: 'invalid' })).status, 400);
  for (const type of ['clinician', 'room', 'equipmentUnit']) boundaries.clinicgrid.request(`/api/v1/resources/${type}/${id}/calendar?from=${fixtureOptions.baseTime}&to=2026-09-08T00:00:00.000Z`);
  assert.throws(() => boundaries.clinicgrid.request(`/api/v1/resources/clinicians/${id}/calendar?from=${fixtureOptions.baseTime}&to=2026-09-08T00:00:00.000Z`), mismatch);
});

test('Every authored ClinicGrid calendar request uses the published singular resource enum', async () => {
  let count = 0;
  for (const file of ['slot', 'race', 'plan', 'load']) {
    const source = await readFile(resolve(root, `evaluators/learning/clinicgrid/v2/cases/${file}.mjs`), 'utf8');
    for (const match of source.matchAll(/calendar\(ctx, [^,]+, "([^"]+)"/g)) {
      boundaries.clinicgrid.request(`/api/v1/resources/${match[1]}/${id}/calendar?from=${fixtureOptions.baseTime}&to=2026-09-08T00:00:00.000Z`);
      count++;
    }
  }
  assert.equal(count, 12);
});

test('ConfigRelay explicitly malformed seed intent survives the author wrapper', async t => {
  const ctx = await relayContext({ ...fixtureOptions, caseId: 'D-01', workspace: root, manageDatabase: false });
  t.after(() => ctx.teardown());
  ctx.npm = async (_script, args, options) => { boundaries.configrelay.seed(JSON.parse(await readFile(args[1])), options); return { exitCode: options.contractExpectation === 'invalid' ? 1 : 0 }; };
  const bad = { ...ctx.seedFor('wire'), managerState: [] };
  await assert.rejects(ctx.seed(bad), mismatch);
  await ctx.seed(bad, { expectFailure: true, contractExpectation: 'invalid' });
  const invalidPlan = ctx.deploymentBody(ctx.catalog(), { cohorts: [] });
  ctx.mutate = async (_url, path, _key, json, options) => { post('configrelay', path, json, options); return { status: 400 }; };
  await assert.rejects(ctx.createDeployment('http://author.invalid', invalidPlan), mismatch);
  assert.equal((await ctx.createDeployment('http://author.invalid', invalidPlan, { contractExpectation: 'invalid' })).status, 400);
});

test('ConfigRelay rollback fixtures retain a real revision/digest and validate APPLY and ROLLBACK acknowledgements', () => {
  const f = relay.createFixtureFactory(fixtureOptions), catalog = relay.agentCatalog(f, { rollbackBaseline: true });
  const seed = relay.v1Seed(f, 'rollback-wire', { catalog });
  boundaries.configrelay.seed(seed);
  assert.deepEqual(seed.configurations.map(c => c.revision), [1, 2]);
  assert.equal(catalog.configuration.revision, 2);
  assert.equal(catalog.fleet.currentRevision, 2);
  for (const agent of catalog.agents) {
    assert.equal(agent.appliedRevision, 1);
    assert.equal(agent.appliedDigest, seed.configurations[0].canonicalDigest);
    for (const configuration of seed.configurations) post('configrelay', `/api/v1/agents/${agent.agentId}/acknowledgements`, relay.acknowledgementBody({ deploymentId: f.uuid('deployment'), commandSequence: 2, toRevision: configuration.revision, toDigest: configuration.canonicalDigest, assignmentToken: 'wire-token' }));
  }
  assert.equal(relay.agentCatalog(f).agents[0].appliedRevision, 0, 'legacy zero-state fixtures are unchanged');
  assert.throws(() => post('configrelay', `/api/v1/agents/${id}/acknowledgements`, relay.acknowledgementBody({ deploymentId: id, commandSequence: 2, toRevision: 0, toDigest: null, assignmentToken: 'wire-token' })), mismatch, 'the original uninitialized rollback target cannot be a positive acknowledgement');
});

test('ConfigRelay A-04 reaches every malformed and domain-negative cohort request with correct intent', async t => {
  const ctx = await relayContext({ ...fixtureOptions, caseId: 'A-04', workspace: root, manageDatabase: false });
  t.after(() => ctx.teardown());
  const calls = [];
  ctx.seed = async value => boundaries.configrelay.seed(value);
  ctx.startApi = async () => ({ baseUrl: 'http://author.invalid' });
  ctx.snapshot = async () => ({ asOf: fixtureOptions.baseTime, resources: {}, work: [], events: [] });
  // This is a transport audit, not a fake business pass: assertions are tested by real execution elsewhere.
  ctx.equal = () => {}; ctx.assert = () => {}; ctx.ok = () => {};
  ctx.mutate = async (_url, path, _key, json, options) => {
    post('configrelay', path, json, options); calls.push({ json, options });
    return { status: 202, json: { deploymentId: id, rollback: null, cohorts: json.cohorts.map((c, ordinal) => ({ ...c, ordinal, targetCount: 1 })) } };
  };
  await relayACases.find(c => c.id === 'A-04').run(ctx);
  assert.equal(calls.length, 12);
  assert.equal(calls.filter(c => c.options.contractExpectation === 'invalid').length, 7);
  assert(calls.slice(-3).every(c => c.options.contractExpectation === undefined), 'selector semantics, unmatched targets and overlapping cohorts are wire-valid negatives');
});

function edgeContext(caseId) {
  const f = edge.createFixtureFactory({ ...fixtureOptions, caseId });
  const ctx = { fixtures: f, caseId, workspace: `author-${caseId}`, at: f.at, key: f.key, uuid: f.uuid,
    npm: async () => ({ exitCode: 0 }), migrate: async () => {}, startApi: async () => ({ baseUrl: 'http://author.invalid' }),
    seed: async value => { boundaries.edgetwin.seed(value); ctx.seedValue = value; },
    equal() {}, ok() {}, snapshot: async () => ({ resources: {}, work: [], events: [] }) };
  ctx.forWorkspace = () => ctx;
  return ctx;
}

test('EdgeTwin CONTRACT-01 emits all ten published patch bodies without legacy tenantId', async () => {
  const ctx = edgeContext('CONTRACT-01'), bodies = [], reached = new Error('all ten wire requests reached');
  let shadow;
  ctx.mutate = async (_url, path, _key, json, options) => {
    boundaries.edgetwin.request(path, { ...options, headers: { 'Idempotency-Key': 'wire' }, json });
    bodies.push(json);
    if (bodies.length <= 4) {
      shadow ??= structuredClone(ctx.seedValue.deviceShadows[0]);
      shadow = { ...shadow, desiredVersion: shadow.desiredVersion + 1, desired: applyMergePatch(shadow.desired, json.patch) };
      return { status: 200, json: shadow };
    }
    return { status: bodies.length <= 6 ? 409 : 400, json: { error: { code: bodies.length <= 6 ? 'SHADOW_VERSION_CONFLICT' : 'INVALID_SHADOW_PATCH', message: 'wire test', details: {} } } };
  };
  ctx.snapshot = async () => { if (bodies.length === 10) throw reached; return { resources: {}, work: [], events: [] }; };
  await assert.rejects(edgeCases.find(c => c.id === 'CONTRACT-01').run(ctx), error => error === reached);
  assert.equal(bodies.length, 10);
  assert(bodies.every(body => !Object.hasOwn(body, 'tenantId')));
  assert.throws(() => boundaries.edgetwin.request(`/api/v1/devices/${id}/shadow/desired`, { method: 'PATCH', headers: { 'Idempotency-Key': 'wire' }, json: { ...bodies[0], tenantId: id } }), mismatch);
});

test('EdgeTwin CONTRACT-04 positive campaign members are unique before transport', async () => {
  const ctx = edgeContext('CONTRACT-04'), bodies = [], reached = new Error('campaign wire reached');
  ctx.mutate = async (_url, path, _key, json, options) => {
    post('edgetwin', path, json, options); bodies.push(json);
    if (bodies.length === 1) return { status: 400, json: { error: { code: 'INVALID_REQUEST', message: 'retired', details: {} } } };
    throw reached;
  };
  await assert.rejects(edgeCases.find(c => c.id === 'CONTRACT-04').run(ctx), error => error === reached);
  assert.equal(bodies[1].deviceIds.length, 2);
  assert.equal(new Set(bodies[1].deviceIds).size, 2);
  assert.throws(() => post('edgetwin', '/api/v1/upgrade-campaigns', { ...bodies[1], deviceIds: [bodies[1].deviceIds[0], ...bodies[1].deviceIds] }), mismatch);
});

test('EdgeTwin wave schema negatives are explicit while duplicate-name domain negatives stay validated', async () => {
  const f = edge.createFixtureFactory(fixtureOptions), seed = edge.baseSeed(f), body = edge.waveRequest(f, seed);
  const bad = { ...body, waves: [{ ...body.waves[0], minimumObservationSeconds: 0 }] };
  const ctx = { key: f.key, mutate: async (_url, path, _key, json, options) => { post('edgetwin', path, json, options); return { status: 400 }; } };
  await assert.rejects(createWave(ctx, 'http://author.invalid', bad, { allowFailure: true }), mismatch);
  assert.equal((await createWave(ctx, 'http://author.invalid', bad, { allowFailure: true, contractExpectation: 'invalid' })).status, 400);
  post('edgetwin', '/api/v1/deployment-waves', { ...body, waves: body.waves.map(w => ({ ...w, name: 'same' })) });
});

test('ExportVault malformed scope intent survives helper and Grant uses published complete shape', async () => {
  const ctx = { key: () => 'author-wire', equal: (a, b) => assert.deepEqual(a, b), ok: value => assert.ok(value), mutate: async (_url, path, _key, json, options) => { post('exportvault', path, json, options); return { status: 400 }; } };
  const bad = { subjectId: id, scope: [], format: 'JSONL' };
  await assert.rejects(createExport(ctx, 'http://author.invalid', bad, { allowFailure: true }), mismatch);
  assert.equal((await createExport(ctx, 'http://author.invalid', bad, { allowFailure: true, contractExpectation: 'invalid' })).status, 400);
  const grant = { grantId: id, exportId: id, expiresAt: fixtureOptions.baseTime, revokedAt: null, createdAt: fixtureOptions.baseTime };
  ctx.mutate = async (_url, path, _key, json, options) => { post('exportvault', path, json, options); return { status: 200, json: grant }; };
  assert.deepEqual(await createGrant(ctx, 'http://author.invalid', id, { expiresInSeconds: 300 }), grant);
});
