import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import contract from '../contracts/transfer/incidentrelay.mjs';
import { validatePublicContract } from '../src/public-contract.mjs';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { validator, openApi, requestPath, expand, requestValidator, matchOperation } from '../templates/contract-first/runtime.mjs';
import { createFixtureFactory } from '../evaluators/transfer/incidentrelay/v2/fixtures/index.mjs';
import { assertOpenApiContract } from '../evaluators/transfer/incidentrelay/v2/oracles/openapi.mjs';
import { acknowledgementQuorum, notificationQuorum, schedule } from '../evaluators/transfer/incidentrelay/v2/oracles/index.mjs';
import { timeline, createIncident, createPolicy } from '../evaluators/transfer/incidentrelay/v2/cases/helpers.mjs';
import { CASES } from '../evaluators/transfer/incidentrelay/v2/cases/index.mjs';

const factory = createFixtureFactory({ evaluationSeed: 'public-wire-regression', caseId: 'A-05', baseTime: '2032-04-05T06:07:08.000Z' });
const compile = validator(contract);
const response = (status, json) => ({ status, json, text: JSON.stringify(json) });

test('IncidentRelay every public operation and real private OpenAPI oracle agree', () => {
  assert.deepEqual(validatePublicContract(contract), { operations: 14, probes: 6, schemas: 18 });
  assert.equal(CASES.length, 44);
  assert.doesNotThrow(() => assertOpenApiContract(openApi(contract)));
  const incomplete = openApi(contract); delete incomplete.paths['/api/v1/incidents'].post.responses['415'];
  assert.throws(() => assertOpenApiContract(incomplete), /415/);
  const seed = contract.seed.example;
  assert.equal(seed.services[0].currentPolicyId, seed.escalationPolicies[0].policyId);
  assert.equal(seed.escalationPolicies[0].steps[0].responderId, seed.responders[0].responderId);
});

test('IncidentRelay private seed families remain exact V1 and linked', () => {
  const valid = compile(contract.seed.schema);
  for (const name of ['empty', 'policy', 'incident', 'notification', 'idempotency', 'contention', 'quorum', 'work', 'event', 'migration', 'browser']) {
    const family = factory[name](); assert(valid(family.seed), `${name}: ${JSON.stringify(valid.errors)}`);
    for (const service of family.seed.services) assert(family.seed.escalationPolicies.some(p => p.policyId === service.currentPolicyId && p.version === service.currentPolicyVersion));
    for (const policy of family.seed.escalationPolicies) for (const step of policy.steps) assert(family.seed.responders.some(r => r.responderId === step.responderId));
    assert(!Object.hasOwn(family.seed, 'groupEscalationSteps'));
  }
});

test('IncidentRelay actual mounted author boundary validates positive examples and explicit negatives', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'incident-public-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'contract.json'), JSON.stringify(contract));
  await writeFile(join(directory, 'runtime.mjs'), `export * from ${JSON.stringify(pathToFileURL(resolve('templates/contract-first/runtime.mjs')).href)};`);
  const boundary = await evaluatorContract(directory);
  for (const operation of contract.operations) {
    const example = expand(operation.example, { ADMIN_TOKEN: 'public-author' });
    assert.doesNotThrow(() => boundary.request(requestPath(operation, example), { method: operation.method, headers: example.headers, ...(example.body !== undefined ? { json: example.body } : {}) }), operation.id);
  }
  assert.throws(() => boundary.request('/api/v1/incidents', { method: 'POST', json: factory.incidentBody('bad') }), e => e.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.throws(() => boundary.seed({ ...factory.policy().seed, unknown: true }), e => e.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.doesNotThrow(() => boundary.seed({ ...factory.policy().seed, unknown: true }, { contractExpectation: 'invalid' }));
});

test('IncidentRelay real helpers extract public timeline and forward only explicit negative markers', async () => {
  const calls = [], family = factory.policy();
  const ctx = { key: factory.key, mutate: async (_base, path, key, body, options) => { calls.push({ path, key, body, options }); return response(200, {}); }, request: async () => response(200, { items: [{ sequence: 1 }] }) };
  assert.deepEqual(await timeline(ctx, 'http://author', factory.uuid('incident')), [{ sequence: 1 }]);
  await createIncident(ctx, 'http://author', family, 'wire', {}, { expectSuccess: false });
  await createPolicy(ctx, 'http://author', family, 'wire-negative', { expectSuccess: false, steps: [{ stepIndex: 0, delaySeconds: 1.5, responderId: family.responders[0].responderId }], contractExpectation: 'invalid' });
  assert.equal(calls[0].options.contractExpectation, undefined);
  assert.equal(calls[1].options.contractExpectation, 'invalid');
  const step = { stepIndex: 0, responderIds: family.responders.map(r => r.responderId), quorumRequired: 2 };
  assert.equal(acknowledgementQuorum(step, [{ stepIndex: 0, responderId: step.responderIds[0] }, { stepIndex: 0, responderId: step.responderIds[0] }]).reached, false);
  assert.equal(notificationQuorum(step, step.responderIds.slice(0, 2).map(responderId => ({ responderId, state: 'DELIVERED' }))).sent, true);
  assert.equal(schedule(family.policyV1, '2032-04-05T06:07:08.000Z')[1].dueAt, '2032-04-05T06:07:18.000Z');
});

test('IncidentRelay transport maps fractional policy to its business-specific published error', () => {
  const operation = contract.operations.find(o => o.id === 'create-policy'), example = operation.example;
  const body = structuredClone(example.body); body.steps[0].delaySeconds = 1.5;
  const result = requestValidator(contract)(operation, { params: example.params, headers: { ...example.headers, 'content-type': 'application/json' }, body, hasBody: true });
  assert.equal(result.valid, false); assert.equal(result.code, 'INVALID_ESCALATION_POLICY');
  const unknown = { ...example.body, unpublished: true };
  assert.equal(requestValidator(contract)(operation, { params: example.params, headers: { ...example.headers, 'content-type': 'application/json' }, body: unknown, hasBody: true }).code, 'UNKNOWN_FIELD');
});
