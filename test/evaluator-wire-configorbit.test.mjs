import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { CASES } from '../evaluators/learning/configorbit/v2/cases/index.mjs';
import { createCaseContext } from '../evaluators/learning/configorbit/v2/lib/runtime.mjs';
import { createFixtureFactory, baseCatalog, v1Seed, emptySeed, performanceSeed, contentionSeed, revisionBody, publishBody, rolloutBody, observationBody, trainBody } from '../evaluators/learning/configorbit/v2/lib/fixtures.mjs';
import { validateCaseRegistry } from '../evaluators/learning/configorbit/v2/lib/execution.mjs';
import { validateManifest } from '../evaluators/learning/configorbit/v2/lib/scoring.mjs';

const root = resolve(import.meta.dirname, '..');
const boundary = await evaluatorContract(resolve(root, 'task-packages/v2/configorbit/public-contract'));
const fixture = caseId => createFixtureFactory({ evaluationSeed: 'author-wire', caseId, baseTime: '2026-09-07T00:00:00.000Z' });
const post = (path, json, options = {}) => boundary.request(path, { method: 'POST', headers: { 'Idempotency-Key': 'author-wire' }, json, ...options });

test('ConfigOrbit preserves all 22 cases and scoring definitions', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'evaluators/learning/configorbit/v2/manifest.v2.json')));
  const map = JSON.parse(await readFile(resolve(root, 'evaluators/learning/configorbit/v2/contract-map.v2.json')));
  assert.equal(CASES.length, 22);
  assert.equal(validateManifest(manifest, map), true);
  assert.doesNotThrow(() => validateCaseRegistry(manifest, CASES));
});

test('ConfigOrbit positive seeds, including full production workloads, match public wire', () => {
  for (const { id } of CASES) { boundary.seed(v1Seed(fixture(id))); boundary.seed(emptySeed(fixture(id))); }
  const f = fixture('LOAD-01');
  boundary.seed(performanceSeed(f, { environmentCount: 1, clientCount: 50000 }).seed);
  boundary.seed(contentionSeed(f, { environmentCount: 100 }).seed);
  boundary.seed(performanceSeed(f, { environmentCount: 100, invalidationCount: 100000 }).seed);
});

test('ConfigOrbit author requests use the fixed revision, publication, rollout and Train wire', () => {
  const f = fixture('TRAIN-01'), catalog = baseCatalog(f), environmentId = catalog.environments[0].environmentId;
  const create = revisionBody(catalog, { enabled: true });
  post('/api/v1/config-revisions', create);
  assert.deepEqual(Object.keys(create).sort(), ['document', 'environmentId', 'parentRevisionId', 'schemaRevision']);
  post(`/api/v1/config-revisions/${catalog.configRevisions[0].revisionId}/publish`, publishBody());
  post(`/api/v1/environments/${environmentId}/rollout`, rolloutBody(1, 5000));
  post('/api/v1/client-observations', observationBody({ clientId: 'author', environmentId, lastGeneration: 1, lastReleaseId: catalog.releases[0].releaseId }));
  const train = trainBody(catalog);
  post('/api/v1/promotion-trains', train);
  const bad = { ...train, stages: train.stages.map((stage, index) => index === 1 ? { ...stage, rolloutBasisPoints: 10001 } : stage) };
  assert.throws(() => post('/api/v1/promotion-trains', bad), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  assert.doesNotThrow(() => post('/api/v1/promotion-trains', bad, { contractExpectation: 'invalid' }));
  assert.doesNotThrow(() => post('/api/v1/promotion-trains', { ...train, stages: [...train.stages].reverse() }), 'wire-valid domain negatives must not bypass validation');
});

test('ConfigOrbit seed and Train helper forward only explicit malformed-wire intent', async t => {
  const ctx = await createCaseContext({ caseId: 'MIGRATE-03', workspace: root, evaluationSeed: 'author-wire', baseTime: '2026-09-07T00:00:00.000Z', manageDatabase: false });
  t.after(() => ctx.teardown());
  const f = fixture('MIGRATE-03'), malformed = { ...emptySeed(f), promotionTrains: [] };
  ctx.seedFile = async (path, options) => { boundary.seed(JSON.parse(await readFile(path)), options); return { exitCode: options.contractExpectation === 'invalid' ? 1 : 0 }; };
  await assert.rejects(ctx.seed(malformed), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  await ctx.seed(malformed, { expectFailure: true, contractExpectation: 'invalid' });
  const bad = { ...trainBody(baseCatalog(f)), stages: [] };
  ctx.mutate = async (_url, path, _key, json, options) => { post(path, json, options); return { status: 400 }; };
  assert.throws(() => post('/api/v1/promotion-trains', bad), error => error.code === 'EVALUATOR_PUBLIC_CONTRACT_MISMATCH');
  await ctx.createTrain('http://author.invalid', bad, { contractExpectation: 'invalid' });
});

test('ConfigOrbit RACE-02 sends 16 contract-valid rollout contenders', async () => {
  const f = fixture('RACE-02'), catalog = baseCatalog(f), id = f.uuid('train');
  const state = { resources: { environments: catalog.environments,
    promotionTrains: [{ trainId: id, state: 'RUNNING' }],
    promotionStages: [{ trainId: id, position: 0, state: 'ACTIVE' }] } };
  const reached = new Error('all contenders reached; stop before business oracle');
  const bodies = [];
  let snapshots = 0;
  const ctx = { caseId: 'RACE-02', catalog: () => catalog, seedFor: () => v1Seed(f),
    seed: async value => boundary.seed(value), startApi: async () => ({ baseUrl: 'http://author.invalid' }),
    trainBody, key: f.key, equal() {}, assert() {}, ok() {},
    createTrain: async (_url, body) => { post('/api/v1/promotion-trains', body); return { status: 200, json: { trainId: id } }; },
    startTrain: async () => {}, startWorker: async () => ({}), stop: async () => {},
    waitFor: action => action(), snapshot: async () => { if (++snapshots > 1) throw reached; return state; },
    rollout: async (_url, environmentId, body) => { post(`/api/v1/environments/${environmentId}/rollout`, body); bodies.push(body); return { status: 409 }; },
    rollbackTrain: async () => ({ status: 409, json: { error: { code: 'PROMOTION_STAGE_CHANGED' } } }),
  };
  await assert.rejects(CASES.find(({ id }) => id === 'RACE-02').run(ctx), error => error === reached);
  assert.equal(bodies.length, 16);
  assert(bodies.every(body => body.audienceSalt && body.rolloutBasisPoints === 5000));
});

test('ConfigOrbit TRAIN-01 foreign seed rows do not mutate the intended three-stage catalog', async () => {
  const f = fixture('TRAIN-01'), reached = new Error('valid three-stage request reached');
  let stageCount;
  const ctx = { caseId: 'TRAIN-01', fixtures: f, catalog: label => baseCatalog(f, label), trainBody,
    seed: async value => boundary.seed(value), startApi: async () => ({ baseUrl: 'http://author.invalid' }),
    key: f.key, createTrain: async (_url, body) => {
      post('/api/v1/promotion-trains', body); stageCount = body.stages.length; throw reached;
    } };
  await assert.rejects(CASES.find(({ id }) => id === 'TRAIN-01').run(ctx), error => error === reached);
  assert.equal(stageCount, 3);
});
