import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeEscrowFixture } from '../evaluators/transfer/escrowguard/v2/fixtures/index.mjs';
import { makeSplitFixture } from '../evaluators/transfer/carbonledger/v2/fixtures/index.mjs';
import { assertWork } from '../evaluators/transfer/flagfoundry/v2/oracles/index.mjs';
import { digestTaskPackagePath } from '../src/task-package-v1.mjs';

const options = { evaluationSeed: 'consolidated-repairs', caseId: 'A-04', baseTime: '2035-01-01T00:00:00.000Z' };
test('Escrow case state lists get matching default amounts, without accepting explicit mismatches', () => {
  for (const states of [['SUBMITTED', 'PENDING'], ['PENDING'], ['PENDING', 'PENDING', 'PENDING', 'PENDING']]) {
    const f = makeEscrowFixture(options, { states });
    assert.equal(f.milestones.length, states.length);
    assert.deepEqual(f.milestones.map(m => m.state), states);
    assert.equal(f.milestones.reduce((n, m) => n + m.amountMinor, 0), 100);
    assert.equal(f.escrow.totalMinor, 100);
  }
  assert.throws(() => makeEscrowFixture(options, { states: ['PENDING'], amounts: [30, 70] }), /equal length/);
});
test('Carbon split fixture needs the advertised number of lots, including last-lot boundary', () => {
  for (const count of [2, 4, 20]) {
    const f = makeSplitFixture(options, count);
    assert.deepEqual(f.creditLots.map(lot => lot.issuedGrams), Array(count).fill(2));
  }
});
test('Flag unclaimed attempt zero is legal but leased attempt zero remains invalid', () => {
  const work = { workId: '11111111-1111-4111-8111-111111111111', kind: 'FLAG_COMPILATION', aggregateId: '22222222-2222-4222-8222-222222222222', state: 'PENDING', terminal: false, attempt: 0, leaseOwner: null, leaseExpiresAt: null };
  assert.doesNotThrow(() => assertWork([work]));
  assert.doesNotThrow(() => assertWork([{ ...work, state: 'CANCELLED', terminal: true }]));
  for (const attempt of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => assertWork([{ ...work, attempt }]));
  const leased = { ...work, state: 'LEASED', leaseOwner: 'worker', leaseExpiresAt: options.baseTime };
  assert.throws(() => assertWork([leased]));
  assert.doesNotThrow(() => assertWork([{ ...leased, attempt: 1 }]));
});
test('all 43 generated evaluators and releases match their author sources', async () => {
  for (const group of ['learning', 'transfer']) {
    const { tasks } = JSON.parse(await readFile(new URL(`../${group}-tasks.json`, import.meta.url)));
    for (const id of tasks) {
      const author = new URL(`../evaluators/${group}/${id}/`, import.meta.url);
      const generated = new URL(`../task-packages/v2/${id}/evaluator/`, import.meta.url);
      assert.equal(await digestTaskPackagePath(new URL('v2', generated).pathname), await digestTaskPackagePath(new URL('v2', author).pathname), `${id}: generated evaluator drift`);
      assert.equal(await readFile(new URL('release.json', generated), 'utf8'), await readFile(new URL('release.json', author), 'utf8'), `${id}: release drift`);
    }
  }
});
