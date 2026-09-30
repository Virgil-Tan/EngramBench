import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validator, requestValidator, matchOperation } from '../task-packages/v2/fraudlens/public-contract/runtime.mjs';
import { createFixtureFactory } from '../evaluators/learning/fraudlens/v2/fixtures/index.mjs';
import { CASES } from '../evaluators/learning/fraudlens/v2/cases/index.mjs';
import { validateCaseRegistry } from '../evaluators/learning/fraudlens/v2/lib/execution.mjs';
import { validateManifest } from '../evaluators/learning/fraudlens/v2/lib/scoring.mjs';
import { acceptRisk, activateVersion, createVersion, rollbackVersion, createRemediation } from '../evaluators/learning/fraudlens/v2/cases/helpers.mjs';
import { evaluateRules } from '../evaluators/learning/fraudlens/v2/oracles/index.mjs';

const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const contract = await json('../task-packages/v2/fraudlens/public-contract/contract.json');
const compile = validator(contract), validateRequest = requestValidator(contract);
const fixture = caseId => createFixtureFactory({ evaluationSeed: 'author-wire', caseId, baseTime: '2026-09-07T00:00:00.000Z' });

function request(path, key, body) {
  const matched = matchOperation(contract.operations, 'POST', path);
  assert.ok(matched, path);
  return validateRequest(matched.operation, { params: matched.params, body, hasBody: true,
    headers: { 'content-type': 'application/json', 'idempotency-key': key, authorization: 'Bearer author-test' } });
}

test('FraudLens preserves the complete frozen registry and validates every case seed', async () => {
  const manifest = await json('../evaluators/learning/fraudlens/v2/manifest.v2.json');
  const map = await json('../evaluators/learning/fraudlens/v2/contract-map.v2.json');
  assert.equal(validateManifest(manifest, map), true);
  assert.equal(validateCaseRegistry(manifest, CASES), true);
  const valid = compile(contract.seed.schema);
  for (const { id } of CASES) {
    const seed = fixture(id).seed();
    assert.ok(valid(seed), `${id}: ${JSON.stringify(valid.errors)}`);
    for (const set of seed.ruleSets) assert.equal(seed.ruleVersions.filter(v => v.ruleSetId === set.ruleSetId && v.state === 'ACTIVE').length, 1);
  }
});

test('FraudLens worked example uses legal rule scalars and preserves score, clamp, thresholds and hit order', () => {
  const f = fixture('A-01'), rules = f.workedRules();
  const body = { rules, reviewThreshold: 700, blockThreshold: 900 };
  const result = request(`/api/v1/rule-sets/${f.ids.ruleSetId}/versions`, f.key('worked'), body);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.deepEqual(evaluateRules(f.event(1, { attributes: { a: 1, b: 1, c: 1 } }), body), {
    score: 800, recommendation: 'REVIEW', ruleHits: [
      { ruleId: 'a', priority: 1, score: 300, reasonCode: 'A_MATCH' },
      { ruleId: 'b', priority: 1, score: 900, reasonCode: 'B_MATCH' },
      { ruleId: 'c', priority: 2, score: -400, reasonCode: 'C_MATCH' },
    ],
  });
});

test('FraudLens positive helper requests use the fixed wire contract; malformed nested attributes remain explicit negatives', async () => {
  const f = fixture('A-05'), calls = [];
  const ctx = { fixtures: f, key: f.key, async mutate(_base, path, key, body, options = {}) {
    const result = request(path, key, body);
    assert.equal(result.valid, options.contractExpectation !== 'invalid', JSON.stringify({ path, result }));
    calls.push({ path, body, options });
    return { status: result.valid ? 200 : 400, json: { ruleVersionId: f.uuid('version'), remediationRunId: f.uuid('run') } };
  } };
  const created = await createVersion(ctx, 'http://author.test', 'positive');
  await activateVersion(ctx, 'http://author.test', created.ruleVersionId, f.ids.baseVersionId);
  await rollbackVersion(ctx, 'http://author.test', created.ruleVersionId, f.ids.baseVersionId);
  await acceptRisk(ctx, 'http://author.test', 1);
  await createRemediation(ctx, 'http://author.test', { fromRuleVersionId: created.ruleVersionId, toRuleVersionId: f.ids.baseVersionId });
  await acceptRisk(ctx, 'http://author.test', 2, { attributes: { nested: { forbidden: true } } }, { expectSuccess: false, contractExpectation: 'invalid' });
  assert.equal(calls.length, 6);
  assert.equal(calls[2].body.fromRuleVersionId, created.ruleVersionId);
  assert.equal(Object.hasOwn(calls[2].body, 'expectedActiveRuleVersionId'), false);
  assert.equal(calls.filter(c => c.options.contractExpectation === 'invalid').length, 1);
});

test('FraudLens review wire requires the observed revision and rejects missing fences', () => {
  const f = fixture('A-03'), id = f.uuid('review-case');
  for (const [suffix, body] of [
    ['claim', { reviewerId: 'analyst', expectedRevision: 4, leaseSeconds: 10 }],
    ['decisions', { reviewerId: 'analyst', expectedRevision: 5, outcome: 'APPROVE', reasonCode: 'REVIEWED' }],
  ]) {
    const path = `/api/v1/review-cases/${id}/${suffix}`;
    assert.equal(request(path, f.key(suffix), body).valid, true);
    const { expectedRevision, ...missingFence } = body;
    assert.equal(request(path, f.key(suffix), missingFence).valid, false);
  }
});
