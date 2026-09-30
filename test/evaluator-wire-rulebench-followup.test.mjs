import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { evaluatorContract } from '../src/task-evaluator-v2/public-contract.mjs';
import { CASES } from '../evaluators/learning/rulebench/v2/cases/index.mjs';
import { createFixtureFactory, makeCoreSeed, makeDepthExpression } from '../evaluators/learning/rulebench/v2/fixtures/index.mjs';
import { detectConflicts, evaluateExpression, validateExpression } from '../evaluators/learning/rulebench/v2/oracles/index.mjs';

const options = { evaluationSeed: 'rulebench-followup', caseId: 'A-04', baseTime: '2026-01-01T00:00:00.000Z' };

test('RuleBench conflict fixture remains wire-valid while retaining every semantic conflict family', async () => {
  const boundary = await evaluatorContract(resolve('task-packages/v2/rulebench/public-contract'));
  const fixtures = createFixtureFactory(options);
  const captured = new Error('conflict fixture captured');
  const ctx = { ...options, workspace: 'wire-conflict', fixtures, uuid: fixtures.uuid, key: fixtures.key,
    npm: async () => ({}), migrate: async () => ({}), mark: () => {}, seed: async (seed) => {
      boundary.seed(seed);
      const draftId = makeCoreSeed(options).ids.draftVersionId;
      const rules = seed.rules.filter(({ ruleSetVersionId }) => ruleSetVersionId === draftId);
      assert.deepEqual(new Set(detectConflicts(rules).map(({ code }) => code)), new Set([
        'DUPLICATE_RULE_ID', 'DUPLICATE_PRIORITY', 'INVALID_EXPRESSION', 'TERMINAL_NULL_DECISION', 'AMBIGUOUS_CONDITION', 'UNREACHABLE_RULE',
      ]));
      throw captured;
    } };
  ctx.forWorkspace = () => ctx;
  await assert.rejects(CASES.find(({ id }) => id === 'A-04').run(ctx), (error) => error === captured);
});

test('RuleBench generated positive exists operands are explicit booleans', () => {
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.op === 'exists') assert.equal(typeof value.value, 'boolean');
    for (const child of Object.values(value)) visit(child);
  }
  visit(makeCoreSeed(options).seed);
  visit(makeDepthExpression(20));
});

test('RuleBench oracle implements the published exists true/false operand', () => {
  const expression = (value) => ({ op: 'exists', path: '$.value', value });
  assert.equal(validateExpression(expression(null)).ok, false);
  assert.equal(evaluateExpression(expression(true), { value: null }).result, true);
  assert.equal(evaluateExpression(expression(true), {}).result, false);
  assert.equal(evaluateExpression(expression(false), { value: null }).result, false);
  assert.equal(evaluateExpression(expression(false), {}).result, true);
});

test('RuleBench publication race sends the published empty body on both concurrent requests', async () => {
  const boundary = await evaluatorContract(resolve('task-packages/v2/rulebench/public-contract'));
  const publicationOptions = { ...options, caseId: 'B-02' };
  const fixtures = createFixtureFactory(publicationOptions);
  const captured = new Error('publication requests captured');
  const publications = [];
  const ctx = { ...publicationOptions, workspace: 'wire-publication', fixtures, uuid: fixtures.uuid, key: fixtures.key,
    npm: async () => ({}), migrate: async () => ({}), seed: async (seed) => boundary.seed(seed), mark: () => {},
    startApi: async () => ({ baseUrl: 'http://localhost' }), stop: async () => {},
    equal: assert.deepEqual, snapshot: async () => ({}),
    mutate: async (_baseUrl, path, key, body) => {
      boundary.request(path, { method: 'POST', headers: { 'idempotency-key': key }, json: body });
      if (!path.endsWith('/publish')) return { status: 200 };
      assert.deepEqual(body, {});
      publications.push({ path, key });
      throw captured;
    },
  };
  ctx.forWorkspace = () => ctx;
  await assert.rejects(CASES.find(({ id }) => id === 'B-02').run(ctx), (error) => error === captured);
  assert.equal(publications.length, 2);
  assert.equal(publications[0].path, publications[1].path);
  assert.notEqual(publications[0].key, publications[1].key);
});
