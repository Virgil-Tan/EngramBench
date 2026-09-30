import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeCase, EvaluationInfrastructureError } from '../src/task-evaluator-v2/execution.mjs';

// Exercise each real task wrapper, its HTTP accounting and shared failure
// classifier. Only database initialization is a no-op in this runtime unit peer;
// these checks do not claim that a candidate's full business case has passed.
for (const [taskId, caseIds] of [
  ['launchpass', ['A-05', 'D-04']],
  ['importworks', ['A-03', 'D-02']],
  ['ledgerbridge', ['A-05', 'D-03']],
  ['mediadock', ['A-03', 'D-02']],
  ['configrelay', ['B-04']],
]) {
  const runtime = await import(`../evaluators/learning/${taskId}/v2/lib/runtime.mjs`);
  const manifest = JSON.parse(await readFile(new URL(`../evaluators/learning/${taskId}/v2/manifest.v2.json`, import.meta.url)));
  const map = JSON.parse(await readFile(new URL(`../evaluators/learning/${taskId}/v2/contract-map.v2.json`, import.meta.url)));
  for (const caseId of caseIds) {
    test(`${taskId} ${caseId}: actual wrapper finishes HTTP assertions and retains failure origins`, async t => {
      const workspace = await mkdtemp(join(tmpdir(), `${taskId}-finish-`));
      t.after(() => rm(workspace, { recursive: true, force: true }));
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, scripts: { 'db:migrate': 'node -e "process.exit(0)"' } }));
      let mode = 'correct';
      const calls = [];
      const server = createServer((request, response) => {
        calls.push({ method: request.method, path: request.url, mode });
        response.writeHead(mode === 'server-error' ? 503 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: mode === 'business-error' ? 'wrong' : 'ok' }));
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise(resolve => server.close(resolve)));
      const baseUrl = `http://127.0.0.1:${server.address().port}`;
      const definition = manifest.cases.find(item => item.id === caseId);
      const prefix = map.cases.find(item => item.caseId === caseId).privateFailureCodePrefix;
      let finished;
      const run = () => executeCase({
        definition,
        failureCodePrefix: prefix,
        contextOptions: { workspace, evaluationSeed: 'finish-regression', manageDatabase: false },
        withContext: async (options, operation) => {
          finished = undefined;
          const result = await runtime.withCaseContext(options, operation);
          finished = result;
          return result;
        },
        implementation: { async run(ctx) {
          if (taskId === 'configrelay') {
            const catalog = ctx.catalog();
            assert.ok(catalog.fleet.fleetId, 'B-04 receives the actual decorated fixture helpers');
            assert.equal(typeof ctx.seedFor, 'function');
            assert.equal(typeof ctx.startApi, 'function');
          }
          const response = await ctx.request(baseUrl, taskId === 'launchpass' ? '/api/health' : '/healthz');
          if (mode === 'infrastructure-error') throw new EvaluationInfrastructureError('EVALUATOR_TEST_CONTROL_FAILURE');
          ctx.equal('public HTTP observation matches the expectation', response.json.status, 'ok', { failureCodeSuffix: 'OBSERVED_STATE' });
          return { evidence: ['actual HTTP response was asserted'] };
        } },
      });

      const correct = await run();
      assert.equal(correct.status, 'passed');
      assert.deepEqual(finished.evidence.assertions.map(item => item.status), ['passed', 'passed']);
      assert.equal(finished.evidence.statuses['200'], 1);
      assert.equal(Object.hasOwn(finished.evidence, 'blockedAssertions'), false);
      assert.equal(Object.hasOwn(finished, 'reason'), false);

      mode = 'business-error';
      const wrong = await run();
      assert.equal(wrong.status, 'failed');
      assert.equal(wrong.privateFailureCode, `${prefix}OBSERVED_STATE`);
      assert.equal(finished, undefined, 'the wrapper must not finish or pass after a failed assertion');

      mode = 'server-error';
      const serverError = await run();
      assert.equal(serverError.status, 'failed');
      assert.match(serverError.privateMessage, /no unexpected HTTP 5xx/);

      mode = 'infrastructure-error';
      const infrastructureError = await run();
      assert.equal(infrastructureError.status, 'evaluator_error');
      assert.equal(infrastructureError.evaluatorErrorCode, 'EVALUATOR_TEST_CONTROL_FAILURE');
      assert.equal(calls.length, 4, 'all control variants used an actual HTTP request');
    });
  }
}
