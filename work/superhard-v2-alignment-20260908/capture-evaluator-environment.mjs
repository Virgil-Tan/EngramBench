// Private, read-only diagnostics before the evaluator removes its own container.
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { OciRuntime } from '../../src/oci.mjs';
import { writeJsonAtomic } from '../../src/files.mjs';
import environment from './evaluation-environment.json' with {type: 'json'};
export const evaluatorEnvironment = environment;

// Called only on a fresh, isolated evaluator database, before candidate startup.
export async function configurePostgres(session, settings) {
  const maximum = settings.postgres.maxConnections;
  assert(Number.isSafeInteger(maximum) && maximum > 0, 'Invalid PostgreSQL connection budget');
  const psql = ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-Atc'];
  const exec = async (command, args) => {
    const result = await session.exec(command, args, {timeoutMs: 60_000});
    assert.equal(result.exitCode, 0, `${command} failed during PostgreSQL setup`);
    return result;
  };
  await exec('psql', [...psql, `ALTER SYSTEM SET max_connections = ${maximum}`]);
  await exec('gosu', ['postgres', 'pg_ctl', '-D', settings.pgdata.target, '-m', 'fast', '-w', 'restart', '-l', '/tmp/frontal-benchmark-postgres.log']);
  const actual = await exec('psql', [...psql, 'SHOW max_connections']);
  assert.equal(actual.stdout.trim(), String(maximum), 'PostgreSQL connection budget did not take effect');
}

const capture = `
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
async function tail(path) {
  let file;
  try {
    file = await fs.open(path, 'r');
    const {size} = await file.stat();
    const length = Math.min(size, 1048576);
    const data = Buffer.alloc(length);
    await file.read(data, 0, length, size - length);
    return {size, truncated: size > length, text: data.toString('utf8')};
  } catch (error) { return {error: error.message}; }
  finally { await file?.close(); }
}
async function read(path) { try { return await fs.readFile(path, 'utf8'); } catch(error) { return {error:error.message}; } }
(async () => {
  const result = {capturedAt: new Date().toISOString(),
    postgres: await tail('/tmp/frontal-benchmark-postgres.log'),
    memoryEvents: await read('/sys/fs/cgroup/memory.events'),
    memoryPeak: await read('/sys/fs/cgroup/memory.peak'),
    memoryMax: await read('/sys/fs/cgroup/memory.max')};
  try { result.disk = execFileSync('df', ['-k', '/tmp/frontal-benchmark-pgdata'], {encoding:'utf8'}); }
  catch(error) { result.disk = {error:error.message}; }
  try { result.maxConnections = execFileSync('psql', ['-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres', '-Atc', 'SHOW max_connections'], {encoding:'utf8'}).trim(); }
  catch(error) { result.maxConnections = {error:error.message}; }
  console.log(JSON.stringify(result));
})().catch(error => { console.error(error.message); process.exitCode=1; });
`;

export function capturedRuntimeFactory(options) {
  const runtime = new OciRuntime(options);
  const create = runtime.createSession.bind(runtime);
  runtime.createSession = async config => {
    if (!config.tmpfs.some(mount => mount.target === environment.pgdata.target)) throw new Error('Expected isolated PostgreSQL tmpfs');
    const session = await create({...config,
      tmpfs: config.tmpfs.map(mount => mount.target === environment.pgdata.target ? {...mount, sizeMiB: environment.pgdata.sizeMiB} : mount),
      resources: {...config.resources, ...environment.resources},
    });
    const close = session.close.bind(session);
    const caseRoot = config.mounts.find(mount => mount.target === '/results')?.source;
    session.close = async () => {
      if (!session.closed && caseRoot) {
        try {
          const output = await session.exec('node', ['-e', capture], {timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024});
          await writeJsonAtomic(join(caseRoot, 'private-environment.json'), {container:session.name, environment, ...JSON.parse(output.stdout)});
        } catch (error) {
          // Diagnostics do not turn a business failure into a pass or prevent cleanup.
          await writeJsonAtomic(join(caseRoot, 'private-environment.json'), {container:session.name, captureError:error.message}).catch(() => {});
        }
      }
      return close();
    };
    try { await configurePostgres(session, environment); }
    catch (error) { await session.close().catch(() => {}); throw error; }
    return session;
  };
  return runtime;
}
