import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withCaseContext } from '../evaluators/transfer/accesssentinel/v2/lib/runtime.mjs';
import { executeCase } from '../src/task-evaluator-v2/execution.mjs';

test('an unattributed Access API socket failure retains redacted evidence without a candidate deduction', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'access-process-diagnostics-'));
  let context, api;
  t.after(async () => { await context?.teardown(); await rm(workspace, { recursive: true, force: true }); });
  await writeFile(join(workspace, 'package.json'), JSON.stringify({
    private: true, type: 'module', scripts: { 'start:api': `"${process.execPath}" server.mjs` },
  }));
  await writeFile(join(workspace, 'server.mjs'), `
import { createServer } from 'node:http';
createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }
  const values = [process.env.ADMIN_TOKEN, process.env.TEST_BARRIER_TOKEN, process.env.DATABASE_URL];
  process.stdout.write('fixture-before-socket-stdout ' + JSON.stringify(values) + '\\n', () => {
    process.stderr.write('fixture-before-socket-stderr ' + JSON.stringify(values) + '\\n', () => response.destroy());
  });
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
  const outcome = await executeCase({
    definition: { id: 'E-07', dimension: 'E', weight: 0.75 },
    contextOptions: { workspace, evaluationSeed: 'real-api-socket-diagnostics', manageDatabase: false },
    failureCodePrefix: 'AS_REPRO_', withContext: withCaseContext,
    implementation: { run: async ctx => {
      context = ctx;
      api = await ctx.startApi({ env: { TEST_BARRIER_TOKEN: ctx.barrierToken } });
      return ctx.request(api.baseUrl, '/break-socket', { timeoutMs: 5_000 });
    } },
  });
  assert.equal(outcome.status, 'evaluator_error');
  assert.equal(outcome.evaluatorErrorCode, 'EVALUATOR_UNATTRIBUTED_FAILURE');
  assert.equal(outcome.privateFailureCode, undefined);
  assert(outcome.privateErrorDetails.some(row => row.code === 'UND_ERR_SOCKET'));
  const record = outcome.privateErrorDetails.flatMap(row => row.details?.processes ?? []).find(row => row.role === 'api');
  assert(record, 'the original socket failure must retain API process diagnostics');
  assert.equal(record.script, 'start:api');
  assert.equal(record.pid, api.pid);
  assert.equal(record.exitCode, null, 'the API was alive when its socket failed');
  assert.equal(record.signalCode, null, 'cleanup SIGTERM is not the original failure signal');
  assert.match(record.stdout, /fixture-before-socket-stdout/);
  assert.match(record.stderr, /fixture-before-socket-stderr/);
  const privateResult = JSON.stringify(outcome);
  for (const secret of [context.adminToken, context.barrierToken, context.databaseUrl]) {
    assert(api.stdout.includes(secret) && api.stderr.includes(secret), 'fixture must actually emit every sensitive value');
    assert.equal(privateResult.includes(secret), false, 'private diagnostics must redact runtime credentials');
  }
});
