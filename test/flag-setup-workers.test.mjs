import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

test('recovery fixtures relinquish setup workers before the scored barrier', async () => {
  const source = ts.createSourceFile('helpers.mjs', readFileSync(new URL('../evaluators/transfer/flagfoundry/v2/cases/helpers.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'createReadyCandidate').getText(source).replace(/^export /u, '');
  for (const caseId of ['B-07', 'C-02', 'C-03', 'C-04', 'C-06', 'C-08', 'C-01', 'D-02']) {
    const workers = [{ id: 1 }, { id: 2 }]; const stopped = [];
    const run = runInNewContext(fn + ';createReadyCandidate', {
      createRevision: async () => ({ json: { revisionId: 'revision' } }),
      compileRevision: async () => ({ revision: { state: 'READY', snapshotDigest: 'digest' }, artifact: {}, workers }),
      snapshotDigest: () => 'digest',
    });
    const ctx = { caseId, equal: assert.equal, ok: assert.ok, stop: async worker => { stopped.push(worker); } };
    const result = await run(ctx, 'http://api', { stringFlag: { flagId: 'flag' }, revisionBody: () => ({}) });
    assert.equal(result.workers, workers);
    assert.deepEqual(stopped, ['C-01', 'D-02'].includes(caseId) ? [] : workers, caseId);
  }
});
