import test from 'node:test';
import assert from 'node:assert/strict';
import * as runtime from '../work/superhard-v2-alignment-20260908/capture-evaluator-environment.mjs';

function fakeSession({ failAt, actualConnections = '256\n' } = {}) {
  const calls = [], failure = new Error('isolated PostgreSQL command failed');
  return { calls, failure, async exec(command, args, options = {}) {
    calls.push({ command, args, options });
    if (calls.length === failAt) {
      if (!options.allowFailure) throw failure;
      return { exitCode: 1, stdout: '', stderr: failure.message };
    }
    return { exitCode: 0, stdout: /SHOW\s+max_connections/i.test(args.join(' ')) ? actualConnections : '', stderr: '' };
  } };
}

test('the explicit superhard evaluation environment retains finite shared resources', () => {
  const environment = runtime.evaluatorEnvironment;
  assert.deepEqual(environment.resources, { cpus: 4, memoryMiB: 65536 });
  assert.deepEqual(environment.pgdata, { target: '/tmp/frontal-benchmark-pgdata', sizeMiB: 32768 });
  assert.equal(environment.postgres?.maxConnections, 256);
});

test('PostgreSQL configuration writes the budget, restarts only its isolated cluster, then verifies the live value', async () => {
  const session = fakeSession();
  await runtime.configurePostgres(session, runtime.evaluatorEnvironment);
  assert.equal(session.calls.length, 3);
  const [alter, restart, show] = session.calls;
  assert.match([alter.command, ...alter.args].join(' '), /psql\b.*ALTER\s+SYSTEM\s+SET\s+max_connections\s*(?:=|TO)\s*'?256'?\b/i);
  assert.equal(restart.command.split('/').at(-1), 'gosu');
  assert.deepEqual(restart.args.slice(0, 2), ['postgres', 'pg_ctl']);
  assert(restart.args.includes('restart'));
  assert(restart.args.includes('-w'));
  assert.equal(restart.args[restart.args.indexOf('-D') + 1], runtime.evaluatorEnvironment.pgdata.target);
  assert.match([show.command, ...show.args].join(' '), /psql\b.*SHOW\s+max_connections\b/i);
});

for (const failAt of [1, 2, 3]) test(`a failed PostgreSQL configuration command ${failAt} prevents continuation`, async () => {
  const session = fakeSession({ failAt });
  await assert.rejects(async () => runtime.configurePostgres(session, runtime.evaluatorEnvironment));
  assert.equal(session.calls.length, failAt);
});

test('a restart which leaves PostgreSQL at the old connection limit cannot pass verification', async () => {
  const session = fakeSession({ actualConnections: '100\n' });
  await assert.rejects(async () => runtime.configurePostgres(session, runtime.evaluatorEnvironment));
  assert.equal(session.calls.length, 3);
});
