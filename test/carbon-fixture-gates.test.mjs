import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(new URL('../evaluators/transfer/carbonledger/v2', import.meta.url).pathname);
const { makeSplitFixture } = await import(pathToFileURL(`${root}/fixtures/index.mjs`));
const { selectAllocations } = await import(pathToFileURL(`${root}/oracles/index.mjs`));
const seed = 'f6f3b3ada410567ecab217292ab2a98a76780cd9984aed44917bbff3a6a8f1e6';
for (const [caseId, count, quantity] of [['A-13',2,3],['A-13',3,5],['A-13',20,39],['A-16',20,39],['B-09',4,7]]) {
  test(`${caseId}: published setup really requires ${count} allocations`, () => {
    const f = makeSplitFixture({ evaluationSeed:seed,caseId,baseTime:'2026-09-04T00:00:00.000Z' }, count);
    assert.equal(selectAllocations(f.creditLots, quantity).length, count);
  });
}
test('twenty-one lots still exceed the business limit', () => {
  const f = makeSplitFixture({evaluationSeed:seed,caseId:'A-16',baseTime:'2026-09-04T00:00:00.000Z'},21);
  assert.equal(selectAllocations(f.creditLots,41).error,'CROSS_LOT_LIMIT_EXCEEDED');
});
const source=readFileSync(`${root}/cases/d.mjs`,'utf8');
const matcher=source.match(/ctx\.ok\(!\/(.*?)\/([gimsuy]*)\.test\(output\),/);
assert.ok(matcher,'exercise the actual D-07 zero-tests predicate');
const zeroTests=new RegExp(matcher[1],matcher[2]);
for(const output of ['> carbonledger@0.1.0 test:unit\nℹ tests 3\nℹ pass 3\nℹ fail 0','10 tests passed','20 tests passed','0 tests failed']) {
  test(`does not reject successful output ${output.split('\n')[0]}`,()=>assert.equal(zeroTests.test(output),false));
}
for(const output of ['0 tests','# tests 0','ℹ tests 0','no tests found','Skipping all tests']) {
  test(`still rejects zero-execution output ${output}`,()=>assert.equal(zeroTests.test(output),true));
}
