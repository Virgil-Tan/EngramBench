import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createFixtureFactory } from '../evaluators/transfer/permitforge/v2/fixtures/index.mjs';

const sourceFile = task => ts.createSourceFile('a.mjs', readFileSync(new URL(`../evaluators/transfer/${task}/v2/cases/a.mjs`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
test('Permit A04 uses a real claimable projection and the published reviewers', async () => {
  const source = sourceFile('permitforge');
  const declaration = source.statements.flatMap(n => ts.isVariableStatement(n) ? [...n.declarationList.declarations] : []).find(n => n.name.getText(source) === 'a04');
  const callback = declaration.initializer.arguments.at(-1);
  const prefix = [];
  for (const statement of callback.body.statements) {
    if (statement.getText(source).startsWith('const missingId')) break;
    prefix.push(statement.getText(source));
  }
  const fixtures = createFixtureFactory({ evaluationSeed: 'preconditions', caseId: 'A-04', baseTime: '2035-01-01T00:00:00.000Z' });
  const run = runInNewContext(`async ctx => { ${prefix.join('\n')} return { family, submitted, approved, changes }; }`, { boot: async () => ({ api: {} }) });
  const result = await run({ fixtures });
  assert.equal(result.family.securityReviewers, fixtures.securityReviewers);
  assert.ok(result.submitted);
  assert.ok(!result.submitted.claims.some(c => c.reviewerId === fixtures.securityReviewers[0].reviewerId && c.role === 'security'));
  assert.equal(result.approved.application.state, 'APPROVED');
  assert.equal(result.changes.application.state, 'CHANGES_REQUIRED');
});
test('Meter rollback comparison ignores only observation time, not durable fields', () => {
  const source = sourceFile('metersettle');
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'durableSnapshot').getText(source);
  const stable = runInNewContext(fn + ';durableSnapshot', { assert });
  const original = { asOf: '2035-01-01T00:00:00.000Z', schemaVersion: 'v2', resources: {}, work: [], events: [], checksums: { version: 1 } };
  const encode = value => JSON.stringify(stable(value));
  assert.equal(encode(original), encode({ ...original, asOf: '2035-01-02T00:00:00.000Z' }));
  for (const field of ['schemaVersion', 'resources', 'work', 'events', 'checksums']) assert.notEqual(encode(original), encode({ ...original, [field]: 'changed' }));
  assert.throws(() => stable({ ...original, asOf: 'invalid' }));
});
