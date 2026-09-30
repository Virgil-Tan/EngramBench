import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixtureFactory, makeCoreSeed } from '../evaluators/learning/rulebench/v2/fixtures/index.mjs';
import { assertEvaluationOracle, outcomeFor, replaceVersionRules, rule, sha256Canonical } from '../evaluators/learning/rulebench/v2/cases/helpers.mjs';

function oracleFixture(ruleCount = 2_500) {
  const options = { evaluationSeed: 'bounded-node-diagnostics', caseId: 'C-01', baseTime: '2026-01-01T00:00:00.000Z' };
  const factory = createFixtureFactory(options);
  const fixture = makeCoreSeed(options);
  const versionId = fixture.ids.baselineVersionId;
  replaceVersionRules(fixture, versionId, Array.from({ length: ruleCount }, (_, index) => rule(factory, versionId, `long-${index}`, {
    priority: index + 1, condition: { op: 'eq', path: '$.bucket', value: index },
    effect: { decision: null, tags: [] }, terminal: false,
  })));
  const facts = { bucket: -1 };
  const expected = outcomeFor(fixture, versionId, facts);
  const evaluationId = factory.uuid('evaluation');
  const evaluation = { evaluationId, ruleSetVersionId: versionId, factsDigest: sha256Canonical(facts),
    decision: expected.decision, tags: expected.tags, matchedRuleIds: expected.matchedRuleIds, explanationDigest: expected.explanationDigest };
  const snapshot = { resources: { evaluations: [evaluation], explanationNodes: expected.nodes.map(node => ({ ...node, evaluationId })) } };
  return { fixture, facts, evaluationId, snapshot, expected };
}

function checkedContext() {
  const calls = [];
  return { calls, ok: assert.ok, equal(actual, expected, label, options) {
    if (Array.isArray(actual) && actual.some(item => item && typeof item === 'object' && Object.hasOwn(item, 'ordinal'))) {
      assert.fail('Full ExplanationNode arrays must never enter assertion diff formatting');
    }
    calls.push({ actual, expected, label, options });
    assert.deepEqual(actual, expected, label);
  } };
}

for (const count of [5_000, 10_000]) {
  test(`RuleBench real oracle checks every one of ${count} nodes without a whole-ledger diff`, () => {
    const value = oracleFixture(count / 2);
    const ctx = checkedContext();
    const result = assertEvaluationOracle(ctx, value.snapshot, value.fixture, value.evaluationId, value.facts);
    assert.equal(result.nodes.length, count);
    const nodeCalls = ctx.calls.filter(call => call.actual && typeof call.actual === 'object' && Object.hasOwn(call.actual, 'ordinal'));
    assert.equal(nodeCalls.length, count);
    assert.deepEqual(nodeCalls.map(({ actual }) => actual.ordinal), Array.from({ length: count }, (_, index) => index + 1));
    for (const call of nodeCalls) assert.deepEqual(call.options.hardCapIds, ['DETERMINISTIC_EVALUATION']);
    assert.ok(ctx.calls.some(({ label }) => label === 'independent explanation digest'));
    assert.ok(ctx.calls.some(({ label }) => label === 'public nodes recompute explanation digest'));
  });
}

test('RuleBench still rejects every projected field of the final node and missing nodes', () => {
  const value = oracleFixture();
  const last = value.snapshot.resources.explanationNodes.at(-1);
  for (const [field, wrong] of Object.entries({ ordinal: 5_001, ruleId: value.evaluationId, path: '$.wrong', result: !last.result, reason: 'WRONG' })) {
    const snapshot = structuredClone(value.snapshot);
    snapshot.resources.explanationNodes.at(-1)[field] = wrong;
    const ctx = checkedContext();
    assert.throws(() => assertEvaluationOracle(ctx, snapshot, value.fixture, value.evaluationId, value.facts), error => {
      assert.equal(error.code, 'ERR_ASSERTION');
      assert.ok(error.actual && typeof error.actual === 'object' && !Array.isArray(error.actual));
      assert.equal(error.actual[field], wrong);
      assert.deepEqual(ctx.calls.at(-1).options.hardCapIds, ['DETERMINISTIC_EVALUATION']);
      return true;
    });
    assert.equal(ctx.calls.filter(call => call.actual && typeof call.actual === 'object' && Object.hasOwn(call.actual, 'ordinal')).length, 5_000);
  }
  const snapshot = structuredClone(value.snapshot);
  snapshot.resources.explanationNodes.pop();
  assert.throws(() => assertEvaluationOracle(checkedContext(), snapshot, value.fixture, value.evaluationId, value.facts), error => error.actual === 4_999 && error.expected === 5_000);
});
