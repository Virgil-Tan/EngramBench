import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkLive } from '../templates/contract-first/check.mjs';

test('actual public lifecycle reports a seed subprocess failure after build and migrations', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'public-lifecycle-regression-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const author = join(workspace, 'contract'), bin = join(workspace, 'bin');
  await mkdir(author); await mkdir(bin);
  await writeFile(join(author, 'protected.json'), JSON.stringify({ files: {}, scripts: {} }));
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ type: 'module' }));
  await writeFile(join(author, 'contract.json'), JSON.stringify({ schemas: {}, operations: [], seed: { schema: { type: 'object' }, example: { rows: ['public'] } } }));
  // Test-only executable exercises the real checker subprocess path; it is not a submission.
  await writeFile(join(bin, 'npm'), `#!${process.execPath}
const command = process.argv.slice(2).join(' ');
process.stdout.write(command + '\\n');
if (command.startsWith('run db:seed')) {
  process.stderr.write('public fixture: seed importer rejected a foreign key');
  process.exit(7);
}
`, { mode: 0o755 });
  await assert.rejects(checkLive(workspace, author, { PATH: bin, DATABASE_URL: 'postgresql://localhost/unused-fixture', ADMIN_TOKEN: 'public-test-token' }), error => {
    assert.equal(error.stage, 'seed');
    assert.equal(error.commandResult.exitCode, 7);
    assert.match(error.commandResult.stdout, /run db:seed -- --file/);
    assert.match(error.commandResult.stderr, /foreign key/);
    assert.notEqual(error.preparationFailed, true, 'a submission seed failure is not an installation exemption');
    return true;
  });
});
